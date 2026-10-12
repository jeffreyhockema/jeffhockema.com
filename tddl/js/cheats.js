/**
 * @fileoverview Doom's cheat codes.
 *
 * Typed straight into the game, no console and no Enter, exactly as in 1993:
 * the letters are matched as they arrive, and a letter that cannot continue any
 * code starts the sequence over. Case does not matter. What each code does is
 * Doom's, mapped onto what this game has:
 *
 *   IDDQD        god mode, toggled; health to 100 on the way in
 *   IDKFA        every weapon, full ammo, every key, 200 points of blue armour
 *   IDFA         the same without the keys
 *   IDCLIP       no clipping, toggled -- IDSPISPOPD is the Doom 1 spelling
 *   IDBEHOLD     lists the power-ups; IDBEHOLDV/S/I/R/A/L toggles one
 *   IDCHOPPERS   the chainsaw: here, the knife, readied
 *   IDDT         the map: the whole level, then the level and every thing on it, then off
 *   IDCLEV##     warp to level ##
 *   IDMYPOS      where you are, and a live position readout
 *
 * IDMUS is left out: there is no music to change.
 *
 * Split in two so each half can be tested on its own: CheatMatcher turns
 * keystrokes into cheats and knows nothing of the game; applyCheat() does what
 * a cheat says and knows nothing of keys. The input handler only joins them.
 *
 * @author TDDL Game Team
 */

// =============================================================================
// THE CODES
// =============================================================================

/**
 * Doom's own replies, from d_englsh.h, word for word.
 */
export const CHEAT_MESSAGES = {
    GOD_ON: 'Degreelessness Mode On',
    GOD_OFF: 'Degreelessness Mode Off',
    KFA: 'Very Happy Ammo Added',
    FA: 'Ammo (no keys) Added',
    NOCLIP_ON: 'No Clipping Mode ON',
    NOCLIP_OFF: 'No Clipping Mode OFF',
    BEHOLD: 'inVuln, Str, Inviso, Rad, Allmap, or Lite-amp',
    BEHOLD_TOGGLED: 'Power-up Toggled',
    CHOPPERS: '... doesn\'t suck - GM',
    CLEV: 'Changing Level...',
};

/**
 * IDBEHOLD's letters and the power each one toggles (see POWER_NAMES).
 */
export const BEHOLD_POWERS = {
    v: 'invulnerability',
    s: 'strength',
    i: 'invisibility',
    r: 'ironfeet',
    a: 'allmap',
    l: 'infrared',
};

/**
 * Every code, as a pattern. A letter matches itself; `#` matches any digit and
 * `?` any IDBEHOLD letter, and whatever they matched is handed to the cheat as
 * its argument.
 *
 * IDBEHOLD appears twice on purpose. Bare, it is Doom's prompt that lists the
 * powers; with a letter after it, it is the toggle. The bare one completing
 * does not end the sequence, because the longer one can still follow.
 */
const CODES = [
    { pattern: 'iddqd', id: 'god' },
    { pattern: 'idkfa', id: 'kfa' },
    { pattern: 'idfa', id: 'fa' },
    { pattern: 'idclip', id: 'noclip' },
    { pattern: 'idspispopd', id: 'noclip' },
    { pattern: 'idbehold', id: 'behold-menu' },
    { pattern: 'idbehold?', id: 'behold' },
    { pattern: 'idchoppers', id: 'choppers' },
    { pattern: 'iddt', id: 'map' },
    { pattern: 'idclev##', id: 'warp' },
    { pattern: 'idmypos', id: 'mypos' },
];

/**
 * Once the sequence so far is at least this long -- "id" -- a key that
 * continues it is taken by the cheat and does nothing else. Shorter than that
 * and it is far more likely to be play: "i" is no control, but "d" is
 * strafing right, and a player who brushes "i" and then moves right must move.
 */
const CLAIM_AFTER = 2;

/**
 * @param {string} p - One pattern character
 * @param {string} ch - One typed character, lower case
 * @returns {boolean} Whether the character fits the pattern there
 */
function fits(p, ch) {
    if (p === '#') return ch >= '0' && ch <= '9';
    if (p === '?') return Object.prototype.hasOwnProperty.call(BEHOLD_POWERS, ch);
    return p === ch;
}

/**
 * Whether a typed sequence is the start of a pattern (or all of it).
 *
 * @param {string} typed - Lower case
 * @param {string} pattern - A CODES pattern
 * @returns {boolean}
 */
