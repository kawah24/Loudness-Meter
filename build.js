/** Bundles src/* into the single portable LoudnessMeter.html */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const template = read('src/template.html');
const css = read('src/styles.css');
const core = read('src/loudness-core.js');
const meta = read('src/metadata.js');
const app = read('src/app.js');

const out = template
  .replace('/*__CSS__*/', () => css)
  .replace('/*__CORE__*/', () => core + '\n' + meta)
  .replace('/*__APP__*/', () => app);

if (out.includes('/*__CSS__*/') || out.includes('/*__CORE__*/') || out.includes('/*__APP__*/')) {
  throw new Error('placeholder left unreplaced');
}
if (out.includes('</script>') && (core.includes('</script>') || app.includes('</script>'))) {
  throw new Error('script terminator inside source');
}

const target = path.join(root, 'LoudnessMeter.html');
fs.writeFileSync(target, out, 'utf8');
console.log('built', target, (out.length / 1024).toFixed(1) + ' KB');
