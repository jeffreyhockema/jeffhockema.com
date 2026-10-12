// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Jeff Hockema. See LICENSE and NOTICE.md.

/**
 * =============================================================================
 * STATUS BAR
 * =============================================================================
 *
 * The bar along the bottom of the screen, laid out the way Doom's was, left to
 * right:
 *
 *     AMMO | HEALTH | ARMS | face | ARMOR | keys | ammo table
 *
 * The markup lives in index.html (#uiContainer) and is styled there; this
 * module only writes into it. Everything it shows is read off the Player, so
 * the Player's update...Display() methods all come here, and the render loop
 * calls tickStatusBar() once a frame for the parts that move on their own --
 * the face glancing about, blinking, and the timers on its expressions.
 *
 * Writes are diffed against what is already on screen. The bar is refreshed
 * from many places (every shot fired, every point of armour a pool burns
 * off), so most refreshes change nothing and touch no DOM at all; and the
 * diff is also what notices a number going up or down, which is what flashes
 * it and what makes the face react.
 *
 * THE FACE
 *
 * Doom's marine looked out of the middle of the bar and showed the state of
 * the fight: bloodier as health fell, glancing towards whatever just hurt
 * him, wincing at a big hit, grinning at a new gun, gritting his teeth when
 * the trigger had been held down a while, glowing-eyed in god mode. The face
 * here does all of that with original artwork: an SVG marine in a green
 * helmet (FACE_SVG), drawn once, whose expression is CSS keyed off three
 * data attributes on its frame -- data-tier (health, 0-4), data-mood and
 * data-look. chooseFace() decides those from the face's memory, and is pure
 * so the priorities can be tested; they are Doom's (ST_updateFaceWidget):
 *
 *     dead > grin > ouch / hurt > rampage > god > idle
 */

import { AMMO_TYPES, ARMOR } from './constants.js';

// =============================================================================
// FACE LOGIC
// =============================================================================

/** Health tiers the face is drawn in, as Doom's ST_NUMPAINFACES. */
export const FACE_TIERS = 5;

/**
 * How long each expression holds, in milliseconds. Doom counted these in tics
 * (ST_TURNCOUNT, ST_EVILGRINCOUNT, ST_RAMPAGEDELAY); these are the same
 * lengths, a touch longer for the hurt look so it can actually be read.
 */
export const FACE_TIMING = {
    HURT_MS: 1000,           // Looking towards the last hit
    OUCH_MS: 1000,           // The wince after a big one
    GRIN_MS: 2000,           // A new weapon
    RAMPAGE_AFTER_MS: 2000,  // Trigger held this long before the teeth show
    GLANCE_MIN_MS: 900,      // Idle: how long the eyes rest before moving again
    GLANCE_MAX_MS: 2600,
    BLINK_MS: 140,
    BLINK_MIN_MS: 2400,
    BLINK_MAX_MS: 6000,
};

/** One hit taking more than this many points of health is an "ouch" (ST_MUCHPAIN). */
export const MUCH_PAIN = 20;

/**
 * The face's health tier: 0 at 80% or more, down to 4 under 20%, by Doom's
 * own sum (ST_calcPainOffset), which caps health at 100 first so a
 * soulsphere's 200 is no healthier a face than 100.
 *
 * @param {number} health - Current health
 * @returns {number} 0-4
 */
export function healthTier(health) {
    const h = Math.max(0, Math.min(100, Math.ceil(Number(health) || 0)));
    return Math.min(FACE_TIERS - 1, Math.floor((100 - h) * FACE_TIERS / 101));
}

/**
 * Which way the face should look towards a hit: left, right, or straight out
 * of the bar.
 *
 * Doom turned the head by the attacker's angle relative to where the marine
 * faced. The view here is top-down and the face looks out at the player, so
 * the useful direction is the screen's: a monster to the left of the marine
 * on screen makes the face glance left. Anything within 30 degrees of
 * straight up or down the screen -- and a hit with no known source, such as
 * a hazardous floor -- is taken full-face.
 *
 * @param {{x: number, y: number}} player
 * @param {{x: number, y: number}|null} from - Where the hit came from
 * @returns {'left'|'right'|'front'}
 */
export function hurtSide(player, from) {
    if (!player || !from || !Number.isFinite(from.x) || !Number.isFinite(from.y)) return 'front';
    const dx = from.x - player.x;
    const dy = from.y - player.y;
    // tan(30 degrees): inside that cone of the vertical the hit is "in front"
    if (Math.abs(dx) <= Math.abs(dy) * 0.577) return 'front';
    return dx < 0 ? 'left' : 'right';
}

