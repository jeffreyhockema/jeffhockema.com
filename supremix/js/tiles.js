// Tile vocabulary and level loading. Shared by the browser game and the
// offline level validator, so parsing rules can never drift between them.
//
// Numbering follows the original Supaplex element table where it exists, which
// keeps the mental model (and any future .SP importer) honest.

export const T = {
  EMPTY: 0,
  ZONK: 1,
  BASE: 2,
  MURPHY: 3,
  INFOTRON: 4,
  CHIP: 5,
  HARDWARE: 6,
  EXIT: 7,
  ORANGE: 8,
  PORT_R: 9,
  PORT_D: 10,
  PORT_L: 11,
  PORT_U: 12,
  GPORT_R: 13,
  GPORT_D: 14,
  GPORT_L: 15,
  GPORT_U: 16,
  SNIKSNAK: 17,
  YELLOW: 18,
  TERMINAL: 19,
  RED: 20,
  PORT_V: 21,
  PORT_H: 22,
  PORT_X: 23,
  ELECTRON: 24,
  BUG: 25,
  HW_GREEN: 26,
  HW_RED: 27,

  // Halves of a two-cell DIP package. The original draws most of its chips as
  // pairs -- a body split across two cells -- and single-cell blocks are what
  // made our boards read as masonry rather than as a circuit board. Numbering
  // follows the original element table.
  CHIP_L: 34, CHIP_R: 35,
  CHIP_T: 38, CHIP_B: 39,

  // Hybrid elements, borrowed from the puzzle games either side of Supaplex.
  // Chip's Challenge: coloured access cards and the doors they open.
  KEY_A: 40, KEY_C: 41, KEY_G: 42, KEY_P: 43,        // amber, cyan, green, purple
  LOCK_A: 44, LOCK_C: 45, LOCK_G: 46, LOCK_P: 47,
  BOOTS: 48,                                          // thermal shielding
  // Sokoban: a heavy thing you shove onto a plate.
  RACK: 49,
  // Boulder Dash: growth that crystallises when you box it in.
  SLIME: 50,
  // Scenery with no rules attached, so a board can be drawn as hardware rather
  // than as an abstract maze: expansion slots, heatsink fins, socket pins.
  SLOT: 51,
  HEATSINK: 52,
  SOCKET: 53,

  // Runtime-only tiles, never authored in a level file.
  BOOM: 60,
  BOOM_I: 61,
};

/**
 * The surface a cell has, independent of what is standing on it.
 *
 * Supaplex only ever needed one thing per cell, but ice, pressure plates,
 * collapsing walkways and force fields all have to sit UNDER something --
 * Murphy, a zonk, a server rack -- so they live in their own layer.
 */
export const FL = {
  NONE: 0,
  ICE: 1,     // slide until something stops you
  PAD: 2,     // pressure plate; a rack parked here counts as pressed
  PHASE: 3,   // walkway that seals itself a few seconds after you use it
  FIRE: 4,    // lethal without boots
  FORCE: 5,   // impassable until every pad is pressed
};

export const CHAR_TO_FLOOR = {
  '~': FL.ICE, '@': FL.PAD, ';': FL.PHASE, X: FL.FIRE, F: FL.FORCE,
};

export const CHAR_TO_TILE = {
  ' ': T.EMPTY, '.': T.EMPTY,
  '#': T.HARDWARE, '%': T.HW_GREEN, '&': T.HW_RED,
  ':': T.BASE, '=': T.CHIP,
  '[': T.CHIP_L, ']': T.CHIP_R, '"': T.CHIP_T, '_': T.CHIP_B,
  M: T.MURPHY, O: T.ZONK, I: T.INFOTRON, E: T.EXIT,
  S: T.SNIKSNAK, e: T.ELECTRON, B: T.BUG, T: T.TERMINAL,
  o: T.ORANGE, y: T.YELLOW, r: T.RED,
  '>': T.PORT_R, '<': T.PORT_L, '^': T.PORT_U, v: T.PORT_D,
  1: T.GPORT_R, 2: T.GPORT_D, 3: T.GPORT_L, 4: T.GPORT_U,
  '|': T.PORT_V, '-': T.PORT_H, '+': T.PORT_X,
  a: T.KEY_A, c: T.KEY_C, g: T.KEY_G, p: T.KEY_P,
  A: T.LOCK_A, C: T.LOCK_C, G: T.LOCK_G, P: T.LOCK_P,
  w: T.BOOTS, H: T.RACK, '*': T.SLIME,
  L: T.SLOT, J: T.HEATSINK, K: T.SOCKET,
};

