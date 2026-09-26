// Kurama's voice. VOICEVOX (青山龍星) is rendered through a "beast" chain:
//   slowed playback (lower pitch + formants → a much bigger creature)
//   + an octave-down granular "demon" double
//   + ring-modulated growl/rasp, chest EQ, compression and a stone-chamber reverb.
// Falls back to the browser's Japanese speechSynthesis voice, or to silent mouth-flaps.
// Also owns the sewer ambience and the roar sound effect.
import { kanaTimeline, sampleTimeline, timelineDuration } from './lipsync.js';

const b64ToBuf = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

/** Duration-preserving granular pitch shift (ratio < 1 = lower). Rough on purpose. */
function granularShift(ctx, buffer, ratio) {
  const sr = buffer.sampleRate;
  const src = buffer.getChannelData(0);
  const n = src.length;
  const grain = Math.floor(sr * 0.07);
  const hop = Math.floor(grain / 4);
  const out = new Float32Array(n);
  const norm = new Float32Array(n);
  const win = new Float32Array(grain);
  for (let i = 0; i < grain; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grain - 1));
  for (let start = 0; start < n; start += hop) {
    for (let i = 0; i < grain; i++) {
      const o = start + i;
      if (o >= n) break;
      const pos = start + i * ratio;
      const i0 = Math.floor(pos);
      if (i0 + 1 >= n) break;
      const f = pos - i0;
      const s = src[i0] * (1 - f) + src[i0 + 1] * f;
      out[o] += s * win[i];
      norm[o] += win[i];
    }
  }
  for (let i = 0; i < n; i++) if (norm[i] > 1e-3) out[i] /= norm[i];
  const res = ctx.createBuffer(1, n, sr);
  res.copyToChannel(out, 0);
  return res;
}

function impulse(ctx, seconds = 2.4, decay = 2.8) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp = lp * 0.72 + (Math.random() * 2 - 1) * 0.28;     // darker tail
      d[i] = lp * Math.pow(1 - t, decay) * (i < ctx.sampleRate * 0.012 ? 0.3 : 1);
    }
  }
  return ir;
}

function softClip(k = 6) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

export class Voice {
  constructor(settings) {
    this.settings = settings;     // live object: { voice, depth, demon, volume, ambience }
    this.ctx = null;
    this.current = null;          // { stop(), mouth(now), done }
    this.voicevoxOk = false;
    this.browserVoice = null;
    this.level = 0;
    this._pickBrowserVoice();
    if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => this._pickBrowserVoice();
  }

  _pickBrowserVoice() {
    if (!('speechSynthesis' in window)) return;
    const voices = speechSynthesis.getVoices().filter((v) => /^ja/i.test(v.lang));
    const male = voices.find((v) => /(ichiro|keita|otoya|hattori|takumi|kenji|daichi|naoki|male|男)/i.test(v.name));
    this.browserVoice = male || voices[0] || null;
  }

  /** Must be called from a user gesture (browser autoplay rules). */
  async unlock() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    await ctx.resume();

    // master + reverb bus
    this.master = ctx.createGain();
    this.master.gain.value = this.settings.volume;
    this.master.connect(ctx.destination);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulse(ctx);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.24;
    this.reverbSend.connect(this.reverb).connect(this.master);

    // voice bus
    this.voiceIn = ctx.createGain();
    const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 170; low.gain.value = 6;
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 2600; mid.Q.value = 0.9; mid.gain.value = -2.5;
    const high = ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 7000; high.gain.value = -5;
    this.voiceIn.connect(low).connect(mid).connect(high);

    // growl: distorted, band-limited copy ring-modulated at ~38 Hz
    const shaper = ctx.createWaveShaper(); shaper.curve = softClip(7); shaper.oversample = '2x';
    const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.frequency.value = 900; band.Q.value = 0.6;
    const ring = ctx.createGain(); ring.gain.value = 0.55;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 38;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.45;
    lfo.connect(lfoAmt).connect(ring.gain);
    lfo.start();
    this.growl = ctx.createGain(); this.growl.gain.value = 0.2;
    this.voiceIn.connect(shaper).connect(band).connect(ring).connect(this.growl);

    // octave-down demon layer arrives on its own input
    this.subIn = ctx.createGain();
    const subLp = ctx.createBiquadFilter(); subLp.type = 'lowpass'; subLp.frequency.value = 1100;
    this.subGain = ctx.createGain(); this.subGain.gain.value = 0.4;
    this.subIn.connect(subLp).connect(this.subGain);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.18;
    this.voiceOut = ctx.createGain();
    this.voiceOut.gain.value = 1.15;
    high.connect(comp);
    this.growl.connect(comp);
    this.subGain.connect(comp);
    comp.connect(this.voiceOut);
    this.voiceOut.connect(this.master);
    this.voiceOut.connect(this.reverbSend);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.voiceOut.connect(this.analyser);
    this._abuf = new Float32Array(this.analyser.fftSize);

