import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLanguage, translator } from '../public/locale.js';
import { assignBoards, removeLabel, moveLayoutToTrash, restoreLayout, deleteTrashedLayout } from '../public/library.js';
import * as library from '../public/library.js';

test('detects Traditional Chinese and falls back to English for other locales', () => {
  for (const language of ['zh-Hant', 'zh-Hant-HK', 'zh-TW', 'zh-HK', 'zh-MO']) {
    assert.equal(selectLanguage(null, language), 'zh-Hant');
  }
  for (const language of ['zh-CN', 'zh-Hans-TW', 'en-US', 'ja-JP', '']) {
    assert.equal(selectLanguage(null, language), 'en');
  }
});

test('uses a saved language and translates interpolated text', () => {
  assert.equal(selectLanguage('en', 'zh-TW'), 'en');
  assert.equal(translator('zh-Hant')('settings'), '設定');
  assert.equal(translator('en')('deleteLayoutPrompt', { name: 'Sample' }), 'Delete “Sample” from Explore?');
});

test('image palette ranks visible colors by area and combines nearby shades', () => {
  const rgba = (color, count) => Array.from({ length: count }, () => color).flat();
  const pixels = Uint8ClampedArray.from([
    ...rgba([192, 32, 48, 255], 20),
    ...rgba([208, 32, 48, 255], 20),
    ...rgba([32, 96, 208, 255], 30),
    ...rgba([232, 192, 32, 255], 10),
    ...rgba([255, 255, 255, 0], 40),
  ]);
  assert.deepEqual(library.imagePalette(pixels), ['#C82030', '#2060D0', '#E8C020']);
  assert.deepEqual(library.imagePalette(Uint8ClampedArray.of(45, 45, 45, 255)), ['#2D2D2D']);
  assert.deepEqual(library.imagePalette(Uint8ClampedArray.of(0, 0, 0, 0)), []);
});

test('masonry places each next card in the shortest column in input order', () => {
  assert.deepEqual(library.packMasonry([210, 330, 160, 180, 100, 120], 3, 12), {
    positions: [
      { column: 0, top: 0 }, { column: 1, top: 0 }, { column: 2, top: 0 },
      { column: 2, top: 172 }, { column: 0, top: 222 }, { column: 0, top: 334 },
    ],
    height: 454,
  });
  assert.deepEqual(library.packMasonry([], 7, 10), { positions: [], height: 0 });
});

test('keeps board placements when a layout is removed from Explore', () => {
  const layout = { id: 'entry', name: 'Sample', image: '/image', labels: ['favorite'] };
  const state = { layouts: [layout], trash: [], boards: [{ id: 'one', items: [] }, { id: 'two', items: [] }] };
  const makeId = () => 'placed';
  assignBoards(state, layout.id, ['one', 'two'], { width: 1600, height: 900 }, makeId);
  assignBoards(state, layout.id, ['one', 'two'], { width: 1600, height: 900 }, makeId);
  assert.deepEqual(state.boards.map(board => board.items.length), [1, 1]);
  moveLayoutToTrash(state, layout.id);
  assert.equal(state.layouts.length, 0);
  assert.deepEqual(state.trash, [layout]);
  assert.equal(state.boards[1].items[0].image, '/image');
  assert.equal(state.boards[1].items[0].name, 'Sample');
  restoreLayout(state, layout.id);
  assert.deepEqual(state.layouts, [layout]);
  assert.deepEqual(state.trash, []);
  moveLayoutToTrash(state, layout.id);
  deleteTrashedLayout(state, layout.id);
  restoreLayout(state, layout.id);
  assert.deepEqual(state.trash, []);
  assert.deepEqual(state.layouts, []);
  assert.equal(state.boards[0].items.length, 1);
});

test('removing a custom label clears all assignments and protects Favorite', () => {
  const state = {
    labels: [{ id: 'favorite' }, { id: 'remove' }],
    layouts: [{ labels: ['remove', 'favorite'] }, { labels: ['remove'] }],
    trash: [{ labels: ['favorite', 'remove'] }],
  };
  removeLabel(state, 'remove');
  removeLabel(state, 'favorite');
  assert.deepEqual(state.labels, [{ id: 'favorite' }]);
  assert.deepEqual(state.layouts.map(layout => layout.labels), [['favorite'], []]);
  assert.deepEqual(state.trash[0].labels, ['favorite']);
});

