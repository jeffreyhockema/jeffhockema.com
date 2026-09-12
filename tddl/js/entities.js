/**
 * ENTITIES MODULE
 *
 * This module contains all game entity classes for the top-down Doom-like game.
 * Implements comprehensive entity systems with AI, combat, and animation.
 *
 * Core Features:
 * - Player: Movement, weapon system, inventory, health management
 * - Enemy AI: Distance-based engagement, collision avoidance, multiple attack patterns
 * - Boss System: Scaled difficulty, advanced combat behaviors
 * - Animation: Sprite-based directional animation for all entities
 * - Combat: Melee attacks, ranged weapons, damage systems without invulnerability
 * - Collision: Wall detection, entity separation, tile interaction
 *
 * The enemies are Doom's monsters. Their numbers live in js/monsters.js; the
 * AI on the Enemy class below is a port of the monster half of Doom's
 * p_enemy.c -- standing and looking, eight-direction chasing, the missile
 * range roll, pain, and infighting.
 *
 * @author TDDL Game Team
 * @version 3.0.0
 */

import {
    TILE_SIZE, MAP_COLS, MAP_ROWS, VIEWPORT_WIDTH, VIEWPORT_HEIGHT,
    TILE_EMPTY, TILE_WALL, TILE_DOOR_RED, TILE_DOOR_YELLOW, TILE_DOOR_BLUE, TILE_SECRET_DOOR,
    TILE_KEY_RED, TILE_KEY_YELLOW, TILE_KEY_BLUE, TILE_EXIT,
    TILE_WEAPON_SHOTGUN, TILE_WEAPON_RIFLE, TILE_WEAPON_ROCKETLAUNCHER, TILE_WEAPON_BFG, TILE_WEAPON_PLASMAGUN,
    TILE_HEALTH_PACK,
    WEAPON_STATS, getDifficultyMultipliers, GAME_BALANCE,
    PLAYER_SPRITE_BODY_PER_RADIUS, PLAYER_ATTACK_ANIM_HOLD, PLAYER_DEATH_BEAT,
    MIN_AIM_CONVERGE_DISTANCE, PLAYER_WALK_SPEED, PLAYER_RUN_SPEED,
    ENEMY_SPRITE_BODY_PER_RADIUS, ENEMY_SPRITE_FOOT_OFFSET, ANIMATION_TICKS_PER_SECOND,
    ENEMY_IDLE_BLINK_MIN_DELAY, ENEMY_IDLE_BLINK_MAX_DELAY, ENEMY_CORPSE_LINGER, TILE_PROP, TILE_SLIDE, TILE_SWITCH, AMMO_TYPES, rollWeaponDamage, playerSpread, PLAYER_RADIUS_UNITS, TILE_WINDOW,
} from './constants.js';
import {
    isPathClear, checkWallCollision, isSolidAt,
    getDirectionFromAngle, angleDifference
} from './utils.js';
import { isDoorOpen, unlockDoorAt, doorKeyName, isKeyedDoorTile } from './doors.js';
import { getTerrain, terrainSpeedMultiplier } from './terrain.js';
import {
    PLAYER_ANIM, pickRandomPlayerCharacter, getPlayerSpriteMeta, getPlayerAtlas,
    getPlayerFrameRates, getPlayerSourceAngle,
    resolvePlayerAnimation, getPlayerFrameRect
} from './player-sprites.js';
import {
    ENEMY_ANIM, pickRandomEnemySprite, getEnemySpriteMeta, getEnemyAtlas,
    getEnemyFrameRates, getEnemyOneShotAnimations,
    resolveEnemyAnimation, getEnemyFrameRect
} from './enemy-sprites.js';
import { createBullet, Explosion, traceShot, WeaponPack} from './weapons.js';
import { boxShape, circleShape, hitShapeOf, rayShapeDistance, distanceToShape } from './hitbox.js';
import { spawnBlood, spawnGore, BLOOD_RED, spawnSparks,
} from './particles.js';
import {
    MONSTERS, DIR, DIR_VECTORS, DIR_ANGLES, FRAMES_PER_TIC,
    ticsToFrames, unitsToPx, pxToUnits, chaseSpeedPx, projectileSpeedPx,
    rollDamage, checkMissileRange, newChaseDir, hitscanSpread,
    bossTypeForTier,
    MONSTER_DAMAGE_SCALE, SIGHT_RANGE, NOISE_MEMORY_FRAMES, AMBUSH_CHANCE,
    LOOK_INTERVAL_TICS, MELEE_REACH_UNITS, MISSILE_RANGE_UNITS, BASE_THRESHOLD_TICS,
    LOST_SOUL_LIMIT, RUN_ANIMATION_SPEED
} from './monsters.js';
import {
    playShootSound, playMeleeHitSound, playPlayerHitSound, playHealthPickupSound,
    playKeyPickupSound, playDoorOpenSound, playWeaponPickupSound, playAmmoPickupSound,
    playSecretDoorOpenSound, playEnemyDestroySound, playEnemyShootSound, playEnemyGunSound,
    playEnemySightSound, playEnemyPainSound, playEnemyActiveSound, playEnemyMeleeSound,
    playEnemyWindupSound, playEnemyStepSound, playResurrectSound, playTeleportSound,
    playEmptyGunSound, playWeaponSwitchSound, playLowHealthWarning,
    playErrorSound
} from './audio-system.js';
import { keys, mouse } from './input-handler.js';
import { isSlideOpen } from './switches.js';

// =============================================================================
// SPRITE ELEMENT CACHE
// =============================================================================

/**
 * How long an enemy stands still before playing an idle variation.
 *
 * Randomised per enemy and re-rolled after every blink, so a group standing
 * together doesn't animate in lockstep.
 *
 * @returns {number} A delay in update ticks
 */
/**
 * Frames between pain sounds while standing in something that burns.
 *
 * Damage is dealt every frame; the sound is not. Roughly a third of a second,
 * which reads as being hurt repeatedly rather than as a continuous tone.
 */
const TERRAIN_HURT_SOUND_INTERVAL = 20;

function randomBlinkDelay() {
    const spread = ENEMY_IDLE_BLINK_MAX_DELAY - ENEMY_IDLE_BLINK_MIN_DELAY;
    return ENEMY_IDLE_BLINK_MIN_DELAY + Math.floor(Math.random() * spread);
}

// =============================================================================
// PLAYER CLASS - MAIN CHARACTER
// =============================================================================

/**
 * Player class - Main character controlled by the user
 *
 * Core Systems:
 * - Movement: WASD/Arrow key movement with collision detection
 * - Combat: 6-weapon system with auto-switching and ammo management
 * - Inventory: Key collection, weapon ownership, ammo storage
 * - Health: Direct damage system without invulnerability frames
 * - Animation: Directional sprite animation with 3-frame walk cycle
 * - Interaction: Door opening, item pickup, secret discovery
 */
export class Player {
    /**
     * Creates a new player instance
     *
     * @param {number} x - Starting X world coordinate
     * @param {number} y - Starting Y world coordinate
     */
    constructor(x, y) {
        // === POSITION & PHYSICS ===
        this.x = x;
        this.y = y;
        this.radius = unitsToPx(PLAYER_RADIUS_UNITS);   // Doom's 16 units: 10px, half a tile across
        // Doom's marine walks, and runs at twice that with the run key held.
        // `speed` stays as the walking speed for anything that reads it.
        this.walkSpeed = PLAYER_WALK_SPEED;
        this.runSpeed = PLAYER_RUN_SPEED;
        this.speed = PLAYER_WALK_SPEED;
        this.isRunning = false;              // Shift held this frame
        this.angle = Math.PI / 2;            // Facing direction (0=right, π/2=down)

        // === HEALTH SYSTEM ===
        const multipliers = getDifficultyMultipliers(window.gameState?.selectedDifficulty || 'medium');
        this.maxHealth = GAME_BALANCE.BASE_PLAYER_HEALTH * multipliers.playerHealth;
        this.health = this.maxHealth;

        // === INVENTORY & KEYS ===
        this.keysCollected = { red: false, yellow: false, blue: false };
        this.canPhase = false;               // Debug cheat: walk through walls

        // === TERRAIN ===
        // Which liquid the player is standing in, and the fraction of a hit point
        // it has dealt so far. Toxic waste does ten damage a second, which is a
        // sixth of a point per frame; without carrying the remainder forward,
        // rounding would swallow every tick of it and wading through sludge would
        // be free. See applyTerrainEffects().
        this.terrainTile = TILE_EMPTY;
        this.terrainDamageDebt = 0;
        this.terrainHurtCooldown = 0;        // Throttles the pain sound, not the damage

        // What sprays when the player is hit
        this.bloodColor = BLOOD_RED;

        // === WEAPON SYSTEM ===
        this.weapons = [];
        this.initializeWeapons();
        this.currentWeaponIndex = this.weapons.findIndex(w => w.name === "Pistol");
        this.shootCooldown = 0;              // Frames until next shot allowed
        this.singleShotFiredThisClick = false; // Stops single-shot weapons auto-firing on hold
        this.refireCount = 0;                // Shots fired on the current trigger pull

        // === ANIMATION SYSTEM ===
        // The marine. Null until the atlas has loaded, which
        // leaves the player on the shape fallback in draw().
        this.spriteSlug = pickRandomPlayerCharacter();
        this.animation = PLAYER_ANIM.IDLE;   // Animation currently playing
        this.animFrame = 0;                  // Position within it, in frames (fractional)
        this.attackAnimTimer = 0;            // Counts down while an attack is on screen
        this.muzzleFlashTimer = 0;           // Counts down while a muzzle flash is showing
        this.muzzleFlashSpec = null;         // The firing weapon's flash descriptor
        this.isMoving = false;               // Movement state for animation

        if (this.spriteSlug) {
            getPlayerAtlas(this.spriteSlug);  // Begin fetching before the level starts
        }
    }

    /**
     * What a shot has to cross to hit the player: the drawn body.
     *
     * The sprite is a top-down figure that rotates to the aim, so a circle the
     * width of the artwork is the honest shape. The shoulders span the
     * movement radius (PLAYER_SPRITE_BODY_PER_RADIUS), so the two circles
     * coincide -- Doom's marine is hit within his 16-unit radius and nowhere
     * else -- and a fireball that visibly clips a shoulder still connects.
     *
     * @returns {Object|null} A hitbox shape, or null to use the movement circle
     */
    getHitShape() {
        if (!this.getSpriteMeta()) return null;
        return circleShape(this.x, this.y, this.radius * PLAYER_SPRITE_BODY_PER_RADIUS / 2);
    }

    /**
     * @returns {Object|null} This player's manifest entry, or null without one
     */
    getSpriteMeta() {
        // Retry the pick if the manifest was still in flight at construction.
        // The player is created once per game, so without this a slow asset load
        // meant a blue circle for the whole run.
        if (!this.spriteSlug) {
            this.spriteSlug = pickRandomPlayerCharacter();
            if (!this.spriteSlug) return null;
            getPlayerAtlas(this.spriteSlug);
        }

        return getPlayerSpriteMeta(this.spriteSlug);
    }

    /**
     * The animation set the equipped weapon is drawn with.
     *
     * The rocket launcher and BFG have no artwork in the sprite pack and declare
     * the flamethrower's animations instead, so the character at least holds
     * something bulky and two-handed rather than an empty pose.
     *
     * @returns {string} A sprite weapon key
     */
    getSpriteWeapon() {
        return this.getCurrentWeapon()?.spriteWeapon || 'pistol';
    }

    /**
     * Advances the player's animation and chooses the next one.
     *
     * Firing sets `attackAnimTimer`; while it runs the attack animation owns the
     * character, so a swing plays out instead of being cut off the instant the
     * player moves.
     */
    updateAnimation() {
        const meta = this.getSpriteMeta();
        if (!meta) return;

        if (this.attackAnimTimer > 0) this.attackAnimTimer--;

        const next = this.health <= 0
            ? PLAYER_ANIM.DEATH
            : this.attackAnimTimer > 0
                ? PLAYER_ANIM.ATTACK
                : this.isMoving
                    ? PLAYER_ANIM.WALK
                    : PLAYER_ANIM.IDLE;

        if (next !== this.animation) {
            this.animation = next;
            this.animFrame = 0;
        }

        const weapon = this.animation === PLAYER_ANIM.DEATH ? null : this.getSpriteWeapon();
        const range = resolvePlayerAnimation(meta, this.animation, weapon);
        if (!range) return;

        const rates = getPlayerFrameRates();
        // The walk cycle has no run variant, so running plays it faster in
        // proportion to the extra ground covered.
        const stride = (this.animation === PLAYER_ANIM.WALK && this.isRunning)
            ? this.runSpeed / this.walkSpeed
            : 1;
        this.animFrame += stride * (rates[this.animation] || 12) / ANIMATION_TICKS_PER_SECOND;

        if (this.animFrame >= range.count) {
            // Death holds its final pose. The attack cycles instead of clamping:
            // it is driven by the trigger, not played once, and a sustained burst
            // outlasts it -- clamping pinned the character mid-recoil until the
            // player let go.
            this.animFrame = this.animation === PLAYER_ANIM.DEATH
                ? range.count - 1
                : this.animFrame % range.count;
        }
    }

    /**
     * Starts the attack animation. Called whenever a weapon is actually used.
     *
     * The hold is the length of this weapon's own swing, so a slow, long
     * animation is not cut off partway. Weapons that fire faster than their
     * animation runs simply keep refreshing it, and updateAnimation() cycles the
     * frames for as long as the trigger is held.
     */
    playAttackAnimation() {
        if (this.animation !== PLAYER_ANIM.ATTACK) {
            this.animation = PLAYER_ANIM.ATTACK;
            this.animFrame = 0;
        }
        this.attackAnimTimer = this.attackAnimationTicks();
    }

    /**
     * Where the equipped weapon's barrel is, in world coordinates.
     *
     * The offset is baked per weapon by tools/build_player_sprites.py and stored
     * in the manifest relative to the pivot. Rotating it exactly as the renderer
     * rotates the sprite is what keeps the two in step: the muzzle stays on the
     * drawn barrel through a full turn, rather than only lining up when the
     * character happens to face one way.
     *
     * @returns {{x: number, y: number}|null} World position, or null without artwork
     */
    getMuzzleWorldPosition() {
        const meta = this.getSpriteMeta();
        const offset = meta?.muzzle?.[this.getSpriteWeapon()];
        if (!offset) return null;

        const scale = (this.radius * PLAYER_SPRITE_BODY_PER_RADIUS) / meta.bodyWidth;
        const spin = this.angle - getPlayerSourceAngle();
        const cos = Math.cos(spin);
        const sin = Math.sin(spin);
        const dx = offset[0] * scale;
        const dy = offset[1] * scale;

        return {
            x: this.x + dx * cos - dy * sin,
            y: this.y + dx * sin + dy * cos,
        };
    }

