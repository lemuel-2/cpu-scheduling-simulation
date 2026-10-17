# UI Redesign (App-shell + History Drawer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the CPU scheduling simulator as a fixed three-column app-shell (Setup | Timeline | Output) with a pinned, collapsible History drawer and a time scrubber, so the ready queue and its evolution are visible without page scrolling.

**Architecture:** Two parallel workstreams bound by a frozen DOM contract. Workstream A owns `index.html` + `styles.css`; Workstream B owns `engine.js` + `app.js` + `test_scheduler.mjs`. The engine records bounded history frames; a `cursor` navigates them and every view renders from `stateAt(cursor)`. Each workstream can be built and verified on its own against the contract; a final task verifies the seam.

**Tech Stack:** Vanilla HTML/CSS/ES modules, no framework, no build step. Engine tests use `node:test` (`node --test test_scheduler.mjs`). Browser verification via `python -m http.server`.

**Spec:** `docs/superpowers/specs/2026-10-16-ui-redesign-design.md` (umbrella) and
`docs/superpowers/specs/2026-10-16-queue-history-design.md` (engine data model, §5–§9). Executors read both.

## Global Constraints

- Vanilla HTML/CSS/JS, ES modules; no framework, no build step.
- Single page; keep the monochrome design language (Geist, halftone, light/dark).
- Keep the light/dark toggle with persistence (`localStorage` key `scheme`).
- WCAG AA: visible focus, keyboard operable, contrast ≥ 4.5:1 for small text, aria-live used sparingly.
- Wide-screen first; fix `file://`-free run method = local server. No horizontal page scroll at 360/768/1280px.
- Preserve all scheduling results (FCFS, SJF, SRTF, Priority non-preemptive, Round Robin).
- Engine frame shape (verbatim): `{ start, end, running, ready, completed, event, pid }`; `event ∈ 'start'|'arrive'|'dispatch'|'preempt'|'quantum'|'complete'|'idle'|null`; `start` inclusive, `end` exclusive.
- Cursor `t` = state after tick `t`; `t = 0` = initial state (no frame); `t > 0` = frame covering tick `t-1`.

## Review Focus

Input classes / failure modes the spec implies but unit tests don't fully cover, most likely to bite a user first:

1. **No processes + Run** — must show the existing "Add at least one process first" error and leave scrubber/drawer consistent (empty, not crashed).
2. **Cursor boundaries (0 and end)** — no out-of-range frame lookup; Gantt empty at 0, fully drawn at end; queue/results defined at both.
3. **Missing DOM hook** — if any drawer/scrubber element is absent, JS must fail soft (like `setFieldError`), never throw.
4. **Long ready queue / many processes** — chips and drawer rows scroll/wrap inside their container; no page overflow.
5. **Resize across the 1024px breakpoint** — drawer pinned ↔ inline with no lost content and no horizontal scroll.

---

# Part 1 — Workstream A: HTML + CSS

Owns `index.html`, `styles.css`. Do not edit JavaScript.

## Task A1: App-shell markup (three panes)

**Files:**
- Modify: `index.html` (the `<main class="layout">` block, currently lines 24–170)

**Interfaces:**
- Produces: `<main class="app-shell" id="main-content">` containing three `<section class="pane pane--setup|pane--timeline|pane--output">` elements, each `aria-labelledby` its heading. All existing ids preserved.

- [ ] **Step 1: Change `<main>` to the shell** — replace `class="layout"` with `class="app-shell"`, keep `id="main-content"`.

- [ ] **Step 2: Group existing panels into three panes**
  - `pane--setup`: the Controls panel (`panel--controls`) and Processes panel (`panel--processes`).
  - `pane--timeline`: the Gantt panel (`panel--gantt`).
  - `pane--output`: the Ready queue panel (`panel--queue`) and Results panel (`panel--results`).
  Each pane is a `<section class="pane pane--…">` that wraps its inner panels. Do not rename any inner id.

- [ ] **Step 3: Verify structure**

