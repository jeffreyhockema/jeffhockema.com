/**
 * GAME CONSTANTS AND CONFIGURATION
 * 
 * This module contains all game constants, tile definitions, weapon configurations,
 * and difficulty settings. All values are centralized here for easy maintenance
 * and balance adjustments.
 * 
 * @author TDDL Game Team
 * @version 1.0.0
 */

// =============================================================================
// CORE GAME DIMENSIONS AND VIEWPORT SETTINGS
// =============================================================================

/**
 * Main game viewport dimensions
 * These define the visible game area and are used for camera calculations
 */
export const VIEWPORT_WIDTH = 800;   // Canvas width in pixels
export const VIEWPORT_HEIGHT = 600;  // Canvas height in pixels

/**
 * World and tile system configuration
 * The game world is divided into a grid of tiles for collision detection
 * and map generation. Each tile represents a 40x40 pixel square.
 */
export const TILE_SIZE = 40;         // Size of each world tile in pixels
// Levels are partitioned into gated zones, and every zone needs enough floor for
// several rooms, two-wide hallways between them and the dead rock that keeps the
// zones apart. At 50 x 40 that budget left zones with two small rooms each and
// large stretches of solid nothing between them.
export const MAP_COLS = 64;          // Number of tile columns in the world
export const MAP_ROWS = 48;          // Number of tile rows in the world

// =============================================================================
// TILE TYPE DEFINITIONS
// =============================================================================

/**
 * Tile type constants for map generation and collision detection
 * Each tile type has a unique numeric identifier and specific behavior
 */

// Basic terrain tiles
export const TILE_EMPTY = 0;         // Walkable empty space
export const TILE_WALL = 1;          // Solid wall that blocks movement and projectiles

// Interactive door tiles (require matching keys)
export const TILE_DOOR_RED = 2;      // Red door - requires red key
export const TILE_DOOR_YELLOW = 3;   // Yellow door - requires yellow key  
export const TILE_DOOR_BLUE = 4;     // Blue door - requires blue key
export const TILE_SECRET_DOOR = 5;   // Hidden door - opens on contact, gives points

// Collectible key items
export const TILE_KEY_RED = 6;       // Red key pickup
export const TILE_KEY_YELLOW = 7;    // Yellow key pickup
export const TILE_KEY_BLUE = 8;      // Blue key pickup

// Weapon pickup tiles
export const TILE_WEAPON_SHOTGUN = 9;         // Shotgun weapon pickup
export const TILE_WEAPON_RIFLE = 10;          // Rifle weapon pickup
export const TILE_WEAPON_ROCKETLAUNCHER = 11; // Rocket launcher weapon pickup
export const TILE_WEAPON_BFG = 12;            // BFG weapon pickup
export const TILE_WEAPON_PLASMAGUN = 15;      // Plasma gun weapon pickup

// Special tiles
export const TILE_HEALTH_PACK = 13;  // Health restoration item
export const TILE_EXIT = 14;         // Level exit (unlocked when enemies defeated)

// -----------------------------------------------------------------------------
// TERRAIN TILES
// -----------------------------------------------------------------------------
//
// Walkable ground that is not merely walkable. These are floors, not obstacles:
// nothing about them blocks movement, projectiles or sight, and the connectivity
// checks in map-generator.js treat them exactly like open ground. What they change
// is what it COSTS to walk there -- damage, speed, and in the case of the two hot
// ones, the fact that they light the room themselves.
//
// The full behaviour of each lives in TERRAIN below, keyed by these ids. Nothing
// outside that table should hard-code what lava does; ask the table.
export const TILE_LAVA = 16;         // Molten rock: glows fiercely, burns badly
export const TILE_TOXIC = 17;        // Chemical sludge: glows faintly, corrodes slowly
export const TILE_WATER = 18;        // Standing water: harmless, but wades slowly

/**
 * A prop: a crate, a vat, a pillar (see js/decor.js). Solid to movement and
 * to shots -- you can take cover behind a crate -- but not to light or to
 * sight: it is a thing standing in the room, lit as the floor around it is,
 * with the wall behind it lit as usual. Which prop it is lives in the
 * decoration map, not in the tile.
 */
export const TILE_PROP = 19;

/**
 * A section of wall that can slide aside (see js/switches.js): solid and
 * opaque until its switch is pressed, then it slides into the rock and
 * stays open. Every solver treats it as wall, so it only ever seals a
 * reward, never the way through.
 */
export const TILE_SLIDE = 20;

/** A switch panel on a wall: pressed by pushing into it or shooting it. */
export const TILE_SWITCH = 21;

/**
 * A window: a wall you can see and shoot through but not walk through.
 *
 * Doom builds these as a two-sided line with a gap between the floor and the
 * ceiling of the sector beyond -- you look through it, you shoot through it,
 * and what is on the other side shoots back, but neither of you can cross.
 * That is three separate questions about one tile, and the code already
 * asks them separately: isSolidAt for bodies, blocksShotsAt for bullets,
 * blocksSightAt for eyes and light. A window answers yes, no, no.
 *
 * A window backing onto rock instead of onto another room looks outside
 * (see WINDOW_OUTSIDE), and daylight through it lights the room.
 */
export const TILE_WINDOW = 22;

/**
 * What lies beyond an exterior window, per wall style.
 *
 * Doom's outdoors is the sky flat F_SKY1 and a light level of 255 -- a bright
 * hole in the wall, and the strongest lighting contrast the game has. These
 * are the same idea: a band of sky over a dark horizon, and a brightness the
 * room borrows.
 */
