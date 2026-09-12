/**
 * GAME STATE MANAGEMENT MODULE
 * 
 * This module manages the overall game state, level progression, enemy spawning,
 * game loop coordination, and UI updates. It serves as the central coordinator
 * for all game systems and maintains consistency across the application.
 * 
 * Features:
 * - Centralized game state management
 * - Level progression and boss spawning logic
 * - Enemy management and cleanup
 * - Game loop coordination
 * - Save/load game state capability
 * - Difficulty management
 * 
 * @author TDDL Game Team
 * @version 1.0.0
 */

import { 
    MINI_BOSS_SPAWN_INTERVAL_MIN, MINI_BOSS_SPAWN_INTERVAL_MAX, PLAYER_DEATH_BEAT,
    MAP_COLS, MAP_ROWS, TILE_SIZE,
    getDifficultyMultipliers, TILE_PROP, TILE_SLIDE, TILE_SWITCH, TILE_SECRET_DOOR, AMMO_TYPES, WEAPON_STATS, TILE_EMPTY, TILE_WINDOW,
} from './constants.js';
import { generateMaze, validateMapConnectivity, createFallbackMap } from './map-generator.js';
import { Player, Enemy, Boss, MiniBoss } from './entities.js';
import { pickMonsterType, NOISE_RANGE_TILES } from './monsters.js';
import { blocksSightAt } from './utils.js';
import { registerDoors, updateDoors } from './doors.js';
import { camera, shuffleArray } from './utils.js';
import { resetLighting, updateLighting } from './lighting.js';
import { HealthPack, AmmoPack, bulletHitFraction, applyBulletHit, WeaponPack, Powerup} from './weapons.js';
import { isSolidDecor } from './decor.js';
import { resetParticles, updateParticles } from './particles.js';
import {
    playLevelCompleteSound, playGameOverSound, playDoorOpenSound, playDoorCloseSound,
    playSecretDoorOpenSound, playTeleportSound, playSwitchSound,
    playPowerupSound
} from './audio-system.js';
import { resetInputState } from './input-handler.js';
import { isOnTrigger, openCloset, pickTeleportSpots } from './traps.js';
import { spawnDust, spawnTeleportFog } from './particles.js';
import { Barrel, updateBarrels } from './barrels.js';
import { registerSwitches, updateSwitches, pressSwitchAt } from './switches.js';
import { registerSectors } from './sectors.js';

// =============================================================================
// LEVEL TALLY HELPERS
// =============================================================================

/** Frames per second the game loop is assumed to run at, for the clock. */
const TALLY_FPS = 60;

/**
 * Formats a frame count as a clock reading: "m:ss", or "h:mm:ss" past an hour.
 *
 * Time is counted in frames rather than wall-clock milliseconds so that a
 * tab left in the background, or a moment on the Game Over screen, does not
 * count against the player -- the way Doom counts tics, not seconds.
 *
 * @param {number} frames - Frames elapsed
 * @returns {string} The formatted time
 */
export function formatPlayTime(frames) {
    const total = Math.max(0, Math.floor((frames || 0) / TALLY_FPS));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
    return `${m}:${ss}`;
}

/**
 * Escapes text for insertion into innerHTML. The tally is built from numbers
 * and fixed strings, but the overlay must never be a place where an unescaped
 * value can land.
 *
 * @param {*} value - Anything; coerced to a string
 * @returns {string} The escaped text
 */
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// =============================================================================
// GAME STATE CLASS
// =============================================================================

/**
 * GameState class manages all aspects of the current game session
 * Coordinates between different game systems and maintains consistency
 */
/**
 * World-space centre of a group of tiles, for placing a sound on a door, a
 * switch or a sliding wall.
 *
 * @param {Array<{r: number, c: number}>} tiles - Tile coordinates
 * @returns {{x: number, y: number}}
 */
function tilesCentre(tiles) {
    const n = Math.max(1, tiles.length);
    const c = tiles.reduce((sum, t) => sum + t.c, 0) / n;
    const r = tiles.reduce((sum, t) => sum + t.r, 0) / n;
    return { x: (c + 0.5) * TILE_SIZE, y: (r + 0.5) * TILE_SIZE };
}

/**
 * How each ammo pool appears on the floor: which weapon's pickup it counts as,
 * and the look of the lettered box the artwork falls back to.
 */
const AMMO_PICKUPS = {
    bullets: { weapon: 'Pistol', color: '#FFFF00', char: 'B' },
    shells: { weapon: 'Shotgun', color: '#FFA500', char: 'S' },
    rockets: { weapon: 'Rocket Launcher', color: '#FF6347', char: 'R' },
    cells: { weapon: 'Plasma Gun', color: '#4AA8FF', char: 'C' },
};

/**
 * Builds an ammo pickup of Doom's two sizes.
 *
 * @param {number} x - World X
 * @param {number} y - World Y
 * @param {string} type - An AMMO_TYPES key
 * @param {boolean} [big=false] - A box rather than a clip
 * @param {number} [scale=1] - Fraction of the usual load; drops are half
 * @returns {AmmoPack}
 */
function makeAmmoPack(x, y, type, big = false, scale = 1) {
    const look = AMMO_PICKUPS[type];
    const spec = AMMO_TYPES[type];
    const amount = Math.max(1, Math.round((big ? spec.box : spec.clip) * scale));
    return new AmmoPack(x, y, look.weapon, amount, look.color, look.char, big);
}

export class GameState {
    /**
     * Creates a new game state instance
     */
    constructor() {
        // Core game state
        this.gameRunning = false;
        this.gameOver = false;
        this.isLevelCompleting = false;

        // Set while the end-of-level tally is on screen: the next level does
        // not start until the player asks for it (see continueToNextLevel).
        this.awaitingContinue = false;

        // What the player has done on this level and across the run so far
        // (see freshLevelStats / freshRunStats). Shown on the end-of-level
        // tally and on the Game Over screen.
        this.levelStats = this.freshLevelStats();
        this.runStats = this.freshRunStats();

        // Level and progression
        this.currentLevel = 1;
        this.score = 0;
        this.selectedDifficulty = 'medium';
        
        // Boss and level type tracking
        this.isBossLevel = false;
        this.isCurrentLevelMiniBoss = false;
        this.nextMiniBossSpawnLevel = 0;
        this.currentBoss = null;
        
        // Game entities
        this.player = null;
        this.enemies = [];
        this.barrels = [];
        this.bullets = [];
        this.explosions = [];
        this.temporaryVisualEffects = [];
        this.healthPacks = [];
        this.ammoPacks = [];
        this.weaponPacks = [];
        this.powerups = [];
        
        // World state
        this.gameMap = null;
        this.tileStyles = null;      // Per-tile wall style index; null means one look
        // Lighting state (lightMap / exploredMap / visionMap) is owned by
        // js/lighting.js and mirrored here each frame for convenience.
        this.lightMap = null;
        this.exploredMap = null;
        this.visionMap = null;
        
        // Input state is managed by input-handler.js (keys, mouse exports)
        
        // Game loop management
        this.gameLoopId = null;
        this.levelTransitionTimer = null;
        this.frameCount = 0;

        // Counts down while the player's death animation plays; the game-over
        // screen waits for it. -1 means the player is alive.
        this.playerDeathTimer = -1;

        // P_NoiseAlert: the walkable tiles the player's last shot was heard on,
        // and the frame it was fired. Monsters that look while it is fresh wake.
        this.noiseTiles = null;
        this.noiseFrame = -1;

        // True while an Arch-vile is alive: corpses stay where they fell so it
        // has something to raise. Recomputed every frame in updateEnemies().
        this.corpsesPersist = false;

        // Coordinate display cheat
        this.showCoordinates = false;

        // Performance panel, toggled with F3. Off by default: it is a tool for
        // working on the renderer, not part of the game.
        this.showPerf = false;

        // Minimap panel, toggled with M. On by default: it only ever shows ground
        // the player has already seen, so it gives nothing away, and a player who
        // wants the screen clear can turn it off.
        this.showMinimap = true;

        // Make state globally accessible for backwards compatibility
        window.gameState = this;
    }

