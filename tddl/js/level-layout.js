/**
 * DOOM-STYLE LEVEL LAYOUT
 *
 * Builds the shape of a regular level the way a 1993 Doom map is shaped: you
 * start somewhere, fight your way around an area until you run into a locked
 * door, keep exploring the SAME area until the matching key turns up, walk back
 * to the door, and repeat one colour deeper until the exit.
 *
 * The important word there is "until". A level where the red key sits behind the
 * red door is not a hard level, it is a broken one, and the old generator could
 * only avoid that by placing doors at random and re-checking afterwards. This
 * module inverts the process, following the mission-graph / space split that
 * Joris Dormans describes for action-adventure levels:
 *
 *   1. Decide the MISSION first -- an ordered list of zones where zone i holds
 *      key i, and the gate into zone i+1 is locked with key i.
 *   2. Only then lay out SPACE to match: partition the map into disjoint zone
 *      rectangles separated by solid gutters, fill each with rooms, and connect
 *      zones to each other through exactly one gated corridor.
 *
 * Because corridors are clamped to their own zone rectangle and the only tiles
 * ever carved out of a gutter are the gate crossings, the zone graph is a tree
 * whose edges are all locked doors. Key i lives in zone i, which by induction is
 * open once you hold keys 0..i-1, so the level cannot generate unwinnable. There
 * is no retry loop hiding a design flaw.
 *
 * Two further Doom habits fall out of the same structure:
 *
 * - A zone's gate is NOT always attached to the previous zone. Most of the time
 *   it is (the "each key takes you deeper" chain), but sometimes it hangs off an
 *   earlier zone instead, so the blue key you found at the bottom of the map has
 *   to be carried all the way back to a door near the start. That is Romero's
 *   hub-and-spoke rule -- reuse areas so the player learns the space.
 * - Within a zone the gate sits partway along the exploration path and the key
 *   sits at the far end of it, so the player reliably meets the locked door
 *   BEFORE the thing that opens it. Romero again: show the problem, then the
 *   solution.
 *
 * Corridors and gates are two tiles wide. Doom's hallways are wide enough to
 * fight and strafe in; a one-tile corridor is a queue, not a battlefield. Secret
 * passages stay one tile wide, which is exactly what makes them read as secret.
 *
 * Zones also carry a look. Each one is handed a style index differing from its
 * parent's, so passing a locked door always lands you somewhere that looks like
 * somewhere else -- Romero's contrast rule, and his rule that a texture change
 * should be framed by a border rather than happening mid-wall. The frame is built
 * in: two tiles of solid rock and a door. The module hands out indices only and
 * never learns what a style is; the renderer owns that.
 *
 * @author TDDL Game Team
 * @version 1.0.0
 */

import {
    TILE_EMPTY, TILE_WALL, TILE_EXIT,
    TILE_DOOR_RED, TILE_DOOR_YELLOW, TILE_DOOR_BLUE,
    TILE_KEY_RED, TILE_KEY_YELLOW, TILE_KEY_BLUE, TILE_PROP, TILE_SLIDE, TILE_SWITCH, TILE_WINDOW,
} from './constants.js';
import { randomInt, randomChoice, shuffleArray } from './utils.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

export const LAYOUT_CONFIG = {
    // Corridors wide enough to fight in. Doom's hallways are not queues.
    CORRIDOR_WIDTH: 2,

    // Solid rock left between zone rectangles. Nothing is ever carved out of a
    // gutter except a gate crossing, which is what makes the gates cut vertices.
    ZONE_GUTTER: 2,

    // A zone narrower than this cannot hold a room plus the corridor lane around
    // it, so the splitter stops before producing one.
    MIN_ZONE_SPAN: 15,

    // Two zones only count as neighbours if they share enough border to fit a
    // two-wide crossing with a tile of margin either side.
    MIN_ZONE_OVERLAP: 8,

    // Clear ring inside a zone rectangle where rooms may not go. Corridors run
    // here, and it keeps every room at least this far from the gutter -- so a
    // gate door always lands in a corridor, never on a room's doorstep.
    ROOM_MARGIN: 2,

    MIN_ROOM_SIZE: 5,
    MAX_ROOM_SIZE: 10,
    ARENA_ROOM_SIZE: 13,        // The one oversized room each zone tries for
    MIN_ROOMS_PER_ZONE: 3,
    MAX_ROOMS_PER_ZONE: 7,

    // Extra non-spanning-tree corridors. Doom levels loop; a pure tree makes every
    // room a dead end you have to walk back out of. The budget is a fraction of
    // the zone's room count rather than a flat number: two extra edges in a
    // four-room zone joins everything to everything, and a zone where every room
    // is one hop from every other has no far end to hide a key in.
    LOOP_EDGE_CHANCE: 0.55,
    LOOP_EDGES_PER_ROOM: 0.25,

    // How often a new zone attaches to the most recent zone (a chain) rather
    // than to an earlier one (a spoke off the hub).
    CHAIN_BIAS: 0.7,

    MAX_ATTEMPTS: 16
};

/**
 * The key/door progression, in the order Doom uses them. Zone i holds
 * PROGRESSION[i].key, and the gate into zone i+1 is PROGRESSION[i].door.
 */
export const PROGRESSION = [
    { key: TILE_KEY_RED,    door: TILE_DOOR_RED,    name: 'red' },
    { key: TILE_KEY_YELLOW, door: TILE_DOOR_YELLOW, name: 'yellow' },
    { key: TILE_KEY_BLUE,   door: TILE_DOOR_BLUE,   name: 'blue' }
];

