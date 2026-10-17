// Self-check for the Gantt slice builder: node --test tests/test_render.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSlices } from '../frontend/app.js';

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
