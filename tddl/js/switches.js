/**
 * =============================================================================
 * SWITCHES AND SLIDING WALLS
 * =============================================================================
 *
 * Doom's levels are worked by switches: a panel on a wall that, pressed,
 * makes something happen somewhere else -- a wall slides away, a floor
 * lowers, a door opens across the room. This is that, used sparingly:
 *
 *   loot alcove   A pocket dug into the rock beside a room, holding a health
 *                 pack and a weapon, sealed by a section of the room's own
 *                 wall that slides aside when the switch on a DIFFERENT wall
 *                 of the same room is pressed -- so the player sees the wall
 *                 move as they press it, which is the whole point.
 *
 *   trap switch   One of the level's monster closets, wired to a switch
 *                 instead of a floor trigger: press it and the wall opens.
 *
 * A switch is a wall tile (TILE_SWITCH) that is pressed by pushing into it or
 * by shooting it. A sliding wall is a wall tile (TILE_SLIDE) that is solid
 * and opaque until its switch is pressed, then slides sideways into the
 * rock over SLIDE_FRAMES and stays open. Both are walls to every solver at
 * generation time, so a level with an alcove in it is exactly as solvable as
 * one without: the alcove is a reward, never the way through.
 *
 * Leaf module: constants and the trap planner's closet geometry only. It
 * reports what it wants played or fired rather than doing it, so the modules
 * that depend on it stay free of audio and game logic.
 */

import {
    TILE_SIZE, MAP_COLS, MAP_ROWS, TILE_EMPTY, TILE_WALL, TILE_SLIDE, TILE_SWITCH,
    TILE_HEALTH_PACK, TILE_WEAPON_SHOTGUN, TILE_WEAPON_RIFLE, TILE_WEAPON_PLASMAGUN,
} from './constants.js';
import { planCloset } from './traps.js';

// =============================================================================
// TUNING
// =============================================================================

export const SWITCHES = {
    MIN_LEVEL: 2,                    // The first level has enough to learn
    MAX_PER_LEVEL: 2,                // Sparing: one alcove, maybe one trap switch
    ALCOVE_CHANCE: 0.7,              // A level's chance of an alcove at all
    TRAP_SHARE: 0.4,                 // A level with a closet: chance it gets a switch
    SLIDE_FRAMES: 48,                // How long the wall takes to slide clear
    PASSABLE_AT: 0.6,                // Openness at which the gap can be used
    MIN_ROOM_AREA: 20,
};

// =============================================================================
// STATE
// =============================================================================

let switches = [];
let slides = [];
let switchIndex = null;
let slideIndex = null;

/**
 * Forgets every switch and installs a level's plan.
 *
 * @param {Object|null} plan - From planSwitches(), or null for none
 */
export function registerSwitches(plan) {
    switches = [];
    slides = [];
    switchIndex = new Int16Array(MAP_COLS * MAP_ROWS).fill(-1);
    slideIndex = new Int16Array(MAP_COLS * MAP_ROWS).fill(-1);
    if (!plan) return;

    for (const slide of plan.slides || []) {
        const entry = { id: slides.length, tiles: slide.tiles, dir: slide.dir, openness: 0, target: 0 };
        for (const t of entry.tiles) slideIndex[t.r * MAP_COLS + t.c] = entry.id;
        slides.push(entry);
    }
    for (const sw of plan.switches || []) {
        const entry = { id: switches.length, c: sw.c, r: sw.r, face: sw.face, room: sw.room, effect: sw.effect, on: false };
        switchIndex[sw.r * MAP_COLS + sw.c] = entry.id;
        switches.push(entry);
    }
}

/** Clears everything. */
export function resetSwitches() {
    switches = [];
    slides = [];
    switchIndex = null;
    slideIndex = null;
}

export function getSwitches() { return switches; }
export function getSlides() { return slides; }

/** @returns {Object|null} The switch on a tile */
export function switchAtTile(c, r) {
    if (!switchIndex || c < 0 || c >= MAP_COLS || r < 0 || r >= MAP_ROWS) return null;
    const i = switchIndex[r * MAP_COLS + c];
    return i >= 0 ? switches[i] : null;
}

/** @returns {Object|null} The sliding wall on a tile */
export function slideAtTile(c, r) {
    if (!slideIndex || c < 0 || c >= MAP_COLS || r < 0 || r >= MAP_ROWS) return null;
    const i = slideIndex[r * MAP_COLS + c];
    return i >= 0 ? slides[i] : null;
}

/**
 * Whether a sliding wall tile has slid far enough to walk, see and shoot
 * through. A TILE_SLIDE the registry does not know counts as shut.
 */
export function isSlideOpen(c, r) {
    const slide = slideAtTile(c, r);
    return !!slide && slide.openness >= SWITCHES.PASSABLE_AT;
}

