/**
 * =============================================================================
 * ROOM DECORATION
 * =============================================================================
 *
 * What is standing in a room, and what it is for.
 *
 * A carved room is a rectangle of floor. This gives it a purpose -- a cargo
 * bay stacked with crates, a lab of benches and humming consoles, a crypt of
 * sarcophagi and braziers, a pillared hall -- chosen to suit the zone's look,
 * and furnishes it with three kinds of thing:
 *
 *   solid props   Crates, vats, pillars, machines. These are TILE_PROP tiles
 *                 in the map with a decoration id that says which. A prop is
 *                 solid to movement and to shots -- you take cover behind a
 *                 crate -- but not to light or to sight: it is a thing
 *                 standing in the room, lit as the floor around it is, and
 *                 the wall behind it is lit as usual. Monsters see over it.
 *
 *   floor detail  Grates, hazard stripes, cables, puddles, rubble, bones.
 *                 Drawn over the floor tile; nothing about them affects play.
 *
 *   lights        Some props glow: a ceiling lamp, a console's screen, a vat
 *                 of something green, a furnace. Each contributes a real
 *                 light source to the lighting module, gated by sight like
 *                 the terrain glow, so a lit lab is lit by its own screens.
 *
 * Every solid prop is placed under a rule that nothing the level could reach
 * before is unreachable after: the planner floods the map from the player's
 * start before it begins and again after each group of props, and reverts
 * any group that cuts something off. Doorways and item tiles get a margin on
 * top of that, so nothing is ever boxed in or blocked at the threshold.
 *
 * Leaf module: constants and terrain only.
 */

import {
    TILE_SIZE, MAP_COLS, MAP_ROWS, TILE_EMPTY, TILE_WALL, TILE_PROP, TILE_SECRET_DOOR, WALL_STYLES, TILE_SLIDE, TILE_SWITCH, TILE_WINDOW,
} from './constants.js';
import { isTerrainTile, isDamagingTerrain } from './terrain.js';

// =============================================================================
// DECORATION IDS
// =============================================================================

/**
 * Ids stored per tile in the decoration map. Below SOLID_FROM they are floor
 * detail on a floor tile; from it up they are props on a wall tile.
 */
export const DECOR = {
    NONE: 0,
    // Floor detail
    GRATE: 1, STRIPES: 2, CABLE: 3, PUDDLE: 4, RUBBLE: 5, BONES: 6, VENT: 7,
    DRAIN: 8, MOSS: 9, SLAG: 10, PLATE: 11, MOSAIC: 12, LAMP: 13,
    // Solid props
    CRATE: 20, CRATES: 21, BARREL: 22, VAT: 23, CONSOLE: 24, BENCH: 25, PILLAR: 26,
    SARCOPHAGUS: 27, FURNACE: 28, MACHINE: 29, LOCKER: 30, RACK: 31, BRAZIER: 32, TANK: 33,
};

export const SOLID_FROM = 20;

/** @param {number} id @returns {boolean} True for a prop that is a wall tile */
export function isSolidDecor(id) {
    return id >= SOLID_FROM;
}

/**
 * What each decoration that glows contributes to the lighting.
 * Ranges in pixels, colours as `r,g,b`.
 */
export const DECOR_LIGHTS = {
    [DECOR.LAMP]:    { color: '255,236,190', range: TILE_SIZE * 3.6, intensity: 0.7,  flicker: 0.0,  flickerHz: 0 },
    [DECOR.VAT]:     { color: '120,255,110', range: TILE_SIZE * 2.6, intensity: 0.5,  flicker: 0.08, flickerHz: 0.8 },
    [DECOR.CONSOLE]: { color: '110,200,255', range: TILE_SIZE * 2.2, intensity: 0.45, flicker: 0.12, flickerHz: 3.1 },
    [DECOR.FURNACE]: { color: '255,140,50',  range: TILE_SIZE * 3.6, intensity: 0.8,  flicker: 0.18, flickerHz: 2.4 },
    [DECOR.MACHINE]: { color: '255,70,60',   range: TILE_SIZE * 2.0, intensity: 0.4,  flicker: 0.6,  flickerHz: 0.7 },
    [DECOR.BRAZIER]: { color: '255,170,70',  range: TILE_SIZE * 3.2, intensity: 0.7,  flicker: 0.2,  flickerHz: 2.9 },
};

// =============================================================================
// ROOM KINDS
// =============================================================================

/**
 * The purposes a room can have, per look. Weights are relative within a look;
 * `plain` is a room left mostly empty, which every level needs some of.
 */
export const ROOM_KINDS_BY_STYLE = {
    'Industrial Metal': { cargo: 4, plant: 3, barracks: 2, storage: 2, plain: 2 },
    'Ancient Stone':    { crypt: 4, hall: 4, plain: 2 },
    'Volcanic Foundry': { forge: 4, hall: 2, storage: 1, plain: 2 },
    'Toxic Refinery':   { lab: 5, plant: 3, storage: 1, plain: 2 },
    'Flooded Cistern':  { cistern: 5, storage: 2, plain: 2 },
};

export const DECOR_CONFIG = {
    MIN_ROOM_AREA: 24,               // Smaller rooms stay bare
    DOORWAY_MARGIN: 1,               // Tiles kept clear around an entrance
    ITEM_MARGIN: 1,                  // Tiles kept clear around a key, weapon, exit
    MAX_SOLID_FRACTION: 0.28,        // Of a room's floor
    LIGHT_CULL: TILE_SIZE * 18,      // Decor lights further than this are not cast
    LIGHT_MAX: 6,                    // Decor lights burning at once
};

