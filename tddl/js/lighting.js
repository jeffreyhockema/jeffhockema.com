/**
 * LIGHTING AND VISIBILITY MODULE
 *
 * Owns everything about what the player can currently see and what they remember
 * having seen. Replaces the previous split-brain arrangement where a coarse tile
 * raycast decided what was *revealed* while a completely separate pixel gradient
 * decided what *looked* lit -- the two used different radii and different falloff,
 * so items sat invisible inside an area that plainly looked illuminated.
 *
 * Model
 * -----
 * The world is lit by a list of LIGHT SOURCES. Everything -- the player's
 * flashlight, the glow around them, and later any lamp carried by an enemy or
 * dropped as an item -- is just an entry in that list. Nothing in this module is
 * specific to the player beyond `createPlayerLights()`.
 *
 * Each source is resolved into a SHADOW POLYGON by casting rays outward until they
 * hit an opaque tile. That single polygon drives both outputs, which is what keeps
 * them consistent:
 *
 *   1. `lightMap`  -- per-tile illumination 0..1, used for gameplay queries.
 *   2. The rendered light mask in main.js, filled from the same polygon.
 *
 * Because both come from one computation, anything that looks lit is revealed, and
 * anything in shadow is not.
 *
 * Sight without light
 * -------------------
 * Light is not the only way to know something is there. A VISION SOURCE is a second
 * list, resolved by exactly the same shadow casting -- you cannot make out what is
 * round a corner any more than you can light it -- but accumulated into `visionMap`
 * rather than `lightMap`. The player carries one: a wide arc in front of them over
 * which shapes register as silhouettes without being illuminated.
 *
 * The two grids stay strictly separate. Everything that asks how bright a place is
 * reads `lightMap` and gets an honest answer for ground that is merely sensed:
 * zero. The renderer composites the vision arc as a dim, colourless wash underneath
 * the lit world, so being sensed never looks like being lit.
 *
 * Memory
 * ------
 * `exploredMap` records the peak of BOTH each tile has ever received. Static
 * geometry (floors, walls, doors) is redrawn dimly from this memory once the light
 * moves away, and the minimap is drawn from it directly. Sensed ground counts: you
 * do not forget that a corridor turned left because you never shone the torch down
 * it. Dynamic things -- enemies, items, pickups -- are deliberately NOT remembered:
 * they are drawn only where there is live light or live peripheral vision.
 *
 * @author TDDL Game Team
 */

import {
    MUZZLE_LIGHT_STOPS,
    TILE_SIZE, MAP_COLS, MAP_ROWS,
    TILE_WALL, TILE_DOOR_RED, TILE_DOOR_YELLOW, TILE_DOOR_BLUE, TILE_SECRET_DOOR,
    TERRAIN, TILE_SLIDE, TILE_SWITCH,
} from './constants.js';
import { isGlowingTerrain } from './terrain.js';
import { DOORS, getDoors, isDoorOpen, isKeyedDoorTile } from './doors.js';
import { collectDecorLights } from './decor.js';
import { SWITCHES, getSlides, isSlideOpen } from './switches.js';
import { hasSectors, updateSectors, ambientForTile } from './sectors.js';

// =============================================================================
// TUNING
// =============================================================================

/**
 * All lighting tunables in one place.
 *
 * The flashlight cone angle and the glow radius were carried over from the
 * previous implementation because that shape was the part that already looked
 * right; only the semantics around them changed.
 */
