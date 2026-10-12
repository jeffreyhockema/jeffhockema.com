// App shell: loads the pack, owns the fixed-timestep loop, and wires the HUD,
// menus and score board around the engine.

import { parsePack, T, FL } from './tiles.js';
import { Game } from './engine.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { buildSprites } from './sprites.js';
import { loadHD } from './hd.js';
import { TouchControls } from './touch.js';
import { GamepadControls } from './gamepad.js';
import { PACKS, packedBytes } from './asset-pack.js';

// One simulation step is one tile of motion, and the original took 8 frames
// at 35 a second to move one: 229 ms. (OpenSupaplex's default runs it at twice
// that, which is where the old 115 came from.)
const STEP_MS = 8000 / 35;
const DEATH_HOLD_MS = 1;      // the engine's own 64 frames of wreckage are the pause; this just hands over to the restart
// A move asked for while Murphy stands still starts at once, as it does in the
// original, which reads the keys every frame -- rather than waiting out the rest
// of a 229 ms step. Only the tail of a step is cut, so the world never jumps.
const EARLY_START = 0.35;

const $ = (id) => document.getElementById(id);
const els = {
  board: $('board'), stage: $('stage'), screens: $('screens'), toast: $('toast'),
  num: $('hud-num'), name: $('hud-name'),
  info: $('v-info'), need: $('v-need'), disks: $('v-disks'),
  time: $('v-time'), steps: $('v-steps'), grav: $('v-grav'),
  statInfo: $('stat-info'), statGrav: $('stat-grav'),
  levelGrid: $('level-grid'), legend: $('legend-grid'),
  doneTitle: $('done-title'), doneSub: $('done-sub'),
  result: $('result'), scoreboard: $('scoreboard'),
  tip: $('tip-text'), touch: $('touch'), kit: $('v-kit'),
  btnNext: $('btn-next'), btnSound: $('btn-sound'), doneHint: $('done-hint'),
};

const renderer = new Renderer(els.board);
let touch = null;   // the on-screen controls, once wired (js/touch.js)
let pad = null;     // game controllers, once wired (js/gamepad.js)
const input = new Input();
const audio = new Audio();

// The remastered graphics load in the background; the board draws with the
// procedural set until they arrive, and G switches between the two.
const HD_KEY = 'supremix.hd';
try { renderer.hdOn = localStorage.getItem(HD_KEY) !== 'off'; } catch { /* private mode */ }
// Close up, scrolling with Murphy, unless Z has asked for the whole level.
const VIEW_KEY = 'supremix.view';
try { renderer.overview = localStorage.getItem(VIEW_KEY) === 'overview'; } catch { /* private mode */ }
// The MT-32 theme plays unless N has turned it off.
const MUSIC_KEY = 'supremix.music';
try { audio.setMusicOn(localStorage.getItem(MUSIC_KEY) !== 'off'); } catch { /* private mode */ }
loadHD().then((hd) => { if (hd) renderer.setHD(hd); });
// Game speed, from Options: the whole simulation runs this many times the
// original's pace. 1x is the original.
const SPEED_KEY = 'supremix.speed';
const SPEEDS = [0.5, 1, 1.5, 2];
let speed = 1;
try {
  const s = Number(localStorage.getItem(SPEED_KEY));
  if (SPEEDS.includes(s)) speed = s;
} catch { /* private mode */ }

/**
 * The original's bug sound: it plays while a bug is sparking and Murphy is in
 * one of the eight cells round it -- close enough to be in danger.
 */
function bugNearMurphy(g) {
  const i = g.mi, w = g.w;
  if (g.tiles[i] !== T.MURPHY) return false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const j = i + dy * w + dx;
      if ((dx || dy) && g.tiles[j] === T.BUG && g.bugActive(j)) return true;
    }
  }
  return false;
}

let levels = [];
let game = null;
let levelIndex = 0;
let playing = false;
let paused = false;
let elapsed = 0;
let deaths = 0;
let deathHold = 0;
let acc = 0;
let lastFrame = performance.now();
let toastTimer = 0;
let scoresCache = {};