// =============================================================================
// ENTRY POINT
// =============================================================================

/**
 * Builds a complete zoned, gated level layout.
 *
 * @param {number} cols - Map width in tiles
 * @param {number} rows - Map height in tiles
 * @param {Object} [options]
 * @param {number} [options.keyCount=3] - Keys to gate the level with (capped at 3)
 * @param {number} [options.styleCount=1] - How many looks the renderer offers
 * @param {number} [options.baseStyle=0] - The look the start zone wears
 * @returns {Object|null} Layout, or null if no valid one could be built
 */
export function buildDoomLayout(cols, rows, options = {}) {
    const requestedKeys = Math.max(1, Math.min(options.keyCount ?? PROGRESSION.length, PROGRESSION.length));
    const styleCount = Math.max(1, options.styleCount ?? 1);
    const baseStyle = ((options.baseStyle ?? 0) % styleCount + styleCount) % styleCount;

    for (let attempt = 0; attempt < LAYOUT_CONFIG.MAX_ATTEMPTS; attempt++) {
        const layout = attemptLayout(cols, rows, requestedKeys, styleCount, baseStyle);
        if (layout) return layout;
    }

    console.warn('buildDoomLayout: no valid zoned layout after', LAYOUT_CONFIG.MAX_ATTEMPTS, 'attempts');
    return null;
}

/**
 * One try at a zoned layout. Returns null the moment anything is unworkable,
 * because a partially-built level is cheaper to throw away than to repair.
 *
 * @param {number} cols - Map width in tiles
 * @param {number} rows - Map height in tiles
 * @param {number} requestedKeys - Preferred number of keys
 * @param {number} styleCount - How many looks the renderer offers
 * @param {number} baseStyle - The look the start zone wears
 * @returns {Object|null} Layout or null
 */
function attemptLayout(cols, rows, requestedKeys, styleCount, baseStyle) {
    const map = Array(rows).fill(null).map(() => Array(cols).fill(TILE_WALL));

    // Leave a solid border so nothing ever carves to the map edge.
    const bounds = { x: 1, y: 1, w: cols - 2, h: rows - 2 };

    const rects = splitIntoZones(bounds, requestedKeys + 1);
    if (rects.length < 2) return null;

    const order = orderZones(rects);
    if (!order) return null;

    const zones = order.map((entry, index) => ({
        id: index,
        rect: rects[entry.index],
        parent: entry.parent,      // Zone id (progression index), or -1 for the start
        rooms: [],
        edges: [],
        gate: null                 // Filled in for every zone except the start
    }));

    // --- Rooms -----------------------------------------------------------
    let nextRoomId = 0;
    for (const zone of zones) {
        zone.rooms = generateZoneRooms(zone, () => nextRoomId++);
        if (zone.rooms.length < LAYOUT_CONFIG.MIN_ROOMS_PER_ZONE) return null;
        for (const room of zone.rooms) carveRoomFloor(map, room);
    }

    // --- Corridors inside each zone --------------------------------------
    for (const zone of zones) {
        zone.edges = connectZoneRooms(map, zone);
    }

    // --- Gates between zones ---------------------------------------------
    for (const zone of zones) {
        if (zone.parent < 0) continue;

        const parent = zones[zone.parent];
        const adjacency = zoneAdjacency(parent.rect, zone.rect);
        if (!adjacency) return null;

        const gate = carveGate(map, parent, zone, adjacency);
        if (!gate) return null;

        zone.gate = gate;
    }

    // --- Looks ------------------------------------------------------------
    assignZoneStyles(zones, styleCount, baseStyle);

    // --- Mission roles ----------------------------------------------------
    const roles = assignRoles(zones);
    if (!roles) return null;

    // --- Commit the mission to the map -----------------------------------
    const keyCount = zones.length - 1;

    for (let i = 0; i < keyCount; i++) {
        if (!placeTileInRoom(map, roles.keyRooms[i], PROGRESSION[i].key)) return null;
        // The gate into zone i+1 is what key i opens.
        stampDoor(map, zones[i + 1].gate, PROGRESSION[i].door);
    }

    if (!placeTileInRoom(map, roles.exitRoom, TILE_EXIT)) return null;

    const allRooms = zones.flatMap(zone => zone.rooms);

    return {
        map,
        rooms: allRooms,
        zones,
        keyCount,
        playerStart: { r: roles.startRoom.center.y, c: roles.startRoom.center.x },
        playerStartRoom: roles.startRoom,
        keyRooms: roles.keyRooms,
        exitRoom: roles.exitRoom,
        gates: zones.filter(zone => zone.gate).map(zone => zone.gate),
        reservedTiles: collectGutterTiles(bounds, rects),
        zoneStyles: zones.map(zone => zone.styleIndex),
        tileStyles: buildTileStyleMap(cols, rows, zones)
    };
}

// =============================================================================
// ZONE PARTITIONING
// =============================================================================

/**
 * Recursively splits the playable rectangle into disjoint zone rectangles with
 * solid gutters between them. Always splits the largest remaining rectangle, so
 * the zones come out a similar size rather than one huge zone and three slivers.
 *
 * @param {Object} bounds - Playable area {x, y, w, h}
 * @param {number} target - Desired zone count
 * @returns {Array<Object>} Zone rectangles (may be fewer than requested)
 */
