/**
 * WEAPONS AND PROJECTILES MODULE
 * 
 * This module handles all weapon systems, bullet physics, explosions, and special effects.
 * It includes the complete projectile system with different bullet types, collision detection,
 * area-of-effect damage, and advanced features like seeking projectiles and BFG tracers.
 * 
 * Features:
 * - Multiple bullet types (standard, rocket, BFG, seeking)
 * - Explosion system with area damage
 * - BFG tracer system for multi-target damage
 * - Bullet lifetime and collision management
 * - Visual effects for projectiles and explosions
 * 
 * @author TDDL Game Team
 * @version 1.0.0
 */

import { 
    TILE_SIZE, MAP_COLS, MAP_ROWS,
    TILE_WALL, TILE_DOOR_RED, TILE_DOOR_YELLOW, TILE_DOOR_BLUE, TILE_SECRET_DOOR, TILE_SWITCH, rollDice, ITEM_DRAW_SIZE,
} from './constants.js';
import { WEAPON_STATS } from './constants.js';
import { drawItemIcon, iconDrawSize,
} from './item-icons.js';
import { isPathClear, isSolidAt, blocksShotsAt,
} from './utils.js';
import { isTilePerceived } from './lighting.js';
import { 
    playBFGImpactSound, 
    playRocketExplosionSound 
} from './audio-system.js';
import { hitShapeOf, segmentHitsShape, segmentHitFraction, rayShapeDistance,
} from './hitbox.js';
import { spawnBlood } from './particles.js';

// =============================================================================
// HITSCAN
// =============================================================================

/**
 * P_LineAttack: walks a ray to the first wall, then finds the nearest
 * shootable thing in front of it. Shared by the player's guns, the monsters'
 * and the BFG's spray.
 *
 * @param {number} x - Ray origin X
 * @param {number} y - Ray origin Y
 * @param {number} angle - Ray direction in radians
 * @param {Object|null} [shooter] - Never hit by its own shot
 * @param {number} [maxRange] - MISSILERANGE: 32 tiles
 * @returns {{thing: Object|null, x: number, y: number, dist: number, wall: {c: number, r: number, tile: number|undefined}|null}}
 */
export function traceShot(x, y, angle, shooter = null, maxRange = TILE_SIZE * 32) {
    const gs = window.gameState;
    const map = gs?.gameMap;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    let wallDist = maxRange;
    let wall = null;
    if (map) {
        const step = TILE_SIZE / 4;
        for (let d = step; d <= maxRange; d += step) {
            const c = Math.floor((x + cos * d) / TILE_SIZE);
            const r = Math.floor((y + sin * d) / TILE_SIZE);
            if (c < 0 || c >= MAP_COLS || r < 0 || r >= MAP_ROWS || !map[r]) {
                wallDist = d;
                wall = { c, r, tile: undefined };
                break;
            }
            if (blocksShotsAt(map, c, r)) {
                wallDist = d;
                wall = { c, r, tile: map[r][c] };
                break;
            }
        }
    }

    let best = { thing: null, dist: wallDist };
    const consider = (thing) => {
        if (!thing || thing === shooter || thing.health <= 0 || thing.isDead || thing.dormant) return;
        const dist = rayShapeDistance(hitShapeOf(thing), x, y, cos, sin);
        if (dist < best.dist) best = { thing, dist };
    };

    consider(gs?.player);
    consider(gs?.currentBoss);
    const enemies = gs?.enemies;
    if (enemies) {
        for (let i = 0; i < enemies.length; i++) consider(enemies[i]);
    }
    const barrels = gs?.barrels;
    if (barrels) {
        for (let i = 0; i < barrels.length; i++) consider(barrels[i]);
    }

    return {
        thing: best.thing,
        x: x + cos * best.dist,
        y: y + sin * best.dist,
        dist: best.dist,
        wall: best.thing ? null : wall,
    };
}

// =============================================================================
// BULLET CLASS - CORE PROJECTILE SYSTEM
// =============================================================================

/**
 * Bullet class represents all projectiles in the game
 * Handles movement, collision detection, and special behaviors for different weapon types
 */
