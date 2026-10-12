// Particles, light and screen effects.
//
// Everything here works in TILE space -- a particle at (12.5, 7.25) is in the
// middle of the cell at column 12, row 7, and velocities are in tiles per
// second. The renderer converts to pixels at draw time, so the whole system
// survives a resize, a zoom or a camera move without touching a single
// particle. Storing screen pixels instead is how effects end up sliding around
// when the window changes.
//
// There are two passes. Particles are drawn straight onto the board, over the
// sprites. Light is drawn into a half-resolution buffer and composited back
// additively -- the upscale IS the blur, which is how you get bloom in canvas
// 2D without a shader, a dependency or a per-frame gaussian.
//
// There are two styles, chosen by `fx.style`. 'classic' goes with SupRemix's
// procedural sprites, which are built to be lit: big bursts, rings, screen
// flashes. 'hd' goes with the remastered original art, which already animates
// the thing happening -- the base being eaten, the infotron going into Murphy's
// mouth, the fire of the blast -- so its effects only add what a sprite cannot:
// a few crumbs with weight, smoke that drifts, light that rises and falls, a
// glint. Nothing is drawn over the art that the art already says.

/**
 * The dials, gathered.
 *
 * Everything about how loud the effects are runs through these three numbers,
 * so "more" and "less" are one edit rather than a hunt through the file. They
 * multiply, they do not replace: the shape of each effect still lives in
 * `playFx` at the bottom, and the automatic quality dial in `pace` scales on
 * top of whatever is set here.
 */
export const TUNING = {
  intensity: 1,     // how many particles, and how hard the screen flashes
  bloom: 1,         // how far light bleeds past what is emitting it
  ambient: 1,       // drifting dust and the twinkle on infotrons
};

const POOL = 1400;          // particles alive at once; oldest are recycled
const LIGHT_SCALE = 0.5;    // light buffer resolution, relative to the canvas
const BLOB = 96;            // pre-rendered light blob, in its own pixels

const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[(Math.random() * list.length) | 0];

function makeCanvas(w, h) {
  const c = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  c.width = w; c.height = h;
  return c;
}

/**
 * One soft round light, white, pre-rendered once.
 *
 * Tinting is done by compositing rather than by building a gradient per colour
 * per frame: a radial gradient is expensive to construct and a level can have a
 * hundred lights on screen.
 */
function makeBlob() {
  const c = makeCanvas(BLOB, BLOB);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(BLOB / 2, BLOB / 2, 0, BLOB / 2, BLOB / 2, BLOB / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.14)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, BLOB, BLOB);
  return c;
}

export class Fx {
  constructor() {
    // The canvases are built on first use rather than in the constructor, so an
    // Fx can be made and driven with no DOM at all -- which is what lets the
    // particle arithmetic be tested headlessly alongside the engine.
    this.blob = null;
    this.tinted = new Map();          // colour -> a copy of the blob in that colour
    this.lights = [];                 // queued this frame, drawn at composite time
    this.parts = [];
    this.head = 0;                    // ring buffer cursor into `parts`
    for (let i = 0; i < POOL; i++) this.parts.push({ life: 0 });

    this.light = null;
    this.lightCtx = null;
    this.lw = 0; this.lh = 0;

    this.flashAmount = 0;
    this.flashColour = '#ffffff';
    this.hitStop = 0;                 // seconds of frozen time left
    this.quality = 1;                 // 0..1, dialled down when frames get long
    this.slowFrames = 0;
    this.fastFrames = 0;
    this.style = 'classic';           // or 'hd'; see the top of the file
  }

  /** Colour-matched copy of the light blob, built once per colour. */
  tint(colour) {
    let c = this.tinted.get(colour);
    if (c) return c;
    if (!this.blob) this.blob = makeBlob();
    c = makeCanvas(BLOB, BLOB);
    const ctx = c.getContext('2d');
    ctx.drawImage(this.blob, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, BLOB, BLOB);
    this.tinted.set(colour, c);
    return c;
  }

