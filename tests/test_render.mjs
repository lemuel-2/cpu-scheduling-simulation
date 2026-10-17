// Self-check for the Gantt slice builder and the lane geometry:
// node --test tests/test_render.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { axisTicks, buildSlices, laneReadout, laneRows } from '../frontend/app.js';

const DOT = ' \u00b7 ';

/** Compare fractions without demanding bit-identical floats. */
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} vs ${expected}`);

test('buildSlices: leading idle before the first arrival', () => {
  const slices = buildSlices([{ pid: 'P1', start: 4, end: 6 }]);
  assert.deepEqual(slices, [
    { pid: null, start: 0, end: 4, idle: true },
    { pid: 'P1', start: 4, end: 6, idle: false },
  ]);
});

test('buildSlices: idle gap between disjoint segments', () => {
  const slices = buildSlices([
    { pid: 'P1', start: 0, end: 3 },
    { pid: 'P2', start: 5, end: 8 },
  ]);
  assert.deepEqual(slices.map((s) => [s.pid, s.start, s.end]), [
    ['P1', 0, 3],
    [null, 3, 5],
    ['P2', 5, 8],
  ]);
});

test('buildSlices: contiguous segments get no idle between', () => {
  const slices = buildSlices([
    { pid: 'P1', start: 0, end: 3 },
    { pid: 'P2', start: 3, end: 5 },
  ]);
  assert.equal(slices.filter((s) => s.idle).length, 0);
});

test('buildSlices: covers total span with no gaps', () => {
  const slices = buildSlices([
    { pid: 'P1', start: 2, end: 4 },
    { pid: 'P2', start: 7, end: 9 },
  ]);
  let cursor = 0;
  for (const slice of slices) {
    assert.equal(slice.start, cursor, 'slice starts where the previous ended');
    cursor = slice.end;
  }
  assert.equal(cursor, 9);
});

test('axisTicks: round steps, the finish time kept when it does not crowd', () => {
  assert.deepEqual(axisTicks(21), [0, 5, 10, 15, 21]);
  assert.deepEqual(axisTicks(68), [0, 10, 20, 30, 40, 50, 60, 68]);
  assert.deepEqual(axisTicks(5), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(axisTicks(0), [0]);
});

test('laneRows: bars carry the tick span they were cut to, not just fractions', () => {
  const processes = [{ id: 'P1' }, { id: 'P2' }];
  const timeline = [{ pid: 'P2', start: 0, end: 5 }, { pid: 'P1', start: 5, end: 21 }];

  const { rows } = laneRows(timeline, processes, 12);

  assert.deepEqual(rows[0].bars.map((bar) => [bar.start, bar.finish]), [[5, 12]]);
  assert.deepEqual(rows[1].bars.map((bar) => [bar.start, bar.finish]), [[0, 5]]);
});

test('laneReadout: one run, its tick span, waiting only when the process finished', () => {
  assert.equal(laneReadout('P5', [[7, 13]], 21),
    ['P5', 'runs 7\u201313', '6 of 21 ticks'].join(DOT));
  assert.equal(laneReadout('P5', [[7, 13]], 21, { waiting: 6 }),
    ['P5', 'runs 7\u201313', '6 of 21 ticks', 'waiting 6'].join(DOT));
  assert.equal(laneReadout('P3', [], 21), ['P3', 'not run yet'].join(DOT));
});

test('laneReadout: a few runs are listed, a round robin collapses to a count', () => {
  assert.equal(laneReadout('P2', [[7, 9], [13, 15]], 21),
    ['P2', '2 runs', '7\u20139, 13\u201315', '4 of 21 ticks'].join(DOT));
  assert.equal(laneReadout('P4', [[1, 2], [3, 4], [5, 6], [7, 8], [9, 11]], 21),
    ['P4', '5 runs', '6 of 21 ticks'].join(DOT));
});

test('laneRows: one row per process in list order, fractions of the whole run', () => {
  const processes = [{ id: 'P1' }, { id: 'P2' }];
  const timeline = [{ pid: 'P2', start: 0, end: 5 }, { pid: 'P1', start: 5, end: 21 }];

  const { total, rows } = laneRows(timeline, processes, 21);

  assert.equal(total, 21);
  assert.deepEqual(rows.map((row) => row.pid), ['P1', 'P2']);
  assert.deepEqual(rows.map((row) => row.index), [0, 1]);
  near(rows[0].bars[0].left, 5 / 21, 'P1 starts at tick 5');
  near(rows[0].bars[0].width, 16 / 21, 'P1 runs 16 ticks');
  near(rows[1].bars[0].left, 0, 'P2 starts at tick 0');
  near(rows[1].bars[0].width, 5 / 21, 'P2 runs 5 ticks');
});

test('laneRows: bars truncate at the cursor, and a process that never ran has none', () => {
  const processes = [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }];
  const timeline = [{ pid: 'P1', start: 5, end: 12 }, { pid: 'P2', start: 12, end: 16 }];

  const { total, rows } = laneRows(timeline, processes, 9);

  assert.equal(total, 16);
  near(rows[0].bars[0].left, 5 / 16, 'P1 keeps its position');
  near(rows[0].bars[0].width, 4 / 16, 'P1 is cut at tick 9');
  assert.deepEqual(rows[1].bars, [], 'P2 has not started by tick 9');
  assert.deepEqual(rows[2].bars, [], 'P3 never ran');
  for (const row of rows) {
    for (const bar of row.bars) {
      assert.ok(bar.left >= 0 && bar.width > 0 && bar.left + bar.width <= 1, 'bar stays inside the axis');
    }
  }
});
