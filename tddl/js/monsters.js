/**
 * =============================================================================
 * MONSTER ROSTER AND DOOM AI FORMULAS
 * =============================================================================
 *
 * The bestiary of the original Doom (1993) and Doom II (1994), with the numbers
 * the id Software engine used for each of them, and the handful of formulas from
 * `p_enemy.c` that give the monsters their behaviour. Nothing here touches the
 * world: this is a leaf module of tables and pure functions, and the AI that
 * drives an enemy through them lives on the Enemy class in js/entities.js.
 *
 * Units
 * -----
 * Doom measures the world in map units (a 64-unit tile) and time in tics
 * (35 per second). Every number in MONSTERS is quoted in those units so it can
 * be checked against the source, and the converters at the top of the file turn
 * them into this game's pixels and 60Hz frames. A Doom tile is our 40px tile,
 * so the ratios between monsters -- who outruns whom, who out-ranges whom, how
 * big a Cyberdemon is next to an Imp -- come out exactly as they were.
 *
 * What is authentic
 * -----------------
 * Hit points, speeds, sizes, pain chances, reaction times, attack timings and
 * damage dice are Doom's, unscaled: a monster has the same hit points on
 * level twelve as on level one, on Hard as on Easy, because Doom's did. So
 * are the three formulas that matter most: P_CheckMissileRange (when a
 * monster decides to fire), P_NewChaseDir (how it walks, in eight directions
 * with the famous zig-zag) and the target/threshold rules that produce
 * monster infighting.
 *
 * Difficulty follows Doom's skill levels rather than scaling the monsters
 * (see getDifficultyMultipliers in js/constants.js): an easier skill halves
 * the damage the player takes and places fewer monsters, a harder one places
 * more. The monsters themselves never change.
 *
 * MONSTER_DAMAGE_SCALE below is the one knob left on the monsters' damage,
 * and it is 1.
 */

import { TILE_SIZE } from './constants.js';

// =============================================================================
// UNIT CONVERSION
// =============================================================================

/** Pixels per Doom map unit. Doom's 64-unit tile is this game's 40px tile. */
export const DOOM_UNIT = TILE_SIZE / 64;

/** Game updates per Doom tic. Doom runs at 35Hz; the game updates at 60Hz. */
export const FRAMES_PER_TIC = 60 / 35;

/** @param {number} tics @returns {number} Whole frames */
export function ticsToFrames(tics) {
    return Math.max(1, Math.round(tics * FRAMES_PER_TIC));
}

/** @param {number} units @returns {number} Pixels */
export function unitsToPx(units) {
    return units * DOOM_UNIT;
}

/** @param {number} px @returns {number} Map units */
export function pxToUnits(px) {
    return px / DOOM_UNIT;
}

/**
 * A monster's walking speed in pixels per frame.
 *
 * In Doom a monster steps `speed` units once per chase state, and each state
 * lasts `tics` tics. The Demon (10 units every 2 tics) is therefore two and a
 * half times as fast as the Zombieman (8 units every 4 tics), which is exactly
 * the difference you remember.
 *
 * @param {number} speedUnits - Units moved per chase step
 * @param {number} chaseTics - Tics per chase step
 * @returns {number} Pixels per frame
 */
export function chaseSpeedPx(speedUnits, chaseTics) {
    return (speedUnits / chaseTics) * DOOM_UNIT / FRAMES_PER_TIC;
}

/** Projectile speed: Doom quotes it per tic. @returns {number} Pixels per frame */
export function projectileSpeedPx(unitsPerTic) {
    return unitsPerTic * DOOM_UNIT / FRAMES_PER_TIC;
}

// =============================================================================
// GLOBAL TUNING
// =============================================================================

/**
 * Multiplier on every hit a monster lands. 1: Doom's dice, as rolled. The
 * game has no armour, so a Baron's 10-80 claw is felt in full; that is how
 * Doom's Baron felt to a marine with no armour, too.
 */
export const MONSTER_DAMAGE_SCALE = 1;

