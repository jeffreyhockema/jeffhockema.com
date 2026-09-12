/**
 * AUDIO ENGINE MODULE
 *
 * The mix and the playback primitives, built directly on the Web Audio API.
 *
 * The sounds themselves are Doom's, from the Sound Bulb remaster -- loaded and
 * decoded here (see loadSample) and chosen and placed by audio-system.js. This
 * module is everything underneath that:
 *
 *   - a shared mix bus with saturation, bus compression and ducking, so a
 *     firefight adds up to "loud" instead of "clipped";
 *   - a convolution reverb fed from a procedurally generated stone-room impulse,
 *     kept almost dry, so sounds share a space without smearing;
 *   - sample loading, caching and pitch-shifted playback;
 *   - a voice budget, so a room full of dying enemies cannot spawn 200 nodes;
 *   - synthesis primitives -- noise, swept filters, pitch envelopes, sustained
 *     voices -- for the few sounds Doom never had (dry fire, the
 *     low-health heartbeat) and the menu music.
 *
 * The history matters for the shape of this file: the game first made every
 * sound with a single Tone.js synth voice, then with layered synthesis here.
 * Both sounded like placeholders next to the real thing, which is why the
 * samples took over and the synthesis shrank to what it is now.
 *
 * No library, no CDN. If the environment has no AudioContext (an old browser,
 * or Node during tests) every entry point here degrades to silence rather than
 * throwing.
 *
 * @author TDDL Game Team
 * @version 3.0.0
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Floor value for exponential ramps.
 *
 * exponentialRampToValueAtTime() throws on a target of 0, so envelopes decay to
 * this instead of silence and are then hard-set to 0 a moment later.
 */
const EPS = 0.0001;

/**
 * Scheduling offset. Notes start this far in the future so a render quantum
 * boundary never lands mid-attack, which is audible as a click.
 */
const LOOKAHEAD = 0.005;

/**
 * Maximum simultaneous voices. Beyond this, new non-priority sounds are dropped;
 * the mix is already saturated at that point and the extra nodes only cost CPU.
 */
const MAX_VOICES = 28;

/**
 * Hard ceiling, including sounds marked priority.
 *
 * Priority voices (explosions, the player being hit, stingers) skip the budget
 * so the sounds that carry information are never the ones dropped -- but they
 * still have to stop somewhere, or a scripted chain of explosions could walk the
 * count up without limit.
 */
const VOICE_CEILING = MAX_VOICES * 2;

/**
 * Mix levels per category, in linear gain. Tuned so gunfire sits above impacts,
 * pickups cut through both, and UI/ambient stay out of the way.
 */
const BUS_LEVELS = {
    weapon: 0.85,
    impact: 0.9,
    enemy: 0.7,
    pickup: 0.7,
    ui: 0.5,
    ambient: 0.45,
    music: 0.5,
};

/**
 * Master tone shaping, applied to everything before the compressor.
 *
 * Nearly every sound here carries a low tone layer for weight -- a gunshot's
 * body, a footstep's heel, a wall taking an impact -- and stacked up they turn
 * the mix boomy. Rather than thin out each sound individually, the low end is
 * shaped once at the bus:
 *
 *   - a high-pass removes sub energy that is felt as rumble but carries no
 *     information at these sizes, and stops it from driving the compressor;
 *   - a shelf below it takes a few dB out of the boom band proper.
 *
 * These are the two knobs to reach for if the mix needs more or less bottom.
 */
const MASTER_HIGHPASS_HZ = 95;
const MASTER_SHELF_HZ = 220;
const MASTER_SHELF_DB = -5;

/**
 * The reverb is fed high-passed well above the master's cut.
 *
 * Low frequencies smeared over a 1.9-second tail are what turns a room into a
 * drone: the boom outlasts the sound that caused it. Keeping the send bright
 * preserves the sense of space while letting the low end stay dry and tight.
 */
const REVERB_HIGHPASS_HZ = 300;

// =============================================================================
// ENGINE STATE
// =============================================================================

let ctx = null;                 // The AudioContext
let masterGain = null;          // User volume
let duckGain = null;            // Transient ducking (explosions, player damage)
let saturator = null;           // Soft-clip stage: glues layers, tames peaks
let toneShaper = null;          // Master high-pass into the compressor
let compressor = null;          // Bus compressor
let reverbSend = null;          // Send bus into the convolver
let reverbReturn = null;        // Wet return level
let buses = {};                 // Per-category dry gain nodes
let noiseBuffers = {};          // Cached white/pink/brown noise
let driveCurves = {};           // Cached waveshaper curves by drive amount
let activeVoices = 0;           // Voice budget accounting
let userVolume = 0.9;           // Last requested master volume
let muted = false;

// =============================================================================
// CONTEXT LIFECYCLE
// =============================================================================

/**
 * Returns the AudioContext constructor if this environment has one.
 * Node (during tests) and very old browsers have neither.
 *
 * @returns {Function|null}
 */