/**
 * Picks the face to show, in Doom's order of priority: dead, then the grin
 * at a new weapon, then the pain of a hit -- an "ouch" for a big one, else a
 * look towards where it came from -- then the gritted teeth of a held
 * trigger, then god mode's glowing eyes, then the idle face glancing about.
 *
 * @param {Object} face - The face's memory (see StatusBar.face)
 * @param {number} face.health
 * @param {boolean} [face.god] - God mode or invulnerability
 * @param {number} [face.grinUntil] - Timestamps (ms) the expressions hold until
 * @param {number} [face.ouchUntil]
 * @param {number} [face.hurtUntil]
 * @param {string} [face.hurtSide] - From hurtSide()
 * @param {number|null} [face.firingSince] - When the trigger went down, or null
 * @param {string} [face.glance] - Idle eye direction: left, center or right
 * @param {number} now - Current time in ms
 * @returns {{tier: number, mood: string, look: string}}
 */
export function chooseFace(face, now) {
    const tier = healthTier(face.health);
    const idleLook = face.glance || 'center';

    if (!(face.health > 0)) return { tier, mood: 'dead', look: 'center' };
    if (now < (face.grinUntil || 0)) return { tier, mood: 'grin', look: 'center' };
    if (now < (face.ouchUntil || 0)) return { tier, mood: 'ouch', look: 'center' };
    if (now < (face.hurtUntil || 0)) {
        const side = face.hurtSide === 'left' || face.hurtSide === 'right' ? face.hurtSide : 'center';
        return { tier, mood: 'hurt', look: side };
    }
    if (face.firingSince !== null && face.firingSince !== undefined &&
        now - face.firingSince >= FACE_TIMING.RAMPAGE_AFTER_MS) {
        return { tier, mood: 'rampage', look: 'center' };
    }
    if (face.god) return { tier, mood: 'god', look: idleLook };
    return { tier, mood: 'idle', look: idleLook };
}

// =============================================================================
// NUMBER FORMATTING
// =============================================================================

/**
 * The big AMMO readout: the rounds left in the pool the weapon in hand draws
 * from, or null for a weapon that takes none (the knife), which Doom left
 * blank and this bar shows as a dim dash.
 *
 * @param {Object|undefined} weapon - The current weapon
 * @returns {number|null}
 */
export function ammoReadout(weapon) {
    if (!weapon || !weapon.ammoType || !Number.isFinite(weapon.ammo)) return null;
    return Math.max(0, Math.floor(weapon.ammo));
}

/**
 * A percentage readout: health or armour, rounded up as the old HUD did, so
 * a scratch of 0.4 still reads as alive and a pool's fractions never show.
 *
 * @param {number} value
 * @returns {string} Digits only; the % sign is drawn separately
 */
export function percentText(value) {
    return String(Math.max(0, Math.ceil(Number(value) || 0)));
}

/**
 * The armour class being worn as a word for CSS: none, green or blue.
 *
 * @param {Object} player
 * @returns {'none'|'green'|'blue'}
 */
export function armorKind(player) {
    const worn = player?.armor > 0 ? player.armorClass : 0;
    if (worn === ARMOR.BLUE.armorClass) return 'blue';
    if (worn === ARMOR.GREEN.armorClass) return 'green';
    return 'none';
}

// =============================================================================
// THE FACE ARTWORK
// =============================================================================

/**
 * The marine. Original artwork, drawn for this game: a green combat helmet
 * with its visor pushed up, the face under it, and the collar of the armour.
 * Every expression's parts are present at once and CSS in index.html shows
 * the right ones for the frame's data-tier / data-mood / data-look, so a
 * change of face is one attribute write. The pupils and features sit in
 * groups the CSS slides sideways, which turns the head a little towards
 * whatever it is looking at.
 *
 * Wounds accumulate by tier (.w1 from tier 1, .w2 from tier 2, ...), as
 * Doom's faces did: a cut, then blood from under the helmet, then a swollen
 * eye and split lip, then a face that has clearly had enough.
 */
