// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Jeff Hockema. See LICENSE and NOTICE.md.

/**
 * @fileoverview Touch controls for phones and tablets.
 *
 * Twin floating sticks: a thumb landing on the left half of the screen grabs the
 * movement stick, one landing on the right half grabs the aim stick, and both
 * appear wherever the thumb came down rather than at a fixed spot -- a fixed
 * stick makes the player look down to find it, and a thumb that lands a little
 * off it does nothing at all.
 *
 *   - Move stick: analog. A light push walks slowly, a firmer one walks at full
 *     speed, and pushing it to the rim runs (the touch equivalent of Shift).
 *   - Aim stick: turns the marine. Inside the fire ring it only aims -- shots
 *     wake sleeping monsters and cost ammo, so turning must not mean shooting --
 *     and past the ring it holds the trigger.
 *   - With the aim stick idle the marine faces the way he walks, so the
 *     flashlight lights the corridor he is heading down.
 *
 * Nothing here replaces the keyboard and mouse paths. Aiming and firing are fed
 * through the same `mouse` state the mouse handler writes (an aim point on the
 * canvas, and the button), so Player.updateAiming/handleShooting are untouched;
 * movement is published as `touchMove` and Player.handleMovement only consults
 * it when no movement key is held, so keyboard movement is exactly what it was.
 *
 * The UI only exists in "touch mode" (a class on <body>), which is switched on
 * for a coarse primary pointer or the first real touch, and off again by a
 * mouse click on a device whose primary pointer is fine, so a desktop never
 * sees it.
 *
 * The module has no side effects at import: the stick maths is exported pure so
 * it can be tested under node, and everything that touches the DOM happens in
 * initTouchControls().
 */

import { mouse } from './input-handler.js';
import { ensureAudioAndSynths } from './audio-system.js';
import { toggleFullscreen } from './fullscreen.js';

// =============================================================================
// TUNING
// =============================================================================

/** Stick travel in CSS pixels: how far the thumb moves for full deflection. */
export const STICK_RADIUS = 56;

/**
 * Deflection below which the move stick reads as centred. A resting thumb is
 * never perfectly still, and without this the marine creeps.
 */
export const MOVE_DEAD_ZONE = 0.15;

/** Deflection (of the raw 0..1 travel) at which the move stick reaches full pace. */
export const FULL_WALK_DEFLECTION = 0.7;

/**
 * Slowest walk, as a fraction of walking speed, just outside the dead zone.
 * Starting from zero made the first few pixels of travel feel like nothing
 * happened.
 */
export const MIN_WALK_THROTTLE = 0.35;

/** Deflection below which the aim stick leaves the facing alone. */
export const AIM_DEAD_ZONE = 0.2;

/** Deflection past which the aim stick also holds the trigger. */
export const FIRE_DEFLECTION = 0.6;

/**
 * How far ahead of the marine, in world pixels, a stick puts the aim point.
 *
 * A mouse points AT something; a stick only gives a direction, so the aim point
 * is placed at a fixed distance along it. It must be well past
 * MIN_AIM_CONVERGE_DISTANCE (60) or Player.shoot stops converging the barrel
 * on it, and about a room's depth is where a target usually is.
 */
export const AIM_REACH = 160;

/**
 * Picks a starting zoom for a touch screen.
 *
 * The desktop default of 1.4 is chosen for a monitor; on a phone's 390px side it
 * shows under seven tiles, which is not enough to see a monster before it is on
 * top of you. This aims for roughly nine and a half tiles across the shorter
 * side, never more zoomed in than the desktop default, and snaps to the zoom
 * step so the +/- buttons land on the same values the keyboard does.
 *
 * @param {number} width - Viewport width in CSS pixels
 * @param {number} height - Viewport height in CSS pixels
 * @returns {number} Zoom level
 */
export function touchDefaultZoom(width, height) {
    const shortSide = Math.min(width, height);
    const zoom = Math.min(1.4, Math.max(0.8, shortSide / 380));
    return Math.round(zoom * 10) / 10;
}

// =============================================================================
// STICK MATHS (pure)
// =============================================================================

