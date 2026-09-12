/**
 * MAIN GAME CONTROLLER MODULE
 * 
 * This is the main entry point that initializes and coordinates all game systems.
 * It handles game startup, input management, rendering coordination, and provides
 * the primary interface between the HTML UI and the game logic.
 * 
 * Features:
 * - Game initialization and startup
 * - Input event handling and processing
 * - UI event management
 * - Rendering system coordination
 * - Audio system integration
 * - Error handling and recovery
 * 
 * @author TDDL Game Team
 * @version 1.0.0
 */

import {
    VIEWPORT_WIDTH, VIEWPORT_HEIGHT, TILE_SIZE, MAP_COLS, MAP_ROWS,
    WALL_STYLES, MINIMAP, TERRAIN, DOOR_STYLES, KEY_STYLES, EXIT_STYLE,
    TILE_SECRET_DOOR, TILE_WALL, TILE_PROP, TILE_SLIDE, TILE_SWITCH, TILE_EMPTY, ITEM_DRAW_SIZE, TILE_WINDOW, WINDOW_OUTSIDE,
} from './constants.js';
import {
    NB, isWallLike, isKeyedDoor, isTerrainTile, neighbourMask, tileNoise
} from './terrain.js';
import {
    LIGHTING, updateLighting, sampleLightAt, sampleVisionAt, resetLighting,
    rayDirection, getVisionMap, getLightMap,
    getLightingGeneration, getVisionPolygons, getExploredMap, isOpaqueTile,
    litWallFace, radialLightAt, wallFaceSamplePoint, getSightPolygon,
} from './lighting.js';
import { GameState } from './game-state.js';
// Note: startMenuMusic/stopMenuMusic are intentionally not imported. The menu music
// feature exists in audio-system.js but has never been wired up to anything; these
// were dead imports. playLevelCompleteSound/playGameOverSound are triggered from
// game-state.js, not here.
import {
    initializeAudio, ensureAudioAndSynths, playUIClickSound, playUIHoverSound
} from './audio-system.js';
import { loadEnemySpriteManifest } from './enemy-sprites.js';
import { drawDecals, drawParticles } from './particles.js';
import { loadPlayerSpriteManifest } from './player-sprites.js';
import { loadItemIcons, drawItemIcon, iconDrawSize,
} from './item-icons.js';
import { initializeInputHandler, mouse } from './input-handler.js';
import { doorAtTile } from './doors.js';
import { DECOR, isSolidDecor } from './decor.js';
import { slideAtTile, switchAtTile, isSlideOpen } from './switches.js';
import { hasSectors, ambientForTile } from './sectors.js';
import { isWindowExterior } from './windows.js';

// =============================================================================
// GLOBAL GAME CONTROLLER
// =============================================================================

/**
 * Main game controller class that manages the entire application
 */
class GameController {
    /**
     * Creates the main game controller
     */
    constructor() {
        console.log("GameController: Constructor called");
        
        // Core game systems
        this.gameState = null;
        this.canvas = null;
        this.ctx = null;
        
        // UI elements
        this.messageOverlay = null;
        this.restartButton = null;
        this.difficultyButtons = null;
        this.instructionsButton = null;
        this.mainMenuButton = null;
        this.instructionsOverlay = null;
        this.closeInstructionsButton = null;
        
        // Visual settings

        // Rendering loop handle (cancelled and restarted on each new game)
        this.renderLoopId = null;
        this.lastRenderErrorMessage = null;
        
        // Initialize game
        this.init();
    }

    /**
     * Initializes the game controller and all subsystems
     */
    init() {
        console.log("GameController: Initializing game systems");
        
        try {
            this.initializeAudio(); // Non-blocking audio init
            this.initializeCanvas();
            this.initializeUI();
            this.initializeGameState();
            this.setupEventListeners();
            this.initializeSprites();
            this.showStartScreen();
            
            console.log("GameController: Initialization complete");
        } catch (error) {
            console.error("GameController: Initialization failed:", error);
            this.showCriticalError(error);
        }
    }

    /**
     * Initializes the audio system
     */
    async initializeAudio() {
        try {
            // Don't await - let audio initialize in background
            initializeAudio().then(() => {
                console.log("GameController: Audio system initialized");
            }).catch(error => {
                console.warn("GameController: Audio initialization failed (will retry on user interaction):", error);
            });
        } catch (error) {
            console.warn("GameController: Audio initialization failed:", error);
        }
    }

    /**
     * Initializes canvas and rendering context
     */
    initializeCanvas() {
        this.canvas = document.getElementById('gameCanvas');
        if (!this.canvas) {
            throw new Error("Failed to find the #gameCanvas element");
        }

        this.ctx = this.canvas.getContext('2d');
        if (!this.ctx) {
            throw new Error("Failed to acquire a 2D rendering context");
        }

        // Initialize zoom system. The default is 1.4 rather than 1.0: the
        // marine and the monsters are drawn at Doom's own proportions, where
        // a man is half a tile across, and at 1.0 the whole view reads small.
        // The player can still zoom either way with - and =.
        this.zoomLevel = 1.4;
        this.minZoom = 0.5;
        this.maxZoom = 3.0;
        this.zoomStep = 0.1;

        // Set up dynamic canvas sizing
        this.setupDynamicCanvasSizing();

        // Dynamic sizing will be handled by setupDynamicCanvasSizing
        this.updateCanvasSize();

        // Initialize input handler for mouse and keyboard events
        this.inputHandler = initializeInputHandler(this.canvas);

        console.log("GameController: Canvas and input handler initialized");
    }

    /**
     * Initializes UI element references
     */
    initializeUI() {
        // Get UI element references
        this.messageOverlay = document.getElementById('messageOverlay');
        this.messageTitle = document.getElementById('messageTitle');
        this.messageText = document.getElementById('messageText');
        this.restartButton = document.getElementById('restartButton');
        this.difficultyButtons = document.querySelectorAll('.difficulty-button');
        this.instructionsButton = document.getElementById('instructionsButton');
        this.mainMenuButton = document.getElementById('mainMenuButton');
        this.instructionsOverlay = document.getElementById('instructionsOverlay');
        this.closeInstructionsButton = document.getElementById('closeInstructionsButton');
        this.continueButton = document.getElementById('continueButton');
        this.difficultyHint = document.getElementById('difficultyHint');

        // Initialize wall style

        // Whether self-luminous flourishes -- the bloom over lava, a door's status
        // lamp, the pool under a key -- may be drawn on the layer currently being
        // built. False for exactly one pass: what peripheral vision makes out is a
        // colourless wash, and a glow added there would be a second, weaker torch
        // that lights whatever the player happens to be facing near.
        this.allowEmissive = true;
        
        console.log("GameController: UI elements initialized");
    }

    /**
     * Initializes the game state system
     */
    initializeGameState() {
        this.gameState = new GameState();

        // Connect the input handler to the game state
        if (this.inputHandler) {
            this.inputHandler.setGameState(this.gameState);
        }

        console.log("GameController: Game state initialized and connected to input handler");
    }

    /**
     * Sets up all event listeners for input and UI
     */
    setupEventListeners() {
        this.setupMouseInput();
        this.setupUIEvents();
        console.log("GameController: Event listeners configured");
    }

    /**
     * Sets up mouse input handling
     */
    setupMouseInput() {
        // Mouse input is now handled by InputHandler class in input-handler.js
        // This method is kept for backwards compatibility but functionality moved there
        // to avoid duplicate event listeners that cause aiming misalignment
    }

    /**
     * Sets up UI event handlers
     */
    setupUIEvents() {
        // Restart button
        if (this.restartButton) {
            this.restartButton.addEventListener('click', async () => {
                await ensureAudioAndSynths(); // Ensure audio is ready
                playUIClickSound();
                this.startNewGame();
            });
            this.restartButton.addEventListener('mouseenter', () => {
                playUIHoverSound();
            });
        }

        // Difficulty selection
        this.difficultyButtons.forEach(button => {
            button.addEventListener('click', async () => {
                await ensureAudioAndSynths(); // Ensure audio is ready
                playUIClickSound();
                this.difficultyButtons.forEach(btn => btn.classList.remove('selected'));
                button.classList.add('selected');
                this.gameState.selectedDifficulty = button.dataset.difficulty;
                this.updateDifficultyHint();
                this.blurMenuButton();
                console.log("Difficulty set to:", this.gameState.selectedDifficulty);
            });
            button.addEventListener('mouseenter', () => {
                playUIHoverSound();
            });
        });

        // Instructions
        if (this.mainMenuButton) {
            this.mainMenuButton.addEventListener('click', () => {
                playUIClickSound();
                this.gameState?.showStartScreen();
            });
            this.mainMenuButton.addEventListener('mouseenter', () => playUIHoverSound());
        }

        if (this.instructionsButton) {
            this.instructionsButton.addEventListener('click', () => {
                this.showInstructions();
            });
        }

        if (this.closeInstructionsButton) {
            this.closeInstructionsButton.addEventListener('click', () => {
                this.hideInstructions();
            });
        }

        // Continue, from the end-of-level tally
        if (this.continueButton) {
            this.continueButton.addEventListener('click', () => this.continueGame());
            this.continueButton.addEventListener('mouseenter', () => {
                playUIHoverSound();
            });
        }

        // Menu keys: Enter and Space stand in for whichever button the overlay
        // is showing, and Escape closes the instructions.
        document.addEventListener('keydown', (event) => this.handleMenuKey(event));

        this.updateDifficultyHint();
    }

    /**
     * Starts the next level from the end-of-level tally, if one is waiting.
     */
    async continueGame() {
        if (!this.gameState?.awaitingContinue) return;
        await ensureAudioAndSynths();
        playUIClickSound();
        this.gameState.continueToNextLevel();
    }

    /**
     * Whether an element controlled by inline display is currently shown.
     *
     * @param {HTMLElement|null} element
     * @returns {boolean}
     */
    isShown(element) {
        return !!element && element.style.display !== 'none';
    }

    /**
     * Keyboard shortcuts for the menus.
     *
     * Enter and Space continue past the tally; Enter also presses Start or
     * Restart on the start and Game Over screens. Escape closes the
     * instructions. None of it fires during play, and none of it fires when
     * a button has focus -- the browser already presses a focused button on
     * Enter and Space, and pressing it twice would start two levels.
     *
     * @param {KeyboardEvent} event
     */
    handleMenuKey(event) {
        const key = event.key;

        if (key === 'Escape') {
            if (this.isShown(this.instructionsOverlay)) {
                event.preventDefault();
                this.hideInstructions();
            }
            return;
        }

        if (key !== 'Enter' && key !== ' ') return;
        if (this.isShown(this.instructionsOverlay)) return;
        if (!this.isShown(this.messageOverlay)) return;

        // The button that would be pressed anyway, if it has focus. Any other
        // focused button -- a difficulty, or Instructions after Escape closed
        // it -- must not swallow the key: preventDefault() stops the browser
        // pressing it, and the key does what the screen says it does.
        const focused = (event.target && event.target.tagName === 'BUTTON') ? event.target : null;

        if (this.gameState?.awaitingContinue) {
            if (focused === this.continueButton) return;
            event.preventDefault();
            this.continueGame();
            return;
        }

        if (key === 'Enter' && this.isShown(this.restartButton)) {
            if (focused === this.restartButton) return;
            event.preventDefault();
            this.restartButton.click();
        }
    }

    /**
     * Drops keyboard focus from whatever menu button was last clicked, so the
     * next Enter or Space goes to handleMenuKey() rather than back to that
     * button.
     */
    blurMenuButton() {
        const active = document.activeElement;
        if (active && active.tagName === 'BUTTON' && typeof active.blur === 'function') {
            active.blur();
        }
    }

    /**
     * Describes the selected difficulty under the picker.
     */
    updateDifficultyHint() {
        if (!this.difficultyHint) return;
        const hints = {
            easy:   'Fewer enemies, and you take half the damage.',
            medium: 'The standard fight.',
            hard:   'The same enemies, and a lot more of them.',
        };
        const difficulty = this.gameState?.selectedDifficulty || 'medium';
        this.difficultyHint.textContent = hints[difficulty] || hints.medium;
    }

    /**
     * Initializes sprite images
     *
     * Nothing is embedded in the page any more. All three sets of artwork are
     * fetched: the player characters in sprites/player/, the enemy characters in
     * sprites/enemies/, and the pickup icons in sprites/items/.
     *
     * None of it is awaited. Each loader handles its own failure by logging and
     * leaving that layer on its fallback -- shapes for characters, lettered
     * badges for pickups -- so a missing or slow asset costs polish rather than
     * keeping the player at a blank menu.
     */
    initializeSprites() {
        loadPlayerSpriteManifest();
        loadEnemySpriteManifest();
        loadItemIcons();
    }

    // =============================================================================
    // GAME LIFECYCLE METHODS
    // =============================================================================

    /**
     * Starts a new game
     */
    startNewGame() {
        console.log("GameController: Starting new game");
        
        try {
            this.hideMessageOverlay();
            
            // Clear all lighting memory so the new run starts in the dark
            resetLighting();
            
            this.gameState.reset();
            this.gameState.startGame();
            this.gameState.startGameLoop();
            
            // Start rendering
            this.startRenderLoop();
            
        } catch (error) {
            console.error("GameController: Failed to start new game:", error);
            this.showCriticalError(error);
        }
    }

    /**
     * Shows the start screen
     */
    showStartScreen() {
        console.log("GameController: showStartScreen called");
        
        // Try to show via gameState first
        if (this.gameState) {
            this.gameState.showStartScreen();
        }
        
        // Backup direct DOM manipulation, in case the overlay was left hidden.
        // Guarded on the game not having started: this used to fire unconditionally
        // 100ms later, so clicking "Start Game" quickly enough dropped the start
        // overlay back on top of a game that was already running.
        setTimeout(() => {
            if (this.gameState?.gameRunning) return;

            const messageOverlay = document.getElementById('messageOverlay');
            if (messageOverlay) {
                messageOverlay.style.display = 'flex';
                messageOverlay.style.visibility = 'visible';
                messageOverlay.style.opacity = '1';
            }
        }, 100);
    }

    /**
     * Shows instructions overlay
     */
    showInstructions() {
        if (this.instructionsOverlay) {
            this.instructionsOverlay.style.display = 'flex';
        }
    }

    /**
     * Hides instructions overlay
     */
    hideInstructions() {
        if (this.instructionsOverlay) {
            this.instructionsOverlay.style.display = 'none';
        }
        this.blurMenuButton();
    }

    /**
     * Hides the message overlay
     */
    hideMessageOverlay() {
        if (this.messageOverlay) {
            this.messageOverlay.style.display = 'none';
        }
    }

    /**
     * Shows a critical error message
     * 
     * @param {Error} error - The error to display
     */
    showCriticalError(error) {
        if (this.messageTitle) this.messageTitle.textContent = "Critical Error!";
        if (this.messageText) {
            this.messageText.innerHTML = `A critical error occurred: ${error.message}<br>Check console for details.`;
        }
        if (this.restartButton) this.restartButton.textContent = "Restart Game";
        if (this.messageOverlay) this.messageOverlay.style.display = 'flex';
    }

    // =============================================================================
    // RENDERING SYSTEM
    // =============================================================================

    /**
     * Starts the rendering loop
     */
    startRenderLoop() {
        // Cancel any loop already in flight. startNewGame() calls this on every
        // restart, and the old loop was never cancelled -- each restart left another
        // full render loop running, so the cost of drawing compounded every time the
        // player died and pressed Restart.
        this.stopRenderLoop();
        this.renderLoopId = requestAnimationFrame(() => this.render());
    }

    /**
     * Stops the rendering loop if one is running
     */
    stopRenderLoop() {
        if (this.renderLoopId !== null && this.renderLoopId !== undefined) {
            cancelAnimationFrame(this.renderLoopId);
            this.renderLoopId = null;
        }
    }

    /**
     * Main rendering function
     */
    render() {
        // Frame timing, smoothed. A raw frame-to-frame delta swings far too much to
        // read off the screen, and the number is only useful if it can be read while
        // the thing being measured is happening.
        const now = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        if (this.lastFrameAt) {
            const delta = now - this.lastFrameAt;
            this.frameMs = this.frameMs ? this.frameMs * 0.9 + delta * 0.1 : delta;
        }
        this.lastFrameAt = now;

        // One clock for every animated surface this frame. Lava, water and the
        // exit light all read it, and they must all read the SAME value: the
        // geometry is drawn three times over (remembered, sensed, lit) and a
        // surface that advanced between those passes would tear along the seam
        // where one pass gives way to the next.
        this.terrainPhase = now / 1000;

        const renderStart = now;
        if (!this.phase) this.phase = {};
        for (const key in this.phase) this.phase[key] = 0;
        this.counts = { sources: 0, passes: 0, spans: 0, rays: 0 };

        try {
            this.clearCanvas();

            if (this.gameState.gameRunning && !this.gameState.gameOver) {
                this.renderGame();
            }
            this.recordFrameCost(renderStart);
        } catch (error) {
            // Log once per burst rather than flooding the console at 60fps
            if (!this.lastRenderErrorMessage || this.lastRenderErrorMessage !== error.message) {
                console.error("GameController: Render error:", error);
                this.lastRenderErrorMessage = error.message;
            }
        } finally {
            // Rescheduling lives in `finally` so a single thrown frame cannot
            // permanently stop rendering. Previously the requestAnimationFrame call
            // sat inside the try block after renderGame(), so one exception --
            // a transient null map during a level transition, say -- left the canvas
            // frozen for the rest of the session.
            this.renderLoopId = requestAnimationFrame(() => this.render());
        }
    }

    /**
     * @returns {number} A high-resolution timestamp in milliseconds
     */
    now() {
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
    }

    /**
     * Adds the time since `since` to a named slice of this frame's cost.
     *
     * @param {string} name - Slice name, as shown in the panel
     * @param {number} since - Timestamp from now()
     */
    mark(name, since) {
        // Lazily, because renderGame() is a legitimate entry point on its own --
        // the render tests drive it directly -- and instrumentation must never be
        // the reason a frame fails to draw.
        if (!this.phase) this.phase = {};
        this.phase[name] = (this.phase[name] || 0) + (this.now() - since);
    }

    /**
     * Folds this frame's slices into the running averages behind the F3 panel.
     *
     * Averaged over a short window rather than shown raw, because a single frame's
     * numbers jitter far too much to read while the game is running -- which is the
     * only time they are worth anything.
     *
     * @param {number} renderStart - When this frame's rendering began
     */
    recordFrameCost(renderStart) {
        let totals = this.perfTotals;
        if (!totals) {
            totals = this.perfTotals = { frames: 0, render: 0, frame: 0, phase: {}, counts: {} };
        }

        totals.frames++;
        totals.render += this.now() - renderStart;
        totals.frame += this.frameMs || 0;
        for (const key in this.phase) {
            totals.phase[key] = (totals.phase[key] || 0) + this.phase[key];
        }
        for (const key in this.counts) {
            totals.counts[key] = (totals.counts[key] || 0) + this.counts[key];
        }

        if (totals.frames < 20) return;

        const stats = {
            render: totals.render / totals.frames,
            frame: totals.frame / totals.frames,
            phase: {},
            counts: {},
        };
        for (const key in totals.phase) stats.phase[key] = totals.phase[key] / totals.frames;
        for (const key in totals.counts) stats.counts[key] = totals.counts[key] / totals.frames;
        this.perfStats = stats;
        this.perfTotals = null;
    }