function shuffle(list, random) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

function pickWeighted(weights, random) {
    const entries = Object.entries(weights);
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let roll = random() * total;
    for (const [key, w] of entries) {
        roll -= w;
        if (roll < 0) return key;
    }
    return entries[entries.length - 1][0];
}

// =============================================================================
// PLANNING
// =============================================================================

/**
 * Decorates every room of a level.
 *
 * @param {number[][]} map - The level; solid props are written into it as walls
 * @param {Object[]} rooms - Room rectangles
 * @param {Object} options
 * @param {{c: number, r: number}} options.playerStart - For the reachability rule
 * @param {(room: Object) => Object} [options.styleForRoom] - The look a room wears
 * @param {() => number} [options.random] - Injectable RNG
 * @param {Object|null} [options.playerStartRoom] - Kept plain
 * @returns {{decor: Uint8Array, lights: Object[], kinds: Object<number, string>}}
 */
export function decorateRooms(map, rooms, options) {
    const {
        playerStart,
        styleForRoom = () => WALL_STYLES[0],
        random = Math.random,
        playerStartRoom = null,
    } = options;

    const decor = new Uint8Array(MAP_COLS * MAP_ROWS);
    const lights = [];
    const kinds = {};
    if (!map || !rooms || !playerStart) return { decor, lights, kinds };

    // Two baselines: everything walkable, and everything walkable without
    // touching anything that burns. A prop that leaves the level connected
    // but turns the only dry way past a pool into a wade through lava has
    // cut something off just the same.
    const ctx = {
        map, decor, random, playerStart,
        baseline: reachableFloor(map, playerStart, () => true).size,
        safeBaseline: reachableFloor(map, playerStart, (t) => !isDamagingTerrain(t)).size,
    };

    for (const room of rooms) {
        if (room.width * room.height < DECOR_CONFIG.MIN_ROOM_AREA) continue;
        const style = styleForRoom(room) || WALL_STYLES[0];
        const weights = ROOM_KINDS_BY_STYLE[style.name] || { plain: 1 };
        const kind = (room === playerStartRoom || room.role === 'start') ? 'plain' : pickWeighted(weights, random);
        kinds[room.id] = kind;

        const recipe = RECIPES[kind] || RECIPES.plain;
        recipe(ctx, room, style);
    }

    // Lights: one per glowing decoration
    for (let r = 0; r < MAP_ROWS; r++) {
        for (let c = 0; c < MAP_COLS; c++) {
            const id = decor[r * MAP_COLS + c];
            const spec = DECOR_LIGHTS[id];
            if (!spec) continue;
            lights.push({
                id, x: c * TILE_SIZE + TILE_SIZE / 2, y: r * TILE_SIZE + TILE_SIZE / 2, ...spec,
            });
        }
    }

    return { decor, lights, kinds };
}

/**
 * Floods the walkable map from the start. Doors of every kind count as
 * passable -- the player can open them -- so the set is "everything the
 * level offers", not "everything reachable right now".
 *
 * @returns {Set<number>} Tile codes
 */
function reachableFloor(map, start, allow = () => true) {
    const reached = new Set();
    const stack = [[start.c, start.r]];
    while (stack.length) {
        const [c, r] = stack.pop();
        if (c < 0 || c >= MAP_COLS || r < 0 || r >= MAP_ROWS) continue;
        const code = r * MAP_COLS + c;
        if (reached.has(code)) continue;
        const tile = map[r] && map[r][c];
        if (tile === undefined || tile === TILE_WALL || tile === TILE_PROP || tile === TILE_SLIDE ||
            tile === TILE_SWITCH || tile === TILE_WINDOW || !allow(tile)) continue;
        reached.add(code);
        stack.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]);
    }
    return reached;
}

// ---------------------------------------------------------------- room helpers

/** The tiles of a room's floor that are plain, empty floor. */
function isFloor(ctx, c, r) {
    return ctx.map[r] && ctx.map[r][c] === TILE_EMPTY;
}

function isItem(map, c, r) {
    const t = map[r] && map[r][c];
    return t >= 6 && t <= 15;
}

/** Floor detail that is part of a room's plan, which props keep off. */
const STRUCTURAL_FLOOR = new Set([DECOR.GRATE, DECOR.MOSAIC, DECOR.STRIPES, DECOR.PLATE, DECOR.LAMP, DECOR.DRAIN, DECOR.VENT]);

/** Anything a body can stand on or pass through: floor, terrain, items, doors. */
function isOpen(map, c, r) {
    const t = map[r] && map[r][c];
    return t !== undefined && t !== TILE_WALL && t !== TILE_SECRET_DOOR && t !== TILE_PROP;
}

/**
 * Tiles of the room that must stay clear of solids: within a margin of any
 * entrance (a room-edge tile whose outward neighbour is open), of any item,
 * and of any terrain (a pool's bank is walked).
 */