function audioContextCtor() {
    if (typeof AudioContext !== 'undefined') return AudioContext;
    if (typeof webkitAudioContext !== 'undefined') return webkitAudioContext;
    return null;
}

/**
 * Creates the context and mix graph if they do not exist yet.
 * Safe to call repeatedly, and safe to call before any user gesture -- the
 * context is simply created suspended and resumed later by startAudio().
 *
 * @returns {boolean} True if a context exists afterwards
 */
export function ensureContext() {
    if (ctx) return true;

    const Ctor = audioContextCtor();
    if (!Ctor) return false;

    try {
        ctx = new Ctor({ latencyHint: 'interactive' });
        buildGraph();
        return true;
    } catch (error) {
        console.warn('Audio engine: could not create AudioContext:', error);
        ctx = null;
        return false;
    }
}

/**
 * Resumes the context. Browsers create it suspended until a user gesture, so
 * this must be called from a click or keypress handler.
 *
 * @async
 * @returns {Promise<boolean>} True if audio is running afterwards
 */
export async function startAudio() {
    if (!ensureContext()) return false;

    if (ctx.state !== 'running') {
        try {
            await ctx.resume();
        } catch (error) {
            console.warn('Audio engine: resume rejected:', error);
            return false;
        }
    }
    return ctx.state === 'running';
}

/**
 * @returns {boolean} True when it is safe to schedule sound right now
 */
export function isReady() {
    return !!ctx && ctx.state === 'running' && !!masterGain;
}

/**
 * @returns {string} 'unavailable' | 'suspended' | 'running' | 'closed'
 */
export function contextState() {
    if (!ctx) return audioContextCtor() ? 'suspended' : 'unavailable';
    return ctx.state;
}

/**
 * Current scheduling time, already nudged into the future by the lookahead.
 * @returns {number} Time in AudioContext seconds
 */
export function now() {
    return ctx ? ctx.currentTime + LOOKAHEAD : 0;
}

/**
 * Wall-clock milliseconds, used for cooldown bookkeeping. Deliberately
 * independent of the AudioContext so cooldowns also work before audio starts.
 *
 * @returns {number}
 */
export function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
}

// =============================================================================
// MIX GRAPH
// =============================================================================

/**
 * Builds the shared output chain:
 *
 *   category buses --+--> saturator --+--> tone --> compressor --> duck --> master --> out
 *                    |                 |
 *                    +--> send --> convolver --> return --+
 *
 * The saturator runs before the compressor on purpose: it rounds off the peaks
 * of stacked transients, which is most of what makes layered gunfire read as
 * "beefy" rather than "clipped", and the compressor then rides the average.
 *
 * The tone stage sits between them, so both the dry sum and the reverb return
 * are shaped before compression. Putting it after the compressor would leave the
 * low end driving gain reduction even once it had been filtered out of the
 * output -- the mix would still duck as though it were boomy.
 */
function buildGraph() {
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : userVolume;
    masterGain.connect(ctx.destination);

    duckGain = ctx.createGain();
    duckGain.gain.value = 1;
    duckGain.connect(masterGain);

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 12;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;
    compressor.connect(duckGain);

    // Master tone: high-pass, then a shelf to tame the boom band. Everything
    // meets here, dry and wet alike.
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = MASTER_SHELF_HZ;
    lowShelf.gain.value = MASTER_SHELF_DB;
    lowShelf.connect(compressor);

    toneShaper = ctx.createBiquadFilter();
    toneShaper.type = 'highpass';
    toneShaper.frequency.value = MASTER_HIGHPASS_HZ;
    toneShaper.Q.value = 0.7;
    toneShaper.connect(lowShelf);

    saturator = ctx.createWaveShaper();
    saturator.curve = makeDriveCurve(1.4);
    saturator.oversample = '2x';
    saturator.connect(toneShaper);

    // Reverb. A generated impulse costs nothing to ship and puts every sound in
    // the same room, which is most of the difference between game audio and beeps.
    reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.55;
    reverbReturn.connect(toneShaper);

    try {
        const convolver = ctx.createConvolver();
        convolver.buffer = makeImpulseResponse(1.9, 3.0);
        convolver.connect(reverbReturn);

        // Darken the tail: a bright reverb on top of noise-heavy sounds is hiss.
        const tailTone = ctx.createBiquadFilter();
        tailTone.type = 'lowpass';
        tailTone.frequency.value = 3200;
        tailTone.connect(convolver);

        // ...but keep the bottom out of it. Low end held for 1.9 seconds is a
        // drone, and it is most of what made the room read as boomy.
        const tailBody = ctx.createBiquadFilter();
        tailBody.type = 'highpass';
        tailBody.frequency.value = REVERB_HIGHPASS_HZ;
        tailBody.Q.value = 0.7;
        tailBody.connect(tailTone);

        reverbSend = ctx.createGain();
        reverbSend.gain.value = 1;
        reverbSend.connect(tailBody);
    } catch (error) {
        // Convolver unsupported: run dry rather than silent.
        console.warn('Audio engine: reverb unavailable, running dry:', error);
        reverbSend = null;
    }

    buses = {};
    for (const name of Object.keys(BUS_LEVELS)) {
        const bus = ctx.createGain();
        bus.gain.value = BUS_LEVELS[name];
        bus.connect(saturator);
        buses[name] = bus;
    }
}