export const LIGHTING = {
    // --- Player flashlight (cone) ---
    FLASHLIGHT_RANGE: TILE_SIZE * 10,      // How far the beam reaches
    FLASHLIGHT_HALF_ANGLE: Math.PI / 3,    // 60 deg either side = 120 deg beam
    FLASHLIGHT_INTENSITY: 1.0,

    // --- Player glow (omnidirectional) ---
    GLOW_RADIUS: TILE_SIZE * 3,            // Close-quarters awareness bubble
    GLOW_INTENSITY: 0.95,

    // --- Peripheral vision (a sense, not a light) ---
    // A wide arc in front of the player over which shapes REGISTER without being
    // lit. Eyes do not stop working at the edge of a torch beam: you know the
    // corridor turns and that something is moving off to your left long before the
    // beam swings round to show you what colour it is.
    //
    // Cast by exactly the same machinery as a light -- a cone source resolved into
    // a shadow polygon -- but accumulated into `visionMap` instead of `lightMap`,
    // so nothing downstream can mistake being sensed for being illuminated.
    // Rendering keeps them apart too: sensed geometry is composited as a dim,
    // colourless wash under the lit world (see the sense pass in main.js).
    PERIPHERAL_HALF_ANGLE: Math.PI / 2,    // 90 deg either side = a 180 deg arc
    PERIPHERAL_RANGE: TILE_SIZE * 13,      // Reaches past the beam, which stops at 10

    // Deliberately low. This is the alpha the sensed world is composited at, so it
    // sets how much of a silhouette you get: high enough to make out a doorway or a
    // moving shape, far too low to read as light.
    PERIPHERAL_INTENSITY: 0.34,

    // Softer rim than the flashlight. A beam has an edge; the limit of what you can
    // make out does not, so the arc fades away over its outer third rather than
    // stopping -- a hard cut at 90 degrees would draw a straight line across the
    // screen through the player, which is exactly what vision does not look like.
    //
    // The cost is that the arc is only at full strength out to about 58 degrees
    // either side. Raising this widens the fade and narrows that core; lowering it
    // sharpens the arc's edge back towards a visible boundary.
    PERIPHERAL_RIM_SOFTNESS: 0.35,

    // Vision needs no penumbra: it is a flat dim wash, so the gradations a
    // multi-origin cast buys would be invisible, and each extra origin is a whole
    // set of rays plus a whole polygon fill. One origin, cast coarsely.
    PERIPHERAL_ORIGINS: 1,
    PERIPHERAL_ARC_DEGREES: 1.5,

    // Much less overshoot than a light needs. CONE_CAST_MARGIN exists so a wall
    // fades in while it is still dark rather than snapping on, and 30 degrees of it
    // suits the flashlight -- but the arc's own rim has faded to nothing by 90
    // degrees already, so everything the margin admits past that contributes
    // exactly zero while still being cast, filtered and given a wall pass. Since
    // that pass is the frame's single largest cost, and the arc is by far the
    // widest source in it, the tiles saved are worth more here than anywhere else.
    //
    // Enough is left to cover the tile and a half between a wall and the open
    // ground its lighting is decided from, which at this range is under 7 degrees.
    PERIPHERAL_CAST_MARGIN: Math.PI / 12,  // 15 degrees each side

    // Blur on the arc's own coverage. A full-surface blur is the most expensive
    // single operation in a frame and there is one per source, so this is the
    // cheapest thing there is to give up -- and the arc gives up least by it: its
    // shadow edges sit under a wash at PERIPHERAL_INTENSITY, where the few pixels
    // of penumbra that matter on a lit floor are not visible at all.
    PERIPHERAL_EDGE_SOFTNESS_PX: 0,

    // Light needed for something to be made out by peripheral vision alone. Lower
    // than REVEAL_THRESHOLD because the whole arc is dimmer: applying the light
    // threshold to it would cut the outer half of the arc off entirely.
    SENSE_THRESHOLD: 0.02,

    // --- Sight (which lit things the player can actually see) ---
    // A lava pool lights the room it is in; whether the PLAYER sees that room
    // lit is a different question, and it used to have the wrong answer. The
    // pool's light polygon is cast from the pool, so a pool next door lit the
    // walls of its own room, the light mask let them through, memory recorded
    // them and the minimap drew the room -- all without the player ever having
    // had a line of sight to any of it. A glowing room announced itself
    // through the wall.
    //
    // Sight is the fix: a line-of-sight polygon cast from the player, and every
    // light flagged `gated` (all terrain glow) counts only where it overlaps.
    // Light you cannot see falling on ground you cannot see is not seen.
    //
    // Cast ALL ROUND, not as a cone. It began as a half-circle facing the way the
    // player was aimed, on the reasoning that eyes have a front -- but that made a
    // lit room close the moment the player turned their back on it, and open again
    // when they looked round. A pool of lava is a fixed feature of a level, and it
    // reads as one: you walk past it down a corridor and it stays lit behind you,
    // and you can still see what is moving about in it. Tying it to the aim made it
    // behave like a second torch instead.
    //
    // What still gates it is geometry, which is the part that matters: the polygon
    // is occluded exactly like a light's, so a lit room on the far side of a wall
    // stays hidden until there is a line to it. Turn a corner and it closes -- not
    // because of where the player is looking, but because rock is in the way.
    //
    // Long, because a glow at the end of a corridor is visible from the far end of
    // it -- 26 tiles covers the whole viewport at any zoom the game allows. Flat,
    // because sight has no rim: a lit thing is either in view or it is not. One
    // origin, coarse rays: it is a stencil, and nothing graded is asked of it.
    SIGHT_RANGE: TILE_SIZE * 26,
    SIGHT_ARC_DEGREES: 1.5,
    SIGHT_MIN: 0.01,                       // Coverage below this is out of sight

    // --- Shadow casting ---
    // Rays sit on a fixed grid of directions that divides the full circle exactly
    // (see castLightPolygon), so the resolution here is "per full turn": a cone
    // casts only the part of the grid it spans. MIN/MAX_RAYS bound the size of
    // that grid, not the count a single cone ends up with.
    RAY_ARC_DEGREES: 0.75,                 // Angular resolution of the shadow edge
    MIN_RAYS: 24,
    MAX_RAYS: 512,

    // --- Light size ---
    // A light is not a mathematical point. Cast from one, a wall corner cuts the
    // beam with zero tolerance: ground a hair past the corner is fully lit, ground a
    // hair before it is fully black, and stepping sideways swings whole tiles in and
    // out at once. Real lamps have width, so a corner throws a PENUMBRA -- ground
    // only part of the lamp can see comes out part lit.
    //
    // Modelled by casting the light from several origins spread over a small disc and
    // averaging their coverage. LIGHT_ORIGINS sets how many gradations the penumbra
    // has; too few and it bands, and every origin costs a full set of rays.
    LIGHT_RADIUS: TILE_SIZE * 0.2,
    LIGHT_ORIGINS: 5,                      // centre plus a ring of four

    // --- Memory ---
    // How strongly this frame's light is written into the record of what has been
    // seen. Memory keeps a maximum, so without a gain an area only ever glimpsed at
    // the dim edge of the beam is remembered just as faintly and is effectively
    // invisible. Boosting before the maximum is taken keeps it idempotent: the value
    // written for an unchanged view is identical every frame.
    MEMORY_GAIN: 8,

    // The same, for what peripheral vision made out. Far lower, and that gap is
    // the whole difference between having looked at something and having glanced
    // past it: at the full gain a wall the player merely sensed came back exactly
    // as solid as one they had put the torch on, so a yellow door glimpsed across
    // a dark room was redrawn in full colour from memory -- underneath the very
    // wash that exists to take its colour away.
    //
    // Two, against the arc's peak alpha of PERIPHERAL_INTENSITY, lands sensed
    // ground at roughly two thirds of remembered brightness and lets it fade out
    // towards the edge of the arc instead of saturating flat.
    MEMORY_SENSE_GAIN: 2,

    // How bright remembered geometry is drawn. Floors are dark to begin with, so a
    // low value here leaves explored areas indistinguishable from unexplored black
    // and the map you have walked stops being readable.
    MEMORY_BRIGHTNESS: 0.45,
    MEMORY_MIN_LIGHT: 0.06,                // Light below this doesn't count as "seen"

    // --- Gameplay gating ---
    REVEAL_THRESHOLD: 0.05,                // Light needed for an item/enemy to show

    // --- Cone shape ---
    // Fraction of the beam's half-angle over which it fades out towards the rim.
    // Without this the cone is uniformly bright right up to a hard angular cut, so
    // every wall tile across the beam takes the same value and the lit strip reads
    // as a row of flat blocks rather than a beam.
    CONE_RIM_SOFTNESS: 0.4,

    // Extra arc, beyond the visible beam, over which a cone still casts rays.
    //
    // Whether a wall is lit is decided from the OPEN tile beside it, but how bright
    // it is gets evaluated at the wall itself -- and those can be a tile and a half
    // apart. With the cast stopping at the beam's edge, a wall could already be well
    // inside the beam while its neighbour was still outside, so it stayed black and
    // then snapped straight to a visible brightness the instant the neighbour
    // crossed in. Casting wider lets that decision happen while the wall is still
    // dark, and the conic profile (which uses the true half-angle) fades it in.
    CONE_CAST_MARGIN: Math.PI / 6,         // 30 degrees each side
                                           // (per-source: light.castMargin)

    // --- Wall faces ---
    // A wall is lit at its exposed FACE -- the side of the block that fronts ground
    // the player could stand on -- and each face is asked the same question a floor
    // tile is: can this source see the ground just in front of it, and how brightly.
    //
    // That single rule is what gives walls their sidedness for free. Two rooms
    // separated by a two-block wall have one block fronting each room, and a lamp in
    // one room can only see its own block's face; the far one is behind solid rock
    // and stays dark. A spur jutting into a room has a face on either side, and
    // which of them lights up is decided by which one the lamp can see -- including
    // the case where it reaches round the end of the spur and genuinely lights both.
    //
    // How far out in front of the face the light is measured, in world pixels. Not
    // flush against the surface: rays stop exactly on a wall's near face, so a
    // sample taken there sits on the boundary of its own occluder and comes and goes
    // with rounding. A little way into the open ground is unambiguous.
    WALL_FACE_SAMPLE_PX: 6,

    // How many points along each tile of a face are measured to shade it. The face
    // is shaded by a gradient run between them, which is what lets a pillar throw
    // its shadow ACROSS a wall instead of the wall switching on and off as a unit.
    // Four is roughly the resolution EDGE_SOFTNESS_PX blurs the floor to, so the two
    // agree where they meet.
    WALL_FACE_SAMPLES_PER_TILE: 4,


    // --- Edge softness ---
    // Blur applied to the light mask, in screen pixels. Shadow boundaries are
    // geometrically exact, which on its own reads as a hard-cut stencil -- the beam
    // ends in a crisp triangle. A few pixels of blur give the edge a penumbra
    // without reintroducing any stepping. Set to 0 for hard-edged light.
    //
    // Kept small because the cost is paid on SHALLOW edges. A shadow thrown by a
    // corner a couple of tiles away crosses a tile at a glancing angle, and a
    // penumbra measured across the edge stretches by 1/sin of it -- at 18 degrees,
    // ten pixels of blur smear over thirty, and the shadow stops reading as an edge
    // at all. The beam's own rim does not depend on this: that is a conic gradient,
    // applied separately (see applyAngularFalloff).
    EDGE_SOFTNESS_PX: 4,

    // --- Terrain glow ---
    // Lava and toxic waste light the room they are in. They are ordinary entries in
    // the light list -- shadow casting, wall faces, memory and the minimap all pick
    // them up with no special cases -- which is the whole reason a lava lake casts
    // the pillar's shadow across the floor properly instead of glowing through it.
    //
    // The cost of that is real, though: every source is a full ray cast plus its own
    // pass over the mask, and a volcanic level can have two hundred glowing tiles.
    // The budget below is what keeps a frame affordable.

    // How many terrain lights may burn at once. The single most important number
    // here for performance; each one costs roughly what a third of the flashlight
    // does. Lower it first if frames get expensive on lava levels.
    // A safety valve, not a budget. Generated levels carry at most about fifteen
    // emitters in total, so in practice every one of them within sight is lit and
    // this never bites -- which is the point. A cap that bites is a cap that
    // decides, each frame, which pools are lit from where the player happens to be
    // standing, and a pool is a fixture of the level: it should light the same
    // ground whoever is looking and from wherever.
    //
    // There used to be a per-pool cap as well, of two. It meant a lake lit only the
    // stretch of itself nearest your feet, and that bright patch slid along with you
    // as you walked past -- the far end of the same lake sitting dark. Lighting the
    // whole of every pool costs a ray cast apiece, which measured at a fraction of
    // a millisecond for a whole level's worth.
    HAZARD_LIGHT_MAX: 16,

    // Minimum spacing between emitters within a pool, in tiles. A lake is not lit
    // from its centre -- that would leave a long channel glowing only in the middle
    // -- but from points spread along it at this interval.
    HAZARD_EMITTER_SPACING: 3,

    // How far from the player an emitter is still considered.
    //
    // Exactly the sight range, and not a number of its own. Terrain glow is gated
    // through the sightline, so a pool beyond that range contributes nothing
    // whatever it does -- culling there is free by construction, and culling any
    // NEARER puts a second, invisible edge in front of the first, which is what
    // used to make a pool wink out while it was still plainly in view.
    HAZARD_LIGHT_CULL: TILE_SIZE * 26,        // keep in step with SIGHT_RANGE

    // Terrain lights are cast coarsely and from a single origin. They are small,
    // dim and numerous, and everything the extra fidelity buys -- a graded penumbra
    // at a shadow's edge -- is invisible under a glow this faint.
    HAZARD_LIGHT_ORIGINS: 1,
    HAZARD_LIGHT_ARC_DEGREES: 3,
    // Deliberately the same as EDGE_SOFTNESS_PX rather than a value of its own.
    // Sources that share a softness share a rendering pass, and pools are the one
    // thing a level has many of at once -- a lava room with its own value would pay
    // a whole extra blur over the screen to look three pixels crisper than the
    // player's glow, which nobody can see.
    HAZARD_LIGHT_SOFTNESS_PX: 4,
};

// =============================================================================
// INTERNAL STATE
// =============================================================================

/** Per-tile current illumination, 0..1. Indexed [row][col]. */
let lightMap = null;

/** Per-tile peak illumination ever received, 0..1. Indexed [row][col]. */
let exploredMap = null;

/**
 * Per-tile line of sight from the player this frame, 0..1. Indexed [row][col].
 * The gate every terrain light is multiplied through; see LIGHTING.SIGHT_*.
 */
let sightMap = null;

/** The sight polygon cast this frame, or null without a player. */
let activeSightPolygon = null;

/**
 * Per-tile peripheral awareness, 0..1. Indexed [row][col].
 *
 * Deliberately a separate grid from `lightMap` rather than a boost to it. Anything
 * that asks "is this lit?" -- brightness, the reveal threshold, the memory fold's
 * notion of how brightly a place was seen -- must keep answering no for ground the
 * player has merely sensed, or peripheral vision becomes a second, worse torch.
 */