export class Bullet {
    /**
     * Creates a new bullet instance
     * 
     * @param {number} x - Starting X coordinate
     * @param {number} y - Starting Y coordinate
     * @param {number} angle - Firing angle in radians
     * @param {number} speed - Projectile speed in pixels per frame
     * @param {string} owner - Who fired this bullet ('player', 'enemy', 'boss')
     * @param {number} damage - Damage dealt on impact
     * @param {string} color - Projectile color (default: '#ffeb3b')
     * @param {boolean} isRocket - Whether this is a rocket with explosion (default: false)
     * @param {number} aoeRadius - Area-of-effect explosion radius (default: 0)
     * @param {number} explosionDuration - How long explosion animation lasts (default: 0)
     * @param {boolean} isBFG - Whether this is a BFG projectile (default: false)
     * @param {number} tracerDamage - Additional tracer damage for BFG (default: 0)
     * @param {boolean} isSeeking - Whether projectile homes in on targets (default: false)
     * @param {number} life - Frames before the projectile expires; 0 uses the default for its type
     * @param {number} radius - Projectile radius in pixels; 0 uses the default for its type
     */
    constructor(x, y, angle, speed, owner, damage, color = '#ffeb3b', isRocket = false, 
                aoeRadius = 0, explosionDuration = 0, isBFG = false, tracerDamage = 0, isSeeking = false,
                life = 0, radius = 0) {
        
        // Position and movement. `prev` is where the bullet was at the start
        // of the frame: collision tests the segment it travelled, not the point
        // it ended on, so a fast round cannot step over a thin target.
        this.x = x;
        this.y = y;
        this.prevX = x;
        this.prevY = y;
        this.angle = angle;
        this.initialSpeed = speed;
        this.dx = Math.cos(angle) * speed;    // X velocity component
        this.dy = Math.sin(angle) * speed;    // Y velocity component
        
        // Combat properties
        this.owner = owner;                   // Who fired this bullet
        this.damage = damage;                 // Damage dealt on impact
        
        // Visual properties. Monster projectiles used to be forced orange here;
        // now each monster's fireball has its own colour, as in Doom, where an
        // Imp's is orange, a Baron's green and a Cacodemon's red.
        this.color = color;

        // Who fired it, for infighting: a monster hit by another monster's
        // projectile turns on the shooter, and a projectile from a monster of
        // the same species bursts on it without damage. Set by the shooter.
        this.shooter = null;
        this.species = null;
        
        // Special weapon properties
        this.isRocket = isRocket;             // Rocket launcher projectile
        this.aoeRadius = aoeRadius;           // Explosion radius for rockets
        this.explosionDuration = explosionDuration; // Explosion animation length
        // The blast's own damage, as distinct from the impact's: Doom's rocket
        // does 20-160 to what it hits and a 128-point blast around it. Set by
        // createBullet; falls back to the impact damage.
        this.splashDamage = null;
        this.isBFGMainProjectile = isBFG;     // BFG main projectile
        this.tracerDamage = tracerDamage;     // BFG tracer damage (legacy flat value)
        this.tracerDice = null;               // A_BFGSpray: dice per ray
        this.tracerCount = 40;                // ...rays
        this.tracerConeDegrees = 90;          // ...across this fan
        this.isSeeking = isSeeking;           // Homing projectile
        
        // Physics properties
        // A weapon can override either, which is how the flamethrower gets its
        // short reach: the flames simply burn out after a fixed number of frames
        // rather than being range-checked against the player every update.
        // Doom's info.c radii, in pixels: MT_ROCKET and MT_BFG collide at 11
        // and 13 map units, an Imp-sized fireball at 6.
        this.radius = radius || (TILE_SIZE / 64) * (isRocket ? 11 : (this.isBFGMainProjectile ? 13 : 6));
        this.life = life || (isRocket ? 180 : (this.isBFGMainProjectile ? 200 : 120));
        
        // Seeking behavior setup
        if (isSeeking && (owner === 'boss' || owner === 'enemy') && window.gameState?.player) {
            this.seekTarget = window.gameState.player;
            this.turnRate = 0.03;             // How quickly seeking bullets can turn
        } else {
            this.seekTarget = null;
            this.turnRate = 0;
        }
    }