// The game is a static site: it needs nothing from the webserver but files.
// The levels come from a pack in public/packs/ -- the original set if it has
// been built, SupRemix's own otherwise -- and the BEST RUNS board is this
// browser's own.
const RUNS_KEY = 'supremix.runs';
const RUNS_PER_LEVEL = 10;

function localRuns() {
  try { return JSON.parse(localStorage.getItem(RUNS_KEY)) || {}; } catch { return {}; }
}

function addLocalRun(level, row) {
  const all = localRuns();
  all[level] = [...(all[level] || []), row]
    .sort((a, b) => a.steps - b.steps || a.ms - b.ms)
    .slice(0, RUNS_PER_LEVEL);
  try { localStorage.setItem(RUNS_KEY, JSON.stringify(all)); } catch { /* private mode */ }
  return all[level];
}

// --- persistence ------------------------------------------------------------

const PROGRESS_KEY = 'supremix.progress';
const NAME_KEY = 'supremix.name';

function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(PROGRESS_KEY));
    if (p && typeof p === 'object') {
      // Progress can outlive a pack that has since got shorter.
      return { unlocked: Math.max(0, p.unlocked | 0), best: p.best || {} };
    }
  } catch { /* corrupt or unavailable storage is not worth a crash */ }
  return { unlocked: 0, best: {} };
}

function saveProgress(p) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

function playerName() {
  try { return localStorage.getItem(NAME_KEY) || 'MURPHY'; } catch { return 'MURPHY'; }
}

function setPlayerName(n) {
  try { localStorage.setItem(NAME_KEY, n); } catch { /* ignore */ }
}

let progress = loadProgress();

// --- screens ----------------------------------------------------------------

function showScreen(name) {
  for (const s of els.screens.querySelectorAll('.screen')) {
    s.hidden = s.dataset.screen !== name;
  }
  els.screens.hidden = !name;
  // While a menu is up the keyboard belongs to it, not to Murphy. Without this
  // a direction held over the menu fires the instant play resumes.
  input.enabled = !name;
  if (name) input.clear();
}

function currentScreen() {
  const open = els.screens.querySelector('.screen:not([hidden])');
  return els.screens.hidden ? null : open?.dataset.screen ?? null;
}

function toast(msg, bad = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('is-bad', bad);
  els.toast.hidden = false;
  toastTimer = 1600;
}

// --- formatting -------------------------------------------------------------