function buildKeepClear(ctx, room) {
    const keep = new Set();
    const mark = (c, r, margin) => {
        for (let dr = -margin; dr <= margin; dr++) {
            for (let dc = -margin; dc <= margin; dc++) keep.add((r + dr) * MAP_COLS + (c + dc));
        }
    };
    const map = ctx.map;
    const x1 = room.x + room.width - 1;
    const y1 = room.y + room.height - 1;

    for (let r = room.y; r <= y1; r++) {
        for (let c = room.x; c <= x1; c++) {
            if (isItem(map, c, r)) mark(c, r, DECOR_CONFIG.ITEM_MARGIN);
            if (isTerrainTile(map[r][c])) mark(c, r, 1);

            const onEdge = c === room.x || c === x1 || r === room.y || r === y1;
            if (!onEdge) continue;
            const outward = [];
            if (c === room.x) outward.push([c - 1, r]);
            if (c === x1) outward.push([c + 1, r]);
            if (r === room.y) outward.push([c, r - 1]);
            if (r === y1) outward.push([c, r + 1]);
            for (const [oc, or] of outward) {
                if (isOpen(map, oc, or)) mark(c, r, DECOR_CONFIG.DOORWAY_MARGIN);
            }
        }
    }
    return keep;
}

function keepClear(ctx, room) {
    if (!ctx.keep) ctx.keep = new Map();
    let keep = ctx.keep.get(room);
    if (!keep) {
        keep = buildKeepClear(ctx, room);
        ctx.keep.set(room, keep);
    }
    return keep;
}

/**
 * Places a group of solid props, or none of it. The group goes in only if
 * every tile is plain floor outside the keep-clear set, the room's solid
 * budget allows it, and the level loses exactly those tiles and nothing more
 * -- counted both over all floor and over floor that does not burn.
 *
 * @returns {boolean} True if placed
 */
function placeSolidGroup(ctx, room, tiles, id) {
    const map = ctx.map;
    if (tiles.length === 0) return false;
    const keep = keepClear(ctx, room);

    for (const [c, r] of tiles) {
        if (c < room.x || c >= room.x + room.width || r < room.y || r >= room.y + room.height) return false;
        if (!isFloor(ctx, c, r)) return false;
        if (keep.has(r * MAP_COLS + c)) return false;
    }

    // Nothing stands on a feature of the floor that was laid out on purpose:
    // an aisle, a drainage channel, a loading stripe, the spot under a lamp.
    for (const [c, r] of tiles) {
        if (STRUCTURAL_FLOOR.has(ctx.decor[r * MAP_COLS + c])) return false;
    }

    const used = (ctx.solidCount && ctx.solidCount.get(room)) || 0;
    if (used + tiles.length > room.width * room.height * DECOR_CONFIG.MAX_SOLID_FRACTION) return false;

    for (const [c, r] of tiles) map[r][c] = TILE_PROP;

    const after = reachableFloor(map, ctx.playerStart, () => true).size;
    const safeAfter = reachableFloor(map, ctx.playerStart, (t) => !isDamagingTerrain(t)).size;
    if (after !== ctx.baseline - tiles.length || safeAfter !== ctx.safeBaseline - tiles.length) {
        for (const [c, r] of tiles) map[r][c] = TILE_EMPTY;
        return false;
    }

    ctx.baseline = after;
    ctx.safeBaseline = safeAfter;
    for (const [c, r] of tiles) ctx.decor[r * MAP_COLS + c] = id;
    if (!ctx.solidCount) ctx.solidCount = new Map();
    ctx.solidCount.set(room, used + tiles.length);
    return true;
}

/**
 * Places a run of solid props whole if it can, else in halves, down to single
 * tiles: a run that would block something loses only the part that would.
 *
 * @returns {number} Tiles placed
 */
function placeRun(ctx, room, tiles, id) {
    if (tiles.length === 0) return 0;
    if (placeSolidGroup(ctx, room, tiles, id)) return tiles.length;
    if (tiles.length === 1) return 0;
    const half = tiles.length >> 1;
    return placeRun(ctx, room, tiles.slice(0, half), id) + placeRun(ctx, room, tiles.slice(half), id);
}

/** Lays floor detail on a tile if it is plain floor with nothing on it yet. */
function placeFloor(ctx, c, r, id) {
    if (!isFloor(ctx, c, r)) return false;
    const code = r * MAP_COLS + c;
    if (ctx.decor[code] !== DECOR.NONE) return false;
    ctx.decor[code] = id;
    return true;
}

// ---------------------------------------------------------------- geometry
//
// A room is furnished the way a room is used. That needs four facts about it:
// where it is entered, which wall is its back (the one nobody comes through),
// which way it is long, and where its corners are. Everything below is laid
// out from those, so a cargo bay's pallets stand against the back wall with
// the loading edge striped in front of them and an aisle running to it from
// the door; a barracks' lockers line the side walls; a lab's benches run in
// parallel rows down the long axis with its console bank on the back wall.

const OPPOSITE_SIDE = { N: 'S', S: 'N', W: 'E', E: 'W' };

/**
 * Where a room is entered, which wall is its back, and which way it is long.
 *
 * @returns {{entrances: Object[], count: Object, back: string, front: string,
 *            quiet: string[], horizontal: boolean, x1: number, y1: number}}
 */
