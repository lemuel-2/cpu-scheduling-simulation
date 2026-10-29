/**
 * CPU Scheduling Simulator - engine.js
 *
 * Scheduling logic only. No page code, no timers, so it also runs in Node tests.
 *
 * Time moves one tick per step(). Each step produces one history entry and may
 * extend a timeline segment. A full run needs at most the total burst plus the
 * idle ticks before the last arrival.
 *
 * Used by:
 *  - frontend/app.js: builds a Simulation, runs it, then reads the timeline,
 *    history, stats, and state at a given tick.
 *  - tests/test_scheduler.mjs: uses the same API without a browser.
 *
 * All algorithms share one loop. Only two things differ: which process is
 * picked, and whether SRTF may take the CPU from a running process.
 */

export const ALGORITHM = {
    FCFS: 'fcfs',         // first come first served: first in the queue runs, no taking the CPU back
    SJF: 'sjf',           // shortest job first: smallest burst runs, no taking the CPU back
    SRTF: 'srtf',         // shortest remaining time first: smallest remaining runs, may take the CPU back each tick
    PRIORITY: 'priority', // smallest priority number runs, no taking the CPU back
    RR: 'rr',             // round robin: first in the queue runs, goes to the back when its quantum ends
};

const CONFIG = {
    minBurst: 1,    // burst 0 would never use a tick, so the process could never finish
    minPriority: 0, // used when the priority field is left blank
};

// Largest number the form accepts for arrival, burst, or priority.
// The cap keeps one run() call from running too long or reaching Infinity.
// Raise it together with chunked stepping if larger times are ever needed.
export const MAX_VALUE = 100000;

/**
 * Turn any value into a whole number between `min` and MAX_VALUE.
 * Missing, NaN, or infinite input becomes `min`.
 * Every entry point uses it so a raw caller value cannot break run()'s tick limit.
 */
function clampCount(value, min = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min; // NaN, +Infinity, -Infinity
    return Math.min(Math.max(Math.floor(number), min), MAX_VALUE);
}