export const FACE_SVG = `
<svg class="face-art" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="faceBg" cx="50%" cy="38%" r="70%">
      <stop offset="0" stop-color="#3a2f27"/>
      <stop offset="1" stop-color="#0d0b0a"/>
    </radialGradient>
    <linearGradient id="faceSkin" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8f5c43"/>
      <stop offset="0.3" stop-color="#c9946f"/>
      <stop offset="0.62" stop-color="#c38d68"/>
      <stop offset="1" stop-color="#7f4f3b"/>
    </linearGradient>
    <linearGradient id="faceHelmet" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7f9d4e"/>
      <stop offset="0.45" stop-color="#557433"/>
      <stop offset="1" stop-color="#2c401c"/>
    </linearGradient>
    <linearGradient id="faceHelmetSide" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000" stop-opacity="0.45"/>
      <stop offset="0.3" stop-color="#000" stop-opacity="0"/>
      <stop offset="0.7" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.5"/>
    </linearGradient>
    <linearGradient id="faceVisor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4a5560"/>
      <stop offset="0.5" stop-color="#151b21"/>
      <stop offset="1" stop-color="#0a0d10"/>
    </linearGradient>
    <linearGradient id="faceArmor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6e8c42"/>
      <stop offset="1" stop-color="#2a3d1a"/>
    </linearGradient>
    <radialGradient id="faceGodGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#fff6c0"/>
      <stop offset="0.45" stop-color="#ffd23a"/>
      <stop offset="1" stop-color="#ffb000" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="faceEyeL"><path d="M33.5 51 Q40 46.8 46.5 50.6 Q40 53.8 33.5 51 Z"/></clipPath>
    <clipPath id="faceEyeR"><path d="M53.5 50.6 Q60 46.8 66.5 51 Q60 53.8 53.5 50.6 Z"/></clipPath>
  </defs>

  <rect class="face-bg" width="100" height="100" fill="url(#faceBg)"/>
  <ellipse class="face-halo" cx="50" cy="46" rx="46" ry="44" fill="url(#faceGodGlow)"/>

  <g class="face-head">
    <!-- Neck and the armour's collar -->
    <path d="M38.5 76 L61.5 76 L63 94 L37 94 Z" fill="#74472f"/>
    <path d="M0 100 L0 92 Q8 84 26 82 L38 90 Q50 95 62 90 L74 82 Q92 84 100 92 L100 100 Z" fill="url(#faceArmor)"/>
    <path d="M26 82 L38 90 Q50 95 62 90 L74 82" fill="none" stroke="#a8c070" stroke-opacity="0.35" stroke-width="0.8"/>
    <path d="M8 92 L20 87 M92 92 L80 87" stroke="#1d2a12" stroke-width="1.2"/>

    <!-- Face -->
    <path class="face-skin" d="M29 38 L29.4 60 Q30.6 73 37.5 80.5 Q43.5 86.6 50 87 Q56.5 86.6 62.5 80.5 Q69.4 73 70.6 60 L71 38 Z" fill="url(#faceSkin)"/>
    <!-- Stubble, the jaw's shadow, cheekbones and a cleft chin -->
    <path d="M30.6 63 Q32 79 42 85 Q50 88.4 58 85 Q68 79 69.4 63 Q64 75.5 50 77.6 Q36 75.5 30.6 63 Z" fill="#2b1d17" opacity="0.32"/>
    <path d="M43.5 67.6 Q50 65.8 56.5 67.6 Q50 69.8 43.5 67.6 Z" fill="#2b1d17" opacity="0.22"/>
    <path d="M32.2 58 Q34.8 63.6 38.6 66.4 M67.8 58 Q65.2 63.6 61.4 66.4" fill="none" stroke="#6b3f2c" stroke-opacity="0.28" stroke-width="1.2" stroke-linecap="round"/>
    <path d="M50 81.6 L50 84.4" stroke="#5a3526" stroke-opacity="0.6" stroke-width="0.7" stroke-linecap="round"/>
    <!-- Eye sockets in the brow's shade -->
    <ellipse cx="40" cy="49" rx="9" ry="5.5" fill="#5a3527" opacity="0.35"/>
    <ellipse cx="60" cy="49" rx="9" ry="5.5" fill="#5a3527" opacity="0.35"/>

    <g class="face-features">
      <!-- Eyes: whites, then irises that move, clipped to the lids -->
      <g class="face-eye face-eye-l">
        <path class="face-white" d="M33.5 51 Q40 46.8 46.5 50.6 Q40 53.8 33.5 51 Z" fill="#ece3d6"/>
        <g clip-path="url(#faceEyeL)">
          <g class="face-pupil">
            <circle class="face-iris" cx="40" cy="50.3" r="2.7" fill="#4c6b7a"/>
            <circle cx="40" cy="50.3" r="1.25" fill="#0b0d0f"/>
            <circle cx="40.9" cy="49.5" r="0.6" fill="#fff" opacity="0.8"/>
          </g>
        </g>
        <path d="M33.5 51 Q40 46.8 46.5 50.6" fill="none" stroke="#24140f" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M34.5 48.4 Q40 45.6 45.8 47.9" fill="none" stroke="#6b3f2c" stroke-opacity="0.5" stroke-width="0.6"/>
      </g>
      <g class="face-eye face-eye-r">
        <path class="face-white" d="M53.5 50.6 Q60 46.8 66.5 51 Q60 53.8 53.5 50.6 Z" fill="#ece3d6"/>
        <g clip-path="url(#faceEyeR)">
          <g class="face-pupil">
            <circle class="face-iris" cx="60" cy="50.3" r="2.7" fill="#4c6b7a"/>
            <circle cx="60" cy="50.3" r="1.25" fill="#0b0d0f"/>
            <circle cx="60.9" cy="49.5" r="0.6" fill="#fff" opacity="0.8"/>
          </g>
        </g>
        <path d="M53.5 50.6 Q60 46.8 66.5 51" fill="none" stroke="#24140f" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M54.2 47.9 Q60 45.6 65.5 48.4" fill="none" stroke="#6b3f2c" stroke-opacity="0.5" stroke-width="0.6"/>
        <!-- Swollen half shut, from tier 3 -->
        <path class="w w3" d="M52.5 51 Q60 44.5 67.5 51 Q60 50.2 52.5 51 Z" fill="#9a5a48" stroke="#2a1812" stroke-width="0.8"/>
      </g>
      <!-- God mode: the eyes burn -->
      <g class="face-godeyes">
        <ellipse cx="40" cy="50.3" rx="5" ry="2.8" fill="url(#faceGodGlow)"/>
        <ellipse cx="60" cy="50.3" rx="5" ry="2.8" fill="url(#faceGodGlow)"/>
      </g>
      <!-- Death: lids shut over rolled-back eyes -->
      <g class="face-deadeyes" fill="#8f5a42" stroke="#2a1812" stroke-width="0.9">
        <path d="M32.5 51.5 Q40 45 47.5 51.5 Q40 52.5 32.5 51.5 Z"/>
        <path d="M52.5 51.5 Q60 45 67.5 51.5 Q60 52.5 52.5 51.5 Z"/>
      </g>

      <!-- Brows, one pair per mood -->
      <g class="face-brows" fill="#3a2418">
        <path class="brow brow-idle" d="M30.5 44.6 Q38 41.6 47 44.4 L47 47 Q38 44.6 30.5 47.2 Z M53 44.4 Q62 41.6 69.5 44.6 L69.5 47.2 Q62 44.6 53 47 Z"/>
        <path class="brow brow-angry" d="M30.5 42.4 Q39 42.4 47.5 46.8 L47 49.6 Q39 45.6 30.5 45.2 Z M52.5 46.8 Q61 42.4 69.5 42.4 L69.5 45.2 Q61 45.6 53 49.6 Z"/>
        <path class="brow brow-pain" d="M30.5 47 Q39 45.4 47 41.6 L47.5 44.4 Q40 47.8 30.5 49.4 Z M53 41.6 Q61 45.4 69.5 47 L69.5 49.4 Q60 47.8 52.5 44.4 Z"/>
        <path class="brow brow-dead" d="M31 47 Q39 45.5 47 47 L47 48.6 Q39 47.4 31 48.8 Z M53 47 Q61 45.5 69 47 L69 48.8 Q61 47.4 53 48.6 Z"/>
      </g>

      <!-- Nose -->
      <path d="M48.6 50 Q47.2 56.5 45.8 61.2 Q47.6 60.4 49 60.8 Q48.2 56 49.6 50 Z" fill="#6b3f2c" opacity="0.55"/>
      <path d="M51.2 51 Q52 56 52.6 59.5" fill="none" stroke="#e8b48c" stroke-opacity="0.45" stroke-width="0.8" stroke-linecap="round"/>
      <path d="M45.6 61.8 Q47.2 64.6 50 64.2 Q52.8 64.6 54.4 61.8" fill="none" stroke="#4a2a1f" stroke-width="1" stroke-linecap="round"/>
      <path d="M48.4 66 Q50 66.8 51.6 66" fill="none" stroke="#6b3f2c" stroke-opacity="0.5" stroke-width="0.7"/>

      <!-- Mouths, one per mood -->
      <g class="face-mouths">
        <g class="mouth mouth-idle">
          <path d="M42.6 72.8 Q46 72 50 72.3 Q54 72 57.4 72.8" fill="none" stroke="#4a2219" stroke-width="1.6" stroke-linecap="round"/>
          <path d="M46 75.2 Q50 76.2 54 75.2" fill="none" stroke="#7a4434" stroke-opacity="0.45" stroke-width="0.8" stroke-linecap="round"/>
        </g>
        <g class="mouth mouth-grit">
          <path d="M41.5 70 Q50 68.6 58.5 70 L58 74.6 Q50 76 42 74.6 Z" fill="#e8e0cf" stroke="#3a1a12" stroke-width="1.2"/>
          <path d="M42 72.3 L58 72.3 M45.5 69.6 V75.2 M50 69.2 V75.6 M54.5 69.6 V75.2" stroke="#7a6a5a" stroke-width="0.6"/>
        </g>
        <g class="mouth mouth-ouch">
          <ellipse cx="50" cy="73.5" rx="5" ry="6" fill="#2a0c08" stroke="#4a2219" stroke-width="1"/>
          <path d="M45.6 70.5 Q50 68.6 54.4 70.5 L54 71.6 Q50 70.4 46 71.6 Z" fill="#e8e0cf"/>
        </g>
        <g class="mouth mouth-grin">
          <path d="M38.5 68.5 Q50 80 61.5 68.5 Q50 72.5 38.5 68.5 Z" fill="#e8e0cf" stroke="#3a1a12" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="M43 70.6 L43.6 74.4 M47 71.3 V76.2 M50 71.5 V76.8 M53 71.3 V76.2 M57 70.6 L56.4 74.4" stroke="#7a6a5a" stroke-width="0.55"/>
          <path d="M36.5 66.5 Q37.5 69 38.5 68.5 M63.5 66.5 Q62.5 69 61.5 68.5" fill="none" stroke="#6b4030" stroke-width="0.9"/>
        </g>
        <g class="mouth mouth-smirk">
          <path d="M43 72.6 Q51 74.4 58 70.2" fill="none" stroke="#4a2219" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M57.4 69.4 Q59 70 58.6 71.6" fill="none" stroke="#6b4030" stroke-width="0.8"/>
        </g>
        <g class="mouth mouth-dead">
          <path d="M43 73 Q48 71.5 57 74.5 Q51 79 43 73 Z" fill="#2a0c08" stroke="#4a2219" stroke-width="1"/>
        </g>
      </g>
    </g>

    <!-- Wounds, accumulating by tier -->
    <g class="w w1">
      <path d="M60.8 57.4 L66.6 59.6" stroke="#8c1410" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M63.6 58.6 Q64 61 63.4 63.4" fill="none" stroke="#a3170f" stroke-width="0.8" stroke-linecap="round"/>
      <ellipse cx="36" cy="64" rx="3" ry="2" fill="#4a3428" opacity="0.35"/>
    </g>
    <g class="w w2">
      <path d="M33 39 Q32 46 33.5 52 Q34 56 33 61 Q35 57 35.5 52 Q36 45 36 39 Z" fill="#9e130d"/>
      <ellipse cx="40" cy="55.5" rx="5.5" ry="2.2" fill="#6a3a4a" opacity="0.45"/>
    </g>
    <g class="w w3">
      <ellipse cx="60" cy="49.5" rx="8.5" ry="5.2" fill="#6d3550" opacity="0.5"/>
      <path d="M56 76 Q57 79 56.2 82" stroke="#9e130d" stroke-width="1.2" stroke-linecap="round" fill="none"/>
      <path d="M58 39 Q63 41 66 39 Q65 43 62 44 Q59 43 58 39 Z" fill="#9e130d" opacity="0.9"/>
    </g>
    <g class="w w4">
      <path d="M29 40 Q38 41 44 39 Q42 44 40 45 Q37 46 35 52 Q33 60 31 62 Q29 52 29 40 Z" fill="#8a0f0a" opacity="0.9"/>
      <path d="M49 63.5 Q48.6 67 49.4 69.5" stroke="#9e130d" stroke-width="1.4" stroke-linecap="round" fill="none"/>
      <path d="M64 62 Q67 66 66 72 Q63 68 62 64 Z" fill="#9e130d" opacity="0.85"/>
      <path d="M68 56 Q70 58 69.5 61" stroke="#c9d6dc" stroke-opacity="0.55" stroke-width="0.8" fill="none"/>
    </g>
    <g class="w w-dead">
      <path d="M38 78 Q44 88 50 87 Q56 86 60 80 Q54 84 50 84 Q43 84 38 78 Z" fill="#7a0c08" opacity="0.85"/>
      <path d="M44 46 Q50 52 56 44 Q54 50 50 52 Q46 51 44 46 Z" fill="#8a0f0a" opacity="0.8"/>
    </g>

    <!-- Helmet, over the top of the face -->
    <path class="face-helmet" d="M16 46 C14 21 30 6 50 6 C70 6 86 21 84 46 L84 63 Q84 67 80 67 L74 67 L72 41 Q50 33 28 41 L26 67 L20 67 Q16 67 16 63 Z" fill="url(#faceHelmet)"/>
    <path d="M16 46 C14 21 30 6 50 6 C70 6 86 21 84 46 L84 63 Q84 67 80 67 L74 67 L72 41 Q50 33 28 41 L26 67 L20 67 Q16 67 16 63 Z" fill="url(#faceHelmetSide)"/>
    <!-- Brow ridge of the shell -->
    <path d="M25 42 Q50 31 75 42 L74.5 45.5 Q50 35.5 25.5 45.5 Z" fill="#2a3b1a"/>
    <path d="M25 42 Q50 31 75 42" fill="none" stroke="#9bb86a" stroke-opacity="0.5" stroke-width="0.7"/>
    <!-- Ear guards' seams and a rivet each -->
    <path d="M26 50 L18 50 M74 50 L82 50" stroke="#22321a" stroke-width="0.9"/>
    <circle cx="21.5" cy="58" r="1.4" fill="#b7c19a"/>
    <circle cx="78.5" cy="58" r="1.4" fill="#b7c19a"/>
    <!-- Visor, pushed up onto the helmet -->
    <path class="face-visor" d="M28 25 Q50 15 72 25 L70.5 33 Q50 25 29.5 33 Z" fill="url(#faceVisor)" stroke="#1a2312" stroke-width="0.8"/>
    <path d="M34 25 Q44 20.5 54 20.5" fill="none" stroke="#cfe3f0" stroke-opacity="0.55" stroke-width="1.1" stroke-linecap="round"/>
    <!-- Shine along the dome -->
    <path d="M26 20 Q36 9 50 8.5" fill="none" stroke="#d6e8a8" stroke-opacity="0.45" stroke-width="1.4" stroke-linecap="round"/>
    <!-- At death the visor is cracked through -->
    <path class="face-crack" d="M46 21 L48.5 25 L46.5 27.5 L49.5 31.5 M48.5 25 L52 24" fill="none" stroke="#dfe9ef" stroke-opacity="0.7" stroke-width="0.6"/>
  </g>

  <!-- Hit flash, run by StatusBar.flashFace() -->
  <rect class="face-hit" width="100" height="100" fill="#ff1a0a"/>
</svg>`;

