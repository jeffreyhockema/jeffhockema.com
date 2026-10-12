// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Jeff Hockema. See LICENSE and NOTICE.md.

/**
 * =============================================================================
 * ASSET PACKS
 * =============================================================================
 *
 * Reads the packs tools/pack_assets.py builds: the sprites and sounds, bundled
 * into a few binary files with their bytes scrambled.
 *
 * Why packs: the art is CraftPix's and the sounds are the Doom Sound Bulb
 * pack's, and neither should sit in a public repository as loose PNGs and WAVs
 * anyone can browse, preview and save. A pack cannot be previewed, and its
 * contents do not look like images or audio to anything that scans for them.
 *
 * This is obfuscation, not security, and is not meant to be more. The key is
 * PACK_KEY below, in plain sight; the aim is only that extracting the art takes
 * deliberate effort rather than a right-click.
 *
 * Two layers live here:
 *
 *   - Pure functions -- parsePack(), readEntry(), encodePack() -- that work on
 *     bytes alone, so the Node test suites can read the committed packs
 *     directly. encodePack() is not used by the game; it is the format's other
 *     half, kept beside the decoder so the tests can check that the two
 *     implementations (this and tools/pack_assets.py) still agree.
 *
 *   - A loader, openPack(), that downloads a pack once, reports its bytes as
 *     they stream in for the loading bar, and hands out entries -- as Image
 *     elements through loadPackedImage(), or as raw bytes for decodeAudioData().
 *     The rest of the game never sees a pack: it draws Image objects and plays
 *     AudioBuffers exactly as it did when they came from loose files.
 *
 * The format is described in full in tools/pack_assets.py.
 */

import { whenImageReady } from './asset-preloader.js';

// =============================================================================
// FORMAT
// =============================================================================

/** "TDPK": the first four bytes of every pack. */
export const PACK_MAGIC = [0x54, 0x44, 0x50, 0x4b];

/** The format version this decoder reads. Bump with tools/pack_assets.py. */
export const PACK_VERSION = 1;

/** Bytes before the index: magic, version, reserved, size, index length, index CRC. */
export const PACK_HEADER_SIZE = 20;

/** The scrambling key. Must match KEY in tools/pack_assets.py. */
const PACK_KEY = 0x7dd1a55e;

/** The name the index is scrambled under; no entry can have it. */
const INDEX_SEED_NAME = ':index';

/**
 * Thrown for a pack that cannot be read: not a pack, a version this code does
 * not know, truncated, or damaged. `code` says which, for callers that care.
 */
export class PackError extends Error {
    /**
     * @param {string} message - What is wrong
     * @param {'format'|'version'|'truncated'|'corrupt'|'missing'} code - The kind of failure
     */
    constructor(message, code) {
        super(message);
        this.name = 'PackError';
        this.code = code;
    }
}

// =============================================================================
// HASHES AND THE KEYSTREAM -- mirrored in tools/pack_assets.py
// =============================================================================

/** CRC-32 lookup table (the zlib polynomial), built on first use. */
let crcTable = null;