function fmtTime(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// --- level flow -------------------------------------------------------------

function startLevel(i) {
  levelIndex = Math.max(0, Math.min(levels.length - 1, i));
  game = new Game(levels[levelIndex]);
  elapsed = 0;
  deaths = 0;
  deathHold = 0;
  acc = 0;
  playing = true;
  paused = false;
  renderer.camReady = false;
  renderer.fx.clear();          // no sparks carried over from the last level
  renderer.resize(game);
  renderer.centreOn(game);
  showScreen(null);

  els.num.textContent = String(levelIndex + 1).padStart(2, '0');
  els.name.textContent = game.level.name;
  els.tip.textContent = game.level.hint || '';
  forceHud();
  audio.play('select');
  audio.music();
}

function restartLevel(silent = false) {
  if (!game) return;
  game.restart();
  elapsed = 0;
  acc = 0;
  deathHold = 0;
  playing = true;
  paused = false;
  renderer.camReady = false;
  renderer.fx.clear();
  renderer.centreOn(game);
  showScreen(null);
  forceHud();
  if (!silent) toast('LEVEL RESET');
}

function onDeath() {
  deaths++;
  toast('SYSTEM FAILURE — REBOOTING', true);
}

let winToken = 0;

async function onWin() {
  playing = false;
  audio.play('win');

  const stats = { steps: game.steps, ms: Math.round(elapsed), deaths };
  const key = String(levelIndex);
  const prev = progress.best[key];
  const isBest = !prev || stats.steps < prev.steps || (stats.steps === prev.steps && stats.ms < prev.ms);
  if (isBest) progress.best[key] = { steps: stats.steps, ms: stats.ms };
  progress.unlocked = Math.max(progress.unlocked, levelIndex + 1);
  saveProgress(progress);

  const last = levelIndex === levels.length - 1;
  els.doneTitle.textContent = last ? 'ALL SYSTEMS CLEAR' : 'LEVEL CLEAR';
  els.doneSub.innerHTML = '';
  els.doneSub.append(
    document.createTextNode(
      last ? 'Every level in the pack is done. ' : `${game.level.name} complete. `));
  const who = document.createElement('button');
  who.className = 'btn btn-ghost';
  who.style.cssText = 'padding:2px 8px;font-size:10px;letter-spacing:.1em';
  who.textContent = `AS ${playerName()}`;
  who.onclick = () => {
    const n = window.prompt('Name for the score board:', playerName());
    if (n) { setPlayerName(n.slice(0, 14)); who.textContent = `AS ${playerName()}`; }
  };
  els.doneSub.append(who);

  els.result.innerHTML = '';
  const cells = [
    ['MOVES', stats.steps, isBest],
    ['TIME', fmtTime(stats.ms), false],
    ['DEATHS', stats.deaths, stats.deaths === 0],
  ];
  for (const [label, value, good] of cells) {
    const d = document.createElement('div');
    d.className = `cell${good ? ' is-best' : ''}`;
    d.innerHTML = `<span>${label}</span><b></b>`;
    d.querySelector('b').textContent = String(value);
    els.result.append(d);
  }

  els.btnNext.disabled = last;
  els.btnNext.textContent = last ? 'PACK COMPLETE' : 'NEXT LEVEL';
  els.doneHint.textContent = last ? 'SPACE to play it again' : 'SPACE for the next level';
  showScreen('done');
  renderLevelGrid();

  const token = ++winToken;
  const board = await submitScore(levelIndex, stats);
  if (token !== winToken) return;   // the player moved on before the reply came
  renderScoreboard(board, stats);
}

// --- scores -----------------------------------------------------------------

async function submitScore(level, stats) {
  scoresCache[level] = addLocalRun(level, { name: playerName(), steps: stats.steps, ms: stats.ms, at: Date.now() });
  return scoresCache[level];
}

function renderScoreboard(board, mine) {
  els.scoreboard.innerHTML = '';
  if (!board || !board.length) {
    els.scoreboard.innerHTML = '<li class="empty">no runs recorded yet</li>';
    return;
  }
  let flagged = false;
  board.slice(0, 8).forEach((row, i) => {
    const li = document.createElement('li');
    const isYou = !flagged && mine && row.steps === mine.steps && row.ms === mine.ms;
    if (isYou) { li.className = 'is-you'; flagged = true; }
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(i + 1).padStart(2, '0');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = row.name;
    const mv = document.createElement('span');
    mv.textContent = `${row.steps} mv`;
    const tm = document.createElement('span');
    tm.textContent = fmtTime(row.ms);
    li.append(rank, who, mv, tm);
    els.scoreboard.append(li);
  });
}

async function loadScores() {
  scoresCache = localRuns();
}

// --- level select + legend --------------------------------------------------

function renderLevelGrid() {
  els.levelGrid.innerHTML = '';
  levels.forEach((lvl, i) => {
    const locked = i > progress.unlocked;
    const best = progress.best[String(i)];
    const b = document.createElement('button');
    b.className = `lvl${best ? ' is-done' : ''}`;
    b.disabled = locked;

    const top = document.createElement('div');
    top.className = 'lvl-top';
    const n = document.createElement('span');
    n.className = 'lvl-n';
    n.textContent = locked ? 'LOCKED' : String(i + 1).padStart(2, '0');
    top.append(n);
    if (best) {
      const tick = document.createElement('span');
      tick.className = 'lvl-tick';
      tick.textContent = '✓';
      top.append(tick);
    }

    const name = document.createElement('div');
    name.className = 'lvl-name';
    name.textContent = locked ? '———' : lvl.name;

    const meta = document.createElement('div');
    meta.className = 'lvl-best';
    meta.textContent = best ? `best ${best.steps} mv / ${fmtTime(best.ms)}`
      : locked ? 'clear the previous level' : `${lvl.need} infotrons`;

    b.append(top, name, meta);
    b.onclick = () => startLevel(i);
    els.levelGrid.append(b);
  });
}

function renderLegend() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.round(26 * dpr);
  const set = buildSprites(px);
  const items = [
    [T.MURPHY, 'Service bot', 'murphy-1'],
    [T.INFOTRON, 'Infotron'],
    [T.ZONK, 'Capacitor'],
    [T.BASE, 'Board', 'base-0'],
    [T.HARDWARE, 'Chassis'],
    [T.CHIP, 'RAM chip'],
    [T.EXIT, 'Drive bay', 'exit-on'],
    [T.SNIKSNAK, 'Case fan'],
    [T.ELECTRON, 'Short circuit'],
    [T.BUG, 'Bug', 'bug-on'],
    [T.TERMINAL, 'DIP switches'],
    [T.ORANGE, 'Orange floppy'],
    [T.YELLOW, 'Yellow floppy'],
    [T.RED, 'Red floppy'],
    [T.PORT_R, 'Ribbon port'],
    [T.GPORT_D, 'Gravity port'],
    [T.KEY_A, 'Access card'],
    [T.LOCK_C, 'Locked header'],
    [T.BOOTS, 'Thermal boots'],
    [T.RACK, 'Disk drive'],
    [T.SLIME, 'Electrolyte'],
    [`fl-${FL.ICE}`, 'Data bus'],
    [`fl-${FL.PAD}`, 'Pressure plate'],
    [`fl-${FL.FORCE}`, 'Force field'],
    [`fl-${FL.PHASE}`, 'Failing trace'],
    [`fl-${FL.FIRE}`, 'Hot component'],
  ];

  els.legend.innerHTML = '';
  for (const [tile, label, key] of items) {
    const src = set.get(key ?? tile, 0);
    if (!src) continue;
    const wrap = document.createElement('div');
    wrap.className = 'legend-item';
    const c = document.createElement('canvas');
    c.width = px; c.height = px;
    c.getContext('2d').drawImage(src, 0, 0, px, px);
    const b = document.createElement('b');
    b.textContent = label;
    wrap.append(c, b);
    els.legend.append(wrap);
  }
}

