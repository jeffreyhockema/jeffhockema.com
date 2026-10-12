// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Jeff Hockema. See LICENSE and NOTICE.md.

/**
 * @fileoverview Player preferences that outlast a page load.
 *
 * One so far: always run. Doom had it as a config setting (and, in later ports,
 * a menu toggle): with it on the marine runs by default and the run key walks.
 * On a touch screen it is the only way to run at all -- the move stick tops out
 * at walking pace, as the keyboard does without Shift.
 *
 * Kept in localStorage, which can be missing, full or blocked (a private
 * window, a sandboxed preview, Node in the tests). Every access is guarded and
 * the setting simply lives in memory for the session when storage fails; it is
 * a convenience, and nothing may break for want of it.
 *
 * @author TDDL Game Team
 */

const ALWAYS_RUN_KEY = 'tddl.alwaysRun';

let alwaysRun = readFlag(ALWAYS_RUN_KEY);

/**
 * @param {string} key - Storage key
 * @returns {boolean} The stored flag, or false when there is none or no storage
 */
function readFlag(key) {
    try {
        return globalThis.localStorage?.getItem(key) === '1';
    } catch {
        return false;
    }
}

/**
 * @param {string} key - Storage key
 * @param {boolean} value - Flag to store; failures are ignored
 */
function writeFlag(key, value) {
    try {
        globalThis.localStorage?.setItem(key, value ? '1' : '0');
    } catch {
        // Storage refused: the setting holds for this session only
    }
}

/** @returns {boolean} Whether the marine runs unless the run key is held */
export function isAlwaysRun() {
    return alwaysRun;
}

/**
 * @param {boolean} value - Turn always run on or off
 * @returns {boolean} The new setting
 */
export function setAlwaysRun(value) {
    alwaysRun = !!value;
    writeFlag(ALWAYS_RUN_KEY, alwaysRun);
    return alwaysRun;
}

/** @returns {boolean} The new setting, after flipping it */
export function toggleAlwaysRun() {
    return setAlwaysRun(!alwaysRun);
}

/**
 * Whether the marine runs this step: the run key held, or always run on --
 * in which case the run key walks instead, as in Doom.
 *
 * @param {boolean} runKeyHeld - Shift is down
 * @returns {boolean} True to move at running speed
 */
export function wantsToRun(runKeyHeld) {
    return alwaysRun ? !runKeyHeld : !!runKeyHeld;
}
