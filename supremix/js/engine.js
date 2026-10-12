// SupRemix simulation.
//
// The world is a flat tile grid advanced in discrete steps. Every step runs the
// same passes in a fixed order -- explosions, Murphy, gravity, enemies, then the
// slow world systems -- so the same inputs always produce the same world.
//
// A step is the original game's tile of motion: Supaplex ran at 35 frames a
// second and moved Murphy, zonks and enemies 2 pixels a frame, so 8 frames,
// 229 ms, to a tile. Its timings are kept here in those terms (OpenSupaplex's
// reverse engineering of SUPAPLEX.EXE is the reference). Above all, a cell that
// something leaves stays taken for the rest of that move: nothing falls or
// walks into it until the next step. That is what keeps a zonk a tile behind a
// Murphy who keeps going, gives him a step of grace when he stops under one, and
// lets a falling column come apart a tile at a time.
// Rendering never touches this file's state; it only interpolates using `from`,
// which records where each tile arrived from during the current step.
//
// Two layers: `tiles` is what is standing in a cell, `floor` is the surface
// under it. Ice, pressure plates, collapsing walkways, fire and force fields all
// need to sit beneath Murphy or a zonk, which is what the floor layer is for.

import {
  T, FL, isWall, isRound, isFaller, isBomb, isEnemy, isPort, isGravityPort,
  isBlastProof, portAllows, isKey, isLock, keyColour, lockColour,
} from './tiles.js';

export const UP = 0, RIGHT = 1, DOWN = 2, LEFT = 3;
export const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// In steps of 8 original frames. Where the original's count is not a whole
// number of steps it is rounded, and the frame count is given.
const BOOM_STEPS = 4;    // an explosion burns 8 phases of 4 frames
const BOOM_I_STEPS = 5;  // an infotron explosion one phase longer (36 frames)
const BOOM_LETHAL = 2;   // walking into a blast kills for its first 16 frames
const CHAIN_DELAY = 2;   // a disk caught in a blast goes up 13 frames later
const RED_FUSE = 5;      // 38 frames from planting a red disk to the bang
const PLANT_HOLD = 8;    // 64 frames of holding fire to put the disk down
const PUSH_DELAY = 1;    // 8 frames of lean-in before a zonk actually shifts
const BUG_ON = 14;       // a bug sparks for 14 quarter-steps (56 frames)
const BUG_OFF_MIN = 32;  // then goes dark for 32-95 of them, chosen afresh each time
const EXIT_STEPS = 5;    // the 40-frame exit animation, the world running on
const DEATH_STEPS = 8;   // 64 frames from the bang to the level ending
const PHASE_FUSE = 44;   // steps of walkway before it seals itself
const SLIME_PERIOD = 9;  // steps between one slime cell spreading
const SLIME_SET = 14;    // steps boxed in before slime crystallises

export class Game {
  constructor(level) {
    this.load(level);
  }

