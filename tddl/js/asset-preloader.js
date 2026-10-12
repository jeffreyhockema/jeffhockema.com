/**
 * =============================================================================
 * ASSET PRELOADER
 * =============================================================================
 *
 * The pieces behind the loading screen: a way to wait for one image to be
 * genuinely drawable, and a tracker that counts many such waits towards a
 * progress bar and says when they are all over.
 *
 * Why this exists: the sprite loaders used to create their images lazily, on the
 * first draw, so on a phone the first level was routinely on screen before the
 * marine's atlas had even been requested and he was drawn as the blue fallback
 * dot for a moment. Now main.js asks every loader for its images up front, hands
 * each wait to a LoadTracker, and keeps the start menu behind a loading screen
 * until the tracker reports that everything has settled.
 *
 * "Settled" is deliberately not "succeeded". A missing or broken asset is logged
 * and counted as done -- the renderer already has a fallback for every image
 * (shapes for characters, lettered badges for pickups) -- because a game that
 * starts with one ugly monster is better than one that never starts. For the
 * same reason the tracker gives up waiting after a stall or an overall deadline.
 */

/** How long the tracker waits with nothing finishing before it gives up. */
export const DEFAULT_STALL_MS = 15000;

/**
 * The longest the loading screen may ever hold, however steadily things trickle
 * in. Generous, because a phone on a poor connection really can need it for the
 * ~11 MB of art and sound; past it the game starts on whatever has arrived,
 * which is exactly how it behaved before there was a loading screen at all.
 */
export const DEFAULT_MAX_MS = 60000;

/**
 * Waits for an image to be loaded *and decoded*.
 *
 * A downloaded image is not yet a drawable one: the first drawImage() of a large
 * atlas decodes it on the spot, which is a visible hitch on a phone. decode()
 * does that work now, off the main thread where the browser can. Where decode()
 * is missing (old browsers, and the test stubs) this falls back to the load and
 * error events.
 *
 * Never rejects. Resolves false for a missing image or one that failed to load,
 * so callers can count it as done and let the renderer use its fallback.
 *
 * @param {HTMLImageElement|null} image - An image whose src has been set
 * @returns {Promise<boolean>} True if the image can be drawn
 */
export function whenImageReady(image) {
    if (!image) return Promise.resolve(false);

    const drawable = () => !!image.complete && image.naturalWidth > 0;

    const viaEvents = () => new Promise((resolve) => {
        // `complete` is also true for an image that has already *failed*, so the
        // size is what tells success from failure here.
        if (image.complete) {
            resolve(drawable());
            return;
        }
        image.addEventListener('load', () => resolve(true), { once: true });
        image.addEventListener('error', () => resolve(false), { once: true });
    });

    if (typeof image.decode !== 'function') return viaEvents();

    // decode() rejects for broken images, but Safari has also been known to
    // reject it for perfectly good large images it would rather decode lazily.
    // So a rejection is not trusted on its own: if the image did load it is
    // drawable, and if it is somehow still in flight the events decide.
    return image.decode().then(() => true, () => (image.complete ? drawable() : viaEvents()));
}

/**
 * Counts asynchronous asset loads towards a progress bar.
 *
 * Tasks are added with track() and may themselves add more before they settle --
 * a manifest's task tracks the atlases that manifest names -- so the total can
 * grow while loading runs. Because a child is always tracked before its parent
 * settles, `done` can never catch up with `total` while work is still being
 * discovered, and finished() cannot fire early.
 */
export class LoadTracker {
    /**
     * @param {Object} [options]
     * @param {(progress: {done: number, total: number, failed: number, label: string|null}) => void} [options.onProgress]
     *        Called whenever the counts change
     * @param {number} [options.stallMs=DEFAULT_STALL_MS] - Give up after this long with no task settling
     * @param {number} [options.maxMs=DEFAULT_MAX_MS] - Give up after this long regardless
     */
    constructor(options = {}) {
        this.onProgress = options.onProgress || null;
        this.stallMs = options.stallMs ?? DEFAULT_STALL_MS;
        this.maxMs = options.maxMs ?? DEFAULT_MAX_MS;

        this.total = 0;
        this.done = 0;
        this.failed = 0;

        /** Labels of tasks still in flight, for the timeout report. */
        this.pending = new Set();

        /** Labels of tasks that failed, for the summary. */
        this.failures = [];

        this.settled = false;
        this.resolveFinished = null;
        this.stallTimer = null;
        this.maxTimer = null;
        this.finishedPromise = null;
    }