/**
 * How far a monster can see. Doom has no limit at all -- a monster with a line
 * of sight across the whole map will wake -- and neither has this: the map is
 * 64 by 48 tiles, so 80 tiles is past its far corner. Only line of sight and
 * the monster's facing decide it.
 */
export const SIGHT_RANGE = TILE_SIZE * 80;

/**
 * How far the noise of a weapon carries, measured in walkable tiles from the
 * player. Doom propagates sound through every connected sector without limit
 * and relies on the mapper's sound-blocking lines to contain it; a step limit
 * plays that role here, and closed doors block it just as they do in Doom.
 */
export const NOISE_RANGE_TILES = 40;

/** Frames a noise stays audible to monsters that look after it was made. */
export const NOISE_MEMORY_FRAMES = 120;

/**
 * Fraction of monsters spawned with Doom's "ambush" flag. A deaf monster
 * ignores noise and waits until it actually sees the player.
 */
export const AMBUSH_CHANCE = 0.25;

/** A_Look runs every 10 tics in the standing state of every monster. */
export const LOOK_INTERVAL_TICS = 10;

/**
 * P_CheckMeleeRange: MELEERANGE (64) minus 20, plus the target's radius. The
 * monster's own radius is not part of it.
 */
export const MELEE_REACH_UNITS = 44;

/** MISSILERANGE in p_local.h: how far a hitscan shot travels. */
export const MISSILE_RANGE_UNITS = 32 * 64;

/** BASETHRESHOLD: how many chase steps a monster stays locked on a new target. */
export const BASE_THRESHOLD_TICS = 100;

/** A_PainShootSkull refuses to spawn once this many Lost Souls are alive. */
export const LOST_SOUL_LIMIT = 20;

/**
 * Hitscan spread. Doom offsets each bullet by (P_Random() - P_Random()) << 20
 * in binary angle measure, a triangular distribution reaching about 22.5
 * degrees either side.
 */
export const HITSCAN_SPREAD_DEGREES = 22.5;

/** Mancubus fireball fan: FATSPREAD is ANG90 / 8. */
export const FATSPREAD_DEGREES = 11.25;

/**
 * Below this walking speed the walk animation is used instead of the run. The
 * atlases have both; a Zombieman at 0.73px a frame plodding along in the run
 * cycle looked like it was jogging on the spot.
 */
export const RUN_ANIMATION_SPEED = 1.2;

// =============================================================================
// THE BESTIARY
// =============================================================================

/**
 * Damage dice as Doom rolls them: `mult * ((P_Random() % sides) + 1)`.
 *
 * @param {[number, number]} dice - [multiplier, sides]
 * @param {() => number} [random] - Injectable RNG, for deterministic tests
 * @returns {number} Rolled damage
 */
export function rollDamage(dice, random = Math.random) {
    const [mult, sides] = dice;
    return mult * (1 + Math.floor(random() * sides));
}

