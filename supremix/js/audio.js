// Sound. The seven effects the original game has -- explosion, infotron, push,
// fall, bug, base, exit -- are remastered from its own Sound Blaster samples
// (extracted from BLASTER.SND by tools/extract-sounds.mjs) by
// tools/remaster-sounds.mjs into the sfx pack: each rebuilt at 44.1 kHz as the
// sound it was reaching for -- a weighty explosion, a heavy thud, the exit
// jingle on a modern synth -- except the infotron, which is the original
// sample itself, cleaned and given a little air and room. Everything the
// original never had a sound for (keys, ice, ports, the menus) is a few
// oscillators and a noise buffer, as before, and so is any original effect
// whose sample failed to load.
//
// The samples play the way the original plays them: through one channel, by
// priority. A sound holds the channel for a while, and nothing of lower
// priority can cut in -- which is why a chain of explosions is one roar rather
// than twenty, and why an infotron is heard over the base you dug to reach it.
//
// The context is created lazily on the first gesture, so browsers never see a
// blocked autoplay attempt.

import { PACKS, packedBytes } from './asset-pack.js';

const NOISE_SECONDS = 1;
const VOLUME = 0.32;
// The remastered files are balanced against each other (explosion loudest,
// base quietest) and peak under -1 dBFS; this sets the set against the
// synthesised cues, and each rule's gain below trims one cue within it.
const SAMPLE_GAIN = 2.0;

// Cues that can fire every step; held apart so they never pile up.
const REPEATING = new Set(['slide', 'creep', 'lean', 'dig']);

// Game cue -> original effect, and the original's rules for it: the priority it
// takes the channel at, the priority already playing that blocks it, and how
// long it holds the channel, in the original's game ticks (about 35 a second).
// Then ours: a gain trim, a playback rate, and `vary`, a random spread of that
// rate so a cue fired every step (digging) never machine-guns.
const TICK = 1 / 35;
const ORIGINAL = {
  boom: { sfx: 'explosion', pri: 5, blockedBy: 5, hold: 15 },
  die: { sfx: 'explosion', pri: 5, blockedBy: 5, hold: 15 },
  infotron: { sfx: 'infotron', pri: 4, blockedBy: 5, hold: 15 },
  bug: { sfx: 'bug', pri: 3, blockedBy: 3, hold: 3, gain: 0.9 },
  push: { sfx: 'push', pri: 2, blockedBy: 2, hold: 7, gain: 0.9 },
  rack: { sfx: 'push', pri: 2, blockedBy: 2, hold: 7, gain: 0.9, rate: 0.78 },
  land: { sfx: 'fall', pri: 2, blockedBy: 2, hold: 7, gain: 0.85 },
  dig: { sfx: 'base', pri: 1, blockedBy: 1, hold: 3, gain: 1.1, vary: 0.04 },
  exit: { sfx: 'exit', pri: 10, blockedBy: 11, hold: 250 },
};
const SFX_NAMES = [...new Set(Object.values(ORIGINAL).map(o => o.sfx))];

