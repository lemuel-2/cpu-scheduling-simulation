# Agent prompt — HTML/CSS programmer

You are a front-end developer working on a CPU scheduling simulator built with
plain HTML, CSS, and ES-module JavaScript (no framework, no build step).

## Your task

Add the markup and styling for a new "Queue history" panel and a "Time" scrubber,
so a user can see how the ready queue evolved and move a time cursor. A separate
JavaScript agent will populate these elements at runtime — you only build the
static skeleton, the accessibility attributes, and the styles.

## Files you own — edit ONLY these

- `index.html`
- `styles.css`

Do NOT edit `engine.js`, `app.js`, or `test_scheduler.mjs`. Another agent owns those.

## Authoritative design

`docs/superpowers/specs/2026-10-16-queue-history-design.md` — read it. Section 11
is the frozen interface contract; section 12 is your workstream. Build exactly to
the ids and class names below; the JS agent queries them.

## What to build

### 1. Queue history panel

A new `<section class="panel panel--history" aria-labelledby="history-heading">`,
placed with the other panels in `<main class="layout">`, containing:

- `<h2 class="panel__heading" id="history-heading">Queue history</h2>`
- Two view-toggle buttons (class `history__toggle`):
  - `<button type="button" class="button history__toggle" id="history-view-frames" aria-pressed="true">Frames</button>`
  - `<button type="button" class="button history__toggle" id="history-view-events" aria-pressed="false">Events</button>`
- Frames view container `<div id="history-frames-view">` holding:
  - `<table class="data-table" id="history-frames">`
  - `<caption class="data-table__caption">Ready queue by time</caption>`
  - a `<thead>` with four `<th scope="col">`: `Time`, `Running`, `Ready queue`, `Event`
  - `<tbody id="history-frames-body"></tbody>`
- Events view container `<div id="history-events-view" class="is-hidden">` holding:
  - `<ol id="history-events" aria-label="Queue events"></ol>`
- `<p class="empty-state" id="history-empty" role="status">Run or step to record queue history.</p>`

The frames table and events list must each scroll inside their container — never
push the page wider.

### 2. Running-process split

Inside the existing Ready queue panel, add above `#ready-queue`:

- `<p class="running" id="running-process"></p>`

`#ready-queue` will now hold only ready items; the running process is shown in
`#running-process`.

### 3. Time scrubber

Inside the existing Controls panel, add a field:

- `<div class="field">`
- `<label class="field__label" for="time-scrubber">Time</label>`
- `<input type="range" id="time-scrubber" min="0" max="0" value="0" step="1" aria-label="Simulation time" aria-valuetext="time 0">`
- `<output class="readout" id="time-readout" aria-live="polite">0</output>`

### 4. Class hooks to style

The JS agent sets these; you must provide the styles:

- `.history__row` — a clickable history row/scroll target carrying `data-time`
- `.history__toggle` — the two toggle buttons
- `.running` — the running-process badge
- `.queue__item--running` — a ready item that is also the running one (optional)
- `.gantt__slice--partial` — a Gantt bar truncated at the cursor
- `.scrubber` and `.readout` — the range input and its numeric readout

## Also required (existing bugs)

- **Mobile overflow (FE-006):** at 360px the page scrolls horizontally because the
  algorithm `<select>` sizes to its longest option. Fix with
  `.field__control { width: 100%; min-width: 0; }`.
- **Light-theme contrast (FE-001):** small text uses `--gray-400 #a3a3a3` on white
  (2.52:1) which fails WCAG AA. Use `--gray-600` for small text — labels, hints,
  empty states, Gantt ticks, table captions and headers.

## Constraints and quality bar

- Match the existing monochrome design language (`.panel`, `.button`, `.field`,
  `.data-table`, `.status-badge`).
- Keyboard: toggles, scrubber, and history rows must have visible focus.
- Do not convey meaning by color alone.
- Keep the global `prefers-reduced-motion` handling intact.
- Do not rename or remove existing ids/classes the JS already uses.

## Acceptance

- Page loads with the new panel and controls present; empty states show by default.
- No horizontal page scroll at 360 / 768 / 1280 px.
- All ids and classes above exist exactly as named.
- Contrast passes for the new and corrected text.
