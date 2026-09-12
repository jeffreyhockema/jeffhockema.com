/**
 * =============================================================================
 * SECTOR LIGHTING -- DOOM'S AMBIENT LIGHT MODEL
 * =============================================================================
 *
 * Doom has no point lights. None. Every sector carries a light level from 0 to
 * 255 that the mapper set by hand, and that is the whole of its lighting: the
 * lamp standing in the corner is a decoration, and the corner is bright because
 * somebody typed a number into the sector, not because the lamp emits anything.
 * The contrast between one sector and the next -- a bright hall opening off a
 * black corridor, a lit alcove at the end of a dim passage -- is the main tool
 * a Doom level has for drawing the eye and setting a mood.
 *
 * This game grew the other way round: a dark world lit by a torch and a handful
 * of real point sources. That is a fine idea and it stays, but it left every
 * room the same shade of black, which is the one thing a Doom level never is.
 * This module adds the missing layer -- the overhead lighting a room is assumed
 * to have -- as a base brightness per tile, plus the light specials that make
 * some of them blink.
 *
 * What ambient light does NOT do here is reveal the map. It is gated on the
 * player's line of sight exactly as the terrain glow is, so a lit room is lit
 * when you can see into it and black until then. Walking up to a doorway and
 * having the room beyond resolve all at once is the Doom moment this buys.
 *
 * Light specials are Doom's sector types:
 *
 *   steady      the great majority
 *   blink       type 2 and 3: mostly on, dropping to the dark level briefly
 *   flicker     type 1 and 17: a broken light, on and off at random
 *   glow        type 8: a smooth swell between dark and full
 *
 * A special's "dark" level is Doom's too: it falls back to the dimmest light
 * around it rather than to black.
 */

import { MAP_COLS, MAP_ROWS, TILE_EMPTY, TILE_WALL } from './constants.js';

// =============================================================================
// TUNING
// =============================================================================

export const SECTORS = {
    /**
     * What Doom's 255 is worth here. The torch is 1.0, so holding the
     * brightest room below this keeps the beam worth having: a bright room
     * reads as a place you can see across, not as daylight.
     */
    MAX_AMBIENT: 0.55,

    /** Doom light levels, and how often each turns up as a room's base. */
    ROOM_LEVELS: [
        { level: 208, weight: 2 },   // bright: a working, powered room
        { level: 192, weight: 4 },
        { level: 160, weight: 6 },   // the ordinary case
        { level: 144, weight: 5 },
        { level: 112, weight: 4 },
        { level: 80, weight: 3 },    // dim: something has failed here
        { level: 48, weight: 2 },    // nearly dark
    ],

    /** Corridors run darker than the rooms they join, as Doom's mostly do. */
    CORRIDOR_LEVELS: [
        { level: 128, weight: 3 },
        { level: 96, weight: 5 },
        { level: 64, weight: 5 },
        { level: 32, weight: 3 },
    ],

    /**
     * A room's kind pushes its light level up or down the table: a laboratory
     * is lit and working, a crypt is not.
     */
    KIND_BIAS: {
        lab: +2, hall: +1, forge: +1, cargo: 0, storage: 0, barracks: 0,
        plain: 0, plant: -1, cistern: -1, crypt: -2,
    },

    /** Chance a room gets a light special rather than a steady level. */
    SPECIAL_CHANCE: 0.22,

    /** Relative weights of the specials, once a room has one. */
    SPECIAL_KINDS: [
        { kind: 'blink', weight: 4 },
        { kind: 'flicker', weight: 3 },
        { kind: 'glow', weight: 3 },
    ],

    /** How far a special drops, as a fraction of its own base level. */
    SPECIAL_DARK: 0.28,

    /** Seconds. Doom blinks on a half second and a whole one. */
    BLINK_PERIOD: [0.5, 1.0],
    BLINK_DARK_SHARE: 0.28,      // Fraction of the period spent dark
    FLICKER_MIN: 0.05,           // A broken light holds a state this long, at least
    FLICKER_MAX: 0.5,
    GLOW_PERIOD: 2.4,            // A full swell and back

    /**
     * A wall is drawn a shade under the floor it faces. Doom did the same
     * thing on purpose -- "fake contrast", the trick of shading walls by
     * their orientation so an edge reads without any real lighting behind it.
     */
    WALL_SHARE: 0.85,

    /**
     * Light spills a little past a bright room's doorway rather than stopping
     * dead at the wall, over this many tiles. Doom did this by hand, with a
     * sector of middling brightness in the doorway; here it is a blur over the
     * finished grid, which comes to the same thing and costs nothing to author.
     */
    SPILL_TILES: 2,
};