export const WINDOW_OUTSIDE = [
    { sky: ['#1B2A3C', '#3C5A78'], ground: '#1A1F24', glow: '#7FA8D0', stars: true },   // Industrial: night
    { sky: ['#2A2418', '#6B5A38'], ground: '#241F18', glow: '#C9A86A', stars: true },   // Ancient stone: dusk
    { sky: ['#3A1008', '#8C2A10'], ground: '#1E0C06', glow: '#FF6A30', stars: false },  // Volcanic: hellfire
    { sky: ['#1C2A16', '#4A6B2A'], ground: '#151C12', glow: '#9FD060', stars: false },  // Toxic: sick green
    { sky: ['#14202A', '#2E4A5C'], ground: '#101619', glow: '#6FA0B8', stars: true },   // Cistern: cold dawn
];

/** How bright an exterior window makes the wall it sits in, 0..1. */
export const WINDOW_DAYLIGHT = 0.62;

/**
 * Everything each terrain tile does, in one table.
 *
 * Damage is quoted per SECOND rather than per frame so the numbers mean something
 * against the player's 100 health: lava kills an unarmoured player in a little
 * under two seconds, which is long enough to sprint across a two-tile channel and
 * far too short to stand and think about it. Callers convert with
 * ANIMATION_TICKS_PER_SECOND and accumulate the fraction, so a tile that deals
 * less than a point per frame still deals its full rate over a second.
 *
 * `speed` multiplies movement while standing on the tile. Water is the interesting
 * one: it does no damage at all, so wading is purely a decision about time, which
 * is exactly what makes it dangerous with something shooting at you.
 *
 * `glow` is fed straight to the lighting module as a light source (see
 * collectHazardLights in js/lighting.js). Its absence -- water -- means the tile
 * emits nothing and is only visible when something else lights it.
 *
 * `palette` is read by the renderer. The five entries are the same five roles for
 * every liquid: `deep` is the body of the pool, `mid` the mottling washed over it,
 * `hot` the brightest highlight, `rim` the crust or shoreline drawn where the pool
 * ends, `ember` the thin lit line just inside that crust, and `crust` the near
 * black of the cooled skin floating on it and of the bank's outer shadow.
 *
 * `surface` picks which of three routines draws the body. They exist because the
 * three liquids do not move alike, and drawing them all with the same wobble is
 * what made an early version of this read as polka dots: molten rock cracks into
 * bright veins between cooling plates, sludge blisters and pops, and water runs in
 * long ripples. Same palette roles, three different motions.
 */
export const TERRAIN = {
    [TILE_LAVA]: {
        name: 'lava',
        damagePerSecond: 55,       // Lethal in under two seconds at full health
        speed: 0.60,               // Wading through molten rock is not quick
        splashSound: 'lava',
        surface: 'molten',
        palette: {
            deep: '#4A1207',
            mid: '#9E320A',
            hot: '#FFB13A',
            rim: '#2B201B',        // Cooled basalt bank at the pool's edge
            ember: '#FF8A2E',
            crust: '#150C08',      // Plates of skin floating on the melt
        },
        glow: {
            range: TILE_SIZE * 4.0,
            intensity: 0.85,
            color: '255,150,60',
            flicker: 0.18,         // Amplitude of the intensity wobble, 0..1
            flickerHz: 2.7,
        },
    },

    [TILE_TOXIC]: {
        name: 'toxic waste',
        damagePerSecond: 10,       // A tax on crossing, not a death sentence
        speed: 0.80,
        splashSound: 'sludge',
        surface: 'sludge',
        palette: {
            deep: '#14290E',
            mid: '#33660F',
            hot: '#9BD634',
            rim: '#2C3A22',
            ember: '#7FBF2E',
            crust: '#0E1A09',
        },
        glow: {
            range: TILE_SIZE * 3.0,
            intensity: 0.42,
            color: '150,255,90',
            flicker: 0.10,
            flickerHz: 1.3,
        },
    },

    [TILE_WATER]: {
        name: 'water',
        damagePerSecond: 0,
        speed: 0.62,               // The slowest of the three, and the only safe one
        splashSound: 'water',
        surface: 'ripple',
        palette: {
            deep: '#0B1F30',
            mid: '#173C58',
            hot: '#5C9EC0',
            rim: '#22384A',
            ember: '#7FB6D4',
            crust: '#08131E',
        },
        glow: null,                // Water is not self-luminous
    },
};

/**
 * Terrain ids in ascending order. Handy for iteration and for tests; prefer
 * `isTerrainTile()` in js/terrain.js over comparing against this directly.
 */
export const TERRAIN_TILES = [TILE_LAVA, TILE_TOXIC, TILE_WATER];

// =============================================================================
// PLAYER CHARACTER CONFIGURATION
// =============================================================================

/**
 * The player is drawn from the character atlases in sprites/player/, indexed by
 * sprites/player/manifest.json and addressed through js/player-sprites.js.
 *
 * These are top-down sprites with a single facing, rotated to wherever the
 * player aims. On-screen size is derived from the collision radius, the same way
 * enemies are, so the artwork and the hitbox stay in step.
 */
export const PLAYER_SPRITE_BODY_PER_RADIUS = 2.0;  // Shoulders span the collision circle, as Doom's marine sprite spans his radius

/**
 * The marine's collision radius, in Doom map units: 16, half a tile across,
 * as in Doom, so he fits a doorway the way Doom's marine does. Enemies' radii
 * live in the bestiary (js/monsters.js).
 */
export const PLAYER_RADIUS_UNITS = 16;

