/**
 * MAP GENERATION MODULE
 * 
 * This module handles procedural generation of game levels including room-and-corridor
 * mazes, boss arenas, item placement, and connectivity algorithms. It creates diverse
 * level layouts that provide engaging gameplay experiences.
 * 
 * Features:
 * - Procedural room-and-corridor maze generation
 * - Boss level layouts with special arena designs
 * - Intelligent item and weapon placement
 * - Connectivity validation using spanning tree algorithms
 * - Secret door placement for exploration rewards
 * - Failure recovery with multiple generation attempts
 * 
 * @author TDDL Game Team
 * @version 1.0.0
 */

import {
    TILE_SIZE, MAP_COLS, MAP_ROWS,
    TILE_EMPTY, TILE_WALL, TILE_EXIT,
    TILE_DOOR_RED, TILE_DOOR_YELLOW, TILE_DOOR_BLUE,
    TILE_KEY_RED, TILE_KEY_YELLOW, TILE_KEY_BLUE,
    TILE_WEAPON_SHOTGUN, TILE_WEAPON_RIFLE, TILE_WEAPON_ROCKETLAUNCHER, TILE_WEAPON_BFG, TILE_WEAPON_PLASMAGUN,
    TILE_HEALTH_PACK, TILE_SECRET_DOOR,
    WALL_STYLES, TILE_PROP, TILE_SLIDE, TILE_SWITCH, TILE_WINDOW,
} from './constants.js';
import { randomInt, randomChoice, shuffleArray } from './utils.js';
import { isDamagingTerrain, isTerrainTile, pickThemeTerrain } from './terrain.js';
import { buildDoomLayout, verifyProgression } from './level-layout.js';
import { planTraps } from './traps.js';
import { decorateRooms } from './decor.js';
import { planBarrels } from './barrels.js';
import { planSwitches } from './switches.js';
import { planSectors } from './sectors.js';
import { planWindows } from './windows.js';

// =============================================================================
// MAP GENERATION CONFIGURATION
// =============================================================================

/**
 * Map generation constants for controlling layout parameters
 */
const MAP_GEN_CONFIG = {
    // Room generation parameters
    MIN_ROOM_SIZE: 5,           // Minimum room dimensions
    MAX_ROOM_SIZE: 11,          // Maximum room dimensions
    NUM_ROOMS_ATTEMPT: 30,      // Number of rooms to attempt placing
    MIN_ROOMS_FOR_LOGIC: 6,     // Minimum rooms needed for valid level
    MAX_GENERATION_ATTEMPTS: 25, // Maximum attempts before giving up
    
    // Boss level parameters
    BOSS_ROOM_WIDTH_FACTOR: 0.6,    // Boss room width as fraction of map
    BOSS_ROOM_HEIGHT_FACTOR: 0.5,   // Boss room height as fraction of map
    MIN_BOSS_ROOM_WIDTH: 15,         // Minimum boss room width
    MIN_BOSS_ROOM_HEIGHT: 10,        // Minimum boss room height
    
    // Item placement parameters
    HEALTH_PACK_CHANCE: 0.25,        // Probability of health pack in room

    // Obstacle and internal structure parameters
    OBSTACLE_CHANCE: 0.4,             // Probability of obstacles in a room
    INTERNAL_WALL_CHANCE: 0.3,        // Probability of internal walls in larger rooms
    MIN_OBSTACLE_ROOM_SIZE: 16,       // Minimum room area for obstacles (4x4)
    MAX_OBSTACLE_DENSITY: 0.15,       // Maximum portion of room that can be obstacles
    PILLAR_CHANCE: 0.2,               // Chance for pillar-style obstacles
    WALL_SEGMENT_CHANCE: 0.15,        // Chance for wall segment obstacles

    // Secret room parameters
    //
    // Romero's rule was "include at least four secrets in your level", and it is
    // the rule that makes players read walls instead of walking past them. Not
    // every attempt finds anywhere to go -- a dense level leaves little spare rock
    // -- so the ask is set above the target rather than at it.
    MIN_SECRET_ROOMS: 5,             // Minimum secret rooms per level
    MAX_SECRET_ROOMS: 8,             // Maximum secret rooms per level
    MIN_SECRET_ROOM_SIZE: 4,         // Minimum tiles in the first chamber
    MAX_SECRET_ROOM_SIZE: 30,        // Maximum tiles in the first chamber

    // One secret a level is the prize: the only one holding a weapon a tier
    // early and a sphere or backpack, and the only one that grows into a suite
    // -- a second chamber behind the first whenever there is rock for it, and
    // a chance of a third, with the best of the loot at the far end. The rest
    // are a small room with a small bonus, so that finding five secrets on a
    // level does not mean five weapons.
    SECRET_THIRD_CHAMBER_CHANCE: 0.4, // Chance the prize suite's second chamber leads to a third
    
    // Connectivity parameters
    //
    // Two tiles, not one. A one-tile hallway is a queue: you cannot strafe, you
    // cannot get past the thing in front of you, and every fight in it is decided
    // by who shoots first. Doom's hallways are wide enough to fight in, and that
    // width is most of what makes its corridors read as architecture rather than
    // as connections between rooms. Secret passages stay one tile, which is
    // exactly what makes them read as secret.
    CORRIDOR_WIDTH: 2,              // Width of connecting corridors

    // Whole-level tries at the zoned Doom layout before falling back to the old
    // scatter-and-connect generator. Each try is rebuilt from scratch and then
    // verified end to end, so a try that fails costs nothing but time.
    REGULAR_LEVEL_ATTEMPTS: 6,

    // Terrain pool parameters
    //
    // Pools are carved into room interiors only, never into corridors: a corridor
    // is one tile wide, so flooding one leaves no way past it, and the safety check
    // in placeTerrainPools() would only reject it afterwards anyway. Keeping them
    // out of corridors by construction means the check almost never has to.
    TERRAIN_ROOM_MARGIN: 1,          // Clear tiles left inside the room's own edge
    MIN_TERRAIN_ROOM_AREA: 30,       // Rooms smaller than this stay dry
    TERRAIN_POOL_MIN: 4,             // Smallest pool worth drawing
    TERRAIN_POOL_COVERAGE: 0.45,     // Largest share of the carvable region a pool takes
    TERRAIN_BOSS_CLEARANCE: 3        // Tiles kept dry around a boss's spawn
};

// =============================================================================
// MAIN MAP GENERATION FUNCTION
// =============================================================================

/**
 * Generates a complete game level with rooms, corridors, and items
 * 
 * @param {number} cols - Number of map columns
 * @param {number} rows - Number of map rows
 * @param {boolean} isMainBossLevelLayout - Whether to generate boss level layout
 * @returns {Object} Generated map data with gameMap, playerStart, and bossSpawn
 */
/**
 * The secret suites carved into the level being generated, each with the loot
 * that has to be spawned as entities once the game state exists. Reset per
 * level; handed back with the map.
 */
let secretSuites = [];

export function generateMaze(cols, rows, isMainBossLevelLayout) {
    secretSuites = [];
    console.log("generateMaze: Starting maze generation for level", window.gameState?.currentLevel || 1, "isMainBossLevelLayout:", isMainBossLevelLayout);

    if (isMainBossLevelLayout) {
        return generateBossMaze(cols, rows);
    }

    // Regular levels get the Doom-style zoned layout: keys and doors decided as a
    // progression first, space laid out to fit it second. Each attempt is built,
    // populated and then played through by the verifier; only a level that is
    // genuinely completable AND genuinely gated by every one of its keys ships.
    for (let attempt = 0; attempt < MAP_GEN_CONFIG.REGULAR_LEVEL_ATTEMPTS; attempt++) {
        const layout = buildDoomLayout(cols, rows, {
            keyCount: keyCountForLevel(),
            styleCount: WALL_STYLES.length,
            baseStyle: levelStyleIndex()
        });
        if (!layout) break;   // Geometry will not support it at all; stop retrying

        // Each zone's rooms flood with its own theme's liquid, so crossing a gate
        // changes what is pooled on the floor as well as what the walls are made
        // of. A cistern behind the red door should be wet; the foundry it opens
        // off should not be.
        const styleForRoom = (room) => WALL_STYLES[layout.zoneStyles[room.zone] ?? 0];

        let traps = [];
        let barrels = [];
        let switchPlan = null;
        let sectors = null;
        let windows = [];
        let decoration = { decor: null, lights: [], kinds: {} };
        setReservedTiles(layout.reservedTiles);
        try {
            decorateLayoutRooms(layout.map, layout.rooms);
            placeGameplayElements(layout.map, layout.rooms, layout.playerStartRoom, false, layout);
            placeTerrainPools(layout.map, layout.rooms, layout.playerStartRoom, layout.playerStart, null, styleForRoom);
            // Furnishing: each room gets a purpose and the props that go with
            // it. Solid props become wall tiles, placed under the rule that
            // nothing reachable before is unreachable after.
            decoration = decorateRooms(layout.map, layout.rooms, {
                playerStart: layout.playerStart,
                playerStartRoom: layout.playerStartRoom,
                styleForRoom,
            });
            // Traps are planned last, against the finished level, and change
            // nothing about it: a closet is chosen where the rock is solid and
            // stays solid until the trap fires.
            traps = planTraps(layout.map, layout.rooms, layout.playerStartRoom, {
                level: window.gameState?.currentLevel || 1,
                isReserved: isReservedTile,
                tileStyles: layout.tileStyles,
            });
            // Barrels stand where barrels belong; a switch or two may carve a
            // loot alcove or wire a closet. Both come after the traps so a
            // closet can be rewired, and before the verifier, which treats
            // sliding walls and switches as walls.
            barrels = planBarrels(layout.map, layout.rooms, decoration.kinds, layout.playerStartRoom, {
                level: window.gameState?.currentLevel || 1,
            });
            switchPlan = planSwitches(layout.map, layout.rooms, layout.playerStartRoom, {
                level: window.gameState?.currentLevel || 1,
                isReserved: isReservedTile,
                tileStyles: layout.tileStyles,
                traps,
            });
            // Windows go in before the lighting, so daylight through an
            // exterior one is part of the room's light rather than something
            // painted over it.
            windows = planWindows(layout.map, layout.rooms, {
                level: window.gameState?.currentLevel || 1,
                isReserved: isReservedTile,
                tileStyles: layout.tileStyles,
            });
            // Every room gets an overhead light level, as a Doom sector has
            // one, and a few get a light special. Last of all, so it sees the
            // final geometry: a switch alcove carved after this would be a
            // pocket of floor with no lighting at all.
            sectors = planSectors(layout.map, layout.rooms, {
                roomKinds: decoration.kinds,
                windows,
            });
        } finally {
            setReservedTiles(null);
        }

        if (verifyProgression(layout.map, layout.playerStart, cols, rows)) {
            console.log(
                `generateMaze: zoned layout ready -- ${layout.zones.length} zones, ` +
                `${layout.rooms.length} rooms, ${layout.keyCount} key(s)`
            );
            return {
                gameMap: layout.map,
                playerStart: layout.playerStart,
                bossSpawn: null,
                rooms: layout.rooms,
                tileStyles: layout.tileStyles,
                traps,
                barrels,
                switchPlan,
                sectors,
                windows,
                decor: decoration.decor,
                decorLights: decoration.lights,
                roomKinds: decoration.kinds,
                secrets: secretSuites,
            };
        }

        console.warn(`generateMaze: attempt ${attempt + 1} failed progression verification, rebuilding`);
    }

    console.warn("generateMaze: falling back to the legacy scatter-and-connect layout");
    return generateLegacyMaze(cols, rows);
}

/**
 * The wall style a level opens in. Zones wander away from it from there.
 *
 * @returns {number} Index into WALL_STYLES
 */
function levelStyleIndex() {
    const level = window.gameState?.currentLevel || 1;
    return (level - 1) % WALL_STYLES.length;
}

/**
 * How many keys this level's progression should use.
 *
 * Doom does not open with a three-key map, and neither should this. The first
 * level teaches the loop with a single colour, the next few add a second, and
 * from there on levels run the full red -> yellow -> blue chain.
 *
 * @returns {number} Number of keys to gate the level with
 */
function keyCountForLevel() {
    const level = window.gameState?.currentLevel || 1;
    if (level <= 1) return 1;
    if (level <= 3) return 2;
    return 3;
}

/**
 * Adds obstacles to the rooms of a zoned layout.
 *
 * Kept separate from carving so the layout module stays purely structural: it
 * decides where space and gates go, and this decides what is standing in it.
 *
 * @param {Array} map - 2D map array
 * @param {Array} rooms - Rooms to decorate
 */
function decorateLayoutRooms(map, rooms) {
    for (const room of rooms) {
        addRoomObstacles(map, room);
    }
}

/**
 * Generates a boss level: one big arena with antechambers, no keys.
 *
 * @param {number} cols - Number of map columns
 * @param {number} rows - Number of map rows
 * @returns {Object} Generated map data
 */
function generateBossMaze(cols, rows) {
    let map = Array(rows).fill(null).map(() => Array(cols).fill(TILE_WALL));

    const result = generateBossLevel(map, cols, rows);
    map = result.map;

    placeGameplayElements(map, result.rooms, result.playerStartRoom, true, null);
    placeTerrainPools(map, result.rooms, result.playerStartRoom, result.playerStart, result.bossSpawn);

    console.log("generateMaze: Main boss level layout complete.");

    return {
        gameMap: map,
        playerStart: result.playerStart,
        bossSpawn: result.bossSpawn,
        rooms: result.rooms,
        secrets: secretSuites,
    };
}