/**
 * Builds a tanh soft-clipping curve.
 *
 * @param {number} amount - Drive; 1 is nearly clean, 6 is aggressive
 * @returns {Float32Array} Waveshaper curve
 */
function makeDriveCurve(amount) {
    const key = amount.toFixed(2);
    if (driveCurves[key]) return driveCurves[key];

    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    driveCurves[key] = curve;
    return curve;
}

/**
 * Generates a stone-room impulse response.
 *
 * Plain decaying noise sounds like a hiss gate. What makes a small room read as
 * a room is the handful of discrete early reflections in the first ~60ms, so
 * those are stamped in explicitly before the diffuse tail takes over. The two
 * channels use independent noise, which is what gives the tail its width.
 *
 * @param {number} seconds - Tail length
 * @param {number} decay - Decay exponent; higher is tighter
 * @returns {AudioBuffer}
 */
function makeImpulseResponse(seconds, decay) {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = ctx.createBuffer(2, length, rate);

    // Early reflection times (seconds) and levels, roughly a 12m stone chamber.
    const early = [
        [0.011, 0.7], [0.019, -0.55], [0.027, 0.45],
        [0.036, -0.38], [0.048, 0.3], [0.061, -0.24],
    ];

    for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        let lp = 0;

        for (let i = 0; i < length; i++) {
            const t = i / length;
            // Diffuse tail, progressively lowpassed so it darkens as it decays.
            const white = Math.random() * 2 - 1;
            lp += (white - lp) * (0.35 - 0.28 * t);
            data[i] = lp * Math.pow(1 - t, decay);
        }

        // Pre-delay, then the early reflections, offset slightly per channel so
        // they do not collapse to the centre.
        const preDelay = Math.floor(rate * 0.008);
        for (let i = 0; i < preDelay; i++) data[i] *= 0.15;

        for (const reflection of early) {
            const index = Math.floor((reflection[0] + channel * 0.0013) * rate);
            if (index < length) data[index] += reflection[1];
        }
    }

    return buffer;
}

/**
 * Returns a cached noise buffer, generating it on first use.
 *
 * @param {string} type - 'white' | 'pink' | 'brown'
 * @returns {AudioBuffer}
 */
function noiseBuffer(type) {
    if (noiseBuffers[type]) return noiseBuffers[type];

    const rate = ctx.sampleRate;
    // Three seconds: long enough that even the boss-death rumble can start at a
    // random offset and still have buffer left to play.
    const length = Math.floor(rate * 3);
    const buffer = ctx.createBuffer(2, length, rate);

    for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);

        if (type === 'pink') {
            // Paul Kellet's economical pink filter: -3dB/octave, the natural
            // spectrum of most real-world noise (fire, wind, crowd, gunshot air).
            let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
            for (let i = 0; i < length; i++) {
                const white = Math.random() * 2 - 1;
                b0 = 0.99886 * b0 + white * 0.0555179;
                b1 = 0.99332 * b1 + white * 0.0750759;
                b2 = 0.96900 * b2 + white * 0.1538520;
                b3 = 0.86650 * b3 + white * 0.3104856;
                b4 = 0.55000 * b4 + white * 0.5329522;
                b5 = -0.7616 * b5 - white * 0.0168980;
                data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
                b6 = white * 0.115926;
            }
        } else if (type === 'brown') {
            // Leaky integrator: -6dB/octave, the rumble under explosions.
            let last = 0;
            for (let i = 0; i < length; i++) {
                const white = Math.random() * 2 - 1;
                last = (last + 0.02 * white) / 1.02;
                data[i] = last * 3.5;
            }
        } else {
            for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
        }
    }

    noiseBuffers[type] = buffer;
    return buffer;
}

// =============================================================================
// SMALL HELPERS
// =============================================================================

/**
 * Uniform random in a range.
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function rand(min, max) {
    return min + Math.random() * (max - min);
}

/**
 * Random element of an array.
 * @param {Array} list
 * @returns {*}
 */
export function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

/**
 * Writes a percussive amplitude envelope onto a gain parameter.
 *
 * @param {AudioParam} param - The gain to automate
 * @param {number} when - Start time
 * @param {Object} [shape]
 * @param {number} [shape.attack=0.002] - Attack time in seconds
 * @param {number} [shape.hold=0] - Time at full level
 * @param {number} [shape.decay=0.2] - Decay to silence
 * @param {number} [shape.peak=1] - Peak linear gain
 * @param {boolean} [shape.linearAttack=false] - Linear rather than exponential rise
 * @returns {number} Total envelope duration in seconds
 */