let visionMap = null;

/** Shadow polygons produced by the most recent update, consumed by the renderer. */
let activePolygons = [];

/** Peripheral-vision polygons from the most recent update. */
let activeVisionPolygons = [];

/**
 * Bumped every time lighting memory is cleared. The renderer keeps a persistent
 * world-space surface recording where light has fallen; watching this counter is
 * how it knows to throw that surface away and start the new level in the dark,
 * without lighting needing to know the renderer exists.
 */
let generation = 0;

function makeGrid(fill) {
    return Array.from({ length: MAP_ROWS }, () => new Float32Array(MAP_COLS).fill(fill));
}

function ensureGrids() {
    if (!lightMap) lightMap = makeGrid(0);
    if (!exploredMap) exploredMap = makeGrid(0);
    if (!visionMap) visionMap = makeGrid(0);
    if (!sightMap) sightMap = makeGrid(0);
}

/**
 * Clears all lighting memory. Call when a new level starts.
 */
export function resetLighting() {
    faceIndexMap = null;
    faceIndexSignature = '';
    lightMap = makeGrid(0);
    exploredMap = makeGrid(0);
    visionMap = makeGrid(0);
    sightMap = makeGrid(0);
    activePolygons = [];
    activeVisionPolygons = [];
    activeSightPolygon = null;
    hazardEmitters = [];
    hazardEmitterMap = null;
    generation++;

    publishGlobals();
}

/**
 * Counter identifying the current lighting epoch. Changes whenever memory is
 * cleared, so consumers can discard anything they cached about it.
 *
 * @returns {number} Current generation
 */
export function getLightingGeneration() {
    return generation;
}

/**
 * Mirrors the grids onto `window` for the few call sites that still reach through
 * the global. Guarded so the module can also be imported outside a browser (the
 * test suites drive it directly in Node).
 */
function publishGlobals() {
    if (typeof window === 'undefined') return;
    window.lightMap = lightMap;
    window.exploredMap = exploredMap;
    window.visionMap = visionMap;
}

/**
 * @returns {Array<Float32Array>} Per-tile current light, indexed [row][col]
 */
export function getLightMap() {
    ensureGrids();
    return lightMap;
}

/**
 * @returns {Array<Float32Array>} Per-tile remembered light, indexed [row][col]
 */
export function getExploredMap() {
    ensureGrids();
    return exploredMap;
}

/**
 * @returns {Array<Float32Array>} Per-tile peripheral awareness, indexed [row][col]
 */
export function getVisionMap() {
    ensureGrids();
    return visionMap;
}

/**
 * Shadow polygons from the last update, for the renderer to fill.
 * @returns {Array<Object>} One entry per light source
 */
export function getActivePolygons() {
    return activePolygons;
}

/**
 * @returns {Object|null} The player's sight polygon cast this frame
 */
export function getSightPolygon() {
    return activeSightPolygon;
}

/**
 * @returns {Array<Float32Array>|null} Per-tile line of sight this frame
 */
export function getSightMap() {
    ensureGrids();
    return sightMap;
}

/**
 * Whether the player has a line of sight to a tile this frame.
 *
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {boolean} True if in sight
 */
export function isTileInSight(tileX, tileY) {
    if (!sightMap) return false;
    if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) return false;
    return sightMap[tileY][tileX] > LIGHTING.SIGHT_MIN;
}

/**
 * Peripheral-vision polygons from the last update, for the renderer to fill.
 * @returns {Array<Object>} One entry per vision source
 */
export function getVisionPolygons() {
    return activeVisionPolygons;
}

/**
 * Current illumination at a tile.
 *
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {number} 0..1
 */
export function getTileLight(tileX, tileY) {
    if (!lightMap) return 0;
    if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) return 0;
    return lightMap[tileY][tileX];
}

/**
 * Whether a tile is lit enough for its contents to be revealed.
 *
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {boolean} True if currently lit
 */
export function isTileLit(tileX, tileY) {
    return getTileLight(tileX, tileY) > LIGHTING.REVEAL_THRESHOLD;
}

/**
 * Peripheral awareness at a tile.
 *
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {number} 0..1
 */
export function getTileVision(tileX, tileY) {
    if (!visionMap) return 0;
    if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) return 0;
    return visionMap[tileY][tileX];
}

/**
 * Whether a tile registers in peripheral vision -- made out, not lit.
 *
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {boolean} True if currently sensed
 */
export function isTileSensed(tileX, tileY) {
    return getTileVision(tileX, tileY) > LIGHTING.SENSE_THRESHOLD;
}

/**
 * Whether the player can make a tile out at all, by light or by peripheral vision.
 *
 * This is the question gameplay usually wants -- can I see that thing? -- as
 * opposed to isTileLit(), which asks the narrower question of whether light is
 * actually falling on it.
 *
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {boolean} True if lit or sensed
 */
export function isTilePerceived(tileX, tileY) {
    return isTileLit(tileX, tileY) || isTileSensed(tileX, tileY);
}

/**
 * Whether a tile has ever been lit (used to draw remembered geometry).
 *
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {boolean} True if previously seen
 */
export function isTileExplored(tileX, tileY) {
    if (!exploredMap) return false;
    if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) return false;
    return exploredMap[tileY][tileX] > 0;
}

/**
 * Illumination at an arbitrary world position, for entities that sit between
 * tiles. Bilinearly samples the tile light map so things fade smoothly rather
 * than popping as they cross a tile boundary.
 *
 * @param {number} worldX - World X in pixels
 * @param {number} worldY - World Y in pixels
 * @returns {number} 0..1
 */
export function sampleLightAt(worldX, worldY) {
    return sampleGrid(lightMap, worldX, worldY);
}

/**
 * Peripheral awareness at an arbitrary world position. The vision counterpart of
 * sampleLightAt(), and interpolated the same way so a creature drifting across a
 * tile boundary fades rather than pops.
 *
 * @param {number} worldX - World X in pixels
 * @param {number} worldY - World Y in pixels
 * @returns {number} 0..1
 */
export function sampleVisionAt(worldX, worldY) {
    return sampleGrid(visionMap, worldX, worldY);
}

/**
 * Bilinearly samples a per-tile grid at a world position.
 *
 * @param {Array<Float32Array>} grid - Per-tile values, indexed [row][col]
 * @param {number} worldX - World X in pixels
 * @param {number} worldY - World Y in pixels
 * @returns {number} Interpolated value, 0 outside the map
 */
function sampleGrid(grid, worldX, worldY) {
    if (!grid) return 0;

    // Convert to tile-centre space so samples interpolate between centres
    const fx = worldX / TILE_SIZE - 0.5;
    const fy = worldY / TILE_SIZE - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;

    const at = (cx, cy) => {
        if (cx < 0 || cx >= MAP_COLS || cy < 0 || cy >= MAP_ROWS) return 0;
        return grid[cy][cx];
    };

    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
}

// =============================================================================
// LIGHT SOURCES
// =============================================================================

/**
 * Builds the light sources belonging to the player: a wide close-range glow plus
 * the directional flashlight.
 *
 * @param {Object} player - Player entity (needs x, y, angle)
 * @returns {Array<Object>} Light source descriptors
 */
export function createPlayerLights(player) {
    if (!player) return [];

    const lights = [];

    // A muzzle flash is a light before it is a picture: for a frame or two the
    // room around the barrel is lit in the weapon's colour. The renderer draws
    // the flash itself from the same descriptor, so the two cannot disagree.
    const flash = player.getMuzzleFlash?.();
    if (flash) {
        lights.push({
            id: 'player-muzzle',
            x: flash.x,
            y: flash.y,
            kind: 'point',
            range: flash.spec.lightRange,
            intensity: flash.spec.light * flash.strength,
            stops: MUZZLE_LIGHT_STOPS,
            color: flash.spec.color.join(','),
        });
    }

    lights.push(
        {
            id: 'player-glow',
            x: player.x,
            y: player.y,
            kind: 'point',
            range: LIGHTING.GLOW_RADIUS,
            intensity: LIGHTING.GLOW_INTENSITY,
            // Soft, quick falloff -- a lantern held at the chest
            stops: [[0, 1], [0.45, 0.75], [1, 0]],
        },
        {
            id: 'player-flashlight',
            x: player.x,
            y: player.y,
            kind: 'cone',
            direction: player.angle,
            halfAngle: LIGHTING.FLASHLIGHT_HALF_ANGLE,
            range: LIGHTING.FLASHLIGHT_RANGE,
            intensity: LIGHTING.FLASHLIGHT_INTENSITY,
            // Holds brightness further out, then drops off near the end of the beam
            stops: [[0, 1], [0.55, 0.7], [1, 0]],
        },
    );

    return lights;
}

/**
 * Collects every light source in the world for this frame.
 *
 * This is the extension point for additional lights. To add a lamp carried by an
 * enemy, or a lit item lying on the floor, push a descriptor here -- shadow
 * casting, tile illumination, memory and rendering all pick it up with no other
 * changes:
 *
 *   for (const e of gameState.enemies) {
 *       if (e.carriesLamp) lights.push({
 *           id: `enemy-lamp-${e.id}`, x: e.x, y: e.y,
 *           kind: 'point', range: TILE_SIZE * 4, intensity: 0.7,
 *           stops: [[0, 1], [1, 0]], color: '255,200,120',
 *       });
 *   }
 *
 * @param {Object} gameState - Current game state
 * @returns {Array<Object>} All active light sources
 */