// =============================================================================
// THE STATUS BAR
// =============================================================================

/** The ammo table's rows: one per pool, in Doom's order. */
const AMMO_ROWS = Object.keys(AMMO_TYPES);

/**
 * Random number in [min, max).
 *
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function between(min, max) {
    return min + Math.random() * (max - min);
}

/**
 * Owns the DOM of the status bar.
 */
export class StatusBar {
    /**
     * @param {Document} doc - The page (a stub in the tests)
     */
    constructor(doc) {
        const byId = (id) => doc?.getElementById?.(id) || null;

        this.el = {
            ammo: byId('ammoDisplay'),
            ammoBox: byId('ammoDisplayContainer'),
            health: byId('healthDisplay'),
            healthBox: byId('healthDisplayContainer'),
            armor: byId('armorDisplay'),
            armorBox: byId('armorDisplayContainer'),
            score: byId('scoreDisplay'),
            face: byId('faceDisplay'),
            keys: {
                red: byId('redKeyIcon'),
                yellow: byId('yellowKeyIcon'),
                blue: byId('blueKeyIcon'),
            },
            slots: new Map(),     // weapon name -> { box, ammo }
            ammoRows: new Map(),  // ammo type -> { row, current, max }
        };

        for (const box of Array.from(doc?.querySelectorAll?.('[data-weapon-name]') || [])) {
            const name = box.dataset?.weaponName;
            if (name) this.el.slots.set(name, { box, ammo: box.querySelector?.('.arms-ammo') || null });
        }
        for (const type of AMMO_ROWS) {
            this.el.ammoRows.set(type, {
                row: byId(`ammoRow-${type}`),
                current: byId(`ammoCurrent-${type}`),
                max: byId(`ammoMax-${type}`),
            });
        }

        // The artwork goes in once. The check is for an <svg> already in the
        // frame, not a truthy querySelector, which every test stub returns.
        const face = this.el.face;
        if (face && typeof face.innerHTML === 'string' && !face.innerHTML.includes('<svg')) {
            face.innerHTML = FACE_SVG;
        }
        this.faceHit = face?.querySelector?.('.face-hit') || null;

        /** What is on screen now, by key; writes are skipped when it matches. */
        this.shown = new Map();

        /** The player the numbers below were last read from. */
        this.player = null;
        /** Last readings, to see what went up and what came down. */
        this.prev = null;

        /** The face's memory; see chooseFace(). */
        this.face = {
            health: 100, god: false,
            grinUntil: 0, ouchUntil: 0, hurtUntil: 0, hurtSide: 'front',
            firingSince: null, glance: 'center',
        };
        this.nextGlanceAt = 0;
        this.nextBlinkAt = 0;
        this.blinkUntil = 0;
    }

