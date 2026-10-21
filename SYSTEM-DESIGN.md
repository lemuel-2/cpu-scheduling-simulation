# CPU Scheduling Simulator — System Design

As-built description of the current system. No proposed changes.

## 1. Purpose and scope

Interactive CPU scheduling simulator for five algorithms: FCFS, SJF, SRTF,
non-preemptive Priority, and Round Robin. The user enters processes, picks an
algorithm, and inspects the resulting schedule as a Gantt chart, per-process
lanes, a ready-queue view, a metrics table, and a queue history.

Time is discrete. One tick advances the clock by exactly one unit. All
scheduling decisions, metrics, and visuals are derived from that tick model.

Out of scope: backend, persistence of processes, real CPU measurement, and
multi-core scheduling.

## 2. Architecture

Three layers, no build step, no runtime dependencies:

- Markup: `index.html`
- Presentation and UI state: `frontend/styles.css`, `frontend/app.js`
- Scheduling logic: `logic/engine.js` (pure, DOM-free, Node-importable)

Supporting files:

- `tests/test_scheduler.mjs` — engine behaviour and metrics.
- `tests/test_render.mjs` — pure render helpers exported by `frontend/app.js`.
- `tools/measure-layout.mjs` — headless-Chrome layout harness.
- `docs/superpowers/specs/`, `docs/superpowers/plans/` — earlier design and
  implementation records.

Dependency direction is one-way: `app.js` imports `engine.js`. The engine never
imports UI code and never touches the DOM, timers, or storage. Tests import the
same modules directly.

The page loads `frontend/app.js` as an ES module, so it must be served over
HTTP. `file://` fails on module origin rules. The README describes running it
with the VS Code Live Preview extension, which serves the folder over
`localhost`.

## 3. Components

### 3.1 `Simulation` (logic/engine.js)

Owns all simulation state and exposes:

- `new Simulation(processes, { algorithm, quantum })` — clones and clamps input,
  precomputes arrival order.
- `step()` — advance one tick.
- `run()` — step until done or the tick bound is hit; returns `isDone`.
- `getTimeline()` — merged run segments for Gantt rendering.
- `getHistory()` — merged state frames.
- `getQueueIndices()` — running process first, then ready queue.
- `getStats()` — per-process completion, turnaround, waiting, response.
- `stateAt(t)` — state observable at time `t`.
- `isDone` — getter, `completed === processes.length`.

State fields:

| Field | Meaning |
|---|---|
| `algorithm`, `quantum`, `preemptive` | Run configuration; `preemptive` is true only for SRTF |
| `processes` | Cloned processes plus `index`, `remaining`, `start`, `completion`, `quantumUsed` |
| `time` | Next tick to execute; starts at 0 |
| `current` | Index of running process, or `null` when idle |
| `ready` | Indices waiting for the CPU, in admission order |
| `timeline` | Merged `{ pid, start, end }` segments |
| `history` | Merged `{ start, end, running, ready, completed, event, pid }` frames |
| `completed` | Count of finished processes |
| `arrivalOrder`, `arrivalCursor` | Processes sorted by arrival once, plus admission cursor |

### 3.2 UI state (frontend/app.js)

`initUI()` builds one state object:

- `processes` — validated `{ id, arrival, burst, priority }` records.
- `algorithm`, `quantum` — current selection.
- `sim` — `Simulation | null`.
- `cursor` — time currently shown, `0..sim.time`.
- `historyView` — `"frames"` or `"events"`.

The UI renders from the engine's read-only outputs; it does not reimplement
scheduling.

### 3.3 Render helpers (frontend/app.js, exported)

Pure functions, tested without a DOM:

- `buildSlices(timeline)` — timeline plus idle gaps, as contiguous slices.
- `cursorSlices(timeline, cursor)` — slices truncated at the cursor, including
  leading and interior idle.
- `laneRows(timeline, processes, cursor)` — one row per process, bar geometry as
  fractions of the whole run, truncated at the cursor.
