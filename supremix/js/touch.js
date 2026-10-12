// On-screen controls for phones and tablets.
//
// A floating thumbstick and two hold buttons, drawn over the board only while a
// level is being played.
//
//   - The stick appears wherever a thumb lands on the left of the board rather
//     than at a fixed spot: a fixed pad makes you look down to find it, and a
//     thumb that lands a little off it does nothing at all. Its base follows a
//     thumb that over-travels, so easing back always means "less", never a
//     reversal. (The approach, and the stick maths, come from TDDL's controls.)
//   - Supaplex moves on a grid, so the stick reads as one of four directions.
//     Near a diagonal it keeps the direction it already has until the other
//     axis clearly wins, so a thumb rolling round a corner does not flicker
//     between the two.
//   - GRAB and DISK are held, like Space: hold GRAB with the stick pushed to
//     reach without moving; hold DISK, standing still, to plant a red disk.
//
// Every gesture over the layer is ours -- no scrolling, no pinch or double-tap
// zoom, no long-press callout or text selection -- which is what used to zoom
// the page in on a button's label when it was held.
//
// The module writes the same fields the keyboard does (`touchDir`, `touchGrab`,
// `touchPlant`, `tapDir`, `fresh`) on the shared Input, so the game reads touch
// exactly as it reads keys. The stick maths is exported pure for tests.

/** Stick travel in CSS pixels for full deflection. */
export const STICK_RADIUS = 52;
/** Deflection (0..1) below which the stick reads as centred. */
export const DEAD_ZONE = 0.28;
/** How far the other axis must lead before a held direction switches to it. */
export const AXIS_HYSTERESIS = 1.25;

/**
 * Reads a stick from the thumb's offset from where it landed: where to draw
 * the knob (clamped to the rim), and the deflection 0..1.
 */
export function readStick(dx, dy, radius) {
  const distance = Math.hypot(dx, dy);
  if (distance === 0 || radius <= 0) return { knobX: 0, knobY: 0, deflection: 0 };
  const travel = Math.min(distance, radius);
  return { knobX: (dx / distance) * travel, knobY: (dy / distance) * travel, deflection: travel / radius };
}

/** Drags the stick's origin behind a thumb that has gone past the rim. */
export function dragOrigin(ox, oy, x, y, radius) {
  const dx = x - ox, dy = y - oy, distance = Math.hypot(dx, dy);
  if (distance <= radius) return { x: ox, y: oy };
  const excess = (distance - radius) / distance;
  return { x: ox + dx * excess, y: oy + dy * excess };
}

/**
 * One of the four directions (0 up, 1 right, 2 down, 3 left), or -1 when
 * centred. `held` is the direction currently in force, kept until the other
 * axis leads it by AXIS_HYSTERESIS.
 */
export function stickDirection(dx, dy, deflection, held = -1) {
  if (deflection < DEAD_ZONE) return -1;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const horizontal = dx > 0 ? 1 : 3, vertical = dy > 0 ? 2 : 0;
  if (held === horizontal && ax * AXIS_HYSTERESIS >= ay) return horizontal;
  if (held === vertical && ay * AXIS_HYSTERESIS >= ax) return vertical;
  return ax >= ay ? horizontal : vertical;
}

export class TouchControls {
  /**
   * @param {HTMLElement} layer  the controls layer, over the board
   * @param {object} input       the game's Input
   */
  constructor(layer, input) {
    this.layer = layer;
    this.input = input;
    this.stickEl = layer.querySelector('.tstick');
    this.knob = layer.querySelector('.tstick-knob');
    this.arrows = [...layer.querySelectorAll('.tstick-arrow')];
    this.buttons = [...layer.querySelectorAll('[data-hold]')];
    this.stick = { id: null, ox: 0, oy: 0, dir: -1 };
    this.held = new Map();   // pointerId -> button element
    this.active = false;
    this.enabled = false;
    this.bind();
  }

  /** Turns the touch UI on for this device. */
  enable() {
    if (this.enabled) return;
    this.enabled = true;
    document.body.classList.add('touch-ui');
    this.park();
  }