function splitIntoZones(bounds, target) {
    let rects = [{ ...bounds }];

    while (rects.length < target) {
        const byAreaDesc = rects
            .map((rect, index) => index)
            .sort((a, b) => (rects[b].w * rects[b].h) - (rects[a].w * rects[a].h));

        let split = false;
        for (const index of byAreaDesc) {
            const halves = splitRect(rects[index]);
            if (halves) {
                rects.splice(index, 1, halves[0], halves[1]);
                split = true;
                break;
            }
        }

        // Nothing left is big enough to divide; run with what we have.
        if (!split) break;
    }

    return rects;
}

/**
 * Splits one rectangle in two along its longer axis, leaving a gutter.
 *
 * @param {Object} rect - Rectangle to split
 * @returns {Array<Object>|null} The two halves, or null if it is too small
 */
function splitRect(rect) {
    const gutter = LAYOUT_CONFIG.ZONE_GUTTER;
    const min = LAYOUT_CONFIG.MIN_ZONE_SPAN;

    const canSplitVertically = rect.w >= min * 2 + gutter;
    const canSplitHorizontally = rect.h >= min * 2 + gutter;
    if (!canSplitVertically && !canSplitHorizontally) return null;

    const vertical = canSplitVertically && (!canSplitHorizontally || rect.w >= rect.h);

    if (vertical) {
        const left = randomInt(min, rect.w - gutter - min);
        return [
            { x: rect.x, y: rect.y, w: left, h: rect.h },
            { x: rect.x + left + gutter, y: rect.y, w: rect.w - left - gutter, h: rect.h }
        ];
    }

    const top = randomInt(min, rect.h - gutter - min);
    return [
        { x: rect.x, y: rect.y, w: rect.w, h: top },
        { x: rect.x, y: rect.y + top + gutter, w: rect.w, h: rect.h - top - gutter }
    ];
}

/**
 * Works out whether two zone rectangles face each other across a gutter, and if
 * so where a crossing could go.
 *
 * BSP guarantees that any two rectangles which touch are separated by exactly
 * one gutter's width, so an exact comparison is the right test here.
 *
 * @param {Object} a - First zone rectangle
 * @param {Object} b - Second zone rectangle
 * @returns {Object|null} {axis, low, high, gutterStart, from, to} or null
 */
function zoneAdjacency(a, b) {
    const gutter = LAYOUT_CONFIG.ZONE_GUTTER;
    const minOverlap = LAYOUT_CONFIG.MIN_ZONE_OVERLAP;

    const yLow = Math.max(a.y, b.y);
    const yHigh = Math.min(a.y + a.h, b.y + b.h);
    if (yHigh - yLow >= minOverlap) {
        if (b.x - (a.x + a.w) === gutter) {
            return { axis: 'x', low: a, high: b, gutterStart: a.x + a.w, from: yLow, to: yHigh - 1 };
        }
        if (a.x - (b.x + b.w) === gutter) {
            return { axis: 'x', low: b, high: a, gutterStart: b.x + b.w, from: yLow, to: yHigh - 1 };
        }
    }

    const xLow = Math.max(a.x, b.x);
    const xHigh = Math.min(a.x + a.w, b.x + b.w);
    if (xHigh - xLow >= minOverlap) {
        if (b.y - (a.y + a.h) === gutter) {
            return { axis: 'y', low: a, high: b, gutterStart: a.y + a.h, from: xLow, to: xHigh - 1 };
        }
        if (a.y - (b.y + b.h) === gutter) {
            return { axis: 'y', low: b, high: a, gutterStart: b.y + b.h, from: xLow, to: xHigh - 1 };
        }
    }

    return null;
}

/**
 * Puts the zone rectangles into progression order, choosing which already-placed
 * zone each new one hangs off. Every zone after the first must border its parent,
 * because the gate corridor has to cross a single shared gutter.
 *
 * @param {Array<Object>} rects - Zone rectangles
 * @returns {Array<Object>|null} [{index, parent}] in progression order, or null
 */
function orderZones(rects) {
    const count = rects.length;
    const neighbours = rects.map(() => []);

    for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
            if (zoneAdjacency(rects[i], rects[j])) {
                neighbours[i].push(j);
                neighbours[j].push(i);
            }
        }
    }

    // Any zone can be the start; try them in a random order so levels do not all
    // begin in the same corner of the map.
    for (const start of shuffleArray(rects.map((_, index) => index))) {
        const order = growOrder(start, count, neighbours);
        if (order) return order;
    }

    return null;
}

/**
 * Grows a progression order outwards from a starting zone.
 *
 * @param {number} start - Index of the starting rectangle
 * @param {number} count - Total rectangles
 * @param {Array<Array<number>>} neighbours - Adjacency lists
 * @returns {Array<Object>|null} Order covering every rectangle, or null
 */
function growOrder(start, count, neighbours) {
    const order = [{ index: start, parent: -1 }];
    const placedAt = new Map([[start, 0]]);

    while (order.length < count) {
        const options = [];
        for (const [rectIndex, position] of placedAt) {
            for (const neighbour of neighbours[rectIndex]) {
                if (!placedAt.has(neighbour)) options.push({ index: neighbour, parent: position });
            }
        }
        if (options.length === 0) return null;

        // Usually extend the chain from the newest zone; occasionally hang the new
        // zone off an older one so its key has to be walked back across the level.
        const newest = order.length - 1;
        const continuations = options.filter(option => option.parent === newest);
        const pick = (continuations.length > 0 && Math.random() < LAYOUT_CONFIG.CHAIN_BIAS)
            ? randomChoice(continuations)
            : randomChoice(options);

        placedAt.set(pick.index, order.length);
        order.push(pick);
    }

    return order;
}

