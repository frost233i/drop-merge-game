/**
 * Drop & Merge — H5 Puzzle Game
 * 5 cols × 6 visible rows (row 0 = buffer, rows 1-5 = main area)
 * Grid internally: grid[row][col], row 0 is buffer (top), row 5 is bottom.
 * Levels 1-44, merge same-level neighbors into higher level.
 */
(function () {
  'use strict';

  // ===== Constants =====
  const COLS = 5;
  const ROWS = 6; // 1 buffer + 5 main
  const MAX_LEVEL = 44;
  const STORAGE_KEY = 'dropmerge_save';

  // ===== Audio System =====
  const bgm = new Audio('sounds/bgm(2).mp3');
  bgm.loop = true;
  bgm.volume = 0.3;
  let bgmStarted = false;

  // Sound pool: reuse a fixed set of Audio instances to avoid memory leaks
  function createSoundPool(src, volume, poolSize) {
    var pool = [];
    for (var i = 0; i < poolSize; i++) {
      var a = new Audio(src);
      a.volume = volume;
      pool.push(a);
    }
    var index = 0;
    return function() {
      var a = pool[index];
      index = (index + 1) % pool.length;
      a.currentTime = 0;
      a.play().catch(function(){});
    };
  }

  const playSfxDrop = createSoundPool('sounds/下落音效(1).mp3', 0.6, 3);
  const playSfxMerge = createSoundPool('sounds/合成音效(1).mp3', 0.6, 4);
  const playSfxCheer = createSoundPool('sounds/欢呼声(1).mp3', 0.7, 2);

  // ===== Skin system: preload available skin images =====
  const skinImages = {}; // level -> Image object (only for loaded skins)
  const SKIN_PATH = 'skins/';
  function preloadSkins() {
    // Batch re-renders: multiple images can finish in the same frame,
    // so coalesce them into a single renderBoard instead of one per image.
    let pendingRender = false;
    function scheduleRender() {
      if (pendingRender) return;
      pendingRender = true;
      requestAnimationFrame(function () {
        pendingRender = false;
        renderBoard();
        updateNextPreview();
        updateNextNextPreview();
      });
    }
    for (let lv = 1; lv <= MAX_LEVEL; lv++) {
      const img = new Image();
      img.onload = function () {
        skinImages[lv] = img;
        scheduleRender();
      };
      img.src = SKIN_PATH + lv + '.png';
    }
  }

  // ===== DOM refs =====
  const boardEl = document.getElementById('board');
  const scoreEl = document.getElementById('score');
  const bestScoreEl = document.getElementById('best-score');
  const nextBlockEl = document.getElementById('next-block');
  const nextNextBlockEl = document.getElementById('next-next-block');
  const arrowRow = document.getElementById('arrow-row');
  const overlay = document.getElementById('overlay');
  const finalScoreEl = document.getElementById('final-score');
  const btnRestart = document.getElementById('btn-restart');
  const btnNew = document.getElementById('btn-new');
  const overflowWarning = document.getElementById('overflow-warning');
  const btnUndo = document.getElementById('btn-undo');
  const btnWarningRestart = document.getElementById('btn-warning-restart');

  // ===== Game State =====
  let grid = [];        // grid[row][col] = level (0 = empty)
  let score = 0;
  let bestScore = 0;
  let nextLevel = 1;
  let nextNextLevel = 0; // second preview block (0 = not yet generated)
  let minSpawnLevel = 1; // lowest level that can spawn
  let maxSpawnLevel = 5; // highest level that can spawn
  let spawnQueue = [];   // overflow queue from hand card insertions
  let isAnimating = false;
  let gameOver = false;

  // Undo snapshot for overflow warning
  let lastSnapshot = null;

  // Bath Brush state
  let brushMode = false;
  let brushDragging = false;
  let brushCenterRow = -1;
  let brushCenterCol = -1;
  let _brushBlockClick = false;

  // Hammer state
  let hammerMode = false;

  // Swap state
  let swapMode = false;
  let swapFirstCell = null; // {row, col}

  // Cell DOM elements: cellEls[row][col]
  let cellEls = [];
  // Block DOM elements: blockEls[row][col] (reused to avoid DOM churn)
  let blockEls = [];

  // ===== Color System: HSL-based 44 distinct colors =====
  function getLevelColor(level) {
    if (level <= 0) return 'transparent';
    // Spread across hue wheel, vary saturation/lightness for distinction
    const hue = (level * 47 + 10) % 360;
    const sat = 65 + (level % 3) * 10; // 65-85
    const lit = 45 + (level % 5) * 4;  // 45-61
    return `hsl(${hue}, ${sat}%, ${lit}%)`;
  }

  function getLevelTextColor(level) {
    // Light text for most, dark for very light blocks
    const lit = 45 + (level % 5) * 4;
    return lit > 58 ? '#1a1a2e' : '#ffffff';
  }

  // ===== Initialize Board DOM =====
  function initBoardDOM() {
    boardEl.innerHTML = '';
    cellEls = [];
    blockEls = [];
    for (let r = 0; r < ROWS; r++) {
      cellEls[r] = [];
      blockEls[r] = [];
      for (let c = 0; c < COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell' + (r === 0 ? ' buffer-cell' : '');
        cell.dataset.row = r;
        cell.dataset.col = c;
        boardEl.appendChild(cell);
        cellEls[r][c] = cell;
        blockEls[r][c] = null;
      }
    }
  }

  // ===== Render a single cell =====
  function renderCell(row, col, animClass) {
    const cell = cellEls[row][col];
    const level = grid[row][col];
    let block = blockEls[row][col];

    // Empty cell: remove block if present
    if (level <= 0) {
      if (block) {
        block.remove();
        blockEls[row][col] = null;
      }
      return;
    }

    // Reuse the block element to avoid DOM churn
    if (!block) {
      block = document.createElement('div');
      block.className = 'block';
      cell.appendChild(block);
      blockEls[row][col] = block;
    }

    // Reset classes, then re-apply animation class (with a reflow so it restarts)
    block.className = 'block' + (level >= 10 ? ' level-high' : '');
    if (animClass) {
      void block.offsetWidth; // force reflow so the animation restarts
      block.classList.add(animClass);
    }

    // Use skin image if available, otherwise fallback to color + number
    if (skinImages[level]) {
      block.style.backgroundImage = 'url(' + skinImages[level].src + ')';
      block.style.backgroundSize = '100% 100%';
      block.style.backgroundRepeat = 'no-repeat';
      block.style.backgroundPosition = 'center';
      block.style.backgroundColor = 'transparent';
      block.textContent = '';
    } else {
      block.style.backgroundImage = 'none';
      block.style.backgroundSize = '';
      block.style.backgroundRepeat = '';
      block.style.backgroundPosition = '';
      block.style.background = getLevelColor(level);
      block.style.color = getLevelTextColor(level);
      block.textContent = level;
    }

    // Level 44 blocks: click to eliminate
    if (level === MAX_LEVEL) {
      block.style.cursor = 'pointer';
      block.style.boxShadow = '0 0 12px rgba(255,215,0,0.6), 0 2px 8px rgba(0,0,0,0.25)';
      if (!block._eliminateBound) {
        block._eliminateBound = () => eliminateMaxBlock(row, col);
        block.addEventListener('click', block._eliminateBound);
      }
    } else {
      block.style.cursor = '';
      block.style.boxShadow = '';
      if (block._eliminateBound) {
        block.removeEventListener('click', block._eliminateBound);
        block._eliminateBound = null;
      }
    }
  }

  // ===== Render entire board =====
  function renderBoard() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        renderCell(r, c);
      }
    }
  }

  // ===== Score display =====
  function updateScoreDisplay() {
    scoreEl.textContent = score;
    bestScoreEl.textContent = bestScore;
  }

  // ===== Next block preview =====
  function updateNextPreview() {
    if (skinImages[nextLevel]) {
      nextBlockEl.textContent = '';
      nextBlockEl.style.backgroundImage = 'url(' + skinImages[nextLevel].src + ')';
      nextBlockEl.style.backgroundSize = 'contain';
      nextBlockEl.style.backgroundRepeat = 'no-repeat';
      nextBlockEl.style.backgroundPosition = 'center';
      nextBlockEl.style.backgroundColor = 'transparent';
    } else {
      nextBlockEl.textContent = nextLevel;
      nextBlockEl.style.backgroundImage = '';
      nextBlockEl.style.background = getLevelColor(nextLevel);
      nextBlockEl.style.color = getLevelTextColor(nextLevel);
    }
  }

  // ===== Next-next block preview =====
  function updateNextNextPreview() {
    if (nextNextLevel <= 0) return;
    if (skinImages[nextNextLevel]) {
      nextNextBlockEl.textContent = '';
      nextNextBlockEl.style.backgroundImage = 'url(' + skinImages[nextNextLevel].src + ')';
      nextNextBlockEl.style.backgroundSize = 'contain';
      nextNextBlockEl.style.backgroundRepeat = 'no-repeat';
      nextNextBlockEl.style.backgroundPosition = 'center';
      nextNextBlockEl.style.backgroundColor = 'transparent';
    } else {
      nextNextBlockEl.textContent = nextNextLevel;
      nextNextBlockEl.style.backgroundImage = '';
      nextNextBlockEl.style.background = getLevelColor(nextNextLevel);
      nextNextBlockEl.style.color = getLevelTextColor(nextNextLevel);
    }
  }

  // ===== Generate next block level =====
  // First call (nextNextLevel===0): generate both fresh.
  // Subsequent calls: shift nextNextLevel → nextLevel, generate new nextNextLevel.
  function generateNextLevel() {
    if (nextNextLevel > 0) {
      nextLevel = nextNextLevel;
    } else {
      nextLevel = Math.floor(Math.random() * (maxSpawnLevel - minSpawnLevel + 1)) + minSpawnLevel;
    }
    // Pull from spawnQueue if hand card pushed items there, otherwise random
    if (spawnQueue.length > 0) {
      nextNextLevel = spawnQueue.shift();
    } else {
      nextNextLevel = Math.floor(Math.random() * (maxSpawnLevel - minSpawnLevel + 1)) + minSpawnLevel;
    }
    updateNextPreview();
    updateNextNextPreview();
  }

  // ===== Update spawn level range based on highest block on board =====
  // Rules:
  //   highest <= 8  → spawn 1-5
  //   highest = 9   → spawn 1-6
  //   highest = 10  → spawn 1-7
  //   highest = 11  → spawn 1-8
  //   highest >= 12 → min = highest-10, max = highest-3  (e.g. 12→2-9, 13→3-10)
  function updateSpawnRange() {
    let highest = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (grid[r][c] > highest) highest = grid[r][c];
      }
    }

    let newMin, newMax;
    if (highest <= 8) {
      newMin = 1; newMax = 5;
    } else if (highest === 9) {
      newMin = 1; newMax = 6;
    } else if (highest === 10) {
      newMin = 1; newMax = 7;
    } else if (highest === 11) {
      newMin = 1; newMax = 8;
    } else {
      // highest >= 12
      newMin = highest - 10;
      newMax = highest - 3;
    }

    minSpawnLevel = newMin;
    maxSpawnLevel = newMax;
  }

  // ===== Auto-eliminate blocks below minSpawnLevel =====
  // Returns a Promise<boolean> — true if any blocks were eliminated
  async function eliminateBelowMin() {
    // Collect cells to eliminate
    const toEliminate = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (grid[r][c] > 0 && grid[r][c] < minSpawnLevel) {
          toEliminate.push({ row: r, col: c });
        }
      }
    }
    if (toEliminate.length === 0) return false;

    // Step 1: Sweep flash across board + star particles
    boardEl.classList.add('sweep-flash');
    spawnStars(10 + Math.floor(Math.random() * 3)); // 10-12 stars
    await delay(470);
    boardEl.classList.remove('sweep-flash');

    // Step 2: Shake the blocks
    for (const { row, col } of toEliminate) {
      const cell = cellEls[row][col];
      const block = cell.querySelector('.block');
      if (block) block.classList.add('anim-shake');
    }
    await delay(320);

    // Step 3: Pop (shrink & disappear) + clear grid
    for (const { row, col } of toEliminate) {
      grid[row][col] = 0;
      renderCell(row, col, 'anim-pop');
    }
    await delay(220);

    return true;
  }

  // ===== Cleanup spawn queue & previews after minSpawnLevel changes =====
  function cleanupSpawnQueue() {
    if (nextLevel < minSpawnLevel) {
      nextLevel = Math.floor(Math.random() * (maxSpawnLevel - minSpawnLevel + 1)) + minSpawnLevel;
      updateNextPreview();
    }
    if (nextNextLevel > 0 && nextNextLevel < minSpawnLevel) {
      nextNextLevel = Math.floor(Math.random() * (maxSpawnLevel - minSpawnLevel + 1)) + minSpawnLevel;
      updateNextNextPreview();
    }
    spawnQueue = spawnQueue.filter(lv => lv >= minSpawnLevel);
  }

  // ===== Gravity: drop all floating blocks down =====
  function applyGravity() {
    let moved = false;
    for (let c = 0; c < COLS; c++) {
      let writePos = ROWS - 1;
      for (let r = ROWS - 1; r >= 0; r--) {
        if (grid[r][c] !== 0) {
          if (r !== writePos) {
            grid[writePos][c] = grid[r][c];
            grid[r][c] = 0;
            moved = true;
          }
          writePos--;
        }
      }
    }
    return moved;
  }


  // ===== Find neighbors of same level =====
  function findSameNeighbors(row, col) {
    const level = grid[row][col];
    if (level <= 0) return [];
    const neighbors = [];
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dr, dc] of dirs) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && grid[nr][nc] === level) {
        neighbors.push({ row: nr, col: nc });
      }
    }
    return neighbors;
  }

  // ===== Score popup effect =====
  function showScorePopup(row, col, points) {
    const cell = cellEls[row][col];
    const popup = document.createElement('div');
    popup.className = 'score-popup';
    popup.textContent = '+' + points;
    cell.appendChild(popup);
    setTimeout(() => popup.remove(), 700);
  }

  // ===== Merge logic at a specific cell =====
  // Returns true if a merge happened
  function tryMerge(row, col) {
    const level = grid[row][col];
    if (level <= 0 || level >= MAX_LEVEL) return false;

    const neighbors = findSameNeighbors(row, col);
    if (neighbors.length === 0) return false;

    // Number of blocks merging (including self): neighbors.length + 1
    // But rule: N same-level neighbors merge into level + N
    // "2 same (new+1 old) -> +1, 3 same (new+2 old) -> +2, 4 same (new+3 old) -> +3"
    const mergeCount = neighbors.length; // number of old blocks consumed
    const newLevel = Math.min(level + mergeCount, MAX_LEVEL);

    // Calculate score: base score for merge
    const points = newLevel * mergeCount * 10;
    score += points;
    if (score > bestScore) bestScore = score;

    // Play merge sound
    playSfxMerge();

    // Remove neighbors
    for (const n of neighbors) {
      grid[n.row][n.col] = 0;
      renderCell(n.row, n.col, 'anim-pop');
    }

    // Upgrade current cell
    grid[row][col] = newLevel;
    renderCell(row, col, 'anim-merge');
    showScorePopup(row, col, points);
    updateScoreDisplay();

    return true;
  }

  // ===== Chain merge + gravity loop =====
  // Tracks the "active block" (newest/merged block) through gravity.
  // Always tries to merge FROM the active block first (neighbors merge toward it).
  async function chainMergeAndGravity(startRow, startCol) {
    let activeRow = startRow;
    let activeCol = startCol;
    let activeLevel = (activeRow >= 0 && activeCol >= 0) ? grid[activeRow][activeCol] : 0;
    let comboCount = 0;

    // Initial merge at placed position
    if (activeRow >= 0 && activeCol >= 0 && tryMerge(activeRow, activeCol)) {
      comboCount++;
      activeLevel = grid[activeRow][activeCol];
      triggerComboEffects(activeRow, activeCol, comboCount);
      await delay(180);
    }

    let safety = 200;
    while (--safety > 0) {
      // Gravity: all blocks fall
      if (applyGravity()) {
        renderBoard();
        await delay(120);

        // Track where active block ended up after gravity (same column, may have fallen)
        // Search DOWNWARD from old position — block can only fall, not rise
        if (activeRow >= 0 && activeCol >= 0 && grid[activeRow][activeCol] !== activeLevel) {
          let found = false;
          for (let r = activeRow; r < ROWS; r++) {
            if (grid[r][activeCol] === activeLevel) {
              activeRow = r;
              found = true;
              break;
            }
          }
          if (!found) { activeRow = -1; activeCol = -1; }
        }
      }

      let merged = false;

      // Priority 1: try merge at active block (the "new" block, neighbors merge toward it)
      if (activeRow >= 0 && activeCol >= 0 &&
          grid[activeRow][activeCol] > 0 && grid[activeRow][activeCol] < MAX_LEVEL) {
        if (tryMerge(activeRow, activeCol)) {
          comboCount++;
          activeLevel = grid[activeRow][activeCol];
          triggerComboEffects(activeRow, activeCol, comboCount);
          merged = true;
          await delay(180);
        }
      }

      // Priority 2: scan for any other merges (gravity-triggered, e.g. fallen blocks)
      if (!merged) {
        let bestR = -1, bestC = -1, bestCount = 0;
        for (let r = ROWS - 1; r >= 0; r--) {
          for (let c = 0; c < COLS; c++) {
            if (grid[r][c] > 0 && grid[r][c] < MAX_LEVEL) {
              const n = findSameNeighbors(r, c).length;
              if (n > bestCount) {
                bestCount = n;
                bestR = r;
                bestC = c;
              }
            }
          }
        }
        if (bestCount > 0 && tryMerge(bestR, bestC)) {
          comboCount++;
          activeRow = bestR;
          activeCol = bestC;
          activeLevel = grid[bestR][bestC];
          triggerComboEffects(bestR, bestC, comboCount);
          merged = true;
          await delay(180);
        }
      }

      if (!merged) break;
    }

    // Final settle
    if (applyGravity()) {
      renderBoard();
      await delay(80);
    }

    updateSpawnRange();
    return comboCount;
  }

  // ===== Trigger end-of-chain broadcast + cheer + confetti =====
  function triggerChainEndEffects(comboCount) {
    if (comboCount >= 3) showBroadcast(comboCount);
    if (comboCount >= 4) {
      playSfxCheer();
      spawnConfetti(comboCount >= 6 ? 30 : comboCount >= 5 ? 22 : 15);
    }
  }

  // ===== Canvas Particle System =====
  const fxCanvas = document.getElementById('fx-canvas');
  const fxCtx = fxCanvas.getContext('2d');
  var particles = [];
  var fxRAFRunning = false;

  // Preload particle images
  var fxImages = {};
  var FX_IMAGE_SRCS = {
    '红色气泡': 'effects/红色气泡.png',
    '蓝色气泡': 'effects/蓝色气泡.png',
    '黄色闪光星星': 'effects/黄色闪光星星.png',
    '蓝色闪光星星': 'effects/蓝色闪光星星.png',
    '红色闪光星星': 'effects/红色闪光星星.png',
    '黄色实心星星': 'effects/黄色实心星星.png',
    '蓝色实心星星': 'effects/蓝色实心星星.png'
  };
  function preloadFxImages() {
    for (var key in FX_IMAGE_SRCS) {
      var img = new Image();
      img.src = FX_IMAGE_SRCS[key];
      fxImages[key] = img;
    }
  }

  // Pre-rendered glow sprite (avoids per-frame createRadialGradient)
  var glowSprite = null;
  function getGlowSprite() {
    if (glowSprite) return glowSprite;
    glowSprite = document.createElement('canvas');
    glowSprite.width = 128;
    glowSprite.height = 128;
    var gctx = glowSprite.getContext('2d');
    var g = gctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255, 215, 0, 0.55)');
    g.addColorStop(0.4, 'rgba(255, 165, 0, 0.2)');
    g.addColorStop(1, 'transparent');
    gctx.fillStyle = g;
    gctx.fillRect(0, 0, 128, 128);
    return glowSprite;
  }

  // Cap total particles to keep per-frame cost bounded
  var MAX_PARTICLES = 80;
  function pushParticle(p) {
    if (particles.length < MAX_PARTICLES) {
      particles.push(p);
    }
  }

  // Canvas size sync (call on init and resize)
  function resizeFxCanvas() {
    var rect = boardEl.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.round(rect.width * dpr);
    var h = Math.round(rect.height * dpr);
    // Skip reallocation unless the size actually changed (realloc is expensive)
    if (fxCanvas.width === w && fxCanvas.height === h) return;
    fxCanvas.width = w;
    fxCanvas.height = h;
    fxCanvas.style.width = rect.width + 'px';
    fxCanvas.style.height = rect.height + 'px';
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Debounce resize — iOS fires it often (URL bar, rotation), and each realloc janks
  var resizeTimer = null;
  function onResizeFx() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      resizeFxCanvas();
    }, 150);
  }

  // Convert cell row/col to canvas-local coordinates (center of cell)
  function cellToCanvasPos(row, col) {
    var cellEl = cellEls[row][col];
    var boardRect = boardEl.getBoundingClientRect();
    var cellRect = cellEl.getBoundingClientRect();
    return {
      x: cellRect.left - boardRect.left + cellRect.width / 2,
      y: cellRect.top - boardRect.top + cellRect.height / 2
    };
  }

  // Single RAF loop for all canvas particles
  var lastFxTime = 0;
  function fxLoop(now) {
    if (particles.length === 0) {
      fxRAFRunning = false;
      var dpr = window.devicePixelRatio || 1;
      fxCtx.clearRect(0, 0, fxCanvas.width / dpr, fxCanvas.height / dpr);
      return;
    }
    var dt = lastFxTime ? Math.min((now - lastFxTime) / 1000, 0.05) : 0.016;
    lastFxTime = now;

    var dpr = window.devicePixelRatio || 1;
    var cw = fxCanvas.width / dpr;
    var ch = fxCanvas.height / dpr;
    fxCtx.clearRect(0, 0, cw, ch);

    var i = particles.length;
    while (i--) {
      var p = particles[i];
      // Handle delay
      if (p.delay > 0) { p.delay -= dt; continue; }

      p.elapsed += dt;
      if (p.elapsed >= p.lifetime) { particles.splice(i, 1); continue; }

      // Physics update
      if (p.friction) p.vx *= p.friction;
      p.vy += (p.gravity || 0) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += (p.rotSpeed || 0) * dt;

      // Scale based on lifetime progress: grow fast → peak → shrink
      var progress = p.elapsed / p.lifetime;
      var scale;
      if (p.scaleMax !== undefined) {
        if (progress < 0.12) {
          // Rapid grow to peak
          scale = p.scaleMax * (progress / 0.12);
        } else if (progress < 0.3) {
          // Hold near peak
          scale = p.scaleMax;
        } else {
          // Shrink to scaleEnd
          scale = p.scaleMax + (p.scaleEnd - p.scaleMax) * ((progress - 0.3) / 0.7);
        }
      } else {
        scale = 1;
      }

      // Fade out in last 30%
      var alpha = p.opacity;
      if (progress > 0.7) {
        alpha *= (1 - (progress - 0.7) / 0.3);
      }

      // Draw
      fxCtx.save();
      fxCtx.globalAlpha = Math.max(0, alpha);
      fxCtx.translate(p.x, p.y);
      fxCtx.rotate(p.rotation);
      fxCtx.scale(scale, scale);

      if (p.img && p.img.complete && p.img.naturalWidth > 0) {
        fxCtx.drawImage(p.img, -p.size / 2, -p.size / 2, p.size, p.size);
      } else if (p.color) {
        fxCtx.fillStyle = p.color;
        if (p.shape === 'dot') {
          fxCtx.beginPath();
          fxCtx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          fxCtx.fill();
        } else {
          // ribbon / squiggle
          fxCtx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
        }
      } else if (p.type === 'glow') {
        // Radial gradient glow (pre-rendered sprite)
        fxCtx.drawImage(getGlowSprite(), -p.size, -p.size, p.size * 2, p.size * 2);
      }

      fxCtx.restore();
    }

    requestAnimationFrame(fxLoop);
  }

  function startFxLoop() {
    if (!fxRAFRunning) {
      fxRAFRunning = true;
      lastFxTime = 0;
      requestAnimationFrame(fxLoop);
    }
  }

  // Confetti colors for canvas confetti
  var CONFETTI_COLORS = ['#ff4757', '#ff6b81', '#3742fa', '#70a1ff', '#ffa502', '#ffdd59', '#2ed573', '#7bed9f', '#e056fd', '#be2edd'];
  var CONFETTI_STAR_KEYS = ['黄色闪光星星', '蓝色闪光星星', '红色闪光星星', '黄色实心星星', '蓝色实心星星'];

  function spawnConfetti(count) {
    var bRect = boardEl.getBoundingClientRect();
    var originX = bRect.width * 0.5;
    var originY = bRect.height * 0.15;

    for (var i = 0; i < count; i++) {
      var angle = Math.random() * Math.PI * 2;
      var speed = 180 + Math.random() * 250;
      var vx = Math.cos(angle) * speed;
      var vy = Math.sin(angle) * speed - 120;
      var isStar = Math.random() < 0.25;

      if (isStar) {
        var key = CONFETTI_STAR_KEYS[Math.floor(Math.random() * CONFETTI_STAR_KEYS.length)];
        var sz = 14 + Math.random() * 10;
        pushParticle({
          type: 'confetti', x: originX, y: originY, vx: vx, vy: vy,
          gravity: 420 + Math.random() * 150, size: sz,
          rotation: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 14,
          opacity: 1, lifetime: 1.6 + Math.random() * 0.8, elapsed: 0,
          img: fxImages[key], friction: 0.985, delay: Math.random() * 0.15
        });
      } else {
        var isDot = Math.random() < 0.33;
        var color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
        if (isDot) {
          pushParticle({
            type: 'confetti', x: originX, y: originY, vx: vx, vy: vy,
            gravity: 420 + Math.random() * 150, size: 5 + Math.random() * 6,
            rotation: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 14,
            opacity: 1, lifetime: 1.6 + Math.random() * 0.8, elapsed: 0,
            color: color, shape: 'dot', friction: 0.985, delay: Math.random() * 0.15
          });
        } else {
          var w = 5 + Math.random() * 7;
          var h = 12 + Math.random() * 14;
          pushParticle({
            type: 'confetti', x: originX, y: originY, vx: vx, vy: vy,
            gravity: 420 + Math.random() * 150, size: Math.max(w, h),
            width: w, height: h,
            rotation: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 14,
            opacity: 1, lifetime: 1.6 + Math.random() * 0.8, elapsed: 0,
            color: color, shape: 'ribbon', friction: 0.985, delay: Math.random() * 0.15
          });
        }
      }
    }

    startFxLoop();
  }

  // ===== Eliminate max-level block =====
  async function eliminateMaxBlock(row, col) {
    if (isAnimating || gameOver) return;
    if (grid[row][col] !== MAX_LEVEL) return;

    isAnimating = true;
    grid[row][col] = 0;
    renderCell(row, col, 'anim-pop');
    score += 1000;
    if (score > bestScore) bestScore = score;
    showScorePopup(row, col, 1000);
    updateScoreDisplay();

    await delay(200);

    // Gravity + chain merge (reuse same logic, pass a dummy position)
    let maxCombo = await chainMergeAndGravity(-1, -1);

    // Auto-eliminate blocks below new minSpawnLevel
    if (await eliminateBelowMin()) {
      cleanupSpawnQueue();
      renderBoard();
      await delay(300);
      const c2 = await chainMergeAndGravity(-1, -1);
      if (c2 > maxCombo) maxCombo = c2;
    }

    triggerChainEndEffects(maxCombo);
    saveGame();
    isAnimating = false;
  }

  // ===== Find lowest empty row in a column =====
  function lowestEmptyRow(col) {
    for (let r = ROWS - 1; r >= 0; r--) {
      if (grid[r][col] === 0) return r;
    }
    return -1; // column full
  }

  // ===== Animate block falling from arrow row to landing cell =====
  function animateDrop(row, col) {
    return new Promise(resolve => {
      const targetCell = cellEls[row][col];
      const actualBlock = targetCell.querySelector('.block');
      if (!actualBlock) { resolve(); return; }

      // Get positions: start from the arrow button, end at the target cell
      const arrowBtn = arrowRow.children[col];
      const startRect = arrowBtn.getBoundingClientRect();
      const endRect = targetCell.getBoundingClientRect();

      // Clone the block as a floating element
      const floater = actualBlock.cloneNode(true);
      floater.style.position = 'fixed';
      floater.style.inset = 'auto';
      floater.style.left = endRect.left + 'px';
      floater.style.top = startRect.top + 'px';
      floater.style.width = endRect.width + 'px';
      floater.style.height = endRect.height + 'px';
      floater.style.zIndex = '50';
      floater.style.pointerEvents = 'none';
      floater.style.borderRadius = '0';
      document.body.appendChild(floater);

      // Hide actual block during animation
      actualBlock.style.visibility = 'hidden';

      // Force reflow
      floater.offsetHeight;

      // Animate — duration proportional to distance, ease-in for gravity feel
      const duration = 80 + (row + 1) * 30;
      floater.style.transition = 'top ' + duration + 'ms cubic-bezier(0.4, 0, 1, 1)';
      floater.style.top = endRect.top + 'px';

      let resolved = false;
      const onEnd = () => {
        if (resolved) return;
        resolved = true;
        floater.removeEventListener('transitionend', onEnd);
        floater.remove();
        actualBlock.style.visibility = '';
        resolve();
      };
      floater.addEventListener('transitionend', onEnd);
      setTimeout(onEnd, duration + 80);
    });
  }

  // ===== Drop block into column =====
  async function dropBlock(col) {
    if (isAnimating || gameOver) return;
    isAnimating = true;

    // Save snapshot before any state mutation
    lastSnapshot = {
      grid: grid.map(row => [...row]),
      score: score,
      bestScore: bestScore,
      nextLevel: nextLevel,
      nextNextLevel: nextNextLevel,
      spawnQueue: [...spawnQueue],
      minSpawnLevel: minSpawnLevel,
      maxSpawnLevel: maxSpawnLevel
    };

    const level = nextLevel;
    const landRow = lowestEmptyRow(col);

    // Column completely full — can't drop
    if (landRow === -1) {
      isAnimating = false;
      return;
    }

    // If the only free spot is the buffer row (row 0), rows 1-5 are full.
    // Per rules: merge with row 1 if same level, else Game Over.
    if (landRow === 0) {
      grid[0][col] = level;
      renderCell(0, col);
      playSfxDrop();
      await animateDrop(0, col);

      let maxCombo0 = 0;
      if (grid[1][col] === level) {
        // Merge possible — run chain merge (will merge row-1 into row-0, then gravity)
        maxCombo0 = await chainMergeAndGravity(0, col);
      }

      // Auto-eliminate blocks below new minSpawnLevel
      if (await eliminateBelowMin()) {
        cleanupSpawnQueue();
        renderBoard();
        await delay(300);
        const c2 = await chainMergeAndGravity(-1, -1);
        if (c2 > maxCombo0) maxCombo0 = c2;
      }

      triggerChainEndEffects(maxCombo0);

      // After chain, if buffer still occupied → overflow warning
      if (grid[0][col] !== 0) {
        showOverflowWarning();
        isAnimating = false;
        return;
      }
      generateNextLevel();
      saveGame();
      isAnimating = false;
      return;
    }

    // Normal case: land in main area (row >= 1)
    grid[landRow][col] = level;
    renderCell(landRow, col);
    playSfxDrop();
    await animateDrop(landRow, col);

    // Chain merge + gravity
    let maxCombo = await chainMergeAndGravity(landRow, col);

    // Auto-eliminate blocks below new minSpawnLevel (e.g. all 1s disappear when highest reaches 12)
    if (await eliminateBelowMin()) {
      cleanupSpawnQueue();
      renderBoard();
      await delay(300);
      // Gravity + chain merge after elimination
      const c2 = await chainMergeAndGravity(-1, -1);
      if (c2 > maxCombo) maxCombo = c2;
    }

    triggerChainEndEffects(maxCombo);

    // Safety: check buffer overflow after chains
    let bufferOccupied = false;
    for (let c2 = 0; c2 < COLS; c2++) {
      if (grid[0][c2] !== 0) { bufferOccupied = true; break; }
    }

    if (bufferOccupied) {
      showOverflowWarning();
    } else {
      generateNextLevel();
      saveGame();
    }

    isAnimating = false;
  }

  // ===== Game Over =====
  function endGame() {
    gameOver = true;
    finalScoreEl.textContent = '得分: ' + score;
    overlay.classList.add('active');
    // Persist best score, clear game save
    try {
      localStorage.setItem(STORAGE_KEY + '_best', String(bestScore));
    } catch (e) { /* ignore */ }
    cancelPendingSave();
    localStorage.removeItem(STORAGE_KEY);
  }

  // ===== Overflow Warning =====
  function showOverflowWarning() {
    overflowWarning.classList.add('active');
    isAnimating = false;
  }

  function undoLastMove() {
    if (!lastSnapshot) return;
    grid = lastSnapshot.grid.map(row => [...row]);
    score = lastSnapshot.score;
    bestScore = lastSnapshot.bestScore;
    nextLevel = lastSnapshot.nextLevel;
    nextNextLevel = lastSnapshot.nextNextLevel;
    spawnQueue = [...lastSnapshot.spawnQueue];
    minSpawnLevel = lastSnapshot.minSpawnLevel;
    maxSpawnLevel = lastSnapshot.maxSpawnLevel;
    lastSnapshot = null;

    overflowWarning.classList.remove('active');
    renderBoard();
    updateScoreDisplay();
    updateNextPreview();
    updateNextNextPreview();
    saveGame();
  }

  // ===== New Game =====
  function newGame() {
    if (brushMode) exitBrushMode();
    if (hammerMode) exitHammerMode();
    if (swapMode) exitSwapMode();
    grid = [];
    for (let r = 0; r < ROWS; r++) {
      grid[r] = new Array(COLS).fill(0);
    }
    score = 0;
    minSpawnLevel = 1;
    maxSpawnLevel = 5;
    spawnQueue = [];
    nextNextLevel = 0; // reset so generateNextLevel creates both fresh
    gameOver = false;
    isAnimating = false;
    overlay.classList.remove('active');
    overflowWarning.classList.remove('active');

    loadBestScore();
    updateScoreDisplay();
    generateNextLevel();
    renderBoard();
    saveGame();
  }

  // ===== Save / Load =====
  function writeSave() {
    const data = {
      grid: grid,
      score: score,
      bestScore: bestScore,
      nextLevel: nextLevel,
      nextNextLevel: nextNextLevel,
      minSpawnLevel: minSpawnLevel,
      maxSpawnLevel: maxSpawnLevel,
      spawnQueue: spawnQueue
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* ignore */ }
  }

  // Debounce saves so the synchronous localStorage write doesn't jank every move
  let saveTimer = null;
  function saveGame() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      writeSave();
    }, 250);
  }

  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writeSave();
  }

  function cancelPendingSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  function loadGame() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data.grid || data.grid.length !== ROWS) return false;

      grid = data.grid;
      score = data.score || 0;
      bestScore = data.bestScore || 0;
      nextLevel = data.nextLevel || 1;
      nextNextLevel = data.nextNextLevel || Math.floor(Math.random() * (data.maxSpawnLevel || 5)) + 1;
      minSpawnLevel = data.minSpawnLevel || 1;
      maxSpawnLevel = data.maxSpawnLevel || 5;
      spawnQueue = Array.isArray(data.spawnQueue) ? data.spawnQueue : [];
      gameOver = false;
      isAnimating = false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function loadBestScore() {
    try {
      // Check dedicated best-score key first
      const best = localStorage.getItem(STORAGE_KEY + '_best');
      if (best) {
        const val = parseInt(best, 10);
        if (val > bestScore) bestScore = val;
      }
      // Also check save data
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.bestScore > bestScore) bestScore = data.bestScore;
      }
    } catch (e) { /* ignore */ }
  }

  // ===== Utility =====
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ===== Event Handlers =====
  function onArrowClick(e) {
    if (brushMode || hammerMode || swapMode) return;
    const btn = e.target.closest('.arrow-btn');
    if (!btn) return;
    const col = parseInt(btn.dataset.col);
    if (!isNaN(col)) dropBlock(col);
  }

  // ===== Hand Card Feature =====
  const handCardOverlay = document.getElementById('hand-card-overlay');
  const handCardGrid = document.getElementById('hand-card-grid');
  const handCardConfirm = document.getElementById('hand-card-confirm');
  const btnHandCard = document.getElementById('btn-hand-card');
  let handCardSelectedLevel = 0;

  function openHandCardPanel() {
    if (isAnimating || gameOver) return;
    if (brushMode) exitBrushMode();
    if (hammerMode) exitHammerMode();
    if (swapMode) exitSwapMode();

    handCardSelectedLevel = 0;
    handCardConfirm.disabled = true;
    handCardGrid.innerHTML = '';

    for (let lv = minSpawnLevel; lv <= maxSpawnLevel; lv++) {
      const item = document.createElement('div');
      item.className = 'hand-card-item';
      item.dataset.level = lv;

      if (skinImages[lv]) {
        item.style.backgroundImage = 'url(' + skinImages[lv].src + ')';
        item.style.backgroundSize = '100% 100%';
        item.style.backgroundRepeat = 'no-repeat';
        item.style.backgroundPosition = 'center';
        item.style.backgroundColor = 'transparent';
      } else {
        item.style.background = getLevelColor(lv);
        item.style.color = getLevelTextColor(lv);
        item.textContent = lv;
      }

      item.addEventListener('click', function () {
        // Deselect previous
        const prev = handCardGrid.querySelector('.hand-card-item.selected');
        if (prev) prev.classList.remove('selected');
        // Select this one
        item.classList.add('selected');
        handCardSelectedLevel = lv;
        handCardConfirm.disabled = false;
      });

      handCardGrid.appendChild(item);
    }

    handCardOverlay.classList.add('active');
  }

  function closeHandCardPanel() {
    handCardOverlay.classList.remove('active');
    handCardSelectedLevel = 0;
  }

  function confirmHandCard() {
    if (handCardSelectedLevel <= 0) return;

    // Insert selected level as next; push displaced blocks into queue
    spawnQueue.unshift(nextNextLevel); // save old nextNext
    nextNextLevel = nextLevel;         // old next becomes nextNext
    nextLevel = handCardSelectedLevel; // selected becomes next
    updateNextPreview();
    updateNextNextPreview();

    closeHandCardPanel();
    saveGame();
  }

  // Close on backdrop click (outside panel)
  handCardOverlay.addEventListener('click', function (e) {
    if (e.target === handCardOverlay) {
      closeHandCardPanel();
    }
  });

  btnHandCard.addEventListener('click', openHandCardPanel);
  handCardConfirm.addEventListener('click', confirmHandCard);

  // ===== Bath Brush Feature (洗澡刷) =====
  const btnBrush = document.getElementById('btn-brush');

  function enterBrushMode() {
    if (isAnimating || gameOver) return;
    if (hammerMode) exitHammerMode();
    if (swapMode) exitSwapMode();
    brushMode = true;
    brushDragging = false;
    brushCenterRow = -1;
    brushCenterCol = -1;
    btnBrush.classList.add('brush-active');
    boardEl.classList.add('brush-mode');
  }

  function exitBrushMode() {
    brushMode = false;
    brushDragging = false;
    clearBrushHighlight();
    btnBrush.classList.remove('brush-active');
    boardEl.classList.remove('brush-mode');
    // Block the click event that fires after mouseup
    _brushBlockClick = true;
    setTimeout(function () { _brushBlockClick = false; }, 80);
  }

  function clampBrushCenter(row, col) {
    return {
      row: Math.max(2, Math.min(4, row)),
      col: Math.max(1, Math.min(3, col))
    };
  }

  function clearBrushHighlight() {
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        cellEls[r][c].classList.remove('brush-highlight');
      }
    }
  }

  function updateBrushHighlight(centerRow, centerCol) {
    clearBrushHighlight();
    if (centerRow < 0) return;
    for (var dr = -1; dr <= 1; dr++) {
      for (var dc = -1; dc <= 1; dc++) {
        var r = centerRow + dr;
        var c = centerCol + dc;
        if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
          cellEls[r][c].classList.add('brush-highlight');
        }
      }
    }
  }

  function getCellFromPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return null;
    var cell = el.closest('.cell');
    if (!cell) return null;
    return {
      row: parseInt(cell.dataset.row),
      col: parseInt(cell.dataset.col)
    };
  }

  function onBrushBtnClick(e) {
    e.stopPropagation();
    if (brushMode) {
      exitBrushMode();
      return;
    }
    enterBrushMode();
  }

  // --- Pointer handlers for brush selection ---
  function brushPointerDown(x, y) {
    if (!brushMode) return;
    var cellPos = getCellFromPoint(x, y);
    if (!cellPos) return;

    brushDragging = true;
    var clamped = clampBrushCenter(cellPos.row, cellPos.col);
    brushCenterRow = clamped.row;
    brushCenterCol = clamped.col;
    updateBrushHighlight(brushCenterRow, brushCenterCol);
  }

  function brushPointerMove(x, y) {
    if (!brushMode || !brushDragging) return;
    var cellPos = getCellFromPoint(x, y);
    if (!cellPos) return;

    var clamped = clampBrushCenter(cellPos.row, cellPos.col);
    if (clamped.row !== brushCenterRow || clamped.col !== brushCenterCol) {
      brushCenterRow = clamped.row;
      brushCenterCol = clamped.col;
      updateBrushHighlight(brushCenterRow, brushCenterCol);
    }
  }

  function brushPointerUp(x, y) {
    if (!brushMode) return;
    if (!brushDragging) {
      // If not dragging and release is outside board, cancel
      var cellPos = getCellFromPoint(x, y);
      if (!cellPos || !boardEl.contains(document.elementFromPoint(x, y))) {
        exitBrushMode();
      }
      return;
    }
    brushDragging = false;

    var cellPos = getCellFromPoint(x, y);
    if (!cellPos) {
      // Released outside board → cancel
      exitBrushMode();
      return;
    }

    var clamped = clampBrushCenter(cellPos.row, cellPos.col);
    clearBrushHighlight();
    exitBrushMode();
    executeBrushEffect(clamped.row, clamped.col);
  }

  // Mouse event handlers
  function onBoardMouseDown(e) {
    if (!brushMode) return;
    e.preventDefault();
    brushPointerDown(e.clientX, e.clientY);
  }

  function onWindowMouseMove(e) {
    if (!brushMode || !brushDragging) return;
    brushPointerMove(e.clientX, e.clientY);
  }

  function onWindowMouseUp(e) {
    if (!brushMode) return;
    brushPointerUp(e.clientX, e.clientY);
  }

  // Touch event handlers
  function onBoardTouchStart(e) {
    if (!brushMode) return;
    e.preventDefault();
    var t = e.touches[0];
    brushPointerDown(t.clientX, t.clientY);
  }

  function onBoardTouchMove(e) {
    if (!brushMode || !brushDragging) return;
    e.preventDefault();
    var t = e.touches[0];
    brushPointerMove(t.clientX, t.clientY);
  }

  function onWindowTouchEnd(e) {
    if (!brushMode) return;
    // Use changedTouches for final position
    var t = e.changedTouches[0];
    brushPointerUp(t.clientX, t.clientY);
  }

  // Cancel brush/hammer/swap mode on any click outside board
  function onDocClickCancelBrush(e) {
    // Hammer mode: cancel on click outside board
    if (hammerMode) {
      if (btnHammer.contains(e.target)) return;
      if (!boardEl.contains(e.target)) {
        exitHammerMode();
      }
      return;
    }
    // Swap mode: cancel on click outside board
    if (swapMode) {
      if (btnSwap.contains(e.target)) return;
      if (!boardEl.contains(e.target)) {
        exitSwapMode();
      }
      return;
    }
    if (!brushMode) return;
    if (brushDragging) return;
    // Ignore clicks on the brush button itself (handled by onBrushBtnClick)
    if (btnBrush.contains(e.target)) return;
    // If click is outside board, cancel
    if (!boardEl.contains(e.target)) {
      exitBrushMode();
    }
  }

  // ===== Brush Core Algorithm =====
  async function executeBrushEffect(centerRow, centerCol) {
    isAnimating = true;

    var r0 = centerRow - 1; // top-left row of 3×3
    var c0 = centerCol - 1; // top-left col of 3×3

    // Step 1: Rearrange — collect non-empty levels, sort descending, place back
    var levels = [];
    for (var dr = 0; dr < 3; dr++) {
      for (var dc = 0; dc < 3; dc++) {
        var lv = grid[r0 + dr][c0 + dc];
        if (lv > 0) levels.push(lv);
      }
    }

    if (levels.length === 0) {
      isAnimating = false;
      return;
    }

    levels.sort(function (a, b) { return b - a; }); // descending

    // Place back: bottom-left is highest, fill right then up; empties at top
    var idx = 0;
    for (var dr = 2; dr >= 0; dr--) {
      for (var dc = 0; dc < 3; dc++) {
        grid[r0 + dr][c0 + dc] = idx < levels.length ? levels[idx++] : 0;
      }
    }

    // Render rearranged blocks with appear animation
    for (var dr = 0; dr < 3; dr++) {
      for (var dc = 0; dc < 3; dc++) {
        renderCell(r0 + dr, c0 + dc, 'anim-appear');
      }
    }
    await delay(350);

    // Step 2: Horizontal merge loop (pair-wise, left-to-right per row)
    var hMerged = true;
    while (hMerged) {
      hMerged = false;
      for (var dr = 0; dr < 3; dr++) {
        for (var dc = 0; dc < 2; dc++) {
          var r = r0 + dr;
          var cL = c0 + dc;
          var cR = c0 + dc + 1;
          if (grid[r][cL] > 0 && grid[r][cL] < MAX_LEVEL && grid[r][cL] === grid[r][cR]) {
            var newLevel = Math.min(grid[r][cL] + 1, MAX_LEVEL);
            var points = newLevel * 10;
            score += points;
            if (score > bestScore) bestScore = score;

            grid[r][cL] = newLevel;
            grid[r][cR] = 0;

            renderCell(r, cL, 'anim-merge');
            renderCell(r, cR, 'anim-pop');
            showScorePopup(r, cL, points);
            updateScoreDisplay();

            hMerged = true;
            await delay(300);
            // Restart scan from beginning after each merge
            break;
          }
        }
        if (hMerged) break;
      }
    }

    // Step 3: Vertical merge loop (pair-wise, bottom-to-top per column)
    var vMerged = true;
    while (vMerged) {
      vMerged = false;
      for (var dc = 0; dc < 3; dc++) {
        for (var dr = 2; dr >= 1; dr--) {
          var rBot = r0 + dr;
          var rTop = r0 + dr - 1;
          var c = c0 + dc;
          if (grid[rBot][c] > 0 && grid[rBot][c] < MAX_LEVEL && grid[rBot][c] === grid[rTop][c]) {
            var newLevel = Math.min(grid[rBot][c] + 1, MAX_LEVEL);
            var points = newLevel * 10;
            score += points;
            if (score > bestScore) bestScore = score;

            grid[rBot][c] = newLevel;
            grid[rTop][c] = 0;

            renderCell(rBot, c, 'anim-merge');
            renderCell(rTop, c, 'anim-pop');
            showScorePopup(rBot, c, points);
            updateScoreDisplay();

            vMerged = true;
            await delay(300);
            break;
          }
        }
        if (vMerged) break;
      }
    }

    // Step 4: Restore gravity — 3×3 restriction lifted
    if (applyGravity()) {
      renderBoard();
      await delay(200);
    }

    let maxCombo = await chainMergeAndGravity(-1, -1);

    if (await eliminateBelowMin()) {
      cleanupSpawnQueue();
      renderBoard();
      await delay(300);
      const c2 = await chainMergeAndGravity(-1, -1);
      if (c2 > maxCombo) maxCombo = c2;
    }

    triggerChainEndEffects(maxCombo);
    updateSpawnRange();
    saveGame();
    isAnimating = false;
  }

  // ===== Hammer Feature (锤子) =====
  const btnHammer = document.getElementById('btn-hammer');

  function enterHammerMode() {
    if (isAnimating || gameOver) return;
    if (brushMode) exitBrushMode();
    if (swapMode) exitSwapMode();
    hammerMode = true;
    btnHammer.classList.add('hammer-active');
    boardEl.classList.add('hammer-mode');
  }

  function exitHammerMode() {
    hammerMode = false;
    btnHammer.classList.remove('hammer-active');
    boardEl.classList.remove('hammer-mode');
  }

  function onHammerBtnClick(e) {
    e.stopPropagation();
    if (hammerMode) {
      exitHammerMode();
      return;
    }
    enterHammerMode();
  }

  async function executeHammer(row, col) {
    if (grid[row][col] === 0) {
      exitHammerMode();
      return;
    }
    grid[row][col] = 0;
    renderCell(row, col, 'anim-pop');
    exitHammerMode();

    isAnimating = true;
    await delay(220);
    applyGravity();
    renderBoard();
    await delay(120);
    let maxCombo = await chainMergeAndGravity(-1, -1);

    if (await eliminateBelowMin()) {
      cleanupSpawnQueue();
      renderBoard();
      await delay(300);
      const c2 = await chainMergeAndGravity(-1, -1);
      if (c2 > maxCombo) maxCombo = c2;
    }

    triggerChainEndEffects(maxCombo);
    saveGame();
    isAnimating = false;
  }

  // ===== Swap Feature (交换) =====
  const btnSwap = document.getElementById('btn-swap');

  function enterSwapMode() {
    if (isAnimating || gameOver) return;
    if (brushMode) exitBrushMode();
    if (hammerMode) exitHammerMode();
    swapMode = true;
    swapFirstCell = null;
    btnSwap.classList.add('swap-active');
    boardEl.classList.add('swap-mode');
  }

  function exitSwapMode() {
    swapMode = false;
    // Remove any swap-selected highlight
    if (swapFirstCell) {
      cellEls[swapFirstCell.row][swapFirstCell.col].classList.remove('swap-selected');
    }
    swapFirstCell = null;
    btnSwap.classList.remove('swap-active');
    boardEl.classList.remove('swap-mode');
  }

  function onSwapBtnClick(e) {
    e.stopPropagation();
    if (swapMode) {
      exitSwapMode();
      return;
    }
    enterSwapMode();
  }

  async function executeSwap(row1, col1, row2, col2) {
    // Swap grid values
    const tmp = grid[row1][col1];
    grid[row1][col1] = grid[row2][col2];
    grid[row2][col2] = tmp;

    // Render both with animation
    renderCell(row1, col1, 'anim-appear');
    renderCell(row2, col2, 'anim-appear');

    exitSwapMode();

    isAnimating = true;
    await delay(260);
    applyGravity();
    renderBoard();
    await delay(120);
    let maxCombo = await chainMergeAndGravity(-1, -1);

    if (await eliminateBelowMin()) {
      cleanupSpawnQueue();
      renderBoard();
      await delay(300);
      const c2 = await chainMergeAndGravity(-1, -1);
      if (c2 > maxCombo) maxCombo = c2;
    }

    triggerChainEndEffects(maxCombo);
    saveGame();
    isAnimating = false;
  }

  // ===== Particle Effects (Canvas-based) =====
  // Star pool keys (referencing fxImages keys instead of file paths)
  var STAR_GOLD_HOLLOW = ['黄色闪光星星'];
  var STAR_BLUE_RED_HOLLOW = ['蓝色闪光星星', '红色闪光星星'];
  var STAR_ALL_HOLLOW = ['黄色闪光星星', '蓝色闪光星星', '红色闪光星星'];
  var STAR_SOLID = ['黄色实心星星', '蓝色实心星星'];
  var STAR_BLUE_RED_ALL = ['蓝色闪光星星', '红色闪光星星', '黄色实心星星', '蓝色实心星星'];
  var STAR_ALL = ['黄色闪光星星', '蓝色闪光星星', '红色闪光星星', '黄色实心星星', '蓝色实心星星'];
  var BUBBLE_KEYS = ['红色气泡', '蓝色气泡'];

  /** Spawn star particles at random positions inside the board (auto-eliminate) */
  function spawnStars(count) {
    var bRect = boardEl.getBoundingClientRect();
    var bw = bRect.width;
    var bh = bRect.height;
    for (var i = 0; i < count; i++) {
      var key = STAR_ALL[Math.floor(Math.random() * STAR_ALL.length)];
      var size = 16 + Math.random() * 8;
      var x = bw * (0.1 + Math.random() * 0.8);
      var y = bh * (0.1 + Math.random() * 0.8);
      pushParticle({
        type: 'star', x: x, y: y,
        vx: (Math.random() - 0.5) * 20,
        vy: -(30 + Math.random() * 40),
        gravity: 0, size: size,
        rotation: 0, rotSpeed: (Math.random() - 0.5) * 10,
        opacity: 1, lifetime: 0.8, elapsed: 0,
        img: fxImages[key],
        scaleMax: 1.1, scaleEnd: 0.25,
        delay: Math.random() * 0.25
      });
    }
    startFxLoop();
  }

  /** Spawn bubble particles from a specific cell center */
  function spawnBubbles(row, col, count) {
    var pos = cellToCanvasPos(row, col);
    for (var i = 0; i < count; i++) {
      var key = BUBBLE_KEYS[Math.floor(Math.random() * BUBBLE_KEYS.length)];
      var size = 12 + Math.random() * 8;
      var angle = Math.random() * Math.PI * 2;
      var speed = 40 + Math.random() * 50;
      pushParticle({
        type: 'bubble', x: pos.x, y: pos.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: 0, size: size,
        rotation: 0, rotSpeed: 0,
        opacity: 1, lifetime: 1.0, elapsed: 0,
        img: fxImages[key],
        scaleMax: 1.0, scaleEnd: 0.25,
        delay: Math.random() * 0.2
      });
    }
    startFxLoop();
  }

  /** Spawn merge stars that burst outward from a cell
   *  @param {string[]} starPool — array of fxImages keys to randomly pick from
   */
  function spawnMergeStars(row, col, count, starPool) {
    var pool = starPool || STAR_ALL;
    var pos = cellToCanvasPos(row, col);
    for (var i = 0; i < count; i++) {
      var key = pool[Math.floor(Math.random() * pool.length)];
      var size = 18 + Math.random() * 12;
      var angle = Math.random() * Math.PI * 2;
      var dist = 35 + Math.random() * 45;
      var speed = dist / 1.2; // map distance to velocity for ~1.2s travel
      pushParticle({
        type: 'mergeStar', x: pos.x, y: pos.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: 0, size: size,
        rotation: 0, rotSpeed: (Math.random() - 0.5) * 12,
        opacity: 1, lifetime: 2.5, elapsed: 0,
        img: fxImages[key],
        scaleMax: 1.2, scaleEnd: 0.15,
        delay: Math.random() * 0.15
      });
    }
    startFxLoop();
  }

  /** Spawn a glow effect on a cell (radial gradient, no image) */
  function spawnGlow(row, col) {
    var pos = cellToCanvasPos(row, col);
    pushParticle({
      type: 'glow', x: pos.x, y: pos.y,
      vx: 0, vy: 0,
      gravity: 0, size: 60,
      rotation: 0, rotSpeed: 0,
      opacity: 0.8, lifetime: 0.7, elapsed: 0,
      scaleMax: 1.8, scaleEnd: 2.2,
      delay: 0
    });
    startFxLoop();
  }

  /** Show combo text above a cell (image-spliced version) */
  function showComboText(row, col, comboCount) {
    const cell = cellEls[row][col];
    const container = document.createElement('div');
    container.className = 'combo-text';

    // Determine image height based on combo count
    let imgHeight;
    let extraGlow = false;
    if (comboCount >= 5) {
      imgHeight = '3.5rem';
      extraGlow = true;
    } else if (comboCount === 4) {
      imgHeight = '3rem';
    } else if (comboCount === 3) {
      imgHeight = '2.5rem';
    } else {
      imgHeight = '2rem';
    }

    // Helper: create an img element with consistent styling
    function makeImg(src) {
      const img = document.createElement('img');
      img.src = src;
      img.style.height = imgHeight;
      if (extraGlow) {
        img.style.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,0.3)) drop-shadow(0 0 12px rgba(255,215,0,0.8))';
      }
      return img;
    }

    // 1. "连击" image
    container.appendChild(makeImg('effects/连击.png'));
    // 2. "×" (乘号) image
    container.appendChild(makeImg('effects/乘号.png'));
    // 3. Digit images (split comboCount into individual digits)
    const digits = String(comboCount).split('');
    for (const d of digits) {
      container.appendChild(makeImg('effects/' + d + '.png'));
    }

    cell.appendChild(container);
    setTimeout(() => container.remove(), 1100);
  }

  /** Show broadcast image for combo streaks (3+) */
  function showBroadcast(comboCount) {
    if (comboCount < 3) return;
    var src;
    if (comboCount === 3) {
      src = 'effects/3次连击.png';
    } else if (comboCount === 4) {
      src = 'effects/4次连击.png';
    } else if (comboCount === 5) {
      src = 'effects/5次连击.png';
    } else {
      src = 'effects/6次及以上连击.png';
    }
    var img = document.createElement('img');
    img.className = 'broadcast-effect';
    img.src = src;
    // Append to body with fixed positioning — no clipping from any container
    document.body.appendChild(img);
    setTimeout(function () { img.remove(); }, 3200);
  }

  /** Trigger graded combo effects at merge position
   *  1次合成：气泡 3-4 个
   *  2次连击：气泡 + 金色空心星 4-5 个
   *  3-4次连击：气泡 + 金/蓝/红空心星随机 6-8 个 + CSS光晕
   *  5+次连击：气泡 + 全部星星（空心+实心）随机 8-10 个 + CSS光晕（双重）
   */
  function triggerComboEffects(row, col, comboCount) {
    // Note: broadcast + cheer sound moved to after chainMergeAndGravity completes

    if (comboCount === 1) {
      // 1次合成：气泡 3-4 个
      spawnBubbles(row, col, 3 + Math.floor(Math.random() * 2));
    } else if (comboCount === 2) {
      // 2次连击：气泡 + 金色空心星 4-5 个
      spawnBubbles(row, col, 3 + Math.floor(Math.random() * 2));
      spawnMergeStars(row, col, 4 + Math.floor(Math.random() * 2), STAR_GOLD_HOLLOW);
      showComboText(row, col, comboCount);
    } else if (comboCount <= 4) {
      // 3-4次连击：气泡 + 蓝红星星 6-8 个 + CSS光晕
      spawnBubbles(row, col, 3 + Math.floor(Math.random() * 2));
      spawnMergeStars(row, col, 6 + Math.floor(Math.random() * 3), STAR_BLUE_RED_HOLLOW);
      spawnGlow(row, col);
      showComboText(row, col, comboCount);
    } else {
      // 5+次连击：气泡 + 蓝红全部星星（空心+实心）随机 8-10 个 + CSS光晕（双重）
      spawnBubbles(row, col, 4 + Math.floor(Math.random() * 2));
      spawnMergeStars(row, col, 8 + Math.floor(Math.random() * 3), STAR_BLUE_RED_ALL);
      spawnGlow(row, col);
      spawnGlow(row, col);
      showComboText(row, col, comboCount);
    }
  }

  // ===== Init =====
  function init() {
    preloadSkins();
    initBoardDOM();
    preloadFxImages();
    resizeFxCanvas();
    window.addEventListener('resize', onResizeFx);

    // Flush any pending save when the page is hidden/closed so no progress is lost
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) flushSave();
    });
    window.addEventListener('pagehide', flushSave);

    // Start BGM on first user interaction (required by iOS autoplay policy)
    function startBGM() {
      if (!bgmStarted) {
        bgmStarted = true;
        bgm.play().catch(function(){});
      }
    }
    document.addEventListener('click', startBGM, { once: true });
    document.addEventListener('touchstart', startBGM, { once: true });

    // Try to load saved game
    if (loadGame()) {
      updateScoreDisplay();
      updateNextPreview();
      updateNextNextPreview();
      renderBoard();
    } else {
      newGame();
    }

    // Event listeners — arrows and board both trigger drops
    arrowRow.addEventListener('click', onArrowClick);
    boardEl.addEventListener('click', function (e) {
      if (_brushBlockClick) return;

      const cell = e.target.closest('.cell');
      if (!cell) return;
      const row = parseInt(cell.dataset.row);
      const col = parseInt(cell.dataset.col);
      if (isNaN(row) || isNaN(col)) return;

      // Hammer mode: eliminate clicked block
      if (hammerMode) {
        if (isAnimating || gameOver) return;
        executeHammer(row, col);
        return;
      }

      // Swap mode: select two blocks to swap
      if (swapMode) {
        if (isAnimating || gameOver) return;
        if (grid[row][col] === 0) {
          exitSwapMode();
          return;
        }
        if (!swapFirstCell) {
          // First selection
          swapFirstCell = { row, col };
          cellEls[row][col].classList.add('swap-selected');
          return;
        }
        // Second selection
        if (swapFirstCell.row === row && swapFirstCell.col === col) {
          // Same cell — cancel
          exitSwapMode();
          return;
        }
        executeSwap(swapFirstCell.row, swapFirstCell.col, row, col);
        return;
      }

      if (brushMode) return;
      if (!isNaN(col)) dropBlock(col);
    });

    // Hammer & Swap button listeners
    btnHammer.addEventListener('click', onHammerBtnClick);
    btnSwap.addEventListener('click', onSwapBtnClick);

    // Brush event listeners
    btnBrush.addEventListener('click', onBrushBtnClick);
    boardEl.addEventListener('mousedown', onBoardMouseDown);
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
    boardEl.addEventListener('touchstart', onBoardTouchStart, { passive: false });
    boardEl.addEventListener('touchmove', onBoardTouchMove, { passive: false });
    window.addEventListener('touchend', onWindowTouchEnd);
    document.addEventListener('click', onDocClickCancelBrush);

    btnRestart.addEventListener('click', newGame);
    btnUndo.addEventListener('click', undoLastMove);
    btnWarningRestart.addEventListener('click', function () {
      overflowWarning.classList.remove('active');
      newGame();
    });
    btnNew.addEventListener('click', () => {
      if (confirm('开始新游戏？当前进度将丢失。')) {
        localStorage.removeItem(STORAGE_KEY);
        newGame();
      }
    });

    // Periodic DOM cleanup: remove stale DOM elements (score popups, combo text)
    setInterval(function() {
      var stale = boardEl.querySelectorAll('.score-popup, .combo-text');
      if (stale.length > 30) {
        for (var i = 0; i < stale.length - 10; i++) {
          stale[i].remove();
        }
      }
    }, 5000);
  }

  init();
})();
