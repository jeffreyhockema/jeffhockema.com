/**
 * AUDIO SYSTEM MODULE
 *
 * What every game event sounds like.
 *
 * The sounds are the Doom Sound Bulb pack: a 16-bit remaster of Doom's 1993
 * sound set under Doom's own lump names, plus its Extras, which give each
 * monster a pain and idle voice of its own where Doom made several share one,
 * and add the sounds Doom never had (a real chaingun, the Mancubus's shot, the
 * Arch-vile's raise). They are used the way Doom uses them -- the pump of the
 * shotgun a beat after the shot, each monster with its own sight, pain, idle,
 * attack and death voice, and everything placed in the world with Doom's own
 * panning and distance falloff. tools/build_sounds.py extracts them from the
 * WAD and PK3 into sounds/; see the README there.
 *
 * Two kinds of sound remain synthesised in js/audio-engine.js, because Doom has
 * no sample for them: things Doom never made a sound for (the empty
 * click of a dry weapon, the low-health heartbeat) and the menu music.
 *
 * The public API is the same set of play* functions the rest of the game has
 * always called, with an optional `at` on anything that happens somewhere in
 * the world. If audio has not started, or the browser has no Web Audio at all,
 * every one of them is a silent no-op.
 *
 * @author TDDL Game Team
 * @version 3.0.0
 */

import { AUDIO_COOLDOWNS, TILE_SIZE } from './constants.js';
import {
    ensureContext, startAudio, isReady, contextState, now, nowMs,
    voice, noiseLayer, toneLayer, metalRing, sustainedVoice,
    loopingNoise, createFilter, attachLfo,
    loadSamples, hasSample, sampleDuration, playSample, loadedSamples,
    duck, rand, pick, setMasterVolume, getMasterVolume, setMuted, isMuted,
    disposeEngine, engineStats,
} from './audio-engine.js';

// =============================================================================
// THE SOUND SET
// =============================================================================

/**
 * Where the samples live. Resolved against this module's own URL rather than
 * the page's, so the sound lab under tools/ finds them as well as index.html.
 * Node has import.meta.url too, but the tests serve files off disk by path and
 * need the plain relative form.
 */
const SOUND_ROOT = (typeof document !== 'undefined' && import.meta.url)
    ? new URL('../sounds/', import.meta.url).href
    : 'sounds/';

/**
 * Every lump the game uses, by Doom's names. The list is the manifest: a sound
 * not named here is never fetched, and a name here without a file in sounds/
 * fails the audio test suite.
 */
export const SAMPLE_NAMES = [
    // Player weapons
    'dspistol', 'dsshotgn', 'dssgcock', 'dschngun', 'dsrlaunc', 'dsplasma', 'dsbfg',
    'dspunch', 'dsskepch', 'dsskeswg',
    // Impacts
    'dsbarexp', 'dsexplo1', 'dsexplo2', 'dsrxplod', 'dsfirxpl', 'dsslop',
    // The player
    'dsplpain', 'dspldeth', 'dsnoway',
    // Monster attacks
    'dsfirsht', 'dsclaw', 'dssgtatk', 'dssklatk', 'dsskeatk', 'dsmanatk', 'dsmnshot',
    'dsvilatk', 'dsflamst', 'dsvilrai', 'dsssgun',
    // Monster voices
    'dsposit1', 'dsposit2', 'dsposit3', 'dspopain', 'dsposact',
    'dspodth1', 'dspodth2', 'dspodth3',
    'dssssit', 'dssspain', 'dsssdth',
    'dsbgsit1', 'dsbgsit2', 'dsbgpain', 'dsbgact', 'dsbgdth1', 'dsbgdth2',
    'dssgtsit', 'dsdmpain', 'dsdmact', 'dssgtdth',
    'dssklpn', 'dssklact', 'dsskldth',
    'dscacsit', 'dscacpai', 'dscacact', 'dscacdth',
    'dsbrssit', 'dsbrpain', 'dsbract', 'dsbrsdth',
    'dskntsit', 'dskntpai', 'dskntact', 'dskntdth',
    'dsskesit', 'dsskepai', 'dsskeact', 'dsskedth',
    'dsmansit', 'dsmnpain', 'dsmanact', 'dsmandth',
    'dsbspsit', 'dsbsppai', 'dsbspact', 'dsbspdth', 'dsbspwlk',
    'dspesit', 'dspepain', 'dspeact', 'dspedth',
    'dsvilsit', 'dsvipain', 'dsvilact', 'dsvildth',
    'dscybsit', 'dscybpai', 'dscybact', 'dscybdth', 'dshoof', 'dsmetal',
    'dsspisit', 'dssppain', 'dsspiact', 'dsspidth',
    // Items, doors, switches, menus
    'dsitemup', 'dswpnup', 'dsgetpow', 'dsdoropn', 'dsdorcls', 'dsswtchn', 'dsstnmov',
    'dspstop', 'dstelept',
];

