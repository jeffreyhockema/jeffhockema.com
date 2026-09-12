/**
 * =============================================================================
 * TRAPS: MONSTER CLOSETS AND TELEPORT AMBUSHES
 * =============================================================================
 *
 * Doom's levels are full of things that happen because you did something: you
 * pick up the key and the walls of the room slide away to reveal the monsters
 * that were waiting behind them; you walk to the middle of the room and a
 * squad teleports in at your back. Both were done with linedef triggers and
 * sealed-off rooms full of sleeping monsters. This is the same idea.
 *
 * Two kinds of trap:
 *
 *   closet   A pocket dug into the solid rock beside a room, two tiles wide
 *            and one deep, sealed by the room's own wall and holding a couple
 *            of monsters. Crossing the trigger opens the wall; the monsters
 *            wake and come out -- usually behind the player, because the
 *            trigger sits on the room's item or at its centre and the closet
 *            is on a wall they have already walked past.
 *
 *   teleport A trigger that brings monsters in. Crossing it picks spots in the
 *            room, out of arm's reach and by preference behind the player,
 *            and monsters arrive there in a flash of green with their eyes
 *            already on the player.
 *
 * Planning happens at level generation and changes nothing about the map: a
 * closet is chosen where the rock is solid and stays solid, so the level the
 * progression verifier checks is the level the player gets. Only firing a
 * trap carves anything, and what it carves is a dead-end pocket.
 *
 * Leaf module: constants and the bestiary only. The runtime that creates the
 * monsters and fires the traps is on GameState.
 */

import { TILE_SIZE, MAP_COLS, MAP_ROWS, TILE_EMPTY, TILE_WALL } from './constants.js';
import { pickMonsterType } from './monsters.js';

// =============================================================================
// TUNING
// =============================================================================

export const TRAPS = {
    MIN_LEVEL: 2,                    // The first level teaches the loop untrapped
    PER_ROOMS: 3,                    // About one trap per this many eligible rooms
    MAX_PER_LEVEL: 4,
    CLOSET_SHARE: 0.6,               // The rest are teleport ambushes
    CLOSET_WIDTH: 2,                 // Tiles along the wall; one deep
    MIN_ROOM_AREA: 20,
    TELEPORT_MIN: 2,                 // Monsters per teleport ambush
    TELEPORT_MAX: 4,
    TELEPORT_MIN_DISTANCE: TILE_SIZE * 3,   // Never right on top of the player
};

/** Tile values that are items: keys, weapons, health, the exit. */
function isItemTile(tile) {
    return tile >= 6 && tile <= 15;
}

function shuffle(list, random) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

function inBounds(c, r) {
    return c >= 1 && c < MAP_COLS - 1 && r >= 1 && r < MAP_ROWS - 1;
}

function tileAt(map, c, r) {
    return map[r] ? map[r][c] : undefined;
}

// =============================================================================
// PLANNING
// =============================================================================

/**
 * Plans the traps for a level.
 *
 * @param {number[][]} map - The finished level
 * @param {Object[]} rooms - Room rectangles (x, y, width, height, id, role)
 * @param {Object|null} playerStartRoom - Never trapped
 * @param {Object} [options]
 * @param {number} [options.level] - Current level, for the monster mix
 * @param {() => number} [options.random] - Injectable RNG
 * @param {(c: number, r: number) => boolean} [options.isReserved] - Tiles never to dig
 * @param {Uint8Array|number[]|null} [options.tileStyles] - Per-tile looks; a
 *        pocket takes its room's, so the opened wall matches the room
 * @param {number} [options.maxTraps] - Override the per-level cap
 * @returns {Object[]} Traps, unfired
 */
