/**
 * =============================================================================
 * EXPLODING BARRELS
 * =============================================================================
 *
 * Doom's barrels: a drum of something green that takes twenty points of
 * damage and then goes off, hurting everything within two tiles and setting
 * off any barrel beside it. Half of the joy of an early Doom level is a
 * pack of zombies standing next to a row of them.
 *
 * A barrel is an entity, not a tile: solid to bodies, in the way of shots,
 * but transparent to light and sight. It is shot with the same hit shapes
 * and collision pass as a monster (it has a hit shape and takeDamage), it
 * blocks the player and monsters through the same checks that keep them
 * apart, and its explosion is the same Explosion the rocket launcher makes,
 * which is what damages the next barrel along and sets the chain going.
 * There is a short fuse between being killed and going off, so a chain
 * reads as a chain rather than as one bang.
 *
 * Placement is at level generation, in small groups against the walls of
 * the rooms where barrels belong -- cargo bays, storerooms, plant rooms --
 * never beside a doorway or an item, and never on the first level.
 */

import { TILE_SIZE, MAP_COLS, MAP_ROWS, TILE_EMPTY, TILE_WALL } from './constants.js';
import { circleShape } from './hitbox.js';
import { Explosion } from './weapons.js';
import { unitsToPx, MONSTER_DAMAGE_SCALE } from './monsters.js';
import { spawnSparks, spawnEmber, spawnSmoke, addDecal } from './particles.js';
import { playBarrelExplosionSound } from './audio-system.js';

// =============================================================================
// TUNING
// =============================================================================

export const BARRELS = {
    MIN_LEVEL: 2,
    MAX_GROUPS: 5,                   // Per level
    GROUP_MIN: 2,
    GROUP_MAX: 4,
    HEALTH: 20,                      // info.c: MT_BARREL spawnhealth
    DAMAGE: 128,                     // A_Explode: P_RadiusAttack(thing, target, 128)
    BLAST_UNITS: 128,                // ...over 128 map units
    FUSE_FRAMES: 8,                  // Between the killing blow and the bang
    RADIUS: 12,                      // Collision radius in pixels
    ROOM_KINDS: { cargo: 5, storage: 5, plant: 3, forge: 2, barracks: 1, plain: 1, lab: 1 },
};

// =============================================================================
// THE BARREL
// =============================================================================

export class Barrel {
    /**
     * @param {number} x - World X
     * @param {number} y - World Y
     */
    constructor(x, y) {
        this.x = x;
        this.y = y;
        this.radius = BARRELS.RADIUS;
        this.maxHealth = BARRELS.HEALTH;
        this.health = this.maxHealth;
        this.hitTimer = 0;
        this.isDead = false;
        this.exploding = false;
        this.fuse = 0;
        this.bloodColor = null;          // Barrels do not bleed
        this.isBarrel = true;
    }

    /** @returns {Object} The drum, a little larger than its footprint */
    getHitShape() {
        return circleShape(this.x, this.y, this.radius + 2);
    }

    /**
     * @param {number} amount - Damage
     * @returns {boolean} True if this blow set it off
     */
    takeDamage(amount) {
        if (this.isDead || this.exploding) return false;
        this.health -= amount;
        this.hitTimer = 6;
        if (this.health <= 0) {
            this.health = 0;
            this.exploding = true;
            this.fuse = BARRELS.FUSE_FRAMES;
            return true;
        }
        return false;
    }

    /** Runs the fuse. */
    update() {
        if (this.hitTimer > 0) this.hitTimer--;
        if (!this.exploding || this.isDead) return;
        if (--this.fuse <= 0) this.explode();
    }