/**
 * The monster voices, keyed by the `sounds` field of a monster definition in
 * monsters.js. Doom's own assignments, with the Sound Bulb Extras filling in
 * where Doom economised: the Cacodemon, Baron, Knight, Cyberdemon and the rest
 * each get a pain and idle voice of their own instead of the shared grunt. The
 * Demon and Spectre still share one voice, and the three zombies another,
 * because in Doom they are the same creature.
 *
 * A list means one is picked at random each time. `windup` plays as an attack
 * begins (the Mancubus's bellow, the Arch-vile's flame igniting), `attack` as
 * each shot leaves. `step` names the footfalls the heavy monsters make,
 * `stepEvery` how many moving frames apart. `full` marks the two bosses whose
 * sight and death cries Doom plays at full volume from nowhere in particular,
 * so the whole map hears them.
 */
export const MONSTER_VOICES = {
    zombie: {
        sight: ['dsposit1', 'dsposit2', 'dsposit3'], pain: 'dspopain', active: 'dsposact',
        death: ['dspodth1', 'dspodth2', 'dspodth3'],
    },
    ss: { sight: 'dssssit', pain: 'dssspain', active: 'dsposact', death: 'dsssdth' },
    imp: {
        sight: ['dsbgsit1', 'dsbgsit2'], pain: 'dsbgpain', active: 'dsbgact',
        death: ['dsbgdth1', 'dsbgdth2'], attack: 'dsfirsht', melee: 'dsclaw',
    },
    demon: { sight: 'dssgtsit', pain: 'dsdmpain', active: 'dsdmact', death: 'dssgtdth', melee: 'dssgtatk' },
    lost_soul: { pain: 'dssklpn', active: 'dssklact', death: 'dsskldth', attack: 'dssklatk' },
    cacodemon: { sight: 'dscacsit', pain: 'dscacpai', active: 'dscacact', death: 'dscacdth', attack: 'dsfirsht' },
    baron: {
        sight: 'dsbrssit', pain: 'dsbrpain', active: 'dsbract', death: 'dsbrsdth',
        attack: 'dsfirsht', melee: 'dsclaw',
    },
    hell_knight: {
        sight: 'dskntsit', pain: 'dskntpai', active: 'dskntact', death: 'dskntdth',
        attack: 'dsfirsht', melee: 'dsclaw',
    },
    revenant: {
        sight: 'dsskesit', pain: 'dsskepai', active: 'dsskeact', death: 'dsskedth',
        attack: 'dsskeatk', melee: 'dsskepch',
    },
    mancubus: {
        sight: 'dsmansit', pain: 'dsmnpain', active: 'dsmanact', death: 'dsmandth',
        windup: 'dsmanatk', attack: 'dsmnshot',
    },
    arachnotron: {
        sight: 'dsbspsit', pain: 'dsbsppai', active: 'dsbspact', death: 'dsbspdth',
        attack: 'dsplasma', step: ['dsbspwlk'], stepEvery: 20,
    },
    pain_elemental: { sight: 'dspesit', pain: 'dspepain', active: 'dspeact', death: 'dspedth', attack: 'dssklatk' },
    archvile: {
        sight: 'dsvilsit', pain: 'dsvipain', active: 'dsvilact', death: 'dsvildth',
        attack: 'dsvilatk', windup: 'dsflamst',
    },
    cyberdemon: {
        sight: 'dscybsit', pain: 'dscybpai', active: 'dscybact', death: 'dscybdth',
        attack: 'dsrlaunc', step: ['dshoof', 'dsmetal'], stepEvery: 10, full: true,
    },
    spider_mastermind: {
        sight: 'dsspisit', pain: 'dssppain', active: 'dsspiact', death: 'dsspidth',
        step: ['dsmetal'], stepEvery: 10, full: true,
    },
};

// =============================================================================
// PLACEMENT
// =============================================================================

/**
 * Doom's distance model, converted from map units to pixels: a tile is 64
 * map units and TILE_SIZE pixels.
 *
 * Inside S_CLOSE_DIST a sound is at full volume; beyond S_CLIPPING_DIST it is not
 * started at all; between the two it falls off linearly. That hard clip is a
 * feature -- a fight two rooms over is inaudible, then a door opens and it is
 * suddenly not.
 */
const UNIT = TILE_SIZE / 64;
const CLOSE_DIST = 200 * UNIT;
const CLIP_DIST = 1200 * UNIT;

/** Doom's S_STEREO_SWING as a fraction of full pan: nothing is ever hard left. */
const STEREO_SWING = 0.75;

