// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Jeff Hockema. See LICENSE and NOTICE.md.

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
 * The manifest is plain JSON; the atlases ship inside two packs (see
 * js/asset-pack.js and tools/pack_assets.py). `sprites/enemies.pak` holds the
 * characters the Doom bestiary in js/monsters.js wears -- about twenty of
 * them, ~3 MB -- and `sprites/enemies-extra.pak` the rest of the ~11 MB
 * collection. Only the first is downloaded in normal play; the extra pack is
 * fetched only if something asks for a character the first lacks, which
 * happens when the packs were built against an older roster. The loading
 * screen asks preloadEnemyAtlases() for the roster's characters before the
 * start menu appears, so no level can begin with a monster still on its shape
 * fallback. getEnemyAtlas() still starts a load on demand for anything that
 * was not preloaded.
 *
 * Every animation the source packs ship is available here:
 *   idle, idle_blink, walk, run  (looping, per direction)
 *   attack, hurt                 (one-shot, per direction)
 *   dying                        (one-shot, directionless)
 */

// =============================================================================
// ANIMATION NAMES
// =============================================================================

import { openPack, loadPackedImage, hasEntry, _resetPacksForTest } from './asset-pack.js';

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

/** Where the manifest lives, relative to the page. */
const SPRITE_ROOT = 'sprites/enemies/';

/** The pack holding the characters the bestiary wears. */
const PACK_URL = 'sprites/enemies.pak';

/** The pack holding the rest of the collection, fetched only when needed. */
const EXTRA_PACK_URL = 'sprites/enemies-extra.pak';

// =============================================================================
// MODULE STATE
// =============================================================================

/** Parsed manifest.json, or null until loadEnemySpriteManifest() resolves. */
let manifest = null;

/** slug -> HTMLImageElement. An entry exists as soon as loading *starts*. */
const atlasImages = new Map();

/** slug -> Promise<boolean>, settling once that atlas is drawable or has failed. */
const atlasReady = new Map();

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
 * Starts the bestiary's pack downloading, or returns the download under way.
 * The loading screen calls this first, to count the pack's bytes on its bar.
 *
 * @returns {{ready: Promise<Object|null>, onProgress: Function}} The pack load
 */
export function openEnemySpritePack() {
    return openPack(PACK_URL);
}

/**
 * Finds the pack an atlas is in: the bestiary's, or failing that the extra
 * one -- which is only downloaded the first time this falls through to it.
 *
 * @param {string} file - Atlas entry name, from the manifest
 * @returns {Promise<Object|null>} The pack to read it from, or null if the
 *          main pack itself never arrived (it has logged why)
 */
async function packHolding(file) {
    const main = await openEnemySpritePack().ready;
    // Without the main pack there is no network worth spending another 7 MB
    // on; every monster falls back to its shape.
    if (!main || hasEntry(main, file)) return main;

    const extra = await openPack(EXTRA_PACK_URL).ready;
    // Neither has it: hand back the main pack and let the read say "missing".
    return hasEntry(extra, file) ? extra : main;
}

/**
 * Starts loading a character's atlas, or returns the in-flight/finished image.
 *
 * Safe to call every frame: the first call creates the Image, later ones hand
 * back the same element. Callers check `.complete && .naturalHeight` before
 * drawing, which is false until the pack is in and the atlas decoded.
 *
 * @param {string} slug - Character key
 * @returns {HTMLImageElement|null} The atlas image, or null for unknown slugs
 */
export function getEnemyAtlas(slug) {
    const cached = atlasImages.get(slug);
    if (cached) return cached;

    const meta = getEnemySpriteMeta(slug);
    if (!meta) return null;

    const { image, ready } = loadPackedImage(packHolding(meta.file), meta.file, 'EnemySprites');

    atlasImages.set(slug, image);
    atlasReady.set(slug, ready);
    return image;
}

/**
 * Starts the atlases a level can use loading, and reports when each is drawable.
 *
 * The roster -- which character each Doom monster wears -- lives in
 * js/monsters.js, so the caller passes it in rather than this module importing
 * game rules. If any of those characters is missing from the manifest,
 * Enemy.assignSprite() falls back to a *random* character, which could be any
 * of them, so in that case every atlas is preloaded instead.
 *
 * @param {Iterable<string>} [slugs] - Characters the roster uses; omit for all
 * @returns {Array<{name: string, ready: Promise<boolean>}>} One entry per
 *          atlas; `ready` resolves true once it is decoded, false if it failed
 *          (that monster then renders as a shape)
 */
export function preloadEnemyAtlases(slugs) {
    let wanted = slugs ? [...new Set(slugs)] : slugList.slice();
    if (wanted.some((slug) => !getEnemySpriteMeta(slug))) {
        wanted = slugList.slice();
    }

    return wanted.map((slug) => {
        getEnemyAtlas(slug);
        return { name: slug, ready: atlasReady.get(slug) };
    });
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
 * Resets module state, and forgets the pack downloads so the next atlas
 * fetches them afresh. Test-only hook; the game loads everything once.
 */
export function _resetEnemySpritesForTest() {
    manifest = null;
    slugList = [];
    atlasImages.clear();
    atlasReady.clear();
    _resetPacksForTest(PACK_URL);
    _resetPacksForTest(EXTRA_PACK_URL);
}