    /**
     * Renders the bullet on the canvas
     * Different bullet types have distinct visual representations
     * 
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     */
    draw(ctx) {
        ctx.fillStyle = this.color;

        // Special rendering for rockets and BFG projectiles
        if (this.isRocket || this.isBFGMainProjectile) {
            ctx.save();
            ctx.translate(this.x, this.y);

            // Rotate rockets and seeking projectiles to face their direction
            if (this.isRocket || this.isSeeking) {
                ctx.rotate(Math.atan2(this.dy, this.dx));
            }

            if (this.isBFGMainProjectile) {
                // BFG projectile: Large green orb with energy glow
                ctx.beginPath();
                ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
                ctx.fill();

                // Add outer glow effect
                ctx.fillStyle = 'rgba(200, 255, 200, 0.3)';
                ctx.beginPath();
                ctx.arc(0, 0, this.radius * 1.5, 0, Math.PI * 2);
                ctx.fill();
            } else {
                // Rocket projectile: Arrow-shaped missile
                ctx.beginPath();
                ctx.moveTo(-this.radius, -this.radius / 2);    // Back left
                ctx.lineTo(this.radius, 0);                     // Front point
                ctx.lineTo(-this.radius, this.radius / 2);      // Back right
                ctx.closePath();
                ctx.fill();
            }

            ctx.restore();
        } else {
            // Standard bullet: Simple circle
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    /**
     * Updates bullet position and handles collision detection
     * Called every frame to move the bullet and check for impacts
     */
    update() {
        // Handle seeking behavior for homing projectiles
        if (this.isSeeking && this.seekTarget && this.seekTarget.health > 0) {
            this.updateSeekingBehavior();
        }

        // Update position, remembering where this frame's travel began
        this.prevX = this.x;
        this.prevY = this.y;
        this.x += this.dx;
        this.y += this.dy;
        this.life--;

        // Check for wall collisions
        if (this.checkWallCollision()) {
            this.handleWallCollision();
            return;
        }

        // Handle bullet expiration
        if (this.life <= 0) {
            this.handleExpiration();
        }
    }

    /**
     * Updates seeking projectile behavior to home in on target
     * Gradually adjusts bullet trajectory toward the target
     */
    updateSeekingBehavior() {
        // Calculate angle to target
        const targetAngle = Math.atan2(
            this.seekTarget.y - this.y, 
            this.seekTarget.x - this.x
        );
        
        // Get current movement angle
        let currentAngle = Math.atan2(this.dy, this.dx);
        
        // Calculate shortest angular difference
        let angleDiff = targetAngle - currentAngle;
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
        
        // Gradually turn toward target
        if (Math.abs(angleDiff) > this.turnRate) {
            currentAngle += Math.sign(angleDiff) * this.turnRate;
        } else {
            currentAngle = targetAngle;
        }
        
        // Update velocity components
        this.dx = Math.cos(currentAngle) * this.initialSpeed;
        this.dy = Math.sin(currentAngle) * this.initialSpeed;
    }

    /**
     * Checks if bullet has collided with walls or doors
     * 
     * @returns {boolean} True if collision detected
     */
    checkWallCollision() {
        // Convert world position to tile coordinates
        const tileX = Math.floor(this.x / TILE_SIZE);
        const tileY = Math.floor(this.y / TILE_SIZE);

        // Check if bullet is outside map boundaries
        if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) {
            return true;
        }

        // Check if tile exists and is solid. An open door lets a shot through.
        const gameMap = window.gameState?.gameMap;
        if (gameMap && gameMap[tileY]) {
            const solid = blocksShotsAt(gameMap, tileX, tileY);
            // A switch can be shot, as Doom's could
            if (solid && this.owner === 'player' && gameMap[tileY][tileX] === TILE_SWITCH) {
                window.gameState?.pressSwitchAt?.(tileX, tileY);
            }
            return solid;
        }

        return false;
    }

    /**
     * Handles bullet collision with walls
     * Different bullet types have different collision behaviors
     */
    handleWallCollision() {
        if (this.isBFGMainProjectile) {
            // BFG projectiles create tracers on wall impact
            this.life = 0;
            playBFGImpactSound(this);
            
            if (window.gameState?.player) {
                this.fireBFGTracers(window.gameState.player);
            }
        } else if (this.isRocket) {
            // Rockets explode on wall impact
            this.life = 0;
            this.createExplosion();
            playRocketExplosionSound(this);
        } else {
            // Standard bullets just disappear
            this.life = 0;
        }
    }

    /**
     * Handles bullet expiration (lifetime reached zero)
     */
    handleExpiration() {
        if (this.isRocket) {
            // Rockets explode at end of life
            this.createExplosion();
            playRocketExplosionSound(this);
        }
        // Other bullet types just disappear
    }

    /**
     * Creates an explosion at the bullet's current position
     * Used by rocket launcher projectiles
     */
    createExplosion() {
        if (window.gameState?.explosions) {
            const explosion = new Explosion(
                this.x, this.y, this.aoeRadius, this.explosionDuration,
                'orange', this.splashDamage !== null ? this.splashDamage : this.damage,
                this.owner === 'player'
            );
            explosion.source = this.shooter;
            window.gameState.explosions.push(explosion);
        }
    }

    /**
     * A_BFGSpray. When the ball bursts, forty rays fan out over ninety degrees
     * from where the shooter stands, in the direction they face -- not from
     * the ball -- and each ray does 15-120 to the first thing it meets within
     * sixteen tiles. Several rays landing on one monster all count, which is
     * why a Cyberdemon in the middle of the fan takes most of the spray.
     *
     * @param {Object} playerOrigin - The player who fired
     * @param {() => number} [random] - Injectable RNG
     * @returns {number} Rays that hit something
     */
    fireBFGTracers(playerOrigin, random = Math.random) {
        if (!playerOrigin || !window.gameState?.gameMap) return 0;

        const count = this.tracerCount || 40;
        const cone = (this.tracerConeDegrees || 90) * Math.PI / 180;
        const dice = this.tracerDice || [15, 8];
        const reach = TILE_SIZE * 16;
        let hits = 0;

        for (let i = 0; i < count; i++) {
            const angle = playerOrigin.angle - cone / 2 + (cone / count) * i;
            const hit = traceShot(playerOrigin.x, playerOrigin.y, angle, playerOrigin, reach);
            if (!hit.thing) continue;

            const damage = this.tracerDice ? rollDice(dice, random) : (this.tracerDamage || rollDice(dice, random));
            if (hit.thing.bloodColor !== null && hit.thing.bloodColor !== undefined) {
                spawnBlood(hit.x, hit.y, angle, { color: hit.thing.bloodColor, amount: 3 });
            }
            hit.thing.takeDamage(damage, playerOrigin);
            hits++;

            if (window.gameState?.temporaryVisualEffects) {
                window.gameState.temporaryVisualEffects.push({
                    type: 'bfg_tracer',
                    startX: playerOrigin.x,
                    startY: playerOrigin.y,
                    endX: hit.x,
                    endY: hit.y,
                    life: 15,
                    color: `rgba(0, 255, 0, ${0.5 + random() * 0.3})`
                });
            }
        }
        return hits;
    }
}

// =============================================================================
// EXPLOSION CLASS - AREA DAMAGE SYSTEM
// =============================================================================

/**
 * Explosion class handles area-of-effect damage and visual effects
 * Used by rocket launcher and other explosive weapons
 */
export class Explosion {
    /**
     * Creates a new explosion
     * 
     * @param {number} x - Explosion center X coordinate
     * @param {number} y - Explosion center Y coordinate
     * @param {number} radius - Maximum explosion radius
     * @param {number} duration - Animation duration in frames
     * @param {string} color - Explosion color (default: 'orange')
     */
    constructor(x, y, radius, duration, color = 'orange', damage = 75, ownerIsPlayer = true) {
        this.x = x;                          // Explosion center X
        this.y = y;                          // Explosion center Y
        this.maxRadius = radius;             // Maximum explosion radius
        this.currentRadius = 0;              // Current animation radius
        this.duration = duration;            // Total animation duration
        this.life = duration;                // Remaining animation time
        this.color = color;                  // Explosion color
        this.damageDealt = false;            // Whether damage has been applied
        this.damage = damage;                // Damage dealt to entities in radius
        this.ownerIsPlayer = ownerIsPlayer;  // Player rockets self-damage at a reduced rate
        this.source = null;                  // The monster responsible, for infighting
    }