/** Doom's sky is light level 255; a window onto it lights the floor below. */
const DAYLIGHT_LEVEL = 235;

// =============================================================================
// STATE
// =============================================================================

/** Base level per tile, 0..1. */
let baseLevel = null;

/** Index into `specials` per tile, -1 for a steady tile. */
let specialOf = null;

/** The level's light specials. */
let specials = [];

/** Current multiplier per special, recomputed each frame. */
let specialGain = [];

/**
 * Forgets the current level's lighting and installs a plan.
 *
 * @param {Object|null} plan - From planSectors(), or null for an unlit level
 */
export function registerSectors(plan) {
    if (!plan) {
        resetSectors();
        return;
    }
    baseLevel = plan.baseLevel;
    specialOf = plan.specialOf;
    specials = plan.specials || [];
    specialGain = specials.map(() => 1);
}

/** Clears every sector, leaving the level dark. */
export function resetSectors() {
    baseLevel = null;
    specialOf = null;
    specials = [];
    specialGain = [];
}

/** @returns {boolean} Whether a level's sector lighting is loaded */
export function hasSectors() {
    return baseLevel !== null;
}

/** @returns {Object[]} The level's light specials */
export function getSpecials() {
    return specials;
}

/**
 * The steady light level of a tile, before any special is applied.
 *
 * @param {number} c - Tile column
 * @param {number} r - Tile row
 * @returns {number} 0..1
 */
export function baseLightAt(c, r) {
    if (!baseLevel || c < 0 || c >= MAP_COLS || r < 0 || r >= MAP_ROWS) return 0;
    return baseLevel[r * MAP_COLS + c];
}

/**
 * A tile's ambient light right now, its light special included.
 *
 * @param {number} c - Tile column
 * @param {number} r - Tile row
 * @returns {number} 0..1
 */
export function ambientAt(c, r) {
    if (!baseLevel || c < 0 || c >= MAP_COLS || r < 0 || r >= MAP_ROWS) return 0;
    const i = r * MAP_COLS + c;
    const special = specialOf[i];
    return special < 0 ? baseLevel[i] : baseLevel[i] * specialGain[special];
}

/**
 * What to draw a tile at: its own ambient if it is open, and for a wall the
 * brightest floor it faces, dimmed a little.
 *
 * A Doom wall has no light level of its own -- it is lit by the sector in
 * front of it -- so a wall bounding a bright hall is bright on the hall side
 * and black on the other, which is most of what makes a room read as a room.
 *
 * @param {number[][]} map - The level
 * @param {number} c - Tile column
 * @param {number} r - Tile row
 * @returns {number} 0..1
 */
export function ambientForTile(map, c, r) {
    if (!baseLevel) return 0;
    const row = map && map[r];
    if (row === undefined) return 0;

    if (row[c] !== TILE_WALL) {
        const own = ambientAt(c, r);
        if (own > 0) return own;
        // Floor the plan never saw: a monster closet is solid rock until it
        // opens, so its pocket has no level of its own. Borrow from the room
        // it just opened onto rather than leaving a black hole in the floor.
        return neighbourAmbient(map, c, r) * SECTORS.WALL_SHARE;
    }

    return neighbourAmbient(map, c, r) * SECTORS.WALL_SHARE;
}

/**
 * The brightest ambient among a tile's four orthogonal open neighbours.
 *
 * @param {number[][]} map - The level
 * @param {number} c - Tile column
 * @param {number} r - Tile row
 * @returns {number} 0..1
 */
function neighbourAmbient(map, c, r) {
    let best = 0;
    if (map[r] && map[r][c - 1] !== undefined && map[r][c - 1] !== TILE_WALL) best = Math.max(best, ambientAt(c - 1, r));
    if (map[r] && map[r][c + 1] !== undefined && map[r][c + 1] !== TILE_WALL) best = Math.max(best, ambientAt(c + 1, r));
    if (map[r - 1] && map[r - 1][c] !== undefined && map[r - 1][c] !== TILE_WALL) best = Math.max(best, ambientAt(c, r - 1));
    if (map[r + 1] && map[r + 1][c] !== undefined && map[r + 1][c] !== TILE_WALL) best = Math.max(best, ambientAt(c, r + 1));
    return best;
}

