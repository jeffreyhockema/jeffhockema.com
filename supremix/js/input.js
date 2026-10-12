// Keyboard input, and the shared state touch and controllers write into.
//
// Directions are kept as a recency stack so that rolling from one arrow to the
// next never drops a frame -- the newest key held always wins, which is what
// makes tight corridors feel fair.

import { UP, RIGHT, DOWN, LEFT } from './engine.js';

const KEY_DIR = {
  ArrowUp: UP, ArrowRight: RIGHT, ArrowDown: DOWN, ArrowLeft: LEFT,
  KeyW: UP, KeyD: RIGHT, KeyS: DOWN, KeyA: LEFT,
};

export class Input {
  constructor() {
    this.held = [];
    this.tapDir = -1;   // a press that came and went inside one simulation step
    this.fresh = false; // a direction pressed since the last step (lets an idle Murphy start at once)
    this.keyB = false;
    this.touchPlant = false;
    this.space = false;
    this.spaceUsedForGrab = false;
    this.plantQueued = false;
    this.commands = new Map();
    this.touchDir = -1;
    this.touchGrab = false;
    this.padDir = -1;            // a game controller (js/gamepad.js)
    this.padFire = false;
    this.padFireUsedForGrab = false;
    this.padPlant = false;
    this.enabled = true;   // false while a menu owns the keyboard
    this.bind();
  }

  on(key, fn) {
    this.commands.set(key, fn);
  }

  /**
   * True when a key belongs to whatever the user is focused on rather than to
   * the game.
   *
   * Text fields take everything. Buttons take only Space and Enter, which is
   * how they are activated: swallowing arrows there too would freeze Murphy
   * for anyone who clicked RESTART and left it focused.
   */
  static claimedByFocus(e) {
    const el = e.target;
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return tag === 'BUTTON' && (e.code === 'Space' || e.code === 'Enter');
  }

  bind() {
    window.addEventListener('keydown', (e) => {
      // Never steal Space/Enter from a focused button: that is how a keyboard
      // user presses PLAY. Our own single-letter commands still work anywhere.
      if (Input.claimedByFocus(e) && !this.commands.has(e.code)) return;
      if (e.repeat) {
        if (KEY_DIR[e.code] !== undefined) e.preventDefault();
        return;
      }
      const cmd = this.commands.get(e.code);
      if (cmd) { e.preventDefault(); cmd(); return; }

      const d = KEY_DIR[e.code];
      if (d !== undefined) {
        e.preventDefault();
        if (!this.held.includes(d)) this.held.push(d);
        this.tapDir = d;
        this.fresh = true;
        if (this.space) this.spaceUsedForGrab = true;
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        this.space = true;
        this.spaceUsedForGrab = this.held.length > 0;
        return;
      }
      if (e.code === 'KeyB') {           // dedicated plant, for anyone who
        e.preventDefault();               // finds the space-bar overload fiddly
        this.keyB = true;
      }
    });

    window.addEventListener('keyup', (e) => {
      if (Input.claimedByFocus(e)) return;
      const d = KEY_DIR[e.code];
      if (d !== undefined) {
        const at = this.held.indexOf(d);
        if (at >= 0) this.held.splice(at, 1);
        return;
      }
      if (e.code === 'Space') {
        this.space = false;
        this.spaceUsedForGrab = false;
      }
      if (e.code === 'KeyB') this.keyB = false;
    });

    // Never leave a key stuck down after an alt-tab.
    window.addEventListener('blur', () => this.clear());
  }

  clear() {
    this.held.length = 0;
    this.tapDir = -1;
    this.plantQueued = false;   // a charge queued before a pause is not wanted after it
    this.fresh = false;
    this.keyB = false;
    this.touchPlant = false;
    this.space = false;
    this.spaceUsedForGrab = false;
    this.touchDir = -1;
    this.touchGrab = false;
    this.padDir = -1;
    this.padFire = false;
    this.padFireUsedForGrab = false;
    this.padPlant = false;
  }

  // The on-screen controls (js/touch.js) write touchDir, touchGrab and
  // touchPlant, and a controller (js/gamepad.js) padDir, padFire and padPlant;
  // both set tapDir and fresh on a new direction, as keys do.

  /**
   * Snapshot for one simulation step.
   *
   * `plant` is held, not tapped: as in the original, a red disk goes down only
   * after fire has been held, with no direction, for a moment (the engine
   * counts it out), and letting go early plants nothing.
   *
   * A key tapped and released between two steps would otherwise vanish, so a
   * buffered tap stands in when nothing is currently held. That single frame of
   * grace is the difference between crisp and unresponsive.
   */
  read() {
    this.fresh = false;
    if (!this.enabled) { this.plantQueued = false; return { dir: -1, grab: false, plant: false }; }
    const plant = (this.space && !this.spaceUsedForGrab) || this.keyB || this.touchPlant
      || (this.padFire && !this.padFireUsedForGrab) || this.padPlant;
    this.plantQueued = false;

    let dir;
    if (this.held.length) {
      dir = this.held[this.held.length - 1];
      this.tapDir = -1;
    } else if (this.touchDir >= 0) {
      dir = this.touchDir;
      this.tapDir = -1;
    } else if (this.padDir >= 0) {
      dir = this.padDir;
      this.tapDir = -1;
    } else {
      dir = this.tapDir;
      this.tapDir = -1;
    }

    return {
      dir,
      grab: (this.space || this.touchGrab || this.padFire) && dir >= 0,
      plant: plant && dir < 0,
    };
  }
}