/** Keys and their doors share an index: 0 amber, 1 cyan, 2 green, 3 purple. */
export const KEY_COLOURS = ['amber', 'cyan', 'green', 'purple'];
export function isKey(t) { return t >= T.KEY_A && t <= T.KEY_P; }
export function isLock(t) { return t >= T.LOCK_A && t <= T.LOCK_P; }
export function keyColour(t) { return t - T.KEY_A; }
export function lockColour(t) { return t - T.LOCK_A; }

// --- element predicates -----------------------------------------------------

/** Solid scenery: nothing moves it, nothing destroys it. */
export function isWall(t) {
  return isChassis(t) || isChip(t);
}

/**
 * Wall that an explosion cannot touch.
 *
 * A DIP chip is a wall to walk into and it is not one of these: a blast takes
 * it out, which is how several of the original boards are finished at all --
 * level 105 has its drive bay behind a single chip and nothing else.
 */
export function isChassis(t) {
  return t === T.HARDWARE || t === T.HW_GREEN || t === T.HW_RED
    || t === T.SLOT || t === T.HEATSINK || t === T.SOCKET;
}

/** Any part of a DIP package, whole or half. */
export function isChip(t) {
  return t === T.CHIP || t === T.CHIP_L || t === T.CHIP_R
    || t === T.CHIP_T || t === T.CHIP_B;
}

/**
 * Zonks and infotrons roll off anything with a rounded top: each other, and the
 * single RAM chip. The halves of a two-cell chip are flat, as the original has
 * them -- a zonk sits on a long chip rather than sliding off it.
 */
export function isRound(t) {
  return t === T.ZONK || t === T.INFOTRON || t === T.CHIP;
}

/** Obeys gravity. */
export function isFaller(t) {
  return t === T.ZONK || t === T.INFOTRON || t === T.ORANGE;
}

/** Detonates when caught in a blast or crushed. */
export function isBomb(t) {
  return t === T.ORANGE || t === T.YELLOW || t === T.RED;
}

export function isEnemy(t) {
  return t === T.SNIKSNAK || t === T.ELECTRON;
}

export function isPort(t) {
  return (t >= T.PORT_R && t <= T.GPORT_U) || (t >= T.PORT_V && t <= T.PORT_X);
}

export function isGravityPort(t) {
  return t >= T.GPORT_R && t <= T.GPORT_U;
}

/**
 * Survives an explosion. Everything else in the 3x3 is vaporised.
 *
 * In the original only hardware stands -- an exit or a port caught in a blast
 * is gone, and so is the level if that was the only way out. Keys, doors, racks
 * and boots are ours, and proof on purpose: they are puzzle furniture, and a
 * stray blast destroying the only amber key would quietly strand the player.
 */
export function isBlastProof(t) {
  return isChassis(t) || isKey(t) || isLock(t) || t === T.RACK || t === T.BOOTS;
}

/**
 * Can something travel through this port heading (dx, dy)?
 * Ports are strictly one-way in the original, which is the whole puzzle.
 */
export function portAllows(t, dx, dy) {
  switch (t) {
    case T.PORT_R: case T.GPORT_R: return dx === 1;
    case T.PORT_L: case T.GPORT_L: return dx === -1;
    case T.PORT_U: case T.GPORT_U: return dy === -1;
    case T.PORT_D: case T.GPORT_D: return dy === 1;
    case T.PORT_V: return dx === 0;
    case T.PORT_H: return dy === 0;
    case T.PORT_X: return true;
    default: return false;
  }
}

// --- level loading ----------------------------------------------------------

export class LevelParseError extends Error {}

/**
 * Extend a short authored row to the full interior width.
 *
 * A row continues with whatever material it ends in: a wall row ending in '#',
 * '%' or '&' runs to the edge as wall, a base row ends in ':' and stays base,
 * and anything else (an entity, or an empty row) pads with empty space. That means a level
 * can be drawn only as wide as it is interesting without a short wall row
 * silently leaving a gap at the edge -- which is exactly the bug that used to
 * open accidental shafts through several levels.
 */
