// Smoke test: parse an unzipped Anki collection and print a few rendered cards.
// usage: node tools/test_parser.js path/to/collection.anki21
const { DatabaseSync } = require('node:sqlite');
const A = require('../anki.js');
const d = new DatabaseSync(process.argv[2], { readOnly: true });
const col = A.parseCollection({ all: (s) => d.prepare(s).all() });
console.log('models', Object.keys(col.models).length, 'notes', Object.keys(col.notes).length, 'cards', col.cards.length);
console.log(col.decks);
for (const c of col.cards.slice(0, 5)) { const r = A.renderCard(col, c); console.log('---\nQ:', r.q, '\nA:', r.aOnly ?? r.a); }