test('keeps a very narrow image assignable to a board', () => {
  const state = {
    layouts: [{ id: 'entry', name: 'Tall', image: '/image' }],
    boards: [{ id: 'board', items: [] }],
  };
  assignBoards(state, 'entry', ['board'], { width: 1, height: 4000 }, () => 'placed');
  assert.equal(state.boards[0].items[0].width, 1);
  assert.equal(state.boards[0].items[0].height, 240);
});

test('batch adds preserve the selected layouts’ existing labels and board placements', () => {
  const state = {
    layouts: [
      { id: 'one', name: 'One', image: '/one', labels: ['old'] },
      { id: 'two', name: 'Two', image: '/two', labels: ['new'] },
      { id: 'three', name: 'Three', image: '/three', labels: [] },
    ],
    labels: [{ id: 'old' }, { id: 'new' }],
    boards: [{ id: 'old', items: [] }, { id: 'new', items: [] }],
  };
  const size = { width: 1280, height: 720 };
  const makeId = () => crypto.randomUUID();
  assignBoards(state, 'one', ['old'], size, makeId);
  const previous = state.boards[0].items[0];
  library.addLayoutLabels(state, ['one', 'two'], ['new', 'missing']);
  library.addLayoutToBoards(state, 'one', ['new'], size, makeId);
  library.addLayoutToBoards(state, 'two', ['new'], size, makeId);
  library.addLayoutToBoards(state, 'one', ['new'], size, makeId);
  assert.deepEqual(state.layouts.map(layout => layout.labels), [['old', 'new'], ['new'], []]);
  assert.deepEqual(state.boards[0].items, [previous]);
  assert.deepEqual(state.boards[1].items.map(item => item.layoutId), ['one', 'two']);
});

test('new layouts fill three columns and continue below the shortest column', () => {
  const layouts = ['one', 'two', 'three', 'four', 'five'].map(id => ({ id, name: id, image: '/image' }));
  const board = { id: 'board', items: [] };
  const state = { layouts, boards: [board] };
  const sizes = [
    { width: 1280, height: 720 },
    { width: 400, height: 600 },
    { width: 1200, height: 600 },
    { width: 1200, height: 600 },
    { width: 1280, height: 720 },
  ];
  layouts.forEach((layout, index) => {
    library.addLayoutToBoards(state, layout.id, [board.id], sizes[index], () => 'item-' + layout.id);
  });
  assert.deepEqual(board.items.map(({ x, y }) => [x, y]), [
    [56, 56], [400, 56], [744, 56], [744, 240], [56, 260],
  ]);
});

test('new layouts fit around manually positioned images and use open space above them', () => {
  const existing = [
    { id: 'occupied-left', layoutId: 'old', x: 120, y: 40, width: 500, height: 190 },
    { id: 'occupied-low', layoutId: 'old-2', x: 740, y: 300, width: 320, height: 100 },
  ];
  const board = { id: 'board', items: structuredClone(existing) };
  const layouts = ['one', 'two'].map(id => ({ id, name: id, image: '/image' }));
  const state = { layouts, boards: [board] };
  for (const { id } of layouts) {
    assignBoards(state, id, [board.id], { width: 1280, height: 720 }, () => 'item-' + id);
  }
  assert.deepEqual(board.items.slice(0, 2), existing);
  assert.deepEqual(board.items.slice(2).map(({ x, y }) => [x, y]), [[744, 56], [56, 254]]);
});

test('batch removing labels clears active and trashed assignments while protecting Favorite', () => {
  const state = {
    labels: [{ id: 'favorite' }, { id: 'one' }, { id: 'two' }, { id: 'rest' }],
    layouts: [{ labels: ['favorite', 'one', 'rest'] }],
    trash: [{ labels: ['one', 'two'] }],
  };
  library.removeLabels(state, ['favorite', 'one', 'two']);
  assert.deepEqual(state.labels.map(label => label.id), ['favorite', 'rest']);
  assert.deepEqual(state.layouts[0].labels, ['favorite', 'rest']);
  assert.deepEqual(state.trash[0].labels, []);
});