    // ---------------------------------------------------------------- writing

    /**
     * Sets an element's text if it differs from what is on screen.
     *
     * @returns {boolean} Whether anything was written
     */
    setText(key, element, text) {
        if (!element || this.shown.get(key) === text) return false;
        this.shown.set(key, text);
        element.textContent = text;
        return true;
    }

    /**
     * Sets a data attribute, likewise only on change.
     */
    setData(key, element, name, value) {
        if (!element || this.shown.get(key) === value) return;
        this.shown.set(key, value);
        if (element.dataset) element.dataset[name] = value;
    }

    /**
     * A short pulse on a number that just changed: brighter and a little
     * larger for a gain, a white flash dropping into place for a loss. The Web
     * Animations API, so a pulse can restart mid-pulse without the class
     * juggling a CSS animation needs, and does nothing where it is missing.
     *
     * @param {Element} element
     * @param {'up'|'down'} direction
     */
    pulse(element, direction) {
        if (!element || typeof element.animate !== 'function') return;
        const frames = direction === 'up'
            ? [{ filter: 'brightness(1.9)', transform: 'scale(1.12)' }, { filter: 'none', transform: 'none' }]
            : [{ filter: 'brightness(3) saturate(0)', transform: 'translateY(-0.06em)' }, { filter: 'none', transform: 'none' }];
        element.animate(frames, { duration: direction === 'up' ? 420 : 320, easing: 'ease-out' });
    }