    /**
     * Clears the canvas
     */
    clearCanvas() {
        // Black, not grey: anywhere the player has never lit stays genuinely unseen.
        // The old '#333' meant unexplored parts of the map were visibly lighter than
        // the void and the level's footprint could be read straight off the screen.
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    /**
     * Renders the complete game scene
     */
    renderGame() {
        if (!this.gameState.gameMap || !this.gameState.player) return;

        const viewWidth = this.canvas.width;
        const viewHeight = this.canvas.height;
        this.ensureRenderLayers(viewWidth, viewHeight);

        const player = this.gameState.player;
        const bounds = this.computeVisibleTileBounds(player, viewWidth, viewHeight);

        // Refresh the lighting solution for this frame before anything reads it
        let at = this.now();
        const polygons = updateLighting(this.gameState);
        const visionPolygons = getVisionPolygons();
        const sightPolygon = getSightPolygon();
        this.mark('cast', at);

        if (!this.counts) this.counts = { sources: 0, passes: 0, spans: 0, rays: 0 };
        this.counts.sources = polygons.length + visionPolygons.length;
        for (const polygon of polygons) {
            this.counts.rays += polygon.origins.length * polygon.distances.length;
        }
        for (const polygon of visionPolygons) {
            this.counts.rays += polygon.origins.length * polygon.distances.length;
        }

        // Resolve this frame's coverage once, then reuse it for the live masks and
        // for the persistent record of what has been seen.
        // Both masks report the rectangle they actually touched, which is all the
        // memory stamp below has to look at -- everywhere else they are empty, and
        // stamping empty pixels into a maximum changes nothing.
        at = this.now();
        // Sight first: terrain glow is multiplied through it (see buildMask), so
        // a pool in the next room lights nothing the player cannot see.
        this.buildMask(this.sightMaskCtx, sightPolygon ? [sightPolygon] : [], bounds, player, viewWidth, viewHeight);
        const litArea = this.buildMask(this.maskCtx, polygons, bounds, player, viewWidth, viewHeight,
                                       this.sightMaskCanvas);
        const sensedArea = this.buildMask(this.senseMaskCtx, visionPolygons, bounds, player, viewWidth, viewHeight);
        this.mark('mask', at);

        at = this.now();
        this.stampSeenSurface(player, viewWidth, viewHeight,
                              this.unionBounds(litArea, sensedArea));
        this.mark('memory', at);

        // --- Pass 1: remembered geometry -------------------------------------
        // Dim floors, walls and doors the player has already seen. Static only:
        // items and creatures are never drawn from memory, so walking away from a
        // room leaves its shape behind but not what was standing in it.
        //
        // Masked by the seen surface rather than by a per-tile explored flag. Using
        // the flag meant a tile the light had merely clipped the corner of was
        // remembered as a whole bright square, so explored areas grew in blocky
        // 40px steps that had nothing to do with the shape of the beam.
        at = this.now();
        const mem = this.memCtx;
        mem.setTransform(1, 0, 0, 1, 0, 0);
        mem.clearRect(0, 0, viewWidth, viewHeight);
        mem.save();
        this.applyWorldTransform(mem, player, viewWidth, viewHeight);
        this.drawStaticGeometry(mem, bounds, 'memory');
        mem.restore();

        // Multiply the dim geometry by the record of what has been seen. The record
        // is opaque grey rather than alpha (see stampSeenSurface), so it modulates
        // brightness here instead of masking: unseen ground multiplies to black.
        mem.globalCompositeOperation = 'multiply';
        mem.save();
        this.applyWorldTransform(mem, player, viewWidth, viewHeight);
        this.drawSeenSurfaceRegion(mem, player, viewWidth, viewHeight);
        mem.restore();
        mem.globalCompositeOperation = 'source-over';

        this.ctx.drawImage(this.memCanvas, 0, 0);
        this.mark('remembered', at);

        // --- Pass 2: what peripheral vision makes out --------------------------
        // The wide arc in front of the player, where shapes register without being
        // lit. Same content as the lit pass -- geometry, items, creatures -- but
        // masked by the vision arc instead of the light, and then drained of colour
        // so it reads as something noticed rather than something illuminated.
        //
        // Under the lit pass, never over it: where the beam also falls, the lit
        // layer paints straight over this at full alpha, so the two never fight and
        // there is no seam where the arc crosses the beam's rim.
        at = this.now();
        this.drawSensePass(player, bounds, viewWidth, viewHeight);
        this.mark('sensed', at);

        // --- Pass 3: the lit world -------------------------------------------
        // Everything at full brightness on its own layer. Nothing here is gated on
        // visibility -- the light mask below decides what survives, which is what
        // stops "looks lit" and "is revealed" from drifting apart.
        at = this.now();
        const lit = this.litCtx;
        lit.setTransform(1, 0, 0, 1, 0, 0);
        lit.clearRect(0, 0, viewWidth, viewHeight);
        lit.save();
        this.applyWorldTransform(lit, player, viewWidth, viewHeight);
        this.drawStaticGeometry(lit, bounds, 'lit');
        // Blood on the floor: under the items and creatures, over the ground
        drawDecals(lit, bounds);
        this.drawItemTiles(lit, bounds);
        this.drawEntities(lit, (e) => sampleLightAt(e.x, e.y) > LIGHTING.REVEAL_THRESHOLD);
        // Water and blood in flight: lit things, seen where the torch falls
        drawParticles(lit, 'lit');
        lit.restore();

        // --- Pass 4: mask the lit world by the light shape --------------------
        lit.setTransform(1, 0, 0, 1, 0, 0);
        lit.globalCompositeOperation = 'destination-in';
        lit.drawImage(this.maskCanvas, 0, 0);
        lit.globalCompositeOperation = 'source-over';

        // Composite the lit world over the remembered one. Where the light fades
        // out its partial alpha blends back into the dim memory underneath, so the
        // edge of the beam is a soft gradient rather than a hard cut.
        this.ctx.drawImage(this.litCanvas, 0, 0);
        this.mark('lit', at);

        // --- Pass 5: the player and everything self-luminous ------------------
        // Drawn straight onto the screen, outside the mask, so they are never
        // swallowed by darkness.
        this.ctx.save();
        this.applyWorldTransform(this.ctx, player, viewWidth, viewHeight);
        player.draw(this.ctx);
        this.drawEmissive(this.ctx);
        this.ctx.restore();

        at = this.now();
        this.renderUIOverlay();
        this.mark('hud', at);
    }

    /**
     * Applies the world-to-screen transform: centre on the player, apply zoom.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {Object} player - Player entity
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     */
    applyWorldTransform(ctx, player, viewWidth, viewHeight) {
        ctx.translate(viewWidth / 2, viewHeight / 2);
        ctx.scale(this.zoomLevel, this.zoomLevel);
        ctx.translate(-player.x, -player.y);
    }

    /**
     * Tile range covering the visible viewport, for culling.
     *
     * @param {Object} player - Player entity (camera centre)
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     * @returns {Object} Object with startRow, endRow, startCol, endCol
     */
    computeVisibleTileBounds(player, viewWidth, viewHeight) {
        const halfCols = Math.ceil(viewWidth / this.zoomLevel / TILE_SIZE / 2);
        const halfRows = Math.ceil(viewHeight / this.zoomLevel / TILE_SIZE / 2);
        const playerCol = Math.floor(player.x / TILE_SIZE);
        const playerRow = Math.floor(player.y / TILE_SIZE);

        return {
            startCol: Math.max(0, playerCol - halfCols),
            endCol: Math.min(MAP_COLS, playerCol + halfCols + 1),
            startRow: Math.max(0, playerRow - halfRows),
            endRow: Math.min(MAP_ROWS, playerRow + halfRows + 1),
        };
    }

    /**
     * Draws the map's static geometry -- floors, walls, doors, props, terrain --
     * for one of the three passes.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context, in world space
     * @param {Object} bounds - Tile range from computeVisibleTileBounds
     * @param {string} mode - 'memory', 'sensed' or 'lit'
     */
    drawStaticGeometry(ctx, bounds, mode) {
        const map = this.gameState.gameMap;

        // Cleared per pass, because a gradient belongs to the context that built it
        // and the bands drift every frame.
        if (!this.bandGradients) this.bandGradients = new Map();
        this.bandGradients.clear();

        // A level built as gated zones wears a different look either side of every
        // locked door, so the style is resolved per tile rather than per level.
        const styles = this.gameState.tileStyles;
        const levelStyle = WALL_STYLES[(this.gameState.currentLevel - 1) % WALL_STYLES.length];
        const decor = this.gameState.decor;

        const isMemory = mode === 'memory';
        const detail = mode === 'lit';

        // Each pass is masked afterwards -- by the seen surface, the vision arc or
        // the live light -- and that mask is exactly zero over most of the viewport
        // most of the time: a fresh level is almost all unexplored, and the beam
        // covers a third of the screen. Tiles under a zero mask are drawn only to
        // be thrown away, so they are skipped here, with a two-tile margin so no
        // tile the mask's soft edge could touch is ever left out. The edge of each
        // pass therefore stays as smooth as the mask makes it; only tiles that
        // could not have shown are gone.
        const reach = this.reachableTiles(bounds, mode);
        const cols = bounds.endCol - bounds.startCol;

        for (let r = bounds.startRow; r < bounds.endRow; r++) {
            const row = map[r];
            if (!row) continue;
            const reachBase = (r - bounds.startRow) * cols - bounds.startCol;

            for (let c = bounds.startCol; c < bounds.endCol; c++) {
                if (reach && !reach[reachBase + c]) continue;
                const tileType = row[c];
                if (tileType === undefined) continue;

                const style = styles ? WALL_STYLES[styles[r * MAP_COLS + c]] : levelStyle;
                const decorId = decor ? decor[r * MAP_COLS + c] : 0;

                if (tileType === TILE_WINDOW) {
                    this.drawWindowTile(ctx, c, r, style, isMemory, detail);
                } else if (tileType === TILE_SLIDE) {
                    this.drawSlideTile(ctx, c, r, style, isMemory, detail);
                } else if (tileType === TILE_SWITCH) {
                    this.drawSwitchTile(ctx, c, r, style, isMemory, detail);
                } else if (isWallLike(tileType)) {
                    this.drawWallTile(ctx, c, r, tileType, style, isMemory, detail);
                } else if (tileType === TILE_PROP) {
                    // A thing standing on the floor, lit as the floor is
                    this.drawProp(ctx, c, r, decorId, style, isMemory, detail);
                } else if (isTerrainTile(tileType)) {
                    this.drawTerrainTile(ctx, c, r, tileType, isMemory, detail);
                } else {
                    this.drawFloorTile(ctx, c, r, style, isMemory, detail);
                    if (decorId && !isSolidDecor(decorId)) {
                        this.drawFloorDecor(ctx, c, r, decorId, style, isMemory, detail);
                    }
                }
            }
        }

        // Seams last, and in device pixels -- see drawFloorGrout().
        if (!isMemory) this.drawFloorGrout(ctx, bounds, levelStyle, reach);

        // The bloom over glowing terrain goes on afterwards, in its own sweep.
        // It is additive and it spills past the tile that owns it, so drawing it
        // inline would let the next tile in the loop paint over half of it and
        // every pool would come out brighter along its top-left edge than its
        // bottom-right.
        if (detail) {
            const at = this.now();
            this.drawTerrainBloom(ctx, bounds);
            this.mark('bloom', at);
        }
    }

    /**
     * Which tiles in view a pass could put on screen: those within two tiles of
     * anything the pass's mask is non-zero at.
     *
     * Two tiles is generous on purpose. The masks are blurred by a few pixels and
     * the penumbra a lamp of LIGHT_RADIUS throws is a fraction of a tile, so one
     * tile would already do; two leaves nothing to argue about, and costs a few
     * dozen extra tile draws a frame against the several hundred it saves.
     *
     * @param {Object} bounds - Tile range from computeVisibleTileBounds
     * @param {string} mode - 'memory', 'sensed' or 'lit'
     * @returns {Uint8Array|null} One flag per tile in `bounds`, row-major, or null
     *     when there is nothing to gate on
     */
    reachableTiles(bounds, mode) {
        let grid, threshold;
        if (mode === 'memory') { grid = getExploredMap(); threshold = LIGHTING.MEMORY_MIN_LIGHT; }
        else if (mode === 'sensed') { grid = getVisionMap(); threshold = 0; }
        else { grid = getLightMap(); threshold = 0; }
        if (!grid || !grid.length) return null;

        const cols = bounds.endCol - bounds.startCol;
        const rows = bounds.endRow - bounds.startRow;
        const size = cols * rows;
        if (size <= 0) return null;

        let reach = this.reachGrid;
        if (!reach || reach.length < size) reach = this.reachGrid = new Uint8Array(size);
        else reach.fill(0, 0, size);

        const MARGIN = 2;
        const r0 = Math.max(0, bounds.startRow - MARGIN);
        const r1 = Math.min(MAP_ROWS, bounds.endRow + MARGIN);
        const c0 = Math.max(0, bounds.startCol - MARGIN);
        const c1 = Math.min(MAP_COLS, bounds.endCol + MARGIN);

        for (let r = r0; r < r1; r++) {
            const gridRow = grid[r];
            if (!gridRow) continue;
            for (let c = c0; c < c1; c++) {
                if (gridRow[c] <= threshold) continue;

                // Stamp this tile's neighbourhood, clipped to the viewport
                const rr0 = Math.max(bounds.startRow, r - MARGIN);
                const rr1 = Math.min(bounds.endRow - 1, r + MARGIN);
                const cc0 = Math.max(bounds.startCol, c - MARGIN);
                const cc1 = Math.min(bounds.endCol - 1, c + MARGIN);
                for (let rr = rr0; rr <= rr1; rr++) {
                    const base = (rr - bounds.startRow) * cols - bounds.startCol;
                    for (let cc = cc0; cc <= cc1; cc++) reach[base + cc] = 1;
                }
            }
        }
        return reach;
    }

    /**
     * How far each tile fill is grown so neighbours overlap, in world units.
     *
     * A tile edge lands wherever the camera puts it, which is almost never on a
     * whole device pixel. Two neighbours then each cover part of the pixel they
     * share, and `source-over` does not add them back to one: at a 30/70 split
     * about a fifth of what is behind them shows through. That is a dark seam
     * around every tile whose weight changes as the camera moves.
     *
     * One device pixel of overlap costs nothing -- the later tile covers the
     * earlier one's spill, exactly as it already did -- and leaves no gap for
     * anything to show through.
     *
     * @returns {number} Overlap in world units
     */
    tileBleed() {
        return 1 / this.zoomLevel;
    }

    /**
     * Strokes the seams between floor tiles, in device pixels.
     *
     * A stroke is the expensive call here, so the seams cannot be stroked tile
     * by tile: they go into one path per grout colour. Which colours are on
     * screen is worked out first, as a bitmask over the style list, and the
     * tiles are then walked once per colour actually present. A viewport almost
     * always sits inside a single zone, so this is normally the one pass it has
     * always been, and two at a gate -- with nothing allocated either way.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {Object} bounds - Tile range from computeVisibleTileBounds
     * @param {Object} levelStyle - The level's style, used when tiles carry none
     * @param {Uint8Array|null} reach - From reachableTiles(); tiles it marks
     *        unreachable are skipped, as the geometry pass skipped them
     */
    drawFloorGrout(ctx, bounds, levelStyle, reach = null) {
        const map = this.gameState.gameMap;
        const player = this.gameState.player;
        if (!map || !player) return;

        const zoom = this.zoomLevel;
        const viewWidth = this.canvas.width;
        const viewHeight = this.canvas.height;
        const offsetX = viewWidth / 2 - player.x * zoom;
        const offsetY = viewHeight / 2 - player.y * zoom;
        const styles = this.gameState.tileStyles;
        const cols = bounds.endCol - bounds.startCol;

        let present = 0;
        if (styles) {
            for (let r = bounds.startRow; r < bounds.endRow; r++) {
                const row = map[r];
                if (!row) continue;
                const reachBase = (r - bounds.startRow) * cols - bounds.startCol;
                for (let c = bounds.startCol; c < bounds.endCol; c++) {
                    if (reach && !reach[reachBase + c]) continue;
                    const tileType = row[c];
                    if (tileType === undefined) continue;
                    if (isWallLike(tileType) || isTerrainTile(tileType)) continue;
                    present |= 1 << styles[r * MAP_COLS + c];
                }
            }
        } else {
            present = 1;   // The level's own style, and only that
        }

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.lineWidth = 1;

        for (let index = 0; present !== 0; index++, present >>= 1) {
            if ((present & 1) === 0) continue;

            const style = styles ? WALL_STYLES[index] : levelStyle;
            ctx.strokeStyle = style.grout || style.borderColor;
            ctx.beginPath();

            for (let r = bounds.startRow; r < bounds.endRow; r++) {
                const row = map[r];
                if (!row) continue;
                const reachBase = (r - bounds.startRow) * cols - bounds.startCol;

                for (let c = bounds.startCol; c < bounds.endCol; c++) {
                    if (reach && !reach[reachBase + c]) continue;
                    const tileType = row[c];
                    if (tileType === undefined) continue;
                    if (isWallLike(tileType) || isTerrainTile(tileType)) continue;
                    if (styles && styles[r * MAP_COLS + c] !== index) continue;

                    const tile = this.tileScreenRect(c, r, zoom, offsetX, offsetY);
                    // Half a pixel off a whole one puts a one-pixel stroke inside it
                    const left = tile.left + 0.5;
                    const top = tile.top + 0.5;
                    ctx.moveTo(left, tile.top + tile.height);
                    ctx.lineTo(left, top);
                    ctx.lineTo(tile.left + tile.width, top);
                }
            }

            ctx.stroke();
        }

        ctx.restore();
    }

    /**
     * Draws a single floor tile, with a subtle checker so large rooms are not flat.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {Object} style - Active wall style
     * @param {boolean} isMemory - Draw at remembered brightness
     */
    drawFloorTile(ctx, c, r, style, isMemory, detail) {
        const x = c * TILE_SIZE;
        const y = r * TILE_SIZE;
        const base = ((c + r) & 1) ? style.floorAltColor : style.floorColor;

        ctx.fillStyle = isMemory ? this.dimColor(base, LIGHTING.MEMORY_BRIGHTNESS) : base;
        ctx.fillRect(x, y, TILE_SIZE + this.tileBleed(), TILE_SIZE + this.tileBleed());

        // Detail is skipped in every pass but the lit one: see drawStaticGeometry.
        if (!detail) return;

        // A stain on roughly one plate in seven. Keyed to the tile's coordinates
        // rather than rolled per frame, so it stays where it is instead of
        // crawling about the floor.
        const roll = tileNoise(c, r, 7);
        if (roll > 0.86) {
            const w = TILE_SIZE * (0.16 + (roll - 0.86) * 1.4);
            ctx.fillStyle = 'rgba(0,0,0,0.18)';
            ctx.fillRect(x + 5 + tileNoise(c, r, 8) * (TILE_SIZE - w - 10),
                         y + 5 + tileNoise(c, r, 9) * (TILE_SIZE - w * 0.6 - 10),
                         w, w * 0.6);
        }
    }

    // =========================================================================
    // TERRAIN
    // =========================================================================

    /**
     * Draws one tile of lava, toxic waste or water.
     *
     * Three things make a grid of tiles read as a pool rather than as tiles. The
     * body is mottled by blobs positioned from the tile's own coordinates and
     * drifting on the frame clock, so the surface moves. The blobs are drawn wider
     * than the tile and clipped to it, so they carry across the seam into the
     * neighbour and the seam stops being visible. And the crust is drawn only on
     * sides where the liquid actually ends -- which is the same autotiling rule the
     * walls use, and the reason a lake has a shoreline instead of a grid.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} tileType - Terrain tile value
     * @param {boolean} isMemory - Draw at remembered brightness
     */
    drawTerrainTile(ctx, c, r, tileType, isMemory, detail) {
        const terrain = TERRAIN[tileType];
        if (!terrain) return;

        const x = c * TILE_SIZE;
        const y = r * TILE_SIZE;
        const palette = terrain.palette;
        const dim = LIGHTING.MEMORY_BRIGHTNESS;
        const tone = (color) => isMemory ? this.dimColor(color, dim) : color;

        ctx.fillStyle = tone(palette.deep);
        ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);

        // The moving surface is the most expensive thing in the tile pass, and two
        // of the three passes throw it away: the memory pass draws at 45% and the
        // sense pass washes the layer colourless. Neither shows a ripple. Skipping
        // it there is most of the cost of a flooded room, and it is also the honest
        // reading -- you do not make out the current in a pool you have only half
        // noticed at the edge of your vision.
        if (detail && this.allowEmissive) {
            this.drawLiquidSurface(ctx, c, r, x, y, terrain);
        }

        const mask = neighbourMask(this.gameState.gameMap, c, r, (n) => n === tileType);
        this.drawLiquidShore(ctx, x, y, mask, terrain, isMemory, detail);
    }

    /**
     * The moving body of a liquid.
     *
     * Two layers, and the split matters. Underneath, a pair of soft radial washes
     * of the mid tone, drawn wider than the tile and clipped to it, so the colour
     * carries across the seam into the neighbour and a lake stops looking like a
     * row of separately painted squares. Over that, whichever of the three surface
     * routines this liquid asked for.
     *
     * The washes are gradients rather than flat discs on purpose: hard-edged discs
     * of a contrasting colour read as spots, and a pool covered in spots reads as
     * decoration rather than as a fluid. This is the same reason the bright tone is
     * spent on thin veins and ripples below rather than on more discs.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} x - World X of the tile's top-left corner
     * @param {number} y - World Y of the tile's top-left corner
     * @param {Object} terrain - Entry from TERRAIN
     */
    drawLiquidSurface(ctx, c, r, x, y, terrain) {
        const palette = terrain.palette;
        const size = TILE_SIZE;
        const phase = this.terrainPhase || 0;

        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, size, size);
        ctx.clip();

        // Two mottling bands, crossed. See drawLiquidBand: they are periodic in
        // world space, so they carry across tile boundaries without a seam.
        this.drawLiquidBand(ctx, x, y, size, palette, TILE_SIZE * 6, 1, phase * 5);
        this.drawLiquidBand(ctx, x, y, size, palette, TILE_SIZE * 4.5, -1, phase * -3.5);

        ctx.globalAlpha = 1;

        switch (terrain.surface) {
            case 'molten': this.drawMoltenCrust(ctx, c, r, x, y, palette, phase); break;
            case 'sludge': this.drawSludgeBubbles(ctx, c, r, x, y, palette, phase); break;
            default:       this.drawWaterRipples(ctx, c, r, x, y, palette, phase); break;
        }