export function planTraps(map, rooms, playerStartRoom, options = {}) {
    const {
        level = 1,
        random = Math.random,
        isReserved = () => false,
        tileStyles = null,
        maxTraps = TRAPS.MAX_PER_LEVEL,
    } = options;

    if (!map || !rooms || level < TRAPS.MIN_LEVEL) return [];

    const eligible = shuffle(rooms.filter(room =>
        room !== playerStartRoom && room.role !== 'start' &&
        room.width * room.height >= TRAPS.MIN_ROOM_AREA), random);

    const budget = Math.min(maxTraps, Math.max(1, Math.floor(eligible.length / TRAPS.PER_ROOMS)));
    const traps = [];

    for (const room of eligible) {
        if (traps.length >= budget) break;

        const trigger = triggerTilesFor(map, room);
        if (trigger.length === 0) continue;

        if (random() < TRAPS.CLOSET_SHARE) {
            const closet = planCloset(map, room, random, isReserved);
            if (closet) {
                if (tileStyles) {
                    const roomStyle = tileStyles[room.center.y * MAP_COLS + room.center.x];
                    for (const t of [...closet.pocket, ...closet.door]) {
                        tileStyles[t.r * MAP_COLS + t.c] = roomStyle;
                    }
                }
                traps.push({
                    kind: 'closet',
                    room: room.id,
                    trigger,
                    pocket: closet.pocket,
                    door: closet.door,
                    facing: closet.facing,
                    monsters: closet.pocket.map(() => pickMonsterType(level, random)),
                    fired: false,
                });
                continue;
            }
        }

        const count = TRAPS.TELEPORT_MIN + Math.floor(random() * (TRAPS.TELEPORT_MAX - TRAPS.TELEPORT_MIN + 1));
        traps.push({
            kind: 'teleport',
            room: room.id,
            trigger,
            rect: { x: room.x, y: room.y, w: room.width, h: room.height },
            count,
            monsters: Array.from({ length: count }, () => pickMonsterType(level, random)),
            fired: false,
        });
    }

    return traps;
}

/**
 * Where a room's trap goes off: the tiles around its item, if it has one --
 * grab the key and the walls open -- else a block at its centre.
 *
 * @param {number[][]} map - The level
 * @param {Object} room - Room rectangle
 * @returns {Array<{c: number, r: number}>} Trigger tiles, all walkable
 */
export function triggerTilesFor(map, room) {
    let item = null;
    for (let r = room.y; r < room.y + room.height && !item; r++) {
        for (let c = room.x; c < room.x + room.width; c++) {
            if (isItemTile(tileAt(map, c, r))) { item = { c, r }; break; }
        }
    }

    const tiles = [];
    const consider = (c, r) => {
        const tile = tileAt(map, c, r);
        if (tile === TILE_EMPTY || isItemTile(tile)) tiles.push({ c, r });
    };

    if (item) {
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) consider(item.c + dc, item.r + dr);
    } else {
        const cx = room.x + Math.floor(room.width / 2);
        const cy = room.y + Math.floor(room.height / 2);
        for (let dr = -1; dr <= 0; dr++) for (let dc = -1; dc <= 0; dc++) consider(cx + dc, cy + dr);
    }
    return tiles;
}

/**
 * Finds a place for a closet on one of a room's walls.
 *
 * The pocket sits one tile beyond the wall; the wall tiles in front of it are
 * the door. Both, and a ring of rock round them, must be solid and unreserved,
 * so that opening the closet can only ever connect it to this room.
 *
 * @param {number[][]} map - The level
 * @param {Object} room - Room rectangle
 * @param {() => number} random - Injectable RNG
 * @param {(c: number, r: number) => boolean} isReserved - Tiles never to dig
 * @returns {{pocket: Object[], door: Object[], facing: Object[]}|null} The closet, or null
 */
export function planCloset(map, room, random, isReserved) {
    const width = TRAPS.CLOSET_WIDTH;
    const sides = shuffle(['N', 'S', 'W', 'E'], random);

    for (const side of sides) {
        const along = (side === 'N' || side === 'S') ? room.width : room.height;
        const offsets = shuffle(Array.from({ length: Math.max(0, along - width + 1) }, (_, i) => i), random);

        for (const offset of offsets) {
            const closet = closetAt(room, side, offset, width);
            if (!closet) continue;

            const solid = [...closet.pocket, ...closet.door, ...closet.margin];
            if (!solid.every(t => inBounds(t.c, t.r) && tileAt(map, t.c, t.r) === TILE_WALL)) continue;
            if ([...closet.pocket, ...closet.door].some(t => isReserved(t.c, t.r))) continue;
            if (!closet.facing.every(t => tileAt(map, t.c, t.r) === TILE_EMPTY)) continue;

            return { pocket: closet.pocket, door: closet.door, facing: closet.facing };
        }
    }
    return null;
}

/**
 * The tiles of a closet on a given side at a given offset along it.
 *
 * @returns {{pocket: Object[], door: Object[], margin: Object[], facing: Object[]}|null}
 */