    /**
     * A red wash over the face for a moment when the marine is hit.
     */
    flashFace() {
        if (!this.faceHit || typeof this.faceHit.animate !== 'function') return;
        this.faceHit.animate([{ opacity: 0.55 }, { opacity: 0 }], { duration: 380, easing: 'ease-out' });
    }

    // ------------------------------------------------------------- the update

    /**
     * Brings the whole bar up to date with the player.
     *
     * @param {Object} player - The Player
     * @param {number} [now] - Current time in ms
     */
    update(player, now = Date.now()) {
        if (!player) return;

        const weapon = player.weapons?.[player.currentWeaponIndex];
        const reading = {
            health: Math.max(0, Math.ceil(player.health || 0)),
            armor: Math.max(0, Math.ceil(player.armor || 0)),
            ammo: ammoReadout(weapon),
            ammoType: weapon?.ammoType || null,
            pools: { ...(player.ammo || {}) },
            owned: (player.weapons || []).filter(w => w.owned).length,
            score: window.gameState?.score ?? 0,
            hitSerial: player.hitSerial || 0,
        };

        // A new player is a new game: take its numbers as they are, with no
        // flash for "gaining" 100 health or a grin for the starting pistol.
        const prev = player === this.player ? this.prev : null;
        if (!prev) this.resetFace(now);
        this.player = player;
        this.prev = reading;

        this.updateNumbers(player, reading, prev);
        this.updateArms(player);
        this.updateAmmoTable(player, reading, prev);
        this.updateKeys(player);
        this.noteFaceEvents(player, reading, prev, now);
        this.updateFace(player, now);
    }

