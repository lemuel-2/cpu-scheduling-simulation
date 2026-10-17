# Agent prompt — JavaScript programmer

You are a JavaScript developer working on a CPU scheduling simulator. The code is
plain ES modules, no framework. `engine.js` is pure scheduling logic (importable in
Node); `app.js` is the UI layer that imports from `engine.js`.

## Your task

Make the ready queue observable. Today `run()` calls `Simulation.run()`, which
advances every tick synchronously to completion, then renders once — so by the time
the queue is rendered it is empty. Record the ready-queue history and add a time
cursor so the Ready queue, Gantt chart, and Results table all render "as of time t".

## Files you own — edit ONLY these

- `engine.js`
- `app.js`
- `test_scheduler.mjs`

Do NOT edit `index.html` or `styles.css`. Another agent owns those and is building
the exact DOM elements below. Build to the frozen contract.

## Authoritative design

`docs/superpowers/specs/2026-10-16-queue-history-design.md` — read it. Section 11
is the frozen contract; sections 5–9 define the data model, cursor, rendering, and
state transitions; section 13 is your workstream.

## Approach: record and replay

Whenever a `Simulation` is built, run it once (instant) to fill a bounded history;
a `cursor` then navigates that history, and every view renders from
`stateAt(cursor)`.

### 1. engine.js — record history

`Simulation` records `history`: one **frame** per maximal run of ticks with an
identical `(running, ready, completed)` triple.

Frame:

```
{ start, end, running, ready, completed, event, pid }
```

- `start` inclusive tick, `end` exclusive tick (covers ticks `start..end-1`).
- `running` — process index or `null` (CPU idle).
- `ready` — array of process indices, queue order.
- `completed` — number of processes completed so far.
- `event` — `'start' | 'arrive' | 'dispatch' | 'preempt' | 'quantum' | 'complete' | 'idle' | null`.
- `pid` — process id for the event, or `null`.

Frames cover ticks `0..time-1`, each exactly once. Consecutive frames with identical
triples MUST be merged. Memory must be O(number of scheduling changes), not O(time).

New API:

- `getHistory()` → `Frame[]`.
- `stateAt(t)` → `{ running, ready, completed }`:
  - `t = 0` → initial state (nothing running, empty ready, 0 completed).
  - `t > 0` → the frame covering tick `t-1`.
- `getTimeline()` and `getStats()` keep working unchanged.

Do not change scheduling results for FCFS, SJF, SRTF, Priority (non-preemptive), or
Round Robin. Existing tests must stay green.

### 2. app.js — time cursor and as-of-cursor rendering

Add `cursor` to state. On any (re)build of the sim: `run()` it, set cursor = 0
(except `Run`, which sets cursor = end).

- `Run` → build+run sim, cursor = end.
- `Step` → build+run sim if needed, then cursor + 1 (clamped to `sim.time`).
- Scrubber `input` → cursor = value.
- Click on `[data-time]` → cursor = that time.
- `Reset` → keep sim, cursor = 0.
- Add/delete process, algorithm or quantum change, `Clear` → rebuild sim, cursor 0,
  clear history.

Render everything from `stateAt(cursor)`:

- **Queue panel:** `#running-process` = running pid (or empty); `#ready-queue` =
  ready list only (the running process must no longer appear in the ready queue).
- **Gantt:** draw only segments with `end <= cursor`; truncate the segment spanning
  the cursor at `cursor` and add class `gantt__slice--partial` to it.
- **Results table:** show a process's metrics only when
  `completion !== null && completion <= cursor`; otherwise `–`. Averages over shown.
- **Status badge:** cursor 0 → `Idle`; `0 < cursor < end` → `t = N`; cursor = end → `Finished`.

### 3. History panel rendering

- Frames view (`#history-frames-body`): one row per frame —
  `Time` (range, e.g. `3–4`), `Running`, `Ready queue`, `Event`. Each row has class
  `history__row` and `data-time` = frame `start`.
- Events view (`#history-events`): one `<li>` per frame with `event != null` —
  `t | event | pid`. Each item has `data-time`.
- Toggles `#history-view-frames` / `#history-view-events`: switch the two views
  (`#history-frames-view` / `#history-events-view`) with `.is-hidden`, and update
  each button's `aria-pressed`.
- Show `#history-empty` when there is no history.

### 4. Scrubber wiring

- `#time-scrubber`: set `max` = sim end time, `value` = cursor; on `input` set cursor.
- `#time-readout`: show the current time; set `#time-scrubber` `aria-valuetext` to
  `time N, running Px` or `time N, idle`.

## Frozen DOM contract (provided by the HTML/CSS agent)

Ids you read/write: `history-frames-body`, `history-frames-view`,
`history-view-frames`, `history-events`, `history-events-view`,
`history-view-events`, `history-empty`, `time-scrubber`, `time-readout`,
`running-process`.

Classes you set: `.is-hidden`, `.history__row` (with `data-time`),
`.gantt__slice--partial`, `.queue__item--running`.

ARIA you write: `aria-valuetext` on `#time-scrubber`, `aria-pressed` on the two
toggle buttons.

Guard DOM access like the existing `setFieldError`: if a hook is missing, fail soft,
never throw.

## Testing (extend test_scheduler.mjs, node:test)

- Frames are contiguous and cover ticks `0..time-1` exactly once; `stateAt(0)` is
  the initial state.
- Consecutive identical triples are merged.
- `stateAt(t)` equals replaying `t` `step()` calls for all `t`, across all
  algorithms (fuzz).
- Events are tagged at the correct ticks.
- All existing tests stay green.

If a headless/jsdom harness is available, also verify: after `Run`, moving the
scrubber shows a non-empty ready queue, and `Step` equals `cursor + 1`.

## Optional (only if trivial while in app.js)

`run()` currently ignores the return value of `Simulation.run()`; surface an error
if it did not complete.

## Do not

- Touch `index.html` or `styles.css`.
- Change scheduling results.