/**
 * Reads a stick from the thumb's offset relative to where it landed.
 *
 * @param {number} dx - Thumb x minus stick origin x, CSS pixels
 * @param {number} dy - Thumb y minus stick origin y, CSS pixels
 * @param {number} radius - Full-deflection travel, CSS pixels
 * @param {number} deadZone - Raw deflection (0..1) treated as centred
 * @returns {{knobX: number, knobY: number, deflection: number,
 *            magnitude: number, x: number, y: number}}
 *   knobX/knobY: where to draw the knob, clamped to the rim;
 *   deflection: raw travel 0..1;
 *   magnitude: travel rescaled so the dead zone's edge is 0 and the rim is 1 --
 *     rescaled rather than cut off, or the output would jump from 0 straight to
 *     the dead zone's value the moment the thumb crossed it;
 *   x/y: unit direction times magnitude (zero inside the dead zone).
 */
export function readStick(dx, dy, radius, deadZone) {
    const distance = Math.hypot(dx, dy);
    if (distance === 0 || radius <= 0) {
        return { knobX: 0, knobY: 0, deflection: 0, magnitude: 0, x: 0, y: 0 };
    }

    const ux = dx / distance;
    const uy = dy / distance;
    const travel = Math.min(distance, radius);
    const deflection = travel / radius;
    const magnitude = deflection <= deadZone ? 0 : (deflection - deadZone) / (1 - deadZone);

    return {
        knobX: ux * travel,
        knobY: uy * travel,
        deflection,
        magnitude,
        x: ux * magnitude,
        y: uy * magnitude,
    };
}

/**
 * Drags a floating stick's origin along behind a thumb that has gone past the rim.
 *
 * Without this a thumb that over-travels, then eases back, sits in the dead zone
 * or past the centre, and the marine stops or reverses though the thumb never
 * moved back that far. Keeping the thumb on the rim means "back off a little"
 * always means "a little less".
 *
 * @param {number} originX - Current stick origin x
 * @param {number} originY - Current stick origin y
 * @param {number} x - Thumb x
 * @param {number} y - Thumb y
 * @param {number} radius - Full-deflection travel
 * @returns {{x: number, y: number}} The origin to use from now on
 */
export function dragOrigin(originX, originY, x, y, radius) {
    const dx = x - originX;
    const dy = y - originY;
    const distance = Math.hypot(dx, dy);
    if (distance <= radius) return { x: originX, y: originY };

    const excess = (distance - radius) / distance;
    return { x: originX + dx * excess, y: originY + dy * excess };
}

/**
 * Turns the move stick's magnitude into a speed.
 *
 * The stick never runs by itself. It used to, past 90% of its travel -- but the
 * base follows a thumb that overshoots the rim, so an ordinary swipe got there
 * and stayed there, and touch players ran at double speed nearly all the time
 * while keyboard players walked. Now a full push is walking pace, exactly the
 * keyboard without Shift, and running is Always Run in the pause menu
 * (js/settings.js), which scales the whole stick up to running pace.
 *
 * @param {number} magnitude - Rescaled stick magnitude, 0..1
 *   (see readStick; the raw deflection is magnitude mapped back over the dead zone)
 * @returns {{throttle: number}} A fraction of the marine's speed (walking or,
 *   with Always Run, running): 0 when centred, MIN_WALK_THROTTLE..1 when pushed.
 */
export function moveDrive(magnitude) {
    if (!(magnitude > 0)) return { throttle: 0 };

    // Ramps up to full pace, then holds it to the rim. Without the plateau a
    // full-pace walk would need the thumb held exactly at the edge.
    const deflection = MOVE_DEAD_ZONE + magnitude * (1 - MOVE_DEAD_ZONE);
    const span = (deflection - MOVE_DEAD_ZONE) / (FULL_WALK_DEFLECTION - MOVE_DEAD_ZONE);
    return { throttle: MIN_WALK_THROTTLE + (1 - MIN_WALK_THROTTLE) * Math.min(1, span) };
}

