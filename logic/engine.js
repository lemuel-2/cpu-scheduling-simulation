/**
 * CPU Scheduling Simulator - engine.js
 *
 * Pure scheduling logic. No DOM, no rendering: safe to import in Node for tests.
 */

export const ALGORITHM = {
    FCFS: 'fcfs',
    SJF: 'sjf',
    SRTF: 'srtf',
    PRIORITY: 'priority',
    RR: 'rr',
};

const CONFIG = {
    minBurst: 1,
    minPriority: 0,
};

// ponytail: caps one field so a synchronous run() stays responsive and cannot
// overflow to Infinity. Raise this together with async/chunked stepping if
// larger time units are ever needed.
export const MAX_VALUE = 100000;

/** Coerce any value to an integer in [min, MAX_VALUE]. Non-finite -> min. */
function clampCount(value, min = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min; // NaN, +Infinity, -Infinity
    return Math.min(Math.max(Math.floor(number), min), MAX_VALUE);
}

/** Shallow equality for two index arrays. */
function sameIndices(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

const NUMBER_PATTERN = /^\d+$/;

const ERROR_MESSAGE = {
    pidDuplicate: 'That PID already exists. Choose a different one.',
    arrivalInvalid: `Enter an arrival time from 0 to ${MAX_VALUE}.`,
    burstInvalid: `Enter a burst time from 1 to ${MAX_VALUE}.`,
    priorityInvalid: `Enter a priority from 0 to ${MAX_VALUE}.`,
};

/**
 * Tick-based CPU scheduler. One `step()` advances the clock by one unit.
 * The same loop drives every algorithm; only the pick rule and whether a
 * running process may be preempted differ.
 */
export class Simulation {
    /**
     * @param {Array<{id:string, arrival:number, burst:number, priority:number}>} processes
     * @param {{algorithm:string, quantum:number}} options
     */
    constructor(processes, options) {
        this.algorithm = options.algorithm;
        this.quantum = options.quantum;
        this.preemptive = options.algorithm === ALGORITHM.SRTF;
        // ponytail: cap arrival/burst again here, not only in parseCount. run()'s
        // tick bound is derived from them, so this is the guard that keeps the
        // engine itself unhangable when a caller passes raw numbers.
        this.processes = processes.map((process, index) => {
            const burst = clampCount(process.burst, CONFIG.minBurst);
            return {
                ...process,
                index,
                arrival: clampCount(process.arrival),
                burst,
                remaining: burst,
                start: null,
                completion: null,
                quantumUsed: 0,
            };
        });

        this.time = 0;
        this.current = null;
        this.ready = [];
        this.timeline = [];
        this.history = [];
        this.completed = 0;
        this.arrivalOrder = this.processes
            .map((_, index) => index)
            .sort((a, b) => this.processes[a].arrival - this.processes[b].arrival || a - b);
        this.arrivalCursor = 0;
    }

    /** @returns {boolean} True when every process has completed. */
    get isDone() {
        return this.completed === this.processes.length;
    }

    /** Advance the clock by one tick. No-op when finished. */
    step() {
        if (this.isDone) return;

        const admitted = this.#admitArrivals();
        const previous = this.current;
        this.#schedule();

        const ran = this.current;
        let event = null;
        let pid = null;

        if (ran !== null) {
            const process = this.processes[ran];
            if (process.start === null) process.start = this.time;

            process.remaining -= 1;
            process.quantumUsed += 1;
            this.#appendSegment(process.id, this.time, this.time + 1);

            if (process.remaining === 0) {
                process.completion = this.time + 1;
                this.completed += 1;
                this.current = null;
                event = 'complete';
                pid = process.id;
            } else if (this.algorithm === ALGORITHM.RR && process.quantumUsed >= this.quantum) {
                process.quantumUsed = 0;
                this.ready.push(this.current);
                this.current = null;
                event = 'quantum';
                pid = process.id;
            }
        }

        if (event === null) {
            if (previous !== null && ran !== null && previous !== ran) {
                event = 'preempt';
                pid = this.processes[ran].id;
            } else if (ran !== null && previous === null) {
                event = 'dispatch';
                pid = this.processes[ran].id;
            } else if (admitted.length > 0) {
                event = 'arrive';
                pid = this.processes[admitted[admitted.length - 1]].id;
            } else if (ran === null) {
                event = 'idle';
            }
        }

        this.#recordFrame(event, pid);
        this.time += 1;
    }

    /**
     * Run to completion with an upper bound on ticks so a logic bug cannot hang the tab.
     * @returns {boolean} True when the schedule completed.
     */
    run() {
        const totalBurst = this.processes.reduce((sum, process) => sum + process.burst, 0);
        const maxArrival = this.processes.reduce((max, process) => Math.max(max, process.arrival), 0);
        const maxTicks = totalBurst + maxArrival + this.processes.length + 1;

        let ticks = 0;
        while (!this.isDone && ticks < maxTicks) {
            this.step();
            ticks += 1;
        }
        return this.isDone;
    }

    /** @returns {Array<{pid:string, start:number, end:number}>} Merged run segments. */
    getTimeline() {
        return this.timeline;
    }

    /** @returns {import('./engine.js').Frame[]} Merged history frames covering ticks 0..time-1. */
    getHistory() {
        return this.history;
    }

    /**
     * State after tick `t`: the initial pre-tick state for t <= 0, otherwise the
     * frame covering tick `t-1` (clamped to the recorded range).
     * @returns {{running:number|null, ready:number[], completed:number}}
     */
    stateAt(t) {
        if (t <= 0 || this.history.length === 0) {
            return { running: null, ready: [], completed: 0 };
        }
        const tick = Math.min(t, this.time) - 1;
        const frame = this.history.find((candidate) => candidate.start <= tick && tick < candidate.end);
        if (!frame) return { running: null, ready: [], completed: 0 };
        return { running: frame.running, ready: [...frame.ready], completed: frame.completed };
    }

    /** @returns {number[]} Process indices, running one first then the ready queue. */
    getQueueIndices() {
        return this.current === null ? [...this.ready] : [this.current, ...this.ready];
    }

    /** @returns {Array<object>} Per-process metrics. */
    getStats() {
        return this.processes.map((process) => {
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
        });
    }

    /** Move every process whose arrival time has been reached into the ready queue.
     * @returns {number[]} Indices admitted this tick. */
    #admitArrivals() {
        const admitted = [];
        while (this.arrivalCursor < this.arrivalOrder.length) {
            const index = this.arrivalOrder[this.arrivalCursor];
            if (this.processes[index].arrival > this.time) break;
            this.ready.push(index);
            this.arrivalCursor += 1;
            admitted.push(index);
        }
        return admitted;
    }

    /** Decide which process runs this tick. */
    #schedule() {
        if (this.current === null) {
            const pick = this.#pickBest();
            if (pick !== null) {
                this.#removeReady(pick);
                this.processes[pick].quantumUsed = 0;
                this.current = pick;
            }
            return;
        }

        if (!this.preemptive) return;

        const pick = this.#pickBest();
        if (pick !== null && this.#isBetter(pick, this.current, 'remaining')) {
            this.#removeReady(pick);
            this.ready.push(this.current);
            this.processes[pick].quantumUsed = 0;
            this.current = pick;
        }
    }

    /** @returns {number|null} Index of the process the algorithm would run now. */
    #pickBest() {
        if (this.ready.length === 0) return null;

        const key = this.#sortKey();
        if (key === null) return this.ready[0]; // FCFS and Round Robin keep queue order

        let best = this.ready[0];
        for (const index of this.ready) {
            if (this.#isBetter(index, best, key)) best = index;
        }
        return best;
    }

    /** @returns {string|null} Process field the algorithm minimises. */
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

    /** Whether `candidate` should beat `incumbent`. Ties break by arrival, then order added. */
    #isBetter(candidate, incumbent, key) {
        const a = this.processes[candidate];
        const b = this.processes[incumbent];
        if (a[key] !== b[key]) return a[key] < b[key];
        if (a.arrival !== b.arrival) return a.arrival < b.arrival;
        return a.index < b.index;
    }

    #removeReady(index) {
        const position = this.ready.indexOf(index);
        if (position !== -1) this.ready.splice(position, 1);
    }

    /** Append a tick, merging it into the previous segment when the PID matches and time is contiguous. */
    #appendSegment(pid, start, end) {
        const last = this.timeline[this.timeline.length - 1];
        if (last && last.pid === pid && last.end === start) {
            last.end = end;
            return;
        }
        this.timeline.push({ pid, start, end });
    }

    /**
     * Record the state after the tick just executed, merging into the previous
     * frame when the (running, ready, completed) triple is identical.
     */
    #recordFrame(event, pid) {
        const last = this.history[this.history.length - 1];
        if (
            last &&
            last.running === this.current &&
            last.completed === this.completed &&
            sameIndices(last.ready, this.ready)
        ) {
            last.end = this.time + 1;
            return;
        }
        this.history.push({
            start: this.time,
            end: this.time + 1,
            running: this.current,
            ready: [...this.ready],
            completed: this.completed,
            event,
            pid,
        });
    }
}

