"use strict";

/* ============================================================
   CPU Scheduling Simulator - app.js
   UI layer only. Scheduling + validation live in engine.js.
   Every view renders "as of time t" from the sim's recorded history.
   ============================================================ */

import { Simulation, ALGORITHM, validateProcess } from "../logic/engine.js";

const DASH = "\u2013";
const PROC_COLORS = 8;

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

/**
 * Gantt slices visible at the cursor: segments that end at or before the
 * cursor are drawn whole; the segment spanning the cursor is truncated at it
 * and flagged `partial`. Idle gaps are filled so widths stay time-accurate.
 * @param {Array<{pid:string,start:number,end:number}>} timeline
 * @param {number} cursor
 * @returns {Array<{pid:string|null,start:number,end:number,idle:boolean,partial:boolean}>}
 */
export function cursorSlices(timeline, cursor) {
    const slices = [];
    let at = 0;
    for (const segment of timeline) {
        if (segment.start >= cursor) break;
        if (segment.start > at) {
            slices.push({ pid: null, start: at, end: segment.start, idle: true, partial: false });
        }
        const end = Math.min(segment.end, cursor);
        slices.push({
            pid: segment.pid,
            start: segment.start,
            end,
            idle: false,
            partial: segment.end > cursor,
        });
        at = segment.end;
        if (at >= cursor) return slices;
    }
    if (at < cursor) {
        slices.push({ pid: null, start: at, end: cursor, idle: true, partial: false });
    }
    return slices;
}

/**
 * Per-process lane geometry for the expanded Gantt: one row per process, in
 * process-list order, with each run segment placed as a fraction of the whole
 * run so every row lines up on one time axis. Waits are dropped — the lane
 * track reads as the wait, the bars as the work.
 * @param {Array<{pid:string,start:number,end:number}>} timeline
 * @param {Array<{id:string}>} processes
 * @param {number} cursor
 * @returns {{total:number, rows:Array<{pid:string, index:number, bars:Array<{start:number,finish:number,left:number,width:number}>}>}}
 */
export function laneRows(timeline, processes, cursor) {
    const total = timeline.reduce((max, segment) => Math.max(max, segment.end), 0);
    const empty = processes.map((process, index) => ({ pid: process.id, index, bars: [] }));
    if (total === 0) return { total, rows: empty };

    return {
        total,
        rows: processes.map((process, index) => ({
            pid: process.id,
            index,
            bars: cursorSlices(timeline.filter((segment) => segment.pid === process.id), cursor)
                .filter((slice) => !slice.idle)
                .map((slice) => ({
                    start: slice.start,
                    finish: slice.end,
                    left: slice.start / total,
                    width: (slice.end - slice.start) / total,
                })),
        })),
    };
}

/**
 * One line naming what a process did: its runs, how much of the run it held the
 * CPU, and how long it waited once it is finished. A round robin can hand a
 * process a dozen slices, so past three the list collapses to a count.
 * @param {string} pid
 * @param {Array<[number, number]>} runs [start, finish] tick pairs
 * @param {number} total whole-run length in ticks
 * @param {{waiting:number}|null} [stat] present only once the process finished
 * @returns {string}
 */
export function laneReadout(pid, runs, total, stat = null) {
    if (runs.length === 0) return [pid, 'not run yet'].join(' \u00b7 ');

    const ticks = runs.reduce((sum, [start, finish]) => sum + (finish - start), 0);
    const span = (run) => `${run[0]}\u2013${run[1]}`;
    const parts = [pid];
    if (runs.length === 1) parts.push(`runs ${span(runs[0])}`);
    else if (runs.length <= 3) parts.push(`${runs.length} runs`, runs.map(span).join(', '));
    else parts.push(`${runs.length} runs`);
    parts.push(`${ticks} of ${total} ticks`);
    if (stat) parts.push(`waiting ${stat.waiting}`);
    return parts.join(' \u00b7 ');
}

/**
 * Evenly spaced tick values for the lane axis, kept close to `max` labels and
 * rounded to step sizes a reader can multiply in their head, plus the finish
 * time when it is not already one of them.
 * @param {number} total
 * @param {number} [max]
 * @returns {number[]}
 */