/**
 * Every monster, keyed by the id the game uses for it.
 *
 * Fields
 * ------
 *   name          Display name
 *   doom          1 or 2: which game introduced it
 *   sprite        Character slug in sprites/enemies/manifest.json. Most are
 *                 Doom-coloured variants of a pack character, built by
 *                 tools/build_doom_monsters.py
 *   hp            Hit points (info.c spawnhealth); never scaled
 *   speed         Units per chase step
 *   chaseTics     Tics per chase step (the duration of the run frames)
 *   radius        Collision radius in units; capped for the two largest so
 *                 they fit a two-tile corridor
 *   painChance    Chance in 256 that a hit interrupts the monster
 *   painTics      How long the pain state lasts
 *   reactionTics  info.c's reactiontime: chase steps after waking before the
 *                 monster may fire (8 for every monster). Counted in steps,
 *                 as A_Chase counts it, so a fast monster's grace is shorter
 *   melee         Melee attack, if any: `hitAt`/`duration` in tics, `damage`
 *                 dice. The blow lands at hitAt if the target is still in reach.
 *   missile       Ranged attack, if any. A projectile's `radius` is its own
 *                 collision radius in map units (info.c: 6 for the Imp,
 *                 Cacodemon, Baron and Mancubus, 11 for a rocket and the
 *                 Revenant's tracer, 13 for Arachnotron plasma), converted to
 *                 pixels when it is fired. `kind` selects the behaviour:
 *                   hitscan     instant bullets; `shots` lists when they fire
 *                   projectile  fireballs; `shots` may fan them with `angles`
 *                   burst       fires repeatedly until a refire check fails
 *                   charge      the Lost Soul's headlong flight
 *                   spawn       the Pain Elemental's Lost Soul
 *                   flame       the Arch-vile's line-of-sight fire attack
 *   missileRange  P_CheckMissileRange special cases for this monster
 *   flies         Cosmetic: floats rather than walks
 *   alpha         Draw opacity (the Spectre)
 *   spriteScale   Draw-size multiplier on top of the radius, for monsters
 *                 whose Doom sprite is much taller than its footprint
 *   splashImmune  Takes no damage from explosions (P_RadiusAttack)
 *   resurrects    Raises corpses it walks over (the Arch-vile)
 *   untargetable  Other monsters never turn on it (the Arch-vile)
 *   alwaysRetargets Turns on whoever hurt it, threshold or not (the Arch-vile)
 *   raisable      False for monsters an Arch-vile cannot raise
 *   deathSpawn    Lost Souls released on death (the Pain Elemental)
 *   blood         Blood colour as an `r,g,b` triple. Doom bled red for
 *                 everything; the blue Cacodemon and green Baron are the
 *                 convention the source ports settled on, kept because they
 *                 read well
 *   boss          Spawned only by boss levels
 *   score         Points for a kill; not from Doom, which had no score
 *   drop          What the body leaves behind, as in Doom: a half clip from the
 *                 zombies, a shotgun from the Shotgun Guy, a chaingun from the
 *                 Chaingunner. Everything else drops nothing.
 *   sounds        Which voice the audio module gives it: a key of MONSTER_VOICES
 *                 in audio-system.js (the zombies share one, so do Demon and Spectre)
 */