    /**
     * Updates explosion animation and handles damage
     * Called every frame during the explosion animation
     */
    update() {
        this.life--;

        // Expand outward with an ease-out curve. This previously computed
        // `1 - progress * progress`, which started the blast at full size and
        // shrank it to nothing -- the opposite of a shockwave.
        const progress = 1 - (this.life / this.duration);
        this.currentRadius = this.maxRadius * (1 - (1 - progress) * (1 - progress));

        // Deal damage once, at full radius, so the blast covers its stated AoE.
        // (The old ordering only worked by accident: it read currentRadius while
        // the radius happened to still be near maximum on its way down.)
        if (!this.damageDealt && this.life < this.duration * 0.8) {
            this.dealAreaDamage();
            this.damageDealt = true;
        }
    }

    /**
     * Deals damage to all entities within explosion radius
     */
    dealAreaDamage() {
        const gameState = window.gameState;
        if (!gameState) return;

        // Damage enemies, bosses, and barrels -- which is what makes a row of
        // barrels go off one after another
        const allTargets = [];
        if (gameState.currentBoss && gameState.currentBoss.health > 0) {
            allTargets.push(gameState.currentBoss);
        }
        if (gameState.enemies) {
            allTargets.push(...gameState.enemies);
        }
        if (gameState.barrels) {
            allTargets.push(...gameState.barrels);
        }

        // Damage is applied over the full blast radius, not whatever the
        // animation radius happens to be on the frame this runs.
        const blastRadius = this.maxRadius;

        // Check each target for explosion damage. As in Doom's P_RadiusAttack,
        // a monster's own blast does not hurt it, and the Cyberdemon and Spider
        // shrug off splash altogether; everything else in range is fair game,
        // which is how a Cyberdemon's rockets start fights it did not mean to.
        // P_RadiusAttack: the blast does `damage` at its centre falling off
        // in a straight line to nothing at its edge, measured to the edge of
        // the thing rather than its middle, and only to things it can see --
        // a rocket on the other side of a wall is a bang, not a wound.
        const map = gameState.gameMap;
        const blastDamage = (target) => {
            const distance = Math.max(0, Math.hypot(target.x - this.x, target.y - this.y) - (target.radius || 0));
            if (distance >= blastRadius) return 0;
            if (map && !isPathClear(this.x, this.y, target.x, target.y, map)) return 0;
            return this.damage * (1 - distance / blastRadius);
        };

        allTargets.forEach(target => {
            if (target && target.health > 0 && !target.isDead && !target.dormant) {
                if (target === this.source || target.def?.splashImmune) return;
                const amount = blastDamage(target);
                if (amount <= 0) return;
                if (target.bloodColor !== null && target.bloodColor !== undefined) {
                    spawnBlood(target.x, target.y, Math.atan2(target.y - this.y, target.x - this.x),
                               { color: target.bloodColor, amount: 7, speed: 4 });
                }
                target.takeDamage(amount, this.source);
            }
        });

        // The player takes the blast in full, their own rocket's included:
        // Doom's marine could rocket-jump, and paid for it.
        if (gameState.player && gameState.player.health > 0) {
            const amount = blastDamage(gameState.player);
            if (amount > 0) gameState.player.takeDamage(amount);
        }
    }

