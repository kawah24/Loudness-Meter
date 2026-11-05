const fs = require('fs');
let s = fs.readFileSync('src/app.js', 'utf8');
let n = 0;

const anchor = `    $('btnHelp').addEventListener('click', toggleHelp);`;
const add = `    $('btnAbout').addEventListener('click', () => { $('aboutModal').hidden = false; });
    $('btnCloseAbout').addEventListener('click', () => { $('aboutModal').hidden = true; });
    $('aboutModal').addEventListener('click', (ev) => {
      if (ev.target === $('aboutModal')) $('aboutModal').hidden = true;
    });
` + anchor;
if (s.includes(anchor) && !s.includes("$('btnAbout')")) { s = s.replace(anchor, add); n++; }

const esc = `          $('metaModal').hidden = true;`;
if (s.includes(esc) && !s.includes("$('aboutModal').hidden = true;")) {
  s = s.replace(esc, esc + "\n          $('aboutModal').hidden = true;");
  n++;
}
fs.writeFileSync('src/app.js', s);
console.log('js patches:', n);