/**
 * The canvas point to put the "mouse" at so the player aims along a direction.
 *
 * Player.updateAiming turns mouse.x/y into an angle from the screen centre
 * (where the player always is), dividing by the zoom to get world distance, so
 * the offset is multiplied by the zoom here to keep AIM_REACH in world units.
 *
 * @param {number} ux - Aim direction x (any length; it is normalised)
 * @param {number} uy - Aim direction y
 * @param {number} canvasWidth - Canvas width in CSS pixels
 * @param {number} canvasHeight - Canvas height in CSS pixels
 * @param {number} zoom - Current zoom level
 * @returns {{x: number, y: number}|null} Canvas coordinates, or null for no direction
 */
export function aimPoint(ux, uy, canvasWidth, canvasHeight, zoom) {
    const length = Math.hypot(ux, uy);
    if (length === 0) return null;

    const reach = AIM_REACH * zoom;
    return {
        x: canvasWidth / 2 + (ux / length) * reach,
        y: canvasHeight / 2 + (uy / length) * reach,
    };
}

// =============================================================================
// SHARED STATE
// =============================================================================

/**
 * The move stick, as Player.handleMovement reads it.
 * x/y are the direction scaled by magnitude; magnitude is 0 when the stick is
 * idle or inside its dead zone.
 */
export const touchMove = {
    x: 0,
    y: 0,
    magnitude: 0,
};

/**
 * Centres the move stick.
 */
function clearTouchMove() {
    touchMove.x = 0;
    touchMove.y = 0;
    touchMove.magnitude = 0;
}

// =============================================================================
// DOM CONTROLLER
// =============================================================================

/**
 * Wires the touch UI to the game.
 */
class TouchControls {
    /**
     * @param {Object} controller - The GameController (canvas, zoom, gameState)
     */
    constructor(controller) {
        this.controller = controller;
        this.layer = document.getElementById('touchControls');
        this.hud = document.getElementById('uiContainer');
        this.enabled = false;
        this.zoomChosen = false;

        // Whether the aim stick is what set mouse.down. Releasing the stick must
        // not clear a button a real mouse is holding (a touchscreen laptop can
        // have both).
        this.touchFiring = false;

        // Last direction the marine was turned to by touch, re-applied when the
        // canvas resizes or the zoom changes -- both move the screen centre or
        // the scale that mouse.x/y are measured against.
        this.lastAim = null;

        this.sticks = {
            move: this.makeStick('touchMoveStick', MOVE_DEAD_ZONE),
            aim: this.makeStick('touchAimStick', AIM_DEAD_ZONE),
        };

        this.coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;

        this.bindEvents();
        if (this.coarse?.matches) this.enable();
    }

    /**
     * @param {string} id - Element id of the stick's visual
     * @param {number} deadZone - Its dead zone
     * @returns {Object} Stick record
     */
    makeStick(id, deadZone) {
        const element = document.getElementById(id);
        return {
            element,
            knob: element?.querySelector('.touch-stick-knob') || null,
            deadZone,
            pointerId: null,
            originX: 0,
            originY: 0,
            reading: null,
        };
    }

    // -------------------------------------------------------------- touch mode

    /**
     * Turns the touch UI on. Idempotent.
     */
    enable() {
        if (this.enabled) return;
        this.enabled = true;
        document.body.classList.add('touch-ui');

        // Once only, so a player who zoomed by hand is not overridden on the
        // next rotation.
        if (!this.zoomChosen && this.controller) {
            this.zoomChosen = true;
            this.controller.zoomLevel = touchDefaultZoom(window.innerWidth, window.innerHeight);
        }

        this.layout();
        this.startSync();
    }