    // =============================================================================
    // GAME LIFECYCLE MANAGEMENT
    // =============================================================================

    /**
     * Starts a new game session
     * Resets all state and initializes the first level
     */
    startGame() {
        console.log("GameState: Starting new game");
        
        // Reset game state
        this.score = 0;
        this.currentLevel = 1;
        this.gameOver = false;
        this.nextMiniBossSpawnLevel = 0;
        this.runStats = this.freshRunStats();

        // Create player at default position
        this.player = new Player(400, 300); // Will be repositioned by level init
        
        if (isNaN(this.player.x) || isNaN(this.player.y)) {
            console.error("CRITICAL ERROR: Player position is NaN after creation");
            this.player.x = 400;
            this.player.y = 300;
        }
        
        console.log(`GameState: Player created at x:${this.player.x}, y:${this.player.y}`);
        
        // Initialize first level
        this.initLevel();
        console.log("GameState: Game start completed");
    }

    /**
     * Initializes a new level
     * Handles level generation, entity spawning, and UI updates
     */
    initLevel() {
        console.log(`GameState: Initializing Level ${this.currentLevel}`);

        // Reset level state
        this.isLevelCompleting = false;
        this.gameRunning = true;
        this.currentBoss = null;
        this.playerDeathTimer = -1;

        // Reset random spawning timer
        this.lastSpawnTime = this.frameCount;

        // Last level's gunfire is not this level's
        this.noiseTiles = null;
        this.noiseFrame = -1;
        this.corpsesPersist = false;

        // Every level starts unexplored and unlit
        resetLighting();
        
        // Determine level type
        this.isBossLevel = (this.currentLevel % 5 === 0);
        this.isCurrentLevelMiniBoss = false;
        
        this.determineMiniBoßLevel();
        this.generateLevel();
        this.levelStats = this.freshLevelStats();
        this.levelStats.secretsTotal = this.countSecretDoors();
        resetParticles(this.gameMap);
        registerDoors(this.gameMap);
        registerSwitches(this.switchPlan);
        registerSectors(this.sectorPlan);
        this.setupPlayerPosition();
        this.updateUIElements();
        this.spawnLevelEntities();
        this.placeLevelAmmo();
        this.spawnSecretLoot();
        this.armTraps();

        console.log(`GameState: Level ${this.currentLevel} initialization complete`);
    }

    /**
     * Determines if current level should have a mini-boss
     */
    determineMiniBoßLevel() {
        if (!this.isBossLevel) {
            if (this.currentLevel === 3) {
                this.isCurrentLevelMiniBoss = true;
                console.log("Level 3: Mini-Boss will spawn");
                this.nextMiniBossSpawnLevel = this.currentLevel + 
                    MINI_BOSS_SPAWN_INTERVAL_MIN + 
                    Math.floor(Math.random() * (MINI_BOSS_SPAWN_INTERVAL_MAX - MINI_BOSS_SPAWN_INTERVAL_MIN + 1));
            } else if (this.currentLevel > 3) {
                if (this.nextMiniBossSpawnLevel === 0 || this.currentLevel >= this.nextMiniBossSpawnLevel) {
                    this.isCurrentLevelMiniBoss = true;
                    console.log(`Level ${this.currentLevel}: Random Mini-Boss will spawn`);
                    this.nextMiniBossSpawnLevel = this.currentLevel + 
                        MINI_BOSS_SPAWN_INTERVAL_MIN + 
                        Math.floor(Math.random() * (MINI_BOSS_SPAWN_INTERVAL_MAX - MINI_BOSS_SPAWN_INTERVAL_MIN + 1));
                    console.log("Next potential Mini-Boss level:", this.nextMiniBossSpawnLevel);
                }
            }
        }
    }

    /**
     * Generates the level map and validates connectivity
     */
    generateLevel() {
        // Generate map
        const mapData = generateMaze(MAP_COLS, MAP_ROWS, this.isBossLevel);
        this.gameMap = mapData.gameMap;
        
        // Validate map connectivity
        if (!validateMapConnectivity(this.gameMap, mapData.playerStart)) {
            console.warn("Generated map failed connectivity check, using fallback");
            const fallbackData = createFallbackMap(MAP_COLS, MAP_ROWS);
            this.gameMap = fallbackData.gameMap;
            mapData.playerStart = fallbackData.playerStart;
            mapData.bossSpawn = fallbackData.bossSpawn;
            // The zone looks described a map that has just been thrown away.
            mapData.tileStyles = null;
            mapData.traps = [];
            mapData.decor = null;
            mapData.decorLights = [];
            mapData.barrels = [];
            mapData.switchPlan = null;
            mapData.sectors = null;
            mapData.windows = [];
            mapData.secrets = [];
        }
        
        // Store spawn positions
        this.playerSpawn = mapData.playerStart;
        this.bossSpawn = mapData.bossSpawn;

        // Which look each tile wears, for levels built as gated zones. Null on boss
        // arenas and on the fallback layout, where the whole map shares one look.
        this.tileStyles = mapData.tileStyles || null;

        // The level's traps, planned by the generator and armed once the
        // monsters are spawned (see armTraps).
        this.traps = mapData.traps || [];

        // What is standing in the rooms (see js/decor.js): a decoration id per
        // tile, the lights the glowing ones give off, and each room's purpose.
        this.decor = mapData.decor || null;
        this.decorLights = mapData.decorLights || [];
        this.roomKinds = mapData.roomKinds || {};
        this.rooms = mapData.rooms || [];

        // What the hidden rooms hold (see placeSecretRooms in js/map-generator.js):
        // spawned as entities once the level's arrays exist.
        this.secretSuites = mapData.secrets || [];

        // Barrels and switches, planned by the generator (see js/barrels.js
        // and js/switches.js); the barrels are spawned with the level's other
        // entities, the switches installed with its doors.
        this.pendingBarrels = mapData.barrels || [];
        this.switchPlan = mapData.switchPlan || null;
        // The overhead lighting every room is assumed to have (js/sectors.js)
        this.sectorPlan = mapData.sectors || null;
        this.windows = mapData.windows || [];
        
        console.log("GameState: Map generated successfully");
    }

    /**
     * Sets up player position and resets level-specific player state
     */
    setupPlayerPosition() {
        if (this.player && this.playerSpawn) {
            this.player.x = this.playerSpawn.c * TILE_SIZE + TILE_SIZE / 2;
            this.player.y = this.playerSpawn.r * TILE_SIZE + TILE_SIZE / 2;

            // WEAPON_STATS damage scales with currentLevel, but it was only ever
            // evaluated once when the Player was constructed. Without this the
            // Pistol and Knife stayed at their level-1 damage for the whole run.
            this.player.refreshWeaponDamage();

            // Reset keys for non-boss levels
            if (!this.isBossLevel) {
                this.player.keysCollected = { red: false, yellow: false, blue: false };
            }
        } else {
            console.error("GameState: Player or spawn position is null");
            this.showStartScreen();
            return;
        }
    }

    /**
     * Updates UI elements for the new level
     */
    updateUIElements() {
        this.player?.updateKeyUI();
        this.player?.updateWeaponUI();
        this.player?.updateHealthDisplay();
        this.player?.updateScoreDisplay();
        
        // Update level display
        const waveDisplay = document.getElementById('waveDisplay');
        if (waveDisplay) {
            waveDisplay.textContent = this.currentLevel;
        }
        
        // Seed lighting so the first rendered frame is already lit correctly
        if (this.player && this.gameMap) {
            updateLighting(this);
        }
    }

    /**
     * Spawns entities for the current level
     */
    spawnLevelEntities() {
        // Reset entity arrays
        this.bullets = [];
        this.enemies = [];
        this.barrels = (this.pendingBarrels || []).map(spot => new Barrel(spot.x, spot.y));
        this.healthPacks = [];
        this.ammoPacks = [];
        this.weaponPacks = [];
        this.powerups = [];
        this.explosions = [];
        this.temporaryVisualEffects = [];
        
        // Update camera
        if (this.player) {
            camera.update(this.player);
        }
        
        // Spawn boss or enemies based on level type
        if (this.isBossLevel && this.bossSpawn) {
            this.spawnMainBoss();
        } else if (this.isCurrentLevelMiniBoss) {
            this.spawnMiniBoss();
        } else {
            this.spawnRegularEnemies();
        }
    }