// =============================================================================
// ZONE LOOKS
// =============================================================================

/**
 * Hands each zone a style index, with the rule that a zone never wears its
 * parent's look.
 *
 * Every gate is therefore a visible transition: pass the red door and the walls,
 * the floor and the liquid pooled in the rooms all change together. That is worth
 * more than decoration. It gives the player somewhere to file the memory -- the
 * yellow key was in the flooded part, the door back to the start was in the metal
 * part -- which is the whole reason Doom levels change texture set partway
 * through rather than dressing a level in one theme.
 *
 * Non-adjacent zones may repeat a look, and that is deliberate: with a handful of
 * styles, insisting they all differ would just push a level through every palette
 * it owns whether the palettes suited each other or not.
 *
 * @param {Array<Object>} zones - Zones in progression order
 * @param {number} styleCount - How many looks the renderer offers
 * @param {number} baseStyle - The look the start zone wears
 */
function assignZoneStyles(zones, styleCount, baseStyle) {
    zones[0].styleIndex = baseStyle;

    for (let i = 1; i < zones.length; i++) {
        const parentStyle = zones[zones[i].parent].styleIndex;

        const options = [];
        for (let style = 0; style < styleCount; style++) {
            if (style !== parentStyle) options.push(style);
        }

        // One style in the whole build: everything looks the same, and there is
        // nothing to be done about it.
        zones[i].styleIndex = options.length > 0 ? randomChoice(options) : parentStyle;
    }
}

/**
 * Builds the per-tile style lookup the renderer reads.
 *
 * Tiles between zones belong to no zone, and they are exactly the tiles the
 * player is looking at while walking through a gate. Handing them to the nearest
 * zone splits the two-tile gutter down the middle, so the wall on your left
 * changes texture as you pass the door rather than a step before or after it.
 *
 * @param {number} cols - Map width in tiles
 * @param {number} rows - Map height in tiles
 * @param {Array<Object>} zones - Zones, each carrying a styleIndex
 * @returns {Uint8Array} Style index per tile, indexed `y * cols + x`
 */
function buildTileStyleMap(cols, rows, zones) {
    const styles = new Uint8Array(cols * rows);

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            let best = zones[0];
            let bestDistance = Infinity;

            for (const zone of zones) {
                const r = zone.rect;
                // Chebyshev distance to the rectangle: zero inside it.
                const dx = Math.max(r.x - x, 0, x - (r.x + r.w - 1));
                const dy = Math.max(r.y - y, 0, y - (r.y + r.h - 1));
                const distance = Math.max(dx, dy);

                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = zone;
                    if (distance === 0) break;
                }
            }

            styles[y * cols + x] = best.styleIndex;
        }
    }

    return styles;
}

/**
 * Every playable tile that belongs to no zone -- the gutters. Nothing else may
 * carve here, or two zones would join up behind the gates' backs.
 *
 * @param {Object} bounds - Playable area
 * @param {Array<Object>} rects - Zone rectangles
 * @returns {Set<number>} Reserved tiles, encoded as y * 10000 + x
 */
function collectGutterTiles(bounds, rects) {
    const reserved = new Set();

    for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
        for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
            const inZone = rects.some(rect =>
                x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h);
            if (!inZone) reserved.add(y * 10000 + x);
        }
    }

    return reserved;
}

// =============================================================================
// ROOMS
// =============================================================================

/**
 * Fills one zone with rooms.
 *
 * The zone's interior is subdivided BSP-style into slots and one room is carved
 * into each, rather than throwing random rectangles at the zone and keeping the
 * ones that miss. Random darts leave a zone half solid rock: the first two rooms
 * land easily, and after that almost every dart clips something. Slots guarantee
 * the whole zone gets used, which is what stops a level reading as a few rooms
 * marooned in a quarry.
 *
 * Each room is inset randomly within its slot, so the sizes and the gaps between
 * them still vary -- the grid is scaffolding, not something the player can see.
 * The largest slot gets a room filling nearly all of it: every zone should have
 * one space big enough to actually fight a crowd in.
 *
 * @param {Object} zone - Zone being filled
 * @param {Function} nextId - Supplies unique room ids
 * @returns {Array<Object>} Rooms placed in this zone
 */