// --- HUD --------------------------------------------------------------------

const hudCache = {};
function setText(el, key, value) {
  if (hudCache[key] === value) return;
  hudCache[key] = value;
  el.textContent = value;
}

function forceHud() {
  for (const k of Object.keys(hudCache)) delete hudCache[k];
  kitSignature = '';
  updateHud();
}

function updateHud() {
  if (!game) return;
  setText(els.info, 'info', String(game.collected));
  setText(els.need, 'need', String(game.need));
  setText(els.disks, 'disks', String(game.redDisks));
  setText(els.steps, 'steps', String(game.steps));
  setText(els.time, 'time', fmtTime(elapsed));
  setText(els.grav, 'grav', game.gravity ? 'ON' : 'OFF');
  els.statInfo.classList.toggle('is-met', game.exitOpen());
  els.statGrav.classList.toggle('is-on', game.gravity);
  updateKit();
}

const CARD_COLOURS = ['#ffb02e', '#3fc4ff', '#4fe06a', '#c07bff'];
let kitSignature = '';

/** Access cards and boots, drawn as the things themselves rather than numbers. */
function updateKit() {
  const sig = `${game.keys.join(',')}|${game.boots ? 1 : 0}`;
  if (sig === kitSignature) return;
  kitSignature = sig;

  els.kit.innerHTML = '';
  let any = false;
  game.keys.forEach((n, c) => {
    if (!n) return;
    any = true;
    const pip = document.createElement('span');
    pip.className = `kit-card${n > 1 ? ` n${Math.min(n, 4)}` : ''}`;
    pip.style.color = CARD_COLOURS[c];
    pip.dataset.n = String(n);
    els.kit.append(pip);
  });
  if (game.boots) {
    any = true;
    const b = document.createElement('span');
    b.className = 'kit-boots';
    b.textContent = '❄';
    b.title = 'thermal boots';
    els.kit.append(b);
  }
  if (!any) {
    const none = document.createElement('i');
    none.className = 'kit-none';
    none.textContent = '--';
    els.kit.append(none);
  }
}