/**
 * The original scatter-rooms-then-connect generator, kept as a safety net for the
 * rare level whose geometry the zoned layout cannot satisfy.
 *
 * Its corridors stay one tile wide on purpose: its doors are placed by trying
 * candidate tiles until one does not soft-lock the level, and a single door tile
 * dropped into a two-wide corridor is a door you simply walk around.
 *
 * @param {number} cols - Number of map columns
 * @param {number} rows - Number of map rows
 * @returns {Object} Generated map data
 */
function generateLegacyMaze(cols, rows) {
    const initial = Array(rows).fill(null).map(() => Array(cols).fill(TILE_WALL));
    const result = generateRegularLevel(initial, cols, rows);

    placeGameplayElements(result.map, result.rooms, result.playerStartRoom, false, null);
    placeTerrainPools(result.map, result.rooms, result.playerStartRoom, result.playerStart, null);

    return {
        gameMap: result.map,
        playerStart: result.playerStart,
        bossSpawn: null,
        rooms: result.rooms,
        secrets: secretSuites,
    };
}

// =============================================================================
// BOSS LEVEL GENERATION
// =============================================================================

/**
 * Generates a boss level with a large central arena and connecting antechambers
 * 
 * @param {Array} map - 2D map array to modify
 * @param {number} cols - Number of map columns
 * @param {number} rows - Number of map rows
 * @returns {Object} Boss level generation result
 */
function generateBossLevel(map, cols, rows) {
    console.log("generateMaze: Generating MAIN BOSS LEVEL layout.");
    
    // Create large central boss arena
    const bossRoomWidth = Math.max(MAP_GEN_CONFIG.MIN_BOSS_ROOM_WIDTH, Math.floor(cols * MAP_GEN_CONFIG.BOSS_ROOM_WIDTH_FACTOR));
    const bossRoomHeight = Math.max(MAP_GEN_CONFIG.MIN_BOSS_ROOM_HEIGHT, Math.floor(rows * MAP_GEN_CONFIG.BOSS_ROOM_HEIGHT_FACTOR));
    const bossRoomX = Math.floor((cols - bossRoomWidth) / 2);
    const bossRoomY = Math.floor((rows - bossRoomHeight) / 2);

    const bossRoom = {
        x: bossRoomX, 
        y: bossRoomY, 
        width: bossRoomWidth, 
        height: bossRoomHeight, 
        id: 0,
        center: {
            x: bossRoomX + Math.floor(bossRoomWidth/2), 
            y: bossRoomY + Math.floor(bossRoomHeight/2)
        }, 
        connected: true
    };
    
    const rooms = [bossRoom];

    // Carve out the boss room
    for (let r = bossRoomY; r < bossRoomY + bossRoomHeight; r++) {
        for (let c = bossRoomX; c < bossRoomX + bossRoomWidth; c++) {
            if (r >= 0 && r < rows && c >= 0 && c < cols) {
                map[r][c] = TILE_EMPTY;
            }
        }
    }
    
    const bossSpawnCell = { r: bossRoom.center.y, c: bossRoom.center.x };
    console.log("generateMaze: Main boss room created. Center:", bossSpawnCell);

    // Create antechambers connected to the boss room
    const result = createBossAntechambers(map, cols, rows, bossRoom, rooms);
    
    return {
        map: map,
        rooms: rooms,
        playerStart: result.playerStart,
        bossSpawn: bossSpawnCell,
        playerStartRoom: result.playerStartRoom
    };
}

/**
 * Creates antechambers around the boss room for player entry
 * 
 * @param {Array} map - 2D map array
 * @param {number} cols - Number of map columns
 * @param {number} rows - Number of map rows
 * @param {Object} bossRoom - Main boss room object
 * @param {Array} rooms - Array of room objects
 * @returns {Object} Antechamber creation result
 */
function createBossAntechambers(map, cols, rows, bossRoom, rooms) {
    const numAntechambers = 1 + Math.floor(Math.random() * 2); // 1-2 antechambers
    let playerPlaced = false;
    let playerStartCell = { r: Math.floor(rows/2), c: Math.floor(cols/2) };
    let actualPlayerStartRoom = null;

    for (let i = 0; i < numAntechambers; i++) {
        const anteWidth = 5 + Math.floor(Math.random() * 3);  // 5-7 tiles wide
        const anteHeight = 5 + Math.floor(Math.random() * 3); // 5-7 tiles high
        let anteX, anteY;

        // Position antechamber on one side of the boss room
        const side = Math.floor(Math.random() * 4); // 0=top, 1=right, 2=bottom, 3=left
        
        switch (side) {
            case 0: // Top
                anteX = bossRoom.x + Math.floor(Math.random() * (bossRoom.width - anteWidth));
                anteY = Math.max(1, bossRoom.y - anteHeight - 2);
                break;
            case 1: // Right
                anteX = Math.min(cols - anteWidth - 1, bossRoom.x + bossRoom.width + 2);
                anteY = bossRoom.y + Math.floor(Math.random() * (bossRoom.height - anteHeight));
                break;
            case 2: // Bottom
                anteX = bossRoom.x + Math.floor(Math.random() * (bossRoom.width - anteWidth));
                anteY = Math.min(rows - anteHeight - 1, bossRoom.y + bossRoom.height + 2);
                break;
            case 3: // Left
                anteX = Math.max(1, bossRoom.x - anteWidth - 2);
                anteY = bossRoom.y + Math.floor(Math.random() * (bossRoom.height - anteHeight));
                break;
        }

        // Ensure antechamber is within map bounds
        anteX = Math.max(1, Math.min(anteX, cols - anteWidth - 1));
        anteY = Math.max(1, Math.min(anteY, rows - anteHeight - 1));

        const antechamber = {
            x: anteX, 
            y: anteY, 
            width: anteWidth, 
            height: anteHeight,
            id: rooms.length,
            center: {
                x: anteX + Math.floor(anteWidth/2), 
                y: anteY + Math.floor(anteHeight/2)
            },
            connected: true
        };

        rooms.push(antechamber);

        // Carve out antechamber
        for (let r = anteY; r < anteY + anteHeight; r++) {
            for (let c = anteX; c < anteX + anteWidth; c++) {
                if (r >= 0 && r < rows && c >= 0 && c < cols) {
                    map[r][c] = TILE_EMPTY;
                }
            }
        }

        // Connect antechamber to boss room
        connectRoomsToBossRoom(map, antechamber, bossRoom);

        // Place player in first antechamber
        if (!playerPlaced) {
            playerStartCell = { r: antechamber.center.y, c: antechamber.center.x };
            actualPlayerStartRoom = antechamber;
            playerPlaced = true;
            console.log("generateMaze: Player start placed in antechamber:", playerStartCell);
        }
    }

    return {
        playerStart: playerStartCell,
        playerStartRoom: actualPlayerStartRoom
    };
}

/**
 * Connects an antechamber to the main boss room with a corridor
 * 
 * @param {Array} map - 2D map array
 * @param {Object} antechamber - Antechamber room object
 * @param {Object} bossRoom - Main boss room object
 */
function connectRoomsToBossRoom(map, antechamber, bossRoom) {
    // Find the closest points between rooms
    let bestDistance = Infinity;
    let bestAntePoint = null;
    let bestBossPoint = null;

    // Check all edge points of both rooms
    const anteEdgePoints = getRoomEdgePoints(antechamber);
    const bossEdgePoints = getRoomEdgePoints(bossRoom);

    for (const antePoint of anteEdgePoints) {
        for (const bossPoint of bossEdgePoints) {
            const distance = Math.hypot(antePoint.x - bossPoint.x, antePoint.y - bossPoint.y);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestAntePoint = antePoint;
                bestBossPoint = bossPoint;
            }
        }
    }

    // Create L-shaped corridor between the closest points. Boss levels get the
    // same two-wide hallways as everywhere else -- the walk up to an arena is
    // where the player picks a weapon and a side to enter from, not somewhere to
    // be funnelled single-file into a boss's opening attack.
    if (bestAntePoint && bestBossPoint) {
        createLShapedCorridor(map, bestAntePoint, bestBossPoint, MAP_GEN_CONFIG.CORRIDOR_WIDTH);
    }
}

/**
 * Gets edge points of a room for connection purposes
 * 
 * @param {Object} room - Room object
 * @returns {Array} Array of edge point coordinates
 */
function getRoomEdgePoints(room) {
    const points = [];
    
    // Top and bottom edges
    for (let x = room.x; x < room.x + room.width; x++) {
        points.push({ x: x, y: room.y });                    // Top edge
        points.push({ x: x, y: room.y + room.height - 1 });  // Bottom edge
    }
    
    // Left and right edges
    for (let y = room.y; y < room.y + room.height; y++) {
        points.push({ x: room.x, y: y });                    // Left edge
        points.push({ x: room.x + room.width - 1, y: y });   // Right edge
    }
    
    return points;
}

/**
 * Creates an L-shaped corridor between two points
 * 
 * @param {Array} map - 2D map array
 * @param {Object} start - Starting point {x, y}
 * @param {Object} end - Ending point {x, y}
 */
function createLShapedCorridor(map, start, end, width = 1) {
    let currentX = start.x;
    let currentY = start.y;
    let tilesCleared = 0;

    // Widening is done by stamping a width x width block at every step rather than
    // by carving a second parallel line, which is what keeps the corner square: two
    // parallel L's meet at a notch a player can get stuck on.
    const stamp = () => {
        for (let dy = 0; dy < width; dy++) {
            for (let dx = 0; dx < width; dx++) {
                const row = map[currentY + dy];
                if (row && row[currentX + dx] === TILE_WALL) {
                    row[currentX + dx] = TILE_EMPTY;
                    tilesCleared++;
                }
            }
        }
    };

    // Move horizontally first
    while (currentX !== end.x) {
        stamp();
        currentX += Math.sign(end.x - currentX);
    }

    // Mark the corner
    stamp();

    // Move vertically
    while (currentY !== end.y) {
        stamp();
        currentY += Math.sign(end.y - currentY);
    }

    // Mark the final point
    stamp();

    console.log(`createLShapedCorridor: (${start.x},${start.y}) -> (${end.x},${end.y}), width ${width}, cleared ${tilesCleared} tiles`);
}

/**
 * Creates an L-shaped corridor that properly connects two room boundaries
 * Ensures corridors extend into both rooms for proper connectivity
 *
 * @param {Array} map - 2D map array
 * @param {Object} roomA - Starting room object
 * @param {Object} roomB - Ending room object
 */
function createLShapedCorridorBetweenRooms(map, roomA, roomB) {
    // Find the closest points on the room boundaries
    const startPoint = findClosestRoomBoundaryPoint(roomA, roomB.center);
    const endPoint = findClosestRoomBoundaryPoint(roomB, roomA.center);

    console.log(`createLShapedCorridorBetweenRooms: From room boundary (${startPoint.x},${startPoint.y}) to room boundary (${endPoint.x},${endPoint.y})`);

    // Create the corridor between boundary points
    createLShapedCorridor(map, startPoint, endPoint);
}

/**
 * Finds the closest point on a room's boundary to a target point
 * Returns a point that's just outside the room (in a wall that can be carved)
 *
 * @param {Object} room - Room object
 * @param {Object} targetPoint - Target point to get closest to
 * @returns {Object} Closest boundary point {x, y}
 */
function findClosestRoomBoundaryPoint(room, targetPoint) {
    const roomLeft = room.x;
    const roomRight = room.x + room.width - 1;
    const roomTop = room.y;
    const roomBottom = room.y + room.height - 1;

    const targetX = targetPoint.x;
    const targetY = targetPoint.y;

    // Determine which side of the room is closest to the target
    const distToLeft = Math.abs(targetX - roomLeft);
    const distToRight = Math.abs(targetX - roomRight);
    const distToTop = Math.abs(targetY - roomTop);
    const distToBottom = Math.abs(targetY - roomBottom);

    const minDist = Math.min(distToLeft, distToRight, distToTop, distToBottom);

    if (minDist === distToLeft) {
        // Target is closest to left side - connect from left wall
        const y = Math.max(roomTop, Math.min(roomBottom, targetY));
        return { x: roomLeft - 1, y: y };
    } else if (minDist === distToRight) {
        // Target is closest to right side - connect from right wall
        const y = Math.max(roomTop, Math.min(roomBottom, targetY));
        return { x: roomRight + 1, y: y };
    } else if (minDist === distToTop) {
        // Target is closest to top side - connect from top wall
        const x = Math.max(roomLeft, Math.min(roomRight, targetX));
        return { x: x, y: roomTop - 1 };
    } else {
        // Target is closest to bottom side - connect from bottom wall
        const x = Math.max(roomLeft, Math.min(roomRight, targetX));
        return { x: x, y: roomBottom + 1 };
    }
}

// =============================================================================
// REGULAR LEVEL GENERATION
// =============================================================================

/**
 * Generates a regular level with rooms and corridors
 * 
 * @param {Array} initialMap - Initial map array
 * @param {number} cols - Number of map columns
 * @param {number} rows - Number of map rows
 * @returns {Object} Regular level generation result
 */
