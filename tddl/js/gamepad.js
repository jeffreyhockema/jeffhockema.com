// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Jeff Hockema. See LICENSE and NOTICE.md.

/**
 * @fileoverview Game controllers: Xbox, PlayStation, Switch Pro, 8BitDo and the
 * rest, over Bluetooth or USB, through the browser's Gamepad API.
 *
 * Laid out as a twin-stick shooter, the way this game plays from above:
 *
 *   Left stick        move (analog: a light push creeps, a full one walks)
 *   LT (hold)         run -- with Always Run on, walk
 *   Right stick       aim; let go and the marine faces the way he walks
 *   RT                fire
 *   LB / RB           previous / next weapon (D-pad left / right too)
 *   D-pad up / down   zoom in / out
 *   Y or Back         minimap on / off
 *   Start             pause (and resume)
 *
 * and in the menus: D-pad or left stick to move between buttons, A to press,
 * B to go back, Start to start or resume; in the instructions, up and down
 * scroll. A controller that drops out mid-level pauses the game, as a console
 * does.
 *
 * Nothing here is new machinery. Movement goes into the touch move stick
 * (touchMove), aim and the trigger into `mouse`, run into `pad.run`, weapons
 * through the mouse wheel's cycling, pause through the pause menu -- so a
 * controller plays by exactly the rules everything else does.
 *
 * The Gamepad API is polled, not evented: buttons are read once per animation
 * frame and turned into presses here. Browsers only report a controller once
 * one of its buttons has been pressed with the page open, and some only on a
 * secure page (https:// or localhost), which matters when the game is opened
 * from another device by its LAN address.
 *
 * @author TDDL Game Team
 */

import { mouse, pad } from './input-handler.js';
import { readStick, aimPoint, touchMove } from './touch-controls.js';
import { cycleWeaponIndex, isActivePlay } from './mouse-wheel.js';
import { pauseMenu } from './pause-menu.js';
import { ensureAudioAndSynths } from './audio-system.js';

// =============================================================================
// TUNING
// =============================================================================

/**
 * Buttons by their index in the browser's "standard" mapping, which every
 * mainstream controller is reported with (Xbox names; a PlayStation pad's
 * Cross is A, Circle B, Square X, Triangle Y; Options is Start).
 */