    /**
     * The bang: a blast that hurts everything in reach, barrels included,
     * with the fire, smoke and noise to go with it.
     */
    explode() {
        this.isDead = true;
        const gs = window.gameState;

        const blast = new Explosion(
            this.x, this.y, unitsToPx(BARRELS.BLAST_UNITS), 30, 'orange',
            BARRELS.DAMAGE * MONSTER_DAMAGE_SCALE, false
        );
        gs?.explosions?.push(blast);

        spawnSparks(this.x, this.y, 22);
        for (let i = 0; i < 8; i++) spawnEmber(this.x + (Math.random() - 0.5) * 16, this.y + (Math.random() - 0.5) * 16);
        spawnSmoke(this.x, this.y, 10);
        addDecal(this.x, this.y, 16, '20,18,16', 0.55);

        playBarrelExplosionSound(this);
        // Doom's barrels are loud: everything nearby hears it.
        gs?.noiseAlert?.(this.x, this.y);
    }

    /**
     * Draws the drum: a shadow, a green body with a rust band, the hazard
     * trefoil on the lid, and a white flash when hit.
     *
     * @param {CanvasRenderingContext2D} ctx - World-transformed context
     */
    draw(ctx) {
        if (this.isDead) return;
        const { x, y } = this;
        const r = this.radius;
        const flash = this.hitTimer > 0;
        const swell = this.exploding ? 1 + (1 - this.fuse / BARRELS.FUSE_FRAMES) * 0.25 : 1;

        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath(); ctx.ellipse(x + 3, y + 4, r * swell, r * 0.9 * swell, 0, 0, Math.PI * 2); ctx.fill();

        // Side ring, then the lid
        ctx.fillStyle = flash ? '#ffffff' : '#1f3b1c';
        ctx.beginPath(); ctx.arc(x, y + 2, r * swell, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = flash ? '#ffffff' : '#4f8a3c';
        ctx.beginPath(); ctx.arc(x, y - 1, r * swell, 0, Math.PI * 2); ctx.fill();
        // Rust band and rim
        ctx.strokeStyle = flash ? '#ffffff' : '#7a4a22';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y - 1, r * 0.72 * swell, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = flash ? '#ffffff' : '#122611';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y - 1, r * swell, 0, Math.PI * 2); ctx.stroke();
        // Highlight
        ctx.fillStyle = flash ? '#ffffff' : 'rgba(180,230,150,0.45)';
        ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.4, r * 0.3, 0, Math.PI * 2); ctx.fill();

