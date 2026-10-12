/**
 * @fileoverview The pause menu, for the keyboard, the mouse and touch alike.
 *
 * Doom's Esc opens its menu over the frozen game, and so does this one. Three
 * ways in, all to the same menu:
 *   - Esc, during play;
 *   - the pause button at the top right of the view (#gameButtons on a
 *     desktop, the last of #touchButtons in touch mode);
 *   - and nothing else: a menu, the tally or Game Over has nothing to pause.
 *
 * The menu offers Resume, Enter Code (Doom's cheat codes, typed into a box --
 * the only way in on a phone, and harmless on a desktop), Fullscreen where the
 * browser can do it, and Main Menu.
 *
 * Pausing stops the simulation and silences the game (GameState.pause), and
 * lets go of every held input here -- keys, the mouse button and the touch
 * sticks -- so nothing is still walking or firing when play resumes.
 *
 * Esc while paused resumes, unless the code box has the keyboard, where it
 * only closes the box. An Esc that the browser spends leaving fullscreen is
 * the browser's, and does neither: see handleEscape().
 *
 * This grew out of the touch controls' own pause menu (js/touch-controls.js),
 * which was the only pause there was. The touch controls now call into this.
 */

import { resetInputState } from './input-handler.js';
import { cheatsInText, applyCheat } from './cheats.js';
import { isAlwaysRun, toggleAlwaysRun } from './settings.js';
import {
    fullscreenSupported, isFullscreen, toggleFullscreen, onFullscreenChange,
} from './fullscreen.js';

/**
 * How long after leaving fullscreen an Esc is still taken to be the one that
 * left it, in milliseconds. Browsers differ on whether that key press reaches
 * the page at all, and on whether it arrives before or after the change.
 */
export const FULLSCREEN_ESC_GRACE_MS = 500;

/**
 * @returns {number} Milliseconds, for timing the fullscreen grace period
 */
function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/**
 * The pause menu and the top-right buttons that open it.
 */
export class PauseMenu {
    /**
     * @param {Object} controller - The GameController (gameState, touchControls,
     *        showStartScreen)
     * @param {Object} [options]
     * @param {Document} [options.doc] - The document; a stub, under test
     */
    constructor(controller, { doc = (typeof document !== 'undefined' ? document : null) } = {}) {
        this.controller = controller;
        this.doc = doc;
        this.paused = false;

        // When the page last left fullscreen; see handleEscape()
        this.leftFullscreenAt = -Infinity;

        const byId = (id) => doc?.getElementById?.(id) || null;
        this.overlay = byId('pauseOverlay');
        this.resumeButton = byId('pauseResumeButton');
        this.fullscreenButton = byId('pauseFullscreenButton');
        this.runButton = byId('pauseRunButton');
        this.codeForm = byId('cheatCodeForm');
        this.codeInput = byId('cheatCodeInput');
        this.codeNote = byId('cheatCodeNote');

        this.bindEvents();
        this.syncFullscreen();
        this.syncAlwaysRun();
        this.startSync();
    }

    /**
     * Flips Always Run (js/settings.js) and relabels its button. On a touch
     * screen it is the only way to run: the move stick tops out at walking.
     */
    toggleAlwaysRun() {
        toggleAlwaysRun();
        this.syncAlwaysRun();
    }

    /**
     * Makes the Always Run button say what the setting is.
     */
    syncAlwaysRun() {
        if (!this.runButton) return;
        const on = isAlwaysRun();
        this.runButton.textContent = `Always Run: ${on ? 'On' : 'Off'}`;
        this.runButton.setAttribute?.('aria-pressed', on ? 'true' : 'false');
    }

    // ------------------------------------------------------------------ state

    /**
     * @returns {Object|null} The live GameState
     */
    get gameState() {
        return this.controller?.gameState || null;
    }

    /**
     * Whether a level is being played right now, and so could be paused. The
     * death beat counts -- the world is still running -- but the tally and
     * Game Over do not.
     *
     * @returns {boolean}
     */
    isPlaying() {
        const gs = this.gameState;
        return !!gs && gs.gameRunning && !gs.gameOver && !!gs.player &&
            !gs.isLevelCompleting && !gs.awaitingContinue;
    }

    // ------------------------------------------------------------------ events