function roomGeometry(ctx, room) {
    if (!ctx.geometry) ctx.geometry = new Map();
    const cached = ctx.geometry.get(room);
    if (cached) return cached;

    const map = ctx.map;
    const x1 = room.x + room.width - 1;
    const y1 = room.y + room.height - 1;
    const entrances = [];
    for (let c = room.x; c <= x1; c++) {
        if (isOpen(map, c, room.y - 1)) entrances.push({ c, r: room.y, side: 'N' });
        if (isOpen(map, c, y1 + 1)) entrances.push({ c, r: y1, side: 'S' });
    }
    for (let r = room.y; r <= y1; r++) {
        if (isOpen(map, room.x - 1, r)) entrances.push({ c: room.x, r, side: 'W' });
        if (isOpen(map, x1 + 1, r)) entrances.push({ c: x1, r, side: 'E' });
    }

    const count = { N: 0, S: 0, W: 0, E: 0 };
    for (const e of entrances) count[e.side]++;
    const sides = ['N', 'S', 'W', 'E'];
    const quiet = sides.filter(s => count[s] === 0);
    const busiest = sides.slice().sort((a, b) => count[b] - count[a])[0];
    // The back is a quiet wall, and the one facing the busiest doorway if
    // there is such a choice: what you see as you come in.
    const back = quiet.includes(OPPOSITE_SIDE[busiest])
        ? OPPOSITE_SIDE[busiest]
        : (quiet.length ? shuffle(quiet.slice(), ctx.random)[0] : OPPOSITE_SIDE[busiest]);

    const geo = {
        entrances, count, back, front: OPPOSITE_SIDE[back], quiet,
        horizontal: room.width >= room.height, x1, y1,
    };
    ctx.geometry.set(room, geo);
    return geo;
}

/** The inside tiles along one wall, in order along it. */
function sideTiles(room, side) {
    const tiles = [];
    const x1 = room.x + room.width - 1;
    const y1 = room.y + room.height - 1;
    if (side === 'N' || side === 'S') {
        const r = side === 'N' ? room.y : y1;
        for (let c = room.x; c <= x1; c++) tiles.push([c, r]);
    } else {
        const c = side === 'W' ? room.x : x1;
        for (let r = room.y; r <= y1; r++) tiles.push([c, r]);
    }
    return tiles;
}

/** A tile stepped `n` tiles into the room from a side. */
function inward(side, [c, r], n = 1) {
    if (side === 'N') return [c, r + n];
    if (side === 'S') return [c, r - n];
    if (side === 'W') return [c + n, r];
    return [c - n, r];
}

/** `count` positions evenly spaced from `from` to `to` inclusive, symmetric. */
function spread(from, to, count) {
    if (count <= 1) return [Math.round((from + to) / 2)];
    const step = (to - from) / (count - 1);
    return Array.from({ length: count }, (_, i) => Math.round(from + i * step));
}

/** The four inside corners, `inset` tiles in from each wall. */
function corners(room, inset = 1) {
    const x1 = room.x + room.width - 1;
    const y1 = room.y + room.height - 1;
    return [
        [room.x + inset, room.y + inset], [x1 - inset, room.y + inset],
        [room.x + inset, y1 - inset], [x1 - inset, y1 - inset],
    ];
}

/** The two back corners: where things get pushed out of the way. */
function backCorners(room, geo, inset = 1) {
    return corners(room, inset).filter(([c, r]) =>
        (geo.back === 'N' && r === room.y + inset) || (geo.back === 'S' && r === geo.y1 - inset) ||
        (geo.back === 'W' && c === room.x + inset) || (geo.back === 'E' && c === geo.x1 - inset));
}

/**
 * Runs of a prop along the inside of a wall, broken only where the room must
 * stay clear (doorways, items, pool banks), leaving `skipEnds` tiles free at
 * the corners for whatever stands there.
 *
 * @returns {number} Tiles placed
 */
function wallRun(ctx, room, side, id, { skipEnds = 1, maxLength = Infinity, step = 1 } = {}) {
    const tiles = sideTiles(room, side);
    const inner = tiles.slice(skipEnds, tiles.length - skipEnds);
    const keep = keepClear(ctx, room);

    const stretches = [];
    let current = [];
    for (const t of inner) {
        const ok = isFloor(ctx, t[0], t[1]) && !keep.has(t[1] * MAP_COLS + t[0]);
        if (ok) current.push(t);
        else if (current.length) { stretches.push(current); current = []; }
    }
    if (current.length) stretches.push(current);

    let placed = 0;
    for (const stretch of stretches) {
        for (let i = 0; i < stretch.length; i += maxLength + step - 1) {
            placed += placeRun(ctx, room, stretch.slice(i, i + maxLength), id);
        }
    }
    return placed;
}

/**
 * Parallel rows of a prop down the room's long axis, an aisle between each
 * pair and around the lot: benches, shelving, sarcophagi.
 *
 * @returns {number} Tiles placed
 */
function rowsAcross(ctx, room, id, { length = 3, aisle = 2, inset = 2, maxRows = 4 } = {}) {
    const geo = roomGeometry(ctx, room);
    const along = geo.horizontal ? room.width : room.height;     // the axis a row runs on
    const across = geo.horizontal ? room.height : room.width;    // the axis rows stack on
    const runLength = Math.min(length, along - inset * 2);
    if (runLength < 1) return 0;

    const rowCount = Math.min(maxRows, Math.max(1, Math.floor((across - inset * 2 + aisle) / (1 + aisle))));
    const lowAcross = (geo.horizontal ? room.y : room.x) + inset;
    const highAcross = (geo.horizontal ? geo.y1 : geo.x1) - inset;
    const lowAlong = (geo.horizontal ? room.x : room.y);
    const start = lowAlong + Math.floor((along - runLength) / 2);

    let placed = 0;
    for (const pos of spread(lowAcross, highAcross, rowCount)) {
        const tiles = [];
        for (let i = 0; i < runLength; i++) {
            tiles.push(geo.horizontal ? [start + i, pos] : [pos, start + i]);
        }
        placed += placeRun(ctx, room, tiles, id);
    }
    return placed;
}

