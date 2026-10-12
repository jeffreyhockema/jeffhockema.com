// Board renderer. Reads engine state, never writes it.
//
// Motion comes entirely from `game.from[i]`: the engine records which cell each
// tile arrived from during the current step, and we interpolate that hop across
// the step's wall-clock duration. So the simulation stays a clean grid while the
// picture stays smooth.

import { T, FL } from './tiles.js';
import { buildSprites, BOOM_FRAMES, BASE_VARIANTS, PAL, KEY_COLS } from './sprites.js';
import { Fx, playFx, TUNING } from './fx.js';
import { DIRS } from './engine.js';

// --- the remastered set ---------------------------------------------------------
//
// With the HD atlas loaded (./hd.js), every element the original game has is
// drawn with its own remastered tile and its own animation frames, and the
// procedural sprites are kept for what the original never had: keys and doors,
// boots, racks, slime and the floors.

/** Game tile -> original tile number in the atlas. */
const HD_TILE = new Map([
  [T.ZONK, 1], [T.BASE, 2], [T.INFOTRON, 4], [T.CHIP, 5], [T.HARDWARE, 6], [T.EXIT, 7],
  [T.ORANGE, 8], [T.PORT_R, 9], [T.PORT_D, 10], [T.PORT_L, 11], [T.PORT_U, 12],
  [T.GPORT_R, 13], [T.GPORT_D, 14], [T.GPORT_L, 15], [T.GPORT_U, 16], [T.SNIKSNAK, 17],
  [T.YELLOW, 18], [T.TERMINAL, 19], [T.RED, 20], [T.PORT_V, 21], [T.PORT_H, 22], [T.PORT_X, 23],
  [T.ELECTRON, 24], [T.BUG, 25], [T.CHIP_L, 26], [T.CHIP_R, 27], [T.CHIP_T, 38], [T.CHIP_B, 39],
]);
// The original has ten decorative hardware tiles and the game folds them into
// five; each of the five shows the two originals it stands for, chosen by cell.
const HD_HARDWARE = new Map([
  [T.HW_GREEN, [28, 33]], [T.HW_RED, [29, 34]], [T.SLOT, [30, 35]], [T.HEATSINK, [31, 36]], [T.SOCKET, [32, 37]],
]);
const SIDE = ['up', 'right', 'down', 'left'];
// The band angles a zonk shows rolling one cell, frame by frame, as the
// original's roll draws them; indexes into the atlas's zonk-roll (0/45/90/135).
const ZONK_ROLL = { left: [3, 2, 1, 0, 3, 2, 1, 0], right: [0, 1, 2, 3, 0, 1, 2, 3] };
const PUSHED = new Map([[T.ZONK, 'zonk'], [T.ORANGE, 'orange-disk'], [T.YELLOW, 'yellow-disk']]);
/** The original hardware tile a decorative wall shows in this cell. */
const hdHardware = (t, x, y) => { const pair = HD_HARDWARE.get(t); return pair ? pair[(x * 7 + y * 13) % 2] : null; };
// With the remastered art, light comes only from what is lit in it: the
// hardware lamps (by their tile), screens, sparks, a burning fuse, the open
// exit. The SupRemix elements the original never had keep their own lights.
const HD_LAMPS = new Map([[29, '#00ee77'], [30, '#8faaff'], [31, '#ff3322']]);
const HYBRID = new Set([T.KEY_A, T.KEY_C, T.KEY_G, T.KEY_P, T.LOCK_A, T.LOCK_C, T.LOCK_G, T.LOCK_P,
  T.BOOTS, T.RACK, T.SLIME]);
// The bead positions on an infotron, where a glint can catch.
const BEADS = [[0.5, 0.25], [0.25, 0.75], [0.75, 0.75]];
const SNAP = { dig: 'base-snap', infotron: 'infotron-snap', pickup: 'red-disk-snap' };
const FRAME_MS = 1000 / 35;  // one frame of the original's animation
const SNAP_MS = FRAME_MS;    // a snap plays at the original's 35 Hz
const EXIT_MS = FRAME_MS;    // and so does the exit, 40 frames over its 5 steps

/** How far through its burn an explosion cell is, 0..1. */
function burnt(game, i, alpha) {
  const total = game.tiles[i] === T.BOOM_I ? 5 : 4;
  return Math.max(0, Math.min(1, (total - game.timer[i] + alpha) / total));
}
/** The planted red disk's steps of fuse left, if this is it. */
function fuseAt(game, i) {
  return game.liveDisk && game.liveDisk.i === i ? game.liveDisk.t : 0;
}
const YAWN_AFTER_MS = 6000;  // idle this long and Murphy starts to yawn
const YAWN_EVERY_MS = 9000;
const YAWN_MS = 120;

