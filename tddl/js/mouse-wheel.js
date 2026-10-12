/**
 * @fileoverview Mouse wheel: weapon cycling and Ctrl+wheel zoom.
 *
 * The wheel does what it does in the modern Doom source ports: rolled up it
 * selects the previous weapon, rolled down the next, skipping anything not
 * carried or out of ammunition and wrapping round at either end (GZDoom's
 * weapprev/weapnext). Held with Ctrl it zooms the view instead, the gesture
 * every browser and map viewer has taught people.
 *
 * Everything here is pure -- no DOM, no game globals -- so the decisions can
 * be tested in node. js/input-handler.js owns the listener and applies them.
 *
 * Why there is an accumulator at all: a wheel is not one kind of device. A
 * notched mouse sends one event of ~100-120 px per click; a trackpad sends a
 * stream of tiny ones, 1-10 px each, for as long as the fingers and then the
 * momentum keep going; Firefox may report the same notch in lines rather than
 * pixels. Acting on every event would make a trackpad swipe spin through the
 * whole arsenal, so deltas are summed and acted on once per threshold.
 */

/**
 * Tuning for the wheel. Exported so the tests read the same numbers the game
 * uses rather than restating them.
 */
export const WHEEL = {
    // Pixels one "line" is worth when deltaMode is DOM_DELTA_LINE. Firefox
    // reports a notch as 3 lines; some setups as 1. Either way it must reach
    // the weapon threshold on its own, so a line is made exactly that big.
    LINE_PX: 40,

    // Pixels one "page" is worth (DOM_DELTA_PAGE, rare: "scroll a screen at
    // a time" accessibility settings). Anything over the thresholds will do.
    PAGE_PX: 800,

    // Wheel travel for one weapon change. Below every real mouse notch seen
    // in the wild (Chrome 100-120, older Linux Chrome 53, Firefox pixel mode
    // ~48) so a click is always one switch, but well above a single trackpad
    // event so a light brush of the pad does nothing.
    WEAPON_THRESHOLD_PX: 40,

    // After a weapon change, further wheel input is thrown away for this
    // long. A trackpad swipe's stream of events, momentum tail and all, would
    // otherwise cross the threshold every few frames; with this a swipe moves
    // a few slots (about four for a full second of swiping), not the arsenal.
    // Deliberate mouse notches come further apart than this, so stepping one
    // click at a time is never lost.
    WEAPON_COOLDOWN_MS: 120,

    // Wheel travel for one zoom step. Smaller than for weapons because a
    // trackpad pinch (which Chrome reports as Ctrl+wheel with deltas of a few
    // pixels) should zoom steadily as the fingers move, not in jumps. A mouse
    // notch still makes exactly one step: the remainder is dropped.
    ZOOM_THRESHOLD_PX: 20,

    // A gap this long between wheel events ends a gesture: leftover travel
    // from a nudge a second ago must not combine with a new one to fire.
    IDLE_RESET_MS: 250,
};

/** WheelEvent.deltaMode values (named here; node has no WheelEvent). */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/**
 * The wheel travel of an event in pixels along the axis the player rolled.
 *
 * Only the vertical axis counts, except with Shift held: Chrome and Firefox
 * turn Shift+wheel into a horizontal scroll and report it in deltaX, and Shift
 * is the run key -- switching weapons mid-sprint must still work. Otherwise
 * deltaX is ignored, so a sideways trackpad swipe does not change weapons.
 *
 * @param {{deltaX?: number, deltaY?: number, deltaMode?: number, shiftKey?: boolean}} event
 * @returns {number} Positive for down (toward the player), negative for up
 */
export function wheelPixels(event) {
    let delta = event.deltaY || 0;
    if (delta === 0 && event.shiftKey) delta = event.deltaX || 0;

    if (event.deltaMode === DOM_DELTA_LINE) return delta * WHEEL.LINE_PX;
    if (event.deltaMode === DOM_DELTA_PAGE) return delta * WHEEL.PAGE_PX;
    return delta;
}

/**
 * Whether the wheel can select this weapon: carried, and with enough ammo for
 * one shot. That is the BFG's forty cells, not one -- GZDoom will not select a
 * weapon it cannot fire, and neither should this. Melee and infinite-ammo
 * weapons always qualify, so the knife is always somewhere to land.
 *
 * @param {Object} weapon - Entry from player.weapons
 * @returns {boolean} True if the wheel may stop on it
 */