/**
 * Movement speeds, in pixels per frame -- Doom's marine exactly.
 *
 * P_MovePlayer thrusts the marine by `forwardmove * 2048` each tic, and
 * friction takes back 1 - 0.90625 of his momentum, so he settles at
 * `accel / (1 - friction)`: 25/32 over 0.09375 is 8 1/3 map units a tic
 * walking, and forwardmove doubles to 50 for a run, so running is 16 2/3 --
 * exactly twice, which is the ratio the whole game is built around.
 *
 * Converted here by the same two factors as everything else: a 64-unit tile
 * is drawn TILE_SIZE wide, and Doom's 35 tics are this game's 60 frames. The
 * walk used to be 3.5, fifteen per cent quick, which put the ratio at 1.7 and
 * let a strolling marine leave an Arch-vile behind; at Doom's figure the vile
 * runs at nine tenths of a walk and you have to break into a run, which is
 * why running is how Doom is played.
 */
const DOOM_UNIT_PX = TILE_SIZE / 64;
const DOOM_TIC_FRAMES = 60 / 35;
const doomSpeedPx = (unitsPerTic) => unitsPerTic * DOOM_UNIT_PX / DOOM_TIC_FRAMES;

export const PLAYER_WALK_SPEED = doomSpeedPx(25 / 32 / 0.09375);   // 8 1/3 u/tic
export const PLAYER_RUN_SPEED = doomSpeedPx(50 / 32 / 0.09375);    // 16 2/3 u/tic

/**
 * Fallback hold for the attack animation, in updates.
 *
 * Only used when there is no artwork to measure. Normally the hold is the length
 * of the equipped weapon's own attack animation (see Player.attackAnimationTicks),
 * because a fixed number here cannot suit weapons whose swings run anywhere from
 * 17 to 40 updates -- a flat 12 showed the bat's wind-up and never its swing.
 */
export const PLAYER_ATTACK_ANIM_HOLD = 12;

/**
 * How close the crosshair may get before shots stop being aimed at it.
 *
 * Projectiles leave the barrel, which sits off to one side of the player, and
 * are angled at whatever the crosshair is on so they still land where the player
 * pointed. Aim at your own feet, though, and that correction swings wildly --
 * inside this radius the shot simply follows the way the character is facing.
 */
export const MIN_AIM_CONVERGE_DISTANCE = 60;

/**
 * Muzzle flashes are drawn by the game, not painted into the sprites.
 *
 * Each firing weapon carries a `muzzleFlash` descriptor: its colour (also used
 * for the light it throws), a size in world pixels, how many updates it lasts,
 * and how brightly it lights the room. The sprites' own painted flashes are
 * removed at build time so the two never disagree about where the barrel is or
 * what colour the shot was.
 */
export const MUZZLE_LIGHT_STOPS = [[0, 1], [0.5, 0.55], [1, 0]];

/**
 * How long the player's death plays out before the game-over screen, in updates.
 *
 * Both characters ship a six-frame death animation. Ending the run the instant
 * health hit zero cancelled the render loop on the same frame, so that artwork
 * was never seen and the game cut straight from full motion to a menu.
 */
export const PLAYER_DEATH_BEAT = 80;

// =============================================================================
// ENEMY SPRITE CONFIGURATION
// =============================================================================

/**
 * Enemy sprite rendering settings
 *
 * Enemies are drawn from the character atlases in sprites/enemies/, indexed by
 * sprites/enemies/manifest.json and addressed through js/enemy-sprites.js. The
 * atlases are baked at a fixed body height, so on-screen size is derived here
 * from each enemy's own collision radius: a mini-boss with twice the radius of
 * a grunt renders at twice the size from the same artwork.
 */
// Body height as a multiple of collision radius. 2.6 puts the human-sized
// monsters at Doom's 40 map units across; each monster's `spriteScale` then
// solves its own footprint for the width of its Doom sprite.
export const ENEMY_SPRITE_BODY_PER_RADIUS = 2.6;
export const ENEMY_SPRITE_FOOT_OFFSET = 0.6;      // Feet sit this fraction of a radius below centre

/**
 * Animation playback timing
 *
 * Enemy updates run once per rendered frame, so an animation's frame rate is
 * converted into per-update steps against this figure.
 */
export const ANIMATION_TICKS_PER_SECOND = 60;

/**
 * How long a standing enemy waits before playing an idle variation, in updates.
 * Randomised per blink so a room full of enemies doesn't blink in lockstep.
 */
export const ENEMY_IDLE_BLINK_MIN_DELAY = 120;   // 2 seconds
export const ENEMY_IDLE_BLINK_MAX_DELAY = 420;   // 7 seconds

/**
 * How long a corpse lingers after its death animation finishes, in updates.
 * The body holds its final frame briefly so kills read as kills, then the
 * enemy is removed.
 */
export const ENEMY_CORPSE_LINGER = 45;

// =============================================================================
// BOSS ENEMY CONFIGURATION  
// =============================================================================

/**
 * Boss level scheduling and mini-boss spawn configuration
 * Controls when boss encounters occur and their frequency.
 *
 * Which monsters the bosses are -- a Baron of Hell guarding the exit on
 * mini-boss levels, the Cyberdemon and Spider Mastermind alternating on every
 * fifth level -- is decided in js/monsters.js.
 */
export const MINI_BOSS_SPAWN_INTERVAL_MIN = 3;  // Minimum levels between mini-bosses
export const MINI_BOSS_SPAWN_INTERVAL_MAX = 7;  // Maximum levels between mini-bosses

// =============================================================================
// WEAPON SYSTEM CONFIGURATION
// =============================================================================