/** Parse a whole, non-negative number within MAX_VALUE. */
export function parseCount(value) {
    const text = String(value).trim();
    if (!NUMBER_PATTERN.test(text)) return { ok: false, value: 0 };
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_VALUE) return { ok: false, value: 0 };
    return { ok: true, value: parsed };
}

/** Pick the next unused default PID, e.g. P1, P2 ... */
function nextPid(processes) {
    const used = new Set(processes.map((process) => process.id.toLowerCase()));
    let number = 1;
    while (used.has(`p${number}`)) number += 1;
    return `P${number}`;
}

/**
 * Validate raw form values against the current process list.
 * @returns {{errors: Record<string,string>, process: object|null}}
 */
export function validateProcess(raw, processes) {
    const errors = {};
    let id = raw.pid.trim();

    if (id === '') {
        id = nextPid(processes);
    } else if (processes.some((process) => process.id.toLowerCase() === id.toLowerCase())) {
        errors.pid = ERROR_MESSAGE.pidDuplicate;
    }

    const arrival = parseCount(raw.arrival);
    if (!arrival.ok) errors.arrival = ERROR_MESSAGE.arrivalInvalid;

    const burst = parseCount(raw.burst);
    if (!burst.ok || burst.value < CONFIG.minBurst) errors.burst = ERROR_MESSAGE.burstInvalid;

    let priority = CONFIG.minPriority;
    if (String(raw.priority).trim() !== '') {
        const parsed = parseCount(raw.priority);
        if (!parsed.ok) errors.priority = ERROR_MESSAGE.priorityInvalid;
        else priority = parsed.value;
    }

    return {
        errors,
        process: { id, arrival: arrival.value, burst: burst.value, priority },
    };
}