    /**
     * AMMO, HEALTH, ARMOR and the score.
     */
    updateNumbers(player, reading, prev) {
        const ammoText = reading.ammo === null ? '--' : String(reading.ammo);
        this.setText('ammo', this.el.ammo, ammoText);
        this.el.ammoBox?.classList?.toggle('none', reading.ammo === null);
        // Ammo flashes only on a gain: every shot spends some, and a bar that
        // flickered on each one would be noise.
        if (prev && reading.ammo !== null && prev.ammo !== null &&
            prev.ammoType === reading.ammoType && reading.ammo > prev.ammo) {
            this.pulse(this.el.ammo, 'up');
        }

        this.setText('health', this.el.health, percentText(reading.health));
        if (prev && reading.health !== prev.health && reading.health > 0) {
            this.pulse(this.el.health, reading.health > prev.health ? 'up' : 'down');
        }
        // The readout throbs at a quarter health or less
        this.el.healthBox?.classList?.toggle('low', player.health > 0 && player.health <= player.maxHealth * 0.25);

        // Armour, coloured by the class being worn: the green or blue of the
        // vest that was picked up, and dim with none, so it reads at a glance
        // which armour is on and not just how much.
        this.setText('armor', this.el.armor, percentText(reading.armor));
        const kind = armorKind(player);
        const box = this.el.armorBox?.classList;
        if (box) {
            box.toggle('armor-green', kind === 'green');
            box.toggle('armor-blue', kind === 'blue');
            box.toggle('armor-none', kind === 'none');
        }
        if (prev && reading.armor !== prev.armor) {
            this.pulse(this.el.armor, reading.armor > prev.armor ? 'up' : 'down');
        }

        this.setText('score', this.el.score, Number(reading.score).toLocaleString('en-US'));
        if (prev && reading.score > prev.score) this.pulse(this.el.score, 'up');
    }

    /**
     * ARMS: which slots are owned and which is in hand. Each slot also carries
     * its pool's count, which only the touch layout shows -- there the slots are
     * the weapon buttons and the ammo table is folded into them.
     */
    updateArms(player) {
        (player.weapons || []).forEach((weapon, index) => {
            const slot = this.el.slots.get(weapon.name);
            if (!slot) return;
            const classes = slot.box.classList;
            classes?.toggle('owned', Boolean(weapon.owned));
            classes?.toggle('current', index === player.currentWeaponIndex);
            const count = weapon.owned && weapon.ammoType && Number.isFinite(weapon.ammo)
                ? String(Math.floor(weapon.ammo)) : '';
            this.setText(`slot-${weapon.name}`, slot.ammo, count);
        });
    }

    /**
     * The table of every pool, current over maximum, with the row the weapon
     * in hand draws from picked out.
     */
    updateAmmoTable(player, reading, prev) {
        for (const [type, row] of this.el.ammoRows) {
            const current = Math.floor(player.ammo?.[type] ?? 0);
            const max = Math.floor(player.ammoMax?.[type] ?? AMMO_TYPES[type].max);
            this.setText(`pool-${type}`, row.current, String(current));
            this.setText(`max-${type}`, row.max, String(max));
            row.row?.classList?.toggle('active', reading.ammoType === type);
            row.row?.classList?.toggle('empty', current === 0);
            if (prev && current > (prev.pools[type] ?? current)) this.pulse(row.current, 'up');
        }
    }

    /**
     * The three key slots.
     */
    updateKeys(player) {
        for (const [colour, icon] of Object.entries(this.el.keys)) {
            icon?.classList?.toggle('collected', Boolean(player.keysCollected?.[colour]));
        }
    }

    // ---------------------------------------------------------------- the face