/**
 * The arsenal is Doom's (1993), weapon for weapon, with the numbers from
 * p_pspr.c and info.c:
 *
 *   Knife            the Fist:        2-20,   one punch every 22 tics
 *   Pistol           the Pistol:      5-15,   one bullet every 14 tics, the
 *                                     first shot dead straight, refire spread
 *   Shotgun          the Shotgun:     7 pellets of 5-15, every 37 tics
 *   Rifle            the Chaingun:    5-15,   a bullet every 4 tics
 *   Rocket Launcher  the same:        20-160 on impact, 128 splash, every 20 tics
 *   Plasma Gun       the same:        5-40,   a bolt every 3 tics
 *   BFG              the BFG9000:     100-800 on impact, then forty rays of
 *                                     15-120 across a 90-degree fan, every 60
 *                                     tics, forty cells a shot
 *
 * Damage is rolled per shot from `dice` -- `mult * (1 + P_Random() % sides)`,
 * as Doom rolled it -- and never scales with the level or the difficulty.
 * `damage` is the average, kept as a number for anything that only wants a
 * size. The pistol, shotgun and rifle are hitscan: instant, with the
 * `(P_Random() - P_Random()) << 18` spread of about 5.6 degrees either side.
 * The rest throw projectiles at Doom's speeds. Ammunition is Doom's four
 * pools (see AMMO_TYPES), shared between the weapons that shared them.
 *
 * Units: Doom's 64-unit tile is this game's TILE_SIZE, and its 35 tics are
 * 60 frames; the two converters below quote each number in Doom's own terms.
 */

/** Pixels per Doom map unit. */
const DOOM_PX = TILE_SIZE / 64;

/** Frames per Doom tic. */
const FRAMES_PER_DOOM_TIC = 60 / 35;

/** @param {number} tics @returns {number} Whole frames */
const doomTics = (tics) => Math.max(1, Math.round(tics * FRAMES_PER_DOOM_TIC));

/** @param {number} unitsPerTic @returns {number} Pixels per frame */
const doomSpeed = (unitsPerTic) => unitsPerTic * DOOM_PX / FRAMES_PER_DOOM_TIC;

/**
 * Player hitscan spread: (P_Random() - P_Random()) << 18 in binary angles,
 * a triangular distribution reaching about 5.6 degrees either side.
 */
export const PLAYER_SPREAD_DEGREES = 5.625;

/**
 * Doom's ammunition. `max` is the backpack-less capacity, `start` what a new
 * game begins with, `clip` the small pickup and `box` the large one.
 */
export const AMMO_TYPES = {
    bullets: { label: 'bullets', max: 200, start: 50, clip: 10, box: 50 },
    shells:  { label: 'shells',  max: 50,  start: 0,  clip: 4,  box: 20 },
    rockets: { label: 'rockets', max: 50,  start: 0,  clip: 1,  box: 5 },
    cells:   { label: 'cells',   max: 300, start: 0,  clip: 20, box: 100 },
};

/**
 * Damage dice as Doom rolls them: `mult * ((P_Random() % sides) + 1)`.
 *
 * @param {[number, number]} dice - [multiplier, sides]
 * @param {() => number} [random] - Injectable RNG
 * @returns {number} Rolled damage
 */
export function rollDice(dice, random = Math.random) {
    return dice[0] * (1 + Math.floor(random() * dice[1]));
}

/** @param {[number, number]} dice @returns {number} The average roll */
export function diceAverage(dice) {
    return dice[0] * (dice[1] + 1) / 2;
}

/**
 * One shot's damage from a weapon: rolled from its dice, or its flat
 * `damage` for anything without dice.
 *
 * @param {Object} weapon - A WEAPON_STATS entry or a player's weapon instance
 * @param {() => number} [random] - Injectable RNG
 * @returns {number} Damage
 */
export function rollWeaponDamage(weapon, random = Math.random) {
    return weapon.dice ? rollDice(weapon.dice, random) : weapon.damage;
}

/**
 * The spread of one player bullet, in radians: the difference of two uniform
 * rolls, triangular and peaking at zero.
 *
 * @param {number} [degrees] - Half-width of the spread
 * @param {() => number} [random] - Injectable RNG
 * @returns {number} Angle offset in radians
 */
export function playerSpread(degrees = PLAYER_SPREAD_DEGREES, random = Math.random) {
    return (random() - random()) * degrees * Math.PI / 180;
}