test('a batch import adds one new time label and the selected labels to every picture', () => {
  const timeLabel = '匯入 2026-11-23 21:30:15';
  const state = {
    labels: [{ id: 'web', name: 'Web' }, { id: 'other-batch', name: timeLabel }],
    layouts: [{ id: 'existing', labels: ['other-batch'] }],
  };
  const files = [
    { name: 'First', image: '/images/first.jpg', publisher: '', url: '' },
    { name: 'Second', image: '/images/second.jpg', publisher: '', url: '' },
  ];
  library.addImportedLayouts(state, files, ['web', 'missing', 'web'], timeLabel);
  const batch = state.labels.at(-1);
  assert.equal(state.labels.length, 3);
  assert.equal(batch.name, timeLabel + ' (2)');
  assert.deepEqual(state.layouts.slice(0, 2).map(({ id, labels, ...details }) => details), files);
  assert.deepEqual(state.layouts.map(layout => layout.labels),
    [[batch.id, 'web'], [batch.id, 'web'], ['other-batch']]);
  assert.equal(new Set(state.layouts.map(layout => layout.id)).size, 3);
});

test('importing one picture does not create a time label', () => {
  const state = { labels: [{ id: 'web', name: 'Web' }], layouts: [] };
  library.addImportedLayouts(state, [{ name: 'First' }], ['web'], 'Import 2026-11-23 21:30:15');
  assert.equal(state.labels.length, 1);
  assert.deepEqual(state.layouts[0].labels, ['web']);
});

test('search matches every word across metadata and label names while requiring all selected labels', () => {
  const match = {
    name: 'Étude in blue', publisher: 'Café Studio', siteName: 'Color Index',
    url: 'https://example.com/archive', labels: ['web', 'art'],
  };
  const layouts = [
    match,
    { ...match, labels: ['web'] },
    { ...match, siteName: 'Different site' },
  ];
  const names = new Map([['web', '網頁設計'], ['art', 'Design inspiration']]);
  assert.deepEqual(library.filterLayouts(layouts, {
    query: '  ETUDE Café   INDEX archive 網頁設計 inspiration  ', labelIds: ['web', 'art'],
  }, names), [match]);
  assert.deepEqual(library.filterLayouts(layouts, {
    query: 'web design', labelIds: ['web', 'art'],
  }, names), [match, layouts[2]]);
  assert.deepEqual(library.filterLayouts(layouts, {
    query: '', labelIds: ['art', 'web'],
  }, names), [match, layouts[2]]);
});

test('ratio filters use saved or measured dimensions and omit unmeasured layouts', () => {
  const layouts = [
    { id: 'wide', image: '/wide', width: 1366, height: 768, labels: [] },
    { id: 'tall', image: '/tall', labels: [] },
    { id: 'square', image: '/square', width: 1200, height: 1200, labels: [] },
    { id: 'unknown', image: '/unknown', labels: [] },
  ];
  const sizes = new Map([['/wide', { width: 400, height: 400 }], ['/tall', { width: 720, height: 1280 }]]);
  const ids = ratio => library.filterLayouts(layouts, { ratio }, new Map(), sizes).map(layout => layout.id);
  assert.deepEqual(ids('16:9'), ['wide']);
  assert.deepEqual(ids('square'), ['square']);
  assert.deepEqual(ids('portrait'), ['tall']);
  assert.deepEqual(ids('landscape'), ['wide']);
  assert.deepEqual(ids('any'), ['wide', 'tall', 'square', 'unknown']);
});

test('selected layouts can bypass label filters while still matching search and aspect ratio', () => {
  const matching = { id: 'match', name: 'Design one', labels: ['chosen'], width: 640, height: 480 };
  const selected = { id: 'selected', name: 'Design two', labels: ['other'], width: 480, height: 640 };
  const hidden = { id: 'hidden', name: 'Design three', labels: ['other'], width: 640, height: 480 };
  const layouts = [matching, selected, hidden];
  const labels = { labelIds: ['chosen'] };
  const selection = new Set(['selected']);
  const filter = criteria => library.filterLayouts(layouts, { ...labels, ...criteria }, new Map(), new Map(), selection);
  assert.deepEqual(filter({}), [matching, selected]);
  assert.deepEqual(filter({ query: 'one' }), [matching]);
  assert.deepEqual(filter({ ratio: 'landscape' }), [matching]);
  assert.deepEqual(library.filterLayouts(layouts, labels), [matching]);
});

