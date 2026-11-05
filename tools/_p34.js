const fs = require('fs');
let n = 0;

// ---------- template: About button + modal ----------
let t = fs.readFileSync('src/template.html', 'utf8');
const btnAnchor = `      <button class="btn btn-icon" id="btnHelp" title="Reference &amp; shortcuts (?)" aria-label="Help">?</button>`;
const btnAdd = `      <button class="btn btn-icon" id="btnAbout" title="About" aria-label="About">i</button>
` + btnAnchor;
if (t.includes(btnAnchor) && !t.includes('id="btnAbout"')) { t = t.replace(btnAnchor, btnAdd); n++; }

const modal = `<div class="modal" id="aboutModal" hidden>
  <div class="modal-card about-card">
    <header>
      <h2>ABOUT</h2>
      <button class="btn btn-icon" id="btnCloseAbout" aria-label="Close">&times;</button>
    </header>
    <div class="modal-body about-body">
      <svg class="about-mark" viewBox="0 0 32 32" aria-hidden="true">
        <rect x="3"  y="12" width="3" height="8"  rx="1.5" opacity=".45"/>
        <rect x="9"  y="7"  width="3" height="18" rx="1.5" opacity=".7"/>
        <rect x="15" y="2"  width="3" height="28" rx="1.5"/>
        <rect x="21" y="9"  width="3" height="14" rx="1.5" opacity=".7"/>
        <rect x="27" y="13" width="3" height="6"  rx="1.5" opacity=".45"/>
      </svg>
      <h3>Loudness Meter</h3>
      <p class="about-sub">version 1.1.0 &middot; MIT licence</p>
      <p class="about-by">made by <a href="https://github.com/kawah24" target="_blank" rel="noopener">kawah24</a></p>

      <div class="about-links">
        <a href="https://github.com/kawah24/Loudness-Meter" target="_blank" rel="noopener">
          <span>Source, issues and the changelog</span>
          github.com/kawah24/Loudness-Meter
        </a>
        <a href="https://kawah24.github.io/Loudness-Meter/" target="_blank" rel="noopener">
          <span>Hosted copy — open it on any machine</span>
          kawah24.github.io/Loudness-Meter
        </a>
      </div>

      <p class="about-note">ITU-R BS.1770-4 and EBU R128 measurement, verified to 0.05 LU against
      libebur128 and 0.11 dB of true peak against exact interpolation. Everything runs in your
      browser: no account, no telemetry, no audio leaves this machine.</p>
    </div>
  </div>
</div>

<div class="modal" id="helpModal" hidden>`;
if (t.includes('<div class="modal" id="helpModal" hidden>') && !t.includes('id="aboutModal"')) {
  t = t.replace('<div class="modal" id="helpModal" hidden>', modal); n++;
}
fs.writeFileSync('src/template.html', t);

// ---------- css ----------
let c = fs.readFileSync('src/styles.css', 'utf8');
if (!c.includes('.about-card')) {
  c = c.replace('/* ---------------- themes ---------------- */', `/* ---------------- about ---------------- */

.about-card { width: min(470px, 100%); }

.about-body { text-align: center; padding-top: 18px; }

.about-mark {
  width: 42px; height: 42px;
  fill: var(--i);
  filter: drop-shadow(0 0 14px color-mix(in srgb, var(--i) 35%, transparent));
  margin-bottom: 8px;
}

.about-body h3 {
  margin: 0;
  font-size: 15px;
  letter-spacing: .04em;
  font-weight: 600;
  color: var(--txt);
}

.about-sub {
  margin: 4px 0 2px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: .06em;
  color: var(--faint);
}

.about-by { margin: 0 0 16px; font-size: 11.5px; color: var(--dim); }
.about-by a { color: var(--i); text-decoration: none; }
.about-by a:hover { text-decoration: underline; }

.about-links { display: grid; gap: 8px; margin-bottom: 16px; }

.about-links a {
  display: block;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: #0c1016;
  color: var(--i);
  text-decoration: none;
  font-family: var(--mono);
  font-size: 10.5px;
  text-align: left;
  line-height: 1.5;
}
.about-links a span {
  display: block;
  font-family: var(--sans);
  font-size: 11px;
  color: var(--dim);
  margin-bottom: 1px;
}
.about-links a:hover { border-color: color-mix(in srgb, var(--i) 50%, transparent); background: color-mix(in srgb, var(--i) 6%, #0c1016); }

.about-note {
  margin: 0;
  font-size: 10px;
  line-height: 1.55;
  color: var(--faint);
}

/* ---------------- themes ---------------- */`);
  fs.writeFileSync('src/styles.css', c);
  n++;
}
console.log('template + css patches:', n);