export const WEAPON_STATS = {
    // KNIFE - the Fist. Always owned; a punch every 22 tics for 2-20.
    "Knife": {
        name: "Knife",
        dice: [2, 10],
        damage: () => diceAverage([2, 10]),
        fireRate: doomTics(22),
        bulletSpeed: 0,
        spread: 0,
        numPellets: 0,
        color: '#ffffff',
        singleShot: false,      // Doom's fist keeps punching while the button is held
        ammo: Infinity,
        maxAmmo: Infinity,
        pickupAmmo: 0,
        isMelee: true,
        meleeRange: 64 * DOOM_PX,   // MELEERANGE
        spriteWeapon: 'knife',
        icon: 'knife'
    },

    // PISTOL - 5-15 a bullet, every 14 tics. The first shot of a burst is
    // dead straight; holding the trigger spreads the rest (A_FirePistol).
    "Pistol": {
        name: "Pistol",
        dice: [5, 3],
        damage: () => diceAverage([5, 3]),
        fireRate: doomTics(14),
        hitscan: true,
        spreadDegrees: PLAYER_SPREAD_DEGREES,
        accurateFirstShot: true,
        spread: PLAYER_SPREAD_DEGREES * Math.PI / 180,
        bulletSpeed: 0,
        numPellets: 1,
        color: '#ffeb3b',
        singleShot: false,
        ammoType: 'bullets',
        ammoPerShot: 1,
        ammo: AMMO_TYPES.bullets.start,
        maxAmmo: AMMO_TYPES.bullets.max,
        pickupAmmo: 20,         // Doom has no pistol pickup; a found one comes with a clip's worth
        bulletRadius: 2,
        muzzleFlash: { color: [255, 226, 140], size: 13, frames: 3, light: 0.5, lightRange: TILE_SIZE * 3 },
        spriteWeapon: 'pistol',
        icon: 'pistol',
        ammoIcon: 'ammo_pistol'
    },

    // SHOTGUN - seven pellets of 5-15 in a 5.6-degree fan, every 37 tics.
    //
    // Drawn with the flamethrower artwork as-is: the sprite pack has no shotgun,
    // and a big two-handed weapon held at the hip is the closest pose it has.
    "Shotgun": {
        name: "Shotgun",
        dice: [5, 3],           // Per pellet
        damage: () => diceAverage([5, 3]),
        fireRate: doomTics(37),
        hitscan: true,
        spreadDegrees: PLAYER_SPREAD_DEGREES,
        spread: PLAYER_SPREAD_DEGREES * Math.PI / 180,
        bulletSpeed: 0,
        numPellets: 7,
        color: '#FFA500',
        singleShot: false,
        ammoType: 'shells',
        ammoPerShot: 1,
        ammo: 0,
        maxAmmo: AMMO_TYPES.shells.max,
        pickupAmmo: 8,          // A found shotgun holds eight shells
        bulletRadius: 2,
        muzzleFlash: { color: [255, 200, 110], size: 22, frames: 4, light: 0.8, lightRange: TILE_SIZE * 4 },
        spriteWeapon: 'flamethrower',
        icon: 'shotgun',
        ammoIcon: 'ammo_shotgun'
    },

    // RIFLE - the Chaingun's seat: 5-15 a bullet, a bullet every 4 tics,
    // always with the refire spread.
    "Rifle": {
        name: "Rifle",
        dice: [5, 3],
        damage: () => diceAverage([5, 3]),
        fireRate: doomTics(4),
        hitscan: true,
        spreadDegrees: PLAYER_SPREAD_DEGREES,
        spread: PLAYER_SPREAD_DEGREES * Math.PI / 180,
        bulletSpeed: 0,
        numPellets: 1,
        color: '#ADD8E6',
        singleShot: false,
        ammoType: 'bullets',
        ammoPerShot: 1,
        ammo: 0,
        maxAmmo: AMMO_TYPES.bullets.max,
        pickupAmmo: 20,         // A found chaingun holds twenty rounds
        bulletRadius: 2,
        muzzleFlash: { color: [255, 226, 140], size: 12, frames: 2, light: 0.45, lightRange: TILE_SIZE * 3 },
        spriteWeapon: 'rifle',
        icon: 'rifle',
        ammoIcon: 'ammo_rifle'
    },

    // ROCKET LAUNCHER - 20-160 on what it hits, and a 128-point blast over
    // 128 units that falls off to nothing at the edge and hurts the shooter
    // too. A rocket every 20 tics at 20 units a tic.
    //
    // Drawn with the flamethrower artwork recoloured to black metal.
    "Rocket Launcher": {
        name: "Rocket Launcher",
        dice: [20, 8],
        damage: () => diceAverage([20, 8]),
        splashDamage: 128,
        fireRate: doomTics(20),
        bulletSpeed: doomSpeed(20),
        spread: 0,
        numPellets: 1,
        color: '#FF6347',
        singleShot: false,
        ammoType: 'rockets',
        ammoPerShot: 1,
        ammo: 0,
        maxAmmo: AMMO_TYPES.rockets.max,
        pickupAmmo: 2,          // A found launcher holds two rockets
        aoeRadius: 128 * DOOM_PX,
        bulletRadius: 11 * DOOM_PX,     // MT_ROCKET
        explosionDuration: 30,
        isRocket: true,
        muzzleFlash: { color: [255, 190, 120], size: 28, frames: 6, light: 0.9, lightRange: TILE_SIZE * 5 },
        spriteWeapon: 'flamethrower_black',
        icon: 'rocketlauncher',
        ammoIcon: 'ammo_rocket'
    },

    // PLASMA GUN - 5-40 a bolt, a bolt every 3 tics at 25 units a tic.
    //
    // Drawn with the flamethrower artwork recoloured blue.
    "Plasma Gun": {
        name: "Plasma Gun",
        dice: [5, 8],
        damage: () => diceAverage([5, 8]),
        fireRate: doomTics(3),
        bulletSpeed: doomSpeed(25),
        spread: 0,
        numPellets: 1,
        color: '#4AA8FF',
        singleShot: false,
        ammoType: 'cells',
        ammoPerShot: 1,
        ammo: 0,
        maxAmmo: AMMO_TYPES.cells.max,
        pickupAmmo: 40,         // A found plasma gun holds forty cells
        bulletRadius: 13 * DOOM_PX,     // MT_PLASMA
        muzzleFlash: { color: [110, 180, 255], size: 15, frames: 3, light: 0.5, lightRange: TILE_SIZE * 3 },
        spriteWeapon: 'flamethrower_blue',
        icon: 'plasmagun',
        ammoIcon: 'ammo_plasma'
    },

    // BFG - the BFG9000. The ball does 100-800 to what it hits; when it
    // bursts, forty rays of 15-120 fan out over 90 degrees from where the
    // shooter stands, in the direction they face (A_BFGSpray). Sixty tics a
    // shot, forty cells a shot.
    //
    // Drawn with the flamethrower artwork recoloured glowing green.
    "BFG": {
        name: "BFG",
        dice: [100, 8],
        damage: () => diceAverage([100, 8]),
        tracerDice: [15, 8],
        tracerDamage: () => diceAverage([15, 8]),
        tracerCount: 40,
        tracerConeDegrees: 90,
        fireRate: doomTics(60),
        bulletSpeed: doomSpeed(25),
        spread: 0,
        numPellets: 1,
        color: '#00FF00',
        singleShot: false,
        ammoType: 'cells',
        ammoPerShot: 40,
        ammo: 0,
        maxAmmo: AMMO_TYPES.cells.max,
        pickupAmmo: 40,         // A found BFG holds one shot
        bulletRadius: 13 * DOOM_PX,     // MT_BFG; the draw adds a glow half again as wide
        isBFG: true,
        muzzleFlash: { color: [120, 255, 140], size: 36, frames: 12, light: 1.0, lightRange: TILE_SIZE * 6 },
        spriteWeapon: 'flamethrower_green',
        icon: 'bfg',
        ammoIcon: 'ammo_bfg'
    }
};

