/**
 * CPU Scheduling Simulator - engine.js
 *
 * Purpose: pure scheduling logic for the simulator. No DOM, no rendering, no
 * timers: this module is safe to import in Node for tests.
 *
 * Model: time is discrete. One step() advances the clock by exactly one unit,
 * producing one history frame and possibly extending one timeline segment. A
 * whole run is therefore at most (total burst + idle ticks) steps long.
 *
 * Consumers:
 *  - frontend/app.js: builds a Simulation from the process table, calls run()
 *    or step(), then reads getTimeline() / getHistory() / getStats() / stateAt().
 *  - tests/test_scheduler.mjs: drives the same API without a browser.
 *
 * One loop drives every algorithm; only the pick rule (#sortKey, #pickBest)
 * and whether a running process can be preempted (SRTF only) differ.
 */

export const ALGORITHM = {
    FCFS: 'fcfs',         // first come first served: ready[0], never preempts
    SJF: 'sjf',           // shortest job first: min burst, never preempts
    SRTF: 'srtf',         // shortest remaining first: min remaining, preempts every tick
    PRIORITY: 'priority', // smallest priority number wins, never preempts
    RR: 'rr',             // round robin: ready[0], requeues when the quantum expires
};

const CONFIG = {
    minBurst: 1,    // burst 0 would never consume a tick, so the process could never finish
    minPriority: 0, // default when the priority field is left blank
};

// Hard ceiling for every user-supplied number (arrival, burst, priority).
// ponytail: caps one field so a synchronous run() stays responsive and cannot
// overflow to Infinity. Raise this together with async/chunked stepping if
// larger time units are ever needed.
export const MAX_VALUE = 100000;

/**
 * Coerce any value to an integer in [min, MAX_VALUE].
 * Non-finite input (NaN, +-Infinity) and everything below `min` collapses to
 * `min`. Used on every entry path so raw numbers from a caller cannot make
 * run()'s tick bound non-finite.
 */
function clampCount(value, min = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min; // NaN, +Infinity, -Infinity
    return Math.min(Math.max(Math.floor(number), min), MAX_VALUE);
}

/**
 * Shallow equality for two index arrays. #recordFrame uses it to detect
 * "same ready queue", so frames merge instead of re-allocating every tick.
 */