function generateRegularLevel(initialMap, cols, rows) {
    console.log("generateMaze: Generating REGULAR/MINI-BOSS LEVEL layout.");
    
    let generationAttempts = 0;
    let levelIsValid = false;
    let map, rooms, playerStartCell, actualPlayerStartRoom;

    // Try multiple times to generate a valid level
    while (!levelIsValid && generationAttempts < MAP_GEN_CONFIG.MAX_GENERATION_ATTEMPTS) {
        // Reset for new attempt
        map = Array(rows).fill(null).map(() => Array(cols).fill(TILE_WALL));
        rooms = [];
        playerStartCell = { r: Math.floor(rows/2), c: Math.floor(cols/2) };

        // Generate rooms
        const roomResult = generateRooms(map, cols, rows);
        rooms = roomResult.rooms;
        
        // Check if we have enough rooms
        if (rooms.length < MAP_GEN_CONFIG.MIN_ROOMS_FOR_LOGIC) {
            generationAttempts++;
            levelIsValid = false;
            continue;
        }

        // Set player start and connect rooms
        if (rooms.length > 0) {
            playerStartCell = { r: rooms[0].center.y, c: rooms[0].center.x };
            actualPlayerStartRoom = rooms[0];
            
            // Connect all rooms using minimum spanning tree
            connectAllRooms(map, rooms);
            levelIsValid = true;
        }

        if (!levelIsValid) {
            generationAttempts++;
        }
    }

    if (!levelIsValid) {
        console.warn("generateMaze: Failed to generate valid level after", MAP_GEN_CONFIG.MAX_GENERATION_ATTEMPTS, "attempts. Using fallback.");
        // Use fallback generation or the last attempt
    }

    console.log("generateMaze: Regular level layout attempt complete.");

    return {
        map: map,
        rooms: rooms,
        playerStart: playerStartCell,
        playerStartRoom: actualPlayerStartRoom
    };
}

/**
 * Generates rooms for regular levels
 * 
 * @param {Array} map - 2D map array
 * @param {number} cols - Number of map columns
 * @param {number} rows - Number of map rows
 * @returns {Object} Room generation result
 */
function generateRooms(map, cols, rows) {
    const rooms = [];

    for (let i = 0; i < MAP_GEN_CONFIG.NUM_ROOMS_ATTEMPT && rooms.length < MAP_GEN_CONFIG.NUM_ROOMS_ATTEMPT * 0.8; i++) {
        const roomWidth = randomInt(MAP_GEN_CONFIG.MIN_ROOM_SIZE, MAP_GEN_CONFIG.MAX_ROOM_SIZE);
        const roomHeight = randomInt(MAP_GEN_CONFIG.MIN_ROOM_SIZE, MAP_GEN_CONFIG.MAX_ROOM_SIZE);
        const roomX = randomInt(1, cols - roomWidth - 2);
        const roomY = randomInt(1, rows - roomHeight - 2);

        const newRoom = {
            x: roomX, 
            y: roomY, 
            width: roomWidth, 
            height: roomHeight,
            connected: false,
            id: rooms.length,
            center: {
                x: roomX + Math.floor(roomWidth/2), 
                y: roomY + Math.floor(roomHeight/2)
            }
        };

        // Check for overlaps with existing rooms
        let overlaps = false;
        for (const existingRoom of rooms) {
            if (newRoom.x < existingRoom.x + existingRoom.width + 1 &&
                newRoom.x + newRoom.width + 1 > existingRoom.x &&
                newRoom.y < existingRoom.y + existingRoom.height + 1 &&
                newRoom.y + newRoom.height + 1 > existingRoom.y) {
                overlaps = true;
                break;
            }
        }

        // Place room if no overlaps
        if (!overlaps) {
            rooms.push(newRoom);
            carveRoom(map, newRoom);
        }
    }

    return { rooms: rooms };
}

/**
 * Carves out a room in the map and adds obstacles for variety
 *
 * @param {Array} map - 2D map array
 * @param {Object} room - Room object to carve
 */
function carveRoom(map, room) {
    // First, carve out the basic room
    for (let r = room.y; r < room.y + room.height; r++) {
        for (let c = room.x; c < room.x + room.width; c++) {
            if (r >= 0 && r < map.length && c >= 0 && c < map[0].length) {
                map[r][c] = TILE_EMPTY;
            }
        }
    }

    // Add obstacles and internal structures for visual interest
    addRoomObstacles(map, room);
}

/**
 * Adds obstacles and internal structures to a room for visual variety
 * Ensures all areas remain accessible to the player
 *
 * @param {Array} map - 2D map array
 * @param {Object} room - Room object to add obstacles to
 */
function addRoomObstacles(map, room) {
    const roomArea = room.width * room.height;

    // Skip obstacles for very small rooms
    if (roomArea < MAP_GEN_CONFIG.MIN_OBSTACLE_ROOM_SIZE) {
        return;
    }

    // Decide whether to add obstacles to this room
    if (Math.random() > MAP_GEN_CONFIG.OBSTACLE_CHANCE) {
        return;
    }

    // Calculate maximum obstacles based on room size
    const maxObstacles = Math.floor(roomArea * MAP_GEN_CONFIG.MAX_OBSTACLE_DENSITY);
    const numObstacles = Math.floor(Math.random() * maxObstacles) + 1;

    // Add different types of obstacles
    for (let i = 0; i < numObstacles; i++) {
        const obstacleType = Math.random();

        if (obstacleType < MAP_GEN_CONFIG.PILLAR_CHANCE) {
            addPillarObstacle(map, room);
        } else if (obstacleType < MAP_GEN_CONFIG.PILLAR_CHANCE + MAP_GEN_CONFIG.WALL_SEGMENT_CHANCE) {
            addWallSegment(map, room);
        } else if (room.width >= 8 && room.height >= 8 && Math.random() < MAP_GEN_CONFIG.INTERNAL_WALL_CHANCE) {
            addInternalWall(map, room);
        } else {
            addRandomObstacle(map, room);
        }
    }
}

/**
 * Adds a pillar-style obstacle (single wall tile or small cluster)
 *
 * @param {Array} map - 2D map array
 * @param {Object} room - Room object
 */
function addPillarObstacle(map, room) {
    // Leave border space for movement
    const minX = room.x + 1;
    const maxX = room.x + room.width - 2;
    const minY = room.y + 1;
    const maxY = room.y + room.height - 2;

    if (minX >= maxX || minY >= maxY) return;

    const pillarX = minX + Math.floor(Math.random() * (maxX - minX));
    const pillarY = minY + Math.floor(Math.random() * (maxY - minY));

    // Single pillar or small cluster
    if (Math.random() < 0.7) {
        // Single pillar
        if (isValidObstaclePosition(map, pillarX, pillarY, room)) {
            map[pillarY][pillarX] = TILE_WALL;
        }
    } else {
        // 2x2 pillar cluster
        if (pillarX < maxX - 1 && pillarY < maxY - 1 &&
            isValidObstaclePosition(map, pillarX, pillarY, room) &&
            isValidObstaclePosition(map, pillarX + 1, pillarY, room) &&
            isValidObstaclePosition(map, pillarX, pillarY + 1, room) &&
            isValidObstaclePosition(map, pillarX + 1, pillarY + 1, room)) {

            map[pillarY][pillarX] = TILE_WALL;
            map[pillarY][pillarX + 1] = TILE_WALL;
            map[pillarY + 1][pillarX] = TILE_WALL;
            map[pillarY + 1][pillarX + 1] = TILE_WALL;
        }
    }
}

/**
 * Adds a wall segment (short internal wall)
 *
 * @param {Array} map - 2D map array
 * @param {Object} room - Room object
 */
function addWallSegment(map, room) {
    const minX = room.x + 1;
    const maxX = room.x + room.width - 2;
    const minY = room.y + 1;
    const maxY = room.y + room.height - 2;

    if (minX >= maxX || minY >= maxY) return;

    const isHorizontal = Math.random() < 0.5;
    const segmentLength = Math.min(3, isHorizontal ? room.width - 2 : room.height - 2);

    if (isHorizontal) {
        const startX = minX + Math.floor(Math.random() * (maxX - minX - segmentLength + 1));
        const wallY = minY + Math.floor(Math.random() * (maxY - minY));

        for (let i = 0; i < segmentLength; i++) {
            if (isValidObstaclePosition(map, startX + i, wallY, room)) {
                map[wallY][startX + i] = TILE_WALL;
            }
        }
    } else {
        const wallX = minX + Math.floor(Math.random() * (maxX - minX));
        const startY = minY + Math.floor(Math.random() * (maxY - minY - segmentLength + 1));

        for (let i = 0; i < segmentLength; i++) {
            if (isValidObstaclePosition(map, wallX, startY + i, room)) {
                map[startY + i][wallX] = TILE_WALL;
            }
        }
    }
}

/**
 * Adds an internal wall that divides the room but maintains accessibility
 *
 * @param {Array} map - 2D map array
 * @param {Object} room - Room object
 */
function addInternalWall(map, room) {
    const isHorizontal = Math.random() < 0.5;

    if (isHorizontal && room.height >= 6) {
        // Horizontal wall with gaps
        const wallY = room.y + 2 + Math.floor(Math.random() * (room.height - 4));
        const gapSize = Math.max(1, Math.floor(room.width / 4));
        const gapStart = room.x + 1 + Math.floor(Math.random() * (room.width - gapSize - 2));

        for (let x = room.x + 1; x < room.x + room.width - 1; x++) {
            if (x < gapStart || x >= gapStart + gapSize) {
                if (isValidObstaclePosition(map, x, wallY, room)) {
                    map[wallY][x] = TILE_WALL;
                }
            }
        }
    } else if (!isHorizontal && room.width >= 6) {
        // Vertical wall with gaps
        const wallX = room.x + 2 + Math.floor(Math.random() * (room.width - 4));
        const gapSize = Math.max(1, Math.floor(room.height / 4));
        const gapStart = room.y + 1 + Math.floor(Math.random() * (room.height - gapSize - 2));

        for (let y = room.y + 1; y < room.y + room.height - 1; y++) {
            if (y < gapStart || y >= gapStart + gapSize) {
                if (isValidObstaclePosition(map, wallX, y, room)) {
                    map[y][wallX] = TILE_WALL;
                }
            }
        }
    }
}

/**
 * Adds a random small obstacle
 *
 * @param {Array} map - 2D map array
 * @param {Object} room - Room object
 */
function addRandomObstacle(map, room) {
    const minX = room.x + 1;
    const maxX = room.x + room.width - 2;
    const minY = room.y + 1;
    const maxY = room.y + room.height - 2;

    if (minX >= maxX || minY >= maxY) return;

    const obstacleX = minX + Math.floor(Math.random() * (maxX - minX));
    const obstacleY = minY + Math.floor(Math.random() * (maxY - minY));

    if (isValidObstaclePosition(map, obstacleX, obstacleY, room)) {
        map[obstacleY][obstacleX] = TILE_WALL;
    }
}

/**
 * Checks if an obstacle can be placed at the given position
 * Ensures room remains accessible and doesn't block doorways
 *
 * @param {Array} map - 2D map array
 * @param {number} x - X coordinate to check
 * @param {number} y - Y coordinate to check
 * @param {Object} room - Room object for boundary checking
 * @returns {boolean} True if position is valid for obstacle
 */
function isValidObstaclePosition(map, x, y, room) {
    // Must be within room bounds (not on edges)
    if (x <= room.x || x >= room.x + room.width - 1 ||
        y <= room.y || y >= room.y + room.height - 1) {
        return false;
    }

    // Must be empty space
    if (map[y][x] !== TILE_EMPTY) {
        return false;
    }

    // Don't place obstacles too close to room center (keep some open space)
    const centerX = room.x + Math.floor(room.width / 2);
    const centerY = room.y + Math.floor(room.height / 2);
    const distanceFromCenter = Math.abs(x - centerX) + Math.abs(y - centerY);

    if (distanceFromCenter < 2) {
        return false;
    }

    // Ensure at least 2 adjacent spaces remain clear for movement
    let clearSpaces = 0;
    const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    for (const [dx, dy] of directions) {
        const checkX = x + dx;
        const checkY = y + dy;

        if (checkX >= 0 && checkX < map[0].length &&
            checkY >= 0 && checkY < map.length &&
            map[checkY][checkX] === TILE_EMPTY) {
            clearSpaces++;
        }
    }

    return clearSpaces >= 2;
}

/**
 * Connects all rooms using a minimum spanning tree algorithm
 * 
 * @param {Array} map - 2D map array
 * @param {Array} rooms - Array of room objects
 */
function connectAllRooms(map, rooms) {
    if (rooms.length === 0) return;

    console.log(`connectAllRooms: Connecting ${rooms.length} rooms`);

    // Start with the first room as connected
    let connectedSet = new Set();
    connectedSet.add(rooms[0].id);
    rooms[0].connected = true;

    console.log(`connectAllRooms: Started with room 0 at (${rooms[0].x},${rooms[0].y})`);

    // Connect remaining rooms using minimum spanning tree approach
    while (connectedSet.size < rooms.length) {
        let closestDistance = Infinity;
        let roomA = null, roomB = null;

        // Find closest unconnected room to any connected room
        for (const connectedRoom of rooms) {
            if (!connectedRoom.connected) continue;

            for (const unconnectedRoom of rooms) {
                if (unconnectedRoom.connected) continue;

                const distance = Math.hypot(
                    connectedRoom.center.x - unconnectedRoom.center.x,
                    connectedRoom.center.y - unconnectedRoom.center.y
                );

                if (distance < closestDistance) {
                    closestDistance = distance;
                    roomA = connectedRoom;
                    roomB = unconnectedRoom;
                }
            }
        }

        // Connect the closest pair
        if (roomA && roomB) {
            console.log(`connectAllRooms: Connecting room at (${roomA.x},${roomA.y}) to room at (${roomB.x},${roomB.y}), distance: ${closestDistance.toFixed(1)}`);
            createLShapedCorridorBetweenRooms(map, roomA, roomB);
            roomB.connected = true;
            connectedSet.add(roomB.id);
            console.log(`connectAllRooms: Now ${connectedSet.size}/${rooms.length} rooms connected`);
        } else {
            console.log(`connectAllRooms: No more rooms to connect (${connectedSet.size}/${rooms.length} connected)`);
            break; // No more rooms to connect
        }
    }

    console.log(`connectAllRooms: Finished connecting rooms (${connectedSet.size}/${rooms.length} connected)`);
}

