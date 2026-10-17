# CPU Scheduling Simulator

Interactive CPU scheduling simulator: FCFS, SJF, SRTF, Priority, and Round Robin,
with a Gantt chart, per-process Gantt lanes, ready-queue view, and per-process
metrics.

## Running

The page loads `frontend/app.js` as an ES module, so it must be served over HTTP —
opening `index.html` directly from disk (`file://`) will not work, because the
browser blocks module scripts on a `null` origin.

Start a static server from this folder, then open the URL it prints:

```sh
python -m http.server 8000
# then visit http://localhost:8000
```

Alternatives that work the same way:

```sh
npx serve .
```

## How to use

1. Pick an algorithm. The time-quantum field appears only for Round Robin.
2. Add processes (PID is optional — one is generated if left blank), or delete
   a row with its Delete button.
3. **Run** schedules everything at once; **Step** advances one time unit at a
   time and updates the readiness queue; **Reset** clears the current run but
   keeps the processes; **Clear** removes everything.

## Tests

Pure scheduling logic, the Gantt slice builder, the lane geometry, and the lane
axis ticks are covered by Node's built-in test runner — no dependencies:

```sh
node --test tests/test_scheduler.mjs tests/test_render.mjs
```

(The files use the `test_*.mjs` name, which Node's default `node --test`
glob does not pick up, so list them explicitly.)

## Files

- `index.html` — markup.
- `frontend/styles.css` — styling.
- `frontend/app.js` — UI layer; imports `logic/engine.js`.
- `logic/engine.js` — scheduling engine (pure, DOM-free).
- `tests/test_scheduler.mjs`, `tests/test_render.mjs` — tests.
- `tools/measure-layout.mjs` — headless-Chrome layout harness.
