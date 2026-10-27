/* Anki core: collection parsing + card template rendering.
   Works in the browser (window.AnkiCore) and in Node (module.exports). */
(function (root) {
  'use strict';
  const SEP = '\x1f';
  const td = new TextDecoder();

  // ---------- tiny protobuf reader (for Anki 2.1.50+ schema) ----------
  function pbRead(buf) {
    const out = {};
    let i = 0;
    const n = buf.length;
    const varint = () => {
      let r = 0, s = 0, b;
      do { b = buf[i++]; r += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80 && i < n);
      return r;
    };
    while (i < n) {
      const key = varint();
      const f = Math.floor(key / 8), wt = key % 8;
      let v;
      if (wt === 0) v = varint();
      else if (wt === 2) { const len = varint(); v = buf.subarray(i, i + len); i += len; }
      else if (wt === 1) { v = buf.subarray(i, i + 8); i += 8; }
      else if (wt === 5) { v = buf.subarray(i, i + 4); i += 4; }
      else break;
      (out[f] || (out[f] = [])).push(v);
    }
    return out;
  }
  const pbStr = (m, f) => (m[f] ? td.decode(m[f][0]) : '');
  const pbNum = (m, f) => (m[f] ? m[f][0] : 0);
  const toU8 = (v) => (v == null ? new Uint8Array(0) : v instanceof Uint8Array ? v : new Uint8Array(v));
  const isZstd = (b) => b && b.length > 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;

  // ---------- collection parsing ----------
  // db: { all(sql) -> array of row objects }
  function parseCollection(db) {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
    const models = {};
    const decks = {};

    let usedNew = false;
    if (tables.has('notetypes')) {
      const rows = db.all('SELECT id, name, config FROM notetypes');
      if (rows.length) {
        usedNew = true;
        for (const r of rows) {
          const c = pbRead(toU8(r.config));
          models[String(r.id)] = { name: r.name, type: pbNum(c, 1) === 1 ? 1 : 0, css: pbStr(c, 3), flds: [], tmpls: [] };
        }
        for (const r of db.all('SELECT ntid, ord, name FROM fields')) {
          const m = models[String(r.ntid)];
          if (m) m.flds.push({ ord: r.ord, name: r.name });
        }
        for (const r of db.all('SELECT ntid, ord, name, config FROM templates')) {
          const m = models[String(r.ntid)];
          if (!m) continue;
          const c = pbRead(toU8(r.config));
          m.tmpls.push({ ord: r.ord, name: r.name, qfmt: pbStr(c, 1), afmt: pbStr(c, 2) });
        }
      }
    }
    if (tables.has('decks')) {
      for (const r of db.all('SELECT id, name FROM decks')) decks[String(r.id)] = String(r.name).split(SEP).join('::');
    }
    if (!usedNew || !Object.keys(decks).length) {
      const col = db.all('SELECT models, decks FROM col')[0] || {};
      if (!usedNew && col.models) {
        const j = JSON.parse(col.models || '{}');
        for (const id in j) {
          const m = j[id];
          models[String(id)] = {
            name: m.name, type: m.type === 1 ? 1 : 0, css: m.css || '',
            flds: (m.flds || []).map((f, i) => ({ ord: f.ord ?? i, name: f.name })),
            tmpls: (m.tmpls || []).map((t, i) => ({ ord: t.ord ?? i, name: t.name, qfmt: t.qfmt || '', afmt: t.afmt || '' })),
          };
        }
      }
      if (!Object.keys(decks).length && col.decks) {
        const j = JSON.parse(col.decks || '{}');
        for (const id in j) decks[String(id)] = j[id].name;
      }
    }
    for (const id in models) {
      models[id].flds.sort((a, b) => a.ord - b.ord);
      models[id].tmpls.sort((a, b) => a.ord - b.ord);
    }

    const notes = {};
    for (const r of db.all('SELECT id, mid, flds, tags FROM notes')) {
      notes[String(r.id)] = { m: String(r.mid), f: String(r.flds).split(SEP), t: String(r.tags || '').trim() };
    }
    const cards = [];
    const usedDecks = {};
    for (const r of db.all('SELECT id, nid, did, ord FROM cards ORDER BY nid, ord')) {
      const nid = String(r.nid);
      if (!notes[nid]) continue;
      const did = String(r.did);
      cards.push([String(r.id), nid, did, r.ord]);
      usedDecks[did] = (usedDecks[did] || 0) + 1;
    }

    // keep only decks that hold cards (+ their parents for naming)
    const deckOut = {};
    for (const did in usedDecks) deckOut[did] = { name: decks[did] || 'Без колоды', count: usedDecks[did] };

    const first = cards[0] && notes[cards[0][1]];
    if (cards.length <= 2 && first && /update to the latest|newer version of Anki|обновите/i.test(first.f.join(' '))) {
      const e = new Error('NEWER_FORMAT');
      e.code = 'NEWER_FORMAT';
      throw e;
    }
    return { models, notes, cards, decks: deckOut };
  }

  // media names referenced by notes/templates/css
  function referencedMedia(col) {
    const set = new Set();
    const scan = (s) => {
      if (!s) return;
      let m;
      const reSrc = /\bsrc\s*=\s*["']?([^"'>\s]+)/gi;
      while ((m = reSrc.exec(s))) set.add(decodeName(m[1]));
      const reSnd = /\[sound:([^\]]+)\]/g;
      while ((m = reSnd.exec(s))) set.add(decodeName(m[1]));
      const reUrl = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
      while ((m = reUrl.exec(s))) set.add(decodeName(m[1]));
    };
    for (const id in col.notes) for (const f of col.notes[id].f) scan(f);
    for (const id in col.models) {
      const m = col.models[id];
      scan(m.css);
      for (const t of m.tmpls) { scan(t.qfmt); scan(t.afmt); }
    }
    return set;
  }
  function decodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  function decodeName(s) {
    s = decodeEntities(s);
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  // ---------- template rendering ----------
  const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
  const isEmptyField = (s) => !stripHtml(s).replace(/\s+/g, '') && !/<img|\[sound:/i.test(s || '');

  const CLOZE_RE = /\{\{c(\d+)::((?:(?!\{\{c\d+::)[\s\S])*?)(?:::((?:(?!\{\{c\d+::)[\s\S])*?))?\}\}/;
  function renderCloze(text, ord, side) {
    let s = String(text || '');
    let guard = 0;
    while (CLOZE_RE.test(s) && guard++ < 500) {
      s = s.replace(CLOZE_RE, (all, n, body, hint) => {
        if (/^image-occlusion:/.test(body)) return '';
        if (Number(n) === ord) {
          if (side === 'q') return '<span class="cloze" data-cloze="1">[' + (hint ? hint : '…') + ']</span>';
          return '<span class="cloze">' + body + '</span>';
        }
        return body;
      });
    }
    return s;
  }

  function furigana(s, mode) {
    return String(s).replace(/ ?([^ >]+?)\[(.+?)\]/g, (a, base, read) => {
      if (mode === 'kanji') return base;
      if (mode === 'kana') return read;
      return '<ruby><rb>' + base + '</rb><rt>' + read + '</rt></ruby>';
    });
  }

  function applyFilters(val, filters, ctx) {
    for (let i = filters.length - 1; i >= 0; i--) {
      const f = filters[i].trim().toLowerCase();
      if (f === 'cloze') val = renderCloze(val, ctx.ord + 1, ctx.side);
      else if (f === 'text') val = stripHtml(val);
      else if (f === 'type' || f.startsWith('type')) val = '';
      else if (f === 'hint') val = isEmptyField(val) ? '' : '<details class="hint"><summary>Подсказка</summary>' + val + '</details>';
      else if (f === 'furigana' || f === 'kana' || f === 'kanji') val = furigana(val, f);
      else if (f.startsWith('tts')) val = stripHtml(val);
      // unknown filters (edit, cloze-only, etc.) pass through
    }
    return val;
  }

  function renderTemplate(tpl, fields, ctx) {
    let s = String(tpl || '');
    // sections, innermost-first by repetition
    const secRe = /\{\{([#^])\s*([^}]+?)\s*\}\}((?:(?!\{\{[#^])[\s\S])*?)\{\{\/\s*\2\s*\}\}/g;
    let prev, guard = 0;
    do {
      prev = s;
      s = s.replace(secRe, (all, kind, name, body) => {
        const key = name.includes(':') ? name.split(':').pop().trim() : name;
        const v = fields[key];
        const empty = v === undefined || isEmptyField(v);
        return (kind === '#' ? !empty : empty) ? body : '';
      });
    } while (s !== prev && guard++ < 50);

    s = s.replace(/\{\{([^#^\/{}][^{}]*?)\}\}/g, (all, raw) => {
      const parts = raw.split(':');
      const name = parts.pop().trim();
      const filters = parts;
      let val;
      if (name === 'FrontSide') val = ctx.front || '';
      else if (name === 'Tags') val = ctx.tags || '';
      else if (name === 'Deck') val = ctx.deck || '';
      else if (name === 'Subdeck') val = (ctx.deck || '').split('::').pop();
      else if (name === 'Card') val = ctx.cardName || '';
      else if (name === 'Type') val = ctx.modelName || '';
      else if (name === 'CardFlag') val = '';
      else if (Object.prototype.hasOwnProperty.call(fields, name)) val = fields[name];
      else if (filters.length && filters[0].trim().toLowerCase().startsWith('tts')) val = '';
      else return '';
      return applyFilters(val, filters, ctx);
    });
    return s;
  }

  function preprocessHtml(s) {
    return String(s || '')
      .replace(/\[anki:tts[^\]]*\]([\s\S]*?)\[\/anki:tts\]/g, '$1')
      .replace(/\[\$\$\]([\s\S]*?)\[\/\$\$\]/g, '\\[$1\\]')
      .replace(/\[\$\]([\s\S]*?)\[\/\$\]/g, '\\($1\\)')
      .replace(/\[latex\]([\s\S]*?)\[\/latex\]/gi, (a, body) => {
        body = body.replace(/<br\s*\/?>/gi, ' ').trim();
        if (/\$/.test(body)) return body.replace(/\$\$([\s\S]+?)\$\$/g, '\\[$1\\]').replace(/\$([^$]+?)\$/g, '\\($1\\)');
        return '\\(' + body + '\\)';
      })
      .replace(/\[sound:([^\]]+)\]/g, (a, n) => '<span class="snd" data-src="' + n.replace(/"/g, '&quot;') + '"></span>');
  }

  const ANSWER_HR = /<hr[^>]*id\s*=\s*["']?answer["']?[^>]*>/i;

  function renderCard(col, card) {
    const [cid, nid, did, ord] = card;
    const note = col.notes[nid];
    const model = col.models[note.m] || { name: '?', type: 0, css: '', flds: [], tmpls: [] };
    const fields = {};
    model.flds.forEach((f, i) => { fields[f.name] = note.f[i] ?? ''; });
    const isCloze = model.type === 1;
    const tmpl = isCloze ? model.tmpls[0] : model.tmpls.find((t) => t.ord === ord) || model.tmpls[ord] || model.tmpls[0];
    const deck = (col.decks[did] && col.decks[did].name) || '';
    const ctx = { ord, deck, tags: note.t, cardName: tmpl ? tmpl.name : '', modelName: model.name };
    if (!tmpl) {
      const q = note.f[0] || '', a = note.f.slice(1).join('<br>');
      return { q: preprocessHtml(q), a: preprocessHtml(a), aOnly: preprocessHtml(a), css: model.css, isCloze, ord, deck, tags: note.t };
    }
    const q = renderTemplate(tmpl.qfmt, fields, Object.assign({ side: 'q' }, ctx));
    const a = renderTemplate(tmpl.afmt, fields, Object.assign({ side: 'a', front: q }, ctx));
    let aOnly = null;
    const m = a.match(ANSWER_HR);
    if (m) aOnly = a.slice(m.index + m[0].length);
    return { q: preprocessHtml(q), a: preprocessHtml(a), aOnly: aOnly == null ? null : preprocessHtml(aOnly), css: model.css || '', isCloze, ord, deck, tags: note.t };
  }

  function searchText(col, card) {
    const note = col.notes[card[1]];
    return stripHtml(note.f.join(' ')).replace(/\{\{c\d+::|\}\}/g, '').toLowerCase();
  }

  // ---------- Anki "Notes in Plain Text" (.txt/.csv) ----------
  const SEPS = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', colon: ':', space: ' ' };
  function parseNotesText(text) {
    text = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const hdr = {};
    let i = 0;
    while (text[i] === '#') {
      const e = text.indexOf('\n', i);
      const line = text.slice(i + 1, e < 0 ? text.length : e);
      const k = line.indexOf(':');
      if (k > 0) hdr[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim();
      i = e < 0 ? text.length : e + 1;
    }
    const body = text.slice(i);
    let sep = hdr.separator;
    sep = sep ? (SEPS[sep.toLowerCase()] || sep[0]) : body.includes('\t') ? '\t' : body.includes(';') ? ';' : ',';
    // CSV-style: quoted cells may contain separators, newlines and "" escapes
    const rows = [];
    let row = [], cell = '', q = false, quoted = false;
    for (let j = 0; j <= body.length; j++) {
      const ch = body[j];
      if (q) {
        if (ch === '"' && body[j + 1] === '"') { cell += '"'; j++; }
        else if (ch === '"') q = false;
        else if (ch === undefined) { row.push(cell); rows.push(row); }
        else cell += ch;
        continue;
      }
      if (ch === '"' && !cell) { q = true; quoted = true; }
      else if (ch === sep) { row.push(cell); cell = ''; quoted = false; }
      else if (ch === '\n' || ch === undefined) {
        row.push(cell);
        if (row.length > 1 || row[0].trim() || quoted) rows.push(row);
        row = []; cell = ''; quoted = false;
      } else cell += ch;
    }
    const col = (name) => { const n = parseInt(hdr[name + ' column'], 10); return n > 0 ? n - 1 : -1; };
    const meta = { guid: col('guid'), tags: col('tags'), deck: col('deck'), notetype: col('notetype') };
    const metaCols = new Set(Object.values(meta).filter((n) => n >= 0));
    const html = String(hdr.html || 'true').toLowerCase() !== 'false';
    const fix = (s) => html ? s : s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/\n/g, '<br>');
    const notes = rows.map((r) => ({
      f: r.filter((_, k) => !metaCols.has(k)).map(fix),
      guid: meta.guid >= 0 ? r[meta.guid] || '' : '',
      tags: meta.tags >= 0 ? (r[meta.tags] || '').trim() : (hdr.tags || ''),
      deck: (meta.deck >= 0 && r[meta.deck]) || hdr.deck || '',
      notetype: (meta.notetype >= 0 && r[meta.notetype]) || hdr.notetype || '',
    })).filter((n) => n.f.some((x) => x.trim()));
    return { deck: hdr.deck || '', notes };
  }
  // several parsed files → one collection in the same shape as parseCollection()
  function buildTextCollection(parsed, fallbackDeck) {
    const models = {
      b: { name: 'Basic', type: 0, css: '', flds: [{ ord: 0, name: 'Front' }, { ord: 1, name: 'Back' }],
        tmpls: [{ ord: 0, name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }] },
      r: { name: 'Basic (and reversed card)', type: 0, css: '', flds: [{ ord: 0, name: 'Front' }, { ord: 1, name: 'Back' }],
        tmpls: [{ ord: 0, name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' },
          { ord: 1, name: 'Card 2', qfmt: '{{Back}}', afmt: '{{FrontSide}}<hr id=answer>{{Front}}' }] },
      c: { name: 'Cloze', type: 1, css: '', flds: [{ ord: 0, name: 'Text' }, { ord: 1, name: 'Back Extra' }],
        tmpls: [{ ord: 0, name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Back Extra}}' }] },
    };
    const notes = {}, cards = [], decks = {}, deckIds = {}, seen = new Set();
    let k = 0;
    for (const p of parsed) {
      for (const n of p.notes) {
        if (n.guid && seen.has(n.guid)) continue;
        if (n.guid) seen.add(n.guid);
        const name = n.deck || fallbackDeck;
        const did = deckIds[name] || (deckIds[name] = 't' + Object.keys(deckIds).length);
        const nid = 'n' + k++;
        const cl = /\{\{c(\d+)::/g;
        const isCloze = /cloze|пропуск/i.test(n.notetype) || cl.test(n.f[0]);
        const m = isCloze ? 'c' : /revers|обратн/i.test(n.notetype) ? 'r' : 'b';
        const f = [n.f[0] || '', n.f.slice(1).filter((x) => x.trim()).join('<br>')];
        notes[nid] = { m, f, t: n.tags };
        let ords = [0];
        if (isCloze) {
          const s = new Set();
          for (const mm of f[0].matchAll(/\{\{c(\d+)::/g)) s.add(Number(mm[1]) - 1);
          if (s.size) ords = [...s].sort((a, b) => a - b);
        } else if (m === 'r') ords = [0, 1];
        for (const o of ords) cards.push([nid + '_' + o, nid, did, o]);
        decks[did] = { name, count: (decks[did] ? decks[did].count : 0) + ords.length };
      }
    }
    return { models, notes, cards, decks };
  }

  function mimeFor(name) {
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    return ({
      svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
      mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
      mp4: 'video/mp4', webm: 'video/webm', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', css: 'text/css',
    })[ext] || 'application/octet-stream';
  }

  const api = { pbRead, pbStr, pbNum, isZstd, parseCollection, parseNotesText, buildTextCollection, referencedMedia, renderCard, renderCloze, renderTemplate, stripHtml, searchText, mimeFor, decodeName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AnkiCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
