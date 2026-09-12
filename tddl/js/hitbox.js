/**
 * =============================================================================
 * HIT SHAPES AND SWEPT COLLISION
 * =============================================================================
 *
 * What a projectile has to cross to count as a hit, and the tests that decide
 * whether it did.
 *
 * Two problems made shots pass through sprites without landing:
 *
 *   1. The hit region was the movement circle -- a 12px radius on a monster
 *      whose drawn body is 25px wide and 37px tall and sits mostly ABOVE that
 *      circle, because the sprite is planted by its feet. A bullet through the
 *      chest missed the maths entirely.
 *
 *   2. The test was "does the bullet overlap the target right now". A rifle
 *      round moves 12px a frame and a fast monster fireball nine; a graze or a
 *      thin target could be on one side of the bullet one frame and the other
 *      side the next. Nothing overlapped, so nothing hit.
 *
 * The fix for the first is a hit shape derived from the artwork: an upright
 * box the size of the drawn body for monsters, and a circle the size of the
 * drawn body for the player, whose sprite rotates. The fix for the second is
 * to test the segment the bullet travelled this frame against that shape,
 * grown by the bullet's own radius, so no speed can step over a target.
 *
 * Leaf module: no game-logic imports. Shapes are plain objects:
 *   { kind: 'box', left, top, right, bottom }
 *   { kind: 'circle', x, y, r }
 */

/**
 * A box shape.
 *
 * @param {number} left
 * @param {number} top
 * @param {number} right
 * @param {number} bottom
 * @returns {Object} Shape
 */
export function boxShape(left, top, right, bottom) {
    return { kind: 'box', left, top, right, bottom };
}

/**
 * A circle shape.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} r
 * @returns {Object} Shape
 */
export function circleShape(x, y, r) {
    return { kind: 'circle', x, y, r };
}

/**
 * The hit shape of an entity: its own, if it defines one, else the movement
 * circle every entity has.
 *
 * @param {Object} entity - Anything with x, y and radius; may have getHitShape()
 * @returns {Object} Shape
 */
export function hitShapeOf(entity) {
    if (typeof entity.getHitShape === 'function') {
        const shape = entity.getHitShape();
        if (shape) return shape;
    }
    return circleShape(entity.x, entity.y, entity.radius);
}

/**
 * Whether a point lies inside a shape grown by `pad`.
 *
 * @param {Object} shape
 * @param {number} x
 * @param {number} y
 * @param {number} [pad]
 * @returns {boolean}
 */
export function pointInShape(shape, x, y, pad = 0) {
    if (shape.kind === 'box') {
        return x >= shape.left - pad && x <= shape.right + pad &&
               y >= shape.top - pad && y <= shape.bottom + pad;
    }
    const dx = x - shape.x;
    const dy = y - shape.y;
    const r = shape.r + pad;
    return dx * dx + dy * dy <= r * r;
}

/**
 * Distance from a point to the nearest edge of a shape; zero inside it.
 *
 * @param {Object} shape
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function distanceToShape(shape, x, y) {
    if (shape.kind === 'box') {
        const dx = Math.max(shape.left - x, 0, x - shape.right);
        const dy = Math.max(shape.top - y, 0, y - shape.bottom);
        return Math.hypot(dx, dy);
    }
    return Math.max(0, Math.hypot(x - shape.x, y - shape.y) - shape.r);
}

/**
 * Where a ray first enters a shape, as a distance along the ray, or Infinity
 * if it never does. The ray starts at (ox, oy) and points along the unit
 * vector (dx, dy). A ray that starts inside the shape hits at distance 0.
 *
 * @param {Object} shape
 * @param {number} ox
 * @param {number} oy
 * @param {number} dx
 * @param {number} dy
 * @param {number} [pad] - Grow the shape by this much (the bullet's radius)
 * @returns {number} Distance to entry, or Infinity
 */
export function rayShapeDistance(shape, ox, oy, dx, dy, pad = 0) {
    if (shape.kind === 'circle') {
        const cx = shape.x - ox;
        const cy = shape.y - oy;
        const r = shape.r + pad;
        const along = cx * dx + cy * dy;
        const perpSq = cx * cx + cy * cy - along * along;
        if (perpSq > r * r) return Infinity;
        const half = Math.sqrt(r * r - perpSq);
        const entry = along - half;
        if (entry >= 0) return entry;
        // Starts inside, or the circle is behind: inside counts, behind does not.
        return along + half >= 0 ? 0 : Infinity;
    }

    // Slab test against the padded box.
    const left = shape.left - pad;
    const right = shape.right + pad;
    const top = shape.top - pad;
    const bottom = shape.bottom + pad;

    // One axis at a time, written out rather than looped over an array of
    // tuples: this runs once per bullet per entity per frame, and the tuple
    // array was an allocation every time.
    let tMin = 0;
    let tMax = Infinity;

    if (Math.abs(dx) < 1e-12) {
        if (ox < left || ox > right) return Infinity;
    } else {
        let t1 = (left - ox) / dx;
        let t2 = (right - ox) / dx;
        if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) return Infinity;
    }

    if (Math.abs(dy) < 1e-12) {
        if (oy < top || oy > bottom) return Infinity;
    } else {
        let t1 = (top - oy) / dy;
        let t2 = (bottom - oy) / dy;
        if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) return Infinity;
    }

    return tMin;
}

/**
 * Whether the segment from (x0, y0) to (x1, y1), thickened by `pad`, touches
 * a shape. This is the projectile test: the segment is the bullet's travel
 * this frame, and the pad is its radius.
 *
 * @param {Object} shape
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number} [pad]
 * @returns {boolean}
 */
export function segmentHitsShape(shape, x0, y0, x1, y1, pad = 0) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy);

    if (length < 1e-9) return pointInShape(shape, x0, y0, pad);

    const entry = rayShapeDistance(shape, x0, y0, dx / length, dy / length, pad);
    return entry <= length;
}

/**
 * Where along a segment a shape is first touched, as a fraction 0..1, or
 * Infinity if the segment misses. Lets a collision pass find the NEAREST of
 * several targets a bullet crossed in one frame, rather than the first in
 * array order.
 *
 * @param {Object} shape
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number} [pad]
 * @returns {number} Fraction along the segment, or Infinity
 */
export function segmentHitFraction(shape, x0, y0, x1, y1, pad = 0) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy);

    if (length < 1e-9) return pointInShape(shape, x0, y0, pad) ? 0 : Infinity;

    const entry = rayShapeDistance(shape, x0, y0, dx / length, dy / length, pad);
    return entry <= length ? entry / length : Infinity;
}
