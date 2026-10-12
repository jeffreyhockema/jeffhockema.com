// Every sprite in SupRemix is drawn with canvas primitives at runtime -- there
// are no image assets to load, and the whole set is rebuilt at the exact pixel
// size the board is currently using, so nothing is ever resampled.
//
// The setting is the inside of a 1990s PC. Murphy is a service bot crawling a
// motherboard: the base you dig is green solder mask over copper, zonks are
// electrolytic capacitors, disks are 3.5" floppies, monsters are case fans and
// arcing shorts, and the walls are beige steel chassis. The Supaplex silhouettes
// survive underneath -- a capacitor still reads as a thing that falls on you.

import { T, FL } from './tiles.js';

// The original's sixteen colours, read straight out of the game's own
// PALETTES.DAT (4-bit components, so each is the raw value times seventeen).
// These are the anchors: the sprites below interpolate between them freely for
// gradients, rim light and specular, which is the whole difference between the
// 1991 tile and a high-definition one. The shapes are the original's; the
// shading is not, because the original had sixteen colours and we do not.
export const SPX = {
  black: '#000000', white: '#ffffff', yellow: '#eeee00',
  green: '#008855', greenHi: '#00bb66', silver: '#bbbbbb',
  red: '#ee1111', grey: '#999999', blueHi: '#7799ee',
  blue: '#5555dd', brown: '#884400', redDark: '#bb0000',
  orange: '#ff9944', grey3: '#666666', grey4: '#777777', grey6: '#888888',
};

export const PAL = {
  void: '#03060a',
  grid: '#081210',

  // The board you dig: the original's green, with its darker trace and the
  // white via that sits in the corner of every tile.
  pcb: '#00bb66',
  pcbDark: '#00603a',
  pcbDeep: '#00381f',
  trace: '#00593a',      // the darker green the circuit lines are drawn in
  via: '#ffffff',
  silk: '#d8f0e2',

  // Chassis. The original's is a flat blue-grey slab; this keeps the value and
  // spends the extra colours on the bevel.
  beige: '#8f97a8',
  beigeDark: '#454c5c',
  steel: '#bbbbbb',
  steelDark: '#666666',
  screw: '#777777',

  // Capacitor: the grey boulder.
  capBody: '#9aa0aa',
  capTop: '#e6ecf4',
  capStripe: '#ffffff',
  capRim: '#3a3f49',

  // Infotron: silver ball, red and yellow band.
  gold: '#ee1111',
  goldHot: '#eeee00',
  goldRim: '#bb0000',

  // Murphy: red sphere, yellow face, grey jaw.
  shell: '#ee1111',
  shellDark: '#bb0000',
  face: '#eeee00',
  faceHot: '#ff9944',
  visor: '#1a0405',
  phosphor: '#00bb66',
  service: '#999999',

  dip: '#7a828e',
  dipLeg: '#bbbbbb',

  fan: '#999999',
  fanHub: '#3a3f49',
  spark: '#7799ee',
  sparkHot: '#ffffff',

  bugShell: '#bb0000',
  bugHot: '#ee1111',

  floppyO: '#ff9944',
  floppyY: '#eeee00',
  floppyR: '#ee1111',
  shutter: '#bbbbbb',
  label: '#ffffff',

  ribbon: '#999999',
  ribbonRed: '#bb0000',

  keyA: '#ff9944',
  keyC: '#7799ee',
  keyG: '#00bb66',
  keyP: '#c07bff',

  ooze: '#008855',
  oozeHot: '#00bb66',
  hot: '#ff9944',

  text: '#d8f0e2',
};

const TAU = Math.PI * 2;
export const KEY_COLS = [PAL.keyA, PAL.keyC, PAL.keyG, PAL.keyP];

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function glow(ctx, x, y, r, color, alpha = 0.55) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Board underlay used by anything that sits on bare PCB. */
/**
 * A lit sphere: body gradient, specular highlight, and a rim light on the far
 * side. Three cheap gradients are the whole difference between a flat disc and
 * something that looks round -- and the original's sixteen colours could not
 * afford any of them.
 */
function orb(ctx, cx, cy, r, dark, mid, light, rim) {
  const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r);
  g.addColorStop(0, light);
  g.addColorStop(0.45, mid);
  g.addColorStop(1, dark);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();

  if (rim) {
    const rg = ctx.createRadialGradient(cx, cy, r * 0.72, cx, cy, r);
    rg.addColorStop(0, 'rgba(0,0,0,0)');
    rg.addColorStop(1, rim);
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();
  }

  // The specular: a small soft ellipse up and to the left, which is where the
  // light has been in every one of these sprites since 1991.
  const sg = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.44, 0, cx - r * 0.38, cy - r * 0.44, r * 0.5);
  sg.addColorStop(0, 'rgba(255,255,255,0.85)');
  sg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.arc(cx - r * 0.34, cy - r * 0.4, r * 0.46, 0, TAU);
  ctx.fill();
}

/** A drop shadow under something round, so it sits on the board rather than on top of it. */
function contact(ctx, cx, cy, r) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, 'rgba(0,0,0,0.5)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r, r * 0.5, 0, 0, TAU);
  ctx.fill();
}

function boardBed(ctx, S) {
  const g = ctx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, PAL.pcb);
  g.addColorStop(1, PAL.pcbDark);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
}

// --- scenery ----------------------------------------------------------------

function drawHardware(ctx, S, accent) {
  // The chassis slab. Plain it is a blue-grey panel; with an accent it carries
  // the grid of indicator lamps the original prints on its decorative variants.
  const g = ctx.createLinearGradient(0, 0, S * 0.35, S);
  g.addColorStop(0, '#a4acbb');
  g.addColorStop(0.45, PAL.beige);
  g.addColorStop(1, PAL.beigeDark);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  const b = Math.max(1.5, S * 0.085);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillRect(0, 0, S, b);
  ctx.fillRect(0, 0, b, S);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, S - b, S, b);
  ctx.fillRect(S - b, 0, b, S);

  if (!accent) {
    // A plain slab still wants something to catch the light, or a wall of them
    // is a flat rectangle: two recessed screws and a faint brushed grain.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = Math.max(1, S * 0.02);
    for (let y = S * 0.24; y < S * 0.8; y += S * 0.13) {
      ctx.beginPath();
      ctx.moveTo(S * 0.16, y);
      ctx.lineTo(S * 0.84, y);
      ctx.stroke();
    }
    for (const [px, py] of [[0.26, 0.26], [0.74, 0.74]]) {
      const r = Math.max(1, S * 0.055);
      const sg = ctx.createLinearGradient(S * px - r, S * py - r, S * px + r, S * py + r);
      sg.addColorStop(0, '#3b414c');
      sg.addColorStop(1, '#c8cfda');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(S * px, S * py, r, 0, TAU);
      ctx.fill();
    }
    return;
  }

  // The lamp grid: three by three, glass domes over a dark backing plate.
  ctx.fillStyle = '#1b1f26';
  rr(ctx, S * 0.14, S * 0.14, S * 0.72, S * 0.72, S * 0.06);
  ctx.fill();
  const r = S * 0.075;
  for (let iy = 0; iy < 3; iy++) {
    for (let ix = 0; ix < 3; ix++) {
      const x = S * (0.26 + ix * 0.24), y = S * (0.26 + iy * 0.24);
      const on = ((ix * 3 + iy) % 3) !== 1;
      const lg = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, 0, x, y, r);
      lg.addColorStop(0, '#ffffff');
      lg.addColorStop(0.45, accent);
      lg.addColorStop(1, on ? accent : '#2a2f38');
      ctx.globalAlpha = on ? 1 : 0.35;
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  glow(ctx, S * 0.5, S * 0.5, S * 0.55, accent, 0.28);
}