export const MONSTERS = {
    // ------------------------------------------------------------ Doom (1993)
    zombieman: {
        name: 'Zombieman', doom: 1, sprite: 'zombieman',
        hp: 20, speed: 8, chaseTics: 4, radius: 20,
        painChance: 200, painTics: 6, reactionTics: 8,
        missile: { kind: 'hitscan', shots: [{ at: 10, count: 1 }], duration: 26,
                   damage: [3, 5], gun: 'rifle' },
        spriteScale: 1.01, score: 100, color: '#8a9a6a',
        sounds: 'zombie',
        drop: { ammo: 'bullets' },
    },
    shotgun_guy: {
        name: 'Shotgun Guy', doom: 1, sprite: 'shotgun-guy',
        hp: 30, speed: 8, chaseTics: 3, radius: 20,
        painChance: 170, painTics: 6, reactionTics: 8,
        missile: { kind: 'hitscan', shots: [{ at: 3, count: 3 }], duration: 17,
                   damage: [3, 5], gun: 'shotgun' },
        spriteScale: 1.22, score: 150, color: '#6a6a6a',
        sounds: 'zombie',
        drop: { weapon: 'Shotgun' },
    },
    imp: {
        name: 'Imp', doom: 1, sprite: 'imp',
        hp: 60, speed: 8, chaseTics: 3, radius: 20,
        painChance: 200, painTics: 4, reactionTics: 8,
        melee: { hitAt: 16, duration: 22, damage: [3, 8] },
        missile: { kind: 'projectile', shots: [{ at: 16 }], duration: 22,
                   projectile: { speed: 10, damage: [3, 8], radius: 6, color: '#ff8a3d' } },
        spriteScale: 0.88, score: 120, color: '#a06a3a',
        sounds: 'imp',
    },
    demon: {
        name: 'Demon', doom: 1, sprite: 'demon',
        hp: 150, speed: 10, chaseTics: 2, radius: 30,
        painChance: 180, painTics: 4, reactionTics: 8,
        melee: { hitAt: 16, duration: 24, damage: [4, 10] },
        score: 200, color: '#d06a8a', spriteScale: 1.29,
        sounds: 'demon',
    },
    spectre: {
        name: 'Spectre', doom: 1, sprite: 'demon',
        hp: 150, speed: 10, chaseTics: 2, radius: 30,
        painChance: 180, painTics: 4, reactionTics: 8,
        melee: { hitAt: 16, duration: 24, damage: [4, 10] },
        alpha: 0.28,
        score: 250, color: '#d06a8a', spriteScale: 1.29,
        sounds: 'demon',
    },
    lost_soul: {
        name: 'Lost Soul', doom: 1, sprite: 'lost-soul',
        hp: 100, speed: 8, chaseTics: 6, radius: 16,
        painChance: 256, painTics: 6, reactionTics: 8,
        missile: { kind: 'charge', at: 10, chargeSpeed: 20, damage: [3, 8], maxTics: 70 },
        missileRange: { halve: true },
        flies: true, raisable: false,
        score: 100, color: '#e0d0a0', spriteScale: 1.49,
        sounds: 'lost_soul',
    },
    cacodemon: {
        name: 'Cacodemon', doom: 1, sprite: 'cyclops',
        hp: 400, speed: 8, chaseTics: 3, radius: 31,
        painChance: 128, painTics: 6, reactionTics: 8,
        melee: { hitAt: 15, duration: 20, damage: [10, 6] },
        missile: { kind: 'projectile', shots: [{ at: 15 }], duration: 20,
                   projectile: { speed: 10, damage: [5, 8], radius: 6, color: '#ff3b3b' } },
        flies: true, blood: '40,80,220',
        score: 300, color: '#d03030', spriteScale: 1.25,
        sounds: 'cacodemon',
    },
    baron: {
        name: 'Baron of Hell', doom: 1, sprite: 'baron',
        hp: 1000, speed: 8, chaseTics: 3, radius: 24,
        painChance: 50, painTics: 4, reactionTics: 8,
        melee: { hitAt: 16, duration: 24, damage: [10, 8] },
        missile: { kind: 'projectile', shots: [{ at: 16 }], duration: 24,
                   projectile: { speed: 15, damage: [8, 8], radius: 6, color: '#5cff5c' } },
        blood: '60,180,60',
        score: 1000, color: '#c05060', spriteScale: 1.61,
        sounds: 'baron',
    },
    cyberdemon: {
        name: 'Cyberdemon', doom: 1, sprite: 'minotaur',
        hp: 4000, speed: 16, chaseTics: 3, radius: 40,
        painChance: 20, painTics: 20, reactionTics: 8,
        missile: { kind: 'projectile', shots: [{ at: 6 }, { at: 30 }, { at: 54 }], duration: 66,
                   projectile: { speed: 20, damage: [20, 8], radius: 11, color: '#ffb040',
                                 rocket: { radius: 128 } } },
        missileRange: { halve: true, cap: 160 },
        splashImmune: true, raisable: false, boss: true,
        score: 2500, color: '#804030', spriteScale: 1.19,
        sounds: 'cyberdemon',
    },
    spider_mastermind: {
        name: 'Spider Mastermind', doom: 1, sprite: 'zeus',
        hp: 3000, speed: 12, chaseTics: 3, radius: 96,
        painChance: 40, painTics: 6, reactionTics: 8,
        missile: { kind: 'burst', shot: 'hitscan', windup: 20, cycle: 9, shotTics: [0, 4],
                   count: 3, stopChance: 10 / 256, damage: [3, 5], gun: 'chaingun' },
        missileRange: { halve: true },
        splashImmune: true, raisable: false, boss: true,
        score: 2500, color: '#a0a0b0', spriteScale: 1.0,
        sounds: 'spider_mastermind',
    },

    // --------------------------------------------------------- Doom II (1994)
    chaingunner: {
        name: 'Heavy Weapon Dude', doom: 2, sprite: 'chaingunner',
        hp: 70, speed: 8, chaseTics: 3, radius: 20,
        painChance: 170, painTics: 6, reactionTics: 8,
        missile: { kind: 'burst', shot: 'hitscan', windup: 10, cycle: 9, shotTics: [0, 4],
                   count: 1, stopChance: 40 / 256, damage: [3, 5], gun: 'chaingun' },
        spriteScale: 1.37, score: 250, color: '#b03030',
        sounds: 'zombie',
        drop: { weapon: 'Rifle' },
    },
    hell_knight: {
        name: 'Hell Knight', doom: 2, sprite: 'hell-knight',
        hp: 500, speed: 8, chaseTics: 3, radius: 24,
        painChance: 50, painTics: 4, reactionTics: 8,
        melee: { hitAt: 16, duration: 24, damage: [10, 8] },
        missile: { kind: 'projectile', shots: [{ at: 16 }], duration: 24,
                   projectile: { speed: 15, damage: [8, 8], radius: 6, color: '#5cff5c' } },
        blood: '60,180,60',
        score: 600, color: '#b08060', spriteScale: 1.61,
        sounds: 'hell_knight',
    },
    revenant: {
        name: 'Revenant', doom: 2, sprite: 'skeleton-knight',
        hp: 300, speed: 10, chaseTics: 2, radius: 20,
        painChance: 100, painTics: 10, reactionTics: 8,
        melee: { hitAt: 12, duration: 18, damage: [6, 10] },
        missile: { kind: 'projectile', shots: [{ at: 20 }], duration: 40,
                   projectile: { speed: 10, damage: [10, 8], radius: 11, color: '#ffd080',
                                 homingChance: 0.5 } },
        missileRange: { minDist: 196, halve: true },
        spriteScale: 1.47, score: 400, color: '#d0c8b0',
        sounds: 'revenant',
    },
    mancubus: {
        name: 'Mancubus', doom: 2, sprite: 'mancubus',
        hp: 600, speed: 8, chaseTics: 4, radius: 48,
        painChance: 80, painTics: 6, reactionTics: 8,
        missile: { kind: 'projectile', duration: 80,
                   shots: [{ at: 20, angles: [0, FATSPREAD_DEGREES] },
                           { at: 40, angles: [0, -2 * FATSPREAD_DEGREES] },
                           { at: 60, angles: [FATSPREAD_DEGREES / 2, -FATSPREAD_DEGREES / 2] }],
                   projectile: { speed: 20, damage: [8, 8], radius: 6, color: '#ff9a3d' } },
        score: 500, color: '#a08060', spriteScale: 0.98,
        sounds: 'mancubus',
    },
    arachnotron: {
        name: 'Arachnotron', doom: 2, sprite: 'ice-monster',
        hp: 500, speed: 12, chaseTics: 3, radius: 48,
        painChance: 128, painTics: 6, reactionTics: 8,
        missile: { kind: 'burst', shot: 'projectile', windup: 20, cycle: 9, shotTics: [0],
                   stopChance: 10 / 256,
                   projectile: { speed: 25, damage: [5, 5], radius: 13, color: '#6cd0ff' } },
        spriteScale: 1.17, score: 500, color: '#70a0c0',
        sounds: 'arachnotron',
    },
    pain_elemental: {
        name: 'Pain Elemental', doom: 2, sprite: 'pain-elemental',
        hp: 400, speed: 8, chaseTics: 3, radius: 31,
        painChance: 128, painTics: 12, reactionTics: 8,
        missile: { kind: 'spawn', at: 15, duration: 20 },
        flies: true, deathSpawn: 3,
        score: 400, color: '#a06040', spriteScale: 1.27,
        sounds: 'pain_elemental',
    },
    archvile: {
        name: 'Arch-vile', doom: 2, sprite: 'arch-vile',
        hp: 700, speed: 15, chaseTics: 2, radius: 20,
        painChance: 10, painTics: 10, reactionTics: 8,
        missile: { kind: 'flame', at: 84, duration: 104, damage: 20, splash: 70 },
        missileRange: { maxDist: 14 * 64 },
        resurrects: true, untargetable: true, alwaysRetargets: true,
        score: 1500, color: '#e0c080', spriteScale: 1.5,
        sounds: 'archvile',
    },
    ss: {
        name: 'Wolfenstein SS', doom: 2, sprite: 'pirate-guy',
        hp: 50, speed: 8, chaseTics: 3, radius: 20,
        painChance: 170, painTics: 6, reactionTics: 8,
        missile: { kind: 'burst', shot: 'hitscan', windup: 20, cycle: 5, shotTics: [0],
                   count: 1, stopChance: 40 / 256, damage: [3, 5], gun: 'ss' },
        spriteScale: 0.99, score: 150, color: '#4060b0',
        sounds: 'ss',
        drop: { ammo: 'bullets' },
    },
};

