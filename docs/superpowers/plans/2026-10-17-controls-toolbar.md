# Controls Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Controls panel out of the scrolling left column into a
full-width toolbar row under the app header, so Run, Step, the algorithm, and the
time scrubber are always visible while the process list scrolls.

**Architecture:** One DOM move (the section becomes a child of `main.app-shell`
instead of `div.pane--setup`), one new grid row at 1024px and wider, a flex row
inside the moved section, a smaller history drawer to pay for the toolbar's
height, and the same pinned-panel pattern already used by the Results pane
applied to the Processes panel. No JavaScript changes: every id survives.

**Tech Stack:** Plain HTML, CSS custom properties, ES modules. Verification runs
in headless Chrome over the DevTools protocol; tests use `node:test`.

**Spec:** `cpu_scheduling_simulation/docs/superpowers/specs/2026-10-17-controls-toolbar-design.md`

## Global Constraints

- No change to `app.js`, `engine.js`, or any element id. Every id inside the
  moved section keeps working.
- `grid-area: controls` appears only inside `@media (min-width: 1024px)`. Outside
  that block there is no `controls` area and the declaration creates stray
  implicit grid lines.
- Toolbar height is 60px at 1024px and wider: a 36px control plus
  `var(--space-3) var(--space-4)` padding.
- Toolbar occupies a single row at 1024px and wider.
- History drawer becomes `height: 20vh; min-height: 160px` at 1024px and wider.
- No pane ever gets `overflow: hidden`; a pane keeps `overflow: auto` as the
  short-window safety valve. Clipped content cannot be scrolled at all.
- Inner row lists use a `4rem` `min-height` floor with their own `overflow: auto`.
- The `01 — CONTROLS` heading stays, so panel numbering is unchanged:
  Processes `02`, Gantt `03`, Queue `04`, Results `05`, History `06`.
- Below 1024px nothing changes visually: the section stays in document flow,
  stacked, with its current field layout.
- Existing tests stay green: 4 in `test_render.mjs`, 22 in `test_scheduler.mjs`.
- Git: the repository root `C:\com_prog` holds several unrelated projects. Stage
  only `cpu_scheduling_simulation` paths, never `git add -A`. Leave
  `store/inventory.js` alone.

## Review Focus

Failure modes the spec implies but no unit test can catch. Each line names the
case and the behavior a person would expect; the task in brackets carries its
test.

1. **Round Robin at 1024px.** Selecting Round Robin reveals the quantum field.
   The toolbar must stay one row and must not overflow horizontally. [Task 3,
   harness case H]
2. **The longest algorithm label at 1024px.** `SRTF — Shortest Remaining Time
   First` must not push the row into wrapping or off screen. [Task 3, case I]
3. **Short window, 1024x620, drawer expanded.** The toolbar plus drawer exceed
   the height the panes need. Everything must stay reachable: the pane may
   scroll, nothing may be clipped out of existence. [Task 4, case K]
4. **Three-digit metrics.** After a run long enough to produce completion times
   of 100 or more, the results table must still fit without sideways scroll.
   [Task 5, case L]
5. **Zero processes.** With an empty list the left pane shows the form and the
   empty state, no first row exists to check, and the pane must not overflow.
   [Task 5, case J]

## Files

- Create: `cpu_scheduling_simulation/tools/measure-layout.mjs` — the layout
  harness. Needs Chrome at
  `C:\Program Files\Google\Chrome\Application\chrome.exe` and Python for a static
  server (the page imports `app.js` as a module, which `file://` blocks).
- Modify: `cpu_scheduling_simulation/index.html` — the DOM move only.
- Modify: `cpu_scheduling_simulation/styles.css` — grid row, toolbar layout,
  drawer height, process pane pinning.
- Unchanged: `cpu_scheduling_simulation/app.js`, `engine.js`, both test files.

---

### Task 1: Layout harness

The assertions for every later task run through this script. It must fail now,
before any layout change, because the toolbar does not exist yet.

**Files:**
- Create: `cpu_scheduling_simulation/tools/measure-layout.mjs`

