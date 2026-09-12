/**
 * UTILITIES MODULE
 * 
 * This module contains shared utility functions used throughout the game.
 * These functions handle common operations like collision detection, line-of-sight
 * calculations, visibility management, and camera control.
 * 
 * Features:
 * - Path clearing and line-of-sight algorithms
 * - Visibility map management for fog-of-war effect
 * - Camera tracking and smooth following
 * - Sprite initialization and management
 * - Mathematical utilities for game calculations
 * 
 * @author TDDL Game Team
 * @version 1.0.0
 */

import {
    TILE_SIZE, MAP_COLS, MAP_ROWS, VIEWPORT_WIDTH, VIEWPORT_HEIGHT,
    TILE_WALL, TILE_DOOR_RED, TILE_DOOR_YELLOW, TILE_DOOR_BLUE, TILE_SECRET_DOOR, TILE_PROP, TILE_SLIDE, TILE_SWITCH, TILE_WINDOW,
} from './constants.js';
import { isDoorOpen, isKeyedDoorTile } from './doors.js';
import { isSlideOpen } from './switches.js';

// =============================================================================
// CAMERA SYSTEM
// =============================================================================

/**
 * Camera object that smoothly follows the player
 * Provides viewport management and world-to-screen coordinate translation
 */
export const camera = {
    x: 0,                    // Camera world X position
    y: 0,                    // Camera world Y position
    width: VIEWPORT_WIDTH,   // Viewport width
    height: VIEWPORT_HEIGHT, // Viewport height

    /**
     * Updates camera position to follow a target (usually the player)
     * Centers the camera on the target while keeping it within world bounds
     * 
     * @param {Object} target - Object with x and y properties to follow
     */
    update: function(target) {
        // Validate target coordinates
        const targetX = (target && typeof target.x === 'number' && !isNaN(target.x)) 
            ? target.x 
            : VIEWPORT_WIDTH / 2;
        const targetY = (target && typeof target.y === 'number' && !isNaN(target.y)) 
            ? target.y 
            : VIEWPORT_HEIGHT / 2;

        // Log warning if target coordinates are invalid
        if (target && (isNaN(target.x) || isNaN(target.y))) {
            console.warn(`Camera target position is NaN (x: ${target.x}, y: ${target.y}). Defaulting target to center for camera calculation.`);
        }

        // Center camera on target
        this.x = targetX - this.width / 2;
        this.y = targetY - this.height / 2;

        // Clamp camera to world boundaries
        const worldWidth = MAP_COLS * TILE_SIZE;
        const worldHeight = MAP_ROWS * TILE_SIZE;
        
        // Prevent camera from showing area outside the world
        this.x = Math.max(0, Math.min(this.x, worldWidth - this.width));
        this.y = Math.max(0, Math.min(this.y, worldHeight - this.height));
    }
};

// =============================================================================
// SPRITE MANAGEMENT
// =============================================================================

/**
 * Determines facing direction based on movement angle
 * Converts a movement angle to one of four cardinal directions for sprite animation
 * 
 * @param {number} angle - Movement angle in radians
 * @returns {string} Direction string ("down", "left", "up", "right")
 */
export function getDirectionFromAngle(angle) {
    // Normalize angle to 0-2π range
    const normalizedAngle = (angle + 2 * Math.PI) % (2 * Math.PI);
    
    // Convert angle to direction based on quadrants
    if (normalizedAngle >= Math.PI * 0.25 && normalizedAngle < Math.PI * 0.75) {
        return "down";
    } else if (normalizedAngle >= Math.PI * 0.75 && normalizedAngle < Math.PI * 1.25) {
        return "left";
    } else if (normalizedAngle >= Math.PI * 1.25 && normalizedAngle < Math.PI * 1.75) {
        return "up";
    } else {
        return "right";
    }
}

