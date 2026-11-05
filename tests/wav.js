/** Minimal WAV reader (16/24/32-bit PCM and float32) for the Node tests. */
const fs = require('fs');

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
  const bytes = fmt.bits / 8;
  const ch = fmt.channels;
  const frames = Math.floor(data.length / bytes / ch);
  const out = [];
  for (let c = 0; c < ch; c++) out.push(new Float32Array(frames));

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const o = (i * ch + c) * bytes;
      let v;
      if (bytes === 2) v = data.readInt16LE(o) / 32768;
      else if (bytes === 3) {
        const b = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16);
        v = ((b << 8) >> 8) / 8388608;
      } else if (fmt.format === 3) v = data.readFloatLE(o);
      else v = data.readInt32LE(o) / 2147483648;
      out[c][i] = v;
    }
  }
  return { channels: out, rate: fmt.rate, bits: fmt.bits };
}

/** Reads a WAV straight out of an ArrayBuffer (as produced by encodeWav24). */
function readWavBuffer(arrayBuffer) {
  const tmp = require('os').tmpdir() + '/lm-wav-' + process.pid + '.wav';
  fs.writeFileSync(tmp, Buffer.from(arrayBuffer));
  const r = readWav(tmp);
  fs.unlinkSync(tmp);
  return r;
}

module.exports = { readWav, readWavBuffer };