// =============================================================================
// ITEM PLACEMENT SYSTEM
// =============================================================================

/**
 * Places gameplay elements like keys, weapons, health packs, and exits
 *
 * @param {Array} map - 2D map array
 * @param {Array} rooms - Array of room objects
 * @param {Object} actualPlayerStartRoom - Room where player starts
 * @param {boolean} isMainBossLevelLayout - Whether this is a boss level
 * @param {Object|null} layout - Zoned layout that already placed its own keys,
 *                               doors and exit, or null for the legacy path
 */
function placeGameplayElements(map, rooms, actualPlayerStartRoom, isMainBossLevelLayout, layout) {
    if (rooms.length === 0) return;

    // Create list of available rooms for item placement
    let availableRoomsForItems = [...rooms];
    const roomsToAvoidForKeyItems = actualPlayerStartRoom ? [actualPlayerStartRoom] : [];

    // A zoned layout has already committed its whole progression -- keys, gates and
    // exit -- as part of building the space, and every one of those decisions is
    // load-bearing. Re-running the legacy placement over the top would scatter a
    // second set of keys into rooms the progression never accounted for.
    const missionAlreadyPlaced = !!layout;

    let keyRooms = { redKeyRoom: null, yellowKeyRoom: null, blueKeyRoom: null, exitRoom: null };
    if (!isMainBossLevelLayout && !missionAlreadyPlaced) {
        keyRooms = placeKeys(map, availableRoomsForItems, roomsToAvoidForKeyItems, actualPlayerStartRoom);
    }

    // Keep weapons out of the rooms the mission depends on: a rocket launcher lying
    // on the same square the exit wants is a weapon that never spawns.
    const roomsToAvoidForWeapons = missionAlreadyPlaced
        ? [...roomsToAvoidForKeyItems, ...layout.keyRooms, layout.exitRoom].filter(Boolean)
        : roomsToAvoidForKeyItems;

    // Place weapons
    placeWeapons(map, availableRoomsForItems, roomsToAvoidForWeapons, isMainBossLevelLayout);

    // Place health packs
    placeHealthPacks(map, rooms, layout ? layout.playerStart : null);

    // Place secret rooms with hidden doors; every one is stocked, and the good
    // stuff -- weapons a tier early, spheres, backpacks -- lives nowhere else.
    placeSecretRooms(map, actualPlayerStartRoom);

    if (missionAlreadyPlaced) return;

    // Place exit and track the room
    keyRooms.exitRoom = placeExit(map, rooms, actualPlayerStartRoom);

    // Place colored doors guarding key rooms (after exit is placed)
    if (!isMainBossLevelLayout) {
        console.log("Attempting to place colored doors...");
        placeColoredDoors(map, rooms, keyRooms.redKeyRoom, keyRooms.yellowKeyRoom, keyRooms.blueKeyRoom, keyRooms.exitRoom, actualPlayerStartRoom);
    } else {
        console.log("Skipping door placement - this is a boss level");
    }
}

// =============================================================================
// RESERVED TILES
// =============================================================================

/**
 * Tiles nothing may carve into, encoded as `y * 10000 + x`.
 *
 * For a zoned level this is the solid rock between zones. That rock is the only
 * reason the gates are gates: carve a secret passage through it and the red door
 * becomes a suggestion. The verifier would catch such a level and throw it away,
 * but it is cheaper to not build it in the first place.
 */
let reservedTiles = null;

/**
 * Sets (or clears, with null) the tiles that carving must avoid.
 *
 * @param {Set<number>|null} tiles - Reserved tile set
 */
function setReservedTiles(tiles) {
    reservedTiles = tiles || null;
}

/**
 * Whether a tile is off limits to carving.
 *
 * @param {number} x - Tile column
 * @param {number} y - Tile row
 * @returns {boolean} True if nothing may be carved here
 */
function isReservedTile(x, y) {
    return reservedTiles !== null && reservedTiles.has(y * 10000 + x);
}

// =============================================================================
// TERRAIN POOLS
// =============================================================================

/**
 * Floods some of the level's rooms with the theme's liquid.
 *
 * The safety contract
 * -------------------
 * A player must never be REQUIRED to walk through something that hurts them. Lava
 * is a shortcut, a hazard to fight around, and a reason to take the long way -- it
 * is not a toll. That is enforced rather than hoped for: every pool is carved
 * provisionally, the level is re-flooded from the player's start using only tiles
 * that do no damage, and if anything that used to be reachable no longer is, the
 * pool is taken straight back out again.
 *
 * Water is exempt from that test, because wading is a cost in time rather than in
 * health. A flooded cistern is allowed to make you swim for the key.
 *
 * @param {Array} map - 2D map array to modify
 * @param {Array} rooms - Room objects
 * @param {Object} playerStartRoom - Room the player begins in, kept dry
 * @param {Object} playerStart - Player start cell `{ r, c }`
 * @param {Object} bossSpawn - Boss spawn cell `{ r, c }`, or null
 * @param {Function|null} [styleForRoom] - Given a room, the WALL_STYLES entry whose
 *                                         theme it should flood with. Omit for one
 *                                         theme across the whole map.
 */
export function placeTerrainPools(map, rooms, playerStartRoom, playerStart, bossSpawn, styleForRoom = null) {
    if (!map || !rooms || rooms.length === 0 || !playerStart) return;

    const levelStyle = WALL_STYLES[levelStyleIndex()];

    // A zoned level themes each room by the zone it stands in; a boss arena or a
    // fallback level has one look for the whole map.
    const themeOf = styleForRoom || (() => levelStyle);

    // What the level could reach before any of this. Every pool is measured against
    // it, so the test is "did I take anything away", not "is the map still roughly
    // connected" -- the second would happily wall a key off behind a lake.
    const baseline = floodReachable(map, playerStart, () => true);

    let pools = 0;

    for (const room of rooms) {
        if (room === playerStartRoom) continue;
        if (room.width * room.height < MAP_GEN_CONFIG.MIN_TERRAIN_ROOM_AREA) continue;

        const style = themeOf(room);
        const theme = style?.terrain;
        if (!theme || !(theme.chance > 0)) continue;
        if (Math.random() >= theme.chance) continue;

        const tile = pickThemeTerrain(style);
        if (tile === null) continue;

        const carved = carveTerrainPool(map, room, tile, playerStart, bossSpawn);
        if (carved.length === 0) continue;

        if (isDamagingTerrain(tile) && !preservesSafeAccess(map, playerStart, baseline)) {
            for (const cell of carved) map[cell.r][cell.c] = TILE_EMPTY;
            continue;
        }

        pools++;
    }

    if (pools > 0) {
        console.log(`placeTerrainPools: ${pools} pool(s) placed`);
    }
}

/**
 * Carves one organic pool into a room's interior.
 *
 * Grown outward from a seed rather than stamped as a rectangle: a rectangular lake
 * reads as a design element, and a ragged one reads as something that got in and
 * settled. Growth is confined to the room's interior less TERRAIN_ROOM_MARGIN, so
 * a walkable ring survives inside the room whatever shape comes out.
 *
 * @param {Array} map - 2D map array to modify
 * @param {Object} room - Room to carve within
 * @param {number} tile - Terrain tile id to fill with
 * @param {Object} playerStart - Player start cell `{ r, c }`
 * @param {Object} bossSpawn - Boss spawn cell `{ r, c }`, or null
 * @returns {Array<{r: number, c: number}>} The cells filled, for rollback
 */
function carveTerrainPool(map, room, tile, playerStart, bossSpawn) {
    const margin = MAP_GEN_CONFIG.TERRAIN_ROOM_MARGIN;
    const minX = room.x + margin;
    const maxX = room.x + room.width - 1 - margin;
    const minY = room.y + margin;
    const maxY = room.y + room.height - 1 - margin;
    if (maxX < minX || maxY < minY) return [];

    const region = (maxX - minX + 1) * (maxY - minY + 1);
    const target = Math.max(
        MAP_GEN_CONFIG.TERRAIN_POOL_MIN,
        randomInt(MAP_GEN_CONFIG.TERRAIN_POOL_MIN,
                  Math.max(MAP_GEN_CONFIG.TERRAIN_POOL_MIN,
                           Math.floor(region * MAP_GEN_CONFIG.TERRAIN_POOL_COVERAGE)))
    );

    const eligible = (x, y) =>
        x >= minX && x <= maxX && y >= minY && y <= maxY &&
        isPoolCandidate(map, x, y, playerStart, bossSpawn);

    // Seed somewhere legal. A handful of darts rather than a scan: most rooms take
    // the first one, and a room where they all miss has nothing worth flooding.
    let seed = null;
    for (let attempt = 0; attempt < 12 && !seed; attempt++) {
        const x = randomInt(minX, maxX);
        const y = randomInt(minY, maxY);
        if (eligible(x, y)) seed = { c: x, r: y };
    }
    if (!seed) return [];

    const filled = [];
    const frontier = [seed];
    const claimed = new Set([seed.r * MAP_COLS + seed.c]);

    while (frontier.length > 0 && filled.length < target) {
        // Drawn at random from the frontier rather than taken off the end, which is
        // the difference between a blob and a snake: a stack grows one long tendril,
        // a random draw spreads in every direction at once.
        const index = Math.floor(Math.random() * frontier.length);
        const cell = frontier.splice(index, 1)[0];

        if (!eligible(cell.c, cell.r)) continue;

        map[cell.r][cell.c] = tile;
        filled.push(cell);

        for (const step of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nc = cell.c + step[0];
            const nr = cell.r + step[1];
            const code = nr * MAP_COLS + nc;
            if (claimed.has(code)) continue;
            claimed.add(code);
            if (eligible(nc, nr)) frontier.push({ c: nc, r: nr });
        }
    }

    // A pool of one or two tiles is a puddle nobody notices and a light source for
    // no reason. Take it back out rather than ship it.
    if (filled.length < MAP_GEN_CONFIG.TERRAIN_POOL_MIN) {
        for (const cell of filled) map[cell.r][cell.c] = TILE_EMPTY;
        return [];
    }

    return filled;
}

/**
 * Whether a single tile may be flooded.
 *
 * Open floor, clear of the player's start, clear of a boss's spawn, and -- the
 * important one -- with nothing but floor, wall or more liquid in the eight tiles
 * around it. That last rule is what keeps a pool a full tile away from every key,
 * weapon, health pack, door and the level exit, so nothing is ever collected or
 * opened while standing in a fire.
 *
 * @param {Array} map - 2D map array
 * @param {number} x - Tile column
 * @param {number} y - Tile row
 * @param {Object} playerStart - Player start cell `{ r, c }`
 * @param {Object} bossSpawn - Boss spawn cell `{ r, c }`, or null
 * @returns {boolean} True if the tile may be flooded
 */
function isPoolCandidate(map, x, y, playerStart, bossSpawn) {
    if (y < 0 || y >= MAP_ROWS || x < 0 || x >= MAP_COLS) return false;
    if (map[y][x] !== TILE_EMPTY) return false;

    if (playerStart &&
        Math.max(Math.abs(x - playerStart.c), Math.abs(y - playerStart.r)) <= 2) {
        return false;
    }

    if (bossSpawn &&
        Math.max(Math.abs(x - bossSpawn.c), Math.abs(y - bossSpawn.r)) <=
            MAP_GEN_CONFIG.TERRAIN_BOSS_CLEARANCE) {
        return false;
    }

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= MAP_COLS || ny < 0 || ny >= MAP_ROWS) continue;
            const neighbour = map[ny][nx];
            if (neighbour === TILE_EMPTY || neighbour === TILE_WALL) continue;
            if (isTerrainTile(neighbour)) continue;
            return false;   // A key, door, weapon, health pack or the exit
        }
    }

    return true;
}

/**
 * Every tile reachable on foot from a starting cell, subject to a filter.
 *
 * Closed doors count as passable, matching validateMapConnectivity(): the player
 * holds the key by the time they get there, and the generator has already proved
 * the keys themselves are reachable in order.
 *
 * @param {Array} map - 2D map array
 * @param {Object} start - Cell `{ r, c }` to flood from
 * @param {Function} allow - Given a tile value, whether it may be walked over
 * @returns {Set<number>} Reachable cells encoded as `r * MAP_COLS + c`
 */
function floodReachable(map, start, allow) {
    const reached = new Set();
    if (!map || !start) return reached;

    const stack = [{ c: start.c, r: start.r }];
    while (stack.length > 0) {
        const cell = stack.pop();
        const { c, r } = cell;
        if (c < 0 || c >= MAP_COLS || r < 0 || r >= MAP_ROWS) continue;

        const code = r * MAP_COLS + c;
        if (reached.has(code)) continue;

        const tile = map[r] && map[r][c];
        if (tile === undefined || tile === TILE_WALL || tile === TILE_PROP ||
            tile === TILE_SLIDE || tile === TILE_SWITCH || tile === TILE_WINDOW) continue;
        if (!allow(tile)) continue;

        reached.add(code);
        stack.push({ c: c + 1, r }, { c: c - 1, r }, { c, r: r + 1 }, { c, r: r - 1 });
    }

    return reached;
}

/**
 * Whether everything the level could reach before the pools were carved can still
 * be reached without walking through anything that deals damage.
 *
 * Tiles that are themselves damaging are exempt -- of course you cannot stand in
 * the middle of a lava lake without touching lava. What must survive is access to
 * every piece of ordinary ground the player could previously walk to.
 *
 * @param {Array} map - 2D map array
 * @param {Object} playerStart - Player start cell `{ r, c }`
 * @param {Set<number>} baseline - Reachable set from before any pools were cut
 * @returns {boolean} True if nothing was cut off
 */
