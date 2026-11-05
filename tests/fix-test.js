/**
 * Verifies normalizeToTarget: it must land on the loudness target, stay under
 * the true-peak ceiling, never clip, and survive a 24-bit WAV round trip.
 */
const path = require('path');
const fs = require('fs');
const core = require('../src/loudness-core.js');
const { readWav, readWavBuffer } = require('./wav');

const DIR = path.join(__dirname, 'signals');

function peakOf(channels) {
  let p = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) {
    const a = Math.abs(c[i]);
    if (a > p) p = a;
  }
  return p;
}

function run(file, targetIL, ceiling) {
  const wav = readWav(path.join(DIR, file));
  const chans = wav.channels.map((c) => new Float32Array(c));
  const before = core.analyze(chans, wav.rate).values();
  const t0 = Date.now();
  const fix = core.normalizeToTarget(chans, wav.rate, { targetIL, ceiling, before });
  const ms = Date.now() - t0;
  if (!fix) { console.log(file, 'FAILED (no measurement)'); return; }

  const after = fix.after;
  const pk = peakOf(fix.channels);
  const achieved = after.integrated;
  const okIL = Math.abs(achieved - targetIL) <= 0.25;
  const okTP = after.truePeak <= ceiling + 0.05;
  const okClip = pk <= 1.0;

  // round trip through the 24-bit encoder
  const buf = core.encodeWav24(fix.channels, wav.rate);
  const back = readWavBuffer(buf);
  const rt = core.analyze(back.channels, back.rate).values();

  console.log(
    file.padEnd(20),
    'I ' + before.integrated.toFixed(1).padStart(6) + ' -> ' + achieved.toFixed(2).padStart(6),
    ' TP ' + before.truePeak.toFixed(1).padStart(5) + ' -> ' + after.truePeak.toFixed(2).padStart(5),
    ' gain ' + fix.gainDb.toFixed(1).padStart(5) + ' dB',
    ' lim ' + fix.reductionDb.toFixed(1) + ' dB',
    ' LRA ' + before.lra.toFixed(1) + ' -> ' + after.lra.toFixed(1),
    ' RT ' + rt.integrated.toFixed(2),
    (okIL && okTP && okClip ? '  OK' : '  FAIL ' + JSON.stringify({ okIL, okTP, okClip })),
    ' ' + ms + 'ms'
  );
  return { before, after, rt, ms, okIL, okTP, okClip };
}

console.log('fix a programme to -14 LUFS / -1.0 dBTP (Spotify / YouTube)\n');
run('program.wav', -14, -1.0);
run('lra_step_10lu.wav', -14, -1.0);
run('transients.wav', -14, -1.0);
run('sine_1k_m20.wav', -14, -1.0);
console.log('\nfix to -23 LUFS / -1.0 dBTP (EBU R128)\n');
run('program.wav', -23, -1.0);
console.log('\nfix to -16 LUFS / -1.0 dBTP (Apple / podcast)\n');
run('real_track.wav', -16, -1.0);