    /**
     * The muzzle flash currently showing, if any.
     *
     * Shared by the renderer, which draws it, and the lighting pass, which turns
     * it into a brief light -- so the flash on screen and the light it casts
     * always agree on where and how bright.
     *
     * @returns {{x: number, y: number, angle: number, strength: number, spec: Object}|null}
     */
    getMuzzleFlash() {
        if (this.muzzleFlashTimer <= 0 || !this.muzzleFlashSpec) return null;

        // Without artwork there is no measured barrel; put it on the aim ray.
        const muzzle = this.getMuzzleWorldPosition() || {
            x: this.x + Math.cos(this.angle) * (this.radius + 5),
            y: this.y + Math.sin(this.angle) * (this.radius + 5),
        };

        return {
            x: muzzle.x,
            y: muzzle.y,
            angle: this.angle,
            // Fades over its life; the first frame is the brightest.
            strength: this.muzzleFlashTimer / this.muzzleFlashSpec.frames,
            spec: this.muzzleFlashSpec,
        };
    }

    /**
     * Draws the muzzle flash at the barrel.
     *
     * A bloom at the muzzle plus a short tongue along the aim, both additive so
     * they read as light rather than paint, both jittered a little per frame so
     * a burst of automatic fire flickers instead of stamping the same shape.
     * Called from the emissive pass, after the light mask, so it shows in the
     * dark -- which is where a muzzle flash matters most.
     *
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     */
    drawMuzzleFlash(ctx) {
        const flash = this.getMuzzleFlash();
        if (!flash) return;

        const { spec, strength } = flash;
        const [r, g, b] = spec.color;
        const jitter = 0.85 + Math.random() * 0.3;
        const size = spec.size * jitter * (0.6 + 0.4 * strength);
        const alpha = Math.min(1, 0.55 + 0.45 * strength);

        ctx.save();
        ctx.translate(flash.x, flash.y);
        ctx.rotate(flash.angle + (Math.random() - 0.5) * 0.12);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = alpha;

        // Bloom: white-hot centre falling off into the weapon's colour. Pushed
        // a little forward so it emanates from the end of the barrel instead of
        // sitting centred on it and swallowing the last of the gun.
        const lead = size * 0.3;
        const bloom = ctx.createRadialGradient(lead, 0, 0, lead, 0, size);
        bloom.addColorStop(0, 'rgba(255,255,255,1)');
        bloom.addColorStop(0.35, `rgba(${r},${g},${b},0.85)`);
        bloom.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = bloom;
        ctx.beginPath();
        ctx.arc(lead, 0, size, 0, Math.PI * 2);
        ctx.fill();

        // Tongue: a tapered streak forward along the aim.
        const length = size * 2.4;
        const tongue = ctx.createLinearGradient(0, 0, length, 0);
        tongue.addColorStop(0, 'rgba(255,255,255,0.9)');
        tongue.addColorStop(0.4, `rgba(${r},${g},${b},0.6)`);
        tongue.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = tongue;
        ctx.beginPath();
        ctx.moveTo(0, -size * 0.35);
        ctx.lineTo(length, 0);
        ctx.lineTo(0, size * 0.35);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
    }

    /**
     * How many updates the equipped weapon's attack animation takes to play once.
     *
     * @returns {number} Duration in updates, or the fallback hold without artwork
     */
    attackAnimationTicks() {
        const meta = this.getSpriteMeta();
        if (!meta) return PLAYER_ATTACK_ANIM_HOLD;

        const range = resolvePlayerAnimation(meta, PLAYER_ANIM.ATTACK, this.getSpriteWeapon());
        if (!range) return PLAYER_ATTACK_ANIM_HOLD;

        const fps = getPlayerFrameRates()[PLAYER_ANIM.ATTACK] || 12;
        return Math.ceil((range.count / fps) * ANIMATION_TICKS_PER_SECOND);
    }

    /**
     * Initializes the player's weapon inventory
     * Sets up 6 weapons with proper ownership, ammo, and damage scaling
     * Player starts with the Knife (infinite uses) and Pistol (30 rounds)
     */
    initializeWeapons() {
        // Weapon order matches UI layout (keys 1-7), in the Doom tradition
        const WEAPON_ORDER = [
            "Knife",           // Key 1 - Infinite uses, always owned
            "Pistol",          // Key 2 - 30 starting ammo, owned by default
            "Shotgun",         // Key 3 - Must be found
            "Rifle",           // Key 4 - Must be found
            "Rocket Launcher", // Key 5 - Must be found
            "Plasma Gun",      // Key 6 - Must be found
            "BFG"              // Key 7 - Must be found
        ];

        // Doom's four ammunition pools, shared between the weapons that
        // shared them: the pistol and the rifle draw the same bullets, the
        // plasma gun and the BFG the same cells. A weapon's `ammo` reads and
        // writes its pool, so every caller that counts rounds on the weapon
        // keeps working and the two guns always agree.
        this.ammo = {};
        this.ammoMax = {};
        this.hasBackpack = false;
        for (const [type, spec] of Object.entries(AMMO_TYPES)) {
            this.ammo[type] = spec.start;
            this.ammoMax[type] = spec.max;
        }
        const pools = this.ammo;
        const limits = this.ammoMax;

        this.weapons = WEAPON_ORDER.map(weaponName => {
            const stats = WEAPON_STATS[weaponName];
            if (!stats) return null; // Skip invalid weapons

            const weapon = {
                ...stats,
                ...Player.evaluateWeaponDamage(stats), // Resolve damage functions to numbers
                owned: this.isStartingWeapon(weaponName)
            };
            if (stats.ammoType) {
                const type = stats.ammoType;
                // The ceiling lives on the player, not the weapon, so a backpack
                // can raise it for every weapon sharing the pool at once.
                Object.defineProperty(weapon, 'maxAmmo', {
                    enumerable: true,
                    configurable: true,
                    get: () => limits[type],
                });
                Object.defineProperty(weapon, 'ammo', {
                    enumerable: true,
                    configurable: true,
                    get: () => pools[type],
                    set: (value) => { pools[type] = Math.max(0, Math.min(value, limits[type])); },
                });
            } else {
                weapon.ammo = this.getStartingAmmo(weaponName);
            }
            return weapon;
        }).filter(Boolean); // Remove any null entries
    }

    /**
     * Resolves a weapon's damage functions into plain numbers for the current
     * level and difficulty.
     *
     * WEAPON_STATS stores damage as a thunk so it can scale with progression.
     * Every one of those thunks must be evaluated before the value reaches the
     * projectile layer -- the BFG's `tracerDamage` was previously copied through
     * as a *function*, so `enemy.health -= tracerDamage` produced NaN and left
     * every tracer-hit enemy permanently unkillable (NaN <= 0 is false).
     *
     * @param {Object} stats - Entry from WEAPON_STATS
     * @returns {Object} Object with numeric `damage` and, when applicable, `tracerDamage`
     */
    static evaluateWeaponDamage(stats) {
        const resolved = {
            damage: typeof stats.damage === 'function' ? stats.damage() : stats.damage
        };

        if (stats.tracerDamage !== undefined) {
            resolved.tracerDamage = typeof stats.tracerDamage === 'function'
                ? stats.tracerDamage()
                : stats.tracerDamage;
        }

        return resolved;
    }

    /**
     * Re-evaluates every owned weapon's damage against the current level and
     * difficulty. Weapon damage was computed once in the constructor, so the
     * level scaling baked into WEAPON_STATS never actually applied to weapons
     * the player already held -- the Pistol and Knife stayed at their level-1
     * damage for the entire run.
     *
     * Called on each level transition.
     */
    refreshWeaponDamage() {
        this.weapons.forEach(weapon => {
            const stats = WEAPON_STATS[weapon.name];
            if (stats) {
                Object.assign(weapon, Player.evaluateWeaponDamage(stats));
            }
        });
    }

    /**
     * Determines starting ammunition for a weapon
     * @param {string} weaponName - Name of the weapon
     * @returns {number} Starting ammo amount (Infinity for infinite)
     */
    getStartingAmmo(weaponName) {
        const stats = WEAPON_STATS[weaponName];
        if (!stats) return 0;

        // A weapon that takes no ammunition keeps its infinite supply whether or
        // not the player starts with it. Listing names here instead is what left
        // the bat owned but permanently empty: it is picked up mid-run, so a
        // "starting weapons only" rule zeroed the ammo its stats call infinite,
        // and with pickupAmmo of 0 nothing ever refilled it.
        if (stats.ammo === Infinity) return Infinity;

        return this.isStartingWeapon(weaponName) ? stats.ammo : 0;
    }

    /**
     * Checks if player starts with this weapon
     * @param {string} weaponName - Name of the weapon
     * @returns {boolean} True if player owns this weapon initially
     */
    isStartingWeapon(weaponName) {
        return weaponName === "Knife" || weaponName === "Pistol";
    }

    /**
     * Gets the currently selected weapon
     * 
     * @returns {Object} Current weapon object
     */
    getCurrentWeapon() {
        return this.weapons[this.currentWeaponIndex];
    }

    /**
     * Attempts to pick up a weapon or ammo from the ground
     * Returns true if item was successfully picked up, false if should remain on ground
     *
     * @param {Object} weaponDataFromTile - Weapon data from map tile pickup
     * @returns {boolean} True if item was picked up, false if it should remain
     */
    addWeapon(weaponDataFromTile) {
        let weaponInstance = this.weapons.find(w => w.name === weaponDataFromTile.name);
        const stats = WEAPON_STATS[weaponDataFromTile.name];
        if (!stats) return false; // Unknown weapon - leave it on the ground
        const evaluatedDamage = Player.evaluateWeaponDamage(stats);
        const pickupAmmo = (weaponDataFromTile.pickupAmmo || 0) * this.ammoScale();

        if (weaponInstance) {
            if (!weaponInstance.owned) {
                // First time picking up this weapon - always successful
                weaponInstance.owned = true;
                weaponInstance.ammo = Math.min(
                    weaponInstance.ammo + pickupAmmo,
                    weaponInstance.maxAmmo
                );
                Object.assign(weaponInstance, evaluatedDamage);
                playWeaponPickupSound();
                this.updateWeaponUI();
                return true;
            } else if (weaponInstance.ammo !== Infinity) {
                // Check if we can add any ammo
                if (weaponInstance.ammo < weaponInstance.maxAmmo) {
                    // Can add some ammo
                    weaponInstance.ammo = Math.min(
                        weaponInstance.ammo + pickupAmmo,
                        weaponInstance.maxAmmo
                    );
                    Object.assign(weaponInstance, evaluatedDamage);
                    playAmmoPickupSound();
                    this.updateWeaponUI();
                    return true;
                } else {
                    // Already at max ammo - leave item on ground
                    return false;
                }
            } else {
                // Infinite ammo weapon already owned - leave item on ground
                return false;
            }
        }

        // Weapon not found in inventory - shouldn't happen, but leave on ground
        return false;
    }

    /**
     * Adds ammunition for a specific weapon type
     * 
     * @param {string} weaponName - Name of the weapon to add ammo for
     * @param {number} amount - Amount of ammunition to add
     */
    addAmmo(weaponName, amount) {
        const weapon = this.weapons.find(w => w.name === weaponName);
        if (!weapon || weapon.ammo === Infinity) return false;

        // Already full - report failure so the caller can leave the pack on the ground
        if (weapon.ammo >= weapon.maxAmmo) return false;

        // Add ammo regardless of ownership status
        weapon.ammo = Math.min(weapon.ammo + amount * this.ammoScale(), weapon.maxAmmo);
        playAmmoPickupSound();
        this.updateWeaponUI();

        return true;
    }

    /**
     * How much every ammo pickup is worth. Doom's easiest skill doubles it
     * (P_GiveAmmo: `if (gameskill == sk_baby) num <<= 1`); the others get the
     * number on the box.
     *
     * @returns {number} Multiplier
     */
    ammoScale() {
        return window.gameState?.selectedDifficulty === 'easy' ? 2 : 1;
    }

    /**
     * Picks up a backpack: the ammo ceiling doubles, once, and every pool gets
     * a clip. A second backpack is just the clips, as in Doom.
     */
    addBackpack() {
        if (!this.hasBackpack) {
            this.hasBackpack = true;
            for (const type of Object.keys(this.ammoMax)) this.ammoMax[type] *= 2;
        }
        for (const [type, spec] of Object.entries(AMMO_TYPES)) {
            this.ammo[type] = Math.min(this.ammo[type] + spec.clip * this.ammoScale(), this.ammoMax[type]);
        }
        this.updateWeaponUI();
    }

    /**
     * Switches to a different weapon if owned and available
     *
     * @param {number} index - Index of weapon to switch to
     */
    switchWeapon(index) {
        if (index >= 0 && index < this.weapons.length && this.weapons[index].owned) {
            this.currentWeaponIndex = index;
            this.updateWeaponUI();
            playWeaponSwitchSound();
        }
    }

    /**
     * Automatically switches to the next available weapon with ammo
     * Excludes rockets and BFG from automatic selection
     */
    autoSwitchWeapon() {
        // Preferred weapon order for auto-switching (excluding rockets and BFG)
        const weaponPriority = ["Rifle", "Shotgun", "Plasma Gun", "Pistol", "Knife"];

        // Find the best available weapon with ammo
        for (const weaponName of weaponPriority) {
            const weaponIndex = this.weapons.findIndex(w => w.name === weaponName);
            if (weaponIndex !== -1 &&
                this.weapons[weaponIndex].owned &&
                (this.weapons[weaponIndex].ammo > 0 || this.weapons[weaponIndex].ammo === Infinity)) {
                this.switchWeapon(weaponIndex);
                return;
            }
        }

        // Fall back to whatever melee weapon the player is carrying. Matching on a
        // literal weapon name would leave the player stuck on an empty gun as soon
        // as the roster changed.
        const meleeIndex = this.weapons.findIndex(
            w => w.owned && (w.isMelee || w.ammo === Infinity)
        );
        if (meleeIndex !== -1) {
            this.switchWeapon(meleeIndex);
        }
    }

