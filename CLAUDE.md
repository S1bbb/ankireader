# ankireader — читалка колод Anki

Статичный сайт (без сборки и бэкенда) для чтения колод Anki на ПК и iPhone 16 Pro. Деплой на Vercel как есть.
Пользователь пишет по-русски, весь UI на русском. Дизайн строго по системе **Ivory & Slate** (токены ниже).

## Статус
- Код написан и проверен в headless Chromium (402×874 и 1440×900): библиотека, карточки, переворот, cloze, таблицы, картинки, звук, список с поиском, тёмная тема, импорт `.apkg` → IndexedDB → рендер медиа.
- **Ещё не задеплоено и не в git-remote.** Первая задача: создать GitHub-репо `ankireader`, запушить, подключить к Vercel.
- **Не проверено вживую** (в песочнице не было сети):
  1. настоящий `sql.js@1.10.3` (в тестах подменялся заглушкой с тем же API `new SQL.Database(u8).exec(sql)`);
  2. `fzstd@0.1.1/umd/index.js` и имя глобала `window.fzstd` (нужен только для нового формата `collection.anki21b`);
  3. реальный iPhone/Safari: safe-area, режим «На экран Домой», звук.
  Проверь импорт настоящих колод пользователя (у него 20+ наборов, физика/матан).

## Деплой
```bash
gh repo create ankireader --private --source=. --push   # или вручную через remote
vercel --prod                                            # framework: Other, build: нет, output: корень
```
Vercel-команда пользователя: `za` (slug `za-9ad6`). Отдельный проект, не путать с его другим проектом «свободные аудитории».

## Архитектура
| Файл | Роль |
|---|---|
| `index.html` | разметка: сайдбар/экран библиотеки, ридер, `<dialog class="sheet">` для меню/настроек/импорта |
| `styles.css` | токены Ivory & Slate + лейаут. Мобильный: один экран (`#app[data-view=lib|reader]`), ≥960px: сайдбар 360px + ридер |
| `anki.js` | ядро без DOM (работает и в Node): `parseCollection(db)`, `renderCard(col, card)`, cloze, шаблоны, мини-protobuf-ридер |
| `app.js` | UI, роутинг (`#/`, `#/s/<id>`, `#/s/<id>/list`), IndexedDB, импорт, свайпы, хоткеи, shadow DOM для карточек |
| `sample-deck.js` | встроенная колода «Физфак: выживание» (33 карточки), генерируется скриптами из `tools/` |
| `sw.js` | офлайн: shell network-first, пиновые CDN cache-first |
| `samples/*.apkg` | та же тестовая колода файлом, для проверки импорта |

Библиотеки с jsDelivr, версии пиннуты: dompurify 3.1.6, katex 0.16.11 (+auto-render), jszip 3.10.1, sql.js 1.10.3, fzstd 0.1.1. JSZip/sql.js/fzstd грузятся лениво только при импорте. Шрифты: Inter + JetBrains Mono (Google Fonts), serif = Georgia (системный фолбэк Tiempos).

## Данные
- Колоды **только на устройстве**, на Vercel ничего не грузится, поэтому сервер не нагружается при любом числе колод.
- IndexedDB `anki-reader` v1, сторы (ключи внешние):
  - `meta[id]` → `{id,title,file,added,cards,notes,decks,media,bytes}`, лёгкое, для списка;
  - `data[id]` → распарсенная коллекция `{models, notes, cards, decks}`;
  - `state[id]` → `{pos, order:'seq'|'shuffle', seed, deck:'all'|did, filter:'all'|'again'|'unmarked', marks:{cid:1|2}, mode}` (1 = повторить, 2 = знаю);
  - `media["<id>/<имя NFC>"]` → `{type, buf: ArrayBuffer}`. ArrayBuffer, а не Blob: так надёжнее в Safari.
- Формат коллекции: `models[mid] = {name, type(0|1 cloze), css, flds:[{ord,name}], tmpls:[{ord,name,qfmt,afmt}]}`, `notes[nid] = {m, f:[поля], t}`, `cards = [[cid, nid, did, ord], …]`, `decks[did] = {name, count}`.
- Импорт: `collection.anki21b` (zstd, схема 18: таблицы notetypes/fields/templates/decks с protobuf-конфигами) → `anki21` → `anki2`. Медиа-карта бывает JSON (legacy) или zstd+protobuf (новый). Сохраняются только упомянутые в полях/шаблонах/CSS файлы и файлы на `_`.
- Настройки в localStorage (`reader.theme`, `reader.cardStyle`, `reader.last`, `reader.sampleHidden`, `reader.iosHint`).

## Рендер карточек
- Каждая сторона рендерится в shadow root: katex.css, BASE_CSS, CSS колоды (url() → blob), затем IVORY_CSS (override `.card` шрифта/цвета/фона через `!important`) или ORIGINAL_CSS («Как в Anki»).
- Если в `afmt` есть `<hr id=answer>`, ответ (часть после hr) выезжает снизу **чёрной полосой во всю ширину** (black band из дизайн-системы, `data-theme="black"`). Иначе (cloze и т. п.) лицо меняется на полный ответ.
- Размер текста: `sizeClass()` → l/m/s по длине текста (TeX считается со скидкой), таблицы → s. У cloze размер считается по ответу, чтобы не прыгал при перевороте.
- `[sound:x]` → кнопка; blob-URL резолвится заранее, иначе iOS ломает жест. `[latex]`, `[$]`, `[$$]` конвертируются в KaTeX-разделители.
- В тёмной теме инлайновые почти-чёрные цвета и белые фоны из полей нейтрализуются.

## Ivory & Slate (источник: артефакт пользователя «Ivory & Slate» на claude.ai)
ink `#141413`, ink-soft `#3d3d3a`, text-muted `#5e5d59` (для читаемого текста), text-tertiary `#87867f`, text-secondary `#b0aea5` (только декоративное), hairline `#d1cfc5`, canvas `#faf9f5`, surface-secondary `#f0eee6` / hover `#e8e6dc`, surface-warm `#e3dacc`, manilla `#ebdbbc`, inverse `#000`.
Тема «Black band» инвертирует токены (`[data-theme="black"]`). Радиусы 8/16/24, отступы 4–96.
Правила: **никаких теней и градиентов**, никаких цветных кнопок (только ink), serif для текста, sans 700 один раз (заголовок «Колоды»), mono uppercase только для eyebrow-меток, кнопки 44px serif 18/600.

## Инструменты
```bash
python3 tools/make_sample_apkg.py     # → samples/fizfak-vyzhivanie.apkg + tools/.build/
node tools/build_sample_deck.js       # → sample-deck.js (нужен Node 22+, node:sqlite)
node tools/test_parser.js tools/.build/collection.anki21
python3 -m http.server 8000           # локально
```

## Известные ограничения / идеи
- Image Occlusion показывается без масок (клозы `image-occlusion:` вырезаются).
- `{{type:}}` скрывается, ввод ответа не поддерживается. JS из шаблонов колод вырезается (DOMPurify).
- Синхронизации ПК ↔ телефон нет (всё локально). Идея: экспорт/импорт прогресса JSON-файлом.
- Не SRS: только отметки «знаю / повторить» и фильтры.
- Очень большие `.apkg` (сотни МБ медиа) JSZip держит целиком в памяти, на iPhone может не хватить.
- В `.apkg` поддерживаются `.colpkg` и мультивыбор файлов. На ПК работает drag & drop.