/**
 * Twin rows of a prop down the long axis, one tile in from each side wall,
 * evenly spaced: the columns of a hall, the pillars of an undercroft.
 *
 * @returns {number} Tiles placed
 */
function colonnade(ctx, room, id, spacing = 3, inset = 1) {
    const geo = roomGeometry(ctx, room);
    const along = geo.horizontal ? room.width : room.height;
    const count = Math.max(2, Math.round((along - 1 - inset * 2) / spacing) + 1);
    const lowAlong = (geo.horizontal ? room.x : room.y) + inset;
    const highAlong = (geo.horizontal ? geo.x1 : geo.y1) - inset;
    const sides = geo.horizontal ? [room.y + inset, geo.y1 - inset] : [room.x + inset, geo.x1 - inset];

    let placed = 0;
    for (const pos of spread(lowAlong, highAlong, count)) {
        for (const side of sides) {
            const tile = geo.horizontal ? [pos, side] : [side, pos];
            if (placeSolidGroup(ctx, room, [tile], id)) placed++;
        }
    }
    return placed;
}

/** A symmetric grid of single props over the interior. */
function gridOf(ctx, room, id, spacing = 3, inset = 1) {
    const cols = Math.max(1, Math.round((room.width - 1 - inset * 2) / spacing) + 1);
    const rows = Math.max(1, Math.round((room.height - 1 - inset * 2) / spacing) + 1);
    let placed = 0;
    for (const c of spread(room.x + inset, room.x + room.width - 1 - inset, cols)) {
        for (const r of spread(room.y + inset, room.y + room.height - 1 - inset, rows)) {
            if (placeSolidGroup(ctx, room, [[c, r]], id)) placed++;
        }
    }
    return placed;
}

/**
 * Ceiling lamps on a symmetric grid over the room, one to four by size,
 * each on the nearest plain floor to its ideal spot.
 */
function placeLamps(ctx, room) {
    const geo = roomGeometry(ctx, room);
    const along = geo.horizontal ? room.width : room.height;
    const across = geo.horizontal ? room.height : room.width;
    const nAlong = along >= 9 ? 2 : 1;
    const nAcross = across >= 9 ? 2 : 1;
    const alongs = spread((geo.horizontal ? room.x : room.y) + 2, (geo.horizontal ? geo.x1 : geo.y1) - 2, nAlong);
    const acrosses = spread((geo.horizontal ? room.y : room.x) + 2, (geo.horizontal ? geo.y1 : geo.x1) - 2, nAcross);

    let placed = 0;
    for (const a of alongs) {
        for (const b of acrosses) {
            const [c, r] = geo.horizontal ? [a, b] : [b, a];
            if (placeFloorNear(ctx, c, r, DECOR.LAMP)) placed++;
        }
    }
    return placed;
}

/** Floor detail on a tile, or the nearest plain one within a tile of it. */
function placeFloorNear(ctx, c, r, id) {
    if (placeFloor(ctx, c, r, id)) return true;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        if (placeFloor(ctx, c + dc, r + dr, id)) return true;
    }
    return false;
}

/** Floor detail along a straight line, stopping at the first thing in the way. */
function floorLine(ctx, [c0, r0], [c1, r1], id, { skipFirst = 0 } = {}) {
    const dc = Math.sign(c1 - c0);
    const dr = Math.sign(r1 - r0);
    const steps = Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0));
    let laid = 0;
    for (let i = skipFirst; i <= steps; i++) {
        const c = c0 + dc * i;
        const r = r0 + dr * i;
        if (!isFloor(ctx, c, r)) break;
        if (placeFloor(ctx, c, r, id)) laid++;
    }
    return laid;
}

/** Floor detail along the inside of a wall. */
function floorAlongWall(ctx, room, side, id, { inset = 0, skipEnds = 0 } = {}) {
    const tiles = sideTiles(room, side);
    let laid = 0;
    for (const t of tiles.slice(skipEnds, tiles.length - skipEnds)) {
        const [c, r] = inward(side, t, inset);
        if (placeFloor(ctx, c, r, id)) laid++;
    }
    return laid;
}

/** The floor tiles beside a placed prop of a given id (its foot, its front). */
function floorBeside(ctx, room, id, side) {
    const out = [];
    for (let r = room.y; r < room.y + room.height; r++) {
        for (let c = room.x; c < room.x + room.width; c++) {
            if (ctx.decor[r * MAP_COLS + c] !== id) continue;
            const [fc, fr] = inward(side, [c, r], 1);
            if (isFloor(ctx, fc, fr)) out.push([fc, fr]);
        }
    }
    return out;
}

/**
 * Sentinels either side of each doorway: the two tiles just inside the room
 * beside the opening, where a brazier or a barrel would be put.
 */
