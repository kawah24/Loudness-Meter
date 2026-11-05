const fs = require('fs');
let s = fs.readFileSync('src/app.js', 'utf8');
const anchor = `          $('helpModal').hidden = true;
          $('fixModal').hidden = true;
          $('metaModal').hidden = true;`;
if (s.includes(anchor) && !s.includes("$('aboutModal').hidden = true;\n          state.selection")) {
  s = s.replace(anchor, anchor + "\n          $('aboutModal').hidden = true;");
  fs.writeFileSync('src/app.js', s);
  console.log('esc patched');
} else console.log('anchor missing or already patched');