export const BUTTON = {
    A: 0, B: 1, X: 2, Y: 3,
    LB: 4, RB: 5, LT: 6, RT: 7,
    BACK: 8, START: 9, L3: 10, R3: 11,
    UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

export const PAD = {
    // Sticks drift: a controller at rest commonly reads 0.05-0.15. These are
    // radial, so a diagonal is not harder to reach than a straight line.
    MOVE_DEAD_ZONE: 0.2,
    AIM_DEAD_ZONE: 0.25,

    // An analog trigger counts as pulled past this
    TRIGGER_THRESHOLD: 0.4,

    // The left stick steps through menus once pushed this far
    MENU_STICK_THRESHOLD: 0.6,

    // A held direction in a menu: first repeat after this, then at this rate
    REPEAT_DELAY_MS: 400,
    REPEAT_RATE_MS: 140,

    // How far one step scrolls the instructions
    SCROLL_PX: 140,

    // Rumble when hit: this long, at a strength that grows with the damage
    RUMBLE_MS: 160,
    RUMBLE_FULL_AT: 40,      // health lost in one hit for a full-strength rumble
};

/** Directions that repeat when held in a menu */
const REPEATING = new Set([BUTTON.UP, BUTTON.DOWN, BUTTON.LEFT, BUTTON.RIGHT]);

// =============================================================================
// PURE HELPERS
// =============================================================================

/**
 * Turns a button list into presses: a button fires on the frame it goes
 * down, and the menu directions fire again while held, after a delay, like a
 * held key.
 */
export class ButtonEdges {
    constructor() {
        /** index -> when it went down, and when it last fired */
        this.held = new Map();
    }

    /** Forgets every held button (a controller swapped, or the page hidden) */
    reset() {
        this.held.clear();
    }

    /**
     * @param {boolean[]} pressed - Whether each button is down, by index
     * @param {number} now - Milliseconds
     * @returns {Set<number>} Indexes that fire this frame
     */
    update(pressed, now) {
        const fired = new Set();
        for (let i = 0; i < pressed.length; i++) {
            const was = this.held.get(i);
            if (!pressed[i]) {
                if (was) this.held.delete(i);
                continue;
            }
            if (!was) {
                this.held.set(i, { since: now, last: now });
                fired.add(i);
            } else if (REPEATING.has(i) && now - was.since >= PAD.REPEAT_DELAY_MS &&
                       now - was.last >= PAD.REPEAT_RATE_MS) {
                was.last = now;
                fired.add(i);
            }
        }
        return fired;
    }
}

/**
 * Reads a controller into plain values: which buttons are down (triggers
 * included, by threshold), the menu directions also from the left stick, and
 * both sticks with their dead zones applied.
 *
 * @param {Gamepad} gp - A controller from navigator.getGamepads()
 * @returns {{pressed: boolean[], menuPressed: boolean[], move: Object, aim: Object}}
 *   pressed: each button down; menuPressed: the same with the left stick
 *   standing in for the D-pad; move and aim: readStick() readings of the sticks
 */
export function readPad(gp) {
    const buttons = gp.buttons || [];
    const axes = gp.axes || [];
    const pressed = [];
    for (let i = 0; i < Math.max(buttons.length, 16); i++) {
        const b = buttons[i];
        pressed[i] = !!b && (b.pressed || (b.value ?? 0) > PAD.TRIGGER_THRESHOLD);
    }

    const lx = axes[0] || 0, ly = axes[1] || 0;
    const rx = axes[2] || 0, ry = axes[3] || 0;

    // The left stick doubles as the D-pad for menus: easier on a controller
    // whose D-pad is mushy, and the only option on some that have none.
    const t = PAD.MENU_STICK_THRESHOLD;
    const menuDirs = {
        [BUTTON.UP]: ly < -t, [BUTTON.DOWN]: ly > t,
        [BUTTON.LEFT]: lx < -t, [BUTTON.RIGHT]: lx > t,
    };

    return {
        pressed,
        menuPressed: pressed.map((p, i) => p || !!menuDirs[i]),
        move: readStick(lx, ly, 1, PAD.MOVE_DEAD_ZONE),
        aim: readStick(rx, ry, 1, PAD.AIM_DEAD_ZONE),
    };
}

/**
 * Whether a controller is doing anything at all: a button, or a stick past
 * its dead zone. Used to tell which of several is being played with.
 *
 * @param {Object} reading - From readPad
 * @returns {boolean}
 */
export function isPadBusy(reading) {
    return reading.pressed.some(Boolean) || reading.move.magnitude > 0 || reading.aim.magnitude > 0;
}

/**
 * The next button along when stepping through a menu: wraps at both ends,
 * and from nothing focused, down/right lands on the first and up/left on the
 * last.
 *
 * @param {number} count - Buttons in the menu
 * @param {number} current - Index of the focused one, or -1
 * @param {number} step - +1 or -1
 * @returns {number} The index to focus, or -1 for an empty menu
 */
export function stepFocus(count, current, step) {
    if (count <= 0) return -1;
    if (current < 0 || current >= count) return step > 0 ? 0 : count - 1;
    return (current + step + count) % count;
}

/**
 * The buttons of a menu a controller can move between: shown, enabled, in
 * page order. Text boxes are left out -- a controller has no letters to put
 * in them.
 *
 * @param {Element} overlay - A menu overlay
 * @returns {HTMLElement[]}
 */
export function menuButtons(overlay) {
    const all = [...(overlay?.querySelectorAll?.('button') || [])];
    return all.filter(b => !b.disabled && !b.hidden && isShownElement(b));
}

/**
 * @param {Element} el
 * @returns {boolean} Whether it takes up space on the page
 */
function isShownElement(el) {
    if (typeof el.getClientRects === 'function') return el.getClientRects().length > 0;
    return el.style?.display !== 'none';
}

// =============================================================================
// THE CONTROLLER
// =============================================================================

export class GamepadController {
    /**
     * @param {Object} controller - The GameController (canvas, zoom, gameState)
     * @param {Object} [options]
     * @param {Function} [options.getPads] - Returns the connected controllers
     * @param {Document} [options.doc] - The page
     * @param {Function} [options.now] - Milliseconds
     */
    constructor(controller, {
        getPads = () => (typeof navigator !== 'undefined' && navigator.getGamepads)
            ? [...navigator.getGamepads()] : [],
        doc = (typeof document !== 'undefined' ? document : null),
        now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    } = {}) {
        this.controller = controller;
        this.getPads = getPads;
        this.doc = doc;
        this.now = now;

        this.edges = new ButtonEdges();
        this.padIndex = null;      // The controller being played with

        // What this module is holding down, so it lets go of exactly that and
        // never of a key, a mouse button or a thumb on the glass.
        this.ownsMove = false;
        this.firing = false;
        this.aimOwned = false;     // The marine is facing where the pad said
        this.lastAim = null;

        this.lastHitSerial = null;
        this.lastHealth = null;
        this.audioUnlocked = false;
    }

    /** @returns {Object|null} The live GameState */
    get gameState() {
        return this.controller?.gameState || null;
    }

    // ------------------------------------------------------------------ polling

    /**
     * Reads the controller once and acts on it. Called every animation frame.
     */
    poll() {
        const gp = this.choosePad();
        if (!gp) {
            this.releasePlay();
            return;
        }

        const reading = readPad(gp);
        const now = this.now();
        const busy = isPadBusy(reading);
        if (busy) this.markActive();

        const overlay = this.topOverlay();
        if (overlay) {
            this.releasePlay();
            const fired = this.edges.update(reading.menuPressed, now);
            this.handleMenu(overlay, fired);
            return;
        }

        const fired = this.edges.update(reading.pressed, now);
        if (isActivePlay(this.gameState)) {
            this.handlePlay(gp, reading, fired);
        } else {
            this.releasePlay();
        }
    }

    /**
     * The controller to read: the one already in use, or else the first that
     * is doing something -- a second pad left on the sofa does not steal the
     * game, and picking one up takes it over.
     *
     * @returns {Gamepad|null}
     */
    choosePad() {
        const pads = (this.getPads() || []).filter(p => p && p.connected !== false);
        if (!pads.length) {
            this.padIndex = null;
            return null;
        }

        const current = pads.find(p => p.index === this.padIndex);
        const busy = pads.find(p => p !== current && isPadBusy(readPad(p)));
        const chosen = busy && (!current || !isPadBusy(readPad(current))) ? busy : (current || pads[0]);
        if (chosen.index !== this.padIndex) {
            this.padIndex = chosen.index;
            // Held buttons on the old pad are not held on the new one
            this.edges.reset();
        }
        return chosen;
    }

    /**
     * The controller has been used: the touch sticks step aside (a phone in
     * a controller clip has no thumbs on the glass), and the first press
     * tries to unlock the audio, as a tap or click does.
     */
    markActive() {
        this.doc?.body?.classList?.add('pad-active');
        if (!this.audioUnlocked) {
            this.audioUnlocked = true;
            try { ensureAudioAndSynths(); } catch { /* no audio: play on */ }
        }
    }

    // --------------------------------------------------------------------- play

    /**
     * @param {Gamepad} gp - The controller (for rumble)
     * @param {Object} reading - From readPad
     * @param {Set<number>} fired - Buttons that went down this frame
     */
    handlePlay(gp, reading, fired) {
        const gs = this.gameState;
        const player = gs.player;

        // Move: the touch move stick, so the same analog walk applies
        if (reading.move.magnitude > 0) {
            touchMove.x = reading.move.x;
            touchMove.y = reading.move.y;
            touchMove.magnitude = reading.move.magnitude;
            this.ownsMove = true;
        } else if (this.ownsMove) {
            this.clearMove();
        }

        pad.run = !!reading.pressed[BUTTON.LT];

        // Aim: the right stick, or with it at rest the way he walks
        if (reading.aim.magnitude > 0) {
            this.lastAim = { x: reading.aim.x, y: reading.aim.y };
            this.aimOwned = true;
        } else if (this.aimOwned && reading.move.magnitude > 0 && !this.firing) {
            this.lastAim = { x: reading.move.x, y: reading.move.y };
        }
        // Re-placed every frame while the pad has the aim: a zoom or a resize
        // moves the screen point a direction comes out at.
        if (this.aimOwned) this.applyAim();

        // Fire
        if (reading.pressed[BUTTON.RT]) {
            mouse.down = true;
            this.firing = true;
        } else if (this.firing) {
            mouse.down = false;
            this.firing = false;
        }

        // Weapons
        if (fired.has(BUTTON.RB) || fired.has(BUTTON.RIGHT)) this.cycleWeapon(player, +1);
        if (fired.has(BUTTON.LB) || fired.has(BUTTON.LEFT)) this.cycleWeapon(player, -1);

        // View
        if (fired.has(BUTTON.UP)) this.controller?.zoomIn?.();
        if (fired.has(BUTTON.DOWN)) this.controller?.zoomOut?.();
        if (fired.has(BUTTON.Y) || fired.has(BUTTON.BACK)) gs.showMinimap = !gs.showMinimap;

        // Pause: last, as it ends play for this frame
        if (fired.has(BUTTON.START)) {
            this.releasePlay();
            pauseMenu?.pause();
            return;
        }

        this.rumbleOnHit(gp, player);
    }

    /**
     * @param {Object} player - The Player
     * @param {number} step - +1 next, -1 previous
     */
    cycleWeapon(player, step) {
        const index = cycleWeaponIndex(player.weapons, player.currentWeaponIndex, step);
        if (index !== player.currentWeaponIndex) player.switchWeapon(index);
    }

    /**
     * Puts the shared aim point along lastAim, measured from the current
     * canvas size and zoom -- the touch aim stick's arithmetic.
     */
    applyAim() {
        const canvas = this.controller?.canvas;
        if (!this.lastAim || !canvas) return;
        const point = aimPoint(this.lastAim.x, this.lastAim.y, canvas.width, canvas.height,
                               this.controller.zoomLevel || 1);
        if (point) {
            mouse.x = point.x;
            mouse.y = point.y;
        }
    }

    /**
     * A jolt when the marine is hurt, stronger for a bigger hit. Read off the
     * player rather than hooked into the damage code: the hit counter
     * (Player.hitSerial, kept for the status bar's face) says a hit landed,
     * the health says how hard.
     *
     * @param {Gamepad} gp
     * @param {Object} player
     */
    rumbleOnHit(gp, player) {
        const serial = player.hitSerial ?? 0;
        const health = player.health ?? 0;
        if (this.lastHitSerial !== null && serial !== this.lastHitSerial) {
            const lost = Math.max(0, (this.lastHealth ?? health) - health);
            const strength = Math.min(1, 0.25 + lost / PAD.RUMBLE_FULL_AT);
            const effect = gp.vibrationActuator?.playEffect?.('dual-rumble', {
                duration: PAD.RUMBLE_MS,
                strongMagnitude: strength,
                weakMagnitude: Math.min(1, strength + 0.2),
            });
            effect?.catch?.(() => {});      // A pad without motors refuses; fine
        }
        this.lastHitSerial = serial;
        this.lastHealth = health;
    }

    /**
     * Lets go of whatever the controller is holding: the move stick, the
     * trigger, the run button. Called whenever play stops -- a menu, death,
     * the controller gone -- so nothing carries into what comes next.
     */
    releasePlay() {
        if (this.ownsMove) this.clearMove();
        if (this.firing) {
            mouse.down = false;
            this.firing = false;
        }
        pad.run = false;
    }

    clearMove() {
        touchMove.x = 0;
        touchMove.y = 0;
        touchMove.magnitude = 0;
        this.ownsMove = false;
    }

    /**
     * The mouse moved: it has the aim now, until the right stick takes it back.
     */
    yieldAim() {
        this.aimOwned = false;
    }

    // -------------------------------------------------------------------- menus

    /**
     * The menu on top, if any is up: the instructions over the start screen,
     * then the pause menu, then the start screen, tally or Game Over. The
     * loading screen takes no input.
     *
     * @returns {Element|null}
     */
    topOverlay() {
        const doc = this.doc;
        if (!doc) return null;
        for (const id of ['instructionsOverlay', 'pauseOverlay', 'messageOverlay']) {
            const el = doc.getElementById(id);
            if (el && el.style?.display !== 'none' && isShownElement(el)) return el;
        }
        return null;
    }

    /**
     * @param {Element} overlay - The menu on top
     * @param {Set<number>} fired - Presses this frame (menu directions include the left stick)
     */
    handleMenu(overlay, fired) {
        if (!fired.size) return;

        if (overlay.id === 'instructionsOverlay') {
            const content = overlay.querySelector?.('.modal-content') || overlay;
            if (fired.has(BUTTON.UP)) content.scrollBy?.({ top: -PAD.SCROLL_PX, behavior: 'smooth' });
            if (fired.has(BUTTON.DOWN)) content.scrollBy?.({ top: PAD.SCROLL_PX, behavior: 'smooth' });
            if (fired.has(BUTTON.A) || fired.has(BUTTON.B) || fired.has(BUTTON.START)) {
                this.doc.getElementById('closeInstructionsButton')?.click();
            }
            return;
        }

        const isPause = overlay.id === 'pauseOverlay';

        if (fired.has(BUTTON.B)) {
            if (isPause) {
                if (pauseMenu?.codeForm && pauseMenu.codeForm.style.display !== 'none') {
                    pauseMenu.closeCodeEntry();
                } else {
                    pauseMenu?.resume();
                }
            }
            return;
        }

        if (fired.has(BUTTON.START)) {
            if (isPause) pauseMenu?.resume();
            else this.primaryButton(overlay)?.click();
            return;
        }

        const buttons = menuButtons(overlay);
        const focused = buttons.indexOf(this.doc.activeElement);

        if (fired.has(BUTTON.A)) {
            // Nothing focused yet: A is the screen's main button (Start Game,
            // Continue, Resume), as Enter is.
            (focused >= 0 ? buttons[focused] : this.primaryButton(overlay))?.click();
            return;
        }

        let step = 0;
        if (fired.has(BUTTON.DOWN) || fired.has(BUTTON.RIGHT)) step = 1;
        if (fired.has(BUTTON.UP) || fired.has(BUTTON.LEFT)) step = -1;
        if (step) this.focusButton(buttons, stepFocus(buttons.length, focused, step));
    }

    /**
     * The screen's main button: the first shown one that is not secondary.
     *
     * @param {Element} overlay
     * @returns {HTMLElement|null}
     */
    primaryButton(overlay) {
        const buttons = menuButtons(overlay);
        return buttons.find(b => b.classList?.contains('game-button') && !b.classList.contains('secondary'))
            || buttons[0] || null;
    }

    /**
     * Focuses a menu button and marks it, since a focus set from script does
     * not always draw the browser's focus ring.
     *
     * @param {HTMLElement[]} buttons
     * @param {number} index
     */
    focusButton(buttons, index) {
        const button = buttons[index];
        if (!button) return;
        this.doc.querySelectorAll?.('.pad-focus').forEach(el => el.classList.remove('pad-focus'));
        button.classList?.add('pad-focus');
        button.focus?.({ preventScroll: false });
    }

    // ------------------------------------------------------------ connections

    /**
     * A controller went away. Mid-level the game pauses, as a console's does,
     * rather than leave the marine standing in a firefight.
     *
     * @param {number} index - Gamepad.index of the one that left
     */
    disconnected(index) {
        if (index !== this.padIndex) return;
        this.padIndex = null;
        this.edges.reset();
        this.releasePlay();
        if (isActivePlay(this.gameState)) pauseMenu?.pause();
    }
}

// =============================================================================
// SET-UP
// =============================================================================

export let gamepad = null;

/**
 * Starts listening for controllers. The polling loop only runs once one has
 * shown up, so a page without one pays nothing.
 *
 * @param {Object} controller - The GameController
 * @returns {GamepadController|null} Null where the browser has no Gamepad API
 */
export function initGamepad(controller) {
    if (typeof window === 'undefined' || typeof navigator === 'undefined' ||
        typeof navigator.getGamepads !== 'function') {
        return null;
    }

    gamepad = new GamepadController(controller);
    let polling = false;
    const startPolling = () => {
        if (polling) return;
        polling = true;
        const tick = () => {
            try {
                gamepad.poll();
            } catch (error) {
                console.error('Gamepad: poll failed:', error);
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };

    window.addEventListener('gamepadconnected', (e) => {
        startPolling();
        controller?.gameState?.postMessage?.('Controller connected');
        console.log(`Gamepad: ${e.gamepad?.id} connected`);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
        gamepad.disconnected(e.gamepad?.index);
        controller?.gameState?.postMessage?.('Controller disconnected');
    });

    // A controller already connected before the page loaded may not announce
    // itself until pressed; one that is already listed can start at once.
    try {
        if ([...navigator.getGamepads()].some(Boolean)) startPolling();
    } catch { /* blocked on an insecure page */ }

    // The mouse takes the aim back the moment it moves; a thumb on the glass
    // brings the touch sticks back.
    window.addEventListener('mousemove', () => gamepad.yieldAim());
    window.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch') document.body.classList.remove('pad-active');
    }, { capture: true });

    return gamepad;
}