const CONTINUES = new Set([':', '#', '%', '&', '=']);

export function padRow(row, width) {
  if (row.length >= width) return row;
  const last = row[row.length - 1];
  const fill = CONTINUES.has(last) ? last : ' ';
  return row + fill.repeat(width - row.length);
}

/** Same idea for the optional floor map: a surface runs on to the edge. */
export function padFloorRow(row, width) {
  if (row.length >= width) return row;
  const last = row[row.length - 1];
  const fill = last && CHAR_TO_FLOOR[last] !== undefined ? last : ' ';
  return row + fill.repeat(width - row.length);
}

/**
 * Turn an authored level (interior rows only) into a flat tile grid.
 * Adds the hardware border, pads short rows with empty space, and rejects
 * rows that overflow the declared width.
 */
export function parseLevel(def, index = 0) {
  const w = def.w | 0;
  const h = def.h | 0;
  if (w < 5 || h < 5) throw new LevelParseError(`level ${index + 1}: size ${w}x${h} is too small`);

  const inner = w - 2;
  const rows = def.rows || [];
  if (rows.length > h - 2) {
    throw new LevelParseError(`level ${index + 1}: ${rows.length} rows will not fit in height ${h}`);
  }

  const tiles = new Uint8Array(w * h).fill(T.HARDWARE);
  const floor = new Uint8Array(w * h).fill(FL.NONE);
  let murphy = -1;
  let infotrons = 0;

  // An optional parallel map for surfaces. Without it a floor character in
  // `rows` claims the cell and leaves it empty, which is fine for plain ice or
  // a bare plate; with it, anything can stand on anything -- an infotron out on
  // the data bus, a rack already sitting on its plate.
  const floorRows = def.floors || null;

  for (let y = 1; y < h - 1; y++) {
    const authored = rows[y - 1] || '';
    if (authored.length > inner) {
      throw new LevelParseError(
        `level ${index + 1}: row ${y} is ${authored.length} chars, max ${inner}`);
    }
    const row = padRow(authored, inner);
    const frow = floorRows ? padFloorRow(floorRows[y - 1] || '', inner) : null;

    for (let x = 1; x < w - 1; x++) {
      const ch = row[x - 1] ?? ' ';
      const i = y * w + x;

      if (frow) {
        const fch = frow[x - 1] ?? ' ';
        const ff = CHAR_TO_FLOOR[fch];
        if (ff === undefined && fch !== ' ' && fch !== '.') {
          throw new LevelParseError(
            `level ${index + 1}: unknown floor character "${fch}" at row ${y}`);
        }
        floor[i] = ff === undefined ? FL.NONE : ff;
      }

      // Without a floor map, a surface character claims the cell and leaves it
      // empty; objects are then placed by the level, not in the same glyph.
      const f = CHAR_TO_FLOOR[ch];
      if (f !== undefined) {
        if (!frow) floor[i] = f;
        tiles[i] = T.EMPTY;
        continue;
      }

      const t = CHAR_TO_TILE[ch];
      if (t === undefined) {
        throw new LevelParseError(`level ${index + 1}: unknown character "${ch}" at row ${y}`);
      }
      tiles[i] = t;
      if (t === T.MURPHY) {
        if (murphy >= 0) throw new LevelParseError(`level ${index + 1}: more than one Murphy`);
        murphy = i;
      }
      if (t === T.INFOTRON) infotrons++;
    }
  }

  if (murphy < 0) throw new LevelParseError(`level ${index + 1}: no Murphy`);
  if (!tiles.includes(T.EXIT)) throw new LevelParseError(`level ${index + 1}: no exit`);

  const need = def.need == null ? infotrons : def.need | 0;

  return {
    index,
    name: def.name || `Level ${index + 1}`,
    hint: def.hint || '',
    w, h, tiles, floor, murphy, infotrons,
    need,
    gravity: !!def.gravity,
    slimeCap: def.slimeCap == null ? 70 : def.slimeCap | 0,
  };
}

export function parsePack(defs) {
  if (!Array.isArray(defs)) {
    throw new LevelParseError('the pack is not a list of levels');
  }
  return defs.map((d, i) => parseLevel(d, i));
}
