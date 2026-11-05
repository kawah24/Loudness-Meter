const fs = require('fs');
const html = fs.readFileSync('LoudnessMeter.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
scripts.forEach((s, i) => {
  try { new Function(s); console.log('script', i, 'OK', (s.length / 1024).toFixed(1) + 'KB'); }
  catch (e) { console.log('script', i, 'SYNTAX ERROR:', e.message); }
});
console.log('metaModal:', html.includes('id="metaModal"'), '| Metadata api:', html.includes('root.Metadata'), '| btnMeta:', html.includes('id="btnMeta"'));
console.log('size', (html.length / 1024).toFixed(1) + 'KB');