export function axisTicks(total, max = 8) {
    if (!(total > 0)) return [0];

    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500];
    const step = steps.find((size) => total / size <= max) ?? Math.ceil(total / max / 500) * 500;
    const ticks = [];
    for (let tick = 0; tick <= total; tick += step) ticks.push(tick);

    const last = ticks[ticks.length - 1];
    if (last === total) return ticks;
    if (total - last < step * 0.35) ticks.pop();
    ticks.push(total);
    return ticks;
}

/**
 * Status badge for a cursor position.
 * @returns {{state:string, text:string}}
 */
export function statusForCursor(cursor, end) {
    if (cursor <= 0) return { state: "idle", text: "Idle" };
    if (end > 0 && cursor >= end) return { state: "finished", text: "Finished" };
    return { state: "running", text: `t = ${cursor}` };
}

/**
 * Result rows whose process has completed at or before the cursor.
 * @param {Array<{completion:number|null}>} stats
 * @param {number} cursor
 */
export function visibleResults(stats, cursor) {
    return stats.filter((row) => row.completion !== null && row.completion <= cursor);
}

/**
 * Frame history -> plain rows (index -> pid) for the frames table.
 * @param {Array<object>} history
 * @param {Array<{id:string}>} processes
 */
export function historyFrameRows(history, processes) {
    return history.map((frame) => ({
        start: frame.start,
        end: frame.end,
        runningPid: frame.running === null ? null : processes[frame.running].id,
        readyPids: frame.ready.map((index) => processes[index].id),
        event: frame.event,
        pid: frame.pid,
    }));
}

/* engine error key -> form field id */
const FIELD_FOR = {
    pid: "pid",
    arrival: "arrival-time",
    burst: "burst-time",
    priority: "priority",
};
const FIELDS = Object.values(FIELD_FOR);

