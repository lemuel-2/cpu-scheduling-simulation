# CPU Scheduling Simulator

Interactive CPU scheduling simulator: FCFS, SJF, SRTF, Priority, and Round Robin,
with a Gantt chart, ready-queue view, and per-process metrics.

## Running

The page loads `app.js` as an ES module, so it must be served over HTTP —
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

Pure scheduling logic and the Gantt slice builder are covered by Node's built-in
test runner — no dependencies:

```sh
node --test test_scheduler.mjs test_render.mjs
```

(The files use the `test_*.mjs` name, which Node's default `node --test`
glob does not pick up, so list them explicitly.)

## Files

- `index.html` — markup.
- `styles.css` — styling.
- `engine.js` — scheduling engine (pure, DOM-free).
- `app.js` — UI layer; imports `engine.js`.
- `test_scheduler.mjs`, `test_render.mjs` — tests.
