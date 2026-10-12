// The remastered graphics: the original Supaplex tiles and animation frames,
// redrawn in HD (tools/remaster/) and packed into one atlas, which ships inside
// the scrambled gfx pack (js/asset-pack.js) rather than as a loose PNG.
//
// Frames are cut from the atlas and scaled to the board's tile size the first
// time they are asked for, then kept until the tile size changes -- the same
// bargain the procedural sprites make, so the board never resamples while it
// draws. Anything the atlas does not have (the hybrid elements, which the
// original never drew) stays with the procedural set.

import { PACKS, packedBytes, packedURL } from './asset-pack.js';

/** Loads the atlas out of its pack, or resolves to null if it is not there. */
export async function loadHD(pack = PACKS.gfx) {
  try {
    const json = await packedBytes(pack, 'remaster.json');
    const src = json && await packedURL(pack, 'remaster.png');
    if (!src) return null;
    const meta = JSON.parse(new TextDecoder().decode(json));
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    await img.decode();
    return new HD(img, meta);
  } catch {
    return null;
  }
}

export class HD {
  constructor(img, meta) {
    this.img = img;
    this.meta = meta;
    this.cell = meta.cell;
    this.size = 0;
    this.cache = new Map();
  }

  has(key) { return key in this.meta.sprites; }

  /** w, h (original pixels), anchor, frame count and any measurements, for a sprite. */
  info(key) {
    const s = this.meta.sprites[key];
    return s ? { ...s, count: s.frames.length } : null;
  }

  count(key) { return this.meta.sprites[key]?.frames.length ?? 0; }

  /** Drop every scaled frame; the next `frame` call rebuilds at `size` device pixels a cell. */
  setSize(size) {
    if (size === this.size) return;
    this.size = size;
    this.cache.clear();
  }

  /** Frame `i` of `key` (wrapping), scaled so one cell is `size` device pixels. */
  frame(key, i = 0) {
    const s = this.meta.sprites[key];
    if (!s) return null;
    const n = s.frames.length;
    const f = ((i % n) + n) % n;
    const id = `${key}#${f}`;
    let c = this.cache.get(id);
    if (c) return c;
    const k = this.size / 16;
    const w = Math.max(1, Math.round(s.w * k)), h = Math.max(1, Math.round(s.h * k));
    c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const [ax, ay] = s.frames[f];
    const scale = this.cell / 16;
    ctx.drawImage(this.img, ax, ay, Math.round(s.w * scale), Math.round(s.h * scale), 0, 0, w, h);
    this.cache.set(id, c);
    return c;
  }
}
