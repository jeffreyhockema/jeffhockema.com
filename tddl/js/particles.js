/**
 * =============================================================================
 * PARTICLES AND DECALS
 * =============================================================================
 *
 * Small, short-lived things: embers lifting off lava, bubbles breaking on
 * sludge, the ring a boot leaves in water, and blood. None of it affects play.
 * It exists because a pool that only ripples is a picture of a pool, and a
 * monster that only flashes white when shot is a target rather than a body.
 *
 * Two layers, because the renderer has two. Anything that gives off light --
 * embers, sparks, the gas over sludge -- is drawn in the emissive pass, outside
 * the light mask, so it is visible in the dark the way the pools themselves
 * are. Everything else (water, blood) is drawn on the lit layer and is seen
 * only where the torch falls, like the things it lands on.
 *
 * Blood that stops moving becomes a decal: a stain on the floor that stays,
 * drawn under the entities, so a corridor you fought through looks fought
 * through. Decals are capped and the oldest go first.
 *
 * Leaf module: imports constants and terrain lookups only. The game calls
 * resetParticles() per level, updateParticles() per frame, and the renderer
 * calls drawDecals() and drawParticles() in the passes described above.
 */

import { TILE_SIZE, MAP_COLS, MAP_ROWS, TERRAIN, TILE_LAVA, TILE_TOXIC, TILE_WATER } from './constants.js';
import { isTerrainTile } from './terrain.js';

// =============================================================================
// TUNING
// =============================================================================

export const PARTICLES = {
    MAX: 700,                        // Hard cap on live particles
    DECAL_MAX: 240,                  // Blood stains kept on the floor

    AMBIENT_RANGE: TILE_SIZE * 22,   // Pools further than this from the player are quiet
    LAVA_EMBER_CHANCE: 0.03,         // Per lava tile per frame
    LAVA_SPARK_CHANCE: 0.004,        // A crackle: a burst of sparks
    TOXIC_BUBBLE_CHANCE: 0.014,      // Per sludge tile per frame
    TOXIC_WISP_CHANCE: 0.006,        // Gas lifting off the sludge
    WATER_GLINT_CHANCE: 0.008,       // A point of light on the surface

    WADE_INTERVAL: 7,                // Frames between ripples under a wading entity

    BLOOD_PER_HIT: 9,                // Droplets from an ordinary hit
    BLOOD_PER_DEATH: 26,             // Droplets from a kill
};

/** Blood as an `r,g,b` triple. Monsters may override it (see MONSTERS). */
export const BLOOD_RED = '178,16,20';

// =============================================================================
// STATE
// =============================================================================

/** Live particles. */
let particles = [];

/** Floor stains, oldest first. */
let decals = [];

/** Every terrain tile on the current map, so the ambient pass need not scan it. */
let pools = [];

/** Frame counter for cadenced effects. */
let tick = 0;

/**
 * Forgets everything and indexes the new map's pools.
 *
 * @param {number[][]|null} map - The level, or null to just clear
 */
export function resetParticles(map = null) {
    particles = [];
    decals = [];
    pools = [];
    tick = 0;

    if (!map) return;
    for (let r = 0; r < MAP_ROWS; r++) {
        const row = map[r];
        if (!row) continue;
        for (let c = 0; c < MAP_COLS; c++) {
            if (isTerrainTile(row[c])) pools.push({ c, r, type: row[c] });
        }
    }
}

/** @returns {Object[]} The live particles (read-only; for tests and the HUD) */
export function getParticles() {
    return particles;
}

/** @returns {Object[]} The floor decals (read-only) */
export function getDecals() {
    return decals;
}

// =============================================================================
// SPAWNING
// =============================================================================

/**
 * Adds a particle, unless the cap has been reached.
 *
 * @param {Object} p - Particle fields; `life` is copied to `maxLife`
 * @returns {Object|null} The particle, or null if dropped
 */