test('import labels recognize generated legacy names and explicitly marked renamed labels', () => {
  for (const name of ['Import 2026-11-23 12:34:56', '匯入 2026-11-23 12:34:56 (3)']) {
    assert.equal(library.isImportLabel({ name }), true);
  }
  assert.equal(library.isImportLabel({ name: 'Photo research', kind: 'import' }), true);
  assert.equal(library.isImportLabel({ name: 'Import notes' }), false);
});

test('manual label priority overrides legacy pin order and keeps Favorite first', () => {
  const state = {
    labels: [
      { id: 'games' },
      { id: 'favorite' },
      { id: 'batch', pinned: true, kind: 'import' },
      { id: 'website' },
    ],
    settings: {},
  };
  const ids = () => library.orderedLabels(state).map(label => label.id);
  assert.deepEqual(ids(), ['favorite', 'batch', 'games', 'website']);

  assert.equal(library.moveLabel(state, 'batch', 'website', true), true);
  assert.deepEqual(ids(), ['favorite', 'games', 'website', 'batch']);
  assert.deepEqual(library.orderedLabels(JSON.parse(JSON.stringify(state))).map(label => label.id), ids());

  assert.equal(library.moveLabel(state, 'favorite', 'batch', true), false);
  assert.equal(library.moveLabel(state, 'games', 'favorite', false), false);
  assert.equal(library.moveLabel(state, 'games', 'missing', true), false);
  state.labels.push({ id: 'new' });
  assert.deepEqual(ids(), ['favorite', 'games', 'website', 'batch', 'new']);
});

test('merging labels updates active layouts, trash, and saved collections', () => {
  const collections = [{ id: 'one', labelIds: ['source', 'target', 'other', 'favorite'] }];
  const state = {
    labels: [
      { id: 'source', name: 'Source', pinned: true },
      { id: 'target', name: 'Target', customName: true },
      { id: 'other', name: 'Other' },
      { id: 'favorite', name: 'Favorite' },
    ],
    layouts: [{ labels: ['source', 'other', 'target', 'favorite'] }],
    trash: [{ labels: ['source'] }],
    settings: { collections },
  };
  library.mergeLabels(state, ['source', 'target', 'favorite', 'missing'], 'target');
  assert.deepEqual(state.labels, [
    { id: 'target', name: 'Target', customName: true, pinned: true },
    { id: 'other', name: 'Other' },
    { id: 'favorite', name: 'Favorite' },
  ]);
  assert.deepEqual(state.layouts[0].labels, ['target', 'other', 'favorite']);
  assert.deepEqual(state.trash[0].labels, ['target']);
  assert.deepEqual(collections[0].labelIds, ['target', 'other', 'favorite']);
});

test('removing labels also clears their assignments in saved collections', () => {
  const state = {
    labels: [{ id: 'favorite' }, { id: 'removed' }],
    layouts: [],
    trash: [],
    settings: { collections: [{ labelIds: ['favorite', 'removed'] }] },
  };
  library.removeLabels(state, ['favorite', 'removed']);
  assert.deepEqual(state.settings.collections[0].labelIds, ['favorite']);
});

test('video keys normalize provider variants without folding video ID case', () => {
  const youtube = 'youtube:B0J27sf9N1Y';
  for (const url of [
    'youtu.be/B0J27sf9N1Y?t=10',
    'https://m.youtube.com/watch?v=B0J27sf9N1Y&list=unused',
    'https://www.youtube.com/shorts/B0J27sf9N1Y/',
    'https://www.youtube-nocookie.com/embed/B0J27sf9N1Y',
  ]) assert.equal(library.videoKey(url), youtube);
  assert.equal(library.videoKey('https://www.youtube.com/live/b0J27sf9N1Y'), 'youtube:b0J27sf9N1Y');
  assert.equal(library.videoKey('https://m.bilibili.com/video/BV1NE2DBKER9/?share_source=copy'), 'bilibili:BV1NE2DBKER9');
  assert.equal(library.videoKey('https://www.bilibili.com/video/AV001234'), 'bilibili:av1234');
  assert.equal(library.videoKey('https://b23.tv/demo'), null);
  assert.equal(library.videoKey('https://youtu.be.example.com/B0J27sf9N1Y'), null);
});