    /**
     * Fires the current weapon if possible
     * Handles different weapon types and their firing patterns
     */
    shoot() {
        const weapon = this.getCurrentWeapon();
        const perShot = weapon.ammoPerShot || 1;

        // Check if weapon has ammunition: the BFG wants forty cells
        if (weapon.ammo < perShot) {
            // Rate-limit the click. Holding the trigger on an empty automatic weapon
            // called this every frame, building a fresh voice 60 times a second.
            this.shootCooldown = Math.max(this.shootCooldown, 20);
            playEmptyGunSound();
            return;
        }

        // Handle melee weapons differently
        if (weapon.isMelee) {
            this.playAttackAnimation();
            this.performMeleeAttack(weapon);
            return;
        }

        // Play weapon sound
        playShootSound(weapon.name);
        this.playAttackAnimation();

        // The sprites carry no painted flash; this is the only one there is.
        if (weapon.muzzleFlash) {
            this.muzzleFlashSpec = weapon.muzzleFlash;
            this.muzzleFlashTimer = weapon.muzzleFlash.frames;
        }

        // P_NoiseAlert: every shot wakes the monsters within earshot.
        window.gameState?.noiseAlert?.(this.x, this.y);

        // Set the cooldown from the weapon that actually fired, BEFORE any
        // auto-switch. Doing it afterwards applied the emptied weapon's fire rate
        // to the newly selected gun -- firing your last BFG round (fireRate 150)
        // locked the pistol you switched to for two and a half seconds.
        this.shootCooldown = weapon.fireRate;

        // Consume ammunition (except for infinite ammo weapons)
        if (weapon.ammo !== Infinity) {
            weapon.ammo -= perShot;
            this.updateWeaponUI();

            // Auto-switch if we ran out of ammo
            if (weapon.ammo < perShot) {
                this.autoSwitchWeapon();
            }
        }

        // How many shots this trigger pull has fired so far: the pistol's
        // first is dead straight, the rest have the refire spread (A_ReFire).
        const refire = this.refireCount++;

        // Shots leave the barrel, not the middle of the player. The character
        // holds a weapon out to one side, so the two are a good few pixels apart
        // and projectiles appearing at the centre visibly missed the gun.
        const muzzle = this.getMuzzleWorldPosition();
        const originX = muzzle ? muzzle.x : this.x + Math.cos(this.angle) * (this.radius + 5);
        const originY = muzzle ? muzzle.y : this.y + Math.sin(this.angle) * (this.radius + 5);

        // Firing from an off-centre point along the facing angle would send every
        // shot on a line parallel to the crosshair but never through it, so the
        // player would miss what they were pointing at by the width of the offset.
        // Aiming from the barrel at the aim point instead keeps the gun honest.
        let aimAngle = this.angle;
        if (muzzle && Number.isFinite(this.aimX) && Number.isFinite(this.aimY)) {
            const toAimX = this.aimX - originX;
            const toAimY = this.aimY - originY;
            if (Math.hypot(toAimX, toAimY) > MIN_AIM_CONVERGE_DISTANCE) {
                aimAngle = Math.atan2(toAimY, toAimX);
            }
        }

        // Hitscan guns: the pistol, shotgun and rifle. Each bullet is instant,
        // with Doom's spread -- none on the pistol's first shot.
        if (weapon.hitscan) {
            for (let i = 0; i < weapon.numPellets; i++) {
                const straight = weapon.accurateFirstShot && refire === 0;
                const angle = aimAngle + (straight ? 0 : playerSpread(weapon.spreadDegrees));
                this.fireHitscan(originX, originY, angle, rollWeaponDamage(weapon));
            }
            return;
        }

        // Create projectiles based on weapon type
        for (let i = 0; i < weapon.numPellets; i++) {
            let bulletAngle = aimAngle;
            if (weapon.spread > 0) {
                bulletAngle += playerSpread(weapon.spread * 180 / Math.PI);
            }

            // Create bullet with weapon-specific properties. Damage is rolled
            // per shot from the weapon's dice, as Doom rolled it.
            const bullet = createBullet({
                x: originX,
                y: originY,
                angle: bulletAngle,
                speed: weapon.bulletSpeed,
                owner: 'player',
                damage: rollWeaponDamage(weapon),
                color: weapon.color,
                isRocket: weapon.isRocket || false,
                aoeRadius: weapon.aoeRadius || 0,
                splash: weapon.splashDamage !== undefined ? weapon.splashDamage : null,
                explosionDuration: weapon.explosionDuration || 0,
                isBFG: weapon.isBFG || false,
                tracerDamage: weapon.tracerDamage || 0,
                tracerDice: weapon.tracerDice || null,
                tracerCount: weapon.tracerCount || 40,
                tracerConeDegrees: weapon.tracerConeDegrees || 90,
                life: weapon.bulletLife || 0,
                radius: weapon.bulletRadius || 0
            });

            // Add bullet to game state
            if (window.gameState?.bullets) {
                window.gameState.bullets.push(bullet);
            }
        }
    }

    /**
     * One instant bullet from the player: P_LineAttack. It hits the first
     * monster, boss or barrel along the ray, or the wall behind them, where
     * it throws a puff and can throw a switch.
     *
     * @param {number} x - Muzzle X
     * @param {number} y - Muzzle Y
     * @param {number} angle - Direction in radians, spread included
     * @param {number} damage - Damage for this bullet
     * @returns {{thing: Object|null, x: number, y: number}} What it hit and where
     */
    fireHitscan(x, y, angle, damage) {
        const gs = window.gameState;
        const hit = traceShot(x, y, angle, this);

        if (hit.thing) {
            if (hit.thing.bloodColor !== null && hit.thing.bloodColor !== undefined) {
                spawnBlood(hit.x, hit.y, angle, { color: hit.thing.bloodColor, amount: 6 });
            }
            hit.thing.takeDamage(damage, this);
        } else if (hit.wall) {
            spawnSparks(hit.x, hit.y, 3);
            if (hit.wall.tile === TILE_SWITCH) gs?.pressSwitchAt?.(hit.wall.c, hit.wall.r);
        }

        gs?.temporaryVisualEffects?.push({
            type: 'tracer', startX: x, startY: y, endX: hit.x, endY: hit.y,
            life: 3, color: '#fff2b0',
        });
        return hit;
    }

    /**
     * Performs a melee attack with the current weapon
     * @param {Object} weapon - The melee weapon being used
     */
    performMeleeAttack(weapon) {
        // Play melee sound
        playShootSound(weapon.name);

        // Doom alerts monsters on any attack, the fist included.
        window.gameState?.noiseAlert?.(this.x, this.y);

        // Set cooldown for next attack
        this.shootCooldown = weapon.fireRate;

        // Define melee range
        // Reach comes from the weapon: a knife jabs, a bat swings further.
        const meleeRange = weapon.meleeRange || 50; // pixels

        // Whether this swing landed on anything, so the impact plays once.
        let connected = false;

        // Check for enemies within melee range
        if (window.gameState?.enemies) {
            window.gameState.enemies.forEach(enemy => {
                if (enemy.isDead || enemy.health <= 0 || enemy.dormant) return;
                const dx = enemy.x - this.x;
                const dy = enemy.y - this.y;

                // Reach is measured to the nearest edge of the drawn body, not to
                // its centre: a tall monster's chest is well inside a swing that
                // its feet are not.
                const distance = distanceToShape(hitShapeOf(enemy), this.x, this.y);

                // Check if enemy is in range and in front of player (roughly)
                if (distance <= meleeRange) {
                    // Check if enemy is roughly in the direction player is facing
                    const angleToEnemy = Math.atan2(dy, dx);
                    const angleDiff = Math.abs(angleToEnemy - this.angle);
                    const normalizedAngleDiff = Math.min(angleDiff, 2 * Math.PI - angleDiff);

                    // Attack if enemy is within 90 degrees of facing direction AND
                    // there is no wall in between -- melee used to hit straight
                    // through walls, letting the player safely chainsaw enemies in
                    // the next room.
                    if (normalizedAngleDiff <= Math.PI / 2 &&
                        isPathClear(this.x, this.y, enemy.x, enemy.y, window.gameState?.gameMap)) {
                        if (enemy.bloodColor !== null) {
                            spawnBlood(enemy.x, enemy.y, angleToEnemy,
                                       { color: enemy.bloodColor, amount: weapon.isHeavyMelee ? 14 : 8 });
                        }
                        enemy.takeDamage(rollWeaponDamage(weapon), this);
                        connected = true;
                    }
                }
            });
        }

        // Barrels in reach take the blow too -- which is one way to set one off
        for (const barrel of window.gameState?.barrels || []) {
            if (barrel.isDead) continue;
            const dx = barrel.x - this.x;
            const dy = barrel.y - this.y;
            if (Math.hypot(dx, dy) - barrel.radius > meleeRange) continue;
            const angleDiff = Math.abs(Math.atan2(dy, dx) - this.angle);
            if (Math.min(angleDiff, 2 * Math.PI - angleDiff) > Math.PI / 2) continue;
            barrel.takeDamage(rollWeaponDamage(weapon), this);
            connected = true;
        }

        // Check for boss within melee range
        if (window.gameState?.currentBoss) {
            const boss = window.gameState.currentBoss;
            const dx = boss.x - this.x;
            const dy = boss.y - this.y;
            const distance = distanceToShape(hitShapeOf(boss), this.x, this.y);

            if (distance <= meleeRange && !boss.isDead && boss.health > 0) {
                const angleToEnemy = Math.atan2(dy, dx);
                const angleDiff = Math.abs(angleToEnemy - this.angle);
                const normalizedAngleDiff = Math.min(angleDiff, 2 * Math.PI - angleDiff);

                if (normalizedAngleDiff <= Math.PI / 2 &&
                    isPathClear(this.x, this.y, boss.x, boss.y, window.gameState?.gameMap)) {
                    if (boss.bloodColor !== null) {
                        spawnBlood(boss.x, boss.y, angleToEnemy, { color: boss.bloodColor, amount: 10 });
                    }
                    boss.takeDamage(rollWeaponDamage(weapon), this);
                    connected = true;
                }
            }
        }

        if (connected) {
            playMeleeHitSound(Boolean(weapon.isHeavyMelee));
        }
    }

    /**
     * Updates weapon UI display to show current weapon and ammo status
     */
    updateWeaponUI() {
        this.weapons.forEach((weapon, index) => {
            // Every weapon in the roster has its own HUD slot, keyed by name.
            const iconElement = document.querySelector(`[data-weapon-name="${weapon.name}"]`);
            if (iconElement) {
                // Update ownership status
                if (weapon.owned) {
                    iconElement.classList.add('owned');
                } else {
                    iconElement.classList.remove('owned');
                }

                // Update selection status
                if (index === this.currentWeaponIndex) {
                    iconElement.classList.add('selected-weapon-icon');
                } else {
                    iconElement.classList.remove('selected-weapon-icon');
                }

                // Update ammo display
                const ammoDisplay = iconElement.querySelector('.ammo-text-display');
                if (ammoDisplay) {
                    if (weapon.ammo === Infinity) {
                        ammoDisplay.textContent = 'Inf';
                    } else if (weapon.owned) {
                        ammoDisplay.textContent = weapon.ammo.toString();
                    } else if (weapon.ammo > 0) {
                        // Show collected ammo for unowned weapons with a different style
                        ammoDisplay.textContent = `(${weapon.ammo})`;
                    } else {
                        ammoDisplay.textContent = '--';
                    }
                }
            }
        });
    }

    /**
     * Main update function called every frame
     * Handles movement, animation, shooting, and interactions
     */
    update() {
        // A dead player stops acting but keeps animating, so the death plays out
        // on screen instead of being cancelled on the frame it started.
        if (this.health <= 0) {
            this.isMoving = false;
            this.muzzleFlashTimer = 0;
            this.handleAnimation();
            this.checkHealthStatus();
            return;
        }

        if (this.muzzleFlashTimer > 0) this.muzzleFlashTimer--;

        this.applyTerrainEffects();
        this.handleMovement();
        this.handleAnimation();
        this.updateAiming();
        this.handleShooting();
        this.checkHealthStatus();
    }

    /**
     * The terrain tile the player is standing in, if any.
     *
     * Read from the tile under the player's CENTRE rather than from everything
     * their body overlaps. Anything wider would set them on fire for brushing past
     * a lava bank with one shoulder, and the pools are drawn tile-shaped, so the
     * centre is the reading that matches what the screen shows.
     *
     * @returns {number} A tile value, TILE_EMPTY when standing on ordinary ground
     */
    currentTerrainTile() {
        const gameMap = window.gameState?.gameMap;
        if (!gameMap) return TILE_EMPTY;

        const tileX = Math.floor(this.x / TILE_SIZE);
        const tileY = Math.floor(this.y / TILE_SIZE);
        if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) return TILE_EMPTY;

