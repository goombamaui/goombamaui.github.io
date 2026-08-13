# Optimizer tab autocomplete — design (scratch, not part of wynnmacro's docs/design chain)

Ask: give `#opt-constraints` (textarea) and `#opt-formula` (input) the same
autoComplete.js-driven suggestion UX WynnAtlas/WynnBuilder already use elsewhere on this fork,
suggesting from the live stat-identifier set, only while the cursor sits in an identifier
position.

## Phase 1 findings (recap)

- Library: `thirdparty/autoComplete.min.js` (tobiasahlin/autoComplete.js-family, minified,
  `mode: 'loose'|'strict'`, string-vs-string `.indexOf`/subsequence matching, no built-in
  mid-string token replace). CSS already linked on `optimizer/index.html` (`<link
  rel="stylesheet" href="/thirdparty/autoComplete.min.css">`) but the **JS file is not loaded** —
  `optimizer/index.html`'s script chain has no `<script src="/thirdparty/autoComplete.min.js">`.
- Every existing usage (`js/search.js:425-540`, `js/customizer.js:102-143`,
  `js/builder/builder.js:155-190`) wires one `autoComplete` instance per **single-purpose** text
  input, where a selection **replaces the entire field value**
  (`event.target.value = event.detail.selection.value`). None of them do partial/in-place token
  replacement inside a larger free-text expression — that behavior doesn't exist anywhere in this
  codebase and must be written fresh for `#opt-formula`/`#opt-constraints`.
- Config shape used everywhere: `{ data: { src }, threshold: 0, selector: "#id", wrapper: false,
  resultsList: { maxResults, tabSelect: true, noResults: true, class, element(list, data) {...
  manual position/size, since wrapper:false} }, resultItem: { class, selected }, events: { input:
  { selection(event) {...} } } }`. `threshold: 0` means it always evaluates on input, matching
  starts as soon as 0+ characters are typed (not "after N chars").
- Data source: `knownStatNames()` in `js/optimizer_grammar.js:24-36` returns a `Set<string>` of
  bare stat-key identifiers (`ing.ids` keys from `ingMap`, plus the 5 `*Req` stats, plus
  `durability`/`duration`/`charges`) — no separate human-readable labels, confirmed correct
  identifier source for the parser's `IDENT` token per design doc
  `craft-optimizer-js-port.md` §2's own "valid-identifier table" row citing the same function.
  `autoComplete`'s `data.src` accepts an array, so this needs `Array.from(knownStatNames())`.
- Identifier-position rule (from `ConstraintTokenizer.statNameExpectedAt` /
  `FormulaTokenizer.statNameExpectedAt` in wynnmacro, `LinearTermTokenizer.statNameExpectedAfter`):
  tokenize the text, find the IDENT token the cursor is inside/at-the-end-of (or use the raw
  cursor pos if none), walk back to the last token ending at-or-before that position, and check
  its kind against an allow-list. Constraints grammar allow-list: **start of text**, `,`, `(`,
  `+`, `-`, `*`. Formula grammar allow-list: **start of text**, `(`, `+`, `-` (note: no `,` — no
  comma in the formula grammar; also note formula's own allow-list omits `*`, since
  `FormulaTokenizer.statNameExpectedAt` here only allows `PLUS, MINUS, LPAREN`, not `STAR` —
  checked directly against the Java source, this is a real grammar-specific difference, not an
  oversight to normalize away). Anywhere else (right after a NUMBER, IDENT, `)`, comparison
  operator, `/`, `^`) is not an identifier position.
- This is deliberately **not** a full tokenizer/highlighter port — `craft-optimizer-js-port.md`
  §3 already scoped `#opt-constraints`/`#opt-formula` as plain inputs and explicitly ruled out
  porting `FormulaInputField`. This design only adds the minimal "is the cursor at an
  identifier-start position" predicate needed to gate the autocomplete popup, reusing
  `optimizer_grammar.js`'s existing tokenizers (`tokenizeFormula`, and a new tiny constraint-level
  scan) rather than writing a parallel lexer.

## Design table