/** Horizontal distance at which a sound reaches full swing. */
const PAN_REACH = 5 * TILE_SIZE;

/**
 * A touch of the shared room on everything. Doom itself is bone dry; this is
 * low enough to read as the game's mix rather than as reverb.
 */
const ROOM_SEND = 0.06;

/**
 * Default random pitch spread, as a fraction. Doom v1.1 shifted every sound a
 * little; later versions turned it off. It is kept on here for the sounds that
 * repeat -- weapons and monsters -- and off for doors, switches and menus, which
 * are machines and should sound like the same machine every time.
 */
const PITCH_DRIFT = 0.03;

/**
 * Where the player is. Read lazily from the game rather than pushed in every
 * frame: the audio module is called from entities that already reach the game
 * state the same way, and a sound played before a level exists is simply
 * unpositioned.
 *
 * @returns {{x: number, y: number}|null}
 */
function listener() {
    const player = typeof window !== 'undefined' ? window.gameState?.player : null;
    return player && Number.isFinite(player.x) ? { x: player.x, y: player.y } : null;
}

/**
 * Works out how loud and how far to the side a sound at a world position is.
 *
 * @param {{x: number, y: number}} at - World position of the sound
 * @returns {{gain: number, pan: number}|null} Null if it is out of earshot
 */
export function spatialise(at) {
    const ear = listener();
    if (!ear || !at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) {
        return { gain: 1, pan: 0 };
    }

    const dx = at.x - ear.x;
    const dy = at.y - ear.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist >= CLIP_DIST) return null;

    const gain = dist <= CLOSE_DIST ? 1 : (CLIP_DIST - dist) / (CLIP_DIST - CLOSE_DIST);
    const pan = Math.max(-1, Math.min(1, dx / PAN_REACH)) * STEREO_SWING;
    return { gain, pan };
}

// =============================================================================
// STATE
// =============================================================================

/**
 * Cooldown bookkeeping in wall-clock milliseconds, so the limits hold whether
 * or not the audio context is running.
 */
const lastPlayed = {
    playerHit: 0,
    uiClick: 0,
    uiHover: 0,
    lowHealth: 0,
    itemPickup: 0,
    weaponSwitch: 0,
    enemyGun: 0,
    enemyShoot: 0,
    enemySight: 0,
    enemyPain: 0,
    enemyActive: 0,
    enemyStep: 0,
    enemyDeath: 0,
    door: 0,
};

/** Handle for the menu music loop's re-schedule. */
let menuMusicTimer = null;

/** Ambient drone handle, created on first use. */
let ambientVoice = null;

/** Resolves once the sample set has been fetched and decoded. */
let samplesLoading = null;

/**
 * Returns true when a cooldown has elapsed, and stamps it if so.
 *
 * @param {string} key - Key in `lastPlayed`
 * @param {number} ms - Minimum gap in milliseconds
 * @returns {boolean} True if the caller should play the sound
 */
function ready(key, ms) {
    if (!isReady()) return false;
    const t = nowMs();
    if (t - lastPlayed[key] < ms) return false;
    lastPlayed[key] = t;
    return true;
}

/**
 * Stops every source in a list, ignoring ones already stopped or torn down.
 *
 * @param {Array<AudioScheduledSourceNode|null>} sources
 */
function stopAll(sources) {
    for (const source of sources) {
        if (!source) continue;
        try { source.stop(); } catch (error) { /* already stopped */ }
    }
}

// =============================================================================
// PLAYING A SAMPLE
// =============================================================================

/**
 * Plays one Doom sound.
 *
 * This is the whole sample path: pick the lump, place it in the world, drift
 * the pitch, open a voice and play. Every sampled sound in this file goes
 * through here.
 *
 * @param {string|string[]} name - Lump name, or a list to pick from at random
 * @param {Object} [opts]
 * @param {{x: number, y: number}} [opts.at] - World position; omit for the player's own sounds
 * @param {boolean} [opts.full=false] - Ignore position: full volume, centred
 * @param {number} [opts.gain=1] - Level
 * @param {number} [opts.drift=PITCH_DRIFT] - Random pitch spread; 0 for none
 * @param {number} [opts.rate] - Fixed playback rate, overriding drift
 * @param {number} [opts.delay=0] - Seconds to wait before starting
 * @param {number} [opts.send=ROOM_SEND] - Reverb send
 * @param {string} [opts.bus='impact'] - Mix bus
 * @param {boolean} [opts.priority=false] - Skip the voice budget
 * @returns {GainNode|null} The voice, or null if nothing played
 */
