# Queue History & Time Scrubber — Design

Date: 2026-10-16
Status: Data model authoritative; UI section superseded by
`2026-10-16-ui-redesign-design.md` (history now lives in a bottom drawer).

## 1. Context and problem

The CPU scheduling simulator renders a "Ready queue" panel, but in normal use it
is always empty. Root cause: `app.js` `run()` calls `Simulation.run()`, which
advances every tick synchronously to completion, then renders once. By render time
`current === null` and `ready === []`, so `getQueueIndices()` returns `[]`. The
queue is only ever populated transiently when the user clicks **Step** one tick at
a time. There is no way to observe how the ready queue evolves.

## 2. Goal

Make the ready queue observable. Record its evolution during scheduling and add a
time cursor so the Ready queue, Gantt chart, and Results table all render
"as of time t".

Success criteria:

- After **Run**, the user can move the cursor back and see a populated ready queue
  at any tick.
- The Gantt, queue, and results are mutually consistent at every cursor position.
- Engine scheduling results are unchanged for all five algorithms.
- Engine history is memory-bounded (O(number of scheduling changes), not O(time)).

## 3. Non-goals (YAGNI)

- Auto-play / animation.
- Editing or exporting history.
- Expanding merged frames into one row per tick.
- Any change to the scheduling algorithms' results.

## 4. Approach

Chosen: **record and replay.**

The running simulation is the default timeline boundary, but the simulator becomes
an _observation_ concern on top of it: whenever a `Simulation` exists, it is run
once (instant) to fill a bounded history; a `cursor` then navigates that history and
every view renders from `stateAt(cursor)`.

Alternatives rejected:

- **Re-run on scrub** — store inputs only, rebuild the sim to view time `t`.
  O(t) per scrub, laggy, re-triggers the existing freeze risk. Rejected.
- **Snapshot every tick** — store the queue each time unit. Simplest code but
  O(time) memory; a large-burst process produces that many rows. Rejected.

## 5. Data model (`engine.js`)

`Simulation` records `history`: one **frame** per maximal run of ticks with an
identical `(running, ready, completed)` triple.

Frame:

```
{ start, end, running, ready, completed, event, pid }
```

- `start` inclusive tick; `end` exclusive tick (frame covers ticks `start..end-1`).
- `running` — process index or `null` (CPU idle).
- `ready` — array of process indices in queue order.
- `completed` — number of processes completed so far.
- `event` — one of `start | arrive | dispatch | preempt | quantum | complete | idle | null`.
- `pid` — process id for the event, or `null`.

Frames cover ticks `0 .. time-1`, each tick exactly once (tick `n` sits in the
frame whose `[start, end)` contains `n`). Consecutive frames with identical triples
MUST be merged. Memory is therefore proportional to the number of scheduling
changes.

Engine API (added/changed):

- `getHistory()` → `Frame[]`.
- `stateAt(t)` → `{ running, ready, completed }` for cursor `t` in `0..time`.
- `getTimeline()` and `getStats()` continue to work as today.

## 6. Time cursor semantics

- Cursor `t` = system state **after** tick `t`.
- Cursor `0` = before any tick has executed (nothing admitted, nothing running);
  it is the initial state, not part of any frame.
- For `t > 0`, `stateAt(t)` returns the frame covering tick `t-1`.
- Valid range: `0..sim.time` (a `stateAt` call is only meaningful within range).

## 7. Rendering as-of-cursor (`app.js`)

All three views render from `stateAt(cursor)`:

- **Ready queue panel** — `#running-process` shows the running pid (or empty);
  `#ready-queue` lists the ready processes only. This also corrects the earlier
  semantics where the running process appeared inside the ready queue.
- **Gantt** — only segments with `end <= cursor` are drawn; the segment spanning the
  cursor is truncated at `cursor` and marked with class `gantt__slice--partial`.
- **Results table** — a process shows its metrics only when
  `completion !== null && completion <= cursor`; otherwise `–`. Averages are
  computed over the shown rows.
- **Status badge** — cursor `0` → `Idle`; `0 < cursor < end` → `t = N`;
  cursor `= end` → `Finished`.

## 8. UI additions

### Queue history panel

New `panel--history` section with a two-view toggle:

- **Frames** — table: `Time range | Running | Ready queue | Event`, one row per
  merged frame. Rows carry class `history__row` and `data-time` = frame `start`.
- **Events** — list: `t | event | pid`, one item per frame where `event != null`.
  Items carry `data-time`.

Toggle buttons `#history-view-frames` / `#history-view-events` switch views with
`.is-hidden` and update `aria-pressed`.

Clicking any element with `data-time` sets the cursor to that time and syncs all
views and the scrubber.

### Time scrubber

A range input in the Controls panel plus a numeric readout. Range `0..endTime`,
value = cursor. Arrow keys move time. The readout reflects the cursor and sets the
scrubber's `aria-valuetext` (`time N, running Px` / `time N, idle`).

## 9. State transitions

| Action | Effect |
|---|---|
| Add / delete process | rebuild sim, cursor 0, clear history |
| Change algorithm or quantum | rebuild sim, cursor 0, clear history |
| Clear | clear processes, rebuild, cursor 0 |
| Run | build+run sim, cursor = end |
| Step | cursor + 1 (clamped), building+running sim first if needed |
| Scrubber input | cursor = value (≤ sim.time) |
| Click `[data-time]` | cursor = that time |
| Reset | keep sim, cursor 0 |

