/**
 * =============================================================================
 * WINDOWS
 * =============================================================================
 *
 * A window in Doom is a two-sided line with a gap between the floor of one
 * sector and the ceiling of the next: you see through it, you shoot through
 * it, and whatever is on the other side shoots back, but nobody crosses. It
 * is one of the cheapest and best things a Doom map does -- it shows you a
 * room before you can reach it, and it lets a fight happen across a wall.
 *
 * The tile is TILE_WINDOW and the three questions a tile gets asked are
 * answered separately (see js/utils.js): solid to bodies, clear to shots,
 * clear to sight and light.
 *
 * Two kinds, told apart by what is behind them rather than by a flag:
 *
 *   interior   open ground on both sides -- a window between two rooms, or
 *              onto a corridor. You watch the room beyond and trade fire
 *              with it.
 *   exterior   rock behind, so there is no room back there and it must be
 *              the outside of the building. Drawn as sky over a horizon and
 *              lit like it: Doom's outdoors is a light level of 255, and an
 *              exterior window is the brightest thing on most of these maps.
 *
 * This module places them and classifies them. Drawing is in js/main.js.
 */

import {
    MAP_COLS, MAP_ROWS, TILE_EMPTY, TILE_WALL, TILE_WINDOW,
} from './constants.js';

// =============================================================================
// TUNING
// =============================================================================

export const WINDOWS = {
    MIN_LEVEL: 1,
    /** Runs of window per level, at most. */
    MAX_RUNS: 4,
    /** At most one run in a room, so no room becomes a greenhouse. */
    MAX_PER_ROOM: 1,
    RUN_MIN: 2,
    RUN_MAX: 3,
    /** A room needs at least this much floor before it gets a window. */
    MIN_ROOM_AREA: 24,
    /** Solid tiles behind a window before it counts as looking outside. */
    OUTSIDE_DEPTH: 3,
    /** Keep clear of doorways and corners by this many tiles. */
    MARGIN: 2,
    /** Chance a run is taken once a legal one is found. */
    PLACE_CHANCE: 0.75,
};

// =============================================================================
// CLASSIFYING
// =============================================================================

function tileAt(map, c, r) {
    return map && map[r] ? map[r][c] : undefined;
}

/** Open ground: anything a body could stand on, so not rock and not a window. */
function isOpenGround(map, c, r) {
    const t = tileAt(map, c, r);
    return t !== undefined && t !== TILE_WALL && t !== TILE_WINDOW;
}

/**
 * Which way a window's opening runs.
 *
 * @param {number[][]} map - The level
 * @param {number} c - Tile column
 * @param {number} r - Tile row
 * @returns {boolean} True when the slot runs east-west (open ground above or below)
 */
export function isWindowHorizontal(map, c, r) {
    return isOpenGround(map, c, r - 1) || isOpenGround(map, c, r + 1);
}

/**
 * Whether a window looks outside rather than into another room.
 *
 * One side fronts a room; if the other is rock for a few tiles there is no
 * room back there, so it is the outside wall of the building.
 *
 * @param {number[][]} map - The level
 * @param {number} c - Tile column
 * @param {number} r - Tile row
 * @returns {boolean} True if it looks out
 */
export function isWindowExterior(map, c, r) {
    const horizontal = isWindowHorizontal(map, c, r);
    const sides = horizontal ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];

    let openSides = 0;
    let blind = null;
    for (const [dc, dr] of sides) {
        if (isOpenGround(map, c + dc, r + dr)) openSides++;
        else blind = [dc, dr];
    }
    // Both sides open is a window between two spaces; neither open is not a
    // window at all. Exactly one means the other side is rock.
    if (openSides !== 1 || !blind) return false;

    for (let i = 1; i <= WINDOWS.OUTSIDE_DEPTH; i++) {
        const t = tileAt(map, c + blind[0] * i, r + blind[1] * i);
        // Running off the map is as outside as it gets.
        if (t === undefined) return true;
        if (t !== TILE_WALL) return false;
    }
    return true;
}

// =============================================================================
// PLANNING
// =============================================================================

function shuffle(list, random) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

/**
 * Candidate wall tiles along one side of a room.
 *
 * A window has to sit in a run of plain wall fronting the room's floor, well
 * clear of the corners and of any doorway -- a window beside a door reads as
 * a mistake, and one in a corner has nowhere to look.
 *
 * @param {number[][]} map - The level
 * @param {Object} room - The room
 * @param {string} side - 'N', 'S', 'W' or 'E'
 * @returns {Array<{c: number, r: number}>} Candidates in order along the wall
 */