export function isWheelSelectable(weapon) {
    if (!weapon || !weapon.owned) return false;
    if (weapon.isMelee || weapon.ammo === Infinity) return true;
    return weapon.ammo >= (weapon.ammoPerShot || 1);
}

/**
 * The weapon the wheel moves to from the current one.
 *
 * Walks the inventory in slot order (the order of the 1-7 keys) in the given
 * direction, wrapping round, and returns the first selectable weapon. If none
 * other is, the current index comes back unchanged and the caller does
 * nothing -- no switch sound for a switch that did not happen.
 *
 * @param {Object[]} weapons - player.weapons, in slot order
 * @param {number} currentIndex - player.currentWeaponIndex
 * @param {number} step - +1 for the next weapon (wheel down), -1 for the previous (wheel up)
 * @returns {number} Index to switch to; equal to currentIndex if there is nowhere to go
 */
export function cycleWeaponIndex(weapons, currentIndex, step) {
    const count = weapons?.length || 0;
    if (count === 0 || step === 0) return currentIndex;

    const dir = step > 0 ? 1 : -1;
    // A current index outside the list (it starts life as findIndex's -1 in
    // principle) still has to lead somewhere sensible.
    const start = currentIndex >= 0 && currentIndex < count ? currentIndex : (dir > 0 ? -1 : count);

    for (let i = 1; i <= count; i++) {
        const index = (((start + dir * i) % count) + count) % count;
        if (index === currentIndex) break;
        if (isWheelSelectable(weapons[index])) return index;
    }
    return currentIndex;
}

/**
 * Sums wheel travel and reports when it crosses a threshold.
 *
 * Each crossing fires once and empties the sum, rather than firing once per
 * multiple of the threshold: a fat 120 px notch is one switch, not three.
 * Rolling the other way also empties it, so a back-and-forth wobble on a pad
 * does not net out to a surprise. Times are passed in (event.timeStamp) so the
 * behaviour is deterministic under test.
 */
export class WheelAccumulator {
    /**
     * @param {number} threshold - Pixels of travel per step
     * @param {number} [cooldownMs=0] - Input ignored for this long after a step
     * @param {number} [idleResetMs=WHEEL.IDLE_RESET_MS] - Gap that starts a fresh gesture
     */
    constructor(threshold, cooldownMs = 0, idleResetMs = WHEEL.IDLE_RESET_MS) {
        this.threshold = threshold;
        this.cooldownMs = cooldownMs;
        this.idleResetMs = idleResetMs;
        this.reset();
    }

    /** Forgets any travel and any cooldown in progress. */
    reset() {
        this.sum = 0;
        this.lastEventTime = -Infinity;
        this.cooldownUntil = -Infinity;
    }

    /**
     * Adds an event's travel.
     *
     * @param {number} deltaPx - Travel in pixels (wheelPixels), signed
     * @param {number} now - Event time in milliseconds
     * @returns {number} +1 or -1 when a step fires in that direction, else 0
     */
    feed(deltaPx, now) {
        if (now - this.lastEventTime > this.idleResetMs) this.sum = 0;
        this.lastEventTime = now;

        if (!deltaPx) return 0;

        // Inside the cooldown, travel is discarded rather than banked: banking
        // it would just fire the next step the instant the cooldown ended.
        if (now < this.cooldownUntil) {
            this.sum = 0;
            return 0;
        }

        if (this.sum !== 0 && Math.sign(this.sum) !== Math.sign(deltaPx)) this.sum = 0;
        this.sum += deltaPx;

        if (Math.abs(this.sum) < this.threshold) return 0;

        const direction = Math.sign(this.sum);
        this.sum = 0;
        this.cooldownUntil = now + this.cooldownMs;
        return direction;
    }
}

/**
 * Whether the game is in active play, the only time the wheel changes weapon.
 *
 * Not on the start screen or the tally (gameRunning is false), not while
 * paused (pause() clears gameRunning; a `paused` flag is honoured too), not
 * after death or once the exit has been reached.
 *
 * @param {Object|null} gameState - The GameState
 * @returns {boolean} True if a weapon change makes sense right now
 */
export function isActivePlay(gameState) {
    if (!gameState || !gameState.player) return false;
    if (!gameState.gameRunning || gameState.gameOver || gameState.paused) return false;
    if (gameState.isLevelCompleting || gameState.awaitingContinue) return false;
    if (typeof gameState.isPlayerDying === 'function' && gameState.isPlayerDying()) return false;
    return true;
}