function generateZoneRooms(zone, nextId) {
    const margin = LAYOUT_CONFIG.ROOM_MARGIN;
    const interior = {
        x: zone.rect.x + margin,
        y: zone.rect.y + margin,
        w: zone.rect.w - margin * 2,
        h: zone.rect.h - margin * 2
    };

    const slots = subdivideIntoSlots(interior, LAYOUT_CONFIG.MAX_ROOMS_PER_ZONE);
    if (slots.length === 0) return [];

    // The roomiest slot becomes the zone's arena.
    let arenaIndex = 0;
    for (let i = 1; i < slots.length; i++) {
        if (slots[i].w * slots[i].h > slots[arenaIndex].w * slots[arenaIndex].h) arenaIndex = i;
    }

    const rooms = [];

    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const isArena = i === arenaIndex;

        // Every room keeps a clear tile inside its slot on each side, so two rooms
        // in neighbouring slots always have solid rock between them.
        const maxWidth = Math.min(slot.w - 2, isArena ? LAYOUT_CONFIG.ARENA_ROOM_SIZE : LAYOUT_CONFIG.MAX_ROOM_SIZE);
        const maxHeight = Math.min(slot.h - 2, isArena ? LAYOUT_CONFIG.ARENA_ROOM_SIZE : LAYOUT_CONFIG.MAX_ROOM_SIZE);
        if (maxWidth < LAYOUT_CONFIG.MIN_ROOM_SIZE || maxHeight < LAYOUT_CONFIG.MIN_ROOM_SIZE) continue;

        const minWidth = isArena ? Math.max(LAYOUT_CONFIG.MIN_ROOM_SIZE, maxWidth - 1) : LAYOUT_CONFIG.MIN_ROOM_SIZE;
        const minHeight = isArena ? Math.max(LAYOUT_CONFIG.MIN_ROOM_SIZE, maxHeight - 1) : LAYOUT_CONFIG.MIN_ROOM_SIZE;

        const width = randomInt(minWidth, maxWidth);
        const height = randomInt(minHeight, maxHeight);
        const x = randomInt(slot.x + 1, slot.x + slot.w - 1 - width);
        const y = randomInt(slot.y + 1, slot.y + slot.h - 1 - height);

        rooms.push({
            x, y, width, height,
            id: nextId(),
            zone: zone.id,
            isArena,
            role: 'transit',      // Overwritten by assignRoles for start/key/exit
            connected: true,
            center: { x: x + Math.floor(width / 2), y: y + Math.floor(height / 2) }
        });
    }

    return rooms;
}

/**
 * Subdivides a rectangle into room-sized slots, always cutting the largest one so
 * the slots stay a similar size.
 *
 * @param {Object} area - Rectangle to divide
 * @param {number} maxSlots - Upper bound on slot count
 * @returns {Array<Object>} Slot rectangles
 */
function subdivideIntoSlots(area, maxSlots) {
    // A slot has to hold the smallest room plus its one-tile inset on both sides.
    const minSlot = LAYOUT_CONFIG.MIN_ROOM_SIZE + 2;
    if (area.w < minSlot || area.h < minSlot) return [];

    const slots = [{ ...area }];

    while (slots.length < maxSlots) {
        const byAreaDesc = slots.map((_, index) => index)
            .sort((a, b) => (slots[b].w * slots[b].h) - (slots[a].w * slots[a].h));

        let split = false;
        for (const index of byAreaDesc) {
            const halves = splitSlot(slots[index], minSlot);
            if (halves) {
                slots.splice(index, 1, halves[0], halves[1]);
                split = true;
                break;
            }
        }
        if (!split) break;
    }

    return slots;
}

/**
 * Cuts one slot in two along its longer axis, if it is big enough.
 *
 * @param {Object} slot - Slot to cut
 * @param {number} minSlot - Smallest permitted slot span
 * @returns {Array<Object>|null} The two halves, or null
 */
function splitSlot(slot, minSlot) {
    const canSplitVertically = slot.w >= minSlot * 2;
    const canSplitHorizontally = slot.h >= minSlot * 2;
    if (!canSplitVertically && !canSplitHorizontally) return null;

    const vertical = canSplitVertically && (!canSplitHorizontally || slot.w >= slot.h);

    if (vertical) {
        const left = randomInt(minSlot, slot.w - minSlot);
        return [
            { x: slot.x, y: slot.y, w: left, h: slot.h },
            { x: slot.x + left, y: slot.y, w: slot.w - left, h: slot.h }
        ];
    }

    const top = randomInt(minSlot, slot.h - minSlot);
    return [
        { x: slot.x, y: slot.y, w: slot.w, h: top },
        { x: slot.x, y: slot.y + top, w: slot.w, h: slot.h - top }
    ];
}

/**
 * Carves a room's floor.
 *
 * @param {Array} map - 2D map array
 * @param {Object} room - Room to carve
 */
function carveRoomFloor(map, room) {
    for (let r = room.y; r < room.y + room.height; r++) {
        for (let c = room.x; c < room.x + room.width; c++) {
            map[r][c] = TILE_EMPTY;
        }
    }
}

// =============================================================================
// CORRIDORS
// =============================================================================

/**
 * Connects every room in a zone, then adds a loop or two.
 *
 * A minimum spanning tree alone makes every side room a dead end; Doom's areas
 * loop back on themselves so you can run a circle around a fight. The extra
 * edges cost nothing structurally because they never leave the zone.
 *
 * @param {Array} map - 2D map array
 * @param {Object} zone - Zone whose rooms should be joined
 * @returns {Array<Array<number>>} Edges as pairs of indices into zone.rooms
 */
function connectZoneRooms(map, zone) {
    const rooms = zone.rooms;
    const edges = [];
    if (rooms.length < 2) return edges;

    // Prim's algorithm over room centres.
    const inTree = new Set([0]);
    while (inTree.size < rooms.length) {
        let best = null;
        let bestDistance = Infinity;

        for (const from of inTree) {
            for (let to = 0; to < rooms.length; to++) {
                if (inTree.has(to)) continue;
                const distance = Math.hypot(
                    rooms[from].center.x - rooms[to].center.x,
                    rooms[from].center.y - rooms[to].center.y
                );
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = [from, to];
                }
            }
        }

        if (!best) break;
        inTree.add(best[1]);
        edges.push(best);
        carveCorridorBetween(map, rooms[best[0]], rooms[best[1]], zone.rect);
    }

    // Loop edges: the shortest connections that are not already in the tree.
    const candidates = [];
    for (let a = 0; a < rooms.length; a++) {
        for (let b = a + 1; b < rooms.length; b++) {
            if (edges.some(([i, j]) => (i === a && j === b) || (i === b && j === a))) continue;
            candidates.push({
                a, b,
                distance: Math.hypot(
                    rooms[a].center.x - rooms[b].center.x,
                    rooms[a].center.y - rooms[b].center.y
                )
            });
        }
    }
    candidates.sort((p, q) => p.distance - q.distance);

    let added = 0;
    for (const candidate of candidates) {
        if (added >= Math.floor(rooms.length * LAYOUT_CONFIG.LOOP_EDGES_PER_ROOM)) break;
        if (Math.random() >= LAYOUT_CONFIG.LOOP_EDGE_CHANCE) continue;

        edges.push([candidate.a, candidate.b]);
        carveCorridorBetween(map, rooms[candidate.a], rooms[candidate.b], zone.rect);
        added++;
    }

    return edges;
}