/**
 * How big a pickup is drawn, and the radius it is picked up at.
 *
 * `weight` is the geometric mean of the drawn width and height, in pixels --
 * "how much of the floor this thing covers" -- rather than a flat width,
 * because the icons are wildly different shapes and sizing them all by their
 * longest side left the flat ones (a pistol magazine, a rifle clip) reading
 * as slivers beside the upright ones. `max` caps the longest side so a long
 * thin object cannot stretch out of proportion. See iconDrawSize().
 *
 * The weights are a little larger than life so an item still reads on a dark
 * floor, but no bigger than the marine, who is 20px across. A pickup's
 * collision radius is half its weight, so what you see is roughly what you
 * walk onto; the player's own radius adds the forgiveness.
 */
export const ITEM_DRAW_SIZE = {
    health:   { weight: 17.5, max: 20 },
    ammoClip: { weight: 13,   max: 20 },
    ammoBox:  { weight: 16,   max: 24 },
    weapon:   { weight: 17,   max: 28 },
};

// =============================================================================
// DIFFICULTY SYSTEM CONFIGURATION
// =============================================================================

/**
 * Difficulty, the way Doom's skill levels did it.
 *
 * Doom never made a monster tougher, faster or harder-hitting for a higher
 * skill. A skill decided how many monsters the map placed -- each thing was
 * flagged for the skills it appeared on, and E1M1 has 10 monsters on the two
 * easy skills, 17 on Hurt Me Plenty and 24 on Ultra-Violence -- and on the
 * easiest, "I'm Too Young To Die", the player took half damage and found
 * double ammo. Nothing else changed, so an Imp was always an Imp and the
 * player's skill was the variable.
 *
 * The three settings here map onto that: Easy is I'm Too Young To Die, Medium
 * is Hurt Me Plenty, Hard is Ultra-Violence. Multipliers on the player and on
 * the monsters' own numbers are all 1; the `monsterCount` ratio is E1M1's.
 *
 * @param {string} difficulty - "easy", "medium", or "hard"
 * @returns {Object} Multiplier values for different game aspects
 */
export function getDifficultyMultipliers(difficulty) {
    const multipliers = {
        // EASY: I'm Too Young To Die. Half damage to the player, fewer monsters.
        easy: {
            playerHealth: 1.0,
            playerDamage: 1.0,
            monsterDamage: 1.0,      // The monsters hit as hard as ever...
            damageTaken: 0.5,        // ...and the player feels half of it
            monsterCount: 0.6,       // 10 of E1M1's 17
        },

        // HARD: Ultra-Violence. Every monster the map has room for.
        hard: {
            playerHealth: 1.0,
            playerDamage: 1.0,
            monsterDamage: 1.0,
            damageTaken: 1.0,
            monsterCount: 1.4,       // 24 of E1M1's 17
        },

        // MEDIUM: Hurt Me Plenty. The numbers as they are.
        medium: {
            playerHealth: 1.0,
            playerDamage: 1.0,
            monsterDamage: 1.0,
            damageTaken: 1.0,
            monsterCount: 1.0,
        }
    };

    // Return requested difficulty or default to medium
    return multipliers[difficulty] || multipliers.medium;
}

// =============================================================================
// VISUAL STYLING CONFIGURATION
// =============================================================================

/**
 * Level themes: how a level looks, and what is lying about on its floor.
 *
 * Each entry is a complete environment -- wall masonry, floor, and the liquids
 * that pool in its rooms -- and levels cycle through them, so progression is a
 * tour of visibly different places rather than the same corridor recoloured.
 *
 * Wall colours
 * ------------
 * A wall is not drawn as a flat square with a border any more (see drawWallTile in
 * js/main.js): each block is shaded according to which of its sides face open
 * ground, so a run of wall reads as one continuous mass with a lit edge along it
 * and corner pieces where it turns. That needs four related tones rather than one:
 *
 *   face   -- the body of the block, seen from above
 *   cap    -- the bright edge along a side that fronts open ground
 *   shade  -- the dark line inboard of the cap, and the block's own shadow
 *   mortar -- the seams of the masonry pattern running across the whole run
 *   trim   -- accent used on corner pieces, so turns are legible in the dark
 *
 * `fillColor` and `borderColor` are kept as the flat-shaded equivalents; the
 * minimap and any caller that just wants "what colour is this wall" reads those.
 *
 * Masonry
 * -------
 * `masonry.kind` selects the surface pattern, and every pattern is laid out in
 * WORLD coordinates rather than per tile. That is the whole point of it: bricks
 * that restart at each tile boundary draw a 40px grid over the level and undo the
 * continuous run the edge shading just built.
 *
 * Terrain
 * -------
 * `terrain.chance` is the probability that an eligible room gets a pool, and
 * `terrain.weights` the relative likelihood of each liquid when one is placed. A
 * weight of zero means that liquid never appears in this theme, which is what
 * keeps a flooded cistern free of lava.
 */
