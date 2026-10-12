// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Jeff Hockema. See LICENSE and NOTICE.md.

/**
 * @fileoverview Input Handling System Module
 * 
 * This module manages all user input for the top-down Doom-like game, including
 * keyboard controls, mouse input, and input state management.
 * 
 * Key Features:
 * - Keyboard state tracking with proper key press/release handling
 * - Mouse position and click detection
 * - Weapon switching controls (1-7 keys, mouse wheel)
 * - Ctrl+wheel (and trackpad pinch) zoom
 * - Movement controls (WASD/Arrow keys, Shift to run)
 * - Doom's typed cheat codes, fed to js/cheats.js
 * - Esc, handed to the pause menu (js/pause-menu.js)
 * - Input validation and sanitization
 * 
 * @author Game Development Team
 * @version 1.0.0
 */

import { ensureAudioAndSynths } from './audio-system.js';
import { CheatMatcher, applyCheat } from './cheats.js';
import {
    WHEEL, WheelAccumulator, wheelPixels, cycleWeaponIndex, isActivePlay
} from './mouse-wheel.js';

/**
 * Number keys to weapons, and the debounce flag each one latches.
 *
 * Both the switcher and the key-up reset read this, so a weapon slot cannot be
 * added to one and forgotten in the other -- which is exactly how key 7 ended
 * up selecting the BFG but never clearing its flag, killing the hotkey after a
 * single press.
 */
const WEAPON_HOTKEYS = {
    '1': { name: 'Knife', flag: 'weapon_1_processed' },
    '2': { name: 'Pistol', flag: 'weapon_2_processed' },
    '3': { name: 'Shotgun', flag: 'weapon_3_processed' },
    '4': { name: 'Rifle', flag: 'weapon_4_processed' },
    '5': { name: 'Rocket Launcher', flag: 'weapon_5_processed' },
    '6': { name: 'Plasma Gun', flag: 'weapon_6_processed' },
    '7': { name: 'BFG', flag: 'weapon_7_processed' }
};

/**
 * @param {EventTarget|null} target - Where a key event landed
 * @returns {boolean} Whether it is somewhere the player is typing text
 */
function isTextField(target) {
    const tag = target?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || !!target?.isContentEditable;
}

/**
 * Global input state object containing all current input states
 */
export const keys = {
    // Movement keys
    'ArrowUp': false,
    'ArrowDown': false,
    'ArrowLeft': false,
    'ArrowRight': false,
    'w': false,
    'a': false,
    's': false,
    'd': false,

    // Run modifier. Matched on event.key, which is "Shift" for either shift
    // key, so it is spelled the way the browser spells it.
    'Shift': false,

    // Weapon selection keys
    '1': false,
    '2': false,
    '3': false,
    '4': false,
    '5': false,
    '6': false,

    // View toggles
    'm': false,

    // Input processing flags to prevent repeat actions
    'm_toggle_processed': false,
    'f3_toggle_processed': false,
    'weapon_1_processed': false,
    'weapon_2_processed': false,
    'weapon_3_processed': false,
    'weapon_4_processed': false,
    'weapon_5_processed': false,
    'weapon_6_processed': false
};

/**
 * Mouse input state object
 */
export const mouse = {
    x: 0,
    y: 0,
    down: false
};

/**
 * What a game controller holds that has no keyboard or mouse equivalent to
 * write into (js/gamepad.js). Movement, aim and the trigger go through the
 * touch move stick and `mouse`, as the touch controls do; running is the one
 * thing left, and it cannot be `keys.Shift`, which the keyboard's own keyup
 * would clear under a thumb still holding the controller's run button.
 */
export const pad = {
    run: false,
};

/**
 * Input handler class that manages all user input events and state
 */
export class InputHandler {
    /**
     * Initialize input handler with canvas reference for mouse events
     * @param {HTMLCanvasElement} canvas - Game canvas element
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.gameState = null;
        // Doom's cheat codes are typed into the game itself. Single-letter
        // debug keys used to live here, and would have gone off halfway
        // through typing any code; the codes replace them.
        this.cheats = new CheatMatcher();
        // The wheel's travel is summed separately for weapons and for zoom:
        // they want different step sizes, and a few pixels left over from
        // scrolling weapons must not count towards a zoom step or vice versa.
        this.weaponWheel = new WheelAccumulator(WHEEL.WEAPON_THRESHOLD_PX, WHEEL.WEAPON_COOLDOWN_MS);
        this.zoomWheel = new WheelAccumulator(WHEEL.ZOOM_THRESHOLD_PX);

        // What Esc does, set by the pause menu (js/pause-menu.js), which gets
        // the key event and returns true if it used it. A callback rather than
        // an import, because the pause menu imports this module.
        this.onEscape = null;

        this._ac = new AbortController();
        this.setupEventListeners();
    }

    /**
     * Set reference to game state for input processing
     * @param {Object} gameState - Current game state object
     */
    setGameState(gameState) {
        this.gameState = gameState;
    }