function flankDoorways(ctx, room, id) {
    const geo = roomGeometry(ctx, room);
    let placed = 0;
    for (const side of ['N', 'S', 'W', 'E']) {
        const mouth = geo.entrances.filter(e => e.side === side);
        if (mouth.length === 0) continue;
        const along = (e) => (side === 'N' || side === 'S') ? e.c : e.r;
        const lo = Math.min(...mouth.map(along));
        const hi = Math.max(...mouth.map(along));
        // Two tiles clear of the opening (the margin takes the first), one
        // tile in; a step further if that spot is spoken for.
        for (const dir of [-1, 1]) {
            for (let gap = 2; gap <= 3; gap++) {
                const pos = (dir < 0 ? lo : hi) + dir * gap;
                const edge = (side === 'N' || side === 'S') ? [pos, mouth[0].r] : [mouth[0].c, pos];
                if (placeSolidGroup(ctx, room, [inward(side, edge, 1)], id)) { placed++; break; }
            }
        }
    }
    return placed;
}

/**
 * A pallet: a block of stacked things in a corner, or as near to it as the
 * doorway allows -- when the corner is by a door it slides along the back
 * wall until it finds room.
 */
function pallet(ctx, room, [c, r], id, w = 2, h = 2) {
    const x1 = room.x + room.width - 1;
    const y1 = room.y + room.height - 1;
    const geo = roomGeometry(ctx, room);
    // Which way to slide: along the back wall, away from this corner
    const alongX = geo.back === 'N' || geo.back === 'S';
    const towardsCentre = alongX ? (c < room.x + room.width / 2 ? 1 : -1) : (r < room.y + room.height / 2 ? 1 : -1);

    for (let shift = 0; shift < 4; shift++) {
        const sc = c + (alongX ? shift * towardsCentre : 0);
        const sr = r + (alongX ? 0 : shift * towardsCentre);
        // Grow the block away from the nearest walls
        const c0 = sc + w - 1 > x1 ? sc - (w - 1) : sc;
        const r0 = sr + h - 1 > y1 ? sr - (h - 1) : sr;
        const tiles = [];
        for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) tiles.push([c0 + dc, r0 + dr]);
        if (placeSolidGroup(ctx, room, tiles, id)) return tiles.length;
    }
    return 0;
}

/** A few of a thing, scattered lightly over the interior. */
function scatterFloor(ctx, room, ids, fraction) {
    for (let r = room.y + 1; r < room.y + room.height - 1; r++) {
        for (let c = room.x + 1; c < room.x + room.width - 1; c++) {
            if (ctx.random() < fraction) placeFloor(ctx, c, r, ids[Math.floor(ctx.random() * ids.length)]);
        }
    }
}

// ---------------------------------------------------------------- recipes