## 10. Accessibility

- History frames table: `<caption>` + `<th scope>`.
- Scrubber: `<label for>` and `aria-valuetext`; only `#time-readout` is `aria-live`.
- Toggle buttons expose `aria-pressed`.
- Focus is visible on toggles, scrubber, and clickable history rows.
- No meaning conveyed by color alone.
- Small text must meet WCAG AA (4.5:1); see the contrast note in Workstream A.

## 11. Frozen interface contract

Both workstreams build to this. It is the only seam between them.

### DOM — elements (ids)

| Id | Purpose |
|---|---|
| `history-heading` | panel heading reference |
| `history-view-frames` | toggle button for the frames view |
| `history-view-events` | toggle button for the events view |
| `history-frames-view` | container of the frames table |
| `history-frames-body` | `<tbody>` for frame rows |
| `history-events-view` | container of the events list |
| `history-events` | `<ol>` for event items |
| `history-empty` | empty-state message |
| `running-process` | running-process display in the queue panel |
| `time-scrubber` | range input for the cursor |
| `time-readout` | numeric cursor readout |

### DOM — class hooks (JS sets, CSS styles)

| Class | Meaning |
|---|---|
| `is-hidden` | hidden utility (exists) |
| `history__row` | clickable history row (has `data-time`) |
| `history__toggle` | the two view-toggle buttons |
| `running` | running-process badge |
| `queue__item--running` | ready item that is also running (optional) |
| `gantt__slice--partial` | Gantt bar truncated at the cursor |
| `scrubber` | the range input |
| `readout` | the numeric readout |

### DOM — ARIA (JS writes)

- `aria-valuetext` on `#time-scrubber`.
- `aria-pressed` on `#history-view-frames` and `#history-view-events`.

### Data hooks

- `data-time="<t>"` on any clickable element that sets the cursor.

### Engine (JS-internal, not DOM)

- `getHistory()`, `stateAt(t)`.

## 12. Workstream A — HTML + CSS

Owns `index.html`, `styles.css`. Does not edit JavaScript.

Deliverables:

- Markup for the Queue history panel (toggle, frames table, events list, empty
  state), the `#running-process` element in the queue panel, and the scrubber field
  in Controls — all ids/classes per §11.
- Styles for history table, events list, toggle buttons, scrubber, readout, running
  badge, and the partial Gantt bar, in the existing monochrome design language.
- Repository scrolls: the history table and events list scroll inside their
  container; no horizontal page scroll at 360 / 768 / 1280 px.
- Fix known mobile overflow (FE-006): the algorithm `<select>` sizes to its longest
  option and overflows the page at 360px. Apply
  `.field__control { width: 100%; min-width: 0; }`.
- Fix light-theme contrast (FE-001): `--gray-400 #a3a3a3` on white is 2.52:1 and
  fails AA. Use `--gray-600` for small text (labels, hints, empty states, Gantt
  ticks, table captions/headers).
- Preserve `prefers-reduced-motion` handling.

## 13. Workstream B — JavaScript

Owns `engine.js`, `app.js`, `test_scheduler.mjs`. Does not edit `index.html` or
`styles.css`.

Deliverables:

- Engine history recording and merging; `getHistory()`; `stateAt(t)` (§5).
- Cursor state and as-of-cursor rendering of queue, Gantt, results, status (§6, §7).
- History panel rendering and event log (§8).
- Scrubber wiring and two-way sync (§8).
- Resilient DOM access: guard a missing element like the existing `setFieldError`
  (fail soft; never throw if a hook is absent).
- Tests (§14).

## 14. Testing and acceptance

Engine (`test_scheduler.mjs`, `node:test`):

- Frames are contiguous and cover ticks `0 .. time-1` exactly once; `stateAt(0)`
  returns the initial (pre-tick) state.
- Consecutive identical triples are merged.
- `stateAt(t)` equals replaying `t` `step()` calls, for all `t`, across all
  algorithms (fuzz).
- Events are tagged at the correct ticks.

Integration:

- After `Run`, moving the scrubber shows a **non-empty** ready queue for
  `0 < cursor < end` (this is the reported symptom).
- `Step` advances exactly one tick and equals `cursor + 1`.
- Gantt, queue, and results agree at every cursor position.
- All existing tests stay green; engine results unchanged.

Workstream A acceptance:

- New panel present with empty states; all ids/classes exist; no horizontal page
  scroll at 360 / 768 / 1280 px; contrast passes for new and corrected text.

## 15. Sequencing

1. Freeze this contract (this document).
2. Workstreams A and B proceed in parallel against the frozen ids/classes.
3. Integration pass verifies the seam: every id JS reads exists in the HTML, and
   every hook the HTML exposes is used.

## 16. Risks and open questions

- **Memory bound.** History size is bounded by the existing tick bound, but a very
  large burst still creates many frames. Acceptable for the target use; a hard cap
  is deferred (ties to the known BUG-001/002 numeric-input issue, out of scope here).
- **Seam drift.** If either workstream renames an id/class, integration breaks.
  Mitigated by freezing §11 and guarding DOM access in JS.
