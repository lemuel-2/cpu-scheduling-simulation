# app.js — changes for programmer review

These changes were made to `app.js` during the UI/UX session and are **already
present** in the current file. This document is for review: keep, adjust, or
revert. No further JavaScript edits will be made from this side.

Scope: `app.js` only (plus a new test file, `test_render.mjs`). `engine.js`,
`test_scheduler.mjs`, and `index.html` were not touched.

Line numbers below will drift as the file changes, so each hunk is anchored by
the surrounding code rather than a line number.

---

## 1. New pure helper `buildSlices` (exported)

**Why.** The engine timeline records only scheduled ticks; idle ticks advance
the clock with no segment. The Gantt drew the segments back-to-back, so the
chart was not time-proportional whenever the CPU sat idle (e.g. P1 at t=4 and
P2 at t=10 rendered as touching bars). This fills the gaps.

**Where.** Near the top of the file, after `const PROC_COLORS = 8;`.

**Before.** (did not exist)

**After.**

```js
/**
 * Turn engine segments into a continuous slice list by filling idle gaps
 * (leading idle from time 0, and between disjoint segments). Keeps the
 * Gantt time-proportional even while the CPU sits idle.
 * @param {Array<{pid:string,start:number,end:number}>} timeline
 * @returns {Array<{pid:string|null,start:number,end:number,idle:boolean}>}
 */
export function buildSlices(timeline) {
  const slices = [];
  let cursor = 0;
  for (const segment of timeline) {
    if (segment.start > cursor) {
      slices.push({ pid: null, start: cursor, end: segment.start, idle: true });
    }
    slices.push({ pid: segment.pid, start: segment.start, end: segment.end, idle: false });
    cursor = segment.end;
  }
  return slices;
}
```

**Note.** This adds a named `export` to `app.js`. `test_render.mjs` imports it
directly. If exporting from the UI module is not wanted, move the function to
`engine.js` and import it — the logic is pure and has no DOM dependency.

---

## 2. `renderGantt()` — draw idle slices, fix legend duplication

**Why.**
1. Consume `buildSlices()` so idle gaps get drawn.
2. The legend loop skipped only *consecutive* duplicate PIDs, so an SRTF run
   with the sequence `P1, P2, P1` produced a legend of `P1, P2, P1`.

**Before.**

```js
    const timeline = state.sim ? state.sim.getTimeline() : [];
    const has = timeline.length > 0;
    $("#gantt-chart").classList.toggle("is-hidden", !has);
    $("#gantt-empty").classList.toggle("is-hidden", has);
    if (!has) return;

    const indexById = new Map(state.processes.map((process, index) => [process.id, colorOf(index)]));

    for (const segment of timeline) {
      bars.appendChild(h("div", {
        class: "gantt__slice",
        "data-process-index": indexById.get(segment.pid) ?? 0,
        style: `--units:${Math.max(1, segment.end - segment.start)}`,
      }, [
        h("span", { class: "gantt__bar" }, [segment.pid]),
        h("span", { class: "gantt__tick" }, [String(segment.start)]),
      ]));
    }
    const endTime = timeline[timeline.length - 1].end;
    bars.appendChild(h("div", { class: "gantt__slice gantt__slice--end" }, [
      h("span", { class: "gantt__bar gantt__bar--empty", "aria-hidden": "true" }, [" "]),
      h("span", { class: "gantt__tick" }, [String(endTime)]),
    ]));

    let previous = null;
    for (const segment of timeline) {
      if (segment.pid === previous) continue;
      previous = segment.pid;
      legend.appendChild(h("li", {
        class: "legend__item", "data-process-index": indexById.get(segment.pid) ?? 0,
      }, [
        h("span", { class: "legend__swatch", "aria-hidden": "true" }, []),
        h("span", null, [segment.pid]),
      ]));
    }
```

**After.**

```js
    const timeline = state.sim ? state.sim.getTimeline() : [];
    const slices = buildSlices(timeline);
    const has = slices.length > 0;
    $("#gantt-chart").classList.toggle("is-hidden", !has);
    $("#gantt-empty").classList.toggle("is-hidden", has);
    if (!has) return;

    const indexById = new Map(state.processes.map((process, index) => [process.id, colorOf(index)]));

    for (const slice of slices) {
      const attributes = {
        class: slice.idle ? "gantt__slice gantt__slice--idle" : "gantt__slice",
        style: `--units:${Math.max(1, slice.end - slice.start)}`,
      };
      if (!slice.idle) attributes["data-process-index"] = indexById.get(slice.pid) ?? 0;

      bars.appendChild(h("div", attributes, [
        slice.idle
          ? h("span", { class: "gantt__bar gantt__bar--idle" }, ["idle"])
          : h("span", { class: "gantt__bar" }, [slice.pid]),
        h("span", { class: "gantt__tick" }, [String(slice.start)]),
      ]));
    }
    const endTime = slices[slices.length - 1].end;
    bars.appendChild(h("div", { class: "gantt__slice gantt__slice--end" }, [
      h("span", { class: "gantt__bar gantt__bar--empty", "aria-hidden": "true" }, [" "]),
      h("span", { class: "gantt__tick" }, [String(endTime)]),
    ]));

    const seen = new Set();
    for (const segment of timeline) {
      if (seen.has(segment.pid)) continue;
      seen.add(segment.pid);
      legend.appendChild(h("li", {
        class: "legend__item", "data-process-index": indexById.get(segment.pid) ?? 0,
      }, [
        h("span", { class: "legend__swatch", "aria-hidden": "true" }, []),
        h("span", null, [segment.pid]),
      ]));
    }
```

**CSS dependency.** The idle slice needs these rules in `styles.css`
(already added):

```css
.gantt__slice--idle .gantt__bar--idle {
  color: var(--text-meta);
  background: transparent;
  border: 1px dashed var(--gray-300);
}
```

---

## 3. Time-quantum handlers

**Why.** Typing `0`, `-5`, or clearing the field left that value visible while
the simulation silently used `1`. Now the field is validated on input and
snapped to a valid value on blur / Enter.

**Before.** (single handler)

```js
  $("#time-quantum").addEventListener("input", (event) => {
    const value = Math.floor(Number(event.target.value));
    state.quantum = Number.isFinite(value) && value >= 1 ? value : 1;
    resetSimulation();
  });
```

**After.** (two handlers)

```js
  $("#time-quantum").addEventListener("input", (event) => {
    const value = Math.floor(Number(event.target.value));
    if (Number.isFinite(value) && value >= 1) {
      state.quantum = value;
      resetSimulation();
    }
  });

  // Snap the visible value back to a valid quantum on blur / Enter, so the
  // field never keeps showing a value the simulation is not using.
  $("#time-quantum").addEventListener("change", (event) => {
    const value = Math.floor(Number(event.target.value));
    const safe = Number.isFinite(value) && value >= 1 ? value : 1;
    state.quantum = safe;
    event.target.value = String(safe);
    resetSimulation();
  });
```

---

## New test file

`test_render.mjs` — 4 assertions over `buildSlices` (leading idle, gap between
segments, no idle when contiguous, full-span coverage).

Run:

```sh
node --test test_scheduler.mjs test_render.mjs
```

Result at time of writing: 13 pass, 0 fail.

---

## Not part of these changes

The `finished` handling in `run()` (a `const finished = state.sim.run();` with
a failure branch) is the owner's edit, not from this session.