function sfx(name, opts) {
    if (!isReady()) return null;

    const o = opts || {};
    const lump = Array.isArray(name) ? pick(name) : name;
    if (!hasSample(lump)) return null;

    let gain = o.gain === undefined ? 1 : o.gain;
    let pan = 0;
    if (o.at && !o.full) {
        const placed = spatialise(o.at);
        if (!placed) return null;
        gain *= placed.gain;
        pan = placed.pan;
    }

    const drift = o.drift === undefined ? PITCH_DRIFT : o.drift;
    const rate = o.rate !== undefined ? o.rate : rand(1 - drift, 1 + drift);
    const delay = o.delay || 0;

    const v = voice({
        dur: delay + sampleDuration(lump) / rate + 0.1,
        gain,
        pan,
        send: o.send === undefined ? ROOM_SEND : o.send,
        bus: o.bus || 'impact',
        priority: !!o.priority,
    });
    if (!v) return null;

    playSample(v, { name: lump, when: now() + delay, rate });
    return v;
}

/**
 * @param {string} voiceName - A key of MONSTER_VOICES
 * @returns {Object|null} The voice table, or null for an unknown monster
 */
function monsterVoice(voiceName) {
    return MONSTER_VOICES[voiceName] || null;
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Prepares the audio system and starts fetching the sound set.
 *
 * The context is created suspended so the mix graph is built -- and the samples
 * decoded -- before the user's first click, not during it.
 *
 * @async
 * @returns {Promise<number>} How many samples loaded
 */
export async function initializeAudio() {
    try {
        ensureContext();
    } catch (error) {
        console.warn('Warning during audio preparation:', error);
    }
    return preloadSounds();
}

/**
 * Fetches and decodes every sample in SAMPLE_NAMES. Idempotent: repeated calls
 * share the first load.
 *
 * @async
 * @returns {Promise<number>} How many samples are playable
 */
export function preloadSounds() {
    // No Web Audio, no point fetching two megabytes it could never play. This is
    // also the headless-test path, which would otherwise log a warning per file.
    if (contextState() === 'unavailable') return Promise.resolve(0);

    if (!samplesLoading) {
        samplesLoading = loadSamples(SAMPLE_NAMES.map(name => [name, `${SOUND_ROOT}${name}.wav`]))
            .then((count) => {
                if (count < SAMPLE_NAMES.length) {
                    console.warn(`Audio: ${SAMPLE_NAMES.length - count} of ${SAMPLE_NAMES.length} sounds failed to load`);
                } else {
                    console.log(`Audio: ${count} sounds ready`);
                }
                return count;
            });
    }
    return samplesLoading;
}

/**
 * Starts or resumes audio. Must be called from a user gesture -- browsers
 * refuse to start an AudioContext otherwise. Safe and cheap to call on every
 * input.
 *
 * @async
 */
export async function ensureAudioAndSynths() {
    await startAudio();
    preloadSounds();
}

/**
 * @returns {{loaded: number, total: number}} Sample loading progress
 */
export function soundStats() {
    return { loaded: loadedSamples().length, total: SAMPLE_NAMES.length };
}

// =============================================================================
// PLAYER WEAPONS
// =============================================================================

/**
 * Plays the firing sound for a weapon.
 *
 * Doom's assignments. The fist makes no sound of its own until it connects.
 *
 * @param {string} weaponName - Name of the weapon being fired
 */
export function playShootSound(weaponName) {
    if (!isReady()) return;

    switch (weaponName) {
        case 'Pistol':
            sfx('dspistol', { bus: 'weapon' });
            break;

        case 'Rifle':
            // Doom's chaingun was the pistol sample fired faster; the Extras give
            // it a sound of its own. The drift keeps a held trigger from sounding
            // like one looped sample.
            sfx('dschngun', { bus: 'weapon', gain: 0.9, drift: 0.045 });
            break;

        case 'Shotgun':
            sfx('dsshotgn', { bus: 'weapon' });
            // The pump, during the reload frames. Mechanical: no drift.
            sfx('dssgcock', { bus: 'weapon', gain: 0.8, drift: 0, delay: 0.55 });
            break;

        case 'Rocket Launcher':
            sfx('dsrlaunc', { bus: 'weapon' });
            break;

        case 'Plasma Gun':
            sfx('dsplasma', { bus: 'weapon', gain: 0.85, drift: 0.04 });
            break;

        case 'BFG':
            // One long sample covers the charge and the discharge.
            sfx('dsbfg', { bus: 'weapon', priority: true });
            break;

        case 'Knife':
            // Doom's fist is silent on the swing; the Revenant's swing whoosh
            // stands in so a jab at empty air still registers. The hit is
            // playMeleeHitSound.
            sfx('dsskeswg', { bus: 'weapon', gain: 0.6 });
            break;

        default:
            sfx('dspistol', { bus: 'weapon' });
            break;
    }
}

/**
 * A melee weapon connecting: Doom's punch.
 *
 * @param {boolean} [heavy=false] - A heavier blow: the Revenant's punch sample
 */
export function playMeleeHitSound(heavy = false) {
    sfx(heavy ? 'dsskepch' : 'dspunch', { bus: 'weapon' });
}

/**
 * Dry fire. Doom has no sound for this (it switches weapons instead), so it is
 * the one weapon sound still synthesised: two clicks of a mechanism with
 * nothing to move.
 */
export function playEmptyGunSound() {
    if (!isReady()) return;

    const t = now();
    const v = voice({ dur: 0.4, gain: 0.6, send: 0.1, bus: 'weapon' });
    if (!v) return;

    noiseLayer(v, { when: t, dur: 0.012, gain: 0.5, filter: 'bandpass', freq: 1500, q: 2 });
    metalRing(v, { when: t, freqs: [1200, 2050], dur: 0.06, gain: 0.1, spread: 0.6 });
    noiseLayer(v, { when: t + 0.045, dur: 0.01, gain: 0.3, filter: 'bandpass', freq: 2600, q: 2 });
    metalRing(v, { when: t + 0.05, freqs: [3400, 5200], dur: 0.09, gain: 0.04, spread: 0.5 });
}

/**
 * Weapon switch. Doom is silent here too; a quiet synthesised clack stays so the
 * change registers without looking at the HUD.
 */
export function playWeaponSwitchSound() {
    if (!ready('weaponSwitch', 150)) return;

    const t = now();
    const v = voice({ dur: 0.4, gain: 0.45, send: 0.1, bus: 'ui' });
    if (!v) return;

    noiseLayer(v, { when: t, dur: 0.02, gain: 0.45, filter: 'bandpass', freq: 1100, q: 1.8, drive: 2 });
    metalRing(v, { when: t, freqs: [640, 1080, 1710], dur: 0.1, gain: 0.14, spread: 0.6 });
    noiseLayer(v, { when: t + 0.07, dur: 0.02, gain: 0.4, filter: 'bandpass', freq: 1900, q: 1.8 });
    metalRing(v, { when: t + 0.07, freqs: [980, 1590, 2470], dur: 0.14, gain: 0.12, spread: 0.6 });
}

// =============================================================================
// IMPACTS
// =============================================================================

/**
 * The player taking damage.
 */
export function playPlayerHitSound() {
    if (!ready('playerHit', 150)) return;
    sfx('dsplpain', { bus: 'impact', priority: true });
}

/**
 * A rocket going off.
 *
 * @param {{x: number, y: number}} [at] - Where it exploded
 */
export function playRocketExplosionSound(at) {
    const v = sfx('dsbarexp', { at, send: 0.2, bus: 'impact', priority: true });
    if (v) duck(0.75, 0.08, 0.4);
}

/**
 * A barrel going off. Doom used the rocket's sample; the Extras add two more,
 * and a chain of barrels sounds better for not being the same one three times.
 *
 * @param {{x: number, y: number}} [at] - Where it exploded
 */
export function playBarrelExplosionSound(at) {
    const v = sfx(['dsbarexp', 'dsexplo1', 'dsexplo2'], { at, send: 0.2, bus: 'impact', priority: true });
    if (v) duck(0.75, 0.08, 0.4);
}

/**
 * The BFG ball detonating.
 *
 * @param {{x: number, y: number}} [at] - Where it hit
 */
export function playBFGImpactSound(at) {
    const v = sfx('dsrxplod', { at, send: 0.2, bus: 'impact', priority: true });
    if (v) duck(0.7, 0.1, 0.5);
}

/**
 * A corpse being raised by the Arch-vile. Doom reused the gib sound here; the
 * Extras have one for the purpose.
 *
 * @param {{x: number, y: number}} [at] - The corpse
 */
export function playResurrectSound(at) {
    sfx('dsvilrai', { at, bus: 'enemy' });
}

// =============================================================================
// MONSTERS
// =============================================================================

/**
 * The samples a monster's gun fires, by the `gun` field of its missile spec.
 * A Zombieman is the pistol and a Shotgun Guy exactly the shotgun, as in Doom;
 * the chaingun and the SS's gun are the Extras' own.
 */
const GUN_SAMPLES = {
    rifle: 'dspistol',
    shotgun: 'dsshotgn',
    chaingun: 'dschngun',
    ss: 'dsssgun',
};

/**
 * A monster's gun.
 *
 * @param {string} [gun='rifle'] - A key of GUN_SAMPLES
 * @param {{x: number, y: number}} [at] - The monster
 */
export function playEnemyGunSound(gun = 'rifle', at) {
    if (!ready('enemyGun', 30)) return;
    sfx(GUN_SAMPLES[gun] || GUN_SAMPLES.rifle, { at, bus: 'enemy' });
}

/**
 * A monster launching its projectile, breathing fire, or (the Lost Soul)
 * beginning its charge.
 *
 * @param {string} [voiceName] - The monster's voice
 * @param {{x: number, y: number}} [at] - The monster
 */
export function playEnemyShootSound(voiceName, at) {
    if (!ready('enemyShoot', 30)) return;
    const v = monsterVoice(voiceName);
    sfx(v && v.attack ? v.attack : 'dsfirsht', { at, bus: 'enemy' });
}

/**
 * A monster's claws or teeth on the swing.
 *
 * @param {string} [voiceName] - The monster's voice
 * @param {{x: number, y: number}} [at] - The monster
 */
export function playEnemyMeleeSound(voiceName, at) {
    const v = monsterVoice(voiceName);
    if (!v || !v.melee) return;
    sfx(v.melee, { at, bus: 'enemy' });
}

/**
 * The start of an attack that has a wind-up: the Arch-vile's flame igniting,
 * the Mancubus's bellow before its volley. Called for every missile attack, and
 * returns at once for the monsters that have none.
 *
 * @param {string} [voiceName] - The monster's voice
 * @param {{x: number, y: number}} [at] - The monster
 */
export function playEnemyWindupSound(voiceName, at) {
    const v = monsterVoice(voiceName);
    if (!v || !v.windup) return;
    sfx(v.windup, { at, bus: 'enemy' });
}

/**
 * A monster has seen the player.
 *
 * @param {string} [voiceName] - The monster's voice
 * @param {{x: number, y: number}} [at] - The monster
 */
export function playEnemySightSound(voiceName, at) {
    const v = monsterVoice(voiceName);
    if (!v || !v.sight) return;
    if (!ready('enemySight', 60)) return;
    sfx(v.sight, { at, full: !!v.full, bus: 'enemy', priority: !!v.full });
}

/**
 * A monster flinching.
 *
 * @param {string} [voiceName] - The monster's voice
 * @param {{x: number, y: number}} [at] - The monster
 */
export function playEnemyPainSound(voiceName, at) {
    const v = monsterVoice(voiceName);
    if (!v || !v.pain) return;
    if (!ready('enemyPain', 60)) return;
    sfx(v.pain, { at, bus: 'enemy' });
}

/**
 * A monster's idle noise while it hunts. Doom rolls for this every chase step,
 * so a pack is never quiet for long; the cooldown keeps it from becoming a wall.
 *
 * @param {string} [voiceName] - The monster's voice
 * @param {{x: number, y: number}} [at] - The monster
 */
export function playEnemyActiveSound(voiceName, at) {
    const v = monsterVoice(voiceName);
    if (!v || !v.active) return;
    if (!ready('enemyActive', 400)) return;
    sfx(v.active, { at, gain: 0.8, bus: 'enemy' });
}

/**
 * The footfalls of the monsters heavy enough to have them: the Cyberdemon's
 * hoof and metal, the Spider's metal, the Arachnotron's clatter.
 *
 * Called on every frame a monster moves, and returns at once for the monsters
 * that have no step sound.
 *
 * @param {string} [voiceName] - The monster's voice
 * @param {{x: number, y: number}} [at] - The monster
 * @param {number} stepFrames - How many frames this monster has moved in total
 */
export function playEnemyStepSound(voiceName, at, stepFrames) {
    const v = monsterVoice(voiceName);
    if (!v || !v.step) return;
    if (stepFrames % v.stepEvery !== 0) return;
    if (!ready('enemyStep', 40)) return;

    const lump = v.step[(stepFrames / v.stepEvery) % v.step.length];
    sfx(lump, { at, gain: 0.9, drift: 0.02, bus: 'enemy' });
}

/**
 * A monster dying.
 *
 * @param {string} [voiceName] - The monster's voice
 * @param {{x: number, y: number}} [at] - The monster
 * @param {boolean} [gibbed=false] - Blown apart rather than shot: the wet one
 */
export function playEnemyDestroySound(voiceName, at, gibbed = false) {
    if (!ready('enemyDeath', AUDIO_COOLDOWNS.ENEMY_DESTROY_SOUND_COOLDOWN)) return;

    const v = monsterVoice(voiceName);
    if (gibbed) {
        sfx('dsslop', { at, bus: 'enemy' });
        return;
    }
    if (!v || !v.death) {
        sfx('dsslop', { at, bus: 'enemy' });
        return;
    }
    sfx(v.death, { at, full: !!v.full, bus: 'enemy', priority: !!v.full });
}

// =============================================================================
// ITEMS, DOORS AND SWITCHES
// =============================================================================

/**
 * Picking up a small item. Doom uses one blip for health, ammo, armour and
 * keys alike; the rate limit is for walking through a row of shells.
 */
function itemPickup() {
    if (!ready('itemPickup', 60)) return;
    sfx('dsitemup', { drift: 0, bus: 'pickup' });
}

/** Health pickup. */
export function playHealthPickupSound() { itemPickup(); }

/** Ammunition pickup. */
export function playAmmoPickupSound() { itemPickup(); }

/** Key pickup. */
export function playKeyPickupSound() { itemPickup(); }

/**
 * A powerup: the soulsphere, the backpack. Doom's own "got power" sound.
 */
export function playPowerupSound() {
    sfx('dsgetpow', { drift: 0, bus: 'pickup', priority: true });
}

/**
 * Picking up a weapon: the bigger, lower sound Doom reserves for the ones that
 * matter.
 */
export function playWeaponPickupSound() {
    sfx('dswpnup', { drift: 0, bus: 'pickup', priority: true });
}

/**
 * A door starting to open.
 *
 * @param {{x: number, y: number}} [at] - The door
 */
export function playDoorOpenSound(at) {
    sfx('dsdoropn', { at, drift: 0, bus: 'impact' });
}

/**
 * A door starting to close.
 *
 * @param {{x: number, y: number}} [at] - The door
 */
export function playDoorCloseSound(at) {
    sfx('dsdorcls', { at, drift: 0, bus: 'impact' });
}

/**
 * A switch being thrown.
 *
 * @param {{x: number, y: number}} [at] - The switch
 */
export function playSwitchSound(at) {
    sfx('dsswtchn', { at, drift: 0, bus: 'impact' });
}

/**
 * A hidden wall sliding open.
 *
 * Doom has no secret-door sound; a moving wall is a moving floor, and a moving
 * floor is this short stone-grind lump repeated every eight tics until it
 * arrives. Four of them cover the slide.
 *
 * @param {{x: number, y: number}} [at] - The wall
 */
export function playSecretDoorOpenSound(at) {
    for (let i = 0; i < 4; i++) {
        sfx('dsstnmov', { at, drift: 0, delay: i * 0.23, bus: 'impact' });
    }
}

/**
 * Something teleporting in.
 *
 * @param {{x: number, y: number}} [at] - The destination
 */
export function playTeleportSound(at) {
    sfx('dstelept', { at, drift: 0, bus: 'enemy', priority: true });
}

/**
 * A blocked action: Doom's "no way" grunt at a locked door.
 */
export function playErrorSound() {
    sfx('dsnoway', { bus: 'ui' });
}

// =============================================================================
// MOVEMENT AND UI
// =============================================================================

/**
 * Menu selection: the switch sound, exactly as Doom's menu uses it.
 */
export function playUIClickSound() {
    if (!ready('uiClick', 60)) return;
    sfx('dsswtchn', { drift: 0, gain: 0.6, bus: 'ui' });
}

/**
 * Menu cursor movement: Doom's platform-stop tick.
 */
export function playUIHoverSound() {
    if (!ready('uiHover', 60)) return;
    sfx('dspstop', { drift: 0, gain: 0.35, bus: 'ui' });
}

/**
 * Low health. Doom has no such warning; this is a quiet synthesised heartbeat,
 * kept because the game has always given the player one.
 */
export function playLowHealthWarning() {
    if (!ready('lowHealth', 2000)) return;

    const t = now();
    const v = voice({ dur: 1.2, gain: 0.6, send: 0.2, bus: 'ui' });
    if (!v) return;

    toneLayer(v, { when: t, freq: 78, freqEnd: 40, dur: 0.16, gain: 0.55, type: 'sine' });
    noiseLayer(v, { when: t, dur: 0.05, gain: 0.12, type: 'brown', filter: 'lowpass', freq: 300 });
    toneLayer(v, { when: t + 0.3, freq: 68, freqEnd: 36, dur: 0.2, gain: 0.42, type: 'sine' });
    noiseLayer(v, { when: t + 0.3, dur: 0.06, gain: 0.09, type: 'brown', filter: 'lowpass', freq: 260 });
}

// =============================================================================
// STINGERS
// =============================================================================

/**
 * Level complete. Doom marks the exit with the switch being thrown and nothing
 * more; the intermission screen does the celebrating.
 */
export function playLevelCompleteSound() {
    sfx('dsswtchn', { drift: 0, bus: 'music', priority: true });
}

/**
 * Game over: the marine's death cry, at full volume.
 */
export function playGameOverSound() {
    sfx('dspldeth', { drift: 0, bus: 'music', priority: true });
}

// =============================================================================
// AMBIENCE AND MENU MUSIC
// =============================================================================

/**
 * A distant environmental swell: a drone an octave apart from itself with a
 * filtered gust of air across it. Quiet and wet, so it sounds like it is coming
 * from somewhere else.
 */
export function playAmbientSound() {
    if (!isReady()) return;

    const t = now();
    const v = voice({ dur: 5.0, gain: 0.6, pan: rand(-0.5, 0.5), send: 0.8, bus: 'ambient' });
    if (!v) return;

    const root = pick([49, 55, 65, 73]);
    toneLayer(v, { when: t, freq: root, dur: 3.0, attack: 1.2, gain: 0.3, type: 'sine' });
    toneLayer(v, { when: t, freq: root * 2.01, dur: 2.6, attack: 1.5, gain: 0.12, type: 'triangle', lowpass: 800 });
    noiseLayer(v, {
        when: t + 0.4, dur: 2.4, gain: 0.1, type: 'brown', attack: 1.0,
        filter: 'bandpass', freq: 200, freqEnd: 600, q: 1.6,
    });
}

/**
 * Starts a looping ambient bed of low room tone, kept alive by repeated calls.
 */
export function startAmbientBed() {
    if (!isReady()) return;

    if (!ambientVoice) {
        ambientVoice = sustainedVoice({
            gain: 0.22,
            attack: 2.0,
            release: 2.0,
            holdMs: 3000,
            send: 0.7,
            bus: 'ambient',
            build(node, at) {
                const rumble = loopingNoise('brown', at);
                const filter = createFilter('lowpass', 180, 1.2);
                if (!rumble || !filter) return null;

                rumble.connect(filter).connect(node);
                const sources = [rumble, attachLfo(filter.frequency, at, 60, 0.07)];
                return () => stopAll(sources);
            },
        });
    }
    ambientVoice.keepAlive();
}

/**
 * Stops the ambient bed.
 */
export function stopAmbientBed() {
    if (ambientVoice) ambientVoice.stop();
}

/**
 * Starts the looping menu music: a slow four-bar pad progression with a sparse
 * bell melody over it.
 */
export function startMenuMusic() {
    if (!isReady()) return;

    const t = now();
    const v = voice({ dur: 8.5, gain: 0.8, send: 0.6, bus: 'music', priority: true });
    if (!v) return;

    // Am - F - C - G, one chord per two seconds.
    const progression = [
        { at: 0.0, notes: [220, 261, 329], bass: 110 },
        { at: 2.0, notes: [174, 220, 261], bass: 87 },
        { at: 4.0, notes: [196, 261, 329], bass: 65 },
        { at: 6.0, notes: [196, 246, 293], bass: 98 },
    ];

    for (const chord of progression) {
        const when = t + chord.at;
        for (const note of chord.notes) {
            toneLayer(v, { when, freq: note, dur: 1.9, attack: 0.4, gain: 0.07, type: 'triangle', lowpass: 2600 });
        }
        toneLayer(v, { when, freq: chord.bass, dur: 1.9, attack: 0.3, gain: 0.1, type: 'sine' });
    }

    const melody = [
        { at: 0.5, freq: 659 }, { at: 1.25, freq: 587 }, { at: 2.5, freq: 523 },
        { at: 3.5, freq: 587 }, { at: 4.5, freq: 659 }, { at: 6.0, freq: 784 },
        { at: 7.0, freq: 659 },
    ];
    for (const note of melody) {
        metalRing(v, {
            when: t + note.at,
            freqs: [note.freq, note.freq * 2.01, note.freq * 3.02],
            dur: 1.1, gain: 0.08, spread: 0.6,
        });
    }

    // Loop. The handle is stored because this is a self-perpetuating chain:
    // without it, stopMenuMusic() could silence the current notes but the loop
    // would keep re-triggering the progression straight through gameplay.
    clearTimeout(menuMusicTimer);
    menuMusicTimer = setTimeout(() => {
        menuMusicTimer = null;
        startMenuMusic();
    }, 8000);
}

/**
 * Stops the menu music loop.
 */
export function stopMenuMusic() {
    clearTimeout(menuMusicTimer);
    menuMusicTimer = null;
}

// =============================================================================
// SYSTEM UTILITIES
// =============================================================================

/**
 * Releases all audio resources. The decoded samples are kept: they belong to no
 * context, and a restart should not fetch two megabytes again.
 */
export function cleanupAudio() {
    clearTimeout(menuMusicTimer);
    menuMusicTimer = null;

    if (ambientVoice) ambientVoice.stop();
    ambientVoice = null;

    disposeEngine();
    console.log('Audio resources cleaned up');
}

/**
 * @returns {string} Current audio context state
 */
export function getAudioState() {
    return contextState();
}

/**
 * @returns {boolean} True if audio is running and can play sound
 */
export function isAudioReady() {
    return isReady();
}

// Volume and diagnostics, re-exported so the rest of the game only ever imports
// from audio-system.js.
export { setMasterVolume, getMasterVolume, setMuted, isMuted, engineStats };
