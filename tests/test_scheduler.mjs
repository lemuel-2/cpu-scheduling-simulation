// Self-check for the scheduler engine: node --test tests/test_scheduler.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { Simulation, ALGORITHM, MAX_VALUE, parseCount, validateProcess } from '../logic/engine.js';
import { cursorSlices, statusForCursor, visibleResults, historyFrameRows } from '../frontend/app.js';
const P = (id, arrival, burst, priority = 0) => ({ id, arrival, burst, priority });
const run = (processes, algorithm, quantum = 2) => {
  const sim = new Simulation(processes, { algorithm, quantum });
  assert.equal(sim.run(), true, `${algorithm} should finish`);
  return sim;
};

test('FCFS: sequential, no idle', () => {
  const sim = run([P('P1', 0, 3), P('P2', 0, 2)], ALGORITHM.FCFS);
  const stats = sim.getStats();
  assert.deepEqual(stats.map((s) => s.completion), [3, 5]);
  assert.deepEqual(stats.map((s) => s.waiting), [0, 3]);
});

test('FCFS: idle gap before first arrival', () => {
  const sim = run([P('P1', 4, 2)], ALGORITHM.FCFS);
  assert.equal(sim.getTimeline()[0].start, 4);
  assert.equal(sim.getStats()[0].completion, 6);
});

test('SJF: shortest burst first', () => {
  const sim = run([P('P1', 0, 5), P('P2', 0, 2)], ALGORITHM.SJF);
  assert.deepEqual(sim.getTimeline().map((s) => s.pid), ['P2', 'P1']);
});

test('SRTF: preempts a long job for a shorter arrival', () => {
  const sim = run([P('P1', 0, 5), P('P2', 1, 2)], ALGORITHM.SRTF);
  assert.deepEqual(sim.getTimeline().map((s) => s.pid), ['P1', 'P2', 'P1']);
  assert.deepEqual(sim.getStats().map((s) => s.completion), [7, 3]);
});

test('Priority non-preemptive: lowest number runs first', () => {
  const sim = run(
    [P('P1', 0, 3, 5), P('P2', 0, 1, 1)],
    ALGORITHM.PRIORITY,
  );
  assert.deepEqual(sim.getTimeline().map((s) => s.pid), ['P2', 'P1']);
});

test('Round Robin: honours the quantum and rotates', () => {
  const sim = run([P('P1', 0, 5), P('P2', 0, 3)], ALGORITHM.RR, 2);
  assert.deepEqual(sim.getTimeline().map((s) => s.pid), ['P1', 'P2', 'P1', 'P2', 'P1']);
});

test('metrics: response time is first run minus arrival', () => {
  const sim = run([P('P1', 8, 2)], ALGORITHM.FCFS);
  const [row] = sim.getStats();
  assert.equal(row.response, 0);
  assert.equal(row.turnaround, 2);
});

test('parseCount: rejects overflow, non-numeric and negatives', () => {
  assert.equal(parseCount('9'.repeat(400)).ok, false); // Number() would be Infinity
  assert.equal(parseCount(String(MAX_VALUE + 1)).ok, false);
  assert.equal(parseCount('1e9').ok, false);
  assert.equal(parseCount('-1').ok, false);
  assert.equal(parseCount('abc').ok, false);
  assert.deepEqual(parseCount(String(MAX_VALUE)), { ok: true, value: MAX_VALUE });
  assert.deepEqual(parseCount('0'), { ok: true, value: 0 });
});

test('validateProcess: oversized burst is rejected before it can hang run()', () => {
  const { errors } = validateProcess(
    { pid: 'P1', arrival: '0', burst: '9'.repeat(400), priority: '' },
    [],
  );
  assert.ok(errors.burst, 'burst error expected');
});

/* ---------- history (queue observability) ---------- */