function sameIndices(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

const NUMBER_PATTERN = /^\d+$/; // whole non-negative digits only: no sign, decimal, or exponent

// Form-facing messages. The keys are the error keys frontend/app.js maps back
// to the matching input element, so keep them in sync with the form fields.
const ERROR_MESSAGE = {
    pidDuplicate: 'That PID already exists. Choose a different one.',
    arrivalInvalid: `Enter an arrival time from 0 to ${MAX_VALUE}.`,
    burstInvalid: `Enter a burst time from 1 to ${MAX_VALUE}.`,
    priorityInvalid: `Enter a priority from 0 to ${MAX_VALUE}.`,
};

/**
 * Clone one input process into the mutable record the scheduler steps.
 * @param {object} process - caller-supplied process fields
 * @param {number} index - position in the input list
 * @returns {object} runtime process record
 */
function createProcessState(process, index) {
    const burst = clampCount(process.burst, CONFIG.minBurst);
    return {
        ...process,
        index,            // stable tie-breaker and UI identity
        arrival: clampCount(process.arrival),
        burst,
        remaining: burst, // ticks still owed; reaches 0 at completion
        start: null,      // first tick this process ran; null until dispatched
        completion: null, // tick after its last run; null until finished
        quantumUsed: 0,   // consecutive ticks in the current RR slice
    };
}

/** @returns {{running:null, ready:number[], completed:number}} A fresh pre-tick state. */
function initialState() {
    return { running: null, ready: [], completed: 0 };
}

/**
 * Decide the single UI label for one tick.
 * A completion or quantum expiry labelled by #runTick wins; otherwise the first
 * matching transition names the tick. `processes` is read only to resolve PIDs,
 * so this helper has no side effects.
 *
 * @param {Array<object>} processes - runtime process records
 * @param {{previous:number|null, running:number|null, admitted:number[],
 *          event:string|null, pid:string|null}} tick - pre/post schedule owners,
 *   the arrivals admitted this tick, and any label already decided
 * @returns {{event:string|null, pid:string|null}}
 */
function labelForTick(processes, { previous, running, admitted, event, pid }) {
    if (event !== null) return { event, pid };
    if (running !== null && previous !== running) {
        // 'dispatch' when the CPU was idle, 'preempt' when SRTF took it mid-burst.
        return { event: previous === null ? 'dispatch' : 'preempt', pid: processes[running].id };
    }
    if (admitted.length > 0) {
        return { event: 'arrive', pid: processes[admitted[admitted.length - 1]].id }; // newest arrival
    }
    if (running === null) return { event: 'idle', pid: null }; // nobody runnable this tick
    return { event: null, pid: null };
}

/**
 * One merged history frame: a state that held for ticks [start, end).
 * @typedef {object} Frame
 * @property {number} start
 * @property {number} end
 * @property {number|null} running
 * @property {number[]} ready
 * @property {number} completed
 * @property {string|null} event
 * @property {string|null} pid
 */

/**
 * Tick-based CPU scheduler. One `step()` advances the clock by one unit.
 * The same loop drives every algorithm; only the pick rule and whether a
 * running process may be preempted differ.
 *
 * Lifecycle:
 *   1. new Simulation(processes, { algorithm, quantum }) - clones and clamps input.
 *   2. run() to completion, or step() repeatedly for animated playback.
 *   3. read getTimeline() / getHistory() / getStats() / getQueueIndices() / stateAt(t).
 *
 * State fields:
 *   time          - current tick; the unit the next step() executes.
 *   current       - index of the running process, or null when the CPU idles.
 *   ready         - indices waiting for the CPU, in admission order.
 *   timeline      - merged run segments { pid, start, end } for the Gantt lanes.
 *   history       - merged frames { start, end, running, ready, completed, event, pid };
 *                   one entry per state change, covering ticks 0..time-1.
 *   completed     - count of finished processes; equals length when the run is done.
 *   arrivalOrder  - indices sorted by arrival once, so admission never rescans.
 *   arrivalCursor - how far into arrivalOrder admission has progressed.
 */
export class Simulation {
    /**
     * @param {Array<{id:string, arrival:number, burst:number, priority:number}>} processes
     * @param {{algorithm:string, quantum:number}} options
     */
    constructor(processes, options) {
        this.algorithm = options.algorithm;
        this.quantum = options.quantum;
        // SRTF is the only algorithm allowed to take the CPU away mid-burst.
        this.preemptive = options.algorithm === ALGORITHM.SRTF;
        // ponytail: cap arrival/burst again here, not only in parseCount. run()'s
        // tick bound is derived from them, so this is the guard that keeps the
        // engine itself unhangable when a caller passes raw numbers.
        this.processes = processes.map(createProcessState);

        this.time = 0;
        this.current = null;
        this.ready = [];
        this.timeline = [];
        this.history = [];
        this.completed = 0;
        // Sort once at construction: admission then walks this array with a
        // cursor instead of rescanning every process on every tick.
        this.arrivalOrder = this.processes
            .map((_, index) => index)
            .sort((a, b) => this.processes[a].arrival - this.processes[b].arrival || a - b);
        this.arrivalCursor = 0;
    }

    /** @returns {boolean} True when every process has completed. */
    get isDone() {
        // Counter comparison, not a scan, so asking every tick is free.
        return this.completed === this.processes.length;
    }

    /**
     * Advance the clock by one tick. No-op when finished.
     * Order of operations per tick (matches the flowchart):
     *   1. admit arrivals  2. schedule / preempt  3. run one tick
     *   4. complete or expire quantum  5. label the tick for the UI
     *   6. record a frame and advance the clock
     */
    step() {
        if (this.isDone) return;

        // 1. Every process whose arrival time has been reached joins the ready queue.
        const admitted = this.#admitArrivals();
        // Keep the pre-schedule owner: after #schedule() it tells us whether the
        // CPU changed hands mid-tick (SRTF preemption) or stayed put.
        const previous = this.current;
        // 2. Pick a process if the CPU is idle, or let SRTF preempt the running one.
        this.#schedule();

        // 3-4. Whoever holds the CPU now consumes exactly one tick, and may
        // finish or lose the CPU to an expired quantum.
        const running = this.current;
        const outcome = this.#runTick(running);

        // 5. Label the tick: an outcome label wins, else its transition does.
        const label = labelForTick(this.processes, { previous, running, admitted, ...outcome });

        // 6. Snapshot the post-tick state, then move the clock.
        this.#recordFrame(label.event, label.pid);
        this.time += 1;
    }

    /**
     * Run to completion with an upper bound on ticks so a logic bug cannot hang the tab.
     * @returns {boolean} True when the schedule completed.
     */
    run() {
        const maxTicks = this.#maxTicks();

        let ticks = 0;
        while (!this.isDone && ticks < maxTicks) {
            this.step();
            ticks += 1;
        }
        // False only when the bound was hit first, i.e. a scheduler bug.
        return this.isDone;
    }

    /** @returns {Array<{pid:string, start:number, end:number}>} Merged run segments. */
    getTimeline() {
        return this.timeline; // consumed by the Gantt lane renderer in app.js
    }

    /** @returns {Frame[]} Merged history frames covering ticks 0..time-1. */
    getHistory() {
        return this.history; // one entry per state change, not per tick
    }

    /**
     * State after tick `t`: the initial pre-tick state for t <= 0, otherwise the
     * frame covering tick `t-1` (clamped to the recorded range).
     * A frame records the result of the tick it covers, so the scrubber at t
     * must look at tick t-1.
     * @returns {{running:number|null, ready:number[], completed:number}}
     */
    stateAt(t) {
        if (t <= 0 || this.history.length === 0) {
            // Before the first tick (or an unrun simulation): nothing has happened yet.
            return initialState();
        }
        const tick = Math.min(t, this.time) - 1; // past the end: clamp to the last tick
        const frame = this.history.find((candidate) => candidate.start <= tick && tick < candidate.end);
        if (!frame) return initialState();
        // Copy the ready array: callers must not mutate recorded history.
        return { running: frame.running, ready: [...frame.ready], completed: frame.completed };
    }

    /** @returns {number[]} Process indices, running one first then the ready queue. */
    getQueueIndices() {
        // Display order only: the running process sits visually at the head.
        return this.current === null ? [...this.ready] : [this.current, ...this.ready];
    }

    /** @returns {Array<object>} Per-process metrics. */
    getStats() {
        return this.processes.map((process) => this.#metricsFor(process));
    }

    /**
     * Upper bound on the ticks a completed run can need:
     *   totalBurst - every process must burn its whole burst, one tick each
     *   maxArrival - worst case the CPU idles until the last arrival
     *   length     - one tick of slack per process for bookkeeping
     *   +1         - so an empty process list still exits on the first probe
     * @returns {number}
     */
    #maxTicks() {
        const totalBurst = this.processes.reduce((sum, process) => sum + process.burst, 0);
        const maxArrival = this.processes.reduce((max, process) => Math.max(max, process.arrival), 0);
        return totalBurst + maxArrival + this.processes.length + 1;
    }

    /**
     * Move every process whose arrival time has been reached into the ready queue.
     * Walks arrivalOrder once from arrivalCursor: over a whole run the total work
     * is O(n), no rescanning. Ready order = admission order, which FCFS and RR
     * deliberately rely on.
     * @returns {number[]} Indices admitted this tick. */
    #admitArrivals() {
        const admitted = [];
        while (this.arrivalCursor < this.arrivalOrder.length) {
            const index = this.arrivalOrder[this.arrivalCursor];
            if (this.processes[index].arrival > this.time) break; // sorted: nothing later is due either
            this.ready.push(index);
            this.arrivalCursor += 1;
            admitted.push(index);
        }
        return admitted;
    }

    /**
     * Decide which process runs this tick. Two modes:
     *  - CPU idle: take the algorithm's best candidate from the ready queue.
     *  - CPU busy: only SRTF reconsiders, and only if a runnable process has
     *    strictly less remaining time than the current one.
     */
    #schedule() {
        if (this.current === null) {
            const pick = this.#pickBest();
            if (pick !== null) this.#dispatch(pick);
            return;
        }

        if (!this.preemptive) return; // FCFS, SJF, PRIORITY, RR never revisit a running process

        const pick = this.#pickBest();
        if (pick !== null && this.#isBetter(pick, this.current, 'remaining')) {
            // Preempt: the running process returns to the ready queue, not aside.
            this.ready.push(this.current);
            this.#dispatch(pick);
        }
    }

    /** Move `index` from the ready queue onto the CPU with a fresh quantum slice. */
    #dispatch(index) {
        this.#removeReady(index);
        this.processes[index].quantumUsed = 0; // fresh slice on every dispatch
        this.current = index;
    }

    /** @returns {number|null} Index of the process the algorithm would run now. */
    #pickBest() {
        if (this.ready.length === 0) return null; // nothing to run: the tick will be idle

        const key = this.#sortKey();
        if (key === null) return this.ready[0]; // FCFS and Round Robin keep queue order

        // Linear scan: ready queues here are tiny, and a strictly-better rule
        // keeps the earliest candidate on every tie, so scans stay deterministic.
        let best = this.ready[0];
        for (const index of this.ready) {
            if (this.#isBetter(index, best, key)) best = index;
        }
        return best;
    }

    /**
     * @returns {string|null} Process field the algorithm minimises.
     * `null` means "no ordering key": keep ready-queue order (FCFS, RR).
     * SJF compares full burst; SRTF compares remaining, which shrinks as it runs.
     */
    #sortKey() {
        switch (this.algorithm) {
            case ALGORITHM.SJF:
                return 'burst';
            case ALGORITHM.SRTF:
                return 'remaining';
            case ALGORITHM.PRIORITY:
                return 'priority';
            default:
                return null;
        }
    }

    /**
     * Whether `candidate` should beat `incumbent`: smaller key wins, then earlier
     * arrival, then lower original index. The chain is total, so the pick is
     * deterministic for any process list.
     * @param {string} key - field name: 'burst', 'remaining' or 'priority'
     */
    #isBetter(candidate, incumbent, key) {
        const a = this.processes[candidate];
        const b = this.processes[incumbent];
        if (a[key] !== b[key]) return a[key] < b[key];
        if (a.arrival !== b.arrival) return a.arrival < b.arrival;
        return a.index < b.index;
    }

    /** Drop `index` from the ready queue if present. */
    #removeReady(index) {
        // indexOf + splice: ready queues are tiny, no secondary index structure needed.
        const position = this.ready.indexOf(index);
        if (position !== -1) this.ready.splice(position, 1);
    }

    /**
     * Consume one tick on the process holding the CPU, if any: charge the tick,
     * extend the run segment, then finish the process or expire the RR quantum.
     * @param {number|null} running - index of the process on the CPU
     * @returns {{event:string|null, pid:string|null}} A label only when this
     *   method decided one (complete or quantum), otherwise nulls.
     */
    #runTick(running) {
        if (running === null) return { event: null, pid: null };

        const process = this.processes[running];
        // First tick on the CPU defines response time.
        if (process.start === null) process.start = this.time;

        process.remaining -= 1;
        process.quantumUsed += 1;
        // Merge into the previous segment when contiguous, so a 10-tick run
        // stays one rectangle instead of ten.
        this.#appendSegment(process.id, this.time, this.time + 1);

        if (process.remaining === 0) {
            // Finished: completion is the tick after the last one it ran.
            process.completion = this.time + 1;
            this.completed += 1;
            this.current = null;
            return { event: 'complete', pid: process.id };
        }

        if (this.algorithm === ALGORITHM.RR && process.quantumUsed >= this.quantum) {
            // RR quantum expired: requeue at the tail for the next slice.
            process.quantumUsed = 0;
            this.ready.push(running);
            this.current = null;
            return { event: 'quantum', pid: process.id };
        }

        return { event: null, pid: null };
    }

    /**
     * Append a tick, merging it into the previous segment when the PID matches and
     * time is contiguous. The lane renderer then draws one rectangle per run
     * instead of one per tick.
     */
    #appendSegment(pid, start, end) {
        const last = this.timeline[this.timeline.length - 1];
        if (last && last.pid === pid && last.end === start) {
            last.end = end; // extend in place
            return;
        }
        this.timeline.push({ pid, start, end });
    }

    /**
     * Record the state after the tick just executed, merging into the previous
     * frame when the (running, ready, completed) triple is identical.
     * Merging keeps one frame per state change instead of one per tick; a merged
     * frame keeps the first event/pid it was created with, so the toolbar labels
     * where a run started rather than its last transition.
     */
    #recordFrame(event, pid) {
        if (this.#lastFrameMatchesCurrent()) {
            this.history[this.history.length - 1].end = this.time + 1; // same state: widen it
            return;
        }
        this.history.push({
            start: this.time,        // this frame covers ticks [start, end)
            end: this.time + 1,
            running: this.current,   // null while idling
            ready: [...this.ready],  // snapshot: later ticks mutate this.ready
            completed: this.completed,
            event,                   // display label, see step()
            pid,
        });
    }

    /** @returns {boolean} True when the last frame already holds the current state. */
    #lastFrameMatchesCurrent() {
        const last = this.history[this.history.length - 1];
        return (
            last !== undefined &&
            last.running === this.current &&
            last.completed === this.completed &&
            sameIndices(last.ready, this.ready)
        );
    }

    /**
     * Metrics for one process. Values stay null until they are defined.
     * @returns {{id:string, index:number, completion:number|null,
     *            turnaround:number|null, waiting:number|null, response:number|null}}
     */
    #metricsFor(process) {
        const complete = process.completion !== null;
        const turnaround = complete ? process.completion - process.arrival : null;
        return {
            id: process.id,
            index: process.index,
            completion: process.completion,
            turnaround,
            waiting: complete ? turnaround - process.burst : null,
            response: process.start === null ? null : process.start - process.arrival,
        };
    }
}