        const row = gameMap[tileY];
        return row ? row[tileX] : TILE_EMPTY;
    }

    /**
     * Applies whatever the ground underfoot is doing to the player.
     *
     * Damage accrues as a debt in fractional hit points and is spent whole, so a
     * rate quoted per second lands as that rate however the frame timing falls.
     * The pain sound is throttled separately from the damage: lava deals damage
     * every single frame and playing the hit sound at 60Hz is a klaxon, not
     * feedback.
     *
     * Phasing through walls does not make you fireproof -- the cheat is about
     * geometry -- but the debt is still reset when leaving the tile so it cannot
     * accumulate across two separate dips into the same pool.
     */
    applyTerrainEffects() {
        const tile = this.currentTerrainTile();
        const terrain = getTerrain(tile);

        if (this.terrainHurtCooldown > 0) this.terrainHurtCooldown--;

        if (tile !== this.terrainTile) {
            this.terrainTile = tile;
            this.terrainDamageDebt = 0;
        }

        if (!terrain || terrain.damagePerSecond <= 0) return;

        this.terrainDamageDebt += terrain.damagePerSecond / ANIMATION_TICKS_PER_SECOND;
        const whole = Math.floor(this.terrainDamageDebt);
        if (whole <= 0) return;

        this.terrainDamageDebt -= whole;
        this.health = Math.max(0, this.health - whole);
        this.updateHealthDisplay();

        if (this.terrainHurtCooldown === 0) {
            playPlayerHitSound();
            this.terrainHurtCooldown = TERRAIN_HURT_SOUND_INTERVAL;
        }
    }

    /**
     * Handles player movement input and collision detection
     */
    handleMovement() {
        let moveX = 0;
        let moveY = 0;

        // Liquids drag. Water is the clearest case of what this is for: it does no
        // damage at all, so the only thing wading costs is time -- which is a real
        // cost with something shooting at you, and turns a flooded room into a
        // decision rather than scenery.
        // Hold Shift to run. Doom's run doubles the walking speed, and since
        // the monsters are tuned to Doom's numbers the same ratio is used here:
        // a running marine outpaces everything but the Arch-vile.
        this.isRunning = !!keys.Shift;
        const baseSpeed = this.isRunning ? this.runSpeed : this.walkSpeed;
        const speed = baseSpeed * terrainSpeedMultiplier(this.terrainTile);

        // Process movement input
        if (keys.w || keys.ArrowUp) moveY -= speed;
        if (keys.s || keys.ArrowDown) moveY += speed;
        if (keys.a || keys.ArrowLeft) moveX -= speed;
        if (keys.d || keys.ArrowRight) moveX += speed;

        this.isMoving = (moveX !== 0 || moveY !== 0);

        // Normalize diagonal movement
        if (moveX !== 0 && moveY !== 0) {
            const factor = Math.sqrt(0.5);
            moveX *= factor;
            moveY *= factor;
        }

        // Collision detection
        if (moveX !== 0 || moveY !== 0) {
            this.handleCollisionAndMovement(moveX, moveY);
        }
    }

    /**
     * Handles collision detection and movement execution
     * 
     * @param {number} moveX - Intended X movement
     * @param {number} moveY - Intended Y movement
     */
    handleCollisionAndMovement(moveX, moveY) {
        const currentTileX = Math.floor(this.x / TILE_SIZE);
        const currentTileY = Math.floor(this.y / TILE_SIZE);
        let collisionX = false;
        let collisionY = false;
        const checkRadius = this.radius * 0.9;

        // Collision probing uses a PURE predicate.
        //
        // These probes look one step ahead at up to six tiles the player may never
        // actually enter. They used to call checkTileInteraction(), which mutates the
        // world: keys and weapons were collected, doors opened and the level exit
        // triggered from tiles merely brushed alongside, up to a tile early.
        // Interaction now happens separately, against tiles the player really occupies.

        // Check X-axis collision
        if (moveX !== 0) {
            const nextTileCenterX = Math.floor((this.x + moveX + Math.sign(moveX) * checkRadius) / TILE_SIZE);
            if (this.isTileBlocking(nextTileCenterX, Math.floor((this.y - checkRadius) / TILE_SIZE)) ||
                this.isTileBlocking(nextTileCenterX, Math.floor((this.y + checkRadius) / TILE_SIZE)) ||
                this.isTileBlocking(nextTileCenterX, currentTileY)) {
                collisionX = true;
            }
        }

        // Check Y-axis collision
        if (moveY !== 0) {
            const nextTileCenterY = Math.floor((this.y + moveY + Math.sign(moveY) * checkRadius) / TILE_SIZE);
            if (this.isTileBlocking(Math.floor((this.x - checkRadius) / TILE_SIZE), nextTileCenterY) ||
                this.isTileBlocking(Math.floor((this.x + checkRadius) / TILE_SIZE), nextTileCenterY) ||
                this.isTileBlocking(currentTileX, nextTileCenterY)) {
                collisionY = true;
            }
        }

        // Pushing into a locked door with its key unlocks it, and pushing into
        // a switch presses it: the tile has to be touched once. Only the tile
        // straight ahead counts as touched -- the diagonal probes are looking
        // past the player's shoulders.
        if (moveX !== 0 && collisionX) {
            this.touchTile(Math.floor((this.x + moveX + Math.sign(moveX) * checkRadius) / TILE_SIZE), currentTileY);
        }
        if (moveY !== 0 && collisionY) {
            this.touchTile(currentTileX, Math.floor((this.y + moveY + Math.sign(moveY) * checkRadius) / TILE_SIZE));
        }

        // Barrels are solid too, and a body, not a tile
        if (!collisionX && this.hitsBarrel(this.x + moveX, this.y)) collisionX = true;
        if (!collisionY && this.hitsBarrel(this.x, this.y + moveY)) collisionY = true;

        // Apply movement if no collision
        if (!collisionX) this.x += moveX;
        if (!collisionY) this.y += moveY;

        this.interactWithOccupiedTiles();
    }

    /**
     * Whether moving to a position would push into a barrel. A body already
     * overlapping one is allowed any step that takes it further away.
     *
     * @param {number} nx - Candidate X
     * @param {number} ny - Candidate Y
     * @returns {boolean} True if blocked
     */
    hitsBarrel(nx, ny) {
        const barrels = window.gameState?.barrels;
        if (!barrels || barrels.length === 0 || this.canPhase) return false;
        const reach = this.radius * 0.9;
        for (const barrel of barrels) {
            if (barrel.isDead) continue;
            const limit = reach + barrel.radius;
            const dxN = barrel.x - nx;
            const dyN = barrel.y - ny;
            const afterSq = dxN * dxN + dyN * dyN;
            if (afterSq >= limit * limit) continue;
            const dx0 = barrel.x - this.x;
            const dy0 = barrel.y - this.y;
            if (afterSq < dx0 * dx0 + dy0 * dy0) return true;
        }
        return false;
    }

    /**
     * Acts on a tile the player is pushing against: unlocks a keyed door if
     * they hold its key, presses a switch.
     *
     * @param {number} tileX - Tile column
     * @param {number} tileY - Tile row
     * @returns {boolean} True if the touch did something
     */
    touchTile(tileX, tileY) {
        const gameMap = window.gameState?.gameMap;
        const tile = gameMap && gameMap[tileY] ? gameMap[tileY][tileX] : undefined;

        if (tile === TILE_SWITCH) {
            return !!window.gameState?.pressSwitchAt?.(tileX, tileY);
        }

        if (!isKeyedDoorTile(tile)) return false;
        if (!this.keysCollected[doorKeyName(tile)]) return false;

        const door = unlockDoorAt(tileX, tileY);
        if (!door) return false;
        this.updateKeyUI();
        return true;
    }

    /** @deprecated Use touchTile */
    touchDoor(tileX, tileY) {
        return this.touchTile(tileX, tileY);
    }

    /**
     * Pure test for whether a tile blocks the player. Has no side effects.
     *
     * A closed door the player holds the key for is NOT blocking -- the player walks
     * onto it and interactWithOccupiedTiles() opens it. Secret doors are likewise
     * passable so that pushing into a wall still reveals them, matching the original
     * behaviour.
     *
     * @param {number} tileX - Tile X coordinate
     * @param {number} tileY - Tile Y coordinate
     * @returns {boolean} True if the tile blocks movement
     */
    isTileBlocking(tileX, tileY) {
        if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) {
            return !this.canPhase;
        }

        const gameMap = window.gameState?.gameMap;
        if (!gameMap || !gameMap[tileY]) return false;

        if (this.canPhase) return false; // Phase cheat walks through everything

        switch (gameMap[tileY][tileX]) {
            case TILE_WALL:
            case TILE_PROP:
            case TILE_SWITCH:
            case TILE_WINDOW:
                return true;
            case TILE_SLIDE:
                return !isSlideOpen(tileX, tileY);
            case TILE_DOOR_RED:
            case TILE_DOOR_YELLOW:
            case TILE_DOOR_BLUE: {
                // Locked without the key. With it, the door still blocks until
                // it has been touched and has slid open far enough.
                const tile = gameMap[tileY][tileX];
                if (!this.keysCollected[doorKeyName(tile)]) return true;
                return !isDoorOpen(tileX, tileY);
            }
            case TILE_EXIT: {
                // A living boss seals the exit
                const boss = window.gameState?.currentBoss;
                return !!(boss && boss.health > 0 && !boss.isDead);
            }
            default:
                return false;
        }
    }

    /**
     * Applies tile interactions for every tile the player's body currently overlaps.
     * This is where pickups, door opening, secret discovery and the level exit fire.
     */
    interactWithOccupiedTiles() {
        const r = this.radius * 0.9;
        const minTileX = Math.floor((this.x - r) / TILE_SIZE);
        const maxTileX = Math.floor((this.x + r) / TILE_SIZE);
        const minTileY = Math.floor((this.y - r) / TILE_SIZE);
        const maxTileY = Math.floor((this.y + r) / TILE_SIZE);

        for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
            for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
                this.checkTileInteraction(tileX, tileY);
            }
        }
    }

    /**
     * Handles animation frame progression
     */
    handleAnimation() {
        this.updateAnimation();
    }

    /**
     * Updates player aiming based on mouse position
     */
    updateAiming() {
        // mouse is imported from input-handler.js at module level
        if (mouse && window.gameController) {
            // Get current canvas dimensions and zoom level
            const canvas = window.gameController.canvas;
            const zoomLevel = window.gameController.zoomLevel;

            if (canvas) {
                // Convert mouse coordinates to world coordinates accounting for zoom and transforms
                // Mouse coordinates are relative to canvas, need to transform to world space
                const canvasWidth = canvas.width;
                const canvasHeight = canvas.height;

                // Calculate offset from center of viewport
                const mouseOffsetX = (mouse.x - canvasWidth / 2) / zoomLevel;
                const mouseOffsetY = (mouse.y - canvasHeight / 2) / zoomLevel;

                // World mouse position is player position plus the offset
                const worldMouseX = this.x + mouseOffsetX;
                const worldMouseY = this.y + mouseOffsetY;

                this.angle = Math.atan2(worldMouseY - this.y, worldMouseX - this.x);

                // Kept so shots fired from the barrel can be aimed at the point
                // the player is actually pointing at, rather than merely running
                // parallel to it.
                this.aimX = worldMouseX;
                this.aimY = worldMouseY;
            }
        }
    }

    /**
     * Handles shooting input and weapon firing
     */
    handleShooting() {
        const weapon = this.getCurrentWeapon();
        // mouse is imported from input-handler.js at module level

        // Reduce shoot cooldown
        if (this.shootCooldown > 0) this.shootCooldown--;

        // Handle shooting input
        if (mouse?.down && this.shootCooldown === 0) {
            if (weapon.singleShot) {
                // Single-shot weapons (knife, pistol, rocket launcher, BFG)
                if (!this.singleShotFiredThisClick) {
                    this.shoot();
                    this.singleShotFiredThisClick = true;
                }
            } else {
                // Held-trigger weapons (rifle, flamethrower, bat)
                this.shoot();
            }
        }

        // Reset single-shot flag when mouse released
        if (!mouse?.down) {
            this.singleShotFiredThisClick = false;
            this.refireCount = 0;
        }
    }

    /**
     * Checks if player health is depleted
     */
    checkHealthStatus() {
        if (this.health <= 0) {
            // Hand off to the game state, which holds the run open long enough
            // for the death animation before showing the game-over screen.
            window.gameState?.beginPlayerDeath();
        } else if (this.health <= this.maxHealth * 0.25) {
            // Play low health warning when health drops below 25%
            playLowHealthWarning();
        }
    }

    /**
     * Checks tile interactions and handles pickups, doors, etc.
     * 
     * @param {number} tileX - Tile X coordinate to check
     * @param {number} tileY - Tile Y coordinate to check
     * @returns {boolean} True if tile blocks movement, false if passable
     */
    checkTileInteraction(tileX, tileY) {
        // Check map boundaries
        if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) {
            return !this.canPhase;
        }

        const gameMap = window.gameState?.gameMap;
        if (!gameMap || !gameMap[tileY]) return false;

        const tileType = gameMap[tileY][tileX];

        // Phase mode used to short-circuit this whole method, which made walls
        // passable but also disabled every pickup, door and the level exit -- the
        // cheat left the level uncompletable. It now only suppresses blocking.

        switch (tileType) {
            case TILE_WALL:
            case TILE_PROP:
            case TILE_SWITCH:
            case TILE_SLIDE:
            case TILE_WINDOW:
                return !this.canPhase;

            // Colored doors. Standing on one (it opened for you, or you phased
            // in) with the key counts as touching it; the tile stays a door.
            case TILE_DOOR_RED:
            case TILE_DOOR_YELLOW:
            case TILE_DOOR_BLUE:
                if (this.keysCollected[doorKeyName(tileType)]) {
                    this.touchDoor(tileX, tileY);
                    return false;
                }
                return !this.canPhase; // Locked without the key, unless phasing
                
            // Key pickups
            case TILE_KEY_RED:
                this.keysCollected.red = true;
                gameMap[tileY][tileX] = TILE_EMPTY;
                playKeyPickupSound();
                this.updateKeyUI();
                this.addScore(GAME_BALANCE.KEY_PICKUP_POINTS);
                window.gameState?.recordItem?.('key');
                return false;
                
            case TILE_KEY_YELLOW:
                this.keysCollected.yellow = true;
                gameMap[tileY][tileX] = TILE_EMPTY;
                playKeyPickupSound();
                this.updateKeyUI();
                this.addScore(GAME_BALANCE.KEY_PICKUP_POINTS);
                window.gameState?.recordItem?.('key');
                return false;
                
            case TILE_KEY_BLUE:
                this.keysCollected.blue = true;
                gameMap[tileY][tileX] = TILE_EMPTY;
                playKeyPickupSound();
                this.updateKeyUI();
                this.addScore(GAME_BALANCE.KEY_PICKUP_POINTS);
                window.gameState?.recordItem?.('key');
                return false;
                
            // Level exit
            case TILE_EXIT: {
                // Any living boss seals the exit. This previously only checked
                // isCurrentLevelMiniBoss, so on main boss levels (every 5th) the
                // generator still placed a normal exit tile that was not gated at
                // all -- the player could walk straight past the boss and skip the
                // entire encounter.
                const boss = window.gameState?.currentBoss;
                if (boss && boss.health > 0 && !boss.isDead) {
                    return true; // Exit blocked until the boss is defeated
                }
                window.gameState?.levelComplete();
                return false;
            }
                
            // Weapon pickups
            case TILE_WEAPON_SHOTGUN:
                if (this.addWeapon(WEAPON_STATS["Shotgun"])) {
                    gameMap[tileY][tileX] = TILE_EMPTY;
                    window.gameState?.recordItem?.('weapon');
                }
                return false;

            case TILE_WEAPON_RIFLE:
                if (this.addWeapon(WEAPON_STATS["Rifle"])) {
                    gameMap[tileY][tileX] = TILE_EMPTY;
                    window.gameState?.recordItem?.('weapon');
                }
                return false;

            case TILE_WEAPON_ROCKETLAUNCHER:
                if (this.addWeapon(WEAPON_STATS["Rocket Launcher"])) {
                    gameMap[tileY][tileX] = TILE_EMPTY;
                    window.gameState?.recordItem?.('weapon');
                }
                return false;

            case TILE_WEAPON_BFG:
                if (this.addWeapon(WEAPON_STATS["BFG"])) {
                    gameMap[tileY][tileX] = TILE_EMPTY;
                    window.gameState?.recordItem?.('weapon');
                }
                return false;

            case TILE_WEAPON_PLASMAGUN:
                if (this.addWeapon(WEAPON_STATS["Plasma Gun"])) {
                    gameMap[tileY][tileX] = TILE_EMPTY;
                    window.gameState?.recordItem?.('weapon');
                }
                return false;

            // Health pack
            case TILE_HEALTH_PACK:
                if (this.gainHealth(GAME_BALANCE.HEALTH_PACK_VALUE)) {
                    gameMap[tileY][tileX] = TILE_EMPTY;
                    window.gameState?.recordItem?.('health');
                }
                return false;
                
            // Secret door
            case TILE_SECRET_DOOR:
                gameMap[tileY][tileX] = TILE_EMPTY;
                playSecretDoorOpenSound();
                this.addScore(GAME_BALANCE.SECRET_DOOR_POINTS);
                window.gameState?.recordSecret?.();
                return false;
                
            case TILE_EMPTY:
            default:
                return false;
        }
    }

    /**
     * Attempts to restore health
     * Returns true if health was gained, false if already at max
     *
     * @param {number} amount - Health to restore
     * @returns {boolean} True if health was gained, false if at max
     */
    gainHealth(amount, options = {}) {
        // A soulsphere heals past the bar, to Doom's 200; everything else stops
        // at the bar.
        const cap = options.cap || this.maxHealth;
        if (this.health >= cap) {
            return false; // Already at the cap - leave item on ground
        }

        const oldHealth = this.health;
        this.health = Math.min(this.health + amount, cap);

        if (this.health > oldHealth) {
            if (!options.silent) playHealthPickupSound();
            this.updateHealthDisplay();
            return true;
        }

        return false;
    }

    /**
     * Reduces player health and handles damage effects.
     *
     * On the easiest skill the player feels half of every hit, as on Doom's
     * "I'm Too Young To Die" (P_DamageMobj: `if (gameskill == sk_baby)
     * damage >>= 1`). The monsters' own numbers are never touched.
     *
     * @param {number} amount - Damage to deal
     */
    takeDamage(amount) {
        const taken = getDifficultyMultipliers(window.gameState?.selectedDifficulty || 'medium').damageTaken;
        this.health = Math.max(0, this.health - amount * taken);
        playPlayerHitSound();
        this.updateHealthDisplay();

        // Damage feedback handled by audio and UI updates
    }

    /**
     * Adds points to the player's score
     * 
     * @param {number} points - Points to add
     */
    addScore(points) {
        if (window.gameState) {
            window.gameState.score += points;
            this.updateScoreDisplay();
        }
    }

    /**
     * Updates the health display in the UI
     */
    updateHealthDisplay() {
        const healthDisplay = document.getElementById('healthDisplay');
        if (healthDisplay) {
            healthDisplay.textContent = Math.ceil(this.health);
        }

        // The readout flashes at a quarter health or less
        const container = document.getElementById('healthDisplayContainer');
        if (container?.classList) {
            container.classList.toggle('low', this.health > 0 && this.health <= this.maxHealth * 0.25);
        }
    }

    /**
     * Updates the score display in the UI
     */
    updateScoreDisplay() {
        const scoreDisplay = document.getElementById('scoreDisplay');
        if (scoreDisplay && window.gameState) {
            scoreDisplay.textContent = window.gameState.score;
        }
    }

    /**
     * Updates the key collection display in the UI
     */
    updateKeyUI() {
        const redKeyIcon = document.getElementById('redKeyIcon');
        const yellowKeyIcon = document.getElementById('yellowKeyIcon');
        const blueKeyIcon = document.getElementById('blueKeyIcon');
        
        if (redKeyIcon) {
            redKeyIcon.classList.toggle('collected', this.keysCollected.red);
        }
        if (yellowKeyIcon) {
            yellowKeyIcon.classList.toggle('collected', this.keysCollected.yellow);
        }
        if (blueKeyIcon) {
            blueKeyIcon.classList.toggle('collected', this.keysCollected.blue);
        }
    }

    /**
     * Calculates distance to another entity
     * @param {Object} target - Target entity with x, y properties
     * @returns {number} Distance in pixels
     */
    distanceTo(target) {
        return Math.hypot(target.x - this.x, target.y - this.y);
    }

    /**
     * Calculates squared distance (faster for comparisons)
     * @param {Object} target - Target entity with x, y properties
     * @returns {number} Squared distance
     */
    distanceSquaredTo(target) {
        const dx = target.x - this.x;
        const dy = target.y - this.y;
        return dx * dx + dy * dy;
    }

    /**
     * Debug: Collect all keys (cheat)
     */
    collectAllKeys() {
        this.keysCollected = { red: true, yellow: true, blue: true };
        this.updateKeyUI();
    }

    /**
     * Debug: Acquire all weapons (cheat)
     */
    collectAllGuns() {
        this.weapons.forEach(weapon => {
            weapon.owned = true;
            if (weapon.ammo !== Infinity) {
                weapon.ammo = weapon.maxAmmo;
            }
        });
        this.updateWeaponUI();
    }

    /**
     * Renders the player on the canvas
     * Uses sprite animation or fallback circle rendering
     * 
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     */
    /**
     * Draws the player from the character atlas.
     *
     * These are top-down sprites with a single facing, so the whole sprite is
     * rotated to wherever the player is aiming. The source art aims straight
     * down, which the manifest records as `sourceAngle`; rotating by
     * (aim - sourceAngle) about the measured pivot points the weapon at the
     * cursor while the body stays on the player's position.
     *
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     * @returns {boolean} True if the sprite was drawn; false to fall back to a shape
     */
    drawSprite(ctx) {
        const meta = this.getSpriteMeta();
        if (!meta) return false;

        const atlas = getPlayerAtlas(this.spriteSlug);
        if (!atlas || !atlas.complete || atlas.naturalHeight === 0) return false;

        const weapon = this.animation === PLAYER_ANIM.DEATH ? null : this.getSpriteWeapon();
        const range = resolvePlayerAnimation(meta, this.animation, weapon);
        if (!range) return false;

        const frame = getPlayerFrameRect(meta, range, Math.floor(this.animFrame));
        const scale = (this.radius * PLAYER_SPRITE_BODY_PER_RADIUS) / meta.bodyWidth;

        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle - getPlayerSourceAngle());

        // The phase cheat walks through walls; showing the player as translucent
        // is the only cue that it is on.
        if (this.canPhase) ctx.globalAlpha = 0.5;

        ctx.drawImage(
            atlas,
            frame.x, frame.y, frame.width, frame.height,
            -meta.pivotX * scale, -meta.pivotY * scale,
            meta.frameWidth * scale, meta.frameHeight * scale
        );

        ctx.restore();
        return true;
    }

    draw(ctx) {
        if (this.drawSprite(ctx)) return;

        // Fallback circle rendering
        ctx.save();
        ctx.translate(this.x, this.y);

        // Player body
        ctx.fillStyle = this.canPhase ? 'rgba(0, 123, 255, 0.5)' : '#007bff';
        ctx.beginPath();
        ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
        ctx.fill();

        // Weapon indicator
        ctx.rotate(this.angle);
        ctx.fillStyle = '#555';
        ctx.fillRect(this.radius * 0.8, -this.radius / 5, this.radius, this.radius / 2.5);

        ctx.restore();
    }
}