| File + target | New code (example) | Precedent / research | Why |
|---|---|---|---|
| `wb:optimizer/index.html` — `<head>` script chain | Add `<script src="/thirdparty/autoComplete.min.js"></script>` right after the existing `autoComplete.min.css` `<link>` | `items_adv/index.html`/`ingredients_adv/index.html` both pair the css link with a js `<script>` tag; this page only had the css link | Phase 1 found the JS file present in `thirdparty/` but never loaded on this page — required before `new autoComplete(...)` can run |
| `wb:js/optimizer_grammar.js` — new fn `identifierPositionAt(text, cursor, grammar)` | `function identifierPositionAt(text, cursor, grammar) { const tokens = grammar === 'formula' ? tokenizeFormula(text) : tokenizeConstraintLine(text); /* find containing IDENT or raw cursor, find prev token, check allow-list */ }` plus a small new `tokenizeConstraintLine(text)` reusing the same char classes as `parseTerms`/`tokenizeFormula` (`,`, `(`, `)`, `+`, `-`, `*`, IDENT run) — return `{start, end}` of the identifier run to replace, or `null` | `ConstraintTokenizer.statNameExpectedAt` + `FormulaTokenizer.statNameExpectedAt` (wm) — ported logic, not code (different token shapes) | Single shared predicate + replace-span, called by both autoComplete wiring sites; keeping it in `optimizer_grammar.js` (not inline in `index.html`) matches this file's existing role as the grammar/tokenizer module and makes it unit-testable alongside the parser later if ever needed |
| `wb:js/optimizer_grammar.js` — `identifierPositionAt` allow-lists | Constraints: prev token is `undefined` (start) or one of `,`, `(`, `+`, `-`, `*`. Formula: prev token is `undefined` or one of `(`, `+`, `-` | `LinearTermTokenizer.statNameExpectedAfter` (`PLUS,MINUS,STAR`→true) + `ConstraintTokenizer` (`COMMA,LPAREN`→true) for constraints; `FormulaTokenizer.statNameExpectedAt` (`PLUS,MINUS,LPAREN`→true, no STAR) for formula | Exact grammar-specific allow-lists found in Phase 1; formula intentionally omits `*` per the real Java source, not normalized to match constraints |
| `wb:optimizer/index.html` — new `<script>` block (same inline block as the existing GUI-wiring script, near `runOptimizerFromForm`) | `function initStatAutocomplete(inputEl, grammar) { new autoComplete({ data: { src: () => Array.from(knownStatNames()), filter: (list) => list }, threshold: 0, selector: () => inputEl, wrapper: false, trigger: () => identifierPositionAt(inputEl.value, inputEl.selectionStart, grammar) !== null, resultsList: {...same position/size pattern as customizer.js...}, resultItem: {class:"scaled-font search-item", selected:"dark-5"}, events: { input: { selection: (event) => { const pos = identifierPositionAt(inputEl.value, inputEl.selectionStart, grammar); if (!pos) return; const v = inputEl.value; const newVal = v.slice(0, pos.start) + event.detail.selection.value + v.slice(pos.end); inputEl.value = newVal; const caret = pos.start + event.detail.selection.value.length; inputEl.setSelectionRange(caret, caret); inputEl.dispatchEvent(new Event('input', {bubbles:true})); } } } }); }` called once for each of `#opt-constraints`/`#opt-formula` after `ingredient_loader.load_init()` resolves (`knownStatNames()` needs `ingMap` populated) | `init_stat_dropdown`/`init_filter_dropdown` (customizer.js/search.js) for the base config shape; `identifierPositionAt` (row above) for gating + replace span | Splices only the identifier run at the cursor back into the surrounding expression instead of clobbering the whole field — the one real behavioral difference from every existing usage in this codebase, required because these two fields hold multi-token expressions, not single stat names |
| `wb:optimizer/index.html` — wiring call site | `initStatAutocomplete(document.getElementById("opt-constraints"), 'constraint'); initStatAutocomplete(document.getElementById("opt-formula"), 'formula');` placed in the existing `(async function(){ await ingredient_loader.load_init(); ... })()` IIFE, after `populateRecipeChoices()` | Existing IIFE already gates `populateRecipeChoices()` on `load_init()`; `knownStatNames()` needs the same data | `knownStatNames()` reads `ingMap`, populated by the same load the rest of the page's init already waits on — must not construct the autoComplete instances before that resolves or `data.src()` returns an empty set on first open |

## Scope notes / deviations considered

- No popup positioning library beyond what `customizer.js`/`search.js` already hand-roll
  (`resultsList.element` manually sets `top`/`left`/`width` from `getBoundingClientRect()`) —
  reused verbatim since `wrapper: false` is used everywhere on this site.
- Not adding a debounce; `threshold: 0` + native `input` events is what every existing usage on
  this site already does, and the identifier set is small (a few hundred entries at most), so this
  matches existing perf behavior exactly.
- `trigger` callback (gating whether the popup opens at all) is not a documented option in the
  minified library visible from static review — if `trigger` config is unsupported (checked while
  implementing further), the fallback is to check `identifierPositionAt(...)` first inside a
  manual `input` listener and only construct/`start()` the autoComplete popup when it returns
  non-null, or filter `data.src` down to `[]` when not in position so the library naturally shows
  nothing (used in the final implementation instead — see report).