// Music: the original's in-game theme and level-exit jingle as a Roland MT-32
// played them, captured from ROLAND.SND and rendered offline (see "Music" in the
// README). As in the original's Roland mode, the theme loops through menus and
// play, and reaching the exit stops it for the jingle; the next level starts it
// again from the top.
//
// theme.mp3 is the 15 s intro, one full pass of the loop and 1 s of overrun.
// The last 0.25 s before loopEnd is already crossfaded into the bars leading up
// to loopStart, so the jump is seamless. Times are in the file's own timeline.
// A decoder that ignores the LAME header leaves the encoder's 1105-sample delay
// at the front; the decoded length gives that away, and the loop shifts with it.
const MUSIC_GAIN = 0.9;
const THEME = { duration: 328.804014, loopStart: 15.360227, loopEnd: 327.804014 };
const ENCODER_DELAY = 1105 / 44100;

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.muted = false;
    this.lastPlayed = new Map();
    this.samples = new Map();     // original effect name -> AudioBuffer
    this.channel = { pri: 0, until: 0, src: null, gain: null };
    this.musicOn = true;          // the player's choice (N)
    this.musicWanted = true;      // the theme should be playing right now
    this.tracks = new Map();      // 'theme' / 'exit' -> AudioBuffer
    this.musicBus = null;
    this.musicSrc = null;
  }

  /** Fetch and decode the music. The theme starts as soon as it arrives. */
  loadMusic() {
    if (this.musicLoading || !this.ctx) return;
    this.musicLoading = Promise.all(['theme', 'exit'].map(async (name) => {
      try {
        const bytes = await packedBytes(PACKS.music, `${name}.mp3`);
        if (!bytes) return;
        this.tracks.set(name, await this.ctx.decodeAudioData(bytes.buffer));
        if (name === 'theme') this.syncMusic();
      } catch { /* no music, then */ }
    }));
  }

  /** Start or stop the theme to match what is wanted. */
  syncMusic() {
    const play = this.musicOn && this.musicWanted && this.tracks.has('theme');
    if (play && !this.musicSrc) {
      const buf = this.tracks.get('theme');
      const lead = buf.duration - THEME.duration > 0.012 ? ENCODER_DELAY : 0;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.loopStart = THEME.loopStart + lead;
      src.loopEnd = THEME.loopEnd + lead;
      const g = this.ctx.createGain();
      g.gain.value = MUSIC_GAIN;
      src.connect(g).connect(this.musicBus);
      src.start(0, lead);
      this.musicSrc = { src, g };
    } else if (!play && this.musicSrc) {
      this.fadeOut(this.musicSrc);
      this.musicSrc = null;
    }
  }

  fadeOut({ src, g }, secs = 0.15) {
    const now = this.ctx.currentTime;
    g.gain.setTargetAtTime(0, now, secs / 4);
    try { src.stop(now + secs); } catch { /* already ended */ }
    src.onended = () => { src.disconnect(); g.disconnect(); };
  }

  /** The theme, from the top if it was stopped (called as each level starts). */
  music() {
    this.musicWanted = true;
    if (this.ctx) this.syncMusic();
  }

  toggleMusic() {
    this.musicOn = !this.musicOn;
    if (this.musicBus) this.musicBus.gain.value = this.musicOn ? 1 : 0;
    if (this.ctx) this.syncMusic();
    return this.musicOn;
  }

  setMusicOn(on) {
    if (on !== this.musicOn) this.toggleMusic();
  }

  /** Level exit: stop the theme and play the MT-32 jingle. False if not loaded. */
  exitJingle() {
    const buf = this.tracks.get('exit');
    if (!buf || !this.musicOn) return false;
    this.musicWanted = false;
    this.syncMusic();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = MUSIC_GAIN;
    src.connect(g).connect(this.musicBus);
    src.start();
    src.onended = () => { src.disconnect(); g.disconnect(); };
    return true;
  }

  /** Stop everything while the tab is hidden; pick up where it was after. */
  setHidden(hidden) {
    if (!this.ctx) return;
    if (hidden) this.ctx.suspend();
    else this.ctx.resume();
  }

  /** Fetch and decode the original samples. Missing ones fall back to synthesis. */
  loadSamples() {
    if (this.loading || !this.ctx) return;
    this.loading = Promise.all(SFX_NAMES.map(async (name) => {
      try {
        const bytes = await packedBytes(PACKS.sfx, `${name}.wav`);
        if (!bytes) return;
        this.samples.set(name, await this.ctx.decodeAudioData(bytes.buffer));
      } catch { /* keep the synthesised cue */ }
    }));
  }

  /**
   * One original effect through the one channel. Returns false only when the
   * sample is not loaded, so the caller can synthesise instead; a sound the
   * channel refuses counts as played, because the original drops it too.
   */
  sample(rule) {
    const buf = this.samples.get(rule.sfx);
    if (!buf) return false;
    const now = this.ctx.currentTime;
    const ch = this.channel;
    if (now < ch.until && ch.pri >= rule.blockedBy) return true;
    // the sound being cut off fades over a few ms rather than stopping dead,
    // which would click (the remastered effects ring on in their reverb)
    if (ch.src) {
      ch.gain.gain.setTargetAtTime(0, now, 0.004);
      try { ch.src.stop(now + 0.03); } catch { /* already ended */ }
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const spread = rule.vary ? 1 + (Math.random() * 2 - 1) * rule.vary : 1;
    src.playbackRate.value = (rule.rate || 1) * spread;
    const g = this.ctx.createGain();
    g.gain.value = SAMPLE_GAIN * (rule.gain ?? 1);
    src.connect(g).connect(this.master);
    src.start();
    src.onended = () => { src.disconnect(); g.disconnect(); if (ch.src === src) ch.src = null; };
    ch.src = src;
    ch.gain = g;
    ch.pri = rule.pri;
    ch.until = now + rule.hold * TICK;
    return true;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;

    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : VOLUME;
    this.master.connect(this.ctx.destination);

    const len = Math.floor(this.ctx.sampleRate * NOISE_SECONDS);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = this.musicOn ? 1 : 0;
    this.musicBus.connect(this.master);
    this.loadSamples();
    this.loadMusic();

    return this.ctx;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : VOLUME;
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  // --- primitives -----------------------------------------------------------

  tone({ freq = 440, to = null, type = 'square', dur = 0.1, gain = 0.2, delay = 0 }) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);

    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.012, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }

  hiss({ dur = 0.12, gain = 0.2, from = 2400, to = 400, q = 1, delay = 0 }) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = q;
    filt.frequency.setValueAtTime(from, t0);
    filt.frequency.exponentialRampToValueAtTime(Math.max(60, to), t0 + dur);

    const g = ctx.createGain();
    // eased in over a few milliseconds: noise switched straight on clicks
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.004, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filt).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    src.onended = () => { src.disconnect(); filt.disconnect(); g.disconnect(); };
  }

  // --- cues -----------------------------------------------------------------

  play(name) {
    if (this.muted || !this.ensure()) return;

    // Collapse duplicates fired in the same step (a disk chain is one bang).
    const now = this.ctx.currentTime;
    const gap = REPEATING.has(name) ? 0.09 : name === 'boom' ? 0.05 : 0.02;
    if (now - (this.lastPlayed.get(name) || -1) < gap) return;
    this.lastPlayed.set(name, now);

    // With the music on, the exit is the MT-32 jingle, as in the original's
    // Roland mode; with it off, the remastered Sound Blaster jingle below.
    if (name === 'exit' && this.exitJingle()) return;

    const rule = ORIGINAL[name];
    if (rule && this.sample(rule)) return;

    switch (name) {
      case 'dig':
        this.hiss({ dur: 0.09, gain: 0.16, from: 1800, to: 300 });
        break;
      case 'infotron':
        this.tone({ freq: 880, to: 1660, type: 'triangle', dur: 0.11, gain: 0.2 });
        this.tone({ freq: 1320, to: 2200, type: 'sine', dur: 0.09, gain: 0.1, delay: 0.03 });
        break;
      case 'pickup':
        this.tone({ freq: 620, to: 990, type: 'square', dur: 0.09, gain: 0.15 });
        break;
      case 'open':
        [523, 659, 784, 1047].forEach((f, k) =>
          this.tone({ freq: f, type: 'triangle', dur: 0.16, gain: 0.15, delay: k * 0.06 }));
        break;
      case 'push':
        this.hiss({ dur: 0.16, gain: 0.22, from: 900, to: 120, q: 2 });
        this.tone({ freq: 130, to: 70, type: 'sine', dur: 0.16, gain: 0.2 });
        break;
      case 'lean':
        this.hiss({ dur: 0.04, gain: 0.07, from: 700, to: 300 });
        break;
      case 'land':
        this.tone({ freq: 190, to: 60, type: 'sine', dur: 0.14, gain: 0.28 });
        this.hiss({ dur: 0.1, gain: 0.14, from: 1100, to: 150 });
        break;
      case 'boom':
        this.hiss({ dur: 0.55, gain: 0.42, from: 3200, to: 90, q: 3 });
        this.tone({ freq: 150, to: 34, type: 'sine', dur: 0.5, gain: 0.38 });
        this.tone({ freq: 90, to: 40, type: 'sawtooth', dur: 0.35, gain: 0.14 });
        break;
      case 'die':
        this.tone({ freq: 500, to: 60, type: 'sawtooth', dur: 0.7, gain: 0.28 });
        this.hiss({ dur: 0.6, gain: 0.2, from: 1400, to: 80 });
        break;
      case 'exit':
        [523, 659, 784, 1047, 1319].forEach((f, k) =>
          this.tone({ freq: f, type: 'square', dur: 0.2, gain: 0.16, delay: k * 0.075 }));
        break;
      case 'port':
        this.tone({ freq: 300, to: 1500, type: 'sine', dur: 0.14, gain: 0.16 });
        break;
      case 'gravity':
        this.tone({ freq: 1400, to: 220, type: 'sine', dur: 0.32, gain: 0.2 });
        this.tone({ freq: 220, to: 1400, type: 'triangle', dur: 0.32, gain: 0.12, delay: 0.05 });
        break;
      case 'plant':
        this.tone({ freq: 240, to: 700, type: 'square', dur: 0.12, gain: 0.16 });
        break;
      case 'terminal':
        this.tone({ freq: 120, type: 'sawtooth', dur: 0.22, gain: 0.16 });
        this.tone({ freq: 123, type: 'sawtooth', dur: 0.22, gain: 0.16 });
        break;
      case 'blocked':
        this.tone({ freq: 150, to: 110, type: 'square', dur: 0.05, gain: 0.09 });
        break;
      case 'noroom':
      case 'nodisk':
        this.tone({ freq: 220, to: 90, type: 'square', dur: 0.16, gain: 0.14 });
        break;
      case 'key':
        this.tone({ freq: 1180, to: 1560, type: 'square', dur: 0.07, gain: 0.13 });
        break;
      case 'unlock':
        this.tone({ freq: 420, type: 'square', dur: 0.05, gain: 0.13 });
        this.tone({ freq: 780, type: 'square', dur: 0.09, gain: 0.13, delay: 0.055 });
        this.hiss({ dur: 0.08, gain: 0.1, from: 2600, to: 900 });
        break;
      case 'locked':
        this.tone({ freq: 110, to: 82, type: 'square', dur: 0.09, gain: 0.14 });
        break;
      case 'boots':
        this.tone({ freq: 300, to: 520, type: 'triangle', dur: 0.16, gain: 0.16 });
        this.hiss({ dur: 0.18, gain: 0.09, from: 3600, to: 1600, delay: 0.04 });
        break;
      case 'burn':
        this.hiss({ dur: 0.42, gain: 0.3, from: 5200, to: 700, q: 0.7 });
        break;
      case 'rack':
        this.hiss({ dur: 0.26, gain: 0.26, from: 620, to: 90, q: 4 });
        this.tone({ freq: 88, to: 52, type: 'sine', dur: 0.24, gain: 0.24 });
        break;
      case 'seal':
        this.tone({ freq: 210, to: 60, type: 'square', dur: 0.2, gain: 0.24 });
        this.hiss({ dur: 0.16, gain: 0.2, from: 1500, to: 120, q: 3 });
        break;
      case 'phase':
        this.tone({ freq: 1500, type: 'square', dur: 0.035, gain: 0.1 });
        this.tone({ freq: 1500, type: 'square', dur: 0.035, gain: 0.1, delay: 0.09 });
        break;
      case 'crystal':
        this.tone({ freq: 1568, to: 2093, type: 'sine', dur: 0.22, gain: 0.14 });
        this.tone({ freq: 2093, type: 'sine', dur: 0.16, gain: 0.07, delay: 0.05 });
        break;
      case 'harden':
        this.hiss({ dur: 0.34, gain: 0.3, from: 1800, to: 110, q: 2.5 });
        this.tone({ freq: 120, to: 44, type: 'sawtooth', dur: 0.3, gain: 0.2 });
        break;
      // Slide and creep repeat every step for as long as they last, so they are
      // deliberately near the floor of audibility -- texture, not events.
      case 'slide':
        this.hiss({ dur: 0.07, gain: 0.05, from: 5000, to: 2600 });
        break;
      case 'creep':
        this.tone({ freq: 74, to: 58, type: 'sine', dur: 0.1, gain: 0.06 });
        break;
      case 'bug':
        this.hiss({ dur: 0.08, gain: 0.12, from: 6000, to: 2500, q: 3 });
        break;
      case 'select':
        this.tone({ freq: 700, to: 1000, type: 'triangle', dur: 0.07, gain: 0.12 });
        break;
      case 'win':
        [523, 784, 1047, 1319, 1568].forEach((f, k) =>
          this.tone({ freq: f, type: 'triangle', dur: 0.28, gain: 0.17, delay: k * 0.1 }));
        break;
      default:
        break;
    }
  }
}
