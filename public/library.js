import { labelName, translator } from './locale.js';
import { boardImageWidth, placeBoardImages } from './board.js';

const labelLanguages = [translator('en'), translator('zh-Hant')];

function searchText(value = '') {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function hasSize(size) {
  return size && Number.isFinite(size.width) && Number.isFinite(size.height) &&
    size.width > 0 && size.height > 0;
}

function matchesRatio(size, ratio) {
  if (!hasSize(size)) return false;
  const { width, height } = size;
  switch (ratio) {
    case '16:9': return Math.abs((width / height) / (16 / 9) - 1) <= 0.01;
    case 'square': return width === height;
    case 'portrait': return width < height;
    case 'landscape': return width > height;
    default: return false;
  }
}

export function filterLayouts(layouts, filter, labelNames = new Map(), sizes = new Map()) {
  const { query = '', labelIds = [], ratio = 'any' } = filter;
  const words = searchText(query.trim()).split(/\s+/).filter(Boolean);
  return layouts.filter(layout => {
    if (!labelIds.every(id => layout.labels.includes(id))) return false;
    if (ratio !== 'any' && !matchesRatio(hasSize(layout) ? layout : sizes.get(layout.image), ratio)) return false;
    if (!words.length) return true;

    const names = layout.labels.flatMap(id => [
      labelNames.get(id),
      ...labelLanguages.map(t => labelName({ id, name: '' }, t)),
    ]);
    const searchable = searchText([layout.name, layout.publisher, layout.siteName, layout.url, ...names].join(' '));
    return words.every(word => searchable.includes(word));
  });
}

export function assignBoards(state, layoutId, selectedIds, size, makeId = () => crypto.randomUUID()) {
  const layout = state.layouts.find(item => item.id === layoutId);
  if (!layout) return;
  const scale = Math.min(boardImageWidth / size.width, 240 / size.height);
  for (const board of state.boards) {
    if (!selectedIds.includes(board.id)) {
      board.items = board.items.filter(item => item.layoutId !== layoutId);
      continue;
    }
    if (board.items.some(item => item.layoutId === layoutId)) continue;
    const [placement] = placeBoardImages(board.items, [{
      id: makeId(),
      layoutId,
      name: layout.name,
      image: layout.image,
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
    }]);
    board.items.push(placement);
  }
}

export function addLayoutToBoards(state, layoutId, boardIds, size, makeId) {
  const selected = new Set(boardIds);
  for (const board of state.boards) {
    if (board.items.some(item => item.layoutId === layoutId)) selected.add(board.id);
  }
  assignBoards(state, layoutId, [...selected], size, makeId);
}

export function addLayoutLabels(state, layoutIds, labelIds) {
  const selected = new Set(layoutIds);
  const valid = new Set(state.labels.map(label => label.id));
  const additions = labelIds.filter(id => valid.has(id));
  for (const layout of state.layouts) {
    if (selected.has(layout.id)) layout.labels = [...new Set([...layout.labels, ...additions])];
  }
}

export function isImportLabel(label) {
  return label.kind === 'import' ||
    /^(?:Import|匯入) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: \(\d+\))?$/.test(label.name);
}

export function addImportedLayouts(state, entries, labelIds, timeLabel, existingIds = []) {
  const valid = new Set(state.labels.map(label => label.id));
  const labels = [...new Set(labelIds.filter(id => valid.has(id)))];
  const selected = new Set(existingIds);
  const existing = state.layouts.filter(layout => selected.has(layout.id));
  if (entries.length + existing.length > 1 && timeLabel?.trim()) {
    const names = new Set(state.labels.map(label => label.name.toLocaleLowerCase()));
    let name = timeLabel;
    for (let suffix = 2; names.has(name.toLocaleLowerCase()); suffix++) {
      name = `${timeLabel} (${suffix})`;
    }
    const id = crypto.randomUUID();
    state.labels.push({ id, name, kind: 'import' });
    labels.unshift(id);
  }
  for (const layout of existing) {
    layout.labels = [...new Set([...layout.labels, ...labels])];
  }
  state.layouts = entries.map(entry => ({ ...entry, id: crypto.randomUUID(), labels: [...labels] })).concat(state.layouts);
}

export function normalizeWebsiteUrl(value) {
  if (value == null) return '';
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!input) return '';
  const explicit = /^https?:\/\//i.test(input);
  const bareDomain = /^[^/?#:\s]+\.[^/?#:\s]+(?=[:/?#]|$)/u.test(input);
  if (!explicit && !bareDomain) return null;
  try {
    const url = new URL(explicit ? input : 'https://' + input);
    if (!url.username && !url.password) return url.href;
  } catch {
    // Invalid destinations are handled by the caller.
  }
  return null;
}