        // The trefoil
        if (!flash) {
            ctx.fillStyle = '#e8c830';
            ctx.beginPath(); ctx.arc(x, y - 1, r * 0.42, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#1a1a10';
            for (let i = 0; i < 3; i++) {
                const a = -Math.PI / 2 + i * Math.PI * 2 / 3;
                ctx.beginPath();
                ctx.moveTo(x, y - 1);
                ctx.arc(x, y - 1, r * 0.4, a - 0.5, a + 0.5);
                ctx.closePath();
                ctx.fill();
            }
            ctx.fillStyle = '#e8c830';
            ctx.beginPath(); ctx.arc(x, y - 1, r * 0.12, 0, Math.PI * 2); ctx.fill();
        }

        // The green ooze at the seam, glowing faintly
        if (!flash) {
            ctx.fillStyle = 'rgba(140,255,90,0.55)';
            ctx.beginPath(); ctx.ellipse(x + r * 0.45, y + r * 0.55, 3, 1.8, 0.4, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
    }
}

// =============================================================================
// RUNTIME
// =============================================================================

/**
 * Runs the barrels a frame and clears the ones that have gone off.
 *
 * @param {Object} gameState - Needs barrels
 */
export function updateBarrels(gameState) {
    const barrels = gameState?.barrels;
    if (!barrels) return;
    for (let i = barrels.length - 1; i >= 0; i--) {
        barrels[i].update();
        if (barrels[i].isDead) {
            barrels[i] = barrels[barrels.length - 1];
            barrels.pop();
        }
    }
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

function isItem(t) {
    return t >= 6 && t <= 15;
}

/**
 * Plans a level's barrels: groups of two to four against the walls of the
 * rooms where barrels belong.
 *
 * @param {number[][]} map - The finished level
 * @param {Object[]} rooms - Room rectangles
 * @param {Object<number, string>} roomKinds - Room id -> kind
 * @param {Object|null} playerStartRoom - Never
 * @param {Object} [options]
 * @param {number} [options.level]
 * @param {() => number} [options.random]
 * @returns {Array<{x: number, y: number}>} World positions
 */
export function planBarrels(map, rooms, roomKinds, playerStartRoom, options = {}) {
    const { level = 1, random = Math.random } = options;
    if (!map || !rooms || level < BARRELS.MIN_LEVEL) return [];

    const weighted = [];
    for (const room of rooms) {
        if (room === playerStartRoom || room.role === 'start') continue;
        const weight = BARRELS.ROOM_KINDS[roomKinds[room.id]] || 0;
        for (let i = 0; i < weight; i++) weighted.push(room);
    }
    const chosen = [];
    for (const room of shuffle(weighted, random)) {
        if (chosen.length >= BARRELS.MAX_GROUPS) break;
        if (!chosen.includes(room)) chosen.push(room);
    }

    const positions = [];
    for (const room of chosen) {
        const spots = wallSpots(map, room);
        const touching = (a, b) => a !== b && Math.abs(a.c - b.c) <= 1 && Math.abs(a.r - b.r) <= 1;
        // A group is at least two, so it grows from a spot that has a neighbour
        const seeds = spots.filter(s => spots.some(o => touching(s, o)));
        if (seeds.length === 0) continue;
        const seed = seeds[Math.floor(random() * seeds.length)];
        const count = BARRELS.GROUP_MIN + Math.floor(random() * (BARRELS.GROUP_MAX - BARRELS.GROUP_MIN + 1));
        // Grow a compact cluster from the seed along the wall, nearest first
        const cluster = [seed];
        for (let i = 0; i < cluster.length && cluster.length < count; i++) {
            const next = spots.filter(o => !cluster.includes(o) && touching(cluster[i], o))
                .sort((a, b) => Math.hypot(a.c - seed.c, a.r - seed.r) - Math.hypot(b.c - seed.c, b.r - seed.r));
            for (const o of next) {
                if (cluster.length >= count) break;
                cluster.push(o);
            }
        }
        for (const t of cluster) positions.push({ x: t.c * TILE_SIZE + TILE_SIZE / 2, y: t.r * TILE_SIZE + TILE_SIZE / 2 });
    }
    return positions;
}

/**
 * Floor tiles along the inside of a room's walls where a barrel may stand:
 * plain floor, against a wall, two tiles clear of any item, a tile clear of
 * any doorway, and not on the room's centre line where the fighting is.
 */
function wallSpots(map, room) {
    const x1 = room.x + room.width - 1;
    const y1 = room.y + room.height - 1;
    const spots = [];
    for (let r = room.y; r <= y1; r++) {
        for (let c = room.x; c <= x1; c++) {
            if (tileAt(map, c, r) !== TILE_EMPTY) continue;
            const onEdge = c === room.x || c === x1 || r === room.y || r === y1;
            if (!onEdge) continue;
            // Against solid wall, not a doorway
            let solid = 0, open = 0;
            for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const t = tileAt(map, c + dc, r + dr);
                const outside = c + dc < room.x || c + dc > x1 || r + dr < room.y || r + dr > y1;
                if (!outside) continue;
                if (t === TILE_WALL) solid++; else open++;
            }
            if (solid === 0 || open > 0) continue;
            let clear = true;
            for (let dr = -2; dr <= 2 && clear; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                    const t = tileAt(map, c + dc, r + dr);
                    if (isItem(t)) { clear = false; break; }
                    const outside = c + dc < room.x || c + dc > x1 || r + dr < room.y || r + dr > y1;
                    if (outside && Math.abs(dc) <= 1 && Math.abs(dr) <= 1 && t !== undefined && t !== TILE_WALL) { clear = false; break; }
                }
            }
            if (clear) spots.push({ c, r });
        }
    }
    return spots;
}