    this._startAmbience();
    this.apply();
  }

  /** Re-read the live settings object (volume sliders etc.). */
  apply() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.settings.volume, now, 0.05);
    this.subGain.gain.setTargetAtTime(0.55 * this.settings.demon, now, 0.05);
    this.growl.gain.setTargetAtTime(0.08 + 0.2 * this.settings.demon, now, 0.05);
    if (this.ambGain) this.ambGain.gain.setTargetAtTime(0.9 * this.settings.ambience, now, 0.2);
  }

  /** Mouth opening now (0..1), combining the viseme timeline and the actual loudness. */
  mouth() {
    if (!this.current) return 0;
    const v = this.current.mouth();
    if (!this.analyser || this.current.kind !== 'voicevox') return v;
    this.analyser.getFloatTimeDomainData(this._abuf);
    let s = 0;
    for (let i = 0; i < this._abuf.length; i++) s += this._abuf[i] * this._abuf[i];
    const rms = Math.sqrt(s / this._abuf.length);
    this.level = this.level * 0.6 + Math.min(1, rms * 5) * 0.4;
    return v * (0.55 + 0.75 * this.level);
  }

  get speaking() { return !!this.current; }

  stop() {
    if (this.current) { this.current.stop(); this.current = null; }
  }

  /**
   * Speak one reply. Resolves when finished (or interrupted).
   * @param {{ja:string,kana:string,emotion:string}} line
   * @param {{onStart?:(dur:number)=>void}} hooks
   */
  async speak(line, hooks = {}) {
    this.stop();
    const mode = this.settings.voice;
    if (mode === 'off') return this._silent(line, hooks);
    if (mode !== 'browser' && this.ctx) {
      try {
        return await this._voicevox(line, hooks);
      } catch (err) {
        if (mode === 'voicevox') console.warn('[voice] VOICEVOX failed:', err);
        this.voicevoxOk = false;
      }
    }
    if (mode !== 'voicevox' && this.browserVoice) return this._browser(line, hooks);
    return this._silent(line, hooks);
  }

  async _voicevox(line, hooks) {
    const rate = this.settings.depth;               // < 1 → deeper, bigger
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: line.ja,
        emotion: line.emotion,
        speedScale: Math.min(1.4, 1.06 / rate),     // pre-compensate so the slowed playback keeps pace
        pitchScale: -0.05,
        intonationScale: 1.25,
      }),
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    const data = await res.json();
    this.voicevoxOk = true;
    const ctx = this.ctx;
    const buffer = await ctx.decodeAudioData(b64ToBuf(data.audio));
    const sub = granularShift(ctx, buffer, 0.5);
    const timeline = data.timeline || [];

    return new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      const subSrc = ctx.createBufferSource();
      subSrc.buffer = sub;
      subSrc.playbackRate.value = rate;
      src.connect(this.voiceIn);
      subSrc.connect(this.subIn);
      const start = ctx.currentTime + 0.06;
      src.start(start);
      subSrc.start(start);
      const dur = buffer.duration / rate;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { src.stop(); subSrc.stop(); } catch { /* already stopped */ }
        if (this.current === cur) this.current = null;
        resolve();
      };
      const cur = {
        kind: 'voicevox',
        stop: finish,
        mouth: () => sampleTimeline(timeline, (ctx.currentTime - start) * rate),
      };
      this.current = cur;
      src.onended = finish;
      hooks.onStart?.(dur);
    });
  }

  _browser(line, hooks) {
    return new Promise((resolve) => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(line.ja);
      u.lang = 'ja-JP';
      if (this.browserVoice) u.voice = this.browserVoice;
      u.pitch = 0.1;           // as low as the engine allows
      u.rate = 0.88;
      u.volume = Math.min(1, this.settings.volume * 1.2);
      const tl = kanaTimeline(line.kana || line.ja, 0.155 / u.rate);
      const est = timelineDuration(tl);
      let t0 = performance.now();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (this.current === cur) this.current = null;
        resolve();
      };
      const cur = {
        kind: 'browser',
        stop: () => { speechSynthesis.cancel(); finish(); },
        mouth: () => {
          const t = (performance.now() - t0) / 1000;
          // keep flapping gently if the synthesiser runs longer than our estimate
          return t < est ? sampleTimeline(tl, t) : 0.35 * Math.max(0, Math.sin(t * 14));
        },
      };
      this.current = cur;
      u.onstart = () => { t0 = performance.now(); hooks.onStart?.(est); };
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.speak(u);
      // safety net: some engines never fire onend
      setTimeout(() => finish(), est * 1000 + 8000);
    });
  }

  _silent(line, hooks) {
    return new Promise((resolve) => {
      const tl = kanaTimeline(line.kana || line.ja, 0.12);
      const est = Math.max(1.2, timelineDuration(tl));
      const t0 = performance.now();
      const cur = {
        kind: 'silent',
        stop: () => { clearTimeout(timer); if (this.current === cur) this.current = null; resolve(); },
        mouth: () => sampleTimeline(tl, (performance.now() - t0) / 1000),
      };
      this.current = cur;
      hooks.onStart?.(est);
      const timer = setTimeout(() => cur.stop(), est * 1000 + 300);
    });
  }

  // ---- ambience + sfx ------------------------------------------------------------

  _startAmbience() {
    const ctx = this.ctx;
    this.ambGain = ctx.createGain();
    this.ambGain.gain.value = 0;
    this.ambGain.connect(this.master);

    // low drone of the seal
    const drone = ctx.createGain(); drone.gain.value = 0.05;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180;
    for (const [f, type, g] of [[55, 'sine', 1], [82.4, 'triangle', 0.35], [110.3, 'sine', 0.15]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(og).connect(lp);
      o.start();
    }
    const flfo = ctx.createOscillator(); flfo.frequency.value = 0.07;
    const flfoAmt = ctx.createGain(); flfoAmt.gain.value = 70;
    flfo.connect(flfoAmt).connect(lp.frequency);
    flfo.start();
    lp.connect(drone).connect(this.ambGain);

    // water: brown noise, low-passed
    const len = ctx.sampleRate * 4;
    const nb = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = nb.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true;
    const nlp = ctx.createBiquadFilter(); nlp.type = 'lowpass'; nlp.frequency.value = 520;
    const ng = ctx.createGain(); ng.gain.value = 0.05;
    noise.connect(nlp).connect(ng).connect(this.ambGain);
    noise.start();
    this._noiseBuf = nb;

    // Kurama's slow, rumbling breath (filtered noise swells)
    const breath = ctx.createBufferSource(); breath.buffer = nb; breath.loop = true;
    const blp = ctx.createBiquadFilter(); blp.type = 'bandpass'; blp.frequency.value = 160; blp.Q.value = 0.8;
    this.breathGain = ctx.createGain(); this.breathGain.gain.value = 0;
    breath.connect(blp).connect(this.breathGain).connect(this.ambGain);
    breath.start();

    const drip = () => {
      if (!this.ctx) return;
      const t = ctx.currentTime + 0.02;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const f0 = 900 + Math.random() * 900;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.45, t + 0.09);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05 + Math.random() * 0.05, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g);
      g.connect(this.ambGain);
      g.connect(this.reverbSend);
      o.start(t); o.stop(t + 0.2);
      setTimeout(drip, 1500 + Math.random() * 5500);
    };
    setTimeout(drip, 2500);
  }

  /** Called every frame with the breathing phase (0..1 intensity). */
  breathe(amount) {
    if (this.breathGain) this.breathGain.gain.setTargetAtTime(0.06 * amount, this.ctx.currentTime, 0.3);
  }

  roar() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.45;          // lines up with the Roar clip's blast
    const dur = 2.3;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.9, t + 0.12);
    out.gain.setValueAtTime(0.9, t + dur * 0.55);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    out.connect(this.master);
    out.connect(this.reverbSend);

    const noise = ctx.createBufferSource(); noise.buffer = this._noiseBuf; noise.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.7;
    bp.frequency.setValueAtTime(260, t);
    bp.frequency.exponentialRampToValueAtTime(520, t + 0.4);
    bp.frequency.exponentialRampToValueAtTime(180, t + dur);
    const ng = ctx.createGain(); ng.gain.value = 2.2;
    noise.connect(bp).connect(ng).connect(out);

    const saw = ctx.createOscillator(); saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(70, t);
    saw.frequency.linearRampToValueAtTime(92, t + 0.35);
    saw.frequency.linearRampToValueAtTime(55, t + dur);
    const am = ctx.createGain(); am.gain.value = 0.5;
    const amOsc = ctx.createOscillator(); amOsc.frequency.value = 27;
    const amAmt = ctx.createGain(); amAmt.gain.value = 0.35;
    amOsc.connect(amAmt).connect(am.gain);
    const slp = ctx.createBiquadFilter(); slp.type = 'lowpass'; slp.frequency.value = 700;
    const shaper = ctx.createWaveShaper(); shaper.curve = softClip(4);
    saw.connect(shaper).connect(slp).connect(am).connect(out);

    for (const n of [noise, saw, amOsc]) { n.start(t); n.stop(t + dur + 0.1); }
  }
}