export const WALL_STYLES = [
    {
        name: "Industrial Metal",
        fillColor: '#787A7C',      // Flat-shaded equivalent, for the minimap
        borderColor: '#555759',
        wall: {
            face:   '#6E7174',
            cap:    '#9DA2A6',
            shade:  '#3B3D3F',
            mortar: '#4A4D50',
            trim:   '#B8BDC2',
        },
        masonry: { kind: 'plate', unit: 40, course: 20, rivets: true },
        // Floors were previously never drawn at all -- the bare canvas clear colour
        // showed through -- so there was nothing for the fog-of-war memory pass to
        // dim. The two shades alternate on a checker to give the floor some texture
        // at low brightness.
        floorColor: '#44474B',
        floorAltColor: '#3D4044',
        grout: '#33363A',          // Seam drawn between floor plates
        terrain: {
            chance: 0.30,
            weights: { [TILE_LAVA]: 0, [TILE_TOXIC]: 3, [TILE_WATER]: 2 },
        },
    },
    {
        name: "Ancient Stone",
        fillColor: '#6F6659',
        borderColor: '#504A40',
        wall: {
            face:   '#6A6053',
            cap:    '#948977',
            shade:  '#37322B',
            mortar: '#443E35',
            trim:   '#A99C86',
        },
        masonry: { kind: 'brick', unit: 20, course: 13, rivets: false },
        floorColor: '#454036',
        floorAltColor: '#3E3A31',
        grout: '#302C25',
        terrain: {
            chance: 0.26,
            weights: { [TILE_LAVA]: 0, [TILE_TOXIC]: 1, [TILE_WATER]: 4 },
        },
    },
    {
        name: "Volcanic Foundry",
        fillColor: '#4A3A34',
        borderColor: '#2A211D',
        wall: {
            face:   '#463732',
            cap:    '#7A5B48',
            shade:  '#1E1613',
            mortar: '#2C211C',
            trim:   '#8A6A54',     // Warmer than the cap, but not an accent colour
        },
        masonry: { kind: 'block', unit: 40, course: 20, rivets: false },
        floorColor: '#332723',
        floorAltColor: '#2C221F',
        grout: '#1F1815',
        terrain: {
            chance: 0.62,
            weights: { [TILE_LAVA]: 6, [TILE_TOXIC]: 1, [TILE_WATER]: 0 },
        },
    },
    {
        name: "Toxic Refinery",
        fillColor: '#5A6154',
        borderColor: '#3A4036',
        wall: {
            face:   '#555C4F',
            cap:    '#8A937E',
            shade:  '#2B302A',
            mortar: '#3A4036',
            trim:   '#96A382',     // Barely greener than the cap, on purpose
        },
        masonry: { kind: 'plate', unit: 40, course: 13, rivets: true },
        floorColor: '#3B4038',
        floorAltColor: '#343933',
        grout: '#282C26',
        terrain: {
            chance: 0.58,
            weights: { [TILE_LAVA]: 0, [TILE_TOXIC]: 6, [TILE_WATER]: 2 },
        },
    },
    {
        name: "Flooded Cistern",
        fillColor: '#556069',
        borderColor: '#333C44',
        wall: {
            face:   '#4F5A63',
            cap:    '#7E8C97',
            shade:  '#242C33',
            mortar: '#333C44',
            trim:   '#93A6B4',
        },
        masonry: { kind: 'brick', unit: 26, course: 13, rivets: false },
        floorColor: '#333C43',
        floorAltColor: '#2D353B',
        grout: '#232A30',
        terrain: {
            chance: 0.66,
            weights: { [TILE_LAVA]: 0, [TILE_TOXIC]: 1, [TILE_WATER]: 7 },
        },
    },
];

// Export wallStyles as an alias for backward compatibility
export const wallStyles = WALL_STYLES;

/**
 * Door and key colours, keyed by tile.
 *
 * A door and its key are drawn from the same family on purpose: the thing that
 * makes a locked door readable at a glance in a dark corridor is recognising the
 * colour you are already carrying. Five tones each, because both are drawn as
 * built objects rather than as coloured squares --
 *
 *   body  -- the leaf, or the key's shaft and bow
 *   panel -- the raised panel inset into the leaf
 *   edge  -- the outline and the shadow inside every recess
 *   trim  -- studs, chevrons and the highlight along a lit edge
 *   lamp  -- "r,g,b" for the status light and the glow pool, which are additive
 */
export const DOOR_STYLES = {
    [TILE_DOOR_RED]: {
        body: '#8E211B', panel: '#B32B22', edge: '#3E0D0A',
        trim: '#E8564A', lamp: '255,90,70',
    },
    [TILE_DOOR_YELLOW]: {
        body: '#9A7413', panel: '#C99A1B', edge: '#463305',
        trim: '#F2C63F', lamp: '255,205,80',
    },
    [TILE_DOOR_BLUE]: {
        body: '#26429A', panel: '#3459BE', edge: '#0D1A45',
        trim: '#6C95F0', lamp: '110,160,255',
    },
};