/**
 * The base you dig: solder mask, copper traces, gold vias.
 *
 * Four routings, picked per cell by the renderer. One pattern repeated across a
 * whole level reads as wallpaper; a real board never routes the same twice, and
 * the variety is most of what sells the setting.
 */
const TRACES = [
  { path: [[0.16, 0.26], [0.48, 0.26], [0.48, 0.64], [0.84, 0.64]], spur: [[0.2, 0.8], [0.46, 0.8]], vias: [[0.16, 0.26], [0.84, 0.64], [0.2, 0.8]] },
  { path: [[0.5, 0.06], [0.5, 0.4], [0.86, 0.4], [0.86, 0.9]], spur: [[0.12, 0.6], [0.38, 0.6]], vias: [[0.86, 0.4], [0.12, 0.6], [0.5, 0.06]] },
  { path: [[0.06, 0.5], [0.34, 0.5], [0.34, 0.14], [0.9, 0.14]], spur: [[0.3, 0.86], [0.74, 0.86]], vias: [[0.34, 0.5], [0.3, 0.86], [0.74, 0.86]] },
  { path: [[0.14, 0.18], [0.62, 0.18], [0.62, 0.52], [0.28, 0.52], [0.28, 0.9]], spur: [[0.72, 0.7], [0.94, 0.7]], vias: [[0.62, 0.52], [0.72, 0.7]] },
];

function drawBase(ctx, S, variant = 0) {
  // The board you dig. The original is flat green with a darker trace and one
  // white via; this keeps all three and adds the depth the sixteen-colour
  // version had no room for -- a lit face, a bevel and a soft inner shadow, so
  // a field of it reads as a surface rather than a colour.
  const t = TRACES[variant % TRACES.length];

  const g = ctx.createLinearGradient(0, 0, S * 0.35, S);
  g.addColorStop(0, PAL.pcb);
  g.addColorStop(0.55, '#008a4e');
  g.addColorStop(1, PAL.pcbDark);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  // Bevel: light along the top and left, dark along the bottom and right. This
  // is what stops a wall of base looking like a single flat rectangle.
  const b = Math.max(1, S * 0.07);
  ctx.fillStyle = 'rgba(120,255,190,0.22)';
  ctx.fillRect(0, 0, S, b);
  ctx.fillRect(0, 0, b, S);
  ctx.fillStyle = 'rgba(0,30,18,0.4)';
  ctx.fillRect(0, S - b, S, b);
  ctx.fillRect(S - b, 0, b, S);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = PAL.trace;
  ctx.lineWidth = Math.max(1, S * 0.1);
  ctx.beginPath();
  t.path.forEach(([x, y], k) => (k ? ctx.lineTo(x * S, y * S) : ctx.moveTo(x * S, y * S)));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(t.spur[0][0] * S, t.spur[0][1] * S);
  ctx.lineTo(t.spur[1][0] * S, t.spur[1][1] * S);
  ctx.stroke();

  // A hairline of light down the top edge of each trace, so it reads as etched.
  ctx.strokeStyle = 'rgba(150,255,205,0.18)';
  ctx.lineWidth = Math.max(1, S * 0.028);
  ctx.beginPath();
  t.path.forEach(([x, y], k) => (k ? ctx.lineTo(x * S, y * S - S * 0.03) : ctx.moveTo(x * S, y * S - S * 0.03)));
  ctx.stroke();

  for (const [x, y] of t.vias) {
    const vg = ctx.createRadialGradient(x * S, y * S, 0, x * S, y * S, S * 0.11);
    vg.addColorStop(0, '#ffffff');
    vg.addColorStop(0.6, PAL.silk);
    vg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = vg;
    ctx.beginPath();
    ctx.arc(x * S, y * S, S * 0.11, 0, TAU);
    ctx.fill();
  }

  const shade = ctx.createRadialGradient(S * 0.5, S * 0.5, S * 0.2, S * 0.5, S * 0.5, S * 0.78);
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,20,12,0.35)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, S, S);
}


/** Expansion slot: the brown connector with gold fingers down the middle. */
/**
 * One half of a two-cell DIP package.
 *
 * `part` says which edge of the body is open, so the two cells join into a
 * single chip with legs only on its outside edges. Drawn separately rather than
 * as one wide sprite because the renderer works a cell at a time.
 */
