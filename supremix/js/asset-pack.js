// Asset packs: the remastered graphics, the sounds and the music, bundled into
// a few binary files with their bytes scrambled.
//
// Why packs: the graphics are redrawn from the original game's, the sounds are
// its Sound Blaster samples and the music its own score (see the README's
// licence). None of it should sit on the server as loose PNGs, WAVs and MP3s
// that anyone can browse to, preview and save. A pack cannot be previewed, and
// its contents do not look like images or audio to anything that scans for them.
//
// This is obfuscation, not security, and is not meant to be more. The key is
// PACK_KEY below, in plain sight; the aim is only that lifting the art takes
// deliberate effort rather than a right-click. (The scheme is TDDL's.)
//
// Two layers live here:
//
//   - Pure functions -- parsePack(), readEntry(), encodePack() -- that work on
//     bytes alone, so tools/pack-assets.mjs builds packs with exactly the code
//     that reads them, and the Node tests read the shipped packs directly.
//   - A loader, openPack(), that downloads a pack once and hands out entries as
//     bytes (for decodeAudioData) or as object URLs (for an Image). The rest of
//     the game never sees a pack: it draws Images and plays AudioBuffers exactly
//     as it did when they came from loose files.
//
// Format (version 1), all integers little-endian:
//
//   0   4  magic "SRPK"
//   4   1  format version (1)
//   5   3  reserved, zero
//   8   4  size of the whole pack in bytes
//   12  4  length of the index in bytes
//   16  4  CRC-32 of the plain index
//   20  .. the index, scrambled
//   ..  .. every entry's data, scrambled, back to back in index order
//
// The index is UTF-8 JSON: a list of {crc, length, name, offset, type} sorted by
// name, where `offset` is from the start of the pack and `crc` is the CRC-32 of
// the entry's plain bytes, so a damaged pack is caught rather than handed to an
// image or audio decoder. Scrambling XORs the bytes with an xorshift32
// keystream seeded per entry from the key and a hash of the entry's name, so no
// two entries share a pattern and a PNG's well-known header does not give the
// key away for the rest. Packing is deterministic: the same files always make
// byte-identical packs.

/** "SRPK": the first four bytes of every pack. */
export const PACK_MAGIC = [0x53, 0x52, 0x50, 0x4b];
export const PACK_VERSION = 1;
export const PACK_HEADER_SIZE = 20;

/** The scrambling key. */
const PACK_KEY = 0x5a9e3c71;

/** The name the index is scrambled under; no entry can have it. */
const INDEX_SEED_NAME = ':index';

/** Thrown for a pack that cannot be read; `code` says why. */
export class PackError extends Error {
  /** @param {'format'|'version'|'truncated'|'corrupt'|'missing'} code */
  constructor(message, code) {
    super(message);
    this.name = 'PackError';
    this.code = code;
  }
}

// --- hashes and the keystream ---------------------------------------------------

let crcTable = null;

/** Standard CRC-32 (the zlib polynomial). */
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** FNV-1a over a name's UTF-8 bytes. */
function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h >>> 0;
}

/** MurmurHash3's finaliser, so names a letter apart get unrelated seeds. */
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** An entry's keystream seed; xorshift32 must never be seeded with 0. */
function seedFor(name) {
  return fmix32((PACK_KEY ^ fnv1a32(name)) >>> 0) || 1;
}

/**
 * XORs bytes with an entry's keystream, into a fresh array with a buffer of
 * exactly its length (decodeAudioData takes, and detaches, the whole buffer).
 * Its own inverse. The keystream is xorshift32's state, low byte first.
 */
export function scramble(bytes, name) {
  const length = bytes.length;
  const out = new Uint8Array(length);
  const whole = length - (length % 4);
  let x = seedFor(name);
  let i = 0;
  for (; i < whole; i += 4) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = bytes[i] ^ x;
    out[i + 1] = bytes[i + 1] ^ (x >>> 8);
    out[i + 2] = bytes[i + 2] ^ (x >>> 16);
    out[i + 3] = bytes[i + 3] ^ (x >>> 24);
  }
  if (i < length) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    for (let shift = 0; i < length; i++, shift += 8) out[i] = bytes[i] ^ (x >>> shift);
  }
  return out;
}

// --- decoding -------------------------------------------------------------------