function isPrefixOf(typed, pattern) {
    if (typed.length > pattern.length) return false;
    for (let i = 0; i < typed.length; i++) {
        if (!fits(pattern[i], typed[i])) return false;
    }
    return true;
}

// =============================================================================
// MATCHING
// =============================================================================

/**
 * Turns keystrokes into cheats, one character at a time.
 *
 * Doom kept a pointer into each code and sent it back to the start on any
 * wrong key. This keeps one buffer for all of them, and on a wrong key keeps
 * the longest tail of what was typed that still starts a code -- so a fumbled
 * "iidkfa" or an "idid" restart still works, where Doom would have needed the
 * player to begin again cleanly. Nothing else differs.
 */
export class CheatMatcher {
    constructor() {
        /** What has been typed of the code in progress, lower case. */
        this.buffer = '';
    }

    /** Forgets anything typed so far. */
    reset() {
        this.buffer = '';
    }

    /**
     * Feeds one key.
     *
     * Only printable single characters take part: Shift, the arrows and the
     * rest are ignored outright rather than resetting the sequence, so a code
     * typed in capitals with Shift held works, as does one typed while moving.
     *
     * @param {string} key - A KeyboardEvent.key value
     * @returns {{consumed: boolean, cheat: ({id: string, arg: string}|null)}}
     *   `consumed` says the key belongs to a code in progress and should do
     *   nothing else; `cheat` is the code it completed, if it completed one
     */
    feed(key) {
        if (typeof key !== 'string' || key.length !== 1) {
            return { consumed: false, cheat: null };
        }

        const ch = key.toLowerCase();
        const before = this.buffer;
        const typed = before + ch;

        // The longest tail of what has been typed that some code starts with.
        // Usually that is all of it, or nothing.
        let next = '';
        for (let start = 0; start < typed.length; start++) {
            const tail = typed.slice(start);
            if (CODES.some(code => isPrefixOf(tail, code.pattern))) {
                next = tail;
                break;
            }
        }

        const consumed = next === typed && before.length >= CLAIM_AFTER;

        const done = CODES.find(code => code.pattern.length === next.length && isPrefixOf(next, code.pattern));
        let cheat = null;
        if (done) {
            const arg = [...done.pattern]
                .map((p, i) => (p === '#' || p === '?') ? next[i] : '')
                .join('');
            cheat = { id: done.id, arg };
        }

        // A finished code clears the buffer, unless a longer code can still
        // grow out of it (bare IDBEHOLD, waiting for its letter).
        const longer = CODES.some(code => code.pattern.length > next.length && isPrefixOf(next, code.pattern));
        this.buffer = done && !longer ? '' : next;

        return { consumed, cheat };
    }
}

/**
 * Every cheat a piece of typed text completes, in the order it completes them.
 *
 * This is how a phone enters codes: it has no keyboard to type into the game,
 * so the pause menu takes the code in a text box instead and runs it through
 * a fresh matcher here -- the same matching as typed play, so the same
 * spellings work and nothing else does. Spaces are dropped, since a phone
 * keyboard's autocorrect likes to add them.
 *
 * @param {string} text - What was typed
 * @returns {Array<{id: string, arg: string}>} The cheats it completes
 */
export function cheatsInText(text) {
    const matcher = new CheatMatcher();
    const cheats = [];
    for (const ch of String(text ?? '').replace(/\s+/g, '')) {
        const { cheat } = matcher.feed(ch);
        if (cheat) cheats.push(cheat);
    }
    return cheats;
}

// =============================================================================
// EFFECTS
// =============================================================================

/**
 * Does what a cheat says, and puts Doom's reply on the message line.
 *
 * A dead player is past helping: nothing happens, as no cheat Doom has will
 * stand a corpse back up.
 *
 * @param {{id: string, arg: string}} cheat - From CheatMatcher.feed()
 * @param {Object} gameState - The running game
 * @returns {string|null} The message shown, or null for none
 */
export function applyCheat(cheat, gameState) {
    const player = gameState?.player;
    if (!cheat || !player || player.health <= 0) return null;

    const message = runCheat(cheat, gameState, player);
    if (message) gameState.postMessage?.(message);
    return message;
}

/**
 * @param {{id: string, arg: string}} cheat - The cheat
 * @param {Object} gameState - The running game
 * @param {Object} player - Its player
 * @returns {string|null} The reply
 */