function drawChipHalf(ctx, S, part) {
  boardBed(ctx, S);
  const horiz = part === 'L' || part === 'R';
  const leg = S * 0.1;
  ctx.fillStyle = PAL.dipLeg;
  for (let k = 0; k < 3; k++) {
    const t = S * (0.22 + k * 0.26);
    if (horiz) {
      if (part === 'L') ctx.fillRect(0, t, leg, S * 0.12);
      else ctx.fillRect(S - leg, t, leg, S * 0.12);
    } else if (part === 'T') {
      ctx.fillRect(t, 0, S * 0.12, leg);
    } else {
      ctx.fillRect(t, S - leg, S * 0.12, leg);
    }
  }

  // The body runs off the joining edge so the two halves meet with no seam.
  const o = S * 0.08, over = S * 0.14;
  const x = horiz ? (part === 'L' ? o : -over) : o;
  const y = horiz ? o : (part === 'T' ? o : -over);
  const w = horiz ? S * 0.84 + over : S * 0.84;
  const h = horiz ? S * 0.84 : S * 0.84 + over;
  const g = ctx.createLinearGradient(0, S * 0.1, 0, S * 0.9);
  g.addColorStop(0, '#2a2c33');
  g.addColorStop(1, PAL.dip);
  ctx.fillStyle = g;
  rr(ctx, x, y, w, h, S * 0.08);
  ctx.fill();
  ctx.strokeStyle = '#04050a';
  ctx.lineWidth = Math.max(1, S * 0.035);
  ctx.stroke();

  ctx.fillStyle = 'rgba(220,230,220,0.75)';
  if (part === 'L' || part === 'T') {
    ctx.beginPath();
    ctx.arc(S * 0.28, S * 0.28, S * 0.065, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 0.5;
  ctx.fillRect(S * 0.22, S * 0.56, S * 0.5, S * 0.05);
  ctx.globalAlpha = 1;
}

function drawSlot(ctx, S) {
  // Hazard stripes: the loudest tile in the original set, and the one that says
  // "structure" fastest.
  ctx.fillStyle = PAL.face;
  ctx.fillRect(0, 0, S, S);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, S, S);
  ctx.clip();
  ctx.fillStyle = '#141414';
  const w = S * 0.26;
  for (let x = -S; x < S * 2; x += w * 2) {
    ctx.beginPath();
    ctx.moveTo(x, S);
    ctx.lineTo(x + w, S);
    ctx.lineTo(x + w + S, 0);
    ctx.lineTo(x + S, 0);
    ctx.closePath();
    ctx.fill();
  }
  const sheen = ctx.createLinearGradient(0, 0, 0, S);
  sheen.addColorStop(0, 'rgba(255,255,255,0.3)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, S, S);
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = Math.max(1, S * 0.06);
  ctx.strokeRect(0, 0, S, S);
}

/** Heatsink: extruded aluminium fins. */
function drawHeatsink(ctx, S) {
  // Brushed metal: the original's grey hatched plate.
  const g = ctx.createLinearGradient(0, 0, S * 0.4, S);
  g.addColorStop(0, '#c9cfd8');
  g.addColorStop(0.5, PAL.steel);
  g.addColorStop(1, '#5f666f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, S, S);
  ctx.clip();
  ctx.lineWidth = Math.max(1, S * 0.028);
  for (let k = -S; k < S * 2; k += S * 0.11) {
    ctx.strokeStyle = k % (S * 0.22) < S * 0.11 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.26)';
    ctx.beginPath();
    ctx.moveTo(k, 0);
    ctx.lineTo(k + S, S);
    ctx.stroke();
  }
  ctx.restore();
  const b = Math.max(1, S * 0.07);
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.fillRect(0, 0, S, b);
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(0, S - b, S, b);
}

/** Socket: a slab of ZIF pin grid. */
function drawSocket(ctx, S) {
  // The panel with the big round buttons on it.
  const g = ctx.createLinearGradient(0, 0, S * 0.3, S);
  g.addColorStop(0, '#9aa2b1');
  g.addColorStop(1, '#4a515c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const b = Math.max(1, S * 0.07);
  ctx.fillStyle = 'rgba(255,255,255,0.34)';
  ctx.fillRect(0, 0, S, b);
  ctx.fillRect(0, 0, b, S);
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(0, S - b, S, b);
  ctx.fillRect(S - b, 0, b, S);

  for (const [px, py, col] of [[0.32, 0.34, SPX.red], [0.68, 0.66, SPX.greenHi]]) {
    const r = S * 0.16;
    ctx.fillStyle = '#20242b';
    ctx.beginPath();
    ctx.arc(S * px, S * py, r * 1.28, 0, TAU);
    ctx.fill();
    orb(ctx, S * px, S * py, r, col, col, '#ffffff', 'rgba(0,0,0,0.4)');
    glow(ctx, S * px, S * py, r * 2, col, 0.3);
  }
}

/** Zonk: an electrolytic capacitor, and just as happy to land on your head. */
function drawZonk(ctx, S) {
  // The original zonk is a grey rounded block with a bright top-left and a hard
  // shadow bottom-right -- a metal boulder. The silhouette is kept exactly; what
  // is new is that the bevel is a gradient rather than two flat greys.
  const p = S * 0.06;
  const w = S - p * 2;
  const r = S * 0.26;

  contact(ctx, S * 0.5, S * 0.94, S * 0.42);

  ctx.save();
  rr(ctx, p, p, w, w, r);
  ctx.clip();

  const g = ctx.createLinearGradient(p, p, S - p, S - p);
  g.addColorStop(0, '#eef2f7');
  g.addColorStop(0.28, PAL.capBody);
  g.addColorStop(0.72, '#6f7681');
  g.addColorStop(1, PAL.capRim);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  // The band across the middle, and the sheen above it.
  ctx.fillStyle = 'rgba(20,24,30,0.34)';
  ctx.fillRect(0, S * 0.52, S, S * 0.1);
  const sh = ctx.createLinearGradient(0, p, 0, S * 0.52);
  sh.addColorStop(0, 'rgba(255,255,255,0.5)');
  sh.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sh;
  ctx.fillRect(0, 0, S, S * 0.52);

  ctx.restore();

  ctx.strokeStyle = 'rgba(8,10,14,0.85)';
  ctx.lineWidth = Math.max(1, S * 0.045);
  rr(ctx, p, p, w, w, r);
  ctx.stroke();
}

/** Infotron: a gold-plated data die. */
function drawInfotron(ctx, S, frame) {
  // A silver ball with a red-and-yellow band running across it. The band is the
  // thing people remember, so it turns: four frames of it sweeping round is what
  // makes a screen full of these feel alive rather than printed.
  const cx = S * 0.5, cy = S * 0.5, r = S * 0.4;
  const t = (frame % 4) / 4;

  contact(ctx, cx, S * 0.93, r * 0.95);
  orb(ctx, cx, cy, r, '#5f6773', PAL.capBody, '#f2f6fa', 'rgba(255,255,255,0.28)');

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.985, 0, TAU);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-0.5 + t * TAU);

  // Foreshorten the band as it goes round the back, so it reads as painted on
  // a sphere instead of laid over one.
  const squash = 0.45 + 0.55 * Math.abs(Math.cos(t * TAU));
  ctx.scale(1, 1);
  // Red at the edges, orange inside that, yellow at the core -- the band is a
  // hot filament seen end on, not a flat stripe, and that is most of why the
  // original's infotron looks like it is carrying something.
  const bg = ctx.createLinearGradient(0, -r * 0.36 * squash, 0, r * 0.36 * squash);
  bg.addColorStop(0, PAL.goldRim);
  bg.addColorStop(0.2, PAL.gold);
  bg.addColorStop(0.4, SPX.orange);
  bg.addColorStop(0.5, PAL.goldHot);
  bg.addColorStop(0.6, SPX.orange);
  bg.addColorStop(0.8, PAL.gold);
  bg.addColorStop(1, PAL.goldRim);
  ctx.fillStyle = bg;
  ctx.fillRect(-r, -r * 0.36 * squash, r * 2, r * 0.72 * squash);
  ctx.restore();

  // A second, tighter specular on top of the band: chrome over paint.
  const sg = ctx.createRadialGradient(cx - r * 0.36, cy - r * 0.42, 0, cx - r * 0.36, cy - r * 0.42, r * 0.42);
  sg.addColorStop(0, 'rgba(255,255,255,0.9)');
  sg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.arc(cx - r * 0.32, cy - r * 0.38, r * 0.4, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = 'rgba(10,12,16,0.7)';
  ctx.lineWidth = Math.max(1, S * 0.035);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.stroke();
}

/** Murphy: a service bot with a little CRT for a face. */
function drawMurphy(ctx, S, dir, frame) {
  // The original Murphy: a red sphere with a yellow patch over the brow, two
  // white eyes and a grey jaw that swings round to face the way he is going.
  // Everything here is that silhouette; what is new is that the sphere is lit,
  // the jaw has a bevel, and he blinks.
  const cx = S * 0.5, cy = S * 0.5, r = S * 0.42;
  const f = frame % 4;

  contact(ctx, cx, S * 0.95, r);
  orb(ctx, cx, cy, r, PAL.shellDark, PAL.shell, '#ff6a5a', 'rgba(90,0,0,0.55)');

  // The brow patch, yellow into orange, sitting up and left where the light is.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.98, 0, TAU);
  ctx.clip();
  const bg = ctx.createLinearGradient(0, cy - r, 0, cy);
  bg.addColorStop(0, PAL.face);
  bg.addColorStop(1, PAL.faceHot);
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.12, cy - r * 0.34, r * 0.62, r * 0.44, -0.25, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Which way he is looking. dir is U R D L; the eyes and the jaw both follow.
  const look = [[0, -0.16], [0.2, 0], [0, 0.14], [-0.2, 0]][dir] ?? [0, 0];
  const blink = f === 3;
  const ex = cx + r * 0.1, ey = cy - r * 0.16;
  for (const side of [-1, 1]) {
    const px = ex + side * r * 0.3;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(px, ey, r * 0.2, blink ? r * 0.05 : r * 0.23, 0, 0, TAU);
    ctx.fill();
    if (!blink) {
      ctx.fillStyle = PAL.visor;
      ctx.beginPath();
      ctx.arc(px + look[0] * r, ey + look[1] * r, r * 0.11, 0, TAU);
      ctx.fill();
    }
  }

  // The jaw: a grey wedge on the leading edge.
  const jaw = [[0, -0.62], [0.6, 0.2], [0, 0.62], [-0.6, 0.2]][dir] ?? [0.6, 0.2];
  const jx = cx + jaw[0] * r, jy = cy + jaw[1] * r;
  const jg = ctx.createLinearGradient(jx, jy - r * 0.2, jx, jy + r * 0.2);
  jg.addColorStop(0, '#e2e7ee');
  jg.addColorStop(0.5, PAL.service);
  jg.addColorStop(1, '#5a616b');
  ctx.fillStyle = jg;
  ctx.save();
  ctx.translate(jx, jy);
  ctx.rotate([Math.PI, 0, 0, Math.PI][dir] ?? 0);
  rr(ctx, -r * 0.42, -r * 0.17, r * 0.84, r * 0.34, r * 0.14);
  ctx.fill();
  ctx.restore();
}

/** Exit: a drive bay you can climb out through. */
function drawExit(ctx, S, open, frame) {
  // The original's drive bay: a grey slab cut into four rounded panels, like a
  // grating. Shut it is dead metal; open it is lit from behind and breathing.
  const t = (frame % 4) / 4;
  const lit = open ? PAL.phosphor : SPX.redDark;

  const g = ctx.createLinearGradient(0, 0, S * 0.4, S);
  g.addColorStop(0, '#aab1bd');
  g.addColorStop(0.5, PAL.fan);
  g.addColorStop(1, '#4e545d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  const b = Math.max(1, S * 0.07);
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.fillRect(0, 0, S, b);
  ctx.fillRect(0, 0, b, S);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, S - b, S, b);
  ctx.fillRect(S - b, 0, b, S);

  // Four panels, each with the light behind them.
  const pad = S * 0.13, gap = S * 0.05;
  const cell = (S - pad * 2 - gap) / 2;
  const pulse = open ? 0.6 + 0.4 * Math.sin(t * TAU) : 0.28;
  for (const [ix, iy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const x = pad + ix * (cell + gap), y = pad + iy * (cell + gap);
    ctx.fillStyle = '#12161b';
    rr(ctx, x, y, cell, cell, S * 0.07);
    ctx.fill();
    const pg = ctx.createRadialGradient(x + cell * 0.4, y + cell * 0.35, 0,
      x + cell * 0.5, y + cell * 0.5, cell * 0.8);
    pg.addColorStop(0, lit);
    pg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = pg;
    rr(ctx, x, y, cell, cell, S * 0.07);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(1, S * 0.03);
    rr(ctx, x, y, cell, cell, S * 0.07);
    ctx.stroke();
  }

  if (open) glow(ctx, S * 0.5, S * 0.5, S * 0.62, PAL.phosphor, 0.4 * pulse);
}

/** RAM chip: a DIP package with its legs in the board. */
function drawChip(ctx, S) {
  // The original's RAM chip: a dark green tile with squares nested inside each
  // other, like a die under a magnifier.
  chipBed(ctx, S);
  ctx.lineJoin = 'miter';
  for (let k = 0; k < 3; k++) {
    const inset = S * (0.16 + k * 0.11);
    ctx.strokeStyle = k === 0 ? 'rgba(140,255,200,0.5)' : `rgba(0,${190 - k * 40},${120 - k * 24},0.9)`;
    ctx.lineWidth = Math.max(1, S * 0.055);
    ctx.strokeRect(inset, inset, S - inset * 2, S - inset * 2);
  }
  ctx.fillStyle = PAL.silk;
  ctx.fillRect(S * 0.44, S * 0.44, S * 0.12, S * 0.12);
}

/** The dark green bed every chip variant is drawn on, with its bevel. */
function chipBed(ctx, S) {
  const g = ctx.createLinearGradient(0, 0, S * 0.3, S);
  g.addColorStop(0, '#016b41');
  g.addColorStop(0.6, '#00522f');
  g.addColorStop(1, '#00301c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const b = Math.max(1, S * 0.06);
  ctx.fillStyle = 'rgba(120,255,190,0.2)';
  ctx.fillRect(0, 0, S, b);
  ctx.fillRect(0, 0, b, S);
  ctx.fillStyle = 'rgba(0,18,10,0.45)';
  ctx.fillRect(0, S - b, S, b);
  ctx.fillRect(S - b, 0, b, S);
}

/** Snik Snak: a case fan gone walkabout. */
function drawSnikSnak(ctx, S, frame) {
  // Two dark-red pods on a grey spindle, rotating. The original turns it
  // through eight positions as it patrols; four reads the same at speed.
  const cx = S * 0.5, cy = S * 0.5;
  const a = (frame % 4) / 4 * Math.PI;    // half a turn: the shape is symmetric
  const reach = S * 0.33;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(a);

  // The spindle.
  const sg = ctx.createLinearGradient(0, -S * 0.1, 0, S * 0.1);
  sg.addColorStop(0, '#e8ecf2');
  sg.addColorStop(0.5, PAL.fan);
  sg.addColorStop(1, '#5a616b');
  ctx.fillStyle = sg;
  rr(ctx, -reach, -S * 0.095, reach * 2, S * 0.19, S * 0.09);
  ctx.fill();
  ctx.strokeStyle = 'rgba(8,10,14,0.6)';
  ctx.lineWidth = Math.max(1, S * 0.03);
  rr(ctx, -reach, -S * 0.095, reach * 2, S * 0.19, S * 0.09);
  ctx.stroke();

  // The pods on each end.
  for (const side of [-1, 1]) {
    const px = side * reach;
    orb(ctx, px, 0, S * 0.19, '#6b0000', PAL.bugShell, '#ff5a4a', 'rgba(40,0,0,0.5)');
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.arc(px - S * 0.06, -S * 0.07, S * 0.045, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  glow(ctx, cx, cy, S * 0.42, PAL.bugHot, 0.22);
}

/** Electron: a short arcing across the board. */
function drawElectron(ctx, S, frame) {
  // The original electron is a four-pointed blue star that twinkles -- a spark
  // of light, not a creature. Drawing it as a violet orb was simply wrong.
  const cx = S * 0.5, cy = S * 0.5;
  const t = (frame % 4) / 4;
  const beat = 0.72 + 0.28 * Math.sin(t * TAU);
  const R = S * 0.46 * beat;

  glow(ctx, cx, cy, S * 0.5, PAL.spark, 0.5 * beat);

  // Two stars over each other: a wide soft one and a tight white core, which is
  // what gives a spark its bloom without any bloom.
  for (const [len, thin, col, alpha] of [
    [R, 0.16, PAL.spark, 0.95],
    [R * 0.62, 0.1, PAL.sparkHot, 1],
  ]) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * TAU * 0.25);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, len);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.4, col);
    g.addColorStop(1, 'rgba(85,85,221,0)');
    ctx.fillStyle = g;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2;
      const ax = Math.cos(a), ay = Math.sin(a);
      const bx = Math.cos(a + Math.PI / 4), by = Math.sin(a + Math.PI / 4);
      if (!k) ctx.moveTo(ax * len, ay * len);
      else ctx.lineTo(ax * len, ay * len);
      ctx.lineTo(bx * len * thin, by * len * thin);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.07 * beat, 0, TAU);
  ctx.fill();
}

/** Bug: the literal kind, sitting on the board. */
function drawBug(ctx, S, active) {
  boardBed(ctx, S);
  const cx = S / 2, cy = S / 2;
  const body = active ? PAL.bugHot : PAL.bugShell;

  ctx.strokeStyle = active ? '#ffb3a0' : '#4a1a12';
  ctx.lineWidth = Math.max(1, S * 0.05);
  ctx.lineCap = 'round';
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const y = cy + (k - 1) * S * 0.2;
      ctx.beginPath();
      ctx.moveTo(cx + s * S * 0.16, y);
      ctx.lineTo(cx + s * S * 0.38, y + S * 0.08);
      ctx.stroke();
    }
  }

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(cx, cy + S * 0.04, S * 0.24, S * 0.3, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = '#1a0b08';
  ctx.lineWidth = Math.max(1, S * 0.035);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - S * 0.24);
  ctx.lineTo(cx, cy + S * 0.32);
  ctx.stroke();

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, cy - S * 0.26, S * 0.13, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = '#1a0b08';
  ctx.stroke();

  ctx.fillStyle = active ? '#fff2b0' : '#2a1210';
  ctx.beginPath();
  ctx.arc(cx - S * 0.06, cy - S * 0.28, S * 0.04, 0, TAU);
  ctx.arc(cx + S * 0.06, cy - S * 0.28, S * 0.04, 0, TAU);
  ctx.fill();

  if (active) glow(ctx, cx, cy, S * 0.6, PAL.bugHot, 0.55);
}