    /**
     * Set up all input event listeners
     */
    setupEventListeners() {
        const opts = { signal: this._ac.signal };

        // Keyboard event listeners
        window.addEventListener('keydown', (e) => this.handleKeyDown(e), opts);
        window.addEventListener('keyup', (e) => this.handleKeyUp(e), opts);

        // Mouse event listeners.
        // mousedown stays on the canvas so clicks on the HUD/menus don't fire the weapon,
        // but mousemove and mouseup MUST be on the window: otherwise aiming freezes when the
        // cursor crosses the HUD, and releasing the button outside the canvas latches
        // mouse.down to true, leaving the player firing forever.
        window.addEventListener('mousemove', (e) => this.handleMouseMove(e), opts);
        this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e), opts);
        window.addEventListener('mouseup', (e) => this.handleMouseUp(e), opts);
        this.canvas.addEventListener('contextmenu', (e) => this.handleContextMenu(e), opts);

        // The wheel listens on the game container -- the canvas and the HUD
        // laid over its foot -- and never on the window, so the menus, which
        // are overlays outside it, keep scrolling (the Instructions are long)
        // and Ctrl+wheel over them stays the browser's page zoom. It must not
        // be passive: Ctrl+wheel has to preventDefault or the browser zooms the
        // whole page along with the game.
        const wheelSurface = this.canvas.parentElement || this.canvas;
        wheelSurface.addEventListener('wheel', (e) => this.handleWheel(e), { ...opts, passive: false });

        // Losing focus (alt-tab, switching tabs) never delivers keyup, which would otherwise
        // leave movement keys stuck down and the player sliding into a wall on return.
        window.addEventListener('blur', () => this.resetInputState(), opts);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.resetInputState();
        }, opts);
    }

    /**
     * Handle keydown events for continuous input (movement) and discrete actions
     * @param {KeyboardEvent} event - Keyboard event object
     */
    handleKeyDown(event) {
        const keyName = event.key.toLowerCase();

        // Esc is the pause menu's, wherever focus is -- including in its own
        // code box, where Esc closes the box -- so it is handed over before the
        // text-field check below, and goes no further.
        if (event.key === 'Escape') {
            this.handleEscape(event);
            return;
        }

        // Typing into a text box (the phone's cheat code entry) is not playing:
        // "w" there must not walk, nor "-" zoom the view out.
        if (isTextField(event.target)) return;

        // F3 opens a find bar in some browsers, which would steal the key and the
        // focus with it.
        if (keyName === 'f3') event.preventDefault();

        // Update key state for continuous inputs
        if (keys.hasOwnProperty(event.key)) {
            keys[event.key] = true;
        } else if (keys.hasOwnProperty(keyName)) {
            keys[keyName] = true;
        }

        // Zoom controls work whenever the controller exists, including while paused
        this.handleZoomInput(event.key);

        // Handle game-specific inputs only when game is running
        if (this.gameState && this.gameState.gameRunning && this.gameState.player) {
            const claimed = this.handleCheatInput(event);
            this.handleGameplayInput(keyName, claimed);
        }
    }

    /**
     * Hands Esc to the pause menu: pause in play, resume when paused. The
     * browser's own use of Esc (leaving fullscreen) is left alone, as is
     * everything Esc means on the other screens; see PauseMenu.handleEscape.
     *
     * @param {KeyboardEvent} event - Keyboard event object
     */
    handleEscape(event) {
        if (typeof this.onEscape !== 'function') return;
        if (this.onEscape(event)) event.preventDefault?.();
    }

    /**
     * Feeds a key to the cheat matcher and carries out any code it completes.
     *
     * Held keys repeat, and a repeat is not typing: holding "d" to strafe
     * after a stray "i" must not walk the matcher down "iddd...". Chords with
     * Ctrl, Alt or Meta are the browser's, not the player's.
     *
     * @param {KeyboardEvent} event - Keyboard event object
     * @returns {boolean} True if the key continued a code and should do nothing else
     */
    handleCheatInput(event) {
        if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return false;

        const { consumed, cheat } = this.cheats.feed(event.key);
        if (cheat) applyCheat(cheat, this.gameState);
        return consumed;
    }

    /**
     * Handles view zoom keys ("-"/"_" to zoom out, "="/"+" to zoom in).
     * GameController.zoomIn/zoomOut existed but were never bound to any key,
     * so the zoom controls listed in the instructions did nothing.
     *
     * @param {string} key - Raw event.key value (not lowercased; "+" matters)
     */
    handleZoomInput(key) {
        const controller = window.gameController;
        if (!controller) return;

        if (key === '-' || key === '_') {
            controller.zoomOut();
        } else if (key === '=' || key === '+') {
            controller.zoomIn();
        }
    }

    /**
     * Mouse wheel: Ctrl+wheel zooms, the plain wheel cycles weapons.
     *
     * Wheel up is the previous weapon and down the next, as in GZDoom; up
     * with Ctrl zooms in, as in a browser. Chrome reports a trackpad pinch as
     * Ctrl+wheel, so pinching zooms too -- the zoom step is small enough for
     * its few-pixel deltas to move the view smoothly.
     *
     * Zoom works whenever the view is on screen, paused included, exactly as
     * the - and = keys do. Weapons change only in active play.
     *
     * @param {WheelEvent} event - Wheel event from the game container
     */
    handleWheel(event) {
        // Anything overlay-like that ends up inside the container is a menu,
        // and a menu's wheel is its own: leave the event entirely alone.
        if (event.target?.closest?.('.overlay')) return;

        // The game surface itself never scrolls, so the wheel is always the
        // game's here. Without this, Ctrl+wheel would zoom the page as well.
        event.preventDefault();

        const delta = wheelPixels(event);
        const now = event.timeStamp;

        if (event.ctrlKey) {
            // Zoom input does not count towards a weapon change, and leftover
            // weapon travel must not fire the moment Ctrl is let go.
            this.weaponWheel.reset();
            const controller = window.gameController;
            if (!controller) return;

            const step = this.zoomWheel.feed(delta, now);
            if (step < 0) controller.zoomIn();
            else if (step > 0) controller.zoomOut();
            return;
        }

        this.zoomWheel.reset();
        if (!isActivePlay(this.gameState)) {
            // Travel built up on a menu-less pause or the death beat must not
            // carry into play and switch the moment it resumes.
            this.weaponWheel.reset();
            return;
        }

        const step = this.weaponWheel.feed(delta, now);
        if (step === 0) return;

        const player = this.gameState.player;
        const target = cycleWeaponIndex(player.weapons, player.currentWeaponIndex, step);
        if (target !== player.currentWeaponIndex) player.switchWeapon(target);
    }

    /**
     * Handle keyup events to reset input states
     * @param {KeyboardEvent} event - Keyboard event object
     */
    handleKeyUp(event) {
        const keyName = event.key.toLowerCase();

        // Reset key state
        if (keys.hasOwnProperty(event.key)) {
            keys[event.key] = false;
        } else if (keys.hasOwnProperty(keyName)) {
            keys[keyName] = false;
        }

        // Reset processing flags for discrete actions
        this.resetProcessingFlags(keyName);
    }

    /**
     * Handle gameplay-specific input actions (view toggles, weapon switching)
     *
     * A key that a cheat code has claimed does neither: the digits of IDCLEV
     * must not change weapon on the way, nor the "m" of IDMYPOS hide the
     * minimap. Movement is not held back -- it is held state, not an action,
     * and the letters of a code steering the marine about for a moment is what
     * typing one in Doom always did.
     *
     * @param {string} keyName - Normalized key name (lowercase)
     * @param {boolean} [claimed] - The key belongs to a cheat code in progress
     */
    handleGameplayInput(keyName, claimed = false) {
        if (claimed) return;

        const player = this.gameState.player;

        // Handle display toggles
        this.handleViewToggles(keyName);

        // Handle weapon switching
        this.handleWeaponSwitching(keyName, player);
    }

    /**
     * Process keys that change what is displayed rather than what happens.
     *
     * These are ordinary controls a player is meant to use, and the
     * instructions list them as such.
     *
     * @param {string} keyName - Key that was pressed
     */
    handleViewToggles(keyName) {
        if (keyName === 'm') {
            if (keys.m_toggle_processed) return;
            keys.m_toggle_processed = true;
            this.gameState.showMinimap = !this.gameState.showMinimap;
            console.log(`Minimap ${this.gameState.showMinimap ? 'shown' : 'hidden'}`);
            return;
        }

        if (keyName === 'f3') {
            if (keys.f3_toggle_processed) return;
            keys.f3_toggle_processed = true;
            this.gameState.showPerf = !this.gameState.showPerf;
            console.log(`Performance panel ${this.gameState.showPerf ? 'shown' : 'hidden'}`);
        }
    }

    /**
     * Handle weapon switching input (keys 1-7)
     * @param {string} keyName - Key that was pressed
     * @param {Object} player - Player object reference
     */
    handleWeaponSwitching(keyName, player) {
        const weaponInfo = WEAPON_HOTKEYS[keyName];
        if (weaponInfo && !keys[weaponInfo.flag]) {
            keys[weaponInfo.flag] = true;

            const weaponIndex = player.weapons.findIndex(w => w.name === weaponInfo.name);

            if (weaponIndex !== -1 && player.weapons[weaponIndex].owned) {
                player.switchWeapon(weaponIndex);
            } else {
                console.log(`${weaponInfo.name} not available`);
            }
        }
    }

    /**
     * Reset processing flags when keys are released
     * @param {string} keyName - Key that was released
     */
    resetProcessingFlags(keyName) {
        const flagMap = {
            'm': 'm_toggle_processed',
            'f3': 'f3_toggle_processed',
            // Derived from the same table the switcher uses, so a new weapon
            // slot can never be added to one and forgotten in the other. It was:
            // key 7 selected the BFG but had no reset entry, so its debounce flag
            // latched on the first press and the hotkey died for the session.
            ...Object.fromEntries(
                Object.entries(WEAPON_HOTKEYS).map(([key, { flag }]) => [key, flag])
            )
        };

        if (flagMap[keyName]) {
            keys[flagMap[keyName]] = false;
        }
    }

    /**
     * Handle mouse movement for aiming
     * @param {MouseEvent} event - Mouse event object
     */
    handleMouseMove(event) {
        const rect = this.canvas.getBoundingClientRect();
        const newX = event.clientX - rect.left;
        const newY = event.clientY - rect.top;

        // Update both the local mouse object and the game state mouse
        mouse.x = newX;
        mouse.y = newY;
    }

    /**
     * Handle mouse button press (shooting)
     * @param {MouseEvent} event - Mouse event object
     */
    handleMouseDown(event) {
        if (event.button === 0) { // Left mouse button
            ensureAudioAndSynths();
            mouse.down = true;
        }
    }

    /**
     * Handle mouse button release
     * @param {MouseEvent} event - Mouse event object
     */
    handleMouseUp(event) {
        if (event.button === 0) { // Left mouse button
            mouse.down = false;
        }
    }

    /**
     * Prevent right-click context menu
     * @param {MouseEvent} event - Mouse event object
     */
    handleContextMenu(event) {
        event.preventDefault();
    }

    /**
     * Check if movement keys are currently pressed
     * @returns {Object} Movement state object with directional booleans
     */
    getMovementInput() {
        return {
            up: keys['ArrowUp'] || keys['w'],
            down: keys['ArrowDown'] || keys['s'],
            left: keys['ArrowLeft'] || keys['a'],
            right: keys['ArrowRight'] || keys['d'],
            run: keys['Shift']
        };
    }

    /**
     * Check if shooting input is active
     * @returns {boolean} True if player is currently shooting
     */
    isShooting() {
        return mouse.down;
    }

    /**
     * Get current mouse position relative to canvas
     * @returns {Object} Mouse position object with x,y coordinates
     */
    getMousePosition() {
        return {
            x: mouse.x,
            y: mouse.y
        };
    }

    /**
     * Reset all input states (useful for game state transitions)
     */
    resetInputState() {
        resetInputState();
    }

    /**
     * Check if a specific key is currently pressed
     * @param {string} keyName - Name of the key to check
     * @returns {boolean} True if key is currently pressed
     */
    isKeyPressed(keyName) {
        return keys[keyName] || keys[keyName.toLowerCase()] || false;
    }

    /**
     * Cleanup method to remove event listeners
     */
    destroy() {
        this._ac.abort();
    }
}

/**
 * Global input handler instance (will be initialized by main game controller)
 */
export let globalInputHandler = null;

/**
 * Initialize the global input handler
 * @param {HTMLCanvasElement} canvas - Game canvas element
 */
export function initializeInputHandler(canvas) {
    globalInputHandler = new InputHandler(canvas);
    return globalInputHandler;
}

/**
 * Get the current global input handler instance
 * @returns {InputHandler|null} Current input handler or null if not initialized
 */
export function getInputHandler() {
    return globalInputHandler;
}

/**
 * Clears every latched key and the mouse button.
 *
 * This operates on the exported module state rather than on an InputHandler
 * instance, so it still works before the handler is constructed and cannot be
 * silently skipped -- input left held when the player died used to carry into
 * the next game, which started the player already moving and firing.
 */
export function resetInputState() {
    Object.keys(keys).forEach(key => {
        keys[key] = false;
    });
    mouse.down = false;
    pad.run = false;
}