function initUI() {
    const $ = (sel) => document.querySelector(sel);

    const state = {
        processes: [],                       // { id, arrival, burst, priority }
        algorithm: ALGORITHM.FCFS,
        quantum: 2,
        sim: null,                           // Simulation | null
        cursor: 0,                           // 0..sim.time
        historyView: "processes",             // "processes" | "frames" | "events"
        resultsView: "averages",              // "averages" | "table"
    };

    const STATUS = $("#simulation-status");
    const STATUS_TEXT = STATUS ? STATUS.querySelector(".status-badge__text") || STATUS : null;
    const QUANTUM_FIELD = $("#quantum-field");
    const FORM_ERROR = $("#process-form-error");
    const THEME_TOGGLE = $("#theme-toggle");

    /** Toggle a guarded element's visibility; no-op when the hook is absent. */
    function show(element, visible) {
        if (!element) return;
        element.classList.toggle("is-hidden", !visible);
        element.dataset.state = visible ? "visible" : "hidden";
    }

    function h(tag, attrs, children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs || {})) {
            if (key === "class") node.className = value;
            else node.setAttribute(key, value);
        }
        for (const child of [].concat(children || [])) {
            node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
        }
        return node;
    }

    const fmt = (n) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : DASH);
    const colorOf = (index) => index % PROC_COLORS;

    /* ---------- status + errors ---------- */
    function setStatus(kind, text) {
        if (!STATUS) return;
        STATUS.dataset.state = kind;
        if (STATUS_TEXT) STATUS_TEXT.textContent = text;
    }

    function setFieldError(fieldId, message) {
        const error = document.getElementById(fieldId + "-error");
        if (!error) return;
        error.textContent = message || "";
        error.classList.toggle("is-hidden", !message);
        error.dataset.state = message ? "visible" : "hidden";
    }

    const clearFieldErrors = () => FIELDS.forEach((id) => setFieldError(id, ""));

    function showFormError(message) {
        if (!FORM_ERROR) return;
        FORM_ERROR.textContent = message;
        FORM_ERROR.classList.remove("is-hidden");
        FORM_ERROR.dataset.state = "visible";
    }

    function hideFormError() {
        if (!FORM_ERROR) return;
        FORM_ERROR.classList.add("is-hidden");
        FORM_ERROR.dataset.state = "hidden";
    }

    /* ---------- simulation lifecycle ---------- */
    const endTime = () => (state.sim ? state.sim.time : 0);

    // Build the sim and run it once so its history is complete; the cursor then
    // navigates that history. Nothing here renders.
    function buildSimulation() {
        state.sim = new Simulation(state.processes, {
            algorithm: state.algorithm,
            quantum: state.quantum,
        });
        state.sim.run();
        state.cursor = 0;
    }

    // Rebuild from scratch when inputs change; drop to empty when no processes.
    function rebuild() {
        if (state.processes.length) buildSimulation();
        else resetSimulation();
    }

    function resetSimulation() {
        state.sim = null;
        state.cursor = 0;
    }

    function setCursor(value) {
        const clamped = Math.max(0, Math.min(Number(value) || 0, endTime()));
        state.cursor = clamped;
        renderOutputs();
    }

    function addProcess(event) {
        event.preventDefault();
        clearFieldErrors();
        hideFormError();

        const result = validateProcess(
            {
                pid: $("#pid").value,
                arrival: $("#arrival-time").value,
                burst: $("#burst-time").value,
                priority: $("#priority").value,
            },
            state.processes,
        );

        const keys = Object.keys(result.errors);
        if (keys.length) {
            keys.forEach((key) => setFieldError(FIELD_FOR[key], result.errors[key]));
            const first = FIELD_FOR[keys[0]];
            setStatus("error", "Fix the errors");
            document.getElementById(first).focus();
            return;
        }

        state.processes.push(result.process);
        rebuild();
        renderProcesses();

        const body = $("#process-table-body");
        if (body && body.lastElementChild && body.lastElementChild.scrollIntoView) {
            body.lastElementChild.scrollIntoView({ block: "nearest" });
        }

        renderOutputs();
        event.target.reset();
        $("#pid").focus();
    }

    function deleteProcess(id) {
        state.processes = state.processes.filter((process) => process.id !== id);
        rebuild();
        renderProcesses();
        renderOutputs();
    }

    /* ---------- rendering ---------- */
    function renderProcesses() {
        const body = $("#process-table-body");
        if (!body) return;
        body.replaceChildren();

        state.processes.forEach((process, index) => {
            const remove = h("button", {
                type: "button", class: "button button--danger", "data-id": process.id,
            }, ["Delete"]);
            remove.addEventListener("click", () => deleteProcess(process.id));

            body.appendChild(h("tr", {
                "data-process-index": colorOf(index), "data-process-key": index,
            }, [
                h("td", null, [process.id]),
                h("td", { class: "data-table__numeric" }, [String(process.arrival)]),
                h("td", { class: "data-table__numeric" }, [String(process.burst)]),
                h("td", { class: "data-table__numeric" }, [String(process.priority)]),
                h("td", { class: "data-table__actions" }, [remove]),
            ]));
        });

        show($("#process-empty"), state.processes.length === 0);
    }

    /* ---------- lane hover: one process, lit up everywhere ---------- */
    const READOUT_HINT = "Hover a lane";
    let hotKey = null;

    /**
     * Light every element carrying this process's key and name the process in the
     * lanes panel head. The key is the process's position; the colour slot wraps
     * at eight, so it can name two processes at once.
     * @param {number|null} index
     */
    function setHot(index) {
        if (index === hotKey) return;
        hotKey = index;
        document.body.classList.toggle("has-hot", index !== null);
        for (const el of document.querySelectorAll(".is-hot")) el.classList.remove("is-hot");

        const readout = $("#lane-readout");
        const lanes = index === null || !state.sim
            ? null
            : laneRows(state.sim.getTimeline(), state.processes, state.cursor);
        const row = lanes ? lanes.rows.find((candidate) => candidate.index === index) : null;

        if (row) {
            for (const el of document.querySelectorAll(`[data-process-key="${index}"]`)) {
                el.classList.add("is-hot");
            }
        }
        if (!readout) return;
        if (!row) {
            readout.textContent = READOUT_HINT;
            return;
        }

        const stat = state.sim.getStats().find((candidate) => candidate.index === index);
        const finished = stat && stat.completion !== null && stat.completion <= state.cursor;
        readout.textContent = laneReadout(
            row.pid,
            row.bars.map((bar) => [bar.start, bar.finish]),
            lanes.total,
            finished ? stat : null,
        );
    }

    function renderGantt() {
        const bars = $("#gantt-bars");
        const legend = $("#gantt-legend");
        const lanes = $("#gantt-lanes");
        if (!bars) return;
        bars.replaceChildren();
        if (legend) legend.replaceChildren();
        // Cleared here, not with the lanes: an empty run returns early below and
        // would otherwise leave the previous run's lanes on the page.
        if (lanes) lanes.replaceChildren();
        // The rows that carried the highlight are gone with the rebuild.
        setHot(null);

        const timeline = state.sim ? state.sim.getTimeline() : [];
        const slices = cursorSlices(timeline, state.cursor);
        const has = slices.length > 0;
        show($("#gantt-chart"), has);
        show($("#gantt-empty"), !has);
        // Its own panel, so it carries its own show/hide and empty state.
        if (lanes) show(lanes, has);
        show($("#lanes-empty"), !has);
        if (!has) return;

        // Key is the process's real position; the colour slot wraps at eight, so
        // two processes can share a colour. The hover link keys off position.
        const keyById = new Map(state.processes.map((process, index) => [process.id, index]));
        const colorById = new Map(state.processes.map((process, index) => [process.id, colorOf(index)]));
        const { total, rows } = laneRows(timeline, state.processes, state.cursor);

        for (const slice of slices) {
            const attributes = {
                class: slice.idle
                    ? "gantt__slice gantt__slice--idle"
                    : slice.partial
                        ? "gantt__slice gantt__slice--partial"
                        : "gantt__slice",
                style: `--units:${Math.max(1, slice.end - slice.start)}`,
            };
            if (!slice.idle) {
                attributes["data-process-index"] = colorById.get(slice.pid) ?? 0;
                attributes["data-process-key"] = keyById.get(slice.pid) ?? 0;
            }

            bars.appendChild(h("div", attributes, [
                slice.idle
                    ? h("span", { class: "gantt__bar gantt__bar--idle" }, ["idle"])
                    : h("span", { class: "gantt__bar" }, [slice.pid]),
                h("span", { class: "gantt__tick" }, [String(slice.start)]),
            ]));
        }
        // The rest of the run, so the row keeps the whole run's scale instead of
        // stretching whatever the cursor has reached: the lanes below are placed
        // as fractions of the whole run and the two must agree at every cursor.
        const reached = slices[slices.length - 1].end;
        if (total > reached) {
            bars.appendChild(h("div", {
                class: "gantt__slice gantt__rest",
                style: `--units:${total - reached}`,
            }, []));
        }

        if (lanes) {
            for (const row of rows) {
                const track = h("div", { class: "lane__track" }, []);
                for (const bar of row.bars) {
                    track.appendChild(h("div", {
                        class: "lane__bar",
                        style: `left:${(bar.left * 100).toFixed(4)}%;width:${(bar.width * 100).toFixed(4)}%`,
                        "data-process-index": colorOf(row.index),
                        title: `${row.pid} runs ${bar.start}\u2013${bar.finish}`,
                    }, []));
                }
                lanes.appendChild(h("div", { class: "lane", "data-process-key": row.index }, [
                    h("span", { class: "lane__name" }, [row.pid]),
                    track,
                ]));
            }
            const ticks = axisTicks(total);
            lanes.appendChild(h("div", { class: "lane lane--axis" }, [
                h("span", { class: "lane__name", "aria-hidden": "true" }, [""]),
                h("div", { class: "lane__track lane__track--axis" }, ticks.map((tick) => h("span", {
                    class: "axis__tick",
                    style: tick === 0 ? "left:0"
                        : tick === ticks[ticks.length - 1] ? "right:0"
                            : `left:${((tick / total) * 100).toFixed(4)}%;transform:translateX(-50%)`,
                }, [String(tick)]))),
            ]));
        }

        if (!legend) return;
        const seen = new Set();
        for (const segment of timeline) {
            if (seen.has(segment.pid)) continue;
            seen.add(segment.pid);
            legend.appendChild(h("li", {
                class: "legend__item",
                "data-process-index": colorById.get(segment.pid) ?? 0,
                "data-process-key": keyById.get(segment.pid) ?? 0,
            }, [
                h("span", { class: "legend__swatch", "aria-hidden": "true" }, []),
                h("span", null, [segment.pid]),
            ]));
        }
    }

    function renderQueue() {
        const view = state.sim ? state.sim.stateAt(state.cursor) : { running: null, ready: [] };
        const runningPid = view.running === null ? null : state.processes[view.running].id;

        const runningEl = $("#running-process");
        if (runningEl) {
            runningEl.textContent = runningPid || "";
            runningEl.classList.toggle("running", Boolean(runningPid));
        }

        const list = $("#ready-queue");
        if (list) {
            list.replaceChildren();
            for (const index of view.ready) {
                const process = state.processes[index];
                if (!process) continue;
                list.appendChild(h("li", {
                    class: "queue__item",
                    "data-process-index": colorOf(index),
                    "data-process-key": index,
                }, [process.id]));
            }
        }
        show($("#queue-empty"), view.ready.length === 0);
    }

    function renderResults() {
        const body = $("#results-table-body");
        if (!body) return;
        body.replaceChildren();

        const stats = state.sim ? state.sim.getStats() : [];
        const byIndex = new Map(stats.map((row) => [row.index, row]));
        const shown = visibleResults(stats, state.cursor);

        state.processes.forEach((process, index) => {
            const stat = byIndex.get(index);
            const done = stat && stat.completion !== null && stat.completion <= state.cursor;
            const values = done
                ? [fmt(stat.completion), fmt(stat.turnaround), fmt(stat.waiting), fmt(stat.response)]
                : [DASH, DASH, DASH, DASH];

            body.appendChild(h("tr", {
                "data-process-index": colorOf(index), "data-process-key": index,
            }, [
                h("td", null, [process.id]),
                ...values.map((value) => h("td", { class: "data-table__numeric" }, [value])),
            ]));
        });

        const has = shown.length > 0;
        const mean = (key) => shown.reduce((sum, row) => sum + row[key], 0) / shown.length;
        const avg = (key) => (has ? fmt(mean(key)) : DASH);

        const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };
        setText("#avg-completion", avg("completion"));
        setText("#avg-turnaround", avg("turnaround"));
        setText("#avg-waiting", avg("waiting"));
        setText("#avg-response", avg("response"));
        // The averages have their own strip above the table, so this line
        // reports progress instead of repeating two of them.
        setText("#results-summary", has
            ? `${shown.length} of ${state.processes.length} processes complete`
            : "No results yet.");
    }

    function renderHistory() {
        const history = state.sim ? state.sim.getHistory() : [];
        const has = history.length > 0;
        for (const el of document.querySelectorAll(".history-empty")) show(el, !has);

        const framesBody = $("#history-frames-body");
        if (framesBody) {
            framesBody.replaceChildren();
            for (const row of historyFrameRows(history, state.processes)) {
                // A frame covers ticks [start, end); stateAt(t) returns the frame that
                // covers tick t-1, so the row's state is the one shown at cursor
                // start + 1. Keying data-time by start would make clicking the row (and
                // the scrubber at that time) show the *previous* frame instead.
                framesBody.appendChild(h("tr", {
                    class: "history__row", tabindex: "0", "data-time": String(row.start + 1),
                }, [
                    h("td", { class: "data-table__numeric" }, [`${row.start}\u2013${row.end - 1}`]),
                    h("td", null, [row.runningPid || DASH]),
                    h("td", null, [row.readyPids.length ? row.readyPids.join(", ") : DASH]),
                    h("td", null, [row.event || DASH]),
                ]));
            }
        }

        const eventsList = $("#history-events");
        if (eventsList) {
            eventsList.replaceChildren();
            for (const frame of history) {
                if (frame.event === null) continue;
                const at = frame.start + 1; // cursor time the event is observable at
                eventsList.appendChild(h("li", {
                    class: "history__row", tabindex: "0", "data-time": String(at),
                }, [`t${frame.start} \u00b7 ${frame.event} \u00b7 ${frame.pid || DASH}`]));
            }
        }
    }

    function renderScrubber() {
        const scrubber = $("#time-scrubber");
        const view = state.sim ? state.sim.stateAt(state.cursor) : { running: null };
        const runningPid = view.running === null ? null : state.processes[view.running].id;
        const valueText = runningPid ? `time ${state.cursor}, running ${runningPid}` : `time ${state.cursor}, idle`;

        if (scrubber) {
            scrubber.max = String(endTime());
            scrubber.value = String(state.cursor);
            scrubber.setAttribute("aria-valuetext", valueText);
        }
        const readout = $("#time-readout");
        if (readout) readout.textContent = `t = ${state.cursor}`;
    }

    function renderStatus() {
        const status = statusForCursor(state.cursor, endTime());
        setStatus(status.state, status.text);
    }

    function renderOutputs() {
        renderGantt();
        renderQueue();
        renderResults();
        renderHistory();
        renderScrubber();
        renderStatus();
    }

    function syncHistoryView() {
        const view = state.historyView;
        show($("#processes-view"), view === "processes");
        show($("#history-frames-view"), view === "frames");
        show($("#history-events-view"), view === "events");

        const tabs = [...document.querySelectorAll("#history-drawer [role=\"tab\"]")];
        for (const tab of tabs) {
            const selected = tab.id === `history-view-${view}`;
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
        }
    }

    function syncResultsView() {
        const view = state.resultsView;
        show($("#results-averages-view"), view === "averages");
        show($("#results-table-view"), view === "table");

        const tabs = [...document.querySelectorAll("#results-tablist [role=\"tab\"]")];
        for (const tab of tabs) {
            const selected = tab.id === `results-view-${view}`;
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
        }
    }

    function bindTabList(tablist, select) {
        if (!tablist) return;
        tablist.addEventListener("click", (event) => {
            const tab = event.target.closest("[role=\"tab\"]");
            if (!tab || !tablist.contains(tab)) return;
            select(tab);
        });
        tablist.addEventListener("keydown", (event) => {
            if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
            const tabs = [...tablist.querySelectorAll("[role=\"tab\"]")];
            const index = tabs.indexOf(document.activeElement);
            if (index === -1) return;
            event.preventDefault();
            let next = index;
            if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
            else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
            else if (event.key === "Home") next = 0;
            else next = tabs.length - 1;
            tabs[next].click();
            tabs[next].focus();
        });
    }

    /* ---------- controls ---------- */
    function guardProcesses() {
        if (state.processes.length) return true;
        showFormError("Add at least one process first.");
        setStatus("error", "No processes");
        return false;
    }

    function ensureSimulation() {
        if (!state.sim && state.processes.length) buildSimulation();
        return Boolean(state.sim);
    }

    function run() {
        if (!guardProcesses()) return;
        hideFormError();
        ensureSimulation();
        state.cursor = endTime();
        renderOutputs();
    }

    function step() {
        if (!guardProcesses()) return;
        hideFormError();
        ensureSimulation();
        state.cursor = Math.min(state.cursor + 1, endTime());
        renderOutputs();
    }

    function resetAll() {
        state.cursor = 0;
        hideFormError();
        renderOutputs();
    }

    function clearAll() {
        state.processes = [];
        resetSimulation();
        renderProcesses();
        $("#process-form").reset();
        clearFieldErrors();
        hideFormError();
        renderOutputs();
    }

    function syncQuantumField() {
        const showField = state.algorithm === ALGORITHM.RR;
        if (QUANTUM_FIELD) {
            QUANTUM_FIELD.classList.toggle("is-hidden", !showField);
            QUANTUM_FIELD.dataset.state = showField ? "visible" : "hidden";
        }
    }

    function applyTheme(theme) {
        document.documentElement.dataset.theme = theme;
        const dark = theme === "dark";
        if (THEME_TOGGLE) {
            THEME_TOGGLE.setAttribute("aria-pressed", String(dark));
            THEME_TOGGLE.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
        }
        const label = $("#theme-toggle-label");
        if (label) label.textContent = dark ? "Light" : "Dark";
    }

    /* ---------- wiring ---------- */
    $("#process-form").addEventListener("submit", addProcess);
    $("#run-simulation").addEventListener("click", run);
    $("#step-simulation").addEventListener("click", step);
    $("#reset-simulation").addEventListener("click", resetAll);
    $("#clear-all").addEventListener("click", clearAll);

    $("#algorithm").addEventListener("change", (event) => {
        state.algorithm = event.target.value;
        syncQuantumField();
        rebuild();
        renderOutputs();
    });

    $("#time-quantum").addEventListener("input", (event) => {
        const value = Math.floor(Number(event.target.value));
        if (Number.isFinite(value) && value >= 1) {
            state.quantum = value;
            rebuild();
            renderOutputs();
        }
    });

    // Snap the visible value back to a valid quantum on blur / Enter, so the
    // field never keeps showing a value the simulation is not using.
    $("#time-quantum").addEventListener("change", (event) => {
        const value = Math.floor(Number(event.target.value));
        const safe = Number.isFinite(value) && value >= 1 ? value : 1;
        state.quantum = safe;
        event.target.value = String(safe);
        rebuild();
        renderOutputs();
    });

    const scrubber = $("#time-scrubber");
    if (scrubber) scrubber.addEventListener("input", (event) => setCursor(event.target.value));

    // Hovering a lane lights that process everywhere else and names it in the
    // panel head. Delegated, and the whole lane row is the target, not the bar:
    // a one-tick bar is a much smaller thing to hit.
    const lanesBox = $("#gantt-lanes");
    if (lanesBox) {
        lanesBox.addEventListener("mouseover", (event) => {
            const lane = event.target.closest("[data-process-key]");
            setHot(lane ? Number(lane.dataset.processKey) : null);
        });
        lanesBox.addEventListener("mouseleave", () => setHot(null));
    }

    // Any [data-time] element (frame row, event item) jumps the cursor.
    document.addEventListener("click", (event) => {
        const target = event.target.closest("[data-time]");
        if (target) setCursor(target.dataset.time);
    });

    // ...and so does activating a focused one with the keyboard (its tabindex
    // makes it reachable by Tab; Enter/Space mirrors the click). The re-render
    // rebuilds the row list, so restore focus to the replacement row afterwards —
    // otherwise the focused node is destroyed and focus falls to <body>, dumping
    // the user back at the top of the tab order on every jump.
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const target = event.target.closest("[data-time]");
        if (!target) return;
        event.preventDefault();
        const time = target.dataset.time;
        // The tbody / <ol> survive the re-render (only their children are replaced),
        // so hold onto the container to find the replacement row.
        const container = target.closest("#history-frames-body, #history-events");
        setCursor(time);
        const restored = container && container.querySelector(`[data-time="${time}"]`);
        if (restored) restored.focus();
    });

    bindTabList($("#history-drawer [role=\"tablist\"]"), (tab) => {
        state.historyView = tab.id.replace("history-view-", "");
        syncHistoryView();
    });
    bindTabList($("#results-tablist"), (tab) => {
        state.resultsView = tab.id.replace("results-view-", "");
        syncResultsView();
    });

    const historyToggle = $("#history-toggle");
    if (historyToggle) historyToggle.addEventListener("click", () => {
        const drawer = $("#history-drawer");
        if (!drawer) return;
        const collapsed = drawer.classList.toggle("is-collapsed");
        historyToggle.setAttribute("aria-expanded", String(!collapsed));
        historyToggle.textContent = collapsed ? "Expand" : "Collapse";
    });

    THEME_TOGGLE.addEventListener("click", () => {
        const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        applyTheme(next);
        try { localStorage.setItem("scheme", next); } catch { /* storage blocked */ }
    });

    /* ---------- init ---------- */
    let theme = "light";
    try {
        theme = localStorage.getItem("scheme")
            || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    } catch { /* storage blocked */ }

    applyTheme(theme);
    syncQuantumField();
    syncHistoryView();
    syncResultsView();
    renderProcesses();
    renderOutputs();
}

if (typeof document !== "undefined") initUI();
