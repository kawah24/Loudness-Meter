/*!
 * loudness-core.js
 * ITU-R BS.1770-4 / EBU R128 loudness measurement, implemented from the spec.
 *
 *  - K-weighting: two cascaded biquads (high-shelf 1681.97 Hz +4 dB, RLB high-pass 38.14 Hz)
 *    re-derived by bilinear transform for any sample rate.
 *  - Momentary (400 ms), short-term (3 s, 100 ms hops), integrated (gated, -70 LUFS absolute
 *    + -10 LU relative), LRA (EBU Tech 3342, -20 LU relative gate, P10/P95).
 *  - True peak: 4x polyphase windowed-sinc oversampling (BS.1770-4 Annex 2).
 *
 * Works in the browser (window.LoudnessCore) and in Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LoudnessCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LUFS_OFFSET = -0.691;        // BS.1770 K-weighting gain compensation
  const ABSOLUTE_GATE = -70;         // LUFS
  const RELATIVE_GATE = -10;         // LU
  const LRA_GATE = -20;              // LU
  const HOP_SECONDS = 0.1;
  const MOMENTARY_BLOCKS = 4;        // 4 x 100 ms = 400 ms
  const SHORTTERM_BLOCKS = 30;       // 30 x 100 ms = 3 s

  /* ------------------------------------------------------------------ *
   * K-weighting
   * ------------------------------------------------------------------ */

  /**
   * Bilinear-transform re-derivation of the BS.1770-4 pre-filter (high shelf) and
   * RLB high-pass, valid at any sample rate. At 48 kHz this reproduces the
   * coefficients printed in the recommendation.
   */
  function kWeightingCoefficients(fs) {
    // Stage 1 — "pre-filter" high shelf: +4 dB above ~1.7 kHz, Q 0.707
    const G = 3.999843853973347;
    const Q1 = 0.7071752369554196;
    const fc1 = 1681.974450955533;
    const K1 = Math.tan(Math.PI * fc1 / fs);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K1 / Q1 + K1 * K1;
    const shelf = {
      b0: (Vh + Vb * K1 / Q1 + K1 * K1) / a0,
      b1: 2 * (K1 * K1 - Vh) / a0,
      b2: (Vh - Vb * K1 / Q1 + K1 * K1) / a0,
      a1: 2 * (K1 * K1 - 1) / a0,
      a2: (1 - K1 / Q1 + K1 * K1) / a0
    };

    // Stage 2 — RLB high-pass at 38.14 Hz, Q 0.5
    const Q2 = 0.5003270373238773;
    const fc2 = 38.13547087602444;
    const K2 = Math.tan(Math.PI * fc2 / fs);
    const d = 1 + K2 / Q2 + K2 * K2;
    const hp = {
      b0: 1,
      b1: -2,
      b2: 1,
      a1: 2 * (K2 * K2 - 1) / d,
      a2: (1 - K2 / Q2 + K2 * K2) / d
    };
    return { shelf, hp };
  }

  /* ------------------------------------------------------------------ *
   * Loudness maths
   * ------------------------------------------------------------------ */

  function lkfs(power) {
    if (!(power > 0) || !isFinite(power)) return -Infinity;
    return LUFS_OFFSET + 10 * Math.log10(power);
  }

  function powerFromLkfs(value) {
    if (!isFinite(value)) return 0;
    return Math.pow(10, (value - LUFS_OFFSET) / 10);
  }

  /**
   * Two-stage gating per BS.1770-4 (absolute -70 LUFS, then relative -10 LU).
   * `powers` are the per-block weighted mean squares.
   */
  function integratedFromPowers(powers) {
    const n = powers.length;
    let sum = 0, count = 0;
    for (let i = 0; i < n; i++) {
      const l = lkfs(powers[i]);
      if (l > ABSOLUTE_GATE) { sum += powers[i]; count++; }
    }
    if (!count) return { loudness: -Infinity, threshold: -Infinity, blocks: 0 };
    // RELATIVE_GATE is negative (-10 LU), so adding it lowers the threshold
    const threshold = lkfs(sum / count) + RELATIVE_GATE;
    let sum2 = 0, count2 = 0;
    for (let i = 0; i < n; i++) {
      const l = lkfs(powers[i]);
      if (l > ABSOLUTE_GATE && l > threshold) { sum2 += powers[i]; count2++; }
    }
    return {
      loudness: count2 ? lkfs(sum2 / count2) : -Infinity,
      threshold,
      blocks: count2
    };
  }

  function percentile(sorted, p) {
    const n = sorted.length;
    if (!n) return NaN;
    if (n === 1) return sorted[0];
    const idx = (n - 1) * (p / 100);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  /** EBU Tech 3342 loudness range. */
  function loudnessRange(shortTerm, integrated) {
    if (!isFinite(integrated)) {
      return { lra: NaN, low: NaN, high: NaN, count: 0, threshold: NaN };
    }
    const threshold = integrated + LRA_GATE;
    const values = [];
    for (let i = 0; i < shortTerm.length; i++) {
      const v = shortTerm[i];
      if (isFinite(v) && v > ABSOLUTE_GATE && v > threshold) values.push(v);
    }
    if (values.length < 2) {
      return { lra: 0, low: NaN, high: NaN, count: values.length, threshold };
    }
    values.sort((a, b) => a - b);
    const low = percentile(values, 10);
    const high = percentile(values, 95);
    return { lra: high - low, low, high, count: values.length, threshold };
  }

  /* ------------------------------------------------------------------ *
   * True peak: 4x polyphase interpolation
   * ------------------------------------------------------------------ */

  /**
   * Windowed-sinc (Blackman) polyphase interpolator.
   * Each phase is normalised to unity DC gain so that a DC signal passes
   * through at exactly 1.0 — amplitude error stays below ~0.02 dB.
   */
  function designPolyphase(phases, taps, bandwidth) {
    const alpha = bandwidth || 1.03;   // slight cutoff lift keeps the passband flat to ~21 kHz
    const N = phases * taps;
    const centre = (N - 1) / 2;
    const h = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      const x = alpha * (n - centre) / phases;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1)) +
        0.08 * Math.cos((4 * Math.PI * n) / (N - 1));
      h[n] = sinc * w;
    }
    const table = [];
    for (let p = 0; p < phases; p++) {
      const t = new Float64Array(taps);
      let sum = 0;
      for (let k = 0; k < taps; k++) { t[k] = h[p + phases * k]; sum += t[k]; }
      for (let k = 0; k < taps; k++) t[k] /= sum;
      table.push(t);
    }
    return table;
  }

  /* ------------------------------------------------------------------ *
   * Channel layouts
   * ------------------------------------------------------------------ */

  function channelGainsFor(count) {
    switch (count) {
      case 1: return { name: 'MONO', gains: [1] };
      case 2: return { name: 'STEREO', gains: [1, 1] };
      case 6: return { name: '5.1', gains: [1, 1, 1, 0, 1.41, 1.41] };
      case 8: return { name: '7.1', gains: [1, 1, 1, 0, 1.41, 1.41, 1.41, 1.41] };
      default: {
        const g = new Array(count).fill(1);
        return { name: count + ' CH', gains: g };
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Streaming / offline meter
   * ------------------------------------------------------------------ */

  class Meter {
    constructor(sampleRate, options) {
      options = options || {};
      this.fs = sampleRate;
      this.coeffs = kWeightingCoefficients(sampleRate);
      this.hop = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
      const layout = options.channelGains
        ? { name: options.channelName || options.channelGains.length + ' CH', gains: options.channelGains }
        : channelGainsFor(options.channels || 2);
      this.gains = layout.gains;
      this.layoutName = layout.name;
      this.tpTaps = options.truePeakTaps || 24;
      this.tpPhases = designPolyphase(4, this.tpTaps);
      this._mPow = new Float64Array(1024);
      this.reset();
    }

    reset() {
      this.state = null;
      this.nCh = 0;
      this.tailLen = 0;
      this.tail = null;
      this.subPowers = [];
      this.momentary = [];
      this.shortTerm = [];
      this.peakDb = [];
      this.maxM = -Infinity;
      this.maxS = -Infinity;
      this.peakLin = 0;
      this.tpLin = 0;
      this.tpCarry = null;
      this.samples = 0;
      this._values = null;
      this._tpBuf = null;
      return this;
    }

    get duration() { return this.samples / this.fs; }
    get blockCount() { return this.subPowers.length; }

    _initChannels(nCh) {
      this.nCh = nCh;
      this.state = [];
      for (let i = 0; i < nCh; i++) this.state.push({ s1: 0, s2: 0, s3: 0, s4: 0 });
      this.tail = [];
      for (let i = 0; i < nCh; i++) this.tail.push(new Float32Array(this.hop));
      this.tailLen = 0;
      const pad = this.tpTaps - 1;
      this.tpCarry = [];
      for (let i = 0; i < nCh; i++) this.tpCarry.push(null);
      this._tpPad = pad;
    }

    /**
     * Feed interleaved-by-channel PCM. `channels` is an array of Float32Array
     * (one per channel); `length` defaults to channels[0].length.
     */
    push(channels, length) {
      const nCh = channels.length;
      const n = length === undefined ? channels[0].length : length;
      if (!this.state) this._initChannels(nCh);
      if (!n) return this;

      let off = 0;
      while (off < n) {
        const space = this.hop - this.tailLen;
        const take = Math.min(space, n - off);
        for (let ch = 0; ch < nCh; ch++) {
          const src = channels[ch];
          const dst = this.tail[ch];
          if (src.subarray) dst.set(src.subarray(off, off + take), this.tailLen);
          else for (let i = 0; i < take; i++) dst[this.tailLen + i] = src[off + i];
        }
        this.tailLen += take;
        off += take;
        if (this.tailLen >= this.hop) {
          this._processHop(this.tail, nCh);
          this.tailLen = 0;
        }
      }

      this._scanTruePeak(channels, n);
      return this;
    }

    _processHop(buf, nCh) {
      const b = this.coeffs.shelf;
      const h = this.coeffs.hp;
      const hop = this.hop;
      const gains = this.gains;
      let power = 0;
      let peak = 0;

      for (let ch = 0; ch < nCh; ch++) {
        const x = buf[ch];
        const st = this.state[ch];
        let s1 = st.s1, s2 = st.s2, s3 = st.s3, s4 = st.s4;
        let sum = 0, pk = 0;
        for (let i = 0; i < hop; i++) {
          const v = x[i];
          const y = b.b0 * v + s1;
          s1 = b.b1 * v - b.a1 * y + s2;
          s2 = b.b2 * v - b.a2 * y;
          const z = h.b0 * y + s3;
          s3 = h.b1 * y - h.a1 * z + s4;
          s4 = h.b2 * y - h.a2 * z;
          sum += z * z;
          const a = v < 0 ? -v : v;
          if (a > pk) pk = a;
        }
        st.s1 = s1; st.s2 = s2; st.s3 = s3; st.s4 = s4;
        power += (gains[ch] || 0) * (sum / hop);
        if (pk > peak) peak = pk;
      }

      const subs = this.subPowers;
      subs.push(power);
      this.samples += hop;

      let m = NaN, s = NaN;
      const idx = subs.length - 1;
      if (idx >= MOMENTARY_BLOCKS - 1) {
        m = (subs[idx] + subs[idx - 1] + subs[idx - 2] + subs[idx - 3]) * 0.25;
        this.momentary.push(lkfs(m));
      } else {
        this.momentary.push(NaN);
      }
      if (idx >= SHORTTERM_BLOCKS - 1) {
        let acc = 0;
        for (let i = idx - SHORTTERM_BLOCKS + 1; i <= idx; i++) acc += subs[i];
        s = acc / SHORTTERM_BLOCKS;
        this.shortTerm.push(lkfs(s));
      } else {
        this.shortTerm.push(NaN);
      }

      const mDb = isFinite(m) ? lkfs(m) : -Infinity;
      const sDb = isFinite(s) ? lkfs(s) : -Infinity;
      if (mDb > this.maxM) this.maxM = mDb;
      if (sDb > this.maxS) this.maxS = sDb;
      if (peak > this.peakLin) this.peakLin = peak;
      this.peakDb.push(peak > 0 ? 20 * Math.log10(peak) : -Infinity);
      this._values = null;
    }

    /**
     * 4x oversampled true-peak scan over one push buffer. Input samples more
     * than 6 dB below the running sample peak are skipped — their interpolated
     * value cannot become the maximum.
     */
    _scanTruePeak(channels, n) {
      const phases = this.tpPhases;
      const L = this.tpTaps;
      const pad = L - 1;
      const total = n + 2 * pad;
      if (!this._tpBuf || this._tpBuf.length < total) {
        this._tpBuf = new Float32Array(total + 4096);
      }
      const buf = this._tpBuf;
      const threshold = this.peakLin * 0.45;
      let best = this.tpLin;

      for (let ch = 0; ch < channels.length; ch++) {
        const src = channels[ch];
        const first = src[0];
        const last = src[n - 1];
        buf.fill(first, 0, pad);
        for (let i = 0; i < n; i++) buf[pad + i] = src[i];
        buf.fill(last, pad + n, total);

        const carry = this.tpCarry[ch];
        if (carry) {
          for (let i = 0; i < pad; i++) buf[i] = carry[i];
        }

        for (let i = pad; i < pad + n; i++) {
          const v = buf[i];
          const a = v < 0 ? -v : v;
          if (a < threshold) continue;
          for (let p = 0; p < 4; p++) {
            const t = phases[p];
            let acc = 0;
            const base = i - pad;
            for (let k = 0; k < L; k++) acc += t[k] * buf[base + k];
            const aa = acc < 0 ? -acc : acc;
            if (aa > best) best = aa;
          }
        }

        if (!this.tpCarry[ch]) this.tpCarry[ch] = new Float32Array(pad);
        const c = this.tpCarry[ch];
        for (let i = 0; i < pad; i++) c[i] = src[n - pad + i];
      }

      this.tpLin = best;
    }

    /** Current measurement snapshot (integrated + LRA are recalculated). */
    values() {
      if (this._values) return this._values;
      const subs = this.subPowers;
      const n = subs.length;
      const blocks = Math.max(0, n - MOMENTARY_BLOCKS + 1);
      if (this._mPow.length < blocks) this._mPow = new Float64Array(blocks + 1024);
      const mPow = this._mPow.subarray(0, blocks);
      for (let i = 0; i < blocks; i++) {
        mPow[i] = (subs[i] + subs[i + 1] + subs[i + 2] + subs[i + 3]) * 0.25;
      }
      const integrated = integratedFromPowers(mPow);
      const lra = loudnessRange(this.shortTerm, integrated.loudness);
      const tpLinear = Math.max(this.tpLin, this.peakLin);
      const tpDb = tpLinear > 0 ? 20 * Math.log10(tpLinear) : -Infinity;
      const sPeakDb = this.peakLin > 0 ? 20 * Math.log10(this.peakLin) : -Infinity;
      const il = integrated.loudness;

      this._values = {
        integrated: il,
        integratedThreshold: integrated.threshold,
        integratedBlocks: integrated.blocks,
        lra: lra.lra,
        lraLow: lra.low,
        lraHigh: lra.high,
        lraThreshold: lra.threshold,
        momentary: this.momentary.length ? this.momentary[this.momentary.length - 1] : -Infinity,
        shortTerm: this.shortTerm.length ? this.shortTerm[this.shortTerm.length - 1] : -Infinity,
        maxMomentary: this.maxM,
        maxShortTerm: this.maxS,
        truePeak: tpDb,
        samplePeak: sPeakDb,
        plr: isFinite(il) && isFinite(tpDb) ? tpDb - il : NaN,
        psr: isFinite(this.maxS) && isFinite(tpDb) ? tpDb - this.maxS : NaN,
        duration: this.duration,
        blocks: n,
        layout: this.layoutName,
        sampleRate: this.fs
      };
      return this._values;
    }
  }

  /* ------------------------------------------------------------------ *
   * Batch helpers
   * ------------------------------------------------------------------ */

  function analyze(channels, sampleRate, options) {
    options = options || {};
    const meter = new Meter(sampleRate, { channels: channels.length, channelGains: options.channelGains });
    const n = channels[0].length;
    const chunk = Math.round(sampleRate * 2);
    for (let off = 0; off < n; off += chunk) {
      const len = Math.min(chunk, n - off);
      const slice = channels.map((c) => c.subarray(off, off + len));
      meter.push(slice, len);
    }
    return meter;
  }

  async function analyzeAsync(channels, sampleRate, options) {
    options = options || {};
    const meter = new Meter(sampleRate, { channels: channels.length, channelGains: options.channelGains });
    const n = channels[0].length;
    const chunk = Math.round(sampleRate * 2);
    let count = 0;
    for (let off = 0; off < n; off += chunk) {
      const len = Math.min(chunk, n - off);
      const slice = channels.map((c) => c.subarray(off, off + len));
      meter.push(slice, len);
      if (options.onProgress) options.onProgress(Math.min(1, (off + len) / n));
      if (++count % 2 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return meter;
  }

  /* ------------------------------------------------------------------ *
   * Level repair: gain to target + look-ahead true-peak limiting
   * ------------------------------------------------------------------ */

  function applyGainDb(channels, db) {
    if (!db) return;
    const g = Math.pow(10, db / 20);
    for (let c = 0; c < channels.length; c++) {
      const d = channels[c];
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
  }

  /**
   * Brick-wall limiter on the sample peak, with look-ahead.
   * The gain dips `attackSec` before a peak and recovers over `releaseSec`, so
   * the output can never exceed `ceiling` (linear).
   * Returns the deepest gain reduction in dB.
   */
  function limitSamples(channels, fs, ceiling, attackSec, releaseSec) {
    const nch = channels.length;
    const n = channels[0].length;
    const need = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < nch; c++) {
        const a = Math.abs(channels[c][i]);
        if (a > peak) peak = a;
      }
      need[i] = peak > ceiling ? ceiling / peak : 1;
    }

    // sliding minimum over the look-ahead window, monotonic deque
    const W = Math.max(1, Math.round(attackSec * fs));
    const minEnv = new Float32Array(n);
    const dq = new Int32Array(n);
    let head = 0;
    let tail = 0;
    for (let i = n - 1; i >= 0; i--) {
      while (tail > head && need[dq[tail - 1]] >= need[i]) tail--;
      dq[tail++] = i;
      while (dq[head] > i + W) head++;
      minEnv[i] = need[dq[head]];
    }

    const gain = new Float32Array(n);
    const rise = 1 / W;
    let g = 1;
    for (let i = n - 1; i >= 0; i--) {
      g = Math.min(minEnv[i], g + rise);
      gain[i] = g;
    }
    const R = Math.max(1, Math.round(releaseSec * fs));
    const recover = 1 / R;
    g = 1;
    for (let i = 0; i < n; i++) {
      g = Math.min(gain[i], g + recover);
      gain[i] = g;
    }

    let deepest = 1;
    for (let i = 0; i < n; i++) if (gain[i] < deepest) deepest = gain[i];

    for (let c = 0; c < nch; c++) {
      const d = channels[c];
      for (let i = 0; i < n; i++) d[i] *= gain[i];
    }
    return deepest > 0 ? -20 * Math.log10(deepest) : 0;
  }

  /**
   * Fix a programme to a loudness target under a true-peak ceiling.
   * Returns null when there is nothing to measure.
   */
  function normalizeToTarget(channels, fs, options) {
    const targetIL = options.targetIL;
    const ceiling = options.ceiling;
    const before = options.before || analyze(channels, fs).values();
    if (!isFinite(before.integrated)) return null;

    const work = channels.map((c) => new Float32Array(c));
    let gainDb = targetIL - before.integrated;
    applyGainDb(work, gainDb);

    let sampleCeil = Math.pow(10, (ceiling - 0.25) / 20);
    let result = null;
    let reduction = 0;

    for (let pass = 0; pass < 5; pass++) {
      reduction = Math.max(reduction, limitSamples(work, fs, sampleCeil, 0.003, 0.12));
      result = analyze(work, fs).values();
      const tpOver = result.truePeak - ceiling;
      const delta = targetIL - result.integrated;
      if (tpOver <= 0.05 && Math.abs(delta) < 0.08) break;
      if (tpOver > 0.05) {
        sampleCeil *= Math.pow(10, -(tpOver + 0.05) / 20);
      }
      applyGainDb(work, delta);
      gainDb += delta;
    }

    return {
      channels: work,
      sampleRate: fs,
      gainDb,
      reductionDb: reduction,
      before,
      after: result,
      ceiling
    };
  }

  /** 44-byte WAV header: bits = 16 | 24 (PCM) or 32 (IEEE float). */
  function wavHeader(dataSize, nch, sampleRate, bits) {
    const width = (bits || 24) / 8;
    const format = (bits || 24) === 32 ? 3 : 1;
    const bytes = width;
    const buffer = new ArrayBuffer(44);
    const view = new DataView(buffer);
    const str = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    str(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, nch, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * nch * bytes, true);
    view.setUint16(32, nch * bytes, true);
    view.setUint16(34, bits || 24, true);
    str(36, 'data');
    view.setUint32(40, dataSize, true);
    return buffer;
  }

  /** Interleaved WAV at 16/24-bit PCM or 32-bit float. */
  function encodeWav(channels, sampleRate, bits) {
    const depth = bits || 24;
    const nch = channels.length;
    const n = channels[0].length;
    const bytes = depth / 8;
    const dataSize = n * nch * bytes;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    new Uint8Array(buffer).set(new Uint8Array(wavHeader(dataSize, nch, sampleRate, depth)), 0);

    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        let s = channels[c][i];
        s = s > 1 ? 1 : s < -1 ? -1 : s;
        if (depth === 32) {
          view.setFloat32(o, s, true);
        } else if (depth === 16) {
          view.setInt16(o, Math.round(s * 32767), true);
        } else {
          const v = Math.round(s * 8388607);
          view.setUint8(o, v & 0xff);
          view.setUint8(o + 1, (v >> 8) & 0xff);
          view.setUint8(o + 2, (v >> 16) & 0xff);
        }
        o += bytes;
      }
    }
    return buffer;
  }

  function encodeWav24(channels, sampleRate) { return encodeWav(channels, sampleRate, 24); }

  /** Bit depth of a WAV source, or 0 when it is not a WAV. */
  function wavBits(bytes) {
    const dv = new DataView(bytes);
    if (bytes.byteLength < 44) return 0;
    if (readAscii(dv, 0, 4) !== 'RIFF' || readAscii(dv, 8, 4) !== 'WAVE') return 0;
    let off = 12;
    while (off + 8 <= bytes.byteLength) {
      const id = readAscii(dv, off, 4);
      const size = dv.getUint32(off + 4, true);
      if (id === 'fmt ') return dv.getUint16(off + 8 + 14, true);
      off += 8 + size + (size & 1);
    }
    return 0;
  }

  function readAscii(dv, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
    return s;
  }

  return {
    Meter,
    analyze,
    analyzeAsync,
    applyGainDb,
    limitSamples,
    normalizeToTarget,
    encodeWav,
    encodeWav24,
    wavHeader,
    wavHeader24: (d, ch, fs) => wavHeader(d, ch, fs, 24),
    wavBits,
    kWeightingCoefficients,
    designPolyphase,
    integratedFromPowers,
    loudnessRange,
    lkfs,
    powerFromLkfs,
    percentile,
    channelGainsFor,
    LUFS_OFFSET,
    ABSOLUTE_GATE,
    RELATIVE_GATE,
    LRA_GATE
  };
});