    /**
     * Wires the menu's buttons, the top-right buttons and fullscreen changes.
     */
    bindEvents() {
        const doc = this.doc;
        if (!doc) return;

        const on = (id, type, handler) => doc.getElementById?.(id)?.addEventListener?.(type, handler);
        on('pauseResumeButton', 'click', () => this.resume());
        on('pauseCodeButton', 'click', () => this.openCodeEntry());
        on('pauseFullscreenButton', 'click', () => this.toggleFullscreen());
        on('pauseRunButton', 'click', () => this.toggleAlwaysRun());
        on('pauseQuitButton', 'click', () => this.quitToMenu());
        on('cheatCodeForm', 'submit', (e) => {
            e.preventDefault();
            this.enterCode();
        });
        // "Nothing happens." answers the last attempt, not the one being typed
        on('cheatCodeInput', 'input', () => this.setCodeNote(''));

        // The desktop's buttons over the view. Their own elements, so a click
        // on one never reaches the canvas and fires the weapon; and blurred
        // after, so the next Space or Enter is not a second click on it.
        const buttons = doc.querySelectorAll?.('[data-game-action]') || [];
        for (const button of buttons) {
            button.addEventListener('click', (e) => {
                e.preventDefault?.();
                this.runAction(button.dataset.gameAction);
                button.blur?.();
            });
        }

        onFullscreenChange((fullscreen) => {
            if (!fullscreen) this.leftFullscreenAt = nowMs();
            this.syncFullscreen();
        }, doc);
    }

    /**
     * Runs one of the top-right buttons.
     *
     * @param {string} action - 'pause' or 'fullscreen'
     */
    runAction(action) {
        if (action === 'pause') this.pause();
        else if (action === 'fullscreen') this.toggleFullscreen();
    }

    /**
     * Esc, from InputHandler.
     *
     *   - In play, it pauses.
     *   - Paused, it resumes -- unless the code box has the keyboard, where it
     *     only closes the box, as Esc closes any text box.
     *   - Anywhere else (the start screen, the instructions, the tally, Game
     *     Over) it does nothing here. Starting or resuming a game is never
     *     Esc's job; the instructions close on it in main.js.
     *
     * Leaving fullscreen: the browser takes Esc to leave fullscreen, and
     * whether the page also sees that key press differs between browsers.
     * Where it does, it must not pause the game (or resume it) as well: one
     * key press, one thing. So an Esc that arrives while the page is
     * fullscreen, or just after it stopped being, is left to the browser. A
     * second Esc, once windowed, pauses or resumes as usual.
     *
     * @param {KeyboardEvent} event
     * @returns {boolean} True if the key was used
     */
    handleEscape(event) {
        if (event?.repeat) return false;

        if (this.paused && this.isCodeEntryFocused(event)) {
            this.closeCodeEntry();
            return true;
        }

        if (isFullscreen(this.doc) || nowMs() - this.leftFullscreenAt < FULLSCREEN_ESC_GRACE_MS) {
            return false;
        }

        if (this.paused) {
            this.resume();
            return true;
        }
        return this.pause();
    }

    // ----------------------------------------------------------- pause/resume

    /**
     * Pauses play and shows the menu.
     *
     * @returns {boolean} True if the game was playing and is now paused
     */
    pause() {
        if (this.paused || !this.isPlaying()) return false;
        if (!this.gameState.pause()) return false;
        this.paused = true;

        // Let go of everything held. The keyup or pointerup for it will land
        // on the menu, or never come at all, and the marine would otherwise
        // resume still walking and firing.
        resetInputState();
        this.controller?.touchControls?.releaseAll?.();

        this.closeCodeEntry();
        this.syncFullscreen();
        if (this.overlay) this.overlay.style.display = 'flex';

        // Enter or Space then resumes, as the browser presses a focused button.
        // Not on a touch screen, where a focused button only draws a ring.
        if (!this.isTouchUi()) this.resumeButton?.focus?.({ preventScroll: true });
        return true;
    }

    /**
     * Closes the menu and resumes play, and with it the sound.
     */
    resume() {
        if (!this.paused) return;
        this.paused = false;
        this.hideOverlay();
        this.gameState?.resume();
    }

    /**
     * Pauses in play, resumes when paused.
     */
    toggle() {
        if (this.paused) this.resume();
        else this.pause();
    }

    /**
     * Abandons the paused run for the start screen. The run is left stopped
     * behind the menu, as after Game Over; Start Game resets everything.
     */
    quitToMenu() {
        if (!this.paused) return;
        this.paused = false;
        this.hideOverlay();
        this.controller?.showStartScreen?.();
    }

    /**
     * Takes the menu down and lets the keyboard go.
     */
    hideOverlay() {
        this.closeCodeEntry();
        if (this.overlay) this.overlay.style.display = 'none';
        const active = this.doc?.activeElement;
        if (active && this.overlay?.contains?.(active)) active.blur?.();
    }

    // -------------------------------------------------------------- code entry

