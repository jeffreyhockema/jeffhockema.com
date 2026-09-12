/**
 * =============================================================================
 * ENEMY SPRITE SYSTEM
 * =============================================================================
 *
 * Loads and addresses the enemy atlases produced by tools/build_enemy_sprites.py.
 *
 * The art is 42 CraftPix characters, each baked into a single atlas holding
 * every frame of every animation. `sprites/enemies/manifest.json` is the index:
 * it records each atlas's cell size, how many columns it is packed into, and
 * for every (animation, direction) pair the start index and frame count. A
 * frame is therefore addressed as:
 *
 *     column = index % columns
 *     row    = Math.floor(index / columns)
 *
 * Atlases are fetched lazily. A level uses a handful of characters out of the
 * 42, so loading the whole ~8 MB collection up front would be almost entirely
 * waste; instead a character's atlas is requested the first time an enemy is
 * assigned it, and the enemy falls back to shape rendering for the frame or two
 * before the image lands.
 *
 * Every animation the source packs ship is available here:
 *   idle, idle_blink, walk, run  (looping, per direction)
 *   attack, hurt                 (one-shot, per direction)
 *   dying                        (one-shot, directionless)
 */

// =============================================================================
// ANIMATION NAMES
// =============================================================================

/**
 * The animation slots present in the atlases.
 *
 * `IDLE_BLINK` is an idle variation the packs provide for the front/left/right
 * views; the renderer drops into it occasionally so standing enemies aren't
 * perfectly static.
 */
export const ENEMY_ANIM = {
    IDLE: 'idle',
    IDLE_BLINK: 'idle_blink',
    WALK: 'walk',
    RUN: 'run',
    ATTACK: 'attack',
    HURT: 'hurt',
    DYING: 'dying'
};

/** Where the manifest and atlases live, relative to the page. */
const SPRITE_ROOT = 'sprites/enemies/';

// =============================================================================
// MODULE STATE
// =============================================================================

/** Parsed manifest.json, or null until loadEnemySpriteManifest() resolves. */
let manifest = null;

/** slug -> HTMLImageElement. An entry exists as soon as loading *starts*. */
const atlasImages = new Map();

/** Slugs in manifest order, cached so random picks don't rebuild the array. */
let slugList = [];

/**
 * Loads the sprite manifest.
 *
 * Resolves to false rather than throwing when the manifest is missing or
 * malformed: the game renders enemies as shapes without sprites, so a failed
 * asset load should cost visual polish, not the session.
 *
 * @param {string} [url] - Manifest location, overridable for tests
 * @returns {Promise<boolean>} True if a usable manifest was loaded
 */
export async function loadEnemySpriteManifest(url = `${SPRITE_ROOT}manifest.json`) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!data || !data.characters || typeof data.characters !== 'object') {
            throw new Error('manifest has no characters');
        }

        manifest = data;
        slugList = Object.keys(data.characters);

        console.log(`EnemySprites: ${slugList.length} enemy characters available`);
        return slugList.length > 0;
    } catch (error) {
        console.warn(`EnemySprites: could not load ${url} (${error.message}). ` +
                     `Enemies will render as shapes.`);
        manifest = null;
        slugList = [];
        return false;
    }
}

/** @returns {string[]} Every available character slug */
export function getEnemySpriteSlugs() {
    return slugList.slice();
}

/**
 * Looks up a character's metadata.
 *
 * @param {string} slug - Character key, e.g. "skeleton-knight"
 * @returns {Object|null} Manifest entry, or null if unknown
 */
export function getEnemySpriteMeta(slug) {
    return manifest?.characters?.[slug] || null;
}

/** @returns {Object} Animation name -> frames per second */
export function getEnemyFrameRates() {
    return manifest?.frameRates || {};
}

/** @returns {string[]} Animations that play once instead of looping */
export function getEnemyOneShotAnimations() {
    return manifest?.oneShot || [];
}

// =============================================================================
// ATLAS LOADING
// =============================================================================

/**
 * Starts loading a character's atlas, or returns the in-flight/finished image.
 *
 * Safe to call every frame: the first call creates the Image, later ones hand
 * back the same element. Callers check `.complete && .naturalHeight` before
 * drawing, which is false while the request is still in flight.
 *
 * @param {string} slug - Character key
 * @returns {HTMLImageElement|null} The atlas image, or null for unknown slugs
 */