// NOTE: a drawAnimatedSprite() helper used to live here. It was removed: nothing
// called it, and its frameMap contract ({x, y}) was incompatible with ENEMY_FRAMES
// ({row, frames}), so it would have drawn from the wrong sprite-sheet offsets if it
// ever had been. Player.draw() and Enemy.draw() each do their own frame maths.

// =============================================================================
// COLLISION DETECTION AND PATHFINDING
// =============================================================================

/**
 * Checks if a path between two points is clear of obstacles
 * Uses step-based sampling to detect walls and doors along the path
 * 
 * @param {number} x1 - Starting X coordinate
 * @param {number} y1 - Starting Y coordinate
 * @param {number} x2 - Ending X coordinate
 * @param {number} y2 - Ending Y coordinate
 * @param {Array} currentMap - 2D array representing the game map
 * @param {number} step - Distance between sample points (default: TILE_SIZE/4)
 * @returns {boolean} True if path is clear, false if blocked
 */
export function isPathClear(x1, y1, x2, y2, currentMap, step = TILE_SIZE / 4) {
    // Validate map data
    if (!currentMap || !currentMap.length || !currentMap[0] || !currentMap[0].length) {
        return false;
    }

    // Calculate path vector and distance
    const dxTotal = x2 - x1;
    const dyTotal = y2 - y1;
    const distance = Math.hypot(dxTotal, dyTotal);
    
    // Calculate number of steps needed
    const steps = Math.max(1, Math.floor(distance / step));

    // Sample points along the path
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const currentX = x1 + t * dxTotal;
        const currentY = y1 + t * dyTotal;
        
        // Convert world coordinates to tile coordinates
        const tileX = Math.floor(currentX / TILE_SIZE);
        const tileY = Math.floor(currentY / TILE_SIZE);

        // Check if point is outside map boundaries
        if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) {
            return false;
        }
        
        // Check if tile data exists
        if (!currentMap[tileY] || currentMap[tileY][tileX] === undefined) {
            return false;
        }

        // Check if tile blocks line of sight. An open door does not, and nor
        // does a prop: you see over a crate even though you cannot walk
        // through it.
        if (blocksSightAt(currentMap, tileX, tileY)) {
            // Allow the final point to be on a blocking tile
            if (i < steps) {
                return false;
            }
        }
    }
    
    return true;
}

/**
 * Checks if a circular object collides with walls at a given position
 * Used for movement collision detection with tile-based obstacles
 * 
 * @param {number} x - Center X coordinate
 * @param {number} y - Center Y coordinate
 * @param {number} radius - Object radius
 * @param {Array} gameMap - 2D array representing the game map
 * @returns {boolean} True if collision detected, false if position is clear
 */
export function checkWallCollision(x, y, radius, gameMap) {
    if (!gameMap || !gameMap.length) return false;

    // Sweep every tile the bounding box overlaps rather than probing eight points
    // on the circle. Point sampling skipped entire tiles once the radius exceeded
    // TILE_SIZE, which let bosses (radius 48px on a 40px grid) walk through walls.
    const minTileX = Math.floor((x - radius) / TILE_SIZE);
    const maxTileX = Math.floor((x + radius) / TILE_SIZE);
    const minTileY = Math.floor((y - radius) / TILE_SIZE);
    const maxTileY = Math.floor((y + radius) / TILE_SIZE);

    // Any overlap with the world edge counts as a collision
    if (minTileX < 0 || maxTileX >= MAP_COLS || minTileY < 0 || maxTileY >= MAP_ROWS) {
        return true;
    }

    for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
        const row = gameMap[tileY];
        if (!row) continue;

        for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
            if (isSolidAt(gameMap, tileX, tileY)) {
                return true;
            }
        }
    }

    return false; // No collision detected
}

/**
 * Whether the tile at a position blocks movement, sight and shots RIGHT NOW.
 *
 * isSolidTile() answers by type alone, and a keyed door is a type that changes
 * its mind: shut, it is a wall; open, it is a doorway. Anything that walks,
 * looks or shoots through the map should ask this, with coordinates, rather
 * than the type.
 *
 * @param {Array} map - 2D tile grid
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {boolean} True if the tile is solid at this moment
 */