/**
 * Carves a two-wide L-shaped corridor between two rooms, clamped to a bounding
 * rectangle so it can never wander into a neighbouring zone.
 *
 * @param {Array} map - 2D map array
 * @param {Object} from - Room to start from
 * @param {Object} to - Room to end at
 * @param {Object} bounds - Rectangle the corridor must stay inside
 */
function carveCorridorBetween(map, from, to, bounds) {
    const width = LAYOUT_CONFIG.CORRIDOR_WIDTH;
    const start = corridorAnchor(from, to.center, width);
    const end = corridorAnchor(to, from.center, width);
    stampPath(map, lShapedPath(start, end, Math.random() < 0.5), width, bounds);
}

/**
 * Picks the top-left corner of the corridor's cross-section where it meets a
 * room, aimed at a target point and clamped so the whole width lands on floor.
 *
 * @param {Object} room - Room the corridor attaches to
 * @param {Object} target - Point the corridor is heading for
 * @param {number} width - Corridor width
 * @returns {Object} Anchor point {x, y}
 */
function corridorAnchor(room, target, width) {
    return {
        x: clamp(target.x, room.x, room.x + room.width - width),
        y: clamp(target.y, room.y, room.y + room.height - width)
    };
}

/**
 * The cells of an L-shaped walk between two points.
 *
 * @param {Object} from - Start point
 * @param {Object} to - End point
 * @param {boolean} horizontalFirst - Turn order
 * @returns {Array<Object>} Cells along the path
 */
function lShapedPath(from, to, horizontalFirst) {
    const path = [];
    let x = from.x;
    let y = from.y;
    path.push({ x, y });

    const runX = () => { while (x !== to.x) { x += Math.sign(to.x - x); path.push({ x, y }); } };
    const runY = () => { while (y !== to.y) { y += Math.sign(to.y - y); path.push({ x, y }); } };

    if (horizontalFirst) { runX(); runY(); } else { runY(); runX(); }
    return path;
}

/**
 * Widens a path into a corridor by stamping a width x width block at every cell.
 *
 * Only walls are converted, so a corridor running through an already-carved room
 * leaves its floor, obstacles and items alone.
 *
 * @param {Array} map - 2D map array
 * @param {Array<Object>} path - Cells to stamp
 * @param {number} width - Corridor width
 * @param {Object} bounds - Rectangle the corridor must stay inside
 */
function stampPath(map, path, width, bounds) {
    for (const cell of path) {
        for (let dy = 0; dy < width; dy++) {
            for (let dx = 0; dx < width; dx++) {
                const x = cell.x + dx;
                const y = cell.y + dy;
                if (x < bounds.x || x >= bounds.x + bounds.w) continue;
                if (y < bounds.y || y >= bounds.y + bounds.h) continue;
                if (map[y][x] === TILE_WALL) map[y][x] = TILE_EMPTY;
            }
        }
    }
}

// =============================================================================
// GATES
// =============================================================================

/**
 * Carves the single corridor joining a parent zone to a child zone, and records
 * where the locked door goes.
 *
 * The crossing is the only opening in the gutter between these two zones, and
 * the door spans its full width, so the door is a genuine cut vertex: there is
 * no way into the child zone that does not pass through it.
 *
 * @param {Array} map - 2D map array
 * @param {Object} parent - Zone on the already-reachable side
 * @param {Object} child - Zone being gated
 * @param {Object} adjacency - Result of zoneAdjacency for the two rectangles
 * @returns {Object|null} Gate description, or null if the border is unusable
 */
function carveGate(map, parent, child, adjacency) {
    const width = LAYOUT_CONFIG.CORRIDOR_WIDTH;
    const gutter = LAYOUT_CONFIG.ZONE_GUTTER;

    // Keep a tile of margin at both ends of the shared border, so two gates in
    // the same gutter can never end up touching each other.
    const first = adjacency.from + 1;
    const last = adjacency.to - width;
    if (last < first) return null;

    const line = randomInt(first, last);
    const horizontal = adjacency.axis === 'x';

    // Carve the crossing itself, straight through the gutter.
    const doorTiles = [];
    for (let step = 0; step < gutter; step++) {
        for (let offset = 0; offset < width; offset++) {
            const x = horizontal ? adjacency.gutterStart + step : line + offset;
            const y = horizontal ? line + offset : adjacency.gutterStart + step;
            map[y][x] = TILE_EMPTY;
            if (step === 0) doorTiles.push({ x, y });
        }
    }

    // Mouths: the cross-section where the crossing meets each zone's own rock.
    const lowMouth = horizontal
        ? { x: adjacency.low.x + adjacency.low.w - width, y: line }
        : { x: line, y: adjacency.low.y + adjacency.low.h - width };
    const highMouth = horizontal
        ? { x: adjacency.high.x, y: line }
        : { x: line, y: adjacency.high.y };

    const lowIsParent = adjacency.low === parent.rect;
    const parentMouth = lowIsParent ? lowMouth : highMouth;
    const childMouth = lowIsParent ? highMouth : lowMouth;

    const outerRoom = nearestRoom(parent.rooms, parentMouth);
    const innerRoom = nearestRoom(child.rooms, childMouth);
    if (!outerRoom || !innerRoom) return null;

    // Run each side's approach corridor inside its own zone rectangle. The clamp
    // is what stops an approach from spilling across the gutter.
    stampPath(map, lShapedPath(parentMouth, corridorAnchor(outerRoom, parentMouth, width), horizontal),
              width, parent.rect);
    stampPath(map, lShapedPath(childMouth, corridorAnchor(innerRoom, childMouth, width), horizontal),
              width, child.rect);

    return { doorTiles, outerRoom, innerRoom, parentZone: parent.id, childZone: child.id };
}