    /**
     * Renders the explosion animation
     * 
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     */
    draw(ctx) {
        if (this.life <= 0) return;

        // Calculate opacity based on remaining life
        const opacity = Math.max(0, this.life / this.duration);

        // Draw main explosion circle
        ctx.fillStyle = `rgba(255, ${Math.floor(165 * opacity) + 60}, 0, ${opacity * 0.6})`;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.currentRadius, 0, Math.PI * 2);
        ctx.fill();

        // Draw inner bright core if explosion is large enough
        if (this.currentRadius > TILE_SIZE * 0.2) {
            ctx.fillStyle = `rgba(255, 255, ${Math.floor(150 * opacity) + 100}, ${opacity * 0.8})`;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.currentRadius * 0.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

// =============================================================================
// HEALTH PACK CLASS - HEALING ITEMS
// =============================================================================

/**
 * Health pack class for player healing items
 * Provides health restoration with visual pickup representation
 */
export class HealthPack {
    /**
     * Creates a new health pack
     * 
     * @param {number} x - Health pack X coordinate
     * @param {number} y - Health pack Y coordinate
     */
    constructor(x, y) {
        this.x = x;                          // World X position
        this.y = y;                          // World Y position
        this.radius = ITEM_DRAW_SIZE.health.weight / 2;   // Walk onto it to take it
        this.healthValue = 25;               // Health restored when collected
        this.color = 'lime';                 // Health pack color
    }

    /**
     * Renders the health pack with a medical cross symbol
     * 
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     */
    draw(ctx) {
        // The medkit icon when it has loaded; the drawn cross below otherwise,
        // so a pack is never invisible.
        if (drawItemIcon(ctx, 'health', this.x, this.y,
                         iconDrawSize('health', ITEM_DRAW_SIZE.health))) return;

        // Draw background circle
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fill();

        // Draw medical cross symbol
        ctx.fillStyle = 'white';
        const crossWidth = this.radius / 2.5;
        const crossLength = this.radius * 1.2;

        // Vertical line of cross
        ctx.fillRect(
            this.x - crossWidth / 2, 
            this.y - crossLength / 2, 
            crossWidth, 
            crossLength
        );

        // Horizontal line of cross
        ctx.fillRect(
            this.x - crossLength / 2, 
            this.y - crossWidth / 2, 
            crossLength, 
            crossWidth
        );
    }
}

// =============================================================================
// AMMO PACK CLASS - AMMUNITION SUPPLIES
// =============================================================================

/**
 * Ammo pack class for weapon ammunition pickups
 * Provides ammunition for specific weapon types
 */
export class AmmoPack {
    /**
     * Creates a new ammo pack
     * 
     * @param {number} x - Ammo pack X coordinate
     * @param {number} y - Ammo pack Y coordinate
     * @param {string} weaponName - Name of weapon this ammo is for
     * @param {number} ammoAmount - Amount of ammunition provided
     * @param {string} color - Ammo pack color
     * @param {string} char - Character displayed on ammo pack
     */
    constructor(x, y, weaponName, ammoAmount, color, char, large = false) {
        this.x = x;                          // World X position
        this.y = y;                          // World Y position
        // A box of ammo is drawn bigger than a clip, as in Doom, so the player
        // can tell from across the room which one is worth the detour.
        this.sizing = large ? ITEM_DRAW_SIZE.ammoBox : ITEM_DRAW_SIZE.ammoClip;
        this.radius = this.sizing.weight / 2;     // Walk onto it to take it
        this.weaponName = weaponName;        // Which weapon uses this ammo
        this.ammoAmount = ammoAmount;        // Ammunition quantity
        this.color = color;                  // Ammo pack color
        this.char = char;                    // Display character
        this.large = large;                  // Box rather than clip
    }

    /**
     * Renders the ammo pack with weapon-specific styling
     * 
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     */
    draw(ctx) {
        // Ammo for the rocket launcher and the BFG has no icon in the sprite
        // pack, so those keep the lettered box; everything else gets its
        // magazine or fuel cylinder.
        // The magazine or cell on its own: no disc behind it, so a clip on the
        // floor looks like a clip on the floor. The artwork is distinct enough
        // per ammo type to tell them apart without a colour wash.
        const icon = WEAPON_STATS[this.weaponName]?.ammoIcon;
        if (icon && drawItemIcon(ctx, icon, this.x, this.y,
                                 iconDrawSize(icon, this.sizing))) return;

        // Draw background rectangle
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.fillRect(
            this.x - this.radius, 
            this.y - this.radius, 
            this.radius * 2, 
            this.radius * 2
        );
        ctx.fill();

        // Draw weapon identifier text
        ctx.fillStyle = 'black';
        ctx.font = `${this.radius * 1.5}px "Press Start 2P"`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.char, this.x, this.y + 2);
    }
}

// =============================================================================
// WEAPON PICKUPS - DROPPED AND PLACED WEAPONS
// =============================================================================

/**
 * A weapon lying on the floor: what a Shotgun Guy leaves behind, or a mini-boss.
 *
 * Weapons the level is built with are map tiles; a drop cannot be, because the
 * tile a monster dies on is as likely to be a prop, a pool or another item as
 * bare floor, and the old drop code simply did nothing in that case. An entity
 * lands wherever the body fell.
 */
export class WeaponPack {
    /**
     * @param {number} x - World X position
     * @param {number} y - World Y position
     * @param {string} weaponName - A WEAPON_STATS key
     * @param {number} ammo - Rounds it comes with; Doom halves this for drops
     */
    constructor(x, y, weaponName, ammo) {
        this.x = x;
        this.y = y;
        this.radius = ITEM_DRAW_SIZE.weapon.weight / 2;   // Walk onto it to take it
        this.weaponName = weaponName;
        this.ammo = ammo;
        this.color = WEAPON_STATS[weaponName]?.color || '#dddddd';
    }