export function collectLightSources(gameState) {
    const lights = [];

    if (gameState?.player) {
        lights.push(...createPlayerLights(gameState.player));
        lights.push(...collectHazardLights(gameState.gameMap, gameState.player));
        // Lamps, screens, vats and furnaces: gated by sight like the pools.
        lights.push(...collectDecorLights(gameState.decorLights, gameState.player, currentTimeMs()));
    }

    // Additional world light sources go here (enemy lamps, lit pickups, ...)

    return lights;
}

// =============================================================================
// TERRAIN GLOW
// =============================================================================

/**
 * Emitters for the current map, and the map they were built from.
 *
 * Terrain never changes during a level -- lava does not cool and puddles do not
 * drain -- so the scan is done once and kept. Identity of the array is the cache
 * key rather than the level number: a regenerated map is a different array, which
 * is exactly when the cache must be dropped.
 */
let hazardEmitters = [];
let hazardEmitterMap = null;

/**
 * Finds the points a map's glowing terrain should be lit from.
 *
 * Not one per tile. A lake of forty tiles does not need forty lights -- it needs
 * enough of them, spread far enough apart, that the whole of it glows. Emitters are
 * laid down greedily at HAZARD_EMITTER_SPACING intervals within each connected
 * pool, which gives a small puddle exactly one and a long channel a line of them
 * running down it.
 *
 * Each emitter carries the id of its pool, so the per-pool cap in
 * collectHazardLights() can spend the light budget across the room rather than all
 * of it on whatever the player happens to be standing next to.
 *
 * @param {Array<Array<number>>} map - 2D tile grid
 * @returns {Array<Object>} `{ x, y, tile, pool }` emitters in world pixels
 */
export function buildHazardEmitters(map) {
    const emitters = [];
    if (!map || !map.length) return emitters;

    const spacing = LIGHTING.HAZARD_EMITTER_SPACING;
    const seen = new Uint8Array(MAP_COLS * MAP_ROWS);
    let poolId = 0;

    for (let r = 0; r < MAP_ROWS; r++) {
        const row = map[r];
        if (!row) continue;

        for (let c = 0; c < MAP_COLS; c++) {
            const tile = row[c];
            if (!isGlowingTerrain(tile) || seen[r * MAP_COLS + c]) continue;

            // Flood the connected run of this same liquid, dropping an emitter
            // whenever we reach a tile far enough from every emitter already placed
            // in this pool.
            const pool = poolId++;
            const placed = [];
            const stack = [[c, r]];
            seen[r * MAP_COLS + c] = 1;

            while (stack.length) {
                const spot = stack.pop();
                const tc = spot[0];
                const tr = spot[1];

                let clear = true;
                for (const other of placed) {
                    if (Math.max(Math.abs(other.c - tc), Math.abs(other.r - tr)) < spacing) {
                        clear = false;
                        break;
                    }
                }
                if (clear) {
                    placed.push({ c: tc, r: tr });
                    emitters.push({
                        x: tc * TILE_SIZE + TILE_SIZE / 2,
                        y: tr * TILE_SIZE + TILE_SIZE / 2,
                        tile,
                        pool,
                    });
                }

                for (const step of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nc = tc + step[0];
                    const nr = tr + step[1];
                    if (nc < 0 || nc >= MAP_COLS || nr < 0 || nr >= MAP_ROWS) continue;
                    const index = nr * MAP_COLS + nc;
                    if (seen[index]) continue;
                    const neighbour = map[nr] && map[nr][nc];
                    if (neighbour !== tile) continue;
                    seen[index] = 1;
                    stack.push([nc, nr]);
                }
            }
        }
    }

    return emitters;
}

/**
 * The terrain lights burning this frame.
 *
 * Emitters are filtered to those within sight range of the player -- past which a
 * gated light contributes nothing anyway -- and then capped, nearest first. The cap
 * is a safety valve that generated levels do not reach, so in practice every pool
 * in range is lit, all of it, from every one of its emitters. That is what makes a
 * pool behave like a fixture of the level rather than something that brightens
 * around whoever walks past it.
 *
 * @param {Array<Array<number>>} map - 2D tile grid
 * @param {Object} player - Player entity (needs x, y)
 * @param {number} [nowMs] - Clock for the flicker, injectable for tests
 * @returns {Array<Object>} Light source descriptors
 */
export function collectHazardLights(map, player, nowMs) {
    if (!map || !player) return [];

    if (hazardEmitterMap !== map) {
        hazardEmitters = buildHazardEmitters(map);
        hazardEmitterMap = map;
    }
    if (!hazardEmitters.length) return [];

    const cull = LIGHTING.HAZARD_LIGHT_CULL;
    const near = [];
    for (const emitter of hazardEmitters) {
        const dx = emitter.x - player.x;
        const dy = emitter.y - player.y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq > cull * cull) continue;
        near.push({ emitter, distanceSq });
    }

    near.sort((a, b) => a.distanceSq - b.distanceSq);

    const lights = [];
    const time = (nowMs === undefined ? currentTimeMs() : nowMs) / 1000;

    for (const entry of near) {
        if (lights.length >= LIGHTING.HAZARD_LIGHT_MAX) break;

        const emitter = entry.emitter;
        const glow = TERRAIN[emitter.tile].glow;

        // Flicker, phased off the emitter's own position. A shared phase would make
        // every pool in the level pulse in unison, which reads as the screen
        // brightness changing rather than as fire.
        const phase = emitter.x * 0.017 + emitter.y * 0.031;
        const wobble = 1 + glow.flicker * Math.sin(time * glow.flickerHz * Math.PI * 2 + phase);

        lights.push({
            id: 'terrain-' + emitter.tile + '-' + Math.round(emitter.x) + '-' + Math.round(emitter.y),
            x: emitter.x,
            y: emitter.y,
            kind: 'point',
            range: glow.range,
            intensity: glow.intensity * wobble,
            color: glow.color,
            originCount: LIGHTING.HAZARD_LIGHT_ORIGINS,
            arcDegrees: LIGHTING.HAZARD_LIGHT_ARC_DEGREES,
            softnessPx: LIGHTING.HAZARD_LIGHT_SOFTNESS_PX,
            // Seen only where the player has a line of sight to the ground it
            // lights. See LIGHTING.SIGHT_*.
            gated: true,
            // Bright right over the surface and gone by the rim. A pool lights its
            // own banks and the wall behind it, and very little else.
            stops: [[0, 1], [0.35, 0.62], [1, 0]],
        });
    }

    return lights;
}

/**
 * Wall-clock milliseconds, wherever they can be had.
 *
 * @returns {number} Milliseconds
 */
function currentTimeMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

// =============================================================================
// VISION SOURCES
// =============================================================================

/**
 * The player's peripheral vision: a wide arc in front of them over which shapes
 * register without being illuminated.
 *
 * Structurally identical to a cone light, because it is occluded by exactly the
 * same geometry -- you cannot make out what is round the corner any more than you
 * can light it. Everything that makes it a SENSE rather than a lamp is in where
 * the result goes (visionMap, never lightMap) and how the renderer composites it.
 *
 * @param {Object} player - Player entity (needs x, y, angle)
 * @returns {Array<Object>} Vision source descriptors
 */
export function createPeripheralVision(player) {
    if (!player) return [];

    return [
        {
            id: 'player-peripheral',
            x: player.x,
            y: player.y,
            kind: 'cone',
            direction: player.angle,
            halfAngle: LIGHTING.PERIPHERAL_HALF_ANGLE,
            range: LIGHTING.PERIPHERAL_RANGE,
            intensity: LIGHTING.PERIPHERAL_INTENSITY,
            rimSoftness: LIGHTING.PERIPHERAL_RIM_SOFTNESS,
            originCount: LIGHTING.PERIPHERAL_ORIGINS,
            arcDegrees: LIGHTING.PERIPHERAL_ARC_DEGREES,
            castMargin: LIGHTING.PERIPHERAL_CAST_MARGIN,
            softnessPx: LIGHTING.PERIPHERAL_EDGE_SOFTNESS_PX,
            // Near-flat across most of the arc, then trailing off at the limit of
            // what can be made out. A light's steep falloff would put a bright core
            // around the player, which is the one thing this must not look like.
            stops: [[0, 1], [0.6, 0.85], [1, 0]],
        },
    ];
}

/**
 * The player's line of sight: the stencil through which every gated light is
 * seen. Flat, hard-edged and long -- a lit thing is either in view or it is not.
 *
 * A POINT source, so it reaches all round. It does not depend on the player's aim
 * at all: what a lit room is doing behind you does not stop while you look
 * elsewhere, and a pool you walked past goes on lighting the corridor you left it
 * in. Only geometry closes it, which is the part worth having -- see
 * LIGHTING.SIGHT_*.
 *
 * @param {Object} player - Player entity (needs x, y)
 * @returns {Object} Sight source descriptor
 */
