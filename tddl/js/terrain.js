/**
 * TERRAIN AND TILE ADJACENCY
 *
 * Shared vocabulary for the three modules that all need to ask the same questions
 * about a tile and must never disagree about the answers: the renderer (what does
 * this look like), the map generator (may I put a pool here) and the player
 * (what is this doing to me).
 *
 * Two things live here.
 *
 * Terrain
 * -------
 * Thin accessors over the TERRAIN table in constants.js. Every one of them is a
 * lookup rather than a comparison, which is the point: adding a fourth liquid
 * should mean adding a row to that table and nothing else. Code that asks
 * `isDamagingTerrain(t)` keeps working; code that had written `t === TILE_LAVA ||
 * t === TILE_TOXIC` would not.
 *
 * Adjacency
 * ---------
 * `neighbourMask()` is what makes walls and pools read as continuous shapes rather
 * than as grids of squares. It returns which of a tile's eight neighbours are the
 * same kind of thing, packed into a byte, and the renderer decides from that where
 * to put edges and corner pieces. It is deliberately generic over the predicate --
 * the same function serves a wall run, a lava lake and a stretch of water, and all
 * three get their edges drawn by the same code as a result.
 *
 * @author TDDL Game Team
 */

import {
    MAP_COLS, MAP_ROWS,
    TILE_WALL, TILE_DOOR_RED, TILE_DOOR_YELLOW, TILE_DOOR_BLUE, TILE_SECRET_DOOR,
    TERRAIN, TERRAIN_TILES, TILE_SLIDE, TILE_SWITCH, TILE_WINDOW,
} from './constants.js';

// =============================================================================
// NEIGHBOUR MASK BITS
// =============================================================================

/**
 * Bit positions in the byte `neighbourMask()` returns.
 *
 * The four sides come first so that `mask & 0x0F` is "which sides match" on its
 * own -- which is the only part most callers need, and the part that decides
 * whether an edge is drawn at all. Diagonals only matter for telling an outer
 * corner (both sides open) from an inner one (both sides solid, diagonal open).
 */
export const NB = {
    N:  1,
    E:  2,
    S:  4,
    W:  8,
    NE: 16,
    SE: 32,
    SW: 64,
    NW: 128,
};

/** Mask covering just the four orthogonal neighbours. */
export const NB_SIDES = NB.N | NB.E | NB.S | NB.W;

// =============================================================================
// TILE CLASSIFICATION
// =============================================================================

/**
 * Whether a tile is one of the terrain liquids.
 *
 * @param {number} tileType - Tile value
 * @returns {boolean} True for lava, toxic waste or water
 */
export function isTerrainTile(tileType) {
    return Object.prototype.hasOwnProperty.call(TERRAIN, tileType);
}

/**
 * The terrain descriptor for a tile.
 *
 * @param {number} tileType - Tile value
 * @returns {Object|null} Entry from TERRAIN, or null if this is not terrain
 */
export function getTerrain(tileType) {
    return TERRAIN[tileType] || null;
}

/**
 * Whether standing on this tile costs health.
 *
 * Water is terrain but not a hazard, and the distinction matters well beyond
 * damage: the map generator guarantees a route to every objective that never
 * crosses a DAMAGING tile, and happily routes one through water.
 *
 * @param {number} tileType - Tile value
 * @returns {boolean} True if the tile deals damage over time
 */
export function isDamagingTerrain(tileType) {
    const terrain = TERRAIN[tileType];
    return !!terrain && terrain.damagePerSecond > 0;
}

/**
 * Whether a tile lights the room by itself.
 *
 * @param {number} tileType - Tile value
 * @returns {boolean} True if the tile has a glow descriptor
 */
export function isGlowingTerrain(tileType) {
    const terrain = TERRAIN[tileType];
    return !!(terrain && terrain.glow);
}

/**
 * How much this tile multiplies movement speed. 1 for anything that is not
 * terrain, so callers can apply it unconditionally.
 *
 * @param {number} tileType - Tile value
 * @returns {number} Speed multiplier
 */
export function terrainSpeedMultiplier(tileType) {
    const terrain = TERRAIN[tileType];
    return terrain ? terrain.speed : 1;
}

/**
 * Whether a tile is part of the solid built environment -- wall, closed door or
 * undiscovered secret door.
 *
 * This is the predicate the wall renderer autotiles against, which is why doors
 * count: a door set into a wall run should continue that run, not punch a hole in
 * it and leave the masonry either side with raw exposed edges.
 *
 * @param {number} tileType - Tile value
 * @returns {boolean} True for walls, doors and secret doors
 */
export function isWallLike(tileType) {
    return tileType === TILE_WALL ||
           tileType === TILE_WINDOW ||
           tileType === TILE_SLIDE ||
           tileType === TILE_SWITCH ||
           tileType === TILE_DOOR_RED ||
           tileType === TILE_DOOR_YELLOW ||
           tileType === TILE_DOOR_BLUE ||
           tileType === TILE_SECRET_DOOR;
}