/** Every monster id, in bestiary order. */
export const MONSTER_TYPES = Object.keys(MONSTERS);

/**
 * @param {string} type - A key of MONSTERS
 * @returns {Object} The monster definition, or the Zombieman for unknown ids
 */
export function getMonster(type) {
    return MONSTERS[type] || MONSTERS.zombieman;
}

// =============================================================================
// SPAWN TABLES
// =============================================================================

/**
 * Which monsters a level draws from, and how often. The first game's bestiary
 * arrives first, in roughly the order Doom introduced it; Doom II's additions
 * follow from level 6. Weights are relative within a row.
 */
export const SPAWN_TABLE = [
    { minLevel: 1, weights: { zombieman: 50, shotgun_guy: 15, imp: 35 } },
    { minLevel: 2, weights: { zombieman: 35, shotgun_guy: 20, imp: 30, demon: 12, spectre: 3 } },
    { minLevel: 4, weights: { zombieman: 25, shotgun_guy: 18, imp: 25, demon: 12, spectre: 4,
                              lost_soul: 8, cacodemon: 8 } },
    { minLevel: 6, weights: { zombieman: 18, shotgun_guy: 16, chaingunner: 8, imp: 20, demon: 10,
                              spectre: 4, lost_soul: 6, cacodemon: 8, hell_knight: 6, baron: 2 } },
    { minLevel: 8, weights: { zombieman: 12, shotgun_guy: 14, chaingunner: 10, imp: 16, demon: 8,
                              spectre: 4, lost_soul: 5, cacodemon: 7, hell_knight: 6, baron: 3,
                              revenant: 6, mancubus: 4, arachnotron: 4, pain_elemental: 3 } },
    { minLevel: 11, weights: { zombieman: 10, shotgun_guy: 12, chaingunner: 10, imp: 14, demon: 7,
                               spectre: 4, lost_soul: 4, cacodemon: 7, hell_knight: 6, baron: 4,
                               revenant: 7, mancubus: 5, arachnotron: 5, pain_elemental: 3,
                               archvile: 2, ss: 2 } },
];