**Interfaces:**
- Produces: `node tools/measure-layout.mjs` — measures the matrix below, prints
  one line per case plus a JSON dump, exits `1` if any required assertion fails,
  exits `0` otherwise. Later tasks add cases; they do not rewrite the harness.

- [ ] **Step 1: Write the harness**

Spawn a static server and headless Chrome, open one page, and reuse that page for
every case (set device metrics, then run the probe). An equivalent working harness
exists at `%TEMP%\opencode\cpusched_qa\measure3.mjs` in this session's temp
folder; adapt it if it is still there.

Server: `python -m http.server <port> --bind 127.0.0.1` with `cwd` set to
`cpu_scheduling_simulation`. Chrome:
`--headless=new --disable-gpu --no-first-run --remote-debugging-port=<port>
--user-data-dir=<temp dir>`.

The probe, run with `Runtime.evaluate` and `returnByValue`, returns:

```js
(() => {
  const $ = (s) => document.querySelector(s);
  const box = (el) => { const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top),
             w: Math.round(r.width), h: Math.round(r.height),
             bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const pane = $('.pane--setup');
  const out = { viewport: innerWidth + 'x' + innerHeight };
  const toolbar = $('.app-shell > .panel--controls');
  out.toolbarPresent = !!toolbar;
  if (toolbar) {
    const t = box(toolbar);
    out.toolbarBox = t;
    out.toolbarOnScreen = t.y >= 0 && t.bottom <= innerHeight + 1;
    out.toolbarOverflowsX = toolbar.scrollWidth > toolbar.clientWidth + 1;
  }
  out.controlsInsidePane = !!$('.pane--setup .panel--controls');
  out.runInsidePane = !!$('.pane--setup #run-simulation');
  out.leftPaneOverflow = pane.scrollHeight - pane.clientHeight;
  const form = box($('#process-form'));
  const pr = box(pane);
  out.formVisible = form.y >= pr.y - 1 && form.bottom <= pr.bottom + 1;
  const firstRow = $('#process-table-body tr');
  out.hasFirstRow = !!firstRow;
  out.firstRowVisible = firstRow ? box(firstRow).bottom <= pr.bottom + 1 : null;
  out.processHeaderVisible = out.hasFirstRow
    ? box($('#process-table thead th')).bottom <= pr.bottom + 1 : null;
  const opane = $('.pane--output');
  const ts = $('#results-table').closest('.table-scroll');
  out.outputPaneOverflow = opane.scrollHeight - opane.clientHeight;
  out.resultsOverflowX = ts.scrollWidth - ts.clientWidth;
  const sr = box(ts);
  out.resultsColsCut = [...document.querySelectorAll('#results-table thead th')]
    .filter((th) => { const b = box(th); return b.x < sr.x - 1 || b.right > sr.right + 1; })
    .map((th) => th.textContent.trim());
  out.averagesVisible =
    box($('#results-averages')).bottom <= box(opane).bottom + 1;
  out.pageOverflowX = document.documentElement.scrollWidth - innerWidth;
  out.drawerShut = $('#history-drawer').classList.contains('is-collapsed');
  out.drawerH = box($('#history-drawer')).h;
  return out;
})()
```

Per case, first set the state, then measure:

```js
// clear, add `rows` processes, optionally pick an algorithm, run, set drawer
$('#clear-all').click();
for (let i = 1; i <= rows; i++) {
  $('#pid').value = 'P' + i;
  $('#arrival-time').value = i % 4;
  $('#burst-time').value = burstOf(i);
  $('#priority').value = i % 5;
  $('#process-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}
if (algorithm !== 'fcfs') {
  $('#algorithm').value = algorithm;
  $('#algorithm').dispatchEvent(new Event('change', { bubbles: true }));
}
$('#run-simulation').click();
const drawer = $('#history-drawer');
if (drawer.classList.contains('is-collapsed') !== shut) $('#history-toggle').click();
```

Set the drawer state explicitly on every case; a click from the previous case
otherwise persists into the next one.

Assertions, applied only where the viewport is 1024px or wider:

| Assertion | Rule |
|---|---|
| `toolbarPresent` | true (fails on every case until Task 2) |
| `toolbarOnScreen` | true |
| `toolbarBox.h` | between 56 and 72 |
| `toolbarOverflowsX` | false |
| `controlsInsidePane`, `runInsidePane` | both false |
| `leftPaneOverflow` | 0, except case K where any value is allowed |
| `formVisible` | true |
| `firstRowVisible`, `processHeaderVisible` | true when the case has rows |
| `outputPaneOverflow` | 0, except cases K and J |
| `resultsOverflowX` | 0 |
| `resultsColsCut` | empty |
| `averagesVisible` | true |
| `pageOverflowX` | 0 |

Matrix (rows, algorithm, viewport, drawer):

| Case | Rows | Algorithm | Viewport | Drawer |
|---|---|---|---|---|
| A | 6 | fcfs | 1024x768 | open |
| B | 6 | fcfs | 1024x768 | shut |
| C | 6 | fcfs | 1280x800 | open |
| D | 6 | fcfs | 1440x900 | open |
| E | 20 | fcfs | 1440x900 | open |
| F | 20 | fcfs | 1920x1080 | open |
| G | 20 | fcfs | 1024x768 | open |
| H | 6 | rr | 1024x768 | open |
| I | 6 | srtf | 1024x768 | open |
| J | 0 | fcfs | 1024x768 | open |
| K | 6 | fcfs | 1024x620 | open |
| L | 1 | fcfs | 1440x900 | open |

`burstOf(i)` returns `(i % 6) + 1`, except for case L where process 1 gets burst
120 so completion times reach three digits.

- [ ] **Step 2: Run it and confirm it fails**

Run: `node tools/measure-layout.mjs` (from `cpu_scheduling_simulation`)
Expected: exit code 1, with `toolbarPresent` false and `controlsInsidePane` and
`runInsidePane` true on every case. That is the red state this plan removes.

- [ ] **Step 3: Commit**

```bash
cd C:/com_prog
git add -- cpu_scheduling_simulation/tools/measure-layout.mjs
git commit -m "test(ui): add a headless Chrome layout harness for the shell"
```

---

### Task 2: Move Controls into the shell

**Files:**
- Modify: `cpu_scheduling_simulation/index.html:24-70`
- Modify: `cpu_scheduling_simulation/styles.css:222-232`

**Interfaces:**
- Consumes: the harness from Task 1.
- Produces: `.panel--controls` as a direct child of `.app-shell`, first in
  document order, above `div.pane--setup`. Task 3 styles it; Task 4 resizes the
  drawer to make room for it.

- [ ] **Step 1: Move the section**

In `index.html`, cut the whole
`<section class="panel panel--controls" aria-labelledby="controls-heading">`
element (currently lines 28-70, inside `<div class="pane pane--setup">`) and
paste it immediately after `<main class="app-shell" id="main-content">`
(line 24), before `<div class="pane pane--setup">`. Change nothing inside the
element. `div.pane--setup` must keep its blank-line/indentation structure so the
remaining `panel--processes` section still reads as its single child.

- [ ] **Step 2: Add the grid row**

In the `@media (min-width: 1024px)` block that starts at `styles.css:214`, the
existing `.app-shell` rule has `grid-template-rows: minmax(0, 1fr) auto` and a
two-row `grid-template-areas`. Replace both declarations and append the new rule:

```css
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "controls controls controls"
      "setup    timeline output"
      "history  history  history";
```

```css
  .panel--controls { grid-area: controls; }
```

Place the new rule with the other `grid-area` assignments
(`.pane--setup`, `.pane--timeline`, `.pane--output`).

- [ ] **Step 3: Run the harness**

Run: `node tools/measure-layout.mjs`
Expected: `toolbarPresent`, `toolbarOnScreen`, `controlsInsidePane` false, and
`runInsidePane` false now pass. `toolbarBox.h` still fails (roughly 94px, the
stacked field layout). `outputPaneOverflow` fails on every case except B, F, and
J, because the stack is now taller than the pane by the toolbar's height. Those
are Tasks 3 and 4.

- [ ] **Step 4: Confirm the page still works**