/** Which key opens which door. Used to draw the two in matching colours. */
export const KEY_STYLES = {
    [TILE_KEY_RED]: {
        body: '#D84435', shine: '#FFB1A4', edge: '#4A0F0A', glow: '255,90,70',
    },
    [TILE_KEY_YELLOW]: {
        body: '#EABE36', shine: '#FFF0A8', edge: '#4B3906', glow: '255,210,90',
    },
    [TILE_KEY_BLUE]: {
        body: '#4478DE', shine: '#BBD5FF', edge: '#101F4E', glow: '110,160,255',
    },
};

/**
 * The level exit.
 *
 * Sealed and open are genuinely different objects rather than one object with a
 * letter swapped on it: a sealed exit is barred and lit red, an open one is an
 * empty frame with a green light over it and chevrons pointing into it.
 */
export const EXIT_STYLE = {
    frame: '#2A2233',
    frameEdge: '#544868',
    threshold: '#161020',
    open: { light: '#4CE08A', glow: '80,255,150' },
    sealed: { light: '#E0473C', glow: '255,80,70', bar: '#8A2F27' },
};

// =============================================================================
// MINIMAP CONFIGURATION
// =============================================================================

/**
 * The overview map drawn in the top-left corner.
 *
 * It shows only what the player has actually seen -- it is drawn straight from
 * the lighting module's `exploredMap`, the same record that decides which
 * geometry is redrawn dimly on screen -- so it fills in as the level is explored
 * rather than handing over the layout up front.
 *
 * Kept small and quiet on purpose. This is a thing to glance at, not a second
 * screen: a panel that competes with the world for attention would undo the point
 * of a game played by torchlight.
 */
export const MINIMAP = {
    SCALE: 3,                        // Screen pixels per world tile
    MARGIN_X: 15,                    // Distance from the left edge
    MARGIN_Y: 44,                    // Clears the "Level: N" readout above it
    PADDING: 4,                      // Inset between the frame and the map

    BACKDROP: 'rgba(8,10,14,0.42)',  // Panel fill, dark enough to read against
    BORDER: 'rgba(160,170,190,0.35)',
    OPACITY: 0.78,                   // Applied to the map itself, not the frame

    // Tile colours. Deliberately not the wall style's: at three pixels a tile the
    // in-world palette is mud, and doors have to be told apart at a glance.
    FLOOR: '#3C4450',               // Must read as explored against the black void
    WALL: '#8D96A5',
    SECRET_DOOR: '#8D96A5',          // Indistinguishable from wall until opened
    DOOR_RED: '#D0473F',
    DOOR_YELLOW: '#D8B23A',
    DOOR_BLUE: '#4A7FD0',
    EXIT: '#3FD07A',
    ITEM: '#C8B268',                 // Keys, weapons and health, undifferentiated
    PROP: '#5C6470',                 // Crates, pillars and the like: an obstacle, not a wall
    SWITCH: '#D8B23A',               // A switch, once seen: something to come back for

    // Terrain. Bright enough to plan a route around at three pixels a tile --
    // knowing where the lava is before you walk into it is most of what the
    // minimap is for on a volcanic level.
    LAVA: '#C4501C',
    TOXIC: '#7FA82C',
    WATER: '#31607F',

    PLAYER: '#FF4136',
    PLAYER_RADIUS: 2,                // In screen pixels
};

// =============================================================================
// AUDIO SYSTEM CONFIGURATION
// =============================================================================

/**
 * Audio cooldown timers to prevent sound overlap
 * These prevent audio spam and improve performance
 */
export const AUDIO_COOLDOWNS = {
    HIT_SOUND_COOLDOWN: 50,           // Milliseconds between hit sounds
    ENEMY_DESTROY_SOUND_COOLDOWN: 100 // Milliseconds between destroy sounds
};

// =============================================================================
// PERFORMANCE AND TIMING CONFIGURATION
// =============================================================================

/**
 * Frame rate and animation timing constants
 * Used for consistent animation speeds across different devices
 */
export const ANIMATION_CONFIG = {
    TARGET_FPS: 60,              // Target frames per second
    ANIMATION_FRAME_DURATION: 8, // Frames per animation step
    BULLET_LIFETIME_FRAMES: 120, // How long bullets exist
    EXPLOSION_DURATION_FRAMES: 30 // How long explosions last
};

/**
 * Game balance constants
 * These values affect gameplay difficulty and progression
 */
export const GAME_BALANCE = {
    BASE_PLAYER_HEALTH: 100,     // Starting player health
    HEALTH_PACK_VALUE: 25,       // Health restored per health pack
    SECRET_DOOR_POINTS: 25,      // Points awarded for finding secret doors
    KEY_PICKUP_POINTS: 50,       // Points awarded for collecting keys
    
    // Enemy point values: see the `score` field of each entry in
    // js/monsters.js, which is where the roster and its numbers live.
    ENEMY_KILL_POINTS: {
        zombieman: 100,
        shotgun_guy: 150,
        imp: 120,
        demon: 200,
        spectre: 250,
        lost_soul: 100,
        cacodemon: 300,
        baron: 1000,
        chaingunner: 250,
        hell_knight: 600,
        revenant: 400,
        mancubus: 500,
        arachnotron: 500,
        pain_elemental: 400,
        archvile: 1500,
        ss: 150,
        cyberdemon: 2500,
        spider_mastermind: 2500
    }
};