export function ampEnv(param, when, shape) {
    const opts = shape || {};
    const attack = opts.attack === undefined ? 0.002 : opts.attack;
    const hold = opts.hold === undefined ? 0 : opts.hold;
    const decay = opts.decay === undefined ? 0.2 : opts.decay;
    const peak = Math.max(opts.peak === undefined ? 1 : opts.peak, EPS);

    param.setValueAtTime(EPS, when);
    if (opts.linearAttack) {
        param.linearRampToValueAtTime(peak, when + attack);
    } else {
        param.exponentialRampToValueAtTime(peak, when + attack);
    }
    if (hold > 0) param.setValueAtTime(peak, when + attack + hold);
    param.exponentialRampToValueAtTime(EPS, when + attack + hold + decay);
    param.setValueAtTime(0, when + attack + hold + decay + 0.002);

    return attack + hold + decay;
}

/**
 * Sweeps a frequency parameter from one value to another.
 *
 * @param {AudioParam} param
 * @param {number} when - Start time
 * @param {number} from - Hz
 * @param {number} to - Hz
 * @param {number} dur - Seconds
 * @param {boolean} [linear=false] - Linear rather than exponential sweep
 */
function freqSweep(param, when, from, to, dur, linear) {
    param.setValueAtTime(Math.max(from, 10), when);
    if (linear) {
        param.linearRampToValueAtTime(Math.max(to, 10), when + dur);
    } else {
        param.exponentialRampToValueAtTime(Math.max(to, 10), when + dur);
    }
}

/**
 * Schedules teardown of a node once it can no longer be heard.
 *
 * Disconnecting is what actually lets a node be collected; a stopped but still
 * connected source keeps its whole upstream chain alive.
 *
 * @param {AudioNode} node
 * @param {number} atTime - AudioContext time after which the node is silent
 */
function releaseAt(node, atTime) {
    const delay = Math.max(0, (atTime - ctx.currentTime) * 1000 + 60);
    setTimeout(() => {
        try { node.disconnect(); } catch (error) { /* already gone */ }
    }, delay);
}

// =============================================================================
// VOICES
// =============================================================================

/**
 * Creates a voice: a per-sound mixer point with panning and a reverb send.
 *
 * All the layers of one sound (transient, body, tail) connect into the returned
 * node so they share a position in the stereo field and one send level, which is
 * what makes them read as a single event rather than three coincidences.
 *
 * @param {Object} [options]
 * @param {number} [options.dur=0.5] - How long the sound can last, for cleanup
 * @param {number} [options.gain=1] - Voice level
 * @param {number} [options.pan=0] - -1 left .. 1 right
 * @param {number} [options.send=0] - Reverb send amount, 0..1
 * @param {string} [options.bus='impact'] - Category bus name
 * @param {boolean} [options.priority=false] - Ignore the voice budget
 * @returns {GainNode|null} Node to connect layers into, or null if not audible
 */
export function voice(options) {
    if (!isReady()) return null;

    const opts = options || {};
    const dur = opts.dur === undefined ? 0.5 : opts.dur;
    const gain = opts.gain === undefined ? 1 : opts.gain;
    const pan = opts.pan === undefined ? 0 : opts.pan;
    const send = opts.send === undefined ? 0 : opts.send;
    const bus = opts.bus || 'impact';

    if (activeVoices >= (opts.priority ? VOICE_CEILING : MAX_VOICES)) return null;

    const out = ctx.createGain();
    out.gain.value = gain;

    const target = buses[bus] || buses.impact;
    const lifetimeEnd = ctx.currentTime + dur + 2.2;

    // The send is taken after panning so the wet signal keeps the dry signal's
    // position instead of smearing to the centre.
    let tap = out;
    if (pan !== 0 && ctx.createStereoPanner) {
        const panner = ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));
        out.connect(panner);
        releaseAt(panner, lifetimeEnd);
        tap = panner;
    }
    tap.connect(target);

    if (send > 0 && reverbSend) {
        const sendGain = ctx.createGain();
        sendGain.gain.value = send;
        tap.connect(sendGain);
        sendGain.connect(reverbSend);
        releaseAt(sendGain, lifetimeEnd);
    }

    activeVoices++;
    setTimeout(() => {
        activeVoices = Math.max(0, activeVoices - 1);
        try { out.disconnect(); } catch (error) { /* already gone */ }
    }, Math.max(0, dur * 1000 + 120));

    return out;
}

/**
 * One filtered noise layer: the crack of a gunshot, the scuff of a footstep, the
 * body of an explosion. Optionally sweeps its filter, which is how a static
 * noise buffer turns into something with movement.
 *
 * @param {AudioNode} dest - Voice node to play into
 * @param {Object} opts
 * @param {number} opts.when - Start time
 * @param {number} [opts.dur=0.1] - Decay length
 * @param {string} [opts.type='white'] - Noise colour
 * @param {number} [opts.gain=0.5] - Peak gain
 * @param {number} [opts.attack=0.001] - Attack time
 * @param {number} [opts.hold=0] - Time at full level
 * @param {string} [opts.filter='lowpass'] - Biquad type, or 'none'
 * @param {number} [opts.freq=2000] - Filter frequency
 * @param {number} [opts.freqEnd] - Sweep target; omit to hold steady
 * @param {number} [opts.q=1] - Filter Q
 * @param {number} [opts.hp] - Extra fixed highpass, in Hz
 * @param {number} [opts.drive] - Waveshaper drive, for grit
 * @param {number} [opts.rate=1] - Noise playback rate
 */