Run: `node --test test_render.mjs test_scheduler.mjs` from
`cpu_scheduling_simulation`
Expected: `pass 4` and `pass 22`, zero failures.

- [ ] **Step 5: Commit**

```bash
cd C:/com_prog
git add -- cpu_scheduling_simulation/index.html cpu_scheduling_simulation/styles.css
git commit -m "refactor(ui): move the controls panel into a shell-level toolbar row"
```

---

### Task 3: Toolbar row layout

**Files:**
- Modify: `cpu_scheduling_simulation/styles.css` — new block after the Controls
  section, which ends at line 441 with `.status-badge--quiet`

**Interfaces:**
- Consumes: `.panel--controls` as a direct child of `.app-shell` (Task 2).
- Produces: a 60px single-row toolbar at 1024px and wider. No other task depends
  on the internal arrangement.

- [ ] **Step 1: Add the toolbar block**

Every rule lives inside `@media (min-width: 1024px)`, so narrow screens keep the
stacked panel:

```css
/* ---------- Controls toolbar ---------- */
/* At 1024px and wider the Controls section is a full-width toolbar row above
   the panes, so Run, Step, the algorithm and the scrubber never scroll away.
   Below 1024px it keeps its stacked panel layout. */
@media (min-width: 1024px) {
  .panel--controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3) var(--space-4);
    padding: var(--space-3) var(--space-4);
  }
  .panel--controls .panel__heading { margin-bottom: 0; }
  .panel--controls .fieldset {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .panel--controls .fieldset__legend { margin-bottom: 0; }
  .panel--controls .field {
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: 0;
  }
  .panel--controls .field__label { white-space: nowrap; }
  .panel--controls .field__control { width: auto; }
  .panel--controls .field:has(.scrubber) { flex: 1 1 10rem; }
  .panel--controls .scrubber { width: auto; flex: 1 1 8rem; }
  .panel--controls .readout { margin-top: 0; }
  .panel--controls .button-row { margin: 0; }
  .panel--controls .status-badge { margin-left: auto; }
  /* Standing next to the labelled field, the hint is redundant. Keep it in
     the accessibility tree for aria-describedby; drop it from the pixels. */
  .panel--controls .field__hint {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
}
```

`.field:has(.scrubber)` is the time field; `:has()` is already used at
`styles.css:356`. The hint is inside the time quantum field, which is hidden
unless Round Robin is selected.

- [ ] **Step 2: Run the harness**

Run: `node tools/measure-layout.mjs`
Expected: `toolbarBox.h` between 56 and 72 and `toolbarOverflowsX` false on every
case of 1024px and wider, including H (Round Robin, quantum field visible) and I
(SRTF, the longest option label). `outputPaneOverflow` still fails on A, C, and G.

- [ ] **Step 3: Check the toolbar visually**

Capture a screenshot at 1024x768 with the drawer expanded and read the toolbar:
the algorithm select, the time field, the four buttons, and the status badge on
one line, with the badge at the right end. Adjust only the flex values in Step 1
if something is misaligned; do not change the height.

- [ ] **Step 4: Commit**

```bash
cd C:/com_prog
git add -- cpu_scheduling_simulation/styles.css
git commit -m "feat(ui): lay the controls out as a single-row toolbar"
```

---

### Task 4: Pay for the toolbar with a shorter drawer

**Files:**
- Modify: `cpu_scheduling_simulation/styles.css:276-279`
- Modify: `cpu_scheduling_simulation/tools/measure-layout.mjs` — add the case K
  exception note (already specified) and the drawer-height assertion

**Interfaces:**
- Consumes: the 60px toolbar from Task 3.
- Produces: `outputPaneOverflow` of 0 on cases A, C, and G with the drawer open.

- [ ] **Step 1: Change the drawer height**

In the `@media (min-width: 1024px)` block at `styles.css:273`, the rule
`.drawer:not(.is-collapsed)` currently sets `height: 30vh; min-height: 180px`.
Change it to `height: 20vh; min-height: 160px`. Leave the comment above it
accurate: it pins height only while expanded.