/**
 * Whether a tile is masonry proper: a wall or a secret door, but not a real door.
 *
 * Doors share the run but not the surface -- a door gets panels and a keyhole
 * where a wall gets bricks.
 *
 * @param {number} tileType - Tile value
 * @returns {boolean} True for walls and secret doors
 */
export function isMasonry(tileType) {
    return tileType === TILE_WALL || tileType === TILE_SECRET_DOOR;
}

/**
 * Whether a tile is one of the three keyed doors.
 *
 * @param {number} tileType - Tile value
 * @returns {boolean} True for red, yellow or blue doors
 */
export function isKeyedDoor(tileType) {
    return tileType === TILE_DOOR_RED ||
           tileType === TILE_DOOR_YELLOW ||
           tileType === TILE_DOOR_BLUE;
}

// =============================================================================
// ADJACENCY
// =============================================================================

/**
 * Which of a tile's eight neighbours satisfy a predicate, packed into a byte.
 *
 * Tiles outside the map count as matching. Without that the four edges of the
 * world would be drawn as though the level simply stopped -- every border wall
 * would grow a lit outer face along the void, which is the one place there is
 * definitively nothing to light it.
 *
 * @param {Array<Array<number>>} map - 2D tile grid
 * @param {number} c - Tile column
 * @param {number} r - Tile row
 * @param {Function} predicate - Given a tile value, whether it counts as matching
 * @returns {number} Bitwise OR of the NB.* flags for matching neighbours
 */
export function neighbourMask(map, c, r, predicate) {
    let mask = 0;

    // A plain function, not a closure over map and predicate: this runs for every
    // wall tile in every pass, and a closure allocated per call adds up.
    if (neighbourMatches(map, predicate, c,     r - 1)) mask |= NB.N;
    if (neighbourMatches(map, predicate, c + 1, r    )) mask |= NB.E;
    if (neighbourMatches(map, predicate, c,     r + 1)) mask |= NB.S;
    if (neighbourMatches(map, predicate, c - 1, r    )) mask |= NB.W;
    if (neighbourMatches(map, predicate, c + 1, r - 1)) mask |= NB.NE;
    if (neighbourMatches(map, predicate, c + 1, r + 1)) mask |= NB.SE;
    if (neighbourMatches(map, predicate, c - 1, r + 1)) mask |= NB.SW;
    if (neighbourMatches(map, predicate, c - 1, r - 1)) mask |= NB.NW;

    return mask;
}

/**
 * Whether a neighbouring tile satisfies the predicate. Off the map counts as a
 * match, so the world's edge reads as solid.
 *
 * @param {Array} map - 2D tile grid
 * @param {Function} predicate - Tile test
 * @param {number} nc - Neighbour column
 * @param {number} nr - Neighbour row
 * @returns {boolean} True if it matches
 */
function neighbourMatches(map, predicate, nc, nr) {
    if (nc < 0 || nc >= MAP_COLS || nr < 0 || nr >= MAP_ROWS) return true;
    const row = map && map[nr];
    if (!row) return true;
    return !!predicate(row[nc]);
}

/**
 * A stable pseudo-random value for a tile, in 0..1.
 *
 * Per-tile variation -- which brick is chipped, where a bubble sits in a pool --
 * has to be the same every frame or the surface boils. Deriving it from the
 * coordinates rather than storing it means no per-level allocation and no state
 * to reset between levels.
 *
 * @param {number} c - Tile column
 * @param {number} r - Tile row
 * @param {number} [salt] - Distinguishes independent draws for the same tile
 * @returns {number} Value in [0, 1)
 */
export function tileNoise(c, r, salt = 0) {
    // Integer hash (xorshift-flavoured). Cheap, and good enough that neighbouring
    // tiles do not visibly correlate, which a plain `sin(c * 12.9898 + ...)` does.
    let h = (c | 0) * 374761393 + (r | 0) * 668265263 + (salt | 0) * 2147483647;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// =============================================================================
// THEME SELECTION
// =============================================================================

/**
 * Picks a liquid for a room according to a theme's weights.
 *
 * @param {Object} style - Entry from WALL_STYLES
 * @param {Function} [random] - Source of randomness, injectable for tests
 * @returns {number|null} A terrain tile id, or null if the theme has no liquids
 */
export function pickThemeTerrain(style, random = Math.random) {
    const weights = style?.terrain?.weights;
    if (!weights) return null;

    let total = 0;
    for (const tile of TERRAIN_TILES) total += weights[tile] || 0;
    if (total <= 0) return null;

    let roll = random() * total;
    for (const tile of TERRAIN_TILES) {
        roll -= weights[tile] || 0;
        if (roll < 0) return tile;
    }
    return TERRAIN_TILES[TERRAIN_TILES.length - 1];
}