    /**
     * Renders the weapon lying on the floor, the same treatment a placed
     * weapon tile gets, so a dropped shotgun reads the same as a found one.
     *
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     */
    draw(ctx) {
        const icon = WEAPON_STATS[this.weaponName]?.icon;
        if (icon && drawItemIcon(ctx, icon, this.x, this.y,
                                 iconDrawSize(icon, ITEM_DRAW_SIZE.weapon))) return;

        ctx.fillStyle = this.color;
        ctx.font = `${this.radius}px "Press Start 2P"`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.weaponName[0], this.x, this.y + 2);
    }
}

// =============================================================================
// POWERUPS - THE THINGS SECRETS ARE FOR
// =============================================================================

/**
 * Doom's big pickups, which only secrets hand out here.
 *
 *   soulsphere  +100 health, up to 200. The one thing that takes a marine past
 *               a full bar, and the reason to hunt for the hidden wall.
 *   backpack    Doubles the ammo the player can carry, and comes with a clip
 *               of everything.
 */
export const POWERUPS = {
    soulsphere: { color: '#3c6cff', rim: '#c8d8ff' },
    backpack: { color: '#8a5a2b', rim: '#d9b482' },
};

export class Powerup {
    /**
     * @param {number} x - World X position
     * @param {number} y - World Y position
     * @param {string} kind - A POWERUPS key
     */
    constructor(x, y, kind) {
        this.x = x;
        this.y = y;
        this.kind = kind;
        this.radius = TILE_SIZE / 2.6;
        this.phase = Math.random() * Math.PI * 2;
    }