  load(level) {
    const n = level.w * level.h;
    this.level = level;
    this.w = level.w;
    this.h = level.h;
    this.tiles = Uint8Array.from(level.tiles);
    this.floor = level.floor ? Uint8Array.from(level.floor) : new Uint8Array(n);
    this.fall = new Uint8Array(n);   // 1 while a tile is in free fall
    this.dir = new Uint8Array(n);    // enemy heading
    this.timer = new Int16Array(n);  // explosion burn / red disk fuse
    this.phase = new Uint8Array(n);  // (unused; kept so old saves of state stay shaped)
    this.busy = new Uint8Array(n);   // enemy: half-steps left of a move or a turn
    this.spin = new Uint8Array(n);   // enemy: 0 just arrived, 1 turning left, 2 right
    this.bugT = new Int16Array(n);   // bug: >= 0 sparking (0..13), < 0 dark, counting up
    this.vacated = new Uint8Array(n);  // left this step: taken until the move is over
    this.resBy = new Int32Array(n).fill(-1);  // cell held for an object rolling into it
    this.phaseT = new Int16Array(n); // collapsing-walkway countdown
    this.slimeT = new Int16Array(n); // how long this slime has been boxed in
    this.from = new Int32Array(n).fill(-1);
    this.done = new Uint8Array(n);

    this.mi = level.murphy;
    this.face = RIGHT;
    this.gravity = !!level.gravity;
    this.need = level.need;
    this.collected = 0;
    this.redDisks = 0;
    this.keys = new Uint8Array(4);   // amber, cyan, green, purple
    this.boots = false;
    this.slide = -1;                 // direction Murphy is sliding on ice
    this.steps = 0;
    this.tick = 0;
    this.state = 'play';             // play | dead | won
    this.stateTimer = 0;
    this.pushDir = -1;
    this.pushCount = 0;
    this.pushing = false;
    this.pending = [];               // queued chain explosions
    this.liveDisk = null;            // the planted red disk: { i, t } until it goes off
    this.plantHold = 0;              // steps fire has been held to plant one
    this.idleBefore = true;          // no input last step (planting needs a fresh press)
    this.yellowDone = false;         // the terminals have been used
    this.blowAt = -1;                // Murphy's own blast, set off at the end of the step
    this.shoving = false;            // leaning on or pushing something sideways this step
    // the original's random number generator, for the bugs; seeded by level
    this.seed = [...(level.name || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xffff, 0x2a5f);
    this.events = [];                // sound cues, drained each step
    // The same events again, with a cell attached. Sound does not care where a
    // dig happened; particles care about nothing else. Keeping this beside
    // `events` rather than replacing it means every existing consumer -- audio,
    // the HUD, the tests -- is untouched, and a site that has no sensible cell
    // to report simply does not report one.
    this.fx = [];

    this.pads = [];
    for (let i = 0; i < n; i++) if (this.floor[i] === FL.PAD) this.pads.push(i);
    this.slimeCap = level.slimeCap ?? 70;
    this.slimeCursor = 0;
    this.updateForce();
  }

  restart() {
    this.load(this.level);
  }

  // --- grid helpers ---------------------------------------------------------

  xOf(i) { return i % this.w; }
  yOf(i) { return (i / this.w) | 0; }
  at(x, y) { return this.tiles[y * this.w + x]; }

  /**
   * Something happened, and it happened somewhere.
   *
   * Sound does not care where a dig was; particles care about nothing else.
   * Both channels are filled here so the two never drift apart, and a site with
   * no sensible cell to report can still push to `events` on its own.
   */
  note(kind, i) {
    this.events.push(kind);
    if (i >= 0 && i < this.tiles.length) this.fx.push({ k: kind, i });
  }

  /**
   * The cell one step from `i` in direction `d`, or -1 if that leaves the grid.
   *
   * Passes that walk the interior can add an offset directly, but anything
   * scanning the whole board has to go through here: `i - 1` from column 0 is
   * the far end of the row above, not a wall.
   */
  neighbour(i, d) {
    const [dx, dy] = DIRS[d];
    const x = (i % this.w) + dx, y = ((i / this.w) | 0) + dy;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }

  /** A live force field seals its cell against everything, Murphy included. */
  sealed(i) {
    return this.floor[i] === FL.FORCE && !this.forceOpen;
  }

  /** Free space anything may move into. */
  canEnter(i) {
    return this.tiles[i] === T.EMPTY && !this.sealed(i);
  }

  /**
   * Force fields are open only while every pressure plate carries a rack. A
   * level with fields but no plates leaves them permanently on, which makes a
   * mis-authored level read as a wall rather than as free passage.
   */
  updateForce() {
    if (!this.pads.length) { this.forceOpen = false; return; }
    for (const i of this.pads) {
      if (this.tiles[i] !== T.RACK) { this.forceOpen = false; return; }
    }
    this.forceOpen = true;
  }

  padsPressed() {
    let n = 0;
    for (const i of this.pads) if (this.tiles[i] === T.RACK) n++;
    return n;
  }

  /** Move a tile and everything attached to it, recording the hop for rendering. */
  moveTile(fromIdx, toIdx) {
    this.tiles[toIdx] = this.tiles[fromIdx];
    this.fall[toIdx] = this.fall[fromIdx];
    this.dir[toIdx] = this.dir[fromIdx];
    this.timer[toIdx] = this.timer[fromIdx];
    this.busy[toIdx] = this.busy[fromIdx];
    this.spin[toIdx] = this.spin[fromIdx];

    this.tiles[fromIdx] = T.EMPTY;
    this.fall[fromIdx] = 0;
    this.dir[fromIdx] = 0;
    this.timer[fromIdx] = 0;
    this.busy[fromIdx] = 0;
    this.spin[fromIdx] = 0;

    // The cell it left is taken until its move is over: in the original the
    // source is marked as being left for the whole eight frames.
    this.vacated[fromIdx] = 1;
    this.resBy[toIdx] = -1;
    this.from[toIdx] = fromIdx;
    this.from[fromIdx] = -1;
    this.done[toIdx] = 1;
    if (this.tiles[toIdx] === T.MURPHY) this.mi = toIdx;
  }

  /** Free for something to move into this step: empty, and not being left or claimed. */
  open(i) {
    return this.canEnter(i) && !this.vacated[i] && this.resBy[i] < 0;
  }

  infotronsLeft() {
    let n = 0;
    for (let i = 0; i < this.tiles.length; i++) if (this.tiles[i] === T.INFOTRON) n++;
    return n;
  }

  exitOpen() { return this.collected >= this.need; }

  /** A bug is lethal while it sparks. */
  bugActive(i) {
    return this.bugT[i] >= 0;
  }

  /** The original's generator: seed * 1509 + 49, 16 bits, the top 15 returned. */
  rand() {
    this.seed = (this.seed * 1509 + 49) & 0xffff;
    return this.seed >> 1;
  }

  // --- explosions -----------------------------------------------------------

  /**
   * Detonate a 3x3 around `center`. `electron` blasts leave infotrons behind.
   *
   * Only hardware stands. Orange and yellow disks, snik snaks and electrons
   * caught in it go off themselves a moment later -- an electron as an infotron
   * blast, or as a plain one if what caught it was an electron blast -- and
   * anything caught by an electron blast chains as one. A red disk lying about
   * is not wired to go off: it is simply destroyed. Murphy caught in it blows up
   * where he stands.
   */
  explode(center, kind = 'normal') {
    const cx = this.xOf(center), cy = this.yOf(center);
    const payload = kind === 'electron' ? T.BOOM_I : T.BOOM;
    const chain = [];

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        const j = y * this.w + x;
        const t = this.tiles[j];
        if (isBlastProof(t)) continue;
        if (t === T.MURPHY) this.killMurphy();
        if (j !== center) {
          if (t === T.ORANGE || t === T.YELLOW || t === T.SNIKSNAK) chain.push([j, kind]);
          else if (t === T.ELECTRON) chain.push([j, kind === 'electron' ? 'normal' : 'electron']);
        }

        this.tiles[j] = payload;
        this.timer[j] = payload === T.BOOM_I ? BOOM_I_STEPS : BOOM_STEPS;
        this.fall[j] = 0;
        this.dir[j] = 0;
        this.busy[j] = 0;
        this.spin[j] = 0;
        this.slimeT[j] = 0;
        this.from[j] = -1;
      }
    }