- `laneReadout(pid, runs, total, stat)` — hover text; collapses many runs.
- `axisTicks(total, max = 8)` — round tick positions.
- `statusForCursor(cursor, end)` — `idle`, `running`, or `finished` badge state.
- `visibleResults(stats, cursor)` — processes complete at or before the cursor.
- `historyFrameRows(history, processes)` — frame rows with PIDs resolved.

### 3.4 Markup and styling

`index.html` provides panels for controls, process entry and table, Gantt chart,
per-process lanes, ready queue, results, and a collapsible queue-history drawer.
Elements are addressed by stable IDs; `app.js` guards optional elements with
null checks.

`frontend/styles.css` owns layout, the eight process colour slots, lane
geometry, dark/light theme tokens, and responsive behaviour.

## 4. Data model

Process record as stored in the engine:

```
{ id, arrival, burst, priority, index, remaining, start, completion, quantumUsed }
```

- `id` — user-supplied or generated `P1`, `P2`, ...; duplicate check is
  case-insensitive.
- `arrival`, `burst`, `priority` — clamped integers in `[0, MAX_VALUE]`, burst
  at least 1.
- `index` — original position, used as identity and final tie-break.
- `remaining` — ticks still owed, starts at `burst`.
- `start` — first tick the process ran; `null` until dispatched.
- `completion` — tick after the last tick it ran; `null` until finished.
- `quantumUsed` — consecutive ticks in the current Round Robin slice.

Timeline segment: `{ pid, start, end }`, half-open `[start, end)`. Segments for
the same process merging only when contiguous.

History frame: `{ start, end, running, ready, completed, event, pid }`, half-open
`[start, end)`, one per state change. `ready` is a snapshot copy. `event` is one
display label per frame; `pid` is the process the label refers to.

## 5. Scheduling model

Every algorithm uses the same tick loop. Only the pick rule and preemption rule
differ.

Per tick, in order:

1. Admit arrivals: walk `arrivalOrder` from `arrivalCursor`; every process with
   `arrival <= time` joins `ready`. Total admission work across a run is O(n).
2. Schedule:
   - Idle CPU: pick the algorithm's best ready process, remove it from `ready`,
     reset `quantumUsed`, make it `current`.
   - Busy CPU: only SRTF reconsiders. It preempts when a ready process is
     strictly better than `current` by remaining time (ties by arrival, then
     index). The old process returns to the tail of `ready`.
3. Run one tick: set `start` on first dispatch, decrement `remaining`, increment
   `quantumUsed`, merge a timeline segment.
4. On completion (`remaining === 0`): set `completion = time + 1`, increment
   `completed`, clear `current`, label `complete`.
5. On Round Robin quantum expiry (`quantumUsed >= quantum`): reset
   `quantumUsed`, requeue at the tail, clear `current`, label `quantum`.
6. Label otherwise, first match wins: `preempt`, `dispatch`, `arrive`, `idle`, or
   none.
7. Record or merge a history frame, then increment `time`.

Algorithm pick rules:

| Algorithm | Key | Preemptive |
|---|---|---|
| FCFS | none — ready-queue order | no |
| SJF | full `burst` | no |
| SRTF | `remaining` | yes, every tick |
| Priority | `priority`, lower wins | no |
| Round Robin | none — ready-queue order | no; requeue on quantum expiry |

Tie-break chain for keyed algorithms: smaller key, then earlier arrival, then
lower `index`. The chain is total, so results are deterministic.

Merging rules keep output small: contiguous same-PID timeline segments merge and
identical `(running, ready, completed)` history states merge. A merged frame
keeps the first event and PID it was created with.

## 6. Data flow

### Add or delete process

Form submit -> `validateProcess(raw, processes)` -> on error, per-field messages
and focus; on success, push record -> `rebuild()` -> new `Simulation` ->
`sim.run()` -> cursor reset to 0 -> re-render table and outputs.

Delete follows the same rebuild path with the record removed. Clear empties the
list and drops the simulation.

### Algorithm or quantum change

Change handler updates state, shows or hides the quantum field, rebuilds the
simulation from scratch, and re-renders. Round Robin uses `quantum`, minimum 1;
the field snaps back to a valid value on blur or Enter.

