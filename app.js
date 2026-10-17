"use strict";

/* ============================================================
   CPU Scheduling Simulator - app.js
   UI layer only. Scheduling + validation live in engine.js.
   Every view renders "as of time t" from the sim's recorded history.
   ============================================================ */

import { Simulation, ALGORITHM, validateProcess } from "./engine.js";

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
        historyView: "frames",               // "frames" | "events"
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

            body.appendChild(h("tr", { "data-process-index": colorOf(index) }, [
                h("td", null, [process.id]),
                h("td", { class: "data-table__numeric" }, [String(process.arrival)]),
                h("td", { class: "data-table__numeric" }, [String(process.burst)]),
                h("td", { class: "data-table__numeric" }, [String(process.priority)]),
                h("td", { class: "data-table__actions" }, [remove]),
            ]));
        });

        show($("#process-empty"), state.processes.length === 0);
    }

    function renderGantt() {
        const bars = $("#gantt-bars");
        const legend = $("#gantt-legend");
        if (!bars) return;
        bars.replaceChildren();
        if (legend) legend.replaceChildren();

        const timeline = state.sim ? state.sim.getTimeline() : [];
        const slices = cursorSlices(timeline, state.cursor);
        const has = slices.length > 0;
        show($("#gantt-chart"), has);
        show($("#gantt-empty"), !has);
        if (!has) return;

        const indexById = new Map(state.processes.map((process, index) => [process.id, colorOf(index)]));

        for (const slice of slices) {
            const attributes = {
                class: slice.idle
                    ? "gantt__slice gantt__slice--idle"
                    : slice.partial
                        ? "gantt__slice gantt__slice--partial"
                        : "gantt__slice",
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
        const end = slices[slices.length - 1].end;
        bars.appendChild(h("div", { class: "gantt__slice gantt__slice--end" }, [
            h("span", { class: "gantt__bar gantt__bar--empty", "aria-hidden": "true" }, [" "]),
            h("span", { class: "gantt__tick" }, [String(end)]),
        ]));

        if (!legend) return;
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
                    class: "queue__item", "data-process-index": colorOf(index),
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

            body.appendChild(h("tr", { "data-process-index": colorOf(index) }, [
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
        show($("#history-empty"), !has);

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
        const frames = state.historyView === "frames";
        show($("#history-frames-view"), frames);
        show($("#history-events-view"), !frames);
        const framesBtn = $("#history-view-frames");
        const eventsBtn = $("#history-view-events");
        if (framesBtn) framesBtn.setAttribute("aria-pressed", String(frames));
        if (eventsBtn) eventsBtn.setAttribute("aria-pressed", String(!frames));
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

    const framesBtn = $("#history-view-frames");
    if (framesBtn) framesBtn.addEventListener("click", () => { state.historyView = "frames"; syncHistoryView(); });
    const eventsBtn = $("#history-view-events");
    if (eventsBtn) eventsBtn.addEventListener("click", () => { state.historyView = "events"; syncHistoryView(); });

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
    renderProcesses();
    renderOutputs();
}

if (typeof document !== "undefined") initUI();
