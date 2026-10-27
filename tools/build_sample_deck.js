// Builds sample-deck.js from tools/.build (run tools/make_sample_apkg.py first). Needs Node 22+ (node:sqlite).
const path = require('path'), fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const A = require('../anki.js');
const B = path.join(__dirname, '.build');
const d = new DatabaseSync(path.join(B, 'collection.anki21'), { readOnly: true });
const col = A.parseCollection({ all: (s) => d.prepare(s).all() });
const media = {
  'zatuhanie.svg': fs.readFileSync(path.join(B, 'media/zatuhanie.svg'), 'utf8'),
  'mayatnik.svg': fs.readFileSync(path.join(B, 'media/mayatnik.svg'), 'utf8'),
  'la-440.wav': 'gen:sine:440', // generated at runtime by sineWav() in app.js
};
fs.writeFileSync(path.join(__dirname, '..', 'sample-deck.js'), '/* Built-in sample deck */\nwindow.SAMPLE_DECK=' + JSON.stringify({ title: 'Физфак: выживание', col, media }) + ';\n');
console.log('sample-deck.js:', col.cards.length, 'cards');