### Run, Step, Reset

The simulation is precomputed: `buildSimulation()` constructs and calls `run()`
as soon as processes or configuration change. Controls only move the cursor.

- Run: cursor = `sim.time`.
- Step: cursor = `min(cursor + 1, sim.time)`.
- Reset: cursor = 0, processes and simulation kept.
- Clear: processes removed, simulation dropped.

All four refuse to act when the process list is empty, showing a form error and
an error status.

### Scrub and inspect

The range input calls `setCursor`, which clamps to `[0, sim.time]` and re-renders.
`renderOutputs()` redraws Gantt, lanes, queue, results, history, scrubber, and
status. `stateAt(cursor)` supplies the queue and running process for the shown
time. History rows and event items carry `data-time`; click or Enter/Space jumps
the cursor there.

### Rendering data sources

| View | Source |
|---|---|
| Gantt bars | `cursorSlices(sim.getTimeline(), cursor)` |
| Legend and lanes | `sim.getTimeline()`, `state.processes`, `cursor` |
| Ready queue | `sim.stateAt(cursor)` |
| Results and averages | `sim.getStats()`, filtered by `visibleResults` |
| History frames and events | `sim.getHistory()` |
| Scrubber bounds | `sim.time` |
| Status badge | `statusForCursor(cursor, sim.time)` |

## 7. Invariants and limits

- `MAX_VALUE = 100000` caps every user-supplied number.
- `parseCount` is strict: digits only, safe integer, at most `MAX_VALUE`. Used
  for form input where a bad value must be an error.
- `clampCount` is forgiving: floors, maps non-finite and below-minimum values to
  the minimum. Used in the engine constructor so raw caller numbers cannot make
  the run bound non-finite.
- Burst minimum is 1; arrival and priority minimum are 0.
- `run()` bound: `totalBurst + maxArrival + processCount + 1` ticks, so a
  scheduler bug cannot hang the page.
- Timeline segments and history frames are contiguous and cover every executed
  tick exactly once.
- `stateAt(t)`: `t <= 0` returns the initial state; otherwise it reads the frame
  covering tick `t - 1`, clamped to the recorded range. The returned `ready`
  array is a copy.
- Metrics are `null` until defined. Waiting requires completion; response only
  requires a first dispatch.
- Process colour slot wraps at eight, so two processes can share a colour; hover
  and identity key off process index, not colour.

## 8. Metrics

- Completion time: `completion`.
- Turnaround: `completion - arrival`.
- Waiting: `turnaround - burst`.
- Response: `start - arrival`, `null` if never dispatched.

Per-process cells and averages only include processes whose `completion <=
cursor`. Averages are arithmetic means over that visible subset.

## 9. Error handling

- Field validation returns an `errors` map keyed `pid`, `arrival`, `burst`,
  `priority`; `FIELD_FOR` maps keys to input IDs. The first invalid field is
  focused.
- Duplicate PID is rejected case-insensitively; a blank PID generates the next
  free `P#`.
- Empty process list blocks Run, Step, and Reset with a form error.
- Missing DOM hooks are tolerated; render functions return early instead of
  throwing.
- Theme storage access is wrapped in `try/catch` because storage can be blocked.

## 10. Testing

Node's built-in test runner, no dependencies:

```sh
node --test tests/test_scheduler.mjs tests/test_render.mjs
```

`test_scheduler.mjs` covers each algorithm, idle handling, metrics, input
validation, tick bounds, history contiguity and merging, event labelling,
`stateAt` against a step-by-step replay fuzz, cursor slicing, status, and result
visibility.

`test_render.mjs` covers Gantt slice building and idle gaps, axis ticks, lane
geometry and truncation, and lane readout formatting.

## 11. Known constraints

- Scheduling is synchronous. `MAX_VALUE` and the `run()` bound keep it
  responsive; larger time units would need chunked execution.
- Ready-queue scans and removals are linear. Queues are small by design.
- Only theme preference persists, via `localStorage`.
- Preemption exists only in SRTF; quantum handling exists only in Round Robin.
- No multi-run comparison, save/load, or export.