export function createSightline(player) {
    return {
        id: 'player-sight',
        x: player.x,
        y: player.y,
        kind: 'point',
        range: LIGHTING.SIGHT_RANGE,
        intensity: 1,
        originCount: 1,
        arcDegrees: LIGHTING.SIGHT_ARC_DEGREES,
        softnessPx: 0,
        stops: [[0, 1], [1, 1]],
    };
}

/**
 * Collects everything that lets the player perceive without illuminating.
 *
 * The vision counterpart of collectLightSources(), and the same extension point:
 * a motion tracker, a creature's own sense of the room, or a temporary
 * see-through-walls power would each be one more descriptor pushed here.
 *
 * @param {Object} gameState - Current game state
 * @returns {Array<Object>} All active vision sources
 */
export function collectVisionSources(gameState) {
    const senses = [];

    if (gameState?.player) {
        senses.push(...createPeripheralVision(gameState.player));
    }

    return senses;
}

// =============================================================================
// SHADOW CASTING
// =============================================================================

/**
 * Whether a tile blocks light.
 *
 * Closed doors and undiscovered secret doors are opaque, matching how they block
 * movement -- you should not see a room through its shut door.
 *
 * @param {number} tileType - Tile value
 * @returns {boolean} True if the tile stops light
 */
export function isOpaqueTile(tileType) {
    return isOpaque(tileType);
}

function isOpaque(tileType) {
    // A window is glazed, not blind: light and sight pass, bodies do not.
    return tileType === TILE_WALL ||
           tileType === TILE_SLIDE ||
           tileType === TILE_SWITCH ||
           tileType === TILE_DOOR_RED ||
           tileType === TILE_DOOR_YELLOW ||
           tileType === TILE_DOOR_BLUE ||
           tileType === TILE_SECRET_DOOR;
}

/**
 * Whether the tile at a position blocks light right now. A keyed door is
 * opaque only while it is shut; light pours through an open one, as it should.
 *
 * @param {number} tileType - Tile value
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {boolean} True if the tile stops light at this moment
 */
function isOpaqueAt(tileType, tileX, tileY) {
    if (!isOpaque(tileType)) return false;
    if (isKeyedDoorTile(tileType) && isDoorOpen(tileX, tileY)) return false;
    if (tileType === TILE_SLIDE && isSlideOpen(tileX, tileY)) return false;
    return true;
}

/**
 * Traces a single ray from a light and returns exactly how far it travels before
 * being stopped, using a DDA grid walk (Amanatides & Woo).
 *
 * This must be exact, not sampled. The previous version stepped along the ray in
 * fixed 8px increments and reported the distance of whichever step first landed
 * inside a wall. Neighbouring rays therefore stopped at slightly different depths
 * depending on where their sample points happened to fall, and the light's edge
 * along a flat wall came out as a visible staircase. A DDA walk lands precisely on
 * the tile boundary instead, so every ray hitting the same wall stops on the same
 * plane and the edge is straight.
 *
 * The ray stops precisely on the blocking tile's near face and is never extended
 * past it, so light cannot reach anything behind a wall. The wall tile itself is
 * lit separately, from its exposed face -- see litWallFace().
 *
 * Takes the direction as a unit vector rather than an angle: every cast draws its
 * directions from one shared table (rayGrid), which is what saves the eight
 * thousand sin/cos calls a frame otherwise spends recomputing the same handful of
 * angles.
 *
 * @param {number} originX - Light X in world pixels
 * @param {number} originY - Light Y in world pixels
 * @param {number} dirX - Unit direction X
 * @param {number} dirY - Unit direction Y
 * @param {number} maxRange - Maximum distance in world pixels
 * @param {Array} map - 2D tile grid
 * @returns {number} Distance travelled in world pixels
 */
function marchRay(originX, originY, dirX, dirY, maxRange, map) {
    let tileX = Math.floor(originX / TILE_SIZE);
    let tileY = Math.floor(originY / TILE_SIZE);

    const stepX = dirX >= 0 ? 1 : -1;
    const stepY = dirY >= 0 ? 1 : -1;

    // Distance along the ray between successive grid lines on each axis
    const tDeltaX = dirX !== 0 ? Math.abs(TILE_SIZE / dirX) : Infinity;
    const tDeltaY = dirY !== 0 ? Math.abs(TILE_SIZE / dirY) : Infinity;

    // Distance along the ray to the first grid line on each axis
    let tMaxX;
    if (dirX > 0)      tMaxX = ((tileX + 1) * TILE_SIZE - originX) / dirX;
    else if (dirX < 0) tMaxX = (tileX * TILE_SIZE - originX) / dirX;
    else               tMaxX = Infinity;

    let tMaxY;
    if (dirY > 0)      tMaxY = ((tileY + 1) * TILE_SIZE - originY) / dirY;
    else if (dirY < 0) tMaxY = (tileY * TILE_SIZE - originY) / dirY;
    else               tMaxY = Infinity;

    // Bounded by the worst case of walking the whole range on both axes
    const maxSteps = Math.ceil(maxRange / TILE_SIZE) * 2 + 4;

    for (let i = 0; i < maxSteps; i++) {
        // Cross into the next cell along whichever axis comes first
        let entryDistance;
        if (tMaxX < tMaxY) {
            tileX += stepX;
            entryDistance = tMaxX;
            tMaxX += tDeltaX;
        } else {
            tileY += stepY;
            entryDistance = tMaxY;
            tMaxY += tDeltaY;
        }

        if (entryDistance >= maxRange) return maxRange;

        if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) {
            return Math.min(entryDistance, maxRange);
        }

        const row = map[tileY];
        if (!row || isOpaqueAt(row[tileX], tileX, tileY)) {
            // Stop dead on the blocking tile's near face. Nothing is added on.
            //
            // Earlier versions pushed the ray onward so the wall tile would fall
            // inside the lit polygon, but there is no safe amount to add: a ray
            // entering a wall at a grazing angle needs `TILE_SIZE / sin(theta)` to
            // cross one tile, which runs to tens of tiles as theta approaches zero.
            // That is what threw long lens-shaped arcs of light straight through
            // walls into the rooms beyond.
            //
            // Wall tiles are instead lit explicitly from their exposed faces, by
            // accumulateWallLight() -- so the wall a room is made of lights up
            // completely while nothing behind it is touched.
            return Math.min(entryDistance, maxRange);
        }
    }

    return maxRange;
}

/**
 * The grid of ray directions for a given angular resolution: `count` unit
 * vectors dividing the full circle exactly, built once and kept.
 *
 * @param {number} arcDegrees - Requested spacing between rays
 * @returns {Object} `{ count, step, cos, sin }`
 */
const rayGrids = new Map();
function rayGrid(arcDegrees) {
    let grid = rayGrids.get(arcDegrees);
    if (grid) return grid;

    let count = Math.ceil(360 / arcDegrees);
    count = Math.max(LIGHTING.MIN_RAYS, Math.min(LIGHTING.MAX_RAYS, count));
    const step = (Math.PI * 2) / count;

    const cos = new Float64Array(count);
    const sin = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        cos[i] = Math.cos(i * step);
        sin[i] = Math.sin(i * step);
    }

    grid = { count, step, cos, sin };
    rayGrids.set(arcDegrees, grid);
    return grid;
}

/**
 * Positions a light is cast from: its centre, plus a ring around it.
 *
 * A source may override the disc with `originCount` / `originRadius`. Peripheral
 * vision does: it is a flat dim wash, so the penumbra gradations extra origins buy
 * would be invisible, and each one costs a full set of rays.
 *
 * @param {Object} light - Light source descriptor
 * @returns {Array<Object>} Origins as `{ x, y }`, the centre first
 */
function lightOrigins(light) {
    const radius = light.originRadius ?? LIGHTING.LIGHT_RADIUS;
    const count = light.originCount ?? LIGHTING.LIGHT_ORIGINS;
    const origins = [{ x: light.x, y: light.y }];
    if (!(radius > 0) || count < 2) return origins;

    for (let i = 0; i < count - 1; i++) {
        const angle = (i / (count - 1)) * Math.PI * 2;
        origins.push({
            x: light.x + Math.cos(angle) * radius,
            y: light.y + Math.sin(angle) * radius,
        });
    }
    return origins;
}

/**
 * Resolves a light source into a shadow polygon: an ordered fan of ray hits that
 * describes exactly how far the light reaches in every direction.
 *
 * Cast once per origin (see LIGHT_RADIUS). Every origin shares one set of ray
 * ANGLES, so their fans can be compared index by index, and how many of them reach
 * a given point is that point's coverage -- 1 in full light, 0 in full shadow, and
 * in between along the penumbra of every corner.
 *
 * `distances` is the centre origin's fan, which is the light's nominal reach.
 *
 * @param {Object} light - Light source descriptor
 * @param {Array} map - 2D tile grid
 * @returns {Object} { light, startAngle, angleStep, origins, distances, isFullCircle,
 *     grid, gridStart }
 */