function add(p) {
    if (particles.length >= PARTICLES.MAX) return null;
    p.maxLife = p.life;
    particles.push(p);
    return p;
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

/**
 * An ember lifting off lava: drifts, wobbles and dims.
 *
 * @param {number} x
 * @param {number} y
 * @param {Object} palette - The lava palette
 */
export function spawnEmber(x, y, palette = TERRAIN[TILE_LAVA].palette) {
    add({
        kind: 'ember', layer: 'emissive',
        x, y, vx: rand(-0.25, 0.25), vy: rand(-0.55, -0.2),
        drag: 0.985, wobble: rand(0, Math.PI * 2),
        size: rand(1.2, 2.6), color: hexToRgb(Math.random() < 0.6 ? palette.hot : palette.ember),
        life: Math.round(rand(40, 85)),
    });
}

/**
 * A crackle: a handful of fast sparks from one point.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} [count]
 * @param {Object} [palette]
 */
export function spawnSparks(x, y, count = 6, palette = TERRAIN[TILE_LAVA].palette) {
    for (let i = 0; i < count; i++) {
        const angle = rand(0, Math.PI * 2);
        const speed = rand(1.2, 3.4);
        add({
            kind: 'spark', layer: 'emissive',
            x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.6,
            drag: 0.9, size: rand(0.8, 1.6), color: hexToRgb(palette.hot),
            life: Math.round(rand(10, 22)),
        });
    }
}

/**
 * A bubble swelling on sludge. When it bursts it leaves a wisp of gas.
 *
 * @param {number} x
 * @param {number} y
 * @param {Object} [palette]
 */
export function spawnBubble(x, y, palette = TERRAIN[TILE_TOXIC].palette) {
    add({
        kind: 'bubble', layer: 'emissive',
        x, y, vx: 0, vy: 0, drag: 1,
        size: rand(1.5, 3.5), grow: rand(0.05, 0.11), color: hexToRgb(palette.hot),
        palette, life: Math.round(rand(30, 60)),
    });
}

/**
 * Gas lifting off sludge: a faint blob that spreads and fades.
 *
 * @param {number} x
 * @param {number} y
 * @param {Object} [palette]
 */
export function spawnWisp(x, y, palette = TERRAIN[TILE_TOXIC].palette) {
    add({
        kind: 'wisp', layer: 'emissive',
        x, y, vx: rand(-0.12, 0.12), vy: rand(-0.3, -0.1), drag: 0.995,
        size: rand(3, 6), grow: rand(0.04, 0.08), color: hexToRgb(palette.ember),
        life: Math.round(rand(70, 130)),
    });
}

/**
 * A glint on water: a point of light that appears and goes.
 *
 * @param {number} x
 * @param {number} y
 * @param {Object} [palette]
 */
export function spawnGlint(x, y, palette = TERRAIN[TILE_WATER].palette) {
    add({
        kind: 'glint', layer: 'lit',
        x, y, vx: 0, vy: 0, drag: 1,
        size: rand(0.8, 1.6), color: hexToRgb(palette.ember),
        life: Math.round(rand(12, 26)),
    });
}

/**
 * A ring spreading out from a point on a liquid.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} tileType - Which liquid, for its colour
 * @param {number} [size] - Final radius
 */
export function spawnRipple(x, y, tileType, size = TILE_SIZE * 0.45) {
    const terrain = TERRAIN[tileType];
    if (!terrain) return;
    add({
        kind: 'ripple', layer: 'lit',
        x, y, vx: 0, vy: 0, drag: 1,
        size: 2, grow: (size - 2) / 28, color: hexToRgb(terrain.palette.ember),
        life: 28,
    });
}

/**
 * A splash: droplets thrown up from a liquid, plus a ring.
 *
 * Lava throws sparks instead, because what comes off molten rock is not a
 * droplet of anything you want on you.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} tileType - Which liquid
 * @param {number} [strength] - 1 for a footfall, more for a plunge
 */
export function spawnSplash(x, y, tileType, strength = 1) {
    const terrain = TERRAIN[tileType];
    if (!terrain) return;

    spawnRipple(x, y, tileType, TILE_SIZE * (0.35 + 0.25 * strength));

    if (tileType === TILE_LAVA) {
        spawnSparks(x, y, Math.round(4 * strength), terrain.palette);
        return;
    }

    const count = Math.round(5 * strength);
    for (let i = 0; i < count; i++) {
        const angle = rand(0, Math.PI * 2);
        const speed = rand(0.8, 2.2) * Math.sqrt(strength);
        add({
            kind: 'droplet', layer: 'lit',
            x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.8 * strength,
            drag: 0.92, size: rand(1, 2.2),
            color: hexToRgb(Math.random() < 0.5 ? terrain.palette.hot : terrain.palette.ember),
            life: Math.round(rand(14, 26)),
        });
    }
}

/**
 * Blood spraying from a hit, away from whatever caused it.
 *
 * Most of it follows the shot through; a little comes back toward the shooter,
 * because that is what an entry wound does and it is the part you see when you
 * are the one shooting.
 *
 * @param {number} x - Where the hit landed
 * @param {number} y
 * @param {number} angle - Direction the hit was travelling, in radians
 * @param {Object} [options]
 * @param {number} [options.amount] - Droplets
 * @param {string} [options.color] - An `r,g,b` triple
 * @param {number} [options.spread] - Cone half-angle in radians
 * @param {number} [options.speed] - Peak droplet speed
 */
export function spawnBlood(x, y, angle, options = {}) {
    const {
        amount = PARTICLES.BLOOD_PER_HIT,
        color = BLOOD_RED,
        spread = 0.55,
        speed = 3.2,
    } = options;

    for (let i = 0; i < amount; i++) {
        const back = Math.random() < 0.2;
        const direction = angle + (back ? Math.PI : 0) + rand(-spread, spread) * (back ? 1.6 : 1);
        const velocity = rand(0.4, 1) * speed * (back ? 0.45 : 1);
        add({
            kind: 'blood', layer: 'lit',
            x, y, vx: Math.cos(direction) * velocity, vy: Math.sin(direction) * velocity,
            drag: rand(0.86, 0.93), size: rand(0.9, 2.4), color,
            life: Math.round(rand(14, 34)),
        });
    }

    // A puff of mist at the wound itself, gone in a few frames.
    add({
        kind: 'mist', layer: 'lit',
        x, y, vx: Math.cos(angle) * 0.6, vy: Math.sin(angle) * 0.6, drag: 0.9,
        size: rand(3, 5), grow: 0.35, color,
        life: 9,
    });
}

/**
 * A kill: blood in every direction, and a bigger stain.
 *
 * @param {number} x
 * @param {number} y
 * @param {string} [color] - An `r,g,b` triple
 * @param {number} [scale] - Body size relative to an Imp
 */
export function spawnGore(x, y, color = BLOOD_RED, scale = 1) {
    const amount = Math.round(PARTICLES.BLOOD_PER_DEATH * scale);
    for (let i = 0; i < amount; i++) {
        const angle = rand(0, Math.PI * 2);
        const velocity = rand(0.6, 3.6) * Math.sqrt(scale);
        add({
            kind: 'blood', layer: 'lit',
            x, y, vx: Math.cos(angle) * velocity, vy: Math.sin(angle) * velocity,
            drag: rand(0.85, 0.92), size: rand(1, 3) * Math.sqrt(scale), color,
            life: Math.round(rand(16, 40)),
        });
    }
    addDecal(x, y, rand(5, 8) * scale, color, 0.75);
}

/**
 * Dust and grit shaken loose: a wall has just moved.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} [count]
 */
export function spawnDust(x, y, count = 8) {
    for (let i = 0; i < count; i++) {
        const angle = rand(0, Math.PI * 2);
        const speed = rand(0.3, 1.4);
        add({
            kind: 'dust', layer: 'lit',
            x: x + rand(-14, 14), y: y + rand(-14, 14),
            vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.2,
            drag: 0.94, size: rand(2.5, 5), grow: 0.08, color: '150,140,125',
            life: Math.round(rand(24, 48)),
        });
    }
}

/**
 * Smoke: dark, slow, spreading, from something that has just burned.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} [count]
 */
export function spawnSmoke(x, y, count = 8) {
    for (let i = 0; i < count; i++) {
        const angle = rand(0, Math.PI * 2);
        const speed = rand(0.2, 0.9);
        add({
            kind: 'dust', layer: 'lit',
            x: x + rand(-10, 10), y: y + rand(-10, 10),
            vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.45,
            drag: 0.96, size: rand(4, 8), grow: 0.16, color: '40,38,36',
            life: Math.round(rand(40, 80)),
        });
    }
}

/**
 * Doom's teleport fog:a burst of green light where something has just
 * arrived, rising and gone in a second.
 *
 * @param {number} x
 * @param {number} y
 */
export function spawnTeleportFog(x, y) {
    add({
        kind: 'fog', layer: 'emissive',
        x, y, vx: 0, vy: 0, drag: 1,
        size: 6, grow: 1.1, color: '90,255,120',
        life: 22,
    });
    for (let i = 0; i < 18; i++) {
        const angle = rand(0, Math.PI * 2);
        const speed = rand(0.5, 2.4);
        add({
            kind: 'spark', layer: 'emissive',
            x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 1.2,
            drag: 0.93, size: rand(0.8, 1.8), color: '120,255,140',
            life: Math.round(rand(14, 30)),
        });
    }
}

/**
 * A stain on the floor.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} r - Radius
 * @param {string} color - An `r,g,b` triple
 * @param {number} [alpha]
 */
export function addDecal(x, y, r, color, alpha = 0.6) {
    if (decals.length >= PARTICLES.DECAL_MAX) decals.shift();
    decals.push({
        x, y, r, color, alpha,
        rx: rand(0.7, 1.3), ry: rand(0.7, 1.3), rot: rand(0, Math.PI),
    });
}

// =============================================================================
// UPDATE
// =============================================================================

/**
 * Advances every particle a frame and runs the ambient emitters.
 *
 * @param {Object} gameState - Needs gameMap, player, enemies
 */
export function updateParticles(gameState) {
    tick++;
    if (gameState?.gameMap) {
        emitAmbient(gameState);
        emitWading(gameState);
    }
    integrate();
}

/**
 * The pools near the player breathe: embers, bubbles, gas, glints.
 *
 * @param {Object} gameState
 */
function emitAmbient(gameState) {
    const player = gameState.player;
    if (!player) return;

    const range = PARTICLES.AMBIENT_RANGE;
    const rangeSq = range * range;
    const map = gameState.gameMap;

    for (let i = 0; i < pools.length; i++) {
        const pool = pools[i];
        const cx = pool.c * TILE_SIZE + TILE_SIZE / 2;
        const cy = pool.r * TILE_SIZE + TILE_SIZE / 2;
        const dx = cx - player.x;
        const dy = cy - player.y;
        if (dx * dx + dy * dy > rangeSq) continue;

        // The map can change under the index (a pool is never removed, but be safe).
        const type = map[pool.r] ? map[pool.r][pool.c] : 0;
        if (type !== pool.type) continue;

        const px = pool.c * TILE_SIZE + rand(3, TILE_SIZE - 3);
        const py = pool.r * TILE_SIZE + rand(3, TILE_SIZE - 3);
        const roll = Math.random();

        if (type === TILE_LAVA) {
            if (roll < PARTICLES.LAVA_EMBER_CHANCE) spawnEmber(px, py);
            else if (roll < PARTICLES.LAVA_EMBER_CHANCE + PARTICLES.LAVA_SPARK_CHANCE) spawnSparks(px, py, 5);
        } else if (type === TILE_TOXIC) {
            if (roll < PARTICLES.TOXIC_BUBBLE_CHANCE) spawnBubble(px, py);
            else if (roll < PARTICLES.TOXIC_BUBBLE_CHANCE + PARTICLES.TOXIC_WISP_CHANCE) spawnWisp(px, py);
        } else if (type === TILE_WATER) {
            if (roll < PARTICLES.WATER_GLINT_CHANCE) spawnGlint(px, py);
        }
    }
}

/**
 * Anything moving through a pool disturbs it: a ring every few frames, and a
 * proper splash on the way in.
 *
 * @param {Object} gameState
 */
function emitWading(gameState) {
    const map = gameState.gameMap;
    const things = [];
    if (gameState.player) things.push(gameState.player);
    if (gameState.enemies) {
        for (const enemy of gameState.enemies) {
            if (!enemy.isDead && enemy.health > 0) things.push(enemy);
        }
    }

    for (const thing of things) {
        const tileX = Math.floor(thing.x / TILE_SIZE);
        const tileY = Math.floor(thing.y / TILE_SIZE);
        const type = map[tileY] ? map[tileY][tileX] : 0;
        const liquid = isTerrainTile(type) ? type : 0;

        // Entering a pool.
        if (liquid && thing.wadingTile !== liquid) {
            spawnSplash(thing.x, thing.y + thing.radius * 0.4, liquid, 1.6);
        }
        thing.wadingTile = liquid;

        if (!liquid || !thing.isMoving) continue;
        if ((tick + (thing.wadeOffset || 0)) % PARTICLES.WADE_INTERVAL !== 0) continue;

        const footY = thing.y + thing.radius * 0.4;
        if (liquid === TILE_LAVA) {
            spawnSparks(thing.x, footY, 2);
            spawnRipple(thing.x, footY, liquid, TILE_SIZE * 0.3);
        } else {
            spawnRipple(thing.x, footY, liquid, TILE_SIZE * 0.35);
            if (Math.random() < 0.35) spawnSplash(thing.x, footY, liquid, 0.5);
        }
    }
}

/**
 * Moves and ages every particle; retires the dead, and turns settled blood
 * into stains.
 */
function integrate() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];

        p.x += p.vx;
        p.y += p.vy;
        p.vx *= p.drag;
        p.vy *= p.drag;
        p.life--;

        switch (p.kind) {
            case 'ember':
                p.wobble += 0.18;
                p.x += Math.sin(p.wobble) * 0.25;
                break;
            case 'bubble':
            case 'wisp':
            case 'ripple':
            case 'mist':
            case 'dust':
            case 'fog':
                p.size += p.grow;
                break;
            case 'blood':
                // Settled: it is a stain now.
                if (p.life <= 0 || (Math.abs(p.vx) + Math.abs(p.vy)) < 0.12) {
                    addDecal(p.x, p.y, p.size * rand(0.8, 1.4), p.color, rand(0.35, 0.6));
                    p.life = 0;
                }
                break;
            default:
                break;
        }

        if (p.life <= 0) {
            if (p.kind === 'bubble') spawnWisp(p.x, p.y, p.palette);
            particles[i] = particles[particles.length - 1];
            particles.pop();
        }
    }
}

