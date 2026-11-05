/**
 * Cross-checks loudness-core.js against ffmpeg's libebur128 (ebur128 filter).
 * Run: node verify.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../src/loudness-core.js');

const DIR = path.join(__dirname, 'signals');

function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a wav: ' + file);
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14)
      };
      if (fmt.format === 0xfffe) fmt.format = buf.readUInt16LE(body + 24);
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    pos = body + size + (size & 1);
  }
  const ch = fmt.channels;
  const frames = Math.floor(data.length / (fmt.bits / 8) / ch);
  const out = [];
  for (let c = 0; c < ch; c++) out.push(new Float32Array(frames));
  const bytes = fmt.bits / 8;
  const scale = bytes === 2 ? 1 / 32768 : bytes === 3 ? 1 / 8388608 : bytes === 4 ? 1 : 1;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const o = (i * ch + c) * bytes;
      let v;
      if (bytes === 2) v = data.readInt16LE(o) * scale;
      else if (bytes === 3) {
        const b = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16);
        v = ((b << 8) >> 8) * scale;
      } else if (fmt.format === 3) v = data.readFloatLE(o);
      else v = data.readInt32LE(o) * scale;
      out[c][i] = v;
    }
  }
  return { channels: out, rate: fmt.rate };
}

function ffmpegMeasure(file) {
  const out = execFileSync('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file,
    '-af', 'ebur128=peak=true', '-f', 'null', '-'
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
  // ffmpeg writes the summary to stderr, execFileSync returns only stdout by default
  return out;
}

function ffmpegMeasure2(file) {
  const { spawnSync } = require('child_process');
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file,
    '-af', 'ebur128=peak=true', '-f', 'null', '-'
  ], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  const err = r.stderr || '';
  const idx = err.lastIndexOf('Summary:');
  const tail = idx >= 0 ? err.slice(idx) : err;
  const pick = (re) => { const m = tail.match(re); return m ? parseFloat(m[1]) : NaN; };
  return {
    I: pick(/I:\s+(-?[\d.]+)\s+LUFS/),
    LRA: pick(/LRA:\s+(-?[\d.]+)\s+LU/),
    TP: pick(/Peak:\s+(-?[\d.]+)\s+dBFS/),
    raw: tail
  };
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.wav')).sort();

let exact = {};
try { exact = JSON.parse(fs.readFileSync(path.join(__dirname, 'exact_tp.json'), 'utf8')); } catch (e) {}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('file', 24) + pad('I(ours)', 10) + pad('I(ffmpeg)', 11) +
  pad('LRA ours', 10) + pad('LRA ff', 9) + pad('TP ours', 9) + pad('TP ff', 8) + 'status');

let worst = { I: 0, LRA: 0, TP: 0 };
for (const f of files) {
  const file = path.join(DIR, f);
  const wav = readWav(file);
  const meter = core.analyze(wav.channels, wav.rate);
  const v = meter.values();
  const ref = ffmpegMeasure2(file);
  const dI = Math.abs(v.integrated - ref.I);
  const dL = isFinite(ref.LRA) ? Math.abs(v.lra - ref.LRA) : 0;
  const dT = Math.abs(v.truePeak - ref.TP);
  worst.I = Math.max(worst.I, dI);
  worst.LRA = Math.max(worst.LRA, dL);
  worst.TP = Math.max(worst.TP, dT);
  const ok = dI <= 0.11 && dL <= 0.31 && dT <= 0.21;
  console.log(
    pad(f, 24) +
    pad(v.integrated.toFixed(2), 10) + pad(ref.I.toFixed(2), 11) +
    pad(v.lra.toFixed(2), 10) + pad(ref.LRA.toFixed(2), 9) +
    pad(v.truePeak.toFixed(2), 9) + pad(ref.TP.toFixed(2), 8) +
    (ok ? 'OK' : `MISMATCH  dI=${dI.toFixed(2)} dLRA=${dL.toFixed(2)} dTP=${dT.toFixed(2)}`)
  );
}
console.log('\nworst deltas vs ffmpeg/libebur128: I ' + worst.I.toFixed(2) +
  ' LU, LRA ' + worst.LRA.toFixed(2) + ' LU, TP ' + worst.TP.toFixed(2) + ' dB');

if (Object.keys(exact).length) {
  console.log('\nTrue peak against exact 8x band-limited interpolation:');
  let worstExact = 0;
  for (const f of files) {
    if (!(f in exact)) continue;
    const wav = readWav(path.join(DIR, f));
    const v = core.analyze(wav.channels, wav.rate).values();
    const d = v.truePeak - exact[f];
    worstExact = Math.max(worstExact, Math.abs(d));
    console.log('  ' + pad(f, 24) + 'ours ' + pad(v.truePeak.toFixed(2), 8) +
      'exact ' + pad(exact[f].toFixed(2), 8) + 'delta ' + d.toFixed(2) + ' dB');
  }
  console.log('  worst |delta| ' + worstExact.toFixed(2) + ' dB');
}

// 48 kHz coefficient sanity check against the values printed in BS.1770-4
const k = core.kWeightingCoefficients(48000);
console.log('\n48k shelf b0..a2:', [k.shelf.b0, k.shelf.b1, k.shelf.b2, k.shelf.a1, k.shelf.a2].map(x => x.toFixed(9)).join(' '));
console.log('48k hp    a1..a2:', [k.hp.a1, k.hp.a2].map(x => x.toFixed(9)).join(' '));