export function noiseLayer(dest, opts) {
    if (!dest || !ctx) return;

    const when = opts.when;
    const dur = opts.dur === undefined ? 0.1 : opts.dur;
    const gain = opts.gain === undefined ? 0.5 : opts.gain;
    const attack = opts.attack === undefined ? 0.001 : opts.attack;
    const hold = opts.hold === undefined ? 0 : opts.hold;
    const filter = opts.filter === undefined ? 'lowpass' : opts.filter;
    const freq = opts.freq === undefined ? 2000 : opts.freq;
    const q = opts.q === undefined ? 1 : opts.q;

    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(opts.type || 'white');
    src.playbackRate.value = opts.rate === undefined ? 1 : opts.rate;

    let node = src;

    if (filter !== 'none') {
        const biquad = ctx.createBiquadFilter();
        biquad.type = filter;
        biquad.Q.value = q;
        if (opts.freqEnd !== undefined) {
            freqSweep(biquad.frequency, when, freq, opts.freqEnd, attack + hold + dur);
        } else {
            biquad.frequency.value = freq;
        }
        node.connect(biquad);
        node = biquad;
    }

    if (opts.hp !== undefined) {
        const highpass = ctx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = opts.hp;
        node.connect(highpass);
        node = highpass;
    }

    if (opts.drive) {
        const shaper = ctx.createWaveShaper();
        shaper.curve = makeDriveCurve(opts.drive);
        node.connect(shaper);
        node = shaper;
    }

    const env = ctx.createGain();
    const total = ampEnv(env.gain, when, { attack, hold, decay: dur, peak: gain });
    node.connect(env);
    env.connect(dest);

    // Random offset into the buffer so repeated shots are not bit-identical --
    // but never so far in that the source runs off the end of the buffer and
    // leaves the tail of a long layer playing silence.
    const buffered = src.buffer.duration / src.playbackRate.value;
    const headroom = Math.max(0, buffered - total - 0.1);
    src.start(when, Math.random() * headroom);
    src.stop(when + total + 0.05);
    releaseAt(src, when + total + 0.05);
}

/**
 * One pitched layer: the low thump under a gunshot, the whistle of a plasma
 * bolt, the note of a pickup. A falling pitch envelope is what gives an impact
 * its weight, so `freqEnd` gets used far more often than not.
 *
 * @param {AudioNode} dest - Voice node to play into
 * @param {Object} opts
 * @param {number} opts.when - Start time
 * @param {number} opts.freq - Start frequency in Hz
 * @param {number} [opts.freqEnd] - End frequency; omit for a steady note
 * @param {number} [opts.dur=0.2] - Decay length
 * @param {string} [opts.type='sine'] - Oscillator type
 * @param {number} [opts.gain=0.4] - Peak gain
 * @param {number} [opts.attack=0.002] - Attack time
 * @param {number} [opts.hold=0] - Time at full level
 * @param {number} [opts.detune=0] - Cents
 * @param {number} [opts.drive] - Waveshaper drive
 * @param {number} [opts.lowpass] - Post filter cutoff, in Hz
 * @param {Object} [opts.vibrato] - {rate, depth} in Hz
 * @param {boolean} [opts.linearSweep=false] - Linear rather than exponential sweep
 */
export function toneLayer(dest, opts) {
    if (!dest || !ctx) return;

    const when = opts.when;
    const dur = opts.dur === undefined ? 0.2 : opts.dur;
    const gain = opts.gain === undefined ? 0.4 : opts.gain;
    const attack = opts.attack === undefined ? 0.002 : opts.attack;
    const hold = opts.hold === undefined ? 0 : opts.hold;

    const osc = ctx.createOscillator();
    osc.type = opts.type || 'sine';
    osc.detune.value = opts.detune === undefined ? 0 : opts.detune;

    const total = attack + hold + dur;
    if (opts.freqEnd !== undefined) {
        freqSweep(osc.frequency, when, opts.freq, opts.freqEnd, total, opts.linearSweep);
    } else {
        osc.frequency.value = opts.freq;
    }

    if (opts.vibrato) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = opts.vibrato.rate;
        const depth = ctx.createGain();
        depth.gain.value = opts.vibrato.depth;
        lfo.connect(depth);
        depth.connect(osc.frequency);
        lfo.start(when);
        lfo.stop(when + total + 0.05);
        releaseAt(depth, when + total + 0.05);
    }

    let node = osc;

    if (opts.drive) {
        const shaper = ctx.createWaveShaper();
        shaper.curve = makeDriveCurve(opts.drive);
        node.connect(shaper);
        node = shaper;
    }

    if (opts.lowpass !== undefined) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = opts.lowpass;
        node.connect(filter);
        node = filter;
    }

    const env = ctx.createGain();
    ampEnv(env.gain, when, { attack, hold, decay: dur, peak: gain });
    node.connect(env);
    env.connect(dest);

    osc.start(when);
    osc.stop(when + total + 0.05);
    releaseAt(osc, when + total + 0.05);
}

