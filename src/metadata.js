/*!
 * metadata.js — read, rewrite and strip container metadata without re-encoding.
 *
 * WAV  : RIFF chunks (LIST/INFO, bext, iXML, XMP, id3 )
 * MP3  : ID3v2.3/2.4, ID3v1, APE tags
 * FLAC : Vorbis comments and picture blocks
 *
 * The audio payload is copied byte for byte; only metadata is rebuilt.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Metadata = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const te = new TextEncoder();
  const tdUtf8 = new TextDecoder('utf-8');
  const tdLatin1 = new TextDecoder('latin1');

  const FIELDS = ['title', 'artist', 'album', 'albumartist', 'date', 'genre',
    'track', 'comment', 'copyright', 'isrc'];

  function readStr(dv, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
    return s;
  }

  function bytesToStr(bytes, off, len, enc) {
    const view = new Uint8Array(bytes, off, len);
    return (enc === 'latin1' ? tdLatin1 : tdUtf8).decode(view);
  }

  function syncsafe(dv, off) {
    return ((dv.getUint8(off) & 0x7f) << 21) | ((dv.getUint8(off + 1) & 0x7f) << 14) |
      ((dv.getUint8(off + 2) & 0x7f) << 7) | (dv.getUint8(off + 3) & 0x7f);
  }

  function toSyncsafe(n) {
    return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
  }

  /* ------------------------------------------------------------------ *
   * WAV
   * ------------------------------------------------------------------ */

  const WAV_INFO = {
    title: 'INAM', artist: 'IART', album: 'IPRD', date: 'ICRD', genre: 'IGNR',
    comment: 'ICMT', copyright: 'ICOP', track: 'ITRK', encoder: 'ISFT', software: 'ISFT'
  };

  const WAV_META_CHUNKS = ['LIST', 'bext', 'iXML', 'XMP ', 'id3 ', 'ID3 ', 'axml', 'ID3v2'];

  function isWav(bytes) {
    const dv = new DataView(bytes);
    return bytes.byteLength > 12 && readStr(dv, 0, 4) === 'RIFF' && readStr(dv, 8, 4) === 'WAVE';
  }

  function wavChunks(bytes) {
    const dv = new DataView(bytes);
    const out = [];
    let off = 12;
    while (off + 8 <= bytes.byteLength) {
      const id = readStr(dv, off, 4);
      const size = dv.getUint32(off + 4, true);
      const body = off + 8;
      if (body + size > bytes.byteLength) break;
      out.push({ id, size, offset: body, end: body + size, head: off });
      off = body + size + (size & 1);
    }
    return out;
  }

  function readWav(bytes) {
    const dv = new DataView(bytes);
    const chunks = wavChunks(bytes);
    const fields = {};
    const found = [];
    let art = false;

    for (const c of chunks) {
      if (c.id === 'LIST' && c.size >= 4) {
        const type = readStr(dv, c.offset, 4);
        if (type !== 'INFO') {
          found.push({ key: 'LIST / ' + type.trim(), value: c.size + ' bytes', where: 'chunk' });
          continue;
        }
        let p = c.offset + 4;
        while (p + 8 <= c.end) {
          const id = readStr(dv, p, 4);
          const sz = dv.getUint32(p + 4, true);
          if (p + 8 + sz > c.end) break;
          const val = bytesToStr(bytes, p + 8, sz, 'latin1').replace(/\0+$/g, '').trim();
          const key = Object.keys(WAV_INFO).find((k) => WAV_INFO[k] === id);
          if (key && val) fields[key] = val;
          found.push({ key: id, value: val, where: 'LIST/INFO' });
          art = art || id === 'IPIC' || id === 'ICON';
          p += 8 + sz + (sz & 1);
        }
      } else if (c.id === 'bext') {
        const originator = bytesToStr(bytes, c.offset + 256, 32, 'latin1').replace(/\0+$/g, '').trim();
        const reference = bytesToStr(bytes, c.offset + 288, 32, 'latin1').replace(/\0+$/g, '').trim();
        const d = bytesToStr(bytes, c.offset + 320, 10, 'latin1').replace(/\0+$/g, '').trim();
        const t = bytesToStr(bytes, c.offset + 330, 8, 'latin1').replace(/\0+$/g, '').trim();
        const desc = bytesToStr(bytes, c.offset, 256, 'latin1').replace(/\0+$/g, '').trim();
        if (desc) found.push({ key: 'bext description', value: desc, where: 'BWF' });
        if (originator) found.push({ key: 'bext originator', value: originator, where: 'BWF' });
        if (reference) found.push({ key: 'bext reference', value: reference, where: 'BWF' });
        if (d || t) found.push({ key: 'bext date', value: (d + ' ' + t).trim(), where: 'BWF' });
      } else if (c.id === 'iXML') {
        found.push({ key: 'iXML', value: 'present (' + c.size + ' bytes)', where: 'chunk' });
      } else if (c.id === 'XMP ') {
        found.push({ key: 'XMP', value: 'present (' + c.size + ' bytes)', where: 'chunk' });
      } else if (c.id.trim() === 'id3' || c.id.trim() === 'ID3') {
        found.push({ key: 'ID3 chunk', value: c.size + ' bytes', where: 'chunk' });
      } else if (c.id === 'fmt ') {
        found.push({ key: 'fmt', value: 'audio format header', where: 'required' });
      } else if (c.id === 'data') {
        found.push({ key: 'data', value: c.size + ' bytes of audio', where: 'required' });
      } else {
        found.push({ key: c.id.trim(), value: c.size + ' bytes', where: 'chunk' });
      }
    }

    return { format: 'wav', label: 'WAV', fields, found, art,
      editable: ['title', 'artist', 'album', 'date', 'genre', 'track', 'comment', 'copyright'] };
  }

  function infoChunk(fields) {
    const parts = [];
    for (const key of Object.keys(WAV_INFO)) {
      const id = WAV_INFO[key];
      const val = fields[key];
      if (val === undefined || val === null || val === '') continue;
      if (parts.some((p) => p.id === id)) continue;
      const body = te.encode(String(val) + '\0');
      const head = new Uint8Array(8);
      head.set(te.encode(id), 0);
      new DataView(head.buffer).setUint32(4, body.length, true);
      parts.push({ id, head, body });
    }
    if (!parts.length) return null;

    let inner = 4; // 'INFO'
    for (const p of parts) inner += 8 + p.body.length + (p.body.length & 1);

    const out = new Uint8Array(8 + inner);
    out.set(te.encode('LIST'), 0);
    new DataView(out.buffer).setUint32(4, inner, true);
    out.set(te.encode('INFO'), 8);
    let o = 12;
    for (const p of parts) {
      out.set(p.head, o);
      out.set(p.body, o + 8);
      o += 8 + p.body.length;
      if (p.body.length & 1) out[o++] = 0;
    }
    return out;
  }

  function writeWav(bytes, fields, stripAll) {
    const chunks = wavChunks(bytes);
    const keep = [];
    let removed = 0;
    let inserted = false;
    const info = stripAll ? null : infoChunk(fields);
    const removedList = [];

    for (const c of chunks) {
      // editing replaces only the tag chunks; bext/iXML/XMP survive unless stripping
      const isMeta = stripAll
        ? WAV_META_CHUNKS.includes(c.id)
        : (c.id === 'LIST' || c.id.trim() === 'id3' || c.id.trim() === 'ID3');
      if (isMeta) {
        removedList.push(c.id.trim());
        removed += c.size + 8 + (c.size & 1);
        continue;
      }
      if (!inserted && info && c.id === 'data') {
        keep.push({ raw: info });
        inserted = true;
      }
      keep.push({ raw: new Uint8Array(bytes, c.head, c.size + 8 + (c.size & 1)) });
    }
    if (!inserted && info) keep.push({ raw: info });

    let total = 12;
    for (const k of keep) total += k.raw.length;

    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    out.set(te.encode('RIFF'), 0);
    dv.setUint32(4, total - 8, true);
    out.set(te.encode('WAVE'), 8);
    let o = 12;
    for (const k of keep) { out.set(k.raw, o); o += k.raw.length; }
    return { bytes: out.buffer, removedBytes: removed, removedList };
  }

  /* ------------------------------------------------------------------ *
   * MP3
   * ------------------------------------------------------------------ */

  const ID3_MAP = {
    TIT2: 'title', TPE1: 'artist', TALB: 'album', TPE2: 'albumartist',
    TDRC: 'date', TYER: 'date', TCON: 'genre', TRCK: 'track',
    TCOP: 'copyright', TSRC: 'isrc', TSSE: 'encoder', TENC: 'encoder'
  };

  const ID3_WRITE = {
    title: 'TIT2', artist: 'TPE1', album: 'TALB', albumartist: 'TPE2',
    date: 'TYER', genre: 'TCON', track: 'TRCK', copyright: 'TCOP', isrc: 'TSRC'
  };

  function decodeId3Text(payload) {
    if (!payload.length) return '';
    const enc = payload[0];
    let body = payload.subarray(1);
    if (enc === 0) return tdLatin1.decode(body).replace(/\0+$/g, '');
    if (enc === 3) return tdUtf8.decode(body).replace(/\0+$/g, '');
    if (enc === 2) return new TextDecoder('utf-16be').decode(body).replace(/\0+$/g, '');
    // UTF-16 with BOM
    return new TextDecoder('utf-16le').decode(body).replace(/\0+$/g, '').replace(/^\ufeff/, '');
  }

  function readMp3(bytes) {
    const dv = new DataView(bytes);
    const found = [];
    const fields = {};
    let tag = null;
    let art = false;

    if (bytes.byteLength > 10 && readStr(dv, 0, 3) === 'ID3') {
      const ver = dv.getUint8(3);
      const size = syncsafe(dv, 6);
      const total = 10 + size + (dv.getUint8(5) & 0x10 ? 10 : 0);
      tag = { version: ver, size, total };
      found.push({ key: 'ID3v2.' + ver, value: size + ' bytes', where: 'tag' });

      let p = 10;
      const end = Math.min(10 + size, bytes.byteLength);
      while (p + 10 <= end) {
        const id = readStr(dv, p, 4);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const fsz = ver === 4 ? syncsafe(dv, p + 4) : dv.getUint32(p + 4, false);
        if (fsz <= 0 || p + 10 + fsz > end) break;
        const payload = new Uint8Array(bytes, p + 10, fsz);
        if (ID3_MAP[id]) {
          const val = decodeId3Text(payload).replace(/\0.*$/, '').trim();
          if (val) {
            const key = ID3_MAP[id];
            if (!fields[key]) fields[key] = val;
            found.push({ key: id, value: val, where: 'ID3v2' });
          }
        } else if (id === 'COMM') {
          const enc = payload[0];
          const rest = payload.subarray(4);
          const zero = rest.indexOf(0);
          const text = zero >= 0 ? decodeId3Text(Uint8Array.of(enc, ...rest.subarray(zero + 1))) : '';
          if (text.trim()) {
            fields.comment = text.trim();
            found.push({ key: 'COMM', value: text.trim(), where: 'ID3v2' });
          }
        } else if (id === 'APIC') {
          art = true;
          found.push({ key: 'APIC', value: 'cover art (' + fsz + ' bytes)', where: 'ID3v2' });
        }
        p += 10 + fsz;
      }
    }

    // ID3v1 / APE at the tail
    if (bytes.byteLength >= 128) {
      const tail = new Uint8Array(bytes, bytes.byteLength - 128, 128);
      if (String.fromCharCode(tail[0], tail[1], tail[2]) === 'TAG') {
        found.push({ key: 'ID3v1', value: 'present (128 bytes)', where: 'tag' });
      }
    }

    return { format: 'mp3', label: 'MP3', fields, found, art, editable: FIELDS.slice(), tag };
  }

  function id3Frame(id, text) {
    const body = te.encode(String(text));
    const payload = new Uint8Array(1 + body.length + 2);
    payload[0] = 0x03; // UTF-8 (ID3v2.4 reads it; v2.3 players ignore unknown enc)
    payload.set(body, 1);
    payload[1 + body.length] = 0;
    payload[2 + body.length] = 0;
    const head = new Uint8Array(10);
    head.set(te.encode(id), 0);
    new DataView(head.buffer).setUint32(4, payload.length, false);
    const out = new Uint8Array(10 + payload.length);
    out.set(head, 0);
    out.set(payload, 10);
    return out;
  }

  function buildId3v2(fields) {
    const frames = [];
    for (const key of Object.keys(ID3_WRITE)) {
      const id = ID3_WRITE[key];
      const val = fields[key];
      if (val === undefined || val === null || val === '') continue;
      frames.push(id3Frame(id, val));
    }
    if (fields.comment) {
      const text = te.encode(String(fields.comment));
      const payload = new Uint8Array(1 + 3 + 1 + text.length);
      payload[0] = 0x03;
      payload.set(te.encode('eng'), 1);
      payload[4] = 0; // empty description
      payload.set(text, 5);
      const head = new Uint8Array(10);
      head.set(te.encode('COMM'), 0);
      new DataView(head.buffer).setUint32(4, payload.length, false);
      const frame = new Uint8Array(10 + payload.length);
      frame.set(head, 0);
      frame.set(payload, 10);
      frames.push(frame);
    }
    if (!frames.length) return null;

    let size = 0;
    for (const f of frames) size += f.length;
    const out = new Uint8Array(10 + size);
    out.set(te.encode('ID3'), 0);
    out[3] = 4;      // version 2.4
    out[4] = 0;
    out[5] = 0;
    out.set(toSyncsafe(size), 6);
    let o = 10;
    for (const f of frames) { out.set(f, o); o += f.length; }
    return out;
  }

  function writeMp3(bytes, fields, stripAll) {
    const info = readMp3(bytes);
    let start = info.tag ? info.tag.total : 0;
    let end = bytes.byteLength;
    const removedList = [];

    // trailing ID3v1
    if (end - 128 >= start) {
      const t = new Uint8Array(bytes, end - 128, 3);
      if (String.fromCharCode(t[0], t[1], t[2]) === 'TAG') {
        end -= 128;
        removedList.push('ID3v1');
      }
    }
    // trailing APE tag (footer magic at the end)
    if (end - 32 >= start) {
      const f = readStr(new DataView(bytes, end - 32, 32), 0, 8);
      if (f === 'APETAGEX') {
        const dvf = new DataView(bytes, end - 32, 32);
        const size = dvf.getUint32(12, true);
        const items = dvf.getUint32(16, true);
        end -= size + (items ? 32 : 0);
        removedList.push('APE');
      }
    }

    if (info.tag) removedList.push('ID3v2.' + info.tag.version);

    const newTag = stripAll ? null : buildId3v2(fields);
    const audio = new Uint8Array(bytes, start, end - start);
    const total = (newTag ? newTag.length : 0) + audio.length;
    const out = new Uint8Array(total);
    let o = 0;
    if (newTag) { out.set(newTag, 0); o = newTag.length; }
    out.set(audio, o);

    return { bytes: out.buffer, removedBytes: bytes.byteLength - total, removedList };
  }

  /* ------------------------------------------------------------------ *
   * FLAC
   * ------------------------------------------------------------------ */

  function parseFlacBlocks(bytes) {
    const dv = new DataView(bytes);
    const blocks = [];
    let off = 4;
    while (off + 4 <= bytes.byteLength) {
      const h = dv.getUint8(off);
      const last = (h & 0x80) !== 0;
      const type = h & 0x7f;
      const len = (dv.getUint8(off + 1) << 16) | (dv.getUint8(off + 2) << 8) | dv.getUint8(off + 3);
      if (off + 4 + len > bytes.byteLength) break;
      blocks.push({ type, last, offset: off + 4, len, head: off });
      off += 4 + len;
      if (last) break;
    }
    return { blocks, audioStart: off };
  }

  function readFlac(bytes) {
    const dv = new DataView(bytes);
    const { blocks } = parseFlacBlocks(bytes);
    const fields = {};
    const found = [];
    let art = false;
    let vendor = '';

    for (const b of blocks) {
      if (b.type === 4) {
        let p = b.offset;
        const vlen = dv.getUint32(p, true);
        vendor = bytesToStr(bytes, p + 4, vlen, 'utf-8');
        p += 4 + vlen;
        const count = dv.getUint32(p, true);
        p += 4;
        for (let i = 0; i < count && p + 4 <= b.offset + b.len; i++) {
          const len = dv.getUint32(p, true);
          p += 4;
          const kv = bytesToStr(bytes, p, len, 'utf-8');
          p += len;
          const eq = kv.indexOf('=');
          if (eq < 0) continue;
          const k = kv.slice(0, eq).toUpperCase();
          const v = kv.slice(eq + 1);
          found.push({ key: k, value: v, where: 'Vorbis comment' });
          const map = {
            TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumartist',
            DATE: 'date', YEAR: 'date', GENRE: 'genre', TRACKNUMBER: 'track',
            COMMENT: 'comment', DESCRIPTION: 'comment', COPYRIGHT: 'copyright', ISRC: 'isrc'
          };
          if (map[k] && !fields[map[k]]) fields[map[k]] = v;
        }
        found.unshift({ key: 'vendor', value: vendor, where: 'Vorbis comment' });
      } else if (b.type === 6) {
        art = true;
        found.push({ key: 'PICTURE', value: b.len + ' bytes', where: 'block' });
      } else if (b.type === 0) {
        const sr = ((dv.getUint8(b.offset + 10) << 12) | (dv.getUint8(b.offset + 11) << 4) |
          (dv.getUint8(b.offset + 12) >> 4));
        found.unshift({ key: 'STREAMINFO', value: sr + ' Hz', where: 'required' });
      } else if (b.type === 1) {
        found.push({ key: 'PADDING', value: b.len + ' bytes', where: 'block' });
      } else if (b.type === 3) {
        found.push({ key: 'SEEKTABLE', value: b.len + ' bytes', where: 'block' });
      } else if (b.type === 2) {
        found.push({ key: 'APPLICATION', value: b.len + ' bytes', where: 'block' });
      }
    }

    return { format: 'flac', label: 'FLAC', fields, found, art, editable: FIELDS.filter((f) => f !== 'encoder') };
  }

  function buildVorbis(fields, vendor) {
    const entries = [];
    const map = {
      title: 'TITLE', artist: 'ARTIST', album: 'ALBUM', albumartist: 'ALBUMARTIST',
      date: 'DATE', genre: 'GENRE', track: 'TRACKNUMBER', comment: 'COMMENT',
      copyright: 'COPYRIGHT', isrc: 'ISRC'
    };
    for (const key of Object.keys(map)) {
      const v = fields[key];
      if (v) entries.push(te.encode(map[key] + '=' + v));
    }
    const vendorBytes = te.encode(vendor || 'Loudness Meter');
    let size = 4 + vendorBytes.length + 4;
    for (const e of entries) size += 4 + e.length;

    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    let o = 0;
    dv.setUint32(0, vendorBytes.length, true);
    o = 4;
    out.set(vendorBytes, o);
    o += vendorBytes.length;
    dv.setUint32(o, entries.length, true);
    o += 4;
    for (const e of entries) {
      dv.setUint32(o, e.length, true);
      o += 4;
      out.set(e, o);
      o += e.length;
    }
    return out;
  }

  function writeFlac(bytes, fields, stripAll) {
    const { blocks } = parseFlacBlocks(bytes);
    const parts = [];
    const removedList = [];

    // keep STREAMINFO and SEEKTABLE, drop comments/pictures/application/padding
    for (const b of blocks) {
      if (b.type === 0 || b.type === 3) {
        parts.push({ type: b.type, data: new Uint8Array(bytes, b.offset, b.len) });
      } else if (b.type === 4) {
        if (stripAll) removedList.push('Vorbis comment');
      } else if (b.type === 6) {
        removedList.push('PICTURE');
      } else if (b.type === 2) {
        removedList.push('APPLICATION');
      } else if (b.type === 1) {
        removedList.push('PADDING');
      }
    }

    let vendor = 'Loudness Meter';
    for (const b of blocks) {
      if (b.type === 4) {
        vendor = bytesToStr(bytes, b.offset + 4, new DataView(bytes).getUint32(b.offset, true), 'utf-8') || vendor;
      }
    }

    if (!stripAll) {
      const vc = buildVorbis(fields, vendor);
      parts.push({ type: 4, data: vc });
      parts.push({ type: 1, data: new Uint8Array(4096) });
    } else {
      parts.push({ type: 1, data: new Uint8Array(512) });
    }

    let total = 4;
    for (const p of parts) total += 4 + p.data.length;
    const audioStart = (function () {
      const dv = new DataView(bytes);
      let off = 4;
      for (const b of blocks) {
        off += 4 + b.len;
        if (b.last) break;
      }
      return off;
    })();

    const audioLen = bytes.byteLength - audioStart;
    const out = new Uint8Array(total + audioLen);
    out.set(te.encode('fLaC'), 0);
    let o = 4;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      out[o] = (last ? 0x80 : 0) | p.type;
      out[o + 1] = (p.data.length >> 16) & 0xff;
      out[o + 2] = (p.data.length >> 8) & 0xff;
      out[o + 3] = p.data.length & 0xff;
      out.set(p.data, o + 4);
      o += 4 + p.data.length;
    });
    out.set(new Uint8Array(bytes, audioStart), o);

    return { bytes: out.buffer, removedBytes: Math.max(0, bytes.byteLength - (total + audioLen)), removedList };
  }

  /* ------------------------------------------------------------------ *
   * public
   * ------------------------------------------------------------------ */

  function detect(bytes) {
    if (isWav(bytes)) return 'wav';
    const dv = new DataView(bytes);
    if (bytes.byteLength > 4 && readStr(dv, 0, 4) === 'fLaC') return 'flac';
    if (bytes.byteLength > 3 && readStr(dv, 0, 3) === 'ID3') return 'mp3';
    if (bytes.byteLength > 2 && dv.getUint8(0) === 0xff && (dv.getUint8(1) & 0xe0) === 0xe0) return 'mp3';
    return 'unknown';
  }

  function read(bytes) {
    const format = detect(bytes);
    if (format === 'wav') return readWav(bytes);
    if (format === 'mp3') return readMp3(bytes);
    if (format === 'flac') return readFlac(bytes);
    return { format: 'unknown', label: 'Unsupported', fields: {}, found: [], art: false, editable: [] };
  }

  function write(bytes, options) {
    const opts = options || {};
    const format = detect(bytes);
    if (format === 'wav') return writeWav(bytes, opts.fields || {}, !!opts.stripAll);
    if (format === 'mp3') return writeMp3(bytes, opts.fields || {}, !!opts.stripAll);
    if (format === 'flac') return writeFlac(bytes, opts.fields || {}, !!opts.stripAll);
    throw new Error('Unsupported format');
  }

  return { read, write, detect, FIELDS };
});
