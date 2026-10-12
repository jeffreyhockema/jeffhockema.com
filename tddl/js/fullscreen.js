/**
 * @fileoverview Fullscreen, through the Fullscreen API.
 *
 * The whole page goes fullscreen (document.documentElement), not the canvas:
 * the HUD, the touch controls and every menu are HTML laid over the canvas,
 * and a fullscreen canvas would leave all of them behind on the hidden page.
 * The canvas follows on its own -- going in or out of fullscreen resizes the
 * window, and GameController re-fits the canvas on every resize.
 *
 * Safari before 16.4 only has the webkit-prefixed spelling, so every call tries
 * the standard name first and falls back to it. An iPhone has neither for
 * anything but a <video>: fullscreenSupported() is false there, and the
 * controls that would offer it are hidden rather than left doing nothing.
 *
 * Every function takes the document as an optional last argument so the tests
 * can hand in a stub; the game always uses the real one.
 */

/**
 * @returns {Document|null} The page's document, or null under node
 */
function pageDocument() {
    return typeof document !== 'undefined' ? document : null;
}

/**
 * Whether this browser can put the page into fullscreen at all.
 *
 * Both halves are needed: the request method can exist while the browser
 * reports fullscreen as disabled (an iframe without allowfullscreen, an
 * iPhone's Safari), and asking anyway only rejects.
 *
 * @param {Document} [doc] - Defaults to the page's document
 * @returns {boolean}
 */
export function fullscreenSupported(doc = pageDocument()) {
    const root = doc?.documentElement;
    if (!root) return false;

    const enabled = !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
    const canRequest = typeof root.requestFullscreen === 'function' ||
                       typeof root.webkitRequestFullscreen === 'function';
    return enabled && canRequest;
}

/**
 * @param {Document} [doc] - Defaults to the page's document
 * @returns {boolean} Whether something on the page is fullscreen right now
 */
export function isFullscreen(doc = pageDocument()) {
    return !!(doc && (doc.fullscreenElement || doc.webkitFullscreenElement));
}

/**
 * Puts the page into fullscreen. Must be called from a click or a key press:
 * browsers refuse a request that no user gesture asked for.
 *
 * @param {Document} [doc] - Defaults to the page's document
 * @returns {Promise<boolean>} Whether the request was made and not refused
 */
export async function enterFullscreen(doc = pageDocument()) {
    if (!fullscreenSupported(doc)) return false;
    const root = doc.documentElement;

    try {
        if (typeof root.requestFullscreen === 'function') {
            // navigationUI 'hide' asks Android Chrome to drop its bars as well
            await root.requestFullscreen({ navigationUI: 'hide' });
        } else {
            // The prefixed call returns nothing; failure arrives as an event
            root.webkitRequestFullscreen();
        }
        return true;
    } catch (error) {
        // Refused (no gesture, a permissions policy): stay windowed, quietly
        console.warn('Fullscreen request refused:', error);
        return false;
    }
}

/**
 * Leaves fullscreen.
 *
 * @param {Document} [doc] - Defaults to the page's document
 * @returns {Promise<boolean>} Whether there was fullscreen to leave
 */
export async function exitFullscreen(doc = pageDocument()) {
    if (!isFullscreen(doc)) return false;

    try {
        if (typeof doc.exitFullscreen === 'function') {
            await doc.exitFullscreen();
        } else if (typeof doc.webkitExitFullscreen === 'function') {
            doc.webkitExitFullscreen();
        } else {
            return false;
        }
        return true;
    } catch (error) {
        console.warn('Leaving fullscreen failed:', error);
        return false;
    }
}

/**
 * Enters fullscreen if windowed, leaves it if not.
 *
 * @param {Document} [doc] - Defaults to the page's document
 * @returns {Promise<boolean>} See enterFullscreen / exitFullscreen
 */
export function toggleFullscreen(doc = pageDocument()) {
    return isFullscreen(doc) ? exitFullscreen(doc) : enterFullscreen(doc);
}

/**
 * Calls back whenever the page enters or leaves fullscreen, however it
 * happened: one of the game's buttons, or the browser's own Esc. (F11 is the
 * browser's fullscreen rather than the page's, and fires nothing here.)
 *
 * Both spellings are listened for. A browser that fires both calls back
 * twice, which is harmless: the callback reads the state rather than
 * flipping it.
 *
 * @param {Function} callback - Called with whether the page is now fullscreen
 * @param {Document} [doc] - Defaults to the page's document
 */
export function onFullscreenChange(callback, doc = pageDocument()) {
    if (!doc?.addEventListener) return;
    const notify = () => callback(isFullscreen(doc));
    doc.addEventListener('fullscreenchange', notify);
    doc.addEventListener('webkitfullscreenchange', notify);
}