export function isSolidAt(map, tileX, tileY) {
    const row = map && map[tileY];
    if (!row) return false;
    const tile = row[tileX];
    if (tile === TILE_WALL || tile === TILE_SECRET_DOOR || tile === TILE_PROP ||
        tile === TILE_SWITCH || tile === TILE_WINDOW) return true;
    if (tile === TILE_SLIDE) return !isSlideOpen(tileX, tileY);
    if (isKeyedDoorTile(tile)) return !isDoorOpen(tileX, tileY);
    return false;
}

/**
 * Whether the tile at a position stops a bullet.
 *
 * The third of the three questions a tile is asked, and the reason they are
 * separate: a window stops a body but not a shot, a crate stops a shot but
 * not a line of sight. Everything solid stops a bullet except a window.
 *
 * @param {number[][]} map - The level
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {boolean} True if a shot cannot pass
 */
export function blocksShotsAt(map, tileX, tileY) {
    const row = map && map[tileY];
    if (!row) return false;
    if (row[tileX] === TILE_WINDOW) return false;
    return isSolidAt(map, tileX, tileY);
}

/**
 * Whether the tile at a position blocks a line of sight right now.
 *
 * Not the same question as isSolidAt(): a crate stops a bullet and a body,
 * but a monster sees over it and light falls past it. Walls, secret doors
 * and shut keyed doors block sight; props and open doors do not.
 *
 * @param {Array} map - 2D tile grid
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {boolean} True if the tile blocks sight at this moment
 */
export function blocksSightAt(map, tileX, tileY) {
    const row = map && map[tileY];
    if (!row) return false;
    const tile = row[tileX];
    if (tile === TILE_WALL || tile === TILE_SECRET_DOOR || tile === TILE_SWITCH) return true;
    if (tile === TILE_SLIDE) return !isSlideOpen(tileX, tileY);
    if (isKeyedDoorTile(tile)) return !isDoorOpen(tileX, tileY);
    return false;
}

/**
 * Reports whether a tile type blocks entity movement.
 *
 * Closed doors and undiscovered secret doors are solid. Only TILE_WALL used to be
 * checked here, so enemies and bosses walked straight through locked colored doors
 * and out of secret rooms -- including into areas the player cannot reach yet.
 *
 * The player deliberately does NOT use this helper: Player.checkTileInteraction has
 * its own logic so that walking into a door you hold the key for opens it.
 *
 * @param {number} tileType - Tile type value to test
 * @returns {boolean} True if the tile blocks movement
 */
export function isSolidTile(tileType) {
    return tileType === TILE_WALL ||
           tileType === TILE_WINDOW ||
           tileType === TILE_PROP ||
           tileType === TILE_SLIDE ||
           tileType === TILE_SWITCH ||
           tileType === TILE_DOOR_RED ||
           tileType === TILE_DOOR_YELLOW ||
           tileType === TILE_DOOR_BLUE ||
           tileType === TILE_SECRET_DOOR;
}

// =============================================================================
// VISIBILITY SYSTEM (FOG OF WAR)
// =============================================================================
//
// Moved out to js/lighting.js. The old implementation here maintained a boolean
// `visibilityMap` from a tile raycast whose cone radii and falloff did not match
// the gradient the renderer actually drew, so items could sit unrevealed inside an
// area that plainly looked lit. Lighting is now derived once, from shadow
// polygons, and drives both the visuals and what counts as revealed.

// =============================================================================
// MATHEMATICAL UTILITIES
// =============================================================================

/**
 * Clamps a value between minimum and maximum bounds
 * 
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {number} Clamped value
 */
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * Calculates distance between two points
 * 
 * @param {number} x1 - First point X coordinate
 * @param {number} y1 - First point Y coordinate
 * @param {number} x2 - Second point X coordinate
 * @param {number} y2 - Second point Y coordinate
 * @returns {number} Distance between points
 */