const RECIPES = {
    plain(ctx, room) {
        // A little wear in the corners, nothing in the way
        for (const [c, r] of corners(room, 1)) {
            if (ctx.random() < 0.5) placeFloor(ctx, c, r, ctx.random() < 0.5 ? DECOR.PUDDLE : DECOR.RUBBLE);
        }
    },

    // A shipping bay. Pallets of stacked crates stand in the back corners and
    // loose crates line the back wall between them; the loading edge in front
    // of them is striped; an aisle of steel plate runs from the doorway to it;
    // barrels wait by the side wall; lamps hang on a grid.
    cargo(ctx, room) {
        const geo = roomGeometry(ctx, room);
        for (const corner of backCorners(room, geo, 0)) pallet(ctx, room, corner, DECOR.CRATES, 2, 2);
        wallRun(ctx, room, geo.back, DECOR.CRATE, { skipEnds: 3, maxLength: 3, step: 2 });
        floorAlongWall(ctx, room, geo.back, DECOR.STRIPES, { inset: 1, skipEnds: 0 });
        // The aisle: from the front wall's middle to the loading edge
        const front = sideTiles(room, geo.front);
        const mid = front[Math.floor(front.length / 2)];
        const far = inward(geo.back, sideTiles(room, geo.back)[Math.floor(front.length / 2)], 2);
        floorLine(ctx, inward(geo.front, mid, 1), far, DECOR.PLATE);
        const sideWall = shuffle(['N', 'S', 'W', 'E'].filter(s => s !== geo.back && s !== geo.front), ctx.random)[0];
        wallRun(ctx, room, sideWall, DECOR.BARREL, { skipEnds: 2, maxLength: 2, step: 4 });
        placeLamps(ctx, room);
    },

    // A plant room. Machinery is banked along the back wall with tanks in the
    // corners beside it; every machine's cable runs straight out across the
    // floor to a vent; a walkway of plate runs in front of the bank.
    plant(ctx, room) {
        const geo = roomGeometry(ctx, room);
        for (const corner of backCorners(room, geo, 0)) placeSolidGroup(ctx, room, [corner], DECOR.TANK);
        wallRun(ctx, room, geo.back, DECOR.MACHINE, { skipEnds: 2, maxLength: 2, step: 2 });
        for (const foot of floorBeside(ctx, room, DECOR.MACHINE, geo.back)) {
            placeFloor(ctx, foot[0], foot[1], DECOR.PLATE);
        }
        const machines = floorBeside(ctx, room, DECOR.MACHINE, geo.back);
        for (let i = 0; i < machines.length; i += 2) {
            const start = inward(geo.back, machines[i], 1);
            const end = inward(geo.back, machines[i], 4);
            const laid = floorLine(ctx, start, end, DECOR.CABLE);
            if (laid > 0) placeFloorNear(ctx, end[0], end[1], DECOR.VENT);
        }
        if (Math.max(room.width, room.height) >= 8) placeLamps(ctx, room);
    },

    // A barracks. Lockers line both side walls; a footlocker stands at the
    // end of each row; a walkway of plate runs down the middle under a lamp.
    barracks(ctx, room) {
        const geo = roomGeometry(ctx, room);
        // The walls nobody comes through, else the long ones
        const longWalls = geo.horizontal ? ['N', 'S'] : ['W', 'E'];
        const sides = geo.quiet.length >= 2 ? geo.quiet.slice(0, 2) : longWalls;
        for (const side of sides) wallRun(ctx, room, side, DECOR.LOCKER, { skipEnds: 1 });
        for (const corner of backCorners(room, geo, 1)) placeSolidGroup(ctx, room, [corner], DECOR.CRATE);
        const front = sideTiles(room, geo.front);
        const mid = front[Math.floor(front.length / 2)];
        floorLine(ctx, inward(geo.front, mid, 1), inward(geo.back, sideTiles(room, geo.back)[Math.floor(front.length / 2)], 1), DECOR.PLATE);
        placeLamps(ctx, room);
    },

    // A storeroom. Shelving in parallel rows with aisles wide enough to fight
    // in; barrels grouped in a back corner; crates at the ends of the rows.
    storage(ctx, room) {
        const geo = roomGeometry(ctx, room);
        const along = geo.horizontal ? room.width : room.height;
        rowsAcross(ctx, room, DECOR.RACK, { length: Math.max(2, along - 4), aisle: 2, inset: 2 });
        for (const corner of backCorners(room, geo, 0)) pallet(ctx, room, corner, DECOR.BARREL, 2, 1);
        for (const corner of corners(room, 1)) {
            if (ctx.random() < 0.5) placeSolidGroup(ctx, room, [corner], DECOR.CRATE);
        }
        scatterFloor(ctx, room, [DECOR.PUDDLE], 0.02);
        placeLamps(ctx, room);
    },

    // A laboratory. A bank of consoles along the back wall with vats in the
    // corners beside it; benches in parallel rows down the room; a drain in
    // each aisle; lit by its own screens and one lamp over the benches.
    lab(ctx, room) {
        const geo = roomGeometry(ctx, room);
        for (const corner of backCorners(room, geo, 0)) placeSolidGroup(ctx, room, [corner], DECOR.VAT);
        wallRun(ctx, room, geo.back, DECOR.CONSOLE, { skipEnds: 1 });
        const along = geo.horizontal ? room.width : room.height;
        rowsAcross(ctx, room, DECOR.BENCH, { length: Math.max(2, Math.min(4, along - 4)), aisle: 2, inset: 2, maxRows: 3 });
        // A drain between each pair of benches, on the room's axis
        const centre = geo.horizontal ? room.x + Math.floor(room.width / 2) : room.y + Math.floor(room.height / 2);
        const across = geo.horizontal ? [room.y, geo.y1] : [room.x, geo.x1];
        for (let pos = across[0] + 1; pos <= across[1] - 1; pos++) {
            const [c, r] = geo.horizontal ? [centre, pos] : [pos, centre];
            if (ctx.decor[r * MAP_COLS + c] === DECOR.NONE && isFloor(ctx, c, r) &&
                ((pos - across[0]) % 3 === 0)) placeFloor(ctx, c, r, DECOR.DRAIN);
        }
        for (const foot of floorBeside(ctx, room, DECOR.CONSOLE, geo.back)) placeFloor(ctx, foot[0], foot[1], DECOR.PLATE);
        if (Math.max(room.width, room.height) >= 8) placeLamps(ctx, room);
    },

    // A crypt. Sarcophagi in two symmetric ranks down the long axis, an aisle
    // between; braziers burn in the four corners; bones and rubble lie in the
    // aisles between the tombs, not in the walkway.
    crypt(ctx, room) {
        const geo = roomGeometry(ctx, room);
        for (const corner of corners(room, 0)) placeSolidGroup(ctx, room, [corner], DECOR.BRAZIER);
        // Ranks: pairs of sarcophagi (1x2 along the long axis) in two rows
        const along = geo.horizontal ? room.width : room.height;
        const across = geo.horizontal ? room.height : room.width;
        const lanes = across >= 7 ? [1, across - 3] : [Math.floor((across - 2) / 2)];
        const slots = Math.max(1, Math.floor((along - 2) / 3));
        for (const laneOffset of lanes) {
            for (const slot of spread(1, along - 3, slots)) {
                const tiles = [];
                for (let i = 0; i < 2; i++) {
                    tiles.push(geo.horizontal
                        ? [room.x + slot + i, room.y + laneOffset]
                        : [room.x + laneOffset, room.y + slot + i]);
                }
                placeSolidGroup(ctx, room, tiles, DECOR.SARCOPHAGUS);
            }
        }
        for (const foot of floorBeside(ctx, room, DECOR.SARCOPHAGUS, geo.horizontal ? 'N' : 'W')) {
            if (ctx.random() < 0.5) placeFloor(ctx, foot[0], foot[1], ctx.random() < 0.6 ? DECOR.BONES : DECOR.RUBBLE);
        }
        for (const [c, r] of corners(room, 1)) if (ctx.random() < 0.4) placeFloor(ctx, c, r, DECOR.RUBBLE);
    },

    // A pillared hall. Columns down both sides on an even spacing; a mosaic
    // aisle down the centre from the doorway to the far wall; braziers either
    // side of every doorway.
    hall(ctx, room) {
        const geo = roomGeometry(ctx, room);
        // The aisle first: nothing is allowed to stand on it
        const centre = geo.horizontal ? room.y + Math.floor(room.height / 2) : room.x + Math.floor(room.width / 2);
        if (geo.horizontal) floorLine(ctx, [room.x, centre], [geo.x1, centre], DECOR.MOSAIC);
        else floorLine(ctx, [centre, room.y], [centre, geo.y1], DECOR.MOSAIC);
        // Sentinels claim their places before the columns go up
        flankDoorways(ctx, room, DECOR.BRAZIER);
        colonnade(ctx, room, DECOR.PILLAR, 3, 1);
        for (const [c, r] of corners(room, 0)) if (ctx.random() < 0.3) placeFloor(ctx, c, r, DECOR.RUBBLE);
    },

    // A forge. Furnaces in a bank along the back wall, slag cooling on the
    // floor in front of their mouths; stock in barrels and crates in a side
    // corner, well away from the heat.
    forge(ctx, room) {
        const geo = roomGeometry(ctx, room);
        wallRun(ctx, room, geo.back, DECOR.FURNACE, { skipEnds: 1, maxLength: 2, step: 2 });
        for (const foot of floorBeside(ctx, room, DECOR.FURNACE, geo.back)) {
            placeFloor(ctx, foot[0], foot[1], DECOR.SLAG);
            const [c2, r2] = inward(geo.back, foot, 1);
            if (ctx.random() < 0.4) placeFloor(ctx, c2, r2, DECOR.SLAG);
        }
        const frontCorners = corners(room, 0).filter(t => !backCorners(room, geo, 0).some(b => b[0] === t[0] && b[1] === t[1]));
        const stock = shuffle(frontCorners, ctx.random)[0];
        if (stock) {
            pallet(ctx, room, stock, DECOR.BARREL, 2, 1);
            const [c, r] = stock;
            placeSolidGroup(ctx, room, [[c, r + (r === room.y ? 1 : -1)]], DECOR.CRATE);
        }
        scatterFloor(ctx, room, [DECOR.RUBBLE], 0.03);
    },

    // A cistern. Pillars on a grid hold the roof up; a drainage channel of
    // grates runs down the middle; puddles collect at the foot of the pillars
    // and moss grows along the walls.
    cistern(ctx, room) {
        const geo = roomGeometry(ctx, room);
        // The channel first; the pillars go up around it
        const centre = geo.horizontal ? room.y + Math.floor(room.height / 2) : room.x + Math.floor(room.width / 2);
        if (geo.horizontal) floorLine(ctx, [room.x + 1, centre], [geo.x1 - 1, centre], DECOR.GRATE);
        else floorLine(ctx, [centre, room.y + 1], [centre, geo.y1 - 1], DECOR.GRATE);
        gridOf(ctx, room, DECOR.PILLAR, 3, 1);
        for (const foot of floorBeside(ctx, room, DECOR.PILLAR, 'N')) {
            if (ctx.random() < 0.6) placeFloor(ctx, foot[0], foot[1], DECOR.PUDDLE);
        }
        for (const side of ['N', 'S', 'W', 'E']) {
            for (const t of sideTiles(room, side)) {
                if (ctx.random() < 0.3) placeFloor(ctx, t[0], t[1], DECOR.MOSS);
            }
        }
        if (ctx.random() < 0.4) flankDoorways(ctx, room, DECOR.BRAZIER);
    },
};