    /**
     * Forgets every expression, for a new player.
     */
    resetFace(now) {
        Object.assign(this.face, {
            grinUntil: 0, ouchUntil: 0, hurtUntil: 0, hurtSide: 'front',
            firingSince: null, glance: 'center',
        });
        this.nextGlanceAt = now + between(FACE_TIMING.GLANCE_MIN_MS, FACE_TIMING.GLANCE_MAX_MS);
        this.nextBlinkAt = now + between(FACE_TIMING.BLINK_MIN_MS, FACE_TIMING.BLINK_MAX_MS);
        this.blinkUntil = 0;
    }

    /**
     * Turns what changed since the last reading into expressions, the way
     * st_stuff.c compared its old and new values: more weapons owned is a
     * grin; a new hit (Player.hitSerial moved) or health lost is pain.
     */
    noteFaceEvents(player, reading, prev, now) {
        if (!prev || reading.health <= 0) return;

        if (reading.owned > prev.owned) {
            this.face.grinUntil = now + FACE_TIMING.GRIN_MS;
        }

        const hit = reading.hitSerial !== prev.hitSerial;
        const lost = prev.health - reading.health;
        if (hit || lost > 0) {
            // A hit the armour soaked entirely still hurts, as in Doom.
            if (lost > MUCH_PAIN) {
                this.face.ouchUntil = now + FACE_TIMING.OUCH_MS;
            }
            // One hit refreshes the bar more than once -- the armour's share,
            // then the health's -- and only the first sees the new serial, so
            // a refresh without one keeps the side a hit already chose.
            if (hit) {
                this.face.hurtSide = hurtSide(player, player.hitFrom);
            } else if (now >= this.face.hurtUntil) {
                this.face.hurtSide = 'front';
            }
            this.face.hurtUntil = now + FACE_TIMING.HURT_MS;
            this.flashFace();
        }
    }

    /**
     * Writes the chosen face to the frame.
     */
    updateFace(player, now) {
        const frame = this.el.face;
        if (!frame) return;

        this.face.health = player.health;
        this.face.god = Boolean(player.isInvulnerable?.() ?? player.godMode);
        const face = chooseFace(this.face, now);

        this.setData('face-tier', frame, 'tier', String(face.tier));
        this.setData('face-mood', frame, 'mood', face.mood);
        this.setData('face-look', frame, 'look', face.look);
        // Blinking is idle business: not mid-wince, and not when dead
        const blinking = now < this.blinkUntil && (face.mood === 'idle' || face.mood === 'god');
        this.setData('face-blink', frame, 'blink', blinking ? '1' : '0');
    }

    /**
     * The once-a-frame part: timers the face runs on its own.
     *
     * @param {Object} player
     * @param {number} now - Current time in ms
     */
    tick(player, now) {
        if (!player) return;

        // The trigger: Player.refireCount counts shots on the current pull and
        // goes back to 0 when the button is let go.
        if (player.refireCount > 0 && player.health > 0) {
            if (this.face.firingSince === null) this.face.firingSince = now;
        } else {
            this.face.firingSince = null;
        }

        // Idle glances: mostly straight ahead, sometimes to one side, never
        // twice the same way in a row so a change is always visible.
        if (now >= this.nextGlanceAt) {
            const options = ['center', 'center', 'left', 'right'].filter(look => look !== this.face.glance);
            this.face.glance = options[Math.floor(Math.random() * options.length)];
            const hold = this.face.glance === 'center' ? 1.4 : 0.7;
            this.nextGlanceAt = now + hold * between(FACE_TIMING.GLANCE_MIN_MS, FACE_TIMING.GLANCE_MAX_MS);
        }
        if (now >= this.nextBlinkAt) {
            this.blinkUntil = now + FACE_TIMING.BLINK_MS;
            this.nextBlinkAt = now + between(FACE_TIMING.BLINK_MIN_MS, FACE_TIMING.BLINK_MAX_MS);
        }

        this.update(player, now);
    }
}

// =============================================================================
// MODULE INTERFACE
// =============================================================================

/** The page's one status bar, made on first use so it finds the markup. */
let statusBar = null;

/**
 * @returns {StatusBar|null} The status bar, or null with no document
 */
function getStatusBar() {
    if (!statusBar && typeof document !== 'undefined') statusBar = new StatusBar(document);
    return statusBar;
}

/**
 * Builds the bar at page load, so the marine is in his frame behind the start
 * menu rather than an empty box until the first game.
 */
export function initStatusBar() {
    getStatusBar();
}

/**
 * Refreshes the bar from the player. Called by every Player method that
 * changes something the bar shows.
 *
 * @param {Object} player
 */
export function updateStatusBar(player) {
    getStatusBar()?.update(player, Date.now());
}

/**
 * Advances the face's own timers and refreshes the bar; once a frame from the
 * render loop.
 *
 * @param {Object} player
 */
export function tickStatusBar(player) {
    getStatusBar()?.tick(player, Date.now());
}