    /**
     * Spawns the main boss for boss levels
     */
    spawnMainBoss() {
        const bossSpawnX = this.bossSpawn.c * 40 + 20;
        const bossSpawnY = this.bossSpawn.r * 40 + 20;
        this.currentBoss = new Boss(bossSpawnX, bossSpawnY, this.currentLevel);
        console.log(`GameState: Main Boss spawned at level ${this.currentLevel}`);
    }

    /**
     * Spawns a mini-boss for mini-boss levels
     */
    spawnMiniBoss() {
        // The mini-boss blocks the level exit until it dies, so where it lands is a
        // correctness concern, not just a cosmetic one. The previous version picked a
        // raw random point with no map check at all: spawning it inside solid rock
        // left it unreachable and unkillable, and the exit locked forever.
        const MINI_BOSS_RADIUS = 40 * 0.8;              // Matches MiniBoss radius
        const CLEARANCE = Math.ceil(MINI_BOSS_RADIUS / 40); // Tiles of empty space needed
        const MIN_DISTANCE_FROM_PLAYER = 200;

        const spot = this.findClearSpawnTile(CLEARANCE, MIN_DISTANCE_FROM_PLAYER)
                  || this.findClearSpawnTile(CLEARANCE, 0);   // Relax the distance rule
        let spawnX, spawnY;

        if (spot) {
            spawnX = spot.x;
            spawnY = spot.y;
        } else {
            // Nothing suitable anywhere: drop it on the player's own start tile,
            // which is guaranteed walkable. Better a close fight than a dead level.
            console.warn("GameState: No clear mini-boss spawn found, using player spawn");
            spawnX = this.player ? this.player.x : 400;
            spawnY = this.player ? this.player.y : 300;
        }

        this.currentBoss = new MiniBoss(spawnX, spawnY);
        console.log(`GameState: Mini-Boss spawned at level ${this.currentLevel} (${Math.round(spawnX)}, ${Math.round(spawnY)})`);
    }

    /**
     * Finds a walkable world position with enough empty space around it for an
     * entity of the given tile clearance, reachable from the player's position.
     *
     * @param {number} clearance - Required empty tiles in each direction
     * @param {number} minPlayerDistance - Minimum world-pixel distance from the player
     * @returns {{x: number, y: number}|null} World coordinates, or null if none found
     */
    findClearSpawnTile(clearance, minPlayerDistance) {
        if (!this.gameMap) return null;

        const reachable = this.getReachableTiles();
        const candidates = [];

        for (let tileY = clearance; tileY < MAP_ROWS - clearance; tileY++) {
            for (let tileX = clearance; tileX < MAP_COLS - clearance; tileX++) {
                if (!reachable.has(tileY * MAP_COLS + tileX)) continue;

                // Require a clear block so the entity is not born inside geometry
                let clear = true;
                for (let dy = -clearance; dy <= clearance && clear; dy++) {
                    for (let dx = -clearance; dx <= clearance; dx++) {
                        if (this.gameMap[tileY + dy][tileX + dx] !== 0) { clear = false; break; }
                    }
                }
                if (!clear) continue;

                const worldX = tileX * 40 + 20;
                const worldY = tileY * 40 + 20;

                if (this.player && minPlayerDistance > 0 &&
                    Math.hypot(worldX - this.player.x, worldY - this.player.y) < minPlayerDistance) {
                    continue;
                }

                candidates.push({ x: worldX, y: worldY });
            }
        }

        if (candidates.length === 0) return null;
        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    /**
     * Flood-fills the walkable tiles reachable from the player's current position.
     * Closed doors are treated as passable because the player can open them with the
     * matching key, so rooms behind them still count as legitimate spawn space.
     *
     * @returns {Set<number>} Set of reachable tiles encoded as (row * MAP_COLS + col)
     */
    getReachableTiles() {
        const reachable = new Set();
        if (!this.gameMap || !this.player) return reachable;

        const startX = Math.floor(this.player.x / TILE_SIZE);
        const startY = Math.floor(this.player.y / TILE_SIZE);
        if (startY < 0 || startY >= MAP_ROWS || startX < 0 || startX >= MAP_COLS) return reachable;

        const stack = [{ x: startX, y: startY }];
        while (stack.length > 0) {
            const { x, y } = stack.pop();
            if (x < 0 || x >= MAP_COLS || y < 0 || y >= MAP_ROWS) continue;

            const code = y * MAP_COLS + x;
            if (reachable.has(code)) continue;
            const t = this.gameMap[y][x];
            // Walls, props, switches and windows: everything a body cannot cross
            if (t === 1 || t === TILE_PROP || t === TILE_SLIDE || t === TILE_SWITCH || t === TILE_WINDOW) continue;

            reachable.add(code);
            // Neighbours are pushed as coordinates, not encoded offsets: +/-1 on the
            // packed code would wrap across row boundaries at the map's edges.
            stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
        }

        return reachable;
    }

    /**
     * Spawns regular enemies for standard levels
     */
    spawnRegularEnemies() {
        // How many monsters the level places is the one thing the skill level
        // changes about them, as in Doom (see getDifficultyMultipliers).
        const baseEnemyCount = 3 + Math.floor(this.currentLevel * 1.5);
        const skill = getDifficultyMultipliers(this.selectedDifficulty).monsterCount;
        const targetCount = Math.min(Math.round(baseEnemyCount * 5 * skill), 75); // 5x more enemies, cap at 75

        // Build the pool of legal spawn tiles once, then draw from it.
        //
        // This replaces per-enemy rejection sampling (up to 100 random darts per
        // enemy, each needing a clear 3x3 and minimum separation). As the pool
        // filled up the hit rate collapsed and spawning silently gave up, so levels
        // shipped with roughly half the enemies they asked for -- and the wasted
        // attempts still cost ~7500 map probes per level.
        const candidates = this.collectEnemySpawnTiles();
        shuffleArray(candidates);

        const MIN_SEPARATION_SQ = 80 * 80;
        const placed = [];

        for (const spot of candidates) {
            if (placed.length >= targetCount) break;

            // Keep enemies from stacking on top of each other
            let tooClose = false;
            for (const other of placed) {
                const dx = spot.x - other.x;
                const dy = spot.y - other.y;
                if (dx * dx + dy * dy < MIN_SEPARATION_SQ) { tooClose = true; break; }
            }
            if (tooClose) continue;

            this.enemies.push(new Enemy(spot.x, spot.y, this.chooseEnemyType()));
            placed.push(spot);
        }

        if (placed.length < targetCount) {
            console.warn(
                `GameState: Level ${this.currentLevel} had room for ${placed.length} of ` +
                `${targetCount} enemies (map too tight)`
            );
        }
        console.log(`GameState: ${this.enemies.length} enemies spawned for level ${this.currentLevel}`);
    }

    /**
     * Collects every tile an enemy may legally spawn on: reachable from the player,
     * surrounded by open space, and far enough from the player's start.
     *
     * @returns {Array<{x: number, y: number}>} World-space candidate positions
     */
    collectEnemySpawnTiles() {
        const candidates = [];
        if (!this.gameMap) return candidates;

        const reachable = this.getReachableTiles();
        const MIN_PLAYER_DISTANCE_SQ = 150 * 150;

        for (let tileY = 1; tileY < MAP_ROWS - 1; tileY++) {
            for (let tileX = 1; tileX < MAP_COLS - 1; tileX++) {
                if (this.gameMap[tileY][tileX] !== 0) continue;
                if (!reachable.has(tileY * MAP_COLS + tileX)) continue;

                // Require an open 3x3 so the enemy is not born wedged in geometry
                let clear = true;
                for (let dy = -1; dy <= 1 && clear; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (this.gameMap[tileY + dy][tileX + dx] !== 0) { clear = false; break; }
                    }
                }
                if (!clear) continue;

                const x = tileX * 40 + 20;
                const y = tileY * 40 + 20;

                if (this.player) {
                    const dx = x - this.player.x;
                    const dy = y - this.player.y;
                    if (dx * dx + dy * dy < MIN_PLAYER_DISTANCE_SQ) continue;
                }

                candidates.push({ x, y });
            }
        }

        return candidates;
    }