test('import planning finds video and image matches with active layouts taking priority', () => {
  const image = '/images/' + 'a'.repeat(64) + '.jpg';
  const archivedDigest = 'b'.repeat(64);
  const partial = '/legacy/scan.jpg';
  const active = { id: 'video-active', url: 'https://www.youtube.com/watch?v=B0J27sf9N1Y', image };
  const trashedVideo = { ...active, id: 'video-trash' };
  const trashedImage = { id: 'image-trash', url: '', image: '/examples/photo.jpg' };
  const otherVideo = { url: 'https://www.youtube.com/shorts/Wx84FdVvU2A', image };
  const existingPath = { id: 'legacy', url: '', image: partial };
  const newImage = { url: '', image: '/legacy/other.jpg' };
  const state = { layouts: [active, existingPath], trash: [trashedVideo, trashedImage] };
  const entries = [
    { url: 'https://youtu.be/B0J27sf9N1Y?t=30', image: '/different-preview' },
    { url: 'https://www.youtube-nocookie.com/embed/B0J27sf9N1Y', image },
    { url: 'https://example.com/gallery', image: '/images/' + archivedDigest + '.jpg' },
    { url: '', image: '/images/' + archivedDigest + '.png' },
    { url: '', image: partial },
    otherVideo,
    newImage,
    { ...newImage, name: 'Repeat' },
  ];
  const plan = library.planImports(state, entries, new Map([['/examples/photo.jpg', archivedDigest.toUpperCase()]]));
  assert.deepEqual(plan, {
    newEntries: [otherVideo, newImage],
    duplicateLayouts: [
      { layout: active, trashed: false },
      { layout: trashedImage, trashed: true },
      { layout: existingPath, trashed: false },
    ],
    repeatedCount: 3,
  });
});

test('an image file can match a saved video thumbnail by its bytes', () => {
  const image = '/images/' + 'a'.repeat(64) + '.jpg';
  const video = { id: 'one', image, url: 'https://youtu.be/B0J27sf9N1Y' };
  const picture = { image, url: 'https://youtu.be/aaaaaaaaaaa', sourceType: 'image' };
  const plan = library.planImports({ layouts: [video], trash: [] }, [picture]);
  assert.deepEqual(plan.duplicateLayouts, [{ layout: video, trashed: false }]);
  assert.deepEqual(plan.newEntries, []);
});

test('an atomic import can attach labels to selected active duplicates alongside new entries', () => {
  const state = {
    layouts: [{ id: 'existing', labels: ['old'] }, { id: 'other', labels: ['new'] }],
    trash: [{ id: 'trashed', labels: [] }],
    labels: [{ id: 'old', name: 'Old' }, { id: 'new', name: 'New' }],
  };
  const time = 'Import 2026-11-23 12:34:56';
  library.addImportedLayouts(state, [{ name: 'First' }], ['new', 'missing'], time, ['existing', 'existing', 'trashed']);
  const batch = state.labels.at(-1);
  assert.equal(batch.name, time);
  assert.equal(batch.kind, 'import');
  assert.deepEqual(state.layouts.map(layout => layout.labels), [[batch.id, 'new'], ['old', batch.id, 'new'], ['new']]);
  assert.deepEqual(state.trash[0].labels, []);
});

test('selecting the same existing import twice with no new entries does not create a batch', () => {
  const state = { labels: [{ id: 'new', name: 'New' }], layouts: [{ id: 'existing', labels: [] }] };
  library.addImportedLayouts(state, [], ['new'], 'Import 2026-11-23 12:34:56', ['existing', 'existing', 'missing']);
  assert.equal(state.labels.length, 1);
  assert.deepEqual(state.layouts[0].labels, ['new']);
});

test('website URLs accept blank and bare HTTP(S) destinations and reject credentials', () => {
  assert.equal(library.normalizeWebsiteUrl('  '), '');
  assert.equal(library.normalizeWebsiteUrl(' EXAMPLE.com/path '), 'https://example.com/path');
  assert.equal(library.normalizeWebsiteUrl('http://example.com'), 'http://example.com/');
  for (const url of ['not a website', 'https://', 'javascript:alert(1)', 'https://user:pass@example.com']) {
    assert.equal(library.normalizeWebsiteUrl(url), null);
  }
});
