/**
 * Metadata engine checks: read tags, rewrite them, strip them, and prove the
 * audio payload is bit-identical by comparing decoded PCM hashes.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const md = require('../src/metadata.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-'));
const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const p = (n) => path.join(tmp, n);

function probeTags(file) {
  const out = execFileSync('ffprobe',
    ['-v', 'quiet', '-show_entries', 'format_tags', '-of', 'json', file],
    { encoding: 'utf8' });
  const raw = (JSON.parse(out).format && JSON.parse(out).format.tags) || {};
  const lower = {};
  for (const k of Object.keys(raw)) lower[k.toLowerCase()] = raw[k];
  return lower;
}

function pcmHash(file) {
  const raw = p('dec.raw');
  ff(['-i', file, '-f', 's16le', '-ac', '2', '-ar', '48000', raw]);
  const h = crypto.createHash('md5').update(fs.readFileSync(raw)).digest('hex');
  fs.unlinkSync(raw);
  return h;
}

function bytesOf(file) {
  const b = fs.readFileSync(file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function save(file, arrayBuffer) {
  fs.writeFileSync(file, Buffer.from(arrayBuffer));
  return file;
}

// source: 6 s of tone + noise so lossy codecs behave like real audio
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=pink:a=0.05',
  '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=shortest', '-ac', '2', '-ar', '48000', p('src.wav')]);

const cases = [
  { fmt: 'wav', args: ['-c:a', 'pcm_s16le'], file: 'tagged.wav' },
  { fmt: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '3'], file: 'tagged.mp3' },
  { fmt: 'flac', args: ['-c:a', 'flac'], file: 'tagged.flac' }
];

let fails = 0;
for (const c of cases) {
  const file = p(c.file);
  ff(['-i', p('src.wav'), ...c.args,
    '-metadata', 'title=Original Title',
    '-metadata', 'artist=Some Artist',
    '-metadata', 'album=An Album',
    '-metadata', 'date=2026',
    '-metadata', 'genre=Folk',
    '-metadata', 'comment=private note',
    file]);

  const original = bytesOf(file);
  const info = md.read(original);
  const beforeHash = pcmHash(file);

  console.log('\n=== ' + c.fmt.toUpperCase() + ' ===');
  console.log('detected:', info.format, '| fields:', JSON.stringify(info.fields));
  console.log('found   :', info.found.map((f) => f.key + '=' + f.value).join('  '));

  // 1. edit
  const edited = md.write(original, {
    fields: { title: 'New Title', artist: 'New Artist', album: 'New Album', date: '2027', genre: 'Rock', comment: '' },
    stripAll: false
  });
  const editedFile = save(p('edited.' + c.fmt), edited.bytes);
  const tags = probeTags(editedFile);
  const afterHash = pcmHash(editedFile);
  const tagOk = (tags.title || '') === 'New Title' && (tags.artist || '') === 'New Artist' &&
    (tags.album || '') === 'New Album' && (tags.comment || '') === '';
  const audioOk = beforeHash === afterHash;
  console.log('audit   :', tagOk ? 'tags written' : 'TAGS WRONG ' + JSON.stringify(tags),
    '| audio identical:', audioOk);
  if (!tagOk || !audioOk) fails++;

  // 2. strip everything
  const stripped = md.write(original, { stripAll: true, fields: {} });
  const stripFile = save(p('stripped.' + c.fmt), stripped.bytes);
  const stripTags = probeTags(stripFile);
  const names = Object.keys(stripTags);
  const stripHash = pcmHash(stripFile);
  const stripOk = names.length === 0 && stripHash === beforeHash;
  console.log('strip   :', stripOk ? 'all tags gone, audio identical' : 'LEFT ' + names.join(',') + ' audio=' + (stripHash === beforeHash));
  if (!stripOk) fails++;

  console.log('removed :', stripped.removedList.join(', ') || '(none)', '|', edited.removedList.join(', '));
}

console.log('\n' + (fails ? fails + ' FAILURES' : 'all checks passed'));
fs.rmSync(tmp, { recursive: true, force: true });