/**
 * A bank of inharmonic partials: metal. Struck steel, shell casings, keys, door
 * mechanisms. The inharmonic ratios are the whole point -- harmonic partials
 * sound like an organ, inharmonic ones sound like a struck object.
 *
 * @param {AudioNode} dest - Voice node to play into
 * @param {Object} opts
 * @param {number} opts.when - Start time
 * @param {number[]} opts.freqs - Partial frequencies in Hz, lowest first
 * @param {number} [opts.dur=0.4] - Decay of the lowest partial
 * @param {number} [opts.gain=0.25] - Peak gain of the lowest partial
 * @param {number} [opts.spread=0.55] - How much faster upper partials decay, 0..1
 * @param {number} [opts.attack=0.001] - Attack time
 */
export function metalRing(dest, opts) {
    if (!dest || !ctx) return;

    const when = opts.when;
    const freqs = opts.freqs;
    const dur = opts.dur === undefined ? 0.4 : opts.dur;
    const gain = opts.gain === undefined ? 0.25 : opts.gain;
    const spread = opts.spread === undefined ? 0.55 : opts.spread;
    const attack = opts.attack === undefined ? 0.001 : opts.attack;
    const last = Math.max(1, freqs.length - 1);

    freqs.forEach((freq, index) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        // A few cents of drift per strike; identical partials sound synthetic.
        osc.frequency.value = freq * rand(0.996, 1.004);

        const decay = dur * (1 - spread * (index / last));
        const env = ctx.createGain();
        ampEnv(env.gain, when, { attack, decay, peak: gain / (1 + index * 0.7) });

        osc.connect(env);
        env.connect(dest);
        osc.start(when);
        osc.stop(when + attack + decay + 0.05);
        releaseAt(osc, when + attack + decay + 0.05);
    });
}

// =============================================================================
// SUSTAINED-VOICE PRIMITIVES
// =============================================================================

/**
 * Creates a looping noise source and starts it.
 *
 * Held sounds (the flamethrower's roar, room tone) need a running source rather
 * than the fire-and-forget layers above, so they get raw nodes -- but they still
 * come from here, because only this module knows the context.
 *
 * The buffer is crossfaded across its seam: a two-second noise loop with a hard
 * splice ticks audibly twice a second.
 *
 * @param {string} type - Noise colour, 'white' | 'pink' | 'brown'
 * @param {number} at - Start time
 * @returns {AudioBufferSourceNode|null}
 */
export function loopingNoise(type, at) {
    if (!ctx) return null;

    const key = 'loop:' + type;
    if (!noiseBuffers[key]) {
        const source = noiseBuffer(type);
        const length = source.length;
        const looped = ctx.createBuffer(2, length, ctx.sampleRate);
        const fade = Math.floor(ctx.sampleRate * 0.05);

        for (let channel = 0; channel < 2; channel++) {
            const from = source.getChannelData(channel);
            const to = looped.getChannelData(channel);
            to.set(from);
            for (let i = 0; i < fade; i++) {
                const w = i / fade;
                to[i] = from[i] * w + from[length - fade + i] * (1 - w);
            }
        }
        noiseBuffers[key] = looped;
    }

    const src = ctx.createBufferSource();
    src.buffer = noiseBuffers[key];
    src.loop = true;
    src.start(at, Math.random() * 1.5);
    return src;
}

/**
 * Creates a biquad filter belonging to the engine's context.
 *
 * @param {string} type - Biquad type
 * @param {number} freq - Cutoff or centre frequency in Hz
 * @param {number} [q=1] - Resonance
 * @returns {BiquadFilterNode|null}
 */
export function createFilter(type, freq, q) {
    if (!ctx) return null;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q === undefined ? 1 : q;
    return filter;
}

/**
 * Creates a gain node belonging to the engine's context.
 *
 * @param {number} value - Linear gain
 * @returns {GainNode|null}
 */
export function createGain(value) {
    if (!ctx) return null;
    const gain = ctx.createGain();
    gain.gain.value = value;
    return gain;
}

/**
 * Modulates a parameter with a slow LFO and starts it.
 *
 * A sustained sound whose filter sits at a fixed frequency reveals itself as
 * synthetic within about a second; drifting it is most of what sells a flame or
 * a room tone as a real, moving thing.
 *
 * @param {AudioParam} param - Parameter to modulate
 * @param {number} at - Start time
 * @param {number} depth - Modulation depth, in the parameter's units
 * @param {number} rate - Modulation rate in Hz
 * @returns {OscillatorNode|null} The LFO, for the caller to stop later
 */
