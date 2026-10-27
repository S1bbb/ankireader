/* Читалка — Anki reader */
(function () {
  'use strict';
  const A = window.AnkiCore;
  const $ = (id) => document.getElementById(id);
  const CDN = 'https://cdn.jsdelivr.net/npm/';
  const LIBS = {
    jszip: CDN + 'jszip@3.10.1/dist/jszip.min.js',
    sqljs: CDN + 'sql.js@1.10.3/dist/sql-wasm.js',
    fzstd: CDN + 'fzstd@0.1.1/umd/index.js',
  };
  const KATEX_CSS = CDN + 'katex@0.16.11/dist/katex.min.css';
  const fmt = new Intl.NumberFormat('ru-RU');
  const isDesktop = () => matchMedia('(min-width: 960px)').matches;

  // ---------- small utils ----------
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  const cardsWord = (n) => fmt.format(n) + ' ' + plural(n, 'карточка', 'карточки', 'карточек');
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  const scriptCache = {};
  function loadScript(url) {
    return scriptCache[url] || (scriptCache[url] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = res;
      s.onerror = () => { delete scriptCache[url]; rej(new Error('NETWORK')); };
      document.head.appendChild(s);
    }));
  }
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }
  function seededShuffle(arr, seed) {
    const a = arr.slice();
    let s = seed >>> 0 || 1;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function sineWav(freq) {
    const sr = 8000, n = Math.round(sr * 1.2), buf = new ArrayBuffer(44 + n), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, Math.round(128 + 90 * Math.min(1, i / 400) * Math.min(1, (n - i) / 1600) * Math.sin(2 * Math.PI * freq * i / sr)));
    return new Blob([buf], { type: 'audio/wav' });
  }
  const prefs = {
    get(k, d) { try { const v = localStorage.getItem('reader.' + k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('reader.' + k, v); } catch (e) {} },
  };

  // ---------- IndexedDB ----------
  const idb = (() => {
    let dbp;
    function open() {
      return dbp || (dbp = new Promise((res, rej) => {
        const r = indexedDB.open('anki-reader', 1);
        r.onupgradeneeded = () => { const d = r.result; for (const s of ['meta', 'data', 'state', 'media']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }));
    }
    async function run(store, mode, fn) {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        let out;
        if (req) req.onsuccess = () => { out = req.result; };
        t.oncomplete = () => res(out);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error('abort'));
      });
    }
    return {
      get: (s, k) => run(s, 'readonly', (st) => st.get(k)),
      put: (s, k, v) => run(s, 'readwrite', (st) => st.put(v, k)),
      del: (s, k) => run(s, 'readwrite', (st) => st.delete(k)),
      all: (s) => run(s, 'readonly', (st) => st.getAll()),
      delRange: (s, lo, hi) => run(s, 'readwrite', (st) => st.delete(IDBKeyRange.bound(lo, hi))),
      putMany: (s, entries) => run(s, 'readwrite', (st) => { for (const [k, v] of entries) st.put(v, k); }),
    };
  })();

  // ---------- library ----------
  const SAMPLE_ID = 'sample';
  let library = []; // meta objects
  function sampleMeta() {
    const S = window.SAMPLE_DECK;
    return { id: SAMPLE_ID, title: S.title, cards: S.col.cards.length, decks: S.col.decks, added: 0, sample: true };
  }
  async function loadLibrary() {
    let metas = [];
    try { metas = await idb.all('meta'); } catch (e) { console.warn(e); }
    metas.sort((a, b) => b.added - a.added);
    library = metas;
    if (prefs.get('sampleHidden', '0') !== '1' && window.SAMPLE_DECK) library.push(sampleMeta());
    const states = {};
    await Promise.all(library.map(async (m) => { states[m.id] = await getState(m.id); }));
    renderLibrary(states);
    if ($('lib-q').value.trim()) globalSearch();
  }
  function renderLibrary(states) {
    const ul = $('sets');
    ul.innerHTML = '';
    const total = library.reduce((s, m) => s + m.cards, 0);
    $('lib-sub').textContent = library.length ? library.length + ' ' + plural(library.length, 'колода', 'колоды', 'колод') + ', ' + cardsWord(total) : '';
    $('empty-lib').hidden = library.length > 0;
    $('btn-restore-sample').hidden = prefs.get('sampleHidden', '0') !== '1';
    for (const m of library) {
      const st = states[m.id] || {};
      const known = Object.values(st.marks || {}).filter((v) => v === 2).length;
      const subs = Object.keys(m.decks || {}).length;
      const li = document.createElement('li');
      li.innerHTML =
        '<a class="set-row" href="#/s/' + encodeURIComponent(m.id) + '"' + (current && current.id === m.id ? ' aria-current="true"' : '') + '>' +
        '<p class="set-title">' + esc(m.title) + '</p>' +
        '<div class="set-meta eyebrow"><span>' + cardsWord(m.cards) + (subs > 1 ? ', ' + subs + ' ' + plural(subs, 'подколода', 'подколоды', 'подколод') : '') + '</span>' +
        '<span>' + (m.sample ? 'Пример' : known ? 'Знаю ' + fmt.format(known) : '') + '</span></div>' +
        '<div class="bar"><i style="width:' + (m.cards ? Math.round((known / m.cards) * 100) : 0) + '%"></i></div></a>';
      ul.appendChild(li);
    }
  }

  // ---------- per-set state ----------
  const defaultState = () => ({ pos: 0, order: 'seq', seed: 1, deck: 'all', filter: 'all', marks: {}, mode: 'cards' });
  async function getState(id) {
    try { return Object.assign(defaultState(), (await idb.get('state', id)) || {}); } catch (e) { return defaultState(); }
  }
  let saveTimer;
  function saveState() {
    if (!current) return;
    const id = current.id;
    // during an exam the real reading position is parked in exam.savedPos
    const st = current.exam ? Object.assign({}, current.state, { pos: current.exam.savedPos }) : current.state;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => idb.put('state', id, st).catch(console.warn), 250);
  }

  // ---------- media ----------
  const mediaUrls = new Map();
  function clearMedia() { for (const u of mediaUrls.values()) if (u) URL.revokeObjectURL(u); mediaUrls.clear(); }
  async function mediaURL(setId, name) {
    name = A.decodeName(name).normalize('NFC');
    const key = setId + '/' + name;
    if (mediaUrls.has(key)) return mediaUrls.get(key);
    let url = null;
    try {
      if (setId === SAMPLE_ID) {
        const b = window.SAMPLE_DECK.media[name];
        if (b && b.startsWith('gen:sine:')) url = URL.createObjectURL(sineWav(Number(b.split(':')[2])));
        else if (b) url = URL.createObjectURL(new Blob([b], { type: A.mimeFor(name) }));
      } else {
        const rec = await idb.get('media', key);
        if (rec) url = URL.createObjectURL(new Blob([rec.buf], { type: rec.type || A.mimeFor(name) }));
      }
    } catch (e) { console.warn(e); }
    mediaUrls.set(key, url);
    return url;
  }

  // ---------- sanitizing ----------
  function sanitize(html) {
    if (window.DOMPurify) {
      return window.DOMPurify.sanitize(html, { FORCE_BODY: true, ADD_TAGS: ['style'], FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'link', 'meta', 'base'] });
    }
    const t = document.createElement('template');
    t.innerHTML = html;
    t.content.querySelectorAll('script,iframe,object,embed,form,link,meta,base').forEach((n) => n.remove());
    t.content.querySelectorAll('*').forEach((n) => {
      for (const at of [...n.attributes]) {
        if (/^on/i.test(at.name) || /^\s*javascript:/i.test(at.value)) n.removeAttribute(at.name);
      }
    });
    return t.innerHTML;
  }

  // ---------- card face rendering (shadow DOM) ----------
  const BASE_CSS = `
:host { display: block; }
.card { overflow-wrap: break-word; }
img, video { max-width: 100%; height: auto; }
table { border-collapse: collapse; margin: .6em auto; display: block; width: fit-content; max-width: 100%; overflow-x: auto; }
td, th { border: 1px solid var(--hairline); padding: .35em .55em; vertical-align: top; }
td .katex, th .katex { white-space: nowrap; font-size: 1.05em; }
th { font-weight: 600; }
hr { border: 0; border-top: 1px solid var(--hairline); margin: 1em 0; }
details.hint summary { cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.snd { display: inline-flex; vertical-align: middle; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 50%;
  border: 1px solid currentColor; background: none; color: inherit; cursor: pointer; margin: 0 .15em; padding: 0; }
.snd svg { width: 18px; height: 18px; fill: currentColor; margin-left: 3px; }
.snd.missing { opacity: .35; cursor: default; }
.katex-display { overflow-x: auto; overflow-y: hidden; padding: .2em 0; margin: .5em 0; }
ruby rt { font-size: .5em; }
`;
  const IVORY_CSS = `
.card { font-family: var(--font-serif) !important; font-size: var(--card-size) !important; line-height: 1.4 !important;
  color: var(--ink) !important; background: transparent !important; padding: 0 !important; margin: 0 !important; }
.card.s { text-align: left !important; line-height: 1.5 !important; }
.cloze { color: inherit !important; font-weight: inherit !important; background: var(--cloze-bg); border-radius: 6px; padding: 0 .18em;
  -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.cloze[data-cloze] { color: var(--text-muted) !important; }
a { color: inherit; }
`;
  const ORIGINAL_CSS = `
.card { border-radius: 16px; padding: 24px; min-height: 100%; }
`;
  const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>';

  function textLen(html) {
    const withMath = String(html).replace(/\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g, (m, a, b) => {
      const tex = String(a || b || '').replace(/\\[a-zA-Z]+/g, 'x').replace(/[{}\s^_]/g, '');
      return 'x'.repeat(Math.ceil(tex.length * 0.9));
    });
    return A.stripHtml(withMath).replace(/\s+/g, ' ').trim().length;
  }
  function sizeClass(html) {
    const n = textLen(html);
    if (/<table|<ul|<ol|<pre/i.test(html)) return 's';
    const hasBlock = /<img|<video|\\\[/i.test(html);
    if (n > 140 || (hasBlock && n > 70)) return 's';
    if (n > 32 || hasBlock) return 'm';
    return 'l';
  }
  const SIZES = { l: 'clamp(30px, 3.4vw, 46px)', m: 'clamp(23px, 2.2vw, 30px)', s: 'clamp(19px, 1.5vw, 22px)' };

  let audio = null;
  function playSound(url) {
    if (!url) return;
    if (audio) { audio.pause(); }
    audio = new Audio(url);
    audio.play().catch(() => {});
  }

  async function fillFace(host, html, opts) {
    const setId = opts.setId;
    const ivory = prefs.get('cardStyle', 'ivory') === 'ivory';
    const size = opts.size || sizeClass(html);
    host.style.setProperty('--card-size', SIZES[size]);
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' });

    // deck css with media urls resolved
    let css = opts.css || '';
    const urlNames = [];
    css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (a, n) => { if (!/^(data:|https?:|blob:)/i.test(n)) urlNames.push(n); return a; });
    for (const n of urlNames) {
      const u = await mediaURL(setId, n);
      if (u) css = css.split(n).join(u);
    }
    const dark = document.documentElement.getAttribute('data-theme') === 'black' || opts.band;
    const cls = ['card', 'card' + ((opts.ord || 0) + 1), ivory ? size : ''];
    if (dark) cls.push('nightMode', 'night_mode');
    root.innerHTML =
      '<link rel="stylesheet" href="' + KATEX_CSS + '">' +
      '<style>' + BASE_CSS + '</style><style>' + css + '</style>' +
      '<style>' + (ivory ? IVORY_CSS : ORIGINAL_CSS) + '</style>' +
      '<div class="' + cls.join(' ') + '">' + sanitize(html) + '</div>';
    const card = root.querySelector('.card');

    // media
    const jobs = [];
    card.querySelectorAll('[src]').forEach((el) => {
      const src = el.getAttribute('src');
      if (!src || /^(data:|https?:|blob:|\/\/)/i.test(src)) return;
      jobs.push(mediaURL(setId, src).then((u) => { if (u) el.setAttribute('src', u); else if (el.tagName === 'IMG') el.alt = el.alt || src; }));
    });
    card.querySelectorAll('.snd').forEach((el) => {
      const b = document.createElement('button');
      b.className = 'snd'; b.type = 'button'; b.setAttribute('aria-label', 'Воспроизвести звук'); b.innerHTML = PLAY_SVG;
      el.replaceWith(b);
      jobs.push(mediaURL(setId, el.dataset.src).then((u) => { if (u) b.dataset.url = u; else b.classList.add('missing'); }));
    });
    card.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('.snd');
      if (b) { e.stopPropagation(); playSound(b.dataset.url); }
    });
    // math
    if (window.renderMathInElement && /\\\(|\\\[|\$\$/.test(html)) {
      try {
        window.renderMathInElement(card, {
          delimiters: [{ left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false }, { left: '$$', right: '$$', display: true }],
          throwOnError: false, ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        });
      } catch (e) { console.warn(e); }
    }
    // dark mode: neutralise near-black inline colours / white backgrounds
    if (dark && ivory) {
      card.querySelectorAll('[style],[color]').forEach((el) => {
        const c = el.style.color || el.getAttribute('color');
        if (c && isDarkColor(c)) { el.style.color = 'inherit'; el.removeAttribute('color'); }
        const bg = el.style.backgroundColor;
        if (bg && isLightColor(bg)) el.style.backgroundColor = 'transparent';
      });
    }
    await Promise.all(jobs);
    return root;
  }
  const probe = document.createElement('canvas').getContext('2d');
  function lum(c) {
    try { probe.fillStyle = '#123456'; probe.fillStyle = c; } catch (e) { return null; }
    const v = probe.fillStyle;
    if (v === '#123456' && !/123456/.test(c)) return null;
    let r, g, b;
    if (v[0] === '#') { r = parseInt(v.slice(1, 3), 16); g = parseInt(v.slice(3, 5), 16); b = parseInt(v.slice(5, 7), 16); }
    else { const m = v.match(/[\d.]+/g); if (!m) return null; [r, g, b] = m.map(Number); }
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  const isDarkColor = (c) => { const l = lum(c); return l != null && l < 0.22; };
  const isLightColor = (c) => { const l = lum(c); return l != null && l > 0.85; };

  // ---------- reader ----------
  let current = null; // { id, meta, col, state, list (card indices), flipped, rendered }

  async function openSet(id, mode) {
    if (current && current.id === id) {
      setView('reader');
      setMode(applyJump() ? 'cards' : mode || current.state.mode);
      return;
    }
    let meta = library.find((m) => m.id === id);
    let col;
    if (id === SAMPLE_ID && window.SAMPLE_DECK) { col = window.SAMPLE_DECK.col; meta = meta || sampleMeta(); }
    else {
      try { col = await idb.get('data', id); } catch (e) { col = null; }
    }
    if (!col || !meta) { location.hash = '#/'; return; }
    stopExamTimer();
    clearMedia();
    current = { id, meta, col, state: await getState(id), flipped: false };
    const tops = new Set(Object.values(col.decks).map((d) => d.name.split('::')[0]));
    current.sharedTop = tops.size === 1 ? [...tops][0] : null;
    prefs.set('last', id);
    $('r-title').textContent = meta.title;
    document.title = meta.title + ' — Читалка';
    rebuildList();
    setView('reader');
    document.querySelectorAll('.set-row').forEach((a) => a.setAttribute('aria-current', a.getAttribute('href') === '#/s/' + encodeURIComponent(id) ? 'true' : 'false'));
    setMode(applyJump() ? 'cards' : mode || current.state.mode || 'cards', true);
  }

  // jump to a specific card (from global search): show the whole deck so the card is in the list
  let pendingJump = null;
  function applyJump() {
    if (!pendingJump || pendingJump.id !== current.id) return false;
    const i = pendingJump.i;
    pendingJump = null;
    if (current.exam) endExam(true);
    const s = current.state;
    s.deck = 'all'; s.filter = 'all';
    rebuildList();
    s.pos = Math.max(0, current.list.indexOf(i));
    saveState();
    return true;
  }
  function jumpTo(id, i) {
    pendingJump = { id, i };
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const want = '#/s/' + encodeURIComponent(id);
    if (location.hash !== want) location.hash = want; else route();
  }

  function deckLabel(name) {
    const parts = name.split('::');
    if (current && current.sharedTop && parts.length > 1 && parts[0] === current.sharedTop) return parts.slice(1).join(' / ');
    return parts.join(' / ');
  }
  function rebuildList() {
    const { col, state } = current;
    if (current.exam) { current.list = current.exam.list; $('r-sub').textContent = examSub(); return; }
    let idx = [];
    for (let i = 0; i < col.cards.length; i++) {
      const c = col.cards[i];
      if (state.deck !== 'all' && c[2] !== state.deck) continue;
      const mk = state.marks[c[0]];
      if (state.filter === 'again' && mk !== 1) continue;
      if (state.filter === 'unmarked' && mk) continue;
      idx.push(i);
    }
    if (state.order === 'shuffle') idx = seededShuffle(idx, state.seed);
    current.list = idx;
    if (state.pos > idx.length) state.pos = 0;
    const subs = Object.keys(col.decks).length;
    const deckName = state.deck !== 'all' && col.decks[state.deck] ? deckLabel(col.decks[state.deck].name) : (subs > 1 ? 'Все подколоды' : '');
    const bits = [deckName, state.order === 'shuffle' ? 'вперемешку' : '', state.filter === 'again' ? 'повторить' : state.filter === 'unmarked' ? 'без отметки' : ''].filter(Boolean);
    $('r-sub').textContent = bits.join(', ') || cardsWord(col.cards.length);
  }

  function setView(v) {
    $('app').dataset.view = v;
  }
  function setMode(mode, force) {
    if (!current) return;
    const changed = current.state.mode !== mode;
    current.state.mode = mode;
    $('mode-cards').setAttribute('aria-pressed', String(mode === 'cards'));
    $('mode-list').setAttribute('aria-pressed', String(mode === 'list'));
    $('stage').hidden = mode !== 'cards';
    $('list').hidden = mode !== 'list';
    $('r-foot').hidden = mode !== 'cards';
    $('keys').hidden = mode !== 'cards';
    const want = '#/s/' + encodeURIComponent(current.id) + (mode === 'list' ? '/list' : '');
    if (location.hash !== want) history.replaceState(null, '', want);
    if (mode === 'cards') showCard(0);
    else renderList(true);
    if (changed) saveState();
  }

  // card mode
  let renderToken = 0;
  async function showCard(dir) {
    const { list, state, col } = current;
    const inner = $('stage-inner');
    const token = ++renderToken;
    current.flipped = false;
    updateProgress();
    if (!list.length) {
      inner.innerHTML = '<div class="end-card"><div><h2>Здесь нет карточек</h2><p>' +
        (state.filter !== 'all' ? 'С этим фильтром ничего не нашлось.' : 'В этой подколоде пусто.') +
        '</p><div class="btns"><button class="btn btn-primary" data-act="show-all">Показать все карточки</button></div></div></div>';
      renderFoot('empty');
      return;
    }
    if (state.pos >= list.length) { renderEnd(); return; }
    const card = col.cards[list[state.pos]];
    const r = A.renderCard(col, card);
    current.rendered = r;
    const deck = col.decks[card[2]] ? deckLabel(col.decks[card[2]].name) : '';
    const mk = state.marks[card[0]];
    const frag = document.createElement('div');
    frag.className = 'stage-inner';
    frag.id = 'stage-inner';
    frag.innerHTML =
      '<div class="meta-row"><span class="eyebrow">' + esc(deck) + '</span><span class="eyebrow">' +
      (mk ? '<span class="mark-chip">' + (mk === 2 ? 'знаю' : 'повторить') + '</span> &nbsp;' : '') +
      fmt.format(state.pos + 1) + ' / ' + fmt.format(list.length) + '</span></div>' +
      '<div class="q-wrap"><div class="face" id="face-q"></div></div>' +
      '<section class="band" data-theme="black" id="band" hidden><div class="face" id="face-a"></div></section>';
    current.qSize = r.aOnly == null ? sizeClass(r.a) : sizeClass(r.q);
    await fillFace(frag.querySelector('#face-q'), r.q, { setId: current.id, css: r.css, ord: r.ord, size: current.qSize });
    if (token !== renderToken) return;
    const stage = $('stage');
    current.swapping = true;
    await swapIn(inner, frag, dir);
    current.swapping = false;
    stage.scrollTop = 0;
    renderFoot('front');
    saveState();
  }
  function swapIn(oldEl, newEl, dir) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!dir || reduce) { oldEl.replaceWith(newEl); return Promise.resolve(); }
    return new Promise((res) => {
      oldEl.style.transition = 'transform .14s ease-in, opacity .14s ease-in';
      oldEl.style.transform = 'translateX(' + (dir > 0 ? -36 : 36) + 'px)';
      oldEl.style.opacity = '0';
      setTimeout(() => {
        newEl.style.transform = 'translateX(' + (dir > 0 ? 36 : -36) + 'px)';
        newEl.style.opacity = '0';
        oldEl.replaceWith(newEl);
        requestAnimationFrame(() => {
          newEl.style.transition = 'transform .2s cubic-bezier(.2,.7,.2,1), opacity .2s';
          newEl.style.transform = 'none';
          newEl.style.opacity = '1';
          setTimeout(() => { newEl.style.transition = ''; newEl.style.transform = ''; res(); }, 210);
        });
      }, 140);
    });
  }

  async function flip() {
    if (!current || current.flipped || !current.rendered || current.swapping) return;
    if (current.state.pos >= current.list.length) return;
    const r = current.rendered;
    current.flipped = true;
    const ivory = prefs.get('cardStyle', 'ivory') === 'ivory';
    const inner = $('stage-inner');
    if (r.aOnly != null && ivory && textLen(r.aOnly) + (/<img|\\\[|\\\(/.test(r.aOnly) ? 1 : 0) > 0) {
      const band = $('band');
      await fillFace($('face-a'), r.aOnly, { setId: current.id, css: r.css, ord: r.ord, band: true });
      band.hidden = false;
      inner.classList.add('flipped');
      band.classList.add('reveal');
      const stage = $('stage');
      if (band.offsetTop > stage.clientHeight * 0.75) stage.scrollTo({ top: band.offsetTop - 80, behavior: 'smooth' });
    } else {
      const face = $('face-q');
      await fillFace(face, r.a, { setId: current.id, css: r.css, ord: r.ord, size: current.qSize });
      face.classList.remove('swap'); void face.offsetWidth; face.classList.add('swap');
    }
    renderFoot('back');
  }

  function renderEnd() {
    if (current.exam) { renderExamEnd(); return; }
    const { state, col } = current;
    let know = 0, again = 0;
    for (const i of current.list) { const m = state.marks[col.cards[i][0]]; if (m === 2) know++; else if (m === 1) again++; }
    const inner = $('stage-inner');
    inner.classList.remove('flipped');
    inner.innerHTML = '<div class="end-card"><div><h2>Колода пройдена</h2><p>' +
      cardsWord(current.list.length) + '. Знаю: ' + fmt.format(know) + ', повторить: ' + fmt.format(again) + '.</p>' +
      '<div class="btns">' + (again ? '<button class="btn btn-primary" data-act="again-only">Повторить отмеченные</button>' : '') +
      '<button class="btn ' + (again ? 'btn-secondary' : 'btn-primary') + '" data-act="restart">Начать сначала</button></div></div></div>';
    current.rendered = null;
    updateProgress();
    renderFoot('end');
  }

  function renderFoot(phase) {
    const mid = $('foot-mid');
    const { state, list } = current;
    $('btn-prev').disabled = state.pos <= 0 || !list.length;
    $('btn-next').disabled = state.pos >= list.length || !list.length;
    if (phase === 'front') {
      mid.className = 'mid';
      mid.innerHTML = '<button class="btn btn-primary" data-act="flip">Показать ответ</button>';
    } else if (phase === 'back') {
      mid.className = 'mid two';
      mid.innerHTML = '<button class="btn btn-secondary" data-act="mark-again">Повторить</button><button class="btn btn-primary" data-act="mark-know">Знаю</button>';
    } else {
      mid.className = 'mid';
      mid.innerHTML = '';
    }
  }
  function updateProgress() {
    const { state, list } = current;
    $('r-progress').style.width = (list.length ? Math.min(100, (state.pos / list.length) * 100) : 0) + '%';
  }
  function go(delta) {
    if (!current || current.state.mode !== 'cards') return;
    const { state, list } = current;
    const np = state.pos + delta;
    if (np < 0 || np > list.length) return;
    state.pos = np;
    showCard(delta);
  }
  function mark(v) {
    if (!current || !current.flipped) return;
    const card = current.col.cards[current.list[current.state.pos]];
    current.state.marks[card[0]] = v;
    if (current.exam) current.exam.results[card[0]] = v;
    saveState();
    go(1);
  }

  // ---------- exam ----------
  let examTimer = null;
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function examSub() {
    const ex = current.exam;
    return (ex.review ? 'Разбор ошибок' : 'Экзамен') + (ex.deadline ? ', осталось ' + mmss(ex.deadline - Date.now()) : '');
  }
  function stopExamTimer() { clearInterval(examTimer); examTimer = null; }
  function startExam(n, minutes) {
    const pool = current.list.slice();
    const list = seededShuffle(pool, (Date.now() & 0xffffff) | 1).slice(0, n ? Math.min(n, pool.length) : pool.length);
    current.exam = { list, results: {}, savedPos: current.state.pos, started: Date.now(), deadline: minutes ? Date.now() + minutes * 60000 : 0, review: false, timeUp: false };
    current.state.pos = 0;
    closeSheet();
    rebuildList();
    setMode('cards');
    stopExamTimer();
    if (current.exam.deadline) examTimer = setInterval(tickExam, 1000);
  }
  function tickExam() {
    const ex = current && current.exam;
    if (!ex || !ex.deadline) { stopExamTimer(); return; }
    $('r-sub').textContent = examSub();
    if (Date.now() < ex.deadline) return;
    stopExamTimer();
    ex.deadline = 0; ex.timeUp = true; ex.finished = Date.now();
    closeSheet();
    current.state.pos = ex.list.length;
    $('r-sub').textContent = examSub();
    if (current.state.mode !== 'cards') setMode('cards'); else showCard(0);
  }
  function endExam(silent) {
    stopExamTimer();
    current.state.pos = current.exam.savedPos;
    current.exam = null;
    saveState();
    if (silent) return;
    rebuildList();
    showCard(0);
  }
  function reviewExam() {
    const ex = current.exam;
    const list = ex.list.filter((i) => ex.results[current.col.cards[i][0]] !== 2);
    Object.assign(ex, { list, results: {}, review: true, deadline: 0, timeUp: false, started: Date.now(), finished: 0 });
    stopExamTimer();
    current.state.pos = 0;
    rebuildList();
    showCard(0);
  }
  function renderExamEnd() {
    const ex = current.exam;
    const n = ex.list.length;
    let know = 0, again = 0;
    for (const i of ex.list) { const m = ex.results[current.col.cards[i][0]]; if (m === 2) know++; else if (m === 1) again++; }
    const skipped = n - know - again;
    if (!ex.finished) ex.finished = Date.now();
    stopExamTimer();
    ex.deadline = 0;
    $('r-sub').textContent = examSub();
    const title = ex.review ? 'Разбор закончен' : ex.timeUp ? 'Время вышло' : 'Экзамен закончен';
    const pct = n ? Math.round((know / n) * 100) : 0;
    const inner = $('stage-inner');
    inner.classList.remove('flipped');
    inner.innerHTML = '<div class="end-card"><div><span class="eyebrow">' + (ex.review ? 'Ошибки' : 'Результат') + '</span>' +
      '<h2>' + title + '</h2><p>Знаю ' + fmt.format(know) + ' из ' + fmt.format(n) + ' (' + pct + '%). Повторить: ' + fmt.format(again) +
      (skipped ? ', не успел: ' + fmt.format(skipped) : '') + '. Время: ' + mmss(ex.finished - ex.started) + '.</p>' +
      '<div class="btns">' + (again + skipped ? '<button class="btn btn-primary" data-act="exam-review">Разобрать ошибки</button>' : '') +
      '<button class="btn ' + (again + skipped ? 'btn-secondary' : 'btn-primary') + '" data-act="exam-exit">Завершить</button></div></div></div>';
    current.rendered = null;
    updateProgress();
    renderFoot('end');
  }
  function openExamSetup() {
    const n = prefs.get('examN', '20'), t = prefs.get('examT', '0');
    const pool = current.list.length;
    const html =
      '<div class="sheet-sec"><p class="danger-note" style="margin:0">Случайные карточки из текущего выбора: ' + esc($('r-sub').textContent.toLowerCase()) + ', ' + cardsWord(pool) + '. Отметки «знаю / повторить» сохранятся в колоде.</p></div>' +
      '<div class="sheet-sec"><span class="eyebrow">Сколько карточек</span>' + seg('exam-n', [['10', '10'], ['20', '20'], ['30', '30'], ['0', 'Все']], n) + '</div>' +
      '<div class="sheet-sec"><span class="eyebrow">Время</span>' + seg('exam-t', [['0', 'Без таймера'], ['10', '10 мин'], ['20', '20 мин'], ['30', '30 мин']], t) + '</div>' +
      '<div class="sheet-sec"><div class="sheet-actions">' + (pool ? '<button class="btn btn-primary" data-act="exam-start">Начать</button>' : '<p class="danger-note">Здесь нет карточек. Выберите другую подколоду или фильтр.</p>') +
      '<button class="btn btn-tertiary" data-act="back">Назад</button></div></div>';
    openSheet('Экзамен', html, (act, el) => {
      if (act === 'exam-n') { prefs.set('examN', el.dataset.v); openExamSetup(); }
      else if (act === 'exam-t') { prefs.set('examT', el.dataset.v); openExamSetup(); }
      else if (act === 'exam-start') startExam(Number(prefs.get('examN', '20')), Number(prefs.get('examT', '0')));
      else if (act === 'back') openMenu();
    });
  }

  // ---------- stats ----------
  function openStats() {
    const { col, state } = current;
    const blank = () => ({ n: 0, know: 0, again: 0 });
    const tot = blank(), per = {};
    for (const c of col.cards) {
      const p = per[c[2]] || (per[c[2]] = blank());
      const m = state.marks[c[0]];
      for (const o of [p, tot]) { o.n++; if (m === 2) o.know++; else if (m === 1) o.again++; }
    }
    const pc = (a, n) => (n ? (a / n) * 100 : 0);
    const row = (did, label, o) =>
      '<button class="stat-row" data-act="deck" data-v="' + esc(did) + '"><div class="stat-top"><span class="grow">' + esc(label) + '</span><span class="count">' + Math.round(pc(o.know, o.n)) + '%</span></div>' +
      '<div class="bar"><i style="width:' + pc(o.know, o.n) + '%"></i><b style="left:' + pc(o.know, o.n) + '%;width:' + pc(o.again, o.n) + '%"></b></div>' +
      '<span class="eyebrow">Знаю ' + fmt.format(o.know) + ' · повторить ' + fmt.format(o.again) + ' · без отметки ' + fmt.format(o.n - o.know - o.again) + '</span></button>';
    const decks = Object.entries(per).filter(([id]) => col.decks[id]).sort((a, b) => col.decks[a[0]].name.localeCompare(col.decks[b[0]].name, 'ru'));
    let html = '<div class="sheet-sec"><p class="stat-total">' + Math.round(pc(tot.know, tot.n)) + '%</p><span class="eyebrow" style="margin:0">Выучено: ' + fmt.format(tot.know) + ' из ' + cardsWord(tot.n) + '</span></div>';
    html += '<div class="sheet-sec"><div class="opt-list">' + row('all', 'Все подколоды', tot) + '</div></div>';
    if (decks.length > 1) html += '<div class="sheet-sec"><span class="eyebrow">По подколодам</span><div class="opt-list">' + decks.map(([id, o]) => row(id, deckLabel(col.decks[id].name), o)).join('') + '</div></div>';
    openSheet('Статистика', html, (act, el) => {
      if (act !== 'deck') return;
      if (current.exam) endExam(true);
      Object.assign(current.state, { deck: el.dataset.v, pos: 0 });
      saveState();
      rebuildList();
      closeSheet();
      if (current.state.mode === 'cards') showCard(0); else renderList(true);
    });
  }

  // list mode
  const PAGE = 40;
  let listShown = 0, listIdx = [], searchCache = null;
  function renderList(reset) {
    const q = $('list-q').value.trim().toLowerCase();
    if (reset) {
      listShown = 0;
      $('list-rows').innerHTML = '';
      $('list').scrollTop = 0;
      if (q) {
        if (!searchCache || searchCache.id !== current.id) searchCache = { id: current.id, map: new Map() };
        listIdx = current.list.filter((i) => {
          let t = searchCache.map.get(i);
          if (t == null) { t = A.searchText(current.col, current.col.cards[i]); searchCache.map.set(i, t); }
          return t.includes(q);
        });
      } else listIdx = current.list.slice();
      $('list-count').textContent = q ? 'Найдено: ' + cardsWord(listIdx.length) : cardsWord(listIdx.length);
    }
    const end = Math.min(listIdx.length, listShown + PAGE);
    const rows = $('list-rows');
    for (let k = listShown; k < end; k++) {
      const i = listIdx[k];
      const card = current.col.cards[i];
      const r = A.renderCard(current.col, card);
      const btn = document.createElement('div');
      btn.className = 'list-row';
      btn.tabIndex = 0;
      btn.setAttribute('role', 'button');
      btn.dataset.idx = i;
      const host = document.createElement('div');
      host.className = 'face';
      btn.appendChild(host);
      rows.appendChild(btn);
      const html = r.isCloze
        ? r.a
        : '<div class="lq">' + r.q + '</div><div class="la">' + (r.aOnly != null ? r.aOnly : r.a) + '</div>';
      fillFace(host, html, { setId: current.id, css: (r.css || '') + LIST_CSS, ord: r.ord, size: 's' });
    }
    listShown = end;
    $('list-more').textContent = listShown < listIdx.length ? 'Ещё ' + cardsWord(listIdx.length - listShown) : (listIdx.length ? '' : 'Ничего не найдено');
  }
  const LIST_CSS = `
.card { text-align: left !important; }
.lq { margin-bottom: .4em; }
.la { color: var(--text-muted); font-size: .9em; }
.la .cloze, .card .cloze { color: var(--ink) !important; }
`;

  // ---------- search across all decks ----------
  const gsData = new Map(); // set id -> { col, texts }, filled on first search
  let gsToken = 0, gsHits = [], gsShown = 0;
  async function gsLoad(m) {
    if (gsData.has(m.id)) return gsData.get(m.id);
    let col = null;
    if (m.id === SAMPLE_ID) col = window.SAMPLE_DECK && window.SAMPLE_DECK.col;
    else { try { col = await idb.get('data', m.id); } catch (e) { console.warn(e); } }
    // one hit per note: cards of the same note share the text
    const seen = new Set(), texts = [];
    if (col) col.cards.forEach((c, i) => { if (!seen.has(c[1])) { seen.add(c[1]); texts.push([i, A.searchText(col, c)]); } });
    const d = { col, texts };
    gsData.set(m.id, d);
    return d;
  }
  async function globalSearch() {
    const q = $('lib-q').value.trim().toLowerCase();
    const tok = ++gsToken;
    const lib = document.querySelector('.lib');
    lib.classList.toggle('searching', !!q);
    $('lib-results').hidden = !q;
    if (!q) return;
    const hits = [];
    for (const m of library) {
      const d = await gsLoad(m);
      if (tok !== gsToken) return;
      if (!d.col) continue;
      for (const [i, t] of d.texts) if (t.includes(q)) hits.push({ m, col: d.col, i });
    }
    gsHits = hits; gsShown = 0;
    $('lib-rows').innerHTML = '';
    const nSets = new Set(hits.map((h) => h.m.id)).size;
    $('lib-count').textContent = hits.length ? 'Найдено: ' + cardsWord(hits.length) + (library.length > 1 ? ' в ' + nSets + ' ' + plural(nSets, 'колоде', 'колодах', 'колодах') : '') : '';
    renderGs();
  }
  function renderGs() {
    const end = Math.min(gsHits.length, gsShown + PAGE);
    const rows = $('lib-rows');
    for (let k = gsShown; k < end; k++) {
      const { m, col, i } = gsHits[k];
      const card = col.cards[i];
      const r = A.renderCard(col, card);
      const row = document.createElement('div');
      row.className = 'list-row'; row.tabIndex = 0; row.setAttribute('role', 'button');
      row.dataset.set = m.id; row.dataset.idx = i;
      const deck = col.decks[card[2]] ? col.decks[card[2]].name.split('::') : [];
      if (deck.length > 1) deck.shift();
      row.innerHTML = '<span class="eyebrow">' + esc(m.title + (deck.length && deck.join(' / ') !== m.title ? ' · ' + deck.join(' / ') : '')) + '</span>';
      const host = document.createElement('div');
      host.className = 'face';
      row.appendChild(host);
      rows.appendChild(row);
      // text only: media blob URLs belong to the open deck and get revoked on switch
      const strip = (s) => String(s).replace(/<img[^>]*>/gi, '').replace(/<(audio|video)[\s\S]*?<\/\1>/gi, '').replace(/<span class="snd"[^>]*><\/span>/g, '');
      const html = r.isCloze ? strip(r.a) : '<div class="lq">' + strip(r.q) + '</div><div class="la">' + strip(r.aOnly != null ? r.aOnly : r.a) + '</div>';
      fillFace(host, html, { setId: m.id, css: (r.css || '') + LIST_CSS, ord: r.ord, size: 's' });
    }
    gsShown = end;
    $('lib-more').textContent = gsShown < gsHits.length ? 'Ещё ' + cardsWord(gsHits.length - gsShown) : (gsHits.length ? '' : 'Ничего не найдено');
  }

  // ---------- import ----------
  async function importFiles(files) {
    files = [...files].filter(Boolean);
    if (!files.length) return;
    let lastId = null;
    // plain-text exports: files with the same #deck header become one set
    const texts = files.filter(isTextFile);
    files = files.filter((f) => !isTextFile(f));
    if (texts.length) {
      try { lastId = await importTextFiles(texts); } catch (e) {
        console.error(e);
        showError(texts.map((f) => f.name).join(', '), errorText(e));
        return;
      }
    }
    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      const prefix = files.length > 1 ? (fi + 1) + ' из ' + files.length + ': ' : '';
      try {
        lastId = await importOne(file, (text, frac) => showProgress(prefix + file.name, text, frac));
      } catch (e) {
        console.error(e);
        showError(file.name, errorText(e));
        return;
      }
    }
    closeSheet();
    await loadLibrary();
    if (lastId) location.hash = '#/s/' + encodeURIComponent(lastId);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }
  function errorText(e) {
    const code = e && (e.code || e.message);
    if (code === 'NETWORK') return 'Не загрузились модули для чтения файла. Проверьте интернет и попробуйте ещё раз. Первый импорт требует сети, потом читалка работает и офлайн.';
    if (code === 'NOT_ZIP') return 'Это не архив Anki. Нужен файл .apkg или .colpkg: в Anki выберите «Файл → Экспорт».';
    if (code === 'NO_DB') return 'В архиве нет колоды Anki. Экспортируйте её заново через «Файл → Экспорт».';
    if (code === 'NEWER_FORMAT' || code === 'ZSTD') return 'Не получилось прочитать новый формат Anki. Экспортируйте колоду с галочкой «Поддержка старых версий Anki» и добавьте снова.';
    if (e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message)))) return 'На устройстве не хватило места для этой колоды. Удалите ненужные колоды или освободите память.';
    if (code === 'EMPTY') return 'В колоде нет карточек.';
    return 'Файл не прочитался: ' + (e && e.message ? e.message : 'неизвестная ошибка') + '. Попробуйте экспортировать колоду из Anki ещё раз.';
  }
  async function importOne(file, progress) {
    progress('Готовлю модули', 0.02);
    await loadScript(LIBS.jszip);
    await loadScript(LIBS.sqljs);
    progress('Распаковываю архив', 0.06);
    let zip;
    try { zip = await window.JSZip.loadAsync(file); } catch (e) { const er = new Error('NOT_ZIP'); er.code = 'NOT_ZIP'; throw er; }
    const dbName = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].find((n) => zip.file(n));
    if (!dbName) { const er = new Error('NO_DB'); er.code = 'NO_DB'; throw er; }
    const unz = async (u8) => {
      if (!A.isZstd(u8)) return u8;
      await loadScript(LIBS.fzstd);
      try { return window.fzstd.decompress(u8); } catch (e) { const er = new Error('ZSTD'); er.code = 'ZSTD'; throw er; }
    };
    progress('Читаю базу', 0.14);
    const bytes = await unz(await zip.file(dbName).async('uint8array'));
    const SQL = await window.initSqlJs({ locateFile: (f) => CDN + 'sql.js@1.10.3/dist/' + f });
    const sdb = new SQL.Database(bytes);
    const db = {
      all(sql) {
        const r = sdb.exec(sql);
        if (!r.length) return [];
        const { columns, values } = r[0];
        return values.map((v) => { const o = {}; columns.forEach((c, i) => { o[c] = v[i]; }); return o; });
      },
    };
    let col;
    try { col = A.parseCollection(db); } finally { sdb.close(); }
    if (!col.cards.length) { const er = new Error('EMPTY'); er.code = 'EMPTY'; throw er; }

    // media map
    progress('Разбираю медиа', 0.3);
    let mediaMap = {};
    const mf = zip.file('media');
    if (mf) {
      const mb = await unz(await mf.async('uint8array'));
      if (mb.length && mb[0] === 0x7b) mediaMap = JSON.parse(new TextDecoder().decode(mb));
      else if (mb.length) {
        const entries = A.pbRead(mb)[1] || [];
        entries.forEach((e, i) => {
          const m = A.pbRead(e);
          const name = A.pbStr(m, 1);
          const zipName = m[255] ? String(m[255][0]) : String(i);
          if (name) mediaMap[zipName] = name;
        });
      }
    }
    const refs = A.referencedMedia(col);
    const refsN = new Set([...refs].map((n) => n.normalize('NFC')));
    const wanted = Object.entries(mediaMap).filter(([z, n]) => (refsN.has(n.normalize('NFC')) || n.startsWith('_')) && zip.file(z));

    const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let bytesTotal = 0, done = 0, batch = [];
    const flush = async () => { if (batch.length) { await idb.putMany('media', batch); batch = []; } };
    for (const [z, name] of wanted) {
      let u8 = await unz(await zip.file(z).async('uint8array'));
      const buf = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer;
      bytesTotal += buf.byteLength;
      batch.push([id + '/' + name.normalize('NFC'), { type: A.mimeFor(name), buf }]);
      done++;
      if (batch.length >= 40) { await flush(); progress('Медиа: ' + fmt.format(done) + ' из ' + fmt.format(wanted.length), 0.3 + 0.62 * (done / wanted.length)); }
    }
    await flush();

    progress('Сохраняю', 0.95);
    const tops = new Set(Object.values(col.decks).map((d) => d.name.split('::')[0]));
    let title = file.name.replace(/\.(apkg|colpkg|zip)$/i, '').replace(/[_]+/g, ' ').trim();
    if (tops.size === 1) {
      const t = [...tops][0];
      if (!/^(default|по умолчанию|без колоды)$/i.test(t)) title = t;
    }
    // trim deck names so the shared top level isn't repeated
    const meta = { id, title, file: file.name, added: Date.now(), cards: col.cards.length, notes: Object.keys(col.notes).length, decks: col.decks, media: wanted.length, bytes: bytesTotal };
    await idb.put('data', id, col);
    await idb.put('meta', id, meta);
    progress('Готово', 1);
    return id;
  }

  const isTextFile = (f) => /\.(txt|csv|tsv)$/i.test(f.name);
  async function importTextFiles(files) {
    showProgress(files.length > 1 ? files.length + ' ' + plural(files.length, 'файл', 'файла', 'файлов') : files[0].name, 'Читаю текст', 0.3);
    const groups = new Map();
    for (const f of files) {
      const p = A.parseNotesText(await f.text());
      const key = p.deck || f.name;
      if (!groups.has(key)) groups.set(key, { files: [], parsed: [] });
      groups.get(key).files.push(f); groups.get(key).parsed.push(p);
    }
    let lastId = null, k = 0;
    for (const g of groups.values()) {
      const name = g.files[0].name.replace(/\.(txt|csv|tsv)$/i, '').replace(/[_]+/g, ' ').trim();
      const col = A.buildTextCollection(g.parsed, name);
      if (!col.cards.length) { const er = new Error('EMPTY'); er.code = 'EMPTY'; throw er; }
      const deckNames = Object.values(col.decks).map((d) => d.name);
      const title = deckNames.length === 1 ? deckNames[0].split('::').pop() : name;
      const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + k++;
      const meta = { id, title, file: g.files.map((f) => f.name).join(', '), added: Date.now(), cards: col.cards.length, notes: Object.keys(col.notes).length, decks: col.decks, media: 0, bytes: 0 };
      await idb.put('data', id, col);
      await idb.put('meta', id, meta);
      lastId = id;
    }
    return lastId;
  }

  async function deleteSet(id) {
    gsData.delete(id);
    if (id === SAMPLE_ID) prefs.set('sampleHidden', '1');
    else {
      await idb.del('meta', id);
      await idb.del('data', id);
      await idb.del('state', id);
      await idb.delRange('media', id + '/', id + '/\uffff');
    }
    if (current && current.id === id) { current = null; clearMedia(); }
    closeSheet();
    location.hash = '#/';
    await loadLibrary();
    toast('Колода удалена');
  }

  // ---------- sheets ----------
  const sheet = $('sheet');
  let sheetLocked = false;
  function openSheet(title, html, onClick) {
    $('sheet-title').textContent = title;
    $('sheet-body').innerHTML = html;
    sheet._onClick = onClick || null;
    $('sheet-close').hidden = sheetLocked;
    if (!sheet.open) { sheet.showModal(); }
  }
  function closeSheet() { sheetLocked = false; if (sheet.open) sheet.close(); }
  sheet.addEventListener('cancel', (e) => { if (sheetLocked) e.preventDefault(); });
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet && !sheetLocked) { closeSheet(); return; }
    const t = e.target.closest('[data-act]');
    if (t && sheet._onClick) sheet._onClick(t.dataset.act, t, e);
  });
  $('sheet-close').addEventListener('click', closeSheet);

  function showProgress(name, text, frac) {
    sheetLocked = true;
    const html = '<div class="progress-block"><p>' + esc(name) + '</p><div class="bar"><i style="width:' + Math.round(frac * 100) + '%"></i></div><span class="eyebrow">' + esc(text) + '</span></div>';
    if (sheet.open && $('sheet-title').textContent === 'Добавляю колоду') $('sheet-body').innerHTML = html;
    else openSheet('Добавляю колоду', html);
  }
  function showError(name, text) {
    sheetLocked = false;
    openSheet('Не получилось добавить', '<p class="error-text">' + esc(name) + '</p><p class="error-text">' + esc(text) + '</p><div class="sheet-actions"><button class="btn btn-primary" data-act="close">Понятно</button></div>', (act) => { if (act === 'close') closeSheet(); });
  }

  function seg(name, options, value) {
    return '<div class="seg full" role="group">' + options.map(([v, l]) => '<button data-act="' + name + '" data-v="' + v + '" aria-pressed="' + (v === value) + '">' + l + '</button>').join('') + '</div>';
  }

  async function openSettings() {
    let storage = '';
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        const mb = (b) => fmt.format(Math.round(b / 1048576)) + ' МБ';
        storage = 'Колоды занимают ' + mb(e.usage || 0) + (e.quota ? ', доступно до ' + mb(e.quota) : '') + '.';
      }
    } catch (e) {}
    const html =
      '<div class="sheet-sec"><span class="eyebrow">Тема</span>' + seg('theme', [['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']], prefs.get('theme', 'auto')) + '</div>' +
      '<div class="sheet-sec"><span class="eyebrow">Вид карточек</span>' + seg('style', [['ivory', 'Ivory & Slate'], ['original', 'Как в Anki']], prefs.get('cardStyle', 'ivory')) +
      '<p class="danger-note">«Как в Anki» показывает карточки со стилями самой колоды.</p></div>' +
      (storage ? '<div class="sheet-sec"><span class="eyebrow">Хранилище</span><p class="danger-note" style="margin:0">' + storage + '</p></div>' : '');
    openSheet('Настройки', html, (act, el) => {
      if (act === 'theme') { prefs.set('theme', el.dataset.v); applyTheme(); openSettings(); rerender(); }
      if (act === 'style') { prefs.set('cardStyle', el.dataset.v); openSettings(); rerender(); }
    });
  }

  function openMenu() {
    if (!current) return;
    const { col, state } = current;
    const decks = Object.entries(col.decks).sort((a, b) => a[1].name.localeCompare(b[1].name, 'ru'));
    const marks = Object.values(state.marks);
    const nAgain = marks.filter((v) => v === 1).length;
    const opt = (act, v, label, count, checked) =>
      '<button class="opt" role="radio" data-act="' + act + '" data-v="' + esc(v) + '" aria-checked="' + checked + '"><span class="grow">' + esc(label) + '</span>' + (count != null ? '<span class="count">' + fmt.format(count) + '</span>' : '') + '</button>';
    let html = '';
    if (current.exam) {
      html = '<div class="sheet-sec"><p class="danger-note" style="margin:0">' + esc(examSub()) + ': ' + cardsWord(current.list.length) + '.</p></div>' +
        '<div class="sheet-sec"><div class="sheet-actions"><button class="btn btn-primary" data-act="exam-exit">Завершить экзамен</button>' +
        '<button class="btn btn-tertiary" data-act="stats">Статистика</button><button class="btn btn-tertiary" data-act="settings">Настройки</button></div></div>';
      openSheet(current.meta.title, html, (act) => {
        if (act === 'exam-exit') { closeSheet(); endExam(); }
        else if (act === 'stats') openStats();
        else if (act === 'settings') openSettings();
      });
      return;
    }
    if (decks.length > 1) {
      html += '<div class="sheet-sec"><span class="eyebrow">Подколода</span><div class="opt-list" role="radiogroup">' +
        opt('deck', 'all', 'Все подколоды', col.cards.length, state.deck === 'all') +
        decks.map(([id, d]) => opt('deck', id, deckLabel(d.name), d.count, state.deck === id)).join('') + '</div></div>';
    }
    html += '<div class="sheet-sec"><span class="eyebrow">Порядок</span>' + seg('order', [['seq', 'По порядку'], ['shuffle', 'Вперемешку']], state.order) +
      (state.order === 'shuffle' ? '<div style="margin-top:12px"><button class="text-link" data-act="reshuffle">Перемешать заново</button></div>' : '') + '</div>';
    html += '<div class="sheet-sec"><span class="eyebrow">Показывать</span>' + seg('filter', [['all', 'Все'], ['again', 'Повторить' + (nAgain ? ' ' + nAgain : '')], ['unmarked', 'Без отметки']], state.filter) + '</div>';
    html += '<div class="sheet-sec"><div class="sheet-actions">' +
      '<button class="btn btn-primary" data-act="exam">Экзамен</button>' +
      '<button class="btn btn-secondary" data-act="stats">Статистика</button>' +
      (marks.length ? '<button class="btn btn-tertiary" data-act="reset">Сбросить отметки</button>' : '') +
      '<button class="btn btn-tertiary" data-act="settings">Настройки</button>' +
      '<button class="btn btn-tertiary" data-act="delete">' + (current.id === SAMPLE_ID ? 'Скрыть пример' : 'Удалить колоду') + '</button></div></div>';
    openSheet(current.meta.title, html, (act, el) => {
      const s = current.state;
      if (act === 'deck') { s.deck = el.dataset.v; s.pos = 0; }
      else if (act === 'order') { s.order = el.dataset.v; if (s.order === 'shuffle') s.seed = (Date.now() & 0xffffff) | 1; s.pos = 0; }
      else if (act === 'reshuffle') { s.seed = (Date.now() & 0xffffff) | 1; s.pos = 0; }
      else if (act === 'filter') { s.filter = el.dataset.v; s.pos = 0; }
      else if (act === 'reset') { s.marks = {}; s.filter = 'all'; s.pos = 0; toast('Отметки сброшены'); }
      else if (act === 'settings') { openSettings(); return; }
      else if (act === 'stats') { openStats(); return; }
      else if (act === 'exam') { openExamSetup(); return; }
      else if (act === 'delete') { confirmDelete(); return; }
      else return;
      saveState();
      rebuildList();
      if (s.mode === 'cards') showCard(0); else renderList(true);
      openMenu();
      if (act === 'deck' || act === 'filter') closeSheet();
    });
  }
  function confirmDelete() {
    if (current.id === SAMPLE_ID) { deleteSet(SAMPLE_ID); return; }
    openSheet('Удалить колоду?', '<p class="error-text">«' + esc(current.meta.title) + '» и отметки по ней удалятся с этого устройства. Чтобы вернуть колоду, добавьте файл заново.</p>' +
      '<div class="sheet-actions"><button class="btn btn-primary" data-act="yes">Удалить</button><button class="btn btn-secondary" data-act="no">Оставить</button></div>',
      (act) => { if (act === 'yes') deleteSet(current.id); else openMenu(); });
  }

  function rerender() {
    if (!current) return;
    if (current.state.mode === 'cards') {
      const wasFlipped = current.flipped;
      showCard(0).then(() => { if (wasFlipped) flip(); });
    } else renderList(true);
  }

  // ---------- theme ----------
  const mq = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const m = prefs.get('theme', 'auto');
    const dark = m === 'dark' || (m === 'auto' && mq.matches);
    if (dark) document.documentElement.setAttribute('data-theme', 'black');
    else document.documentElement.removeAttribute('data-theme');
    document.querySelectorAll('meta[name="theme-color"]').forEach((el) => {
      el.setAttribute('content', m === 'auto' ? (el.media.includes('dark') ? '#000000' : '#faf9f5') : (dark ? '#000000' : '#faf9f5'));
    });
  }
  mq.addEventListener && mq.addEventListener('change', () => { if (prefs.get('theme', 'auto') === 'auto') { applyTheme(); rerender(); } });

  // ---------- events ----------
  $('btn-add').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => { const f = e.target.files; importFiles(f); e.target.value = ''; });
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-menu').addEventListener('click', openMenu);
  $('btn-back').addEventListener('click', () => { location.hash = '#/'; });
  $('btn-prev').addEventListener('click', () => go(-1));
  $('btn-next').addEventListener('click', () => go(1));
  $('mode-cards').addEventListener('click', () => setMode('cards'));
  $('mode-list').addEventListener('click', () => setMode('list'));
  $('btn-restore-sample').addEventListener('click', () => { prefs.set('sampleHidden', '0'); loadLibrary(); });
  $('ios-hint-close').addEventListener('click', () => { prefs.set('iosHint', '0'); $('ios-hint').hidden = true; });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || sheet.contains(t)) return;
    const act = t.dataset.act;
    if (act === 'flip') flip();
    else if (act === 'mark-again') mark(1);
    else if (act === 'mark-know') mark(2);
    else if (act === 'restart') { current.state.pos = 0; showCard(0); }
    else if (act === 'again-only') { current.state.filter = 'again'; current.state.pos = 0; rebuildList(); showCard(0); }
    else if (act === 'exam-review') reviewExam();
    else if (act === 'exam-exit') endExam();
    else if (act === 'show-all') { current.state.filter = 'all'; current.state.deck = 'all'; current.state.pos = 0; rebuildList(); showCard(0); }
  });

  // list interactions
  let searchTimer;
  $('list-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => renderList(true), 180); });
  $('list').addEventListener('scroll', () => {
    const l = $('list');
    if (l.scrollTop + l.clientHeight > l.scrollHeight - 600 && listShown < listIdx.length) renderList(false);
  }, { passive: true });
  $('list-rows').addEventListener('click', (e) => {
    const row = e.target.closest('.list-row');
    if (!row) return;
    if (e.composedPath().some((n) => n.classList && n.classList.contains('snd'))) return;
    openListRow(row);
  });
  $('list-rows').addEventListener('keydown', (e) => {
    const row = e.target.closest('.list-row');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openListRow(row); }
  });
  $('lib-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(globalSearch, 180); });
  document.querySelector('.lib-scroll').addEventListener('scroll', (e) => {
    const l = e.currentTarget;
    if (!$('lib-results').hidden && l.scrollTop + l.clientHeight > l.scrollHeight - 600 && gsShown < gsHits.length) renderGs();
  }, { passive: true });
  $('lib-rows').addEventListener('click', (e) => {
    const row = e.target.closest('.list-row');
    if (row) jumpTo(row.dataset.set, Number(row.dataset.idx));
  });
  $('lib-rows').addEventListener('keydown', (e) => {
    const row = e.target.closest('.list-row');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); jumpTo(row.dataset.set, Number(row.dataset.idx)); }
  });
  function openListRow(row) {
    const i = Number(row.dataset.idx);
    const p = current.list.indexOf(i);
    if (p >= 0) { current.state.pos = p; setMode('cards'); }
  }

  // swipe + tap on stage
  (function () {
    const stage = $('stage');
    let sx = 0, sy = 0, st = 0, dragging = false, active = false, pid = null;
    const interactive = (e) => e.composedPath().some((n) => n.nodeType === 1 && /^(A|BUTTON|AUDIO|VIDEO|DETAILS|SUMMARY|INPUT|SELECT|TEXTAREA)$/.test(n.tagName));
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || interactive(e)) return;
      active = true; dragging = false; sx = e.clientX; sy = e.clientY; st = Date.now(); pid = e.pointerId;
    });
    stage.addEventListener('pointermove', (e) => {
      if (!active || e.pointerId !== pid) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!dragging) {
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) { dragging = true; try { stage.setPointerCapture(pid); } catch (er) {} }
        else if (Math.abs(dy) > 12) { active = false; return; }
      }
      if (dragging) {
        const inner = $('stage-inner');
        const atEdge = (dx > 0 && current.state.pos <= 0) || (dx < 0 && current.state.pos >= current.list.length);
        inner.style.transform = 'translateX(' + (atEdge ? dx * 0.25 : dx * 0.6) + 'px)';
        inner.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / 600));
      }
    });
    const end = (e) => {
      if (!active || e.pointerId !== pid) return;
      active = false;
      const dx = e.clientX - sx, dy = e.clientY - sy, dt = Date.now() - st;
      const inner = $('stage-inner');
      if (dragging) {
        const fast = Math.abs(dx) / Math.max(dt, 1) > 0.5;
        const dir = dx < 0 ? 1 : -1;
        const can = dir > 0 ? current.state.pos < current.list.length : current.state.pos > 0;
        if ((Math.abs(dx) > 70 || (fast && Math.abs(dx) > 30)) && can && e.type !== 'pointercancel') {
          inner.style.transform = ''; inner.style.opacity = '';
          go(dir);
        } else {
          inner.style.transition = 'transform .18s, opacity .18s';
          inner.style.transform = ''; inner.style.opacity = '';
          setTimeout(() => { inner.style.transition = ''; }, 200);
        }
        dragging = false;
        return;
      }
      if (e.type === 'pointerup' && Math.abs(dx) < 8 && Math.abs(dy) < 8 && dt < 500 && !interactive(e)) {
        const sel = window.getSelection && String(window.getSelection());
        if (!sel) { if (!current.flipped) flip(); }
      }
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  })();

  document.addEventListener('keydown', (e) => {
    if (sheet.open || !current || $('app').dataset.view !== 'reader' || current.state.mode !== 'cards') return;
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter') { e.preventDefault(); if (!current.flipped) flip(); else go(1); }
    else if (k === 'ArrowRight' || k === 'l') { e.preventDefault(); go(1); }
    else if (k === 'ArrowLeft' || k === 'h') { e.preventDefault(); go(-1); }
    else if (k === '1') mark(1);
    else if (k === '2') mark(2);
    else if (k === 'Escape' && !isDesktop()) location.hash = '#/';
  });

  // drag & drop
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('drop').hidden = false; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop').hidden = true; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('drop').hidden = true;
    importFiles(e.dataTransfer.files);
  });

  // ---------- routing ----------
  async function route() {
    const h = location.hash || '#/';
    const m = h.match(/^#\/s\/([^/]+)(\/list)?$/);
    if (m) await openSet(decodeURIComponent(m[1]), m[2] ? 'list' : null);
    else {
      setView('lib');
      document.title = 'Читалка';
      if (isDesktop()) {
        const last = prefs.get('last', '');
        const pick = library.find((x) => x.id === last) || library[0];
        if (pick) { history.replaceState(null, '', '#/s/' + encodeURIComponent(pick.id)); await openSet(pick.id); }
      }
    }
  }
  window.addEventListener('hashchange', route);

  // iOS still rubber-bands the whole web view on drags over non-scrolling areas:
  // let a touch move only when it started inside something that can actually scroll
  let touchCanScroll = false;
  const canScroll = (n) => {
    if (n.nodeType !== 1 || n === document.body || n === document.documentElement) return false;
    const cs = getComputedStyle(n);
    return (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) ||
      (/(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1);
  };
  document.addEventListener('touchstart', (e) => {
    touchCanScroll = e.composedPath().some((n) => n.nodeType === 1 && (canScroll(n) || /^(INPUT|TEXTAREA)$/.test(n.tagName)));
  }, { passive: true });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 || !touchCanScroll) e.preventDefault(); }, { passive: false });
  // no pinch / double-tap page zoom: it is an app shell, not a document
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

  // ---------- boot ----------
  async function boot() {
    applyTheme();
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    document.documentElement.classList.toggle('standalone', !!standalone);
    if (ios && !standalone && prefs.get('iosHint', '1') === '1') $('ios-hint').hidden = false;
    await loadLibrary();
    await route();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  // KaTeX/DOMPurify are deferred before this script, so they're ready here.
  boot();
})();