// How brightly each thing burns, and how far the light reaches in tiles. This
// is the whole emissive vocabulary of the board in one table -- if the exit
// should be the brightest thing in the level, this is the only place with an
// opinion about it.
const LIT = new Map();
function lit(tile, colour, radius, pulse = 0) { LIT.set(tile, { colour, radius, pulse }); }

lit(T.INFOTRON, '#ffe8d0', 1.15, 0.22);   // silver catching the light
lit(T.ELECTRON, '#7799ee', 1.2, 0.45);
lit(T.SNIKSNAK, '#9fd0ff', 0.7, 0.12);
lit(T.BUG, '#ee1111', 0.85, 0.7);
lit(T.TERMINAL, '#eeee00', 0.6, 0.3);
lit(T.SLIME, '#00bb66', 0.75, 0.35);
lit(T.RED, '#ee1111', 0.6, 0.15);
lit('red-armed', '#ee1111', 1.3, 0.9);
lit(T.ORANGE, '#ff9944', 0.5, 0.1);
lit(T.YELLOW, '#eeee00', 0.5, 0.1);
lit(T.HW_GREEN, '#00bb66', 0.45, 0.35);
lit(T.HW_RED, '#ee1111', 0.45, 0.35);
lit(T.BOOTS, '#ffe9a8', 0.6, 0.2);
lit(T.RACK, '#8fd0ff', 0.45, 0.06);
lit('boom', '#ff9944', 2.1, 0);
lit('boom-i', '#eeee00', 2.3, 0);
lit('exit-on', '#00bb66', 1.9, 0.3);
lit('exit-off', '#bb0000', 0.7, 0.08);
for (const t of [T.PORT_R, T.PORT_L, T.PORT_U, T.PORT_D,
  T.PORT_V, T.PORT_H, T.PORT_X]) lit(t, '#7799ee', 0.7, 0.2);
for (const t of [T.GPORT_R, T.GPORT_L, T.GPORT_U, T.GPORT_D]) lit(t, '#c07bff', 0.85, 0.3);
for (let c = 0; c < KEY_COLS.length; c++) {
  lit(T.KEY_A + c, KEY_COLS[c], 0.8, 0.3);
  lit(T.LOCK_A + c, KEY_COLS[c], 0.5, 0.12);
}

const LIT_FLOOR = new Map([
  [FL.FIRE, { colour: '#ff9944', radius: 0.9, pulse: 0.4 }],
  [FL.ICE, { colour: '#7799ee', radius: 0.5, pulse: 0.05 }],
  [FL.PAD, { colour: '#eeee00', radius: 0.4, pulse: 0.1 }],
]);

const MIN_TILE = 16;
const MAX_TILE = 120;
// The close view: about as much board as the original showed -- it scrolled a
// 20 x 12 window round Murphy -- a little wider, for today's wider screens.
const VIEW_COLS = 24;
const VIEW_ROWS = 13;
// A phone held upright is too narrow for 24 across: there the view is framed
// by its width instead, about 12 tiles, and runs as far down as it is tall.
const PORTRAIT_COLS = 12;
const ANIM_MS = 110;
const REF_FRAME = 1000 / 60;   // the rate the easing constants were tuned at
const CAM_EASE = 0.16;
const SHAKE_DECAY = 0.82;

export class Renderer {
  constructor(canvas) {
    this.fx = new Fx();
    this.twinklers = [];      // visible infotrons this frame, as flat x,y pairs
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tile = 32;
    this.dpr = 1;
    this.sprites = null;
    this.camX = 0;
    this.camY = 0;
    this.camReady = false;
    this.shakeAmount = 0;
    this.vw = 0;
    this.vh = 0;
    this.lastDraw = 0;
    this.overlay = null;   // cached scanlines + vignette, rebuilt on resize
    this.overview = false; // true: shrink the whole level to fit, instead of following Murphy close up

    this.hd = null;           // the remastered atlas, once loaded (./hd.js)
    this.hdOn = true;         // and whether to use it
    this.acts = new Map();    // what happened where this step: cell -> event
    this.actTick = -1;
    this.transients = [];     // snaps and the exit: short animations not tied to a tile
    this.lastMove = 0;        // when Murphy last moved, for his idle yawn
    this.side = 'right';      // the way he last faced sideways, for his up and down poses
  }