/**
 * Advances the light specials. Cheap: a handful of sines and comparisons,
 * whatever the size of the map.
 *
 * @param {number} nowMs - Wall clock in milliseconds
 */
export function updateSectors(nowMs) {
    const t = nowMs / 1000;
    for (let i = 0; i < specials.length; i++) {
        const s = specials[i];
        specialGain[i] = gainFor(s, t);
    }
}

/**
 * One special's current multiplier on its base level.
 *
 * @param {Object} s - A special descriptor
 * @param {number} t - Seconds
 * @returns {number} Multiplier, between the special's dark share and 1
 */
function gainFor(s, t) {
    const dark = s.dark;
    switch (s.kind) {
        case 'blink': {
            // Mostly on, dropping out briefly -- Doom's sector types 2 and 3.
            const phase = ((t + s.phase) % s.period) / s.period;
            return phase < SECTORS.BLINK_DARK_SHARE ? dark : 1;
        }
        case 'flicker': {
            // A broken light. Each state holds for a random slice, so it never
            // falls into a rhythm; the slice is derived from the clock rather
            // than stored, so it needs no per-frame bookkeeping.
            const step = Math.floor((t + s.phase) / SECTORS.FLICKER_MIN);
            const noise = hash(step ^ s.seed);
            const hold = SECTORS.FLICKER_MIN +
                (SECTORS.FLICKER_MAX - SECTORS.FLICKER_MIN) * hash(step * 7 + s.seed);
            const within = ((t + s.phase) % hold) / hold;
            return (noise > 0.45 || within > 0.7) ? 1 : dark;
        }
        case 'glow': {
            // Doom's type 8: a smooth swell rather than a switch.
            const phase = ((t + s.phase) % s.period) / s.period;
            const wave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
            return dark + (1 - dark) * wave;
        }
        default:
            return 1;
    }
}

/** A cheap deterministic hash in 0..1, for the flicker's pattern. */
function hash(n) {
    let x = Math.imul(n | 0, 0x27d4eb2d);
    x = (x ^ (x >>> 15)) >>> 0;
    return x / 4294967296;
}

// =============================================================================
// PLANNING
// =============================================================================

function pickWeighted(table, random, shift = 0) {
    // `shift` slides the choice up or down the table, which is how a room's
    // kind biases it bright or dark without needing a table of its own.
    const total = table.reduce((sum, row) => sum + row.weight, 0);
    let roll = random() * total;
    let index = table.length - 1;
    for (let i = 0; i < table.length; i++) {
        roll -= table[i].weight;
        if (roll < 0) { index = i; break; }
    }
    // The table runs bright to dark, so a positive bias moves toward zero.
    const biased = Math.max(0, Math.min(table.length - 1, index - shift));
    return table[biased].level;
}

/**
 * Assigns every walkable tile a base light level, and gives some rooms a
 * light special.
 *
 * Rooms are sectors: every tile of a room shares one level, as a Doom sector
 * does, so the light is flat across a room and steps at its threshold. What is
 * left over -- corridors and anything the rooms do not cover -- is filled from
 * the corridor table, darker, and then the whole grid is spilled a couple of
 * tiles so brightness bleeds through a doorway instead of stopping dead at it.
 *
 * @param {number[][]} map - The finished level
 * @param {Object[]} rooms - Room rectangles
 * @param {Object} [options]
 * @param {Object<number, string>} [options.roomKinds] - Room id -> kind, for the bias
 * @param {Object[]} [options.windows] - Window runs, so daylight lights its room
 * @param {() => number} [options.random] - Injectable RNG
 * @returns {{baseLevel: Float32Array, specialOf: Int8Array, specials: Object[]}}
 */