  /** Shown only while a level is being played; letting go of everything when it stops. */
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    this.layer.classList.toggle('is-active', on);
    if (!on) this.releaseAll();
    else this.park();
  }

  bind() {
    const L = this.layer;
    // A real touch anywhere turns touch mode on; so does a coarse primary pointer.
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') this.enable();
    }, { capture: true });
    if (matchMedia('(pointer: coarse)').matches) this.enable();

    L.addEventListener('pointerdown', (e) => this.down(e));
    L.addEventListener('pointermove', (e) => this.move(e));
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      L.addEventListener(ev, (e) => this.up(e));
    }
    // touch-action: none does most of this; these back it up where browsers are
    // lax, and stop the long-press menu and iOS's own pinch gesture.
    L.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    L.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    L.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('gesturestart', (e) => { if (this.enabled) e.preventDefault(); });
    document.addEventListener('dblclick', (e) => { if (this.enabled) e.preventDefault(); }, { passive: false });

    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    window.addEventListener('resize', () => this.park());
  }

  local(e) {
    const r = this.layer.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  }

  down(e) {
    if (e.pointerType === 'mouse' || !this.active) return;
    e.preventDefault();
    const button = e.target.closest?.('[data-hold]');
    try { this.layer.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    if (button) {
      this.held.set(e.pointerId, button);
      this.syncButtons();
      return;
    }
    const p = this.local(e);
    if (this.stick.id !== null || p.x > p.w * 0.62) return;   // the right is for the buttons
    this.stick.id = e.pointerId;
    this.stick.ox = p.x;
    this.stick.oy = p.y;
    this.stickEl.classList.add('is-held');
    this.drive(p.x, p.y);
  }

  move(e) {
    if (e.pointerId !== this.stick.id) return;
    e.preventDefault();
    const p = this.local(e);
    this.drive(p.x, p.y);
  }

  up(e) {
    if (this.held.has(e.pointerId)) {
      this.held.delete(e.pointerId);
      this.syncButtons();
    }
    if (e.pointerId === this.stick.id) this.releaseStick();
  }

  /** Moves the stick to follow its thumb, redraws it, and sets the direction. */
  drive(x, y) {
    const s = this.stick;
    const o = dragOrigin(s.ox, s.oy, x, y, STICK_RADIUS);
    s.ox = o.x; s.oy = o.y;
    const r = readStick(x - o.x, y - o.y, STICK_RADIUS);
    const dir = stickDirection(x - o.x, y - o.y, r.deflection, s.dir);
    this.stickEl.style.transform = `translate(${o.x}px, ${o.y}px)`;
    this.knob.style.transform = `translate(${r.knobX}px, ${r.knobY}px)`;
    if (dir !== s.dir) {
      s.dir = dir;
      this.input.touchDir = dir;
      if (dir >= 0) { this.input.tapDir = dir; this.input.fresh = true; }
      this.arrows.forEach((a) => a.classList.toggle('is-on', Number(a.dataset.dir) === dir));
    }
  }

  releaseStick() {
    const id = this.stick.id;
    this.stick.id = null;
    this.stick.dir = -1;
    this.input.touchDir = -1;
    try { if (id !== null && this.layer.hasPointerCapture?.(id)) this.layer.releasePointerCapture(id); } catch { /* gone */ }
    this.stickEl.classList.remove('is-held');
    this.knob.style.transform = '';
    this.arrows.forEach((a) => a.classList.remove('is-on'));
    this.park();
  }

  syncButtons() {
    const down = new Set(this.held.values());
    for (const b of this.buttons) b.classList.toggle('is-down', down.has(b));
    this.input.touchGrab = [...down].some((b) => b.dataset.hold === 'grab');
    this.input.touchPlant = [...down].some((b) => b.dataset.hold === 'plant');
  }

  releaseAll() {
    if (this.stick.id !== null) this.releaseStick();
    this.held.clear();
    this.syncButtons();
  }

  /** The idle stick rests, faint, where a left thumb naturally falls. */
  park() {
    if (this.stick.id !== null || !this.stickEl) return;
    const r = this.layer.getBoundingClientRect();
    const inset = STICK_RADIUS + 28;
    const x = Math.max(inset, Math.min(r.width * 0.2, 150));
    const y = Math.max(inset, r.height - inset);
    this.stickEl.style.transform = `translate(${x}px, ${y}px)`;
  }
}