  /** Use the remastered atlas from now on (null to go back to the procedural set). */
  setHD(hd) {
    this.hd = hd;
    if (hd && this.sprites) hd.setSize(this.sprites.size);
  }

  get hdActive() { return !!(this.hd && this.hdOn); }

  /** Size the backing store to the element and pick a tile size for this level. */
  resize(game) {
    const rect = this.canvas.getBoundingClientRect();
    this.fxNeedsResize = true;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(320, Math.floor(rect.width));
    const cssH = Math.max(240, Math.floor(rect.height));

    // Close up, the tile is sized so the view holds VIEW_COLS across (and at
    // least VIEW_ROWS down), and the camera scrolls; a level smaller than that
    // is simply shown whole. The overview fits the entire level instead.
    const whole = Math.min(cssW / game.w, cssH / game.h);
    const cols = cssW >= cssH ? VIEW_COLS : PORTRAIT_COLS;
    const close = Math.max(whole, Math.min(cssW / cols, cssH / VIEW_ROWS));
    const tile = Math.max(MIN_TILE, Math.min(MAX_TILE, Math.floor(this.overview ? whole : close)));

    this.dpr = dpr;
    this.tile = tile;
    this.vw = cssW;
    this.vh = cssH;

    const w = Math.floor(cssW * dpr), h = Math.floor(cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;      // assigning at all clears the canvas
      this.canvas.height = h;
    }

    // Sprites only care about the tile size. Rebuilding them for every canvas
    // resize meant redrawing the whole set on each event of a window drag.
    const want = Math.round(tile * dpr);
    if (!this.sprites || this.sprites.size !== want) this.sprites = buildSprites(want);
    if (this.hd) this.hd.setSize(this.sprites.size);
    this.overlay = null;
  }

  /** Whatever just happened, wherever it happened. Called from the game loop. */
  event(kind, i, game) {
    if (i == null) return;
    this.fx.style = this.hdActive ? 'hd' : 'classic';
    playFx(this.fx, kind, (i % game.w) + 0.5, ((i / game.w) | 0) + 0.5);
    // Remember what this step did where: it decides which of the original's
    // animations Murphy's move is (walking, eating, pushing).
    if (game.tick !== this.actTick) { this.acts.clear(); this.actTick = game.tick; }
    // only what picks an animation; a routine 'slide' in the same cell must not hide it
    if (SNAP[kind]) this.acts.set(i, kind);
    // Something snapped up from where Murphy stands dissolves where it was;
    // walking in is drawn by his own move, so only reaching out counts here.
    if (SNAP[kind] && i !== game.mi) this.transients.push({ key: SNAP[kind], i, ms: SNAP_MS, t0: null });
    if (kind === 'exit') {
      const [dx, dy] = DIRS[game.face];
      this.transients.push({ key: 'murphy-exit', i: i + dy * game.w + dx, ms: EXIT_MS, t0: null, hold: true });
    }
  }

  shake(amount = 1) {
    // the remastered board is meant to be looked at; it shudders, it does not rattle
    if (this.hdActive) amount *= 0.45;
    this.shakeAmount = Math.min(2.2, this.shakeAmount + amount);
  }

  centreOn(game) {
    const { x, y } = this.murphyPos(game, 1);
    this.camX = x;
    this.camY = y;
    this.camReady = true;
  }

  murphyPos(game, alpha) {
    const i = game.mi;
    const f = game.from[i];
    const x = i % game.w, y = (i / game.w) | 0;
    if (f >= 0 && game.tiles[i] === T.MURPHY) {
      const fx = f % game.w, fy = (f / game.w) | 0;
      return { x: fx + (x - fx) * alpha, y: fy + (y - fy) * alpha };
    }
    return { x, y };
  }