// --- options ----------------------------------------------------------------

function openOptions() {
  disarmReset();
  showSpeed();
  showScreen('options');
}

function setSpeed(s) {
  if (!SPEEDS.includes(s)) return;
  speed = s;
  try { localStorage.setItem(SPEED_KEY, String(s)); } catch { /* private mode */ }
  showSpeed();
  toast(`GAME SPEED ${s}×`);
}

function showSpeed() {
  for (const b of document.querySelectorAll('[data-speed]')) {
    const on = Number(b.dataset.speed) === speed;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const badge = $('hud-speed');
  badge.hidden = speed === 1;
  badge.textContent = `${speed}×`;
}

// Erasing everything takes two presses: the first arms the button, and it
// disarms itself if the second does not come within a few seconds.
let resetArmed = 0;

function disarmReset() {
  clearTimeout(resetArmed);
  resetArmed = 0;
  const b = $('btn-reset-progress');
  b.classList.remove('is-armed');
  b.textContent = 'RESET PROGRESS';
}

function resetProgress() {
  const b = $('btn-reset-progress');
  if (!resetArmed) {
    b.classList.add('is-armed');
    b.textContent = 'PRESS AGAIN TO ERASE';
    resetArmed = setTimeout(disarmReset, 4000);
    return;
  }
  disarmReset();
  try {
    localStorage.removeItem(PROGRESS_KEY);
    localStorage.removeItem(RUNS_KEY);
  } catch { /* private mode */ }
  progress = loadProgress();
  scoresCache = {};
  renderLevelGrid();
  toast('PROGRESS RESET');
}

// --- loop -------------------------------------------------------------------

function handleEvents(events) {
  for (const e of events) {
    audio.play(e);
    if (e === 'boom') renderer.shake(1);
    if (e === 'die') renderer.shake(1.6);
    if (e === 'boom') pad?.rumble(0.45, 140);
    if (e === 'die') pad?.rumble(1, 380);
    if (e === 'exit') renderer.shake(0.5);
    if (e === 'die') onDeath();
    if (e === 'open') toast('EXIT OPEN');
    if (e === 'gravity') toast(game.gravity ? 'GRAVITY ON' : 'GRAVITY OFF');
    if (e === 'plant') toast('CHARGE SET — GET CLEAR');
    if (e === 'nodisk') toast('NO RED DISKS', true);
    if (e === 'noroom') toast('NOTHING TO PLANT IT IN', true);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(200, now - lastFrame);
  lastFrame = now;
  pad?.poll(now);

  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) els.toast.hidden = true;
  }

  if (game) {
    if (playing && !paused) {
      // Game time: at 2x a step takes half as long, and the clock counts the
      // game's own time, so a run's time is the same at any speed.
      const gdt = dt * speed;
      if (game.state === 'play') elapsed += gdt;

      if (deathHold > 0) {
        deathHold -= dt;
        if (deathHold <= 0) restartLevel(true);
      } else {
        // The clock runs at the chosen pace, always: no hit-stop holding it.
        acc += gdt;
        const idle = game.state === 'play' && game.from[game.mi] < 0 && !game.pushing;
        if (idle && input.fresh && acc >= STEP_MS * EARLY_START && acc < STEP_MS) acc = STEP_MS;
        // Catch up on missed steps, but never spiral after a stall. Only drop
        // the backlog when the cap is what stopped us -- testing `guard` after
        // the loop also fired on a healthy sixth step and lost the remainder.
        const MAX_CATCH_UP = 6;
        let ran = 0;
        while (acc >= STEP_MS && ran < MAX_CATCH_UP) {
          acc -= STEP_MS;
          ran++;
          const events = game.step(input.read());
          for (const e of game.fx) renderer.event(e.k, e.i, game);
          handleEvents(events);
          if (bugNearMurphy(game)) audio.play('bug');
          if (game.state === 'won') { onWin(); break; }
          if (game.state === 'dead' && game.stateTimer <= 0) {
            deathHold = DEATH_HOLD_MS;
            break;
          }
        }
        if (ran === MAX_CATCH_UP && acc >= STEP_MS) acc = 0;
      }
    }

    const alpha = playing && !paused && game.state !== 'won'
      ? Math.max(0, Math.min(1, acc / STEP_MS)) : 1;
    renderer.draw(game, alpha, now);
    touch?.setActive(playing && !paused && !currentScreen());
    updateHud();
  }
}

