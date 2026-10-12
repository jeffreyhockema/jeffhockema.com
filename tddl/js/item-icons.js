// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Jeff Hockema. See LICENSE and NOTICE.md.

/**
 * =============================================================================
 * ITEM ICON SYSTEM
 * =============================================================================
 *
 * Loads the pickup icons produced by tools/build_item_icons.py.
 *
 * These replace the coloured letter badges that weapon, health and ammo pickups
 * used to be drawn as. Not everything has art: the rocket launcher and the BFG
 * keep their badges, because the sprite pack has no icon for either. Callers ask
 * for an icon by name and fall back to a badge when `null` comes back, so adding
 * art later is a matter of baking a new icon and naming it here.
 *
 * Icons are small (a few KB each), so unlike the character atlases they are all
 * loaded as soon as the manifest lands rather than on first use, and the
 * loading screen waits on preloadItemIcons() so they are decoded before the
 * first level is drawn.
 *
 * The manifest is plain JSON; the icons themselves ship inside
 * `sprites/items.pak` (see js/asset-pack.js and tools/pack_assets.py).
 */

import { openPack, loadPackedImage, _resetPacksForTest } from './asset-pack.js';

/** Where the manifest lives, relative to the page. */
const ICON_ROOT = 'sprites/items/';

/** The pack the icons are in. */
const PACK_URL = 'sprites/items.pak';

/** Parsed manifest.json, or null until loadItemIcons() resolves. */
let manifest = null;

/** name -> HTMLImageElement, populated when the manifest loads. */
const images = new Map();

/** name -> Promise<boolean>, settling once that icon is drawable or has failed. */
const imageReady = new Map();

/**
 * Starts the icon pack downloading, or returns the download under way.
 * The loading screen calls this first, to count the pack's bytes on its bar.
 *
 * @returns {{ready: Promise<Object|null>, onProgress: Function}} The pack load
 */
export function openItemIconPack() {
    return openPack(PACK_URL);
}

/**
 * Loads the icon manifest and starts fetching every icon.
 *
 * Resolves to false rather than throwing; pickups fall back to badges.
 *
 * @param {string} [url] - Manifest location, overridable for tests
 * @returns {Promise<boolean>} True if a usable manifest was loaded
 */
export async function loadItemIcons(url = `${ICON_ROOT}manifest.json`) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!data || !data.icons || typeof data.icons !== 'object') {
            throw new Error('manifest has no icons');
        }

        manifest = data;

        const pack = openItemIconPack().ready;
        for (const [name, icon] of Object.entries(data.icons)) {
            const { image, ready } = loadPackedImage(pack, icon.file, 'ItemIcons');
            images.set(name, image);
            imageReady.set(name, ready);
        }

        console.log(`ItemIcons: ${images.size} pickup icons available`);
        return images.size > 0;
    } catch (error) {
        console.warn(`ItemIcons: could not load ${url} (${error.message}). ` +
                     `Pickups will render as badges.`);
        manifest = null;
        images.clear();
        imageReady.clear();
        return false;
    }
}

/**
 * Reports when each icon fetched by loadItemIcons() is drawable.
 *
 * Call after loadItemIcons() resolves; before that there are no images to wait
 * for and this returns an empty list.
 *
 * @returns {Array<{name: string, ready: Promise<boolean>}>} One entry per icon;
 *          `ready` resolves true once it is decoded, false if it failed (that
 *          pickup then falls back to its lettered badge)
 */
export function preloadItemIcons() {
    return [...imageReady].map(([name, ready]) => ({ name, ready }));
}

/**
 * Looks up a loaded, drawable icon.
 *
 * @param {string} name - Icon key, e.g. "pistol" or "ammo_rifle"
 * @returns {HTMLImageElement|null} The image, or null if absent or still loading
 */
export function getItemIcon(name) {
    const image = images.get(name);
    if (!image || !image.complete || image.naturalHeight === 0) return null;
    return image;
}

/**
 * Draws an icon centred on a point, scaled to fit a box without distortion.
 *
 * The icons have wildly different aspect ratios -- a bat is 8x64, a rifle 64x14
 * -- so fitting rather than stretching is what keeps them all looking like they
 * belong to the same set.
 *
 * @param {CanvasRenderingContext2D} ctx - Target context
 * @param {string} name - Icon key
 * @param {number} centerX - World X to centre on
 * @param {number} centerY - World Y to centre on
 * @param {number} size - Length of the square box to fit within
 * @returns {boolean} True if the icon was drawn; false to fall back to a badge
 */
export function drawItemIcon(ctx, name, centerX, centerY, size) {
    const image = getItemIcon(name);
    if (!image) return false;

    const scale = size / Math.max(image.naturalWidth, image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;

    ctx.drawImage(image, centerX - width / 2, centerY - height / 2, width, height);
    return true;
}

/**
 * The `size` to hand drawItemIcon so an icon carries a consistent visual
 * weight whatever shape it is.
 *
 * drawItemIcon fits an icon's *longest* side to the size it is given, which
 * only reads evenly when everything is roughly square. These are not: a
 * pistol magazine is 64x15 in the atlas and lies flat, while a shotgun shell
 * box is 51x64 and stands up. At one nominal size the magazine covers a third
 * of the box's pixels, and on a dark floor it reads as a sliver you walk past.
 *
 * Matching the geometric mean of the two sides instead gives them the same
 * visual weight. The cap then stops a long thin object stretching out of
 * proportion -- a clip should not be longer than the marine is wide.
 *
 * @param {string} name - Icon key, e.g. "ammo_pistol"
 * @param {{weight: number, max: number}} spec - Target weight and longest side
 * @returns {number} The size to pass drawItemIcon
 */
export function iconDrawSize(name, spec) {
    const icon = manifest?.icons?.[name];
    const image = images.get(name);
    const width = icon?.width || image?.naturalWidth || 0;
    const height = icon?.height || image?.naturalHeight || 0;
    if (!width || !height) return Math.min(spec.weight, spec.max);

    const longest = Math.max(width, height);
    const scale = spec.weight / Math.sqrt(width * height);
    return Math.min(longest * scale, spec.max);
}

/**
 * Resets module state, and forgets the pack download so the next load
 * fetches it afresh. Test-only hook.
 */
export function _resetItemIconsForTest() {
    manifest = null;
    images.clear();
    imageReady.clear();
    _resetPacksForTest(PACK_URL);
}