Run: `python -m http.server 8080` in the project dir, open `http://localhost:8080/`, in DevTools console:
```js
document.querySelectorAll('.pane').length // 3
['algorithm','gantt-bars','ready-queue','results-table'].every(id=>!!document.getElementById(id)) // true
```
Expected: `3` and `true`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "refactor(index): restructure main into three app-shell panes"
```

## Task A2: History drawer markup

**Files:**
- Modify: `index.html` (append inside `<main class="app-shell">`, after the panes)

**Interfaces:**
- Produces ids: `history-drawer`, `history-toggle`, `history-view-frames`, `history-view-events`, `history-frames-view`, `history-frames-body`, `history-events-view`, `history-events`, `history-empty`. Consumes nothing.

- [ ] **Step 1: Add the drawer section**

```html
<section class="drawer" id="history-drawer" aria-labelledby="history-heading">
  <div class="drawer__header">
    <h2 class="panel__heading" id="history-heading" style="margin:0;">Queue history</h2>
    <div class="drawer__actions">
      <button type="button" class="button history__toggle" id="history-view-frames" aria-pressed="true">Frames</button>
      <button type="button" class="button history__toggle" id="history-view-events" aria-pressed="false">Events</button>
      <button type="button" class="button" id="history-toggle" aria-expanded="true" aria-controls="history-drawer">Collapse</button>
    </div>
  </div>
  <div class="drawer__body">
    <div id="history-frames-view">
      <table class="data-table" id="history-frames">
        <caption class="data-table__caption">Ready queue by time</caption>
        <thead><tr>
          <th scope="col">Time</th><th scope="col">Running</th><th scope="col">Ready queue</th><th scope="col">Event</th>
        </tr></thead>
        <tbody id="history-frames-body"></tbody>
      </table>
    </div>
    <div id="history-events-view" class="is-hidden">
      <ol id="history-events" aria-label="Queue events"></ol>
    </div>
    <p class="empty-state" id="history-empty" role="status">Run or step to record queue history.</p>
  </div>
</section>
```

- [ ] **Step 2: Verify**

In the console: `document.getElementById('history-frames-body') !== null` → `true`.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(index): add queue-history drawer markup"
```

## Task A3: Scrubber and running-process markup

**Files:**
- Modify: `index.html` (Setup pane: add scrubber field; Output pane: add running-process line)

**Interfaces:**
- Produces ids: `time-scrubber`, `time-readout`, `running-process`.

- [ ] **Step 1: Add the scrubber field** inside the Controls panel, after the quantum `.field`:

```html
<div class="field">
  <label class="field__label" for="time-scrubber">Time</label>
  <input class="field__control scrubber" id="time-scrubber" type="range" min="0" max="0" value="0" step="1" aria-label="Simulation time" aria-valuetext="time 0">
  <output class="readout" id="time-readout" aria-live="polite">0</output>
</div>
```

- [ ] **Step 2: Add running-process line** in the Ready queue panel, before `<ol id="ready-queue">`:

```html
<p class="running" id="running-process"></p>
```

- [ ] **Step 3: Verify** — both ids resolve; the drawer from A2 still present. Console:
`['time-scrubber','time-readout','running-process'].every(id=>!!document.getElementById(id))` → `true`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(index): add time scrubber and running-process slots"
```

## Task A4: App-shell layout CSS

**Files:**
- Modify: `styles.css` (replace the `.layout` grid block, lines ~187–216)

**Interfaces:**
- Produces classes: `.app-shell`, `.pane`, `.pane--setup`, `.pane--timeline`, `.pane--output`.

- [ ] **Step 1: Replace `.layout` with the app-shell grid.**

`.app-shell` is a full-height grid: sticky header row, a 3-column main row, and a bottom drawer row. Columns: `minmax(280px,320px) minmax(0,1fr) minmax(300px,360px)`. Panes must have `min-height:0` and `overflow:auto` so they scroll internally without stretching the grid.

- [ ] **Step 2: Vertical fit** — make `.app-shell` fill the viewport below the header (e.g. `min-height: calc(100dvh - <header height>)` or a flex/grid shell on `body`), and give panes `overflow:auto`. Use `minmax(0,1fr)`/`min-height:0` rather than hard `calc` where possible (see spec §15).

- [ ] **Step 3: Verify fit** — at 1280×900 the page has **no vertical or horizontal page scroll**; each pane scrolls internally when its content is long. Console:
```js
document.documentElement.scrollHeight <= window.innerHeight + 1
```

- [ ] **Step 4: Commit**

```bash
git add styles.css
git commit -m "feat(css): app-shell three-column grid with internal pane scroll"
```

## Task A5: Drawer CSS

**Files:**
- Modify: `styles.css` (append drawer block)

**Interfaces:**
- Produces: `.drawer`, `.drawer__header`, `.drawer__actions`, `.drawer__body`, `.is-collapsed`.

- [ ] **Step 1: Style the drawer** — full-width bottom band; default expanded height ~30vh (min ~180px); `.drawer__body { overflow:auto; }`; header is a flex row with the toggle cluster on the right.

- [ ] **Step 2: Collapsed state** — `.drawer.is-collapsed .drawer__body { display:none; }` and the header keeps the `Collapse`/`Expand` button visible.

- [ ] **Step 3: Verify** — toggle `is-collapsed` on `#history-drawer` in the console; the body hides and the header stays. No page scroll change.