function lcg(seed) {
  let state = seed >>> 0;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function randomProcesses(seed) {
  const rnd = lcg(seed + 1);
  const count = 1 + Math.floor(rnd() * 3);
  const processes = [];
  for (let i = 0; i < count; i += 1) {
    processes.push({
      id: `P${i + 1}`,
      arrival: Math.floor(rnd() * 5),
      burst: 1 + Math.floor(rnd() * 4),
      priority: Math.floor(rnd() * 4),
    });
  }
  return processes;
}

const sameTriple = (a, b) =>
  a.running === b.running &&
  a.completed === b.completed &&
  a.ready.length === b.ready.length &&
  a.ready.every((value, index) => value === b.ready[index]);

test('history: frames are contiguous and cover every tick exactly once', () => {
  const sim = run([P('P1', 0, 3), P('P2', 1, 2)], ALGORITHM.FCFS);
  let cursor = 0;
  for (const frame of sim.getHistory()) {
    assert.equal(frame.start, cursor, 'frame starts where the previous ended');
    assert.ok(frame.end > frame.start, 'frame covers at least one tick');
    cursor = frame.end;
  }
  assert.equal(cursor, sim.time, 'frames cover 0..time');
});

test('history: stateAt(0) is the initial state', () => {
  const sim = run([P('P1', 0, 3)], ALGORITHM.FCFS);
  assert.deepEqual(sim.stateAt(0), { running: null, ready: [], completed: 0 });
});

test('history: consecutive identical triples are merged', () => {
  const sim = run([P('P1', 0, 5), P('P2', 2, 1)], ALGORITHM.FCFS);
  const history = sim.getHistory();
  for (let i = 1; i < history.length; i += 1) {
    assert.ok(!sameTriple(history[i - 1], history[i]), 'adjacent frames must differ');
  }
});

test('history: stateAt(t) equals replaying t step() calls (fuzz, all algorithms)', () => {
  const quantumChoices = [1, 2, 3];
  for (let seed = 0; seed < 40; seed += 1) {
    const processes = randomProcesses(seed);
    for (const algorithm of Object.values(ALGORITHM)) {
      const quantum = quantumChoices[seed % quantumChoices.length];
      const complete = new Simulation(processes, { algorithm, quantum });
      complete.run();
      for (let t = 0; t <= complete.time; t += 1) {
        const replayed = new Simulation(processes, { algorithm, quantum });
        for (let i = 0; i < t; i += 1) replayed.step();
        assert.deepEqual(
          complete.stateAt(t),
          { running: replayed.current, ready: [...replayed.ready], completed: replayed.completed },
          `seed ${seed} ${algorithm} t=${t}`,
        );
      }
    }
  }
});

test('history: events are tagged at the correct ticks', () => {
  const fcfs = run([P('P1', 0, 2), P('P2', 0, 2)], ALGORITHM.FCFS);
  const events = fcfs.getHistory().map((frame) => [frame.start, frame.event, frame.pid]);
  assert.deepEqual(events, [
    [0, 'dispatch', 'P1'],
    [1, 'complete', 'P1'],
    [2, 'dispatch', 'P2'],
    [3, 'complete', 'P2'],
  ]);
});

test('history: idle frames merge and carry an idle event', () => {
  const sim = run([P('P1', 3, 1)], ALGORITHM.FCFS);
  const idle = sim.getHistory().find((frame) => frame.event === 'idle');
  assert.ok(idle, 'an idle frame exists');
  assert.equal(idle.start, 0);
  assert.equal(idle.end, 3);
});

test('history: arrival into a busy CPU is tagged arrive', () => {
  const sim = run([P('P1', 0, 5), P('P2', 2, 1)], ALGORITHM.FCFS);
  const arrive = sim.getHistory().find((frame) => frame.event === 'arrive');
  assert.ok(arrive, 'an arrive frame exists');
  assert.equal(arrive.start, 2);
  assert.equal(arrive.pid, 'P2');
});

test('run() terminates when the engine is fed uncapped arrival/burst', () => {
  const sim = new Simulation(
    [
      { id: 'P1', arrival: 0, burst: Infinity },
      { id: 'P2', arrival: 1e12, burst: 1e12 },
    ],
    { algorithm: ALGORITHM.FCFS, quantum: 2 },
  );
  assert.equal(sim.run(), true, 'must terminate, not hang');
  for (const process of sim.processes) {
    assert.ok(Number.isFinite(process.burst) && process.burst <= MAX_VALUE);
    assert.ok(Number.isFinite(process.arrival) && process.arrival <= MAX_VALUE);
  }
  assert.ok(sim.getStats().every((stat) => stat.completion !== null));
});

/* ---------- app: cursor-driven render helpers ---------- */

test('cursorSlices: drops segments past the cursor and truncates the spanning one', () => {
  const timeline = [
    { pid: 'P1', start: 0, end: 3 },
    { pid: 'P2', start: 5, end: 8 },
  ];
  const slices = cursorSlices(timeline, 6);
  assert.deepEqual(slices.map((s) => [s.pid, s.start, s.end, s.partial]), [
    ['P1', 0, 3, false],
    [null, 3, 5, false],
    ['P2', 5, 6, true],
  ]);
});

test('cursorSlices: cursor before the first segment yields only leading idle', () => {
  const slices = cursorSlices([{ pid: 'P1', start: 4, end: 6 }], 2);
  assert.deepEqual(slices, [{ pid: null, start: 0, end: 2, idle: true, partial: false }]);
});

test('statusForCursor: idle at 0, running between, finished at end', () => {
  assert.deepEqual(statusForCursor(0, 7), { state: 'idle', text: 'Idle' });
  assert.deepEqual(statusForCursor(3, 7), { state: 'running', text: 't = 3' });
  assert.deepEqual(statusForCursor(7, 7), { state: 'finished', text: 'Finished' });
});

test('visibleResults: only processes completed at or before the cursor', () => {
  const stats = [
    { index: 0, completion: 2 },
    { index: 1, completion: 6 },
    { index: 2, completion: null },
  ];
  assert.deepEqual(visibleResults(stats, 3).map((row) => row.index), [0]);
  assert.deepEqual(visibleResults(stats, 6).map((row) => row.index), [0, 1]);
});

test('historyFrameRows: maps indices to pids and keeps the tick range', () => {
  const processes = [{ id: 'P1' }, { id: 'P2' }];
  const history = [
    { start: 0, end: 2, running: 0, ready: [1], completed: 0, event: 'dispatch', pid: 'P1' },
    { start: 2, end: 3, running: null, ready: [], completed: 2, event: 'complete', pid: 'P2' },
  ];
  assert.deepEqual(historyFrameRows(history, processes), [
    { start: 0, end: 2, runningPid: 'P1', readyPids: ['P2'], event: 'dispatch', pid: 'P1' },
    { start: 2, end: 3, runningPid: null, readyPids: [], event: 'complete', pid: 'P2' },
  ]);
});