export const ROOM_KINDS = Object.keys(RECIPES);

// =============================================================================
// LIGHTS AT RUNTIME
// =============================================================================

/**
 * The decoration lights burning this frame: the nearest to the player, up to
 * the budget, with their flicker applied. Same contract as the terrain glow.
 *
 * @param {Object[]} decorLights - From decorateRooms()
 * @param {Object} player - Needs x, y
 * @param {number} nowMs - Clock for the flicker
 * @returns {Object[]} Light source descriptors
 */
export function collectDecorLights(decorLights, player, nowMs) {
    if (!decorLights || decorLights.length === 0 || !player) return [];

    const cull = DECOR_CONFIG.LIGHT_CULL;
    const near = [];
    for (const light of decorLights) {
        const dx = light.x - player.x;
        const dy = light.y - player.y;
        const distSq = dx * dx + dy * dy;
        if (distSq <= cull * cull) near.push({ light, distSq });
    }
    near.sort((a, b) => a.distSq - b.distSq);

    const time = nowMs / 1000;
    const out = [];
    for (const { light } of near.slice(0, DECOR_CONFIG.LIGHT_MAX)) {
        const phase = light.x * 0.013 + light.y * 0.029;
        const wobble = light.flicker
            ? 1 + light.flicker * (0.5 + 0.5 * Math.sin(time * light.flickerHz * Math.PI * 2 + phase)) - light.flicker * 0.5
            : 1;
        out.push({
            id: `decor-${light.id}-${Math.round(light.x)}-${Math.round(light.y)}`,
            x: light.x, y: light.y,
            kind: 'point',
            range: light.range,
            intensity: light.intensity * wobble,
            color: light.color,
            originCount: 1,
            arcDegrees: 3,
            softnessPx: 4,
            stops: [[0, 1], [0.4, 0.55], [1, 0]],
            gated: true,
        });
    }
    return out;
}