/**
 * Standard CRC-32, the same as Python's zlib.crc32. Catches a damaged pack
 * before its bytes reach an image or audio decoder, which would fail in far
 * less helpful ways.
 *
 * @param {Uint8Array} bytes
 * @returns {number} Unsigned 32-bit checksum
 */
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
    for (let i = 0; i < bytes.length; i++) {
        crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * FNV-1a over a name's UTF-8 bytes: a cheap, well-spread hash that makes each
 * entry's keystream different.
 *
 * @param {string} text
 * @returns {number} Unsigned 32-bit hash
 */
function fnv1a32(text) {
    let h = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(text)) {
        h = Math.imul(h ^ byte, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/**
 * MurmurHash3's finaliser, so names that differ by a letter still get
 * unrelated seeds.
 *
 * @param {number} h
 * @returns {number} Unsigned 32-bit mix
 */
function fmix32(h) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

/**
 * The keystream seed for one entry. xorshift32 must never be seeded with 0,
 * which would make the "keystream" all zeroes.
 *
 * @param {string} name - Entry name
 * @returns {number}
 */
function seedFor(name) {
    return fmix32((PACK_KEY ^ fnv1a32(name)) >>> 0) || 1;
}

/**
 * XORs bytes with an entry's keystream, into a fresh array. Its own inverse,
 * so the same function scrambles and unscrambles.
 *
 * The keystream is xorshift32: each step's 32-bit state, low byte first. Not
 * cryptographic, and it need not be -- see the top of the file.
 *
 * @param {Uint8Array} bytes - Input; not modified
 * @param {string} name - Entry name the keystream is seeded from
 * @returns {Uint8Array} A new array, with its own ArrayBuffer of exactly its
 *          length (decodeAudioData() takes, and detaches, the whole buffer)
 */
export function scramble(bytes, name) {
    const length = bytes.length;
    const out = new Uint8Array(length);
    const whole = length - (length % 4);
    let x = seedFor(name);
    let i = 0;
    for (; i < whole; i += 4) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        out[i] = bytes[i] ^ x;
        out[i + 1] = bytes[i + 1] ^ (x >>> 8);
        out[i + 2] = bytes[i + 2] ^ (x >>> 16);
        out[i + 3] = bytes[i + 3] ^ (x >>> 24);
    }
    if (i < length) {
        // The last one to three bytes take the low bytes of one more step.
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        for (let shift = 0; i < length; i++, shift += 8) out[i] = bytes[i] ^ (x >>> shift);
    }
    return out;
}

// =============================================================================
// DECODING
// =============================================================================

/**
 * @typedef {Object} PackEntry
 * @property {string} name - File name, as the manifests refer to it
 * @property {number} offset - Byte offset of the data from the start of the pack
 * @property {number} length - Byte length of the data
 * @property {string} type - MIME type
 * @property {number} crc - CRC-32 of the plain data
 */

/**
 * @typedef {Object} ParsedPack
 * @property {number} version - Format version
 * @property {number} size - Total size in bytes
 * @property {Map<string, PackEntry>} entries - By name, in pack order
 * @property {Uint8Array} bytes - The whole pack, still scrambled
 */

/**
 * Reads a pack's header the moment its first bytes are in, so the loader knows
 * how big the whole thing is before the server says (or when it never does).
 *
 * @param {Uint8Array} bytes - At least the first PACK_HEADER_SIZE bytes
 * @returns {number} The declared total size, or 0 if this does not look like a pack
 */
export function declaredPackSize(bytes) {
    if (bytes.length < PACK_HEADER_SIZE) return 0;
    if (!PACK_MAGIC.every((b, i) => bytes[i] === b)) return 0;
    return new DataView(bytes.buffer, bytes.byteOffset, PACK_HEADER_SIZE).getUint32(8, true);
}

/**
 * Parses a pack's header and index. Cheap: entry data is left scrambled until
 * someone asks for it with readEntry().
 *
 * @param {ArrayBuffer|Uint8Array} data - The whole pack
 * @returns {ParsedPack}
 * @throws {PackError} If the bytes are not a whole, readable pack
 */
export function parsePack(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

    if (bytes.length < PACK_HEADER_SIZE) {
        throw new PackError(`only ${bytes.length} bytes, too short for a pack header`, 'truncated');
    }
    if (!PACK_MAGIC.every((b, i) => bytes[i] === b)) {
        throw new PackError('not an asset pack', 'format');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint8(4);
    if (version !== PACK_VERSION) {
        throw new PackError(`pack format ${version}, this game reads ${PACK_VERSION}`, 'version');
    }

    const size = view.getUint32(8, true);
    const indexLength = view.getUint32(12, true);
    const indexCrc = view.getUint32(16, true);

    if (bytes.length !== size) {
        throw new PackError(`${bytes.length} bytes, the header says ${size}`,
                            bytes.length < size ? 'truncated' : 'corrupt');
    }
    if (PACK_HEADER_SIZE + indexLength > size) {
        throw new PackError('index runs past the end of the pack', 'corrupt');
    }

    const indexBytes = scramble(bytes.subarray(PACK_HEADER_SIZE, PACK_HEADER_SIZE + indexLength), INDEX_SEED_NAME);
    if (crc32(indexBytes) !== indexCrc) {
        throw new PackError('index checksum does not match', 'corrupt');
    }

    let records;
    try {
        records = JSON.parse(new TextDecoder().decode(indexBytes));
    } catch (error) {
        throw new PackError(`index is not readable: ${error.message}`, 'corrupt');
    }
    if (!Array.isArray(records)) {
        throw new PackError('index is not a list', 'corrupt');
    }

    const entries = new Map();
    const dataStart = PACK_HEADER_SIZE + indexLength;
    for (const record of records) {
        const { name, offset, length, type, crc } = record || {};
        const sane = typeof name === 'string' && name.length > 0 && !entries.has(name)
            && Number.isInteger(offset) && Number.isInteger(length) && Number.isInteger(crc)
            && offset >= dataStart && length >= 0 && offset + length <= size
            && typeof type === 'string';
        if (!sane) {
            throw new PackError(`index entry ${JSON.stringify(record)} is invalid`, 'corrupt');
        }
        entries.set(name, { name, offset, length, type, crc });
    }

    return { version, size, entries, bytes };
}

/**
 * @param {ParsedPack} pack
 * @param {string} name - Entry name
 * @returns {boolean} True if the pack holds that entry
 */
export function hasEntry(pack, name) {
    return !!pack && pack.entries.has(name);
}

/**
 * Unscrambles one entry and checks it against its checksum.
 *
 * @param {ParsedPack} pack - From parsePack()
 * @param {string} name - Entry name, e.g. "imp.png"
 * @returns {Uint8Array} The entry's original bytes, in a buffer of their own
 * @throws {PackError} If the entry is absent or damaged
 */
export function readEntry(pack, name) {
    const entry = pack.entries.get(name);
    if (!entry) throw new PackError(`no entry "${name}"`, 'missing');

    const plain = scramble(pack.bytes.subarray(entry.offset, entry.offset + entry.length), name);
    if (crc32(plain) !== entry.crc) {
        throw new PackError(`entry "${name}" is damaged (checksum mismatch)`, 'corrupt');
    }
    return plain;
}

// =============================================================================
// ENCODING -- for the tests; the game only reads packs
// =============================================================================

/**
 * Builds a pack, byte for byte as tools/pack_assets.py does.
 *
 * @param {Array<{name: string, type: string, bytes: Uint8Array}>} files
 * @returns {Uint8Array} The pack
 */
export function encodePack(files) {
    const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const encoder = new TextEncoder();

    // Offsets depend on the index's length and the index's length on the
    // offsets; they only grow together, so this settles in a pass or two.
    let indexBytes = new Uint8Array(0);
    for (;;) {
        let offset = PACK_HEADER_SIZE + indexBytes.length;
        // Keys in sorted order, to match Python's json.dumps(sort_keys=True).
        const records = sorted.map((file) => {
            const record = {
                crc: crc32(file.bytes), length: file.bytes.length,
                name: file.name, offset, type: file.type,
            };
            offset += file.bytes.length;
            return record;
        });
        const next = encoder.encode(JSON.stringify(records));
        if (next.length === indexBytes.length) { indexBytes = next; break; }
        indexBytes = next;
    }

    const size = PACK_HEADER_SIZE + indexBytes.length
        + sorted.reduce((sum, file) => sum + file.bytes.length, 0);
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    out.set(PACK_MAGIC, 0);
    view.setUint8(4, PACK_VERSION);
    view.setUint32(8, size, true);
    view.setUint32(12, indexBytes.length, true);
    view.setUint32(16, crc32(indexBytes), true);
    out.set(scramble(indexBytes, INDEX_SEED_NAME), PACK_HEADER_SIZE);

    let at = PACK_HEADER_SIZE + indexBytes.length;
    for (const file of sorted) {
        out.set(scramble(file.bytes, file.name), at);
        at += file.bytes.length;
    }
    return out;
}

// =============================================================================
// LOADING
// =============================================================================

/**
 * Downloads a whole pack, reporting bytes as they arrive.
 *
 * The total comes from the pack's own header once the first chunk is in --
 * Content-Length is only a stand-in until then, and is wrong anyway when a
 * server compresses on the fly. Where a response has no readable stream (old
 * browsers, the test stubs) the body is read in one go.
 *
 * @param {string} url
 * @param {(loaded: number, total: number) => void} onBytes
 * @returns {Promise<Uint8Array>}
 */
async function download(url, onBytes) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const advertised = Number(response.headers?.get?.('Content-Length')) || 0;
    const reader = response.body && typeof response.body.getReader === 'function'
        ? response.body.getReader() : null;

    if (!reader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        onBytes(bytes.length, bytes.length);
        return bytes;
    }

    const chunks = [];
    let loaded = 0;
    let total = advertised;
    let head = null;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (!head && loaded >= PACK_HEADER_SIZE) {
            head = chunks.length === 1 ? value : concat(chunks, loaded);
            total = declaredPackSize(head) || total;
        }
        onBytes(loaded, Math.max(total, loaded));
    }
    return concat(chunks, loaded);
}

/**
 * @param {Uint8Array[]} chunks
 * @param {number} length - Their combined length
 * @returns {Uint8Array} One array holding them all
 */
function concat(chunks, length) {
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

/**
 * One pack's download, shared by everything that reads from it.
 *
 * `ready` never rejects: it resolves to the parsed pack, or to null if the
 * pack is missing or unreadable -- which is logged here, once, so the loaders
 * reading from it can stay quiet and simply fall back.
 */
class PackLoad {
    /** @param {string} url */
    constructor(url) {
        this.url = url;
        this.loaded = 0;
        this.total = 0;
        this.listeners = new Set();

        /** @type {Promise<ParsedPack|null>} */
        this.ready = download(url, (loaded, total) => this.progress(loaded, total))
            .then((bytes) => {
                const pack = parsePack(bytes);
                this.progress(pack.size, pack.size);
                return pack;
            })
            .catch((error) => {
                console.warn(`AssetPack: could not load ${url} (${error.message}). ` +
                             `Its art or sound will use the fallback.`);
                return null;
            });
    }

    /**
     * Subscribes to byte progress. The listener is told the current position
     * at once, so a late subscriber does not miss what has already arrived.
     *
     * @param {(loaded: number, total: number) => void} listener
     */
    onProgress(listener) {
        this.listeners.add(listener);
        listener(this.loaded, this.total);
    }

    /** @private */
    progress(loaded, total) {
        this.loaded = loaded;
        this.total = total;
        for (const listener of this.listeners) {
            try {
                listener(loaded, total);
            } catch (error) {
                console.warn('AssetPack: progress listener failed:', error);
            }
        }
    }
}

/** url -> PackLoad. A pack is downloaded once however many loaders ask. */
const loads = new Map();

/**
 * Starts a pack downloading, or returns the download already under way.
 *
 * @param {string} url - Where the pack lives
 * @returns {PackLoad} Has `ready` (resolves to the pack or null) and
 *          `onProgress(listener)` for the loading bar
 */
export function openPack(url) {
    let load = loads.get(url);
    if (!load) {
        load = new PackLoad(url);
        loads.set(url, load);
    }
    return load;
}

/**
 * Reads an entry's bytes out of a pack that is loading.
 *
 * @param {Promise<ParsedPack|null>} packReady - A pack, once it is in
 * @param {string} name - Entry name
 * @returns {Promise<Uint8Array|null>} The bytes, or null if the pack never
 *          arrived (already logged by the pack's loader)
 * @throws {PackError} If the pack arrived but the entry is absent or damaged
 */
export async function readPackedBytes(packReady, name) {
    const pack = await packReady;
    if (!pack) return null;
    return readEntry(pack, name);
}

/**
 * Makes an Image from a pack entry.
 *
 * The Image is returned at once and has no src until the pack is in, so
 * renderers can hold on to it and draw it whenever `complete && naturalHeight`
 * says it is ready, exactly as they did with images loaded from a URL.
 *
 * The entry becomes a Blob and the Blob an object URL. Object URLs share the
 * page's origin, so drawing these never taints the canvas the lighting pass
 * reads back. The URLs are not revoked: there are a few dozen at most, they
 * live as long as the page, and some browsers re-read the source of a large
 * image after discarding its decoded copy.
 *
 * @param {Promise<ParsedPack|null>} packReady - The pack holding the image
 * @param {string} name - Entry name, e.g. "man.png"
 * @param {string} label - What the image is, for the warning if it fails
 * @returns {{image: HTMLImageElement, ready: Promise<boolean>}} `ready`
 *          resolves true once the image is decoded and drawable, false if it
 *          could not be (the caller's fallback drawing then stands)
 */
export function loadPackedImage(packReady, name, label) {
    const image = new Image();
    const ready = Promise.resolve(packReady)
        .then((pack) => {
            // No pack: its loader has already said so, once, for all of them.
            if (!pack) return false;
            const bytes = readEntry(pack, name);
            const { type } = pack.entries.get(name);
            image.src = URL.createObjectURL(new Blob([bytes], { type }));
            return whenImageReady(image);
        })
        .then((ok) => {
            if (!ok && image.src) console.warn(`${label}: "${name}" did not decode`);
            return ok;
        }, (error) => {
            console.warn(`${label}: could not read "${name}" from its pack (${error.message})`);
            return false;
        });
    return { image, ready };
}

/**
 * Forgets every pack download, so the next openPack() fetches afresh.
 * Test-only hook.
 *
 * @param {string} [url] - Forget only this pack
 */
export function _resetPacksForTest(url) {
    if (url) loads.delete(url);
    else loads.clear();
}