export function getEnemyAtlas(slug) {
    const cached = atlasImages.get(slug);
    if (cached) return cached;

    const meta = getEnemySpriteMeta(slug);
    if (!meta) return null;

    const image = new Image();
    // The lighting pass reads pixels back off the canvas, which taints on a
    // cross-origin draw. The atlases are same-origin, but declaring this keeps
    // the sprites safe to composite if they are ever served from a CDN.
    image.crossOrigin = 'anonymous';
    image.src = `${SPRITE_ROOT}${meta.file}`;
    image.addEventListener('error', () => {
        console.warn(`EnemySprites: failed to load atlas for "${slug}"`);
    });

    atlasImages.set(slug, image);
    return image;
}

// =============================================================================
// CHARACTER SELECTION
// =============================================================================

/**
 * Picks a random character.
 *
 * The roster is settled: each Doom monster names its character in
 * js/monsters.js, and Enemy.assignSprite() uses that. This is the fallback for
 * a monster whose character is missing from the manifest, so a stale build
 * costs the right look rather than any look.
 *
 * @param {() => number} [random] - Injectable RNG, for deterministic tests
 * @returns {string|null} A character slug, or null if none are loaded
 */
export function pickRandomEnemySprite(random = Math.random) {
    if (slugList.length === 0) return null;
    return slugList[Math.floor(random() * slugList.length) % slugList.length];
}

// =============================================================================
// FRAME ADDRESSING
// =============================================================================

/**
 * Resolves an animation to its slice of a character's atlas.
 *
 * Falls back through the options the art actually guarantees. Not every pack is
 * complete: `idle_blink` is missing for the back view everywhere and for one
 * direction of the Skeleton Archer, and the archer packs name their attack
 * "Shooting". The builder normalises the naming, and this resolves what is
 * genuinely absent, so a caller can always ask for any animation.
 *
 * @param {Object} meta - Manifest entry for the character
 * @param {string} animation - Animation name from ENEMY_ANIM
 * @param {string} direction - One of ENEMY_DIRECTIONS
 * @returns {{start: number, count: number, animation: string}|null} Frame range
 */
export function resolveEnemyAnimation(meta, animation, direction) {
    if (!meta || !meta.animations) return null;

    // Try the requested animation, then progressively safer stand-ins.
    const candidates = [animation];
    if (animation === ENEMY_ANIM.IDLE_BLINK) candidates.push(ENEMY_ANIM.IDLE);
    if (animation === ENEMY_ANIM.RUN) candidates.push(ENEMY_ANIM.WALK);
    if (animation === ENEMY_ANIM.WALK) candidates.push(ENEMY_ANIM.RUN);
    if (animation === ENEMY_ANIM.HURT) candidates.push(ENEMY_ANIM.IDLE);
    if (animation === ENEMY_ANIM.ATTACK) candidates.push(ENEMY_ANIM.IDLE);
    candidates.push(ENEMY_ANIM.IDLE);

    for (const name of candidates) {
        const byDirection = meta.animations[name];
        if (!byDirection) continue;

        // "all" is how the builder stores the directionless death animation.
        const range = byDirection[direction] || byDirection.all;
        if (range && range[1] > 0) {
            return { start: range[0], count: range[1], animation: name };
        }
    }

    return null;
}

/**
 * Computes the source rectangle for one frame of an animation.
 *
 * @param {Object} meta - Manifest entry for the character
 * @param {{start: number, count: number}} range - From resolveEnemyAnimation()
 * @param {number} frame - Frame offset within the animation
 * @returns {{x: number, y: number, width: number, height: number}} Atlas rect
 */
export function getEnemyFrameRect(meta, range, frame) {
    const clamped = Math.max(0, Math.min(frame, range.count - 1));
    const index = range.start + clamped;

    return {
        x: (index % meta.columns) * meta.frameWidth,
        y: Math.floor(index / meta.columns) * meta.frameHeight,
        width: meta.frameWidth,
        height: meta.frameHeight
    };
}

/**
 * Resets module state. Test-only hook; the game loads the manifest once.
 */
export function _resetEnemySpritesForTest() {
    manifest = null;
    slugList = [];
    atlasImages.clear();
}