function preservesSafeAccess(map, playerStart, baseline) {
    const safe = floodReachable(map, playerStart, (tile) => !isDamagingTerrain(tile));

    for (const code of baseline) {
        if (safe.has(code)) continue;
        const r = Math.floor(code / MAP_COLS);
        const c = code % MAP_COLS;
        if (isDamagingTerrain(map[r][c])) continue;   // The pool's own tiles
        return false;
    }

    return true;
}

/**
 * Checks if a room is accessible from the player start room without requiring any keys
 * Uses simple pathfinding to verify corridor accessibility (ignores doors)
 */
function isRoomAccessibleWithoutKeys(map, playerStartRoom, targetRoom) {
    if (!playerStartRoom || !targetRoom) return false;
    if (playerStartRoom === targetRoom) return true;

    // Use BFS to find path from player start to target room
    const visited = new Set();
    const queue = [];

    // Add ALL tiles from player start room to the queue and visited set
    for (let r = playerStartRoom.y; r < playerStartRoom.y + playerStartRoom.height; r++) {
        for (let c = playerStartRoom.x; c < playerStartRoom.x + playerStartRoom.width; c++) {
            if (r >= 0 && r < MAP_ROWS && c >= 0 && c < MAP_COLS) {
                visited.add(`${c},${r}`);
                queue.push({ x: c, y: r });
            }
        }
    }

    while (queue.length > 0) {
        const current = queue.shift();
        const { x, y } = current;

        // Check if we reached the target room
        if (x >= targetRoom.x && x < targetRoom.x + targetRoom.width &&
            y >= targetRoom.y && y < targetRoom.y + targetRoom.height) {
            return true;
        }

        // Explore adjacent cells
        const directions = [{ dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }, { dx: -1, dy: 0 }];
        for (const dir of directions) {
            const newX = x + dir.dx;
            const newY = y + dir.dy;
            const key = `${newX},${newY}`;

            if (newX >= 0 && newX < MAP_COLS && newY >= 0 && newY < MAP_ROWS && !visited.has(key)) {
                const tile = map[newY][newX];
                // Only traverse empty tiles (corridors and rooms), ignore doors
                if (tile === TILE_EMPTY) {
                    visited.add(key);
                    queue.push({ x: newX, y: newY });
                }
            }
        }
    }

    return false;
}

/**
 * Places colored keys in different rooms with accessibility validation
 *
 * @param {Array} map - 2D map array
 * @param {Array} availableRooms - Available rooms for placement
 * @param {Array} roomsToAvoid - Rooms to avoid for key placement
 * @param {Object} playerStartRoom - Room where player starts (for accessibility validation)
 */
function placeKeys(map, availableRooms, roomsToAvoid, playerStartRoom) {
    const keyRooms = {
        redKeyRoom: null,
        yellowKeyRoom: null,
        blueKeyRoom: null,
        exitRoom: null
    };

    // Place RED KEY first - Prefer accessible non-player-start rooms, use player start only as fallback
    let redKeyRoom = null;

    // First, try to find accessible rooms OTHER than the player start room
    const accessibleNonPlayerRooms = availableRooms.filter(room =>
        room !== playerStartRoom &&
        !roomsToAvoid.includes(room) &&
        isRoomAccessibleWithoutKeys(map, playerStartRoom, room)
    );

    console.log(`Found ${accessibleNonPlayerRooms.length} accessible non-player-start rooms for red key`);

    if (accessibleNonPlayerRooms.length > 0) {
        // Prefer accessible rooms other than player start
        redKeyRoom = pickRoomForItem(accessibleNonPlayerRooms, []);
        if (redKeyRoom && placeItemInRandomEmptyTile(redKeyRoom, TILE_KEY_RED, map)) {
            keyRooms.redKeyRoom = redKeyRoom;
            console.log(`Placed RED key in accessible room at ${redKeyRoom.x},${redKeyRoom.y}`);
            roomsToAvoid.push(redKeyRoom);
        }
    } else {
        // Fallback 1: Use player start room if no other accessible rooms
        console.log("No accessible non-player-start rooms found, trying player start room as fallback");
        // Always allow player start room for red key as fallback, even if it's in roomsToAvoid
        redKeyRoom = playerStartRoom;
        if (placeItemInRandomEmptyTile(redKeyRoom, TILE_KEY_RED, map)) {
            keyRooms.redKeyRoom = redKeyRoom;
            console.log(`Placed RED key in player start room at ${redKeyRoom.x},${redKeyRoom.y} (fallback - no other accessible rooms)`);
            // Only add to avoid list if it wasn't already there
            if (!roomsToAvoid.includes(redKeyRoom)) {
                roomsToAvoid.push(redKeyRoom);
            }
        } else {
            // Fallback 2: Last resort - pick any available room
            console.warn("Failed to place RED key in player start room, using any available room (may not be accessible!)");
            redKeyRoom = pickRoomForItem(availableRooms, roomsToAvoid);
            if (redKeyRoom && placeItemInRandomEmptyTile(redKeyRoom, TILE_KEY_RED, map)) {
                keyRooms.redKeyRoom = redKeyRoom;
                console.log(`Placed RED key in last resort room at ${redKeyRoom.x},${redKeyRoom.y} (may not be accessible!)`);
                roomsToAvoid.push(redKeyRoom);
            }
        }
    }

    // Place YELLOW KEY in a different room (will be locked behind red door)
    const yellowKeyRoom = pickRoomForItem(availableRooms, roomsToAvoid);
    if (yellowKeyRoom && placeItemInRandomEmptyTile(yellowKeyRoom, TILE_KEY_YELLOW, map)) {
        keyRooms.yellowKeyRoom = yellowKeyRoom;
        console.log(`Placed YELLOW key in room at ${yellowKeyRoom.x},${yellowKeyRoom.y} (will be locked behind red door)`);

        // Add yellow key room to avoid list for blue key
        roomsToAvoid.push(yellowKeyRoom);
    }

    // Place BLUE KEY in a different room (will be locked behind yellow door)
    const blueKeyRoom = pickRoomForItem(availableRooms, roomsToAvoid);
    if (blueKeyRoom && placeItemInRandomEmptyTile(blueKeyRoom, TILE_KEY_BLUE, map)) {
        keyRooms.blueKeyRoom = blueKeyRoom;
        console.log(`Placed BLUE key in room at ${blueKeyRoom.x},${blueKeyRoom.y} (will be locked behind yellow door)`);

        // Add blue key room to avoid list for exit
        roomsToAvoid.push(blueKeyRoom);
    }

    return keyRooms;
}

/**
 * Places weapons in appropriate rooms
 * 
 * @param {Array} map - 2D map array
 * @param {Array} availableRooms - Available rooms for placement
 * @param {Array} roomsToAvoid - Rooms to avoid for weapon placement
 * @param {boolean} isMainBossLevel - Whether this is a boss level
 */
function placeWeapons(map, availableRooms, roomsToAvoid, isMainBossLevel) {
    const currentLevel = window.gameState?.currentLevel || 1;

    // Determine which weapons to place based on strict level progression
    const weaponsToPlace = [];

    // Basic weapons available early
    if (currentLevel >= 2) weaponsToPlace.push(TILE_WEAPON_SHOTGUN);
    if (currentLevel >= 4) weaponsToPlace.push(TILE_WEAPON_RIFLE);
    if (currentLevel >= 7 && Math.random() < 0.5) weaponsToPlace.push(TILE_WEAPON_PLASMAGUN);

    // Advanced weapons require higher levels for regular placement
    if (currentLevel >= 8 && Math.random() < 0.6) weaponsToPlace.push(TILE_WEAPON_ROCKETLAUNCHER);
    if (currentLevel >= 12 && Math.random() < 0.3) weaponsToPlace.push(TILE_WEAPON_BFG);

    // Boss levels get better weapon selection
    if (isMainBossLevel) {
        weaponsToPlace.push(TILE_WEAPON_ROCKETLAUNCHER);
        if (currentLevel >= 10) weaponsToPlace.push(TILE_WEAPON_BFG);
    }

    // Place weapons in different rooms
    for (const weaponType of weaponsToPlace) {
        const room = pickRoomForItem(availableRooms, roomsToAvoid);
        if (room) {
            placeItemInRandomEmptyTile(room, weaponType, map);
        }
    }

}

/**
 * Places health packs randomly in rooms
 *
 * @param {Array} map - 2D map array
 * @param {Array} rooms - Array of room objects
 * @param {Object|null} playerStart - Player start cell `{ r, c }`, kept clear
 */
function placeHealthPacks(map, rooms, playerStart) {
    for (const room of rooms) {
        if (Math.random() < MAP_GEN_CONFIG.HEALTH_PACK_CHANCE) {
            // Not on the player's own spawn square: they would swallow it on frame
            // one, at full health, without ever seeing it.
            placeItemInRandomEmptyTile(room, TILE_HEALTH_PACK, map, playerStart);
        }
    }
}

/**
 * Places secret rooms with hidden doors
 *
 * @param {Array} map - 2D map array
 * @param {Object} playerStartRoom - Player start room for connectivity validation
 */
function placeSecretRooms(map, playerStartRoom) {
    // Determine number of secret rooms (0-3)
    // randomInt() is inclusive at both ends, so the trailing "+ 1" produced up to
    // MAX_SECRET_ROOMS + 1 rooms -- 4 where the config caps it at 3.
    const numSecretRooms = randomInt(
        MAP_GEN_CONFIG.MIN_SECRET_ROOMS,
        MAP_GEN_CONFIG.MAX_SECRET_ROOMS
    );

    console.log(`Attempting to place ${numSecretRooms} secret rooms`);

    let secretRoomsPlaced = 0;
    const maxAttempts = 50;


    for (let i = 0; i < numSecretRooms; i++) {
        let attempts = 0;
        let roomPlaced = false;
        while (attempts < maxAttempts && !roomPlaced) {
            if (attemptSecretRoomPlacement(map, playerStartRoom)) {
                secretRoomsPlaced++;
                console.log(`Secret room ${secretRoomsPlaced} placed successfully`);
                roomPlaced = true;
            }
            attempts++;
        }
        if (!roomPlaced) {
            console.log(`Failed to place secret room ${i + 1} after ${maxAttempts} attempts`);
        }
    }

    console.log(`Placed ${secretRoomsPlaced} out of ${numSecretRooms} planned secret rooms`);

    // Now that every secret exists, choose the prize and stock them all. The
    // prize is stocked last so its suite can grow into rock the others left.
    if (secretSuites.length > 0) {
        const prize = randomChoice(secretSuites);
        for (const suite of secretSuites) {
            if (suite !== prize) stockMinorSecret(map, suite);
        }
        extendSecretSuite(map, prize.chambers);
        stockPrizeSuite(map, prize);
    }
}

/**
 * Attempts to place a single secret room
 *
 * @param {Array} map - 2D map array
 * @param {Object} playerStartRoom - Player start room for connectivity validation
 * @returns {boolean} True if secret room was successfully placed
 */
function attemptSecretRoomPlacement(map, playerStartRoom) {
    // Generate random dimensions for the first chamber
    const targetTiles = randomInt(MAP_GEN_CONFIG.MIN_SECRET_ROOM_SIZE, MAP_GEN_CONFIG.MAX_SECRET_ROOM_SIZE);

    // Try different rectangular configurations for the target tile count
    const possibleDimensions = [];
    for (let width = 2; width <= 7; width++) {
        for (let height = 2; height <= 7; height++) {
            const tiles = width * height;
            if (tiles >= MAP_GEN_CONFIG.MIN_SECRET_ROOM_SIZE && tiles <= MAP_GEN_CONFIG.MAX_SECRET_ROOM_SIZE) {
                possibleDimensions.push({ width, height, tiles });
            }
        }
    }

    // Filter dimensions to ones close to our target
    const suitableDimensions = possibleDimensions.filter(dim =>
        Math.abs(dim.tiles - targetTiles) <= 2
    );

    if (suitableDimensions.length === 0) return false;

    const dimensions = suitableDimensions[Math.floor(Math.random() * suitableDimensions.length)];

    // Try to find a suitable location
    const maxLocationAttempts = 30;
    for (let attempt = 0; attempt < maxLocationAttempts; attempt++) {
        const x = randomInt(2, MAP_COLS - dimensions.width - 2);
        const y = randomInt(2, MAP_ROWS - dimensions.height - 2);

        if (canPlaceSecretRoom(map, x, y, dimensions.width, dimensions.height)) {
            // createSecretRoom reverts itself if the room ends up unreachable,
            // so keep trying other locations rather than counting it as placed.
            if (createSecretRoom(map, x, y, dimensions.width, dimensions.height, playerStartRoom)) {
                return true;
            }
        }
    }

    console.log(`Failed to place secret room with dimensions ${dimensions.width}x${dimensions.height} after ${maxLocationAttempts} location attempts`);
    return false;
}

/**
 * Checks if a secret room can be placed at the given location
 *
 * @param {Array} map - 2D map array
 * @param {number} x - Top-left X coordinate
 * @param {number} y - Top-left Y coordinate
 * @param {number} width - Room width
 * @param {number} height - Room height
 * @returns {boolean} True if room can be placed
 */