/**
 * The spawn weights in force at a level.
 *
 * @param {number} level - Current level
 * @returns {Object<string, number>} Monster id -> relative weight
 */
export function spawnWeightsForLevel(level) {
    let row = SPAWN_TABLE[0];
    for (const candidate of SPAWN_TABLE) {
        if (level >= candidate.minLevel) row = candidate;
    }
    return row.weights;
}

/**
 * Picks a monster for a regular level.
 *
 * @param {number} level - Current level
 * @param {() => number} [random] - Injectable RNG
 * @returns {string} A key of MONSTERS
 */
export function pickMonsterType(level, random = Math.random) {
    const weights = spawnWeightsForLevel(level);
    const entries = Object.entries(weights);
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);

    let roll = random() * total;
    for (const [type, weight] of entries) {
        roll -= weight;
        if (roll < 0) return type;
    }
    return entries[entries.length - 1][0];
}

/**
 * Which boss a boss level gets. Doom's second episode ends on the Cyberdemon
 * and its third on the Spider Mastermind, so they alternate.
 *
 * @param {number} tier - 1 for level 5, 2 for level 10, ...
 * @returns {string} 'cyberdemon' or 'spider_mastermind'
 */
export function bossTypeForTier(tier) {
    return tier % 2 === 1 ? 'cyberdemon' : 'spider_mastermind';
}