// --- wiring -----------------------------------------------------------------

function pause() {
  if (!playing || paused) return;
  paused = true;
  input.clear();
  showScreen('pause');
}

function resume() {
  paused = false;
  lastFrame = performance.now();
  showScreen(null);
}

/**
 * Wire a control that sits over the board.
 *
 * A clicked button keeps focus, and a focused button owns Space -- which is
 * the plant key. Handing focus back after the click keeps both working.
 */
function onPlayClick(el, fn) {
  el.onclick = (e) => { fn(e); el.blur(); };
}

function bindUi() {
  $('btn-play').onclick = () => startLevel(Math.min(progress.unlocked, levels.length - 1));
  $('btn-levels').onclick = () => { renderLevelGrid(); showScreen('levels'); };
  $('btn-help').onclick = () => showScreen('help');
  $('btn-options').onclick = openOptions;
  $('btn-pause-options').onclick = openOptions;
  for (const b of document.querySelectorAll('[data-speed]')) {
    b.onclick = () => setSpeed(Number(b.dataset.speed));
  }
  $('btn-reset-progress').onclick = resetProgress;
  showSpeed();
  $('btn-resume').onclick = resume;
  $('btn-pause-restart').onclick = () => restartLevel();
  $('btn-pause-levels').onclick = () => { playing = false; renderLevelGrid(); showScreen('levels'); };
  $('btn-done-levels').onclick = () => { renderLevelGrid(); showScreen('levels'); };
  $('btn-replay').onclick = () => startLevel(levelIndex);
  $('btn-next').onclick = () => startLevel(levelIndex + 1);
  onPlayClick($('btn-restart'), () => restartLevel());
  onPlayClick($('btn-menu'), () => {
    if (playing && !paused) pause();
    else { renderLevelGrid(); showScreen('levels'); }
  });
  $('btn-unlock').onclick = () => {
    progress.unlocked = levels.length - 1;
    saveProgress(progress);
    renderLevelGrid();
    toast('ALL LEVELS UNLOCKED');
  };
  onPlayClick(els.btnSound, () => {
    const muted = audio.toggleMute();
    els.btnSound.classList.toggle('is-off', muted);
    els.btnSound.title = muted ? 'Sound off (M)' : 'Sound on (M)';
  });

  for (const b of document.querySelectorAll('[data-back]')) {
    b.onclick = () => (playing ? (paused ? showScreen('pause') : showScreen(null)) : showScreen('title'));
  }

  input.on('KeyR', () => { if (playing) restartLevel(); });
  input.on('KeyM', () => els.btnSound.click());
  input.on('KeyN', () => {
    const on = audio.toggleMusic();
    try { localStorage.setItem(MUSIC_KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
    toast(on ? 'MUSIC ON' : 'MUSIC OFF');
  });
  input.on('KeyZ', () => {
    renderer.overview = !renderer.overview;
    try { localStorage.setItem(VIEW_KEY, renderer.overview ? 'overview' : 'close'); } catch { /* private mode */ }
    if (game) { renderer.resize(game); renderer.centreOn(game); }
    toast(renderer.overview ? 'WHOLE LEVEL' : 'CLOSE VIEW');
  });
  input.on('KeyG', () => {
    renderer.hdOn = !renderer.hdOn;
    try { localStorage.setItem(HD_KEY, renderer.hdOn ? 'on' : 'off'); } catch { /* private mode */ }
    toast(renderer.hdOn ? (renderer.hd ? 'REMASTERED GRAPHICS' : 'REMASTERED GRAPHICS NOT LOADED') : 'SUPREMIX GRAPHICS');
  });
  input.on('Escape', () => {
    const screen = currentScreen();
    if (screen === 'pause') resume();
    else if (screen === 'levels' || screen === 'help' || screen === 'options') {
      playing ? showScreen(paused ? 'pause' : null) : showScreen('title');
    } else if (playing) pause();
  });
  input.on('KeyP', () => (paused ? resume() : pause()));

  // On the level-clear screen, space carries on. It is what everyone reaches
  // for after a win, and the plant key it doubles as is idle there anyway.
  // Registered ahead of the game's own handler so it wins the keypress.
  window.addEventListener('keydown', (e) => {
    if (currentScreen() !== 'done') return;
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    if (Input.claimedByFocus(e)) return;   // a focused button activates itself
    e.preventDefault();
    (els.btnNext.disabled ? $('btn-replay') : els.btnNext).click();
  });

  // Any gesture is a good moment to open the audio context.
  const wake = () => audio.ensure();
  window.addEventListener('pointerdown', wake, { once: true });
  window.addEventListener('keydown', wake, { once: true });

  window.addEventListener('resize', () => { if (game) renderer.resize(game); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    audio.setHidden(document.hidden);
  });

  touch = new TouchControls(els.touch, input);
  pad = new GamepadControls(input, {
    screen: currentScreen,
    inPlay: () => playing && !paused && !currentScreen(),
    pause,
    resume,
    back: () => input.commands.get('Escape')?.(),
    restart: () => { if (playing) restartLevel(); },
    toggleView: () => input.commands.get('KeyZ')?.(),
    toast,
    wake: () => audio.ensure(),
    overlay: els.screens,
  });
}

// --- boot -------------------------------------------------------------------

/** Show a dead end honestly rather than leaving a black screen. */
function fatal(message) {
  const panel = document.querySelector('[data-screen="title"]');
  panel.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = 'LOAD FAILURE';
  const p = document.createElement('p');
  p.className = 'tagline';
  p.textContent = message;                       // textContent: never markup
  const hint = document.createElement('p');
  hint.className = 'credit';
  hint.textContent = 'Start the server with npm start and open the address it prints.';
  panel.append(h, p, hint);
  els.screens.hidden = false;
  panel.hidden = false;
}

async function boot() {
  bindUi();
  try {
    const bytes = await packedBytes(PACKS.levels, 'levels.json')
      ?? await packedBytes(PACKS.remix, 'levels.json');
    if (!bytes) throw new Error(`neither ${PACKS.levels} nor ${PACKS.remix} could be read`);
    const data = JSON.parse(new TextDecoder().decode(bytes));
    levels = parsePack(data.levels);
    if (!levels.length) throw new Error('the pack contains no levels');
  } catch (err) {
    fatal(`Could not read the level pack. ${err.message}`);
    return;
  }

  try {
    renderLegend();
    renderLevelGrid();
    await loadScores();
  } catch (err) {
    fatal(`Could not build the interface. ${err.message}`);
    return;
  }

  // Preview the first level behind the title screen.
  game = new Game(levels[Math.min(progress.unlocked, levels.length - 1)]);
  levelIndex = game.level.index;
  renderer.resize(game);
  renderer.centreOn(game);
  els.num.textContent = String(levelIndex + 1).padStart(2, '0');
  els.name.textContent = game.level.name;
  const credit = document.querySelector('[data-screen="title"] .credit');
  // The pack is swappable, so the line is counted rather than written down.
  if (credit) credit.textContent = `A reimagining of Supaplex (1991). ${levels.length} levels. v${credit.dataset.version}`;
  forceHud();
  showScreen('title');

  requestAnimationFrame(frame);
}

boot();