    /**
     * Renders the powerup. There is no artwork for these in the sprite pack, so
     * they are drawn: the sphere as a lit orb that breathes, the backpack as a
     * strapped satchel.
     *
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     */
    draw(ctx) {
        const look = POWERUPS[this.kind] || POWERUPS.soulsphere;
        const pulse = 0.85 + 0.15 * Math.sin(Date.now() / 220 + this.phase);

        ctx.save();
        const glow = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.radius * 1.8);
        glow.addColorStop(0, look.color);
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.globalAlpha = 0.45 * pulse;
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius * 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        if (this.kind === 'backpack') {
            const w = this.radius * 1.5;
            const h = this.radius * 1.3;
            ctx.fillStyle = look.color;
            ctx.fillRect(this.x - w / 2, this.y - h / 2, w, h);
            ctx.fillStyle = look.rim;
            ctx.fillRect(this.x - w / 2, this.y - h / 2, w, h * 0.28);
            ctx.fillRect(this.x - w * 0.1, this.y - h / 2, w * 0.2, h);
            return;
        }

        const r = this.radius * 0.8 * pulse;
        const orb = ctx.createRadialGradient(this.x - r * 0.35, this.y - r * 0.35, r * 0.1, this.x, this.y, r);
        orb.addColorStop(0, '#ffffff');
        orb.addColorStop(0.35, look.rim);
        orb.addColorStop(1, look.color);
        ctx.fillStyle = orb;
        ctx.beginPath();
        ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
        ctx.fill();
    }
}

// =============================================================================
// BULLET MANAGEMENT UTILITIES
// =============================================================================

/**
 * Creates a new bullet with specified parameters
 * Factory function for consistent bullet creation
 * 
 * @param {Object} config - Bullet configuration object
 * @returns {Bullet} New bullet instance
 */
export function createBullet(config) {
    const {
        x, y, angle, speed, owner, damage,
        color = '#ffeb3b',
        isRocket = false,
        aoeRadius = 0,
        explosionDuration = 0,
        isBFG = false,
        tracerDamage = 0,
        isSeeking = false,
        life = 0,
        radius = 0,
        splash = null,
        tracerDice = null,
        tracerCount = 40,
        tracerConeDegrees = 90
    } = config;

    const bullet = new Bullet(
        x, y, angle, speed, owner, damage, color,
        isRocket, aoeRadius, explosionDuration, isBFG, tracerDamage, isSeeking,
        life, radius
    );
    bullet.splashDamage = splash;
    bullet.tracerDice = tracerDice;
    bullet.tracerCount = tracerCount;
    bullet.tracerConeDegrees = tracerConeDegrees;
    return bullet;
}

/**
 * Updates all bullets in the game
 * Handles movement, collision, and cleanup of expired bullets
 * 
 * @param {Array} bullets - Array of bullet instances
 * @returns {Array} Filtered array with expired bullets removed
 */
export function updateBullets(bullets) {
    // Update all bullets
    bullets.forEach(bullet => bullet.update());
    
    // Remove expired bullets
    return bullets.filter(bullet => bullet.life > 0);
}

/**
 * Renders all bullets on the canvas
 * 
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array} bullets - Array of bullet instances
 */
export function drawBullets(ctx, bullets) {
    bullets.forEach(bullet => bullet.draw(ctx));
}

/**
 * Checks for collisions between bullets and a target entity
 * 
 * @param {Array} bullets - Array of bullet instances
 * @param {Object} target - Target entity with x, y, radius, and health properties
 * @param {string} targetOwner - Who the bullets should affect ('player', 'enemy', 'boss')
 * @returns {Array} Bullets that didn't hit the target
 */
export function checkBulletCollisions(bullets, target, targetOwner) {
    if (!target || target.health <= 0 || target.isDead) {
        return bullets;
    }

    return bullets.filter(bullet => {
        // Skip bullets from the same owner
        if (bullet.owner === targetOwner) {
            return true;
        }

        if (!bulletHitsTarget(bullet, target)) {
            return true; // Keep bullet
        }

        applyBulletHit(bullet, target);
        return false; // Remove bullet
    });
}