export function castLightPolygon(light, map) {
    const isCone = light.kind === 'cone';

    // Cast wider than the beam actually shows (see CONE_CAST_MARGIN). The visible
    // extent is still light.halfAngle -- angularFactor() and the renderer's conic
    // profile both use that, and everything past it fades to nothing.
    const castHalfAngle = isCone
        ? Math.min(Math.PI, light.halfAngle + (light.castMargin ?? LIGHTING.CONE_CAST_MARGIN))
        : Math.PI;

    // SNAPPED to a fixed global grid of directions, not hung off the beam's
    // direction.
    //
    // A fan whose rays are measured from wherever the player happens to be aiming
    // sweeps every one of them across the scene as the player turns. Each ray's hit
    // distance is bimodal at a corner -- it either catches the corner or slips past
    // it -- so every corner in view flicks a long shadow spike on and off as the
    // rays cross it, and turning on the spot makes the whole lit area crawl.
    //
    // On a fixed grid the ray directions are the same set whatever the player is
    // facing; turning only changes which of them are cast. A given corner is
    // therefore always sampled by the same ray, and the shadow it throws holds
    // perfectly still. The arc lands up to one ray-step off where it was asked for,
    // which nothing can see: the beam's visible edge comes from the conic profile
    // using the true direction, and the fan is cast a wide margin past it anyway.
    //
    // The grid divides the circle EXACTLY, so its directions can be tabulated once
    // (rayGrid) instead of recomputed with sin/cos for every ray of every origin of
    // every source, every frame.
    const grid = rayGrid(light.arcDegrees ?? LIGHTING.RAY_ARC_DEGREES);
    const angleStep = grid.step;

    let gridStart, rayCount;
    if (isCone) {
        // The first ray at or before the beam's near rim, and enough of them to
        // reach past its far rim: one extra covers the snap, one covers the ceiling.
        gridStart = Math.floor((light.direction - castHalfAngle) / angleStep);
        rayCount = Math.min(grid.count + 1, Math.ceil((castHalfAngle * 2) / angleStep) + 2);
    } else {
        gridStart = 0;
        rayCount = grid.count;                   // Must not duplicate 0 and 2pi
    }
    const startAngle = gridStart * angleStep;

    const origins = lightOrigins(light);
    const count = grid.count;
    const cos = grid.cos, sin = grid.sin;
    for (const origin of origins) {
        const distances = new Float32Array(rayCount);
        for (let i = 0; i < rayCount; i++) {
            const k = (((gridStart + i) % count) + count) % count;
            distances[i] = marchRay(origin.x, origin.y, cos[k], sin[k], light.range, map);
        }
        origin.distances = distances;
    }

    return {
        light, startAngle, angleStep, origins,
        distances: origins[0].distances,
        isFullCircle: !isCone,
        grid, gridStart,
    };
}

/**
 * The unit direction of one ray of a polygon, from the shared grid.
 *
 * For the renderer, which traces every origin's fan into a path each frame and
 * otherwise pays a sin and a cos per vertex to do it.
 *
 * @param {Object} polygon - Result of castLightPolygon
 * @param {number} i - Ray index
 * @param {Object} out - Receives `{ x, y }`
 * @returns {Object} `out`
 */
export function rayDirection(polygon, i, out) {
    const count = polygon.grid.count;
    const k = (((polygon.gridStart + i) % count) + count) % count;
    out.x = polygon.grid.cos[k];
    out.y = polygon.grid.sin[k];
    return out;
}

/**
 * Radial falloff for a light at a given normalised distance, honouring its stops.
 *
 * @param {Object} light - Light source descriptor
 * @param {number} t - Normalised distance from the light, 0..1
 * @returns {number} Brightness multiplier 0..1
 */
function falloffAt(light, t) {
    const stops = light.stops || [[0, 1], [1, 0]];
    if (t <= stops[0][0]) return stops[0][1];

    for (let i = 1; i < stops.length; i++) {
        const [prevPos, prevVal] = stops[i - 1];
        const [pos, val] = stops[i];
        if (t <= pos) {
            const span = pos - prevPos;
            const k = span > 0 ? (t - prevPos) / span : 0;
            return prevVal + (val - prevVal) * k;
        }
    }
    return stops[stops.length - 1][1];
}

/**
 * Light a source delivers to a world point, ignoring the direction it is aimed.
 *
 * Coverage -- the fraction of the lamp with an unobstructed run to the point --
 * scaled by the source's intensity and its distance falloff. This is the whole of
 * the lighting rule except the beam's angular profile, which the renderer applies
 * separately as a conic gradient so that it lands per pixel rather than per sample.
 *
 * @param {Object} polygon - Result of castLightPolygon
 * @param {number} worldX - World X in pixels
 * @param {number} worldY - World Y in pixels
 * @param {number} tolerance - Extra distance allowed past each ray's hit
 * @returns {number} 0..1
 */
export function radialLightAt(polygon, worldX, worldY, tolerance = 0) {
    const light = polygon.light;
    const dx = worldX - light.x;
    const dy = worldY - light.y;
    // sqrt of the sum, not Math.hypot: hypot guards against overflow that
    // coordinates in pixels can never cause, and costs twice as much for it.
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > light.range) return 0;

    const coverage = lightCoverageAt(polygon, worldX, worldY, tolerance);
    if (coverage <= 0) return 0;

    return coverage * light.intensity * falloffAt(light, distance / light.range);
}

/**
 * The full light a source delivers to a world point, beam shape included.
 *
 * The gameplay answer: this is what the tile light map stores, for open ground and
 * wall faces alike.
 *
 * @param {Object} polygon - Result of castLightPolygon
 * @param {number} worldX - World X in pixels
 * @param {number} worldY - World Y in pixels
 * @param {number} tolerance - Extra distance allowed past each ray's hit
 * @returns {number} 0..1
 */
export function sourceLightAt(polygon, worldX, worldY, tolerance = 0) {
    const radial = radialLightAt(polygon, worldX, worldY, tolerance);
    if (radial <= 0) return 0;
    return radial * angularFactor(polygon.light, worldX, worldY);
}

/** Face directions, in the order a tile's faces are considered. */
const ORTHOGONAL_FACES = [[0, -1], [0, 1], [-1, 0], [1, 0]];
const DIAGONAL_FACES = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

/**
 * Whether a tile is ground the player could stand on, so a wall beside it has a
 * face there.
 *
 * @param {Array} map - 2D tile grid
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {boolean} True if open
 */
function isWalkable(map, tileX, tileY) {
    if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) return false;
    const row = map[tileY];
    return !!row && !isOpaqueAt(row[tileX], tileX, tileY);
}

// -----------------------------------------------------------------------------
// The wall-face index
//
// Which sides of which wall tiles front walkable ground. The answer only changes
// when the map does -- and within a level that means a door or a sliding wall
// crossing its passable threshold -- yet it used to be re-derived for every opaque
// tile within reach of every source, every frame: eight neighbour probes each,
// on some two thousand tiles a frame, two thirds of which are interior rock that
// fronts nothing and can never be lit. The index makes those a single byte read.
//
// One byte per tile. Bits 0-3 are the orthogonal faces (up, down, left, right),
// bits 4-7 the diagonals -- recorded only for a tile with NO orthogonal face, since
// diagonals are a fallback, not an equal (see litWallFace). Zero means the tile
// fronts nothing, or is not opaque at all.
// -----------------------------------------------------------------------------
const FACE_BITS = [1, 2, 4, 8];
const CORNER_BITS = [16, 32, 64, 128];

let faceIndex = null;          // Uint8Array, MAP_COLS * MAP_ROWS
let faceIndexMap = null;       // The map array it was built from
let faceIndexSignature = '';   // Door and slide states it was built under

/**
 * The state of everything whose opacity can change mid-level, as one string.
 *
 * @returns {string} Signature; a different string means the index is stale
 */
function opacitySignature() {
    let sig = '';
    const doors = getDoors();
    for (let i = 0; i < doors.length; i++) {
        const door = doors[i];
        sig += (door.unlocked && door.openness >= DOORS.PASSABLE_AT) ? '1' : '0';
    }
    sig += '|';
    const slides = getSlides();
    for (let i = 0; i < slides.length; i++) {
        sig += slides[i].openness >= SWITCHES.PASSABLE_AT ? '1' : '0';
    }
    return sig;
}

/**
 * The face byte for one tile, worked out from its neighbours.
 *
 * @param {Array} map - 2D tile grid
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {number} Face bits, 0 if the tile fronts nothing
 */
function probeFaces(map, tileX, tileY) {
    const row = map[tileY];
    if (!row || !isOpaqueAt(row[tileX], tileX, tileY)) return 0;

    let bits = 0;
    for (let i = 0; i < ORTHOGONAL_FACES.length; i++) {
        if (isWalkable(map, tileX + ORTHOGONAL_FACES[i][0], tileY + ORTHOGONAL_FACES[i][1])) {
            bits |= FACE_BITS[i];
        }
    }
    if (bits) return bits;

    for (let i = 0; i < DIAGONAL_FACES.length; i++) {
        if (isWalkable(map, tileX + DIAGONAL_FACES[i][0], tileY + DIAGONAL_FACES[i][1])) {
            bits |= CORNER_BITS[i];
        }
    }
    return bits;
}

/**
 * Brings the face index up to date for a map. Cheap when nothing has changed:
 * an identity check and a short string compare.
 *
 * @param {Array} map - 2D tile grid
 */
function ensureFaceIndex(map) {
    const signature = opacitySignature();
    if (faceIndexMap === map && faceIndexSignature === signature) return;

    if (!faceIndex) faceIndex = new Uint8Array(MAP_COLS * MAP_ROWS);
    for (let r = 0; r < MAP_ROWS; r++) {
        const row = map[r];
        const base = r * MAP_COLS;
        for (let c = 0; c < MAP_COLS; c++) {
            faceIndex[base + c] = row ? probeFaces(map, c, r) : 0;
        }
    }
    faceIndexMap = map;
    faceIndexSignature = signature;
}