    for (const [j, k] of chain) this.pending.push({ i: j, kind: k, delay: CHAIN_DELAY });
    this.note('boom', center);
  }

  /** Murphy dies. He always goes up in a blast of his own, at the end of the step. */
  killMurphy() {
    if (this.state !== 'play') return;
    this.state = 'dead';
    this.stateTimer = DEATH_STEPS;
    this.slide = -1;
    this.blowAt = this.mi;
    this.note('die', this.mi);
  }

  /**
   * Every terminal is wired to every yellow disk. Touch one and they all go up
   * at once; disks beside one another chain a moment later. It works once.
   */
  detonateYellowDisks() {
    if (this.yellowDone) { this.events.push('blocked'); return; }
    this.yellowDone = true;
    let found = 0;
    for (let i = 0; i < this.tiles.length; i++) {
      if (this.tiles[i] === T.YELLOW) { this.explode(i); found++; }
    }
    this.events.push(found ? 'terminal' : 'blocked');
  }

  // --- passes ---------------------------------------------------------------

  passExplosions() {
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      if (t !== T.BOOM && t !== T.BOOM_I) continue;
      if (--this.timer[i] <= 0) {
        this.tiles[i] = t === T.BOOM_I ? T.INFOTRON : T.EMPTY;
        this.timer[i] = 0;
      }
    }
    // Chains after the burn-down, so a blast set off now gets its full time.
    for (let k = this.pending.length - 1; k >= 0; k--) {
      const p = this.pending[k];
      if (--p.delay <= 0) {
        this.pending.splice(k, 1);
        this.explode(p.i, p.kind);
      }
    }
    // The planted red disk: it shows once Murphy has stepped off it, and it goes
    // off on time whatever has happened to the tile.
    const L = this.liveDisk;
    if (L) {
      if (this.tiles[L.i] === T.EMPTY && L.i !== this.mi) this.tiles[L.i] = T.RED;
      if (--L.t <= 0) { this.liveDisk = null; this.explode(L.i); }
    }
  }

  /**
   * What the surface Murphy just arrived on does to him.
   * Returns false if it killed him.
   */
  arrive(i, dir) {
    const f = this.floor[i];
    this.slide = f === FL.ICE ? dir : -1;

    if (f === FL.FIRE && !this.boots) {
      this.note('burn', i);
      this.killMurphy();
      return false;
    }
    this.note('slide', i);
    if (f === FL.PHASE && this.phaseT[i] === 0) {
      this.phaseT[i] = PHASE_FUSE;
      this.events.push('phase');
    }
    return true;
  }

  /** Murphy takes one step into `j`, which must already be clear. */
  stepInto(j, dir) {
    this.moveTile(this.mi, j);
    this.steps++;
    return this.arrive(j, dir);
  }

  passMurphy(input) {
    if (this.state !== 'play') return;
    const i = this.mi;
    const d = input.dir;
    this.shoving = false;

    // Gravity has him falling whenever there is room below -- unless he is just
    // under a port he could have come up through. He can still dig his way out
    // sideways or upward through base as he goes; nothing else steers him.
    if (this.gravity) {
      const below = i + this.w;
      const above = this.tiles[i - this.w];
      const underPort = isPort(above) && portAllows(above, 0, -1);
      if (this.open(below) && !underPort) {
        const side = { [UP]: i - this.w, [LEFT]: i - 1, [RIGHT]: i + 1 }[d];
        if (input.grab || side === undefined || this.tiles[side] !== T.BASE) {
          this.moveTile(i, below);
          this.arrive(below, DOWN);
          this.pushCount = 0;
          this.idleBefore = false;
          return;
        }
      }
    }

    // So does ice: once you are moving you keep moving until something stops you.
    if (this.slide >= 0) {
      const [sx, sy] = DIRS[this.slide];
      const ahead = i + sy * this.w + sx;
      if (this.open(ahead)) {
        this.stepInto(ahead, this.slide);
        return;
      }
      this.slide = -1;   // stopped against something; controls come back now
    }

    // Planting a red disk: hold fire with no direction, from a standstill, for
    // 64 frames. It goes down where Murphy stands and shows once he steps off.
    // He cannot move while he holds it; letting go early plants nothing.
    if (input.plant && d < 0) {
      if (this.redDisks <= 0) { if (this.plantHold === 0 && this.idleBefore) this.events.push('nodisk'); this.plantHold = -1; return; }
      if (this.liveDisk) return;
      if (this.plantHold === 0 && !this.idleBefore) return;
      if (++this.plantHold > PLANT_HOLD) {
        this.plantHold = 0;
        this.redDisks--;
        this.liveDisk = { i, t: RED_FUSE };
        this.note('plant', i);
      }
      return;
    }
    this.plantHold = 0;
    this.idleBefore = d < 0 && !input.plant;

    if (d < 0) {
      this.pushCount = 0;
      this.pushDir = -1;
      this.pushing = false;
      return;
    }

    this.face = d;
    const [dx, dy] = DIRS[d];
    const x = this.xOf(i) + dx, y = this.yOf(i) + dy;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const j = y * this.w + x;
    const t = this.tiles[j];

    if (input.grab) {
      this.pushing = false;
      this.grab(j, t);
      return;
    }

    // Anything that is not a push resets the lean-in counter.
    const pushable = t === T.ZONK || t === T.ORANGE || t === T.YELLOW || t === T.RACK;
    if (!pushable) {
      this.pushCount = 0;
      this.pushDir = -1;
      this.pushing = false;
    }

    // A live force field is a wall, whatever is standing in the cell.
    if (this.sealed(j) && t !== T.EXIT) { this.events.push('blocked'); return; }

    // Something being left, or held for a rolling object, cannot be walked into.
    // A cell an infotron is about to drop into is death; a zonk's just blocks.
    if (this.vacated[j]) return;
    if (this.resBy[j] >= 0) {
      if (this.tiles[this.resBy[j]] === T.INFOTRON) this.explode(j);
      return;
    }

    // Walking into something that is falling: it lands on you. Coming down onto
    // a falling infotron from above still takes it, as the original does.
    if ((t === T.ZONK || t === T.INFOTRON) && this.fall[j] && this.canEnter(j + this.w)
        && !(t === T.INFOTRON && d === DOWN)) {
      this.explode(j);
      return;
    }

    if (isKey(t)) {
      this.keys[keyColour(t)]++;
      this.tiles[j] = T.EMPTY;
      this.stepInto(j, d);
      this.note('key', j);
      return;
    }

    if (isLock(t)) {
      const c = lockColour(t);
      if (this.keys[c] <= 0) { this.events.push('locked'); return; }
      this.keys[c]--;
      this.tiles[j] = T.EMPTY;
      this.stepInto(j, d);
      this.note('unlock', j);
      return;
    }

    switch (t) {
      case T.EMPTY:
        this.stepInto(j, d);
        return;

      case T.BASE:
        this.tiles[j] = T.EMPTY;
        this.stepInto(j, d);
        this.note('dig', j);
        return;

      case T.INFOTRON:
        this.tiles[j] = T.EMPTY;
        this.fall[j] = 0;
        this.collected++;
        this.stepInto(j, d);
        this.note('infotron', j);
        if (this.collected === this.need) this.events.push('open');
        return;

      case T.RED:
        this.takeRedDisk(j);
        this.stepInto(j, d);
        return;

      case T.BOOTS:
        this.tiles[j] = T.EMPTY;
        this.boots = true;
        this.stepInto(j, d);
        this.note('boots', j);
        return;

      case T.BUG:
        // a sparking bug blows Murphy up where he stands; a dark one is base
        if (this.bugActive(j)) { this.killMurphy(); return; }
        this.tiles[j] = T.EMPTY;
        this.stepInto(j, d);
        this.note('dig', j);
        return;

      case T.BOOM:
        // the dying half of a blast can be walked into; the first half kills
        if (this.timer[j] > BOOM_LETHAL) { this.killMurphy(); return; }
        this.tiles[j] = T.EMPTY;
        this.timer[j] = 0;
        this.stepInto(j, d);
        return;

      case T.BOOM_I:
        this.killMurphy();
        return;

      case T.EXIT:
        if (this.exitOpen()) {
          this.tiles[i] = T.EMPTY;
          this.state = 'exiting';
          this.stateTimer = EXIT_STEPS;
          this.note('exit', i);
        } else {
          this.events.push('blocked');
        }
        return;

      case T.TERMINAL:
        this.detonateYellowDisks();
        return;

      case T.SNIKSNAK:
      case T.ELECTRON:
        this.explode(j, t === T.ELECTRON ? 'electron' : 'normal');
        return;

      case T.SLIME:
        this.events.push('blocked');
        return;

      case T.ZONK:
      case T.ORANGE:
        if (dy !== 0) return;            // zonks and orange disks only shove sideways
        this.tryPush(i, j, dx, dy);
        return;

      case T.YELLOW:
      case T.RACK:
        this.tryPush(i, j, dx, dy);      // disks and racks shove any direction
        return;

      default:
        if (isPort(t) && portAllows(t, dx, dy)) this.tryPort(i, j, dx, dy, t);
        return;
    }
  }

  /**
   * Pick up a red disk from the board. The one that is planted and burning
   * gives no disk back -- and does not stop burning.
   */
  takeRedDisk(j) {
    this.tiles[j] = T.EMPTY;
    this.timer[j] = 0;
    if (!this.liveDisk || this.liveDisk.i !== j) this.redDisks++;
    this.note('pickup', j);
  }

  grab(j, t) {
    // what is taken leaves its cell taken for the rest of the step, as a move does
    const take = () => { this.tiles[j] = T.EMPTY; this.vacated[j] = 1; };
    if (this.vacated[j] || this.resBy[j] >= 0) return;
    if (t === T.BASE) {
      take();
      this.note('dig', j);
    } else if (t === T.INFOTRON) {
      if (this.fall[j] && this.canEnter(j + this.w)) return;   // a falling one slips past
      take();
      this.collected++;
      this.note('infotron', j);
      if (this.collected === this.need) this.events.push('open');
    } else if (t === T.RED) {
      this.takeRedDisk(j);
      this.vacated[j] = 1;
    } else if (isKey(t)) {
      this.keys[keyColour(t)]++;
      take();
      this.note('key', j);
    } else if (t === T.BOOTS) {
      take();
      this.boots = true;
      this.note('boots', j);
    } else if (t === T.BUG) {
      if (this.bugActive(j)) { this.killMurphy(); return; }   // reaching for a live bug is touching it
      take();
      this.note('dig', j);
    } else if (t === T.TERMINAL) {
      this.detonateYellowDisks();
    }
  }

  tryPush(i, j, dx, dy) {
    const bx = this.xOf(j) + dx, by = this.yOf(j) + dy;
    if (bx < 0 || by < 0 || bx >= this.w || by >= this.h) return;
    const beyond = by * this.w + bx;
    const t = this.tiles[j];
    // Only something at rest can be pushed, into a cell nothing else is using;
    // and a zonk or orange disk with nothing under it is about to fall, not be pushed.
    const settling = (t === T.ZONK || t === T.ORANGE) && this.canEnter(j + this.w);
    if (!this.open(beyond) || this.fall[j] || settling) {
      this.pushCount = 0;
      this.pushing = false;
      return;
    }

    // Shoving takes a moment of effort; a single tap only leans on it.
    const d = this.face;
    if (this.pushDir !== d) { this.pushDir = d; this.pushCount = 0; }
    this.pushing = true;
    this.shoving = dy === 0;
    if (this.pushCount++ < PUSH_DELAY) {
      this.events.push('lean');
      return;
    }

    const heavy = t === T.RACK;
    this.moveTile(j, beyond);
    this.fall[beyond] = 0;
    this.moveTile(i, j);
    this.steps++;
    this.arrive(j, d);
    this.pushCount = 0;
    this.pushing = false;
    this.events.push(heavy ? 'rack' : 'push');
    // a zonk shoved off onto a snik snak lands on it there and then
    if (t === T.ZONK && this.tiles[beyond + this.w] === T.SNIKSNAK) this.explode(beyond + this.w);
  }

  tryPort(i, j, dx, dy, portTile) {
    const ex = this.xOf(j) + dx, ey = this.yOf(j) + dy;
    if (ex < 0 || ey < 0 || ex >= this.w || ey >= this.h) return;
    const exitIdx = ey * this.w + ex;
    if (!this.open(exitIdx)) { this.events.push('blocked'); return; }

    this.moveTile(i, exitIdx);       // slides through the port in one hop
    this.steps++;
    this.arrive(exitIdx, this.face);
    if (isGravityPort(portTile)) {
      this.gravity = !this.gravity;
      this.events.push('gravity');
    } else {
      this.note('port', exitIdx);
    }
  }

  passGravity() {
    const w = this.w;
    // A roll's claim on the cell below its new place lasts until the next gravity pass.
    this.resBy.fill(-1);
    // Bottom-up. Each faller waits for the cell below to be truly free -- not
    // just left this step -- so a column comes apart a tile at a time.
    for (let y = this.h - 2; y >= 1; y--) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (this.done[i]) continue;
        const t = this.tiles[i];
        if (!isFaller(t)) continue;

        const below = i + w;
        const tb = this.tiles[below];

        if (this.open(below)) {
          this.fall[i] = 1;
          this.moveTile(i, below);
          continue;
        }

        if (this.fall[i]) {
          // it has landed
          this.fall[i] = 0;
          if (t === T.ORANGE) { this.explode(i); continue; }
          if (!this.vacated[below] && this.crushes(t, tb)) {
            this.explode(below, tb === T.ELECTRON ? 'electron' : 'normal');
            continue;
          }
          this.note('land', below);
          // and may roll off at once
        }

        if (t === T.ORANGE) continue;  // orange disks never roll, they only drop
        if (!isRound(tb) || this.fall[below]) continue;

        for (const s of [-1, 1]) {
          const side = i + s, sideDown = below + s;
          if (this.open(side) && this.open(sideDown)) {
            this.fall[i] = 1;
            this.moveTile(i, side);
            this.resBy[sideDown] = side;
            break;
          }
        }
      }
    }
  }

  /** Does `faller` landing on `t` set it off? */
  crushes(faller, t) {
    // Murphy shoving sideways braces against it: a zonk just comes to rest on him
    if (t === T.MURPHY) return !this.shoving;
    if (isEnemy(t) || t === T.ORANGE || t === T.SLIME) return true;
    // an infotron is heavy enough to set off disks; a zonk is not
    return faller === T.INFOTRON && (t === T.YELLOW || t === T.RED);
  }

  /**
   * Snik snaks and electrons. They move as fast as Murphy, wall-following with
   * the left hand, and the original times their thinking in half steps: a move
   * takes two, the first quarter-turn after arriving one, each turn after that
   * two. So each step gives every enemy two half-steps.
   */
  passEnemies() {
    const list = [];
    for (let i = 0; i < this.tiles.length; i++) {
      if (isEnemy(this.tiles[i]) && !this.done[i]) list.push(i);
    }
    for (const start of list) {
      let at = start;
      for (let h = 0; h < 2 && at >= 0; h++) {
        if (!isEnemy(this.tiles[at])) break;   // blown up meanwhile
        if (this.busy[at] > 0) { this.busy[at]--; continue; }
        at = this.enemyThink(at);
      }
    }
  }

  /** One half-step of an enemy at `i`. Returns where it is now, or -1 if it went off. */
  enemyThink(i) {
    const d = this.dir[i], left = (d + 3) & 3, right = (d + 1) & 3;
    const cell = k => this.neighbour(i, k);
    const free = k => { const j = cell(k); return j >= 0 && this.open(j); };
    const murphy = k => { const j = cell(k); return j >= 0 && this.tiles[j] === T.MURPHY; };
    const go = k => {
      const j = cell(k);
      this.dir[i] = k;
      this.moveTile(i, j);
      this.spin[j] = 0;
      this.busy[j] = 1;               // the move takes the next half-step too
      return j;
    };
    const strike = () => { this.explode(i, this.tiles[i] === T.ELECTRON ? 'electron' : 'normal'); return -1; };

    if (this.spin[i] === 0) {
      // just arrived: left if it can, else on, else right, else round to the left
      if (free(left) || murphy(left)) { this.dir[i] = left; this.spin[i] = 1; return i; }
      if (free(d)) return go(d);
      if (murphy(d)) return strike();
      if (free(right) || murphy(right)) { this.dir[i] = right; this.spin[i] = 2; return i; }
      this.dir[i] = left; this.spin[i] = 1; return i;
    }
    // turning: look where it now faces; carry on round if it cannot go
    if (free(d)) return go(d);
    if (murphy(d)) return strike();
    this.dir[i] = this.spin[i] === 1 ? left : right;
    this.busy[i] = 1;
    return i;
  }

  /** Bugs spark for 56 frames, then lie dark for a random 128-380. All start sparking. */
  passBugs() {
    for (let i = 0; i < this.tiles.length; i++) {
      if (this.tiles[i] !== T.BUG) continue;
      for (let q = 0; q < 2; q++) {
        let s = this.bugT[i] + 1;
        if (s >= BUG_ON) s = -(BUG_OFF_MIN + (this.rand() & 63));
        this.bugT[i] = s;
      }
    }
  }

  /** Collapsing walkways: armed by standing on them, then they seal for good. */
  passPhase() {
    for (let i = 0; i < this.floor.length; i++) {
      if (this.floor[i] !== FL.PHASE || this.phaseT[i] <= 0) continue;
      if (--this.phaseT[i] > 0) continue;

      this.floor[i] = FL.NONE;
      if (this.tiles[i] === T.MURPHY) {
        // Do not overwrite him: `mi` would then point at a wall. Blow the cell
        // instead, which kills him and animates it.
        this.explode(i);
      } else {
        this.tiles[i] = T.HARDWARE;
      }
      this.note('seal', i);
    }
  }

  /**
   * Boulder Dash's amoeba, rethought as data corruption.
   *
   * It creeps into one free cell at a time -- slowly enough to plan against,
   * relentlessly enough to matter. Box a patch in completely and it crystallises
   * into infotrons; let it run past its cap and the whole mass hardens into
   * zonks instead, so a level can never be drowned in it.
   */
  passSlime() {
    const cells = [];
    for (let i = 0; i < this.tiles.length; i++) {
      if (this.tiles[i] === T.SLIME) cells.push(i);
    }
    if (!cells.length) return;

    if (cells.length > this.slimeCap) {
      for (const i of cells) { this.tiles[i] = T.ZONK; this.slimeT[i] = 0; }
      this.note('harden', cells[0]);
      return;
    }

    for (const i of cells) {
      if (this.slimeHasRoom(i)) { this.slimeT[i] = 0; continue; }
      if (++this.slimeT[i] >= SLIME_SET) {
        this.tiles[i] = T.INFOTRON;
        this.slimeT[i] = 0;
        this.note('crystal', i);
      }
    }

    if (this.tick % SLIME_PERIOD !== 0) return;
    const from = cells[this.slimeCursor % cells.length];
    this.slimeCursor++;
    for (let k = 0; k < 4; k++) {
      const nd = (this.slimeCursor + k) & 3;
      const j = this.neighbour(from, nd);
      if (j < 0) continue;
      if (!this.canEnter(j)) continue;
      this.tiles[j] = T.SLIME;
      this.slimeT[j] = 0;
      this.note('creep', j);
      break;
    }
  }

  slimeHasRoom(i) {
    for (let d = 0; d < 4; d++) {
      const j = this.neighbour(i, d);
      if (j >= 0 && this.canEnter(j)) return true;
    }
    return false;
  }

  // --- main step ------------------------------------------------------------

  step(input = { dir: -1, grab: false, plant: false }) {
    this.events.length = 0;
    this.fx.length = 0;
    this.from.fill(-1);
    this.done.fill(0);
    this.vacated.fill(0);
    this.updateForce();

    // `tick` advances at the END of the step, not the start. Bug flashing is
    // driven by it, so this is what makes the board honest: the phase a player
    // sees rendered is the same phase the move they make next is judged
    // against. Incrementing first meant a bug could look dark as you pressed
    // the key and be lethal by the time the step resolved.
    if (this.state === 'won') { this.tick++; return this.events; }

    // Dying and leaving both take a while, and the world keeps going meanwhile.
    if (this.state === 'dead' || this.state === 'exiting') {
      if (this.stateTimer > 0) this.stateTimer--;
      this.passExplosions();
      this.passGravity();
      this.passEnemies();
      this.passBugs();
      this.blowUpMurphy();
      if (this.state === 'exiting' && this.stateTimer <= 0) this.state = 'won';
      this.tick++;
      return this.events;
    }

    this.passExplosions();
    this.passMurphy(input);
    this.passGravity();
    this.passEnemies();
    this.passPhase();
    this.passSlime();
    this.passBugs();
    this.blowUpMurphy();
    this.tick++;
    return this.events;
  }

  /** However Murphy died, he goes up in a 3x3 of his own. */
  blowUpMurphy() {
    if (this.blowAt < 0) return;
    const at = this.blowAt;
    this.blowAt = -1;
    this.explode(at);
  }
}