function canPlaceSecretRoom(map, x, y, width, height) {
    // Check if area is completely surrounded by walls and has buffer space
    for (let checkY = y - 1; checkY <= y + height; checkY++) {
        for (let checkX = x - 1; checkX <= x + width; checkX++) {
            if (checkX < 0 || checkX >= MAP_COLS || checkY < 0 || checkY >= MAP_ROWS) {
                return false;
            }

            // All tiles in the area (including border) must be walls
            if (map[checkY][checkX] !== TILE_WALL) {
                return false;
            }

            // ...and none of them may be the rock holding two zones apart
            if (isReservedTile(checkX, checkY)) {
                return false;
            }
        }
    }

    // Check for nearby empty spaces (too close to existing rooms)
    for (let checkY = y - 2; checkY <= y + height + 1; checkY++) {
        for (let checkX = x - 2; checkX <= x + width + 1; checkX++) {
            if (checkX >= 0 && checkX < MAP_COLS && checkY >= 0 && checkY < MAP_ROWS) {
                if (map[checkY][checkX] === TILE_EMPTY) {
                    // Check if this empty space is close enough to interfere
                    const distanceToRoom = Math.min(
                        Math.abs(checkX - x), Math.abs(checkX - (x + width - 1)),
                        Math.abs(checkY - y), Math.abs(checkY - (y + height - 1))
                    );
                    if (distanceToRoom < 2) {
                        return false;
                    }
                }
            }
        }
    }

    return true;
}

/**
 * Creates a secret room and places a secret door
 *
 * @param {Array} map - 2D map array
 * @param {number} x - Top-left X coordinate
 * @param {number} y - Top-left Y coordinate
 * @param {number} width - Room width
 * @param {number} height - Room height
 * @param {Object} playerStartRoom - Player start room for connectivity validation
 * @returns {boolean} True if the room was created and is reachable
 */
function createSecretRoom(map, x, y, width, height, playerStartRoom) {
    // Carve out the secret room
    for (let roomY = y; roomY < y + height; roomY++) {
        for (let roomX = x; roomX < x + width; roomX++) {
            map[roomY][roomX] = TILE_EMPTY;
        }
    }

    // Place a secret door on one of the walls. If no reachable wall can host one the
    // room is sealed: it used to be carved and stocked with loot regardless, leaving
    // weapons and health permanently entombed inside solid rock (and inflating the
    // empty-tile count that connectivity validation relies on). Fill it back in.
    if (!placeSecretDoorForRoom(map, x, y, width, height, playerStartRoom)) {
        for (let roomY = y; roomY < y + height; roomY++) {
            for (let roomX = x; roomX < x + width; roomX++) {
                map[roomY][roomX] = TILE_WALL;
            }
        }
        console.log(`Reverted unreachable secret room at (${x}, ${y})`);
        return false;
    }

    // Recorded, not yet stocked: what a secret holds depends on which of the
    // level's secrets it turns out to be (see placeSecretRooms).
    secretSuites.push({ chambers: [{ x, y, width, height }], loot: [] });

    console.log(`Created secret room at (${x}, ${y}) with dimensions ${width}x${height} (${width * height} tiles)`);
    return true;
}

/**
 * Grows the prize secret into a suite: a second chamber off one side of the
 * first whenever there is rock for it, and perhaps a third off that, each
 * behind a doorway in the shared wall. Chambers that find no room to exist
 * are simply not built.
 *
 * @param {Array} map - 2D map array
 * @param {Array<{x: number, y: number, width: number, height: number}>} chambers - The suite so far; grown in place
 */
function extendSecretSuite(map, chambers) {
    const wanted = Math.random() < MAP_GEN_CONFIG.SECRET_THIRD_CHAMBER_CHANCE ? 2 : 1;

    for (let i = 0; i < wanted; i++) {
        const next = placeChamberBeside(map, chambers[chambers.length - 1]);
        if (!next) break;
        chambers.push(next);
    }
}

/**
 * Carves a chamber against one side of an existing one, one wall apart, and
 * opens a doorway through that wall.
 *
 * @param {Array} map - 2D map array
 * @param {Object} previous - The chamber to build off
 * @returns {Object|null} The new chamber, or null if no side had room
 */
function placeChamberBeside(map, previous) {
    for (const side of shuffleArray(['E', 'W', 'S', 'N'])) {
        for (let attempt = 0; attempt < 8; attempt++) {
            const width = randomInt(2, 6);
            const height = randomInt(2, 6);
            let x;
            let y;

            if (side === 'E' || side === 'W') {
                x = side === 'E' ? previous.x + previous.width + 1 : previous.x - width - 1;
                y = previous.y + randomInt(-(height - 1), previous.height - 1);
            } else {
                y = side === 'S' ? previous.y + previous.height + 1 : previous.y - height - 1;
                x = previous.x + randomInt(-(width - 1), previous.width - 1);
            }

            if (!canPlaceChamber(map, x, y, width, height)) continue;

            for (let r = y; r < y + height; r++) {
                for (let c = x; c < x + width; c++) map[r][c] = TILE_EMPTY;
            }

            // The doorway: somewhere along the stretch of shared wall.
            if (side === 'E' || side === 'W') {
                const wallX = side === 'E' ? previous.x + previous.width : previous.x - 1;
                const lo = Math.max(previous.y, y);
                const hi = Math.min(previous.y + previous.height, y + height) - 1;
                const r = randomInt(lo, hi);
                map[r][wallX] = TILE_EMPTY;
                if (r + 1 <= hi && Math.random() < 0.5) map[r + 1][wallX] = TILE_EMPTY;
            } else {
                const wallY = side === 'S' ? previous.y + previous.height : previous.y - 1;
                const lo = Math.max(previous.x, x);
                const hi = Math.min(previous.x + previous.width, x + width) - 1;
                const c = randomInt(lo, hi);
                map[wallY][c] = TILE_EMPTY;
                if (c + 1 <= hi && Math.random() < 0.5) map[wallY][c + 1] = TILE_EMPTY;
            }

            return { x, y, width, height };
        }
    }
    return null;
}

/**
 * Whether a chamber can be carved here: solid rock throughout, with a ring of
 * unreserved rock around it.
 *
 * The first chamber also keeps two tiles clear of any open floor, so the
 * secret is not lying right beside the corridor it hides from; an extension
 * does not need that -- it is already behind a hidden door, and the tile at
 * distance two is as likely to be the suite's own entry path as anything
 * else. One wall between it and the world is what makes it a room.
 *
 * @param {Array} map - 2D map array
 * @param {number} x - Top-left column
 * @param {number} y - Top-left row
 * @param {number} width - Width in tiles
 * @param {number} height - Height in tiles
 * @returns {boolean}
 */
function canPlaceChamber(map, x, y, width, height) {
    if (x < 2 || y < 2 || x + width > MAP_COLS - 2 || y + height > MAP_ROWS - 2) return false;

    for (let r = y - 1; r <= y + height; r++) {
        for (let c = x - 1; c <= x + width; c++) {
            if (map[r][c] !== TILE_WALL || isReservedTile(c, r)) return false;
        }
    }
    return true;
}

/**
 * The free floor of a suite, shuffled, with a taker that can prefer the
 * chamber furthest from the door.
 *
 * @param {Array} map - 2D map array
 * @param {Array} chambers - The suite's chambers, first is nearest the door
 * @returns {Function} take(deep) -> {c, r} or null
 */
function suiteFloor(map, chambers) {
    const free = [];
    chambers.forEach((chamber, index) => {
        for (let r = chamber.y; r < chamber.y + chamber.height; r++) {
            for (let c = chamber.x; c < chamber.x + chamber.width; c++) {
                if (map[r][c] === TILE_EMPTY) free.push({ c, r, chamber: index });
            }
        }
    });
    shuffleArray(free);

    return (deep) => {
        if (deep) {
            const index = free.findIndex(t => t.chamber === chambers.length - 1);
            if (index !== -1) return free.splice(index, 1)[0];
        }
        return free.pop() || null;
    };
}

/**
 * The kinds of ammo in play at a level.
 *
 * @param {number} level - Current level
 * @returns {string[]} AMMO_TYPES keys
 */
function ammoKindsAtLevel(level) {
    const kinds = ['bullets', 'shells'];
    if (level >= 4) kinds.push('rockets');
    if (level >= 6) kinds.push('cells');
    return kinds;
}

/**
 * Stocks the level's prize secret with the things the rest of the level never
 * offers:
 *
 *   - a weapon one tier ahead of what the level would place, at the far end;
 *   - a soulsphere or a backpack, or failing those a medikit;
 *   - a box of ammo per chamber;
 *   - a third chamber earns a second medikit.
 *
 * Weapons and medikits are map tiles and go straight in; ammo and powerups are
 * entities, recorded for the game state to spawn.
 *
 * @param {Array} map - 2D map array
 * @param {Object} suite - The suite record; its loot list is filled in
 */
function stockPrizeSuite(map, suite) {
    const level = window.gameState?.currentLevel || 1;
    const chambers = suite.chambers;
    const take = suiteFloor(map, chambers);
    const loot = suite.loot;

    const weapon = earlySecretWeapon(level);
    const weaponSpot = take(true);
    if (weapon && weaponSpot) map[weaponSpot.r][weaponSpot.c] = weapon;

    const roll = Math.random();
    const prize = take(true);
    if (prize) {
        if (roll < 0.5) loot.push({ kind: 'powerup', powerup: 'soulsphere', c: prize.c, r: prize.r });
        else if (roll < 0.85) loot.push({ kind: 'powerup', powerup: 'backpack', c: prize.c, r: prize.r });
        else map[prize.r][prize.c] = TILE_HEALTH_PACK;
    }

    const kinds = ammoKindsAtLevel(level);
    for (let i = 0; i < chambers.length; i++) {
        const spot = take(false);
        if (!spot) break;
        loot.push({ kind: 'ammo', type: randomChoice(kinds), big: true, c: spot.c, r: spot.r });
    }

    if (chambers.length >= 3) {
        const spot = take(false);
        if (spot) map[spot.r][spot.c] = TILE_HEALTH_PACK;
    }
}

/**
 * Stocks one of the level's other secrets: a small room with a small bonus.
 * Most of the time a single pickup -- a clip, a handful of shells, or a
 * medikit; sometimes a box of ammo with a medikit beside it. Never a weapon,
 * never a sphere: those are the prize secret's, so that a level with six
 * hidden rooms is still a level with one big find.
 *
 * @param {Array} map - 2D map array
 * @param {Object} suite - The suite record; its loot list is filled in
 */
function stockMinorSecret(map, suite) {
    const level = window.gameState?.currentLevel || 1;
    const take = suiteFloor(map, suite.chambers);
    const kinds = ammoKindsAtLevel(level);

    if (Math.random() < 0.55) {
        const spot = take(false);
        if (!spot) return;
        if (Math.random() < 0.4) map[spot.r][spot.c] = TILE_HEALTH_PACK;
        else suite.loot.push({ kind: 'ammo', type: randomChoice(kinds), big: false, c: spot.c, r: spot.r });
        return;
    }

    const box = take(false);
    if (box) suite.loot.push({ kind: 'ammo', type: randomChoice(kinds), big: true, c: box.c, r: box.r });
    const kit = take(false);
    if (kit) map[kit.r][kit.c] = TILE_HEALTH_PACK;
}
/**
 * The weapon a secret holds: the next one up the ladder from what the level
 * would place in the open, so a secret found on level 3 is a chaingun a level
 * early. Past the top of the ladder it is one of the big three, for the ammo.
 *
 * @param {number} level - Current level
 * @returns {number} A weapon tile constant
 */
function earlySecretWeapon(level) {
    const ladder = [
        [TILE_WEAPON_SHOTGUN, 2],
        [TILE_WEAPON_RIFLE, 4],
        [TILE_WEAPON_PLASMAGUN, 7],
        [TILE_WEAPON_ROCKETLAUNCHER, 8],
        [TILE_WEAPON_BFG, 12],
    ];
    const next = ladder.find(([, unlock]) => unlock > level);
    return next ? next[0] : randomChoice([TILE_WEAPON_PLASMAGUN, TILE_WEAPON_ROCKETLAUNCHER, TILE_WEAPON_BFG]);
}

/**
 * Places a secret door that connects an existing accessible area to the secret room
 *
 * @param {Array} map - 2D map array
 * @param {number} roomX - Room top-left X coordinate
 * @param {number} roomY - Room top-left Y coordinate
 * @param {number} width - Room width
 * @param {number} height - Room height
 * @param {Object} playerStartRoom - Player start room for connectivity validation
 */
function placeSecretDoorForRoom(map, roomX, roomY, width, height, playerStartRoom) {
    const possibleDoors = [];

    // Find walls that are adjacent to existing accessible areas AND can connect to the secret room
    // We need to find walls that have empty space on one side (existing area)
    // and can connect to the secret room on the other side

    // Check area around the secret room for potential door locations
    const searchRadius = 3; // How far to search around the secret room

    for (let checkY = roomY - searchRadius; checkY <= roomY + height + searchRadius; checkY++) {
        for (let checkX = roomX - searchRadius; checkX <= roomX + width + searchRadius; checkX++) {
            if (checkX < 0 || checkX >= MAP_COLS || checkY < 0 || checkY >= MAP_ROWS) continue;

            // Only consider wall tiles
            if (map[checkY][checkX] !== TILE_WALL) continue;

            // Check if this wall is adjacent to an existing accessible area connected to main dungeon
            if (isAdjacentToAccessibleArea(map, checkX, checkY, playerStartRoom)) {
                // Check if we can create a path from this wall to the secret room
                if (canConnectToSecretRoom(map, checkX, checkY, roomX, roomY, width, height)) {
                    possibleDoors.push({
                        x: checkX,
                        y: checkY,
                        distance: Math.min(
                            Math.abs(checkX - (roomX + width/2)),
                            Math.abs(checkY - (roomY + height/2))
                        )
                    });
                }
            }
        }
    }


    if (possibleDoors.length > 0) {
        // Sort by distance to secret room (prefer closer doors)
        possibleDoors.sort((a, b) => a.distance - b.distance);

        // Pick from the closest options (add some randomness)
        const maxOptions = Math.min(3, possibleDoors.length);
        const door = possibleDoors[Math.floor(Math.random() * maxOptions)];


        map[door.y][door.x] = TILE_SECRET_DOOR;

        // Create a path from the secret door to the secret room
        createPathToSecretRoom(map, door.x, door.y, roomX, roomY, width, height);

        console.log(`Placed secret door at (${door.x}, ${door.y}) connecting to secret room at (${roomX}, ${roomY})`);
        return true;
    }

    console.log(`Could not find valid secret door location for room at (${roomX}, ${roomY})`);
    return false;
}