export function distance(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
}

/**
 * Normalizes an angle to the range [0, 2π)
 * 
 * @param {number} angle - Angle in radians
 * @returns {number} Normalized angle
 */
export function normalizeAngle(angle) {
    return (angle % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
}

/**
 * Calculates the shortest angular difference between two angles
 * 
 * @param {number} angle1 - First angle in radians
 * @param {number} angle2 - Second angle in radians
 * @returns {number} Angular difference in range [-π, π]
 */
export function angleDifference(angle1, angle2) {
    let diff = angle2 - angle1;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return diff;
}

/**
 * Converts world coordinates to tile coordinates
 * 
 * @param {number} worldX - World X coordinate
 * @param {number} worldY - World Y coordinate
 * @returns {Object} Object with tileX and tileY properties
 */
export function worldToTile(worldX, worldY) {
    return {
        tileX: Math.floor(worldX / TILE_SIZE),
        tileY: Math.floor(worldY / TILE_SIZE)
    };
}

/**
 * Converts tile coordinates to world coordinates (center of tile)
 * 
 * @param {number} tileX - Tile X coordinate
 * @param {number} tileY - Tile Y coordinate
 * @returns {Object} Object with worldX and worldY properties
 */
export function tileToWorld(tileX, tileY) {
    return {
        worldX: tileX * TILE_SIZE + TILE_SIZE / 2,
        worldY: tileY * TILE_SIZE + TILE_SIZE / 2
    };
}

// =============================================================================
// RANDOM UTILITIES
// =============================================================================

/**
 * Generates a random integer between min and max (inclusive)
 * 
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Random integer
 */
export function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generates a random float between min and max
 * 
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Random float
 */
export function randomFloat(min, max) {
    return Math.random() * (max - min) + min;
}

/**
 * Selects a random element from an array
 * 
 * @param {Array} array - Array to select from
 * @returns {*} Random element from array, or undefined if array is empty
 */
export function randomChoice(array) {
    if (array.length === 0) return undefined;
    return array[Math.floor(Math.random() * array.length)];
}

/**
 * Shuffles an array in place using Fisher-Yates algorithm
 * 
 * @param {Array} array - Array to shuffle
 * @returns {Array} The same array, shuffled
 */
export function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// =============================================================================
// DEBUGGING UTILITIES
// =============================================================================

/**
 * Logs object properties in a formatted way
 * 
 * @param {Object} obj - Object to log
 * @param {string} label - Label for the log output
 */
export function debugLog(obj, label = "Debug") {
    console.log(`${label}:`, JSON.stringify(obj, null, 2));
}

/**
 * Measures execution time of a function
 * 
 * @param {Function} fn - Function to measure
 * @param {string} label - Label for timing output
 * @returns {*} Return value of the function
 */
export function timeFunction(fn, label = "Function") {
    const start = performance.now();
    const result = fn();
    const end = performance.now();
    console.log(`${label} took ${end - start} milliseconds`);
    return result;
}

/**
 * Creates a performance counter for tracking repeated operations
 * 
 * @param {string} name - Name of the counter
 * @returns {Object} Counter object with start() and end() methods
 */
export function createPerformanceCounter(name) {
    let startTime = 0;
    let totalTime = 0;
    let callCount = 0;
    
    return {
        start() {
            startTime = performance.now();
        },
        end() {
            totalTime += performance.now() - startTime;
            callCount++;
        },
        report() {
            const avgTime = callCount > 0 ? totalTime / callCount : 0;
            console.log(`${name}: ${callCount} calls, ${totalTime.toFixed(2)}ms total, ${avgTime.toFixed(2)}ms average`);
        },
        reset() {
            startTime = 0;
            totalTime = 0;
            callCount = 0;
        }
    };
}