/**
 * The face bits for a tile: from the index when it is current for this map, or
 * probed directly when it is not -- a caller that runs before this frame's
 * updateLighting() still gets the right answer, just not the cheap one.
 *
 * @param {Array} map - 2D tile grid
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {number} Face bits
 */
function faceBits(map, tileX, tileY) {
    if (faceIndexMap === map) return faceIndex[tileY * MAP_COLS + tileX];
    return probeFaces(map, tileX, tileY);
}

/**
 * Where on a wall tile a source lights it, and how brightly.
 *
 * Each face fronting walkable ground is measured just outside its surface, by the
 * same rule a floor tile is measured by, and the brightest wins. A tile with no
 * face the source can see is not lit at all -- which is what confines the reveal to
 * the first layer of wall around a room, and to the side of it the source is on.
 *
 * Diagonals are a fallback, not an equal: a tile whose orthogonal neighbours are all
 * solid still fronts the room at its corner, and that is the tile at the corner of
 * every rectangular room. Considering diagonals alongside the straight faces instead
 * would let a wall be lit around the outside of a corner it does not front.
 *
 * @param {Object} polygon - Result of castLightPolygon
 * @param {Array} map - 2D tile grid
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {Object|null} `{ faceX, faceY, light }`, or null if unlit
 */
/**
 * Where on a wall tile a source lights it, and how brightly.
 *
 * Each face fronting walkable ground is measured just outside its surface, by the
 * same rule a floor tile is measured by, and the brightest wins. A tile with no
 * face the source can see is not lit at all -- which is what confines the reveal to
 * the first layer of wall around a room, and to the side of it the source is on.
 *
 * Diagonals are a fallback, not an equal: a tile whose orthogonal neighbours are all
 * solid still fronts the room at its corner, and that is the tile at the corner of
 * every rectangular room. Considering diagonals alongside the straight faces instead
 * would let a wall be lit around the outside of a corner it does not front.
 *
 * Which faces a tile has comes from the face index (see ensureFaceIndex), so the
 * per-call work is only the measurement itself.
 *
 * @param {Object} polygon - Result of castLightPolygon
 * @param {Array} map - 2D tile grid
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @returns {Object|null} `{ faceX, faceY, light }`, or null if unlit
 */
export function litWallFace(polygon, map, tileX, tileY) {
    if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) return null;
    const bits = faceBits(map, tileX, tileY);
    if (!bits) return null;

    const centreX = tileX * TILE_SIZE + TILE_SIZE / 2;
    const centreY = tileY * TILE_SIZE + TILE_SIZE / 2;
    const reach = TILE_SIZE / 2 + LIGHTING.WALL_FACE_SAMPLE_PX;
    const tolerance = TILE_SIZE * 0.15;

    let bestLight = 0, bestX = 0, bestY = 0;

    if (bits & 15) {
        for (let i = 0; i < ORTHOGONAL_FACES.length; i++) {
            if (!(bits & FACE_BITS[i])) continue;
            const faceX = ORTHOGONAL_FACES[i][0];
            const faceY = ORTHOGONAL_FACES[i][1];
            const value = sourceLightAt(polygon, centreX + faceX * reach,
                                        centreY + faceY * reach, tolerance);
            if (value > bestLight) { bestLight = value; bestX = faceX; bestY = faceY; }
        }
    } else {
        for (let i = 0; i < DIAGONAL_FACES.length; i++) {
            if (!(bits & CORNER_BITS[i])) continue;
            const faceX = DIAGONAL_FACES[i][0];
            const faceY = DIAGONAL_FACES[i][1];
            const value = sourceLightAt(polygon, centreX + faceX * reach,
                                        centreY + faceY * reach, tolerance);
            if (value > bestLight) { bestLight = value; bestX = faceX; bestY = faceY; }
        }
    }

    if (bestLight <= 0) return null;
    return { faceX: bestX, faceY: bestY, light: bestLight };
}

/**
 * The world point at which a face is measured.
 *
 * Shared with the renderer so the shading it draws is sampled at exactly the places
 * the tile light map was.
 *
 * @param {number} tileX - Tile column
 * @param {number} tileY - Tile row
 * @param {number} faceX - Face direction X, -1..1
 * @param {number} faceY - Face direction Y, -1..1
 * @returns {Object} `{ x, y }` in world pixels
 */
export function wallFaceSamplePoint(tileX, tileY, faceX, faceY) {
    const reach = TILE_SIZE / 2 + LIGHTING.WALL_FACE_SAMPLE_PX;
    return {
        x: tileX * TILE_SIZE + TILE_SIZE / 2 + faceX * reach,
        y: tileY * TILE_SIZE + TILE_SIZE / 2 + faceY * reach,
    };
}

/**
 * Accumulates one light's contribution into the tile light map.
 *
 * Reuses the already-computed shadow polygon rather than re-tracing per tile: a
 * tile is lit precisely when it lies nearer than the ray pointing at it, which is
 * what guarantees the tile map and the drawn light agree.
 *
 * @param {Object} polygon - Result of castLightPolygon
 * @param {Array<Float32Array>} target - Tile light grid to accumulate into
 * @param {Array<Float32Array>|null} gate - If given, tiles this grid leaves below
 *        SIGHT_MIN are skipped: light landing where the player cannot see
 */
function accumulateTileLight(polygon, target, gate = null) {
    const light = polygon.light;
    if (!polygon.distances.length) return;

    const minTileX = Math.max(0, Math.floor((light.x - light.range) / TILE_SIZE));
    const maxTileX = Math.min(MAP_COLS - 1, Math.floor((light.x + light.range) / TILE_SIZE));
    const minTileY = Math.max(0, Math.floor((light.y - light.range) / TILE_SIZE));
    const maxTileY = Math.min(MAP_ROWS - 1, Math.floor((light.y + light.range) / TILE_SIZE));

    const rangeSq = light.range * light.range;

    // A small tolerance keeps tiles that straddle a shadow edge from flickering.
    // It has to stay well under a tile: at half a tile, combined with the ray
    // already reaching the far face of the blocker, light bled more than a full
    // tile past walls and marked rooms behind them explored.
    const tolerance = TILE_SIZE * 0.15;

    for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
        const centreY = tileY * TILE_SIZE + TILE_SIZE / 2;
        const targetRow = target[tileY];
        const gateRow = gate ? gate[tileY] : null;

        for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
            if (gateRow && gateRow[tileX] <= LIGHTING.SIGHT_MIN) continue;

            const centreX = tileX * TILE_SIZE + TILE_SIZE / 2;
            const dx = centreX - light.x;
            const dy = centreY - light.y;
            const distanceSq = dx * dx + dy * dy;
            if (distanceSq > rangeSq) continue;

            // Coverage does the cone test itself, so there is nothing to work out
            // about which ray points here first.
            const coverage = lightCoverageAt(polygon, centreX, centreY, tolerance);
            if (coverage <= 0) continue;

            const value = coverage
                        * light.intensity
                        * falloffAt(light, Math.sqrt(distanceSq) / light.range)
                        * angularFactor(light, centreX, centreY);
            if (value > targetRow[tileX]) {
                targetRow[tileX] = value;
            }
        }
    }
}

/**
 * Accumulates one source's contribution to the wall tiles it can see the face of.
 *
 * Runs per source rather than once over the finished grid, because which face is lit
 * is a question about a particular lamp and its shadows. Taking the brightest
 * neighbouring FLOOR tile instead -- which is what this used to do -- has no notion
 * of sides at all: a wall between two rooms took whichever room was better lit, and
 * a spur lit from the left read as lit from the right as well.
 *
 * @param {Object} polygon - Result of castLightPolygon
 * @param {Array} map - 2D tile grid
 * @param {Array<Float32Array>} target - Tile light grid to accumulate into
 */
/**
 * Accumulates one source's contribution to the wall tiles it can see the face of.
 *
 * Runs per source rather than once over the finished grid, because which face is lit
 * is a question about a particular lamp and its shadows. Taking the brightest
 * neighbouring FLOOR tile instead -- which is what this used to do -- has no notion
 * of sides at all: a wall between two rooms took whichever room was better lit, and
 * a spur lit from the left read as lit from the right as well.
 *
 * Walks the face index rather than the map: a tile with no face is one byte to
 * skip, and those are most of the box.
 *
 * @param {Object} polygon - Result of castLightPolygon
 * @param {Array} map - 2D tile grid
 * @param {Array<Float32Array>} target - Tile light grid to accumulate into
 * @param {Array<Float32Array>|null} gate - If given, tiles this grid leaves below
 *        SIGHT_MIN are skipped: light landing where the player cannot see
 */