/**
 * Checks if a wall is adjacent to an existing accessible area that's connected to the main dungeon
 * Uses pathfinding to verify the adjacent area can reach the player start
 *
 * @param {Array} map - 2D map array
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {Object} playerStartRoom - Player start room for connectivity validation
 * @returns {boolean} True if wall is adjacent to accessible area connected to main dungeon
 */
function isAdjacentToAccessibleArea(map, x, y, playerStartRoom) {
    const directions = [
        { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }
    ];

    // Check if this wall is directly adjacent to an empty space that's connected to the main dungeon
    for (const dir of directions) {
        const checkX = x + dir.x;
        const checkY = y + dir.y;

        if (checkX >= 0 && checkX < MAP_COLS && checkY >= 0 && checkY < MAP_ROWS) {
            if (map[checkY][checkX] === TILE_EMPTY) {
                // Found an adjacent empty space - now verify it's connected to the main dungeon
                if (isPositionConnectedToMainDungeon(map, checkX, checkY, playerStartRoom)) {
                    return true;
                }
            }
        }
    }

    return false;
}

/**
 * Checks if a position is connected to the main dungeon (reachable from player start)
 * Uses BFS pathfinding to verify connectivity
 *
 * @param {Array} map - 2D map array
 * @param {number} startX - Starting X coordinate to test
 * @param {number} startY - Starting Y coordinate to test
 * @param {Object} playerStartRoom - Player start room
 * @returns {boolean} True if position is connected to main dungeon
 */
function isPositionConnectedToMainDungeon(map, startX, startY, playerStartRoom) {
    if (!playerStartRoom) return false;

    // Use BFS to check if we can reach the player start room from this position
    const visited = new Set();
    const queue = [{ x: startX, y: startY }];
    visited.add(`${startX},${startY}`);

    while (queue.length > 0) {
        const current = queue.shift();
        const { x, y } = current;

        // Check if we reached the player start room
        if (x >= playerStartRoom.x && x < playerStartRoom.x + playerStartRoom.width &&
            y >= playerStartRoom.y && y < playerStartRoom.y + playerStartRoom.height) {
            return true;
        }

        // Explore adjacent cells
        const directions = [{ dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }, { dx: -1, dy: 0 }];
        for (const dir of directions) {
            const newX = x + dir.dx;
            const newY = y + dir.dy;
            const key = `${newX},${newY}`;

            if (newX >= 0 && newX < MAP_COLS && newY >= 0 && newY < MAP_ROWS && !visited.has(key)) {
                const tile = map[newY][newX];
                // Traverse empty tiles and colored doors (but not secret doors)
                if (tile === TILE_EMPTY || tile === TILE_DOOR_RED || tile === TILE_DOOR_YELLOW || tile === TILE_DOOR_BLUE) {
                    visited.add(key);
                    queue.push({ x: newX, y: newY });
                }
            }
        }
    }

    return false;
}

/**
 * Checks if we can create a connection from a wall position to a secret room
 * Uses improved pathfinding to ensure proper connectivity
 *
 * @param {Array} map - 2D map array
 * @param {number} doorX - Secret door X coordinate
 * @param {number} doorY - Secret door Y coordinate
 * @param {number} roomX - Secret room top-left X coordinate
 * @param {number} roomY - Secret room top-left Y coordinate
 * @param {number} width - Secret room width
 * @param {number} height - Secret room height
 * @returns {boolean} True if connection is possible
 */
function canConnectToSecretRoom(map, doorX, doorY, roomX, roomY, width, height) {
    // Find the closest edge of the secret room to connect to
    const roomCenterX = roomX + Math.floor(width / 2);
    const roomCenterY = roomY + Math.floor(height / 2);

    // Calculate distance to room - reject if too far (prevents long tunnels through walls)
    const distance = Math.abs(doorX - roomCenterX) + Math.abs(doorY - roomCenterY);
    if (distance > 6) { // Reduced from 10 to 6 for better connectivity
        return false;
    }

    // Check if we can create a direct path using only a simple L-shape
    // The path should only traverse through walls and not cross existing corridors
    return canCreateDirectPath(map, doorX, doorY, roomX, roomY, width, height);
}

/**
 * Checks if a direct path can be created between door and secret room through walls only
 * Ensures the path doesn't go through existing corridors or rooms
 */
function canCreateDirectPath(map, doorX, doorY, roomX, roomY, width, height) {
    // Find the closest point on the secret room boundary to connect to
    let targetX, targetY;

    // Determine which edge of the room is closest to the door
    if (doorX < roomX) {
        // Door is to the left of room
        targetX = roomX;
        targetY = Math.max(roomY, Math.min(roomY + height - 1, doorY));
    } else if (doorX >= roomX + width) {
        // Door is to the right of room
        targetX = roomX + width - 1;
        targetY = Math.max(roomY, Math.min(roomY + height - 1, doorY));
    } else {
        // Door is above or below room
        targetX = doorX;
        if (doorY < roomY) {
            targetY = roomY;
        } else {
            targetY = roomY + height - 1;
        }
    }

    // Validate bounds
    if (targetX < 0 || targetX >= MAP_COLS || targetY < 0 || targetY >= MAP_ROWS) {
        return false;
    }

    // Check if we can create a simple L-shaped path without crossing existing areas
    // Path: horizontal from door to target X, then vertical to target Y

    // Check horizontal segment (if needed)
    if (doorX !== targetX) {
        const minX = Math.min(doorX, targetX);
        const maxX = Math.max(doorX, targetX);
        for (let x = minX; x <= maxX; x++) {
            if (x < 0 || x >= MAP_COLS || doorY < 0 || doorY >= MAP_ROWS) {
                return false;
            }
            const tile = map[doorY][x];
            // Only allow walls or the destination room area
            if (tile !== TILE_WALL &&
                !(x >= roomX && x < roomX + width && doorY >= roomY && doorY < roomY + height)) {
                return false;
            }
        }
    }

    // Check vertical segment (if needed)
    if (doorY !== targetY) {
        const minY = Math.min(doorY, targetY);
        const maxY = Math.max(doorY, targetY);
        for (let y = minY; y <= maxY; y++) {
            if (targetX < 0 || targetX >= MAP_COLS || y < 0 || y >= MAP_ROWS) {
                return false;
            }
            const tile = map[y][targetX];
            // Only allow walls or the destination room area
            if (tile !== TILE_WALL &&
                !(targetX >= roomX && targetX < roomX + width && y >= roomY && y < roomY + height)) {
                return false;
            }
        }
    }

    return true;
}

/**
 * Creates a path from the secret door to the secret room
 * Uses the same logic as canCreateDirectPath to ensure consistent connectivity
 *
 * @param {Array} map - 2D map array
 * @param {number} doorX - Secret door X coordinate
 * @param {number} doorY - Secret door Y coordinate
 * @param {number} roomX - Secret room top-left X coordinate
 * @param {number} roomY - Secret room top-left Y coordinate
 * @param {number} width - Secret room width
 * @param {number} height - Secret room height
 */
function createPathToSecretRoom(map, doorX, doorY, roomX, roomY, width, height) {
    // Find the same target point that was validated in canCreateDirectPath
    let targetX, targetY;

    // Determine which edge of the room is closest to the door
    if (doorX < roomX) {
        // Door is to the left of room
        targetX = roomX;
        targetY = Math.max(roomY, Math.min(roomY + height - 1, doorY));
    } else if (doorX >= roomX + width) {
        // Door is to the right of room
        targetX = roomX + width - 1;
        targetY = Math.max(roomY, Math.min(roomY + height - 1, doorY));
    } else {
        // Door is above or below room
        targetX = doorX;
        if (doorY < roomY) {
            targetY = roomY;
        } else {
            targetY = roomY + height - 1;
        }
    }

    console.log(`Creating path from door (${doorX}, ${doorY}) to secret room edge (${targetX}, ${targetY})`);

    // Create L-shaped corridor from door to room edge
    // First, clear horizontal path (if needed)
    if (doorX !== targetX) {
        const startX = Math.min(doorX, targetX);
        const endX = Math.max(doorX, targetX);

        for (let x = startX; x <= endX; x++) {
            if (x >= 0 && x < MAP_COLS && doorY >= 0 && doorY < MAP_ROWS) {
                if (map[doorY][x] === TILE_WALL) {
                    map[doorY][x] = TILE_EMPTY;
                    console.log(`  Cleared wall at (${x}, ${doorY})`);
                }
            }
        }
    }

    // Then, clear vertical path (if needed)
    if (doorY !== targetY) {
        const startY = Math.min(doorY, targetY);
        const endY = Math.max(doorY, targetY);

        for (let y = startY; y <= endY; y++) {
            if (targetX >= 0 && targetX < MAP_COLS && y >= 0 && y < MAP_ROWS) {
                if (map[y][targetX] === TILE_WALL) {
                    map[y][targetX] = TILE_EMPTY;
                    console.log(`  Cleared wall at (${targetX}, ${y})`);
                }
            }
        }
    }

    console.log(`Path creation completed from door (${doorX}, ${doorY}) to secret room (${roomX}, ${roomY})`);
}


/**
 * Places the level exit in an appropriate location
 *
 * @param {Array} map - 2D map array
 * @param {Array} rooms - Array of room objects
 * @param {Object} playerStartRoom - Room where player starts
 */