export function attachLfo(param, at, depth, rate) {
    if (!ctx) return null;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rate;

    const depthGain = ctx.createGain();
    depthGain.gain.value = depth;
    lfo.connect(depthGain);
    depthGain.connect(param);
    lfo.start(at);

    return lfo;
}

// =============================================================================
// SUSTAINED VOICES
// =============================================================================

/**
 * Creates a held sound that repeated calls keep alive rather than retrigger.
 *
 * The flamethrower fires every three frames -- twenty calls a second. Triggering
 * a fresh one-shot each time is a machine gun, not a flame. A sustained voice
 * instead ramps up once, stays up while the trigger is held, and releases when
 * the calls stop.
 *
 * @param {Object} opts
 * @param {Function} opts.build - (voiceNode, startTime) => stopFn, builds the sources
 * @param {number} [opts.attack=0.08] - Fade-in seconds
 * @param {number} [opts.release=0.25] - Fade-out seconds once starved
 * @param {number} [opts.gain=0.5] - Held level
 * @param {number} [opts.holdMs=120] - How long one keepAlive() lasts
 * @param {number} [opts.send=0.2] - Reverb send
 * @param {string} [opts.bus='weapon'] - Category bus
 * @param {Function} [opts.tick] - (voiceNode, time) called ~every 60ms while held
 * @returns {Object} Handle with keepAlive(), stop() and an `active` flag
 */
export function sustainedVoice(opts) {
    const build = opts.build;
    const attack = opts.attack === undefined ? 0.08 : opts.attack;
    const release = opts.release === undefined ? 0.25 : opts.release;
    const gain = opts.gain === undefined ? 0.5 : opts.gain;
    const holdMs = opts.holdMs === undefined ? 120 : opts.holdMs;
    const send = opts.send === undefined ? 0.2 : opts.send;
    const bus = opts.bus || 'weapon';

    let node = null;
    let stopSources = null;
    let timer = null;
    let holdUntil = 0;

    /** Fades the voice out and tears its sources down. */
    function fadeOut() {
        if (!node) return;

        const dyingNode = node;
        const dyingSources = stopSources;
        node = null;
        stopSources = null;
        clearInterval(timer);
        timer = null;

        try {
            const at = now();
            dyingNode.gain.cancelScheduledValues(at);
            dyingNode.gain.setValueAtTime(Math.max(dyingNode.gain.value, EPS), at);
            dyingNode.gain.exponentialRampToValueAtTime(EPS, at + release);
        } catch (error) { /* context went away mid-schedule */ }

        setTimeout(() => {
            if (dyingSources) dyingSources();
            try { dyingNode.disconnect(); } catch (error) { /* already gone */ }
        }, release * 1000 + 80);
    }

    return {
        /** Starts the sound if idle, and extends how long it keeps sounding. */
        keepAlive() {
            if (!isReady()) return;
            holdUntil = nowMs() + holdMs;
            if (node) return;

            node = voice({ dur: 3600, gain: EPS, send, bus, priority: true });
            if (!node) return;

            const at = now();
            stopSources = build(node, at) || null;
            node.gain.setValueAtTime(EPS, at);
            node.gain.exponentialRampToValueAtTime(gain, at + attack);

            timer = setInterval(() => {
                if (nowMs() > holdUntil) {
                    fadeOut();
                } else if (opts.tick && node) {
                    opts.tick(node, now());
                }
            }, 60);
        },

        /** Stops immediately, without waiting for the hold to lapse. */
        stop() {
            holdUntil = 0;
            fadeOut();
        },

        /** @returns {boolean} True while the voice is sounding */
        get active() {
            return !!node;
        },
    };
}

// =============================================================================
// SAMPLES
// =============================================================================

/**
 * Decoded sample buffers by name.
 *
 * AudioBuffers are not tied to the context that decoded them, so these survive
 * disposeEngine() and a rebuilt context can play them without a second fetch.
 */
const samples = {};

/**
 * Fetches and decodes one sample.
 *
 * Decoding needs a context but not a running one, so this can be called at page
 * load, long before the user gesture that lets audio start -- by the time the
 * first shot is fired the buffers are already in memory.
 *
 * @param {string} name - Key the sample is played back by
 * @param {string} url - Where to fetch it from
 * @returns {Promise<boolean>} True if the sample is now playable
 */
export async function loadSample(name, url) {
    if (samples[name]) return true;
    if (typeof fetch !== 'function' || !ensureContext()) return false;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const encoded = await response.arrayBuffer();
        // The callback form is the one every browser supports; the promise form
        // is missing from older Safari.
        const buffer = await new Promise((resolve, reject) => {
            const result = ctx.decodeAudioData(encoded, resolve, reject);
            if (result && typeof result.then === 'function') result.then(resolve, reject);
        });
        if (!buffer || !(buffer.duration > 0)) throw new Error('empty buffer');
        samples[name] = buffer;
        return true;
    } catch (error) {
        console.warn(`Audio engine: sample "${name}" failed to load from ${url}:`, error);
        return false;
    }
}

/**
 * Loads many samples in parallel.
 *
 * @param {Array<[string, string]>} entries - [name, url] pairs
 * @returns {Promise<number>} How many are playable afterwards
 */