- [ ] **Step 2: Assert the drawer height**

In the harness, add to the per-case assertions: when the drawer is open,
`drawerH` equals `max(0.2 * viewportHeight, 160)` within 2px. When shut, no
assertion.

- [ ] **Step 3: Run the harness**

Run: `node tools/measure-layout.mjs`
Expected: `outputPaneOverflow` 0 on every case except K (1024x620, where the pane
may scroll) and J (zero processes, where the results table has no rows). Case K
must still report `formVisible` true and `firstRowVisible` true, and must never
report a clipped toolbar (`toolbarOnScreen` true).

- [ ] **Step 4: Commit**

```bash
cd C:/com_prog
git add -- cpu_scheduling_simulation/styles.css cpu_scheduling_simulation/tools/measure-layout.mjs
git commit -m "fix(ui): shorten the history drawer to keep the panes from scrolling"
```

---

### Task 5: Pin the process list

**Files:**
- Modify: `cpu_scheduling_simulation/styles.css` — extend the block added in
  Task 3, or add a sibling block near the Processes panel

**Interfaces:**
- Consumes: the toolbar and drawer heights from Tasks 3 and 4.
- Produces: `.pane--setup` and the Processes panel laid out like the Results
  pane: heading and form fixed, only the row list scrolling.

- [ ] **Step 1: Add the Processes pane block**

```css
/* With the Controls toolbar gone, the left pane holds the Processes panel
   alone. Heading and form hold their place; only the rows scroll. */
@media (min-width: 1024px) {
  .panel--processes {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }
  .panel--processes > :not(.table-scroll) { flex: 0 0 auto; }
  .panel--processes > .table-scroll {
    flex: 1 1 auto;
    min-height: 4rem;
    overflow: auto;
  }
  #process-table thead th {
    position: sticky;
    top: 0;
    z-index: 1;
  }
}
```

The pane keeps `overflow: auto` from `.pane` at `styles.css:202`. Do not set
`overflow: hidden` anywhere.

- [ ] **Step 2: Run the harness**

Run: `node tools/measure-layout.mjs`
Expected: `leftPaneOverflow` 0 on A through L except K, `formVisible` true
everywhere, `firstRowVisible` and `processHeaderVisible` true wherever rows
exist (not J), and case L still reporting `resultsOverflowX` 0 and
`resultsColsCut` empty with three-digit metrics.

- [ ] **Step 3: Commit**

```bash
cd C:/com_prog
git add -- cpu_scheduling_simulation/styles.css
git commit -m "feat(ui): pin the process form and scroll only the process rows"
```

---

### Task 6: Full verification and handoff

**Files:**
- Modify: none, unless a defect is found

- [ ] **Step 1: Run both test files**

Run: `node --test test_render.mjs test_scheduler.mjs` from
`cpu_scheduling_simulation`
Expected: `pass 4`, `fail 0`, `pass 22`, `fail 0`.

- [ ] **Step 2: Run the whole harness once more**

Run: `node tools/measure-layout.mjs`
Expected: exit code 0. Case K's pane overflow is the only permitted deviation;
every assertion that K shares with the other cases must still hold there.

- [ ] **Step 3: Confirm keyboard order by hand**

Open the app in Chrome at 1024x768. Press Tab from the address bar and record the
order. Expected: theme toggle, then algorithm select, then the quantum input if
Round Robin is selected, then the time scrubber, then Run, Step, Reset, Clear,
then the process form's PID field. Confirm focus is visible on each stop. Report
the measured order rather than an assumption.

- [ ] **Step 4: Capture screenshots**

1024x768 with the drawer expanded, 6 rows, and 1440x900 with 20 rows. Read both
and confirm: the toolbar is one row above the panes, the process form is visible
with rows below it, the results averages and all five columns are visible, and
nothing looks clipped.

- [ ] **Step 5: Report**

State the measured evidence: test counts, harness exit code, the keyboard order
you actually observed, and any case that did not meet its assertion. Name the
limits as limits: `jsdom` cannot verify CSS layout, so the harness and the
screenshots are the evidence, and `position: sticky` behavior is only proven in
a real browser.