/**
 * Presses the switch on a tile. A switch works once.
 *
 * @param {number} c - Tile column
 * @param {number} r - Tile row
 * @returns {Object|null} The switch, if this press turned it on
 */
export function pressSwitchAt(c, r) {
    const sw = switchAtTile(c, r);
    if (!sw || sw.on) return null;
    sw.on = true;
    if (sw.effect.kind === 'slide') {
        const slide = slides[sw.effect.slide];
        if (slide) slide.target = 1;
    }
    return sw;
}

/**
 * Runs the sliding walls a frame.
 *
 * @returns {Array<{kind: string, slide: Object}>} 'slide-start' when a wall begins to move
 */
export function updateSwitches() {
    const events = [];
    for (const slide of slides) {
        if (slide.openness >= slide.target) continue;
        if (slide.openness === 0) events.push({ kind: 'slide-start', slide });
        slide.openness = Math.min(1, slide.openness + 1 / SWITCHES.SLIDE_FRAMES);
    }
    return events;
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

function tileAt(map, c, r) {
    return map[r] ? map[r][c] : undefined;
}

function isOpen(map, c, r) {
    const t = tileAt(map, c, r);
    return t !== undefined && t !== TILE_WALL;
}

/**
 * Wall tiles along one side of a room where a switch could be set: in a run
 * of solid wall, fronting the room's floor, not beside a doorway and not one
 * of the tiles listed as taken.
 */
function switchSpots(map, room, side, taken) {
    const x1 = room.x + room.width - 1;
    const y1 = room.y + room.height - 1;
    const spots = [];
    const consider = (c, r, fc, fr, a1, a2) => {
        if (tileAt(map, c, r) !== TILE_WALL) return;
        if (tileAt(map, a1[0], a1[1]) !== TILE_WALL || tileAt(map, a2[0], a2[1]) !== TILE_WALL) return;
        if (tileAt(map, fc, fr) !== TILE_EMPTY) return;
        if (taken.some(t => Math.abs(t.c - c) <= 1 && Math.abs(t.r - r) <= 1)) return;
        spots.push({ c, r, face: side });
    };
    if (side === 'N' || side === 'S') {
        const r = side === 'N' ? room.y - 1 : y1 + 1;
        const fr = side === 'N' ? room.y : y1;
        for (let c = room.x + 1; c <= x1 - 1; c++) consider(c, r, c, fr, [c - 1, r], [c + 1, r]);
    } else {
        const c = side === 'W' ? room.x - 1 : x1 + 1;
        const fc = side === 'W' ? room.x : x1;
        for (let r = room.y + 1; r <= y1 - 1; r++) consider(c, r, fc, r, [c, r - 1], [c, r + 1]);
    }
    return spots;
}

/** Sides of a room with no doorway in them. */
function quietSides(map, room) {
    const x1 = room.x + room.width - 1;
    const y1 = room.y + room.height - 1;
    const busy = new Set();
    for (let c = room.x; c <= x1; c++) {
        if (isOpen(map, c, room.y - 1)) busy.add('N');
        if (isOpen(map, c, y1 + 1)) busy.add('S');
    }
    for (let r = room.y; r <= y1; r++) {
        if (isOpen(map, room.x - 1, r)) busy.add('W');
        if (isOpen(map, x1 + 1, r)) busy.add('E');
    }
    return ['N', 'S', 'W', 'E'].filter(s => !busy.has(s));
}

/** Which side of the room a closet's door lies on. */
function closetSide(room, closet) {
    const d = closet.door[0];
    if (d.r < room.y) return 'N';
    if (d.r >= room.y + room.height) return 'S';
    if (d.c < room.x) return 'W';
    return 'E';
}

/** The direction a door run slides: into the rock past one of its ends. */
function slideDirection(map, door) {
    const horizontal = door.length > 1 ? door[0].r === door[1].r : true;
    const lo = door.reduce((m, t) => Math.min(m, horizontal ? t.c : t.r), Infinity);
    const hi = door.reduce((m, t) => Math.max(m, horizontal ? t.c : t.r), -Infinity);
    const fixed = horizontal ? door[0].r : door[0].c;
    const rockPast = (pos, sign) => {
        for (let i = 1; i <= door.length; i++) {
            const p = pos + sign * i;
            const t = horizontal ? tileAt(map, p, fixed) : tileAt(map, fixed, p);
            if (t !== TILE_WALL) return false;
        }
        return true;
    };
    if (rockPast(hi, 1)) return horizontal ? [1, 0] : [0, 1];
    if (rockPast(lo, -1)) return horizontal ? [-1, 0] : [0, -1];
    return horizontal ? [1, 0] : [0, 1];
}

/** What an alcove holds, by level. */
function alcoveLoot(level) {
    const weapon = level < 4 ? TILE_WEAPON_SHOTGUN : level < 7 ? TILE_WEAPON_RIFLE : TILE_WEAPON_PLASMAGUN;
    return [TILE_HEALTH_PACK, weapon];
}

/**
 * Plans a level's switches. Carves alcoves and stamps switch and slide tiles
 * into the map; may wire one of the given traps to a switch.
 *
 * @param {number[][]} map - The finished level
 * @param {Object[]} rooms - Room rectangles
 * @param {Object|null} playerStartRoom - Never used
 * @param {Object} [options]
 * @param {number} [options.level]
 * @param {() => number} [options.random]
 * @param {(c: number, r: number) => boolean} [options.isReserved]
 * @param {Uint8Array|number[]|null} [options.tileStyles]
 * @param {Object[]} [options.traps] - The level's traps; a closet may be rewired
 * @returns {{switches: Object[], slides: Object[]}} The plan
 */
export function planSwitches(map, rooms, playerStartRoom, options = {}) {
    const {
        level = 1, random = Math.random, isReserved = () => false, tileStyles = null, traps = [],
    } = options;
    const plan = { switches: [], slides: [] };
    if (!map || !rooms || level < SWITCHES.MIN_LEVEL) return plan;

    // An alcove is dug with the same routine that digs a monster closet, so
    // without this it could be dug straight through one the trap planner has
    // already placed -- putting the loot inside a closet, and leaving the
    // closet short of the tiles it expects to open. Every tile a trap has
    // spoken for counts as reserved.
    const trapTiles = new Set();
    for (const trap of traps) {
        for (const t of [...(trap.pocket || []), ...(trap.door || []), ...(trap.margin || [])]) {
            trapTiles.add(`${t.c},${t.r}`);
        }
    }
    const spokenFor = (c, r) => trapTiles.has(`${c},${r}`) || isReserved(c, r);

    const eligible = shuffle(rooms.filter(room =>
        room !== playerStartRoom && room.role !== 'start' &&
        room.width * room.height >= SWITCHES.MIN_ROOM_AREA), random);

    const taken = [];
    const roomStyle = (room) => tileStyles ? tileStyles[room.center.y * MAP_COLS + room.center.x] : null;
    const paint = (tiles, style) => {
        if (style === null || !tileStyles) return;
        for (const t of tiles) tileStyles[t.r * MAP_COLS + t.c] = style;
    };

    // --- A loot alcove -------------------------------------------------------
    if (random() < SWITCHES.ALCOVE_CHANCE) {
        for (const room of eligible) {
            if (plan.switches.length >= SWITCHES.MAX_PER_LEVEL) break;
            const closet = planCloset(map, room, random, spokenFor);
            if (!closet) continue;
            const alcoveSide = closetSide(room, closet);
            const sides = shuffle(quietSides(map, room).filter(s => s !== alcoveSide), random);
            let spot = null;
            for (const side of sides) {
                const spots = switchSpots(map, room, side, [...closet.door, ...closet.pocket]);
                if (spots.length) { spot = spots[Math.floor(random() * spots.length)]; break; }
            }
            if (!spot) continue;

            const loot = alcoveLoot(level);
            closet.pocket.forEach((t, i) => { map[t.r][t.c] = loot[i] !== undefined ? loot[i] : TILE_EMPTY; });
            for (const t of closet.door) map[t.r][t.c] = TILE_SLIDE;
            map[spot.r][spot.c] = TILE_SWITCH;
            paint([...closet.pocket, ...closet.door, spot], roomStyle(room));

            plan.slides.push({ tiles: closet.door, dir: slideDirection(map, closet.door), pocket: closet.pocket, room: room.id });
            plan.switches.push({ c: spot.c, r: spot.r, face: spot.face, room: room.id,
                                 effect: { kind: 'slide', slide: plan.slides.length - 1 } });
            taken.push(spot, ...closet.door);
            break;
        }
    }

    // --- A closet on a switch ------------------------------------------------
    const closets = traps.map((t, i) => ({ t, i })).filter(({ t }) => t.kind === 'closet');
    if (closets.length && plan.switches.length < SWITCHES.MAX_PER_LEVEL && random() < SWITCHES.TRAP_SHARE) {
        const { t: trap, i: index } = closets[Math.floor(random() * closets.length)];
        const room = rooms.find(r => r.id === trap.room);
        if (room) {
            const doorSide = closetSide(room, trap);
            const sides = shuffle(quietSides(map, room).filter(s => s !== doorSide), random);
            let spot = null;
            for (const side of sides) {
                const spots = switchSpots(map, room, side, [...trap.door, ...trap.pocket, ...taken]);
                if (spots.length) { spot = spots[Math.floor(random() * spots.length)]; break; }
            }
            if (spot) {
                map[spot.r][spot.c] = TILE_SWITCH;
                paint([spot], roomStyle(room));
                trap.trigger = [];
                trap.switched = true;
                plan.switches.push({ c: spot.c, r: spot.r, face: spot.face, room: room.id,
                                     effect: { kind: 'trap', trap: index } });
            }
        }
    }

    return plan;
}