// =============================================================================
// ENEMY CLASS - DOOM MONSTERS
// =============================================================================

/** A_Look runs every 10 tics; the standing state's frame length. */
const LOOK_FRAMES = ticsToFrames(LOOK_INTERVAL_TICS);

/** Frames a hitscan tracer stays on screen. */
const TRACER_LIFE = 4;

/**
 * Pushes a transient drawable onto the effects list, if there is one.
 *
 * @param {Object} effect - Anything drawTemporaryEffects() knows how to draw
 * @returns {Object} The same effect, so callers can keep a handle on it
 */
function pushEffect(effect) {
    window.gameState?.temporaryVisualEffects?.push(effect);
    return effect;
}

/**
 * Enemy class -- one monster from the Doom bestiary, run by Doom's AI.
 *
 * Every enemy is an entry of MONSTERS (js/monsters.js): its hit points, speed,
 * size, pain chance and attacks are the 1993 numbers. The behaviour is a port
 * of the monster half of p_enemy.c, reorganised around a per-frame update:
 *
 *   idle    A_Look. Stands where it was placed, facing one way, and every ten
 *           tics checks whether it can see the player in the half-circle in
 *           front of it, or whether a weapon has been heard nearby. Nothing
 *           wanders. A monster flagged "ambush" is deaf and waits to be seen.
 *
 *   chase   A_Chase. Walks toward its target in one of eight directions,
 *           changing direction when blocked or when its `movecount` runs out
 *           (P_NewChaseDir). At the end of each run it may fire, with a chance
 *           that falls off with distance (P_CheckMissileRange). In melee reach
 *           it swings at once. It never loses its target: a monster that saw
 *           you once hunts you until one of you is dead.
 *
 *   attack  The wind-up and follow-through of one attack, timed from the
 *           monster's state table. Being hurt can interrupt it.
 *
 *   pain    A hit landed and the pain roll succeeded. The monster does nothing
 *           for a few tics, then returns to chasing -- and fires back at once,
 *           because MF_JUSTHIT bypasses the missile-range roll.
 *
 *   charge  The Lost Soul's flight, which stops on the first thing it hits.
 *
 * Infighting comes from the same rules Doom used: a monster hurt by another
 * monster turns on it, unless its `threshold` says it is already committed to
 * a fight, and stays on that target until it dies. Projectiles from a monster
 * of the same species burst harmlessly on it.
 */
export class Enemy {
    /**
     * Creates a monster.
     *
     * @param {number} x - Starting X world coordinate
     * @param {number} y - Starting Y world coordinate
     * @param {string} type - A key of MONSTERS; unknown ids become a Zombieman
     */
    constructor(x, y, type = 'zombieman') {
        // === POSITION & IDENTITY ===
        this.x = x;
        this.y = y;
        this.enemyType = MONSTERS[type] ? type : 'zombieman';
        this.def = MONSTERS[this.enemyType];
        this.species = this.enemyType;

        // === DOOM AI STATE ===
        this.state = 'idle';                 // idle | chase | attack | pain | charge
        this.target = null;                  // The player, or another monster
        this.threshold = 0;                  // Chase steps committed to the current target
        this.reactionTime = this.def.reactionTics;   // Chase steps before it may fire
        this.movedir = DIR.NONE;             // Direction being walked
        this.movecount = 0;                  // Steps left before choosing a new one
        this.chaseClock = 0;                 // Accumulates frames into chase steps
        this.steppedThisFrame = false;       // P_NewChaseDir already moved this frame
        this.lookClock = Math.floor(Math.random() * LOOK_FRAMES);
        this.justHit = false;                // MF_JUSTHIT: fire back next chance
        this.justAttacked = false;           // MF_JUSTATTACKED: move before firing again
        this.ambush = Math.random() < AMBUSH_CHANCE;
        this.attack = null;                  // The attack in progress, if any
        this.charge = null;                  // The Lost Soul's flight, if any
        this.painTimer = 0;                  // Frames of pain state remaining
        // Sealed in a monster closet (see js/traps.js): not drawn, not hit, not
        // thinking, until the closet opens.
        this.dormant = false;
        this.angle = this.initialFacing();   // Where the monster is looking
        this.hitTimer = 0;                   // Visual hit feedback timer

        // === ANIMATION SYSTEM ===
        this.spriteSlug = null;              // Character key into the sprite manifest
        this.animation = ENEMY_ANIM.IDLE;    // Animation currently playing
        this.animFrame = 0;                  // Position within it, in frames (fractional)
        // A one-shot animation (attack, hurt, death) owns the enemy's appearance
        // until it finishes, so a swing isn't cut off the instant the enemy moves.
        this.animLocked = false;
        this.idleBlinkTimer = randomBlinkDelay();
        this.isMoving = false;               // Movement state for animation
        this.facingDirection = getDirectionFromAngle(this.angle);

        // === LIFE ===
        this.isDead = false;                 // Set once onDeath() has run
        this.corpseTimer = 0;                // Counts down once the death animation ends

        this.initializeStats();
        this.assignSprite();
    }

    /**
     * Which way a freshly placed monster faces.
     *
     * Doom's mappers point monsters toward where the player will come from;
     * most of the time that is what happens here too, with a minority left
     * looking elsewhere so that sneaking up behind one is possible.
     *
     * @returns {number} Facing angle in radians
     */
    initialFacing() {
        const player = window.gameState?.player;
        if (player && Math.random() < 0.75) {
            return Math.atan2(player.y - this.y, player.x - this.x);
        }
        return DIR_ANGLES[Math.floor(Math.random() * 8)];
    }

    /**
     * Derives the working stats from the monster's definition.
     *
     * They are Doom's numbers and nothing else: no level scaling, no
     * difficulty scaling. Doom's skill levels never touched a monster's hit
     * points, speed or damage; they placed more or fewer monsters and, on
     * the easiest, halved what the player felt. That is how difficulty works
     * here too (see getDifficultyMultipliers), so a monster is always the
     * monster it was in 1993.
     */
    initializeStats() {
        const def = this.def;
        const multipliers = getDifficultyMultipliers(window.gameState?.selectedDifficulty || 'medium');

        this.radius = unitsToPx(def.radius);
        this.speed = chaseSpeedPx(def.speed, def.chaseTics);
        this.chaseFrames = def.chaseTics * FRAMES_PER_TIC;
        this.painFrames = ticsToFrames(def.painTics);

        this.maxHealth = def.hp;
        this.health = this.maxHealth;

        // Applied to every hit this monster lands, on the player or on another
        // monster. Doom's dice at every skill; the easiest skill halves what
        // reaches the player instead (see Player.takeDamage).
        this.damageScale = MONSTER_DAMAGE_SCALE * multipliers.monsterDamage;
        // P_CheckMissileRange's chance, unscaled
        this.attackChanceScale = 1;

        this.scoreValue = def.score;
        this.color = def.color;
        this.alpha = def.alpha !== undefined ? def.alpha : 1;
        this.spriteScale = def.spriteScale || 1;
        this.canShoot = !!def.missile;
        this.bloodColor = def.blood || BLOOD_RED;
    }

    /**
     * What a shot has to cross to hit this monster: the drawn body.
     *
     * The movement circle is a small disc at the feet; the artwork stands on
     * it and rises two radii above. Before this, a round through the chest
     * missed. The box is the manifest's body size at the size the sprite is
     * actually drawn, planted on the same anchor drawSprite() uses, and never
     * narrower than the movement circle.
     *
     * @returns {Object|null} A hitbox shape, or null to use the movement circle
     */
    getHitShape() {
        const meta = this.getSpriteMeta();
        if (!meta) return null;

        const scale = (this.radius * this.spriteScale * ENEMY_SPRITE_BODY_PER_RADIUS) / meta.bodyHeight;
        const halfWidth = Math.max(this.radius, (meta.bodyWidth * scale) / 2);
        const feetY = this.y + this.radius * ENEMY_SPRITE_FOOT_OFFSET;
        const top = Math.min(feetY - meta.bodyHeight * scale, this.y - this.radius);

        return boxShape(this.x - halfWidth, top, this.x + halfWidth, feetY);
    }

    /**
     * Calculates distance to another entity
     * @param {Object} target - Target entity with x, y properties
     * @returns {number} Distance in pixels
     */
    distanceTo(target) {
        return Math.hypot(target.x - this.x, target.y - this.y);
    }

    /**
     * Calculates squared distance (faster for comparisons)
     * @param {Object} target - Target entity with x, y properties
     * @returns {number} Squared distance
     */
    distanceSquaredTo(target) {
        const dx = target.x - this.x;
        const dy = target.y - this.y;
        return dx * dx + dy * dy;
    }