- [ ] **Step 4: Commit**

```bash
git add styles.css
git commit -m "feat(css): pinned collapsible history drawer"
```

## Task A6: Scrubber, running badge, partial bar, queue-running CSS

**Files:**
- Modify: `styles.css` (append)

**Interfaces:**
- Produces: `.scrubber`, `.readout`, `.running`, `.queue__item--running`, `.gantt__slice--partial`, `.history__row`, `.history__toggle`.

- [ ] **Step 1: Scrubber/readout** — a horizontal range input with a visible playhead and a monospace readout.

- [ ] **Step 2: Running badge** — `.running` reads like a small labeled chip ("Running: P2"); `.queue__item--running` gets a distinguishing outline (not color-only — keep the PID text).

- [ ] **Step 3: Partial Gantt bar** — `.gantt__slice--partial` visually marks a bar truncated at the cursor (e.g. dashed right edge / reduced opacity).

- [ ] **Step 4: History row** — `.history__row:hover`/`:focus-visible` affordance; `.history__toggle` matches `.button`.

- [ ] **Step 5: Verify** — add a process, Run, then in the console set a partial bar and click a `.history__row`; visible focus and no layout shift.

- [ ] **Step 6: Verify long queue (Review Focus #4)** — add 20 processes and Run: ready-queue chips wrap inside the pane and the drawer rows scroll internally; the page has no horizontal or vertical page scroll at 1280px.

- [ ] **Step 6: Commit**

```bash
git add styles.css
git commit -m "feat(css): scrubber, running badge, partial bar, history row styles"
```

## Task A7: Overflow + contrast fixes

**Files:**
- Modify: `styles.css` (`.field__control` ~line 274; small-text tokens)

**Interfaces:** none (pure CSS).

- [ ] **Step 1: Fix FE-006 (mobile overflow)** — add `width: 100%; min-width: 0;` to `.field__control`.

- [ ] **Step 2: Fix FE-001 (contrast)** — for small text (labels, hints, empty states, Gantt ticks, table captions/headers) use `--gray-600` instead of `--gray-400` in light theme.

- [ ] **Step 3: Verify** — at 360px width `document.documentElement.scrollWidth <= window.innerWidth + 1`; `--gray-600` on `#fff` ≥ 4.5:1.

- [ ] **Step 4: Commit**

```bash
git add styles.css
git commit -m "fix(css): prevent mobile overflow and raise small-text contrast to AA"
```

## Task A8: Responsive collapse for panes and drawer

**Files:**
- Modify: `styles.css`

**Interfaces:** none (pure CSS).

- [ ] **Step 1: `< 1024px`** — `.app-shell` becomes a single column; panes stack and the page scrolls vertically; the drawer becomes an inline section (not pinned) and stays collapsible.

- [ ] **Step 2: Verify across the breakpoint** — at 1000px and 1040px, resize and confirm the drawer switches pinned↔inline with no lost content and no horizontal scroll. (Review Focus #5.)

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "feat(css): single-column responsive layout with inline drawer"
```

---

# Part 2 — Workstream B: JavaScript

Owns `engine.js`, `app.js`, `test_scheduler.mjs`. Do not edit `index.html` / `styles.css`. Guard DOM access (fail soft) like the existing `setFieldError`.

## Task B1: Engine history frames

**Files:**
- Modify: `engine.js` (`Simulation` class, ~lines 34–227)
- Test: `test_scheduler.mjs`

**Interfaces:**
- Produces: `Simulation.getHistory(): Array<{start:number,end:number,running:number|null,ready:number[],completed:number,event:string|null,pid:string|null}>`.

- [ ] **Step 1: Write the failing tests** in `test_scheduler.mjs`:

```js
test('history: frames cover every tick exactly once', () => {
  const sim = run([P('P1', 0, 3), P('P2', 0, 2)], ALGORITHM.FCFS);
  const f = sim.getHistory();
  assert.equal(f[0].start, 0);
  for (let i = 1; i < f.length; i++) assert.equal(f[i].start, f[i - 1].end);
  assert.equal(f[f.length - 1].end, sim.time);
  assert.equal(f.reduce((a, x) => a + (x.end - x.start), 0), sim.time);
});

test('history: consecutive identical triples are merged (idle gap)', () => {
  const sim = run([P('P1', 4, 2)], ALGORITHM.FCFS);
  const idle = sim.getHistory().filter((f) => f.running === null && f.ready.length === 0);
  assert.equal(idle.length, 1);          // one merged idle frame, not four
  assert.deepEqual([idle[0].start, idle[0].end], [0, 4]);
});

test('history: events are tagged to the right tick', () => {
  const sim = run([P('P1', 0, 2), P('P2', 1, 1)], ALGORITHM.FCFS);
  const f = sim.getHistory();
  assert.ok(f.some((x) => x.event === 'complete' && x.pid === 'P1'));
  assert.ok(f.some((x) => x.event === 'arrive' && x.pid === 'P2'));
});
```

- [ ] **Step 2: Run — expect failure**

Run: `node --test test_scheduler.mjs`
Expected: FAIL — `sim.getHistory is not a function`.

- [ ] **Step 3: Implement** — add `this.history = []` in the constructor; extend `step()` to append/extend a frame each tick, merging when `(running, ready, completed)` equals the last frame's, and setting `event`/`pid` for that tick; add `getHistory() { return this.history; }`.

- [ ] **Step 4: Run — expect pass**

Run: `node --test test_scheduler.mjs`
Expected: all pass, including the existing 7.

- [ ] **Step 5: Commit**

```bash
git add engine.js test_scheduler.mjs
git commit -m "feat(engine): record merged ready-queue history frames"
```

## Task B2: Engine `stateAt(t)`

**Files:**
- Modify: `engine.js`
- Test: `test_scheduler.mjs`

**Interfaces:**
- Produces: `Simulation.stateAt(t:number): {running:number|null, ready:number[], completed:number}`.
- Consumes: `getHistory()` (Task B1).

- [ ] **Step 1: Write the failing test** (fuzz vs. replay):

```js
test('stateAt(t) equals replaying t steps, all algorithms', () => {
  const ALGOS = [ALGORITHM.FCFS, ALGORITHM.SJF, ALGORITHM.SRTF, ALGORITHM.PRIORITY, ALGORITHM.RR];
  let seed = 7; const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let iter = 0; iter < 300; iter++) {
    const procs = Array.from({ length: 1 + rnd(6) }, (_, i) => P('P' + (i + 1), rnd(5), 1 + rnd(4), rnd(3)));
    for (const algo of ALGOS) {
      const replay = new Simulation(procs.map((p) => ({ ...p })), { algorithm: algo, quantum: 1 + rnd(3) });
      const seen = [{ running: replay.current, ready: [...replay.ready], completed: replay.completed }];
      while (!replay.isDone) { replay.step(); seen.push({ running: replay.current, ready: [...replay.ready], completed: replay.completed }); }
      const sim = new Simulation(procs.map((p) => ({ ...p })), { algorithm: algo, quantum: replay.quantum });
      sim.run();
      for (let t = 0; t <= sim.time; t++) assert.deepEqual(sim.stateAt(t), seen[t], `${algo} t=${t}`);
    }
  }
});
```

- [ ] **Step 2: Run — expect failure** — `sim.stateAt is not a function`.

- [ ] **Step 3: Implement** `stateAt(t)`: `t === 0` → `{running:null, ready:[], completed:0}`; `t > 0` → the frame whose `[start,end)` contains `t-1`, returning `{running, ready, completed}` (copy `ready`). Clamp/guard out-of-range to the last frame (Review Focus #2).

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit**

```bash
git add engine.js test_scheduler.mjs
git commit -m "feat(engine): add stateAt(t) cursor lookup"
```

## Task B3: App cursor and lifecycle

**Files:**
- Modify: `app.js` (state object ~line 25; `newSimulation` ~81; `run`/`step`/`resetAll`/`clearAll` ~257–300; wiring ~317–334)

**Interfaces:**
- Consumes: `getHistory()`, `stateAt(t)`.
- Produces: app state field `cursor`; functions `buildSim()`, `setCursor(t)`, `advanceCursor(n)`; `renderAll()`.

- [ ] **Step 1: Rework lifecycle** — every (re)build creates the sim, calls `run()` once, then sets `cursor`. Rules: `Run` → cursor = `sim.time`; `Step` → `advanceCursor(1)`; `Reset` → cursor = 0 (keep sim); scrubber → `setCursor(value)`; clicking `[data-time]` → `setCursor(t)`; add/delete process, algorithm/quantum change, `Clear` → rebuild, cursor 0, clear history.

- [ ] **Step 2: Implement** `buildSim()` (new Simulation from `state.processes` + options, then `.run()`), `setCursor(t)` (clamp `0..sim.time`, then `renderAll()`), `advanceCursor(n)`, and `renderAll()` calling the render functions (Tasks B4–B6).

- [ ] **Step 3: Verify (Review Focus #1)** — with no processes, `Run` shows "Add at least one process first." and no throw; scrubber/drawer stay empty and stable. Open console: no errors.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat(app): time cursor state and simulation lifecycle"
```

## Task B4: As-of-cursor rendering

**Files:**
- Modify: `app.js` (`renderGantt` ~157, `renderQueue` ~200, `renderResults` ~215, status in `run`/`step` ~265–283)

**Interfaces:**
- Consumes: `stateAt(cursor)`, `getTimeline()`.
- Produces: rendering that reads only `state.cursor`.

- [ ] **Step 1: Queue** — `#running-process` shows the running pid (or empty); `#ready-queue` lists only `ready` (do not include the running process).

- [ ] **Step 2: Gantt** — draw segments with `end <= cursor`; truncate the segment spanning the cursor at `cursor` and add class `gantt__slice--partial`.

- [ ] **Step 3: Results** — show metrics only when `completion !== null && completion <= cursor`, else `–`; averages over shown rows.

- [ ] **Step 4: Status** — cursor 0 → `Idle`; `0 < cursor < end` → `t = N`; cursor = end → `Finished`.

- [ ] **Step 5: Verify** — Run `P1 a0 b5, P2 a0 b3` (RR q2), then set cursor to 3: Gantt shows the first bars only, last truncated; queue reflects `stateAt(3)`; results show only completed rows.

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "feat(app): render gantt, queue, results as of the cursor"
```

## Task B5: History drawer rendering

**Files:**
- Modify: `app.js` (new `renderHistory()`, view toggle wiring)

**Interfaces:**
- Consumes: `getHistory()`, `state.cursor`.
- Produces: `renderHistory()`; click handling for `[data-time]`.

- [ ] **Step 1: Frames view** — one `<tr class="history__row" data-time="<start>">` per frame with cells `Time` (`start–end-1`), `Running`, `Ready queue`, `Event`.

- [ ] **Step 2: Events view** — one `<li data-time>` per frame where `event != null`, text `t | event | pid`.

- [ ] **Step 3: Toggles** — `#history-view-frames` / `#history-view-events` switch `#history-frames-view` / `#history-events-view` via `.is-hidden` and update `aria-pressed`.

- [ ] **Step 4: Collapse** — `#history-toggle` toggles `.is-collapsed` on `#history-drawer` and its own `aria-expanded`.

- [ ] **Step 5: Row click** — a delegated listener on `#history-drawer` sets the cursor from `closest('[data-time]').dataset.time`.

- [ ] **Step 6: Empty state** — show `#history-empty` when there is no history.

- [ ] **Step 7: Verify (Review Focus #3)** — delete the `#history-frames-body` node in DevTools, then Run: no throw; the app still runs. Undo.

- [ ] **Step 8: Commit**

```bash
git add app.js
git commit -m "feat(app): render history drawer with frames/events and collapse"
```

## Task B6: Scrubber wiring

**Files:**
- Modify: `app.js` (wiring near the existing `#time-quantum` input ~330)

**Interfaces:**
- Consumes: `setCursor`, `state.sim`.
- Produces: scrubber sync.

- [ ] **Step 1: Wire** — set `#time-scrubber.max = sim.time`, `.value = cursor`; on `input`, `setCursor(Number(value))`. Set `#time-readout` text and `#time-scrubber` `aria-valuetext` to `time N, running Px` or `time N, idle`.

- [ ] **Step 2: Keep two-way sync** — after any `setCursor` (Step, row click, scrubber) all of Gantt/queue/results/readout/scrubber reflect it.

- [ ] **Step 3: Verify (Review Focus #2)** — set cursor to 0 (empty Gantt, define queue/results) and to end (full Gantt); no console errors; `aria-valuetext` updates.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat(app): wire the time scrubber and readout to the cursor"
```

---

# Part 3 — Integration

## Task C1: Seam verification

**Files:** none (verification only; fix whichever workstream owns a defect).

- [ ] **Step 1: Serve and open** — `python -m http.server 8080`, open `http://localhost:8080/`.

- [ ] **Step 2: Contract check** — console: every id in spec §10 resolves; every class hook is used:
```js
['history-drawer','history-toggle','time-scrubber','time-readout','running-process',
 'history-view-frames','history-view-events','history-frames-view','history-frames-body',
 'history-events-view','history-events','history-empty']
 .every(id => !!document.getElementById(id)) // true
```

- [ ] **Step 3: Behavior** — add `P1 a0 b5, P2 a1 b2, P3 a2 b1`, algorithm SRTF. Run. Drag the scrubber to a mid tick: ready queue is **non-empty** and matches the drawer row for that time; Gantt and results agree. Press Step: cursor +1.

- [ ] **Step 4: Layout/a11y** — at 1280px no page scroll; at 360px no horizontal scroll (Review Focus #5); Tab reaches scrubber, drawer toggles, and history rows with visible focus; drawer collapse toggles `aria-expanded`.

- [ ] **Step 5: Regression** — `node --test test_scheduler.mjs` all green; existing schedules unchanged.

- [ ] **Step 6: Commit** (only if fixes were needed).

```bash
git add -A
git commit -m "test: verify redesign integration and seam"
```

---

# Pre-flight revision — 2026-10-16

**Finding.** Workstream B (engine history frames, `stateAt(t)`, cursor-driven
Gantt/queue/results, drawer + scrubber rendering, tests) is **already
implemented and green** in the working tree: `engine.js`, `app.js`,
`test_scheduler.mjs`, `test_render.mjs` — `node --test` reports 26/26 pass.
Most of Workstream A's CSS is also present: `styles.css` already has
`.scrubber`, `.readout`, `.running`, `.queue__item--running`, `.history__row`,
`.history__toggle`, `.gantt__slice--partial`, `.gantt__slice--idle`,
`--gray-600`, `--text-meta: #525252` (AA), and `.field__control` already sets
`width:100%; min-width:0` (FE-006 fixed) with small-text contrast at AA
(FE-001 fixed).

**Ruling.** Tasks B1–B6, A3, A6 and A7 are already satisfied and are **not
dispatched**. The only missing work is the **app-shell layout**: `index.html`
is still the flat six-panel `<main class="layout">` with no
`#history-drawer`/`#history-toggle`, and `styles.css` has no
`.app-shell`/`.pane`/`.drawer`. Execute Tasks 1–4 below (superseding A1, A2,
A4, A5, A8, B5-collapse, C1). Isolation: main branch, by owner's explicit
choice; the app source is untracked so a worktree cannot contain it.

## Task 1: App-shell markup (index.html)

**File:** `index.html` only. Do not touch `styles.css`, `app.js`, `engine.js`.

Requirements:

1. `<main class="layout" id="main-content">` → `<main class="app-shell" id="main-content">`.
2. Wrap the existing panels into three panes, in this order and grouping:
   - `<div class="pane pane--setup">` around `section.panel--controls` + `section.panel--processes`
   - `<div class="pane pane--timeline">` around `section.panel--gantt`
   - `<div class="pane pane--output">` around `section.panel--queue` + `section.panel--results`
   Use `<div>` wrappers (the inner `<section aria-labelledby>` panels keep the landmark names; do not add a second labelled region).
3. Convert `section.panel.panel--history` into the pinned drawer, placed as the
   **last child of `<main class="app-shell">`** (after the three panes):
   - `<section class="drawer" id="history-drawer" aria-labelledby="history-heading">`
   - `<div class="drawer__header">` containing the existing
     `<h2 class="panel__heading" id="history-heading">Queue history</h2>` and a
     `<div class="drawer__actions">` holding the two existing toggle buttons
     `#history-view-frames` / `#history-view-events` (keep their `aria-pressed`)
     plus a new
     `<button type="button" class="button" id="history-toggle" aria-expanded="true" aria-controls="history-drawer">Collapse</button>`.
   - `<div class="drawer__body">` wrapping the existing `#history-frames-view`,
     `#history-events-view` and `#history-empty`.
4. Preserve every existing id and class exactly. Keep `#time-scrubber` /
   `#time-readout` in the controls panel and `#running-process` in the queue
   panel unchanged. No inline `style` attributes.

Existing ids that must all survive: `main-content`, `algorithm`, `quantum-field`,
`time-quantum`, `quantum-hint`, `time-scrubber`, `time-readout`, `run-simulation`,
`step-simulation`, `reset-simulation`, `clear-all`, `simulation-status`,
`process-form`, `pid`, `arrival-time`, `burst-time`, `priority`, `add-process`,
`process-form-error`, `process-table`, `process-table-body`, `process-empty`,
`gantt-chart`, `gantt-track`, `gantt-bars`, `gantt-empty`, `gantt-legend`,
`ready-queue`, `running-process`, `queue-empty`, `results-summary`,
`results-table`, `results-table-body`, `avg-completion`, `avg-turnaround`,
`avg-waiting`, `avg-response`, `history-heading`, `history-view-frames`,
`history-view-events`, `history-frames-view`, `history-frames`, `history-frames-body`,
`history-events-view`, `history-events`, `history-empty`, `theme-toggle`,
`theme-toggle-label`.

New ids this task adds: `history-drawer`, `history-toggle`.

Verification (local server, manual): `python -m http.server 8080`, open
`http://localhost:8080/`. In the console:
`document.querySelectorAll('.pane').length === 3`;
`!!document.getElementById('history-drawer')` and `'history-toggle'` both true;
`document.getElementById('history-drawer').parentElement === document.getElementById('main-content')`.
No console errors; add a process and Run — the app still works.

Commit: `git add index.html && git commit -m "refactor(index): app-shell three panes with pinned history drawer" -- index.html`

## Task 2: App-shell + drawer CSS (styles.css)

**File:** `styles.css` only.

Requirements:

1. Replace the `.layout` grid block (currently ~lines 190–220) with `.app-shell`.
   - `>= 1024px`: a full-height shell that fills the viewport below the header,
     with three columns `grid-template-columns: minmax(280px,320px) minmax(0,1fr) minmax(300px,360px)`,
     a bottom drawer row, and panes that scroll **internally**. At 1280x900 the
     page must not scroll vertically. Prefer `minmax(0,1fr)` / `min-height:0`
     over hard `calc`.
   - Delete the now-dead `grid-template-areas` and the
     `.panel--controls|--processes|--gantt|--queue|--results|--history { grid-area: ... }`
     rules. Keep the `.panel` card styles, headings and animation delays.
   - Drop the `max-width: 42rem / 64rem` centering for the shell (full width).
2. Add layout containers `.pane`, `.pane--setup`, `.pane--timeline`, `.pane--output`:
   column flex, `gap`, `min-height: 0`, `overflow: auto`.
3. Add `.drawer`, `.drawer__header`, `.drawer__actions`, `.drawer__body`,
   and `.drawer.is-collapsed .drawer__body { display: none; }`. Expanded drawer
   height ~`30vh` (min `180px`); `.drawer__body { overflow: auto; }`; the header
   is a row with the action cluster right-aligned.
4. Responsive `< 1024px`: single-column shell, page scrolls vertically, panes do
   not trap scroll, and the drawer becomes an inline section (no pinned/fixed
   height) that stays collapsible. The pinned 3-column behaviour applies only at
   `>= 1024px`.
5. No horizontal page scroll at 360 / 768 / 1280px.
6. Do not change colour tokens (`--gray-600` / `--text-meta` already meet AA) and
   do not edit HTML or JS. Keep the `prefers-reduced-motion` block intact.

Verification (local server, manual): at 1280x900
`document.documentElement.scrollHeight <= window.innerHeight + 1` and
`scrollWidth <= window.innerWidth + 1`; add 20 processes and confirm each pane
scrolls internally; at 360px and 768px `scrollWidth <= window.innerWidth + 1`;
`document.getElementById('history-drawer').classList.add('is-collapsed')` hides
the body.

Commit: `git add styles.css && git commit -m "feat(css): app-shell grid and pinned collapsible history drawer" -- styles.css`

## Task 3: Drawer collapse wiring (app.js)

**File:** `app.js` only.

Requirements: in `initUI()`, alongside the existing controls wiring, add a
guarded handler on `#history-toggle` that toggles `.is-collapsed` on
`#history-drawer`, sets the button's `aria-expanded` to the inverse, and sets its
text to `"Expand"` when collapsed / `"Collapse"` when expanded. Every element
access must be guarded so a missing hook never throws (match the file's existing
`if (el)` style). The drawer starts expanded (no initial `is-collapsed`). Do not
change scheduling logic or other render functions.

Verification: `node --test test_scheduler.mjs test_render.mjs` → 26 pass. On the
served page, clicking Collapse hides the drawer body and sets `aria-expanded`
to `false`; clicking again restores it.

Commit: `git add app.js && git commit -m "feat(app): wire history drawer collapse toggle" -- app.js`

## Task 4: Integration + accessibility verification

Verification task; fix any defect in its owning file (`index.html`,
`styles.css`, `app.js`) and commit scoped.

1. Serve `python -m http.server 8080`, open `http://localhost:8080/`.
2. Contract: every id in spec §10 resolves — `history-drawer`, `history-toggle`,
   `time-scrubber`, `time-readout`, `running-process`, `history-view-frames`,
   `history-view-events`, `history-frames-view`, `history-frames-body`,
   `history-events-view`, `history-events`, `history-empty` — plus all
   pre-existing ids listed in Task 1.
3. Behaviour: add `P1 a0 b5`, `P2 a1 b2`, `P3 a2 b1`, algorithm SRTF; Run; drag
   the scrubber mid-way → the ready queue is non-empty and matches the drawer row
   for that time; Gantt and results agree; Step advances the cursor by 1;
   clicking a `.history__row` jumps the cursor.
4. Layout: at 1280px no page scroll; at 360px and 768px no horizontal scroll;
   with 20 processes chips wrap and the drawer scrolls internally.
5. a11y: Tab reaches the scrubber, the drawer toggles and history rows with
   visible focus; `#history-toggle` toggles `aria-expanded`; `#time-scrubber`
   carries `aria-valuetext`.
6. Regression: `node --test test_scheduler.mjs test_render.mjs` all green.

Commit only if fixes were needed.