export function planSectors(map, rooms, options = {}) {
    const { roomKinds = {}, windows = [], random = Math.random } = options;
    const size = MAP_COLS * MAP_ROWS;
    const raw = new Float32Array(size);          // Doom levels, 0-255
    const specialOf = new Int8Array(size).fill(-1);
    const plan = { baseLevel: new Float32Array(size), specialOf, specials: [] };

    if (!map || !map.length) return plan;

    // Corridors and everything else first, so rooms paint over them.
    const fill = pickWeighted(SECTORS.CORRIDOR_LEVELS, random);
    for (let r = 0; r < MAP_ROWS; r++) {
        for (let c = 0; c < MAP_COLS; c++) {
            if (!map[r] || map[r][c] === undefined || map[r][c] === TILE_WALL) continue;
            raw[r * MAP_COLS + c] = fill;
        }
    }

    // Each room is one sector, at one level.
    for (const room of rooms || []) {
        const bias = SECTORS.KIND_BIAS[roomKinds[room.id]] || 0;
        const level = pickWeighted(SECTORS.ROOM_LEVELS, random, bias);

        let special = -1;
        if (random() < SECTORS.SPECIAL_CHANCE) {
            const kind = pickWeighted(
                SECTORS.SPECIAL_KINDS.map(s => ({ level: s.kind, weight: s.weight })), random);
            const period = kind === 'glow'
                ? SECTORS.GLOW_PERIOD
                : SECTORS.BLINK_PERIOD[Math.floor(random() * SECTORS.BLINK_PERIOD.length)];
            special = plan.specials.length;
            plan.specials.push({
                kind,
                period,
                dark: SECTORS.SPECIAL_DARK,
                phase: random() * period,
                seed: Math.floor(random() * 0x7fffffff),
                room: room.id,
            });
        }

        for (let r = room.y; r < room.y + room.height; r++) {
            for (let c = room.x; c < room.x + room.width; c++) {
                if (r < 0 || r >= MAP_ROWS || c < 0 || c >= MAP_COLS) continue;
                if (!map[r] || map[r][c] === TILE_WALL) continue;
                const i = r * MAP_COLS + c;
                raw[i] = level;
                specialOf[i] = special;
            }
        }
    }

    // Daylight. A window onto the outside is the brightest thing on a Doom
    // map -- its sky is light level 255 -- so it lights the floor in front of
    // it, and the spill below carries that a couple of tiles into the room.
    for (const run of windows) {
        if (!run.exterior) continue;
        for (const t of run.tiles) {
            for (const [dc, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
                const c = t.c + dc;
                const r = t.r + dr;
                if (c < 0 || c >= MAP_COLS || r < 0 || r >= MAP_ROWS) continue;
                if (!map[r] || map[r][c] === TILE_WALL) continue;
                const i = r * MAP_COLS + c;
                raw[i] = Math.max(raw[i], DAYLIGHT_LEVEL);
            }
        }
    }

    spill(raw, map);

    const scale = SECTORS.MAX_AMBIENT / 255;
    for (let i = 0; i < size; i++) plan.baseLevel[i] = raw[i] * scale;
    return plan;
}

/**
 * Bleeds brightness a couple of tiles through openings.
 *
 * A Doom mapper puts a sector of middling light in a doorway so a bright hall
 * does not end at a hard line. This does the same thing to the finished grid:
 * each pass lifts a tile toward the brightest of its open neighbours, so light
 * reaches through a door and dies out along the corridor beyond. Walls are
 * skipped -- they take their brightness from the floor they face, at draw time.
 *
 * @param {Float32Array} raw - Levels in place
 * @param {number[][]} map - The level, for which tiles are open
 */
function spill(raw, map) {
    const open = (c, r) => map[r] && map[r][c] !== undefined && map[r][c] !== TILE_WALL;
    for (let pass = 0; pass < SECTORS.SPILL_TILES; pass++) {
        const before = raw.slice();
        for (let r = 0; r < MAP_ROWS; r++) {
            for (let c = 0; c < MAP_COLS; c++) {
                if (!open(c, r)) continue;
                let best = 0;
                if (open(c - 1, r)) best = Math.max(best, before[r * MAP_COLS + c - 1]);
                if (open(c + 1, r)) best = Math.max(best, before[r * MAP_COLS + c + 1]);
                if (open(c, r - 1)) best = Math.max(best, before[(r - 1) * MAP_COLS + c]);
                if (open(c, r + 1)) best = Math.max(best, before[(r + 1) * MAP_COLS + c]);
                const i = r * MAP_COLS + c;
                // Halfway to the brighter neighbour: two passes reach two tiles
                // and fade as they go.
                if (best > before[i]) raw[i] = before[i] + (best - before[i]) * 0.5;
            }
        }
    }
}