function wallCandidates(map, room, side) {
    const x1 = room.x + room.width - 1;
    const y1 = room.y + room.height - 1;
    const out = [];
    const m = WINDOWS.MARGIN;

    const consider = (c, r, fc, fr) => {
        if (tileAt(map, c, r) !== TILE_WALL) return;
        if (tileAt(map, fc, fr) !== TILE_EMPTY) return;
        // Nothing open anywhere along the wall beside it: that would be a
        // doorway, and a window has to be in solid masonry.
        for (let d = -m; d <= m; d++) {
            const nc = side === 'N' || side === 'S' ? c + d : c;
            const nr = side === 'N' || side === 'S' ? r : r + d;
            if (tileAt(map, nc, nr) !== TILE_WALL) return;
        }
        out.push({ c, r });
    };

    if (side === 'N' || side === 'S') {
        const r = side === 'N' ? room.y - 1 : y1 + 1;
        const fr = side === 'N' ? room.y : y1;
        for (let c = room.x + m; c <= x1 - m; c++) consider(c, r, c, fr);
    } else {
        const c = side === 'W' ? room.x - 1 : x1 + 1;
        const fc = side === 'W' ? room.x : x1;
        for (let r = room.y + m; r <= y1 - m; r++) consider(c, r, fc, r);
    }
    return out;
}

/**
 * Cuts windows into the walls of a level's rooms.
 *
 * Stamps TILE_WINDOW into the map and reports what it made. Windows are solid
 * to movement, so this can never change whether a level can be finished --
 * every solver counts a window as wall. What it changes is what you can see
 * and what can shoot you, which is the point.
 *
 * @param {number[][]} map - The finished level
 * @param {Object[]} rooms - Room rectangles
 * @param {Object} [options]
 * @param {number} [options.level]
 * @param {() => number} [options.random]
 * @param {(c: number, r: number) => boolean} [options.isReserved]
 * @param {Uint8Array|number[]|null} [options.tileStyles]
 * @returns {Array<{tiles: Object[], exterior: boolean, room: number}>} The runs cut
 */
export function planWindows(map, rooms, options = {}) {
    const {
        level = 1, random = Math.random, isReserved = () => false, tileStyles = null,
    } = options;
    const runs = [];
    if (!map || !rooms || level < WINDOWS.MIN_LEVEL) return runs;

    const eligible = shuffle(rooms.filter(room =>
        room.width * room.height >= WINDOWS.MIN_ROOM_AREA), random);

    for (const room of eligible) {
        if (runs.length >= WINDOWS.MAX_RUNS) break;
        let placedHere = 0;

        for (const side of shuffle(['N', 'S', 'W', 'E'], random)) {
            if (placedHere >= WINDOWS.MAX_PER_ROOM) break;
            if (runs.length >= WINDOWS.MAX_RUNS) break;

            const candidates = wallCandidates(map, room, side)
                .filter(t => !isReserved(t.c, t.r));
            if (candidates.length < WINDOWS.RUN_MIN) continue;

            // The longest stretch of adjacent candidates, then a run inside it.
            const want = WINDOWS.RUN_MIN +
                Math.floor(random() * (WINDOWS.RUN_MAX - WINDOWS.RUN_MIN + 1));
            const run = longestRun(candidates, want);
            if (!run || run.length < WINDOWS.RUN_MIN) continue;
            if (random() > WINDOWS.PLACE_CHANCE) continue;

            for (const t of run) {
                map[t.r][t.c] = TILE_WINDOW;
                if (tileStyles) {
                    tileStyles[t.r * MAP_COLS + t.c] =
                        tileStyles[room.center.y * MAP_COLS + room.center.x];
                }
            }
            runs.push({
                tiles: run,
                exterior: isWindowExterior(map, run[0].c, run[0].r),
                room: room.id,
            });
            placedHere++;
        }
    }
    return runs;
}

/**
 * The first stretch of adjacent candidates, trimmed to the wanted length and
 * centred in whatever stretch it was found in.
 *
 * @param {Array<{c: number, r: number}>} candidates - In order along a wall
 * @param {number} want - Preferred run length
 * @returns {Array<{c: number, r: number}>|null} The run
 */
function longestRun(candidates, want) {
    let best = [];
    let current = [candidates[0]];
    for (let i = 1; i < candidates.length; i++) {
        const a = candidates[i - 1];
        const b = candidates[i];
        if (Math.abs(a.c - b.c) + Math.abs(a.r - b.r) === 1) {
            current.push(b);
        } else {
            if (current.length > best.length) best = current;
            current = [b];
        }
    }
    if (current.length > best.length) best = current;
    if (best.length < WINDOWS.RUN_MIN) return null;

    const take = Math.min(want, best.length);
    const start = Math.floor((best.length - take) / 2);
    return best.slice(start, start + take);
}
