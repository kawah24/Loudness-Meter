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
    $('fixTargetLabel').textContent = 'target ' + fmt(t.il) + ' LUFS · ' + fmt(t.tp) + ' dBTP';
    $('fixCeil').value = t.tp.toFixed(1);

    const v = state.values;
    fixCell('fixNowI', fmt(v.integrated) + ' LUFS');
    fixCell('fixNowTP', fmt(v.truePeak) + ' dBTP', v.truePeak > t.tp);
    fixCell('fixNowLRA', fmt(v.lra) + ' LU');
    fixCell('fixNowPLR', fmt(v.plr) + ' LU');
    fixCell('fixAfterI', '—');
    fixCell('fixAfterTP', '—');
    fixCell('fixAfterLRA', '—');
    fixCell('fixAfterPLR', '—');
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
    const typed = parseFloat($('fixCeil').value);
    const ceiling = isFinite(typed) ? typed : t.tp;
    const gain = t.il - v.integrated;
    const projected = v.truePeak + gain;
    const limiter = Math.max(0, projected - ceiling);

    const bits = [fmtSigned(gain) + ' dB gain'];
    if (limiter > 0.05) bits.push('limiter ' + limiter.toFixed(1) + ' dB on the loudest peaks');
    let text = 'Plan: ' + bits.join('  ·  ') + '.  Predicted ≈ ' + fmt(t.il) + ' LUFS / ' +
      fmt(Math.min(projected, ceiling)) + ' dBTP.';
    const warn = limiter > 3;
    if (warn) text += '  That is a lot of limiting — transients will flatten.';

    const el = $('fixPlan');
    el.textContent = text;
    el.classList.toggle('is-warn', warn);
  }

  async function doFix() {
    const t = state.target;
    const ceiling = parseFloat($('fixCeil').value);
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
        ? ' · limiter pulled ' + fix.reductionDb.toFixed(1) + ' dB'
        : ' · no limiting needed';
      $('fixPlan').textContent = 'Done: ' + fmtSigned(fix.gainDb) + ' dB applied' + reduced +
        '.  Measured ' + fmt(a.integrated) + ' LUFS / ' + fmt(a.truePeak) + ' dBTP.';
      $('fixPlan').classList.remove('is-warn');
      setStatus('Fixed  ·  ' + fmt(a.integrated) + ' LUFS  ·  ' + fmt(a.truePeak) + ' dBTP');
    } catch (err) {
      console.error(err);
      toast('Could not process this file: ' + (err && err.message ? err.message : err), true);
    } finally {
      $('fixBar').hidden = true;
      $('btnDoFix').disabled = false;
      $('btnDoFix').textContent = 'Fix & measure';
    }
  }

  function wavBlob(channels, sampleRate) {
    const nch = channels.length;
    const n = channels[0].length;
    const dataSize = n * nch * 3;
    const parts = [Core.wavHeader24(dataSize, nch, sampleRate)];
    const frames = Math.max(1, Math.round(sampleRate * 4));

    for (let start = 0; start < n; start += frames) {
      const len = Math.min(frames, n - start);
      const buf = new ArrayBuffer(len * nch * 3);
      const view = new DataView(buf);
      let o = 0;
      for (let i = 0; i < len; i++) {
        for (let c = 0; c < nch; c++) {
          let s = channels[c][start + i];
          s = s > 1 ? 1 : s < -1 ? -1 : s;
          const x = Math.round(s * 8388607);
          view.setUint8(o, x & 0xff);
          view.setUint8(o + 1, (x >> 8) & 0xff);
          view.setUint8(o + 2, (x >> 16) & 0xff);
          o += 3;
        }
      }
      parts.push(buf);
    }
    return new Blob(parts, { type: 'audio/wav' });
  }

  function saveFix() {
    const f = state.fix;
    if (!f) return;
    const blob = wavBlob(f.channels, f.sampleRate);
    const base = (state.source.name || 'master')
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w\-. ]+/g, '_')
      .slice(0, 60);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = base + ' — ' + fmt(state.target.il) + ' LUFS.wav';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    toast('WAV exported  ·  24-bit  ·  ' + (f.sampleRate / 1000).toFixed(1).replace('.0', '') + ' kHz');
  }