export async function loadSamples(entries) {
    const results = await Promise.all(entries.map(([name, url]) => loadSample(name, url)));
    return results.filter(Boolean).length;
}

/**
 * @param {string} name - Sample key
 * @returns {boolean} True if the sample has been decoded
 */
export function hasSample(name) {
    return !!samples[name];
}

/**
 * @param {string} name - Sample key
 * @returns {number} Length in seconds, or 0 if not loaded
 */
export function sampleDuration(name) {
    return samples[name] ? samples[name].duration : 0;
}

/**
 * @returns {string[]} Keys of every decoded sample
 */
export function loadedSamples() {
    return Object.keys(samples);
}

/**
 * Plays a decoded sample into a voice.
 *
 * The playback rate doubles as pitch: resampling a sound at a slightly random
 * rate is how Doom itself varied them, and the reason a rapid-fire weapon does
 * not turn into one looped sample.
 *
 * @param {AudioNode} dest - Voice node to play into
 * @param {Object} opts
 * @param {string} opts.name - Sample key
 * @param {number} opts.when - Start time
 * @param {number} [opts.rate=1] - Playback rate; 1.06 is about a semitone up
 * @param {number} [opts.gain=1] - Level
 * @returns {number} How long the sample will sound, in seconds; 0 if not played
 */
export function playSample(dest, opts) {
    const buffer = samples[opts.name];
    if (!dest || !ctx || !buffer) return 0;

    const rate = opts.rate === undefined ? 1 : opts.rate;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;

    let node = src;
    if (opts.gain !== undefined && opts.gain !== 1) {
        const level = ctx.createGain();
        level.gain.value = opts.gain;
        src.connect(level);
        node = level;
    }
    node.connect(dest);

    const length = buffer.duration / rate;
    src.start(opts.when);
    src.stop(opts.when + length + 0.05);
    releaseAt(src, opts.when + length + 0.05);
    return length;
}

// =============================================================================
// MIX CONTROL
// =============================================================================

/**
 * Briefly pulls the whole mix down to make room for a big event.
 *
 * This is what makes an explosion feel physical rather than merely loud:
 * everything else gets out of its way for a moment and then comes back.
 *
 * @param {number} amount - Ducked gain, 0..1 (0.6 is a firm duck)
 * @param {number} [hold=0.08] - Seconds at the ducked level
 * @param {number} [recover=0.35] - Seconds to come back
 */
export function duck(amount, hold, recover) {
    if (!isReady() || !duckGain) return;

    const holdTime = hold === undefined ? 0.08 : hold;
    const recoverTime = recover === undefined ? 0.35 : recover;
    const at = now();
    const param = duckGain.gain;

    try {
        param.cancelScheduledValues(at);
        param.setValueAtTime(Math.min(param.value, 1), at);
        param.linearRampToValueAtTime(amount, at + 0.012);
        param.setValueAtTime(amount, at + 0.012 + holdTime);
        param.linearRampToValueAtTime(1, at + 0.012 + holdTime + recoverTime);
    } catch (error) { /* context went away mid-schedule */ }
}

/**
 * Sets the output volume.
 * @param {number} value - 0..1
 */
export function setMasterVolume(value) {
    userVolume = Math.max(0, Math.min(1, value));
    if (masterGain && !muted) {
        masterGain.gain.setTargetAtTime(userVolume, ctx.currentTime, 0.02);
    }
}

/**
 * @returns {number} Current master volume, 0..1
 */
export function getMasterVolume() {
    return userVolume;
}

/**
 * Mutes or unmutes without losing the volume setting.
 * @param {boolean} value
 * @returns {boolean} The new muted state
 */
export function setMuted(value) {
    muted = !!value;
    if (masterGain) {
        masterGain.gain.setTargetAtTime(muted ? 0 : userVolume, ctx.currentTime, 0.02);
    }
    return muted;
}

/**
 * @returns {boolean} True if muted
 */
export function isMuted() {
    return muted;
}

/**
 * Tears the engine down. Closing the context releases the audio hardware and
 * everything hanging off it, so there is no node-by-node cleanup to do.
 */
export function disposeEngine() {
    if (!ctx) return;

    try {
        ctx.close();
    } catch (error) {
        console.warn('Audio engine: error closing context:', error);
    }

    ctx = null;
    masterGain = duckGain = saturator = toneShaper = compressor = null;
    reverbSend = reverbReturn = null;
    buses = {};
    noiseBuffers = {};
    activeVoices = 0;
}

/**
 * Diagnostics, for tests and any future debug overlay.
 * @returns {Object} Snapshot of engine state
 */
export function engineStats() {
    return {
        state: contextState(),
        voices: activeVoices,
        maxVoices: MAX_VOICES,
        voiceCeiling: VOICE_CEILING,
        samples: Object.keys(samples).length,
        volume: userVolume,
        muted,
        sampleRate: ctx ? ctx.sampleRate : 0,
    };
}
