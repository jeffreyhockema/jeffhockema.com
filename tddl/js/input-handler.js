/**
 * @fileoverview Input Handling System Module
 * 
 * This module manages all user input for the top-down Doom-like game, including
 * keyboard controls, mouse input, and input state management.
 * 
 * Key Features:
 * - Keyboard state tracking with proper key press/release handling
 * - Mouse position and click detection
 * - Weapon switching controls (1-7 keys)
 * - Movement controls (WASD/Arrow keys, Shift to run)
 * - Cheat code handling for development/testing
 * - Input validation and sanitization
 * 
 * @author Game Development Team
 * @version 1.0.0
 */

import { ensureAudioAndSynths } from './audio-system.js';

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
    
    // Cheat keys
    'i': false,
    'k': false,
    'g': false,
    'l': false,

    // View toggles
    'm': false,

    // Input processing flags to prevent repeat actions
    'i_cheat_processed': false,
    'k_cheat_processed': false,
    'g_cheat_processed': false,
    'l_cheat_processed': false,
    'c_cheat_processed': false,
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
            this.handleGameplayInput(keyName);
        }
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
     * Handle gameplay-specific input actions (cheats, weapon switching)
     * @param {string} keyName - Normalized key name (lowercase)
     */
    handleGameplayInput(keyName) {
        const player = this.gameState.player;

        // Handle cheat codes
        this.handleCheatCodes(keyName, player);

        // Handle display toggles
        this.handleViewToggles(keyName);

        // Handle weapon switching
        this.handleWeaponSwitching(keyName, player);
    }

    /**
     * Process keys that change what is displayed rather than what happens.
     *
     * Kept apart from handleCheatCodes: these are ordinary controls a player is
     * meant to use, not development shortcuts, and the instructions list them as
     * such.
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
     * Process cheat code inputs for development and testing
     * @param {string} keyName - Key that was pressed
     * @param {Object} player - Player object reference
     */
    handleCheatCodes(keyName, player) {
        switch (keyName) {
            case 'i':
                if (!keys.i_cheat_processed) {
                    keys.i_cheat_processed = true;
                    player.canPhase = !player.canPhase;
                    console.log(`Invincibility/Phasing ${player.canPhase ? 'enabled' : 'disabled'}`);
                }
                break;
                
            case 'k':
                if (!keys.k_cheat_processed) {
                    keys.k_cheat_processed = true;
                    player.collectAllKeys();
                    console.log('All keys collected');
                }
                break;
                
            case 'g':
                if (!keys.g_cheat_processed) {
                    keys.g_cheat_processed = true;
                    player.collectAllGuns();
                    console.log('All weapons collected');
                }
                break;
                
            case 'l':
                if (!keys.l_cheat_processed && this.gameState.levelComplete) {
                    keys.l_cheat_processed = true;
                    this.gameState.levelComplete();
                    console.log('Level completed via cheat');
                }
                break;

            case 'c':
                if (!keys.c_cheat_processed) {
                    keys.c_cheat_processed = true;
                    this.gameState.showCoordinates = !this.gameState.showCoordinates;
                    console.log(`Coordinates and frame cost ${this.gameState.showCoordinates ? 'enabled' : 'disabled'}`);
                }
                break;
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
            'i': 'i_cheat_processed',
            'k': 'k_cheat_processed',
            'g': 'g_cheat_processed',
            'l': 'l_cheat_processed',
            'c': 'c_cheat_processed',
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
}