    /**
     * Shows the code box and gives it the keyboard -- on a phone, that brings
     * up the on-screen one. Typed play is where Doom's codes go on a computer;
     * with no keyboard, this is where they go instead, and a desktop can use it
     * too.
     */
    openCodeEntry() {
        if (!this.codeForm || !this.codeInput) return;
        this.codeForm.style.display = 'block';
        this.setCodeNote('');
        this.codeInput.value = '';
        this.codeInput.focus?.();
    }

    /**
     * Hides the code box.
     */
    closeCodeEntry() {
        if (this.codeInput) {
            this.codeInput.value = '';
            this.codeInput.blur?.();
        }
        if (this.codeForm) this.codeForm.style.display = 'none';
        this.setCodeNote('');
        // Back to Resume, so Enter still does what the menu says
        if (this.paused && !this.isTouchUi()) this.resumeButton?.focus?.({ preventScroll: true });
    }

    /**
     * @param {Event} [event] - The key event, whose target is checked first
     * @returns {boolean} Whether the code box is open and has the keyboard
     */
    isCodeEntryFocused(event) {
        if (!this.codeInput || this.codeForm?.style?.display === 'none') return false;
        return event?.target === this.codeInput || this.doc?.activeElement === this.codeInput;
    }

    /**
     * Runs what was typed in the code box. A code that works closes the menu
     * and resumes straight away, so Doom's reply is seen on the message line
     * where it belongs; one that does not stays put to be corrected.
     */
    enterCode() {
        const gameState = this.gameState;
        if (!this.codeInput || !gameState?.player) return;

        const cheats = cheatsInText(this.codeInput.value);
        if (!cheats.length) {
            this.setCodeNote('Nothing happens.');
            this.codeInput.select?.();
            return;
        }

        for (const cheat of cheats) applyCheat(cheat, gameState);
        this.resume();
    }

    /**
     * @param {string} text - Small print under the code box
     */
    setCodeNote(text) {
        if (this.codeNote) this.codeNote.textContent = text;
    }

    // -------------------------------------------------------------- fullscreen

    /**
     * Enters or leaves fullscreen. Called straight from a click, which is the
     * user gesture the browser insists on.
     *
     * @returns {Promise<boolean>}
     */
    toggleFullscreen() {
        return toggleFullscreen(this.doc);
    }

    /**
     * Brings every fullscreen control in line with the page: hidden where the
     * browser cannot do it (an iPhone), and the pause menu's label and the
     * buttons' icon saying which way it would go.
     */
    syncFullscreen() {
        const doc = this.doc;
        if (!doc) return;

        const supported = fullscreenSupported(doc);
        const fullscreen = isFullscreen(doc);

        const classes = doc.body?.classList;
        classes?.toggle?.('fullscreen-unsupported', !supported);
        classes?.toggle?.('is-fullscreen', fullscreen);

        const label = fullscreen ? 'Exit Fullscreen' : 'Fullscreen';
        for (const control of doc.querySelectorAll?.('[data-fullscreen-toggle]') || []) {
            control.hidden = !supported;
            control.setAttribute?.('aria-label', label);
            if (control.title !== undefined) control.title = label;
        }
        if (this.fullscreenButton) this.fullscreenButton.textContent = label;
    }

    // -------------------------------------------------------------------- sync

    /**
     * @returns {boolean} Whether the touch controls are in use
     */
    isTouchUi() {
        return !!this.doc?.body?.classList?.contains?.('touch-ui');
    }

    /**
     * Shows the desktop's top-right buttons only while a level is played
     * (body.game-playing): on a menu there is nothing to pause, and they would
     * sit over it. Polled per frame, like the touch controls, rather than
     * hooked into every way play can start or stop.
     */
    startSync() {
        if (typeof requestAnimationFrame !== 'function' || !this.doc?.body) return;

        const tick = () => {
            const playing = this.isPlaying();
            if (playing !== this.wasPlaying) {
                this.wasPlaying = playing;
                this.doc.body.classList?.toggle?.('game-playing', playing);
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }
}

/**
 * The live pause menu, once initPauseMenu has run.
 * @type {PauseMenu|null}
 */
export let pauseMenu = null;

/**
 * Sets up the pause menu and hands it Esc.
 *
 * @param {Object} controller - The GameController
 * @param {Object} [options] - See PauseMenu
 * @returns {PauseMenu}
 */
export function initPauseMenu(controller, options) {
    pauseMenu = new PauseMenu(controller, options);
    controller.pauseMenu = pauseMenu;
    if (controller.inputHandler) {
        controller.inputHandler.onEscape = (event) => pauseMenu.handleEscape(event);
    }
    return pauseMenu;
}