/**
 * Writes a locked door across a gate's full cross-section.
 *
 * @param {Array} map - 2D map array
 * @param {Object} gate - Gate returned by carveGate
 * @param {number} doorTile - Door tile constant
 */
function stampDoor(map, gate, doorTile) {
    for (const tile of gate.doorTiles) {
        map[tile.y][tile.x] = doorTile;
    }
}

/**
 * The room whose centre is closest to a point.
 *
 * @param {Array<Object>} rooms - Rooms to search
 * @param {Object} point - Target point
 * @returns {Object|null} Closest room
 */
function nearestRoom(rooms, point) {
    let best = null;
    let bestDistance = Infinity;

    for (const room of rooms) {
        const distance = Math.hypot(room.center.x - point.x, room.center.y - point.y);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = room;
        }
    }

    return best;
}

// =============================================================================
// MISSION ROLES
// =============================================================================

/**
 * Decides where the player starts, where each key goes, and where the exit goes.
 *
 * The shape being aimed for, per zone, is: enter here -> wander -> hit the locked
 * door -> keep wandering -> find the key -> walk back to the door. Getting that
 * order right is the whole trick, and it is easy to get backwards: put the key at
 * the far end of the zone and the start wherever, and half the time the player
 * picks the key up on their way TO the door and never registers that the door was
 * locked at all.
 *
 * So the key is chosen first, as the room furthest from the door -- and only then
 * is the entrance chosen, as the room furthest from the key. Because the key
 * maximises distance from the door, no room can be further from the door than the
 * key is, the entrance included. The door is therefore never further away than the
 * key, whatever the zone's shape turned out to be.
 *
 * @param {Array<Object>} zones - Zones in progression order
 * @returns {Object|null} {startRoom, keyRooms, exitRoom} or null
 */
function assignRoles(zones) {
    const keyRooms = [];
    const keyCount = zones.length - 1;

    // --- The start zone: pick the key first, then start as far from it as possible.
    const startZone = zones[0];
    const startGateRooms = outboundGateRooms(zones, 0);

    let startRoom;
    if (startGateRooms.length > 0 && startZone.rooms.length > 1) {
        const key = furthestRoom(startZone, startGateRooms, startGateRooms) ||
                    furthestRoom(startZone, startGateRooms, []);
        if (!key) return null;

        startRoom = furthestRoom(startZone, [key], startGateRooms) ||
                    furthestRoom(startZone, [key], []);
        if (!startRoom) return null;

        if (keyCount > 0) {
            key.role = `key-${PROGRESSION[0].name}`;
            keyRooms.push(key);
        }
    } else {
        // A start zone with no outbound gate only happens on a one-zone level.
        startRoom = randomChoice(startZone.rooms);
        if (!startRoom) return null;
    }
    startRoom.role = 'start';

    // --- Every later zone: the player enters through its gate, so that is fixed.
    for (let i = keyRooms.length; i < keyCount; i++) {
        const zone = zones[i];
        const entry = i === 0 ? startRoom : zone.gate.innerRoom;
        const outbound = outboundGateRooms(zones, i);

        const room = furthestRoom(zone, [entry], outbound) ||
                     furthestRoom(zone, [entry], []) ||
                     zone.rooms.find(candidate => candidate !== entry);
        if (!room) return null;

        room.role = `key-${PROGRESSION[i].name}`;
        keyRooms.push(room);
    }

    // --- The exit sits at the far end of the last zone. Nothing is gated behind
    // it, so it is simply the longest walk from the door you came in through.
    const finalZone = zones[zones.length - 1];
    const finalEntry = finalZone.gate ? finalZone.gate.innerRoom : startRoom;
    const exitRoom = furthestRoom(finalZone, [finalEntry], []) ||
                     finalZone.rooms.find(room => room !== finalEntry);
    if (!exitRoom) return null;
    exitRoom.role = 'exit';

    return { startRoom, keyRooms, exitRoom };
}

/**
 * The rooms in a zone that a child zone's gate corridor hangs off -- the rooms
 * where the player will meet that zone's locked doors.
 *
 * @param {Array<Object>} zones - All zones
 * @param {number} zoneId - Zone to inspect
 * @returns {Array<Object>} Gate-hosting rooms
 */
function outboundGateRooms(zones, zoneId) {
    return zones
        .filter(zone => zone.gate && zone.gate.parentZone === zoneId)
        .map(zone => zone.gate.outerRoom);
}

