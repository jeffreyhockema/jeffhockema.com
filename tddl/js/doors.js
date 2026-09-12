/**
 * =============================================================================
 * DOORS
 * =============================================================================
 *
 * The keyed doors, as things that open and close rather than tiles that
 * vanish.
 *
 * A door starts LOCKED. Walking into it with the matching key unlocks it -- it
 * has to be touched once, the way a Doom door has to be used -- and from then
 * on it is an automatic door: it slides open whenever anyone comes near, the
 * two leaves parting from the seam between the tiles into the jambs, and it
 * slides shut again a moment after the last of them has gone. Monsters trip it
 * too, as Doom's monsters open doors, but only once it is unlocked; a locked
 * door is a wall to them.
 *
 * The door tiles never change type. What changes is the entry here, and the
 * things that used to ask "is this tile a door" (movement, line of sight,
 * light, bullets, sound) now ask "is this door open" instead. That is what
 * lets a door close again, and what lets light and sight pour through an open
 * one.
 *
 * Leaf module: constants only. It reports the sounds it wants played rather
 * than playing them, so the modules that depend on it stay free of audio.
 */

import {
    TILE_SIZE, MAP_COLS, MAP_ROWS,
    TILE_DOOR_RED, TILE_DOOR_YELLOW, TILE_DOOR_BLUE,
} from './constants.js';

// =============================================================================
// TUNING
// =============================================================================

export const DOORS = {
    OPEN_FRAMES: 22,                 // Frames for the leaves to slide fully open
    CLOSE_FRAMES: 30,                // ...and to slide shut, a little heavier
    TRIGGER_RANGE: TILE_SIZE * 2.4,  // How near something must come to open it
    PASSABLE_AT: 0.5,                // Openness at which the gap can be walked through
    CLOSE_DELAY: 45,                 // Frames of nobody near before it closes
};

// =============================================================================
// STATE
// =============================================================================

/** Every door on the level. */
let doors = [];

/** Tile code -> index into `doors`, or -1. */
let index = null;

/** Whether a tile value is one of the keyed doors. */
export function isKeyedDoorTile(tileType) {
    return tileType === TILE_DOOR_RED || tileType === TILE_DOOR_YELLOW || tileType === TILE_DOOR_BLUE;
}

/** The key colour a door tile wants. */
export function doorKeyName(tileType) {
    if (tileType === TILE_DOOR_RED) return 'red';
    if (tileType === TILE_DOOR_YELLOW) return 'yellow';
    if (tileType === TILE_DOOR_BLUE) return 'blue';
    return null;
}

/**
 * Forgets every door and finds the new level's.
 *
 * Doors are placed in matched pairs across a two-wide corridor; a pair is one
 * door with two tiles. A tile with no partner is a one-tile door.
 *
 * @param {number[][]|null} map - The level
 */
export function registerDoors(map) {
    doors = [];
    index = new Int16Array(MAP_COLS * MAP_ROWS).fill(-1);
    if (!map) return;

    for (let r = 0; r < MAP_ROWS; r++) {
        const row = map[r];
        if (!row) continue;
        for (let c = 0; c < MAP_COLS; c++) {
            const type = row[c];
            if (!isKeyedDoorTile(type) || index[r * MAP_COLS + c] >= 0) continue;

            const tiles = [{ c, r }];
            // Partner: same type, to the east or the south (the west and north
            // were visited first and would already have claimed this tile).
            if (row[c + 1] === type) tiles.push({ c: c + 1, r });
            else if (map[r + 1] && map[r + 1][c] === type) tiles.push({ c, r: r + 1 });

            const door = {
                id: doors.length,
                type,
                key: doorKeyName(type),
                tiles,
                unlocked: false,
                openness: 0,
                hold: 0,
                x: 0,
                y: 0,
            };
            door.x = (tiles.reduce((s, t) => s + t.c, 0) / tiles.length) * TILE_SIZE + TILE_SIZE / 2;
            door.y = (tiles.reduce((s, t) => s + t.r, 0) / tiles.length) * TILE_SIZE + TILE_SIZE / 2;

            for (const t of tiles) index[t.r * MAP_COLS + t.c] = door.id;
            doors.push(door);
        }
    }
}