function runCheat(cheat, gameState, player) {
    switch (cheat.id) {
        case 'god':
            // Doom sets health to exactly 100 on the way in, even down from a
            // soulsphere's 200. That is what the face in the status bar shows.
            player.godMode = !player.godMode;
            if (!player.godMode) return CHEAT_MESSAGES.GOD_OFF;
            player.health = player.maxHealth;
            player.updateHealthDisplay?.();
            return CHEAT_MESSAGES.GOD_ON;

        case 'kfa':
            player.collectAllGuns();
            giveCheatArmor(player);
            player.collectAllKeys();
            return CHEAT_MESSAGES.KFA;

        case 'fa':
            player.collectAllGuns();
            giveCheatArmor(player);
            return CHEAT_MESSAGES.FA;

        case 'noclip':
            player.canPhase = !player.canPhase;
            return player.canPhase ? CHEAT_MESSAGES.NOCLIP_ON : CHEAT_MESSAGES.NOCLIP_OFF;

        case 'behold-menu':
            return CHEAT_MESSAGES.BEHOLD;

        case 'behold':
            player.togglePower(BEHOLD_POWERS[cheat.arg]);
            return CHEAT_MESSAGES.BEHOLD_TOGGLED;

        case 'choppers':
            return giveChoppers(player);

        case 'map':
            // No reply, as in Doom: the map changing is the answer. Doom only
            // takes the code with the automap open; the minimap is this game's
            // automap, so it is brought up rather than the code ignored.
            gameState.mapCheat = ((gameState.mapCheat || 0) + 1) % 3;
            if (gameState.mapCheat > 0) gameState.showMinimap = true;
            return null;

        case 'warp':
            return warp(gameState, parseInt(cheat.arg, 10));

        case 'mypos':
            gameState.showCoordinates = !gameState.showCoordinates;
            return positionMessage(player);

        default:
            return null;
    }
}

/**
 * The armour IDFA and IDKFA hand over: Doom's deh_idfa_armor and
 * deh_idfa_armor_class, 200 points of the blue kind. It is set, not added, so
 * it replaces whatever was being worn -- even 200 of the same.
 */
const CHEAT_ARMOR = { points: 200, armorClass: 2 };

/**
 * @param {Object} player - The player
 */
function giveCheatArmor(player) {
    player.setArmor?.(CHEAT_ARMOR.points, CHEAT_ARMOR.armorClass);
}

/**
 * IDCHOPPERS. Doom gives the chainsaw; this game's melee weapon is the knife,
 * which the player always carries, so it is given (in case that ever changes)
 * and taken in hand -- otherwise the code would do nothing you could see.
 *
 * @param {Object} player - The player
 * @returns {string} The reply
 */
function giveChoppers(player) {
    const index = player.weapons.findIndex(w => w.isMelee || w.ammo === Infinity);
    if (index !== -1) {
        player.weapons[index].owned = true;
        player.switchWeapon(index);
    }
    return CHEAT_MESSAGES.CHOPPERS;
}

/**
 * IDCLEV. Doom silently ignores a level that does not exist; here every level
 * from 1 up exists, so only 00 is refused.
 *
 * Doom starts a new game on the target map, so the marine arrives with a
 * pistol. This keeps what the player is carrying instead: the code is for
 * getting somewhere, and arriving there stripped is rarely what was wanted.
 *
 * @param {Object} gameState - The running game
 * @param {number} level - Target level
 * @returns {string|null} The reply
 */
function warp(gameState, level) {
    if (!Number.isInteger(level) || level < 1) return null;

    gameState.clearLevelTransition?.();
    gameState.currentLevel = level;
    gameState.initLevel();
    return CHEAT_MESSAGES.CLEV;
}

/**
 * IDMYPOS's reply. Doom prints its angle and coordinates in hex fixed point;
 * this keeps the shape of the line but in plain numbers: Doom's compass angle
 * (0 is east, counter-clockwise -- the screen's y runs down, so it is flipped)
 * and the position in pixels.
 *
 * @param {Object} player - The player
 * @returns {string} The reply
 */
function positionMessage(player) {
    const degrees = ((-player.angle * 180 / Math.PI) % 360 + 360) % 360;
    return `ang=${Math.round(degrees) % 360};x,y=(${Math.round(player.x)},${Math.round(player.y)})`;
}