    // =========================================================================
    // SPRITES AND ANIMATION
    // =========================================================================

    /**
     * Assigns the character the roster gives this monster.
     *
     * Each Doom monster has one look, so it can be told apart at a glance the
     * way the originals could. If the manifest lacks that character the
     * monster takes a random one rather than none, and if the manifest has not
     * loaded yet it stays on the shape fallback until getSpriteMeta() retries.
     */
    assignSprite() {
        const wanted = this.def.sprite;
        this.spriteSlug = getEnemySpriteMeta(wanted) ? wanted : pickRandomEnemySprite();

        if (this.spriteSlug) {
            // Start the atlas downloading now rather than on the first draw, so
            // it is usually in place before the enemy is ever on screen.
            getEnemyAtlas(this.spriteSlug);
        }
    }

    /**
     * @returns {Object|null} This enemy's manifest entry, or null without one
     */
    getSpriteMeta() {
        // Retry the pick if the manifest was still in flight when this enemy
        // spawned, so a level that started before the artwork arrived still fills
        // in rather than staying on shapes until the next level.
        if (!this.spriteSlug) {
            this.assignSprite();
            if (!this.spriteSlug) return null;
        }

        return getEnemySpriteMeta(this.spriteSlug);
    }

    /**
     * Starts an animation.
     *
     * One-shot animations (attack, hurt, dying) lock the enemy's appearance
     * until they play out; a locked enemy ignores further requests unless the
     * new animation is itself one-shot, so being hit mid-swing still reads as a
     * hit and dying always wins.
     *
     * @param {string} animation - A value from ENEMY_ANIM
     * @param {boolean} [force] - Interrupt a locked animation regardless
     */
    playAnimation(animation, force = false) {
        if (this.animation === animation && !force) return;

        const oneShot = getEnemyOneShotAnimations();
        const isOneShot = oneShot.includes(animation);

        // A looping animation never interrupts a swing or a death throe.
        if (this.animLocked && !isOneShot && !force) return;

        this.animation = animation;
        this.animFrame = 0;
        this.animLocked = isOneShot;
    }

    /**
     * Chooses the looping animation that matches the enemy's current behaviour.
     *
     * A Doom monster never strolls: it stands until it has a target and then
     * comes at it flat out. Whether that looks like walking or running is a
     * question of how fast the monster actually is.
     *
     * @returns {string} An animation name from ENEMY_ANIM
     */
    selectIdleOrMoveAnimation() {
        if (this.isMoving) {
            return (this.charge || this.speed >= RUN_ANIMATION_SPEED) ? ENEMY_ANIM.RUN : ENEMY_ANIM.WALK;
        }

        // Standing still: drop into the idle variation now and then so a room of
        // waiting enemies isn't a set of statues.
        if (this.idleBlinkTimer > 0) {
            this.idleBlinkTimer--;
            return ENEMY_ANIM.IDLE;
        }

        return ENEMY_ANIM.IDLE_BLINK;
    }

    /**
     * Advances the current animation and picks the next one when it ends.
     */
    updateAnimation() {
        const meta = this.getSpriteMeta();
        if (!meta) return;

        const range = resolveEnemyAnimation(meta, this.animation, this.facingDirection);
        if (!range) return;

        const rates = getEnemyFrameRates();
        const fps = rates[this.animation] || 12;
        this.animFrame += fps / ANIMATION_TICKS_PER_SECOND;

        if (this.animFrame < range.count) return;

        if (!this.animLocked) {
            // Looping: wrap, and re-arm the blink once an idle variation has played.
            this.animFrame %= range.count;
            if (this.animation === ENEMY_ANIM.IDLE_BLINK) {
                this.idleBlinkTimer = randomBlinkDelay();
            }
            return;
        }

        // A one-shot has run its course.
        if (this.animation === ENEMY_ANIM.DYING) {
            // Hold the final pose; updateEnemies() removes the body once the
            // corpse timer, started here, runs out.
            this.animFrame = range.count - 1;
            return;
        }

        this.animLocked = false;
        this.animFrame = 0;
        this.playAnimation(this.selectIdleOrMoveAnimation());
    }

    /**
     * Points the monster at an angle, and its sprite with it.
     *
     * @param {number} angle - Radians
     */
    face(angle) {
        this.angle = angle;
        this.facingDirection = getDirectionFromAngle(angle);
    }

    /** A_FaceTarget. */
    faceTarget() {
        if (!this.targetAlive()) return;
        this.face(Math.atan2(this.target.y - this.y, this.target.x - this.x));
    }

    // =========================================================================
    // UPDATE
    // =========================================================================

    /**
     * Main update function called every frame.
     */
    update() {
        // A dead enemy is purely a corpse playing out its death animation: no
        // AI, no movement, no attacks. It is still drawn, and still counts as an
        // entity until isReadyToRemove() says the animation is done.
        // Decay the damage flash first: a corpse that skipped this stayed pinned
        // at full brightness for its entire death animation.
        if (this.hitTimer > 0) this.hitTimer--;

        if (this.isDead) {
            this.isMoving = false;
            this.updateAnimation();

            // The linger only starts once the body has finished falling.
            if (this.corpseTimer > 0 && this.isDeathAnimationFinished()) {
                this.corpseTimer--;
            }
            return;
        }

        // Waiting in a closet: no looking, no listening, no moving.
        if (this.dormant) {
            this.isMoving = false;
            this.updateAnimation();
            return;
        }

        if (this.painTimer > 0) {
            // The pain state: a few tics of doing nothing at all.
            this.painTimer--;
            this.isMoving = false;
            if (this.painTimer === 0) this.state = this.target ? 'chase' : 'idle';
        } else if (this.charge) {
            this.updateCharge();
        } else if (this.attack) {
            this.updateAttack();
        } else if (!this.target) {
            this.look();
        } else {
            this.chase();
        }

        // Settle on a looping animation unless an attack, flinch or death is
        // still playing -- updateAnimation() releases the lock when it ends.
        if (!this.animLocked) {
            this.playAnimation(this.selectIdleOrMoveAnimation());
        }

        this.updateAnimation();
    }

    /**
     * @returns {boolean} True while the current target can still be fought
     */
    targetAlive() {
        const t = this.target;
        return !!t && t.health > 0 && !t.isDead;
    }

    /**
     * @param {Object} thing - Anything with x and y
     * @returns {boolean} True if nothing solid stands between them
     */
    hasLineOfSight(thing) {
        return isPathClear(this.x, this.y, thing.x, thing.y, window.gameState?.gameMap);
    }

    // =========================================================================
    // A_Look: STANDING AND WATCHING
    // =========================================================================

    /**
     * The standing state. Every ten tics, listens and looks.
     */
    look() {
        this.state = 'idle';
        this.isMoving = false;

        if (++this.lookClock < LOOK_FRAMES) return;
        this.lookClock = 0;

        const player = window.gameState?.player;
        if (!player || player.health <= 0) return;

        this.threshold = 0;

        // A weapon heard nearby wakes anything that is not lying in ambush; an
        // ambusher is woken by it only if it can also see the player, from any
        // angle.
        if (this.hearsNoise() && (!this.ambush || this.hasLineOfSight(player))) {
            this.acquireTarget(player, true);
            return;
        }

        if (this.lookForPlayer(player, false)) {
            this.acquireTarget(player, true);
        }
    }

    /**
     * @returns {boolean} True if a recent weapon noise reached this tile
     */
    hearsNoise() {
        const gs = window.gameState;
        if (!gs || !gs.noiseTiles || gs.frameCount - gs.noiseFrame > NOISE_MEMORY_FRAMES) return false;

        const tileX = Math.floor(this.x / TILE_SIZE);
        const tileY = Math.floor(this.y / TILE_SIZE);
        return gs.noiseTiles.has(tileY * MAP_COLS + tileX);
    }

    /**
     * P_LookForPlayers. Unless `allAround`, only the half-circle the monster is
     * facing counts -- except at melee range, where it notices you anyway.
     *
     * @param {Object} player - The player
     * @param {boolean} allAround - Ignore facing
     * @returns {boolean} True if the player is in view
     */
    lookForPlayer(player, allAround) {
        const dx = player.x - this.x;
        const dy = player.y - this.y;
        const dist = Math.hypot(dx, dy);
        if (dist > SIGHT_RANGE) return false;

        if (!allAround) {
            const relative = angleDifference(this.angle, Math.atan2(dy, dx));
            if (Math.abs(relative) > Math.PI / 2 && dist > unitsToPx(64)) return false;
        }

        return this.hasLineOfSight(player);
    }

    /**
     * Takes a target and starts chasing it.
     *
     * @param {Object} target - The player or another monster
     * @param {boolean} announce - Play the sight sound
     */
    acquireTarget(target, announce) {
        this.target = target;
        this.state = 'chase';
        this.movedir = DIR.NONE;
        this.movecount = 0;
        this.chaseClock = 0;
        if (announce) playEnemySightSound(this.def.sounds, this);
    }

    // =========================================================================
    // A_Chase: HUNTING
    // =========================================================================

    /**
     * The chase state. Decisions happen at the monster's own step rate;
     * movement happens every frame so it is smooth at 60Hz.
     */
    chase() {
        if (!this.targetAlive()) {
            // A_Chase with no target: look all round for the player, and stand
            // down if there is nothing to see.
            this.target = null;
            const player = window.gameState?.player;
            if (player && player.health > 0 && this.lookForPlayer(player, true)) {
                this.acquireTarget(player, false);
            } else {
                this.state = 'idle';
                this.isMoving = false;
                this.movedir = DIR.NONE;
                return;
            }
        }

        this.state = 'chase';
        this.steppedThisFrame = false;
        this.chaseClock += 1;
        while (this.chaseClock >= this.chaseFrames) {
            this.chaseClock -= this.chaseFrames;
            if (this.chaseStep()) return;
        }

        this.walk();
    }

    /**
     * One A_Chase call.
     *
     * @returns {boolean} True if an attack began and movement should stop
     */
    chaseStep() {
        const def = this.def;

        if (this.reactionTime > 0) this.reactionTime--;

        if (this.threshold > 0) {
            this.threshold = this.targetAlive() ? this.threshold - 1 : 0;
        }

        // The Arch-vile checks for a corpse to raise before anything else.
        if (def.resurrects && this.tryResurrect()) return true;

        // Do not attack twice in a row: move first.
        if (this.justAttacked) {
            this.justAttacked = false;
            this.newChaseDir();
            return false;
        }

        if (def.melee && this.inMeleeRange(this.target)) {
            this.startAttack('melee');
            return true;
        }

        // A missile attack is only considered at the end of a run.
        if (def.missile && this.movecount <= 0 && this.checkMissileRange(this.target)) {
            this.startAttack('missile');
            return true;
        }

        if (--this.movecount < 0) this.newChaseDir();

        if (def.sounds && Math.random() < 3 / 256) {
            playEnemyActiveSound(def.sounds, this);
        }

        return false;
    }

    /**
     * Advances along the current direction, or picks a new one if blocked.
     */
    walk() {
        if (this.movedir === DIR.NONE) {
            this.isMoving = false;
            return;
        }

        // P_TryWalk is a real step: if choosing a direction already moved the
        // monster this frame, that was its step.
        if (!this.steppedThisFrame && !this.tryStep(this.movedir)) this.newChaseDir();
        this.isMoving = this.movedir !== DIR.NONE;
    }

    /**
     * P_Move: one step in a direction, all or nothing.
     *
     * @param {number} dir - A DIR value
     * @returns {boolean} True if the step was taken
     */
    tryStep(dir) {
        const [vx, vy] = DIR_VECTORS[dir];
        const nx = this.x + vx * this.speed;
        const ny = this.y + vy * this.speed;

        if (!this.canStandAt(nx, ny)) return false;

        this.x = nx;
        this.y = ny;
        this.steppedThisFrame = true;
        this.face(DIR_ANGLES[dir]);

        // A_Hoof / A_Metal: the heavy monsters are heard coming. Cheap for the
        // rest, which return from this at once.
        this.stepFrames = (this.stepFrames || 0) + 1;
        playEnemyStepSound(this.def.sounds, this, this.stepFrames);
        return true;
    }

    /**
     * P_CheckPosition: walls, doors and other solid things.
     *
     * Living monsters and the player are solid to each other, which is what
     * makes a crowd queue in a doorway instead of merging into one blob. A
     * monster already overlapping something (it spawned close, or the player
     * walked into it) is allowed any step that takes it further away, so two
     * bodies never lock together.
     *
     * @param {number} nx - Candidate X
     * @param {number} ny - Candidate Y
     * @returns {boolean} True if the monster may stand there
     */
    canStandAt(nx, ny) {
        const gs = window.gameState;
        if (checkWallCollision(nx, ny, this.radius, gs?.gameMap)) return false;

        const blockedBy = (thing) => {
            if (!thing || thing === this || thing.health <= 0 || thing.isDead || thing.dormant) return false;
            const reach = this.radius + thing.radius;
            const dxN = thing.x - nx;
            const dyN = thing.y - ny;
            const afterSq = dxN * dxN + dyN * dyN;
            if (afterSq >= reach * reach) return false;

            const dx0 = thing.x - this.x;
            const dy0 = thing.y - this.y;
            return afterSq < dx0 * dx0 + dy0 * dy0;
        };

        if (blockedBy(gs?.player)) return false;
        if (blockedBy(gs?.currentBoss)) return false;
        const barrels = gs?.barrels;
        if (barrels) {
            for (let i = 0; i < barrels.length; i++) {
                if (blockedBy(barrels[i])) return false;
            }
        }
        const enemies = gs?.enemies;
        if (enemies) {
            for (let i = 0; i < enemies.length; i++) {
                if (blockedBy(enemies[i])) return false;
            }
        }
        return true;
    }

    /**
     * P_NewChaseDir, with P_TryWalk supplied as the step attempt.
     */
    newChaseDir() {
        if (!this.targetAlive()) {
            this.movedir = DIR.NONE;
            return;
        }

        this.movedir = newChaseDir({
            dx: this.target.x - this.x,
            dy: this.target.y - this.y,
            oldDir: this.movedir,
            tryWalk: (dir) => {
                if (!this.tryStep(dir)) return false;
                this.movecount = Math.floor(Math.random() * 16);
                return true;
            },
        });
    }

    /**
     * P_CheckMeleeRange.
     *
     * @param {Object} target - The thing to hit
     * @returns {boolean} True if a melee blow can land
     */
    inMeleeRange(target) {
        if (!target) return false;
        const reach = unitsToPx(MELEE_REACH_UNITS) + target.radius;
        if (this.distanceSquaredTo(target) >= reach * reach) return false;
        return this.hasLineOfSight(target);
    }