/** Parses a pack's header and index; entry data stays scrambled until read. */
export function parsePack(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < PACK_HEADER_SIZE) throw new PackError(`only ${bytes.length} bytes, too short for a pack`, 'truncated');
  if (!PACK_MAGIC.every((b, i) => bytes[i] === b)) throw new PackError('not an asset pack', 'format');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  if (version !== PACK_VERSION) throw new PackError(`pack format ${version}, this game reads ${PACK_VERSION}`, 'version');
  const size = view.getUint32(8, true);
  const indexLength = view.getUint32(12, true);
  const indexCrc = view.getUint32(16, true);
  if (bytes.length !== size) {
    throw new PackError(`${bytes.length} bytes, the header says ${size}`, bytes.length < size ? 'truncated' : 'corrupt');
  }
  if (PACK_HEADER_SIZE + indexLength > size) throw new PackError('index runs past the end of the pack', 'corrupt');

  const indexBytes = scramble(bytes.subarray(PACK_HEADER_SIZE, PACK_HEADER_SIZE + indexLength), INDEX_SEED_NAME);
  if (crc32(indexBytes) !== indexCrc) throw new PackError('index checksum does not match', 'corrupt');
  let records;
  try {
    records = JSON.parse(new TextDecoder().decode(indexBytes));
  } catch (error) {
    throw new PackError(`index is not readable: ${error.message}`, 'corrupt');
  }
  if (!Array.isArray(records)) throw new PackError('index is not a list', 'corrupt');

  const entries = new Map();
  const dataStart = PACK_HEADER_SIZE + indexLength;
  for (const record of records) {
    const { name, offset, length, type, crc } = record || {};
    const sane = typeof name === 'string' && name.length > 0 && !entries.has(name)
      && Number.isInteger(offset) && Number.isInteger(length) && Number.isInteger(crc)
      && offset >= dataStart && length >= 0 && offset + length <= size && typeof type === 'string';
    if (!sane) throw new PackError(`index entry ${JSON.stringify(record)} is invalid`, 'corrupt');
    entries.set(name, { name, offset, length, type, crc });
  }
  return { version, size, entries, bytes };
}

/** Unscrambles one entry and checks it against its checksum. */
export function readEntry(pack, name) {
  const entry = pack.entries.get(name);
  if (!entry) throw new PackError(`no entry "${name}"`, 'missing');
  const plain = scramble(pack.bytes.subarray(entry.offset, entry.offset + entry.length), name);
  if (crc32(plain) !== entry.crc) throw new PackError(`entry "${name}" is damaged (checksum mismatch)`, 'corrupt');
  return plain;
}

// --- encoding (tools/pack-assets.mjs; the game only reads packs) ----------------

/**
 * Builds a pack from {name, type, bytes} files. Entries go in name order and
 * the index has sorted keys, so the output depends only on the inputs.
 */
export function encodePack(files) {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const names = new Set();
  for (const f of sorted) {
    if (!f.name || f.name === INDEX_SEED_NAME || names.has(f.name)) throw new Error(`bad or duplicate entry name: ${f.name}`);
    names.add(f.name);
  }
  const encoder = new TextEncoder();
  // Offsets depend on the index's length and its length on the offsets; they
  // only grow together, so this settles in a pass or two.
  let indexBytes = new Uint8Array(0);
  for (;;) {
    let offset = PACK_HEADER_SIZE + indexBytes.length;
    const records = sorted.map((f) => {
      const record = { crc: crc32(f.bytes), length: f.bytes.length, name: f.name, offset, type: f.type };
      offset += f.bytes.length;
      return record;
    });
    const next = encoder.encode(JSON.stringify(records));
    if (next.length === indexBytes.length) { indexBytes = next; break; }
    indexBytes = next;
  }
  const size = PACK_HEADER_SIZE + indexBytes.length + sorted.reduce((sum, f) => sum + f.bytes.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PACK_MAGIC, 0);
  view.setUint8(4, PACK_VERSION);
  view.setUint32(8, size, true);
  view.setUint32(12, indexBytes.length, true);
  view.setUint32(16, crc32(indexBytes), true);
  out.set(scramble(indexBytes, INDEX_SEED_NAME), PACK_HEADER_SIZE);
  let at = PACK_HEADER_SIZE + indexBytes.length;
  for (const f of sorted) {
    out.set(scramble(f.bytes, f.name), at);
    at += f.bytes.length;
  }
  return out;
}

// --- loading --------------------------------------------------------------------

/** The packs the game ships, by group. */
export const PACKS = {
  gfx: 'packs/gfx.pak',       // the remastered atlas: remaster.png, remaster.json
  sfx: 'packs/sfx.pak',       // the remastered Sound Blaster effects (WAV)
  music: 'packs/music.pak',   // the MT-32 theme and exit jingle (MP3)
  levels: 'packs/levels.pak', // the static demo's level pack (levels.json); see tools/build-demo.mjs
};

const loads = new Map();

/**
 * Downloads and parses a pack, once however many ask. Never rejects: resolves
 * to null if the pack is missing or unreadable (logged here, once), and the
 * callers fall back -- to the procedural sprites, the synthesised sounds, or
 * silence -- as they did when a loose file was missing.
 */
export function openPack(url) {
  let load = loads.get(url);
  if (!load) {
    load = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => parsePack(buf))
      .catch((error) => {
        console.warn(`Asset pack ${url} not loaded (${error.message}); falling back.`);
        return null;
      });
    loads.set(url, load);
  }
  return load;
}

/** An entry's bytes, or null if its pack or the entry is not there. */
export async function packedBytes(url, name) {
  const pack = await openPack(url);
  if (!pack || !pack.entries.has(name)) return null;
  try {
    return readEntry(pack, name);
  } catch (error) {
    console.warn(`Asset pack ${url}: ${error.message}`);
    return null;
  }
}

/**
 * An entry as an object URL, for an Image. Object URLs share the page's origin,
 * so drawing them never taints a canvas.
 */
export async function packedURL(url, name) {
  const pack = await openPack(url);
  const bytes = await packedBytes(url, name);
  if (!bytes) return null;
  return URL.createObjectURL(new Blob([bytes], { type: pack.entries.get(name).type }));
}