// =============================================================================
// P_CheckMissileRange
// =============================================================================

/**
 * Decides whether a monster fires this chase step. A port of
 * P_CheckMissileRange from p_enemy.c.
 *
 * The heart of it: the further the target, the less likely the shot, with
 * `dist` clamped so that even at range a monster fires about one step in five.
 * A monster that was just hurt always fires back. A monster still in its
 * reaction time never does. Monsters with no melee attack fire more readily,
 * and a handful have their own rules: the Arch-vile will not attack beyond
 * 14 tiles, the Revenant punches rather than fires up close, and the
 * Cyberdemon, Spider and Lost Soul treat every distance as half what it is.
 *
 * The caller is responsible for the line-of-sight test that precedes all of
 * this in the original.
 *
 * @param {Object} def - Monster definition from MONSTERS
 * @param {number} distUnits - Distance to the target in map units
 * @param {Object} [state]
 * @param {boolean} [state.justHit] - MF_JUSTHIT: the target hurt this monster
 * @param {number} [state.reactionTime] - Chase steps of reaction time remaining
 * @param {number} [state.chanceScale] - Difficulty multiplier on the final chance
 * @param {() => number} [state.random] - Injectable RNG
 * @returns {boolean} True to attack now
 */
export function checkMissileRange(def, distUnits, state = {}) {
    const { justHit = false, reactionTime = 0, chanceScale = 1, random = Math.random } = state;

    if (justHit) return true;
    if (reactionTime > 0) return false;

    let dist = distUnits - 64;
    if (!def.melee) dist -= 128;

    const rules = def.missileRange || {};
    if (rules.maxDist !== undefined && dist > rules.maxDist) return false;
    if (rules.minDist !== undefined && dist < rules.minDist) return false;
    if (rules.halve) dist /= 2;

    dist = Math.min(dist, rules.cap !== undefined ? rules.cap : 200);

    // P_Random() < dist means "no shot": the chance of firing is what remains.
    const chance = Math.min(1, Math.max(0, (256 - Math.max(0, dist)) / 256) * chanceScale);
    return random() < chance;
}

// =============================================================================
// P_NewChaseDir: EIGHT-DIRECTION MOVEMENT
// =============================================================================

/**
 * The eight compass directions, numbered as in p_enemy.c. Screen coordinates
 * have y pointing down, so NORTH is negative y.
 */
export const DIR = {
    EAST: 0, NORTHEAST: 1, NORTH: 2, NORTHWEST: 3,
    WEST: 4, SOUTHWEST: 5, SOUTH: 6, SOUTHEAST: 7,
    NONE: 8,
};

/** Doom steps diagonals at 47000/65536 of the speed on each axis. */
const DIAGONAL = 47000 / 65536;

/** Unit step for each direction, indexed by DIR. */
export const DIR_VECTORS = [
    [1, 0], [DIAGONAL, -DIAGONAL], [0, -1], [-DIAGONAL, -DIAGONAL],
    [-1, 0], [-DIAGONAL, DIAGONAL], [0, 1], [DIAGONAL, DIAGONAL],
];

/** Facing angle in radians for each direction, indexed by DIR. */
export const DIR_ANGLES = DIR_VECTORS.map(([x, y]) => Math.atan2(y, x));

/** The reverse of each direction. */
export const OPPOSITE = [
    DIR.WEST, DIR.SOUTHWEST, DIR.SOUTH, DIR.SOUTHEAST,
    DIR.EAST, DIR.NORTHEAST, DIR.NORTH, DIR.NORTHWEST,
    DIR.NONE,
];