    /**
     * Chooses a monster for the current level, from the Doom roster.
     *
     * @returns {string} A key of MONSTERS (see js/monsters.js)
     */
    chooseEnemyType() {
        return pickMonsterType(this.currentLevel);
    }

    /**
     * P_NoiseAlert: a weapon has been fired here.
     *
     * Doom floods the sound through every sector connected to the one it was
     * made in, stopping only at closed doors and the mapper's sound-blocking
     * lines, and any monster whose sector it reaches wakes on its next look.
     * The same thing here is a breadth-first walk over open tiles from the
     * shot, capped at NOISE_RANGE_TILES steps in place of those lines; closed
     * doors are solid tiles, so they block it exactly as Doom's do.
     *
     * At most one flood a frame: automatic fire calls this every few frames,
     * and the answer cannot change between two shots in one update.
     *
     * @param {number} x - World X of the shot
     * @param {number} y - World Y of the shot
     */
    noiseAlert(x, y) {
        if (!this.gameMap) return;
        if (this.noiseFrame === this.frameCount && this.noiseTiles) return;

        const startX = Math.floor(x / TILE_SIZE);
        const startY = Math.floor(y / TILE_SIZE);
        if (startX < 0 || startX >= MAP_COLS || startY < 0 || startY >= MAP_ROWS) return;

        const reached = new Set([startY * MAP_COLS + startX]);
        let frontier = [[startX, startY]];

        for (let step = 0; step < NOISE_RANGE_TILES && frontier.length > 0; step++) {
            const next = [];
            for (const [cx, cy] of frontier) {
                for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
                    if (nx < 0 || nx >= MAP_COLS || ny < 0 || ny >= MAP_ROWS) continue;
                    const code = ny * MAP_COLS + nx;
                    if (reached.has(code)) continue;
                    // Sound passes props: a crate does not muffle a shotgun.
                    if (blocksSightAt(this.gameMap, nx, ny)) continue;
                    reached.add(code);
                    next.push([nx, ny]);
                }
            }
            frontier = next;
        }