/**
 * Parse a whole, non-negative number within MAX_VALUE: the strict counterpart
 * of clampCount, used for user input where a bad value must be an error rather
 * than silently clamped. Rejects signs, decimals, exponents, and empty text.
 * @returns {{ok:boolean, value:number}} value is 0 whenever ok is false.
 */
export function parseCount(value) {
    const text = String(value).trim();
    if (!NUMBER_PATTERN.test(text)) return { ok: false, value: 0 };
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_VALUE) return { ok: false, value: 0 };
    return { ok: true, value: parsed };
}

/**
 * Pick the next unused default PID, e.g. P1, P2 ... Comparison is
 * case-insensitive, so a manually entered `p1` also blocks `P1`.
 */
function nextPid(processes) {
    const used = new Set(processes.map((process) => process.id.toLowerCase()));
    let number = 1;
    while (used.has(`p${number}`)) number += 1;
    return `P${number}`;
}

/**
 * Resolve the submitted PID against the existing list.
 * Blank means "you pick one", so it becomes the next free default; an existing
 * PID is reported as an error. IDs compare case-insensitively.
 * @returns {{id:string, error:string|null}}
 */
function resolvePid(rawPid, processes) {
    const id = rawPid.trim();
    if (id === '') return { id: nextPid(processes), error: null };
    const taken = processes.some((process) => process.id.toLowerCase() === id.toLowerCase());
    return { id, error: taken ? ERROR_MESSAGE.pidDuplicate : null };
}