/**
 * The diagonal toward a target, indexed by (south ? 2 : 0) + (east ? 1 : 0).
 * Doom's table is [NW, NE, SW, SE] under its y-up convention; the same table
 * holds here once "south" is read as positive screen y.
 */
const DIAGONALS = [DIR.NORTHWEST, DIR.NORTHEAST, DIR.SOUTHWEST, DIR.SOUTHEAST];

/**
 * Chooses a new direction to walk. A port of P_NewChaseDir from p_enemy.c.
 *
 * The algorithm is the reason Doom's monsters zig-zag: try the diagonal
 * straight at the target; failing that, the longer axis, then the shorter (with
 * a 22% chance of trying them the other way round, which is the wobble); then
 * whatever direction the monster was already going; then a sweep clockwise or
 * anticlockwise round the compass; and only as a last resort straight back the
 * way it came.
 *
 * `tryWalk` is P_TryWalk: it must actually attempt the step and report whether
 * it was possible, because the choice is made by trying, not by looking.
 *
 * @param {Object} args
 * @param {number} args.dx - Target x minus monster x, in pixels
 * @param {number} args.dy - Target y minus monster y, in pixels
 * @param {number} args.oldDir - The direction currently being walked (DIR)
 * @param {(dir: number) => boolean} args.tryWalk - Attempts a step; true on success
 * @param {() => number} [args.random] - Injectable RNG
 * @returns {number} The direction now being walked, or DIR.NONE if stuck
 */
export function newChaseDir({ dx, dy, oldDir, tryWalk, random = Math.random }) {
    const threshold = unitsToPx(10);
    const turnaround = OPPOSITE[oldDir];

    const d = [DIR.NONE, DIR.NONE, DIR.NONE];
    if (dx > threshold) d[1] = DIR.EAST;
    else if (dx < -threshold) d[1] = DIR.WEST;
    if (dy > threshold) d[2] = DIR.SOUTH;
    else if (dy < -threshold) d[2] = DIR.NORTH;

    // Try the direct diagonal.
    if (d[1] !== DIR.NONE && d[2] !== DIR.NONE) {
        const diagonal = DIAGONALS[(dy > 0 ? 2 : 0) + (dx > 0 ? 1 : 0)];
        if (diagonal !== turnaround && tryWalk(diagonal)) return diagonal;
    }

    // Then the axes, longer first -- usually.
    if (random() * 256 > 200 || Math.abs(dy) > Math.abs(dx)) {
        const swap = d[1]; d[1] = d[2]; d[2] = swap;
    }
    if (d[1] === turnaround) d[1] = DIR.NONE;
    if (d[2] === turnaround) d[2] = DIR.NONE;

    if (d[1] !== DIR.NONE && tryWalk(d[1])) return d[1];
    if (d[2] !== DIR.NONE && tryWalk(d[2])) return d[2];

    // No direct path: keep going the way it was going.
    if (oldDir !== DIR.NONE && tryWalk(oldDir)) return oldDir;

    // Sweep the compass, in a random rotational sense.
    if (random() < 0.5) {
        for (let dir = DIR.EAST; dir <= DIR.SOUTHEAST; dir++) {
            if (dir !== turnaround && tryWalk(dir)) return dir;
        }
    } else {
        for (let dir = DIR.SOUTHEAST; dir >= DIR.EAST; dir--) {
            if (dir !== turnaround && tryWalk(dir)) return dir;
        }
    }

    // Last resort: turn round.
    if (turnaround !== DIR.NONE && tryWalk(turnaround)) return turnaround;

    return DIR.NONE;
}

/**
 * The spread applied to one hitscan bullet, in radians. Doom's
 * (P_Random() - P_Random()) << 20: the difference of two uniform bytes, which
 * is triangular and peaks at zero.
 *
 * @param {() => number} [random] - Injectable RNG
 * @returns {number} Angle offset in radians
 */
export function hitscanSpread(random = Math.random) {
    const spread = (random() - random()) * HITSCAN_SPREAD_DEGREES;
    return spread * Math.PI / 180;
}