/** True when two index lists hold the same values in the same order. */
function sameIndices(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

const NUMBER_PATTERN = /^\d+$/; // digits only: no sign, decimal point, or exponent

// Messages shown by the form. The keys match the input fields in frontend/app.js,
// so keep them in sync.
const ERROR_MESSAGE = {
    pidDuplicate: 'That PID already exists. Choose a different one.',
    arrivalInvalid: `Enter an arrival time from 0 to ${MAX_VALUE}.`,
    burstInvalid: `Enter a burst time from 1 to ${MAX_VALUE}.`,
    priorityInvalid: `Enter a priority from 0 to ${MAX_VALUE}.`,
};

/**
 * Copy one input process into the record the scheduler changes while it runs.
 * @param {object} process - process fields supplied by the caller
 * @param {number} index - position in the input list
 * @returns {object} process record used while running
 */
function createProcessState(process, index) {
    const burst = clampCount(process.burst, CONFIG.minBurst);
    return {
        ...process,
        index,            // fixed tie-breaker and UI identity
        arrival: clampCount(process.arrival),
        burst,
        remaining: burst, // ticks still owed; reaches 0 when the process finishes
        start: null,      // first tick this process ran; null until it gets the CPU
        completion: null, // tick after its last run; null until it finishes
        quantumUsed: 0,   // ticks used in the current RR turn
    };
}

/** @returns {{running:null, ready:number[], completed:number}} Fresh state before the first tick. */
function initialState() {
    return { running: null, ready: [], completed: 0 };
}

/**
 * Choose the label shown for one tick.
 * A label already set by #runTick (complete or quantum) wins. Otherwise the
 * first change this tick gives the label. `processes` is read only to find PIDs,
 * so this helper changes nothing.
 *
 * @param {Array<object>} processes - process records used while running
 * @param {{previous:number|null, running:number|null, admitted:number[],
 *          event:string|null, pid:string|null}} tick - the process running before
 *   and after scheduling, the arrivals added this tick, and any label already set
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
    if (running === null) return { event: 'idle', pid: null }; // nothing could run this tick
    return { event: null, pid: null };
}

/**
 * One merged history record: a state that lasted for ticks [start, end).
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
 * Tick-based CPU scheduler. One `step()` moves time forward by one tick.
 * Every algorithm runs the same loop; only the pick rule and whether a running
 * process can be replaced differ.
 *
 * Lifecycle:
 *   1. new Simulation(processes, { algorithm, quantum }) - copies and limits input.
 *   2. run() to completion, or step() repeatedly for animated playback.
 *   3. read getTimeline() / getHistory() / getStats() / getQueueIndices() / stateAt(t).
 *
 * State fields:
 *   time          - current tick; the tick the next step() runs.
 *   current       - index of the running process, or null when the CPU is idle.
 *   ready         - indices waiting for the CPU, in the order they arrived.
 *   timeline      - merged run segments { pid, start, end } for the chart.
 *   history       - merged frames { start, end, running, ready, completed, event, pid };
 *                   one entry per state change, covering ticks 0..time-1.
 *   completed     - number of finished processes; equals the list length when done.
 *   arrivalOrder  - indices sorted by arrival once, so new arrivals never cause a rescan.
 *   arrivalCursor - how far through arrivalOrder new arrivals have been added.
 */
export class Simulation {
    /**
     * @param {Array<{id:string, arrival:number, burst:number, priority:number}>} processes
     * @param {{algorithm:string, quantum:number}} options
     */
    constructor(processes, options) {
        this.algorithm = options.algorithm;
        this.quantum = options.quantum;
        // SRTF is the only algorithm that may take the CPU from a running process.
        this.preemptive = options.algorithm === ALGORITHM.SRTF;
        // Also limit arrival and burst here, not only in parseCount. run()'s tick
        // limit is based on them, so this keeps the engine from hanging when a
        // caller passes raw numbers.
        this.processes = processes.map(createProcessState);

        this.time = 0;
        this.current = null;
        this.ready = [];
        this.timeline = [];
        this.history = [];
        this.completed = 0;
        // Sort once at construction. New arrivals are then added by walking this
        // list with a position marker instead of checking every process each tick.
        this.arrivalOrder = this.processes
            .map((_, index) => index)
            .sort((a, b) => this.processes[a].arrival - this.processes[b].arrival || a - b);
        this.arrivalCursor = 0;
    }

    /** @returns {boolean} True when every process has finished. */
    get isDone() {
        // Compare counts, so checking every tick costs nothing.
        return this.completed === this.processes.length;
    }

    /**
     * Move time forward by one tick. Does nothing when the run is finished.
     * Order of work per tick (matches the flowchart):
     *   1. add new arrivals  
     *   2. schedule or replace the running process  
     *   3. run one tick
     *   4. finish the process or end the quantum  
     *   5. label the tick for the UI
     *   6. record a frame and move the clock
     */
    step() {
        if (this.isDone) return;

        // 1. Every process whose arrival time has been reached joins the ready queue.
        const admitted = this.#admitArrivals();
        // Remember who had the CPU before scheduling, to see whether it changed
        // hands this tick (SRTF) or stayed put.
        const previous = this.current;
        // 2. Pick a process if the CPU is idle, or let SRTF replace the running one.
        this.#schedule();

        // 3-4. Whoever holds the CPU now uses exactly one tick, and may finish or
        // lose the CPU when its quantum ends.
        const running = this.current;
        const outcome = this.#runTick(running);

        // 5. Label the tick: a finish or quantum label wins, else a change does.
        const label = labelForTick(this.processes, { previous, running, admitted, ...outcome });

        // 6. Save the state after the tick, then move the clock.
        this.#recordFrame(label.event, label.pid);
        this.time += 1;
    }

    /**
     * Run to the end, with a tick limit so a logic bug cannot freeze the page.
     * @returns {boolean} True when the schedule finished.
     */
    run() {
        const maxTicks = this.#maxTicks();

        let ticks = 0;
        while (!this.isDone && ticks < maxTicks) {
            this.step();
            ticks += 1;
        }
        // False only when the limit was reached first, which means a scheduler bug.
        return this.isDone;
    }

    /** @returns {Array<{pid:string, start:number, end:number}>} Merged run segments. */
    getTimeline() {
        return this.timeline; // read by the chart renderer in app.js
    }

    /** @returns {Frame[]} Merged history frames covering ticks 0..time-1. */
    getHistory() {
        return this.history; // one entry per state change, not per tick
    }

    /**
     * State after tick `t`: the state before the first tick when t <= 0, otherwise
     * the frame covering tick `t-1` (kept within the recorded range).
     * A frame records the result of the tick it covers, so the scrubber at t must
     * look at tick t-1.
     * @returns {{running:number|null, ready:number[], completed:number}}
     */
    stateAt(t) {
        if (t <= 0 || this.history.length === 0) {
            // Before the first tick (or an unrun simulation): nothing has happened yet.
            return initialState();
        }
        const tick = Math.min(t, this.time) - 1; // past the end: use the last tick
        const frame = this.history.find((candidate) => candidate.start <= tick && tick < candidate.end);
        if (!frame) return initialState();
        // Copy the ready list: callers must not change recorded history.
        return { running: frame.running, ready: [...frame.ready], completed: frame.completed };
    }

    /** @returns {number[]} Process indices, the running one first, then the ready queue. */
    getQueueIndices() {
        // Display order only: the running process sits at the front.
        return this.current === null ? [...this.ready] : [this.current, ...this.ready];
    }

    /** @returns {Array<object>} Metrics for each process. */
    getStats() {
        return this.processes.map((process) => this.#metricsFor(process));
    }

    /**
     * Most ticks a finished run can need:
     *   totalBurst - every process must use its whole burst, one tick each
     *   maxArrival - worst case, the CPU sits idle until the last arrival
     *   length     - one spare tick per process
     *   +1         - so an empty process list still stops on the first check
     * @returns {number}
     */
    #maxTicks() {
        const totalBurst = this.processes.reduce((sum, process) => sum + process.burst, 0);
        const maxArrival = this.processes.reduce((max, process) => Math.max(max, process.arrival), 0);
        return totalBurst + maxArrival + this.processes.length + 1;
    }

    /**
     * Move every process whose arrival time has been reached into the ready queue.
     * Walks arrivalOrder once from arrivalCursor. Each process is added once per
     * run, so nothing is checked twice. Ready order is arrival order, which FCFS
     * and RR rely on.
     * @returns {number[]} Indices added this tick. */
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
     * Decide which process runs this tick. Two cases:
     *  - CPU idle: take the algorithm's best process from the ready queue.
     *  - CPU busy: only SRTF looks again, and only if a ready process has
     *    strictly less remaining time than the current one.
     */
    #schedule() {
        if (this.current === null) {
            const pick = this.#pickBest();
            if (pick !== null) this.#dispatch(pick);
            return;
        }

        if (!this.preemptive) return; // FCFS, SJF, PRIORITY, RR never replace a running process

        const pick = this.#pickBest();
        if (pick !== null && this.#isBetter(pick, this.current, 'remaining')) {
            // The running process goes back to the ready queue, not aside.
            this.ready.push(this.current);
            this.#dispatch(pick);
        }
    }

    /** Move `index` from the ready queue onto the CPU with a new quantum count. */
    #dispatch(index) {
        this.#removeReady(index);
        this.processes[index].quantumUsed = 0; // new count on every dispatch
        this.current = index;
    }

    /** @returns {number|null} Index of the process the algorithm would run now. */
    #pickBest() {
        if (this.ready.length === 0) return null; // nothing to run: the tick will be idle

        const key = this.#sortKey();
        if (key === null) return this.ready[0]; // FCFS and Round Robin keep queue order

        // A simple scan is fine: ready queues are small. When two processes tie,
        // the earlier one stays picked, so the result is always the same.
        let best = this.ready[0];
        for (const index of this.ready) {
            if (this.#isBetter(index, best, key)) best = index;
        }
        return best;
    }

    /**
     * @returns {string|null} The process field the algorithm picks the smallest of.
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
     * True when `candidate` should be picked over `incumbent`: the smaller key
     * wins, then the earlier arrival, then the lower original index. This always
     * gives one answer, so any process list produces the same result every run.
     * @param {string} key - field name: 'burst', 'remaining' or 'priority'
     */
    #isBetter(candidate, incumbent, key) {
        const a = this.processes[candidate];
        const b = this.processes[incumbent];
        if (a[key] !== b[key]) return a[key] < b[key];
        if (a.arrival !== b.arrival) return a.arrival < b.arrival;
        return a.index < b.index;
    }

    /** Remove `index` from the ready queue if it is there. */
    #removeReady(index) {
        // A simple search is fine: ready queues are small, so no extra index is needed.
        const position = this.ready.indexOf(index);
        if (position !== -1) this.ready.splice(position, 1);
    }

    /**
     * Use one tick on the process holding the CPU, if any: count the tick, add
     * to the run segment, then finish the process or end the RR quantum.
     * @param {number|null} running - index of the process on the CPU
     * @returns {{event:string|null, pid:string|null}} A label only when this
     *   method set one (complete or quantum), otherwise nulls.
     */
    #runTick(running) {
        if (running === null) return { event: null, pid: null };

        const process = this.processes[running];
        // The first tick on the CPU sets the response time.
        if (process.start === null) process.start = this.time;

        process.remaining -= 1;
        process.quantumUsed += 1;
        // Add to the previous segment when the times touch, so a 10-tick run stays
        // one rectangle instead of ten.
        this.#appendSegment(process.id, this.time, this.time + 1);

        if (process.remaining === 0) {
            // Finished: completion is the tick after the last one it ran.
            process.completion = this.time + 1;
            this.completed += 1;
            this.current = null;
            return { event: 'complete', pid: process.id };
        }

        if (this.algorithm === ALGORITHM.RR && process.quantumUsed >= this.quantum) {
            // RR quantum ended: send the process to the back for its next turn.
            process.quantumUsed = 0;
            this.ready.push(running);
            this.current = null;
            return { event: 'quantum', pid: process.id };
        }

        return { event: null, pid: null };
    }

    /**
     * Add one tick, merging it into the previous segment when the PID matches and
     * the times touch. The chart then draws one rectangle per run instead of one
     * per tick.
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
     * Record the state after the tick just run, merging it into the previous
     * frame when the (running, ready, completed) values are the same.
     * Merging keeps one frame per state change instead of one per tick. A merged
     * frame keeps the first event and PID it was created with, so the toolbar
     * labels where a run started, not its last change.
     */
    #recordFrame(event, pid) {
        if (this.#lastFrameMatchesCurrent()) {
            this.history[this.history.length - 1].end = this.time + 1; // same state: make it longer
            return;
        }
        this.history.push({
            start: this.time,        // this frame covers ticks [start, end)
            end: this.time + 1,
            running: this.current,   // null while idle
            ready: [...this.ready],  // copy: later ticks change this.ready
            completed: this.completed,
            event,                   // label shown in the UI, see step()
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
     * Metrics for one process. Values stay null until they can be calculated.
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
 * Read a whole non-negative number up to MAX_VALUE: the strict version of
 * clampCount, used for user input where a bad value must be an error instead of
 * being changed silently. Rejects signs, decimals, exponent form, and empty text.
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
 * Pick the next unused default PID, e.g. P1, P2 ... Comparison ignores case,
 * so a manually entered `p1` also blocks `P1`.
 */
export function nextPid(processes) {
    const used = new Set(processes.map((process) => process.id.toLowerCase()));
    let number = 1;
    while (used.has(`p${number}`)) number += 1;
    return `P${number}`;
}

/**
 * Match the submitted PID against the existing list.
 * Blank means "you pick one", so it becomes the next free default number. A PID
 * already in the list is reported as an error. IDs compare without case.
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
 * Check raw form values against the current process list.
 * Fields are independent: every bad one gets its own error key (`pid`, `arrival`,
 * `burst`, `priority`) so the form can highlight each input.
 * Defaults: blank pid -> next free P#, blank priority -> CONFIG.minPriority.
 * @returns {{errors: Record<string,string>, process: object|null}}
 *   `process` is built from the parsed values even when `errors` is not empty,
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
