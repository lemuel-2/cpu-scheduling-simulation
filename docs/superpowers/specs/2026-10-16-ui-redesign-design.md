# UI Redesign — App-shell Layout with History Drawer

Date: 2026-10-16
Status: Draft (awaiting review)
Relationship: Umbrella spec. It reuses the engine data model from
`2026-10-16-queue-history-design.md` (history frames, `getHistory()`,
`stateAt(t)`) and supersedes that document's UI section (panel placement, shell).

## 1. Context

The simulator currently renders five equal panels in a two-column grid that grows
down the page. Three problems motivated this redesign:

1. Panels scroll out of view; the Gantt and the ready queue are rarely visible
   together.
2. The ready queue is effectively invisible because `Run` executes synchronously
   (the queue-history feature fixes the data side; this spec fixes the space side).
3. On narrow screens the page scrolls horizontally (known FE-006).

Audience: a **learning/teaching demo** on wide screens — the Gantt and the
step-through timeline are the centerpiece.

## 2. Goal

A single-viewport, three-column application shell that keeps the timeline, the
current state, and the metrics on screen at once, with a pinned History drawer.

Success criteria:

- On a normal desktop viewport the whole app fits without page scroll.
- Gantt, ready queue, and results are simultaneously visible.
- The page never scrolls horizontally at 360 / 768 / 1280 px.
- All existing features and engine behavior are unchanged.

## 3. Non-goals (YAGNI)

- Auto-play / animation.
- Resizable/draggable panes (fixed proportions).
- Routing or multiple pages.
- Framework or build step.

## 4. Constraints (fixed)

- Vanilla HTML/CSS/JS, ES modules, no framework, no build step.
- Single page.
- Keep the monochrome / typography-driven design language (Geist, halftone,
  light/dark).
- Keep the light/dark toggle with persistence.
- WCAG AA required (focus visible, keyboard, contrast, aria-live).
- Wide-screen first; narrow screens must not break.

## 5. Layout

Fixed app-shell using CSS grid.

```
┌───────────────────────────────────────────────────────────────┐
│ header: title · theme toggle                       (sticky)    │
├───────────────┬───────────────────────────────┬───────────────┤
│ Setup         │ Timeline                      │ Output        │
│ (fixed ~320px)│ (flexible, largest)           │ (fixed ~340px)│
│               │                               │               │
│ Controls      │ Gantt (hero)                  │ Running       │
│ Processes     │ Scrubber (playhead, readout)  │ Ready queue   │
│ Add process   │                               │ Results + avg │
├───────────────┴───────────────────────────────┴───────────────┤
│ History drawer (full width, pinned, collapsible)              │
│ toggle Frames | Events            collapse ▾                  │
│ body: frames table or events list                             │
└───────────────────────────────────────────────────────────────┘
```

- Header stays at the top (sticky).
- The three columns fill the remaining height; **each pane scrolls internally**.
- The History drawer is pinned at the bottom and collapsible; when expanded it takes
  a bounded height (default ~30vh, min ~180px) and its body scrolls internally.
- Overall: no page scroll on a wide desktop viewport; no horizontal scroll ever.

Column sizing: `grid-template-columns: minmax(280px, 320px) minmax(0, 1fr) minmax(300px, 360px)`.

Default drawer state: **expanded**; default view: **Frames**.

## 6. Panes

### Setup (left)
- Controls: algorithm select, quantum (Round Robin only), Run / Step / Reset /
  Clear buttons, status badge.
- Processes table + Add-process form.

### Timeline (center)
- Gantt chart (full pane width).
- Timeline scrubber: range input with a playhead and a `t = N / end` readout.
  Arrow keys change the cursor. No autoplay.

### Output (right)
- Ready queue: the running process shown **separately**, then ready chips.
- Results table with averages.

### History drawer (bottom)
- Header: `Frames | Events` toggle + a collapse control.
- Frames view: table `Time range | Running | Ready queue | Event`, one row per
  merged frame.
- Events view: list `t | event | pid`.
- Clicking a row sets the cursor.

## 7. Time cursor (behavior — inherited from the history spec)

`cursor` drives all three panes and the drawer. `stateAt(cursor)` provides the
queue state; the Gantt shows segments with `end <= cursor` (last truncated and
marked `gantt__slice--partial`); Results show metrics only when
`completion <= cursor`; the scrubber and readout mirror the cursor. Full rules:
`2026-10-16-queue-history-design.md` §6–§9.

## 8. Responsive

- `>= 1024px`: the three-column app-shell above.
- `< 1024px`: collapses to a single column; the History drawer becomes an inline
  section rather than pinned; the page may scroll vertically.
- `< 480px`: no horizontal scroll (fixes FE-006 — the algorithm `<select>` must not
  size to its longest option).

## 9. Accessibility

- The shell exposes landmark regions; each pane has a heading.
- The drawer collapse control is a `<button aria-expanded>`.
- Focus stays visible throughout; the scrubber has a label and `aria-valuetext`.
- Only the time readout is `aria-live` (avoid chatty live regions).
- Contrast: small text meets 4.5:1 (fixes FE-001 — replace `--gray-400` on light
  with `--gray-600` for small text).
