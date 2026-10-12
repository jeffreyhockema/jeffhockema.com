// Game controllers: Xbox, PlayStation, Switch Pro, 8BitDo and the rest, over
// Bluetooth or USB, through the browser's Gamepad API.
//
//   D-pad / left stick   move (the stick snaps to four directions, as touch does)
//   A                    fire, as Space: with a direction, reach without moving;
//                        held alone, standing still, plant a red disk
//   B                    plant a red disk (hold), as the B key
//   Y                    close view / whole level
//   Back (Select)        restart the level
//   Start                pause / resume
//
// and in the menus: D-pad or left stick to move between buttons (by where they
// are on screen, so the level grid works as a grid), A to press, B to go back,
// Start to press the screen's main button. A controller that drops out mid-level
// pauses the game, as a console does. Losing a life, and a blast, rumble.
//
// Nothing here is new machinery: the controller writes `padDir`, `padFire`,
// `padPlant`, `tapDir` and `fresh` on the shared Input, the way the keyboard
// and the touch controls do, so a pad plays by exactly the same rules.
//
// The Gamepad API is polled, not evented: main.js calls poll() once a frame.
// Browsers report a controller only after one of its buttons has been pressed
// with the page open, and only on a secure page (https:// or localhost) --
// which matters when the game is opened from a phone by its LAN address.
// (The approach comes from TDDL's controller support.)

import { stickDirection } from './touch.js';

/** Buttons by index in the browser's "standard" mapping (Xbox names; on a
 *  PlayStation pad Cross is A, Circle B, Square X, Triangle Y). */
export const BUTTON = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

export const PAD = {
  STICK_DEAD_ZONE: 0.3,       // sticks at rest commonly read 0.05-0.15
  TRIGGER_THRESHOLD: 0.4,
  MENU_STICK_THRESHOLD: 0.6,  // the stick steps through menus once pushed this far
  REPEAT_DELAY_MS: 400,       // a direction held in a menu repeats, like a held key
  REPEAT_RATE_MS: 140,
  SCROLL_PX: 140,             // a step past the last button scrolls a long screen
};

const REPEATING = new Set([BUTTON.UP, BUTTON.DOWN, BUTTON.LEFT, BUTTON.RIGHT]);
const DPAD_DIR = [[BUTTON.UP, 0], [BUTTON.RIGHT, 1], [BUTTON.DOWN, 2], [BUTTON.LEFT, 3]];

// --- pure helpers -------------------------------------------------------------

/** Turns button states into presses: a button fires on the frame it goes down,
 *  and the menu directions fire again while held, after a delay. */
export class ButtonEdges {
  constructor() { this.held = new Map(); }

  reset() { this.held.clear(); }

  update(pressed, now) {
    const fired = new Set();
    for (let i = 0; i < pressed.length; i++) {
      const was = this.held.get(i);
      if (!pressed[i]) { if (was) this.held.delete(i); continue; }
      if (!was) {
        this.held.set(i, { since: now, last: now });
        fired.add(i);
      } else if (REPEATING.has(i) && now - was.since >= PAD.REPEAT_DELAY_MS
                 && now - was.last >= PAD.REPEAT_RATE_MS) {
        was.last = now;
        fired.add(i);
      }
    }
    return fired;
  }
}

/** Reads a controller into plain values: which buttons are down (analog
 *  triggers by threshold), the same with the left stick standing in for the
 *  D-pad (for menus), and the left stick with its dead zone applied. */
export function readPad(gp) {
  const buttons = gp.buttons || [];
  const axes = gp.axes || [];
  const pressed = [];
  for (let i = 0; i < Math.max(buttons.length, 16); i++) {
    const b = buttons[i];
    pressed[i] = !!b && (b.pressed || (b.value ?? 0) > PAD.TRIGGER_THRESHOLD);
  }
  const x = axes[0] || 0, y = axes[1] || 0;
  const magnitude = Math.min(1, Math.hypot(x, y));
  const t = PAD.MENU_STICK_THRESHOLD;
  const stickAs = { [BUTTON.UP]: y < -t, [BUTTON.DOWN]: y > t, [BUTTON.LEFT]: x < -t, [BUTTON.RIGHT]: x > t };
  return {
    pressed,
    menuPressed: pressed.map((p, i) => p || !!stickAs[i]),
    stick: magnitude < PAD.STICK_DEAD_ZONE ? { x: 0, y: 0, magnitude: 0 } : { x, y, magnitude },
  };
}

/** Whether a controller is doing anything: a button, or the stick off centre. */
export function isPadBusy(reading) {
  return reading.pressed.some(Boolean) || reading.stick.magnitude > 0;
}