function placeExit(map, rooms, playerStartRoom) {
    // Try to place exit in a room far from player start
    let bestRoom = null;
    let bestDistance = 0;

    for (const room of rooms) {
        if (room === playerStartRoom) continue;

        const distance = playerStartRoom ? 
            Math.hypot(room.center.x - playerStartRoom.center.x, room.center.y - playerStartRoom.center.y) : 
            Math.random();

        if (distance > bestDistance) {
            bestDistance = distance;
            bestRoom = room;
        }
    }

    // Place exit in the chosen room
    if (bestRoom) {
        placeItemInRandomEmptyTile(bestRoom, TILE_EXIT, map);
        return bestRoom;
    } else if (rooms.length > 0) {
        // Fallback: place in any available room
        const fallbackRoom = rooms[rooms.length - 1];
        placeItemInRandomEmptyTile(fallbackRoom, TILE_EXIT, map);
        return fallbackRoom;
    }

    return null;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Picks an appropriate room for item placement
 * 
 * @param {Array} availableRooms - Available rooms for placement
 * @param {Array} mustBeDifferentFromRooms - Rooms to avoid
 * @returns {Object|null} Selected room or null if none available
 */
function pickRoomForItem(availableRooms, mustBeDifferentFromRooms = []) {
    if (availableRooms.length === 0) return null;

    const playerStartRoomId = mustBeDifferentFromRooms.length > 0 ? mustBeDifferentFromRooms[0].id : -1;

    // Filter out rooms to avoid
    const validRoomsToPickFrom = availableRooms.filter(candidateRoom => {
        return !mustBeDifferentFromRooms.some(avoidRoom => avoidRoom.id === candidateRoom.id);
    });

    if (validRoomsToPickFrom.length === 0) {
        // Fallback: use any available room
        return randomChoice(availableRooms);
    }

    return randomChoice(validRoomsToPickFrom);
}

/**
 * Places an item in a random empty tile within a room
 * 
 * @param {Object} room - Room object to place item in
 * @param {number} itemTileType - Type of item tile to place
 * @param {Array} currentMap - Current map array
 * @param {Object|null} [avoidCell] - A cell `{ r, c }` to leave alone
 * @returns {boolean} True if item was successfully placed
 */
function placeItemInRandomEmptyTile(room, itemTileType, currentMap, avoidCell = null) {
    if (!room) return false;

    const emptyTiles = [];
    
    // Find all empty tiles in the room
    for (let r = room.y; r < room.y + room.height; r++) {
        for (let c = room.x; c < room.x + room.width; c++) {
            if (avoidCell && r === avoidCell.r && c === avoidCell.c) continue;
            if (r >= 0 && r < MAP_ROWS && c >= 0 && c < MAP_COLS && 
                currentMap[r][c] === TILE_EMPTY) {
                emptyTiles.push({ r, c });
            }
        }
    }

    // Place item in random empty tile
    if (emptyTiles.length > 0) {
        const randTile = randomChoice(emptyTiles);
        currentMap[randTile.r][randTile.c] = itemTileType;
        return true;
    }

    return false;
}

/**
 * Validates that a generated map has proper connectivity
 * 
 * @param {Array} map - 2D map array to validate
 * @param {Object} playerStart - Player starting position
 * @returns {boolean} True if map is valid and connected
 */
export function validateMapConnectivity(map, playerStart) {
    if (!map || !playerStart) return false;

    // Use flood fill to check connectivity
    const visited = Array(MAP_ROWS).fill(null).map(() => Array(MAP_COLS).fill(false));
    const stack = [{ x: playerStart.c, y: playerStart.r }];
    let reachableTiles = 0;
    let totalEmptyTiles = 0;

    // Count every non-wall tile. The flood fill below walks all non-wall tiles
    // (items, doors and the exit included), so counting only TILE_EMPTY here made
    // the numerator larger than the denominator -- the ratio sailed past 1.0 and the
    // 0.8 threshold could never fail, no matter how broken the map was.
    for (let y = 0; y < MAP_ROWS; y++) {
        for (let x = 0; x < MAP_COLS; x++) {
            if (map[y][x] !== TILE_WALL && map[y][x] !== TILE_SLIDE &&
                map[y][x] !== TILE_SWITCH && map[y][x] !== TILE_WINDOW) {
                totalEmptyTiles++;
            }
        }
    }

    // Flood fill from player start
    while (stack.length > 0) {
        const current = stack.pop();
        const { x, y } = current;

        if (x < 0 || x >= MAP_COLS || y < 0 || y >= MAP_ROWS || visited[y][x]) {
            continue;
        }

        if (map[y][x] === TILE_WALL || map[y][x] === TILE_SLIDE ||
            map[y][x] === TILE_SWITCH || map[y][x] === TILE_WINDOW) {
            continue;
        }

        visited[y][x] = true;
        reachableTiles++;

        // Add neighbors to stack
        stack.push({ x: x + 1, y: y });
        stack.push({ x: x - 1, y: y });
        stack.push({ x: x, y: y + 1 });
        stack.push({ x: x, y: y - 1 });
    }

    // Map is valid if most empty tiles are reachable
    const connectivity = reachableTiles / Math.max(totalEmptyTiles, 1);
    return connectivity > 0.8; // At least 80% of empty tiles should be reachable
}

/**
 * Creates a simple fallback map when generation fails
 * 
 * @param {number} cols - Number of map columns
 * @param {number} rows - Number of map rows
 * @returns {Object} Fallback map data
 */
export function createFallbackMap(cols, rows) {
    console.warn("Creating fallback map due to generation failure");
    
    const map = Array(rows).fill(null).map(() => Array(cols).fill(TILE_WALL));
    
    // Create a simple cross-shaped level
    const centerX = Math.floor(cols / 2);
    const centerY = Math.floor(rows / 2);
    // Must be an integer: fractional indices would write to phantom array keys
    // instead of map cells, leaving the fallback map unwalkable.
    const armLength = Math.floor(Math.min(cols, rows) / 4);

    // Horizontal arm
    for (let x = centerX - armLength; x <= centerX + armLength; x++) {
        if (x >= 0 && x < cols) {
            map[centerY][x] = TILE_EMPTY;
        }
    }

    // Vertical arm
    for (let y = centerY - armLength; y <= centerY + armLength; y++) {
        if (y >= 0 && y < rows) {
            map[y][centerX] = TILE_EMPTY;
        }
    }

    // Place exit at end of horizontal arm
    if (centerX + armLength < cols) {
        map[centerY][centerX + armLength] = TILE_EXIT;
    }

    return {
        gameMap: map,
        playerStart: { r: centerY, c: centerX },
        bossSpawn: null,
        rooms: [{
            x: centerX - 2, y: centerY - 2, width: 5, height: 5,
            center: { x: centerX, y: centerY }, id: 0, connected: true
        }]
    };
}

/**
 * Places colored doors guarding key rooms to create progression
 *
 * @param {Array} map - 2D map array
 * @param {Array} rooms - Array of room objects
 * @param {Object} redKeyRoom - Room containing red key
 * @param {Object} yellowKeyRoom - Room containing yellow key
 * @param {Object} blueKeyRoom - Room containing blue key
 * @param {Object} exitRoom - Room containing exit
 * @param {Object} playerStartRoom - Room the player starts in (for solvability checks)
 */
function placeColoredDoors(map, rooms, redKeyRoom, yellowKeyRoom, blueKeyRoom, exitRoom, playerStartRoom) {
    console.log("Placing colored doors for key progression");

    // Helper function to place door guarding a specific room
    function placeDoorGuardingRoom(targetRoom, doorType) {
        if (!targetRoom || !targetRoom.center) {
            console.log(`No target room for ${doorType === TILE_DOOR_RED ? 'red' : doorType === TILE_DOOR_YELLOW ? 'yellow' : 'blue'} door`);
            return false;
        }

        const { x: roomX, y: roomY, width: roomW, height: roomH } = targetRoom;
        const potentialDoorLocations = [];

        console.log(`Checking door locations for room at ${roomX},${roomY} (${roomW}x${roomH})`);

        // Check corridor tiles adjacent to room for door placement
        for (let r = roomY - 2; r <= roomY + roomH + 1; r++) {
            for (let c = roomX - 2; c <= roomX + roomW + 1; c++) {
                if (r < 0 || r >= MAP_ROWS || c < 0 || c >= MAP_COLS) continue;

                // Check if this is an empty corridor tile that leads to the room
                if (map[r][c] === TILE_EMPTY) {
                    // Check if this corridor tile is a valid door location (corridor end leading to room)
                    if (isValidCorridorDoorLocation(map, c, r, targetRoom)) {
                        potentialDoorLocations.push({ x: c, y: r });
                        console.log(`Found valid door location at ${c},${r}`);
                    }
                }
            }
        }

        console.log(`Found ${potentialDoorLocations.length} potential door locations`);

        // If no corridor-end locations found, fall back to any corridor tile adjacent to room
        if (potentialDoorLocations.length === 0) {
            console.log("No corridor-end locations found, trying fallback approach");

            for (let r = roomY - 2; r <= roomY + roomH + 1; r++) {
                for (let c = roomX - 2; c <= roomX + roomW + 1; c++) {
                    if (r < 0 || r >= MAP_ROWS || c < 0 || c >= MAP_COLS) continue;

                    if (map[r][c] === TILE_EMPTY) {
                        // Simple fallback: any corridor tile adjacent to room
                        if (isSimpleCorridorEntrance(map, c, r, targetRoom)) {
                            potentialDoorLocations.push({ x: c, y: r });
                        }
                    }
                }
            }
            console.log(`Fallback found ${potentialDoorLocations.length} potential door locations`);
        }

        // Try candidate locations until one leaves the level solvable.
        //
        // Corridors form a minimum spanning tree, so a door usually sits on the ONLY
        // route to a region. Dropping one on a random adjacent corridor tile with no
        // further checking could seal the red key behind the red door -- an
        // unwinnable level. Every placement is now committed only if a full
        // key-progression simulation can still reach the exit.
        shuffleArray(potentialDoorLocations);

        for (const doorLocation of potentialDoorLocations) {
            const previousTile = map[doorLocation.y][doorLocation.x];
            map[doorLocation.y][doorLocation.x] = doorType;

            if (isLevelSolvable(map, playerStartRoom)) {
                console.log(`Placed ${doorName(doorType)} door at ${doorLocation.x},${doorLocation.y}`);
                return true;
            }

            // This spot would soft-lock the level; put it back and try another
            map[doorLocation.y][doorLocation.x] = previousTile;
        }

        if (potentialDoorLocations.length > 0) {
            console.warn(`Every candidate ${doorName(doorType)} door location would soft-lock the level; leaving it open`);
            return false;
        }

        console.log(`Failed to place ${doorName(doorType)} door`);
        return false;
    }

    // Place doors in progression order
    // RED KEY room should NEVER get a door (must remain accessible)
    if (yellowKeyRoom && yellowKeyRoom !== redKeyRoom) {
        placeDoorGuardingRoom(yellowKeyRoom, TILE_DOOR_RED);
    } else {
        console.log("Warning: Yellow key room is same as red key room, skipping red door");
    }

    if (blueKeyRoom && blueKeyRoom !== redKeyRoom && blueKeyRoom !== yellowKeyRoom) {
        placeDoorGuardingRoom(blueKeyRoom, TILE_DOOR_YELLOW);
    } else {
        console.log("Warning: Blue key room conflicts with other key rooms, skipping yellow door");
    }

    if (exitRoom && exitRoom !== redKeyRoom && exitRoom !== yellowKeyRoom && exitRoom !== blueKeyRoom) {
        placeDoorGuardingRoom(exitRoom, TILE_DOOR_BLUE);
    } else {
        console.log("Warning: Exit room conflicts with key rooms, skipping blue door");
    }
}


/**
 * Human-readable name for a colored door tile, for logging.
 *
 * @param {number} doorType - TILE_DOOR_RED / TILE_DOOR_YELLOW / TILE_DOOR_BLUE
 * @returns {string} Colour name
 */
function doorName(doorType) {
    if (doorType === TILE_DOOR_RED) return 'red';
    if (doorType === TILE_DOOR_YELLOW) return 'yellow';
    return 'blue';
}

/**
 * Determines whether a level can actually be completed, by simulating the player's
 * key progression rather than just checking raw geometric connectivity.
 *
 * Repeatedly floods the map from the player's start with the keys collected so far,
 * banking any keys found, until no new key is reachable. The level is solvable if
 * the exit is reachable in the final pass.
 *
 * This is what validateMapConnectivity cannot tell you: that function walks through
 * closed doors as if they were open, so it happily approves a map whose red key is
 * locked behind the red door.
 *
 * @param {Array} map - 2D map array
 * @param {Object} playerStartRoom - Room the player starts in
 * @returns {boolean} True if the exit is reachable through legitimate play
 */
function isLevelSolvable(map, playerStartRoom) {
    if (!playerStartRoom || !playerStartRoom.center) return true; // Nothing to verify against

    const startX = playerStartRoom.center.x;
    const startY = playerStartRoom.center.y;
    if (startY < 0 || startY >= MAP_ROWS || startX < 0 || startX >= MAP_COLS) return true;

    const held = { red: false, yellow: false, blue: false };

    for (let pass = 0; pass < 4; pass++) {
        const visited = new Set();
        const stack = [{ x: startX, y: startY }];
        let reachedExit = false;
        let gainedKey = false;

        while (stack.length > 0) {
            const { x, y } = stack.pop();
            if (x < 0 || x >= MAP_COLS || y < 0 || y >= MAP_ROWS) continue;

            const code = y * MAP_COLS + x;
            if (visited.has(code)) continue;

            const tile = map[y][x];
            if (tile === TILE_WALL || tile === TILE_PROP || tile === TILE_SLIDE ||
                tile === TILE_SWITCH || tile === TILE_WINDOW) continue;
            if (tile === TILE_DOOR_RED && !held.red) continue;
            if (tile === TILE_DOOR_YELLOW && !held.yellow) continue;
            if (tile === TILE_DOOR_BLUE && !held.blue) continue;

            visited.add(code);

            if (tile === TILE_KEY_RED && !held.red) { held.red = true; gainedKey = true; }
            if (tile === TILE_KEY_YELLOW && !held.yellow) { held.yellow = true; gainedKey = true; }
            if (tile === TILE_KEY_BLUE && !held.blue) { held.blue = true; gainedKey = true; }
            if (tile === TILE_EXIT) reachedExit = true;

            stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
        }

        if (reachedExit) return true;
        if (!gainedKey) return false; // Stuck: no new key opened anything up
    }

    return false;
}

/**
 * Checks if a corridor location is valid for door placement (corridor tile leading to room)
 *
 * @param {Array} map - 2D map array
 * @param {number} x - X coordinate of corridor tile
 * @param {number} y - Y coordinate of corridor tile
 * @param {Object} room - Room object that this door should protect
 * @returns {boolean} True if this is a valid door location
 */
function isValidCorridorDoorLocation(map, x, y, room) {
    // Check if this corridor tile is adjacent to the room
    const hasRoomAccess = hasAdjacentRoom(map, x, y, room);
    if (!hasRoomAccess) return false;

    // Check if this is at the end of a corridor (good for door placement)
    return isCorridorEndTile(map, x, y, room);
}

/**
 * Checks if a corridor tile has adjacent room access (and is OUTSIDE the room)
 */
function hasAdjacentRoom(map, x, y, room) {
    // First, make sure this corridor tile is NOT inside the room
    if (x >= room.x && x < room.x + room.width &&
        y >= room.y && y < room.y + room.height) {
        return false; // This tile is inside the room, not a valid door location
    }

    const neighbors = [
        { x: x - 1, y: y },
        { x: x + 1, y: y },
        { x: x, y: y - 1 },
        { x: x, y: y + 1 }
    ];

    // Check if any neighbor is inside the room (room interior, not walls)
    for (const neighbor of neighbors) {
        if (neighbor.x < 0 || neighbor.x >= MAP_COLS || neighbor.y < 0 || neighbor.y >= MAP_ROWS) continue;

        // Check if this neighbor is inside the room interior
        if (neighbor.x >= room.x && neighbor.x < room.x + room.width &&
            neighbor.y >= room.y && neighbor.y < room.y + room.height &&
            map[neighbor.y][neighbor.x] === TILE_EMPTY) {
            return true; // This corridor tile is adjacent to room interior
        }
    }
    return false;
}

/**
 * Checks if a corridor tile is at the end of a corridor
 */
function isCorridorEndTile(map, x, y, room) {
    const directions = [
        { x: 1, y: 0 },   // east
        { x: -1, y: 0 },  // west
        { x: 0, y: 1 },   // south
        { x: 0, y: -1 }   // north
    ];

    let corridorDirections = 0;
    let roomDirections = 0;

    for (const dir of directions) {
        let checkX = x + dir.x;
        let checkY = y + dir.y;

        if (checkX >= 0 && checkX < MAP_COLS && checkY >= 0 && checkY < MAP_ROWS) {
            if (map[checkY][checkX] === TILE_EMPTY) {
                // Check if this empty tile is inside the target room
                if (checkX >= room.x && checkX < room.x + room.width &&
                    checkY >= room.y && checkY < room.y + room.height) {
                    roomDirections++; // This direction leads to the room
                } else {
                    corridorDirections++; // This direction leads to more corridor
                }
            }
        }
    }

    // Good door location: should have exactly 1 room direction and 1 corridor direction
    // This means it's the transition point between corridor and room
    return roomDirections === 1 && corridorDirections === 1;
}

/**
 * Simple fallback check for corridor entrance (less restrictive)
 */
function isSimpleCorridorEntrance(map, x, y, room) {
    return hasAdjacentRoom(map, x, y, room);
}