        this.noiseTiles = reached;
        this.noiseFrame = this.frameCount;
    }

    // =============================================================================
    // LEVEL COMPLETION AND PROGRESSION
    // =============================================================================

    /**
     * Handles level completion and progression to next level
     */
    levelComplete() {
        if (this.isLevelCompleting) return; // Prevent double completion
        if (this.isPlayerDying()) return;   // Dying on the exit tile is still dying

        this.isLevelCompleting = true;
        console.log(`GameState: Level ${this.currentLevel} completed`);

        // Play level completion sound
        playLevelCompleteSound();

        // Stop game loop during transition
        this.gameRunning = false;
        if (this.gameLoopId) {
            cancelAnimationFrame(this.gameLoopId);
        }
        
        // Close the books on this level: whatever is still alive counts against
        // the kill tally, and the level's numbers roll into the run's.
        this.levelStats.enemiesTotal = this.levelStats.kills + this.countLivingEnemies();
        const cleared = this.currentLevel;
        this.foldLevelIntoRun();

        // Show the tally and wait. The next level starts when the player asks
        // for it (continueToNextLevel), not on a timer: a summary nobody has
        // time to read is not a summary.
        //
        // This used to be a two-second setTimeout, and if the player died on
        // (or just after) the frame the level completed -- an enemy bullet
        // already in flight, or rocket splash from the killing blow -- the Game
        // Over screen appeared and then the timer fired, hid that overlay and
        // started the next level over a dead player. Now showGameOverScreen()
        // clears awaitingContinue, so a stray Enter cannot do the same.
        this.clearLevelTransition();
        this.currentLevel++;
        this.showLevelCompleteMessage(cleared);
        this.awaitingContinue = true;
    }

    /**
     * Starts the next level from the end-of-level tally.
     *
     * @returns {boolean} True if the level started; false if nothing was waiting
     */
    continueToNextLevel() {
        if (!this.awaitingContinue) return false;
        if (this.gameOver || this.isPlayerDying()) return false;

        this.awaitingContinue = false;
        this.hideMessageOverlay();
        this.initLevel();
        this.startGameLoop();
        return true;
    }

    /**
     * Cancels a pending level transition: a tally waiting for the player, or
     * a scheduled advance if one was ever set.
     */
    clearLevelTransition() {
        this.awaitingContinue = false;
        if (this.levelTransitionTimer !== null && this.levelTransitionTimer !== undefined) {
            clearTimeout(this.levelTransitionTimer);
            this.levelTransitionTimer = null;
        }
    }

    /**
     * Shows the end-of-level tally: what the player killed, found and picked
     * up on the level just cleared, how long it took, and the score.
     *
     * @param {number} [cleared] - The level just cleared (currentLevel has
     *        already moved on to the next one)
     */
    showLevelCompleteMessage(cleared = this.currentLevel - 1) {
        const next = this.currentLevel;
        const nextNote = next % 5 === 0 ? ' -- a boss is waiting' : '';

        this.setOverlay({
            title: `Level ${cleared} Cleared`,
            text: `Next: Level ${next}${nextNote}`,
            rows: this.levelSummaryRows(this.levelStats),
            primary: 'continue',
            hint: 'Press Enter or Space to continue',
        });
    }

    /**
     * Hides the message overlay
     */
    hideMessageOverlay() {
        const messageOverlay = document.getElementById('messageOverlay');
        if (messageOverlay) {
            messageOverlay.style.display = 'none';
        }
    }

    /**
     * Shows game over screen
     */
    showGameOverScreen() {
        // If the tally was up, the player died on the level it was for.
        const diedOn = this.awaitingContinue ? this.currentLevel - 1 : this.currentLevel;

        this.gameOver = true;
        this.gameRunning = false;
        this.clearLevelTransition();

        // Play game over sound
        playGameOverSound();

        this.setOverlay({
            title: "Game Over",
            text: `You fell on Level ${diedOn}.`,
            rows: this.runSummaryRows(this.getRunTotals()),
            primary: 'restart',
            primaryLabel: 'Restart Game',
            showMainMenu: true,
            hint: 'Press Enter to play again',
        });

        if (this.gameLoopId) {
            cancelAnimationFrame(this.gameLoopId);
        }
    }

    /**
     * Shows the start screen
     */
    showStartScreen() {
        console.log("GameState: Showing start screen");

        this.setOverlay({
            title: "Top-Down Doom-like",
            text: "Pick a difficulty and start your mission.",
            primary: 'start',
            primaryLabel: 'Start Game',
            showDifficulty: true,
            showInstructions: true,
            hint: 'Press Enter to start',
        });
    }

    // =============================================================================
    // THE LEVEL TALLY
    // =============================================================================

    /**
     * @returns {Object} A zeroed per-level tally
     */
    freshLevelStats() {
        return {
            kills: 0,           // Monsters killed, bosses included
            enemiesTotal: 0,    // kills + whatever was still alive; set at level end
            secretsFound: 0,    // Secret doors pushed open
            secretsTotal: 0,    // Secret doors the level was built with
            items: 0,           // Keys, weapons, health and ammo picked up
            frames: 0,          // Frames of play on this level
            folded: false,      // Already added to runStats
        };
    }

    /**
     * @returns {Object} A zeroed whole-run tally
     */
    freshRunStats() {
        return { levelsCleared: 0, kills: 0, enemiesTotal: 0, secretsFound: 0, secretsTotal: 0, items: 0, frames: 0 };
    }

    /**
     * @returns {number} How many secret doors the current map holds
     */
    countSecretDoors() {
        if (!this.gameMap) return 0;
        let n = 0;
        for (let r = 0; r < MAP_ROWS; r++) {
            const row = this.gameMap[r];
            if (!row) continue;
            for (let c = 0; c < MAP_COLS; c++) {
                if (row[c] === TILE_SECRET_DOOR) n++;
            }
        }
        return n;
    }

    /**
     * @returns {number} Monsters still alive, the boss included, dormant ones too
     */
    countLivingEnemies() {
        let n = this.enemies.filter(enemy => !enemy.isDead && enemy.health > 0).length;
        const boss = this.currentBoss;
        if (boss && !boss.isDead && boss.health > 0) n++;
        return n;
    }

    /**
     * A monster died. Called from the monsters' onDeath, so a resurrected
     * Arch-vile victim that dies again counts again -- as it does in Doom.
     *
     * @param {Object} [enemy] - The monster, unused for now
     */
    recordKill(enemy) {
        this.levelStats.kills++;
    }

    /** The player pushed open a secret door. */
    recordSecret() {
        this.levelStats.secretsFound++;
    }

    /**
     * The player picked something up.
     *
     * @param {string} [kind] - 'key', 'weapon', 'health' or 'ammo'; unused for now
     */
    recordItem(kind) {
        this.levelStats.items++;
    }

    /**
     * Adds the current level's tally to the run's, once.
     */
    foldLevelIntoRun() {
        const level = this.levelStats;
        if (level.folded) return;
        level.folded = true;

        const run = this.runStats;
        run.levelsCleared++;
        run.kills += level.kills;
        run.enemiesTotal += level.enemiesTotal;
        run.secretsFound += level.secretsFound;
        run.secretsTotal += level.secretsTotal;
        run.items += level.items;
        run.frames += level.frames;
    }

    /**
     * The run's totals, including the level in progress if it has not been
     * cleared yet -- the Game Over screen wants the kills from the level the
     * player died on.
     *
     * @returns {Object} Totals in the shape of freshRunStats()
     */
    getRunTotals() {
        const run = { ...this.runStats };
        const level = this.levelStats;
        if (!level.folded) {
            run.kills += level.kills;
            run.enemiesTotal += level.kills + this.countLivingEnemies();
            run.secretsFound += level.secretsFound;
            run.secretsTotal += level.secretsTotal;
            run.items += level.items;
            run.frames += level.frames;
        }
        return run;
    }

    /**
     * "found / total (pct%)", or "found / total" when there was nothing to find.
     */
    static ratio(found, total) {
        if (total <= 0) return `${found} / ${total}`;
        return `${found} / ${total} (${Math.round(100 * found / total)}%)`;
    }

    /**
     * The rows of the end-of-level tally.
     *
     * @param {Object} stats - A per-level tally, enemiesTotal already set
     * @returns {Array<{label: string, value: string, cls?: string, total?: boolean}>}
     */
    levelSummaryRows(stats) {
        const full = (found, total) => total > 0 && found >= total ? 'good' : '';
        return [
            { label: 'Enemies killed', value: GameState.ratio(stats.kills, stats.enemiesTotal), cls: full(stats.kills, stats.enemiesTotal) },
            { label: 'Secrets found', value: GameState.ratio(stats.secretsFound, stats.secretsTotal), cls: full(stats.secretsFound, stats.secretsTotal) },
            { label: 'Items picked up', value: String(stats.items) },
            { label: 'Time', value: formatPlayTime(stats.frames) },
            { label: 'Score', value: String(this.score), cls: 'score', total: true },
        ];
    }

    /**
     * The rows of the Game Over tally.
     *
     * @param {Object} totals - From getRunTotals()
     * @returns {Array<{label: string, value: string, cls?: string, total?: boolean}>}
     */
    runSummaryRows(totals) {
        const difficulty = this.selectedDifficulty || 'medium';
        return [
            { label: 'Levels cleared', value: String(totals.levelsCleared) },
            { label: 'Difficulty', value: difficulty.charAt(0).toUpperCase() + difficulty.slice(1) },
            { label: 'Enemies killed', value: GameState.ratio(totals.kills, totals.enemiesTotal) },
            { label: 'Secrets found', value: GameState.ratio(totals.secretsFound, totals.secretsTotal) },
            { label: 'Items picked up', value: String(totals.items) },
            { label: 'Time played', value: formatPlayTime(totals.frames) },
            { label: 'Final score', value: String(this.score), cls: 'score', total: true },
        ];
    }

    /**
     * Builds the tally's markup.
     *
     * @param {Array<{label: string, value: string, cls?: string, total?: boolean}>} rows
     * @returns {string} HTML for #levelSummary
     */
    renderSummary(rows) {
        return rows.map(row => {
            const rowClass = row.total ? 'summary-row total' : 'summary-row';
            const valueClass = row.cls ? `summary-value ${row.cls}` : 'summary-value';
            return `<div class="${rowClass}">` +
                   `<span class="summary-label">${escapeHtml(row.label)}</span>` +
                   `<span class="summary-leader"></span>` +
                   `<span class="${valueClass}">${escapeHtml(row.value)}</span>` +
                   `</div>`;
        }).join('');
    }

    /**
     * Puts the message overlay into one of its shapes: the start screen, the
     * end-of-level tally, or Game Over. Everything not asked for is hidden, so
     * no screen inherits a button or a table from the one before it.
     *
     * @param {Object} options
     * @param {string} options.title - The heading
     * @param {string} [options.text] - A line under it; hidden when empty
     * @param {Array|null} [options.rows] - Tally rows for renderSummary(), or none
     * @param {string} [options.primary] - 'start' | 'restart' (the restart button),
     *        'continue' (the continue button) or 'none'
     * @param {string} [options.primaryLabel] - Caption for the restart button
     * @param {boolean} [options.showDifficulty] - Show the difficulty picker
     * @param {boolean} [options.showInstructions] - Show the Instructions button
     * @param {boolean} [options.showMainMenu] - Show the Main Menu button
     * @param {string} [options.hint] - Small print under the buttons
     */
    setOverlay({ title, text = '', rows = null, primary = 'none', primaryLabel = '',
                 showDifficulty = false, showInstructions = false, showMainMenu = false,
                 hint = '' }) {
        const el = (id) => document.getElementById(id);
        const show = (id, on, mode = 'block') => {
            const element = el(id);
            if (element) element.style.display = on ? mode : 'none';
        };

        const titleEl = el('messageTitle');
        if (titleEl) titleEl.textContent = title;

        const textEl = el('messageText');
        if (textEl) {
            textEl.textContent = text;
            textEl.style.display = text ? 'block' : 'none';
        }

        const summary = el('levelSummary');
        if (summary) {
            summary.innerHTML = rows ? this.renderSummary(rows) : '';
            summary.style.display = rows ? 'block' : 'none';
        }

        show('difficultySelection', showDifficulty, 'flex');
        show('instructionsButton', showInstructions);
        show('mainMenuButton', showMainMenu);
        show('continueButton', primary === 'continue');

        const restart = el('restartButton');
        if (restart) {
            restart.style.display = (primary === 'start' || primary === 'restart') ? 'block' : 'none';
            if (primaryLabel) restart.textContent = primaryLabel;
        }

        const hintEl = el('overlayHint');
        if (hintEl) hintEl.textContent = hint;

        const overlay = el('messageOverlay');
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.style.visibility = 'visible';
            overlay.style.opacity = '1';
        } else {
            console.error("GameState: messageOverlay element not found!");
        }
    }

    // =============================================================================
    // GAME LOOP AND UPDATE LOGIC
    // =============================================================================

    /**
     * Starts the main game loop
     */
    startGameLoop() {
        if (this.gameLoopId) {
            cancelAnimationFrame(this.gameLoopId);
        }
        this.gameLoop();
    }

    /**
     * Main game loop: one simulation step per animation frame.
     *
     * Update only. Drawing is GameController's render loop, which runs on its own
     * requestAnimationFrame so a thrown frame of simulation cannot stop the
     * screen from repainting (and vice versa). The render() below is an empty
     * hook kept for that reason -- see it.
     */
    gameLoop() {
        this.frameCount++;
        
        if (!this.gameRunning || this.gameOver || this.isLevelCompleting) {
            return;
        }
        
        try {
            this.update();
            this.render();
            this.gameLoopId = requestAnimationFrame(() => this.gameLoop());
        } catch (error) {
            console.error("FATAL ERROR in gameLoop:", error, error.stack);
            this.gameRunning = false;
            this.showCriticalError(error);
        }
    }

    /**
     * Shows critical error screen
     * 
     * @param {Error} error - The error that occurred
     */
    showCriticalError(error) {
        const messageOverlay = document.getElementById('messageOverlay');
        const messageTitle = document.getElementById('messageTitle');
        const messageText = document.getElementById('messageText');
        const restartButton = document.getElementById('restartButton');
        
        if (messageTitle) messageTitle.textContent = "Critical Error!";
        if (messageText) {
            messageText.innerHTML = `A critical error occurred: ${error.message || JSON.stringify(error)}.<br>Check console for details. Restart required.`;
        }
        if (restartButton) {
            restartButton.textContent = "Restart Game";
            restartButton.style.display = 'block';
        }
        if (messageOverlay) messageOverlay.style.display = 'flex';
    }

    /**
     * Updates all game entities and systems
     */
    update() {
        try {
            if (!this.player) {
                console.error("GameState: Player is null, cannot update");
                this.gameRunning = false;
                return;
            }
            
            this.levelStats.frames++;
            this.updatePlayer();
            this.updatePlayerDeath();
            this.updateDoorsAndSounds();
            this.updateCamera();
            this.updateBullets();
            this.updateExplosions();
            updateBarrels(this);
            this.updateEffects();
            this.updatePickups();
            this.updateBoss();
            this.updateEnemies();
            this.resolveBulletCollisions();
            this.updateTraps();
            updateParticles(this);
            
        } catch (error) {
            console.error("Error in GameState.update:", error);
            throw error;
        }
    }

    /**
     * Updates player and handles visibility changes
     */
    updatePlayer() {
        this.player.update();

        // Lighting is recomputed every frame by the renderer (see lighting.js), so
        // there is nothing to invalidate here. This used to re-run a costly tile
        // visibility pass on tile crossings and aim changes, which both lagged the
        // flashlight and duplicated work.
    }

    /**
     * Starts the death sequence when the player is killed.
     *
     * The world keeps running and rendering for a beat so the death animation is
     * actually seen; the player stops acting in the meantime (see Player.update).
     * Safe to call every frame -- only the first call arms the timer.
     */
    beginPlayerDeath() {
        if (this.gameOver || this.isPlayerDying()) return;

        // Deliberately not setting gameOver here: gameLoop() and the renderer
        // both bail on it, so arming it now would freeze and blank the screen
        // before the beat could ever reach showGameOverScreen(). It is set there,
        // once the animation has played. Until then isPlayerDying() is what marks
        // the player as done for.
        this.playerDeathTimer = PLAYER_DEATH_BEAT;
    }

    /**
     * @returns {boolean} True while the player's death animation is playing
     */
    isPlayerDying() {
        return this.playerDeathTimer >= 0;
    }

    /**
     * Runs out the death beat, then shows the game-over screen.
     */
    updatePlayerDeath() {
        if (this.playerDeathTimer < 0) return;

        if (this.playerDeathTimer > 0) {
            this.playerDeathTimer--;
            return;
        }

        this.playerDeathTimer = -1;
        this.showGameOverScreen();
    }

    /**
     * Runs the doors a frame and voices what they did.
     */
    updateDoorsAndSounds() {
        for (const event of updateDoors(this)) {
            if (event.kind === 'open') playDoorOpenSound(event.door);
            else playDoorCloseSound(event.door);
        }
        for (const event of updateSwitches()) {
            if (event.kind === 'slide-start') playSecretDoorOpenSound(tilesCentre(event.slide.tiles));
        }
    }

    /**
     * Presses a switch, by touch or by a shot. A switch works once: a wall
     * slides aside, or a closet opens.
     *
     * @param {number} tileX - Tile column
     * @param {number} tileY - Tile row
     * @returns {boolean} True if this press turned it on
     */
    pressSwitchAt(tileX, tileY) {
        const sw = pressSwitchAt(tileX, tileY);
        if (!sw) return false;
        playSwitchSound(tilesCentre([{ r: tileY, c: tileX }]));
        if (sw.effect.kind === 'trap') {
            const trap = this.traps[sw.effect.trap];
            if (trap && !trap.fired) {
                trap.fired = true;
                this.fireTrap(trap);
            }
        }
        return true;
    }

    /**
     * Updates camera position
     */
    updateCamera() {
        camera.update(this.player);
    }

    /**
     * Updates all bullets and handles collisions
     */
    updateBullets() {
        // Moves every bullet. Spent ones are NOT pruned here: a bullet that hit
        // a wall this frame may have crossed a monster on the way, and the
        // collision pass needs its last segment to say so. It prunes.
        for (let i = 0; i < this.bullets.length; i++) {
            this.bullets[i].update();
        }
    }

    /**
     * Updates explosion effects
     */
    updateExplosions() {
        // Backward iteration with swap-and-pop, as the enemy and bullet loops
        // do: no fresh array per frame, and the swapped-in element is one this
        // pass has already visited.
        for (let i = this.explosions.length - 1; i >= 0; i--) {
            const explosion = this.explosions[i];
            explosion.update();
            if (explosion.life > 0) continue;
            this.explosions[i] = this.explosions[this.explosions.length - 1];
            this.explosions.pop();
        }
    }

    /**
     * Updates temporary visual effects
     */
    updateEffects() {
        const effects = this.temporaryVisualEffects;
        for (let i = effects.length - 1; i >= 0; i--) {
            if (--effects[i].life > 0) continue;
            effects[i] = effects[effects.length - 1];
            effects.pop();
        }
    }

    /**
     * Updates pickup items (health packs, ammo)
     */
    updatePickups() {
        if (!this.player) return;

        // Health pack pickups (backward iteration with swap-and-pop).
        // Only consume the pack if it actually healed -- walking over a medkit at
        // full health used to silently destroy it.
        for (let i = this.healthPacks.length - 1; i >= 0; i--) {
            const pack = this.healthPacks[i];
            if (Math.hypot(this.player.x - pack.x, this.player.y - pack.y) < this.player.radius + pack.radius) {
                if (this.player.gainHealth(pack.healthValue)) {
                    this.recordItem('health');
                    this.healthPacks[i] = this.healthPacks[this.healthPacks.length - 1];
                    this.healthPacks.pop();
                }
            }
        }

        // Ammo pack pickups -- same rule: leave it on the ground if it grants nothing
        for (let i = this.ammoPacks.length - 1; i >= 0; i--) {
            const pack = this.ammoPacks[i];
            if (Math.hypot(this.player.x - pack.x, this.player.y - pack.y) < this.player.radius + pack.radius) {
                if (this.player.addAmmo(pack.weaponName, pack.ammoAmount)) {
                    this.recordItem('ammo');
                    this.ammoPacks[i] = this.ammoPacks[this.ammoPacks.length - 1];
                    this.ammoPacks.pop();
                }
            }
        }

        // Dropped weapons: a new weapon is always taken; one already owned is
        // taken for its ammo, and left if that ammo is full.
        for (let i = this.weaponPacks.length - 1; i >= 0; i--) {
            const pack = this.weaponPacks[i];
            if (Math.hypot(this.player.x - pack.x, this.player.y - pack.y) < this.player.radius + pack.radius) {
                if (this.player.addWeapon({ name: pack.weaponName, pickupAmmo: pack.ammo })) {
                    this.recordItem('weapon');
                    this.weaponPacks[i] = this.weaponPacks[this.weaponPacks.length - 1];
                    this.weaponPacks.pop();
                }
            }
        }

        // Powerups. A soulsphere at 200 health stays on the floor; a backpack is
        // always worth something.
        for (let i = this.powerups.length - 1; i >= 0; i--) {
            const item = this.powerups[i];
            if (Math.hypot(this.player.x - item.x, this.player.y - item.y) >= this.player.radius + item.radius) continue;

            let taken = false;
            if (item.kind === 'soulsphere') {
                taken = this.player.gainHealth(100, { cap: 200, silent: true });
            } else if (item.kind === 'backpack') {
                this.player.addBackpack();
                taken = true;
            }
            if (taken) {
                playPowerupSound();
                this.recordItem('powerup');
                this.powerups[i] = this.powerups[this.powerups.length - 1];
                this.powerups.pop();
            }
        }
    }

    /**
     * Updates boss entities
     */
    updateBoss() {
        if (!this.currentBoss) return;

        this.currentBoss.update();

        if (this.currentBoss.health <= 0) {
            // A main boss IS the level: killing it completes it. A mini-boss only
            // seals the exit, so killing it should unlock that exit and let the
            // player walk out on their own -- ending the level instantly skipped
            // the rest of the map (and any loot still in it), including the rocket
            // launcher the mini-boss had just dropped.
            if (this.isBossLevel && !this.isLevelCompleting) {
                this.levelComplete();
            }

            // A mini-boss is an Enemy and draws from the sprite collection, so it
            // holds on long enough to play its death animation, exactly as a
            // regular enemy does. The main boss is drawn as a shape and has no
            // animation to wait for.
            const stillDying = typeof this.currentBoss.isReadyToRemove === 'function' &&
                               !this.currentBoss.isReadyToRemove();
            if (!stillDying) {
                this.currentBoss = null;
            }
        }
        // Bullet collisions are resolved centrally in resolveBulletCollisions()
    }

    /**
     * Updates regular enemies and removes the dead ones
     */
    updateEnemies() {
        // While an Arch-vile lives, the dead stay where they fell for it to raise.
        this.corpsesPersist = this.enemies.some(enemy => !enemy.isDead && enemy.def?.resurrects);

        // Backward iteration with swap-and-pop: the element swapped into slot i is
        // always one this pass has already visited, so nothing gets skipped.
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            const enemy = this.enemies[i];
            enemy.update();

            if (enemy.health > 0) continue;

            // Drops are awarded the moment the enemy dies, so the pickup appears
            // where it fell rather than a second later when the body clears.
            if (!enemy.dropHandled) {
                enemy.dropHandled = true;
                this.handleEnemyDrop(enemy);
            }

            // The body stays until its death animation has played out. It is
            // inert while it does: update() skips its AI and takeDamage() refuses
            // further hits.
            if (enemy.isReadyToRemove()) {
                this.enemies[i] = this.enemies[this.enemies.length - 1];
                this.enemies.pop();
            }
        }
    }

    /**
     * Resolves every bullet against the entities it can damage, in a single pass.
     *
     * This replaces a per-entity collision call that had two problems:
     *   - The "enemy bullet hits player" check lived *inside* the enemy loop, so
     *     once the last enemy died, in-flight enemy fire passed harmlessly through
     *     the player -- and while enemies were alive the same check ran once per
     *     enemy, damaging the player repeatedly for a single bullet's worth of hits.
     *   - It rebuilt the entire bullets array once per enemy per frame (up to 75
     *     allocations a frame at high enemy counts).
     *
     * Player fire damages only hostiles. Hostile fire damages the player, and
     * -- for infighting -- other monsters it runs into on the way.
     */
    resolveBulletCollisions() {
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const bullet = this.bullets[i];

            // A bullet that already died this frame -- on a wall, or by running
            // out -- still gets its last segment tested, unless it is a rocket
            // or a BFG shot, which detonated where it stopped.
            const spent = bullet.life <= 0;
            const testable = !spent || !(bullet.isRocket || bullet.isBFGMainProjectile);

            if (testable) {
                if (bullet.owner === 'player') {
                    this.resolvePlayerBullet(bullet);
                } else {
                    this.resolveHostileBullet(bullet);
                }
            }

            if (bullet.life <= 0) {
                this.bullets[i] = this.bullets[this.bullets.length - 1];
                this.bullets.pop();
            }
        }
    }

    /**
     * A player's bullet against the boss and every monster: the nearest thing
     * it crossed this frame takes the hit.
     *
     * @param {Object} bullet - Bullet instance
     */
    resolvePlayerBullet(bullet) {
        let nearest = null;
        let nearestAt = Infinity;

        const consider = (target) => {
            if (!target || target.health <= 0 || target.isDead || target.dormant) return;
            const at = bulletHitFraction(bullet, target);
            if (at < nearestAt) {
                nearest = target;
                nearestAt = at;
            }
        };

        consider(this.currentBoss);
        for (let j = 0; j < this.enemies.length; j++) consider(this.enemies[j]);
        for (let j = 0; j < this.barrels.length; j++) consider(this.barrels[j]);

        if (nearest) applyBulletHit(bullet, nearest);
    }

    /**
     * Hostile fire. The player is the usual victim, but a monster's projectile
     * also stops on any monster in its way, as in Doom's P_CheckThing: it
     * damages it and starts a fight, unless the two are the same species, in
     * which case it bursts harmlessly. Whichever it crossed first, wins.
     *
     * @param {Object} bullet - Bullet instance
     */
    resolveHostileBullet(bullet) {
        let nearest = null;
        let nearestAt = Infinity;

        const consider = (target) => {
            if (!target || target === bullet.shooter || target.health <= 0 || target.isDead || target.dormant) return;
            const at = bulletHitFraction(bullet, target);
            if (at < nearestAt) {
                nearest = target;
                nearestAt = at;
            }
        };

        consider(this.player);
        for (let j = 0; j < this.barrels.length; j++) consider(this.barrels[j]);
        if (bullet.shooter) {
            consider(this.currentBoss);
            for (let j = 0; j < this.enemies.length; j++) consider(this.enemies[j]);
        }

        if (!nearest) return;

        if (nearest !== this.player && nearest.species === bullet.species) {
            bullet.life = 0;
        } else {
            applyBulletHit(bullet, nearest);
        }
    }

    // =============================================================================
    // TRAPS
    // =============================================================================

    /**
     * Puts the closet monsters in their closets. They exist from the start of
     * the level, dormant: sealed behind the wall, undrawn, unhittable and not
     * listening, until the wall opens.
     */
    armTraps() {
        if (!this.traps) this.traps = [];
        for (const trap of this.traps) {
            trap.fired = false;
            if (trap.kind !== 'closet') continue;
            trap.enemies = trap.pocket.map((tile, i) => {
                const enemy = new Enemy(
                    tile.c * TILE_SIZE + TILE_SIZE / 2,
                    tile.r * TILE_SIZE + TILE_SIZE / 2,
                    trap.monsters[i]
                );
                enemy.dormant = true;
                enemy.ambush = true;
                this.enemies.push(enemy);
                return enemy;
            });
        }
    }

    /**
     * Fires any trap whose trigger the player is standing on.
     */
    updateTraps() {
        if (!this.player || !this.traps || this.traps.length === 0) return;
        const tileX = Math.floor(this.player.x / TILE_SIZE);
        const tileY = Math.floor(this.player.y / TILE_SIZE);

        for (const trap of this.traps) {
            if (trap.fired || !isOnTrigger(trap, tileX, tileY)) continue;
            trap.fired = true;
            this.fireTrap(trap);
        }
    }

    /**
     * Springs a trap: opens the closet and wakes what was inside, or brings
     * the ambush in by teleport.
     *
     * @param {Object} trap - A trap from js/traps.js
     */
    fireTrap(trap) {
        if (trap.kind === 'closet') {
            openCloset(this.gameMap, trap);
            playSecretDoorOpenSound();
            for (const tile of trap.door) {
                spawnDust(tile.c * TILE_SIZE + TILE_SIZE / 2, tile.r * TILE_SIZE + TILE_SIZE / 2, 10);
            }
            for (const enemy of trap.enemies || []) {
                if (enemy.isDead) continue;
                enemy.dormant = false;
                enemy.ambush = false;
                enemy.acquireTarget(this.player, true);
            }
            return;
        }

        const spots = pickTeleportSpots(this.gameMap, trap, this.player, trap.count);
        if (spots.length === 0) return;
        playTeleportSound();
        spots.forEach((spot, i) => {
            const enemy = new Enemy(spot.x, spot.y, trap.monsters[i % trap.monsters.length]);
            enemy.ambush = false;
            enemy.acquireTarget(this.player, i === 0);
            this.enemies.push(enemy);
            spawnTeleportFog(spot.x, spot.y);
        });
    }

    /**
     * Checks if ammo for a weapon is available at the current level
     */
    isAmmoAvailableAtLevel(weaponName) {
        const level = this.currentLevel;

        switch (weaponName) {
            case "Pistol":
                return true; // Always available
            case "Shotgun":
                return level >= 1; // Available from level 1 (ammo can be found before weapon)
            case "Rifle":
                return level >= 2; // Available from level 2
            case "Plasma Gun":
                return level >= 6; // Available from level 6
            case "Rocket Launcher":
                return level >= 4; // Available from level 4
            case "BFG":
                return level >= 6; // Available from level 6
            default:
                return false;
        }
    }

    /**
     * What a dead monster leaves behind, as in Doom: the four human zombies
     * drop what they were carrying, at half its usual load, and nothing else
     * drops anything. A Shotgun Guy is where the shotgun comes from on the
     * levels that do not place one.
     *
     * @param {Object} enemy - The monster that died
     */
    handleEnemyDrop(enemy) {
        const drop = enemy.def?.drop;
        if (!drop) return;

        if (drop.weapon && WEAPON_STATS[drop.weapon]) {
            const full = WEAPON_STATS[drop.weapon].pickupAmmo || 0;
            this.weaponPacks.push(new WeaponPack(enemy.x, enemy.y, drop.weapon, Math.max(1, Math.floor(full / 2))));
        } else if (drop.ammo && AMMO_PICKUPS[drop.ammo]) {
            this.ammoPacks.push(makeAmmoPack(enemy.x, enemy.y, drop.ammo, false, 0.5));
        }
    }

    /**
     * Scatters ammunition through the level's rooms the way a Doom map does:
     * clips and shells everywhere, boxes now and then, rockets and cells once
     * the weapons that use them are in play. The player's own room gets none;
     * everything else rolls once or twice.
     */
    placeLevelAmmo() {
        if (!this.gameMap || !this.rooms || this.rooms.length === 0) return;

        const level = this.currentLevel;
        const table = [
            { type: 'bullets', big: false, weight: 40 },
            { type: 'shells', big: false, weight: 30 },
            { type: 'bullets', big: true, weight: 8 },
            { type: 'shells', big: true, weight: 6 },
            { type: 'rockets', big: false, weight: level >= 4 ? 12 : 0 },
            { type: 'rockets', big: true, weight: level >= 6 ? 3 : 0 },
            { type: 'cells', big: false, weight: level >= 6 ? 10 : 0 },
            { type: 'cells', big: true, weight: level >= 8 ? 3 : 0 },
        ].filter(row => row.weight > 0);
        const totalWeight = table.reduce((sum, row) => sum + row.weight, 0);

        const start = this.playerSpawn;
        const inStartRoom = (room) => start &&
            start.c >= room.x && start.c < room.x + room.width &&
            start.r >= room.y && start.r < room.y + room.height;

        for (const room of this.rooms) {
            if (!room || inStartRoom(room)) continue;
            const count = 1 + (Math.random() < 0.35 ? 1 : 0);
            for (let i = 0; i < count; i++) {
                const spot = this.freeTileIn(room);
                if (!spot) break;

                let roll = Math.random() * totalWeight;
                let pick = table[0];
                for (const row of table) {
                    roll -= row.weight;
                    if (roll <= 0) { pick = row; break; }
                }
                this.ammoPacks.push(makeAmmoPack(
                    (spot.c + 0.5) * TILE_SIZE, (spot.r + 0.5) * TILE_SIZE, pick.type, pick.big));
            }
        }
    }

    /**
     * A random tile in a room that a pickup can sit on: bare floor, no prop on
     * it, and not the player's own square.
     *
     * @param {{x: number, y: number, width: number, height: number}} room - Tile bounds
     * @returns {{c: number, r: number}|null}
     */
    freeTileIn(room) {
        for (let attempt = 0; attempt < 12; attempt++) {
            const c = room.x + Math.floor(Math.random() * room.width);
            const r = room.y + Math.floor(Math.random() * room.height);
            if (this.isPickupTileFree(c, r)) return { c, r };
        }
        return null;
    }

    /**
     * @param {number} c - Column
     * @param {number} r - Row
     * @returns {boolean} True if a pickup can be placed on the tile
     */
    isPickupTileFree(c, r) {
        if (c < 1 || r < 1 || c >= MAP_COLS - 1 || r >= MAP_ROWS - 1) return false;
        if (!this.gameMap[r] || this.gameMap[r][c] !== TILE_EMPTY) return false;
        if (this.decor && isSolidDecor(this.decor[r * MAP_COLS + c])) return false;
        if (this.playerSpawn && Math.abs(this.playerSpawn.c - c) <= 1 && Math.abs(this.playerSpawn.r - r) <= 1) return false;
        for (const pack of this.ammoPacks) {
            if (Math.floor(pack.x / TILE_SIZE) === c && Math.floor(pack.y / TILE_SIZE) === r) return false;
        }
        return true;
    }

    /**
     * Spawns the entity half of the secret rooms' loot. Weapons and medikits in
     * a secret are map tiles the generator laid down; ammo and powerups are
     * entities, so they wait until the level's arrays exist.
     */
    spawnSecretLoot() {
        for (const suite of this.secretSuites || []) {
            for (const item of suite.loot || []) {
                const x = (item.c + 0.5) * TILE_SIZE;
                const y = (item.r + 0.5) * TILE_SIZE;
                if (item.kind === 'ammo' && AMMO_PICKUPS[item.type]) {
                    this.ammoPacks.push(makeAmmoPack(x, y, item.type, !!item.big));
                } else if (item.kind === 'powerup') {
                    this.powerups.push(new Powerup(x, y, item.powerup));
                }
            }
        }
    }

    /**
     * Per-frame rendering hook.
     *
     * Deliberately empty: drawing is owned by GameController.render() in main.js,
     * which runs its own requestAnimationFrame loop. This is called by gameLoop()
     * and kept as an extension point.
     */
    /**
     * Intentionally empty. The game used to draw from here; drawing now belongs
     * to GameController.render(), which has its own loop. This stays so the
     * update loop's shape -- update, then render, then reschedule -- reads the
     * same as it always did, and so nothing that still calls it breaks.
     */
    render() {
    }

    // =============================================================================
    // UTILITY METHODS
    // =============================================================================

    /**
     * Gets difficulty multipliers for current settings
     * 
     * @returns {Object} Difficulty multiplier object
     */
    getDifficultyMultipliers() {
        return getDifficultyMultipliers(this.selectedDifficulty);
    }

    /**
     * Resets the game state for a new game
     */
    reset() {
        this.gameRunning = false;
        this.gameOver = false;
        this.isLevelCompleting = false;
        this.awaitingContinue = false;
        this.levelStats = this.freshLevelStats();
        this.runStats = this.freshRunStats();
        this.currentLevel = 1;
        this.score = 0;
        this.currentBoss = null;
        this.player = null;
        this.enemies = [];
        this.bullets = [];
        this.explosions = [];
        this.temporaryVisualEffects = [];
        this.healthPacks = [];
        this.ammoPacks = [];
        this.weaponPacks = [];
        this.powerups = [];
        this.gameMap = null;
        this.tileStyles = null;
        this.lightMap = null;
        this.exploredMap = null;
        this.visionMap = null;

        // Level-type and spawn bookkeeping leaked across restarts: a run that ended
        // on a mini-boss level carried nextMiniBossSpawnLevel into the new game.
        this.isBossLevel = false;
        this.isCurrentLevelMiniBoss = false;
        this.nextMiniBossSpawnLevel = 0;
        this.lastSpawnTime = this.frameCount;
        this.nextSpawnInterval = undefined;

        // A queued level transition from the previous run would otherwise fire mid-way
        // through the new game and jump it to the wrong level.
        this.clearLevelTransition();

        // Whatever keys/mouse were held when the player died stayed latched, so a
        // restarted game began with the player already moving and firing.
        resetInputState();

        if (this.gameLoopId) {
            cancelAnimationFrame(this.gameLoopId);
            this.gameLoopId = null;
        }
    }

    /**
     * Pauses the game
     */
    pause() {
        this.gameRunning = false;
        if (this.gameLoopId) {
            cancelAnimationFrame(this.gameLoopId);
        }
    }

    /**
     * Resumes the game
     */
    resume() {
        if (!this.gameOver) {
            this.gameRunning = true;
            this.startGameLoop();
        }
    }
}