/**
 * The direction Murphy is asked to go, 0 up .. 3 left, or -1. The D-pad wins
 * (the newest of its arrows, should two be down); the stick snaps to four
 * directions with the touch stick's hysteresis, so rolling a thumb round a
 * corner does not flicker between them.
 */
export function padDirection(reading, held = -1) {
  const dpad = DPAD_DIR.filter(([b]) => reading.pressed[b]).map(([, d]) => d);
  if (dpad.length) return dpad.includes(held) && dpad.length > 1 ? dpad.find((d) => d !== held) : dpad[0];
  const s = reading.stick;
  return s.magnitude > 0 ? stickDirection(s.x, s.y, 1, held) : -1;
}

/**
 * The button to move to from `current` in `dir` (0 up .. 3 left), from their
 * centres on screen: the nearest one that way, favouring those in line. -1
 * when there is none that way.
 */
export function nearestButton(centres, current, dir) {
  const from = centres[current];
  if (!from) return centres.length ? 0 : -1;
  const [ux, uy] = [[0, -1], [1, 0], [0, 1], [-1, 0]][dir];
  let best = -1, bestScore = Infinity;
  centres.forEach((c, i) => {
    if (i === current) return;
    const dx = c.x - from.x, dy = c.y - from.y;
    const along = dx * ux + dy * uy;
    if (along <= 4) return;
    const score = along + Math.abs(dx * uy - dy * ux) * 2.5;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

// --- the controller -------------------------------------------------------------

export class GamepadControls {
  /**
   * @param {object} input  the game's Input
   * @param {object} ui     hooks into the app shell: screen(), inPlay(), pause(),
   *                        resume(), back(), restart(), toggleView(), toast(msg),
   *                        wake(), overlay (the element menus scroll in)
   */
  constructor(input, ui, getPads = () => [...(navigator.getGamepads?.() || [])]) {
    this.input = input;
    this.ui = ui;
    this.getPads = getPads;
    this.edges = new ButtonEdges();
    this.padIndex = null;
    this.live = false;         // polled only once a controller has shown up
    this.dir = -1;
    this.stale = new Set();    // buttons held over from a menu, ignored until let go
    this.wasInPlay = false;
    this.woke = false;
    this.bind();
  }

  bind() {
    if (typeof window === 'undefined' || !navigator.getGamepads) return;
    window.addEventListener('gamepadconnected', (e) => {
      this.live = true;
      this.ui.toast?.('CONTROLLER CONNECTED');
      console.log(`Gamepad: ${e.gamepad?.id} connected`);
    });
    window.addEventListener('gamepaddisconnected', (e) => this.disconnected(e.gamepad?.index));
    try { if (this.getPads().some(Boolean)) this.live = true; } catch { /* insecure page */ }
    // A thumb on the glass brings the touch controls back.
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') document.body.classList.remove('pad-active');
    }, { capture: true });
  }

  /** Reads the controller once and acts on it. Called every animation frame. */
  poll(now = performance.now()) {
    if (!this.live) return;
    const gp = this.choosePad();
    if (!gp) { this.releasePlay(); return; }
    const reading = readPad(gp);
    if (isPadBusy(reading)) this.markActive();

    const inPlay = this.ui.inPlay();
    if (!inPlay) {
      this.releasePlay();
      this.wasInPlay = false;
      this.handleMenu(this.edges.update(reading.menuPressed, now));
      return;
    }
    if (!this.wasInPlay) {
      // Whatever was pressed to get here (A on RESUME, say) is not a move.
      this.stale = new Set(reading.pressed.flatMap((p, i) => (p ? [i] : [])));
      this.wasInPlay = true;
    }
    for (const i of this.stale) if (!reading.pressed[i]) this.stale.delete(i);
    const pressed = reading.pressed.map((p, i) => p && !this.stale.has(i));
    this.handlePlay({ ...reading, pressed }, this.edges.update(pressed, now));
  }

  /** The controller in use, or else the first doing something: a second pad
   *  left on the sofa does not steal the game; picking one up takes it over. */
  choosePad() {
    const pads = (this.getPads() || []).filter((p) => p && p.connected !== false);
    if (!pads.length) { this.padIndex = null; return null; }
    const current = pads.find((p) => p.index === this.padIndex);
    const busy = pads.find((p) => p !== current && isPadBusy(readPad(p)));
    const chosen = busy && (!current || !isPadBusy(readPad(current))) ? busy : (current || pads[0]);
    if (chosen.index !== this.padIndex) {
      this.padIndex = chosen.index;
      this.edges.reset();
    }
    return chosen;
  }

  /** The pad is being played with: the touch controls step aside (a phone in a
   *  controller clip has no thumbs on the glass), and audio wakes, as on a tap. */
  markActive() {
    document.body.classList.add('pad-active');
    if (!this.woke) { this.woke = true; try { this.ui.wake?.(); } catch { /* no audio */ } }
  }

  handlePlay(reading, fired) {
    const inp = this.input;
    const dir = padDirection(reading, this.dir);
    if (dir !== this.dir) {
      this.dir = dir;
      if (dir >= 0) { inp.tapDir = dir; inp.fresh = true; }
    }
    inp.padDir = dir;

    // A is Space: reach with a direction, plant when held alone. Once a
    // direction has joined it, letting the direction go does not plant.
    const fire = reading.pressed[BUTTON.A];
    if (fire && !inp.padFire) inp.padFireUsedForGrab = dir >= 0;
    else if (fire && dir >= 0) inp.padFireUsedForGrab = true;
    else if (!fire) inp.padFireUsedForGrab = false;
    inp.padFire = fire;
    inp.padPlant = reading.pressed[BUTTON.B];

    if (fired.has(BUTTON.Y)) this.ui.toggleView();
    if (fired.has(BUTTON.BACK)) { this.releasePlay(); this.ui.restart(); return; }
    if (fired.has(BUTTON.START)) { this.releasePlay(); this.ui.pause(); }
  }

  /** Lets go of everything the pad holds, so nothing carries into a menu. */
  releasePlay() {
    const inp = this.input;
    this.dir = -1;
    inp.padDir = -1;
    inp.padFire = false;
    inp.padFireUsedForGrab = false;
    inp.padPlant = false;
  }

  // --- menus ---

  screenEl() {
    const name = this.ui.screen();
    return name ? document.querySelector(`.screen[data-screen="${name}"]`) : null;
  }

  buttons(screen) {
    return [...screen.querySelectorAll('button')]
      .filter((b) => !b.disabled && b.getClientRects().length > 0);
  }

  primary(screen) {
    const all = this.buttons(screen);
    return all.find((b) => b.classList.contains('btn-primary')) || all[0] || null;
  }

  handleMenu(fired) {
    if (!fired.size) return;
    const screen = this.screenEl();
    if (!screen) return;
    if (fired.has(BUTTON.B)) { this.ui.back(); return; }
    if (fired.has(BUTTON.START)) {
      if (this.ui.screen() === 'pause') this.ui.resume();
      else this.press(this.primary(screen));
      return;
    }
    const all = this.buttons(screen);
    const at = all.indexOf(document.activeElement);
    if (fired.has(BUTTON.A)) { this.press(at >= 0 ? all[at] : this.primary(screen)); return; }

    const dir = DPAD_DIR.find(([b]) => fired.has(b))?.[1];
    if (dir === undefined) return;
    if (at < 0) { this.focus(this.primary(screen)); return; }
    const centres = all.map((b) => {
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const next = nearestButton(centres, at, dir);
    if (next >= 0) this.focus(all[next]);
    else if (dir === 0 || dir === 2) {
      // Nothing further that way: on a long screen (HOW TO PLAY), scroll it.
      this.ui.overlay?.scrollBy?.({ top: dir === 0 ? -PAD.SCROLL_PX : PAD.SCROLL_PX, behavior: 'smooth' });
    }
  }

  /** Presses a button, and drops its focus if it took its screen away -- a
   *  focused button owns Space, which in play is the fire key. */
  press(b) {
    if (!b) return;
    b.click();
    if (b.getClientRects().length === 0 || !this.ui.screen()) b.blur();
    document.querySelectorAll('.pad-focus').forEach((el) => { if (el !== document.activeElement) el.classList.remove('pad-focus'); });
  }

  /** Focuses a menu button and marks it: a focus set from script does not
   *  always draw the browser's focus ring. */
  focus(b) {
    if (!b) return;
    document.querySelectorAll('.pad-focus').forEach((el) => el.classList.remove('pad-focus'));
    b.classList.add('pad-focus');
    b.focus({ preventScroll: false });
    b.scrollIntoView?.({ block: 'nearest' });
  }

  // --- feedback and connections ---

  /** A jolt on the pad in use, if it has motors. */
  rumble(strength, ms) {
    const gp = this.getPads().find((p) => p && p.index === this.padIndex);
    const effect = gp?.vibrationActuator?.playEffect?.('dual-rumble', {
      duration: ms, strongMagnitude: strength, weakMagnitude: Math.min(1, strength + 0.2),
    });
    effect?.catch?.(() => {});
  }

  /** A controller went away: mid-level the game pauses rather than leave
   *  Murphy standing under a zonk. */
  disconnected(index) {
    this.ui.toast?.('CONTROLLER DISCONNECTED', true);
    if (index !== this.padIndex) return;
    this.padIndex = null;
    this.edges.reset();
    this.releasePlay();
    if (this.ui.inPlay()) this.ui.pause();
    document.body.classList.remove('pad-active');
  }
}