  resize(w, h) {
    const lw = Math.max(2, Math.round(w * LIGHT_SCALE));
    const lh = Math.max(2, Math.round(h * LIGHT_SCALE));
    if (lw === this.lw && lh === this.lh) return;
    if (!this.light) this.light = makeCanvas(lw, lh);
    this.light.width = lw; this.light.height = lh;
    this.lw = lw; this.lh = lh;
    this.lightCtx = this.light.getContext('2d');
  }

  // --- emitting -------------------------------------------------------------

  /** A light for this frame only, at tile coordinates. */
  glow(x, y, radius, colour, alpha = 1) {
    if (alpha <= 0.01) return;
    this.lights.push({ x, y, r: radius, colour, a: alpha });
  }

  /**
   * One particle. `kind` decides how it is drawn:
   *   spark  a bright streak along its own velocity, added to the light
   *   shard  a tumbling chip of something solid, lit normally
   *   ring   an expanding hoop, added
   *   smoke  a soft dark puff that fades
   *   puff   smoke with a soft edge, that swells as it fades
   *   glint  a four-pointed specular star that flares and goes out
   *   light  no particle at all: a light that rises fast and dies slowly
   */
  add(kind, x, y, vx, vy, life, colour, size, opts = {}) {
    const p = this.parts[this.head];
    this.head = (this.head + 1) % POOL;
    p.kind = kind;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.max = life;
    p.colour = colour; p.size = size;
    p.grav = opts.grav ?? 0;
    p.drag = opts.drag ?? 0.9;
    p.spin = opts.spin ?? 0;
    p.rot = opts.rot ?? Math.random() * TAU;
    p.lum = opts.lum ?? 0;            // how much light it throws
    p.alpha = opts.alpha ?? 1;
    return p;
  }

  /** A light that flares and fades over `life` seconds, at tile coordinates. */
  flare(x, y, radius, colour, life = 0.35, alpha = 0.6) {
    this.add('light', x, y, 0, 0, life, colour, radius, { drag: 1, alpha });
  }

  burst(x, y, n, colour, opts = {}) {
    const speed = opts.speed ?? 6;
    const life = opts.life ?? 0.5;
    const size = opts.size ?? 0.09;
    const count = Math.max(1, Math.round(n * this.quality * TUNING.intensity));
    // Read the spread out first. Written inline as `-opts.spread ?? -0.6` it
    // parses as `(-opts.spread) ?? -0.6`, and -undefined is NaN, which ?? does
    // not catch -- so every directed burst fired at an angle of NaN and no
    // particle ever appeared.
    const spread = opts.spread ?? 0.6;
    for (let k = 0; k < count; k++) {
      const a = opts.angle === undefined ? rnd(0, TAU)
        : opts.angle + rnd(-spread, spread);
      const s = speed * rnd(0.35, 1);
      this.add(opts.kind ?? 'spark', x, y, Math.cos(a) * s, Math.sin(a) * s,
        life * rnd(0.6, 1.2), colour, size * rnd(0.7, 1.3), opts);
    }
  }

  ring(x, y, colour, opts = {}) {
    this.add('ring', x, y, 0, 0, opts.life ?? 0.34, colour, opts.size ?? 0.2,
      { drag: 1, lum: opts.lum ?? 1 });
  }

  flash(amount, colour = '#ffffff') {
    this.flashAmount = Math.min(1, Math.max(this.flashAmount, amount * TUNING.intensity));
    this.flashColour = colour;
  }

  /** Freeze the world for a moment. What makes a hit feel like it landed. */
  stop(seconds) {
    this.hitStop = Math.max(this.hitStop, seconds);
  }

  // --- running --------------------------------------------------------------