/** Terminal: a bank of DIP switches. */
function drawTerminal(ctx, S, frame) {
  drawHardware(ctx, S, null);
  ctx.fillStyle = '#1d2026';
  rr(ctx, S * 0.14, S * 0.18, S * 0.72, S * 0.62, S * 0.05);
  ctx.fill();
  ctx.strokeStyle = '#0a0c10';
  ctx.lineWidth = Math.max(1, S * 0.035);
  ctx.stroke();

  for (let k = 0; k < 4; k++) {
    const x = S * (0.2 + k * 0.17);
    const on = ((frame + k) % 4) < 2;
    ctx.fillStyle = on ? PAL.floppyR : '#7d848d';
    rr(ctx, x, S * (on ? 0.24 : 0.5), S * 0.12, S * 0.26, S * 0.02);
    ctx.fill();
  }
  ctx.fillStyle = PAL.silk;
  ctx.globalAlpha = 0.7;
  ctx.fillRect(S * 0.14, S * 0.83, S * 0.72, S * 0.04);
  ctx.globalAlpha = 1;
}

/** Disks: 3.5" floppies, colour-coded by how dangerous they are. */
function drawFloppy(ctx, S, color, frame, armed) {
  const cx = S / 2, cy = S / 2;
  if (armed) glow(ctx, cx, cy, S * 0.6, color, 0.3 + 0.4 * (frame % 2));

  ctx.fillStyle = color;
  rr(ctx, S * 0.12, S * 0.12, S * 0.76, S * 0.76, S * 0.07);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = Math.max(1, S * 0.04);
  ctx.stroke();

  ctx.fillStyle = PAL.shutter;
  ctx.fillRect(S * 0.3, S * 0.12, S * 0.42, S * 0.26);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(S * 0.44, S * 0.14, S * 0.16, S * 0.22);

  ctx.fillStyle = PAL.label;
  rr(ctx, S * 0.2, S * 0.46, S * 0.6, S * 0.34, S * 0.03);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(S * 0.25, S * 0.54, S * 0.42, S * 0.045);
  ctx.fillRect(S * 0.25, S * 0.64, S * 0.3, S * 0.045);

  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(S * 0.14, S * 0.14, S * 0.09, S * 0.09);

  if (armed) {
    ctx.fillStyle = frame % 2 ? '#fff' : color;
    ctx.beginPath();
    ctx.arc(S * 0.72, S * 0.72, S * 0.07, 0, TAU);
    ctx.fill();
  }
}