/** Clears every door. */
export function resetDoors() {
    doors = [];
    index = null;
}

/** @returns {Object[]} Every door on the level */
export function getDoors() {
    return doors;
}

/**
 * @param {number} c - Tile column
 * @param {number} r - Tile row
 * @returns {Object|null} The door standing on that tile
 */
export function doorAtTile(c, r) {
    if (!index || c < 0 || c >= MAP_COLS || r < 0 || r >= MAP_ROWS) return null;
    const i = index[r * MAP_COLS + c];
    return i >= 0 ? doors[i] : null;
}

/**
 * Whether a door tile can currently be walked, seen and shot through.
 *
 * A tile that is no door at all is not "open"; callers check the tile type
 * first. A door tile the registry has not heard of (a map changed under it)
 * counts as shut.
 *
 * @param {number} c - Tile column
 * @param {number} r - Tile row
 * @returns {boolean} True if the gap is wide enough
 */
export function isDoorOpen(c, r) {
    const door = doorAtTile(c, r);
    return !!door && door.unlocked && door.openness >= DOORS.PASSABLE_AT;
}

/**
 * Unlocks the door on a tile. The first touch with the key.
 *
 * @param {number} c - Tile column
 * @param {number} r - Tile row
 * @returns {Object|null} The door if this call unlocked it, else null
 */
export function unlockDoorAt(c, r) {
    const door = doorAtTile(c, r);
    if (!door || door.unlocked) return null;
    door.unlocked = true;
    door.hold = DOORS.CLOSE_DELAY;
    return door;
}

/**
 * Runs every door a frame: opens for whoever is near, closes when they have
 * gone, never on top of anyone.
 *
 * @param {Object} gameState - Needs player and enemies
 * @returns {Array<{kind: 'open'|'close', door: Object}>} Sounds to play
 */
export function updateDoors(gameState) {
    const events = [];
    if (doors.length === 0) return events;

    const things = [];
    const player = gameState?.player;
    if (player && player.health > 0) things.push(player);
    if (gameState?.enemies) {
        for (const enemy of gameState.enemies) {
            if (!enemy.isDead && enemy.health > 0 && !enemy.dormant) things.push(enemy);
        }
    }

    const range = DOORS.TRIGGER_RANGE;

    for (const door of doors) {
        if (!door.unlocked) {
            door.openness = 0;
            continue;
        }

        let near = false;
        let inDoorway = false;
        for (const thing of things) {
            const dx = thing.x - door.x;
            const dy = thing.y - door.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < range * range) near = true;
            // Standing in the gap: the door must not shut on them.
            for (const t of door.tiles) {
                if (Math.abs(thing.x - (t.c * TILE_SIZE + TILE_SIZE / 2)) < TILE_SIZE / 2 + thing.radius &&
                    Math.abs(thing.y - (t.r * TILE_SIZE + TILE_SIZE / 2)) < TILE_SIZE / 2 + thing.radius) {
                    inDoorway = true;
                }
            }
        }

        if (near || inDoorway) door.hold = DOORS.CLOSE_DELAY;
        else if (door.hold > 0) door.hold--;

        const wantOpen = door.hold > 0 || inDoorway;
        const before = door.openness;

        if (wantOpen && door.openness < 1) {
            if (door.openness === 0) events.push({ kind: 'open', door });
            door.openness = Math.min(1, door.openness + 1 / DOORS.OPEN_FRAMES);
        } else if (!wantOpen && door.openness > 0) {
            if (door.openness === 1) events.push({ kind: 'close', door });
            door.openness = Math.max(0, door.openness - 1 / DOORS.CLOSE_FRAMES);
        }

        door.moving = door.openness !== before;
    }

    return events;
}