// =============================================================================
// DRAWING
// =============================================================================

/**
 * Draws the stains within a tile range. Under the entities, over the floor.
 *
 * @param {CanvasRenderingContext2D} ctx - World-transformed context
 * @param {{startCol: number, endCol: number, startRow: number, endRow: number}} bounds
 */
export function drawDecals(ctx, bounds) {
    if (decals.length === 0) return;

    const left = bounds.startCol * TILE_SIZE - TILE_SIZE;
    const right = bounds.endCol * TILE_SIZE + TILE_SIZE;
    const top = bounds.startRow * TILE_SIZE - TILE_SIZE;
    const bottom = bounds.endRow * TILE_SIZE + TILE_SIZE;

    ctx.save();
    for (const d of decals) {
        if (d.x < left || d.x > right || d.y < top || d.y > bottom) continue;
        ctx.fillStyle = `rgba(${d.color},${d.alpha})`;
        ctx.beginPath();
        ctx.ellipse(d.x, d.y, d.r * d.rx, d.r * d.ry, d.rot, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

/**
 * Draws the particles of one layer.
 *
 * @param {CanvasRenderingContext2D} ctx - World-transformed context
 * @param {'lit'|'emissive'} layer - Which pass this is
 * @param {(p: Object) => boolean} [visible] - Skips particles it rejects; the
 *        emissive pass is drawn outside the light mask, so it has to ask
 */
export function drawParticles(ctx, layer, visible = null) {
    if (particles.length === 0) return;

    ctx.save();
    if (layer === 'emissive') ctx.globalCompositeOperation = 'lighter';

    for (const p of particles) {
        if (p.layer !== layer) continue;
        if (visible && !visible(p)) continue;
        const t = Math.max(0, p.life / p.maxLife);

        switch (p.kind) {
            case 'ember': {
                const r = p.size * (0.4 + 0.6 * t);
                ctx.fillStyle = `rgba(${p.color},${0.9 * t})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
                ctx.fill();
                // A soft halo, so it reads as hot rather than as a dot
                ctx.fillStyle = `rgba(${p.color},${0.18 * t})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
                ctx.fill();
                break;
            }
            case 'spark': {
                ctx.strokeStyle = `rgba(${p.color},${t})`;
                ctx.lineWidth = p.size;
                ctx.beginPath();
                ctx.moveTo(p.x - p.vx * 1.5, p.y - p.vy * 1.5);
                ctx.lineTo(p.x, p.y);
                ctx.stroke();
                break;
            }
            case 'bubble': {
                // Swells, then bursts: the ring goes bright and wide in its last frames
                const bursting = t < 0.15;
                ctx.strokeStyle = `rgba(${p.color},${bursting ? 0.9 : 0.45})`;
                ctx.lineWidth = bursting ? 1.5 : 1;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * (bursting ? 1.6 : 1), 0, Math.PI * 2);
                ctx.stroke();
                ctx.fillStyle = `rgba(${p.color},0.12)`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
                break;
            }
            case 'wisp': {
                ctx.fillStyle = `rgba(${p.color},${0.16 * Math.sin(Math.PI * (1 - t))})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
                break;
            }
            case 'glint': {
                ctx.fillStyle = `rgba(255,255,255,${0.8 * Math.sin(Math.PI * (1 - t))})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
                break;
            }
            case 'ripple': {
                ctx.strokeStyle = `rgba(${p.color},${0.5 * t})`;
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.ellipse(p.x, p.y, p.size, p.size * 0.72, 0, 0, Math.PI * 2);
                ctx.stroke();
                break;
            }
            case 'droplet': {
                ctx.fillStyle = `rgba(${p.color},${0.9 * t})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * (0.5 + 0.5 * t), 0, Math.PI * 2);
                ctx.fill();
                break;
            }
            case 'blood': {
                ctx.fillStyle = `rgba(${p.color},${0.95})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
                break;
            }
            case 'mist': {
                ctx.fillStyle = `rgba(${p.color},${0.35 * t})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
                break;
            }
            case 'dust': {
                ctx.fillStyle = `rgba(${p.color},${0.3 * t})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
                break;
            }
            case 'fog': {
                // A bright core inside a wider, fainter bloom
                ctx.fillStyle = `rgba(${p.color},${0.55 * t})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = `rgba(${p.color},${0.18 * t})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * 2.2, 0, Math.PI * 2);
                ctx.fill();
                break;
            }
            default:
                break;
        }
    }

    ctx.restore();
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * '#RRGGBB' to 'r,g,b', memoised. Palette colours are hex; particle alpha is
 * per frame, so the triple is what the draw loop needs.
 *
 * @param {string} hex
 * @returns {string}
 */
const rgbCache = new Map();
export function hexToRgb(hex) {
    let rgb = rgbCache.get(hex);
    if (rgb) return rgb;

    const value = parseInt(hex.slice(1), 16);
    rgb = `${(value >> 16) & 255},${(value >> 8) & 255},${value & 255}`;
    rgbCache.set(hex, rgb);
    return rgb;
}