- No meaning by color alone.

## 10. Frozen interface contract

Both workstreams build to this. It is the only seam between them.

### DOM — new / changed elements (ids)

| Id | Purpose |
|---|---|
| `main-content` | the app-shell grid (existing `<main>`, reclassed) |
| `history-drawer` | the bottom History drawer section |
| `history-toggle` | collapse/expand button (`aria-expanded`) |
| `time-scrubber` | range input for the cursor |
| `time-readout` | numeric cursor readout |
| `running-process` | running-process display in the Output pane |
| `history-view-frames` | Frames view toggle button |
| `history-view-events` | Events view toggle button |
| `history-frames-view` | frames view container |
| `history-frames-body` | frames `<tbody>` |
| `history-events-view` | events view container |
| `history-events` | events `<ol>` |
| `history-empty` | drawer empty state |

All existing ids stay unchanged: `algorithm`, `time-quantum`, `run-simulation`,
`step-simulation`, `reset-simulation`, `clear-all`, `simulation-status`,
`process-form`, `pid`, `arrival-time`, `burst-time`, `priority`, `add-process`,
`process-table`, `process-table-body`, `process-empty`, `gantt-chart`,
`gantt-track`, `gantt-bars`, `gantt-legend`, `gantt-empty`, `ready-queue`,
`queue-empty`, `results-table`, `results-table-body`, `avg-completion`,
`avg-turnaround`, `avg-waiting`, `avg-response`, `results-summary`, `theme-toggle`,
`theme-toggle-label`.

### DOM — class hooks (JS sets, CSS styles)

| Class | Meaning |
|---|---|
| `app-shell` | the grid container |
| `pane` | a framed pane |
| `pane--setup` / `pane--timeline` / `pane--output` | pane modifiers |
| `drawer` / `drawer__body` | History drawer and its scroll body |
| `is-collapsed` | drawer collapsed state |
| `is-hidden` | hidden utility (exists) |
| `history__row` | clickable row (has `data-time`) |
| `history__toggle` | Frames/Events toggle buttons |
| `running` | running-process badge |
| `queue__item--running` | ready item that is also running (optional) |
| `gantt__slice--partial` | Gantt bar truncated at the cursor |
| `scrubber` / `readout` | scrubber and readout |

### DOM — ARIA (JS writes)

- `aria-valuetext` on `#time-scrubber`.
- `aria-pressed` on `#history-view-frames` / `#history-view-events`.
- `aria-expanded` on `#history-toggle`.

### Data hooks

- `data-time="<t>"` on any element that sets the cursor.

### Engine

Unchanged from the history spec: `getHistory()`, `stateAt(t)`, plus existing
`getTimeline()`, `getStats()`, `getQueueIndices()`.

## 11. Workstream A — HTML + CSS

Owns `index.html`, `styles.css`. Does not edit JavaScript.

- Restructure `index.html` into the app-shell: header, three panes, History drawer.
- Provide every id/class in §10 with a static skeleton and empty states.
- Fix the algorithm `<select>` overflow: `.field__control { width: 100%; min-width: 0; }`.
- Light-theme contrast: use `--gray-600` for small text.
- Keep `prefers-reduced-motion` handling.

## 12. Workstream B — JavaScript

Owns `engine.js`, `app.js`, `test_scheduler.mjs`. Does not edit `index.html`/`styles.css`.

- Engine history + `stateAt(t)` (§7 / history spec §5).
- Cursor state, as-of-cursor rendering of Gantt / queue / results / status.
- Drawer rendering (frames + events), toggle, collapse (`aria-expanded`).
- Scrubber wiring and two-way sync; `data-time` click handling.
- Guard missing DOM hooks (fail soft, never throw).
- Tests per §14. Preserve all scheduling results.

## 13. Sequencing

1. Freeze this contract.
2. Workstream A and B proceed in parallel against the frozen ids/classes.
3. Integration pass verifies the seam (every id JS reads exists; every hook HTML
   exposes is used).

## 14. Testing and acceptance

- Engine: as in the history spec §14 (contiguity, merging, `stateAt` == replay, fuzz).
- Integration: after `Run`, scrubbing shows a non-empty ready queue; `Step` ==
  `cursor + 1`; Gantt/queue/results agree at every cursor.
- A/C: at 1280px the app fits with no page scroll; at 360px no horizontal scroll;
  drawer collapses with `aria-expanded` toggling; all ids present; contrast passes.
- Existing tests stay green.

## 15. Risks

- **App-shell height math.** `100vh` + sticky header + pinned drawer can overflow if
  the pieces don't subtract correctly; use grid/flex tracks (`minmax(0,1fr)`,
  `min-height:0`) rather than hard `calc` where possible.
- **Seam drift.** Mitigated by freezing §10 and guarding DOM access in JS.
- **Narrow-screen drawer.** Below the breakpoint the pinned drawer must switch to
  inline or content becomes unreachable; §8 makes this explicit.
