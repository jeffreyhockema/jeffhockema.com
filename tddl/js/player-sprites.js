/**
 * =============================================================================
 * PLAYER SPRITE SYSTEM
 * =============================================================================
 *
 * Loads and addresses the player atlases produced by tools/build_player_sprites.py.
 *
 * One character ships, `man` -- the pack's man recoloured into Doom's marine at
 * build time -- and pickRandomPlayerCharacter() picks from whatever the manifest
 * holds, so a second character is a manifest entry away. It is chosen when a
 * game starts. Each atlas holds every frame of every animation, indexed by
 * `sprites/player/manifest.json`, addressed the same way as the enemy atlases:
 *
 *     column = index % columns
 *     row    = Math.floor(index / columns)
 *
 * Unlike the enemies -- who are drawn from four fixed viewpoints -- these are
 * top-down sprites with a single facing that is *rotated* to wherever the player
 * aims. The source art aims straight down, which the manifest records as
 * `sourceAngle`; the renderer rotates by (aim - sourceAngle) about the pivot the
 * builder measured. See tools/build_player_sprites.py for how that pivot is
 * found.
 *
 * Animations are per weapon: `idle`, `walk` and `attack` each exist for pistol,
 * rifle, flamethrower, bat and knife, so the character visibly holds and uses
 * whatever is equipped. `death` is the one animation with no weapon.
 */

/** Animation kinds present in the atlases. */
export const PLAYER_ANIM = {
    IDLE: 'idle',
    WALK: 'walk',
    ATTACK: 'attack',
    DEATH: 'death'
};

/** Where the manifest and atlases live, relative to the page. */
const SPRITE_ROOT = 'sprites/player/';

/** The weapon animation set used when a weapon has no art of its own. */
const FALLBACK_WEAPON = 'flamethrower';

// =============================================================================
// MODULE STATE
// =============================================================================

/** Parsed manifest.json, or null until loadPlayerSpriteManifest() resolves. */
let manifest = null;

/** slug -> HTMLImageElement. An entry exists as soon as loading *starts*. */
const atlasImages = new Map();

/** Character keys in manifest order. */
let slugList = [];

/**
 * Loads the player sprite manifest.
 *
 * Resolves to false rather than throwing: the player renders as a circle
 * without artwork, so a failed asset load should cost polish, not the session.
 *
 * @param {string} [url] - Manifest location, overridable for tests
 * @returns {Promise<boolean>} True if a usable manifest was loaded
 */
export async function loadPlayerSpriteManifest(url = `${SPRITE_ROOT}manifest.json`) {
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

        console.log(`PlayerSprites: ${slugList.length} player characters available`);
        return slugList.length > 0;
    } catch (error) {
        console.warn(`PlayerSprites: could not load ${url} (${error.message}). ` +
                     `The player will render as a shape.`);
        manifest = null;
        slugList = [];
        return false;
    }
}

/** @returns {string[]} Every available character slug */
export function getPlayerSpriteSlugs() {
    return slugList.slice();
}

/**
 * @param {string} slug - Character key, "man"
 * @returns {Object|null} Manifest entry, or null if unknown
 */
export function getPlayerSpriteMeta(slug) {
    return manifest?.characters?.[slug] || null;
}

/** @returns {Object} Animation kind -> frames per second */
export function getPlayerFrameRates() {
    return manifest?.frameRates || {};
}

/** @returns {string[]} Animation kinds that play once instead of looping */
export function getPlayerOneShotAnimations() {
    return manifest?.oneShot || [];
}

/**
 * The direction the source artwork faces, in radians.
 *
 * The renderer rotates a sprite by (aim angle - this), so the drawn weapon
 * points wherever the player is aiming.
 *
 * @returns {number} Radians; the art aims straight down (+Y), so PI/2
 */
export function getPlayerSourceAngle() {
    return manifest?.sourceAngle ?? Math.PI / 2;
}

/**
 * Starts loading a character's atlas, or returns the in-flight/finished image.
 *
 * @param {string} slug - Character key
 * @returns {HTMLImageElement|null} The atlas image, or null for unknown slugs
 */
export function getPlayerAtlas(slug) {
    const cached = atlasImages.get(slug);
    if (cached) return cached;

    const meta = getPlayerSpriteMeta(slug);
    if (!meta) return null;

    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = `${SPRITE_ROOT}${meta.file}`;
    image.addEventListener('error', () => {
        console.warn(`PlayerSprites: failed to load atlas for "${slug}"`);
    });

    atlasImages.set(slug, image);
    return image;
}

/**
 * Picks a character at random.
 *
 * One character ships today (Doom's marine); the choice is made per game from
 * whatever the manifest holds, and when the game grows a character-select
 * screen this is the one place to replace.
 *
 * @param {() => number} [random] - Injectable RNG, for deterministic tests
 * @returns {string|null} A character slug, or null if none are loaded
 */
export function pickRandomPlayerCharacter(random = Math.random) {
    if (slugList.length === 0) return null;
    return slugList[Math.floor(random() * slugList.length) % slugList.length];
}

/**
 * Resolves an animation to its slice of a character's atlas.
 *
 * Weapons without artwork of their own -- the rocket launcher and the BFG, which
 * the sprite pack has no animations for -- borrow the flamethrower's, since a
 * bulky two-handed weapon is the closest pose the character has.
 *
 * @param {Object} meta - Manifest entry for the character
 * @param {string} kind - One of PLAYER_ANIM
 * @param {string|null} weapon - Sprite weapon key, or null for `death`
 * @returns {{start: number, count: number, weapon: string}|null} Frame range
 */
export function resolvePlayerAnimation(meta, kind, weapon) {
    if (!meta || !meta.animations) return null;

    const byWeapon = meta.animations[kind] || meta.animations[PLAYER_ANIM.IDLE];
    if (!byWeapon) return null;

    // `death` is stored under "none"; everything else is keyed by weapon.
    for (const key of [weapon, FALLBACK_WEAPON, 'none']) {
        if (!key) continue;
        const range = byWeapon[key];
        if (range && range[1] > 0) {
            return { start: range[0], count: range[1], weapon: key };
        }
    }

    // Nothing matched -- take whatever this animation does have.
    const first = Object.entries(byWeapon).find(([, range]) => range && range[1] > 0);
    return first ? { start: first[1][0], count: first[1][1], weapon: first[0] } : null;
}

/**
 * Computes the source rectangle for one frame of an animation.
 *
 * @param {Object} meta - Manifest entry for the character
 * @param {{start: number, count: number}} range - From resolvePlayerAnimation()
 * @param {number} frame - Frame offset within the animation
 * @returns {{x: number, y: number, width: number, height: number}} Atlas rect
 */
export function getPlayerFrameRect(meta, range, frame) {
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
export function _resetPlayerSpritesForTest() {
    manifest = null;
    slugList = [];
    atlasImages.clear();
}
