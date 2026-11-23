import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardHistory } from '../public/board.js';
import * as board from '../public/board.js';

const reference = {
  id: 'placement-1', layoutId: 'layout-1', name: 'Reference', image: '/images/reference.png',
  x: 36, y: 54, width: 240, height: 135,
};

const upload = {
  id: 'placement-2', layoutId: null, name: 'Photo', image: '/images/photo.jpg',
  x: 300, y: 200, width: 160, height: 240,
};

test('undo removes a newly added image and redo restores its full placement', () => {
  let history = createBoardHistory([reference]);
  assert.equal(history.canUndo, false);

  history = history.edit([reference, upload]);
  assert.equal(history.canUndo, true);

  history = history.undo();
  assert.deepEqual(history.items, [reference]);
  assert.equal(history.canRedo, true);

  history = history.redo();
  assert.deepEqual(history.items, [reference, upload]);
  assert.equal(history.canRedo, false);
});

test('one undo restores the position from before a completed move', () => {
  const added = createBoardHistory([]).edit([reference]);
  const moved = { ...reference, x: -24, y: 380 };
  let history = added.edit([moved]);

  history = history.undo();
  assert.deepEqual(history.items, [reference]);
  assert.deepEqual(history.undo().items, []);
  assert.deepEqual(history.redo().items, [moved]);
});

test('an edit made after undo clears the abandoned redo changes', () => {
  const moved = { ...reference, x: 450 };
  const history = createBoardHistory([reference])
    .edit([moved])
    .undo()
    .edit([reference, upload]);

  assert.equal(history.canRedo, false);
  assert.deepEqual(history.redo().items, [reference, upload]);
  assert.deepEqual(history.undo().items, [reference]);
});

test('zoom keeps the world point beneath the pointer and converts drop coordinates', () => {
  const view = { x: 40, y: -24, scale: 1 };
  const pointer = { x: 140, y: 176 };
  assert.deepEqual(board.boardPoint(view, pointer), { x: 100, y: 200 });
  const zoomed = board.zoomBoardView(view, 2, pointer);
  assert.deepEqual(zoomed, { x: -60, y: -224, scale: 2 });
  assert.deepEqual(board.boardPoint(zoomed, pointer), { x: 100, y: 200 });
  assert.deepEqual(board.boardPoint(zoomed, { x: 200, y: 260 }), { x: 130, y: 242 });
});

test('zoom clamps both limits without losing the pointer anchor', () => {
  const view = { x: 0, y: 0, scale: 1 };
  const anchor = { x: 240, y: 120 };
  const smallest = board.zoomBoardView(view, 0.01, anchor);
  const largest = board.zoomBoardView(view, 100, anchor);
  assert.equal(smallest.scale, 0.125);
  assert.equal(largest.scale, 8);
  assert.deepEqual(board.boardPoint(smallest, anchor), anchor);
  assert.deepEqual(board.boardPoint(largest, anchor), anchor);
});

test('resizing preserves aspect ratio and anchors the original top-left', () => {
  const resized = board.resizeBoardImage(reference, 120, 67.5);
  assert.deepEqual(resized, { ...reference, width: 360, height: 202.5 });
  const minimum = board.resizeBoardImage(reference, -1000, -1000);
  assert.equal(minimum.width, 24);
  assert.equal(minimum.height, 13.5);
  const history = createBoardHistory([reference]).edit([resized]);
  assert.deepEqual(history.undo().items, [reference]);
  assert.deepEqual(history.undo().redo().items, [resized]);
});

test('dragging any corner keeps the opposite corner fixed', () => {
  const cases = [
    ['nw', -120, -67.5, -84, -13.5],
    ['ne', 120, -67.5, 36, -13.5],
    ['sw', -120, 67.5, -84, 54],
    ['se', 120, 67.5, 36, 54],
  ];
  for (const [corner, dx, dy, x, y] of cases) {
    const enlarged = board.resizeBoardImage(reference, dx, dy, corner);
    assert.deepEqual(enlarged, { ...reference, x, y, width: 360, height: 202.5 }, corner);
    const shrunk = board.resizeBoardImage(enlarged, -dx, -dy, corner);
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(shrunk[key] - reference[key]) < 1e-10, `${corner} ${key}`);
    }
  }
});
test('waiting for board work includes writes started by an in-flight upload', async () => {
  const { createBoardWork } = await import('../public/board.js');
  const work = createBoardWork();
  const upload = Promise.withResolvers();
  const write = Promise.withResolvers();
  const adding = work.run(async () => {
    await upload.promise;
    work.run(() => write.promise);
  });
  let idle = false;
  const remaining = work.wait().then(() => { idle = true; });
  upload.resolve();
  await adding;
  assert.equal(idle, false);
  write.resolve();
  await remaining;
  assert.equal(idle, true);
});