/**
 * Priority is optional: a blank field means CONFIG.minPriority.
 * @returns {{value:number, error:string|null}}
 */
function resolvePriority(rawPriority) {
    if (String(rawPriority).trim() === '') return { value: CONFIG.minPriority, error: null };
    const parsed = parseCount(rawPriority);
    if (!parsed.ok) return { value: CONFIG.minPriority, error: ERROR_MESSAGE.priorityInvalid };
    return { value: parsed.value, error: null };
}

/**
 * Validate raw form values against the current process list.
 * Fields are independent: every invalid one gets its own error key (`pid`,
 * `arrival`, `burst`, `priority`) so the form can highlight each input.
 * Defaults: blank pid -> next free P#, blank priority -> CONFIG.minPriority.
 * @returns {{errors: Record<string,string>, process: object|null}}
 *   `process` is built from the parsed values even when `errors` is non-empty,
 *   so callers must check `errors` before using it.
 */
export function validateProcess(raw, processes) {
    const errors = {};

    const pid = resolvePid(raw.pid, processes);
    if (pid.error !== null) errors.pid = pid.error;

    const arrival = parseCount(raw.arrival);
    if (!arrival.ok) errors.arrival = ERROR_MESSAGE.arrivalInvalid; // arrival 0 is valid

    const burst = parseCount(raw.burst);
    if (!burst.ok || burst.value < CONFIG.minBurst) errors.burst = ERROR_MESSAGE.burstInvalid; // burst 0 is not

    const priority = resolvePriority(raw.priority);
    if (priority.error !== null) errors.priority = priority.error;

    return {
        errors,
        process: { id: pid.id, arrival: arrival.value, burst: burst.value, priority: priority.value },
    };
}