/** Ports: ribbon-cable headers with the direction they take. */
function drawPort(ctx, S, kind, frame) {
  const gravity = kind.gravity;
  const col = gravity ? PAL.keyP : PAL.phosphor;

  ctx.fillStyle = '#141a1c';
  ctx.fillRect(0, 0, S, S);
  for (let k = 0; k < 6; k++) {
    ctx.globalAlpha = k === 0 ? 1 : 0.55;
    ctx.fillStyle = k === 0 ? PAL.ribbonRed : PAL.ribbon;
    ctx.fillRect(S * (0.08 + k * 0.14), S * 0.06, S * 0.09, S * 0.88);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#0a0e10';
  ctx.lineWidth = Math.max(1, S * 0.05);
  rr(ctx, S * 0.06, S * 0.06, S * 0.88, S * 0.88, S * 0.1);
  ctx.stroke();

  const pulse = 0.55 + 0.45 * Math.sin((frame / 4) * TAU);
  ctx.save();
  ctx.translate(S / 2, S / 2);
  ctx.globalAlpha = 0.55 + 0.45 * pulse;
  ctx.fillStyle = col;
  const arrow = (rot) => {
    ctx.save();
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(S * 0.3, 0);
    ctx.lineTo(-S * 0.04, -S * 0.2);
    ctx.lineTo(-S * 0.04, -S * 0.07);
    ctx.lineTo(-S * 0.28, -S * 0.07);
    ctx.lineTo(-S * 0.28, S * 0.07);
    ctx.lineTo(-S * 0.04, S * 0.07);
    ctx.lineTo(-S * 0.04, S * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  for (const rot of kind.arrows) arrow(rot);
  ctx.restore();
  ctx.globalAlpha = 1;
  glow(ctx, S / 2, S / 2, S * 0.5, col, 0.25 * pulse);

  if (gravity) {
    ctx.fillStyle = '#141a1c';
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S * 0.14, 0, TAU);
    ctx.fill();
    ctx.fillStyle = col;
    ctx.font = `bold ${Math.round(S * 0.24)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('G', S / 2, S * 0.52);
  }
}

// --- hybrid elements --------------------------------------------------------

/** Keycard: a jumper cap you pull off the board. */
function drawKey(ctx, S, colour, frame) {
  boardBed(ctx, S);
  const col = KEY_COLS[colour];
  const cx = S / 2, cy = S / 2;
  glow(ctx, cx, cy, S * 0.46, col, 0.3 + 0.1 * Math.sin(frame / 4 * TAU));

  ctx.fillStyle = PAL.dipLeg;
  ctx.fillRect(cx - S * 0.16, cy + S * 0.12, S * 0.08, S * 0.22);
  ctx.fillRect(cx + S * 0.08, cy + S * 0.12, S * 0.08, S * 0.22);

  const g = ctx.createLinearGradient(0, cy - S * 0.24, 0, cy + S * 0.2);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.4, col);
  g.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = g;
  rr(ctx, cx - S * 0.24, cy - S * 0.24, S * 0.48, S * 0.44, S * 0.07);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = Math.max(1, S * 0.035);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillRect(cx - S * 0.16, cy - S * 0.16, S * 0.32, S * 0.06);
}

/** Lock: a shunted header only the matching cap will open. */
function drawLock(ctx, S, colour, frame) {
  drawHardware(ctx, S, null);
  const col = KEY_COLS[colour];
  ctx.fillStyle = '#15181d';
  rr(ctx, S * 0.1, S * 0.1, S * 0.8, S * 0.8, S * 0.08);
  ctx.fill();
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(1.4, S * 0.07);
  rr(ctx, S * 0.1, S * 0.1, S * 0.8, S * 0.8, S * 0.08);
  ctx.stroke();

  ctx.fillStyle = PAL.dipLeg;
  for (let k = 0; k < 3; k++) {
    const x = S * (0.26 + k * 0.2);
    ctx.fillRect(x, S * 0.3, S * 0.08, S * 0.4);
  }
  ctx.fillStyle = col;
  ctx.globalAlpha = 0.55 + 0.45 * Math.sin(frame / 4 * TAU);
  rr(ctx, S * 0.22, S * 0.42, S * 0.56, S * 0.18, S * 0.04);
  ctx.fill();
  ctx.globalAlpha = 1;
  glow(ctx, S / 2, S / 2, S * 0.44, col, 0.2);
}

/** Thermal boots: a pair of heatsinks to stand on. */
function drawBoots(ctx, S) {
  boardBed(ctx, S);
  glow(ctx, S / 2, S / 2, S * 0.44, '#9fd8ff', 0.2);
  for (const off of [-1, 1]) {
    const cx = S / 2 + off * S * 0.19;
    ctx.fillStyle = '#8f98a4';
    rr(ctx, cx - S * 0.14, S * 0.28, S * 0.28, S * 0.46, S * 0.04);
    ctx.fill();
    ctx.strokeStyle = '#40474f';
    ctx.lineWidth = Math.max(1, S * 0.025);
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.moveTo(cx - S * 0.14, S * (0.34 + k * 0.1));
      ctx.lineTo(cx + S * 0.14, S * (0.34 + k * 0.1));
      ctx.stroke();
    }
    ctx.fillStyle = '#d9e2ea';
    ctx.fillRect(cx - S * 0.14, S * 0.28, S * 0.28, S * 0.04);
  }
}

/** Rack: a 3.5" hard drive, heavy enough to hold a plate down. */
function drawRack(ctx, S) {
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, '#b9c0c9');
  g.addColorStop(1, '#6f7680');
  ctx.fillStyle = g;
  rr(ctx, S * 0.06, S * 0.08, S * 0.88, S * 0.84, S * 0.06);
  ctx.fill();
  ctx.strokeStyle = '#2b3038';
  ctx.lineWidth = Math.max(1, S * 0.045);
  ctx.stroke();

  ctx.fillStyle = '#3c424b';
  ctx.beginPath();
  ctx.arc(S * 0.44, S * 0.5, S * 0.26, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#8e97a2';
  ctx.beginPath();
  ctx.arc(S * 0.44, S * 0.5, S * 0.09, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = '#d3dae2';
  ctx.lineWidth = Math.max(1, S * 0.04);
  ctx.beginPath();
  ctx.moveTo(S * 0.78, S * 0.24);
  ctx.lineTo(S * 0.6, S * 0.46);
  ctx.stroke();

  ctx.fillStyle = PAL.label;
  ctx.fillRect(S * 0.12, S * 0.12, S * 0.3, S * 0.14);
  ctx.fillStyle = '#5a6069';
  for (let k = 0; k < 4; k++) ctx.fillRect(S * 0.12, S * (0.8 + k * 0.04), S * 0.76, S * 0.02);
  ctx.fillStyle = PAL.screw;
  for (const [px, py] of [[0.12, 0.9], [0.88, 0.9], [0.12, 0.1], [0.88, 0.1]]) {
    ctx.beginPath();
    ctx.arc(S * px, S * py, S * 0.035, 0, TAU);
    ctx.fill();
  }
}

/** Slime: the 1990s capacitor plague, creeping across the board. */
function drawSlime(ctx, S, frame) {
  boardBed(ctx, S);
  const cx = S / 2, cy = S / 2;
  glow(ctx, cx, cy, S * 0.55, PAL.oozeHot, 0.25);

  const wob = Math.sin((frame / 4) * TAU) * S * 0.03;
  const g = ctx.createRadialGradient(cx - S * 0.1, cy - S * 0.12, S * 0.05, cx, cy, S * 0.5);
  g.addColorStop(0, PAL.oozeHot);
  g.addColorStop(0.6, PAL.ooze);
  g.addColorStop(1, '#3d4a12');
  ctx.fillStyle = g;
  ctx.beginPath();
  for (let k = 0; k <= 12; k++) {
    const a = (k / 12) * TAU;
    const r = S * 0.44 + Math.sin(a * 3 + frame) * S * 0.045 + wob;
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (const [px, py, r] of [[0.36, 0.36, 0.07], [0.62, 0.48, 0.05], [0.48, 0.66, 0.04]]) {
    ctx.beginPath();
    ctx.arc(S * px, S * (py + Math.sin(frame + px * 9) * 0.02), S * r, 0, TAU);
    ctx.fill();
  }
}

// --- floors -----------------------------------------------------------------

/** Ice: the data bus. Step on it and you are carried along. */
function drawIce(ctx, S, frame) {
  ctx.fillStyle = '#0d2430';
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = '#2f6f86';
  ctx.lineWidth = Math.max(1, S * 0.05);
  for (let k = 0; k < 5; k++) {
    const y = S * (0.12 + k * 0.19);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(S, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#7fe6ff';
  for (let k = 0; k < 5; k++) {
    const y = S * (0.12 + k * 0.19);
    const x = ((frame * 0.22 + k * 0.2) % 1) * S;
    ctx.fillRect(x - S * 0.12, y - S * 0.025, S * 0.22, S * 0.05);
  }
  ctx.globalAlpha = 1;
  glow(ctx, S / 2, S / 2, S * 0.5, '#7fe6ff', 0.16);
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = Math.max(1, S * 0.03);
  ctx.strokeRect(0, 0, S, S);
}

/** Pressure plate: a socket that wants something heavy in it. */
function drawPad(ctx, S, pressed) {
  boardBed(ctx, S);
  ctx.fillStyle = pressed ? '#2c6a3f' : '#28323a';
  rr(ctx, S * 0.12, S * 0.12, S * 0.76, S * 0.76, S * 0.06);
  ctx.fill();
  ctx.strokeStyle = pressed ? PAL.phosphor : '#5d6a74';
  ctx.lineWidth = Math.max(1.2, S * 0.055);
  rr(ctx, S * 0.12, S * 0.12, S * 0.76, S * 0.76, S * 0.06);
  ctx.stroke();

  ctx.fillStyle = pressed ? PAL.phosphor : '#7f8a94';
  for (let k = 0; k < 3; k++) {
    for (let j = 0; j < 3; j++) {
      ctx.beginPath();
      ctx.arc(S * (0.28 + j * 0.22), S * (0.28 + k * 0.22), S * 0.035, 0, TAU);
      ctx.fill();
    }
  }
  if (pressed) glow(ctx, S / 2, S / 2, S * 0.5, PAL.phosphor, 0.3);
}

/** Phase floor: a trace that burns out once current has run through it. */
function drawPhase(ctx, S, hot, frame) {
  ctx.fillStyle = '#131c18';
  ctx.fillRect(0, 0, S, S);
  const col = hot ? '#ff8a3c' : '#54c2a0';
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(1.2, S * 0.06);
  ctx.globalAlpha = hot ? 0.5 + 0.5 * (frame % 2) : 0.85;
  ctx.beginPath();
  ctx.moveTo(0, S * 0.5);
  ctx.lineTo(S * 0.3, S * 0.5);
  ctx.lineTo(S * 0.45, S * 0.3);
  ctx.lineTo(S * 0.6, S * 0.7);
  ctx.lineTo(S * 0.75, S * 0.5);
  ctx.lineTo(S, S * 0.5);
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(S * 0.5, S * 0.5, S * 0.06, 0, TAU);
  ctx.fill();
  glow(ctx, S / 2, S / 2, S * 0.45, col, hot ? 0.45 : 0.18);
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = Math.max(1, S * 0.03);
  ctx.strokeRect(0, 0, S, S);
}

/** Fire: a component running far too hot to touch. */
function drawFire(ctx, S, frame) {
  ctx.fillStyle = '#2a0f08';
  ctx.fillRect(0, 0, S, S);
  const g = ctx.createRadialGradient(S / 2, S * 0.6, S * 0.05, S / 2, S * 0.6, S * 0.6);
  g.addColorStop(0, '#fff0a0');
  g.addColorStop(0.4, PAL.hot);
  g.addColorStop(1, 'rgba(60,10,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  ctx.fillStyle = '#4a1b10';
  rr(ctx, S * 0.22, S * 0.3, S * 0.56, S * 0.44, S * 0.05);
  ctx.fill();
  ctx.strokeStyle = '#ffb257';
  ctx.lineWidth = Math.max(1, S * 0.035);
  ctx.stroke();

  ctx.globalAlpha = 0.55 + 0.45 * Math.sin((frame / 4) * TAU);
  ctx.strokeStyle = '#ffd08a';
  ctx.lineWidth = Math.max(1, S * 0.05);
  ctx.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    const x = S * (0.3 + k * 0.2);
    ctx.beginPath();
    ctx.moveTo(x, S * 0.28);
    ctx.quadraticCurveTo(x + S * 0.06, S * 0.16, x, S * 0.06);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  glow(ctx, S / 2, S * 0.55, S * 0.55, PAL.hot, 0.45);
}

/** Force field: a live gap you cannot cross until the plates are loaded. */
function drawForce(ctx, S, on, frame) {
  ctx.fillStyle = '#0b1416';
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = PAL.steelDark;
  ctx.fillRect(0, 0, S, S * 0.1);
  ctx.fillRect(0, S * 0.9, S, S * 0.1);

  if (!on) {
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = '#3d6b7a';
    ctx.lineWidth = Math.max(1, S * 0.04);
    ctx.beginPath();
    ctx.moveTo(S * 0.5, S * 0.12);
    ctx.lineTo(S * 0.5, S * 0.88);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }

  ctx.strokeStyle = '#7ff0ff';
  ctx.lineWidth = Math.max(1, S * 0.045);
  ctx.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin((frame + k) * 1.7));
    ctx.beginPath();
    ctx.moveTo(S * (0.35 + k * 0.1), S * 0.12);
    ctx.lineTo(S * (0.62 - k * 0.12), S * 0.38);
    ctx.lineTo(S * (0.36 + k * 0.14), S * 0.62);
    ctx.lineTo(S * (0.6 - k * 0.08), S * 0.88);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  glow(ctx, S / 2, S / 2, S * 0.55, '#7ff0ff', 0.4);
}

function drawBoom(ctx, S, frame, total, infotron) {
  const t = frame / (total - 1);
  const cx = S / 2, cy = S / 2;
  const r = S * (0.15 + 0.42 * Math.sin(Math.min(1, t * 1.2) * Math.PI * 0.5));

  const hot = infotron ? PAL.goldHot : '#ffffff';
  const mid = infotron ? PAL.gold : '#ffb63c';
  const cool = infotron ? PAL.goldRim : '#ff4d1a';

  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, r));
  g.addColorStop(0, hot);
  g.addColorStop(0.45, mid);
  g.addColorStop(0.8, cool);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 1 - t * 0.55;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();

  ctx.globalAlpha = (1 - t) * 0.85;
  ctx.strokeStyle = hot;
  ctx.lineWidth = Math.max(1, S * 0.06 * (1 - t));
  for (let k = 0; k < 6; k++) {
    const a = k * (TAU / 6) + t * 1.4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 0.4, cy + Math.sin(a) * r * 0.4);
    ctx.lineTo(cx + Math.cos(a) * r * 1.25, cy + Math.sin(a) * r * 1.25);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// --- sprite set -------------------------------------------------------------

export const BASE_VARIANTS = TRACES.length;
export const BOOM_FRAMES = 8;
const ANIM_FRAMES = 4;

/**
 * Build every sprite at `size` device pixels.
 * Returns { size, get(key, frame) -> canvas }.
 */
export function buildSprites(size) {
  const S = Math.max(8, Math.round(size));
  const store = new Map();

  const add = (key, frames, draw) => {
    const list = [];
    for (let f = 0; f < frames; f++) {
      const c = makeCanvas(S, S);
      const ctx = c.getContext('2d');
      draw(ctx, f);
      list.push(c);
    }
    store.set(key, list);
  };

  add(T.HARDWARE, 1, (ctx) => drawHardware(ctx, S, null));
  add(T.HW_GREEN, 1, (ctx) => drawHardware(ctx, S, '#4dff9e'));
  add(T.HW_RED, 1, (ctx) => drawHardware(ctx, S, '#ff5a6e'));
  for (let v = 0; v < TRACES.length; v++) add(`base-${v}`, 1, (ctx) => drawBase(ctx, S, v));
  add(T.ZONK, 1, (ctx) => drawZonk(ctx, S));
  add(T.CHIP, 1, (ctx) => drawChip(ctx, S));
  add(T.CHIP_L, 1, (ctx) => drawChipHalf(ctx, S, 'L'));
  add(T.CHIP_R, 1, (ctx) => drawChipHalf(ctx, S, 'R'));
  add(T.CHIP_T, 1, (ctx) => drawChipHalf(ctx, S, 'T'));
  add(T.CHIP_B, 1, (ctx) => drawChipHalf(ctx, S, 'B'));
  add(T.SLOT, 1, (ctx) => drawSlot(ctx, S));
  add(T.HEATSINK, 1, (ctx) => drawHeatsink(ctx, S));
  add(T.SOCKET, 1, (ctx) => drawSocket(ctx, S));
  add(T.INFOTRON, ANIM_FRAMES, (ctx, f) => drawInfotron(ctx, S, f));
  add(T.SNIKSNAK, ANIM_FRAMES, (ctx, f) => drawSnikSnak(ctx, S, f));
  add(T.ELECTRON, ANIM_FRAMES, (ctx, f) => drawElectron(ctx, S, f));
  add(T.TERMINAL, ANIM_FRAMES, (ctx, f) => drawTerminal(ctx, S, f));
  add(T.ORANGE, ANIM_FRAMES, (ctx, f) => drawFloppy(ctx, S, PAL.floppyO, f, false));
  add(T.YELLOW, ANIM_FRAMES, (ctx, f) => drawFloppy(ctx, S, PAL.floppyY, f, false));
  add(T.RED, ANIM_FRAMES, (ctx, f) => drawFloppy(ctx, S, PAL.floppyR, f, false));
  add('red-armed', ANIM_FRAMES, (ctx, f) => drawFloppy(ctx, S, PAL.floppyR, f, true));
  add('bug-off', 1, (ctx) => drawBug(ctx, S, false));
  add('bug-on', 1, (ctx) => drawBug(ctx, S, true));
  add('exit-off', ANIM_FRAMES, (ctx, f) => drawExit(ctx, S, false, f));
  add('exit-on', ANIM_FRAMES, (ctx, f) => drawExit(ctx, S, true, f));
  add(T.RACK, 1, (ctx) => drawRack(ctx, S));
  add(T.SLIME, ANIM_FRAMES, (ctx, f) => drawSlime(ctx, S, f));
  add(T.BOOTS, 1, (ctx) => drawBoots(ctx, S));

  for (let c = 0; c < 4; c++) {
    add(T.KEY_A + c, ANIM_FRAMES, (ctx, f) => drawKey(ctx, S, c, f));
    add(T.LOCK_A + c, ANIM_FRAMES, (ctx, f) => drawLock(ctx, S, c, f));
  }

  for (let d = 0; d < 4; d++) {
    add(`murphy-${d}`, ANIM_FRAMES, (ctx, f) => drawMurphy(ctx, S, d, f));
  }

  const R = 0, D = Math.PI / 2, L = Math.PI, U = -Math.PI / 2;
  const portKinds = {
    [T.PORT_R]: { arrows: [R], gravity: false },
    [T.PORT_L]: { arrows: [L], gravity: false },
    [T.PORT_U]: { arrows: [U], gravity: false },
    [T.PORT_D]: { arrows: [D], gravity: false },
    [T.GPORT_R]: { arrows: [R], gravity: true },
    [T.GPORT_L]: { arrows: [L], gravity: true },
    [T.GPORT_U]: { arrows: [U], gravity: true },
    [T.GPORT_D]: { arrows: [D], gravity: true },
    [T.PORT_V]: { arrows: [U, D], gravity: false },
    [T.PORT_H]: { arrows: [L, R], gravity: false },
    [T.PORT_X]: { arrows: [U, D, L, R], gravity: false },
  };
  for (const [tile, kind] of Object.entries(portKinds)) {
    add(Number(tile), ANIM_FRAMES, (ctx, f) => drawPort(ctx, S, kind, f));
  }

  add(`fl-${FL.ICE}`, ANIM_FRAMES, (ctx, f) => drawIce(ctx, S, f));
  add(`fl-${FL.PAD}`, 1, (ctx) => drawPad(ctx, S, false));
  add('fl-pad-on', 1, (ctx) => drawPad(ctx, S, true));
  add(`fl-${FL.PHASE}`, ANIM_FRAMES, (ctx, f) => drawPhase(ctx, S, false, f));
  add('fl-phase-hot', ANIM_FRAMES, (ctx, f) => drawPhase(ctx, S, true, f));
  add(`fl-${FL.FIRE}`, ANIM_FRAMES, (ctx, f) => drawFire(ctx, S, f));
  add(`fl-${FL.FORCE}`, ANIM_FRAMES, (ctx, f) => drawForce(ctx, S, true, f));
  add('fl-force-off', ANIM_FRAMES, (ctx, f) => drawForce(ctx, S, false, f));

  add('boom', BOOM_FRAMES, (ctx, f) => drawBoom(ctx, S, f, BOOM_FRAMES, false));
  add('boom-i', BOOM_FRAMES, (ctx, f) => drawBoom(ctx, S, f, BOOM_FRAMES, true));

  return {
    size: S,
    get(key, frame = 0) {
      const list = store.get(key);
      if (!list) return null;
      return list[((frame % list.length) + list.length) % list.length];
    },
    has(key) { return store.has(key); },
    /** Every key built, with how many frames each has. For the tile viewer. */
    keys() { return [...store].map(([k, list]) => ({ key: k, frames: list.length })); },
  };
}