/**
 * The room in a zone furthest from a set of origins, measured in corridor hops.
 *
 * Hop count matters more than straight-line distance: two rooms can be near each
 * other on the map and still be a long walk apart, and it is the walk the player
 * feels. Zones only hold a handful of rooms though, so hop counts tie constantly
 * -- straight-line distance breaks those ties, which is the difference between
 * "technically further" and "feels further".
 *
 * @param {Object} zone - Zone to search
 * @param {Array<Object>} origins - Rooms to measure from
 * @param {Array<Object>} avoid - Rooms to skip if there is any alternative
 * @returns {Object|null} Furthest acceptable room
 */
function furthestRoom(zone, origins, avoid) {
    const hops = hopDistances(zone, origins);

    let best = null;
    let bestHops = -1;
    let bestSpan = -1;

    for (let i = 0; i < zone.rooms.length; i++) {
        const room = zone.rooms[i];
        if (origins.includes(room)) continue;
        if (avoid.includes(room)) continue;
        if (hops[i] === Infinity) continue;

        const span = Math.min(...origins.map(origin =>
            Math.hypot(origin.center.x - room.center.x, origin.center.y - room.center.y)));

        if (hops[i] > bestHops || (hops[i] === bestHops && span > bestSpan)) {
            bestHops = hops[i];
            bestSpan = span;
            best = room;
        }
    }

    return best;
}

/**
 * Breadth-first hop counts from a set of rooms across a zone's corridor graph.
 *
 * @param {Object} zone - Zone whose edges form the graph
 * @param {Array<Object>} origins - Rooms to start from
 * @returns {Array<number>} Hop count per room index
 */
function hopDistances(zone, origins) {
    const distances = zone.rooms.map(() => Infinity);
    const queue = [];

    for (const origin of origins) {
        const index = zone.rooms.indexOf(origin);
        if (index >= 0) {
            distances[index] = 0;
            queue.push(index);
        }
    }

    for (let head = 0; head < queue.length; head++) {
        const current = queue[head];
        for (const [a, b] of zone.edges) {
            const next = a === current ? b : (b === current ? a : -1);
            if (next < 0 || distances[next] !== Infinity) continue;
            distances[next] = distances[current] + 1;
            queue.push(next);
        }
    }

    return distances;
}

// =============================================================================
// PLACEMENT + VERIFICATION
// =============================================================================

/**
 * Drops a tile on a random clear floor square inside a room.
 *
 * @param {Array} map - 2D map array
 * @param {Object} room - Room to place into
 * @param {number} tile - Tile constant to write
 * @returns {boolean} True if it was placed
 */
function placeTileInRoom(map, room, tile) {
    if (!room) return false;

    const candidates = [];
    for (let r = room.y; r < room.y + room.height; r++) {
        for (let c = room.x; c < room.x + room.width; c++) {
            if (map[r][c] === TILE_EMPTY) candidates.push({ r, c });
        }
    }

    if (candidates.length === 0) return false;

    const spot = randomChoice(candidates);
    map[spot.r][spot.c] = tile;
    return true;
}

/**
 * Walks the level the way a player would: flood out from the start, bank any key
 * found, flood again with the new key, and repeat until nothing new opens up.
 *
 * Unlike a plain connectivity check this respects locked doors, so it can tell
 * the difference between "the exit is on the map" and "the exit can be reached".
 *
 * @param {Array} map - 2D map array
 * @param {Object} start - Start tile {r, c}
 * @param {number} cols - Map width
 * @param {number} rows - Map height
 * @returns {boolean} True if the exit can be reached through legitimate play
 */
export function isSolvable(map, start, cols, rows) {
    if (!map || !start) return false;

    const held = { red: false, yellow: false, blue: false };

    for (let pass = 0; pass <= PROGRESSION.length; pass++) {
        const visited = new Set();
        const stack = [{ x: start.c, y: start.r }];
        let reachedExit = false;
        let gainedKey = false;

        while (stack.length > 0) {
            const { x, y } = stack.pop();
            if (x < 0 || x >= cols || y < 0 || y >= rows) continue;

            const code = y * cols + x;
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
        if (!gainedKey) return false;   // Stuck: nothing new opened up
    }

    return false;
}

/**
 * Confirms the level plays the way it was designed to.
 *
 * Solvability alone is not enough. A secret passage carved through a gutter, or
 * a corridor that leaked across a zone border, would leave the level completable
 * while quietly making a key optional -- the lock-and-key structure gone, the
 * exit a straight walk away. So every key is deleted in turn and the level must
 * become UNSOLVABLE each time. If it does not, that key gates nothing.
 *
 * @param {Array} map - 2D map array
 * @param {Object} start - Start tile {r, c}
 * @param {number} cols - Map width
 * @param {number} rows - Map height
 * @returns {boolean} True if the level is solvable and every key is load-bearing
 */
export function verifyProgression(map, start, cols, rows) {
    if (!isSolvable(map, start, cols, rows)) return false;

    for (const stage of PROGRESSION) {
        let present = false;
        const stripped = map.map(row => row.map(tile => {
            if (tile !== stage.key) return tile;
            present = true;
            return TILE_EMPTY;
        }));

        if (!present) continue;                 // Colour unused on this level
        if (isSolvable(stripped, start, cols, rows)) return false;
    }

    return true;
}

// =============================================================================
// SMALL HELPERS
// =============================================================================

/**
 * Clamps a value into a range.
 *
 * @param {number} value - Value to clamp
 * @param {number} low - Lower bound
 * @param {number} high - Upper bound
 * @returns {number} Clamped value
 */
function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
}