    /**
     * Adds a load to wait for.
     *
     * The promise should resolve true on success and false on failure; a
     * rejection is treated as a failure too, so a loader that throws cannot
     * wedge the loading screen.
     *
     * @param {string} label - What is loading, for logs
     * @param {Promise<boolean>} promise - Settles when the load is over
     * @returns {Promise<boolean>} Resolves with whether the load succeeded
     */
    track(label, promise) {
        // Two tasks may share a label (a sound and an icon both called "pistol"),
        // so the pending set is keyed by a numbered copy.
        const key = `${label}#${this.total}`;
        this.total++;
        this.pending.add(key);
        this.report(null);

        return Promise.resolve(promise).then(
            (ok) => ok !== false,
            (error) => {
                console.warn(`Preloader: "${label}" threw while loading:`, error);
                return false;
            }
        ).then((ok) => {
            this.pending.delete(key);
            this.done++;
            if (!ok) {
                this.failed++;
                this.failures.push(label);
            }
            this.report(label);
            this.restartStallTimer();
            this.checkFinished();
            return ok;
        });
    }

    /**
     * @returns {number} Fraction complete, 0..1 (1 when nothing was tracked)
     */
    get fraction() {
        return this.total === 0 ? 1 : this.done / this.total;
    }

    /**
     * Resolves once every tracked load has settled, or the tracker has given
     * up waiting. Call it after the initial tasks are tracked; anything tracked
     * by those tasks before they settle is waited for too.
     *
     * @returns {Promise<{loaded: number, failed: number, total: number, timedOut: boolean, pending: string[]}>}
     */
    finished() {
        if (this.finishedPromise) return this.finishedPromise;

        this.finishedPromise = new Promise((resolve) => {
            this.resolveFinished = resolve;
        });

        if (this.maxMs > 0 && Number.isFinite(this.maxMs)) {
            this.maxTimer = setTimeout(() => this.giveUp('overall deadline'), this.maxMs);
        }
        this.restartStallTimer();
        this.checkFinished();
        return this.finishedPromise;
    }

    // -------------------------------------------------------------- internals

    /** @param {string|null} label - The task that just settled, if any */
    report(label) {
        if (!this.onProgress || this.settled) return;
        try {
            this.onProgress({ done: this.done, total: this.total, failed: this.failed, label });
        } catch (error) {
            // A broken progress bar must not stop the loading it is showing.
            console.warn('Preloader: progress callback failed:', error);
        }
    }

    restartStallTimer() {
        if (!this.resolveFinished || this.settled) return;
        if (this.stallTimer) clearTimeout(this.stallTimer);
        if (this.stallMs > 0 && Number.isFinite(this.stallMs)) {
            this.stallTimer = setTimeout(() => this.giveUp('stalled'), this.stallMs);
        }
    }

    checkFinished() {
        if (!this.resolveFinished || this.settled) return;
        if (this.done < this.total) return;
        this.settle(false);
    }

    /** @param {string} reason - Why the tracker stopped waiting */
    giveUp(reason) {
        if (this.settled) return;
        const waiting = this.pendingLabels();
        console.warn(`Preloader: ${reason} with ${waiting.length} of ${this.total} assets ` +
                     `still loading; starting without them: ${waiting.join(', ')}`);
        this.settle(true);
    }

    /** @returns {string[]} Labels still loading, without their numbering */
    pendingLabels() {
        return [...this.pending].map((key) => key.slice(0, key.lastIndexOf('#')));
    }

    /** @param {boolean} timedOut */
    settle(timedOut) {
        this.settled = true;
        clearTimeout(this.stallTimer);
        clearTimeout(this.maxTimer);
        this.resolveFinished({
            loaded: this.done - this.failed,
            failed: this.failed,
            total: this.total,
            timedOut,
            pending: this.pendingLabels(),
        });
    }
}