  /**
   * @param game   engine instance
   * @param alpha  0..1 progress through the current simulation step
   * @param now    performance.now(), drives idle animation cycles
   */
  draw(game, alpha, now) {
    const ctx = this.ctx;
    const tile = this.tile * this.dpr;
    const W = this.canvas.width, H = this.canvas.height;
    const frame = Math.floor(now / ANIM_MS);

    // camera: follow Murphy, clamped so we never show outside the level
    // Ease by elapsed time, not by frame count: a fixed fraction per draw made
    // the camera twice as tight on a 120Hz display as on a 60Hz one.
    const dt = this.lastDraw ? Math.min(100, now - this.lastDraw) : REF_FRAME;
    this.lastDraw = now;
    const ease = 1 - (1 - CAM_EASE) ** (dt / REF_FRAME);

    const secs = dt / 1000;
    if (this.fxNeedsResize) { this.fx.resize(W, H); this.fxNeedsResize = false; }
    this.fx.pace(secs);
    this.fx.update(secs);

    const target = this.murphyPos(game, alpha);
    const cx = target.x + 0.5, cy = target.y + 0.5;
    if (!this.camReady) { this.camX = cx; this.camY = cy; this.camReady = true; }
    this.camX += (cx - this.camX) * ease;
    this.camY += (cy - this.camY) * ease;

    let originX = this.camX * tile - W / 2;
    let originY = this.camY * tile - H / 2;
    const maxX = game.w * tile - W, maxY = game.h * tile - H;
    originX = maxX <= 0 ? maxX / 2 : Math.max(0, Math.min(maxX, originX));
    originY = maxY <= 0 ? maxY / 2 : Math.max(0, Math.min(maxY, originY));

    if (this.shakeAmount > 0.01) {
      const s = this.shakeAmount * tile * 0.16;
      originX += (Math.random() - 0.5) * s;
      originY += (Math.random() - 0.5) * s;
      this.shakeAmount *= SHAKE_DECAY ** (dt / REF_FRAME);
    } else {
      this.shakeAmount = 0;
    }

    const hdLook = this.hdActive;
    this.alphaNow = alpha;
    this.fx.style = hdLook ? 'hd' : 'classic';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // the original's space is black, with no grid drawn on it
    ctx.fillStyle = hdLook ? '#000000' : PAL.void;
    ctx.fillRect(0, 0, W, H);

    const x0 = Math.max(0, Math.floor(originX / tile));
    const y0 = Math.max(0, Math.floor(originY / tile));
    const x1 = Math.min(game.w - 1, Math.ceil((originX + W) / tile));
    const y1 = Math.min(game.h - 1, Math.ceil((originY + H) / tile));

    if (!hdLook) this.drawGrid(ctx, originX, originY, tile, x0, y0, x1, y1);

    const sp = this.sprites;
    let murphyDraw = null;
    const twinklers = this.twinklers;
    twinklers.length = 0;
    const hd = this.hdActive ? this.hd : null;
    const plan = hd ? this.planMurphy(game, alpha, now) : null;

    // Floors go down first: ice, plates, walkways, fire and force fields all
    // sit UNDER whatever is standing in the cell.
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * game.w + x;
        const f = game.floor[i];
        if (!f) continue;
        const img = sp.get(this.floorKey(game, i, f), frame);
        if (img) {
          ctx.drawImage(img, Math.round(x * tile - originX), Math.round(y * tile - originY),
            tile, tile);
        }
        // A force field only burns while it is actually holding something shut.
        if (f === FL.FORCE) {
          if (!game.forceOpen) this.fx.glow(x + 0.5, y + 0.5, 0.8, '#7799ee', 0.9);
          continue;
        }
        const le = LIT_FLOOR.get(f);
        if (le) {
          const pulse = 1 + le.pulse * Math.sin(now / 260 + (i % 13));
          this.fx.glow(x + 0.5, y + 0.5, le.radius * pulse * (hdLook ? 0.8 : 1), le.colour, hdLook ? 0.4 : 0.7);
        }
      }
    }

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * game.w + x;
        const t = game.tiles[i];
        if (t === T.EMPTY) continue;

        // interpolate this tile's hop, if it made one this step
        let px = x, py = y;
        const f = game.from[i];
        if (f >= 0) {
          const fx = f % game.w, fy = (f / game.w) | 0;
          px = fx + (x - fx) * alpha;
          py = fy + (y - fy) * alpha;
        }
        const sx = Math.round(px * tile - originX);
        const sy = Math.round(py * tile - originY);

        if (t === T.MURPHY) {
          murphyDraw = { sx, sy, key: `murphy-${game.face}`, frame };
          continue;
        }

        const { key, f: fr } = this.spriteFor(game, i, t, frame, now);
        // the thing Murphy is pushing is drawn as part of his push
        if (plan && plan.skip.has(i)) { this.emit(key, t, px, py, now, i, game); continue; }
        const drawn = hd && this.drawHD(ctx, hd, game, i, t, x, y, px, py, now, alpha, originX, originY, tile);
        if (!drawn) {
          const img = sp.get(key, fr);
          if (img) ctx.drawImage(img, sx, sy, tile, tile);
        }
        this.emit(key, t, px, py, now, i, game);
        if (t === T.INFOTRON) twinklers.push(px, py);
      }
    }

    if (hd) this.drawTransients(ctx, hd, game, now, originX, originY, tile);
    if (murphyDraw && plan) {
      for (const d of plan.draws) this.blit(ctx, hd, d.key, d.f, d.x, d.y, originX, originY, tile);
    } else if (murphyDraw) {
      const img = sp.get(murphyDraw.key, murphyDraw.frame);
      if (img) ctx.drawImage(img, murphyDraw.sx, murphyDraw.sy, tile, tile);
    }
    if (murphyDraw && !hdLook) {
      // His visor is the only light he throws, and it is what makes him
      // readable when the board round him is dark.
      const m = this.murphyPos(game, alpha);
      this.fx.glow(m.x + 0.5, m.y + 0.5, 0.55, PAL.phosphor, 0.5);
    }

    this.ambient(secs, x0, y0, x1, y1, twinklers);

    // Particles sit over the board and under the light, so a spark is lit by
    // the bloom pass the same way a sprite is.
    this.fx.drawParticles(ctx, originX, originY, tile);
    this.fx.composite(ctx, W, H, originX, originY, tile);
    this.fx.drawFlash(ctx, W, H);
    this.drawOverlay(ctx, W, H);
  }

  /**
   * The board between events.
   *
   * A level where nothing moves until you touch something reads as a diagram.
   * Two cheap things fix that: dust drifting through the light, and infotrons
   * that catch it now and then. Both are rate-limited by elapsed time rather
   * than by frame, so they look the same on any refresh rate, and both scale
   * with the quality dial so they are the first thing to go on a slow machine.
   */
  ambient(secs, x0, y0, x1, y1, twinklers) {
    const fx = this.fx;
    if (fx.style === 'hd') {
      // No dust: the remastered board is clean. Now and then a light catches
      // one of an infotron's chrome beads.
      this.twinkleClock = (this.twinkleClock ?? 0) + secs * fx.quality * TUNING.ambient;
      while (this.twinkleClock > 0.45 && twinklers.length) {
        this.twinkleClock -= 0.45;
        const k = ((Math.random() * (twinklers.length / 2)) | 0) * 2;
        const [bx, by] = BEADS[(Math.random() * 3) | 0];
        fx.add('glint', twinklers[k] + bx - 0.04, twinklers[k + 1] + by - 0.05, 0, 0,
          0.4, '#ffffff', 0.13, { drag: 1, alpha: 0.85 });
      }
      return;
    }
    this.moteClock = (this.moteClock ?? 0) + secs * fx.quality * TUNING.ambient;
    while (this.moteClock > 0.09) {
      this.moteClock -= 0.09;
      const mx = x0 + Math.random() * Math.max(1, x1 - x0);
      const my = y0 + Math.random() * Math.max(1, y1 - y0);
      fx.add('spark', mx, my, (Math.random() - 0.5) * 0.35, -0.18 - Math.random() * 0.3,
        2.2 + Math.random() * 1.6, '#00693e', 0.05, { drag: 1 });
    }

    this.twinkleClock = (this.twinkleClock ?? 0) + secs * fx.quality * TUNING.ambient;
    while (this.twinkleClock > 0.12 && twinklers.length) {
      this.twinkleClock -= 0.12;
      const k = ((Math.random() * (twinklers.length / 2)) | 0) * 2;
      fx.add('spark', twinklers[k] + 0.5, twinklers[k + 1] + 0.5,
        (Math.random() - 0.5) * 1.2, -0.8 - Math.random(),
        0.45, '#ffffff', 0.06, { drag: 0.9 });
    }
  }

  /**
   * Add this cell's light to the frame, if it has any.
   *
   * Keyed on the sprite key rather than the tile, so a drive bay that is open
   * and one that is shut are different lights without the caller having to know
   * why -- `spriteFor` has already worked that out.
   */
  emit(key, t, px, py, now, i, game) {
    if (this.fx.style === 'hd') { this.emitHD(key, t, px, py, now, i, game); return; }
    const e = LIT.get(key) ?? LIT.get(t);
    if (!e) return;
    const pulse = e.pulse
      ? 1 + e.pulse * Math.sin(now / 320 + (i % 17)) : 1;
    this.fx.glow(px + 0.5, py + 0.5, e.radius * pulse, e.colour, 0.85);
  }

  /** Light for the remastered board: small, placed on what glows, and only while it does. */
  emitHD(key, t, px, py, now, i, game) {
    const glow = (dx, dy, r, c, a) => this.fx.glow(px + dx, py + dy, r, c, a);
    const wobble = (rate, k = 0) => Math.sin(now / rate + (i % 23) + k);
    switch (t) {
      case T.ELECTRON: glow(0.5, 0.5, 0.7, '#7799ee', 0.32 + 0.12 * wobble(110)); return;
      case T.BUG: if (game.bugActive(i)) glow(0.5, 0.5, 0.6, '#c8d6ff', 0.25 + 0.3 * Math.random()); return;
      case T.TERMINAL: glow(0.4, 0.38, 0.42, '#00ff88', 0.18 + 0.03 * wobble(400)); return;
      case T.EXIT: if (game.exitOpen()) glow(0.5, 0.5, 0.85, '#33dd88', 0.2 + 0.08 * wobble(380)); return;
      case T.RED: {
        const fuse = fuseAt(game, i);
        if (fuse > 0) glow(0.5, 0.5, 0.6, '#ff3322', Math.floor(now / Math.max(60, fuse * 45)) % 2 ? 0.55 : 0.12);
        return;
      }
      case T.BOOM: case T.BOOM_I:
        glow(0.5, 0.5, 0.8, t === T.BOOM ? '#ff9944' : '#ffe680', 0.35 * (1 - burnt(game, i, this.alphaNow ?? 0)));
        return;
      case T.GPORT_R: case T.GPORT_L: case T.GPORT_U: case T.GPORT_D:
        glow(0.5, 0.5, 0.45, '#c07bff', 0.16 + 0.05 * wobble(500));
        return;
      default: break;
    }
    const lamp = HD_LAMPS.get(hdHardware(t, i % game.w, (i / game.w) | 0));
    if (lamp) { glow(7.5 / 16, 7.5 / 16, 0.4, lamp, 0.28); return; }
    if (HYBRID.has(t)) {
      const e = LIT.get(key) ?? LIT.get(t);
      if (e) glow(0.5, 0.5, e.radius * 0.8 * (1 + e.pulse * 0.5 * wobble(320)), e.colour, 0.5);
    }
  }

  /**
   * Frame `f` of an atlas sprite with its top-left cell at board (cx, cy).
   * A sprite wider or taller than a cell -- one of the original's windows --
   * covers that many cells from there.
   */
  blit(ctx, hd, key, f, cx, cy, originX, originY, tile) {
    const s = hd.meta.sprites[key];
    const img = s && hd.frame(key, f);
    if (!img) return false;
    ctx.drawImage(img, Math.round(cx * tile - originX), Math.round(cy * tile - originY),
      (s.w / 16) * tile, (s.h / 16) * tile);
    return true;
  }

  /**
   * Draws a tile from the remastered set, if it has one. (x, y) is the cell it
   * is in now, (px, py) where it is drawn this frame.
   */
  drawHD(ctx, hd, game, i, t, x, y, px, py, now, alpha, originX, originY, tile) {
    const f = game.from[i];
    const dx = f >= 0 ? x - (f % game.w) : 0;
    const k = Math.min(7, Math.floor(alpha * 8));
    const at = (key, fr = 0) => this.blit(ctx, hd, key, fr, px, py, originX, originY, tile);
    switch (t) {
      case T.ZONK:
        // a sideways move is a roll (off something round, or a push without Murphy's window)
        if (dx) return at('zonk-roll', ZONK_ROLL[dx < 0 ? 'left' : 'right'][k]);
        break;
      case T.INFOTRON:
        if (dx) return at(`infotron-roll-${dx < 0 ? 'left' : 'right'}`, k);
        break;
      case T.BUG:
        // the bug's own spark state picks the frame, two states to a step
        if (game.bugActive(i)) return at('bug', Math.min(13, game.bugT[i] + Math.floor(alpha * 2)));
        break;
      case T.ELECTRON:
        return at('electron-turn', Math.floor(now / 70) + (i % 16));
      case T.SNIKSNAK: {
        const side = SIDE[game.dir[i]];
        if (f >= 0 && f !== i) {
          const key = `snik-snak-${side}`;
          const s = hd.meta.sprites[key];
          if (s && s.w > 16) return this.blit(ctx, hd, key, k, x - s.anchor[0], y - s.anchor[1], originX, originY, tile);
          return at(key, k);
        }
        const turn = hd.meta.sprites['snik-snak-turn'];
        // mid-turn, it is caught pointing between where it faced and where it will
        let heading = game.dir[i] * 90;
        if (game.spin[i] && game.busy[i] && alpha < 0.5) heading = (heading + (game.spin[i] === 1 ? 45 : 315)) % 360;
        const fr = turn ? turn.headings.indexOf(heading) : -1;
        if (fr >= 0) return at('snik-snak-turn', fr);
        break;
      }
      case T.BOOM:
        return at('explosion', clampFrame(Math.floor(burnt(game, i, alpha) * BOOM_FRAMES)));
      case T.BOOM_I:
        return at('infotron-explosion', clampFrame(Math.floor(burnt(game, i, alpha) * BOOM_FRAMES)));
      default:
        break;
    }
    const id = hdHardware(t, x, y) ?? HD_TILE.get(t);
    return id != null && at(`tile-${id}`);
  }

  /**
   * Which of the original's Murphy animations to show this frame, and where.
   *
   * The original draws a horizontal move as a window over both cells -- Murphy
   * walking across it, or eating through the base in front of him, or shoving a
   * zonk out of the far side -- and a vertical one as a pose that rides along
   * with him. Which window it is depends on what the step did: the engine's
   * events for the cell he moved into say whether he dug, ate or picked up, and
   * a tile that moved out of that cell as he moved in is what he pushed.
   */
  planMurphy(game, alpha, now) {
    const skip = new Set();
    const draws = [];
    const i = game.mi;
    if (game.tiles[i] !== T.MURPHY) return { skip, draws };
    const w = game.w, x = i % w, y = (i / w) | 0;
    const f = game.from[i];
    const k = Math.min(7, Math.floor(alpha * 8));
    if (game.face === 1) this.side = 'right';
    if (game.face === 3) this.side = 'left';
    const acts = this.actTick === game.tick ? this.acts : null;
    const window = (key, fr) => {
      const s = this.hd.meta.sprites[key];
      if (!s) return false;
      const [ax, ay] = s.anchor || [0, 0];
      draws.push({ key, f: fr, x: x - ax, y: y - ay });
      return true;
    };
    const pose = (key, fr) => {
      const p = this.murphyPos(game, alpha);
      draws.push({ key, f: fr, x: p.x, y: p.y });
    };

    if (f >= 0 && f !== i) {
      this.lastMove = now;
      const ddx = x - (f % w), ddy = y - ((f / w) | 0);
      if (Math.abs(ddx) === 2 || Math.abs(ddy) === 2) {
        // through a port: out of one side, in at the other
        const side = ddx > 0 ? 'right' : ddx < 0 ? 'left' : ddy > 0 ? 'down' : 'up';
        draws.push({ key: `murphy-port-${side}-in`, f: k, x: f % w, y: (f / w) | 0 });
        draws.push({ key: `murphy-port-${side}-out`, f: k, x, y });
        return { skip, draws };
      }
      const side = ddx < 0 ? 'left' : ddx > 0 ? 'right' : ddy < 0 ? 'up' : 'down';
      const ahead = i + ddy * w + ddx;
      const pushed = PUSHED.get(game.tiles[ahead]);
      if (pushed && game.from[ahead] === i && (ddx || pushed === 'yellow-disk')) {
        if (window(`murphy-push-${pushed}-${side}`, k)) { skip.add(ahead); return { skip, draws }; }
      }
      if (ddx) {
        const did = acts?.get(i);
        const key = did === 'dig' ? `murphy-eat-base-${side}`
          : did === 'infotron' ? `murphy-eat-infotron-${side}`
            : did === 'pickup' ? `murphy-eat-red-disk-${side}` : `murphy-${side}`;
        if (window(key, k)) return { skip, draws };
      } else {
        pose(`murphy-${side}-facing-${this.side}`, k);
        return { skip, draws };
      }
    }

    // standing: leaning on something, yawning, or just looking out
    if (game.pushing && (game.face === 1 || game.face === 3)) {
      pose(`murphy-shove-${this.side}`, 0);
      return { skip, draws };
    }
    if (!this.lastMove) this.lastMove = now;
    const idle = now - this.lastMove - YAWN_AFTER_MS;
    if (idle > 0) {
      const into = idle % YAWN_EVERY_MS;
      const n = this.hd.count('murphy-yawn');
      if (into < n * YAWN_MS) { pose('murphy-yawn', Math.floor(into / YAWN_MS)); return { skip, draws }; }
    }
    pose('tile-3', 0);
    return { skip, draws };
  }

  /** Snaps and the exit: short animations at a cell, started on their first frame drawn. */
  drawTransients(ctx, hd, game, now, originX, originY, tile) {
    this.transients = this.transients.filter((a) => {
      if (a.t0 == null) a.t0 = now;
      const n = hd.count(a.key);
      let f = Math.floor((now - a.t0) / a.ms);
      if (f >= n) {
        if (!a.hold || (game.state !== 'won' && game.state !== 'exiting')) return false;
        f = n - 1;
      }
      this.blit(ctx, hd, a.key, f, a.i % game.w, (a.i / game.w) | 0, originX, originY, tile);
      return true;
    });
  }

  /** Which variant of a floor to show, given what is on it right now. */
  floorKey(game, i, f) {
    if (f === FL.PAD) return game.tiles[i] === T.RACK ? 'fl-pad-on' : `fl-${FL.PAD}`;
    if (f === FL.PHASE) return game.phaseT[i] > 0 ? 'fl-phase-hot' : `fl-${FL.PHASE}`;
    if (f === FL.FORCE) return game.forceOpen ? 'fl-force-off' : `fl-${FL.FORCE}`;
    return `fl-${f}`;
  }

  spriteFor(game, i, t, frame, now) {
    switch (t) {
      case T.BASE: {
        // Scatter the routing deterministically so the board never tiles.
        const x = i % game.w, y = (i / game.w) | 0;
        return { key: `base-${(x * 5 + y * 11 + ((x * y) % 3)) % BASE_VARIANTS}`, f: 0 };
      }
      case T.EXIT:
        return { key: game.exitOpen() ? 'exit-on' : 'exit-off', f: frame };
      case T.BUG:
        return { key: game.bugActive(i) ? 'bug-on' : 'bug-off', f: 0 };
      case T.BOOM:
        return { key: 'boom', f: clampFrame(Math.floor(burnt(game, i, this.alphaNow ?? 0) * BOOM_FRAMES)) };
      case T.BOOM_I:
        return { key: 'boom-i', f: clampFrame(Math.floor(burnt(game, i, this.alphaNow ?? 0) * BOOM_FRAMES)) };
      case T.RED: {
        const fuse = fuseAt(game, i);
        if (fuse > 0) {
          // blinks faster the closer it gets to going off
          const rate = Math.max(60, fuse * 45);
          return { key: 'red-armed', f: Math.floor(now / rate) };
        }
        return { key: T.RED, f: frame };
      }
      default:
        return { key: t, f: frame };
    }
  }

  drawGrid(ctx, originX, originY, tile, x0, y0, x1, y1) {
    ctx.strokeStyle = PAL.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1 + 1; x++) {
      const sx = Math.round(x * tile - originX) + 0.5;
      ctx.moveTo(sx, Math.round(y0 * tile - originY));
      ctx.lineTo(sx, Math.round((y1 + 1) * tile - originY));
    }
    for (let y = y0; y <= y1 + 1; y++) {
      const sy = Math.round(y * tile - originY) + 0.5;
      ctx.moveTo(Math.round(x0 * tile - originX), sy);
      ctx.lineTo(Math.round((x1 + 1) * tile - originX), sy);
    }
    ctx.stroke();
  }

  /**
   * Faint scanlines and a vignette -- baked once per canvas size.
   *
   * Drawn live this cost a fresh radial gradient plus one fillRect per scanline
   * (hundreds at 4K) on every frame, for a picture that never changes until the
   * window does.
   */
  drawOverlay(ctx, W, H) {
    // the remastered board gets no scanlines -- they band the art -- only a soft vignette
    const crt = !this.hdActive;
    if (!this.overlay || this.overlay.width !== W || this.overlay.height !== H || this.overlay.crt !== crt) {
      this.overlay = buildOverlay(W, H, this.dpr, crt);
    }
    if (this.overlay) ctx.drawImage(this.overlay, 0, 0);
  }
}

/** The CRT layer: scanlines under a vignette, on its own canvas. */
function buildOverlay(W, H, dpr, crt = true) {
  if (W <= 0 || H <= 0) return null;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  c.crt = crt;
  const x = c.getContext('2d');

  if (crt) {
    x.globalAlpha = 0.05;
    x.fillStyle = '#000';
    const step = Math.max(2, Math.round(3 * dpr));
    const thick = Math.max(1, Math.round(dpr));
    for (let y = 0; y < H; y += step) x.fillRect(0, y, W, thick);
    x.globalAlpha = 1;
  }

  const g = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * (crt ? 0.35 : 0.45),
    W / 2, H / 2, Math.max(W, H) * 0.72);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, crt ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.32)');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  return c;
}

function clampFrame(f) {
  return Math.max(0, Math.min(BOOM_FRAMES - 1, f));
}