/**
 * Tests whether a bullet crossed a target this frame.
 *
 * The test is the segment from where the bullet started the frame to where it
 * is now, thickened by its radius, against the target's hit shape -- the
 * drawn body, for anything that has a sprite (see js/hitbox.js). A bullet
 * that has not moved yet (just created, or a test fixture) is tested as a
 * point.
 *
 * @param {Object} bullet - Bullet instance
 * @param {Object} target - Entity with x, y and radius, and maybe getHitShape()
 * @returns {boolean} True if the bullet hit
 */
export function bulletHitsTarget(bullet, target) {
    const x0 = bullet.prevX !== undefined ? bullet.prevX : bullet.x;
    const y0 = bullet.prevY !== undefined ? bullet.prevY : bullet.y;
    return segmentHitsShape(hitShapeOf(target), x0, y0, bullet.x, bullet.y, bullet.radius);
}

/**
 * How far along this frame's travel a bullet reached a target, 0..1, or
 * Infinity for a miss. Lets the collision pass pick the nearest of several
 * things a bullet crossed in one frame.
 *
 * @param {Object} bullet - Bullet instance
 * @param {Object} target - Entity with x, y and radius, and maybe getHitShape()
 * @returns {number} Fraction along the segment, or Infinity
 */
export function bulletHitFraction(bullet, target) {
    const x0 = bullet.prevX !== undefined ? bullet.prevX : bullet.x;
    const y0 = bullet.prevY !== undefined ? bullet.prevY : bullet.y;
    return segmentHitFraction(hitShapeOf(target), x0, y0, bullet.x, bullet.y, bullet.radius);
}

/**
 * Where on its path a bullet met a target, for blood and impact effects.
 *
 * @param {Object} bullet - Bullet instance
 * @param {Object} target - The thing it hit
 * @returns {{x: number, y: number}} World point
 */
export function bulletImpactPoint(bullet, target) {
    const fraction = bulletHitFraction(bullet, target);
    if (!Number.isFinite(fraction)) return { x: bullet.x, y: bullet.y };
    const x0 = bullet.prevX !== undefined ? bullet.prevX : bullet.x;
    const y0 = bullet.prevY !== undefined ? bullet.prevY : bullet.y;
    return { x: x0 + (bullet.x - x0) * fraction, y: y0 + (bullet.y - y0) * fraction };
}

/**
 * Blood where a bullet struck, sprayed on along the bullet's line.
 *
 * @param {Object} bullet - Bullet instance
 * @param {Object} target - The thing it hit; skipped if it does not bleed
 */
function bleedFromBullet(bullet, target) {
    if (target.bloodColor === null) return;
    const point = bulletImpactPoint(bullet, target);
    spawnBlood(point.x, point.y, Math.atan2(bullet.dy, bullet.dx), { color: target.bloodColor });
}

/**
 * Applies a bullet's effect to a target it has hit and marks the bullet spent.
 *
 * Extracted so the collision pass can run in place over the bullet array instead
 * of allocating a fresh filtered array for every entity on every frame.
 *
 * @param {Object} bullet - Bullet that connected
 * @param {Object} target - Entity being hit
 */
export function applyBulletHit(bullet, target) {
    // Who to blame: a monster turns on whatever hurt it.
    const source = bullet.shooter || (bullet.owner === 'player' ? window.gameState?.player : null);

    if (bullet.isBFGMainProjectile) {
        // BFG projectiles deal damage and create tracers
        bleedFromBullet(bullet, target);
        target.takeDamage(bullet.damage, source);
        bullet.life = 0;
        playBFGImpactSound(bullet);

        if (window.gameState?.player) {
            bullet.fireBFGTracers(window.gameState.player);
        }
    } else if (bullet.isRocket) {
        // A rocket does its impact damage to what it hits -- 20-160 for the
        // player's -- and then the blast hurts everything around, the target
        // included, as P_RadiusAttack does.
        bleedFromBullet(bullet, target);
        target.takeDamage(bullet.damage, source);
        bullet.life = 0;
        bullet.createExplosion();
        playRocketExplosionSound(bullet);
    } else {
        // Standard bullets just deal damage
        bleedFromBullet(bullet, target);
        target.takeDamage(bullet.damage, source);
        bullet.life = 0;
    }
}

/**
 * Creates an explosion at a specific location
 * Utility function for creating explosions from various sources
 * 
 * @param {number} x - Explosion X coordinate
 * @param {number} y - Explosion Y coordinate
 * @param {number} radius - Explosion radius
 * @param {number} duration - Animation duration
 * @param {string} color - Explosion color
 * @returns {Explosion} New explosion instance
 */
export function createExplosion(x, y, radius, duration, color = 'orange') {
    return new Explosion(x, y, radius, duration, color);
}