function closetAt(room, side, offset, width) {
    const pocket = [], door = [], margin = [], facing = [];

    if (side === 'N' || side === 'S') {
        const doorRow = side === 'N' ? room.y - 1 : room.y + room.height;
        const pocketRow = side === 'N' ? room.y - 2 : room.y + room.height + 1;
        const marginRow = side === 'N' ? room.y - 3 : room.y + room.height + 2;
        const faceRow = side === 'N' ? room.y : room.y + room.height - 1;
        const x0 = room.x + offset;
        for (let i = 0; i < width; i++) {
            door.push({ c: x0 + i, r: doorRow });
            pocket.push({ c: x0 + i, r: pocketRow });
            margin.push({ c: x0 + i, r: marginRow });
            facing.push({ c: x0 + i, r: faceRow });
        }
        for (const r of [doorRow, pocketRow, marginRow]) {
            margin.push({ c: x0 - 1, r }, { c: x0 + width, r });
        }
    } else {
        const doorCol = side === 'W' ? room.x - 1 : room.x + room.width;
        const pocketCol = side === 'W' ? room.x - 2 : room.x + room.width + 1;
        const marginCol = side === 'W' ? room.x - 3 : room.x + room.width + 2;
        const faceCol = side === 'W' ? room.x : room.x + room.width - 1;
        const y0 = room.y + offset;
        for (let i = 0; i < width; i++) {
            door.push({ c: doorCol, r: y0 + i });
            pocket.push({ c: pocketCol, r: y0 + i });
            margin.push({ c: marginCol, r: y0 + i });
            facing.push({ c: faceCol, r: y0 + i });
        }
        for (const c of [doorCol, pocketCol, marginCol]) {
            margin.push({ c, r: y0 - 1 }, { c, r: y0 + width });
        }
    }

    return { pocket, door, margin, facing };
}

// =============================================================================
// FIRING
// =============================================================================

/**
 * @param {Object} trap - A trap
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {boolean} True if the tile is on the trap's trigger
 */
export function isOnTrigger(trap, tileX, tileY) {
    for (const t of trap.trigger) {
        if (t.c === tileX && t.r === tileY) return true;
    }
    return false;
}

/**
 * Opens a closet: its door and pocket become floor.
 *
 * @param {number[][]} map - The level
 * @param {Object} trap - A closet trap
 */
export function openCloset(map, trap) {
    for (const t of [...trap.pocket, ...trap.door]) {
        if (map[t.r]) map[t.r][t.c] = TILE_EMPTY;
    }
}

/**
 * Chooses where a teleport ambush's monsters arrive: floor tiles in the room,
 * out of arm's reach of the player, and behind them by preference.
 *
 * @param {number[][]} map - The level
 * @param {Object} trap - A teleport trap
 * @param {Object} player - Needs x, y, angle
 * @param {number} count - How many spots
 * @param {() => number} [random] - Injectable RNG
 * @returns {Array<{x: number, y: number}>} World positions, maybe fewer than asked
 */
export function pickTeleportSpots(map, trap, player, count, random = Math.random) {
    const facingX = Math.cos(player.angle || 0);
    const facingY = Math.sin(player.angle || 0);
    const minDist = TRAPS.TELEPORT_MIN_DISTANCE;
    const candidates = [];

    for (let r = trap.rect.y; r < trap.rect.y + trap.rect.h; r++) {
        for (let c = trap.rect.x; c < trap.rect.x + trap.rect.w; c++) {
            if (tileAt(map, c, r) !== TILE_EMPTY) continue;
            const x = c * TILE_SIZE + TILE_SIZE / 2;
            const y = r * TILE_SIZE + TILE_SIZE / 2;
            const dx = x - player.x;
            const dy = y - player.y;
            const dist = Math.hypot(dx, dy);
            if (dist < minDist) continue;
            // Negative when behind the player. Jittered so a fixed room does
            // not always produce the same corner.
            const behind = (dx * facingX + dy * facingY) / Math.max(dist, 1) + (random() - 0.5) * 0.6;
            candidates.push({ x, y, behind });
        }
    }

    candidates.sort((a, b) => a.behind - b.behind);

    const chosen = [];
    for (const spot of candidates) {
        if (chosen.length >= count) break;
        if (chosen.some(other => Math.hypot(other.x - spot.x, other.y - spot.y) < TILE_SIZE)) continue;
        chosen.push({ x: spot.x, y: spot.y });
    }
    return chosen;
}