    /**
     * Turns the touch UI off (a mouse was used on a fine-pointer device).
     */
    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.releaseAll();
        document.body.classList.remove('touch-ui', 'touch-playing');
    }

    // ------------------------------------------------------------------ events

    /**
     * Attaches every listener the touch UI needs.
     */
    bindEvents() {
        // Touch mode detection. Capture phase so it sees the touch even when a
        // menu button handles it.
        window.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'touch' || e.pointerType === 'pen') {
                this.enable();
            } else if (e.pointerType === 'mouse' && !this.coarse?.matches) {
                this.disable();
            }
        }, { capture: true });

        if (this.layer) {
            this.layer.addEventListener('pointerdown', (e) => this.onPointerDown(e));
            this.layer.addEventListener('pointermove', (e) => this.onPointerMove(e));
            this.layer.addEventListener('pointerup', (e) => this.onPointerUp(e));
            this.layer.addEventListener('pointercancel', (e) => this.onPointerUp(e));
            this.layer.addEventListener('lostpointercapture', (e) => this.onPointerUp(e));

            // touch-action: none already stops scrolling and pinch-zoom on the
            // layer; this backs it up on browsers that are lax about it, and stops
            // the long-press menu.
            this.layer.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
            this.layer.addEventListener('contextmenu', (e) => e.preventDefault());

            this.layer.querySelectorAll('[data-touch-action]').forEach((button) => {
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.runAction(button.dataset.touchAction);
                    button.blur();
                });
            });
        }

        // Safari pinch-zooms the page on its own gesture events even with
        // user-scalable=no, which it has ignored since iOS 10.
        document.addEventListener('gesturestart', (e) => {
            if (this.enabled) e.preventDefault();
        });

        // Tapping a weapon on the HUD selects it. Mouse clicks are left alone so
        // the desktop HUD behaves exactly as it always has.
        document.querySelectorAll('.weapon-icon-display[data-weapon-name]').forEach((icon) => {
            icon.addEventListener('pointerdown', (e) => {
                if (e.pointerType === 'mouse') return;
                e.preventDefault();
                this.selectWeapon(icon.dataset.weaponName);
            });
        });

        // The pause menu (Resume, Enter Code, Fullscreen, Main Menu) is shared
        // with the desktop and lives in js/pause-menu.js.

        // A thumb still down when focus is lost never delivers its pointerup.
        window.addEventListener('blur', () => this.releaseAll());
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.releaseAll();
        });

        // GameController resizes the canvas on window resize. Re-measure after
        // it, and after rotation, where some browsers report the old size on
        // the event itself and only settle a moment later.
        const relayout = () => this.layout();
        window.addEventListener('resize', relayout);
        window.addEventListener('orientationchange', () => {
            setTimeout(() => {
                this.controller?.updateCanvasSize?.();
                this.layout();
            }, 250);
        });
        window.visualViewport?.addEventListener('resize', relayout);
    }

    /**
     * @param {PointerEvent} e
     */
    onPointerDown(e) {
        // The desktop mouse belongs to InputHandler
        if (e.pointerType === 'mouse') return;
        if (e.target.closest?.('.touch-button')) return;

        // Stops the compatibility mouse events (which would move the mouse aim
        // point to the thumb) and the browser's own gesture handling.
        e.preventDefault();
        ensureAudioAndSynths()?.catch?.(() => {});

        if (!this.isPlaying()) return;

        const { x, y } = this.localPoint(e);
        const rect = this.layer.getBoundingClientRect();
        const stick = x < rect.width / 2 ? this.sticks.move : this.sticks.aim;

        // That thumb is already down; a second finger on the same side is ignored
        // rather than stealing the stick mid-move.
        if (stick.pointerId !== null) return;

        stick.pointerId = e.pointerId;
        stick.originX = x;
        stick.originY = y;
        try {
            this.layer.setPointerCapture(e.pointerId);
        } catch {
            // Synthetic or already-released pointers cannot be captured; the
            // layer still receives their events while over it.
        }

        stick.element?.classList.add('active');
        this.updateStick(stick, x, y);
    }

    /**
     * @param {PointerEvent} e
     */
    onPointerMove(e) {
        const stick = this.stickFor(e.pointerId);
        if (!stick) return;
        e.preventDefault();
        const { x, y } = this.localPoint(e);
        this.updateStick(stick, x, y);
    }

    /**
     * @param {PointerEvent} e
     */
    onPointerUp(e) {
        const stick = this.stickFor(e.pointerId);
        if (stick) this.releaseStick(stick);
    }

    /**
     * @param {number} pointerId
     * @returns {Object|null} The stick that pointer is driving
     */
    stickFor(pointerId) {
        if (this.sticks.move.pointerId === pointerId) return this.sticks.move;
        if (this.sticks.aim.pointerId === pointerId) return this.sticks.aim;
        return null;
    }

    /**
     * @param {PointerEvent} e
     * @returns {{x: number, y: number}} Point relative to the touch layer
     */
    localPoint(e) {
        const rect = this.layer.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // ------------------------------------------------------------------ sticks

    /**
     * Moves a stick to follow its thumb, redraws it, and feeds the game.
     *
     * @param {Object} stick
     * @param {number} x - Thumb x, layer-relative
     * @param {number} y - Thumb y, layer-relative
     */
    updateStick(stick, x, y) {
        const origin = dragOrigin(stick.originX, stick.originY, x, y, STICK_RADIUS);
        stick.originX = origin.x;
        stick.originY = origin.y;

        const reading = readStick(x - origin.x, y - origin.y, STICK_RADIUS, stick.deadZone);
        stick.reading = reading;

        if (stick.element) {
            stick.element.style.left = `${origin.x}px`;
            stick.element.style.top = `${origin.y}px`;
        }
        if (stick.knob) {
            stick.knob.style.transform = `translate(${reading.knobX}px, ${reading.knobY}px)`;
        }

        if (stick === this.sticks.move) {
            touchMove.x = reading.x;
            touchMove.y = reading.y;
            touchMove.magnitude = reading.magnitude;
        }

        this.applyAim();
    }

    /**
     * Lets go of a stick and puts its visual back at its resting spot.
     *
     * @param {Object} stick
     */
    releaseStick(stick) {
        const pointerId = stick.pointerId;
        if (pointerId === null) return;

        // Cleared before releasing capture: that fires lostpointercapture, which
        // comes back here and must find the stick already let go.
        stick.pointerId = null;
        try {
            if (this.layer?.hasPointerCapture?.(pointerId)) {
                this.layer.releasePointerCapture(pointerId);
            }
        } catch {
            // Already released
        }

        stick.reading = null;
        stick.element?.classList.remove('active', 'firing');
        if (stick.knob) stick.knob.style.transform = '';

        if (stick === this.sticks.move) clearTouchMove();

        this.applyAim();
        this.placeIdleSticks();
    }

    /**
     * Releases both sticks and the trigger.
     */
    releaseAll() {
        this.releaseStick(this.sticks.move);
        this.releaseStick(this.sticks.aim);
        clearTouchMove();
        if (this.touchFiring) {
            mouse.down = false;
            this.touchFiring = false;
        }
    }

    /**
     * Points the marine and sets the trigger from the two sticks.
     *
     * The aim stick wins when it is pushed; otherwise the marine faces the way
     * the move stick is pushing; with neither, he keeps the last facing.
     */
    applyAim() {
        const aim = this.sticks.aim.reading;
        const aiming = !!aim && aim.magnitude > 0;

        if (aiming) {
            this.lastAim = { x: aim.x, y: aim.y };
        } else if (touchMove.magnitude > 0) {
            this.lastAim = { x: touchMove.x, y: touchMove.y };
        }

        const firing = !!aim && aim.deflection >= FIRE_DEFLECTION;
        this.sticks.aim.element?.classList.toggle('firing', firing);
        if (firing) {
            mouse.down = true;
            this.touchFiring = true;
        } else if (this.touchFiring) {
            mouse.down = false;
            this.touchFiring = false;
        }

        this.pointMouse();
    }

    /**
     * Moves the shared aim point to lastAim, measured from the current canvas
     * centre and zoom.
     */
    pointMouse() {
        const canvas = this.controller?.canvas;
        if (!this.lastAim || !canvas) return;
        const point = aimPoint(this.lastAim.x, this.lastAim.y, canvas.width, canvas.height,
            this.controller.zoomLevel || 1);
        if (point) {
            mouse.x = point.x;
            mouse.y = point.y;
        }
    }

    // ------------------------------------------------------------------ layout

    /**
     * Re-measures the screen: the HUD's height (it wraps to two rows in
     * portrait) decides where the resting sticks sit, and a resized canvas moves
     * the centre the aim point is measured from.
     */
    layout() {
        if (!this.enabled || !this.layer) return;
        const hudHeight = this.hud ? this.hud.getBoundingClientRect().height : 0;
        this.layer.style.setProperty('--hud-h', `${Math.round(hudHeight)}px`);
        this.placeIdleSticks();
        this.pointMouse();
    }

    /**
     * Parks any stick that is not held at its resting spot: low on its own side,
     * clear of the HUD, where a thumb naturally falls. Drawn faint, it is only a
     * hint that the stick exists; touching anywhere on that side still works.
     */
    placeIdleSticks() {
        if (!this.layer) return;
        const rect = this.layer.getBoundingClientRect();
        const hudHeight = this.hud ? this.hud.getBoundingClientRect().height : 0;
        const inset = STICK_RADIUS + 24;
        const x = Math.max(inset, Math.min(rect.width * 0.18, rect.width / 4));
        const y = Math.max(inset, rect.height - hudHeight - inset);

        for (const [name, stick] of Object.entries(this.sticks)) {
            if (stick.pointerId !== null || !stick.element) continue;
            stick.element.style.left = `${name === 'move' ? x : rect.width - x}px`;
            stick.element.style.top = `${y}px`;
        }
    }

    // ----------------------------------------------------------------- buttons

    /**
     * Runs one of the on-screen buttons.
     *
     * @param {string} action - The button's data-touch-action
     */
    runAction(action) {
        const controller = this.controller;
        const gameState = controller?.gameState;

        switch (action) {
            case 'pause':
                // The shared pause menu, which also lets go of the sticks
                controller?.pauseMenu?.pause();
                break;
            case 'fullscreen':
                // Straight from the tap: browsers only grant fullscreen to a
                // user gesture. The button is hidden where it is unsupported.
                toggleFullscreen();
                break;
            case 'map':
                if (gameState) gameState.showMinimap = !gameState.showMinimap;
                break;
            case 'zoom-in':
                controller?.zoomIn();
                this.pointMouse();
                break;
            case 'zoom-out':
                controller?.zoomOut();
                this.pointMouse();
                break;
        }
    }

    /**
     * Selects a weapon by name, if the player is carrying it.
     *
     * @param {string} name - Weapon name, as on the HUD icon's data-weapon-name
     */
    selectWeapon(name) {
        const player = this.controller?.gameState?.player;
        if (!player || !this.isPlaying()) return;
        const index = player.weapons.findIndex(w => w.name === name);
        if (index !== -1 && player.weapons[index].owned && index !== player.currentWeaponIndex) {
            player.switchWeapon(index);
        }
    }

    // -------------------------------------------------------------------- sync

    /**
     * @returns {boolean} Whether a level is being played right now
     */
    isPlaying() {
        const gameState = this.controller?.gameState;
        return !!gameState && gameState.gameRunning && !gameState.gameOver && !!gameState.player;
    }

    /**
     * Keeps the touch UI in step with the game: the sticks and buttons are only
     * shown during play, and a stick held when play stops (death, level end,
     * pause) is released so it cannot carry into the next level the way latched
     * keys once did.
     */
    startSync() {
        if (this.syncing) return;
        this.syncing = true;

        const tick = () => {
            if (!this.enabled) {
                this.syncing = false;
                return;
            }
            const playing = this.isPlaying();
            if (playing !== this.wasPlaying) {
                this.wasPlaying = playing;
                document.body.classList.toggle('touch-playing', playing);
                if (!playing) this.releaseAll();
                else this.layout();
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }
}

/**
 * The live controller, once initTouchControls has run.
 * @type {TouchControls|null}
 */
export let touchControls = null;

/**
 * Sets up the touch UI. Safe to call on any device: nothing is shown unless the
 * device has a coarse pointer or is touched.
 *
 * @param {Object} controller - The GameController
 * @returns {TouchControls}
 */
export function initTouchControls(controller) {
    touchControls = new TouchControls(controller);
    return touchControls;
}