        ctx.restore();
    }

    /**
     * One band of mottling across a liquid tile.
     *
     * The reason this is a diagonal gradient anchored to a world lattice, rather
     * than the obvious blob centred on the tile, is that the obvious version draws
     * a grid. A wash positioned inside its own tile puts a bright centre in every
     * tile, and a lake of them comes out as a chequerboard -- the exact thing the
     * shoreline autotiling exists to avoid, reintroduced by the fill underneath it.
     *
     * Instead the gradient runs along a world diagonal with a fixed period, and its
     * endpoints are snapped to that period. Neighbouring tiles inside the same band
     * therefore compute an identical gradient and shade continuously; a tile on the
     * far side of a band boundary computes the next band along, whose start colour
     * is the previous one's end colour, so that seam is invisible too. Scrolling the
     * whole thing with `offset` then moves the mottling across the pool as one
     * surface rather than tile by tile.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context, clipped to the tile
     * @param {number} x - World X of the tile's top-left corner
     * @param {number} y - World Y of the tile's top-left corner
     * @param {number} size - Tile size
     * @param {Object} palette - The liquid's palette
     * @param {number} period - Band wavelength in world pixels
     * @param {number} slope - +1 for the "\" diagonal, -1 for "/"
     * @param {number} offset - How far the band has scrolled, in world pixels
     * @param {string} [peak] - Colour at the band's crest; the mid tone by default
     * @param {number} [alpha] - Strength of the band
     */
    drawLiquidBand(ctx, x, y, size, palette, period, slope, offset,
                   peak = palette.mid, alpha = 0.5) {
        // Where this tile sits along the band's axis, snapped down to a whole
        // period. `slope` picks which diagonal the axis runs on.
        const axis = slope > 0 ? (x + y) : (x - y);
        const start = Math.floor((axis - offset) / period) * period + offset;

        // A point on the axis at `start`, and one a period further along it.
        const originX = start / 2;
        const originY = slope > 0 ? start / 2 : -start / 2;
        const stepX = period / 2;
        const stepY = slope > 0 ? period / 2 : -period / 2;

        // Every tile lying in the same band gets an identical gradient -- `start` is
        // snapped to a whole period, so it is shared by definition -- and a screenful
        // of a pool spans only a handful of periods. Building one per tile meant a
        // gradient object allocated and validated for every liquid tile on screen,
        // twice a frame; keeping them for the pass turns that into a few.
        const key = `${start}|${peak}|${palette.deep}`;
        let band = this.bandGradients.get(key);
        if (!band) {
            band = ctx.createLinearGradient(originX, originY,
                                            originX + stepX, originY + stepY);
            // Starts and ends on the same colour, which is what makes consecutive
            // bands join without a step.
            band.addColorStop(0, palette.deep);
            band.addColorStop(0.5, peak);
            band.addColorStop(1, palette.deep);
            this.bandGradients.set(key, band);
        }

        ctx.globalAlpha = alpha;
        ctx.fillStyle = band;
        ctx.fillRect(x, y, size, size);
    }

    /**
     * Lava: a skin of cooled plates with the heat showing between them.
     *
     * Drawn as the plates rather than as the cracks, which is the way round that
     * works. Cracks drawn directly are strokes, and strokes at this scale come out
     * as a scatter of bright sticks lying on an orange floor; plates drawn over a
     * hot ground leave the gaps between them glowing, and the gaps are the shape
     * they should be because nothing chose them.
     *
     * The plates are static -- rock does not drift -- and the heat between them
     * breathes on the frame clock.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context, already clipped
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} x - World X of the tile's top-left corner
     * @param {number} y - World Y of the tile's top-left corner
     * @param {Object} palette - The liquid's palette
     * @param {number} phase - Frame clock in seconds
     */
    drawMoltenCrust(ctx, c, r, x, y, palette, phase) {
        const size = TILE_SIZE;

        // The heat first, so the plates have something to sit on. Laid down as a
        // third world-periodic band rather than as a glow centred on this tile:
        // a per-tile glow puts a bright spot in the middle of every square and the
        // lake comes out gridded, which is the trap drawLiquidBand exists to avoid.
        const heat = 0.72 + 0.16 * Math.sin(phase * 1.6);
        this.drawLiquidBand(ctx, x, y, size, palette, TILE_SIZE * 7.5, 1,
                            phase * -2.5, palette.hot, heat);

        // Plates. Overlapping and offset past the tile edge so they run on into the
        // neighbour rather than stopping at the seam.
        ctx.fillStyle = palette.crust;
        for (let i = 0; i < 5; i++) {
            const seedA = tileNoise(c, r, 20 + i);
            const seedB = tileNoise(c, r, 30 + i);

            ctx.globalAlpha = 0.62 + seedA * 0.3;
            ctx.beginPath();
            ctx.ellipse(x + size * (seedA * 1.15 - 0.08),
                        y + size * (seedB * 1.15 - 0.08),
                        size * (0.11 + seedB * 0.1),
                        size * (0.09 + seedA * 0.09),
                        seedA * Math.PI, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.globalAlpha = 1;
    }

    /**
     * Toxic waste: bubbles that rise, swell and pop.
     *
     * Each bubble is a ring rather than a disc -- a meniscus catching the light --
     * and it drifts upward on the frame clock, wrapping round when it leaves the
     * tile. That wrap is why a bubble may be cut off at a tile edge: it is about to
     * appear at the bottom of the tile above, which is what the neighbour draws.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context, already clipped
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} x - World X of the tile's top-left corner
     * @param {number} y - World Y of the tile's top-left corner
     * @param {Object} palette - The liquid's palette
     * @param {number} phase - Frame clock in seconds
     */
    drawSludgeBubbles(ctx, c, r, x, y, palette, phase) {
        const size = TILE_SIZE;

        ctx.strokeStyle = palette.hot;
        for (let i = 0; i < 2; i++) {
            const seedA = tileNoise(c, r, 40 + i);
            const seedB = tileNoise(c, r, 50 + i);

            const rise = (seedB + phase * (0.06 + seedA * 0.07)) % 1;
            const bubbleX = x + size * (0.15 + seedA * 0.7);
            const bubbleY = y + size * (1 - rise);
            // Swells as it rises, then vanishes at the top, which reads as a pop.
            const radius = size * (0.03 + seedA * 0.04) * (0.5 + rise);

            ctx.globalAlpha = 0.34 * Math.min(1, (1 - rise) * 3);
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.arc(bubbleX, bubbleY, radius, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    /**
     * Water: long ripples running across the surface.
     *
     * Drawn as wide, near-horizontal strokes rather than as anything circular. The
     * pattern repeats on a world-space period so ripples continue across a tile
     * boundary instead of restarting at it.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context, already clipped
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} x - World X of the tile's top-left corner
     * @param {number} y - World Y of the tile's top-left corner
     * @param {Object} palette - The liquid's palette
     * @param {number} phase - Frame clock in seconds
     */
    drawWaterRipples(ctx, c, r, x, y, palette, phase) {
        const size = TILE_SIZE;
        const span = size * 0.42;
        const period = size * 2.6;      // Distance between ripples along one line

        ctx.strokeStyle = palette.hot;
        ctx.lineCap = 'round';
        ctx.lineWidth = 1.6;

        for (let i = 0; i < 3; i++) {
            // Each line belongs to the WORLD row it sits in, not to this tile, and
            // is spaced along that row on a period of its own. Drawing one ripple
            // per tile instead -- which is the obvious way -- comes out as
            // wallpaper: an identical arc in the same place in every square, in
            // rows exactly a third of a tile apart.
            const line = r * 3 + i;
            const seed = tileNoise(0, line, 60);
            const lineY = y + size * ((i + 0.3 + seed * 0.55) / 3) +
                          Math.sin(phase * 0.9 + seed * 7) * size * 0.05;

            const slide = (phase * (5 + seed * 7) + seed * period) % period;
            const first = Math.floor((x - slide) / period) * period + slide;

            ctx.globalAlpha = 0.18 + 0.1 * Math.sin(phase * 1.4 + i + seed * 5);
            for (let k = 0; k <= 1; k++) {
                const startX = first + k * period;
                if (startX > x + size || startX + span < x) continue;
                ctx.beginPath();
                ctx.moveTo(startX, lineY);
                ctx.quadraticCurveTo(startX + span / 2, lineY - size * 0.07,
                                     startX + span, lineY);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }

    /**
     * The crust or shoreline where a pool ends.
     *
     * Drawn per SIDE from the neighbour mask, never as a border around the tile:
     * an edge is only an edge where the liquid stops, and a tile in the middle of a
     * lake gets nothing at all. The small squares handle the case two straight
     * bands cannot -- an inner corner, where the pool continues both north and west
     * but not north-west, and the crust has to turn.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} x - World X of the tile's top-left corner
     * @param {number} y - World Y of the tile's top-left corner
     * @param {number} mask - Neighbour mask of same-liquid tiles
     * @param {Object} terrain - Entry from TERRAIN
     * @param {boolean} isMemory - Draw at remembered brightness
     */
    drawLiquidShore(ctx, x, y, mask, terrain, isMemory, detail) {
        const size = TILE_SIZE;
        const band = Math.max(3, Math.round(size * 0.18));
        const dim = LIGHTING.MEMORY_BRIGHTNESS;
        const palette = terrain.palette;

        ctx.fillStyle = isMemory ? this.dimColor(palette.rim, dim) : palette.rim;

        if (!(mask & NB.N)) ctx.fillRect(x, y, size, band);
        if (!(mask & NB.S)) ctx.fillRect(x, y + size - band, size, band);
        if (!(mask & NB.W)) ctx.fillRect(x, y, band, size);
        if (!(mask & NB.E)) ctx.fillRect(x + size - band, y, band, size);

        if ((mask & NB.N) && (mask & NB.W) && !(mask & NB.NW)) ctx.fillRect(x, y, band, band);
        if ((mask & NB.N) && (mask & NB.E) && !(mask & NB.NE)) ctx.fillRect(x + size - band, y, band, band);
        if ((mask & NB.S) && (mask & NB.W) && !(mask & NB.SW)) ctx.fillRect(x, y + size - band, band, band);
        if ((mask & NB.S) && (mask & NB.E) && !(mask & NB.SE)) ctx.fillRect(x + size - band, y + size - band, band, band);

        if (!detail) return;

        // A hot line just inside the crust, where the molten body meets the cooled
        // edge. On water it is the same line at a fraction of the strength, and it
        // reads as the shallows.
        ctx.save();

        // Outside first: the bank is in shadow where it meets the floor, which is
        // what gives the pool a depth rather than looking painted on.
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = palette.crust;
        if (!(mask & NB.N)) ctx.fillRect(x, y, size, 2);
        if (!(mask & NB.S)) ctx.fillRect(x, y + size - 2, size, 2);
        if (!(mask & NB.W)) ctx.fillRect(x, y, 2, size);
        if (!(mask & NB.E)) ctx.fillRect(x + size - 2, y, 2, size);

        // Then the lit inner edge, where the liquid laps against the bank. Kept
        // low: at full strength this traces the pool's outline as a bright wire,
        // and a wire is the one thing a shoreline is not.
        ctx.globalAlpha = terrain.glow ? 0.22 : 0.1;
        ctx.fillStyle = palette.ember;
        if (!(mask & NB.N)) ctx.fillRect(x, y + band - 1, size, 2);
        if (!(mask & NB.S)) ctx.fillRect(x, y + size - band - 1, size, 2);
        if (!(mask & NB.W)) ctx.fillRect(x + band - 1, y, 2, size);
        if (!(mask & NB.E)) ctx.fillRect(x + size - band - 1, y, 2, size);
        ctx.restore();
    }

    /**
     * Adds the halo that self-luminous terrain throws onto its own surroundings.
     *
     * Purely cosmetic. What actually LIGHTS the room is the light source the same
     * tile contributes in js/lighting.js -- that one casts shadows, reveals items
     * and is remembered. This is the bloom over the top of it, which is why it is
     * composited additively and why it may safely spill onto the neighbours.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context, in world space
     * @param {Object} bounds - Tile range from computeVisibleTileBounds
     */
    drawTerrainBloom(ctx, bounds) {
        if (!this.allowEmissive) return;

        const map = this.gameState.gameMap;
        const radius = TILE_SIZE * 1.1;

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';

        for (let r = bounds.startRow; r < bounds.endRow; r++) {
            const row = map[r];
            if (!row) continue;

            for (let c = bounds.startCol; c < bounds.endCol; c++) {
                const terrain = TERRAIN[row[c]];
                if (!terrain || !terrain.glow) continue;

                const centreX = c * TILE_SIZE + TILE_SIZE / 2;
                const centreY = r * TILE_SIZE + TILE_SIZE / 2;
                ctx.drawImage(this.bloomSprite(terrain.glow.color, radius),
                              centreX - radius, centreY - radius);
            }
        }

        ctx.restore();
    }

    /**
     * The soft halo drawn over one tile of glowing terrain, as a reusable image.
     *
     * Every tile's halo is the same picture in a different place, so it is painted
     * once and stamped from then on. Built as a gradient per tile it cost a gradient
     * object allocated, validated and thrown away for every pool tile on screen,
     * twice a frame -- which on a room with several pools was most of what the
     * terrain cost at all.
     *
     * @param {string} color - The glow's `r,g,b` triple
     * @param {number} radius - Halo radius in world units
     * @returns {HTMLCanvasElement} A square sprite, `radius * 2` on a side
     */
    bloomSprite(color, radius) {
        if (!this.bloomSprites) this.bloomSprites = new Map();

        const size = Math.ceil(radius * 2);
        const key = `${color}|${size}`;
        let sprite = this.bloomSprites.get(key);
        if (sprite) return sprite;

        sprite = document.createElement('canvas');
        sprite.width = size;
        sprite.height = size;

        const paint = sprite.getContext('2d');
        const centre = size / 2;
        const glow = paint.createRadialGradient(centre, centre, 0, centre, centre, radius);
        glow.addColorStop(0, `rgba(${color},0.13)`);
        glow.addColorStop(0.5, `rgba(${color},0.05)`);
        glow.addColorStop(1, `rgba(${color},0)`);
        paint.fillStyle = glow;
        paint.fillRect(0, 0, size, size);

        this.bloomSprites.set(key, sprite);
        return sprite;
    }

    /**
     * Creates (or resizes) the offscreen layers the lighting composite needs.
     *
     * @param {number} width - Canvas width in pixels
     * @param {number} height - Canvas height in pixels
     */
    ensureRenderLayers(width, height) {
        if (!this.litCanvas || this.litCanvas.width !== width || this.litCanvas.height !== height) {
            this.litCanvas = document.createElement('canvas');
            this.litCanvas.width = width;
            this.litCanvas.height = height;
            this.litCtx = this.litCanvas.getContext('2d');
        }
        if (!this.maskCanvas || this.maskCanvas.width !== width || this.maskCanvas.height !== height) {
            this.maskCanvas = document.createElement('canvas');
            this.maskCanvas.width = width;
            this.maskCanvas.height = height;
            this.maskCtx = this.maskCanvas.getContext('2d');
        }
        if (!this.scratchCanvas || this.scratchCanvas.width !== width || this.scratchCanvas.height !== height) {
            this.scratchCanvas = document.createElement('canvas');
            this.scratchCanvas.width = width;
            this.scratchCanvas.height = height;
            this.scratchCtx = this.scratchCanvas.getContext('2d');
        }
        if (!this.memCanvas || this.memCanvas.width !== width || this.memCanvas.height !== height) {
            this.memCanvas = document.createElement('canvas');
            this.memCanvas.width = width;
            this.memCanvas.height = height;
            this.memCtx = this.memCanvas.getContext('2d');
        }
        if (!this.senseCanvas || this.senseCanvas.width !== width || this.senseCanvas.height !== height) {
            this.senseCanvas = document.createElement('canvas');
            this.senseCanvas.width = width;
            this.senseCanvas.height = height;
            this.senseCtx = this.senseCanvas.getContext('2d');
        }
        if (!this.senseMaskCanvas || this.senseMaskCanvas.width !== width ||
            this.senseMaskCanvas.height !== height) {
            this.senseMaskCanvas = document.createElement('canvas');
            this.senseMaskCanvas.width = width;
            this.senseMaskCanvas.height = height;
            this.senseMaskCtx = this.senseMaskCanvas.getContext('2d');
        }
        // Where a light's origins are summed before being softened in one pass.
        // Blurring each origin separately would mean a full-surface blur per origin,
        // and there are LIGHT_ORIGINS of them per light per frame.
        if (!this.stageCanvas || this.stageCanvas.width !== width || this.stageCanvas.height !== height) {
            this.stageCanvas = document.createElement('canvas');
            this.stageCanvas.width = width;
            this.stageCanvas.height = height;
            this.stageCtx = this.stageCanvas.getContext('2d');
        }

        // The seen surface is world-sized, not screen-sized: it has to persist as
        // the camera moves. It is discarded whenever lighting memory is reset.
        const worldWidth = MAP_COLS * TILE_SIZE;
        const worldHeight = MAP_ROWS * TILE_SIZE;
        const epoch = getLightingGeneration();

        if (!this.seenCanvas || this.seenCanvas.width !== worldWidth ||
            this.seenCanvas.height !== worldHeight) {
            this.seenCanvas = document.createElement('canvas');
            this.seenCanvas.width = worldWidth;
            this.seenCanvas.height = worldHeight;
            this.seenCtx = this.seenCanvas.getContext('2d');
            this.seenEpoch = -1;
        }

        // One pixel per tile, blown up when it is drawn. Tiles are stamped into it
        // as they are first seen and left alone afterwards, so the cost of the
        // minimap is a scan for changes plus one scaled blit -- not two thousand
        // rectangles a frame.
        if (!this.minimapCanvas) {
            this.minimapCanvas = document.createElement('canvas');
            this.minimapCanvas.width = MAP_COLS;
            this.minimapCanvas.height = MAP_ROWS;
            this.minimapCtx = this.minimapCanvas.getContext('2d');
            this.minimapEpoch = -1;
        }

        if (this.minimapEpoch !== epoch) {
            this.minimapCtx.setTransform(1, 0, 0, 1, 0, 0);
            this.minimapCtx.clearRect(0, 0, MAP_COLS, MAP_ROWS);
            // What each tile was last stamped as. 255 means "never stamped", which
            // no tile type collides with, so a door that opens or a pickup that is
            // taken re-stamps itself rather than leaving the map lying.
            this.minimapStamped = new Uint8Array(MAP_COLS * MAP_ROWS).fill(255);
            this.minimapEpoch = epoch;
        }

        // The player's line of sight, as a stencil. Built after everything else
        // because the render test names layers by creation order.
        if (!this.sightMaskCanvas || this.sightMaskCanvas.width !== width ||
            this.sightMaskCanvas.height !== height) {
            this.sightMaskCanvas = document.createElement('canvas');
            this.sightMaskCanvas.width = width;
            this.sightMaskCanvas.height = height;
            this.sightMaskCtx = this.sightMaskCanvas.getContext('2d');
        }

        if (this.seenEpoch !== epoch) {
            // Opaque black, not transparent. The surface stores how brightly each
            // point has ever been lit as a GREY LEVEL rather than as alpha, which is
            // what lets it be combined with `lighten` (a true maximum). Alpha
            // compositing has no maximum operator -- every blend that works on alpha
            // accumulates, and accumulation is what made explored area keep creeping
            // outward while the player stood still.
            this.seenCtx.setTransform(1, 0, 0, 1, 0, 0);
            this.seenCtx.globalCompositeOperation = 'source-over';
            this.seenCtx.fillStyle = '#000';
            this.seenCtx.fillRect(0, 0, worldWidth, worldHeight);
            this.seenEpoch = epoch;
        }
    }

    /**
     * Blits just the visible part of the world-sized seen surface.
     *
     * Source and destination are the same world rectangle (the caller is already in
     * world space), so this is equivalent to drawing the whole surface -- it simply
     * avoids handing the compositor a 2000x1600 texture every frame when only a
     * screenful of it can matter.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context, in world space
     * @param {Object} player - Player entity (camera centre)
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     */
    drawSeenSurfaceRegion(ctx, player, viewWidth, viewHeight) {
        const worldWidth = MAP_COLS * TILE_SIZE;
        const worldHeight = MAP_ROWS * TILE_SIZE;

        const visibleWidth = viewWidth / this.zoomLevel;
        const visibleHeight = viewHeight / this.zoomLevel;

        let sx = Math.max(0, Math.floor(player.x - visibleWidth / 2));
        let sy = Math.max(0, Math.floor(player.y - visibleHeight / 2));
        let sw = Math.min(worldWidth - sx, Math.ceil(visibleWidth) + 2);
        let sh = Math.min(worldHeight - sy, Math.ceil(visibleHeight) + 2);

        if (sw <= 0 || sh <= 0) return;
        ctx.drawImage(this.seenCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
    }

    /**
     * Folds this frame's light into the persistent record of everywhere the player
     * has seen, keeping the BRIGHTEST value each point has ever reached.
     *
     * The mask carries light as alpha, and canvas offers no way to take a maximum of
     * alpha -- `lighter` adds and `source-over` blends, and both converge on fully
     * lit under repetition. Stamping the same shape every frame therefore inflated
     * dim edges to fully explored in about fifteen frames, so the revealed area kept
     * growing after the player stopped and its boundary settled into a circle around
     * the glow rather than the shape of the light.
     *
     * The mask is converted to opaque grey (level = light) and combined with
     * `lighten`, which is a genuine per-channel maximum and is idempotent: stamping
     * an unchanged view a thousand times changes nothing.
     *
     * @param {Object} player - Player entity (camera centre)
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     */
    stampSeenSurface(player, viewWidth, viewHeight, box) {
        const seen = this.seenCtx;
        const scratch = this.scratchCtx;
        if (!seen || !scratch) return;
        if (!box || box.w <= 0 || box.h <= 0) return;

        // Mask (white + alpha) -> opaque grey, so `lighten` sees a real value.
        // Every step is confined to the rectangle the masks reached: this is the
        // gain loop, so whatever it does it does MEMORY_GAIN times over.
        scratch.setTransform(1, 0, 0, 1, 0, 0);
        scratch.globalCompositeOperation = 'source-over';
        scratch.fillStyle = '#000';
        scratch.fillRect(box.x, box.y, box.w, box.h);

        // Drawn repeatedly to lift dim light towards a solid memory. This is a
        // per-frame temporary, so the value handed to the maximum below is identical
        // every frame for an unchanged view -- the boost does not accumulate.
        //
        // The vision arc is stamped alongside the beam: what you made out of a room
        // in passing is still something you now know is there, and remembering only
        // what the torch touched left holes in the map exactly where the player had
        // already looked.
        //
        // At its own, much lower gain, so a glimpse is remembered as a glimpse. Run
        // at the beam's gain it saturated identically, and geometry the player had
        // only sensed came back from memory in full colour -- under the wash whose
        // job is to take that colour away.
        scratch.globalCompositeOperation = 'lighter';
        const beamGain = Math.max(1, LIGHTING.MEMORY_GAIN);
        const senseGain = Math.max(1, LIGHTING.MEMORY_SENSE_GAIN);
        for (let i = 0; i < beamGain; i++) {
            scratch.drawImage(this.maskCanvas, box.x, box.y, box.w, box.h,
                                               box.x, box.y, box.w, box.h);
        }
        for (let i = 0; this.senseMaskCanvas && i < senseGain; i++) {
            scratch.drawImage(this.senseMaskCanvas, box.x, box.y, box.w, box.h,
                                                    box.x, box.y, box.w, box.h);
        }
        scratch.globalCompositeOperation = 'source-over';

        // Black areas of the scratch leave the record untouched: max(dst, 0) = dst
        seen.setTransform(1, 0, 0, 1, 0, 0);
        seen.save();
        seen.translate(player.x, player.y);
        seen.scale(1 / this.zoomLevel, 1 / this.zoomLevel);
        seen.translate(-viewWidth / 2, -viewHeight / 2);
        seen.globalCompositeOperation = 'lighten';
        seen.drawImage(this.scratchCanvas, box.x, box.y, box.w, box.h,
                                           box.x, box.y, box.w, box.h);
        seen.restore();
        seen.globalCompositeOperation = 'source-over';
    }

    /**
     * Radial gradient carrying a light's distance falloff.
     *
     * The centre and radius are given in whatever space the caller is drawing in --
     * world for the open-ground pass, device pixels for the wall pass.
     *
     * @param {CanvasRenderingContext2D} ctx - Context to create the gradient on
     * @param {Object} light - Light source descriptor
     * @param {number} centreX - Gradient centre, in the caller's space
     * @param {number} centreY - Gradient centre, in the caller's space
     * @param {number} radius - The light's range, in the caller's space
     * @returns {CanvasGradient} Gradient centred on the light
     */
    createLightGradient(ctx, light, centreX, centreY, radius) {
        const gradient = ctx.createRadialGradient(centreX, centreY, 0, centreX, centreY, radius);
        const stops = light.stops || [[0, 1], [1, 0]];
        for (const stop of stops) {
            const alpha = stop[1] * light.intensity;
            gradient.addColorStop(stop[0], 'rgba(255,255,255,' + alpha + ')');
        }
        return gradient;
    }

    /**
     * A tile's rectangle in device pixels, with its edges snapped to whole pixels.
     *
     * Snapping matters because each wall tile is laid down by its own drawImage, and
     * the camera sits at a fractional position, so a tile edge lands mid-pixel. Two
     * neighbours then each cover part of that pixel and are composited with
     * source-over, which does not add back up: at a half-pixel offset the shared
     * pixel reaches 0.75, leaving a dark seam around every tile, and an outer edge
     * with no neighbour to complete it gets half. Rounding the SHARED EDGE -- rather
     * than the position and the size separately -- keeps neighbours exactly abutting
     * with no gap and no overlap.
     *
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} zoom - Current zoom level
     * @param {number} offsetX - World-to-screen X offset
     * @param {number} offsetY - World-to-screen Y offset
     * @returns {Object} `{ left, top, width, height }` in whole device pixels
     */
    tileScreenRect(c, r, zoom, offsetX, offsetY) {
        const left = Math.round(c * TILE_SIZE * zoom + offsetX);
        const top = Math.round(r * TILE_SIZE * zoom + offsetY);
        const right = Math.round((c + 1) * TILE_SIZE * zoom + offsetX);
        const bottom = Math.round((r + 1) * TILE_SIZE * zoom + offsetY);
        return { left, top, width: right - left, height: bottom - top };
    }

    /**
     * The screen rectangle a source can affect, in whole device pixels.
     *
     * Every pass in the mask builder used to run over the whole canvas whatever it
     * was drawing, which meant the player's glow -- three tiles across -- paid the
     * same blur, the same gradient fill and the same composite as a source covering
     * the screen. On a full-window canvas that is a couple of million pixels of work
     * to light a circle a couple of hundred across, several times a frame.
     *
     * A cone is bounded as a SECTOR rather than as its whole circle: the apex, the
     * two arc ends, and whichever of the four axis directions fall inside the arc,
     * which are the only places a sector can touch its own bounding box. For a beam
     * that is roughly half the area of the circle it sits in.
     *
     * Generously padded, because a source draws past its own fan: wall tiles are
     * collected a tile beyond its range, each is read from a strip standing clear of
     * it, and the blur spreads further still. Too large only costs a little work;
     * too small would clip light off at a straight edge.
     *
     * @param {Object} light - Light or vision source descriptor
     * @param {Object} player - Player entity (camera centre)
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     * @returns {Object} `{ x, y, w, h }` clamped to the canvas
     */
    sourceScreenBounds(light, player, viewWidth, viewHeight) {
        const zoom = this.zoomLevel;
        const centreX = (light.x - player.x) * zoom + viewWidth / 2;
        const centreY = (light.y - player.y) * zoom + viewHeight / 2;
        const radius = light.range * zoom;

        let minX = centreX - radius, maxX = centreX + radius;
        let minY = centreY - radius, maxY = centreY + radius;

        // The cast half-angle, not the visible one: the fan really is drawn out to
        // the margin, and the conic profile only zeroes it afterwards.
        const half = light.kind === 'cone'
            ? Math.min(Math.PI, light.halfAngle +
                       (light.castMargin ?? LIGHTING.CONE_CAST_MARGIN))
            : Math.PI;

        if (half < Math.PI) {
            minX = maxX = centreX;
            minY = maxY = centreY;
            const include = (angle) => {
                const x = centreX + Math.cos(angle) * radius;
                const y = centreY + Math.sin(angle) * radius;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            };
            include(light.direction - half);
            include(light.direction + half);
            for (let k = 0; k < 4; k++) {
                const axis = k * Math.PI / 2;
                let delta = axis - light.direction;
                delta = Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
                if (delta <= half) include(axis);
            }
        }

        const softness = light.softnessPx ?? LIGHTING.EDGE_SOFTNESS_PX;
        const pad = (2 * TILE_SIZE + LIGHTING.WALL_FACE_SAMPLE_PX) * zoom + softness * 3 + 2;

        const left = Math.max(0, Math.floor(minX - pad));
        const top = Math.max(0, Math.floor(minY - pad));
        const right = Math.min(viewWidth, Math.ceil(maxX + pad));
        const bottom = Math.min(viewHeight, Math.ceil(maxY + pad));

        return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
    }

    /**
     * The smallest rectangle covering two others.
     *
     * @param {Object} a - `{ x, y, w, h }`, or null
     * @param {Object} b - `{ x, y, w, h }`
     * @returns {Object} `{ x, y, w, h }`
     */
    unionBounds(a, b) {
        if (!a) return b;
        if (!b) return a;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        return {
            x, y,
            w: Math.max(a.x + a.w, b.x + b.w) - x,
            h: Math.max(a.y + a.h, b.y + b.h) - y,
        };
    }

    /**
     * Adds one source's coverage of OPEN GROUND to the staging layer: its shadow
     * fan, filled with its own distance falloff.
     *
     * The falloff is the fan's FILL rather than something multiplied through
     * afterwards, and that is the whole reason several sources can share a layer:
     * `destination-in` would scale everything already on it, not just this source.
     * It costs nothing either way -- a canvas radial gradient is exactly the falloff
     * curve.
     *
     * Blurring happens once for the whole group, after this, so nothing here is
     * softened yet. Walls are not touched: each wall face is measured directly, by
     * paintWallSpans().
     *
     * @param {CanvasRenderingContext2D} stage - Staging layer, accumulated additively
     * @param {Object} polygon - Shadow polygon for this source
     * @param {Object} player - Player entity (camera centre)
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     */
    fillLightShape(stage, polygon, player, viewWidth, viewHeight) {
        if (!polygon.distances.length) return;

        const light = polygon.light;

        stage.save();
        this.applyWorldTransform(stage, player, viewWidth, viewHeight);
        stage.fillStyle = this.createLightGradient(stage, light, light.x, light.y, light.range);
        stage.globalCompositeOperation = 'lighter';
        // Cast from a small disc of origins whose fans are averaged, so a corner
        // fades across a penumbra instead of cutting at a knife edge.
        stage.globalAlpha = 1 / polygon.origins.length;
        for (const origin of polygon.origins) {
            this.traceLightFan(stage, polygon, origin);
            stage.fill();
        }
        stage.globalAlpha = 1;
        stage.globalCompositeOperation = 'source-over';
        stage.restore();
    }

    /**
     * The runs of lit wall faces a source paints, ready for paintWallSpans().
     *
     * @param {Object} polygon - Shadow polygon for this source
     * @param {Object} bounds - Tile range from computeVisibleTileBounds
     * @returns {Array<number>} Face runs, see faceRuns()
     */
    collectWallSpans(polygon, bounds) {
        if (!polygon.distances.length) return [];
        const faces = this.collectLitWallFaces(polygon, bounds);
        if (!faces.length) return [];
        // Adjacent tiles sharing a face direction are shaded as one span, so a
        // ten-tile wall costs one gradient rather than ten.
        return this.faceRuns(faces);
    }


    /**
     * Wipes every wall span a source lights, before any of them are painted.
     *
     * Separate from painting because a group of sources shares a layer. The floor
     * fan blurs a few pixels past each wall's near face and has to be wiped off it,
     * but wiping as part of painting would let the last source in the group erase
     * what the others had already put on the same tile.
     *
     * @param {CanvasRenderingContext2D} target - Layer holding the group's coverage
     * @param {Array<number>} runs - Face runs from collectWallSpans()
     * @param {Object} player - Player entity (camera centre)
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     */
    clearWallSpans(target, runs, player, viewWidth, viewHeight) {
        if (!runs.length) return;
        const zoom = this.zoomLevel;
        const offsetX = viewWidth / 2 - player.x * zoom;
        const offsetY = viewHeight / 2 - player.y * zoom;

        target.save();
        target.setTransform(1, 0, 0, 1, 0, 0);
        this.clearTiles(target, runs, zoom, offsetX, offsetY);
        target.restore();
    }

    /**
     * Lights the first layer of wall and door tiles around the space the player can
     * walk in, by measuring each tile's exposed FACE.
     *
     * A face is the side of a wall block that fronts walkable ground. It is asked
     * exactly what a floor tile is asked -- can this source see the ground just in
     * front of it, and how brightly -- and the brightest face a tile has is the one
     * it is drawn from. lighting.js decides that (litWallFace); this only draws it,
     * so the tile map and the picture cannot disagree about which side is lit.
     *
     * That is where the sidedness comes from. Two rooms separated by a two-block
     * wall have one block fronting each room, and a lamp in one room can only see
     * its own; the far block is behind solid rock and stays dark. A spur jutting
     * into a room has a face on either side, and which lights up depends on where
     * the lamp is -- including the case where it reaches round the end of the spur
     * and genuinely lights both.
     *
     * Each run of tiles is shaded by a linear gradient sampled along its face, which
     * is what keeps a pillar's shadow crossing a wall instead of the wall switching
     * on and off as a unit. The angular profile is NOT applied here: the conic
     * gradient in applyAngularFalloff() puts it on per pixel, the same as it does
     * for the floor.
     *
     * @param {CanvasRenderingContext2D} target - Layer holding this source's coverage
     * @param {Array<number>} runs - Face runs from collectWallSpans()
     * @param {Object} polygon - Shadow polygon for this source
     * @param {Object} player - Player entity (camera centre)
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     */
    paintWallSpans(target, runs, polygon, player, viewWidth, viewHeight) {
        if (!runs.length) return;
        if (this.counts) this.counts.spans += runs.length / 6;

        const zoom = this.zoomLevel;
        const offsetX = viewWidth / 2 - player.x * zoom;
        const offsetY = viewHeight / 2 - player.y * zoom;
        const perTile = Math.max(1, LIGHTING.WALL_FACE_SAMPLES_PER_TILE);
        const tolerance = TILE_SIZE * 0.15;

        target.save();
        target.setTransform(1, 0, 0, 1, 0, 0);
        // Additive, so two lamps falling on the same wall brighten it, exactly as
        // they do the floor at its foot.
        target.globalCompositeOperation = 'lighter';

        for (let n = 0; n < runs.length; n += 6) {
            const rect = this.runScreenRect(runs, n, zoom, offsetX, offsetY);
            const width = rect.right - rect.left;
            const height = rect.bottom - rect.top;
            if (width <= 0 || height <= 0) continue;
            if (rect.right <= 0 || rect.bottom <= 0 ||
                rect.left >= viewWidth || rect.top >= viewHeight) continue;

            const c0 = runs[n], r0 = runs[n + 1], c1 = runs[n + 2], r1 = runs[n + 3];
            const faceX = runs[n + 4], faceY = runs[n + 5];
            const along = faceX && faceY ? 0 : (faceX ? r1 - r0 : c1 - c0) + 1;

            if (along === 0) {
                // A corner tile fronts the room at a single vertex, so there is no
                // direction to shade along -- one value covers it.
                const at = wallFaceSamplePoint(c0, r0, faceX, faceY);
                const value = radialLightAt(polygon, at.x, at.y, tolerance);
                if (value <= 0) continue;
                target.fillStyle = `rgba(255,255,255,${value.toFixed(4)})`;
                target.fillRect(rect.left, rect.top, width, height);
                continue;
            }

            const samples = along * perTile;
            const first = wallFaceSamplePoint(c0, r0, faceX, faceY);
            const last = wallFaceSamplePoint(c1, r1, faceX, faceY);

            const gradient = faceX
                ? target.createLinearGradient(rect.left, rect.top, rect.left, rect.bottom)
                : target.createLinearGradient(rect.left, rect.top, rect.right, rect.top);

            // Sampled at tile centres and between them, then extended half a tile to
            // each end so the span's outer edges are shaded rather than extrapolated.
            const startX = first.x - (faceX ? 0 : TILE_SIZE / 2);
            const startY = first.y - (faceX ? TILE_SIZE / 2 : 0);
            const endX = last.x + (faceX ? 0 : TILE_SIZE / 2);
            const endY = last.y + (faceX ? TILE_SIZE / 2 : 0);

            let anyLight = false;
            for (let i = 0; i <= samples; i++) {
                const t = i / samples;
                const value = radialLightAt(polygon,
                    startX + (endX - startX) * t,
                    startY + (endY - startY) * t, tolerance);
                if (value > 0) anyLight = true;
                gradient.addColorStop(t, `rgba(255,255,255,${value.toFixed(4)})`);
            }
            if (!anyLight) continue;

            target.fillStyle = gradient;
            target.fillRect(rect.left, rect.top, width, height);
        }

        target.restore();
    }

    /**
     * Collapses a face list into RUNS: spans of adjacent wall tiles sharing one face
     * direction, which can be drawn in a single call each.
     *
     * The wall pass costs a wipe and a shaded fill per entry, so this is what keeps
     * it proportional to the number of WALLS rather than the number of tiles. Rooms
     * and corridors are made of long straight walls, so the entries collapse hard: a
     * ten-tile wall facing the room is one span, not ten.
     *
     * Merging is exact rather than an approximation, because a face is shaded ALONG
     * its own axis and uniformly across it. The gradient run over a span passes
     * through the same samples, at the same places, that each tile's own gradient
     * would have. The snapped tile rectangles abut exactly, which is what makes the
     * spans seamless.
     *
     * @param {Array<number>} faces - Flat column, row, faceX, faceY quadruples
     * @returns {Array<number>} Flat c0, r0, c1, r1, faceX, faceY sextuples, each
     *     covering the inclusive tile span from (c0, r0) to (c1, r1)
     */
    faceRuns(faces) {
        // One bucket per direction, so runs come out in the order a single tile's
        // faces were listed in: up, down, left, right. That matters because a tile
        // with two exposed faces is drawn twice and the last one wins, and this
        // keeps which one that is unchanged.
        const up = new Map(), down = new Map();       // row -> columns
        const left = new Map(), right = new Map();    // column -> rows

        for (let n = 0; n < faces.length; n += 4) {
            const c = faces[n], r = faces[n + 1];
            const faceX = faces[n + 2], faceY = faces[n + 3];

            // A corner reads a single vertex and floods one tile from it. There is
            // no axis to run along, so it stands alone.
            if (faceX && faceY) continue;

            const bucket = faceX ? (faceX === 1 ? right : left)
                                 : (faceY === 1 ? down : up);
            const key = faceX ? c : r;
            const along = faceX ? r : c;

            let list = bucket.get(key);
            if (!list) bucket.set(key, list = []);
            list.push(along);
        }

        const runs = [];
        const flush = (bucket, faceX, faceY) => {
            for (const [key, list] of bucket) {
                // collectLitWallFaces walks the map row by row, so these arrive in
                // increasing order already. If that ever stops being true the runs
                // simply come out shorter -- never wrong, just less merged.
                let start = list[0], prev = start;
                for (let i = 1; i <= list.length; i++) {
                    const value = list[i];
                    if (value === prev + 1) { prev = value; continue; }
                    if (faceX) runs.push(key, start, key, prev, faceX, faceY);
                    else       runs.push(start, key, prev, key, faceX, faceY);
                    start = prev = value;
                }
            }
        };

        flush(up, 0, -1);
        flush(down, 0, 1);
        flush(left, -1, 0);
        flush(right, 1, 0);

        for (let n = 0; n < faces.length; n += 4) {
            if (faces[n + 2] && faces[n + 3]) {
                runs.push(faces[n], faces[n + 1], faces[n], faces[n + 1],
                          faces[n + 2], faces[n + 3]);
            }
        }

        return runs;
    }

    /**
     * The screen rectangle spanned by a run, in whole device pixels.
     *
     * @param {Array<number>} runs - Flat run list
     * @param {number} n - Index of the run's first element
     * @param {number} zoom - Current zoom level
     * @param {number} offsetX - World-to-screen X offset
     * @param {number} offsetY - World-to-screen Y offset
     * @returns {Object} `{ left, top, right, bottom }` in device pixels
     */
    runScreenRect(runs, n, zoom, offsetX, offsetY) {
        const first = this.tileScreenRect(runs[n], runs[n + 1], zoom, offsetX, offsetY);
        const last = this.tileScreenRect(runs[n + 2], runs[n + 3], zoom, offsetX, offsetY);
        return {
            left: first.left,
            top: first.top,
            right: last.left + last.width,
            bottom: last.top + last.height,
        };
    }

    /**
     * Clears every tile a run covers, in device pixels.
     *
     * A tile with two exposed faces belongs to two runs and so is cleared twice,
     * which costs a little and changes nothing.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context, identity transform
     * @param {Array<number>} runs - Face runs from faceRuns()
     * @param {number} zoom - Current zoom level
     * @param {number} offsetX - World-to-screen X offset
     * @param {number} offsetY - World-to-screen Y offset
     */
    clearTiles(ctx, runs, zoom, offsetX, offsetY) {
        for (let n = 0; n < runs.length; n += 6) {
            const box = this.runScreenRect(runs, n, zoom, offsetX, offsetY);
            ctx.clearRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
        }
    }

    /**
     * The wall and door tiles this source actually lights, and which face of each.
     *
     * One entry per tile, not per face: a tile is drawn once, from whichever of its
     * faces the source sees best. lighting.js owns that choice (litWallFace), so
     * what is drawn and what the tile light map records can never disagree.
     *
     * Tiles the source cannot see are not returned at all. That is a change of kind
     * from the old collector, which handed back every wall in range of the beam and
     * left the shading to discover they were dark -- in a room full of pillars most
     * of them were, and each still cost a full set of draws. It is safe to decide it
     * here because what comes back is a BRIGHTNESS, not a yes or no: a wall the beam
     * is sweeping onto fades up from zero rather than appearing.
     *
     * @param {Object} polygon - Shadow polygon for one source
     * @param {Object} bounds - Tile range from computeVisibleTileBounds
     * @returns {Array<number>} Flat column, row, faceX, faceY quadruples, where the
     *     face vector points out of the tile into the walkable ground it fronts.
     *     Both components are set when the tile fronts that ground only at a corner.
     */
    collectLitWallFaces(polygon, bounds) {
        const map = this.gameState.gameMap;
        const faces = [];
        if (!map) return faces;

        // Nothing outside the source's own reach can be lit by it. Worth checking up
        // front: the glow only spans three tiles, so without this every source walked
        // the whole viewport.
        const light = polygon.light;
        const reach = light.range + TILE_SIZE;
        const minCol = Math.max(bounds.startCol, Math.floor((light.x - reach) / TILE_SIZE));
        const maxCol = Math.min(bounds.endCol - 1, Math.floor((light.x + reach) / TILE_SIZE));
        const minRow = Math.max(bounds.startRow, Math.floor((light.y - reach) / TILE_SIZE));
        const maxRow = Math.min(bounds.endRow - 1, Math.floor((light.y + reach) / TILE_SIZE));

        for (let r = minRow; r <= maxRow; r++) {
            const row = map[r];
            if (!row) continue;

            for (let c = minCol; c <= maxCol; c++) {
                if (!isOpaqueTile(row[c])) continue;
                // A cheap reject before the real test, which costs a ray lookup per
                // face: range and, for a beam, whether any corner of the tile falls
                // inside the arc at all.
                if (!this.tileCouldBeLit(light, c, r)) continue;

                const face = litWallFace(polygon, map, c, r);
                if (face) faces.push(c, r, face.faceX, face.faceY);
            }
        }
        return faces;
    }

    /**
     * Whether a light could put any light on a tile at all, ignoring obstacles.
     *
     * Purely a cost filter, so it errs towards yes: a tile it wrongly admits is
     * simply read and found dark, while one it wrongly rejects leaves a hard-edged
     * hole. Corners are tested rather than the centre so a tile straddling the edge
     * of a beam is kept.
     *
     * @param {Object} light - Light source descriptor
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @returns {boolean} True if the tile is worth reading
     */
    tileCouldBeLit(light, c, r) {
        const x = c * TILE_SIZE;
        const y = r * TILE_SIZE;

        // Nearest point of the tile, so a tile the light only clips still counts
        const nearX = Math.max(x, Math.min(light.x, x + TILE_SIZE));
        const nearY = Math.max(y, Math.min(light.y, y + TILE_SIZE));
        const nearDx = nearX - light.x, nearDy = nearY - light.y;
        const limitDistance = light.range + TILE_SIZE;
        if (nearDx * nearDx + nearDy * nearDy > limitDistance * limitDistance) return false;

        if (light.kind !== 'cone') return true;

        const limit = light.halfAngle + (light.castMargin ?? LIGHTING.CONE_CAST_MARGIN);
        for (let k = 0; k < 4; k++) {
            const cx = x + (k & 1) * TILE_SIZE;
            const cy = y + (k >> 1) * TILE_SIZE;
            let delta = Math.atan2(cy - light.y, cx - light.x) - light.direction;
            delta = Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
            if (delta <= limit) return true;
        }
        return false;
    }

    /**
     * Multiplies a light's coverage by its angular profile, fading the beam out
     * towards its rim.
     *
     * Uses a conic gradient composited with `destination-in`, which scales the alpha
     * already on the layer. Approximating the same shape by stacking progressively
     * narrower fans produced one flat step per fan -- six of them spanning 8 degrees
     * and 56 pixels each, far wider than the blur could hide, so the beam's edge
     * visibly stairstepped.
     *
     * @param {CanvasRenderingContext2D} ctx - Layer holding one light's coverage
     * @param {Object} light - Light source descriptor
     * @param {Object} player - Player entity (camera centre)
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     */
    applyAngularFalloff(ctx, light, player, viewWidth, viewHeight, box) {
        if (light.kind !== 'cone') return;
        // Per-source, matching angularFactor() in lighting.js -- peripheral vision
        // fades over a wider band than the flashlight, because the limit of what
        // can be made out is not an edge the way a beam's rim is.
        const rimSoftness = light.rimSoftness ?? LIGHTING.CONE_RIM_SOFTNESS;
        if (rimSoftness <= 0) return;
        // Older canvas implementations lack conic gradients; the beam keeps a hard
        // rim there rather than losing the light altogether.
        if (typeof ctx.createConicGradient !== 'function') return;

        const zoom = this.zoomLevel;
        const screenX = (light.x - player.x) * zoom + viewWidth / 2;
        const screenY = (light.y - player.y) * zoom + viewHeight / 2;

        // Start half a turn behind the beam so it sits in the middle of the ramp and
        // never straddles the gradient's 0/1 seam.
        const gradient = ctx.createConicGradient(light.direction - Math.PI, screenX, screenY);

        const halfTurn = light.halfAngle / (Math.PI * 2);
        const core = halfTurn * (1 - rimSoftness);

        gradient.addColorStop(0, 'rgba(255,255,255,0)');
        gradient.addColorStop(Math.max(0, 0.5 - halfTurn), 'rgba(255,255,255,0)');
        gradient.addColorStop(0.5 - core, 'rgba(255,255,255,1)');
        gradient.addColorStop(0.5 + core, 'rgba(255,255,255,1)');
        gradient.addColorStop(Math.min(1, 0.5 + halfTurn), 'rgba(255,255,255,0)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.fillStyle = gradient;
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.globalCompositeOperation = 'source-over';
    }

    /**
     * Builds the path for one origin's shadow polygon.
     *
     * Ray directions come from the polygon's shared table (rayDirection) rather
     * than a sin and a cos per vertex: with five origins per light this path is
     * traced several thousand vertices a frame.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context, in world space
     * @param {Object} polygon - Shadow polygon
     * @param {Object} origin - Which origin of the light to trace from
     */
    traceLightFan(ctx, polygon, origin) {
        const { light, isFullCircle } = polygon;
        const from = origin || polygon.origins[0];
        const distances = from.distances;
        const dir = this.rayScratch || (this.rayScratch = { x: 0, y: 0 });

        ctx.beginPath();
        if (!isFullCircle) ctx.moveTo(from.x, from.y);

        for (let i = 0; i < distances.length; i++) {
            rayDirection(polygon, i, dir);
            const distance = Math.min(distances[i], light.range);
            const px = from.x + dir.x * distance;
            const py = from.y + dir.y * distance;
            if (i === 0 && isFullCircle) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
    }

    /**
     * Builds the light mask: opaque where the world is lit, transparent where it is
     * not, with soft gradient edges.
     *
     * Each source is resolved on its own layer so its angular profile can be
     * multiplied in without touching the others, then added to the mask. Sources
     * accumulate additively, so overlapping ones brighten each other.
     *
     * Used for both masks the frame needs: the light mask, and the peripheral
     * vision mask. Vision is occluded by the same geometry and shaped by the same
     * cone maths, so giving it its own copy of this would only be a way for the two
     * to drift apart -- and any drift shows up directly as a seam where the arc
     * crosses the beam.
     *
     * @param {CanvasRenderingContext2D} mask - Mask layer to build into
     * @param {Array<Object>} polygons - Shadow polygons from updateLighting
     * @param {Object} bounds - Tile range from computeVisibleTileBounds
     * @param {Object} player - Player entity (camera centre)
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     * @param {HTMLCanvasElement} [gate] - Sight mask; sources flagged `gated`
     *        are multiplied through it so they show only within line of sight
     */
    buildMask(mask, polygons, bounds, player, viewWidth, viewHeight, gate = null) {
        const scratch = this.scratchCtx;

        mask.setTransform(1, 0, 0, 1, 0, 0);
        mask.clearRect(0, 0, viewWidth, viewHeight);

        // A source needs a pass to itself only if something has to be multiplied
        // through it afterwards -- which now means only a beam's angular profile.
        // Everything else just adds, so all of it can share one pass. On a level lit
        // by lava that is the difference between a pass per pool and a single pass
        // for the lot, and a pass is a blur and a composite over the screen.
        //
        // Grouped by softness because the blur is what the pass is built around,
        // and by whether the source is gated, because the gate is applied to the
        // whole pass.
        const plain = new Map();
        const shaped = [];

        for (const polygon of polygons) {
            if (!polygon.distances.length) continue;
            if (polygon.light.kind === 'cone') {
                shaped.push(polygon);
                continue;
            }
            const softness = polygon.light.softnessPx ?? LIGHTING.EDGE_SOFTNESS_PX;
            const gated = gate && polygon.light.gated ? 1 : 0;
            const key = `${softness}|${gated}`;
            let group = plain.get(key);
            if (!group) plain.set(key, group = { softness, gated, polygons: [] });
            group.polygons.push(polygon);
        }

        let touched = null;
        for (const group of plain.values()) {
            touched = this.unionBounds(touched,
                this.renderSourceGroup(mask, group.polygons, group.softness, bounds, player,
                                       viewWidth, viewHeight, group.gated ? gate : null));
        }
        for (const polygon of shaped) {
            touched = this.unionBounds(touched,
                this.renderSourceGroup(mask, [polygon],
                    polygon.light.softnessPx ?? LIGHTING.EDGE_SOFTNESS_PX,
                    bounds, player, viewWidth, viewHeight,
                    gate && polygon.light.gated ? gate : null));
        }

        // Ambient sector light. Only on the light mask, which is the pass that
        // carries a gate: the sight mask is built by this same routine with no
        // gate, and ambient must not feed the thing that gates it.
        if (gate) {
            touched = this.unionBounds(touched,
                this.paintAmbient(mask, bounds, player, viewWidth, viewHeight, gate));
        }

        mask.globalCompositeOperation = 'source-over';
        return touched;
    }

    /**
     * Paints the level's ambient light onto the mask.
     *
     * A room is one sector at one brightness, so this is flat fills over whole
     * rooms rather than a gradient -- which is what Doom's lighting looks like,
     * and why a doorway between two sectors shows a step. Tiles are bucketed by
     * brightness so the whole viewport costs a handful of fills.
     *
     * The result is gated through the sight mask the same way a terrain glow
     * is, so ambient light never reveals a room the player cannot see into.
     *
     * @param {CanvasRenderingContext2D} mask - The light mask
     * @param {Object} bounds - Visible tile range
     * @param {Object} player - The player, for the camera
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     * @param {HTMLCanvasElement} gate - The sight mask
     * @returns {Object|null} The rectangle touched
     */
    paintAmbient(mask, bounds, player, viewWidth, viewHeight, gate) {
        if (!hasSectors()) return null;
        const map = this.gameState?.gameMap;
        if (!map) return null;

        const zoom = this.zoomLevel;
        const offsetX = viewWidth / 2 - player.x * zoom;
        const offsetY = viewHeight / 2 - player.y * zoom;
        const STEPS = 12;                    // Brightness buckets, so fills stay few

        const buckets = new Map();
        for (let r = bounds.startRow; r < bounds.endRow; r++) {
            for (let c = bounds.startCol; c < bounds.endCol; c++) {
                const level = ambientForTile(map, c, r);
                if (level <= LIGHTING.MEMORY_MIN_LIGHT) continue;
                const step = Math.round(level * STEPS);
                let tiles = buckets.get(step);
                if (!tiles) buckets.set(step, tiles = []);
                tiles.push(c, r);
            }
        }
        if (buckets.size === 0) return null;

        const scratch = this.scratchCtx;
        scratch.setTransform(1, 0, 0, 1, 0, 0);
        scratch.clearRect(0, 0, viewWidth, viewHeight);
        scratch.fillStyle = '#ffffff';

        let box = null;
        for (const [step, tiles] of buckets) {
            scratch.globalAlpha = Math.min(1, step / STEPS);
            scratch.beginPath();
            for (let i = 0; i < tiles.length; i += 2) {
                const rect = this.tileScreenRect(tiles[i], tiles[i + 1], zoom, offsetX, offsetY);
                const w = rect.right - rect.left;
                const h = rect.bottom - rect.top;
                scratch.rect(rect.left, rect.top, w, h);
                box = this.unionBounds(box, { x: rect.left, y: rect.top, w, h });
            }
            scratch.fill();
        }
        scratch.globalAlpha = 1;

        box = this.clampBounds(box, viewWidth, viewHeight);
        if (!box || box.w <= 0 || box.h <= 0) return null;

        scratch.globalCompositeOperation = 'destination-in';
        scratch.drawImage(gate, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
        scratch.globalCompositeOperation = 'source-over';

        mask.globalCompositeOperation = 'lighter';
        mask.drawImage(this.scratchCanvas, box.x, box.y, box.w, box.h,
                                           box.x, box.y, box.w, box.h);
        if (this.counts) this.counts.passes++;
        return box;
    }

    /**
     * Resolves a set of sources onto the mask in one pass.
     *
     * The sources' coverage fans are summed on the staging layer, softened together
     * in a single blur, and their wall spans painted on afterwards -- wall spans
     * being crisp tile rectangles that must not be blurred. Everything is additive,
     * which is what lets a group hold more than one source: two lamps falling on the
     * same ground brighten it.
     *
     * A group of one is how a beam is drawn, because its angular profile has to be
     * multiplied through its own coverage and nothing else's.
     *
     * @param {CanvasRenderingContext2D} mask - Mask layer to add to
     * @param {Array<Object>} group - Shadow polygons sharing this pass
     * @param {number} softness - Blur radius for the group, in device pixels
     * @param {Object} bounds - Tile range from computeVisibleTileBounds
     * @param {Object} player - Player entity (camera centre)
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     * @param {HTMLCanvasElement} [gate] - If given, the group is multiplied
     *        through this mask before it is added: light the player has no
     *        line of sight to is light the player does not see
     * @returns {Object|null} The screen rectangle the group touched
     */
    renderSourceGroup(mask, group, softness, bounds, player, viewWidth, viewHeight, gate = null) {
        if (!group.length) return null;

        const stage = this.stageCtx;
        const scratch = this.scratchCtx;

        let box = null;
        for (const polygon of group) {
            box = this.unionBounds(box,
                this.sourceScreenBounds(polygon.light, player, viewWidth, viewHeight));
        }
        box = this.clampBounds(box, viewWidth, viewHeight);
        if (!box || box.w <= 0 || box.h <= 0) return null;

        // Clearing stays whole-canvas -- it is the one operation here that costs
        // almost nothing -- so no pass can ever read another's leftovers.
        stage.setTransform(1, 0, 0, 1, 0, 0);
        stage.clearRect(0, 0, viewWidth, viewHeight);
        scratch.setTransform(1, 0, 0, 1, 0, 0);
        scratch.clearRect(0, 0, viewWidth, viewHeight);

        for (const polygon of group) {
            this.fillLightShape(stage, polygon, player, viewWidth, viewHeight);
        }

        // One blur for the whole group, on its way onto the layer the wall spans
        // will be painted over.
        const canFilter = softness > 0 && typeof scratch.filter === 'string';
        if (canFilter) scratch.filter = `blur(${softness}px)`;
        scratch.drawImage(this.stageCanvas, box.x, box.y, box.w, box.h,
                                            box.x, box.y, box.w, box.h);
        if (canFilter) scratch.filter = 'none';

        // Wall spans: every tile any source in the group lights is wiped once, then
        // each source adds what it puts there. Wiping per source instead would let
        // the last one erase the rest.
        const spans = group.map(polygon => this.collectWallSpans(polygon, bounds));
        for (const runs of spans) {
            this.clearWallSpans(scratch, runs, player, viewWidth, viewHeight);
        }
        for (let i = 0; i < group.length; i++) {
            this.paintWallSpans(scratch, spans[i], group[i], player, viewWidth, viewHeight);
        }

        if (group.length === 1) {
            this.applyAngularFalloff(scratch, group[0].light, player, viewWidth, viewHeight, box);
        }

        if (gate) {
            scratch.setTransform(1, 0, 0, 1, 0, 0);
            scratch.globalCompositeOperation = 'destination-in';
            scratch.drawImage(gate, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
            scratch.globalCompositeOperation = 'source-over';
        }

        mask.globalCompositeOperation = 'lighter';
        mask.drawImage(this.scratchCanvas, box.x, box.y, box.w, box.h,
                                           box.x, box.y, box.w, box.h);
        if (this.counts) this.counts.passes++;
        return box;
    }

    /**
     * Clamps a rectangle to the canvas.
     *
     * @param {Object} box - `{ x, y, w, h }`, or null
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     * @returns {Object|null} The clamped rectangle
     */
    clampBounds(box, viewWidth, viewHeight) {
        if (!box) return null;
        const x = Math.max(0, box.x);
        const y = Math.max(0, box.y);
        return {
            x, y,
            w: Math.min(viewWidth, box.x + box.w) - x,
            h: Math.min(viewHeight, box.y + box.h) - y,
        };
    }

    /**
     * Draws item and exit tiles.
     *
     * Called only on the lit layer, so no visibility test is needed here -- an item
     * the light does not reach is masked away, and items are never drawn from
     * memory. Walk away and the pickup goes dark with the room.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {Object} bounds - Tile range from computeVisibleTileBounds
     */
    drawItemTiles(ctx, bounds) {
        const map = this.gameState.gameMap;

        for (let r = bounds.startRow; r < bounds.endRow; r++) {
            const row = map[r];
            if (!row) continue;

            for (let c = bounds.startCol; c < bounds.endCol; c++) {
                const tileType = row[c];
                // Keys, weapons, health (6..13), the exit (14) and the chainsaw (15)
                if (tileType >= 6 && tileType <= 15) {
                    this.drawItemTile(ctx, c, r, tileType);
                }
            }
        }
    }

    /**
     * Draws a single item or exit tile.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} tileType - Tile value
     */
    drawItemTile(ctx, c, r, tileType) {
        const x = c * TILE_SIZE;
        const y = r * TILE_SIZE;

        switch (tileType) {
            case 6:
            case 7:
            case 8:  this.drawKeyTile(ctx, x, y, tileType); break;
            case 9:  this.drawItemPickup(ctx, x, y, 'shotgun', '#FFA500', 'SG'); break;
            case 10: this.drawItemPickup(ctx, x, y, 'rifle', '#ADD8E6', 'RIF'); break;
            case 11: this.drawItemPickup(ctx, x, y, 'rocketlauncher', '#FF4500', 'RL'); break;
            case 12: this.drawItemPickup(ctx, x, y, 'bfg', '#00DD00', 'BFG'); break;
            case 13: this.drawItemPickup(ctx, x, y, 'health', '#44FF44', 'H'); break;
            case 14: this.drawExitTile(ctx, x, y); break;
            case 15: this.drawItemPickup(ctx, x, y, 'plasmagun', '#4AA8FF', 'PG'); break;
        }
    }

    /**
     * Draws a pickup as its icon, falling back to a lettered badge.
     *
     * The icon is drawn straight onto the floor -- no coloured disc behind it --
     * so a pickup reads as an object lying in the room rather than as a tile.
     * It is only drawn at all when the tile is lit or sensed, which is what
     * makes it findable in the dark; a pool under it just made every item look
     * like a floor decal. The badge is what appears while the icons are still
     * loading, and for the two weapons the sprite pack has no art for.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} x - World X of the tile's top-left corner
     * @param {number} y - World Y of the tile's top-left corner
     * @param {string} icon - Icon key from sprites/items/manifest.json
     * @param {string} color - Badge colour to fall back to
     * @param {string} text - Badge label to fall back to
     */
    drawItemPickup(ctx, x, y, icon, color, text) {
        const centerX = x + TILE_SIZE / 2;
        const centerY = y + TILE_SIZE / 2;
        const spec = icon === 'health' ? ITEM_DRAW_SIZE.health : ITEM_DRAW_SIZE.weapon;
        const size = iconDrawSize(icon, spec);

        if (icon && drawItemIcon(ctx, icon, centerX, centerY, size)) return;

        // No artwork, or it hasn't loaded yet: a lettered badge in its colour.
        ctx.save();
        ctx.fillStyle = color;
        ctx.font = `${size * (text.length > 2 ? 0.38 : 0.52)}px "Press Start 2P"`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, centerX, centerY + 1);
        ctx.restore();
    }

    /**
     * Draws a key lying on the floor.
     *
     * An actual key -- bow, collar, shaft and two bits -- rather than the coloured
     * square with a "K" on it this replaces. It matters more than it sounds: a key
     * is the single most important thing on the level, it is usually seen at the
     * far edge of the torch beam, and a shape is recognisable at that distance in a
     * way a letter is not. It floats and turns slowly for the same reason, which
     * also tells it apart from the weapon icons lying flat nearby.
     *
     * The colours are shared with the door it opens (see KEY_STYLES and
     * DOOR_STYLES), so the connection is made by recognition rather than by memory.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} x - World X of the tile's top-left corner
     * @param {number} y - World Y of the tile's top-left corner
     * @param {number} tileType - Key tile value
     */
    drawKeyTile(ctx, x, y, tileType) {
        const palette = KEY_STYLES[tileType];
        if (!palette) return;

        const size = TILE_SIZE;
        const phase = this.terrainPhase || 0;
        const centreX = x + size / 2;
        const centreY = y + size / 2 + Math.sin(phase * 1.6 + x * 0.05) * size * 0.05;

        // The pool underneath. Keys are small and these rooms are unlit, so without
        // something behind it a key on a dark floor is a few stray pixels.
        if (this.allowEmissive) {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const pool = ctx.createRadialGradient(centreX, centreY, 0, centreX, centreY, size * 0.5);
            pool.addColorStop(0, `rgba(${palette.glow},0.55)`);
            pool.addColorStop(0.55, `rgba(${palette.glow},0.22)`);
            pool.addColorStop(1, `rgba(${palette.glow},0)`);
            ctx.fillStyle = pool;
            ctx.fillRect(x - size * 0.1, y - size * 0.1, size * 1.2, size * 1.2);
            ctx.restore();
        }

        ctx.save();
        ctx.translate(centreX, centreY);
        ctx.rotate(Math.sin(phase * 0.7 + y * 0.03) * 0.35 - Math.PI / 5);

        const shaft = size * 0.46;      // Length from the collar to the tip
        const bow = size * 0.13;        // Radius of the ring at the head
        const thick = Math.max(2, size * 0.075);

        // Outline first, as a slightly fatter copy of everything below it. Cheaper
        // than stroking each piece, and it is what keeps the key legible against a
        // bright floor -- which, on a lava level, is most of them.
        for (const layer of [
            { color: palette.edge, grow: 1.6 },
            { color: palette.body, grow: 0 },
        ]) {
            const g = layer.grow;
            ctx.fillStyle = layer.color;

            // Shaft
            ctx.fillRect(-thick / 2 - g, -bow - g, thick + g * 2, shaft + g * 2);

            // Bits, at the far end, pointing one way like a real warded key
            ctx.fillRect(thick / 2 - g, shaft - bow - thick * 2.2 - g,
                         thick * 1.9 + g * 2, thick * 0.9 + g * 2);
            ctx.fillRect(thick / 2 - g, shaft - bow - thick * 0.9 - g,
                         thick * 2.9 + g * 2, thick * 0.9 + g * 2);

            // Bow: a ring, drawn as a disc with the middle punched back out below
            ctx.beginPath();
            ctx.arc(0, -bow, bow + thick * 0.55 + g, 0, Math.PI * 2);
            ctx.fill();
        }

        // Punch the hole in the bow. Drawn as a floor-coloured hole rather than
        // cleared, because this layer is composited over the room.
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.arc(0, -bow, bow * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        // A highlight down one side of the shaft, so it reads as metal.
        ctx.fillStyle = palette.shine;
        ctx.fillRect(-thick / 2, -bow, Math.max(1, thick * 0.35), shaft * 0.85);

        ctx.restore();
    }

    /**
     * Draws the level exit, showing whether a living boss still seals it.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} x - World X of the tile's top-left corner
     * @param {number} y - World Y of the tile's top-left corner
     */
    drawExitTile(ctx, x, y) {
        const size = TILE_SIZE;
        const boss = this.gameState.currentBoss;
        const sealed = !!(boss && boss.health > 0 && !boss.isDead);
        const state = sealed ? EXIT_STYLE.sealed : EXIT_STYLE.open;
        const phase = this.terrainPhase || 0;
        const centreX = x + size / 2;
        const centreY = y + size / 2;

        // A recessed doorway: dark threshold, heavy frame, lit from inside.
        ctx.fillStyle = EXIT_STYLE.frame;
        ctx.fillRect(x, y, size, size);
        ctx.fillStyle = EXIT_STYLE.frameEdge;
        ctx.fillRect(x, y, size, 3);
        ctx.fillRect(x, y + size - 3, size, 3);
        ctx.fillRect(x, y, 3, size);
        ctx.fillRect(x + size - 3, y, 3, size);

        const inset = Math.round(size * 0.2);
        ctx.fillStyle = EXIT_STYLE.threshold;
        ctx.fillRect(x + inset, y + inset, size - inset * 2, size - inset * 2);

        if (sealed) {
            // Barred. Two heavy bars across the opening say "not yet" without
            // needing a word on them, and they are still readable at a glance when
            // the exit is half off the edge of the beam.
            ctx.fillStyle = state.bar;
            ctx.save();
            ctx.translate(centreX, centreY);
            for (const angle of [Math.PI / 4, -Math.PI / 4]) {
                ctx.save();
                ctx.rotate(angle);
                ctx.fillRect(-size * 0.42, -3, size * 0.84, 6);
                ctx.restore();
            }
            ctx.restore();
        } else {
            // Open: chevrons pointing inward, marching towards the threshold.
            ctx.strokeStyle = state.light;
            ctx.lineWidth = 2;
            for (let i = 0; i < 3; i++) {
                const t = ((phase * 0.6 + i / 3) % 1);
                const offset = size * (0.34 - t * 0.2);
                ctx.globalAlpha = 0.25 + 0.55 * (1 - t);
                ctx.beginPath();
                ctx.moveTo(centreX - size * 0.22, centreY + offset - size * 0.12);
                ctx.lineTo(centreX, centreY + offset);
                ctx.lineTo(centreX + size * 0.22, centreY + offset - size * 0.12);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
        }

        // The lamp above the threshold, in the one colour that means anything here:
        // red while something is still alive, green once it is not.
        if (this.allowEmissive) {
            const pulse = 0.6 + 0.4 * Math.sin(phase * (sealed ? 4.5 : 1.8));
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const halo = ctx.createRadialGradient(centreX, centreY, 0, centreX, centreY, size * 0.55);
            halo.addColorStop(0, `rgba(${state.glow},${0.42 * pulse})`);
            halo.addColorStop(1, `rgba(${state.glow},0)`);
            ctx.fillStyle = halo;
            ctx.fillRect(x - size * 0.1, y - size * 0.1, size * 1.2, size * 1.2);
            ctx.restore();
        }

        ctx.fillStyle = state.light;
        ctx.fillRect(centreX - size * 0.14, y + Math.round(size * 0.1), size * 0.28, 3);
    }

    /**
     * Draws every dynamic entity: pickups, enemies, bosses, projectiles, effects.
     *
     * Drawn onto a masked layer, so the mask alone decides what the player sees.
     * Entities the caller's test rejects are skipped up front purely to save work
     * -- the mask would have discarded them anyway.
     *
     * The test is the caller's because the two passes perceive differently: the lit
     * pass asks whether light is falling on a creature, the sense pass whether it
     * falls inside the peripheral arc.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {Function} visible - Given an entity, whether this pass can see it
     */
    drawEntities(ctx, visible) {
        const state = this.gameState;

        for (const pack of state.healthPacks) {
            if (visible(pack)) pack.draw(ctx);
        }
        for (const pack of state.ammoPacks) {
            if (visible(pack)) pack.draw(ctx);
        }
        for (const pack of state.weaponPacks || []) {
            if (visible(pack)) pack.draw(ctx);
        }
        for (const item of state.powerups || []) {
            if (visible(item)) item.draw(ctx);
        }

        if (state.currentBoss && visible(state.currentBoss)) {
            state.currentBoss.draw(ctx);
        }

        for (const barrel of state.barrels || []) {
            if (visible(barrel)) barrel.draw(ctx);
        }

        for (const enemy of state.enemies) {
            if (visible(enemy)) enemy.draw(ctx);
        }

    }

    /**
     * Draws everything peripheral vision makes out, as a dim colourless wash.
     *
     * Built exactly like the lit pass -- the same geometry, items and creatures,
     * drawn at full brightness and then clipped by a mask -- with two differences,
     * and both of them are what stop this from reading as a second, weaker torch:
     *
     *   1. The mask is the vision arc, whose peak alpha is PERIPHERAL_INTENSITY.
     *      Whatever survives is therefore already faint.
     *   2. A flat cold grey is painted over the survivors with `source-atop`,
     *      draining their colour. That is the difference between "there is a shape
     *      in the doorway" and "there is a green health pack in the doorway" --
     *      colour is the thing you do not get without light, and leaving it in made
     *      the arc look like illumination however dim it was.
     *
     * Composited under the lit pass, so where the beam also falls the lit layer
     * simply covers this and no seam appears at the beam's rim.
     *
     * @param {Object} player - Player entity (camera centre)
     * @param {Object} bounds - Tile range from computeVisibleTileBounds
     * @param {number} viewWidth - Canvas width
     * @param {number} viewHeight - Canvas height
     */
    drawSensePass(player, bounds, viewWidth, viewHeight) {
        const sense = this.senseCtx;
        if (!sense) return;

        sense.setTransform(1, 0, 0, 1, 0, 0);
        sense.clearRect(0, 0, viewWidth, viewHeight);
        sense.save();
        this.applyWorldTransform(sense, player, viewWidth, viewHeight);

        // Everything self-luminous is suppressed for this pass. The wash below
        // drains the layer of colour, but it cannot drain it of BRIGHTNESS, so an
        // additive glow drawn here would survive as a pale flare -- a lamp you can
        // see through a wall you have only sensed the shape of.
        this.allowEmissive = false;
        try {
            this.drawStaticGeometry(sense, bounds, 'sensed');
            this.drawItemTiles(sense, bounds);
            this.drawEntities(sense, (e) => sampleVisionAt(e.x, e.y) > LIGHTING.SENSE_THRESHOLD);
        } finally {
            this.allowEmissive = true;
        }
        sense.restore();

        sense.setTransform(1, 0, 0, 1, 0, 0);
        sense.globalCompositeOperation = 'destination-in';
        sense.drawImage(this.senseMaskCanvas, 0, 0);

        // Drain the colour out of whatever survived. `source-atop` paints only where
        // the layer already has coverage and keeps that coverage, so this tints
        // without spilling the wash across the rest of the screen.
        sense.globalCompositeOperation = 'source-atop';
        sense.fillStyle = 'rgba(146,166,196,0.62)';
        sense.fillRect(0, 0, viewWidth, viewHeight);
        sense.globalCompositeOperation = 'source-over';

        this.ctx.drawImage(this.senseCanvas, 0, 0);
    }

    /**
     * Draws things that emit their own light: projectiles, explosions and combat
     * flashes.
     *
     * These are composited AFTER the light mask, so they stay visible in an unlit
     * room. Gating them on ambient light would mean incoming enemy fire arrived
     * invisibly out of the dark and explosions in a shadowed corridor simply did
     * not appear.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     */
    drawEmissive(ctx) {
        for (const bullet of this.gameState.bullets) {
            bullet.draw(ctx);
        }
        for (const explosion of this.gameState.explosions) {
            explosion.draw(ctx);
        }
        // On top of the projectiles it just launched.
        if (this.gameState.player) {
            this.gameState.player.drawMuzzleFlash(ctx);
        }
        this.drawTemporaryEffects(ctx);
        // Embers, sparks and gas glow on their own, like the pools they came from
        // -- but only where the player can see the pool. Drawn outside the mask,
        // they would otherwise drift through the wall of a room never entered.
        drawParticles(ctx, 'emissive', (p) =>
            sampleLightAt(p.x, p.y) > LIGHTING.REVEAL_THRESHOLD ||
            sampleVisionAt(p.x, p.y) > LIGHTING.SENSE_THRESHOLD);
    }

    /**
     * Draws transient visual effects.
     *
     * Only BFG tracers now. Melee used to paint its arc here as a row of blobs on
     * the ground, which was the only way to show a swing back when the player was
     * a circle; the character animates the swing itself now.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     */
    drawTemporaryEffects(ctx) {
        for (const effect of this.gameState.temporaryVisualEffects) {
            if (effect.life <= 0) continue;

            switch (effect.type) {
                case 'bfg_tracer':
                    ctx.strokeStyle = effect.color;
                    ctx.lineWidth = 2 + (effect.life / 5);
                    ctx.beginPath();
                    ctx.moveTo(effect.startX, effect.startY);
                    ctx.lineTo(effect.endX, effect.endY);
                    ctx.stroke();
                    break;

                case 'tracer':
                    // A monster's hitscan shot. Doom showed nothing at all; a
                    // thin line for a few frames is the least that lets the
                    // player tell where the fire is coming from.
                    ctx.save();
                    ctx.globalAlpha = Math.min(1, effect.life / 4) * 0.85;
                    ctx.strokeStyle = effect.color || '#ffe9a0';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(effect.startX, effect.startY);
                    ctx.lineTo(effect.endX, effect.endY);
                    ctx.stroke();
                    ctx.restore();
                    break;

                case 'vile_fire':
                    this.drawVileFire(ctx, effect);
                    break;

                default:
                    break;
            }
        }
    }

    /**
     * The Arch-vile's fire: a column of flame at the target's feet that follows
     * them for the length of the wind-up. It is the warning to break line of
     * sight, so it is drawn loud.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {Object} effect - Effect with `follow` (an entity) or x/y, and `radius`
     */
    drawVileFire(ctx, effect) {
        const x = effect.follow ? effect.follow.x : effect.x;
        const y = effect.follow ? effect.follow.y : effect.y;
        const r = effect.radius || 15;
        const flicker = 0.8 + Math.random() * 0.4;

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';

        // Glow on the ground
        ctx.fillStyle = 'rgba(255, 120, 30, 0.35)';
        ctx.beginPath();
        ctx.arc(x, y, r * 1.6 * flicker, 0, Math.PI * 2);
        ctx.fill();

        // Tongues of flame
        for (let i = 0; i < 5; i++) {
            const angle = (i / 5) * Math.PI * 2 + Math.random() * 0.6;
            const height = r * (1.2 + Math.random() * 1.4);
            const baseX = x + Math.cos(angle) * r * 0.5;
            const baseY = y + Math.sin(angle) * r * 0.3;
            ctx.fillStyle = i % 2 ? 'rgba(255, 200, 60, 0.85)' : 'rgba(255, 90, 20, 0.85)';
            ctx.beginPath();
            ctx.moveTo(baseX - r * 0.35, baseY);
            ctx.lineTo(baseX + (Math.random() - 0.5) * r * 0.5, baseY - height);
            ctx.lineTo(baseX + r * 0.35, baseY);
            ctx.closePath();
            ctx.fill();
        }

        ctx.restore();
    }

    /**
     * Colour a tile takes on the minimap, or null if it should be left blank.
     *
     * @param {number} tileType - Tile value
     * @returns {string|null} CSS colour
     */
    minimapTileColor(tileType) {
        switch (tileType) {
            case 0:  return MINIMAP.FLOOR;
            case 1:  return MINIMAP.WALL;
            case 2:  return MINIMAP.DOOR_RED;
            case 3:  return MINIMAP.DOOR_YELLOW;
            case 4:  return MINIMAP.DOOR_BLUE;
            case 5:  return MINIMAP.SECRET_DOOR;
            case 14: return MINIMAP.EXIT;
            case 19: return MINIMAP.PROP;
            case 20: return MINIMAP.WALL;
            case 21: return MINIMAP.SWITCH;
            case 16: return MINIMAP.LAVA;
            case 17: return MINIMAP.TOXIC;
            case 18: return MINIMAP.WATER;
            default: return (tileType >= 6 && tileType <= 15) ? MINIMAP.ITEM : null;
        }
    }

    /**
     * Stamps newly revealed tiles into the persistent minimap surface.
     *
     * Reads `exploredMap`, which is the same record the on-screen memory pass is
     * driven by, so the minimap can never claim to know something the player has
     * not seen -- including anything peripheral vision picked out, which is folded
     * into that record alongside the beam.
     *
     * Restamps a tile whose TYPE has changed as well as one newly revealed: a door
     * the player has opened becomes floor, and a pickup they have taken stops being
     * a pickup. Comparing against what was last drawn is what keeps the surface
     * honest without redrawing it.
     */
    updateMinimapSurface() {
        const map = this.gameState.gameMap;
        const explored = getExploredMap();
        const stamped = this.minimapStamped;
        const ctx = this.minimapCtx;
        if (!map || !explored || !stamped || !ctx) return;

        for (let r = 0; r < MAP_ROWS; r++) {
            const row = map[r];
            const seenRow = explored[r];
            if (!row || !seenRow) continue;

            for (let c = 0; c < MAP_COLS; c++) {
                if (seenRow[c] <= 0) continue;

                // A sliding wall that has opened is floor now, as far as the map
                // is concerned
                const tileType = row[c] === TILE_SLIDE && isSlideOpen(c, r) ? TILE_EMPTY : row[c];
                const index = r * MAP_COLS + c;
                if (stamped[index] === tileType) continue;

                const color = this.minimapTileColor(tileType);
                ctx.clearRect(c, r, 1, 1);
                if (color) {
                    ctx.fillStyle = color;
                    ctx.fillRect(c, r, 1, 1);
                }
                stamped[index] = tileType;
            }
        }
    }

    /**
     * Draws the minimap panel in the top-left corner.
     *
     * Semi-transparent, and small: it sits over the world rather than beside it, so
     * anything more opaque would be a hole in the level. Toggled with M.
     */
    drawMinimap() {
        if (!this.minimapCanvas || !this.gameState.player) return;

        this.updateMinimapSurface();

        const scale = MINIMAP.SCALE;
        const pad = MINIMAP.PADDING;
        const width = MAP_COLS * scale;
        const height = MAP_ROWS * scale;
        const left = MINIMAP.MARGIN_X;
        const top = MINIMAP.MARGIN_Y;

        const ctx = this.ctx;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        // The overlay draws its text with a drop shadow still set; inherited here it
        // would put a black halo under every rectangle of the panel.
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        ctx.fillStyle = MINIMAP.BACKDROP;
        ctx.fillRect(left, top, width + pad * 2, height + pad * 2);
        ctx.strokeStyle = MINIMAP.BORDER;
        ctx.lineWidth = 1;
        ctx.strokeRect(left + 0.5, top + 0.5, width + pad * 2 - 1, height + pad * 2 - 1);

        // Blown up from one pixel a tile, with smoothing off: interpolating between
        // neighbouring tiles would smear a revealed corridor into the unexplored
        // black around it and show the player walls they have not found.
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = MINIMAP.OPACITY;
        ctx.drawImage(this.minimapCanvas, left + pad, top + pad, width, height);
        ctx.globalAlpha = 1;
        ctx.imageSmoothingEnabled = true;

        // The player, drawn live rather than stamped -- they move
        const player = this.gameState.player;
        const px = left + pad + (player.x / TILE_SIZE) * scale;
        const py = top + pad + (player.y / TILE_SIZE) * scale;

        ctx.fillStyle = MINIMAP.PLAYER;
        ctx.beginPath();
        ctx.arc(px, py, MINIMAP.PLAYER_RADIUS, 0, Math.PI * 2);
        ctx.fill();

        // A stub showing which way they are facing, so the panel can be read
        // without first working out where the corridor behind you was
        ctx.strokeStyle = MINIMAP.PLAYER;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(player.angle) * scale * 2.5,
                   py + Math.sin(player.angle) * scale * 2.5);
        ctx.stroke();

        ctx.restore();
    }

    /**
     * Draws the performance panel in the top-right corner. Toggled with F3.
     *
     * The two numbers at the top are the ones that matter, and they answer different
     * questions:
     *
     *   FRAME  how long a frame actually takes, wall to wall. This is the frame rate.
     *   DRAW   how much of that this renderer spent in JavaScript.
     *
     * A large gap between them means the time is going somewhere this panel cannot
     * see -- the browser compositing, the GPU catching up, or the game's own update
     * loop -- and that making the drawing code cleverer will not help. Canvas calls
     * are queued rather than executed, so DRAW measures how long it took to ASK for
     * the frame, not to paint it; a slice that looks cheap here can still be
     * expensive on the GPU. Treat the slices as a ranking, not a stopwatch.
     *
     * The slices are the render's own passes, in the order they run:
     *   cast        casting the shadow polygons, all sources
     *   mask        resolving those into the light and vision masks
     *   memory      folding this frame into the record of what has been seen
     *   remembered  drawing dim, already-seen geometry
     *   sensed      drawing what peripheral vision makes out
     *   lit         drawing the lit world and clipping it to the mask
     *   hud         this panel, the minimap and the rest of the overlay
     *
     * The counts underneath are what the lighting was asked to do: how many sources
     * were alive, how many passes they collapsed into (sources sharing a pass is
     * what keeps glowing terrain affordable), how many wall spans were shaded, and
     * how many rays were marched.
     */
    drawPerfPanel() {
        const stats = this.perfStats;
        if (!stats) return;

        const ctx = this.ctx;
        const pad = 10;
        const lineHeight = 13;
        // Wide enough that no label meets its value: this font is fixed-pitch at
        // roughly the nominal size, and the longest row is a label of eleven
        // characters beside a value of twelve.
        const width = 224;
        const slices = Object.keys(stats.phase).filter(k => stats.phase[k] > 0);
        const height = pad * 2 + lineHeight * (slices.length + 6);
        const left = this.canvas.width - width - 15;
        const top = 62;

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        ctx.fillStyle = 'rgba(8,10,14,0.72)';
        ctx.fillRect(left, top, width, height);
        ctx.strokeStyle = 'rgba(160,170,190,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);

        ctx.font = '9px "Press Start 2P", monospace';
        ctx.textBaseline = 'top';

        let y = top + pad;
        const row = (label, value, colour) => {
            ctx.textAlign = 'left';
            ctx.fillStyle = colour || '#9aa4b4';
            ctx.fillText(label, left + pad, y);
            ctx.textAlign = 'right';
            ctx.fillText(value, left + width - pad, y);
            y += lineHeight;
        };

        const fps = stats.frame > 0 ? Math.round(1000 / stats.frame) : 0;
        row('frame', `${fps}fps ${stats.frame.toFixed(1)}ms`,
            fps >= 50 ? '#7fdc5f' : (fps >= 30 ? '#ffdc00' : '#ff4136'));
        row('draw', `${stats.render.toFixed(1)}ms`, '#cfd6e2');

        y += 3;
        ctx.strokeStyle = 'rgba(160,170,190,0.25)';
        ctx.beginPath();
        ctx.moveTo(left + pad, y + 0.5);
        ctx.lineTo(left + width - pad, y + 0.5);
        ctx.stroke();
        y += 5;

        // Worst first, so the thing to look at is always at the top of the list
        slices.sort((a, b) => stats.phase[b] - stats.phase[a]);
        for (const name of slices) {
            row(name, `${stats.phase[name].toFixed(1)}ms`);
        }

        y += 3;
        ctx.strokeStyle = 'rgba(160,170,190,0.25)';
        ctx.beginPath();
        ctx.moveTo(left + pad, y + 0.5);
        ctx.lineTo(left + width - pad, y + 0.5);
        ctx.stroke();
        y += 5;

        const counts = stats.counts;
        row('sources/pass', `${Math.round(counts.sources)}/${Math.round(counts.passes)}`, '#8d96a5');
        row('spans', `${Math.round(counts.spans)}`, '#8d96a5');
        row('rays', `${Math.round(counts.rays)}`, '#8d96a5');

        ctx.restore();
    }

    /**
     * Renders UI overlay elements on top of the game world
     */
    renderUIOverlay() {
        // Save current context settings
        this.ctx.save();

        // Reset any transforms to render UI in screen space
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);

        // Set font and style for UI text
        this.ctx.font = '16px "Press Start 2P", monospace';
        this.ctx.fillStyle = '#ff4136';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'top';

        // Add shadow for better visibility
        this.ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
        this.ctx.shadowBlur = 4;
        this.ctx.shadowOffsetX = 2;
        this.ctx.shadowOffsetY = 2;

        // Draw level display in top-left corner
        const levelText = `Level: ${this.gameState.currentLevel}`;
        this.ctx.fillText(levelText, 15, 15);

        if (this.gameState.showMinimap) this.drawMinimap();
        if (this.gameState.showPerf) this.drawPerfPanel();

        // Draw coordinate display in top-right corner (if enabled)
        if (this.gameState.showCoordinates && this.gameState.player) {
            // Calculate player position
            const playerX = Math.floor(this.gameState.player.x);
            const playerY = Math.floor(this.gameState.player.y);
            const tileX = Math.floor(this.gameState.player.x / 40); // TILE_SIZE = 40
            const tileY = Math.floor(this.gameState.player.y / 40);

            // Format coordinate text
            const coordText = `Pos: ${playerX},${playerY} Tile: ${tileX},${tileY}`;

            // Set text alignment for right side
            this.ctx.textAlign = 'right';
            this.ctx.fillStyle = '#ffdc00'; // Yellow color for coordinates
            this.ctx.fillText(coordText, this.canvas.width - 15, 15);

            // Frame cost alongside it. Lighting is by far the most expensive thing
            // this game does and its cost varies hugely with where the player is
            // standing -- a corridor full of wall faces is many times a bare room --
            // so a number on screen is the only way to tell what a change was worth.
            if (this.frameMs) {
                const fps = Math.round(1000 / this.frameMs);
                this.ctx.fillStyle = fps >= 50 ? '#7fdc5f' : (fps >= 30 ? '#ffdc00' : '#ff4136');
                this.ctx.fillText(`${fps} fps  ${this.frameMs.toFixed(1)} ms`,
                                  this.canvas.width - 15, 40);
            }

            // Reset text alignment
            this.ctx.textAlign = 'left';
        }

        // Restore context settings
        this.ctx.restore();
    }

    /**
     * Draws a wall, door or secret door tile.
     *
     * Walls are AUTOTILED. Rather than a coloured square with a border drawn round
     * it -- which turns any run of wall into a visible 40px grid, and is what this
     * replaces -- each block is shaded according to which of its four sides front
     * open ground. A side that continues into more wall gets nothing, so a corridor
     * wall comes out as one unbroken mass with a single lit edge running its whole
     * length, and the places where the run turns get corner pieces.
     *
     * Doors are part of the run for the purposes of that decision (see isWallLike),
     * so a door set into a wall does not leave the masonry either side of it with
     * raw exposed edges, but they are drawn by drawDoorTile() rather than here.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} tileType - Tile value (1 = wall, 2..4 = doors, 5 = secret)
     * @param {Object} style - Active wall style
     * @param {boolean} isMemory - Draw at remembered brightness rather than lit
     */
    drawWallTile(ctx, c, r, tileType, style, isMemory, detail) {
        const mask = neighbourMask(this.gameState.gameMap, c, r, isWallLike);

        if (isKeyedDoor(tileType)) {
            this.drawDoorTile(ctx, c, r, tileType, style, mask, isMemory);
            return;
        }

        const x = c * TILE_SIZE;
        const y = r * TILE_SIZE;
        const dim = LIGHTING.MEMORY_BRIGHTNESS;
        const wall = style.wall;

        ctx.fillStyle = isMemory ? this.dimColor(wall.face, dim) : wall.face;
        ctx.fillRect(x, y, TILE_SIZE + this.tileBleed(), TILE_SIZE + this.tileBleed());

        // Surface pattern. Only in the lit pass: it is the most expensive part of
        // the wall draw, and the other two throw it away -- the memory pass at 45%
        // brightness, the sense pass under a colourless wash. Walls are the most
        // numerous thing on screen, so this is the single biggest saving the mode
        // makes.
        if (detail) this.drawMasonry(ctx, c, r, x, y, style);

        this.drawWallEdges(ctx, x, y, mask, wall, isMemory);

        // Secret doors get a barely-there inset so they read as subtly different
        // masonry up close without giving themselves away at a glance.
        if (tileType === TILE_SECRET_DOOR) {
            const insetAlpha = isMemory ? 0.04 : 0.12;
            ctx.fillStyle = `rgba(0,0,0,${insetAlpha})`;
            ctx.fillRect(x + TILE_SIZE * 0.24, y + TILE_SIZE * 0.24,
                         TILE_SIZE * 0.52, TILE_SIZE * 0.52);
        }
    }

    /**
     * Draws the masonry pattern across one wall tile.
     *
     * Every course and every joint is positioned in WORLD coordinates and cut to
     * the tile, which is the entire point of doing it this way: a pattern laid out
     * relative to the tile restarts at each boundary and draws the tile grid
     * straight back onto the wall the edge shading just removed. Laid out in world
     * space, a course of bricks runs unbroken down a corridor.
     *
     * Cut by arithmetic, not by a clip. Everything drawn here is axis-aligned, so
     * a line that would leave the tile can simply be shortened to its edge and one
     * that starts past it dropped. A canvas clip does the same thing at the cost
     * of a save/clip/restore per tile -- three of the most expensive calls there
     * are, on the most numerous thing on screen.
     *
     * The whole tile's worth of seams is a single path and a single stroke, and
     * its rivets a single path and a single fill.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} x - World X of the tile's top-left corner
     * @param {number} y - World Y of the tile's top-left corner
     * @param {Object} style - Active wall style
     */
    drawMasonry(ctx, c, r, x, y, style) {
        const spec = style.masonry;
        if (!spec || !(spec.course > 0) || !(spec.unit > 0)) return;

        const size = TILE_SIZE;
        const course = spec.course;
        const unit = spec.unit;
        const right = x + size;
        const bottom = y + size;

        ctx.strokeStyle = style.wall.mortar;
        ctx.lineWidth = 1;
        ctx.beginPath();

        const firstCourse = Math.floor(y / course) * course;

        for (let cy = firstCourse; cy < bottom; cy += course) {
            // A course line on or above the top edge belongs to the tile above
            if (cy >= y) {
                ctx.moveTo(x, cy + 0.5);
                ctx.lineTo(right, cy + 0.5);
            }

            if (spec.kind === 'plate') continue;

            // Running bond: alternate courses start half a unit along, so joints
            // never line up two rows deep. Each joint is cut to the tile's height.
            const jointTop = Math.max(cy, y);
            const jointBottom = Math.min(cy + course, bottom);
            if (jointBottom <= jointTop) continue;

            const stagger = (Math.floor(cy / course) & 1) ? unit / 2 : 0;
            const firstJoint = Math.floor((x - stagger) / unit) * unit + stagger;
            for (let jx = firstJoint; jx < right; jx += unit) {
                if (jx < x) continue;
                ctx.moveTo(jx + 0.5, jointTop);
                ctx.lineTo(jx + 0.5, jointBottom);
            }
        }

        if (spec.kind === 'plate') {
            // Plating has no bond to stagger: the seams run straight top to bottom.
            const firstSeam = Math.floor(x / unit) * unit;
            for (let sx = firstSeam; sx < right; sx += unit) {
                if (sx < x) continue;
                ctx.moveTo(sx + 0.5, y);
                ctx.lineTo(sx + 0.5, bottom);
            }
        }

        ctx.stroke();

        if (spec.rivets) {
            ctx.globalAlpha = 0.45;
            ctx.fillStyle = style.wall.cap;
            ctx.beginPath();
            const firstRivetX = Math.floor(x / unit) * unit;
            for (let ry = firstCourse; ry < bottom; ry += course) {
                const py = ry + 3;
                if (py < y || py + 2 > bottom) continue;
                for (let rx = firstRivetX; rx < right; rx += unit) {
                    const px1 = rx + 3;
                    const px2 = rx + unit - 5;
                    if (px1 >= x && px1 + 2 <= right) ctx.rect(px1, py, 2, 2);
                    if (px2 >= x && px2 + 2 <= right) ctx.rect(px2, py, 2, 2);
                }
            }
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        // A little tonal variation between blocks, so a long wall is not one flat
        // sheet of colour. One rect per tile: any more and this is the most
        // expensive thing in the frame, since it runs on every visible wall.
        const roll = tileNoise(c, r, 3);
        if (roll > 0.62) {
            ctx.globalAlpha = 0.10 + (roll - 0.62) * 0.25;
            ctx.fillStyle = roll > 0.84 ? style.wall.cap : style.wall.shade;
            const bandY = y + Math.floor(tileNoise(c, r, 4) * (size / course)) * course;
            ctx.fillRect(x, bandY, size, Math.min(course, bottom - bandY));
            ctx.globalAlpha = 1;
        }
    }

    /**
     * Shades a wall block's exposed sides, and turns the corners.
     *
     * Six cases, and between them they cover every arrangement a grid can produce:
     * a lit lip on each side that fronts open ground; that lip's own shadow just
     * inboard of it; a corner cap where two lips meet at an OUTER corner; and a
     * short return where two sides both carry on but the diagonal does not, which
     * is an INNER corner and the one case a per-side rule alone gets wrong -- left
     * to itself it leaves a square notch bitten out of the turn.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} x - World X of the tile's top-left corner
     * @param {number} y - World Y of the tile's top-left corner
     * @param {number} mask - Neighbour mask of wall-like tiles
     * @param {Object} wall - The style's wall palette
     * @param {boolean} isMemory - Draw at remembered brightness
     */
    drawWallEdges(ctx, x, y, mask, wall, isMemory) {
        const size = TILE_SIZE;
        const dim = LIGHTING.MEMORY_BRIGHTNESS;
        const lip = Math.max(2, Math.round(size * 0.11));
        const line = 2;

        const openN = !(mask & NB.N);
        const openS = !(mask & NB.S);
        const openW = !(mask & NB.W);
        const openE = !(mask & NB.E);

        ctx.fillStyle = isMemory ? this.dimColor(wall.cap, dim) : wall.cap;
        if (openN) ctx.fillRect(x, y, size, lip);
        if (openS) ctx.fillRect(x, y + size - lip, size, lip);
        if (openW) ctx.fillRect(x, y, lip, size);
        if (openE) ctx.fillRect(x + size - lip, y, lip, size);

        ctx.fillStyle = isMemory ? this.dimColor(wall.shade, dim) : wall.shade;
        if (openN) ctx.fillRect(x, y + lip, size, line);
        if (openS) ctx.fillRect(x, y + size - lip - line, size, line);
        if (openW) ctx.fillRect(x + lip, y, line, size);
        if (openE) ctx.fillRect(x + size - lip - line, y, line, size);

        // Outer corners: a quoin where two exposed faces meet, which is what makes
        // the end of a wall or the corner of a pillar legible in the dark.
        const quoin = lip + line;
        ctx.fillStyle = isMemory ? this.dimColor(wall.trim, dim) : wall.trim;
        if (openN && openW) ctx.fillRect(x, y, quoin, quoin);
        if (openN && openE) ctx.fillRect(x + size - quoin, y, quoin, quoin);
        if (openS && openW) ctx.fillRect(x, y + size - quoin, quoin, quoin);
        if (openS && openE) ctx.fillRect(x + size - quoin, y + size - quoin, quoin, quoin);

        // Inner corners: the run turns here, and the lip has to turn with it.
        ctx.fillStyle = isMemory ? this.dimColor(wall.cap, dim) : wall.cap;
        if (!openN && !openW && !(mask & NB.NW)) ctx.fillRect(x, y, lip, lip);
        if (!openN && !openE && !(mask & NB.NE)) ctx.fillRect(x + size - lip, y, lip, lip);
        if (!openS && !openW && !(mask & NB.SW)) ctx.fillRect(x, y + size - lip, lip, lip);
        if (!openS && !openE && !(mask & NB.SE)) ctx.fillRect(x + size - lip, y + size - lip, lip, lip);
    }

    /**
     * The two-tile span a door belongs to.
     *
     * Doors are placed in matched pairs across a two-wide corridor (see
     * level-layout.js), and a pair is ONE door: a double door, two leaves
     * meeting at the seam between the tiles, with the lock on the seam. Each
     * tile draws the whole door clipped to itself, so the two halves cannot
     * disagree about where the seam or the lamp is.
     *
     * A door with no partner -- the fallback layout's one-wide corridors -- is
     * a single tile wide and its span is itself.
     *
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} tileType - Door tile value
     * @param {boolean} runsHorizontal - Whether the wall run is east-west
     * @returns {{x: number, y: number, w: number, h: number, paired: boolean}} World rectangle
     */
    doorSpan(c, r, tileType, runsHorizontal) {
        const map = this.gameState.gameMap;
        const size = TILE_SIZE;
        const same = (cc, rr) => !!(map && map[rr] && map[rr][cc] === tileType);

        // The partner lies along the run: side by side for an east-west run,
        // one above the other for a north-south one. Lower coordinate first, so
        // both tiles of a pair resolve to the same span.
        if (runsHorizontal) {
            if (same(c - 1, r)) return { x: (c - 1) * size, y: r * size, w: size * 2, h: size, paired: true };
            if (same(c + 1, r)) return { x: c * size, y: r * size, w: size * 2, h: size, paired: true };
        } else {
            if (same(c, r - 1)) return { x: c * size, y: (r - 1) * size, w: size, h: size * 2, paired: true };
            if (same(c, r + 1)) return { x: c * size, y: r * size, w: size, h: size * 2, paired: true };
        }
        return { x: c * size, y: r * size, w: size, h: size, paired: false };
    }

    /**
     * Draws one tile's share of a keyed door.
     *
     * The door slides: its two leaves part from the seam and retreat into the
     * jambs as `openness` rises (see js/doors.js), and the floor shows through
     * the gap. Each tile draws the whole door clipped to itself.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} tileType - Door tile value
     * @param {Object} style - Active wall style, for the jambs
     * @param {number} mask - Neighbour mask of wall-like tiles
     * @param {boolean} isMemory - Draw at remembered brightness
     */
    drawDoorTile(ctx, c, r, tileType, style, mask, isMemory) {
        const palette = DOOR_STYLES[tileType];
        if (!palette) return;

        const size = TILE_SIZE;
        const x = c * TILE_SIZE;
        const y = r * TILE_SIZE;
        const dim = LIGHTING.MEMORY_BRIGHTNESS;
        const tone = (color) => isMemory ? this.dimColor(color, dim) : color;

        // Which way the wall runs through this tile. A door with wall to its east
        // and west is filling a gap in an east-west run. A door with neither -- a
        // free-standing one, which the generator does produce -- defaults to the
        // same orientation so it still reads as a door rather than as a slab.
        const runsHorizontal = !((mask & NB.N) && (mask & NB.S)) || ((mask & NB.W) && (mask & NB.E));

        const span = this.doorSpan(c, r, tileType, runsHorizontal);
        const door = doorAtTile(c, r);
        const openness = door ? door.openness : 0;
        const unlocked = !!door && door.unlocked;
        const bleed = this.tileBleed();

        ctx.save();
        ctx.beginPath();
        ctx.rect(x - bleed, y - bleed, size + bleed * 2, size + bleed * 2);
        ctx.clip();

        // The floor, for the gap to show; then the jambs, in the surrounding
        // masonry, so the wall run continues through.
        this.drawFloorTile(ctx, c, r, style, isMemory, false);

        const jamb = Math.max(3, Math.round(size * 0.13));
        ctx.fillStyle = tone(style.wall.face);
        if (runsHorizontal) {
            ctx.fillRect(span.x, span.y, span.w, jamb);
            ctx.fillRect(span.x, span.y + span.h - jamb, span.w, jamb);
        } else {
            ctx.fillRect(span.x, span.y, jamb, span.h);
            ctx.fillRect(span.x + span.w - jamb, span.y, jamb, span.h);
        }
        ctx.fillStyle = tone(style.wall.shade);
        if (runsHorizontal) {
            ctx.fillRect(span.x, span.y + jamb - 2, span.w, 2);
            ctx.fillRect(span.x, span.y + span.h - jamb, span.w, 2);
        } else {
            ctx.fillRect(span.x + jamb - 2, span.y, 2, span.h);
            ctx.fillRect(span.x + span.w - jamb, span.y, 2, span.h);
        }

        // The recess between the jambs, which the leaves slide within and out of.
        let recessX, recessY, recessW, recessH;
        if (runsHorizontal) {
            recessX = span.x; recessY = span.y + jamb; recessW = span.w; recessH = span.h - jamb * 2;
        } else {
            recessX = span.x + jamb; recessY = span.y; recessW = span.w - jamb * 2; recessH = span.h;
        }

        const centreX = span.x + span.w / 2;
        const centreY = span.y + span.h / 2;
        const halfRun = runsHorizontal ? recessW / 2 : recessH / 2;
        const shift = openness * halfRun;

        ctx.save();
        ctx.beginPath();
        ctx.rect(recessX, recessY, recessW, recessH);
        ctx.clip();

        // Two leaves, parting from the seam. The first slides toward the low
        // coordinate, the second toward the high one; past the recess they are
        // inside the jamb, and clipped.
        const leaves = runsHorizontal
            ? [{ x: recessX - shift, y: recessY, w: halfRun, h: recessH, hinge: 'low' },
               { x: recessX + halfRun + shift, y: recessY, w: halfRun, h: recessH, hinge: 'high' }]
            : [{ x: recessX, y: recessY - shift, w: recessW, h: halfRun, hinge: 'low' },
               { x: recessX, y: recessY + halfRun + shift, w: recessW, h: halfRun, hinge: 'high' }];

        for (const leaf of leaves) {
            this.drawDoorLeaf(ctx, leaf, runsHorizontal, palette, tone, isMemory);
        }

        // Lock plate and keyhole ride the seam edge of the second leaf.
        if (!isMemory) {
            const plate = Math.round(size * 0.22);
            const plateX = runsHorizontal ? centreX + shift + plate / 2 + 2 : centreX;
            const plateY = runsHorizontal ? centreY : centreY + shift + plate / 2 + 2;
            ctx.fillStyle = palette.edge;
            ctx.fillRect(plateX - plate / 2, plateY - plate / 2, plate, plate);
            ctx.fillStyle = unlocked ? palette.body : palette.trim;
            ctx.fillRect(plateX - plate / 2 + 1, plateY - plate / 2 + 1, plate - 2, plate - 2);
            ctx.fillStyle = palette.edge;
            ctx.beginPath();
            ctx.arc(plateX, plateY - 1, 1.8, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillRect(plateX - 1, plateY - 1, 2, plate / 2 - 2);
        }

        ctx.restore();

        // Status lamp on the frame over the seam. Locked, it pulses -- the
        // cheapest possible way to say "this is a thing that could open" from
        // across a dark room. Unlocked, it burns steady.
        if (!isMemory && this.allowEmissive) {
            const seed = Math.floor(span.x / size) + Math.floor(span.y / size);
            const pulse = unlocked ? 0.8 : 0.55 + 0.45 * Math.sin((this.terrainPhase || 0) * 2.2 + seed);
            const reach = Math.max(span.w, span.h) * 0.3;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const halo = ctx.createRadialGradient(centreX, centreY, 0, centreX, centreY, reach);
            halo.addColorStop(0, `rgba(${palette.lamp},${0.34 * pulse})`);
            halo.addColorStop(1, `rgba(${palette.lamp},0)`);
            ctx.fillStyle = halo;
            ctx.fillRect(span.x, span.y, span.w, span.h);
            ctx.restore();
        }

        ctx.restore();
    }

    /**
     * One leaf of a door: body, edge, raised panel, studs and hinges.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context, clipped to the recess
     * @param {{x: number, y: number, w: number, h: number, hinge: string}} leaf - Leaf rectangle
     * @param {boolean} runsHorizontal - Whether the leaves sit side by side
     * @param {Object} palette - Entry from DOOR_STYLES
     * @param {(color: string) => string} tone - Memory dimming
     * @param {boolean} isMemory - Skip the trim in the memory pass
     */
    drawDoorLeaf(ctx, leaf, runsHorizontal, palette, tone, isMemory) {
        ctx.fillStyle = tone(palette.body);
        ctx.fillRect(leaf.x, leaf.y, leaf.w, leaf.h);

        ctx.fillStyle = tone(palette.edge);
        ctx.fillRect(leaf.x, leaf.y, leaf.w, 1);
        ctx.fillRect(leaf.x, leaf.y + leaf.h - 1, leaf.w, 1);
        ctx.fillRect(leaf.x, leaf.y, 1, leaf.h);
        ctx.fillRect(leaf.x + leaf.w - 1, leaf.y, 1, leaf.h);

        // Raised panel, inset from the leaf's edges.
        const inset = 4;
        ctx.fillStyle = tone(palette.panel);
        ctx.fillRect(leaf.x + inset, leaf.y + 3, Math.max(0, leaf.w - inset * 2), Math.max(0, leaf.h - 6));

        if (isMemory) return;

        // Studs along the rails, and hinges at the outer end.
        ctx.fillStyle = palette.trim;
        const studs = 3;
        for (let i = 0; i < studs; i++) {
            const t = (i + 1) / (studs + 1);
            if (runsHorizontal) {
                ctx.fillRect(Math.round(leaf.x + leaf.w * t) - 1, leaf.y + 2, 2, 2);
                ctx.fillRect(Math.round(leaf.x + leaf.w * t) - 1, leaf.y + leaf.h - 4, 2, 2);
            } else {
                ctx.fillRect(leaf.x + 2, Math.round(leaf.y + leaf.h * t) - 1, 2, 2);
                ctx.fillRect(leaf.x + leaf.w - 4, Math.round(leaf.y + leaf.h * t) - 1, 2, 2);
            }
        }

        const low = leaf.hinge === 'low';
        if (runsHorizontal) {
            const hx = low ? leaf.x + 1 : leaf.x + leaf.w - 4;
            for (const hy of [leaf.y + 5, leaf.y + leaf.h / 2, leaf.y + leaf.h - 7]) {
                ctx.fillRect(hx, hy - 1, 3, 3);
            }
        } else {
            const hy = low ? leaf.y + 1 : leaf.y + leaf.h - 4;
            for (const hx of [leaf.x + 5, leaf.x + leaf.w / 2, leaf.x + leaf.w - 7]) {
                ctx.fillRect(hx - 1, hy, 3, 3);
            }
        }
    }

    // =========================================================================
    // ROOM DECORATION
    // =========================================================================

    /**
     * Whether the tile beside a prop holds the same prop, so a run of benches
     * or lockers is drawn as one piece with end caps only at its ends.
     *
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} id - Decoration id
     * @returns {{w: boolean, e: boolean, n: boolean, s: boolean}} Same-prop neighbours
     */
    propNeighbours(c, r, id) {
        const decor = this.gameState.decor;
        const at = (cc, rr) => !!decor && cc >= 0 && cc < MAP_COLS && rr >= 0 && rr < MAP_ROWS &&
                               decor[rr * MAP_COLS + cc] === id;
        return { w: at(c - 1, r), e: at(c + 1, r), n: at(c, r - 1), s: at(c, r + 1) };
    }

    /**
     * Draws a solid prop: a crate, a vat, a pillar, standing on the floor.
     *
     * Props are lit as floor is -- they are not walls, and the light mask
     * covers them the way it covers the ground they stand on -- so the
     * shading that makes them read as objects has to be their own: a drop
     * shadow on the floor, a lit top face, a darker side face along the
     * bottom, and a rim highlight. The floor is drawn under every one, and
     * the same three modes apply as to everything static: lit with detail,
     * remembered dim, or sensed.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} id - A DECOR id at or above SOLID_FROM
     * @param {Object} style - Active wall style
     * @param {boolean} isMemory - Draw at remembered brightness
     * @param {boolean} detail - Lit pass: glows and fine detail
     */
    drawProp(ctx, c, r, id, style, isMemory, detail) {
        const size = TILE_SIZE;
        const x = c * size;
        const y = r * size;
        const dim = LIGHTING.MEMORY_BRIGHTNESS;
        const tone = (color) => isMemory ? this.dimColor(color, dim) : color;
        const glow = detail && this.allowEmissive && !isMemory;
        const phase = this.terrainPhase || 0;
        const cx = x + size / 2;
        const cy = y + size / 2;
        const nb = this.propNeighbours(c, r, id);

        this.drawFloorTile(ctx, c, r, style, isMemory, false);

        // --- helpers ---------------------------------------------------------
        const shadow = (sx, sy, w, h, blur = 0.34) => {
            ctx.fillStyle = `rgba(0,0,0,${blur})`;
            ctx.fillRect(sx + 3, sy + 4, w, h);
        };
        const roundShadow = (rx, ry, radius) => {
            ctx.fillStyle = 'rgba(0,0,0,0.34)';
            ctx.beginPath();
            ctx.ellipse(rx + 3, ry + 4, radius, radius * 0.9, 0, 0, Math.PI * 2);
            ctx.fill();
        };
        /** A box seen from above: top face, side face along the bottom, edges. */
        const block = (bx, by, w, h, top, side, edge, rim) => {
            const sideH = Math.max(4, Math.round(h * 0.2));
            ctx.fillStyle = tone(edge);
            ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
            ctx.fillStyle = tone(side);
            ctx.fillRect(bx, by + h - sideH, w, sideH);
            ctx.fillStyle = tone(top);
            ctx.fillRect(bx, by, w, h - sideH);
            ctx.fillStyle = tone(rim);
            ctx.fillRect(bx, by, w, 1);
            ctx.fillRect(bx, by, 1, h - sideH);
            return { top: by, bottom: by + h - sideH, sideTop: by + h - sideH };
        };
        /** A drum seen from above: side ring low, top disc with a highlight. */
        const drum = (dx, dy, radius, top, side, edge, rim) => {
            ctx.fillStyle = tone(edge);
            ctx.beginPath(); ctx.arc(dx, dy + 2, radius + 1, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = tone(side);
            ctx.beginPath(); ctx.arc(dx, dy + 2, radius, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = tone(top);
            ctx.beginPath(); ctx.arc(dx, dy - 1, radius, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = tone(rim);
            ctx.beginPath(); ctx.arc(dx - radius * 0.3, dy - radius * 0.35, radius * 0.32, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = tone(edge);
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(dx, dy - 1, radius, 0, Math.PI * 2); ctx.stroke();
        };
        const halo = (color, radius, alpha) => {
            if (!glow) return;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
            g.addColorStop(0, `rgba(${color},${alpha})`);
            g.addColorStop(1, `rgba(${color},0)`);
            ctx.fillStyle = g;
            ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
            ctx.restore();
        };
        const flame = (fx, fy, w, h, seed) => {
            const licks = 3;
            for (let i = 0; i < licks; i++) {
                const t = phase * (9 + i * 2.3) + seed + i * 2;
                const sway = Math.sin(t) * w * 0.25;
                const lick = h * (0.7 + 0.3 * Math.sin(t * 1.7 + i));
                const lx = fx + (i - 1) * w * 0.3;
                ctx.fillStyle = tone(i === 1 ? '#ffd35a' : '#ff8a2a');
                ctx.beginPath();
                ctx.moveTo(lx - w * 0.22, fy);
                ctx.quadraticCurveTo(lx + sway, fy - lick * 0.5, lx + sway * 0.4, fy - lick);
                ctx.quadraticCurveTo(lx + w * 0.22 + sway * 0.3, fy - lick * 0.4, lx + w * 0.22, fy);
                ctx.closePath();
                ctx.fill();
            }
            ctx.fillStyle = tone('#fff3b0');
            ctx.beginPath(); ctx.ellipse(fx, fy - h * 0.18, w * 0.16, h * 0.22, 0, 0, Math.PI * 2); ctx.fill();
        };
        // Horizontal runs (benches, racks, lockers, machines) join seamlessly.
        const runsEW = nb.w || nb.e;
        const runsNS = nb.n || nb.s;
        const left = nb.w ? x - 1 : x + 3;
        const right = nb.e ? x + size + 1 : x + size - 3;
        const top = nb.n ? y - 1 : y + 3;
        const bottom = nb.s ? y + size + 1 : y + size - 3;

        switch (id) {
            case DECOR.CRATE:
            case DECOR.CRATES: {
                shadow(x + 5, y + 5, size - 10, size - 10);
                block(x + 5, y + 5, size - 10, size - 10, '#9c7a45', '#5e4426', '#2a1c0e', '#c39a5c');
                // Planks across the lid, with grain
                ctx.fillStyle = tone('#7a5d33');
                for (let i = 1; i < 3; i++) ctx.fillRect(x + 6, y + 5 + i * 8, size - 12, 1);
                ctx.fillStyle = tone('#b08a50');
                for (let i = 0; i < 3; i++) ctx.fillRect(x + 8 + i * 3, y + 7 + i * 8, size - 22, 1);
                // Steel corner brackets and a strap
                ctx.fillStyle = tone('#3a3f44');
                for (const [bx, by] of [[6, 6], [size - 10, 6], [6, size - 15], [size - 10, size - 15]]) {
                    ctx.fillRect(x + bx, y + by, 4, 4);
                }
                ctx.fillRect(x + 5, cy - 3, size - 10, 2);
                if (id === DECOR.CRATES) {
                    // A smaller crate on top, set at an angle
                    ctx.save();
                    ctx.translate(cx + 2, cy - 4);
                    ctx.rotate(0.22);
                    shadow(-9, -9, 18, 18, 0.3);
                    block(-9, -9, 18, 18, '#b0895a', '#6a4b2a', '#2a1c0e', '#d4ad6e');
                    ctx.fillStyle = tone('#3a3f44');
                    ctx.fillRect(-9, -1, 18, 2);
                    ctx.restore();
                }
                break;
            }
            case DECOR.BARREL: {
                roundShadow(cx, cy, size * 0.36);
                drum(cx, cy, size * 0.36, '#7a5d36', '#3d2c17', '#1a1208', '#a7844f');
                // Hoops and a bung
                ctx.strokeStyle = tone('#2f3236');
                ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(cx, cy - 1, size * 0.26, 0, Math.PI * 2); ctx.stroke();
                ctx.fillStyle = tone('#2f3236');
                ctx.beginPath(); ctx.arc(cx + 4, cy + 2, 2.5, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = tone('#5c4325');
                ctx.fillRect(cx - 1, cy - size * 0.28, 2, size * 0.54);
                break;
            }
            case DECOR.VAT: {
                shadow(x + 4, y + 4, size - 8, size - 8);
                block(x + 4, y + 4, size - 8, size - 8, '#58676a', '#2d3638', '#141a1b', '#8a9a9c');
                // Glass top with the liquid under it
                ctx.fillStyle = tone('#0f2a14');
                ctx.fillRect(x + 8, y + 8, size - 16, size - 20);
                const wave = Math.sin(phase * 2.1 + c) * 1.5;
                ctx.fillStyle = tone('#3fbf3a');
                ctx.fillRect(x + 9, y + 10 + wave, size - 18, size - 23 - wave);
                ctx.fillStyle = tone('#8ff07a');
                ctx.fillRect(x + 9, y + 10 + wave, size - 18, 1.5);
                for (let i = 0; i < 4; i++) {
                    const bx = x + 11 + ((i * 6 + Math.floor(phase * 8) * (i + 1)) % (size - 22));
                    const by = y + size - 14 - ((Math.floor(phase * 11) + i * 6) % (size - 26));
                    ctx.beginPath(); ctx.arc(bx, by, 1.2, 0, Math.PI * 2); ctx.fill();
                }
                // Glass reflection and the pipes at the corners
                ctx.fillStyle = 'rgba(255,255,255,0.18)';
                ctx.fillRect(x + 9, y + 9, 6, size - 22);
                ctx.fillStyle = tone('#8a9a9c');
                ctx.fillRect(x + 5, y + 5, 5, 5);
                ctx.fillRect(x + size - 10, y + 5, 5, 5);
                halo('120,255,110', size * 0.9, 0.22);
                break;
            }
            case DECOR.CONSOLE: {
                shadow(left - x + x, y + 5, right - left, size - 10);
                block(left, y + 5, right - left, size - 10, '#3e454c', '#22272c', '#101316', '#6b7580');
                // The screen: a dark bezel, a lit panel, scanlines and a crawl
                ctx.fillStyle = tone('#0b1218');
                ctx.fillRect(x + 6, y + 7, size - 12, 15);
                ctx.fillStyle = tone('#4fc3ff');
                ctx.fillRect(x + 8, y + 9, size - 16, 11);
                ctx.fillStyle = tone('#0b1218');
                for (let i = 0; i < 5; i++) ctx.fillRect(x + 8, y + 10 + i * 2, size - 16, 0.6);
                const crawl = Math.floor(phase * 6 + c) % 4;
                ctx.fillStyle = tone('#d9f4ff');
                for (let i = 0; i < 3; i++) {
                    if ((i + crawl) % 4 === 0) continue;
                    ctx.fillRect(x + 10, y + 11 + i * 3, 4 + ((i * 7 + crawl * 3) % 10), 1);
                }
                // Keyboard strip and status LEDs
                ctx.fillStyle = tone('#2a3036');
                ctx.fillRect(x + 6, y + size - 15, size - 12, 6);
                ctx.fillStyle = tone('#4a525a');
                for (let i = 0; i < 6; i++) ctx.fillRect(x + 8 + i * 4, y + size - 14, 3, 2);
                const blink = Math.floor(phase * 3 + r) % 2 === 0;
                ctx.fillStyle = tone(blink ? '#ff5a48' : '#5a1f18');
                ctx.fillRect(x + size - 12, y + size - 14, 3, 3);
                ctx.fillStyle = tone('#48f08a');
                ctx.fillRect(x + size - 8, y + size - 14, 3, 3);
                halo('110,200,255', size * 0.8, 0.2);
                break;
            }
            case DECOR.BENCH: {
                shadow(left, y + 9, right - left, size - 18);
                block(left, y + 9, right - left, size - 18, '#6d7c7e', '#3b4749', '#1c2323', '#9aabad');
                // Steel legs at the ends, glassware on top
                ctx.fillStyle = tone('#3b4749');
                if (!nb.w) ctx.fillRect(x + 4, y + size - 13, 3, 5);
                if (!nb.e) ctx.fillRect(x + size - 7, y + size - 13, 3, 5);
                const seed = tileNoise(c, r, 5);
                if (seed < 0.5) {
                    ctx.fillStyle = tone('#cfe0e2');
                    ctx.beginPath(); ctx.arc(x + 12, cy - 2, 3.5, 0, Math.PI * 2); ctx.fill();
                    ctx.fillStyle = tone('#7fd0ff');
                    ctx.beginPath(); ctx.arc(x + 12, cy - 1, 2, 0, Math.PI * 2); ctx.fill();
                    ctx.fillStyle = tone('#cfe0e2');
                    ctx.fillRect(x + 22, cy - 6, 3, 9);
                    ctx.fillRect(x + 27, cy - 4, 3, 7);
                } else {
                    ctx.fillStyle = tone('#2a3032');
                    ctx.fillRect(x + 9, cy - 5, 14, 8);
                    ctx.fillStyle = tone('#48f08a');
                    ctx.fillRect(x + 11, cy - 3, 5, 3);
                    ctx.fillStyle = tone('#e8d8a0');
                    ctx.fillRect(x + 27, cy - 5, 6, 6);
                }
                break;
            }
            case DECOR.PILLAR: {
                const wall = style.wall;
                roundShadow(cx, cy, size * 0.36);
                // Square plinth, then the column
                ctx.fillStyle = tone(wall.shade);
                ctx.fillRect(x + 6, y + 8, size - 12, size - 12);
                ctx.fillStyle = tone(wall.face);
                ctx.fillRect(x + 6, y + 6, size - 12, size - 14);
                drum(cx, cy, size * 0.3, wall.cap, wall.shade, wall.mortar, wall.trim);
                // Fluting
                ctx.strokeStyle = tone(wall.shade);
                ctx.lineWidth = 1;
                ctx.beginPath();
                for (let i = 0; i < 8; i++) {
                    const a = i * Math.PI / 4;
                    ctx.moveTo(cx + Math.cos(a) * size * 0.12, cy - 1 + Math.sin(a) * size * 0.12);
                    ctx.lineTo(cx + Math.cos(a) * size * 0.28, cy - 1 + Math.sin(a) * size * 0.28);
                }
                ctx.stroke();
                break;
            }
            case DECOR.SARCOPHAGUS: {
                const wall = style.wall;
                shadow(x + 6, top, size - 12, bottom - top);
                block(x + 6, top, size - 12, bottom - top, wall.face, wall.shade, wall.mortar, wall.cap);
                // Carved border and a figure down the lid
                ctx.strokeStyle = tone(wall.shade);
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 9.5, (nb.n ? y : y + 6) + 0.5, size - 19, (nb.s ? y + size : y + size - 10) - (nb.n ? y : y + 6) - 1);
                ctx.fillStyle = tone(wall.cap);
                ctx.fillRect(cx - 2, nb.n ? y : y + 9, 4, (nb.s ? y + size : y + size - 12) - (nb.n ? y : y + 9));
                if (!nb.n) {
                    ctx.beginPath(); ctx.arc(cx, y + 12, 4, 0, Math.PI * 2); ctx.fill();
                    ctx.fillStyle = tone(wall.shade);
                    ctx.fillRect(cx - 2, y + 11, 1.5, 1.5);
                    ctx.fillRect(cx + 0.5, y + 11, 1.5, 1.5);
                }
                ctx.fillStyle = tone(wall.cap);
                ctx.fillRect(x + 12, cy - 1, size - 24, 2);
                break;
            }
            case DECOR.FURNACE: {
                shadow(left, y + 3, right - left, size - 6);
                block(left, y + 3, right - left, size - 6, '#3a3431', '#1a1614', '#0a0807', '#5a504a');
                // Riveted plates and a chimney
                ctx.fillStyle = tone('#5a504a');
                for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) ctx.fillRect(x + 7 + i * 12, y + 6 + j * 9, 2, 2);
                ctx.fillStyle = tone('#26221f');
                ctx.beginPath(); ctx.arc(x + size - 10, y + 10, 4.5, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = tone('#0a0807');
                ctx.beginPath(); ctx.arc(x + size - 10, y + 10, 2.5, 0, Math.PI * 2); ctx.fill();
                // The mouth, on the side face, with fire behind its bars
                ctx.fillStyle = tone('#120806');
                ctx.fillRect(cx - 9, y + size - 16, 18, 11);
                ctx.save();
                ctx.beginPath(); ctx.rect(cx - 8, y + size - 15, 16, 9); ctx.clip();
                flame(cx, y + size - 5, 14, 12, c * 3 + r);
                ctx.restore();
                ctx.fillStyle = tone('#3a3431');
                for (let i = -1; i <= 1; i++) ctx.fillRect(cx + i * 5 - 1, y + size - 16, 2, 11);
                halo('255,140,50', size * 1.1, 0.3);
                break;
            }
            case DECOR.MACHINE: {
                shadow(left, y + 4, right - left, size - 8);
                block(left, y + 4, right - left, size - 8, '#5b6670', '#2f363c', '#14181c', '#8a97a2');
                // Two gauges, a pipe, vents, and the warning lamp
                for (const gx of [x + 11, x + 23]) {
                    ctx.fillStyle = tone('#e8e4d8');
                    ctx.beginPath(); ctx.arc(gx, y + 13, 4, 0, Math.PI * 2); ctx.fill();
                    ctx.strokeStyle = tone('#14181c');
                    ctx.lineWidth = 1;
                    ctx.beginPath(); ctx.arc(gx, y + 13, 4, 0, Math.PI * 2); ctx.stroke();
                    const needle = Math.PI * (1.1 + 0.3 * Math.sin(phase * 1.3 + gx));
                    ctx.beginPath(); ctx.moveTo(gx, y + 13); ctx.lineTo(gx + Math.cos(needle) * 3, y + 13 + Math.sin(needle) * 3); ctx.stroke();
                }
                ctx.strokeStyle = tone('#3f474e');
                ctx.lineWidth = 3;
                ctx.beginPath(); ctx.moveTo(x + 6, y + 22); ctx.lineTo(x + size - 6, y + 22); ctx.stroke();
                ctx.strokeStyle = tone('#7c8894');
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(x + 6, y + 21); ctx.lineTo(x + size - 6, y + 21); ctx.stroke();
                ctx.fillStyle = tone('#14181c');
                for (let i = 0; i < 4; i++) ctx.fillRect(x + 8, y + 26 + i * 2, 12, 1);
                const pulse = 0.5 + 0.5 * Math.sin(phase * 4.4 + c + r);
                ctx.fillStyle = tone(pulse > 0.5 ? '#ff5040' : '#5a1a14');
                ctx.beginPath(); ctx.arc(x + size - 10, y + size - 12, 3, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = 'rgba(255,255,255,0.35)';
                ctx.beginPath(); ctx.arc(x + size - 11, y + size - 13, 1, 0, Math.PI * 2); ctx.fill();
                if (pulse > 0.5) halo('255,70,60', size * 0.7, 0.25 * pulse);
                break;
            }
            case DECOR.LOCKER: {
                shadow(left, y + 5, right - left, size - 10);
                block(left, y + 5, right - left, size - 10, '#6a7580', '#353d45', '#171b1f', '#98a4ae');
                // Two doors per tile: louvers, a handle, a name plate
                for (const dx of [x + 5, x + size / 2 + 1]) {
                    ctx.fillStyle = tone('#353d45');
                    ctx.fillRect(dx + (size / 2 - 6) - 1, y + 6, 1, size - 18);
                    for (let i = 0; i < 3; i++) ctx.fillRect(dx + 3, y + 9 + i * 3, size / 2 - 12, 1);
                    ctx.fillStyle = tone('#c8d0d6');
                    ctx.fillRect(dx + 3, y + 20, size / 2 - 12, 3);
                    ctx.fillStyle = tone('#d8dde2');
                    ctx.fillRect(dx + size / 2 - 10, y + 25, 2, 4);
                }
                break;
            }
            case DECOR.RACK: {
                shadow(left, y + 5, right - left, size - 10);
                block(left, y + 5, right - left, size - 10, '#4e555c', '#2a2f34', '#131618', '#7d868e');
                // Uprights at the ends, crossbars, and stock on the shelf
                ctx.fillStyle = tone('#2a2f34');
                if (!nb.w) ctx.fillRect(x + 4, y + 6, 3, size - 14);
                if (!nb.e) ctx.fillRect(x + size - 7, y + 6, 3, size - 14);
                ctx.fillRect(x + 3, cy - 1, size - 6, 2);
                const s = tileNoise(c, r, 11);
                ctx.fillStyle = tone(s < 0.33 ? '#9c7a45' : s < 0.66 ? '#6b7a80' : '#8a3a30');
                ctx.fillRect(x + 8, y + 9, 10, 7);
                ctx.fillStyle = tone(s < 0.5 ? '#6b7a80' : '#9c7a45');
                ctx.fillRect(x + 21, y + 8, 12, 8);
                ctx.fillStyle = tone('#c9d6d6');
                ctx.fillRect(x + 10, cy + 3, 3, 6);
                ctx.fillRect(x + 15, cy + 4, 3, 5);
                ctx.fillStyle = tone('#7a5a30');
                ctx.fillRect(x + 22, cy + 3, 10, 6);
                break;
            }
            case DECOR.BRAZIER: {
                roundShadow(cx, cy + 2, size * 0.28);
                // Three legs, an iron bowl, coals, fire
                ctx.strokeStyle = tone('#1c1a18');
                ctx.lineWidth = 2;
                ctx.beginPath();
                for (const a of [0.6, 2.7, 4.8]) {
                    ctx.moveTo(cx + Math.cos(a) * 6, cy + 2 + Math.sin(a) * 5);
                    ctx.lineTo(cx + Math.cos(a) * 13, cy + 6 + Math.sin(a) * 10);
                }
                ctx.stroke();
                drum(cx, cy, size * 0.27, '#3d3733', '#1c1a18', '#0e0d0c', '#5a524c');
                ctx.fillStyle = tone('#2a1408');
                ctx.beginPath(); ctx.arc(cx, cy - 1, size * 0.2, 0, Math.PI * 2); ctx.fill();
                const glowCoal = 0.7 + 0.3 * Math.sin(phase * 5 + c);
                ctx.fillStyle = tone(`rgb(255,${Math.round(90 * glowCoal)},20)`);
                for (let i = 0; i < 5; i++) {
                    const a = i * 1.26 + 0.4;
                    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * 4, cy - 1 + Math.sin(a) * 3, 1.6, 0, Math.PI * 2); ctx.fill();
                }
                flame(cx, cy + 2, 12, 16, c * 3 + r * 2);
                halo('255,170,70', size * 1.1, 0.32);
                break;
            }
            case DECOR.TANK: {
                roundShadow(cx, cy, size * 0.4);
                drum(cx, cy, size * 0.4, '#6b7a84', '#36414a', '#151a1e', '#9fb0ba');
                // A painted band, a valve wheel and a gauge
                ctx.strokeStyle = tone('#b0402c');
                ctx.lineWidth = 3;
                ctx.beginPath(); ctx.arc(cx, cy - 1, size * 0.3, 0, Math.PI * 2); ctx.stroke();
                ctx.strokeStyle = tone('#151a1e');
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(cx, cy - 1, 5, 0, Math.PI * 2); ctx.stroke();
                ctx.beginPath();
                for (let i = 0; i < 4; i++) {
                    const a = i * Math.PI / 2 + phase * 0.2;
                    ctx.moveTo(cx, cy - 1); ctx.lineTo(cx + Math.cos(a) * 5, cy - 1 + Math.sin(a) * 5);
                }
                ctx.stroke();
                ctx.fillStyle = tone('#e8e4d8');
                ctx.beginPath(); ctx.arc(cx + 9, cy - 8, 2.5, 0, Math.PI * 2); ctx.fill();
                break;
            }
            default:
                break;
        }
    }

    /**
     * Draws floor detail over a floor tile: a grate, a cable, a stain.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {number} id - A DECOR id below SOLID_FROM
     * @param {Object} style - Active wall style
     * @param {boolean} isMemory - Draw at remembered brightness
     * @param {boolean} detail - Lit pass: glows
     */
    drawFloorDecor(ctx, c, r, id, style, isMemory, detail) {
        const size = TILE_SIZE;
        const x = c * size;
        const y = r * size;
        const dim = LIGHTING.MEMORY_BRIGHTNESS;
        const tone = (color) => isMemory ? this.dimColor(color, dim) : color;
        const cx = x + size / 2;
        const cy = y + size / 2;
        const n = (salt) => tileNoise(c, r, salt);

        switch (id) {
            case DECOR.GRATE: {
                // A recessed grille: dark pit, bars with a lit top edge, a frame
                ctx.fillStyle = tone('#0c0e10');
                ctx.fillRect(x + 4, y + 4, size - 8, size - 8);
                for (let i = 0; i < 5; i++) {
                    ctx.fillStyle = tone('#3a4248');
                    ctx.fillRect(x + 6, y + 7 + i * 6, size - 12, 3);
                    ctx.fillStyle = tone('#5c666e');
                    ctx.fillRect(x + 6, y + 7 + i * 6, size - 12, 1);
                }
                ctx.strokeStyle = tone('#6a747c');
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 4.5, y + 4.5, size - 9, size - 9);
                break;
            }
            case DECOR.STRIPES: {
                ctx.save();
                ctx.beginPath();
                ctx.rect(x, y + size - 10, size, 8);
                ctx.clip();
                ctx.fillStyle = tone('#d6ac1f');
                ctx.fillRect(x, y + size - 10, size, 8);
                ctx.fillStyle = tone('#151515');
                for (let i = -1; i < 6; i++) {
                    ctx.beginPath();
                    ctx.moveTo(x + i * 8, y + size - 2);
                    ctx.lineTo(x + i * 8 + 8, y + size - 10);
                    ctx.lineTo(x + i * 8 + 12, y + size - 10);
                    ctx.lineTo(x + i * 8 + 4, y + size - 2);
                    ctx.closePath();
                    ctx.fill();
                }
                ctx.restore();
                // Worn: a few scuffs through the paint
                ctx.fillStyle = 'rgba(0,0,0,0.25)';
                ctx.fillRect(x + 6 + n(1) * 20, y + size - 8, 3 + n(2) * 6, 2);
                break;
            }
            case DECOR.CABLE: {
                const vertical = n(3) > 0.5;
                const draw = (width, color) => {
                    ctx.strokeStyle = tone(color);
                    ctx.lineWidth = width;
                    ctx.beginPath();
                    if (vertical) {
                        ctx.moveTo(cx - 6 + n(4) * 12, y);
                        ctx.quadraticCurveTo(cx + (n(5) - 0.5) * 16, cy, cx - 6 + n(6) * 12, y + size);
                    } else {
                        ctx.moveTo(x, cy - 6 + n(4) * 12);
                        ctx.quadraticCurveTo(cx, cy + (n(5) - 0.5) * 16, x + size, cy - 6 + n(6) * 12);
                    }
                    ctx.stroke();
                };
                draw(5, 'rgba(0,0,0,0.35)');
                draw(3, '#101012');
                draw(1, '#45454c');
                // A clip holding it down
                ctx.fillStyle = tone('#5a6068');
                if (vertical) ctx.fillRect(cx - 5, cy - 1, 10, 3); else ctx.fillRect(cx - 1, cy - 5, 3, 10);
                break;
            }
            case DECOR.PUDDLE: {
                const px = cx + (n(1) - 0.5) * 10;
                const py = cy + (n(2) - 0.5) * 10;
                const rx = 8 + n(3) * 8;
                const ry = 5 + n(4) * 5;
                ctx.fillStyle = 'rgba(8,12,18,0.45)';
                ctx.beginPath(); ctx.ellipse(px, py, rx, ry, n(5) * Math.PI, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = 'rgba(140,170,200,0.18)';
                ctx.beginPath(); ctx.ellipse(px - rx * 0.3, py - ry * 0.3, rx * 0.35, ry * 0.3, n(5) * Math.PI, 0, Math.PI * 2); ctx.fill();
                break;
            }
            case DECOR.RUBBLE: {
                for (let i = 0; i < 5; i++) {
                    const sx = x + 4 + n(10 + i) * (size - 12);
                    const sy = y + 4 + n(20 + i) * (size - 12);
                    const w = 3 + n(30 + i) * 5;
                    const h = 2 + n(40 + i) * 4;
                    ctx.fillStyle = 'rgba(0,0,0,0.3)';
                    ctx.fillRect(sx + 1, sy + 1, w, h);
                    ctx.fillStyle = tone(i % 2 ? style.wall.face : style.wall.shade);
                    ctx.fillRect(sx, sy, w, h);
                    ctx.fillStyle = tone(style.wall.cap);
                    ctx.fillRect(sx, sy, w, 1);
                }
                break;
            }
            case DECOR.BONES: {
                const a = n(7) * Math.PI;
                // A long bone
                ctx.save();
                ctx.translate(cx + (n(1) - 0.5) * 8, cy + (n(2) - 0.5) * 8);
                ctx.rotate(a);
                ctx.fillStyle = 'rgba(0,0,0,0.3)';
                ctx.fillRect(-9, 0, 18, 2);
                ctx.fillStyle = tone('#e0d6bd');
                ctx.fillRect(-9, -1.5, 18, 3);
                for (const bx of [-9, 9]) {
                    ctx.beginPath(); ctx.arc(bx, -1.5, 2.4, 0, Math.PI * 2); ctx.fill();
                    ctx.beginPath(); ctx.arc(bx, 1.5, 2.4, 0, Math.PI * 2); ctx.fill();
                }
                ctx.restore();
                // A skull, with sockets and a jaw
                const sx = cx + (n(8) - 0.5) * 14;
                const sy = cy + (n(9) - 0.5) * 14;
                ctx.fillStyle = 'rgba(0,0,0,0.3)';
                ctx.beginPath(); ctx.arc(sx + 1, sy + 1.5, 4.5, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = tone('#e0d6bd');
                ctx.beginPath(); ctx.arc(sx, sy, 4.5, 0, Math.PI * 2); ctx.fill();
                ctx.fillRect(sx - 3, sy + 3, 6, 3);
                ctx.fillStyle = tone('#2e2820');
                ctx.fillRect(sx - 3, sy - 1.5, 2, 2);
                ctx.fillRect(sx + 1, sy - 1.5, 2, 2);
                ctx.fillRect(sx - 2, sy + 4, 1, 1.5);
                ctx.fillRect(sx + 1, sy + 4, 1, 1.5);
                break;
            }
            case DECOR.VENT: {
                ctx.fillStyle = tone('#1c2024');
                ctx.fillRect(x + 7, y + 7, size - 14, size - 14);
                for (let i = 0; i < 5; i++) {
                    ctx.fillStyle = tone('#3e464d');
                    ctx.fillRect(x + 9, y + 9 + i * 4.4, size - 18, 2.5);
                    ctx.fillStyle = tone('#5d666e');
                    ctx.fillRect(x + 9, y + 9 + i * 4.4, size - 18, 0.8);
                }
                ctx.strokeStyle = tone('#5d666e');
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 7.5, y + 7.5, size - 15, size - 15);
                ctx.fillStyle = tone('#8a949c');
                for (const [bx, by] of [[8, 8], [size - 10, 8], [8, size - 10], [size - 10, size - 10]]) ctx.fillRect(x + bx, y + by, 1.5, 1.5);
                break;
            }
            case DECOR.DRAIN: {
                ctx.fillStyle = 'rgba(0,0,0,0.3)';
                ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = tone('#141618');
                ctx.beginPath(); ctx.arc(cx, cy, 8.5, 0, Math.PI * 2); ctx.fill();
                ctx.strokeStyle = tone('#5a6268');
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(cx, cy, 8.5, 0, Math.PI * 2); ctx.stroke();
                ctx.lineWidth = 1;
                ctx.beginPath();
                for (let i = -2; i <= 2; i++) {
                    ctx.moveTo(cx - 7, cy + i * 3); ctx.lineTo(cx + 7, cy + i * 3);
                    ctx.moveTo(cx + i * 3, cy - 7); ctx.lineTo(cx + i * 3, cy + 7);
                }
                ctx.stroke();
                // A wet ring around it
                ctx.fillStyle = 'rgba(80,110,140,0.12)';
                ctx.beginPath(); ctx.ellipse(cx, cy, 13, 11, 0, 0, Math.PI * 2); ctx.fill();
                break;
            }
            case DECOR.MOSS: {
                for (let i = 0; i < 4; i++) {
                    const mx = x + 6 + n(60 + i) * (size - 12);
                    const my = y + 6 + n(70 + i) * (size - 12);
                    const rx = 4 + n(80 + i) * 6;
                    ctx.fillStyle = 'rgba(52,96,44,0.5)';
                    ctx.beginPath(); ctx.ellipse(mx, my, rx, rx * 0.7, n(90 + i) * 3, 0, Math.PI * 2); ctx.fill();
                    ctx.fillStyle = 'rgba(120,180,90,0.35)';
                    ctx.beginPath(); ctx.ellipse(mx - rx * 0.3, my - rx * 0.2, rx * 0.4, rx * 0.3, 0, 0, Math.PI * 2); ctx.fill();
                }
                break;
            }
            case DECOR.SLAG: {
                const sx = cx + (n(1) - 0.5) * 8;
                const sy = cy + (n(2) - 0.5) * 8;
                ctx.fillStyle = tone('#221210');
                ctx.beginPath(); ctx.ellipse(sx, sy, 7 + n(3) * 7, 5 + n(4) * 4, n(5) * Math.PI, 0, Math.PI * 2); ctx.fill();
                // Cracks with heat still in them
                ctx.strokeStyle = tone('#ff7a2e');
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(sx - 5, sy); ctx.lineTo(sx - 1, sy + 1); ctx.lineTo(sx + 2, sy - 2); ctx.lineTo(sx + 6, sy - 1);
                ctx.moveTo(sx - 1, sy + 1); ctx.lineTo(sx, sy + 4);
                ctx.stroke();
                if (detail && this.allowEmissive && !isMemory) {
                    ctx.save();
                    ctx.globalCompositeOperation = 'lighter';
                    ctx.fillStyle = 'rgba(255,120,40,0.12)';
                    ctx.beginPath(); ctx.ellipse(sx, sy, 10, 7, 0, 0, Math.PI * 2); ctx.fill();
                    ctx.restore();
                }
                break;
            }
            case DECOR.PLATE: {
                ctx.fillStyle = 'rgba(0,0,0,0.12)';
                ctx.fillRect(x + 4, y + 4, size - 8, size - 8);
                ctx.strokeStyle = tone(style.wall.cap);
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 3.5, y + 3.5, size - 7, size - 7);
                ctx.strokeStyle = tone(style.wall.shade);
                ctx.strokeRect(x + 4.5, y + 4.5, size - 7, size - 7);
                ctx.fillStyle = tone(style.wall.cap);
                for (const [bx, by] of [[6, 6], [size - 8, 6], [6, size - 8], [size - 8, size - 8]]) {
                    ctx.beginPath(); ctx.arc(x + bx + 1, y + by + 1, 1.5, 0, Math.PI * 2); ctx.fill();
                }
                break;
            }
            case DECOR.MOSAIC: {
                ctx.fillStyle = tone(style.wall.shade);
                ctx.fillRect(x + 3, y + 3, size - 6, size - 6);
                ctx.fillStyle = tone(style.wall.face);
                for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
                    if ((i + j) % 2 === 0) ctx.fillRect(x + 4 + i * 8, y + 4 + j * 8, 7, 7);
                }
                ctx.fillStyle = tone(style.wall.trim);
                ctx.beginPath();
                ctx.moveTo(cx, y + 8); ctx.lineTo(x + size - 8, cy); ctx.lineTo(cx, y + size - 8); ctx.lineTo(x + 8, cy);
                ctx.closePath();
                ctx.fill();
                ctx.fillStyle = tone(style.wall.shade);
                ctx.fillRect(cx - 3, cy - 3, 6, 6);
                break;
            }
            case DECOR.LAMP: {
                // A caged ceiling lamp, seen from below: housing, cage bars, bright core
                ctx.fillStyle = tone('#22262b');
                ctx.beginPath(); ctx.arc(cx, cy, 8.5, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = tone('#fff6d6');
                ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
                ctx.strokeStyle = tone('#3a4046');
                ctx.lineWidth = 1;
                ctx.beginPath();
                for (let i = 0; i < 3; i++) {
                    const a = i * Math.PI / 3;
                    ctx.moveTo(cx - Math.cos(a) * 6, cy - Math.sin(a) * 6);
                    ctx.lineTo(cx + Math.cos(a) * 6, cy + Math.sin(a) * 6);
                }
                ctx.stroke();
                ctx.fillStyle = tone('#ffffff');
                ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.fill();
                if (detail && this.allowEmissive && !isMemory) {
                    ctx.save();
                    ctx.globalCompositeOperation = 'lighter';
                    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.9);
                    g.addColorStop(0, 'rgba(255,236,190,0.4)');
                    g.addColorStop(1, 'rgba(255,236,190,0)');
                    ctx.fillStyle = g;
                    ctx.fillRect(cx - size, cy - size, size * 2, size * 2);
                    ctx.restore();
                }
                break;
            }
            default:
                break;
        }
    }

    // =========================================================================
    // WINDOWS
    // =========================================================================

    /**
     * Draws a window: a wall with a glazed opening cut through it.
     *
     * The frame is the wall's own masonry, so a window reads as part of the run
     * it sits in rather than as a tile dropped on top. What shows through the
     * pane depends on what is behind: another room, which is simply whatever
     * the light and the geometry there put on screen, or the outside, which is
     * a band of sky over a dark horizon. Doom's outdoors is the sky flat and a
     * light level of 255, and it is the strongest contrast the game has -- so
     * an exterior window is bright, and the room borrows some of it.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {Object} style - Active wall style
     * @param {boolean} isMemory - Draw at remembered brightness
     * @param {boolean} detail - Lit pass: the glow through the glass
     */
    drawWindowTile(ctx, c, r, style, isMemory, detail) {
        const size = TILE_SIZE;
        const x = c * size;
        const y = r * size;
        const map = this.gameState.gameMap;
        const dim = LIGHTING.MEMORY_BRIGHTNESS;
        const tone = (color) => isMemory ? this.dimColor(color, dim) : color;

        // The frame first: the wall this window is cut into.
        this.drawWallTile(ctx, c, r, TILE_WALL, style, isMemory, detail);

        // Which way the opening runs. A window in a north or south wall is a
        // horizontal slot; one in a side wall is vertical.
        const open = (cc, rr) => map[rr] && map[rr][cc] !== undefined && !isWallLike(map[rr][cc]);
        const horizontal = open(c, r - 1) || open(c, r + 1);

        const inset = size * 0.18;
        const px = horizontal ? x + size * 0.08 : x + inset;
        const py = horizontal ? y + inset : y + size * 0.08;
        const pw = horizontal ? size * 0.84 : size - inset * 2;
        const ph = horizontal ? size - inset * 2 : size * 0.84;

        const outside = this.windowOutside(c, r);

        ctx.save();
        ctx.beginPath();
        ctx.rect(px, py, pw, ph);
        ctx.clip();

        if (outside) {
            // Sky over a horizon, running with the slot so it reads as depth.
            const sky = horizontal
                ? ctx.createLinearGradient(0, py, 0, py + ph)
                : ctx.createLinearGradient(px, 0, px + pw, 0);
            sky.addColorStop(0, tone(outside.sky[0]));
            sky.addColorStop(1, tone(outside.sky[1]));
            ctx.fillStyle = sky;
            ctx.fillRect(px, py, pw, ph);

            // The ground beyond, a dark band along the far edge.
            ctx.fillStyle = tone(outside.ground);
            if (horizontal) ctx.fillRect(px, py + ph * 0.66, pw, ph * 0.34);
            else ctx.fillRect(px + pw * 0.66, py, pw * 0.34, ph);

            if (outside.stars && !isMemory) {
                // Fixed per tile, so they do not crawl as the camera moves.
                ctx.fillStyle = 'rgba(255,255,255,0.75)';
                for (let i = 0; i < 5; i++) {
                    const n = tileNoise(c * 31 + i, r * 17 + i);
                    const sx = px + ((n * 977) % 1000) / 1000 * pw;
                    const sy = py + ((n * 613) % 1000) / 1000 * ph * 0.6;
                    ctx.fillRect(sx, sy, 1, 1);
                }
            }
        } else {
            // An interior window: the room beyond is drawn by its own tiles, so
            // the pane is just glass -- a dark tint with a highlight on it.
            ctx.fillStyle = tone('rgba(20, 26, 30, 0.55)');
            ctx.fillRect(px, py, pw, ph);
        }

        // Glass: a diagonal highlight across the pane.
        ctx.fillStyle = isMemory ? 'rgba(255,255,255,0.05)' : 'rgba(210, 235, 255, 0.13)';
        ctx.beginPath();
        if (horizontal) {
            ctx.moveTo(px, py + ph);
            ctx.lineTo(px + pw * 0.45, py);
            ctx.lineTo(px + pw * 0.62, py);
            ctx.lineTo(px + pw * 0.17, py + ph);
        } else {
            ctx.moveTo(px, py);
            ctx.lineTo(px + pw, py + ph * 0.45);
            ctx.lineTo(px + pw, py + ph * 0.62);
            ctx.lineTo(px, py + ph * 0.17);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Frame and mullions, over the glass.
        ctx.strokeStyle = tone(style.wall.shade);
        ctx.lineWidth = 2;
        ctx.strokeRect(px, py, pw, ph);
        ctx.strokeStyle = tone(style.wall.cap);
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (horizontal) {
            ctx.moveTo(x + size / 2, py);
            ctx.lineTo(x + size / 2, py + ph);
        } else {
            ctx.moveTo(px, y + size / 2);
            ctx.lineTo(px + pw, y + size / 2);
        }
        ctx.stroke();

        // Daylight spilling in, on the lit pass only.
        if (outside && detail && this.allowEmissive && !isMemory) {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const cx = x + size / 2;
            const cy = y + size / 2;
            const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 1.1);
            glow.addColorStop(0, this.withAlpha(outside.glow, 0.38));
            glow.addColorStop(1, this.withAlpha(outside.glow, 0));
            ctx.fillStyle = glow;
            ctx.fillRect(x - size, y - size, size * 3, size * 3);
            ctx.restore();
        }
    }

    /**
     * What a window looks out on, or null if it looks into another room.
     *
     * A window is exterior when the side away from the room it fronts is solid
     * rock for a few tiles -- there is no room back there, so it must be the
     * outside of the building.
     *
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @returns {Object|null} An entry of WINDOW_OUTSIDE, or null
     */
    windowOutside(c, r) {
        const map = this.gameState.gameMap;
        if (!isWindowExterior(map, c, r)) return null;
        const styles = this.gameState.tileStyles;
        const index = styles ? styles[r * MAP_COLS + c] : 0;
        return WINDOW_OUTSIDE[index % WINDOW_OUTSIDE.length];
    }

    /**
     * A colour with an alpha applied, for the daylight gradient.
     *
     * @param {string} hex - `#rrggbb`
     * @param {number} alpha - 0..1
     * @returns {string} An `rgba()` string
     */
    withAlpha(hex, alpha) {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }

    // =========================================================================
    // SWITCHES AND SLIDING WALLS
    // =========================================================================

    /**
     * Draws a section of wall that slides: the floor it uncovers, and the
     * masonry block displaced along its direction by how far it has slid,
     * clipped to the tile so it disappears into the rock beside it.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {Object} style - Active wall style
     * @param {boolean} isMemory - Draw at remembered brightness
     * @param {boolean} detail - Lit pass
     */
    drawSlideTile(ctx, c, r, style, isMemory, detail) {
        const slide = slideAtTile(c, r);
        const openness = slide ? slide.openness : 0;
        const size = TILE_SIZE;
        const x = c * size;
        const y = r * size;

        if (openness <= 0) {
            this.drawWallTile(ctx, c, r, TILE_WALL, style, isMemory, detail);
            return;
        }

        this.drawFloorTile(ctx, c, r, style, isMemory, false);

        // A groove in the floor where the wall runs, so the gap reads as a track
        ctx.fillStyle = isMemory ? this.dimColor(style.wall.shade, LIGHTING.MEMORY_BRIGHTNESS) : style.wall.shade;
        const dir = slide ? slide.dir : [1, 0];
        if (dir[0] !== 0) ctx.fillRect(x, y + size / 2 - 1, size, 2);
        else ctx.fillRect(x + size / 2 - 1, y, 2, size);

        const bleed = this.tileBleed();
        ctx.save();
        ctx.beginPath();
        ctx.rect(x - bleed, y - bleed, size + bleed * 2, size + bleed * 2);
        ctx.clip();
        // The whole section moves as one: each tile shifts by the section's
        // full width, so the far tile clears its own footprint last.
        const travel = openness * (slide ? slide.tiles.length : 1) * size;
        ctx.translate(dir[0] * travel, dir[1] * travel);
        this.drawWallTile(ctx, c, r, TILE_WALL, style, isMemory, detail);
        ctx.restore();
    }

    /**
     * Draws a switch: the wall it is set in, and the panel on the face that
     * fronts the room, with its lamp red until it has been thrown and green
     * after.
     *
     * @param {CanvasRenderingContext2D} ctx - Target context
     * @param {number} c - Tile column
     * @param {number} r - Tile row
     * @param {Object} style - Active wall style
     * @param {boolean} isMemory - Draw at remembered brightness
     * @param {boolean} detail - Lit pass: the lamp's glow
     */
    drawSwitchTile(ctx, c, r, style, isMemory, detail) {
        this.drawWallTile(ctx, c, r, TILE_WALL, style, isMemory, detail);

        const sw = switchAtTile(c, r);
        const map = this.gameState.gameMap;
        const size = TILE_SIZE;
        const x = c * size;
        const y = r * size;
        const dim = LIGHTING.MEMORY_BRIGHTNESS;
        const tone = (color) => isMemory ? this.dimColor(color, dim) : color;

        // Which face fronts the room
        let face = sw ? sw.face : null;
        if (!face) {
            const open = (cc, rr) => map[rr] && map[rr][cc] !== undefined && !isWallLike(map[rr][cc]);
            face = open(c, r + 1) ? 'N' : open(c, r - 1) ? 'S' : open(c + 1, r) ? 'W' : 'E';
        }
        // The panel sits on the face: for a switch on the north wall (face N
        // of the room), that is the tile's south edge.
        const horizontal = face === 'N' || face === 'S';
        const plateW = horizontal ? 18 : 8;
        const plateH = horizontal ? 8 : 18;
        const px = horizontal ? x + size / 2 - plateW / 2 : (face === 'W' ? x + size - plateW - 2 : x + 2);
        const py = horizontal ? (face === 'N' ? y + size - plateH - 2 : y + 2) : y + size / 2 - plateH / 2;

        ctx.fillStyle = tone('#1a1c1e');
        ctx.fillRect(px - 1, py - 1, plateW + 2, plateH + 2);
        ctx.fillStyle = tone('#5a6068');
        ctx.fillRect(px, py, plateW, plateH);
        ctx.fillStyle = tone('#8a929a');
        ctx.fillRect(px, py, plateW, 1);

        // Lever and lamp
        const on = !!sw && sw.on;
        const lampColor = on ? '#48f07a' : '#ff4a3a';
        const cx = px + plateW / 2;
        const cy = py + plateH / 2;
        ctx.fillStyle = tone('#22262a');
        if (horizontal) {
            ctx.fillRect(cx - 6, cy - 1.5, 5, 3);
            ctx.fillStyle = tone(on ? '#c8d0d6' : '#8a929a');
            ctx.fillRect(on ? cx - 3 : cx - 6, cy - 1.5, 2, 3);
        } else {
            ctx.fillRect(cx - 1.5, cy - 6, 3, 5);
            ctx.fillStyle = tone(on ? '#c8d0d6' : '#8a929a');
            ctx.fillRect(cx - 1.5, on ? cy - 3 : cy - 6, 3, 2);
        }
        ctx.fillStyle = tone(lampColor);
        ctx.beginPath();
        ctx.arc(horizontal ? cx + 5 : cx, horizontal ? cy : cy + 5, 2, 0, Math.PI * 2);
        ctx.fill();

        if (detail && this.allowEmissive && !isMemory) {
            const lx = horizontal ? cx + 5 : cx;
            const ly = horizontal ? cy : cy + 5;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, 10);
            g.addColorStop(0, on ? 'rgba(72,240,122,0.5)' : 'rgba(255,74,58,0.5)');
            g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = g;
            ctx.fillRect(lx - 10, ly - 10, 20, 20);
            ctx.restore();
        }
    }

    /**
     * A colour at a fraction of its brightness, as a CSS string.
     *
     * Memoised. The memory pass asks this for every face and edge of every wall
     * tile it draws, every frame, and the answer for a given colour and factor
     * never changes -- parsing the hex and building a fresh string each time was a
     * couple of thousand allocations a frame for nothing.
     *
     * @param {string} color - '#rrggbb' or 'rgb(r, g, b)'
     * @param {number} factor - Brightness multiplier, 0..1
     * @returns {string} The dimmed colour
     */
    dimColor(color, factor) {
        const key = color + '|' + factor;
        let cache = this.dimColorCache;
        if (!cache) cache = this.dimColorCache = new Map();
        let dimmed = cache.get(key);
        if (dimmed !== undefined) return dimmed;

        if (color.startsWith('#')) {
            const hex = color.substring(1);
            const r = Math.floor(parseInt(hex.substring(0, 2), 16) * factor);
            const g = Math.floor(parseInt(hex.substring(2, 4), 16) * factor);
            const b = Math.floor(parseInt(hex.substring(4, 6), 16) * factor);
            dimmed = `rgb(${r}, ${g}, ${b})`;
        } else if (color.startsWith('rgb')) {
            const matches = color.match(/\d+/g);
            if (matches && matches.length >= 3) {
                const r = Math.floor(parseInt(matches[0]) * factor);
                const g = Math.floor(parseInt(matches[1]) * factor);
                const b = Math.floor(parseInt(matches[2]) * factor);
                dimmed = `rgb(${r}, ${g}, ${b})`;
            }
        }

        // A named colour. There used to be a lookup table here mapping the three
        // CSS names the doors were painted in; the doors now carry their own hex
        // palettes (DOOR_STYLES) and every caller passes hex or rgb(), so anything
        // reaching this point is a colour the renderer does not know about. Grey at
        // the requested brightness is a visible, harmless answer.
        if (dimmed === undefined) dimmed = `rgba(128, 128, 128, ${factor})`;

        cache.set(key, dimmed);
        return dimmed;
    }

    /**
     * Sets up dynamic canvas sizing and window resize handling
     */
    setupDynamicCanvasSizing() {
        // Handle window resize
        window.addEventListener('resize', () => {
            this.updateCanvasSize();
        });

        // Initial size update
        this.updateCanvasSize();
    }

    /**
     * Updates canvas size based on window dimensions and zoom level
     */
    updateCanvasSize() {
        const container = document.getElementById('gameContainer');
        if (!container) return;

        // Get actual container size
        const containerRect = container.getBoundingClientRect();
        const containerWidth = containerRect.width;
        const containerHeight = containerRect.height;

        // Set canvas to fill entire container
        this.canvas.style.width = `${containerWidth}px`;
        this.canvas.style.height = `${containerHeight}px`;

        // Internal resolution matches the CSS size 1:1.
        //
        // NOTE: this means the game renders at 1x on HiDPI displays and is upscaled
        // by the browser, which looks soft on Retina screens. Fixing it properly
        // means scaling the backing store by devicePixelRatio AND converting every
        // consumer of canvas.width/height to CSS pixels -- mouse aiming
        // (entities.js updateAiming), the light mask and cone (js/lighting.js),
        // the fog overlay and the screen-space HUD all read it directly today.
        // Left as-is deliberately: the 1:1 mapping is what keeps those correct.
        this.canvas.width = containerWidth;
        this.canvas.height = containerHeight;

        // Store actual display size for scaling calculations.
        // (window.VIEWPORT_WIDTH/HEIGHT used to be written here but nothing ever read
        // them -- code that needed the viewport read the 800x600 constants instead,
        // which is what mispositioned the boss health bar.)
        this.displayWidth = containerWidth;
        this.displayHeight = containerHeight;
        this.scaleX = containerWidth / 800;
        this.scaleY = containerHeight / 600;

        console.log(`Canvas resized to ${containerWidth}x${containerHeight} (zoom ${this.zoomLevel})`);
    }


    /**
     * Zooms in the game view
     */
    zoomIn() {
        if (this.zoomLevel < this.maxZoom) {
            this.zoomLevel = Math.min(this.maxZoom, this.zoomLevel + this.zoomStep);
            console.log(`Zoomed in: ${this.zoomLevel.toFixed(1)}x`);
        }
    }

    /**
     * Zooms out the game view
     */
    zoomOut() {
        if (this.zoomLevel > this.minZoom) {
            this.zoomLevel = Math.max(this.minZoom, this.zoomLevel - this.zoomStep);
            console.log(`Zoomed out: ${this.zoomLevel.toFixed(1)}x`);
        }
    }
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize the game when the page loads
 */
document.addEventListener('DOMContentLoaded', () => {
    console.log("Main: DOM loaded, initializing game controller");
    const gameController = new GameController();

    // Make game controller globally accessible for aiming calculations
    window.gameController = gameController;
});

// Export for potential external access
export { GameController };