    /**
     * P_CheckMissileRange, with the line-of-sight and MF_JUSTHIT parts that
     * precede the distance roll.
     *
     * @param {Object} target - The thing to shoot
     * @returns {boolean} True to fire now
     */
    checkMissileRange(target) {
        if (!this.hasLineOfSight(target)) return false;

        if (this.justHit) {
            // The target just hurt this monster: fight back.
            this.justHit = false;
            return true;
        }

        return checkMissileRange(this.def, pxToUnits(this.distanceTo(target)), {
            reactionTime: this.reactionTime,
            chanceScale: this.attackChanceScale,
        });
    }

    // =========================================================================
    // ATTACKS
    // =========================================================================

    /**
     * Begins an attack. The monster stops, faces its target and plays out the
     * timing of its attack states.
     *
     * @param {'melee'|'missile'} kind - Which attack
     */
    startAttack(kind) {
        const spec = kind === 'melee' ? this.def.melee : this.def.missile;
        if (!spec) return;

        this.attack = { kind, spec, timer: 0, fired: new Set(), phase: 'windup', cycleStart: 0, hit: false, effect: null };
        this.state = 'attack';
        this.isMoving = false;
        this.faceTarget();
        this.playAnimation(ENEMY_ANIM.ATTACK, true);
        if (kind === 'missile') playEnemyWindupSound(this.def.sounds, this);

        if (spec.kind === 'flame' && this.targetAlive()) {
            // A_VileTarget: the fire appears at the target's feet and follows it
            // for the length of the wind-up. That is the player's warning.
            this.attack.effect = pushEffect({
                type: 'vile_fire', follow: this.target, life: ticsToFrames(spec.at),
                radius: unitsToPx(24),
            });
        }
    }

    /**
     * Ends the attack and marks MF_JUSTATTACKED, so the next chase step moves
     * rather than firing again.
     */
    endAttack() {
        this.cancelAttackEffect();
        this.attack = null;
        this.justAttacked = true;
        this.state = 'chase';
    }

    /** Removes any effect the attack was showing, e.g. when pain cancels it. */
    cancelAttackEffect() {
        if (this.attack?.effect) this.attack.effect.life = 0;
    }

    /**
     * Advances the attack in progress by one frame.
     */
    updateAttack() {
        const a = this.attack;
        const spec = a.spec;
        a.timer++;

        if (a.kind === 'heal') {
            this.face(Math.atan2(a.corpse.y - this.y, a.corpse.x - this.x));
            if (a.timer >= ticsToFrames(spec.duration)) {
                if (a.corpse.isDead) a.corpse.revive(this);
                this.attack = null;
                this.state = 'chase';
            }
            return;
        }

        this.faceTarget();

        if (a.kind === 'melee') {
            if (!a.hit && a.timer >= ticsToFrames(spec.hitAt)) {
                a.hit = true;
                playEnemyMeleeSound(this.def.sounds, this);
                if (this.targetAlive() && this.inMeleeRange(this.target)) {
                    this.dealDamage(this.target, rollDamage(spec.damage));
                }
            }
            if (a.timer >= ticsToFrames(spec.duration)) this.endAttack();
            return;
        }

        switch (spec.kind) {
            case 'hitscan':
            case 'projectile':
                spec.shots.forEach((shot, index) => {
                    if (a.fired.has(index) || a.timer < ticsToFrames(shot.at)) return;
                    a.fired.add(index);
                    this.fireShot(spec, shot);
                });
                if (a.timer >= ticsToFrames(spec.duration)) this.endAttack();
                break;

            case 'burst':
                this.updateBurst(a, spec);
                break;

            case 'charge':
                if (a.timer >= ticsToFrames(spec.at)) this.beginCharge(spec);
                break;

            case 'spawn':
                if (!a.hit && a.timer >= ticsToFrames(spec.at)) {
                    a.hit = true;
                    if (this.targetAlive()) {
                        this.spawnLostSoul(Math.atan2(this.target.y - this.y, this.target.x - this.x));
                    }
                }
                if (a.timer >= ticsToFrames(spec.duration)) this.endAttack();
                break;

            case 'flame':
                if (!a.hit && a.timer >= ticsToFrames(spec.at)) {
                    a.hit = true;
                    this.fireFlame(spec);
                }
                if (a.timer >= ticsToFrames(spec.duration)) this.endAttack();
                break;

            default:
                this.endAttack();
        }
    }

    /**
     * One scheduled shot of a hitscan or projectile attack.
     *
     * @param {Object} spec - The missile spec
     * @param {Object} shot - One entry of spec.shots
     */
    fireShot(spec, shot) {
        if (spec.kind === 'hitscan') {
            playEnemyGunSound(spec.gun, this);
            for (let i = 0; i < (shot.count || 1); i++) this.fireHitscan(spec.damage);
            return;
        }

        playEnemyShootSound(this.def.sounds, this);
        for (const degrees of (shot.angles || [0])) {
            this.fireProjectile(spec.projectile, degrees);
        }
    }

    /**
     * The chaingun-style attack: after a wind-up, fire on a fixed cycle, and
     * at the end of each cycle roll to keep going (A_CPosRefire / A_SpidRefire).
     * Losing sight of the target also stops it.
     *
     * @param {Object} a - The attack in progress
     * @param {Object} spec - The burst spec
     */
    updateBurst(a, spec) {
        if (a.timer < ticsToFrames(spec.windup)) return;

        if (a.phase === 'windup') {
            a.phase = 'firing';
            a.cycleStart = a.timer;
            a.fired = new Set();
        }

        const inCycle = a.timer - a.cycleStart;
        spec.shotTics.forEach((tic, index) => {
            if (a.fired.has(index) || inCycle < ticsToFrames(tic)) return;
            a.fired.add(index);
            this.fireBurstShot(spec);
        });

        if (inCycle >= ticsToFrames(spec.cycle)) {
            if (Math.random() < spec.stopChance || !this.targetAlive() || !this.hasLineOfSight(this.target)) {
                this.endAttack();
                return;
            }
            a.cycleStart = a.timer;
            a.fired = new Set();
        }
    }

    /**
     * @param {Object} spec - The burst spec
     */
    fireBurstShot(spec) {
        this.playAnimation(ENEMY_ANIM.ATTACK, true);
        if (spec.shot === 'hitscan') {
            playEnemyGunSound(spec.gun, this);
            for (let i = 0; i < (spec.count || 1); i++) this.fireHitscan(spec.damage);
        } else {
            playEnemyShootSound(this.def.sounds, this);
            this.fireProjectile(spec.projectile, 0);
        }
    }

    /**
     * Applies one of this monster's hits, scaled for difficulty.
     *
     * @param {Object} thing - The player or another monster
     * @param {number} raw - Damage as rolled from the Doom dice
     */
    dealDamage(thing, raw, point = null) {
        const amount = raw * this.damageScale;

        if (thing.bloodColor !== null) {
            const at = point || thing;
            spawnBlood(at.x, at.y, Math.atan2(thing.y - this.y, thing.x - this.x),
                       { color: thing.bloodColor, amount: 6 });
        }

        if (thing === window.gameState?.player) {
            thing.takeDamage(amount);
        } else {
            thing.takeDamage(amount, this);
        }
    }

    // ------------------------------------------------------------- hitscan

    /**
     * One bullet: instant, with Doom's spread, hitting the first solid thing
     * along the ray or the wall behind.
     *
     * @param {[number, number]} dice - Damage dice
     */
    fireHitscan(dice) {
        if (!this.targetAlive()) return;

        const angle = Math.atan2(this.target.y - this.y, this.target.x - this.x) + hitscanSpread();
        const hit = this.traceHitscan(angle);

        if (hit.thing) this.dealDamage(hit.thing, rollDamage(dice), hit);

        pushEffect({
            type: 'tracer', startX: this.x, startY: this.y, endX: hit.x, endY: hit.y,
            life: TRACER_LIFE, color: '#ffe9a0',
        });
    }

    /**
     * P_LineAttack for a monster: walks the ray to the first wall, then finds
     * the nearest shootable thing in front of it.
     *
     * @param {number} angle - Ray direction in radians
     * @returns {{thing: Object|null, x: number, y: number}} What was hit and where
     */
    traceHitscan(angle) {
        return traceShot(this.x, this.y, angle, this, unitsToPx(MISSILE_RANGE_UNITS));
    }

    // ---------------------------------------------------------- projectile

    /**
     * P_SpawnMissile: a fireball aimed at the target.
     *
     * @param {Object} proj - The projectile spec
     * @param {number} offsetDegrees - Fan angle, for the Mancubus
     */
    fireProjectile(proj, offsetDegrees = 0) {
        if (!this.targetAlive()) return;
        const gs = window.gameState;

        const angle = Math.atan2(this.target.y - this.y, this.target.x - this.x) +
                      offsetDegrees * Math.PI / 180;
        // Doom quotes a projectile's radius in map units, like everything else
        // in the bestiary; it is the ball's collision radius and the size it is
        // drawn. Converting it here was missing, so every fireball was 1.6x
        // too big and hit from further away than it looked.
        const projRadius = unitsToPx(proj.radius);
        const launch = this.radius + projRadius + 2;

        const bullet = createBullet({
            x: this.x + Math.cos(angle) * launch,
            y: this.y + Math.sin(angle) * launch,
            angle,
            speed: projectileSpeedPx(proj.speed),
            owner: 'enemy',
            damage: rollDamage(proj.damage) * this.damageScale,
            color: proj.color,
            radius: projRadius,
            isRocket: !!proj.rocket,
            aoeRadius: proj.rocket ? unitsToPx(proj.rocket.radius) : 0,
            splash: proj.rocket ? (proj.rocket.damage || 128) * this.damageScale : null,
            explosionDuration: proj.rocket ? 30 : 0,
            isSeeking: !!(proj.homingChance && Math.random() < proj.homingChance),
        });

        // Who fired it decides whom it can hurt, and whom it fizzles on.
        bullet.shooter = this;
        bullet.species = this.species;
        if (bullet.isSeeking) bullet.seekTarget = this.target;

        gs?.bullets?.push(bullet);
    }

    // -------------------------------------------------------------- charge

    /**
     * A_SkullAttack: the Lost Soul launches itself at its target.
     *
     * @param {Object} spec - The charge spec
     */
    beginCharge(spec) {
        if (!this.targetAlive()) {
            this.endAttack();
            return;
        }

        const angle = Math.atan2(this.target.y - this.y, this.target.x - this.x);
        const speed = projectileSpeedPx(spec.chargeSpeed);
        this.charge = {
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            damage: spec.damage,
            timer: 0,
            maxFrames: ticsToFrames(spec.maxTics),
        };
        this.attack = null;
        this.state = 'charge';
        this.face(angle);
        // A_SkullAttack: the charge starts with the attack sound, not the sight cry.
        playEnemyShootSound(this.def.sounds, this);
    }

    /**
     * MF_SKULLFLY: flies in a straight line until it hits something. The first
     * thing it touches takes the bite; a wall just stops it.
     */
    updateCharge() {
        const c = this.charge;
        const gs = window.gameState;
        c.timer++;

        const nx = this.x + c.vx;
        const ny = this.y + c.vy;

        const victims = [gs?.player, gs?.currentBoss];
        if (gs?.enemies) victims.push(...gs.enemies);
        if (gs?.barrels) victims.push(...gs.barrels);
        for (const thing of victims) {
            if (!thing || thing === this || thing.health <= 0 || thing.isDead || thing.dormant) continue;
            const reach = this.radius + thing.radius;
            const dx = thing.x - nx;
            const dy = thing.y - ny;
            if (dx * dx + dy * dy < reach * reach) {
                this.dealDamage(thing, rollDamage(c.damage));
                this.stopCharge();
                return;
            }
        }

        if (c.timer > c.maxFrames || checkWallCollision(nx, ny, this.radius, gs?.gameMap)) {
            this.stopCharge();
            return;
        }

        this.x = nx;
        this.y = ny;
        this.isMoving = true;
    }

    /** The flight is over; back to hunting. */
    stopCharge() {
        this.charge = null;
        this.state = this.target ? 'chase' : 'idle';
        this.movedir = DIR.NONE;
        this.movecount = 0;
        this.justAttacked = true;
    }

    // --------------------------------------------------------------- spawn

    /**
     * A_PainShootSkull: releases a Lost Soul just outside this monster's body,
     * already flying at the target. Refused when the level is full of them or
     * the spot is inside a wall.
     *
     * @param {number} angle - Direction to release it, in radians
     */
    spawnLostSoul(angle) {
        const gs = window.gameState;
        if (!gs?.enemies) return;

        let alive = 0;
        for (const enemy of gs.enemies) {
            if (enemy.enemyType === 'lost_soul' && !enemy.isDead) alive++;
        }
        if (alive >= LOST_SOUL_LIMIT) return;

        const soulRadius = unitsToPx(MONSTERS.lost_soul.radius);
        const prestep = this.radius + soulRadius + unitsToPx(4);
        const sx = this.x + Math.cos(angle) * prestep;
        const sy = this.y + Math.sin(angle) * prestep;
        if (checkWallCollision(sx, sy, soulRadius, gs.gameMap)) return;

        const soul = new Enemy(sx, sy, 'lost_soul');
        soul.ambush = false;
        soul.face(angle);
        if (this.targetAlive()) {
            soul.acquireTarget(this.target, false);
            soul.beginCharge(soul.def.missile);
        }
        gs.enemies.push(soul);
    }

    // --------------------------------------------------------------- flame

    /**
     * A_VileAttack: if the target is still in view when the fire goes off, it
     * takes the direct hit and stands in the centre of the blast.
     *
     * @param {Object} spec - The flame spec
     */
    fireFlame(spec) {
        if (!this.targetAlive() || !this.hasLineOfSight(this.target)) return;
        const gs = window.gameState;

        playEnemyShootSound(this.def.sounds, this);
        this.dealDamage(this.target, spec.damage);

        const blast = new Explosion(
            this.target.x, this.target.y, unitsToPx(70), 20, 'orange',
            spec.splash * this.damageScale, false
        );
        blast.source = this;
        gs?.explosions?.push(blast);
    }

    // ----------------------------------------------------------- resurrect

    /**
     * A_VileChase: a corpse within the next step is raised instead of walked
     * past. The monster stops for the length of the healing animation.
     *
     * @returns {boolean} True if a resurrection began
     */
    tryResurrect() {
        if (this.movedir === DIR.NONE) return false;
        const enemies = window.gameState?.enemies;
        if (!enemies) return false;

        const [vx, vy] = DIR_VECTORS[this.movedir];
        const px = this.x + vx * this.speed;
        const py = this.y + vy * this.speed;

        for (const corpse of enemies) {
            if (!corpse.isDead || corpse === this || corpse.def?.raisable === false) continue;
            if (!corpse.isDeathAnimationFinished()) continue;

            const reach = corpse.radius + this.radius;
            if (Math.abs(corpse.x - px) > reach || Math.abs(corpse.y - py) > reach) continue;

            this.attack = { kind: 'heal', spec: { duration: 30 }, timer: 0, corpse, effect: null };
            this.state = 'attack';
            this.isMoving = false;
            this.face(Math.atan2(corpse.y - this.y, corpse.x - this.x));
            this.playAnimation(ENEMY_ANIM.ATTACK, true);
            playResurrectSound(corpse);
            return true;
        }

        return false;
    }

