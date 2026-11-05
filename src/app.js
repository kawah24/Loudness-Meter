/*!
 * app.js — loudness meter UI
 */
(function () {
  'use strict';

  const Core = window.LoudnessCore;
  const $ = (id) => document.getElementById(id);

  const DB_TOP = 0;
  const DB_BOTTOM = -60;
  const BLOCK = 0.1;              // seconds per sub-block / hop

  const COL = {
    m: '#e2603f',
    s: '#5b9bf3',
    i: '#ffb545',
    ok: '#3ddc97',
    bad: '#ff5d5d',
    grid: 'rgba(255,255,255,0.055)',
    gridStrong: 'rgba(255,255,255,0.1)',
    text: '#596374',
    textDim: '#8b95a7'
  };

  const TARGETS = [
    { id: 'spotify', label: 'Spotify / YouTube   −14', il: -14, tp: -1.0 },
    { id: 'apple', label: 'Apple Music   −16', il: -16, tp: -1.0 },
    { id: 'podcast', label: 'Podcast / spoken   −16', il: -16, tp: -1.0 },
    { id: 'ebu', label: 'EBU R128 broadcast   −23', il: -23, tp: -1.0 },
    { id: 'atsc', label: 'ATSC A/85   −24', il: -24, tp: -2.0 },
    { id: 'netflix', label: 'Netflix   −27', il: -27, tp: -2.0 },
    { id: 'club', label: 'Club / DJ   −9', il: -9, tp: -0.3 },
    { id: 'none', label: 'No target', il: null, tp: null }
  ];

  let unitNodes = [];

  const state = {
    meter: null,
    values: null,
    source: { kind: 'idle', name: '', buffer: null, sampleRate: 0 },
    target: TARGETS[0],
    units: 'LUFS',
    winSeconds: 0,
    selection: null,
    hover: null,
    dragging: null,
    view: { t0: 0, t1: 30 },
    decodeCtx: null,
    play: { ctx: null, node: null, gain: null, startedAt: 0, offset: 0, playing: false },
    live: { ctx: null, node: null, stream: null, sink: null },
    fix: null,
    analysis: { running: false, progress: 0 },
    lastDraw: 0,
    needsHist: true,
    histCache: null,
    busy: false
  };

  /* ------------------------------------------------------------------ *
   * helpers
   * ------------------------------------------------------------------ */

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const isNum = (v) => typeof v === 'number' && isFinite(v);

  function fmt(v, digits) {
    return isNum(v) ? v.toFixed(digits === undefined ? 1 : digits) : '\u2014';
  }

  function fmtLevel(v) {
    return v === -Infinity ? '\u2212\u221e' : fmt(v);
  }

  function setValue(el, text) {
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('is-empty', text === '\u2014' || text === '\u2212\u221e');
  }

  function fmtSigned(v, digits) {
    if (!isNum(v)) return '—';
    const s = Math.abs(v).toFixed(digits === undefined ? 1 : digits);
    return (v < 0 ? '\u2212' : '+') + s;
  }

  function fmtTime(sec) {
    if (!isNum(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function fmtTimePrecise(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  let toastTimer = 0;
  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('is-bad', !!bad);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }

  function setStatus(msg) { setText($('statusLabel'), msg); }

  function setProgress(p) {
    const wrap = $('progress');
    if (p === null) { wrap.classList.remove('is-on'); return; }
    wrap.classList.add('is-on');
    $('progressBar').style.width = (clamp(p, 0, 1) * 100).toFixed(1) + '%';
  }

  /* ------------------------------------------------------------------ *
   * canvases
   * ------------------------------------------------------------------ */

  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    canvas._w = w; canvas._h = h;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function lufsToY(v, top, height) {
    const t = (DB_TOP - clamp(v, DB_BOTTOM - 6, DB_TOP + 6)) / (DB_TOP - DB_BOTTOM);
    return top + t * height;
  }

  /* ------------------------------------------------------------------ *
   * ruler
   * ------------------------------------------------------------------ */

  function drawRuler() {
    const canvas = $('rulerCanvas');
    const { ctx, w, h } = fitCanvas(canvas);
    const padTop = 16;
    const padBot = 16;
    const plotH = Math.max(10, h - padTop - padBot);
    const axisX = w - 7;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(axisX + 0.5, padTop - 6);
    ctx.lineTo(axisX + 0.5, h - padBot + 6);
    ctx.stroke();

    ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let v = 0; v >= DB_BOTTOM; v -= 1.5) {
      const y = lufsToY(v, padTop, plotH);
      const major = Math.abs(v % 6) < 0.01;
      ctx.strokeStyle = major ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.09)';
      ctx.beginPath();
      ctx.moveTo(axisX - (major ? 7 : 3.5), Math.round(y) + 0.5);
      ctx.lineTo(axisX, Math.round(y) + 0.5);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = v === 0 ? '#7d8797' : COL.text;
        ctx.fillText(String(Math.round(v)), axisX - 10, y);
      }
    }

    const t = state.target;
    const vals = state.values;

    // target marker
    if (t && t.il !== null) {
      const y = lufsToY(t.il, padTop, plotH);
      ctx.strokeStyle = 'rgba(255,181,69,0.55)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(6, Math.round(y) + 0.5);
      ctx.lineTo(axisX, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,181,69,0.85)';
      ctx.beginPath();
      ctx.moveTo(4, y - 3);
      ctx.lineTo(9, y);
      ctx.lineTo(4, y + 3);
      ctx.closePath();
      ctx.fill();
    }

    if (vals) {
      // integrated
      if (isNum(vals.integrated)) {
        const y = lufsToY(vals.integrated, padTop, plotH);
        ctx.fillStyle = COL.i;
        ctx.fillRect(Math.max(4, axisX - 26), Math.round(y) - 1, 26, 2);
        ctx.globalAlpha = 0.35;
        ctx.fillRect(Math.max(4, axisX - 26), Math.round(y) - 0.5, 26, 1);
        ctx.globalAlpha = 1;
      }

      // short-term marker
      if (isNum(vals.shortTerm)) {
        const y = lufsToY(vals.shortTerm, padTop, plotH);
        ctx.fillStyle = COL.s;
        ctx.beginPath();
        ctx.moveTo(axisX - 1, y - 4);
        ctx.lineTo(axisX - 9, y);
        ctx.lineTo(axisX - 1, y + 4);
        ctx.closePath();
        ctx.fill();
      }

      // momentary marker
      if (isNum(vals.momentary)) {
        const y = lufsToY(vals.momentary, padTop, plotH);
        ctx.fillStyle = COL.m;
        ctx.beginPath();
        ctx.moveTo(axisX - 1, y - 3.5);
        ctx.lineTo(axisX - 7, y);
        ctx.lineTo(axisX - 1, y + 3.5);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ *
   * histogram
   * ------------------------------------------------------------------ */

  function buildHistogram() {
    const meter = state.meter;
    const bins = 120;
    const countsM = new Float32Array(bins);
    const countsS = new Float32Array(bins);
    if (!meter) return { bins, countsM, countsS, max: 0, n: 0 };

    const toBin = (v) => {
      if (!isNum(v) || v <= DB_BOTTOM || v > 0) return -1;
      return clamp(Math.floor((DB_TOP - v) / ((DB_TOP - DB_BOTTOM) / bins)), 0, bins - 1);
    };
    const mArr = meter.momentary;
    const sArr = meter.shortTerm;
    let n = 0;
    for (let i = 0; i < mArr.length; i++) {
      const b = toBin(mArr[i]);
      if (b >= 0) { countsM[b]++; n++; }
    }
    for (let i = 0; i < sArr.length; i++) {
      const b = toBin(sArr[i]);
      if (b >= 0) countsS[b]++;
    }
    let max = 1;
    for (let i = 0; i < bins; i++) max = Math.max(max, countsM[i], countsS[i]);

    // light smoothing so a few hundred blocks read as a distribution, not noise
    const kernel = [1, 2, 3, 2, 1];
    const smooth = (arr) => {
      const out = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        let s = 0;
        let wsum = 0;
        for (let j = -2; j <= 2; j++) {
          const idx = i + j;
          if (idx < 0 || idx >= arr.length) continue;
          s += arr[idx] * kernel[j + 2];
          wsum += kernel[j + 2];
        }
        out[i] = s / wsum;
      }
      return out;
    };
    const passes = (n / bins) < 4 ? 3 : 1;
    let smoothM = countsM;
    let smoothS = countsS;
    for (let p = 0; p < passes; p++) {
      smoothM = smooth(smoothM);
      smoothS = smooth(smoothS);
    }
    max = 1;
    for (let i = 0; i < bins; i++) max = Math.max(max, smoothM[i], smoothS[i]);
    return { bins, countsM: smoothM, countsS: smoothS, max, n };
  }

  function drawHist() {
    const canvas = $('histCanvas');
    const { ctx, w, h } = fitCanvas(canvas);
    const padTop = 16;
    const padBot = 16;
    const plotH = Math.max(10, h - padTop - padBot);
    const x0 = 8;
    const x1 = w - 10;
    const span = Math.max(1, x1 - x0);

    const hist = state.histCache || { bins: 120, countsM: new Float32Array(0), countsS: new Float32Array(0), max: 1, n: 0 };

    // grid
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    for (let v = 0; v >= DB_BOTTOM; v -= 6) {
      const y = Math.round(lufsToY(v, padTop, plotH)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const bucketH = plotH / hist.bins;

    function contour(counts) {
      const pts = [];
      for (let i = 0; i < hist.bins; i++) {
        const c = counts[i] || 0;
        let r = hist.max > 0 ? Math.pow(c / hist.max, 0.85) : 0;
        // soft floor: kills the one-block spikes without a visible step
        r = (r - 0.02) / 0.98;
        if (r < 0) r = 0;
        pts.push([r * 0.96, padTop + (i + 0.5) * bucketH]);
      }
      return pts;
    }

    function paint(counts, color, alpha) {
      const pts = contour(counts);
      ctx.beginPath();
      ctx.moveTo(x0, padTop);
      for (let i = 0; i < pts.length; i++) ctx.lineTo(x0 + pts[i][0] * span, pts[i][1]);
      ctx.lineTo(x0, padTop + plotH);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
      grad.addColorStop(0, color + 'd0');
      grad.addColorStop(0.55, color + '80');
      grad.addColorStop(1, color + '28');
      ctx.fillStyle = grad;
      ctx.globalAlpha = alpha;
      ctx.fill();
      ctx.globalAlpha = 1;

      // stroke only the parts that actually carry density, in one run per segment
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      let drawing = false;
      for (let i = 0; i < pts.length; i++) {
        const x = x0 + pts[i][0] * span;
        if (pts[i][0] > 0) {
          if (!drawing) { ctx.moveTo(x, pts[i][1]); drawing = true; }
          else ctx.lineTo(x, pts[i][1]);
        } else {
          drawing = false;
        }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (hist.n > 0) {
      paint(hist.countsS, COL.s, 0.4);
      paint(hist.countsM, COL.m, 0.46);
    }

    // baseline the distribution sits on
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x0) + 0.5, padTop);
    ctx.lineTo(Math.round(x0) + 0.5, padTop + plotH);
    ctx.stroke();

    const vals = state.values;

    // target line
    if (state.target && state.target.il !== null) {
      const y = lufsToY(state.target.il, padTop, plotH);
      ctx.strokeStyle = 'rgba(255,181,69,0.4)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // integrated line
    if (vals && isNum(vals.integrated)) {
      const y = lufsToY(vals.integrated, padTop, plotH);
      ctx.strokeStyle = 'rgba(255,181,69,0.9)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([7, 4]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);

      const label = ('I ' + fmt(vals.integrated)).replace('-', '\u2212');
      ctx.font = '9.5px ui-monospace, Consolas, monospace';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(12,15,21,0.85)';
      ctx.fillRect(w - tw - 14, y - 13, tw + 8, 12);
      ctx.fillStyle = COL.i;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      ctx.fillText(label, w - 10, y - 7);
    }

    if (!state.meter) {
      ctx.fillStyle = COL.text;
      ctx.font = '10.5px -apple-system, Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Drop an audio file, or press Demo', w / 2, h / 2 - 6);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(x0, padTop + plotH * 0.5, span, 1);
    }
  }

  /* ------------------------------------------------------------------ *
   * timeline graph
   * ------------------------------------------------------------------ */

  function computeView() {
    const duration = state.values ? state.values.duration : 0;
    if (state.winSeconds > 0) {
      const focus = state.play.playing ? playbackTime() : duration;
      const maxStart = Math.max(0, duration - state.winSeconds);
      const t0 = clamp(focus - state.winSeconds, 0, maxStart);
      state.view = { t0, t1: t0 + state.winSeconds };
    } else {
      state.view = { t0: 0, t1: Math.max(duration, 5) };
    }
    return state.view;
  }

  function drawGraph() {
    const canvas = $('graphCanvas');
    const { ctx, w, h } = fitCanvas(canvas);
    const padTop = 8;
    const stripH = 22;
    const stripTop = h - stripH - 10;
    const plotH = Math.max(20, stripTop - padTop - 14);
    const view = computeView();
    const { t0, t1 } = view;
    const span = Math.max(0.001, t1 - t0);
    const padL = 26;
    const plotW = Math.max(10, w - padL);
    const xOf = (t) => padL + ((t - t0) / span) * plotW;

    const meter = state.meter;

    // grid
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.font = '8.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    for (let v = 0; v >= DB_BOTTOM; v -= 6) {
      const y = Math.round(lufsToY(v, padTop, plotH)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      if (Math.abs(v % 12) < 0.01) {
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillText(String(v), padL - 5, y - 1.5);
      }
    }

    // target
    if (state.target && state.target.il !== null) {
      const y = lufsToY(state.target.il, padTop, plotH);
      ctx.strokeStyle = 'rgba(255,181,69,0.32)';
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (!meter || !meter.subPowers.length) {
      ctx.fillStyle = COL.text;
      ctx.font = '10.5px -apple-system, Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No measurement yet', padL + plotW / 2, padTop + plotH / 2);
      return;
    }

    const n = meter.subPowers.length;
    const i0 = clamp(Math.floor(t0 / BLOCK), 0, n);
    const i1 = clamp(Math.ceil(t1 / BLOCK), 0, n);
    const step = Math.max(1, Math.floor((i1 - i0) / Math.max(120, w * 1.4)));

    // short-term area
    ctx.beginPath();
    let started = false;
    for (let i = i0; i < i1; i += step) {
      const v = meter.shortTerm[i];
      if (!isNum(v)) continue;
      const x = xOf((i + 1) * BLOCK);
      const y = lufsToY(v, padTop, plotH);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    if (started) {
      const lastX = xOf(Math.min(t1, n * BLOCK));
      ctx.lineTo(lastX, padTop + plotH);
      ctx.lineTo(xOf(i0 * BLOCK), padTop + plotH);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
      g.addColorStop(0, 'rgba(91,155,243,0.30)');
      g.addColorStop(0.45, 'rgba(91,155,243,0.10)');
      g.addColorStop(1, 'rgba(91,155,243,0.0)');
      ctx.fillStyle = g;
      ctx.fill();

      ctx.beginPath();
      started = false;
      for (let i = i0; i < i1; i += step) {
        const v = meter.shortTerm[i];
        if (!isNum(v)) continue;
        const x = xOf((i + 1) * BLOCK);
        const y = lufsToY(v, padTop, plotH);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = COL.s;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    // momentary line
    ctx.beginPath();
    started = false;
    for (let i = i0; i < i1; i += step) {
      const v = meter.momentary[i];
      if (!isNum(v)) continue;
      const x = xOf((i + 1) * BLOCK);
      const y = lufsToY(v, padTop, plotH);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(226,96,63,0.95)';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // integrated
    const vals = state.values;
    if (vals && isNum(vals.integrated)) {
      const y = lufsToY(vals.integrated, padTop, plotH);
      ctx.strokeStyle = 'rgba(255,181,69,0.75)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // peak strip
    const stripY = stripTop;
    ctx.fillStyle = 'rgba(6,8,12,0.55)';
    ctx.fillRect(padL, stripY, plotW, stripH);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath();
    ctx.moveTo(padL, stripY + 0.5);
    ctx.lineTo(w, stripY + 0.5);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(padL, stripY + stripH);
    for (let i = i0; i < i1; i += step) {
      const db = meter.peakDb[i];
      const t = clamp((0 - (isNum(db) ? db : -60)) / 36, 0, 1);
      const y = stripY + t * (stripH - 2);
      const x = xOf((i + 1) * BLOCK);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(xOf(Math.min(t1, n * BLOCK)), stripY + stripH);
    ctx.closePath();
    const pg = ctx.createLinearGradient(0, stripY, 0, stripY + stripH);
    pg.addColorStop(0, 'rgba(226,96,63,0.92)');
    pg.addColorStop(0.6, 'rgba(140,90,120,0.45)');
    pg.addColorStop(1, 'rgba(91,155,243,0.22)');
    ctx.fillStyle = pg;
    ctx.fill();

    // -1 dBTP reference
    const tpY = stripY + (1 / 36) * (stripH - 2);
    ctx.strokeStyle = 'rgba(255,181,69,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, Math.round(tpY) + 0.5);
    ctx.lineTo(w, Math.round(tpY) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    // time axis
    ctx.fillStyle = COL.text;
    ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const targetTicks = Math.max(3, Math.floor(w / 92));
    const rawStep = span / targetTicks;
    const nice = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s >= rawStep) || 600;
    const first = Math.ceil(t0 / nice) * nice;
    for (let t = first; t <= t1 + 1e-6; t += nice) {
      const x = xOf(t);
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, padTop);
      ctx.lineTo(Math.round(x) + 0.5, stripTop + stripH);
      ctx.stroke();
      ctx.fillText(fmtTime(t), x, stripTop + stripH + 2);
    }

    // selection
    if (state.selection) {
      const a = Math.min(state.selection.a, state.selection.b);
      const b = Math.max(state.selection.a, state.selection.b);
      const xa = xOf(a);
      const xb = xOf(b);
      ctx.fillStyle = 'rgba(255,181,69,0.1)';
      ctx.fillRect(xa, padTop, xb - xa, plotH);
      ctx.strokeStyle = 'rgba(255,181,69,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(xa) + 0.5, padTop);
      ctx.lineTo(Math.round(xa) + 0.5, padTop + plotH);
      ctx.moveTo(Math.round(xb) + 0.5, padTop);
      ctx.lineTo(Math.round(xb) + 0.5, padTop + plotH);
      ctx.stroke();
    }

    // playhead
    if (state.play.playing || state.play.offset > 0) {
      const t = playbackTime();
      if (t >= t0 && t <= t1) {
        const x = xOf(t);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, padTop);
        ctx.lineTo(Math.round(x) + 0.5, stripTop + stripH);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.moveTo(x - 4, padTop - 5);
        ctx.lineTo(x + 4, padTop - 5);
        ctx.lineTo(x, padTop + 1);
        ctx.closePath();
        ctx.fill();
      }
    }

    // hover readout
    if (state.hover && state.hover.x >= 0 && state.hover.x <= w) {
      const t = t0 + (state.hover.x / w) * span;
      const idx = clamp(Math.round(t / BLOCK) - 1, 0, n - 1);
      const mv = meter.momentary[idx];
      const sv = meter.shortTerm[idx];
      const label = fmtTimePrecise(t) + '   M ' + fmt(mv) + '   S ' + fmt(sv);
      ctx.font = '9.5px ui-monospace, Consolas, monospace';
      const tw = ctx.measureText(label).width;
      const boxX = clamp(state.hover.x + 10, 4, w - tw - 14);
      ctx.fillStyle = 'rgba(10,13,19,0.92)';
      ctx.fillRect(boxX, padTop + 2, tw + 10, 16);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.strokeRect(boxX + 0.5, padTop + 2.5, tw + 9, 15);
      ctx.fillStyle = '#c8d2e2';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, boxX + 5, padTop + 10);
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(state.hover.x) + 0.5, padTop);
      ctx.lineTo(Math.round(state.hover.x) + 0.5, stripTop + stripH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /* ------------------------------------------------------------------ *
   * DOM readouts
   * ------------------------------------------------------------------ */

  function updateReadouts() {
    const v = state.values;
    const t = state.target;

    setValue($('vIntegrated'), v ? fmtLevel(v.integrated) : '\u2014');
    setValue($('vM'), v ? fmtLevel(v.momentary) : '\u2014');
    setValue($('vS'), v ? fmtLevel(v.shortTerm) : '\u2014');
    setValue($('vLra'), v ? fmt(v.lra) : '\u2014');
    setValue($('vPlr'), v ? fmt(v.plr) : '\u2014');
    setValue($('vPsr'), v ? fmt(v.psr) : '\u2014');
    setValue($('vMaxM'), v ? fmtLevel(v.maxMomentary) : '\u2014');
    setValue($('vMaxS'), v ? fmtLevel(v.maxShortTerm) : '\u2014');
    setValue($('vTp'), v ? fmtLevel(v.truePeak) : '\u2014');

    const heroVal = $('vIntegrated');
    heroVal.classList.toggle('is-hot', !!(v && isNum(v.integrated) && t.il !== null && v.integrated - t.il > 1.0));

    const verdict = $('verdict');
    let verdictText = '\u2014';
    let verdictClass = 'verdict is-idle';

    if (v && isNum(v.integrated) && t && t.il !== null) {
      const delta = v.integrated - t.il;
      const tpOver = isNum(v.truePeak) && v.truePeak > t.tp;
      setText($('targetLine'), 'target ' + fmt(t.il) + '  \u00b7  ' + fmtSigned(delta) + ' LU');
      setText($('gateLine'), isNum(v.integratedThreshold) ? 'rel gate ' + fmt(v.integratedThreshold) : 'gate \u2014');

      if (tpOver) {
        verdictText = 'TP ' + fmtSigned(v.truePeak - t.tp);
        verdictClass = 'verdict is-bad';
      } else if (Math.abs(delta) <= 0.3) {
        verdictText = 'ON TARGET';
        verdictClass = 'verdict is-ok';
      } else if (Math.abs(delta) <= 1.0) {
        verdictText = fmtSigned(delta) + ' LU';
        verdictClass = 'verdict is-warn';
      } else {
        verdictText = fmtSigned(delta) + ' LU';
        verdictClass = 'verdict is-bad';
      }
    } else if (v && isNum(v.integrated)) {
      setText($('targetLine'), 'no target set');
      setText($('gateLine'), isNum(v.integratedThreshold) ? 'rel gate ' + fmt(v.integratedThreshold) : 'gate \u2014');
    } else if (v) {
      setText($('targetLine'), 'no measurable loudness');
      setText($('gateLine'), 'gate \u2014');
    } else {
      setText($('targetLine'), 'waiting for audio');
      setText($('gateLine'), 'gate \u2014');
    }

    setText(verdict, verdictText);
    if (verdict.className !== verdictClass) verdict.className = verdictClass;

    const tpCell = document.querySelector('.cell-tp');
    tpCell.classList.toggle('is-over', !!(v && t && t.tp !== null && isNum(v.truePeak) && v.truePeak > t.tp));

    const units = state.units;
    if (unitNodes.length) {
      unitNodes.forEach((el) => {
        if (el.textContent === 'LUFS' || el.textContent === 'LKFS') el.textContent = units;
      });
    }

    if (v) {
      setText($('layoutChip'), v.layout);
      setText($('rateChip'), (v.sampleRate / 1000).toFixed(1).replace('.0', '') + ' kHz');
      setText($('blocksChip'), v.blocks + ' × 100 ms');
    } else {
      setText($('layoutChip'), '—');
      setText($('rateChip'), '—');
      setText($('blocksChip'), '0 blocks');
    }

    const silent = !!(v && v.momentary === -Infinity);
    const chip = $('silentChip');
    if (chip) chip.hidden = !silent;

    setText($('timeLabel'), fmtTime(playbackTime()) + ' / ' + fmtTime(v ? v.duration : 0));
  }

  /* ------------------------------------------------------------------ *
   * analysis
   * ------------------------------------------------------------------ */

  function getDecodeContext() {
    if (state.decodeCtx) return state.decodeCtx;
    try {
      state.decodeCtx = new OfflineAudioContext(2, 1, 48000);
    } catch (e) {
      const AC = window.AudioContext || window.webkitAudioContext;
      state.decodeCtx = new AC();
    }
    return state.decodeCtx;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function measureChannels(channels, sampleRate, label) {
    state.analysis.running = true;
    setProgress(0);
    const meter = new Core.Meter(sampleRate, { channels: channels.length });
    state.meter = meter;
    state.values = null;
    state.histCache = null;
    state.needsHist = true;

    const n = channels[0].length;
    const chunk = Math.round(sampleRate * 2);
    for (let off = 0; off < n; off += chunk) {
      const len = Math.min(chunk, n - off);
      const slice = channels.map((c) => c.subarray(off, off + len));
      meter.push(slice, len);
      state.values = meter.values();
      state.needsHist = true;
      setProgress((off + len) / n);
      setStatus('Measuring ' + Math.round(((off + len) / n) * 100) + '%  ·  ' + label);
      await sleep(0);
    }

    state.values = meter.values();
    state.histCache = null;
    state.needsHist = true;
    state.analysis.running = false;
    setProgress(null);
    setStatus('Measured  ·  I ' + fmt(state.values.integrated) + ' LUFS  ·  LRA ' + fmt(state.values.lra) + ' LU');
    return meter;
  }

  async function loadFile(file) {
    if (state.busy) return;
    state.busy = true;
    stopPlayback();
    stopLive();
    setStatus('Decoding ' + file.name + ' …');
    setProgress(0);
    try {
      const data = await file.arrayBuffer();
      const ctx = getDecodeContext();
      const buffer = await new Promise((resolve, reject) => {
        const p = ctx.decodeAudioData(data.slice(0), resolve, reject);
        if (p && p.then) p.then(resolve, reject);
      });
      const channels = [];
      for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
      state.source = {
        kind: 'file',
        name: file.name,
        buffer,
        bytes: data,
        bits: Core.wavBits(data),
        sampleRate: buffer.sampleRate
      };
      state.selection = null;
      state.play.offset = 0;
      applySourceHeader();
      await measureChannels(channels, buffer.sampleRate, file.name);
      $('btnPlay').disabled = false;
      setStatus('Ready  ·  ' + fmtTime(buffer.duration) + '  ·  press Space to play');
    } catch (err) {
      console.error(err);
      setProgress(null);
      toast('Could not decode that file — try WAV, MP3, FLAC, OGG or M4A.', true);
      setStatus('Decode failed');
    } finally {
      state.busy = false;
    }
  }

  function applySourceHeader() {
    const s = state.source;
    const dot = $('sourceDot');
    dot.className = 'source-dot';
    if (s.kind === 'file') { dot.classList.add('is-file'); setText($('fileName'), s.name); }
    else if (s.kind === 'demo') { dot.classList.add('is-demo'); setText($('fileName'), 'Demo programme (synthesised)'); }
    else if (s.kind === 'live') { dot.classList.add('is-live'); setText($('fileName'), s.name || 'Live input'); }
    else setText($('fileName'), 'No audio loaded');

    if (s.buffer) {
      const ch = s.buffer.numberOfChannels;
      setText($('fileMeta'), fmtTime(s.buffer.duration) + '  ·  ' + (ch === 1 ? 'mono' : ch === 2 ? 'stereo' : ch + ' ch') +
        '  ·  ' + (s.buffer.sampleRate / 1000).toFixed(1).replace('.0', '') + ' kHz');
    } else if (s.kind === 'demo' && state.values) {
      setText($('fileMeta'), fmtTime(state.values.duration) + '  ·  ' + state.values.layout +
        '  ·  ' + (state.values.sampleRate / 1000).toFixed(1).replace('.0', '') + ' kHz');
    } else if (s.kind === 'live') {
      setText($('fileMeta'), 'real-time · nothing is recorded · ' + (s.name === 'System audio' ? 'loopback of the PC output' : 'input device'));
    } else {
      setText($('fileMeta'), 'drop a file anywhere, or press Open audio');
    }
  }

  /* ------------------------------------------------------------------ *
   * demo programme
   * ------------------------------------------------------------------ */

  /**
   * Simple look-ahead peak limiter: the gain dips 2 ms before a peak and
   * recovers over ~80 ms, so the output never exceeds `ceiling`.
   */
  function limitChannels(channels, fs, ceiling) {
    const nch = channels.length;
    const len = channels[0].length;
    const need = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let peak = 0;
      for (let c = 0; c < nch; c++) {
        const a = Math.abs(channels[c][i]);
        if (a > peak) peak = a;
      }
      need[i] = peak > ceiling ? ceiling / peak : 1;
    }
    const gain = new Float32Array(len);
    const rise = 1 / Math.max(1, 0.002 * fs);
    let g = 1;
    for (let i = len - 1; i >= 0; i--) {
      g = Math.min(need[i], g + rise);
      gain[i] = g;
    }
    const rel = 1 / Math.max(1, 0.08 * fs);
    g = 1;
    for (let i = 0; i < len; i++) {
      g = Math.min(gain[i], g + rel);
      gain[i] = g;
    }
    for (let c = 0; c < nch; c++) {
      const d = channels[c];
      for (let i = 0; i < len; i++) d[i] *= gain[i];
    }
  }

  function buildDemo() {
    const fs = 48000;
    const dur = 26;
    const n = Math.round(fs * dur);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296 - 0.5;
    };

    const chords = [
      [110.00, 164.81, 220.00, 277.18],
      [98.00, 146.83, 196.00, 246.94],
      [87.31, 130.81, 174.61, 220.00],
      [123.47, 185.00, 246.94, 311.13]
    ];

    // plucked chord bed, one chord per bar
    for (let bar = 0; bar < Math.ceil(dur / 2); bar++) {
      const chord = chords[bar % chords.length];
      const start = Math.round(bar * 2 * fs);
      const len = Math.round(3.0 * fs);
      for (let ni = 0; ni < chord.length; ni++) {
        const f = chord[ni];
        const det = 1 + (ni - 1.5) * 0.0008;
        const amp = 0.18 / (1 + ni * 0.35);
        const pan = (ni - 1.5) / 3;
        for (let i = 0; i < len; i++) {
          const idx = start + i;
          if (idx >= n) break;
          const t = i / fs;
          const env = Math.exp(-t * 1.15) * (1 - Math.exp(-t * 160));
          // sustained pad under the pluck keeps the programme from collapsing
          // into silence between hits (which would look like a broken meter)
          const padEnv = Math.min(1, t / 0.3) * Math.min(1, Math.max(0, (len / fs - t) / 0.4));
          const s = Math.sin(2 * Math.PI * f * det * t) * 0.7 +
            Math.sin(4 * Math.PI * f * det * t) * 0.18 +
            Math.sin(6 * Math.PI * f * det * t) * 0.06;
          const val = s * (env * amp + padEnv * amp * 0.34);
          L[idx] += val * (1 - pan * 0.5);
          R[idx] += val * (1 + pan * 0.5);
        }
      }
    }

    // kick + hat groove
    for (let beat = 0; beat < dur * 2; beat++) {
      const start = Math.round(beat * 0.5 * fs);
      const klen = Math.round(0.22 * fs);
      for (let i = 0; i < klen; i++) {
        const idx = start + i;
        if (idx >= n) break;
        const t = i / fs;
        const env = Math.exp(-t * 26);
        const f = 52 + 60 * Math.exp(-t * 40);
        const v = Math.sin(2 * Math.PI * f * t) * env * 0.17;
        L[idx] += v; R[idx] += v;
      }
      const hstart = Math.round((beat * 0.5 + 0.25) * fs);
      const hlen = Math.round(0.05 * fs);
      for (let i = 0; i < hlen; i++) {
        const idx = hstart + i;
        if (idx >= n) break;
        const t = i / fs;
        const env = Math.exp(-t * 90);
        const v = rnd() * env * 0.055;
        L[idx] += v * 1.2; R[idx] += v * 0.8;
      }
    }

    // arrangement envelope
    const sections = [
      { t: 0, g: 0.24 },
      { t: 5, g: 0.38 },
      { t: 9, g: 0.62 },
      { t: 14, g: 0.42 },
      { t: 18, g: 0.74 },
      { t: 22, g: 0.36 }
    ];
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      let g = sections[0].g;
      for (let s = 0; s < sections.length; s++) {
        if (t >= sections[s].t) {
          const next = sections[s + 1] ? sections[s + 1].t : dur;
          const x = clamp((t - sections[s].t) / 0.6, 0, 1);
          const prevG = s === 0 ? sections[0].g : sections[s - 1].g;
          g = (sections[s].g * x + prevG * (1 - x)) * (t < 22 ? 1 : 1 - (t - 22) / 4);
        }
      }
      L[i] *= g;
      R[i] *= g;
    }

    // fade out
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      if (t > dur - 3) {
        const k = clamp((dur - t) / 3, 0, 1);
        L[i] *= k; R[i] *= k;
      }
    }

    // gentle saturation: rounds the transients like a mastered mix would be
    const drive = 1.8;
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      L[i] = Math.tanh(L[i] * drive) / norm;
      R[i] = Math.tanh(R[i] * drive) / norm;
    }

    return { channels: [L, R], fs };
  }

  async function loadDemo() {
    if (state.busy) return;
    state.busy = true;
    stopPlayback();
    stopLive();
    setStatus('Building demo programme …');
    setProgress(0);
    await sleep(30);
    try {
      const { channels, fs } = buildDemo();
      // limit, then normalise to the target, three times: converges on
      // -14 LUFS without ever exceeding -1 dBTP
      for (let pass = 0; pass < 3; pass++) {
        limitChannels(channels, fs, 0.78);
        const m = new Core.Meter(fs, { channels: 2 });
        m.push(channels, channels[0].length);
        const il = m.values().integrated;
        if (!isFinite(il)) break;
        const g = Math.pow(10, (-14.0 - il) / 20);
        for (const c of channels) for (let i = 0; i < c.length; i++) c[i] *= g;
      }

      const AC = window.AudioContext || window.webkitAudioContext;
      let buffer = null;
      try {
        await ensurePlayContext();
        buffer = state.play.ctx.createBuffer(2, channels[0].length, fs);
        buffer.copyToChannel(channels[0], 0);
        buffer.copyToChannel(channels[1], 1);
      } catch (e) { /* playback optional */ }

      state.source = { kind: 'demo', name: 'Demo programme', buffer, sampleRate: fs };
      state.selection = null;
      state.play.offset = 0;
      applySourceHeader();
      await measureChannels(channels, fs, 'demo');
      $('btnPlay').disabled = !buffer;
      toast('Demo loaded — a synthesised programme at −14 LUFS');
    } catch (err) {
      console.error(err);
      toast('Demo generation failed.', true);
    } finally {
      state.busy = false;
      setProgress(null);
    }
  }

  /* ------------------------------------------------------------------ *
   * live input
   * ------------------------------------------------------------------ */

  function liveSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async function startLive() {
    if (state.live.ctx) { stopLive(); return; }
    if (location.protocol === 'file:') {
      toast('Live input needs a local server: open the app from the "Loudness Meter" desktop shortcut, or run "Start Loudness Meter.cmd"', true);
      return;
    }
    if (!liveSupported()) {
      toast('Live input needs a secure page: open the app from the "Loudness Meter" desktop shortcut, or run "Start Loudness Meter.cmd"', true);
      return;
    }
    stopPlayback();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      attachLiveStream(stream, 'Microphone / line', 'MIC');
    } catch (err) {
      console.error(err);
      toast('Microphone unavailable: ' + (err && err.message ? err.message : err), true);
    }
  }

  /**
   * Meters whatever the machine is playing (Audacity, a browser tab, Spotify).
   * Chrome only exposes system audio through the screen-share picker.
   */
  async function startSystemAudio() {
    if (state.live.ctx) { stopLive(); return; }
    if (location.protocol === 'file:') {
      toast('System audio needs a local server: open the app from the "Loudness Meter" desktop shortcut.', true);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('This browser cannot capture system audio.', true);
      return;
    }
    if (/firefox/i.test(navigator.userAgent)) {
      toast('Firefox can only share video, not audio. Open the meter from the desktop shortcut (it uses Edge) and pick System audio there.', true);
      return;
    }
    stopPlayback();
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2
        }
      });
    } catch (err) {
      if (err && err.name === 'NotAllowedError') toast('System audio capture was cancelled.');
      else toast('Could not capture system audio: ' + (err && err.message ? err.message : err), true);
      return;
    }

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      toast('No audio came through. Pick "Entire screen" in the picker and tick "Share system audio".', true);
      return;
    }

    // keep the video track alive (Chrome ties the audio session to it) but never use it
    const audioStream = new MediaStream(audioTracks);
    attachLiveStream(audioStream, 'System audio', 'SYS', stream);
  }

  function attachLiveStream(stream, label, kind, keeper) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const channels = Math.min(2, src.channelCount || 2);
    const node = ctx.createScriptProcessor(4096, channels, channels);
    const sink = ctx.createGain();
    sink.gain.value = 0;

    const meter = new Core.Meter(ctx.sampleRate, { channels: 2 });
    node.onaudioprocess = (ev) => {
      const chans = [];
      for (let i = 0; i < ev.inputBuffer.numberOfChannels; i++) {
        chans.push(ev.inputBuffer.getChannelData(i));
      }
      meter.push(chans, ev.inputBuffer.length);
      state.meter = meter;
      state.values = meter.values();
      state.needsHist = true;
    };

    src.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    state.live = { ctx, node, stream, sink, src, keeper: keeper || stream };
    state.meter = meter;
    state.values = null;
    state.histCache = null;
    state.selection = null;
    state.winSeconds = 10;
    document.querySelectorAll('.win-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.win === '10'));
    state.source = { kind: 'live', name: label, buffer: null, sampleRate: ctx.sampleRate };
    applySourceHeader();
    $('btnLive').classList.add('is-active');
    $('btnPlay').disabled = true;
    setStatus(label + '  \u00b7  ' + (ctx.sampleRate / 1000).toFixed(1).replace('.0', '') + ' kHz  \u00b7  ' + meter.layoutName);
    toast(label === 'System audio' ? 'Metering system audio' : 'Metering started');
  }

  function stopLive() {
    const l = state.live;
    if (!l || !l.ctx) return;
    try { l.node.disconnect(); } catch (e) {}
    try { l.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { if (l.keeper && l.keeper !== l.stream) l.keeper.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { l.ctx.close(); } catch (e) {}
    state.live = { ctx: null, node: null, stream: null, sink: null };
    $('btnLive').classList.remove('is-active');
    if (state.source.kind === 'live') {
      state.source = { kind: 'idle', name: '', buffer: null, sampleRate: 0 };
      state.meter = null;
      state.values = null;
      state.histCache = null;
      applySourceHeader();
      setStatus('Live input stopped');
    }
  }

  /* ------------------------------------------------------------------ *
   * playback
   * ------------------------------------------------------------------ */

  async function ensurePlayContext() {
    if (state.play.ctx) return state.play.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    try {
      state.play.ctx = new AC({ sampleRate: 48000 });
    } catch (e) {
      state.play.ctx = new AC();
    }
    return state.play.ctx;
  }

  function playbackTime() {
    const p = state.play;
    if (!p.ctx) return p.offset || 0;
    return p.playing ? p.offset + (p.ctx.currentTime - p.startedAt) : p.offset;
  }

  function startPlayback(from) {
    const b = state.source.buffer;
    if (!b || !state.play.ctx) return;
    const ctx = state.play.ctx;
    ctx.resume();
    stopNode();
    const src = ctx.createBufferSource();
    src.buffer = b;
    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    src.connect(gain).connect(ctx.destination);
    const offset = clamp(from === undefined ? state.play.offset : from, 0, b.duration - 0.01);
    src.start(0, offset);
    src.onended = () => {
      if (state.play.node !== src) return;
      state.play.playing = false;
      state.play.offset = 0;
      updatePlayButton();
    };
    state.play.node = src;
    state.play.gain = gain;
    state.play.startedAt = ctx.currentTime;
    state.play.offset = offset;
    state.play.playing = true;
    updatePlayButton();
  }

  function stopNode() {
    if (state.play.node) {
      try { state.play.node.onended = null; state.play.node.stop(); } catch (e) {}
      state.play.node = null;
    }
  }

  function stopPlayback() {
    if (state.play.playing) state.play.offset = playbackTime();
    state.play.playing = false;
    stopNode();
    updatePlayButton();
  }

  function togglePlay() {
    if (!state.source.buffer) return;
    ensurePlayContext().then(() => {
      if (state.play.playing) {
        stopPlayback();
      } else {
        if (state.play.offset >= state.source.buffer.duration - 0.05) state.play.offset = 0;
        startPlayback(state.play.offset);
      }
    }).catch((err) => {
      console.error(err);
      toast('Playback is not available in this browser context.', true);
    });
  }

  function seek(t) {
    const dur = state.source.buffer ? state.source.buffer.duration : (state.values ? state.values.duration : 0);
    state.play.offset = clamp(t, 0, Math.max(0, dur - 0.01));
    if (state.play.playing) startPlayback(state.play.offset);
  }

  function updatePlayButton() {
    const btn = $('btnPlay');
    btn.classList.toggle('is-playing', state.play.playing);
    btn.innerHTML = state.play.playing
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>';
  }

  /* ------------------------------------------------------------------ *
   * selection
   * ------------------------------------------------------------------ */

  function rangeStats(a, b) {
    const meter = state.meter;
    if (!meter) return null;
    const lo = clamp(Math.min(a, b), 0, meter.duration);
    const hi = clamp(Math.max(a, b), 0, meter.duration);
    const i0 = clamp(Math.floor(lo / BLOCK), 0, meter.subPowers.length);
    const i1 = clamp(Math.ceil(hi / BLOCK), 0, meter.subPowers.length);
    const subs = meter.subPowers;
    const powers = [];
    for (let i = i0; i + 3 < i1; i++) {
      powers.push((subs[i] + subs[i + 1] + subs[i + 2] + subs[i + 3]) * 0.25);
    }
    if (!powers.length) return null;
    const il = Core.integratedFromPowers(powers);
    const st = [];
    let maxM = -Infinity, maxS = -Infinity, maxPeak = -Infinity;
    for (let i = i0; i < i1; i++) {
      const s = meter.shortTerm[i];
      if (isNum(s)) { st.push(s); if (s > maxS) maxS = s; }
      const m = meter.momentary[i];
      if (isNum(m) && m > maxM) maxM = m;
      const pk = meter.peakDb[i];
      if (isNum(pk) && pk > maxPeak) maxPeak = pk;
    }
    const lra = Core.loudnessRange(st, il.loudness);
    return { lo, hi, il: il.loudness, lra: lra.lra, maxM, maxS, maxPeak, dur: hi - lo };
  }

  function updateSelectionChip() {
    const chip = $('selChip');
    if (!state.selection) { chip.hidden = true; return; }
    const s = rangeStats(state.selection.a, state.selection.b);
    if (!s) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.textContent = 'SELECTION ' + fmtTime(s.lo) + '–' + fmtTime(s.hi) + '  ·  I ' +
      fmt(s.il) + '  ·  LRA ' + fmt(s.lra) + ' LU  ·  MAX S ' + fmt(s.maxS);
  }

  /* ------------------------------------------------------------------ *
   * export
   * ------------------------------------------------------------------ */

  function buildReport() {
    const v = state.values;
    if (!v) return null;
    const t = state.target;
    const src = state.source;
    const now = new Date();
    const lines = [];
    const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);

    lines.push('LOUDNESS REPORT');
    lines.push('='.repeat(58));
    lines.push('Source        : ' + (src.name || '—'));
    lines.push('Measured      : ' + now.toLocaleString());
    lines.push('Duration      : ' + fmtTime(v.duration) + '  (' + v.duration.toFixed(2) + ' s)');
    lines.push('Format        : ' + v.layout + '  ·  ' + v.sampleRate + ' Hz  ·  ' + v.blocks + ' blocks');
    lines.push('');
    lines.push('MEASUREMENT (ITU-R BS.1770-4 / EBU R128)');
    lines.push('-'.repeat(58));
    lines.push(pad('Integrated loudness', 26) + fmt(v.integrated, 2) + ' LUFS');
    lines.push(pad('Gating threshold', 26) + fmt(v.integratedThreshold, 2) + ' LUFS');
    lines.push(pad('Short-term max', 26) + fmt(v.maxShortTerm, 2) + ' LUFS');
    lines.push(pad('Momentary max', 26) + fmt(v.maxMomentary, 2) + ' LUFS');
    lines.push(pad('Loudness range (LRA)', 26) + fmt(v.lra, 2) + ' LU');
    lines.push(pad('True peak (4x)', 26) + fmt(v.truePeak, 2) + ' dBTP');
    lines.push(pad('Sample peak', 26) + fmt(v.samplePeak, 2) + ' dBFS');
    lines.push(pad('PLR', 26) + fmt(v.plr, 2) + ' LU');
    lines.push(pad('PSR', 26) + fmt(v.psr, 2) + ' LU');
    lines.push('');

    if (t && t.il !== null) {
      const d = v.integrated - t.il;
      const tpOk = !isNum(v.truePeak) || v.truePeak <= t.tp;
      lines.push('TARGET: ' + t.label);
      lines.push('-'.repeat(58));
      lines.push(pad('Target loudness', 26) + fmt(t.il, 1) + ' LUFS');
      lines.push(pad('Delta', 26) + fmtSigned(d, 2) + ' LU  (' + (Math.abs(d) <= 0.3 ? 'within ±0.3' : 'outside tolerance') + ')');
      lines.push(pad('True-peak ceiling', 26) + fmt(t.tp, 1) + ' dBTP  (' + (tpOk ? 'OK' : 'EXCEEDED') + ')');
      lines.push('');
    }

    if (state.selection) {
      const s = rangeStats(state.selection.a, state.selection.b);
      if (s) {
        lines.push('SELECTION ' + fmtTime(s.lo) + ' – ' + fmtTime(s.hi) + '  (' + s.dur.toFixed(1) + ' s)');
        lines.push('-'.repeat(58));
        lines.push(pad('Integrated', 26) + fmt(s.il, 2) + ' LUFS');
        lines.push(pad('LRA', 26) + fmt(s.lra, 2) + ' LU');
        lines.push(pad('Short-term max', 26) + fmt(s.maxS, 2) + ' LUFS');
        lines.push(pad('Momentary max', 26) + fmt(s.maxM, 2) + ' LUFS');
        lines.push(pad('Sample peak', 26) + fmt(s.maxPeak, 2) + ' dBFS');
        lines.push('');
      }
    }

    lines.push('METHOD');
    lines.push('-'.repeat(58));
    lines.push('K-weighting per BS.1770-4 (bilinear-derived at the measured rate).');
    lines.push('400 ms blocks with 100 ms hops; -70 LUFS absolute gate, then');
    lines.push('-10 LU relative gate for integrated loudness.');
    lines.push('LRA per EBU Tech 3342 (P10/P95, -20 LU relative gate).');
    lines.push('True peak: 4x polyphase oversampling, max across channels.');
    return lines.join('\r\n');
  }

  const PICKER_TYPES = {
    wav: { description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } },
    mp3: { description: 'MP3 audio', accept: { 'audio/mpeg': ['.mp3'] } },
    flac: { description: 'FLAC audio', accept: { 'audio/flac': ['.flac'] } },
    txt: { description: 'Text report', accept: { 'text/plain': ['.txt'] } }
  };

  /**
   * Saves through the system Save dialog when the browser has the File System
   * Access API, so the file lands in the folder the user picks instead of
   * Downloads. Falls back to a normal download elsewhere.
   */
  async function saveBlob(blob, filename) {
    const m = filename.match(/\.([a-z0-9]+)$/i);
    const ext = m ? m[1].toLowerCase() : '';
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: PICKER_TYPES[ext] ? [PICKER_TYPES[ext]] : undefined
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        toast('Saved \u00b7 ' + handle.name);
        return true;
      } catch (err) {
        if (err && err.name === 'AbortError') return false;
        if (!err || (err.name !== 'SecurityError' && err.name !== 'TypeError')) {
          console.error(err);
          toast('Could not write that file: ' + (err && err.message ? err.message : err), true);
          return false;
        }
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    toast('Downloaded \u00b7 ' + filename);
    return true;
  }
  function exportReport() {
    const text = buildReport();
    if (!text) { toast('Nothing to export yet — load audio first.', true); return; }
    const base = (state.source.name || 'measurement').replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_').slice(0, 60);
    saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), base + ' — loudness report.txt');
  }

  /* ------------------------------------------------------------------ *
   * auto-fix
   * ------------------------------------------------------------------ */

  function fixCell(id, text, bad) {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle('is-bad', !!bad);
  }

  function openFix() {
    if (!state.values || !state.source.buffer) {
      toast('Load an audio file first — live input cannot be written back.', true);
      return;
    }
    const t = state.target;
    if (!t || t.il === null) { toast('Choose a target preset first.', true); return; }
    if (state.values.duration > 20 * 60) {
      toast('That file is over 20 minutes — too long to rewrite in the browser.', true);
      return;
    }

    state.fix = null;
    $('btnSaveFix').disabled = true;
    $('fixTargetLabel').textContent = 'target ' + fmt(t.il) + ' LUFS  \u00b7  ' + t.label.replace(/\s+/g, ' ').slice(0, 22);
    $('fixCeil').value = t.tp.toFixed(1);
    const srcBits = (state.source && state.source.bits) || 0;
    $('fixBits').value = String(srcBits === 16 || srcBits === 32 ? srcBits : 24);
    updateFixBitsLabel();

    const v = state.values;
    fixCell('fixNowI', fmt(v.integrated) + ' LUFS');
    fixCell('fixNowTP', fmt(v.truePeak) + ' dBTP', v.truePeak > t.tp);
    fixCell('fixNowLRA', fmt(v.lra) + ' LU');
    fixCell('fixNowPLR', fmt(v.plr) + ' LU');
    fixCell('fixAfterI', '\u2014');
    fixCell('fixAfterTP', '\u2014');
    fixCell('fixAfterLRA', '\u2014');
    fixCell('fixAfterPLR', '\u2014');
    $('fixBar').hidden = true;
    $('btnDoFix').disabled = false;
    $('btnDoFix').textContent = 'Fix & measure';
    updateFixPlan();
    $('fixModal').hidden = false;
  }

  function updateFixPlan() {
    const v = state.values;
    const t = state.target;
    if (!v || !t || t.il === null) return;
    const typed = parseFloat(String($('fixCeil').value).replace(',', '.'));
    const ceiling = isFinite(typed) ? typed : t.tp;
    const gain = t.il - v.integrated;
    const projected = v.truePeak + gain;
    const limiter = Math.max(0, projected - ceiling);

    const bits = [fmtSigned(gain) + ' dB gain'];
    if (limiter > 0.05) bits.push('limiter ' + limiter.toFixed(1) + ' dB on the loudest peaks');
    let text = 'Plan: ' + bits.join('  ·  ') + '.  Predicted \u2248 ' + fmt(t.il) + ' LUFS / ' +
      fmt(Math.min(projected, ceiling)) + ' dBTP.';
    const warn = limiter > 3;
    if (warn) text += '  That is a lot of limiting — transients will flatten.';

    const el = $('fixPlan');
    el.textContent = text;
    el.classList.toggle('is-warn', warn);
  }

  async function doFix() {
    const t = state.target;
    const ceiling = parseFloat(String($('fixCeil').value).replace(',', '.'));
    if (!t || t.il === null || !isFinite(ceiling)) return;

    $('btnDoFix').disabled = true;
    $('btnDoFix').textContent = 'Working…';
    $('fixBar').hidden = false;
    $('fixPlan').textContent = 'Applying gain, limiting, re-measuring…';
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));

    try {
      const buffer = state.source.buffer;
      const src = [];
      for (let i = 0; i < buffer.numberOfChannels; i++) src.push(buffer.getChannelData(i));
      const fix = Core.normalizeToTarget(src, buffer.sampleRate, {
        targetIL: t.il,
        ceiling,
        before: state.values
      });
      if (!fix) { toast('Nothing to fix — the file measures as silence.', true); return; }

      state.fix = fix;
      const a = fix.after;
      fixCell('fixAfterI', fmt(a.integrated) + ' LUFS');
      fixCell('fixAfterTP', fmt(a.truePeak) + ' dBTP', a.truePeak > ceiling + 0.05);
      fixCell('fixAfterLRA', fmt(a.lra) + ' LU');
      fixCell('fixAfterPLR', fmt(a.plr) + ' LU');
      $('btnSaveFix').disabled = false;

      const reduced = fix.reductionDb > 0.05
        ? ' \u00b7 limiter pulled ' + fix.reductionDb.toFixed(1) + ' dB'
        : ' \u00b7 no limiting needed';
      $('fixPlan').textContent = 'Done: ' + fmtSigned(fix.gainDb) + ' dB applied' + reduced +
        '.  Measured ' + fmt(a.integrated) + ' LUFS / ' + fmt(a.truePeak) + ' dBTP.';
      $('fixPlan').classList.remove('is-warn');
      setStatus('Fixed  \u00b7  ' + fmt(a.integrated) + ' LUFS  \u00b7  ' + fmt(a.truePeak) + ' dBTP');
    } catch (err) {
      console.error(err);
      toast('Could not process this file: ' + (err && err.message ? err.message : err), true);
    } finally {
      $('fixBar').hidden = true;
      $('btnDoFix').disabled = false;
      $('btnDoFix').textContent = 'Fix & measure';
    }
  }

  function updateFixBitsLabel() {
    const el = $('btnSaveFix');
    if (el) el.textContent = 'Download ' + fixDepth() + '-bit WAV';
  }

  function fixDepth() {
    const v = parseInt($('fixBits') && $('fixBits').value, 10);
    return v === 16 || v === 32 ? v : 24;
  }

  function wavBlob(channels, sampleRate, bits) {
    const depth = bits || 24;
    const nch = channels.length;
    const n = channels[0].length;
    const width = depth / 8;
    const dataSize = n * nch * width;
    const parts = [Core.wavHeader(dataSize, nch, sampleRate, depth)];
    const frames = Math.max(1, Math.round(sampleRate * 4));

    for (let start = 0; start < n; start += frames) {
      const len = Math.min(frames, n - start);
      const buf = new ArrayBuffer(len * nch * width);
      const view = new DataView(buf);
      let o = 0;
      for (let i = 0; i < len; i++) {
        for (let c = 0; c < nch; c++) {
          let v = channels[c][start + i];
          v = v > 1 ? 1 : v < -1 ? -1 : v;
          if (depth === 32) {
            view.setFloat32(o, v, true);
          } else if (depth === 16) {
            view.setInt16(o, Math.round(v * 32767), true);
          } else {
            const x = Math.round(v * 8388607);
            view.setUint8(o, x & 0xff);
            view.setUint8(o + 1, (x >> 8) & 0xff);
            view.setUint8(o + 2, (x >> 16) & 0xff);
          }
          o += width;
        }
      }
      parts.push(buf);
    }
    return new Blob(parts, { type: 'audio/wav' });
  }

  function saveFix() {
    const f = state.fix;
    if (!f) return;
    const blob = wavBlob(f.channels, f.sampleRate, fixDepth());
    const base = (state.source.name || 'master')
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w\-. ]+/g, '_')
      .slice(0, 60);
    saveBlob(blob, base + ' (' + fmt(state.target.il) + ' LUFS).wav');
  }

  /* ------------------------------------------------------------------ *
   * metadata editor
   * ------------------------------------------------------------------ */

  const META_LABELS = {
    title: 'Title', artist: 'Artist', album: 'Album', albumartist: 'Album artist',
    date: 'Year / date', genre: 'Genre', track: 'Track', comment: 'Comment',
    copyright: 'Copyright', isrc: 'ISRC', encoder: 'Encoder'
  };

  function metaBytes() {
    return state.source && state.source.bytes ? state.source.bytes : null;
  }

  function openMeta() {
    const bytes = metaBytes();
    if (!bytes) {
      toast('Load an audio file first — the editor works on the file itself.', true);
      return;
    }
    let info;
    try {
      info = Metadata.read(bytes);
    } catch (err) {
      toast('Could not read this file: ' + (err && err.message ? err.message : err), true);
      return;
    }
    if (info.format === 'unknown') {
      toast('Only WAV, MP3 and FLAC containers are supported.', true);
      return;
    }

    state.meta = { info, bytes };
    $('metaFormat').textContent = info.label;
    $('metaSize').textContent = (bytes.byteLength / 1048576).toFixed(1) + ' MB';
    $('metaName').textContent = state.source.name || 'audio';

    // editable fields
    const form = $('metaForm');
    form.innerHTML = '';
    const fields = info.editable && info.editable.length ? info.editable : Object.keys(META_LABELS);
    for (const key of fields) {
      const label = document.createElement('label');
      label.className = 'meta-field' + (key === 'comment' ? ' is-wide' : '');
      const span = document.createElement('span');
      span.textContent = META_LABELS[key] || key;
      let input;
      if (key === 'comment') {
        input = document.createElement('textarea');
        input.rows = 2;
      } else {
        input = document.createElement('input');
        input.type = 'text';
      }
      input.value = info.fields[key] || '';
      input.dataset.key = key;
      input.placeholder = '—';
      label.appendChild(span);
      label.appendChild(input);
      form.appendChild(label);
    }

    // what is actually in the file
    const list = $('metaFound');
    list.innerHTML = '';
    if (!info.found.length) {
      const empty = document.createElement('div');
      empty.className = 'meta-empty';
      empty.textContent = 'No metadata chunks found — already clean.';
      list.appendChild(empty);
    }
    for (const f of info.found) {
      const row = document.createElement('div');
      row.className = 'meta-row';
      const k = document.createElement('b');
      k.textContent = f.key;
      const v = document.createElement('span');
      v.textContent = String(f.value).slice(0, 90);
      const w = document.createElement('i');
      w.textContent = f.where;
      row.appendChild(k);
      row.appendChild(v);
      row.appendChild(w);
      list.appendChild(row);
    }

    $('metaArt').hidden = !info.art;
    $('metaNote').textContent = '';
    $('metaModal').hidden = false;
    $('metaSave').disabled = false;
  }

  function collectMetaFields() {
    const out = {};
    $('metaForm').querySelectorAll('[data-key]').forEach((el) => {
      const v = el.value.trim();
      if (v) out[el.dataset.key] = v;
    });
    return out;
  }

  function downloadBuffer(arrayBuffer, fileName) {
    const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  async function saveMeta(stripAll) {
    const m = state.meta;
    if (!m) return;
    try {
      const result = Metadata.write(m.bytes, { fields: collectMetaFields(), stripAll: !!stripAll });
      const base = (state.source.name || 'audio').replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_').slice(0, 60);
      const ext = (state.source.name.match(/\.[^.]+$/) || ['.wav'])[0];
      const suffix = stripAll ? ' — clean' : ' — tagged';
      await saveBlob(new Blob([result.bytes]), base + suffix + ext);

      const removed = result.removedList && result.removedList.length
        ? result.removedList.join(', ')
        : 'nothing';
      $('metaNote').textContent = stripAll
        ? 'Stripped ' + removed + '. Audio untouched (' + (result.bytes.byteLength / 1048576).toFixed(1) + ' MB).'
        : 'Saved with ' + Object.keys(collectMetaFields()).length + ' fields. Removed: ' + removed + '.';
      toast(stripAll ? 'Clean file exported' : 'Tagged file exported');
    } catch (err) {
      console.error(err);
      toast('Could not write metadata: ' + (err && err.message ? err.message : err), true);
    }
  }

  function stripFromMenu() {
    openMeta();
    if (state.meta) {
      $('metaForm').querySelectorAll('[data-key]').forEach((el) => { el.value = ''; });
      saveMeta(true);
    }
  }

  /* ------------------------------------------------------------------ *
   * events
   * ------------------------------------------------------------------ */

  function initTargets() {
    const sel = $('targetSelect');
    TARGETS.forEach((t) => {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.label + ' LUFS';
      sel.appendChild(o);
    });
    sel.value = state.target.id;
    sel.addEventListener('change', () => {
      state.target = TARGETS.find((t) => t.id === sel.value) || TARGETS[0];
      updateReadouts();
    });
  }

  function graphTimeAt(clientX) {
    const canvas = $('graphCanvas');
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const { t0, t1 } = state.view;
    return t0 + clamp(x / Math.max(1, rect.width), 0, 1) * (t1 - t0);
  }

  function initGraphInteraction() {
    const canvas = $('graphCanvas');

    canvas.addEventListener('pointermove', (ev) => {
      const rect = canvas.getBoundingClientRect();
      state.hover = { x: ev.clientX - rect.left };
      const t = graphTimeAt(ev.clientX);
      if (state.dragging) {
        state.selection = { a: state.dragging, b: t };
        updateSelectionChip();
      }
    });

    canvas.addEventListener('pointerleave', () => {
      state.hover = null;
    });

    canvas.addEventListener('pointerdown', (ev) => {
      if (!state.meter) return;
      ev.preventDefault();
      canvas.setPointerCapture(ev.pointerId);
      state.dragging = graphTimeAt(ev.clientX);
      state.selection = null;
      updateSelectionChip();
    });

    canvas.addEventListener('pointerup', (ev) => {
      if (state.dragging === null) return;
      const t = graphTimeAt(ev.clientX);
      const a = Math.min(state.dragging, t);
      const b = Math.max(state.dragging, t);
      state.dragging = null;
      if (b - a > 0.12) {
        state.selection = { a, b };
      } else {
        state.selection = null;
        seek(t);
      }
      updateSelectionChip();
    });

    canvas.addEventListener('dblclick', () => {
      state.selection = null;
      updateSelectionChip();
    });
  }

  function initDropZone() {
    let depth = 0;
    const hasFiles = (ev) => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev)) return;
      depth++;
      document.body.classList.add('is-dragover');
      ev.preventDefault();
    });
    window.addEventListener('dragover', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (ev) => {
      if (!hasFiles(ev)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) document.body.classList.remove('is-dragover');
    });
    window.addEventListener('drop', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth = 0;
      document.body.classList.remove('is-dragover');
      const file = ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (file) loadFile(file);
    });
  }

  function initKeys() {
    window.addEventListener('keydown', (ev) => {
      const tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      switch (ev.key) {
        case ' ':
          ev.preventDefault();
          togglePlay();
          break;
        case 'o': case 'O':
          $('fileInput').click();
          break;
        case 'l': case 'L':
          startLive();
          break;
        case 'r': case 'R':
          resetMeasurement();
          break;
        case 'e': case 'E':
          exportReport();
          break;
        case 'f': case 'F':
          openFix();
          break;
        case 'm': case 'M':
          openMeta();
          break;
        case '?':
          toggleHelp();
          break;
        case 'Escape':
          $('helpModal').hidden = true;
          $('fixModal').hidden = true;
          $('metaModal').hidden = true;
          state.selection = null;
          updateSelectionChip();
          break;
        default:
          break;
      }
    });
  }

  function toggleHelp() {
    const m = $('helpModal');
    m.hidden = !m.hidden;
  }

  async function resetMeasurement() {
    if (state.source.kind === 'live') { stopLive(); return; }
    if (!state.source.buffer) return;
    stopPlayback();
    state.play.offset = 0;
    state.selection = null;
    updateSelectionChip();
    const channels = [];
    for (let i = 0; i < state.source.buffer.numberOfChannels; i++) channels.push(state.source.buffer.getChannelData(i));
    await measureChannels(channels, state.source.buffer.sampleRate, state.source.name);
  }

  function initButtons() {
    $('btnOpen').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (f) loadFile(f);
      ev.target.value = '';
    });
    $('btnLive').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const menu = $('liveMenu');
      menu.hidden = !menu.hidden;
      $('liveStop').hidden = !state.live.ctx;
    });
    $('liveMenu').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-src]');
      if (!btn) return;
      $('liveMenu').hidden = true;
      const src = btn.dataset.src;
      if (src === 'mic') startLive();
      else if (src === 'system') startSystemAudio();
      else if (src === 'stop') stopLive();
    });
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('.live-wrap')) $('liveMenu').hidden = true;
    });
    $('btnDemo').addEventListener('click', loadDemo);
    $('btnFix').addEventListener('click', openFix);
    $('btnCloseFix').addEventListener('click', () => { $('fixModal').hidden = true; });
    $('fixModal').addEventListener('click', (ev) => {
      if (ev.target === $('fixModal')) $('fixModal').hidden = true;
    });
    $('fixCeil').addEventListener('input', updateFixPlan);
    $('fixBits').addEventListener('change', updateFixBitsLabel);
    $('btnDoFix').addEventListener('click', doFix);
    $('btnSaveFix').addEventListener('click', saveFix);
    $('btnMeta').addEventListener('click', openMeta);
    $('btnCloseMeta').addEventListener('click', () => { $('metaModal').hidden = true; });
    $('metaModal').addEventListener('click', (ev) => {
      if (ev.target === $('metaModal')) $('metaModal').hidden = true;
    });
    $('metaSave').addEventListener('click', () => saveMeta(false));
    $('metaStrip').addEventListener('click', () => saveMeta(true));
    $('btnReset').addEventListener('click', resetMeasurement);
    $('btnExport').addEventListener('click', exportReport);
    $('btnHelp').addEventListener('click', toggleHelp);
    $('btnCloseHelp').addEventListener('click', toggleHelp);
    $('helpModal').addEventListener('click', (ev) => {
      if (ev.target === $('helpModal')) toggleHelp();
    });
    $('btnPlay').addEventListener('click', togglePlay);
    $('unitToggle').addEventListener('click', () => {
      state.units = state.units === 'LUFS' ? 'LKFS' : 'LUFS';
      $('unitToggle').textContent = state.units;
      updateReadouts();
    });

    document.querySelectorAll('.win-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.winSeconds = Number(btn.dataset.win) || 0;
        document.querySelectorAll('.win-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * main loop
   * ------------------------------------------------------------------ */

  let lastFrame = 0;
  function tick(ts) {
    requestAnimationFrame(tick);
    if (ts - lastFrame < 28) return;
    lastFrame = ts;

    if (state.needsHist) {
      state.histCache = buildHistogram();
      state.needsHist = false;
    }
    updateReadouts();
    drawRuler();
    drawHist();
    drawGraph();
  }

  function boot() {
    unitNodes = Array.prototype.slice.call(document.querySelectorAll('.cell .u'));
    initTargets();
    initButtons();
    initGraphInteraction();
    initDropZone();
    initKeys();
    applySourceHeader();
    updatePlayButton();
    updateReadouts();
    requestAnimationFrame(tick);

    // expose a tiny API for debugging / console use
    window.loudnessMeter = {
      state,
      measure: (channels, sampleRate) => measureChannels(channels, sampleRate, 'buffer'),
      loadFile
    };

    // #demo opens a ready-made reference programme (handy for screenshots)
    if (location.hash === '#demo' || /[?&]demo\b/.test(location.search)) {
      setTimeout(loadDemo, 120);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();