const youtubeHosts = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);
const bilibiliHosts = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com']);

export function videoKey(value) {
  const normalized = normalizeWebsiteUrl(value);
  if (!normalized) return null;
  const { hostname, pathname, port, searchParams } = new URL(normalized);
  if (port) return null;
  if (hostname === 'youtu.be' || youtubeHosts.has(hostname)) {
    const id = hostname === 'youtu.be'
      ? pathname.match(/^\/([^/]+)\/?$/)?.[1]
      : /^\/watch\/?$/.test(pathname)
        ? searchParams.get('v')
        : pathname.match(/^\/(?:shorts|live|embed|v)\/([^/]+)\/?$/)?.[1];
    if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return 'youtube:' + id;
  }
  if (bilibiliHosts.has(hostname)) {
    const id = pathname.match(/^\/video\/([^/]+)\/?$/)?.[1];
    if (id && /^BV[a-zA-Z0-9]{10}$/.test(id)) return 'bilibili:' + id;
    const aid = id?.match(/^av(\d+)$/i)?.[1];
    if (aid) return 'bilibili:av' + aid.replace(/^0+(?=\d)/, '');
  }
  return null;
}

function imageKey(entry, exampleImageKeys) {
  if (!entry.image) return null;

  const hash = entry.image.match(/^\/images\/([a-f0-9]{64})\.(?:jpg|png|webp|gif|avif|bmp)$/i)?.[1] ??
    exampleImageKeys.get(entry.image);
  return /^[a-f0-9]{64}$/i.test(hash) ? 'image:' + hash.toLowerCase() : 'path:' + entry.image;
}

export function planImports(state, entries, exampleImageKeys = new Map()) {
  const existing = new Map();
  for (const [layouts, trashed] of [[state.layouts, false], [state.trash ?? [], true]]) {
    for (const layout of layouts) {
      const video = layout.sourceType === 'image' ? null : videoKey(layout.url);
      for (const key of [video, imageKey(layout, exampleImageKeys)]) {
        if (key && !existing.has(key)) existing.set(key, { layout, trashed });
      }
    }
  }

  const seen = new Set();
  const newEntries = [];
  const duplicateLayouts = [];
  const duplicateIds = new Set();
  let repeatedCount = 0;
  for (const entry of entries) {
    const video = entry.sourceType === 'image' ? null : videoKey(entry.url);
    const key = video ?? imageKey(entry, exampleImageKeys);
    const duplicate = existing.get(key);
    if ((key && seen.has(key)) || (duplicate && duplicateIds.has(duplicate.layout.id))) {
      repeatedCount++;
      continue;
    }
    if (key) seen.add(key);

    if (duplicate) {
      duplicateLayouts.push(duplicate);
      duplicateIds.add(duplicate.layout.id);
    } else {
      newEntries.push(entry);
    }
  }
  return { newEntries, duplicateLayouts, repeatedCount };
}

function takeLayout(layouts, id) {
  const index = layouts.findIndex(layout => layout.id === id);
  if (index !== -1) return layouts.splice(index, 1)[0];
}

export function moveLayoutToTrash(state, id) {
  const layout = takeLayout(state.layouts, id);
  if (layout) state.trash.unshift(layout);
}

export function restoreLayout(state, id) {
  const layout = takeLayout(state.trash, id);
  if (layout) state.layouts.unshift(layout);
}

export function deleteTrashedLayout(state, id) {
  takeLayout(state.trash, id);
}

export function removeLabel(state, id) {
  removeLabels(state, [id]);
}

function updateLabelAssignments(state, update) {
  for (const layout of [...state.layouts, ...(state.trash ?? [])]) {
    layout.labels = update(layout.labels);
  }
  for (const collection of state.settings?.collections ?? []) {
    collection.labelIds = update(collection.labelIds);
  }
}

export function removeLabels(state, ids) {
  const removed = new Set(ids);
  removed.delete('favorite');
  if (!removed.size) return;
  state.labels = state.labels.filter(label => !removed.has(label.id));
  updateLabelAssignments(state, labels => labels.filter(id => !removed.has(id)));
}

export function mergeLabels(state, sourceIds, targetId) {
  const target = state.labels.find(label => label.id === targetId);
  if (!target) return;
  const sources = new Set(sourceIds);
  sources.delete('favorite');
  sources.delete(targetId);
  const merged = state.labels.filter(label => sources.has(label.id));
  if (!merged.length) return;

  if (target.id !== 'favorite' && merged.some(label => label.pinned)) target.pinned = true;
  state.labels = state.labels.filter(label => !sources.has(label.id));
  updateLabelAssignments(state, labels => [...new Set(labels.map(id => sources.has(id) ? targetId : id))]);
}