    /**
     * Gets back up, at full health, with everything it was doing forgotten.
     *
     * @param {Enemy} raiser - The Arch-vile responsible
     */
    revive(raiser) {
        this.health = this.maxHealth;
        this.isDead = false;
        this.corpseTimer = 0;
        this.hitTimer = 0;
        this.painTimer = 0;
        this.attack = null;
        this.charge = null;
        this.justHit = false;
        this.justAttacked = false;
        this.threshold = 0;
        this.movedir = DIR.NONE;
        this.movecount = 0;
        this.reactionTime = this.def.reactionTics;
        this.animLocked = false;
        this.playAnimation(ENEMY_ANIM.IDLE, true);

        // Doom clears the raised monster's target and lets A_Chase look again.
        this.target = null;
        this.state = 'idle';
        const player = window.gameState?.player;
        if (player && player.health > 0 && this.lookForPlayer(player, true)) {
            this.acquireTarget(player, false);
        } else if (raiser?.targetAlive()) {
            this.acquireTarget(raiser.target, false);
        }
    }

    // =========================================================================
    // DAMAGE AND DEATH
    // =========================================================================

    /**
     * P_DamageMobj for a monster.
     *
     * Three things happen besides losing health. The monster may flinch: a
     * roll against its pain chance, and a success cancels whatever it was
     * doing for the length of its pain state. It may turn on whoever hurt it:
     * always if it is not yet committed to a target, never if it is (that is
     * `threshold`), and always for the Arch-vile -- who nobody ever turns on.
     * And if it was standing, it wakes.
     *
     * @param {number} amount - Damage amount
     * @param {Object|null} [source] - Who dealt it, if anyone
     * @returns {boolean} True if enemy was killed
     */
    takeDamage(amount, source = null) {
        // Several projectiles can land on the same enemy within a single frame,
        // and the enemy is only spliced out of the array on the next update.
        // Without this guard onDeath() runs once per pellet.
        if (this.isDead || this.dormant) return false;

        this.health -= amount;
        this.hitTimer = 10; // Visual hit feedback

        if (this.health <= 0) {
            this.health = 0;
            this.isDead = true;
            this.cancelAttackEffect();
            this.attack = null;
            this.charge = null;
            this.painTimer = 0;
            this.isMoving = false;
            // Death takes over the enemy's appearance outright: force it past any
            // swing or flinch still playing.
            this.playAnimation(ENEMY_ANIM.DYING, true);
            this.corpseTimer = ENEMY_CORPSE_LINGER;
            this.onDeath();
            return true;
        }

        const def = this.def;

        // Turn on the attacker.
        if (source && source !== this && !source.def?.untargetable &&
            (this.threshold <= 0 || def.alwaysRetargets)) {
            const wasStanding = !this.target;
            this.target = source;
            this.threshold = ticsToFrames(BASE_THRESHOLD_TICS);
            if (wasStanding) this.acquireTarget(source, true);
        }

        // The pain roll. A flying skull is never knocked out of its charge.
        if (!this.charge && Math.random() * 256 < def.painChance) {
            this.justHit = true;
            this.painTimer = this.painFrames;
            this.cancelAttackEffect();
            this.attack = null;
            this.state = 'pain';
            this.isMoving = false;
            // Deliberately not forced: a flinch already playing is left to
            // finish. Restarting it on every hit pinned enemies on frame 0
            // under automatic fire, so they read as frozen.
            this.playAnimation(ENEMY_ANIM.HURT);
            playEnemyPainSound(def.sounds, this);
        }

        return false;
    }

    /**
     * Whether the body has finished dying and can be removed from the level.
     *
     * A killed enemy stays in the world long enough to play its death animation
     * and hold the final pose. It is inert throughout: takeDamage() rejects
     * further hits, and update() skips AI, movement and attacks. While an
     * Arch-vile lives, corpses it could raise are never cleared at all.
     *
     * @returns {boolean} True once the corpse should be removed
     */
    isReadyToRemove() {
        if (!this.isDead) return false;

        // With no artwork there is nothing to watch for, so the body goes at
        // once -- exactly as it did before sprites existed.
        if (!this.getDeathAnimation()) return true;

        if (window.gameState?.corpsesPersist && this.def.raisable !== false) return false;

        return this.isDeathAnimationFinished() && this.corpseTimer <= 0;
    }

    /**
     * @returns {{start: number, count: number}|null} This enemy's death animation,
     *          or null if it has no artwork
     */
    getDeathAnimation() {
        const meta = this.getSpriteMeta();
        return meta
            ? resolveEnemyAnimation(meta, ENEMY_ANIM.DYING, this.facingDirection)
            : null;
    }

    /**
     * @returns {boolean} True once the body has reached its final pose, or has
     *          no animation to play
     */
    isDeathAnimationFinished() {
        const range = this.getDeathAnimation();
        return !range || this.animFrame >= range.count - 1;
    }

    /**
     * Handles enemy death effects and scoring.
     */
    onDeath() {
        playEnemyDestroySound(this.def.sounds, this);

        if (this.bloodColor !== null) {
            spawnGore(this.x, this.y - this.radius * 0.5, this.bloodColor,
                      (this.radius * this.spriteScale) / 12.5);
        }

        if (window.gameState) {
            window.gameState.score += this.scoreValue;
            window.gameState.player?.updateScoreDisplay();
            window.gameState.recordKill?.(this);
        }

        // A_PainDie: the Pain Elemental bursts into Lost Souls.
        if (this.def.deathSpawn) {
            for (let i = 1; i <= this.def.deathSpawn; i++) {
                this.spawnLostSoul(this.angle + i * Math.PI / 2);
            }
        }
    }

    // =========================================================================
    // RENDERING
    // =========================================================================

    /**
     * Draws the enemy from its character atlas.
     *
     * Sizing comes from the enemy's own collision radius rather than the
     * artwork: the atlases are all baked at one body height, so scaling by
     * radius makes a Cyberdemon tower over an Imp using identically sized
     * source frames. `spriteScale` adjusts that for monsters whose Doom sprite
     * was much taller than its footprint. The manifest's anchor -- the
     * character's feet within a frame -- is planted just below the enemy's
     * centre, which keeps the sprite still even when an animation's silhouette
     * is much wider than the idle pose.
     *
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     * @returns {boolean} True if the sprite was drawn; false to fall back to shapes
     */
    drawSprite(ctx) {
        const meta = this.getSpriteMeta();
        if (!meta) return false;

        const atlas = getEnemyAtlas(this.spriteSlug);
        // Still in flight, or failed to load: shape rendering covers the gap.
        if (!atlas || !atlas.complete || atlas.naturalHeight === 0) return false;

        const range = resolveEnemyAnimation(meta, this.animation, this.facingDirection);
        if (!range) return false;

        const frame = getEnemyFrameRect(meta, range, Math.floor(this.animFrame));

        const scale = (this.radius * this.spriteScale * ENEMY_SPRITE_BODY_PER_RADIUS) / meta.bodyHeight;
        const width = meta.frameWidth * scale;
        const height = meta.frameHeight * scale;
        const left = this.x - meta.anchorX * scale;
        const top = this.y + this.radius * ENEMY_SPRITE_FOOT_OFFSET - meta.anchorY * scale;

        ctx.save();

        // The Spectre: Doom drew it with a fuzz effect; a ghost of its sprite
        // is the same idea.
        if (this.alpha < 1) ctx.globalAlpha = this.alpha;

        // Flash on damage. The hurt animation carries most of the feedback; this
        // just makes the frame of impact unmistakable. Guarded because a canvas
        // without filter support would otherwise silently drop the sprite.
        if (this.hitTimer > 0 && typeof ctx.filter === 'string') {
            ctx.filter = 'brightness(2.2) saturate(0.5)';
        }

        ctx.drawImage(
            atlas,
            frame.x, frame.y, frame.width, frame.height,
            left, top, width, height
        );

        ctx.restore();

        // A corpse doesn't need a health bar over it.
        if (!this.isDead && this.health < this.maxHealth) {
            this.drawHealthBar(ctx, top);
        }

        return true;
    }

    /**
     * Draws the damage bar above a sprite.
     *
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     * @param {number} spriteTop - World Y of the sprite's top edge
     */
    drawHealthBar(ctx, spriteTop) {
        const width = this.radius * 2;
        const left = this.x - this.radius;
        // Sit the bar just clear of the artwork rather than a fixed distance
        // above the enemy, so it clears tall characters too.
        const top = spriteTop - 8;

        ctx.fillStyle = 'red';
        ctx.fillRect(left, top, width, 5);
        ctx.fillStyle = 'green';
        ctx.fillRect(left, top, width * (this.health / this.maxHealth), 5);
    }

    /**
     * Renders the enemy on the canvas.
     *
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     */
    draw(ctx) {
        // Behind a wall that has not opened yet: there is nothing to see.
        if (this.dormant) return;

        if (this.drawSprite(ctx)) return;

        // Fallback circle rendering when sprites are not loaded
        ctx.save();
        ctx.translate(this.x, this.y);
        if (this.alpha < 1) ctx.globalAlpha = this.alpha;

        ctx.fillStyle = this.hitTimer > 0 ? 'white' : this.color;
        ctx.beginPath();
        ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
        ctx.fill();

        // An eye, so the facing is readable
        ctx.fillStyle = 'black';
        ctx.beginPath();
        ctx.arc(
            Math.cos(this.angle) * this.radius * 0.5,
            Math.sin(this.angle) * this.radius * 0.5,
            this.radius * 0.2, 0, Math.PI * 2
        );
        ctx.fill();

        ctx.restore();

        if (!this.isDead && this.health < this.maxHealth) {
            this.drawHealthBar(ctx, this.y - this.radius - 2);
        }
    }
}

// =============================================================================
// BOSS CLASSES
// =============================================================================

/**
 * MiniBoss -- a Baron of Hell guarding the exit.
 *
 * Doom's first episode ends on a pair of Barons, and that is the job this one
 * does: it is a Baron with the boss difficulty multipliers, it seals the exit
 * until it dies, and it drops the rocket launcher when it does.
 */
export class MiniBoss extends Enemy {
    /**
     * @param {number} x - Starting X world coordinate
     * @param {number} y - Starting Y world coordinate
     */
    constructor(x, y) {
        super(x, y, 'baron');
        this.isMiniBoss = true;
        this.ambush = false;

        // A Baron of Hell, at the Baron's numbers
        this.scoreValue = 1000;

        this.droppedWeapon = false;             // Prevents duplicate weapon drops
    }

    /**
     * Handles mini-boss death and weapon dropping.
     *
     * @param {number} amount - Damage amount
     * @param {Object|null} [source] - Who dealt it
     * @returns {boolean} True if mini-boss was killed
     */
    takeDamage(amount, source = null) {
        const killed = super.takeDamage(amount, source);

        if (killed && !this.droppedWeapon && window.gameState?.weaponPacks) {
            // The launcher lands where the body fell, as a pickup, rather than
            // appearing in the player's hands from across the room.
            const rlStats = WEAPON_STATS["Rocket Launcher"];
            window.gameState.weaponPacks.push(new WeaponPack(this.x, this.y, "Rocket Launcher", rlStats.pickupAmmo));
            this.droppedWeapon = true;
        }

        return killed;
    }
}

/**
 * Boss -- the Cyberdemon or the Spider Mastermind, for every fifth level.
 *
 * Doom's two episode-ending bosses alternate: the Cyberdemon on level 5, the
 * Spider on 10, and so on. Each is a monster from the roster with the boss
 * multipliers, a modest tier scaling so a third Cyberdemon is a bigger fight
 * than the first, and the full-width health bar. Killing it completes the
 * level (see GameState.updateBoss), and the exit is sealed while it lives.
 */
export class Boss extends Enemy {
    /**
     * @param {number} x - Starting X world coordinate
     * @param {number} y - Starting Y world coordinate
     * @param {number} level - Current level for tier calculation
     */
    constructor(x, y, level) {
        const tier = Math.max(1, Math.floor(level / 5));
        super(x, y, bossTypeForTier(tier));

        this.bossTier = tier;
        this.isBoss = true;
        this.ambush = false;

        // The same boss each time it returns: Doom's Cyberdemon is 4000 hit
        // points wherever it stands. Only the score for it climbs.
        this.scoreValue = 500 * tier + this.def.score;
    }

    /**
     * @param {number} amount - Damage amount
     * @param {Object|null} [source] - Who dealt it
     * @returns {boolean} True if boss was killed
     */
    takeDamage(amount, source = null) {
        const killed = super.takeDamage(amount, source);
        if (!killed) {
            this.hitTimer = 15; // Longer hit feedback for bosses
        }
        return killed;
    }

    /**
     * Handles boss death effects.
     */
    onDeath() {
        playEnemyDestroySound(this.def.sounds, this);

        if (window.gameState) {
            window.gameState.score += this.scoreValue;
            window.gameState.player?.updateScoreDisplay();
            window.gameState.recordKill?.(this);
        }
    }

    /**
     * Renders the boss, and its health bar across the bottom of the screen.
     *
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     */
    draw(ctx) {
        super.draw(ctx);

        if (this.isDead || this.health >= this.maxHealth) return;

        // This is a HUD element, so it is drawn in screen space, pinned to the
        // canvas the renderer actually uses rather than a fixed 800x600.
        const canvas = window.gameController?.canvas;
        const screenWidth = canvas ? canvas.width : VIEWPORT_WIDTH;
        const screenHeight = canvas ? canvas.height : VIEWPORT_HEIGHT;

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        const barWidth = screenWidth * 0.6;
        const barHeight = 20;
        const barX = (screenWidth - barWidth) / 2;
        const barY = screenHeight - barHeight - 20;

        ctx.fillStyle = 'darkred';
        ctx.fillRect(barX, barY, barWidth, barHeight);
        ctx.fillStyle = 'red';
        ctx.fillRect(barX, barY, barWidth * (this.health / this.maxHealth), barHeight);
        ctx.strokeStyle = 'white';
        ctx.strokeRect(barX, barY, barWidth, barHeight);

        ctx.fillStyle = 'white';
        ctx.font = '12px "Press Start 2P"';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
            `${this.def.name.toUpperCase()}: ${Math.ceil(this.health)} / ${Math.ceil(this.maxHealth)}`,
            screenWidth / 2,
            barY + barHeight / 2
        );

        ctx.restore();
    }
}