  update(dt) {
    if (this.hitStop > 0) this.hitStop = Math.max(0, this.hitStop - dt);
    if (this.flashAmount > 0) this.flashAmount = Math.max(0, this.flashAmount - dt * 3.4);
    for (const p of this.parts) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy += p.grav * dt;
      const d = p.drag ** (dt * 60);
      p.vx *= d; p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      // a flare throws its light into this frame's light pass
      if (p.kind === 'light') {
        const t = p.life / p.max;
        this.glow(p.x, p.y, p.size * (0.85 + 0.15 * t), p.colour, p.alpha * Math.min(1, (1 - t) * 6) * t);
      }
    }
  }

  /**
   * Watch the frame time and back off if the machine cannot keep up.
   *
   * An effects layer that turns a good machine into a great one and a weak
   * machine into a slideshow is not worth having, and nobody reads a settings
   * screen. Ten long frames in a row and the particle counts come down.
   */
  pace(dt) {
    if (dt > 0.028) {
      this.slowFrames++;
      this.fastFrames = 0;
      if (this.slowFrames > 10) {
        this.quality = Math.max(0.25, this.quality - 0.1);
        this.slowFrames = 0;
      }
    } else {
      this.fastFrames++;
      this.slowFrames = 0;
      if (this.fastFrames > 180) {
        this.quality = Math.min(1, this.quality + 0.1);
        this.fastFrames = 0;
      }
    }
  }

  // --- drawing --------------------------------------------------------------

  /** Particles, over the board. `to` converts tile space to device pixels. */
  drawParticles(ctx, originX, originY, tile) {
    ctx.save();
    for (const p of this.parts) {
      if (p.life <= 0) continue;
      const t = p.life / p.max;                    // 1 at birth, 0 at death
      const px = p.x * tile - originX;
      const py = p.y * tile - originY;
      const s = p.size * tile;

      if (p.kind === 'spark') {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, t * 1.6);
        ctx.strokeStyle = p.colour;
        ctx.lineWidth = Math.max(1, s * 0.55);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - p.vx * tile * 0.02, py - p.vy * tile * 0.02);
        ctx.stroke();
      } else if (p.kind === 'shard') {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = p.alpha * Math.min(1, t * 2);
        ctx.translate(px, py);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.colour;
        if (this.style === 'hd') {
          // a crumb, not a square: rounded, with a lit top edge
          ctx.beginPath();
          ctx.ellipse(0, 0, s / 2, s * 0.36, 0, 0, TAU);
          ctx.fill();
          ctx.globalAlpha *= 0.55;
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.ellipse(-s * 0.1, -s * 0.12, s * 0.22, s * 0.1, 0, 0, TAU);
          ctx.fill();
        } else {
          ctx.fillRect(-s / 2, -s / 2, s, s * 0.7);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      } else if (p.kind === 'light') {
        // drawn by the light pass
      } else if (p.kind === 'puff') {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = p.alpha * t * Math.min(1, (1 - t) * 5);
        const r = s * (2.2 - t * 1.2);
        if (!this.blob) this.blob = makeBlob();
        ctx.drawImage(this.tint(p.colour), px - r, py - r, r * 2, r * 2);
      } else if (p.kind === 'glint') {
        ctx.globalCompositeOperation = 'lighter';
        const flare = Math.sin(Math.PI * (1 - t));          // up then down
        ctx.globalAlpha = p.alpha * flare;
        ctx.strokeStyle = p.colour;
        ctx.lineCap = 'round';
        const arm = s * (0.6 + flare);
        ctx.lineWidth = Math.max(1, s * 0.16);
        ctx.beginPath();
        ctx.moveTo(px - arm, py); ctx.lineTo(px + arm, py);
        ctx.moveTo(px, py - arm); ctx.lineTo(px, py + arm);
        ctx.stroke();
        ctx.lineWidth = Math.max(1, s * 0.07);
        const d = arm * 0.45;
        ctx.beginPath();
        ctx.moveTo(px - d, py - d); ctx.lineTo(px + d, py + d);
        ctx.moveTo(px - d, py + d); ctx.lineTo(px + d, py - d);
        ctx.stroke();
      } else if (p.kind === 'ring') {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = t * t * 0.9;
        ctx.strokeStyle = p.colour;
        ctx.lineWidth = Math.max(1, tile * 0.06 * t);
        ctx.beginPath();
        ctx.arc(px, py, s * (1.6 - t) * 2.2, 0, TAU);
        ctx.stroke();
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = t * 0.5;
        ctx.fillStyle = p.colour;
        ctx.beginPath();
        ctx.arc(px, py, s * (2 - t), 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /**
   * Bloom. Everything emissive goes into a half-size buffer and comes back
   * scaled up and added, twice, at two different sizes: the small pass is the
   * wide haze and the large pass is the tight core. The browser's own bilinear
   * upscale does the blurring, which is why this costs almost nothing.
   */
  composite(ctx, W, H, originX, originY, tile) {
    if (!this.lights.length || !this.lightCtx) { this.lights.length = 0; return; }
    const lc = this.lightCtx;
    const k = LIGHT_SCALE;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, this.lw, this.lh);
    lc.globalCompositeOperation = 'lighter';

    for (const l of this.lights) {
      const px = (l.x * tile - originX) * k;
      const py = (l.y * tile - originY) * k;
      const r = l.r * tile * k;
      if (px < -r || py < -r || px > this.lw + r || py > this.lh + r) continue;
      lc.globalAlpha = Math.min(1, l.a);
      lc.drawImage(this.tint(l.colour), px - r, py - r, r * 2, r * 2);
    }
    this.lights.length = 0;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    // HD lights are few and small and are meant to glow round the art, not
    // wash over it: one tight pass, no wide haze.
    const hd = this.style === 'hd';
    ctx.globalAlpha = (hd ? 0.6 : 0.55) * TUNING.bloom;
    ctx.drawImage(this.light, 0, 0, W, H);
    if (!hd) {
      ctx.globalAlpha = 0.32 * TUNING.bloom;
      ctx.drawImage(this.light, -W * 0.02, -H * 0.02, W * 1.04, H * 1.04);
    }
    ctx.restore();
  }

  /** A full-screen wash. Used sparingly: an explosion, a level opening. */
  drawFlash(ctx, W, H) {
    if (this.flashAmount <= 0.01) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = this.flashAmount * 0.55;
    ctx.fillStyle = this.flashColour;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  clear() {
    for (const p of this.parts) p.life = 0;
    this.lights.length = 0;
    this.flashAmount = 0;
    this.hitStop = 0;
  }
}

// --- what each thing that happens looks like ---------------------------------
//
// Kept here rather than in the renderer so the whole visual vocabulary of the
// game is in one place: if a dig should throw more solder mask about, this is
// the only file that has an opinion about it.

export const FX_COLOUR = {
  // Drawn from the original's own sixteen colours, so a spark and the tile it
  // came off are the same green, the same silver, the same red.
  dig: ['#00bb66', '#008855', '#ffffff'],
  infotron: ['#ffffff', '#eeee00', '#ee1111'],
  boom: ['#eeee00', '#ff9944', '#ee1111'],
  boomI: ['#ffffff', '#eeee00', '#ff9944'],
  land: ['#bbbbbb', '#777777'],
  spark: ['#7799ee', '#ffffff'],
  port: ['#7799ee', '#ffffff'],
  exit: ['#00bb66', '#ffffff'],
  slime: ['#00bb66', '#008855'],
  fire: ['#ff9944', '#eeee00'],
  key: ['#ffffff'],
};

/** Hook the engine's own event stream up to the effects vocabulary. */
export function playFx(fx, kind, x, y) {
  if (fx.style === 'hd') { playFxHD(fx, kind, x, y); return; }
  switch (kind) {
    case 'dig':
      fx.burst(x, y, 9, pick(FX_COLOUR.dig), { kind: 'shard', speed: 3.2, life: 0.42, size: 0.11, grav: 12, drag: 0.86, spin: 9 });
      break;
    case 'infotron':
      fx.burst(x, y, 16, pick(FX_COLOUR.infotron), { speed: 7, life: 0.42, size: 0.1, drag: 0.86 });
      fx.ring(x, y, '#ffffff', { size: 0.22 });
      fx.flash(0.1, '#ffe8c0');
      break;
    case 'boom':
      fx.burst(x, y, 30, pick(FX_COLOUR.boom), { speed: 11, life: 0.6, size: 0.14, grav: 8, drag: 0.9 });
      fx.burst(x, y, 12, '#3a3f49', { kind: 'smoke', speed: 3, life: 0.9, size: 0.2, drag: 0.82 });
      fx.ring(x, y, '#ff9944', { size: 0.45, life: 0.42 });
      fx.flash(0.5, '#ffd9a0');
      fx.stop(0.055);
      break;
    case 'crystal':
      fx.burst(x, y, 12, pick(FX_COLOUR.infotron), { speed: 4, life: 0.5, size: 0.09 });
      fx.ring(x, y, '#ffffff', { size: 0.2 });
      break;
    case 'land':
      fx.burst(x, y + 0.42, 6, pick(FX_COLOUR.land), { kind: 'shard', speed: 2.6, life: 0.3, size: 0.09, grav: 16, angle: 0, spread: 2.6 });
      break;
    case 'port':
      fx.ring(x, y, '#7799ee', { size: 0.24 });
      fx.burst(x, y, 8, pick(FX_COLOUR.port), { speed: 5, life: 0.3, size: 0.08 });
      break;
    case 'exit':
      fx.burst(x, y, 40, pick(FX_COLOUR.exit), { speed: 9, life: 0.9, size: 0.12, drag: 0.93 });
      fx.ring(x, y, '#00bb66', { size: 0.5, life: 0.7 });
      fx.flash(0.45, '#7cffb8');
      break;
    case 'burn':
      fx.burst(x, y, 22, pick(FX_COLOUR.fire), { speed: 6, life: 0.6, size: 0.13, grav: -6 });
      fx.flash(0.35, '#ff9944');
      fx.stop(0.05);
      break;
    case 'creep':
      fx.burst(x, y, 4, pick(FX_COLOUR.slime), { speed: 1.8, life: 0.5, size: 0.09 });
      break;
    case 'key':
    case 'unlock':
    case 'boots':
    case 'pickup':
      fx.burst(x, y, 14, '#ffffff', { speed: 5.5, life: 0.4, size: 0.09 });
      fx.ring(x, y, '#ffffff', { size: 0.22 });
      break;
    case 'seal':
    case 'harden':
      fx.burst(x, y, 10, '#bbbbbb', { kind: 'shard', speed: 3, life: 0.4, size: 0.1, grav: 10, spin: 7 });
      break;
    case 'die':
      fx.burst(x, y, 46, pick(FX_COLOUR.boom), { speed: 13, life: 0.9, size: 0.15, grav: 9 });
      fx.ring(x, y, '#ee1111', { size: 0.6, life: 0.8 });
      fx.flash(0.7, '#ff9944');
      fx.stop(0.11);
      break;
    default:
      break;
  }
}

// --- the HD vocabulary ------------------------------------------------------------
//
// For the remastered art. Each effect is small, short and has a physical
// reason to be there; the bloom comes from flares that rise and fall, never a
// constant glow, and the screen flashes only for something that would light a
// room.

const HD_COLOUR = {
  board: ['#00bb66', '#008855', '#00995a'],
  embers: ['#ffd27a', '#ff9944', '#ee5511'],
  dust: '#8a8f96',
  smoke: '#2b2622',
};

function playFxHD(fx, kind, x, y) {
  const crumbs = (n, colours, opts = {}) => {
    for (let k = 0; k < n; k++) {
      fx.burst(x + rnd(-0.25, 0.25), y + rnd(-0.2, 0.2), 1, pick(colours), {
        kind: 'shard', speed: 2.4, life: 0.4, size: 0.075, grav: 15, drag: 0.86, spin: 10, ...opts,
      });
    }
  };
  const glints = (n, colour, spread = 0.3, size = 0.18) => {
    for (let k = 0; k < Math.max(1, Math.round(n * fx.quality * TUNING.intensity)); k++) {
      fx.add('glint', x + rnd(-spread, spread), y + rnd(-spread, spread), 0, -0.2, rnd(0.25, 0.42), colour, size * rnd(0.7, 1.1), { drag: 1 });
    }
  };
  switch (kind) {
    case 'dig':
      // the original's own animation eats the base; these are the crumbs
      crumbs(4, HD_COLOUR.board);
      break;
    case 'infotron':
      // swallowed by Murphy in the art itself; a glint and a little light
      glints(3, '#ffffff', 0.25, 0.2);
      fx.flare(x, y, 0.75, '#fff2d0', 0.3, 0.35);
      break;
    case 'boom':
      // the fire is the original's; this is what it does to the room
      fx.flare(x, y, 2.2, '#ff9a3c', 0.55, 0.7);
      fx.burst(x, y, 10, pick(HD_COLOUR.embers), { speed: 7, life: 0.55, size: 0.07, grav: 9, drag: 0.92 });
      for (let k = 0; k < 6; k++) {
        fx.add('puff', x + rnd(-0.9, 0.9), y + rnd(-0.9, 0.9), rnd(-0.4, 0.4), rnd(-0.9, -0.3), rnd(0.9, 1.4),
          HD_COLOUR.smoke, rnd(0.32, 0.48), { drag: 0.95, alpha: 0.45 });
      }
      fx.flash(0.07, '#ffd9a0');
      fx.stop(0.045);
      break;
    case 'die':
      fx.flare(x, y, 2.6, '#ff8a3c', 0.7, 0.8);
      fx.burst(x, y, 16, pick(HD_COLOUR.embers), { speed: 8, life: 0.7, size: 0.08, grav: 9, drag: 0.92 });
      for (let k = 0; k < 8; k++) {
        fx.add('puff', x + rnd(-1, 1), y + rnd(-1, 1), rnd(-0.4, 0.4), rnd(-1, -0.3), rnd(1, 1.6),
          HD_COLOUR.smoke, rnd(0.35, 0.5), { drag: 0.95, alpha: 0.5 });
      }
      fx.flash(0.12, '#ffb070');
      fx.stop(0.09);
      break;
    case 'land':
      // a thump: dust kicked out either side of where it came down
      for (const side of [-1, 1]) {
        fx.add('puff', x + side * 0.3, y + 0.45, side * 0.9, -0.15, 0.45, HD_COLOUR.dust, 0.16, { drag: 0.9, alpha: 0.35 });
      }
      break;
    case 'exit':
      fx.flare(x, y, 1.4, '#7cffb8', 0.9, 0.55);
      glints(5, '#d8ffe8', 0.4, 0.22);
      break;
    case 'port':
      fx.flare(x, y, 0.6, '#9fb6ff', 0.25, 0.3);
      break;
    case 'key':
    case 'unlock':
    case 'boots':
    case 'pickup':
      glints(3, '#ffffff', 0.25, 0.18);
      fx.flare(x, y, 0.6, '#ffffff', 0.25, 0.3);
      break;
    case 'crystal':
      glints(4, '#e8fff4', 0.35, 0.2);
      break;
    case 'burn':
      fx.flare(x, y, 1.1, '#ff9944', 0.45, 0.5);
      fx.burst(x, y, 8, pick(HD_COLOUR.embers), { speed: 4, life: 0.5, size: 0.06, grav: -5 });
      fx.add('puff', x, y - 0.2, 0, -0.8, 1, HD_COLOUR.smoke, 0.3, { drag: 0.95, alpha: 0.4 });
      fx.stop(0.04);
      break;
    case 'creep':
      crumbs(2, ['#00bb66', '#008855'], { grav: 6, speed: 1.2 });
      break;
    case 'seal':
    case 'harden':
      crumbs(4, ['#bbbbbb', '#888888', '#666666'], { grav: 12 });
      break;
    default:
      break;
  }
}