function accumulateWallLight(polygon, map, target, gate = null) {
    const light = polygon.light;
    if (!polygon.distances.length) return;
    const reach = light.range + TILE_SIZE;

    const minTileX = Math.max(0, Math.floor((light.x - reach) / TILE_SIZE));
    const maxTileX = Math.min(MAP_COLS - 1, Math.floor((light.x + reach) / TILE_SIZE));
    const minTileY = Math.max(0, Math.floor((light.y - reach) / TILE_SIZE));
    const maxTileY = Math.min(MAP_ROWS - 1, Math.floor((light.y + reach) / TILE_SIZE));

    const index = faceIndexMap === map ? faceIndex : null;

    for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
        const targetRow = target[tileY];
        const gateRow = gate ? gate[tileY] : null;
        const base = tileY * MAP_COLS;

        for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
            if (index ? !index[base + tileX] : !probeFaces(map, tileX, tileY)) continue;
            if (gateRow && gateRow[tileX] <= LIGHTING.SIGHT_MIN) continue;

            const face = litWallFace(polygon, map, tileX, tileY);
            if (face && face.light > targetRow[tileX]) {
                targetRow[tileX] = face.light;
            }
        }
    }
}

/**
 * How strongly a light illuminates in the direction of a given point, ignoring
 * distance. Point lights are uniform; cones fade towards the rim of the beam, over
 * `rimSoftness` of their half-angle.
 *
 * The renderer applies this to wall tiles and the tile light map applies it to open
 * space, so the beam's angular shape is the same everywhere.
 *
 * @param {Object} light - Light source descriptor
 * @param {number} worldX - World X in pixels
 * @param {number} worldY - World Y in pixels
 * @returns {number} Angular multiplier 0..1
 */
export function angularFactor(light, worldX, worldY) {
    if (light.kind !== 'cone') return 1;

    const rim = light.rimSoftness ?? LIGHTING.CONE_RIM_SOFTNESS;
    if (rim <= 0) return 1;

    let offset = Math.atan2(worldY - light.y, worldX - light.x) - light.direction;
    offset = Math.abs(((offset + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI);

    const normalised = offset / light.halfAngle;      // 0 on axis, 1 at the rim
    if (normalised <= 1 - rim) return 1;
    if (normalised >= 1) return 0;
    return (1 - normalised) / rim;
}

/**
 * How much of a light reaches a world position, 0..1.
 *
 * The fraction of the light's origins with an unobstructed run to the point. 1 is
 * full light, 0 is full shadow, and everything between is the penumbra a corner
 * casts because the lamp has width.
 *
 * @param {Object} polygon - Result of castLightPolygon
 * @param {number} worldX - World X in pixels
 * @param {number} worldY - World Y in pixels
 * @param {number} tolerance - Extra distance allowed past each ray's hit
 * @returns {number} Coverage 0..1
 */
export function lightCoverageAt(polygon, worldX, worldY, tolerance = 0) {
    const { light, startAngle, angleStep, origins, isFullCircle } = polygon;
    if (!origins || !origins.length) return 0;

    let reached = 0;
    for (const origin of origins) {
        const distances = origin.distances;
        if (!distances.length) continue;

        const dx = worldX - origin.x;
        const dy = worldY - origin.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > light.range) continue;

        let relative = Math.atan2(dy, dx) - startAngle;
        relative = ((relative % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

        const count = distances.length;
        const exact = relative / angleStep;

        // BLENDED between the two rays either side, never snapped to the nearer.
        //
        // Snapping made a point's answer come from one ray, and a ray's hit distance
        // is bimodal beside a corner: it either catches the corner or slips past it.
        // So the instant the light moved far enough for a point's nearest ray to
        // change -- half a pixel, sometimes -- its answer flipped the whole way from
        // lit to dark. Measured on a room of pillars, creeping half a pixel a frame
        // jumped tiles by 0.45 out of 1.
        //
        // Blending turns that step into a ramp one ray-step wide, which is both
        // continuous under motion and a fair reading of a corner: the fraction of
        // the gap between two rays that is open really is how much of the light
        // gets through there.
        let lo = Math.floor(exact);
        const frac = exact - lo;
        let hi = lo + 1;

        if (isFullCircle) {
            lo = ((lo % count) + count) % count;
            hi = ((hi % count) + count) % count;
        } else {
            if (exact < 0 || lo >= count) continue;     // outside the cone
            if (hi >= count) hi = count - 1;
        }

        const near = distance - tolerance;
        const openLo = near <= distances[lo] ? 1 : 0;
        const openHi = near <= distances[hi] ? 1 : 0;
        reached += openLo + (openHi - openLo) * frac;
    }
    return reached / origins.length;
}

/**
 * Whether a world position is lit at all by a light source.
 *
 * True as soon as ANY part of the lamp can see the point, which is the reading that
 * matters for revealing things: if the player can see a glint of it, it is there.
 * Callers that want to know HOW lit it is should use lightCoverageAt().
 *
 * @param {Object} polygon - Result of castLightPolygon
 * @param {number} worldX - World X in pixels
 * @param {number} worldY - World Y in pixels
 * @returns {boolean} True if the point is lit by this source
 */
export function isPointInLightPolygon(polygon, worldX, worldY) {
    return lightCoverageAt(polygon, worldX, worldY) > 0;
}

// =============================================================================
// PER-FRAME UPDATE
// =============================================================================

/**
 * Recomputes lighting for the current frame.
 *
 * Runs every frame rather than only on tile crossings: the flashlight turns with
 * the mouse, so throttling made illumination visibly lag the beam. Casting is
 * cheap enough to afford -- a DDA walk visits at most one grid cell per step, far
 * less work than the per-tile line-of-sight sampling this replaced.
 *
 * @param {Object} gameState - Current game state (needs gameMap and player)
 * @returns {Array<Object>} The shadow polygons computed this frame
 */
export function updateLighting(gameState) {
    ensureGrids();

    const map = gameState?.gameMap;
    if (!map || !map.length) {
        activePolygons = [];
        activeVisionPolygons = [];
        return activePolygons;
    }

    // Clear current illumination and awareness in place (memory is separate)
    for (let r = 0; r < MAP_ROWS; r++) {
        lightMap[r].fill(0);
        visionMap[r].fill(0);
    }

    // Which wall tiles have a face, and which way: once per frame, and only
    // rebuilt when a door or slide has changed state since last time.
    ensureFaceIndex(map);

    // Sight first: it is the gate the terrain lights are measured through.
    for (let r = 0; r < MAP_ROWS; r++) sightMap[r].fill(0);
    activeSightPolygon = null;
    if (gameState.player) {
        activeSightPolygon = castLightPolygon(createSightline(gameState.player), map);
        accumulateTileLight(activeSightPolygon, sightMap);
        accumulateWallLight(activeSightPolygon, map, sightMap);
    }

    const lights = collectLightSources(gameState);
    activePolygons = [];

    for (const light of lights) {
        const polygon = castLightPolygon(light, map);
        activePolygons.push(polygon);
        // A gated light -- terrain glow -- lands only on tiles the player can
        // see. Its polygon is still cast in full: the renderer needs the shape
        // to clip, and the shadows it throws are real either way.
        const gate = light.gated ? sightMap : null;
        accumulateTileLight(polygon, lightMap, gate);
        accumulateWallLight(polygon, map, lightMap, gate);
    }

    // Ambient sector light: the overhead lighting each room is assumed to have
    // (js/sectors.js). Gated on the sight polygon exactly as a terrain glow is,
    // so a lit room is lit the moment you can see into it and black until then
    // -- the light tells you what is there, it does not hand you the map.
    if (hasSectors()) {
        updateSectors(currentTimeMs());
        for (let r = 0; r < MAP_ROWS; r++) {
            const lightRow = lightMap[r];
            const sightRow = sightMap[r];
            for (let c = 0; c < MAP_COLS; c++) {
                const seen = sightRow[c];
                if (seen <= 0) continue;
                const ambient = ambientForTile(map, c, r) * seen;
                if (ambient > 0) lightRow[c] = Math.min(1, lightRow[c] + ambient);
            }
        }
    }

    // Peripheral vision, cast by the same machinery into its own grid. Nothing
    // here touches lightMap, so a sensed tile never counts as an illuminated one.
    const senses = collectVisionSources(gameState);
    activeVisionPolygons = [];

    for (const sense of senses) {
        const polygon = castLightPolygon(sense, map);
        activeVisionPolygons.push(polygon);
        accumulateTileLight(polygon, visionMap);
        // The walls bounding what is sensed are made out too -- that is most of what
        // peripheral vision is for, knowing the shape of the room you are in.
        accumulateWallLight(polygon, map, visionMap);
    }

    // Fold this frame into the memory of what has been seen. Sensed ground counts:
    // you do not forget that a corridor turned left simply because you never shone
    // the torch down it, and this is what fills the minimap in. Memory records how
    // WELL a place was seen, so a spot only ever glimpsed peripherally is
    // remembered faintly and stays that way until the beam finds it.
    for (let r = 0; r < MAP_ROWS; r++) {
        const lightRow = lightMap[r];
        const visionRow = visionMap[r];
        const seenRow = exploredMap[r];
        for (let c = 0; c < MAP_COLS; c++) {
            const value = Math.max(lightRow[c], visionRow[c]);
            if (value > LIGHTING.MEMORY_MIN_LIGHT && value > seenRow[c]) {
                seenRow[c] = value;
            }
        }
    }

    // Mirror onto the globals some older call sites still read
    publishGlobals();
    if (gameState) {
        gameState.lightMap = lightMap;
        gameState.exploredMap = exploredMap;
        gameState.visionMap = visionMap;
    }

    return activePolygons;
}
