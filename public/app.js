import { labelName, selectLanguage, translator } from './locale.js';
import {
  assignBoards, addLayoutToBoards, addLayoutLabels, addImportedLayouts, removeLabel, removeLabels,
  moveLayoutToTrash, restoreLayout, deleteTrashedLayout, filterLayouts, isImportLabel, mergeLabels,
  moveLabel, orderedLabels, searchText,
  videoKey, planImports, normalizeWebsiteUrl, layoutDimensions, imagePalette, packMasonry,
} from './library.js';
import { mountBoard } from './board.js';

const main = document.querySelector('#content');
const dialog = document.querySelector('#dialog');
const navigation = document.querySelector('#navigation');
const navigationToggle = document.querySelector('#navigation-toggle');
const sidebar = document.querySelector('#sidebar');
const updateNotice = document.querySelector('#update-notice');
const toast = document.querySelector('#toast');
const tabs = ['explore', 'labels', 'whiteboards', 'settings', 'trash'];
const imageExtensions = /\.(avif|bmp|gif|jpe?g|png|webp)$/i;
const imageMime = /^image\/(avif|bmp|gif|jpeg|png|webp|x-ms-bmp)$/;
const imageAccept = 'image/avif,image/bmp,image/gif,image/jpeg,image/png,image/webp,.bmp';
const importTimeFormat = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium' });
const ratios = [['any', 'allRatios'], ['16:9', 'wideRatio'], ['landscape', 'landscapeRatio'], ['square', 'squareRatio'], ['portrait', 'portraitRatio']];
const noFilters = { query: '', labelIds: [], ratio: 'any' };
const imageDimensions = new Map();
const galleryColumnOptions = [3, 5, 7];
const galleryDragType = 'application/x-inspiration-layout';
const galleryDropSelector = '.nav-board-link, .nav-tab[data-tab="trash"]';

let state;
let tab = 'explore';
let exploreFilter = { ...noFilters };
let exploreScroll;
let activeCollection = '';
let readingDimensions = 0;
let dimensionFrame = 0;
let masonryFrame = 0;
const masonryObserver = new ResizeObserver(() => {
  if (masonryFrame) return;
  masonryFrame = requestAnimationFrame(() => {
    masonryFrame = 0;
    layOutExploreGallery(main.querySelector('.grid'));
  });
});
const labelQuickObserver = new ResizeObserver(entries => {
  for (const { target } of entries) {
    if (target.isConnected) fitQuickLabels(target);
    else labelQuickObserver.unobserve(target);
  }
});
let previewSequence = [];
let previewIndex = -1;
let boardId = '';
let boardListOpen = false;
let draggedLayoutId = '';
let galleryDropTarget = null;
let bulkSelection = null;
let bulkAnchorId = '';
let controlClickId = '';
let savingLabelOrder = false;
let stopBoard;
let addDraft;
let toastTimer;
let saveQueue = Promise.resolve();
let navigationRequest = 0;
let updateStarted = false;
let installedVersion = '';
let updateResult = null;
let updateRequest = null;
let updateFailed = false;
let offerUpdate = false;
let dismissedUpdate = '';
let t = translator(selectLanguage(null, navigator.language));

const spec = { explore: renderExplore, labels: renderLabels, whiteboards: renderBoards, trash: renderTrash, settings: renderSettings };
const bulkCommands = {
  labels: [['merge-selected-labels', 'mergeLabels'], ['bulk-delete', 'deleteLabel', true]],
  whiteboards: [['bulk-delete', 'deleteBoard', true]],
  trash: [['bulk-restore', 'restoreLayout'], ['bulk-delete', 'deletePermanently', true]],
};
const exploreBulkShortcuts = {
  delete: 'bulk-delete', backspace: 'bulk-delete', t: 'bulk-labels', w: 'bulk-boards', c: 'compare-layouts',
};

function html(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function txt(key, values) {
  return html(t(key, values));
}

function error(key) {
  return new Error(t(key));
}

function showToast(message, role) {
  clearTimeout(toastTimer);
  toast.setAttribute('role', role);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 7500);
}

function showError(message) {
  showToast(message, 'alert');
}

async function api(path, options) {
  let response;
  const headers = new Headers(options?.headers);
  if (options?.method === 'POST' || options?.method === 'PUT') headers.set('X-Inspiration-Request', '1');
  try {
    response = await fetch(`/api/${path}`, { ...options, headers, credentials: 'omit' });
  } catch {
    throw error('serverError');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw error(data?.error || 'serverError');
  return data;
}

function json(method, value) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

function change(update) {
  const pending = saveQueue.then(async () => {
    const draft = structuredClone(state);
    update(draft);
    state = await api('state', json('PUT', draft));
  });
  saveQueue = pending.catch(() => {});
  return pending;
}

async function uploadImage(file) {
  const type = file.type === 'image/x-ms-bmp' ? 'image/bmp' : file.type;
  return api('image', {
    method: 'POST',
    headers: { 'Content-Type': type || 'application/octet-stream' },
    // WKWebView does not deliver file-backed Blob bodies to custom schemes.
    body: await file.arrayBuffer(),
  });
}

function layoutById(id) {
  return state.layouts.find(layout => layout.id === id);
}

function imageSize(url) {
  const image = new Image();
  image.src = url;
  return image.decode().then(() => ({ width: image.naturalWidth, height: image.naturalHeight }));
}

function pageHead(title, controls = '') {
  return `<div class="page-head"><h1>${txt(title)}</h1>${controls ? `<div class="page-actions">${controls}</div>` : ''}</div>`;
}

function newButton(label, action) {
  return `<button type="button" class="btn primary" data-action="${action}"><span class="symbol" aria-hidden="true">+</span>${txt(label)}</button>`;
}

function bulkButton(hasItems) {
  return `<button type="button" class="btn" data-action="toggle-bulk" aria-pressed="${Boolean(bulkSelection)}"${!hasItems && !bulkSelection ? ' disabled' : ''}>
    ${txt(bulkSelection ? 'endBulkSelect' : 'bulkSelect')}
  </button>`;
}

function allShownSelected(ids) {
  return ids.length > 0 && ids.every(id => bulkSelection.has(id));
}

function bulkToolbar(ids) {
  if (!bulkSelection) return '';
  return `<div class="bulk-toolbar" role="group" aria-label="${txt('bulkActions')}">
    <button type="button" class="btn" data-action="select-visible"${ids.length === 0 ? ' disabled' : ''}>${txt(allShownSelected(ids) ? 'deselectVisible' : 'selectVisible')}</button>
    <span class="count" data-bulk-count role="status">${txt('bulkCount', { count: bulkSelection.size })}</span>
    <div class="bulk-commands">
      ${bulkCommands[tab].map(([action, label, danger]) => `<button type="button" class="btn${danger ? ' danger' : ''}" data-bulk-command data-action="${action}"${bulkSelection.size ? '' : ' disabled'}>${txt(label)}</button>`).join('')}
    </div>
  </div>`;
}

function bulkRow(id, name, body) {
  return `<label class="bulk-row">
    <input type="checkbox" data-bulk-id="${html(id)}" aria-label="${html(name)}"${bulkSelection.has(id) ? ' checked' : ''}>
    ${body}
  </label>`;
}

function labelTags(layout, labels = orderedLabels(state)) {
  return labels
    .filter(label => layout.labels.includes(label.id))
    .map(label => `<span class="tag">${html(labelName(label, t))}</span>`);
}

function metadata(layout) {
  const labels = labelTags(layout).join('');
  const publisher = layout.publisher ? `<span class="publisher">${html(layout.publisher)}</span>` : '';
  const website = layout.siteName ? `<span class="publisher">${html(layout.siteName)}</span>` : '';
  return labels || publisher || website ? `<span class="metadata">${labels}${website}${publisher}</span>` : '';
}

function imageSizeAttributes(layout) {
  const size = layoutDimensions(layout, imageDimensions);
  return size ? ` width="${size.width}" height="${size.height}"` : '';
}

function overlayLabels(tags) {
  return tags.slice(0, 3).join('') + (tags.length > 3 ? '<span class="card-label-overflow">...</span>' : '');
}

function cardCaption(layout) {
  const author = layout.publisher ? `<span class="publisher">${html(layout.publisher)}</span>` : '';
  return `<span class="title">${html(layout.name)}</span>${author}`;
}

function card(layout, draggable, labelOrder) {
  const id = html(layout.id);
  const favorite = layout.labels.includes('favorite');
  const heart = txt(favorite ? 'favoriteRemove' : 'favoriteAdd');
  const labels = labelTags(layout, labelOrder);
  const activation = bulkSelection
    ? `data-action="select-layout" data-bulk-id="${id}" aria-pressed="${bulkSelection.has(layout.id)}"`
    : 'data-action="preview" aria-haspopup="dialog"';
  return `<article class="card" data-layout="${id}">
    <button class="card-preview" type="button" ${activation} data-id="${id}" aria-label="${html(layout.name)}">
      ${bulkSelection ? '<span class="selection-mark" aria-hidden="true"></span>' : ''}
      <img class="art" src="${html(layout.image)}" alt=""${imageSizeAttributes(layout)} loading="lazy" decoding="async" draggable="${draggable}">
      <span class="card-caption" aria-hidden="true">${cardCaption(layout)}</span>
      <span class="card-labels" aria-hidden="true"${labels.length ? '' : ' hidden'}>${overlayLabels(labels)}</span>
    </button>
    ${bulkSelection ? '' : `<div class="card-actions">
      <button type="button" class="icon-btn favorite" data-action="favorite" data-id="${id}" aria-pressed="${favorite}" aria-label="${heart}" title="${heart}">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l8.13 8.13a1 1 0 0 0 1.42 0l8.13-8.13a5.5 5.5 0 0 0 0-7.78Z"/>
        </svg>
      </button>
      <button type="button" class="icon-btn" data-action="organize" data-id="${id}" aria-haspopup="dialog" aria-label="${txt('organize')}" title="${txt('organize')}">⋯</button>
    </div>`}
  </article>`;
}

function hasExploreFilters() {
  return Boolean(exploreFilter.query.trim() || exploreFilter.labelIds.length || exploreFilter.ratio !== 'any');
}

function savedCollections() {
  return Array.isArray(state.settings.collections) ? state.settings.collections : [];
}

function currentLayouts(filter = exploreFilter, selectedIds) {
  const names = new Map(state.labels.map(label => [label.id, `${labelName(label, t)} ${label.name}`]));
  return filterLayouts(state.layouts, filter, names, imageDimensions, selectedIds);
}

function loadExploreDimensions() {
  const candidates = currentLayouts({ ...exploreFilter, ratio: 'any' }, bulkSelection);
  for (const layout of candidates) {
    if (readingDimensions >= 6) break;
    if (layoutDimensions(layout, imageDimensions) || imageDimensions.has(layout.image)) continue;
    const path = layout.image;
    imageDimensions.set(path, null);
    readingDimensions++;
    imageSize(path).then(size => imageDimensions.set(path, size)).catch(() => {}).finally(() => {
      readingDimensions--;
      if (dimensionFrame || tab !== 'explore' || exploreFilter.ratio === 'any') return;
      dimensionFrame = requestAnimationFrame(() => {
        dimensionFrame = 0;
        if (tab === 'explore' && exploreFilter.ratio !== 'any') keepExploreScroll(updateExploreResults);
      });
    });
  }
}

function galleryColumns(settings = state.settings) {
  const count = settings.galleryColumns;
  return galleryColumnOptions.includes(count) ? count : galleryColumnOptions[0];
}

function nextGalleryColumns(count) {
  return galleryColumnOptions[(galleryColumnOptions.indexOf(count) + 1) % galleryColumnOptions.length];
}

function layOutExploreGallery(grid) {
  if (!grid) return;
  const content = grid.firstElementChild;
  const cards = [...content.children];
  const width = cards[0].getBoundingClientRect().width;
  const gap = parseFloat(getComputedStyle(grid).getPropertyValue('--gallery-gap'));
  const heights = cards.map(card => card.getBoundingClientRect().height);
  const { positions, height } = packMasonry(heights, Number(grid.dataset.columns), gap);
  for (const [index, { column, top }] of positions.entries()) {
    cards[index].style.left = `${column * (width + gap)}px`;
    cards[index].style.top = `${top}px`;
  }
  content.style.height = `${height}px`;
}

function observeExploreGallery(grid) {
  masonryObserver.disconnect();
  if (!grid) return;
  layOutExploreGallery(grid);
  const content = grid.firstElementChild;
  masonryObserver.observe(content);
  for (const card of content.children) masonryObserver.observe(card);
}

function captureExploreScroll() {
  const grid = main.querySelector('.grid');
  const x = window.scrollX;
  const y = window.scrollY;
  const galleryX = grid?.scrollLeft ?? 0;
  const galleryBounds = grid?.getBoundingClientRect();
  const scrolledIntoGallery = y > 0 && galleryBounds?.top <= 0;
  const anchor = scrolledIntoGallery ? [...grid.querySelectorAll('.card')].find(card => {
    const bounds = card.getBoundingClientRect();
    return bounds.bottom > 0 && bounds.top < window.innerHeight &&
      bounds.right > galleryBounds.left && bounds.left < galleryBounds.right;
  }) : null;
  return { x, y, galleryX, galleryTop: galleryBounds?.top, anchorId: anchor?.dataset.layout, anchorTop: anchor?.getBoundingClientRect().top };
}

function restoreExploreScroll({ x, y, galleryX, galleryTop, anchorId, anchorTop }) {
  const next = main.querySelector('.grid');
  if (next) next.scrollLeft = galleryX;
  const nextAnchor = anchorId && next?.querySelector(`[data-layout="${CSS.escape(anchorId)}"]`);
  const top = nextAnchor
    ? window.scrollY + nextAnchor.getBoundingClientRect().top - anchorTop
    : y > 0 && galleryTop <= 0 && next
      ? window.scrollY + next.getBoundingClientRect().top - galleryTop : y;
  window.scrollTo({ left: x, top, behavior: 'instant' });
}

function keepExploreScroll(refresh) {
  const position = captureExploreScroll();
  refresh();
  restoreExploreScroll(position);
}

function refreshExploreCard(id) {
  const card = main.querySelector(`.grid [data-layout="${CSS.escape(id)}"]`);
  const layout = currentLayouts().find(item => item.id === id);
  if (!card || !layout) return null;
  card.querySelector('.card-caption').innerHTML = cardCaption(layout);
  card.querySelector('.card-preview').setAttribute('aria-label', layout.name);
  const tags = labelTags(layout);
  const overlay = card.querySelector('.card-labels');
  overlay.innerHTML = overlayLabels(tags);
  overlay.hidden = tags.length === 0;
  const heart = card.querySelector('.favorite');
  if (heart) {
    const selected = layout.labels.includes('favorite');
    const label = t(selected ? 'favoriteRemove' : 'favoriteAdd');
    heart.setAttribute('aria-pressed', String(selected));
    heart.setAttribute('aria-label', label);
    heart.title = label;
  }
  return card;
}

function updateGalleryColumns() {
  const button = main.querySelector('[data-action="gallery-columns"]');
  if (!button) return;
  const count = galleryColumns();
  const grid = main.querySelector('.grid');
  if (grid && Number(grid.dataset.columns) !== count) {
    grid.dataset.columns = String(count);
    layOutExploreGallery(grid);
  }
  const label = t('cycleGalleryColumns', { count, next: nextGalleryColumns(count) });
  button.setAttribute('aria-label', label);
  button.title = label;
  const step = 20 / count;
  const tiles = Array.from({ length: count }, (_, column) => {
    const x = 2.55 + column * step;
    const width = step - 1.1;
    return `<rect x="${x}" y="6" width="${width}" height="5.2" rx=".5"/>
      <rect x="${x}" y="12.8" width="${width}" height="5.2" rx=".5"/>`;
  }).join('');
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${tiles}</svg>`;
}

async function cycleGalleryColumns() {
  await change(saved => { saved.settings.galleryColumns = nextGalleryColumns(galleryColumns(saved.settings)); });
  updateGalleryColumns();
}

function canDragGalleryImages() {
  return tab === 'explore' && !bulkSelection;
}

function updateExploreResults() {
  const results = main.querySelector('.search-results');
  if (!results) return;
  if (draggedLayoutId) endGalleryDrag();
  if (exploreFilter.ratio !== 'any') loadExploreDimensions();
  const layouts = currentLayouts(exploreFilter, bulkSelection);
  const hadFocus = results.contains(document.activeElement) ? document.activeElement : null;
  const loading = exploreFilter.ratio !== 'any' && readingDimensions > 0;
  main.querySelector('[data-result-count]').textContent = loading ? t('loadingDimensions')
    : t(layouts.length === 1 ? 'oneLayout' : 'manyLayouts', { count: layouts.length });
  const draggable = canDragGalleryImages();
  const labelOrder = orderedLabels(state);
  results.innerHTML = layouts.length ? `<div class="grid" data-columns="${galleryColumns()}">
      <div class="masonry-content">${layouts.map(layout => card(layout, draggable, labelOrder)).join('')}</div>
    </div>`
      : loading ? '' : `<p class="empty">${txt(hasExploreFilters() ? 'noMatches' : 'emptyAll')}</p>`;
  observeExploreGallery(results.querySelector('.grid'));
  if (hadFocus) {
    [...results.querySelectorAll('[data-action]')].find(button =>
      button.dataset.action === hadFocus.dataset.action && button.dataset.id === hadFocus.dataset.id)?.focus({ preventScroll: true });
  }
}

function renderExplore() {
  const labels = orderedLabels(state);
  const ids = new Set(labels.map(label => label.id));
  exploreFilter.labelIds = exploreFilter.labelIds.filter(id => ids.has(id));
  if (!savedCollections().some(item => item.id === activeCollection)) activeCollection = '';
  const previousPicker = main.querySelector('.label-picker');
  const bulkLabel = txt(bulkSelection ? 'endBulkSelect' : 'bulkSelect');
  main.innerHTML = `${pageHead('exploreTitle')}
    <div class="explore-tools">
      <div class="explore-search-row">
        <label class="field search-field"><span>${txt('searchLayouts')}</span>
          <input type="search" name="explore-query" autocomplete="off" placeholder="${txt('searchPlaceholder')}">
        </label>
        <label class="field ratio-field"><span>${txt('aspectRatio')}</span>
          <select name="explore-ratio">${ratios.map(([value, key]) => `<option value="${value}">${txt(key)}</option>`).join('')}</select>
        </label>
        <div class="collection-controls">
          <label class="field"><span>${txt('smartCollections')}</span><select name="explore-collection">
            <option value="">${txt('chooseCollection')}</option>
            ${savedCollections().map(item => `<option value="${html(item.id)}">${html(item.name)}</option>`).join('')}
          </select></label>
          <button type="button" class="btn" data-action="save-collection" aria-label="${txt('saveCollection')}" title="${txt('saveCollection')}">${txt('saveFiltersShort')}</button>
          <button type="button" class="btn danger" data-action="delete-collection" aria-label="${txt('deleteCollection')}" title="${txt('deleteCollection')}" hidden>${txt('delete')}</button>
        </div>
      </div>
      <div class="filter-tools">
        ${labelPicker(labels, exploreFilter.labelIds, true)}
        <div class="filter-meta">
          <span class="count" role="status" data-result-count></span>
          <button type="button" class="btn plain" data-action="clear-filters" hidden>${txt('clearFilters')}</button>
        </div>
      </div>
    </div>
    <div class="search-results"></div>
    <div class="gallery-actions">
      <button type="button" class="fab primary" data-action="back-to-top" aria-label="${txt('backToTop')}" title="${txt('backToTop')}">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 5h14M12 19V9m-5 5 5-5 5 5"/></svg>
      </button>
      <button type="button" class="fab primary gallery-bulk" data-action="toggle-bulk" aria-pressed="${Boolean(bulkSelection)}"
        aria-label="${bulkLabel}" title="${bulkLabel}"${!state.layouts.length && !bulkSelection ? ' disabled' : ''}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M9.5 2h10A2.5 2.5 0 0 1 22 4.5v10a2.5 2.5 0 0 1-2.5 2.5H19V8a3 3 0 0 0-3-3H7v-.5A2.5 2.5 0 0 1 9.5 2Z"/>
          <path fill-rule="evenodd" d="M4.5 7h10A2.5 2.5 0 0 1 17 9.5v10a2.5 2.5 0 0 1-2.5 2.5h-10A2.5 2.5 0 0 1 2 19.5v-10A2.5 2.5 0 0 1 4.5 7Zm9.4 4.1a1.05 1.05 0 0 0-1.48 0l-4.3 4.3-1.63-1.63A1.05 1.05 0 0 0 5 15.26l2.38 2.38a1.05 1.05 0 0 0 1.48 0l5.04-5.05a1.05 1.05 0 0 0 0-1.49Z"/>
        </svg>
      </button>
      <button type="button" class="fab primary gallery-columns" data-action="gallery-columns"></button>
      <button type="button" class="fab primary" data-action="add" aria-label="${txt('add')}" title="${txt('add')}">
        <span class="fab-plus" aria-hidden="true"></span>
      </button>
    </div>
    <div class="drop-indicator" aria-hidden="true" hidden>${txt('dropExplore')}</div>`;
  bindLabelPicker(main.querySelector('.label-picker'),
    labelIds => setExploreFilter({ ...exploreFilter, labelIds }), previousPicker);
  updateExploreControls();
  updateExploreResults();
  updateGalleryColumns();
}

function updateExploreControls() {
  const query = main.querySelector('[name="explore-query"]');
  if (query.value !== exploreFilter.query) query.value = exploreFilter.query;
  main.querySelector('[name="explore-ratio"]').value = exploreFilter.ratio;
  main.querySelector('[name="explore-collection"]').value = activeCollection;
  main.querySelector('[data-action="save-collection"]').disabled = !hasExploreFilters();
  main.querySelector('[data-action="delete-collection"]').hidden = !activeCollection;
  main.querySelector('[data-action="clear-filters"]').hidden = !hasExploreFilters();
  main.querySelector('[data-action="filter"][data-id=""]').setAttribute('aria-pressed', String(!exploreFilter.labelIds.length));
  syncLabelPicker(main.querySelector('.label-picker'), exploreFilter.labelIds);
}

function setExploreFilter(next, collection = '') {
  keepExploreScroll(() => {
    exploreFilter = next;
    activeCollection = collection;
    updateExploreControls();
    updateExploreResults();
  });
}

function renderTrash() {
  const layouts = state.trash;
  const clear = `<button type="button" class="btn danger" data-action="clear-trash"${layouts.length ? '' : ' disabled'}>${txt('clearTrash')}</button>`;
  main.innerHTML = `${pageHead('trash', bulkButton(layouts.length > 0) + clear)}
    ${bulkToolbar(layouts.map(layout => layout.id))}
    ${layouts.length ? `<ul class="management trash-list">${layouts.map(layout => {
      const body = `<span class="trashed-layout">
          <img class="art" src="${html(layout.image)}" alt=""${imageSizeAttributes(layout)}>
          <span class="trashed-details">
            <span class="title">${html(layout.name)}</span>
            ${metadata(layout)}
          </span>
        </span>`;
      return `<li>${bulkSelection ? bulkRow(layout.id, layout.name, body) : `${body}<div class="trash-actions">
          <button class="btn" type="button" data-action="restore-layout" data-id="${html(layout.id)}">${txt('restoreLayout')}</button>
          <button class="btn danger" type="button" data-action="purge-layout" data-id="${html(layout.id)}">${txt('deletePermanently')}</button>
        </div>`}</li>`;
    }).join('')}</ul>` : `<p class="empty">${txt('emptyTrash')}</p>`}`;
}

function renderLabels() {
  const labels = orderedLabels(state);
  const selectable = labels.filter(label => label.id !== 'favorite').map(label => label.id);
  const sortable = !bulkSelection && selectable.length > 1;
  main.innerHTML = `${pageHead('labels', bulkButton(selectable.length > 0) + newButton('newLabel', 'new-label'))}
    ${bulkToolbar(selectable)}
    <ul class="management label-list">${labels.map(label => {
      const name = labelName(label, t);
      const id = html(label.id);
      const title = `<span class="title">${html(name)}</span>`;
      if (label.id === 'favorite') return `<li>${title}<span class="muted">${txt('builtIn')}</span></li>`;
      if (bulkSelection) return `<li>${bulkRow(label.id, name, title)}</li>`;
      const reorder = txt('reorderLabel', { name });
      return `<li data-label-row="${id}"><div class="label-title">
        ${sortable ? `<button class="icon-btn label-grip" type="button" draggable="true" aria-keyshortcuts="ArrowUp ArrowDown"
          aria-label="${reorder}" title="${reorder}"><span aria-hidden="true"></span></button>` : ''}
        <span>${title}${label.pinned ? `<span class="muted">${txt('pinnedLabel')}</span>` : ''}</span>
        </div>
        <div class="label-actions">
          <button class="btn" type="button" data-action="pin-label" data-id="${id}">${txt(label.pinned ? 'unpinLabel' : 'pinLabel')}</button>
          <button class="btn" type="button" data-action="rename-label" data-id="${id}">${txt('renameLabel')}</button>
          <button class="btn danger" type="button" data-action="delete-label" data-id="${id}">${txt('deleteLabel')}</button>
        </div>
      </li>`;
    }).join('')}</ul>`;
  if (sortable) bindLabelReordering(main.querySelector('.label-list'));
}

function renderBoards() {
  const board = state.boards.find(item => item.id === boardId);
  if (board) {
    main.innerHTML = `<header class="board-header">
      <button class="btn plain board-back" type="button" data-action="back-boards">${txt('backBoards')}</button>
      <h1 title="${html(board.name)}">${html(board.name)}</h1>
      <span class="whiteboard-selection-name" aria-live="polite"></span>
    </header><div id="board-host"></div>`;
    stopBoard = mountBoard({
      element: document.querySelector('#board-host'),
      selectionName: main.querySelector('.whiteboard-selection-name'),
      board,
      t,
      uploadImage,
      isInternalDrag: isGalleryDrag,
      showError,
      saveItems: items => change(draft => {
        const saved = draft.boards.find(item => item.id === board.id);
        if (!saved) throw error('notFound');
        saved.items = items;
      }),
      saveView: view => change(draft => {
        const saved = draft.boards.find(item => item.id === board.id);
        if (!saved) throw error('notFound');
        saved.view = view;
      }),
    });
    return;
  }
  main.innerHTML = `${pageHead('whiteboards', bulkButton(state.boards.length > 0) + newButton('newBoard', 'new-board'))}
    ${bulkToolbar(state.boards.map(item => item.id))}
    ${state.boards.length ? `<ul class="management">${state.boards.map(item => {
      const body = `<span class="title">${html(item.name)}</span><span class="muted">${txt(item.items.length === 1 ? 'boardOnePicture' : 'boardPictureCount', { count: item.items.length })}</span>`;
      return `<li>${bulkSelection ? bulkRow(item.id, item.name, body) : `
        <button class="open-board" type="button" data-action="open-board" data-id="${html(item.id)}" aria-label="${txt('openBoard', { name: item.name })}">${body}</button>
        <button class="btn danger" type="button" data-action="delete-board" data-id="${html(item.id)}">${txt('delete')}</button>`}</li>`;
    }).join('')}</ul>` : `<p class="empty">${txt('emptyBoards')}</p>`}`;
}

function settingGroup(name, current, options) {
  return `<fieldset>
    <legend>${txt(name)}</legend>
    <div class="setting-options">${options.map(([value, key]) => `<label class="setting-option">
      <input type="radio" name="${name}" value="${value}" ${current === value ? 'checked' : ''}>
      <span>${txt(key)}</span>
    </label>`).join('')}</div>
  </fieldset>`;
}

function renderSettings() {
  main.innerHTML = `${pageHead('settings')}<div class="setting-panel">
    ${settingGroup('theme', state.settings.theme, [['light', 'light'], ['dark', 'dark']])}
    ${settingGroup('language', document.documentElement.lang, [['en', 'english'], ['zh-Hant', 'traditionalChinese']])}
    <fieldset class="update-settings">
      <legend>${txt('updates')}</legend>
      <label class="setting-option">
        <input type="checkbox" name="autoCheckUpdates"${automaticUpdatesEnabled() ? ' checked' : ''}>
        <span>${txt('autoCheckUpdates')}</span>
      </label>
      <div class="update-status">
        <p class="muted" data-installed-version></p>
        <p data-update-status role="status"></p>
      </div>
      <div class="update-actions">
        <button class="btn" type="button" data-action="check-update">${txt('checkForUpdates')}</button>
        <span data-update-link></span>
      </div>
    </fieldset>
  </div>`;
}

function automaticUpdatesEnabled() {
  return state.settings.autoCheckUpdates !== false;
}

function updateLink(result) {
  if (!result?.available) return '';
  if (result.inApp) {
    return `<button class="btn primary" type="button" data-action="install-update">${txt('installUpdate')}</button>`;
  }
  const url = result.downloadURL || result.releaseURL;
  if (!url) return '';
  const label = result.downloadURL ? 'downloadUpdate' : 'viewUpdateRelease';
  return `<a class="btn primary" href="${html(url)}" target="_blank" rel="noopener noreferrer">${txt(label)}</a>`;
}

async function installUpdate() {
  if (dialog.open || !updateResult?.inApp) return;
  const version = updateResult.latest;
  openDialog('update-install', t('updateAvailable', { version }), `<div class="dialog-body">
    <p role="status" tabindex="-1" data-focus data-update-install-status>${txt('installingUpdate')}</p>
    <p class="form-error" role="alert" data-update-install-error hidden></p>
  </div>`);
  dialog.dataset.saving = 'true';
  const close = dialog.querySelector('[data-action="close-dialog"]');
  close.disabled = true;
  try {
    await stopBoard?.whenIdle();
    await saveQueue;
    await api('update/install', json('POST', { version }));
    dialog.querySelector('[data-update-install-status]').textContent = t('restartingUpdate');
  } catch (reason) {
    dialog.querySelector('[data-update-install-status]').hidden = true;
    const message = dialog.querySelector('[data-update-install-error]');
    message.textContent = reason.message;
    message.hidden = false;
    delete dialog.dataset.saving;
    close.disabled = false;
    close.focus();
    if (reason.message === t('updateChanged')) void checkForUpdates();
  }
}

function updateMessage() {
  if (updateRequest) return t('checkingUpdates');
  if (updateFailed) return t('updateCheckFailed');
  if (!updateResult) return t('updatesNotChecked');
  if (!updateResult.available) return t('latestVersion');
  return t('updateAvailable', { version: updateResult.latest });
}

function renderUpdateStatus() {
  const version = main.querySelector('[data-installed-version]');
  if (version) {
    version.textContent = installedVersion ? t('installedVersion', { version: installedVersion }) : '';
    version.hidden = !installedVersion;
    main.querySelector('[data-update-status]').textContent = updateMessage();
    main.querySelector('[data-update-link]').innerHTML = updateLink(updateResult);
    main.querySelector('[data-action="check-update"]').disabled = Boolean(updateRequest);
  }
  const visible = offerUpdate && automaticUpdatesEnabled() && updateResult?.available &&
    updateResult.latest !== dismissedUpdate;
  updateNotice.hidden = !visible;
  if (visible) {
    updateNotice.setAttribute('aria-label', t('updates'));
    updateNotice.innerHTML = `
      <span class="update-notice-title" role="status">${txt('updateAvailable', { version: updateResult.latest })}</span>
      <div class="update-actions">
        <button class="btn plain" type="button" data-action="dismiss-update">${txt('updateLater')}</button>
        ${updateLink(updateResult)}
      </div>`;
  }
}

async function checkForUpdates(automatic = false) {
  if (updateRequest || (automatic && !automaticUpdatesEnabled())) return;
  const controller = new AbortController();
  const request = { controller, automatic };
  updateRequest = request;
  updateFailed = false;
  renderUpdateStatus();
  try {
    const result = await api('update', { method: 'POST', signal: controller.signal });
    if (updateRequest !== request) return;
    updateResult = result;
    installedVersion = result.current || installedVersion;
    offerUpdate = automatic;
  } catch {
    if (updateRequest === request) updateFailed = true;
  } finally {
    if (updateRequest === request) {
      updateRequest = null;
      renderUpdateStatus();
    }
  }
}

async function initializeUpdates() {
  if (updateStarted) return;
  updateStarted = true;
  try {
    const receipt = await api('version');
    installedVersion = receipt.version;
    renderUpdateStatus();
  } catch {
    // The GitHub check can still supply the installed version.
  }
  await checkForUpdates(true);
}

function dismissUpdate() {
  dismissedUpdate = updateResult?.latest || '';
  renderUpdateStatus();
}

function renderNavigation() {
  const buttons = tabs.map(id => {
    const button = `<button class="nav-tab" type="button" data-action="navigate" data-tab="${id}"${id === tab ? ' aria-current="page"' : ''}>${txt(id)}</button>`;
    if (id !== 'whiteboards') return button;
    return `<div class="nav-board-row">${button}
      <button type="button" class="nav-board-toggle" aria-controls="sidebar-boards"><span aria-hidden="true"></span></button>
    </div>
    <ul class="nav-board-list" id="sidebar-boards">
      ${state.boards.map(board => `<li><button type="button" class="nav-board-link" data-action="open-board" data-id="${html(board.id)}"
        aria-label="${txt('openBoard', { name: board.name })}" title="${html(board.name)}"${boardId === board.id ? ' aria-current="location"' : ''}>${html(board.name)}</button></li>`).join('')
        || `<li class="muted">${txt('noBoardChoices')}</li>`}
    </ul>`;
  });
  navigation.innerHTML = '<span class="nav-highlight" aria-hidden="true"></span>' + buttons.join('');
  updateBoardList();
}

function updateBoardList() {
  const open = boardListOpen || (state.boards.length > 0 && sidebar.hasAttribute('data-drag-open'));
  const button = navigation.querySelector('.nav-board-toggle');
  const label = t(open ? 'hideBoardList' : 'showBoardList');
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', label);
  button.title = label;
  navigation.querySelector('#sidebar-boards').hidden = !open;
  highlightNavigation(navigation.querySelector('.nav-tab:hover, .nav-board-row:hover .nav-tab'));
}

function render() {
  if (draggedLayoutId) endGalleryDrag();
  stopBoard?.();
  stopBoard = undefined;
  if (tab !== 'explore') masonryObserver.disconnect();
  const language = selectLanguage(state.settings.language, navigator.language);
  t = translator(language);
  document.documentElement.lang = language;
  document.documentElement.dataset.theme = state.settings.theme;
  document.title = t('app');
  document.querySelector('#brand-name').textContent = t('app');
  navigationToggle.setAttribute('aria-label', t('navigationMenu'));
  navigationToggle.title = `${t('navigationMenu')} (O)`;
  renderNavigation();
  main.dataset.tab = tab;
  spec[tab]();
  renderUpdateStatus();
}

async function navigate(next, nextBoard = '') {
  const focusHeading = sidebar.contains(document.activeElement);
  const request = ++navigationRequest;
  if (stopBoard) await stopBoard.whenIdle();
  await saveQueue;
  if (request !== navigationRequest) return;
  if (tab === 'explore') exploreScroll = captureExploreScroll();
  tab = next;
  boardId = nextBoard;
  resetBulk();
  render();
  if (tab === 'explore' && exploreScroll) restoreExploreScroll(exploreScroll);
  else window.scrollTo(0, 0);
  if (focusHeading) {
    const heading = main.querySelector('h1');
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

function setSidebar(open, restoreFocus = false) {
  if (!open && restoreFocus) navigationToggle.focus({ preventScroll: true });
  if (open) highlightNavigation();
  sidebar.toggleAttribute('data-open', open);
  sidebar.inert = !open;
  if (!open) highlightGalleryDrop(null);
  navigationToggle.setAttribute('aria-expanded', String(open));
}

function highlightNavigation(button) {
  const current = button ?? navigation.querySelector('.nav-tab[aria-current="page"]');
  const target = current?.closest('.nav-board-row') ?? current;
  if (!target) return;
  navigation.style.setProperty('--nav-highlight-y', `${target.offsetTop}px`);
  navigation.style.setProperty('--nav-highlight-height', `${target.offsetHeight}px`);
}

navigation.addEventListener('pointerover', event => {
  const button = event.target.closest('.nav-tab') ?? event.target.closest('.nav-board-row')?.querySelector('.nav-tab');
  if (button && event.pointerType !== 'touch') highlightNavigation(button);
});
navigation.addEventListener('pointerleave', () => highlightNavigation(navigation.querySelector('.nav-tab:focus-visible')));
navigation.addEventListener('focusin', event => {
  if (!event.target.matches(':focus-visible')) return;
  const button = event.target.closest('.nav-tab') ?? event.target.closest('.nav-board-row')?.querySelector('.nav-tab');
  if (button) highlightNavigation(button);
});
navigation.addEventListener('focusout', event => {
  if (!navigation.contains(event.relatedTarget)) highlightNavigation(navigation.querySelector('.nav-tab:hover'));
});

navigationToggle.addEventListener('click', () => setSidebar(!sidebar.hasAttribute('data-open')));
navigation.addEventListener('click', event => {
  if (!event.target.closest('.nav-board-toggle')) return;
  boardListOpen = !boardListOpen;
  updateBoardList();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  if (!dialog.open && bulkSelection) {
    event.preventDefault();
    toggleBulkMode();
    return;
  }
  if (closeLabelPanel(dialog.open ? dialog : main)) {
    event.preventDefault();
    return;
  }
  if (dialog.open) return;
  if (draggedLayoutId) {
    endGalleryDrag();
  } else if (sidebar.hasAttribute('data-open')) {
    event.preventDefault();
    setSidebar(false, true);
  }
});

function clearLinkRequest(draft) {
  clearTimeout(draft.linkTimer);
  draft.linkTimer = null;
  draft.linkRequest?.abort();
  draft.linkRequest = null;
}

function releaseDraftUploads(paths) {
  const images = paths.filter(Boolean);
  // Finish draft cleanup before a subsequent Trash action can reclaim the images.
  for (let offset = 0; offset < images.length; offset += 500) {
    const batch = images.slice(offset, offset + 500);
    saveQueue = saveQueue.then(() => api('image/release', json('POST', { images: batch }))).catch(() => {});
  }
}

function clearImportFiles(draft) {
  releaseDraftUploads(draft.files.map(entry => entry.upload?.image));
  for (const entry of draft.files) URL.revokeObjectURL(entry.preview);
  draft.files = [];
}

function clearImportMedia(draft) {
  releaseDraftUploads([draft.linkUpload]);
  draft.linkUpload = '';
  draft.media = null;
}

function clearDraft() {
  if (addDraft) {
    clearLinkRequest(addDraft);
    clearImportFiles(addDraft);
    clearImportMedia(addDraft);
  }
  addDraft = undefined;
}

function openDialog(kind, title, body, focus = '[data-focus]') {
  clearDraft();
  dialog.dataset.kind = kind;
  delete dialog.dataset.saving;
  const heading = kind === 'preview'
    ? `<button class="preview-title" type="button" data-action="rename-preview" title="${txt('renameImage')}">${html(title)}</button>`
    : html(title);
  dialog.innerHTML = `<div class="dialog-heading">
    <h2 id="dialog-title">${heading}</h2>
    <button class="icon-btn" data-action="close-dialog" type="button" aria-label="${txt('close')}">×</button>
  </div>${body}`;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector(focus)?.focus({ preventScroll: true });
}

function preview(id) {
  previewSequence = currentLayouts().map(layout => layout.id);
  if (!previewSequence.includes(id)) previewSequence = [id];
  previewIndex = previewSequence.indexOf(id);
  renderPreview();
}

function renderPreview(focus = '[data-action="close-dialog"]') {
  const layout = layoutById(previewSequence[previewIndex]);
  if (!layout) return;
  const fromVideo = layout.sourceType !== 'image' && videoKey(layout.url);
  const link = layout.url ? `<a href="${html(layout.url)}" target="_blank" rel="noopener noreferrer">${txt(fromVideo ? 'originalVideo' : 'originalWebsite')} <span aria-hidden="true">↗</span></a>` : '';
  openDialog('preview', layout.name, `<div class="preview-stage">
      <img class="preview-art" src="${html(layout.image)}" alt="${html(layout.name)}">
    </div>
    <div class="dialog-body preview-meta">${metadata(layout)}${link}</div>
    <div class="preview-controls">
      <button class="btn" type="button" data-action="previous-preview" aria-keyshortcuts="ArrowLeft"${previewIndex === 0 ? ' disabled' : ''}><span aria-hidden="true">‹</span>${txt('previousLayout')}</button>
      <div class="preview-palette" role="group" aria-label="${txt('previewPalette')}">
        ${'<span class="preview-swatch" aria-hidden="true"></span>'.repeat(3)}
      </div>
      <button class="btn" type="button" data-action="next-preview" aria-keyshortcuts="ArrowRight"${previewIndex + 1 === previewSequence.length ? ' disabled' : ''}>${txt('nextLayout')}<span aria-hidden="true">›</span></button>
    </div>`, focus);
  void fillPreviewPalette(dialog.querySelector('.preview-art'), dialog.querySelector('.preview-palette'));
}

function sampleImageColors(image) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 80 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return imagePalette(context.getImageData(0, 0, canvas.width, canvas.height).data);
}

async function readPreviewColors(image) {
  await image.decode();
  try {
    return sampleImageColors(image);
  } catch (reason) {
    if (reason.name !== 'SecurityError') throw reason;
  }

  // Some webviews taint a canvas when drawing from the app's custom URL scheme.
  const response = await fetch(image.currentSrc, { credentials: 'omit' });
  if (!response.ok) return [];
  const source = URL.createObjectURL(await response.blob());
  try {
    const copy = new Image();
    copy.src = source;
    await copy.decode();
    return sampleImageColors(copy);
  } finally {
    URL.revokeObjectURL(source);
  }
}

async function fillPreviewPalette(image, palette) {
  const colors = await readPreviewColors(image).catch(() => []);
  if (!dialog.open || !palette.isConnected || !colors.length) return;
  [...palette.children].forEach((swatch, index) => {
    const color = colors[index] ?? colors.at(-1);
    const label = t(index === 0 ? 'previewPrimaryColor' : 'previewSecondaryColor', { color });
    swatch.style.setProperty('--swatch-color', color);
    swatch.dataset.color = color;
    swatch.setAttribute('role', 'img');
    swatch.setAttribute('aria-label', label);
    swatch.removeAttribute('aria-hidden');
    swatch.tabIndex = 0;
  });
}

function editPreviewName() {
  const layout = layoutById(previewSequence[previewIndex]);
  if (!layout || dialog.dataset.kind !== 'preview' || dialog.querySelector('.preview-name-editor')) return;
  const title = dialog.querySelector('.preview-title');
  title.hidden = true;
  title.insertAdjacentHTML('afterend', `<span class="preview-name-editor">
    <input aria-label="${txt('renameImage')}" value="${html(layout.name)}" maxlength="300">
    <button class="icon-btn" type="button" aria-label="${txt('save')}" title="${txt('save')}">✓</button>
    <button class="icon-btn" type="button" aria-label="${txt('cancel')}" title="${txt('cancel')}">×</button>
  </span>`);
  const editor = title.nextElementSibling;
  const input = editor.querySelector('input');
  const [save, cancel] = editor.querySelectorAll('button');
  const closeEditor = () => {
    editor.remove();
    title.hidden = false;
    title.focus({ preventScroll: true });
  };
  async function saveName() {
    if (dialog.dataset.saving) return;
    const name = input.value.trim();
    input.setCustomValidity(name ? '' : t('missingName'));
    if (!input.reportValidity()) return;
    if (name === layout.name) {
      closeEditor();
      return;
    }
    dialog.dataset.saving = 'true';
    input.readOnly = save.disabled = cancel.disabled = true;
    try {
      await change(saved => {
        const entry = saved.layouts.find(item => item.id === layout.id);
        if (!entry) throw error('notFound');
        entry.name = name;
        for (const board of saved.boards) {
          for (const item of board.items) {
            if (item.layoutId === entry.id) item.name = name;
          }
        }
      });
      title.textContent = name;
      dialog.querySelector('.preview-art').alt = name;
      if (tab === 'explore' && !refreshExploreCard(layout.id)) keepExploreScroll(updateExploreResults);
      closeEditor();
    } catch (reason) {
      input.readOnly = false;
      input.setCustomValidity(reason.message);
      input.reportValidity();
    } finally {
      delete dialog.dataset.saving;
      input.readOnly = save.disabled = cancel.disabled = false;
    }
  }
  input.addEventListener('input', () => input.setCustomValidity(''));
  save.addEventListener('click', saveName);
  cancel.addEventListener('click', closeEditor);
  editor.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!dialog.dataset.saving) closeEditor();
    } else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      void saveName();
    }
  });
  input.focus({ preventScroll: true });
  input.select();
}

function stepPreview(offset) {
  const index = previewIndex + offset;
  if (index < 0 || index >= previewSequence.length) return;
  const focused = document.activeElement?.dataset.action;
  previewIndex = index;
  const keepFocus = (focused === 'previous-preview' && index > 0) ||
    (focused === 'next-preview' && index + 1 < previewSequence.length);
  renderPreview(keepFocus ? `[data-action="${focused}"]` : undefined);
}

function compareLayouts() {
  const layouts = [...(bulkSelection ?? [])].map(layoutById).filter(Boolean);
  if (layouts.length < 2 || layouts.length > 4) {
    showToast(t('compareSelectionLimit'), 'status');
    return;
  }
  openDialog('compare', t('compareTitle', { count: layouts.length }), `
    <div class="dialog-body">
      <div class="compare-grid">${layouts.map(layout => `<figure>
        <img src="${html(layout.image)}" alt="${html(layout.name)}">
        <figcaption><span class="title">${html(layout.name)}</span>${metadata(layout)}</figcaption>
      </figure>`).join('')}</div>
      <div class="compare-actions">
        <button type="button" class="btn primary" data-action="bulk-boards">${txt('boardChoices')}</button>
      </div>
    </div>`);
}

function choices(title, name, options, empty) {
  return `<fieldset class="choices"><legend>${txt(title)}</legend>
    ${options.length ? `<div class="checkbox-group">${options.map(option => `<label class="choice">
      <input type="checkbox" name="${name}" value="${html(option.id)}"${option.checked ? ' checked' : ''}>
      <span>${html(option.name)}</span></label>`).join('')}</div>` : `<p class="muted">${txt(empty)}</p>`}
  </fieldset>`;
}

function labelPicker(labels, selected, explore = false) {
  const quick = [];
  const batches = [];
  for (const label of labels) {
    (isImportLabel(label) && !label.pinned ? batches : quick).push(label);
  }
  const selectedIds = new Set(selected);
  const panelId = explore ? 'explore-label-panel' : 'destination-label-panel';
  const filter = explore ? 'data-action="filter"' : 'data-label-toggle';
  function labelOptions(group) {
    return group.map(label => {
      const name = labelName(label, t);
      return `<label class="choice" data-label-search="${html(searchText(`${name} ${label.name}`))}">
        <input type="checkbox"${explore ? '' : ' name="labels"'} value="${html(label.id)}"${selectedIds.has(label.id) ? ' checked' : ''}>
        <span>${html(name)}</span>
      </label>`;
    }).join('');
  }
  return `<div class="label-picker"${explore ? ' data-explore-labels' : ''}>
    <div class="label-picker-bar" role="group" aria-label="${txt(explore ? 'filter' : 'labelChoices')}">
      ${explore ? `<button type="button" class="filter" data-action="filter" data-id="" aria-pressed="false">${txt('all')}</button>` : ''}
      <div class="label-quick">${quick.map(label => {
        const name = html(labelName(label, t));
        return `<button type="button" class="filter" ${filter} data-id="${html(label.id)}"
          aria-pressed="${selectedIds.has(label.id)}" title="${name}">${name}</button>`;
      }).join('')}</div>
      <button type="button" class="filter label-more" aria-expanded="false" aria-controls="${panelId}">${txt('moreLabels')}</button>
    </div>
    <div class="label-selection" hidden>
      <div class="label-selected" role="group" aria-label="${txt('selectedLabels')}"></div>
      ${explore ? '' : `<button class="btn plain label-clear" type="button" data-label-clear>${txt('clearLabels')}</button>`}
    </div>
    <div class="label-panel" id="${panelId}" hidden>
      <label class="field search-field">
        <input type="search" aria-label="${txt('searchLabels')}" placeholder="${txt('searchLabels')}" autocomplete="off">
      </label>
      <div class="label-panel-results">
        <div class="label-options" data-label-section>${labelOptions(quick)}</div>
        ${batches.length ? `<div class="label-panel-batches" data-label-section>
          <p class="muted">${txt('importBatches')}</p>
          <div class="label-options">${labelOptions(batches)}</div>
        </div>` : ''}
        <p class="muted" role="status" data-no-label-results hidden>${txt(labels.length ? 'noMatchingLabels' : 'noLabels')}</p>
      </div>
    </div>
  </div>`;
}

function fitQuickLabels(bar) {
  if (!bar.clientWidth) return;
  const row = bar.querySelector('.label-quick');
  const buttons = [...row.children];
  for (const button of buttons) button.hidden = false;
  const available = row.getBoundingClientRect().width;
  const gap = parseFloat(getComputedStyle(row).columnGap);
  const widths = buttons.map(button => button.getBoundingClientRect().width);
  let occupied = 0;
  buttons.forEach((button, index) => {
    occupied += widths[index] + (index ? gap : 0);
    button.hidden = button.dataset.id !== 'favorite' && occupied > available;
  });
}

function syncLabelPicker(picker, selected) {
  const ids = new Set(selected);
  const remove = picker.hasAttribute('data-explore-labels') ? 'removeLabelFilter' : 'unselectLabel';
  for (const button of picker.querySelectorAll('.label-quick button')) {
    button.setAttribute('aria-pressed', String(ids.has(button.dataset.id)));
  }
  const chips = [];
  for (const input of picker.querySelectorAll('.label-options input')) {
    input.checked = ids.has(input.value);
    if (!input.checked) continue;
    const name = input.nextElementSibling.textContent;
    chips.push(`<button type="button" class="filter label-chip" data-label-toggle data-label-remove data-id="${html(input.value)}"
      aria-label="${txt(remove, { name })}" title="${html(name)}"><span>${html(name)}</span><span aria-hidden="true">×</span></button>`);
  }
  const selection = picker.querySelector('.label-selection');
  selection.hidden = chips.length === 0;
  selection.querySelector('.label-selected').innerHTML = chips.join('');
}

function setLabelPanelOpen(panel, open) {
  const trigger = panel.closest('.label-picker').querySelector('.label-more');
  panel.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
  return trigger;
}

function closeLabelPanel(container) {
  const panel = container.querySelector('.label-panel:not([hidden])');
  if (!panel) return false;
  setLabelPanelOpen(panel, false).focus({ preventScroll: true });
  return true;
}

function bindLabelPicker(picker, onChange, previous) {
  const bar = picker.querySelector('.label-picker-bar');
  const more = picker.querySelector('.label-more');
  const panel = picker.querySelector('.label-panel');
  const search = panel.querySelector('input[type="search"]');
  const sections = [...panel.querySelectorAll('[data-label-section]')].map(section =>
    ({ section, options: [...section.querySelectorAll('[data-label-search]')] }));
  const checkedIds = () => [...panel.querySelectorAll('input:checked')].map(input => input.value);
  const select = ids => onChange ? onChange(ids) : syncLabelPicker(picker, ids);

  function applySearch() {
    const terms = searchText(search.value.trim()).split(/\s+/).filter(Boolean);
    let results = 0;
    for (const { section, options } of sections) {
      let visible = 0;
      for (const option of options) {
        option.hidden = !terms.every(term => option.dataset.labelSearch.includes(term));
        if (!option.hidden) visible++;
      }
      section.hidden = visible === 0;
      results += visible;
    }
    panel.querySelector('[data-no-label-results]').hidden = results > 0;
    panel.querySelector('.label-panel-results').scrollTop = 0;
  }

  if (previous) {
    labelQuickObserver.unobserve(previous.querySelector('.label-picker-bar'));
    setLabelPanelOpen(panel, !previous.querySelector('.label-panel').hidden);
    search.value = previous.querySelector('input[type="search"]').value;
  }
  applySearch();
  syncLabelPicker(picker, checkedIds());
  fitQuickLabels(bar);
  labelQuickObserver.observe(bar);
  search.addEventListener('input', applySearch);
  picker.addEventListener('change', event => {
    if (event.target.matches('.label-options input')) select(checkedIds());
  });
  picker.addEventListener('click', event => {
    if (event.target.closest('.label-more')) {
      setLabelPanelOpen(panel, panel.hidden);
      if (!panel.hidden) search.focus();
      return;
    }
    if (event.target.closest('[data-label-clear]')) {
      select([]);
      more.focus({ preventScroll: true });
      return;
    }
    const toggle = event.target.closest('[data-label-toggle]');
    if (!toggle) return;
    const ids = new Set(checkedIds());
    const id = toggle.dataset.id;
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    const nearby = toggle.nextElementSibling ?? toggle.previousElementSibling;
    select([...ids]);
    if (toggle.hasAttribute('data-label-remove')) {
      const neighbor = nearby && picker.querySelector(`[data-label-remove][data-id="${CSS.escape(nearby.dataset.id)}"]`);
      (neighbor ?? more).focus({ preventScroll: true });
    }
  });
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) event.preventDefault();
  });
}

function newLabelRecord(name, labels, id = crypto.randomUUID()) {
  if (!name) throw error('missingName');
  const normalized = name.toLocaleLowerCase();
  if (labels.some(label => label.id !== id &&
      [label.name, labelName(label, t)].some(value => value.toLocaleLowerCase() === normalized))) {
    throw error('labelExists');
  }
  return { id, name };
}

function destinationChoices(kind, selected, additions = []) {
  if (kind === 'labels') {
    return `<fieldset class="choices"><legend>${txt('labelChoices')}</legend>
      ${labelPicker([...orderedLabels(state), ...additions], selected)}
    </fieldset>`;
  }
  const options = [...state.boards, ...additions].map(item => ({ ...item, checked: selected.includes(item.id) }));
  return choices('boardChoices', kind, options, 'noBoardChoices');
}

function destinationPicker(kind, selected = []) {
  const labels = kind === 'labels';
  return `<div data-destination="${kind}">
    <div data-choices>${destinationChoices(kind, selected)}</div>
    <details class="inline-create">
      <summary class="btn plain"><span class="symbol" aria-hidden="true">+</span>${txt(labels ? 'addLabelInline' : 'newBoard')}</summary>
      <div class="inline-field">
        <label class="field"><span>${txt(labels ? 'labelName' : 'boardName')}</span><input maxlength="80"></label>
        <button type="button" class="btn">${txt(labels ? 'newLabel' : 'createBoard')}</button>
      </div>
      <p class="inline-create-error" role="alert" hidden></p>
    </details>
  </div>`;
}

function bindDestinationPicker(form, kind) {
  const picker = form.querySelector(`[data-destination="${kind}"]`);
  const list = picker.querySelector('[data-choices]');
  const editor = picker.querySelector('details');
  const nameInput = editor.querySelector('input');
  const notice = editor.querySelector('[role="alert"]');
  const additions = [];
  const initialPicker = list.querySelector('.label-picker');
  if (initialPicker) bindLabelPicker(initialPicker);

  function addDestination() {
    if (dialog.dataset.saving) return;
    const name = nameInput.value.trim();
    try {
      if (!name) throw error('missingName');
      const item = kind === 'labels' ? newLabelRecord(name, [...state.labels, ...additions])
        : { id: crypto.randomUUID(), name, items: [] };
      const selected = new FormData(form).getAll(kind);
      additions.push(item);
      const previousPicker = list.querySelector('.label-picker');
      list.innerHTML = destinationChoices(kind, [...selected, item.id], additions);
      nameInput.value = '';
      notice.hidden = true;
      editor.open = false;
      if (previousPicker) {
        bindLabelPicker(list.querySelector('.label-picker'), undefined, previousPicker);
        list.querySelector(`[data-label-remove][data-id="${item.id}"]`)?.focus();
      } else {
        list.querySelector(`input[value="${item.id}"]`).focus();
      }
    } catch (reason) {
      notice.textContent = reason.message;
      notice.hidden = false;
      nameInput.focus();
    }
  }

  editor.addEventListener('toggle', () => {
    if (editor.open) nameInput.focus();
  });
  editor.querySelector('button').addEventListener('click', addDestination);
  nameInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      addDestination();
    }
  });
  return additions;
}

function saveNewLabels(saved, additions) {
  for (const label of additions) saved.labels.push(newLabelRecord(label.name, saved.labels, label.id));
}

function formError(form, message) {
  const notice = form.querySelector('.form-error');
  notice.textContent = message || '';
  notice.hidden = !message;
}

function dialogButtons(leading = '', submit = 'save', danger = false) {
  return `<div class="dialog-actions">${leading}
    <button type="button" class="btn" data-action="close-dialog"${danger ? ' data-focus' : ''}>${txt('cancel')}</button>
    <button type="submit" class="btn ${danger ? 'danger-fill' : 'primary'}">${txt(submit)}</button>
  </div>`;
}

function bindForm(onSubmit, refreshView = render) {
  const form = dialog.querySelector('form');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (dialog.dataset.saving || addDraft?.linkRequest) return;
    const submit = form.querySelector('button[type="submit"]');
    const priorText = submit.textContent;
    dialog.dataset.saving = 'true';
    submit.disabled = true;
    submit.textContent = t('saving');
    formError(form);
    try {
      if (await onSubmit(new FormData(form)) === false) return;
      const refresh = () => {
        dialog.close();
        refreshView();
      };
      if (tab === 'explore' && dialog.dataset.kind !== 'add') keepExploreScroll(refresh);
      else refresh();
    } catch (reason) {
      formError(form, reason.message);
    } finally {
      delete dialog.dataset.saving;
      submit.disabled = false;
      submit.textContent = form.dataset.submitLabel ? t(form.dataset.submitLabel) : priorText;
    }
  });
  return form;
}

function addLayout(files = [], fromClipboard = false) {
  openDialog('add', t('add'), `<form class="dialog-body" novalidate>
    <div class="form-stack">
      <div>
        <label class="field"><span>${txt('videoLink')}</span><input type="url" name="video" inputmode="url" autocomplete="off" placeholder="https://" data-focus></label>
        <p class="muted" data-link-status role="status" hidden>${txt('gettingThumbnail')}</p>
        <button type="button" class="btn plain" data-retry-thumbnail hidden>${txt('retryThumbnail')}</button>
      </div>
      <div class="drop-zone">
        <img alt="${txt('picturePreview')}" hidden>
        <ul class="import-previews" hidden></ul>
        <p class="muted" data-import-count role="status" hidden></p>
        <input type="file" name="picture" accept="${imageAccept}" multiple hidden>
        <button type="button" class="btn plain" data-choose>${txt('chooseImage')}</button>
        <span class="muted">${txt('dropImage')}</span>
      </div>
      <label class="field" data-single-name><span>${txt('layoutName')}</span><input name="name" maxlength="300"></label>
      <label class="field"><span>${txt('layoutAuthor')}</span><input name="publisher"></label>
      <div class="source-fields" hidden>
        <label class="field"><span>${txt('siteName')}</span><input name="site-name" maxlength="160"></label>
        <label class="field"><span>${txt('siteUrl')}</span><input type="url" name="site-url" inputmode="url" maxlength="2048" placeholder="https://"></label>
      </div>
      ${destinationPicker('labels')}
      <fieldset class="duplicate-notice" hidden>
        <legend>${txt('duplicateFound')}</legend>
        <div data-duplicate-details></div>
        <div class="duplicate-choices" data-duplicate-choices></div>
      </fieldset>
      <p class="form-error" role="alert" hidden></p>
    </div>${dialogButtons()}
  </form>`);

  const draft = { media: null, files: [], linkUrl: '', linkUpload: '', linkTimer: null, linkRequest: null, review: '' };
  addDraft = draft;
  const form = bindForm(async data => {
    if (!draft.files.length && !draft.media) throw error('missingImage');
    const batch = draft.files.length > 1;
    const name = String(data.get('name') || '').trim();
    if (!batch && !name) throw error('missingName');
    const publisher = String(data.get('publisher') || '').trim();
    const siteName = String(data.get('site-name') || '').trim();
    const siteUrl = normalizeWebsiteUrl(data.get('site-url'));
    if (!draft.media && siteUrl === null) throw error('invalidSiteUrl');
    const labels = data.getAll('labels');
    const timeLabel = batch ? t('importTimeLabel', { time: importTimeFormat.format(new Date()) }) : '';
    const entries = [];
    if (draft.media) {
      draft.media.dimensions ??= await imageSize(draft.media.image).catch(() => ({}));
      entries.push({ name, publisher, image: draft.media.image, url: draft.media.url, sourceType: 'video', ...draft.media.dimensions });
    }
    for (const entry of draft.files) {
      try {
        entry.upload ??= await uploadImage(entry.file);
      } catch (reason) {
        if (!batch) throw reason;
        throw new Error(t('imageImportError', { name: entry.file.name, message: reason.message }));
      }
      entry.dimensions ??= await imageSize(entry.preview).catch(() => ({}));
      entries.push({
        name: batch ? entry.name : name, publisher, image: entry.upload.image,
        url: siteUrl, siteName, sourceType: 'image', ...entry.dimensions,
      });
    }
    await saveQueue;
    const plan = planImports(state, entries);
    if (plan.duplicateLayouts.length || plan.repeatedCount) {
      const review = reviewKey(plan);
      if (draft.review !== review) {
        draft.review = review;
        showDuplicates(plan);
        return false;
      }
    }
    const existing = data.get('duplicate-choice') === 'apply'
      ? plan.duplicateLayouts.filter(item => !item.trashed).map(item => item.layout.id) : [];
    if (!plan.newEntries.length && !existing.length) return;
    await change(saved => {
      saveNewLabels(saved, newLabels);
      addImportedLayouts(saved, plan.newEntries, labels, timeLabel, existing);
    });
    exploreFilter = { ...noFilters, labelIds: [] };
    activeCollection = '';
  });
  const title = form.elements.namedItem('name');
  const author = form.elements.namedItem('publisher');
  const video = form.elements.namedItem('video');
  const fileInput = form.elements.namedItem('picture');
  const linkStatus = form.querySelector('[data-link-status]');
  const retryThumbnail = form.querySelector('[data-retry-thumbnail]');
  const saveButton = form.querySelector('button[type="submit"]');
  const chooseButton = form.querySelector('[data-choose]');
  const image = form.querySelector('.drop-zone img');
  const previews = form.querySelector('.import-previews');
  const importCount = form.querySelector('[data-import-count]');
  const singleName = form.querySelector('[data-single-name]');
  const sourceFields = form.querySelector('.source-fields');
  const duplicateNotice = form.querySelector('.duplicate-notice');
  const dropZone = form.querySelector('.drop-zone');
  const newLabels = bindDestinationPicker(form, 'labels');

  function reviewKey(plan) {
    return JSON.stringify([plan.duplicateLayouts.map(({ layout, trashed }) => [layout.id, trashed]), plan.repeatedCount]);
  }

  function showDuplicates(plan, focus = true) {
    const names = plan.duplicateLayouts.map(({ layout, trashed }) =>
      `<li>${html(layout.name)}${trashed ? ` <span class="muted">(${txt('duplicateInTrash')})</span>` : ''}</li>`).join('');
    duplicateNotice.querySelector('[data-duplicate-details]').innerHTML = `
      ${names ? `<ul>${names}</ul>` : ''}
      ${plan.repeatedCount ? `<p>${txt('duplicateRepeated', { count: plan.repeatedCount })}</p>` : ''}
      <p class="muted">${txt('duplicateHint')}</p>`;
    const canApply = plan.duplicateLayouts.some(item => !item.trashed);
    duplicateNotice.querySelector('[data-duplicate-choices]').innerHTML = `
      <label class="choice"><input type="radio" name="duplicate-choice" value="skip" checked>${txt('duplicateSkip')}</label>
      ${canApply ? `<label class="choice"><input type="radio" name="duplicate-choice" value="apply">${txt('duplicateApplyLabels')}</label>` : ''}`;
    duplicateNotice.hidden = false;
    form.dataset.submitLabel = 'continueImport';
    if (focus) duplicateNotice.querySelector('input').focus();
    else saveButton.textContent = t('continueImport');
  }

  function resetDuplicateReview() {
    if (!draft.review) return;
    draft.review = '';
    duplicateNotice.hidden = true;
    duplicateNotice.querySelector('[data-duplicate-choices]').replaceChildren();
    delete form.dataset.submitLabel;
    saveButton.textContent = t('save');
  }

  function showPictures() {
    const count = draft.files.length;
    const batch = count > 1;
    const single = count === 1 ? draft.files[0].preview : draft.media?.image;
    if (single) image.src = single;
    else image.removeAttribute('src');
    image.hidden = !single;
    previews.hidden = !batch;
    previews.innerHTML = batch ? draft.files.map(entry => `<li>
      <img src="${html(entry.preview)}" alt="" loading="lazy"><span title="${html(entry.name)}">${html(entry.name)}</span>
    </li>`).join('') : '';
    importCount.hidden = !batch;
    importCount.textContent = batch ? t('batchImportHint', { count }) : '';
    singleName.hidden = batch;
    sourceFields.hidden = !count;
    for (const field of sourceFields.querySelectorAll('input')) field.disabled = !count;
    title.disabled = batch;
    title.value = batch ? '' : draft.files[0]?.name ?? draft.media?.name ?? '';
    chooseButton.textContent = t(batch ? 'chooseOtherImages' : single ? 'chooseOtherImage' : 'chooseImage');
  }

  function updateLinkStatus() {
    linkStatus.hidden = !draft.linkRequest;
    saveButton.disabled = Boolean(draft.linkRequest);
  }

  function useFiles(files, clipboard = false) {
    if (!files.length || dialog.dataset.saving) return;
    formError(form);
    for (const file of files) {
      const supported = imageMime.test(file.type) || (!file.type && imageExtensions.test(file.name));
      const issue = !supported ? 'unsupportedImage' : file.size > 20 * 1024 * 1024 ? 'imageTooLarge' : '';
      if (issue) {
        const message = t(issue);
        formError(form, files.length > 1 ? t('imageImportError', { name: file.name, message }) : message);
        return;
      }
    }
    clearLinkRequest(draft);
    resetDuplicateReview();
    updateLinkStatus();
    retryThumbnail.hidden = true;
    video.value = '';
    draft.linkUrl = '';
    clearImportFiles(draft);
    draft.files = files.map((file, index) => ({
      file,
      name: clipboard ? t('clipboardScreenshot') + (files.length > 1 ? ` ${index + 1}` : '')
        : file.name.replace(imageExtensions, '').trim() || t('imageName'),
      preview: URL.createObjectURL(file),
    }));
    if (author.value === draft.media?.publisher) author.value = '';
    clearImportMedia(draft);
    showPictures();
  }

  function scheduleThumbnail(delay) {
    if (dialog.dataset.saving) return;
    const url = video.value.trim();
    if (url !== draft.linkUrl) resetDuplicateReview();
    clearLinkRequest(draft);
    formError(form);
    retryThumbnail.hidden = true;
    if (draft.media && url !== draft.linkUrl) {
      if (author.value === draft.media.publisher) author.value = '';
      clearImportMedia(draft);
      draft.linkUrl = '';
      showPictures();
    }
    if (url && !draft.media) {
      const request = new AbortController();
      draft.linkRequest = request;
      draft.linkTimer = setTimeout(() => {
        draft.linkTimer = null;
        importLink(url, request);
      }, delay);
    }
    updateLinkStatus();
  }

  async function importLink(url, request) {
    const current = () => draft === addDraft && request === draft.linkRequest && dialog.open;
    try {
      const known = planImports(state, [{ url }]).duplicateLayouts[0]?.layout;
      const media = known ? { ...known } : await api('import', { ...json('POST', { url }), signal: request.signal });
      if (!current()) {
        if (!known) releaseDraftUploads([media.image]);
        return;
      }
      clearImportFiles(draft);
      if (!author.value.trim()) author.value = media.publisher || '';
      draft.media = media;
      draft.linkUpload = known ? '' : media.image;
      draft.linkUrl = url;
      showPictures();
      const plan = planImports(state, [{ ...media, sourceType: 'video' }]);
      if (plan.duplicateLayouts.length) {
        draft.review = reviewKey(plan);
        showDuplicates(plan, false);
      }
    } catch (reason) {
      if (current()) {
        formError(form, reason.message);
        retryThumbnail.hidden = false;
      }
    } finally {
      if (current()) {
        draft.linkRequest = null;
        updateLinkStatus();
      }
    }
  }

  draft.useFiles = useFiles;
  chooseButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    useFiles([...fileInput.files]);
    fileInput.value = '';
  });
  retryThumbnail.addEventListener('click', () => {
    video.focus();
    scheduleThumbnail(0);
  });
  video.addEventListener('input', event => {
    if (!event.isComposing) scheduleThumbnail(event.inputType === 'insertFromPaste' ? 0 : 300);
  });
  video.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      if (draft.linkTimer !== null || !draft.linkRequest) scheduleThumbnail(0);
    }
  });
  dropZone.addEventListener('dragover', event => {
    if (!isGalleryDrag(event) && event.dataTransfer?.types.includes('Files')) dropZone.classList.add('is-over');
  });
  dropZone.addEventListener('dragleave', event => {
    if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('is-over');
  });
  if (files.length) {
    useFiles(files, fromClipboard);
    (title.disabled ? chooseButton : title).focus({ preventScroll: true });
  }
}

function organize(id) {
  const layout = layoutById(id);
  if (!layout) return;
  const currentBoards = state.boards.filter(board => board.items.some(item => item.layoutId === id)).map(board => board.id);
  openDialog('organize', t('organizeName', { name: layout.name }), `<form class="dialog-body">
    <div class="form-stack">
      <label class="field"><span>${txt('layoutAuthor')}</span><input name="publisher" value="${html(layout.publisher)}"></label>
      ${destinationPicker('labels', layout.labels)}
      ${destinationPicker('boards', currentBoards)}
      <p class="form-error" role="alert" hidden></p>
    </div>
    ${dialogButtons(`<button type="button" class="btn danger leading" data-action="delete-layout" data-id="${html(id)}">${txt('deleteLayout')}</button>`)}
  </form>`);
  const form = bindForm(async data => {
    const publisher = String(data.get('publisher') || '').trim();
    const labels = data.getAll('labels');
    const selectedBoards = data.getAll('boards');
    const addsBoard = selectedBoards.some(board => !currentBoards.includes(board));
    const size = addsBoard ? await imageSize(layout.image).catch(() => { throw error('unsupportedImage'); }) : { width: 1280, height: 720 };
    await change(saved => {
      const entry = saved.layouts.find(item => item.id === id);
      if (!entry) throw error('notFound');
      saveNewLabels(saved, newLabels);
      saved.boards.push(...structuredClone(newBoards));
      entry.publisher = publisher;
      entry.labels = labels.filter(label => saved.labels.some(item => item.id === label));
      assignBoards(saved, id, selectedBoards, size);
    });
  }, () => {
    if (newLabels.length || newBoards.length || !refreshExploreCard(id)) render();
  });
  const newLabels = bindDestinationPicker(form, 'labels');
  const newBoards = bindDestinationPicker(form, 'boards');
}

function confirmRemoval(prompt, hint, update, submit = 'delete', completed) {
  openDialog('confirm', prompt, `<form class="dialog-body">
    <p>${txt(hint)}</p><p class="form-error" role="alert" hidden></p>
    ${dialogButtons('', submit, true)}
  </form>`);
  bindForm(async () => {
    await change(update);
    completed?.();
  });
}

function createNamed(kind) {
  const isLabel = kind === 'label';
  openDialog('name', t(isLabel ? 'newLabel' : 'newBoard'), `<form class="dialog-body">
    <label class="field"><span>${txt(isLabel ? 'labelName' : 'boardName')}</span><input name="name" maxlength="80" required data-focus></label>
    <p class="form-error" role="alert" hidden></p>
    ${dialogButtons('', isLabel ? 'newLabel' : 'newBoard')}
  </form>`);
  bindForm(data => {
    const name = String(data.get('name') || '').trim();
    if (!name) throw error('missingName');
    const id = crypto.randomUUID();
    return change(saved => {
      if (isLabel) {
        saved.labels.push(newLabelRecord(name, saved.labels, id));
      } else {
        saved.boards.push({ id, name, items: [] });
      }
    }).then(() => { if (!isLabel) boardId = id; });
  });
}

function filter(id) {
  const labels = new Set(exploreFilter.labelIds);
  if (!id) labels.clear();
  else if (labels.has(id)) labels.delete(id);
  else labels.add(id);
  setExploreFilter({ ...exploreFilter, labelIds: [...labels] });
}

function applyCollection(id) {
  const item = savedCollections().find(collection => collection.id === id);
  if (item) setExploreFilter({ query: item.query, labelIds: [...item.labelIds], ratio: item.ratio }, id);
  else setExploreFilter({ ...noFilters, labelIds: [] });
}

function createCollection() {
  if (!hasExploreFilters()) return;
  const criteria = { ...exploreFilter, query: exploreFilter.query.trim(), labelIds: [...exploreFilter.labelIds] };
  openDialog('name', t('saveCollection'), `<form class="dialog-body">
    <label class="field"><span>${txt('collectionName')}</span><input name="name" maxlength="80" required data-focus></label>
    <p class="form-error" role="alert" hidden></p>
    ${dialogButtons()}
  </form>`);
  bindForm(async data => {
    const name = String(data.get('name') ?? '').trim();
    if (!name) throw error('missingName');
    const id = crypto.randomUUID();
    await change(saved => {
      const collections = saved.settings.collections ??= [];
      if (collections.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw error('collectionExists');
      collections.push({ id, name, ...criteria });
    });
    activeCollection = id;
  });
}

function deleteCollection() {
  const item = savedCollections().find(collection => collection.id === activeCollection);
  if (!item) return;
  confirmRemoval(t('deleteCollectionPrompt', { name: item.name }), 'deleteCollectionHint', saved => {
    saved.settings.collections = saved.settings.collections.filter(collection => collection.id !== item.id);
  }, 'deleteCollection', () => { activeCollection = ''; });
}

function renameCatalogLabel(id) {
  const label = state.labels.find(item => item.id === id);
  if (!label || id === 'favorite') return;
  openDialog('name', t('renameLabel'), `<form class="dialog-body">
    <label class="field"><span>${txt('labelName')}</span><input name="name" value="${html(labelName(label, t))}" maxlength="80" required data-focus></label>
    <p class="form-error" role="alert" hidden></p>
    ${dialogButtons()}
  </form>`);
  bindForm(data => {
    const name = String(data.get('name') ?? '').trim();
    return change(saved => {
      const target = saved.labels.find(item => item.id === id);
      if (!target) throw error('notFound');
      if (name === labelName(target, t)) return;
      const renamed = newLabelRecord(name, saved.labels, id);
      if (isImportLabel(target)) target.kind = 'import';
      Object.assign(target, renamed, { customName: true });
    });
  });
}

async function toggleLabelPin(id) {
  if (id === 'favorite') return;
  await change(saved => {
    const label = saved.labels.find(item => item.id === id);
    if (!label) throw error('notFound');
    label.pinned = !label.pinned;
  });
  if (tab === 'labels') {
    renderLabels();
    [...main.querySelectorAll('[data-action="pin-label"]')].find(button => button.dataset.id === id)?.focus({ preventScroll: true });
  }
}

async function saveLabelOrder(id, targetId, after, keyboard = false) {
  if (savingLabelOrder) return;
  savingLabelOrder = true;
  try {
    let moved = false;
    await change(saved => { moved = moveLabel(saved, id, targetId, after); });
    if (!moved || tab !== 'labels' || bulkSelection) return;
    const focusId = document.activeElement?.matches('.label-grip')
      ? document.activeElement.closest('[data-label-row]').dataset.labelRow : null;
    const { scrollX, scrollY } = window;
    renderLabels();
    window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
    if (focusId) {
      main.querySelector(`[data-label-row="${CSS.escape(focusId)}"] .label-grip`)?.focus({ preventScroll: !keyboard });
    }
  } catch (reason) {
    showError(reason.message);
  } finally {
    savingLabelOrder = false;
  }
}

function bindLabelReordering(list) {
  let dragged = null;
  let target = null;

  function clearTarget() {
    target?.removeAttribute('data-label-drop');
    target = null;
  }

  function endDrag() {
    clearTarget();
    dragged?.removeAttribute('data-label-dragging');
    dragged = null;
  }

  function destination(event) {
    const row = event.target.closest('[data-label-row]');
    if (!row || row === dragged) return null;
    const bounds = row.getBoundingClientRect();
    const after = event.clientY > bounds.top + bounds.height / 2;
    if ((after ? row.nextElementSibling : row.previousElementSibling) === dragged) return null;
    return { row, after };
  }

  list.addEventListener('dragstart', event => {
    const handle = event.target.closest('.label-grip');
    if (!handle || !event.dataTransfer) return;
    if (savingLabelOrder) {
      event.preventDefault();
      return;
    }
    dragged = handle.closest('[data-label-row]');
    const bounds = dragged.getBoundingClientRect();
    event.dataTransfer.setData('application/x-inspiration-label', dragged.dataset.labelRow);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setDragImage(dragged, event.clientX - bounds.left, event.clientY - bounds.top);
    dragged.setAttribute('data-label-dragging', '');
    handle.addEventListener('dragend', endDrag, { once: true });
  });

  list.addEventListener('dragover', event => {
    if (!dragged || !event.dataTransfer) return;
    const drop = destination(event);
    if (target !== drop?.row) clearTarget();
    if (!drop) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    target = drop.row;
    target.setAttribute('data-label-drop', drop.after ? 'after' : 'before');
  });

  list.addEventListener('dragleave', event => {
    if (target && !target.contains(event.relatedTarget)) clearTarget();
  });

  list.addEventListener('drop', event => {
    if (!dragged) return;
    const id = dragged.dataset.labelRow;
    const drop = destination(event);
    endDrag();
    if (!drop) return;
    event.preventDefault();
    void saveLabelOrder(id, drop.row.dataset.labelRow, drop.after);
  });

  list.addEventListener('keydown', event => {
    if (!event.target.matches('.label-grip') || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const row = event.target.closest('[data-label-row]');
    const after = event.key === 'ArrowDown';
    const neighbor = after ? row.nextElementSibling : row.previousElementSibling;
    if (neighbor?.dataset.labelRow) void saveLabelOrder(row.dataset.labelRow, neighbor.dataset.labelRow, after, true);
  });
}

function mergeCatalogLabels() {
  if (tab !== 'labels' || !bulkSelection?.size) return;
  const sources = new Set(bulkSelection);
  const targets = orderedLabels(state).filter(label => !sources.has(label.id));
  openDialog('merge-labels', t('mergeTitle', { count: sources.size }), `<form class="dialog-body">
    <div class="form-stack">
      <p>${txt('mergeHint')}</p>
      <label class="field"><span>${txt('mergeTarget')}</span>
        <select name="target" required data-focus>
          <option value="">${txt('mergeChooseTarget')}</option>
          ${targets.map(label => `<option value="${html(label.id)}">${html(labelName(label, t))}</option>`).join('')}
        </select>
      </label>
      <p class="form-error" role="alert" hidden></p>
    </div>
    ${dialogButtons('', 'mergeLabels')}
  </form>`);
  bindForm(async data => {
    const target = String(data.get('target') ?? '');
    if (!target) throw error('chooseAtLeastOne');
    await change(saved => mergeLabels(saved, [...sources], target));
    exploreFilter.labelIds = [...new Set(exploreFilter.labelIds.map(id => sources.has(id) ? target : id))];
    resetBulk();
  });
}

async function toggleFavorite(id) {
  await change(saved => {
    const layout = saved.layouts.find(item => item.id === id);
    if (!layout) throw error('notFound');
    layout.labels = layout.labels.includes('favorite')
      ? layout.labels.filter(label => label !== 'favorite')
      : [...layout.labels, 'favorite'];
  });
  if (tab !== 'explore') return;
  const card = refreshExploreCard(id);
  if (!card) {
    keepExploreScroll(updateExploreResults);
    return;
  }
  const button = card.querySelector('.favorite');
  if (!button) return;
  button.removeAttribute('data-pop');
  void button.offsetWidth;
  button.setAttribute('data-pop', '');
}

function deleteFromExplore(id) {
  const layout = layoutById(id);
  if (layout) {
    confirmRemoval(t('deleteLayoutPrompt', { name: layout.name }), 'deleteLayoutHint',
      saved => moveLayoutToTrash(saved, id), 'moveToTrash');
  }
}

async function restoreFromTrash(id) {
  await change(saved => restoreLayout(saved, id));
  if (tab === 'trash') renderTrash();
}

function deleteFromTrash(id) {
  const layout = state.trash.find(item => item.id === id);
  if (layout) {
    confirmRemoval(t('permanentDeletePrompt', { name: layout.name }), 'permanentDeleteHint',
      saved => deleteTrashedLayout(saved, id), 'deletePermanently');
  }
}

function deleteCatalogLabel(id) {
  const label = state.labels.find(item => item.id === id);
  if (label && id !== 'favorite') {
    confirmRemoval(t('deleteLabelPrompt', { name: labelName(label, t) }), 'deleteLabelHint', saved => removeLabel(saved, id));
  }
}

function deleteWhiteboard(id) {
  const board = state.boards.find(item => item.id === id);
  if (board) {
    confirmRemoval(t('deleteBoardPrompt', { name: board.name }), 'deleteBoardHint', saved => {
      saved.boards = saved.boards.filter(item => item.id !== id);
    });
  }
}

function toggleBulkMode() {
  if (bulkSelection) resetBulk();
  else bulkSelection = new Set();
  if (tab === 'explore') keepExploreScroll(renderExplore);
  else spec[tab]();
  main.querySelector('[data-action="toggle-bulk"]')?.focus({ preventScroll: true });
}

function updateBulkSelection() {
  const selections = [...main.querySelectorAll('[data-bulk-id]')];
  for (const element of selections) {
    const selected = bulkSelection.has(element.dataset.bulkId);
    if (element.type === 'checkbox') element.checked = selected;
    else element.setAttribute('aria-pressed', String(selected));
  }
  const toolbar = main.querySelector('.bulk-toolbar');
  if (!toolbar) return;
  const visibleIds = selections.map(element => element.dataset.bulkId);
  toolbar.querySelector('[data-bulk-count]').textContent = t('bulkCount', { count: bulkSelection.size });
  toolbar.querySelector('[data-action="select-visible"]').textContent = t(allShownSelected(visibleIds) ? 'deselectVisible' : 'selectVisible');
  for (const command of toolbar.querySelectorAll('[data-bulk-command]')) {
    command.disabled = bulkSelection.size === 0;
  }
}

function selectBulkItem(id, selected = !bulkSelection?.has(id)) {
  if (!bulkSelection) return;
  if (selected) bulkSelection.add(id);
  else bulkSelection.delete(id);
  updateBulkSelection();
}

function exploreCardIds() {
  return [...main.querySelectorAll('.card-preview[data-id]')].map(button => button.dataset.id);
}

function setExploreSelection(ids, focusId) {
  const entering = !bulkSelection;
  bulkSelection = new Set(ids);
  if (!entering) {
    updateBulkSelection();
    return;
  }
  keepExploreScroll(renderExplore);
  if (focusId) main.querySelector(`.card-preview[data-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
}

function selectExploreLayout(id, extend = false) {
  if (!bulkSelection) {
    bulkAnchorId = id;
    setExploreSelection([id], id);
    return;
  }
  if (extend && bulkAnchorId) {
    const ids = exploreCardIds();
    const start = ids.indexOf(bulkAnchorId);
    const end = ids.indexOf(id);
    if (start >= 0 && end >= 0) {
      for (const item of ids.slice(Math.min(start, end), Math.max(start, end) + 1)) bulkSelection.add(item);
      updateBulkSelection();
      return;
    }
  }
  bulkAnchorId = id;
  const selected = extend || !bulkSelection.has(id);
  const layout = !selected && layoutById(id);
  if (layout && exploreFilter.labelIds.some(labelId => !layout.labels.includes(labelId))) {
    bulkSelection.delete(id);
    keepExploreScroll(updateExploreResults);
    return;
  }
  selectBulkItem(id, selected);
}

function selectVisible() {
  if (!bulkSelection) return;
  const ids = [...main.querySelectorAll('[data-bulk-id]')].map(element => element.dataset.bulkId);
  const deselect = allShownSelected(ids);
  for (const id of ids) {
    if (deselect) bulkSelection.delete(id);
    else bulkSelection.add(id);
  }
  updateBulkSelection();
}

function resetBulk() {
  bulkSelection = null;
  bulkAnchorId = '';
}

function chooseBulkDestinations(kind) {
  const ids = [...(bulkSelection ?? [])];
  if (!ids.length || tab !== 'explore') return;
  const boards = kind === 'boards';
  const title = t(boards ? 'bulkBoardTitle' : 'bulkLabelTitle', { count: ids.length });
  openDialog('bulk-destination', title, `<form class="dialog-body">
    <div class="form-stack">
      ${destinationPicker(kind)}
      <p class="form-error" role="alert" hidden></p>
    </div>
    ${dialogButtons()}
  </form>`);
  const form = bindForm(async data => {
    const targets = data.getAll(kind);
    if (!targets.length) throw error('chooseAtLeastOne');
    if (boards) {
      const destinations = [...state.boards, ...additions].filter(board => targets.includes(board.id));
      const needed = state.layouts.filter(layout =>
        ids.includes(layout.id) && destinations.some(board => !board.items.some(item => item.layoutId === layout.id)));
      const sizes = await Promise.all(needed.map(async layout => {
        const size = await imageSize(layout.image).catch(() => { throw error('unsupportedImage'); });
        return [layout.id, size];
      }));
      await change(saved => {
        saved.boards.push(...structuredClone(additions));
        for (const [id, size] of sizes) addLayoutToBoards(saved, id, targets, size);
      });
    } else {
      await change(saved => {
        saveNewLabels(saved, additions);
        addLayoutLabels(saved, ids, targets);
      });
    }
    resetBulk();
  });
  const additions = bindDestinationPicker(form, kind);
}

function bulkDelete() {
  const ids = [...(bulkSelection ?? [])];
  if (!ids.length) return;
  const count = { count: ids.length };
  const selected = new Set(ids);
  switch (tab) {
    case 'explore':
      confirmRemoval(t('bulkTrashPrompt', count), 'bulkTrashHint', saved => {
        for (const id of ids.toReversed()) moveLayoutToTrash(saved, id);
      }, 'moveToTrash', resetBulk);
      break;
    case 'labels':
      confirmRemoval(t('bulkLabelDeletePrompt', count), 'bulkLabelDeleteHint',
        saved => removeLabels(saved, ids), 'deleteLabel', resetBulk);
      break;
    case 'whiteboards':
      confirmRemoval(t('bulkBoardDeletePrompt', count), 'bulkBoardDeleteHint', saved => {
        saved.boards = saved.boards.filter(board => !selected.has(board.id));
      }, 'deleteBoard', resetBulk);
      break;
    case 'trash':
      confirmRemoval(t('bulkPurgePrompt', count), 'bulkPurgeHint', saved => {
        saved.trash = saved.trash.filter(layout => !selected.has(layout.id));
      }, 'deletePermanently', resetBulk);
      break;
  }
}

async function bulkRestore() {
  const ids = [...(bulkSelection ?? [])];
  if (!ids.length || tab !== 'trash') return;
  await change(saved => {
    for (const id of ids.toReversed()) restoreLayout(saved, id);
  });
  resetBulk();
  if (tab === 'trash') renderTrash();
}

function clearTrash() {
  const count = state.trash.length;
  if (!count) return;
  confirmRemoval(t('clearTrashPrompt', { count }), 'bulkPurgeHint', saved => {
    saved.trash = [];
  }, 'clearTrash', resetBulk);
}

const actions = {
  navigate: (_, button) => navigate(button.dataset.tab),
  filter,
  preview,
  'rename-preview': editPreviewName,
  'previous-preview': () => stepPreview(-1),
  'next-preview': () => stepPreview(1),
  'compare-layouts': compareLayouts,
  'clear-filters': () => setExploreFilter({ ...noFilters, labelIds: [] }),
  'save-collection': createCollection,
  'delete-collection': deleteCollection,
  organize,
  favorite: toggleFavorite,
  'gallery-columns': cycleGalleryColumns,
  'back-to-top': () => window.scrollTo({
    top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  }),
  add: () => addLayout(),
  'close-dialog': () => dialog.close(),
  'delete-layout': deleteFromExplore,
  'restore-layout': restoreFromTrash,
  'purge-layout': deleteFromTrash,
  'new-label': () => createNamed('label'),
  'delete-label': deleteCatalogLabel,
  'rename-label': renameCatalogLabel,
  'pin-label': toggleLabelPin,
  'merge-selected-labels': mergeCatalogLabels,
  'new-board': () => createNamed('board'),
  'open-board': id => navigate('whiteboards', id),
  'back-boards': () => navigate('whiteboards'),
  'delete-board': deleteWhiteboard,
  'toggle-bulk': toggleBulkMode,
  'select-layout': id => selectExploreLayout(id),
  'select-visible': selectVisible,
  'bulk-labels': () => chooseBulkDestinations('labels'),
  'bulk-boards': () => chooseBulkDestinations('boards'),
  'bulk-delete': bulkDelete,
  'bulk-restore': bulkRestore,
  'clear-trash': clearTrash,
  'check-update': () => checkForUpdates(),
  'install-update': installUpdate,
  'dismiss-update': dismissUpdate,
  retry: start,
};

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button || (dialog.dataset.saving && dialog.contains(button))) return;
  if (tab === 'explore' && button.matches('.card-preview') && event.button === 0 &&
      !event.altKey && (event.ctrlKey || event.metaKey || event.shiftKey)) {
    event.preventDefault();
    if (!event.ctrlKey || controlClickId !== button.dataset.id) selectExploreLayout(button.dataset.id, event.shiftKey);
    return;
  }
  const action = actions[button.dataset.action];
  if (action) Promise.resolve().then(() => action(button.dataset.id, button)).catch(reason => showError(reason.message));
});

main.addEventListener('pointerdown', () => { controlClickId = ''; });
main.addEventListener('contextmenu', event => {
  if (tab !== 'explore' || event.button !== 0 || !event.ctrlKey || event.altKey) return;
  const card = event.target.closest('.card-preview');
  if (!card) return;
  // macOS may deliver a context menu instead of a click for a primary-button Control gesture.
  event.preventDefault();
  controlClickId = card.dataset.id;
});
main.addEventListener('pointerup', event => {
  if (!controlClickId || event.button !== 0 || !event.ctrlKey) return;
  const card = event.target.closest('.card-preview');
  if (card?.dataset.id === controlClickId) selectExploreLayout(controlClickId, event.shiftKey);
});

main.addEventListener('load', event => {
  const image = event.target;
  if (image.matches?.('.grid .art') && image.naturalWidth > 0) {
    imageDimensions.set(image.getAttribute('src'), { width: image.naturalWidth, height: image.naturalHeight });
  }
}, true);

main.addEventListener('input', event => {
  if (tab === 'explore' && event.target.name === 'explore-query') {
    setExploreFilter({ ...exploreFilter, query: event.target.value });
  }
});

main.addEventListener('change', async event => {
  const { name, value } = event.target;
  if (bulkSelection && event.target.dataset.bulkId) {
    selectBulkItem(event.target.dataset.bulkId, event.target.checked);
    return;
  }
  if (tab === 'explore') {
    if (name === 'explore-ratio') setExploreFilter({ ...exploreFilter, ratio: value });
    if (name === 'explore-collection') applyCollection(value);
    return;
  }
  if (tab !== 'settings' || !['theme', 'language', 'autoCheckUpdates'].includes(name)) return;
  if (name === 'autoCheckUpdates') {
    const checkbox = event.target;
    const enabled = checkbox.checked;
    checkbox.disabled = true;
    try {
      await change(saved => { saved.settings.autoCheckUpdates = enabled; });
      if (!enabled && updateRequest?.automatic) {
        updateRequest.controller.abort();
        updateRequest = null;
      }
      renderUpdateStatus();
      if (enabled) void checkForUpdates(true);
    } catch (reason) {
      checkbox.checked = automaticUpdatesEnabled();
      showError(reason.message);
    } finally {
      checkbox.disabled = false;
      if (checkbox.isConnected) checkbox.focus({ preventScroll: true });
    }
    return;
  }
  try {
    await change(saved => { saved.settings[name] = value; });
  } catch (reason) {
    showError(reason.message);
  }
  if (tab === 'settings') {
    render();
    main.querySelector(`input[name="${name}"]:checked`)?.focus({ preventScroll: true });
  }
});

dialog.addEventListener('close', () => {
  if (!dialog.open) clearDraft();
});

function isDialogBackdrop(event) {
  if (event.target !== dialog) return false;
  const { left, right, top, bottom } = dialog.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
}

let pressedBackdrop = false;
dialog.addEventListener('pointerdown', event => {
  pressedBackdrop = event.button === 0 && isDialogBackdrop(event);
});
dialog.addEventListener('click', event => {
  if (dialog.dataset.saving || event.button !== 0) return;
  const kind = dialog.dataset.kind;
  if (kind === 'preview' && event.target.matches('.preview-stage')) {
    dialog.close();
    return;
  }
  if ((kind === 'preview' || kind === 'organize') && pressedBackdrop && isDialogBackdrop(event)) {
    dialog.close();
  }
});
dialog.addEventListener('cancel', event => {
  if (dialog.dataset.saving || closeLabelPanel(dialog)) event.preventDefault();
});

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || event.altKey) return;
  const modified = event.metaKey || event.ctrlKey;
  if (dialog.open) {
    if (!modified && dialog.dataset.kind === 'preview' && !dialog.dataset.saving && !event.target.closest?.('.preview-name-editor') &&
       (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      stepPreview(event.key === 'ArrowLeft' ? -1 : 1);
    }
    return;
  }
  const key = event.key.toLowerCase();
  // A closed dialog can still be the keyboard event target in WebKit.
  const target = dialog.contains(event.target) ? main : event.target;
  const typing = target.isContentEditable ||
    target.closest?.('input:not([type="checkbox"], [type="radio"]), select, textarea, [role="textbox"]');
  if (bulkSelection && modified && !event.shiftKey && !event.repeat && !typing && key === 'd') {
    event.preventDefault();
    toggleBulkMode();
    return;
  }
  if (tab === 'explore' && !typing && !event.repeat) {
    if (modified && !event.shiftKey && key === 'a') {
      const ids = exploreCardIds();
      if (ids.length || bulkSelection) {
        event.preventDefault();
        const focusId = target.closest?.('.card-preview')?.dataset.id;
        bulkAnchorId = focusId ?? ids[0] ?? '';
        setExploreSelection(ids, focusId);
      }
      return;
    }
    const action = !modified && bulkSelection?.size && exploreBulkShortcuts[key];
    if (action) {
      event.preventDefault();
      actions[action]();
      return;
    }
  }
  if (modified) return;
  if (key === 'o' && !event.repeat && !typing) {
    event.preventDefault();
    const open = !sidebar.hasAttribute('data-open');
    setSidebar(open, !open);
    if (open) navigation.querySelector('.nav-tab[aria-current="page"]')?.focus({ preventScroll: true });
    return;
  }
  if (event.key !== ' ' || tab !== 'explore' || bulkSelection ||
      target.closest?.('button,input,select,textarea,a,summary,[contenteditable]')) return;
  const button = main.querySelector('.card:hover [data-action="preview"]') ?? main.querySelector('[data-action="preview"]');
  if (button) {
    event.preventDefault();
    preview(button.dataset.id);
  }
});

function handlesExploreDrop() {
  return state && tab === 'explore' && (!dialog.open || dialog.dataset.kind === 'add');
}

function highlightGalleryDrop(target) {
  if (target === galleryDropTarget) return;
  galleryDropTarget?.removeAttribute('data-drop-target');
  galleryDropTarget = target;
  galleryDropTarget?.setAttribute('data-drop-target', '');
}

function endGalleryDrag() {
  draggedLayoutId = '';
  highlightGalleryDrop(null);
  if (sidebar.hasAttribute('data-drag-open')) {
    setSidebar(false);
    sidebar.removeAttribute('data-drag-open');
    updateBoardList();
  }
}

function isGalleryDrag(event) {
  return Boolean(draggedLayoutId || event.dataTransfer?.types.includes(galleryDragType));
}

main.addEventListener('dragstart', event => {
  const image = event.target.closest('.card .art');
  if (!image) return;
  if (!canDragGalleryImages() || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  const id = image.closest('.card').dataset.layout;
  event.dataTransfer.clearData();
  event.dataTransfer.setData(galleryDragType, '1');
  event.dataTransfer.effectAllowed = 'copyMove';
  draggedLayoutId = id;
  main.querySelector('.drop-indicator')?.setAttribute('hidden', '');
  image.addEventListener('dragend', endGalleryDrag, { once: true });
  if (!sidebar.hasAttribute('data-open')) {
    sidebar.setAttribute('data-drag-open', '');
    setSidebar(true);
  } else if (state.boards.length) {
    boardListOpen = true;
  }
  updateBoardList();
});

navigation.addEventListener('dragover', event => {
  if (!draggedLayoutId || !canDragGalleryImages() || !event.dataTransfer) return;
  const target = event.target.closest(galleryDropSelector);
  highlightGalleryDrop(target);
  if (!target) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = target.dataset.tab === 'trash' ? 'move' : 'copy';
});

navigation.addEventListener('dragleave', event => {
  if (galleryDropTarget && !galleryDropTarget.contains(event.relatedTarget)) highlightGalleryDrop(null);
});

navigation.addEventListener('drop', async event => {
  const target = event.target.closest(galleryDropSelector);
  if (!target || !draggedLayoutId || !canDragGalleryImages()) return;
  event.preventDefault();
  event.stopPropagation();
  const layoutId = draggedLayoutId;
  endGalleryDrag();
  if (target.dataset.tab === 'trash') {
    deleteFromExplore(layoutId);
    return;
  }
  const layout = layoutById(layoutId);
  const id = target.dataset.id;
  const board = state.boards.find(item => item.id === id);
  if (!layout || !board) return;
  if (board.items.some(item => item.layoutId === layout.id)) {
    showToast(t('alreadyOnBoard', { name: board.name }), 'status');
    return;
  }
  try {
    const size = imageDimensions.get(layout.image) ?? await imageSize(layout.image).catch(() => { throw error('unsupportedImage'); });
    let added = false;
    await change(saved => {
      const destination = saved.boards.find(item => item.id === id);
      if (!destination || !saved.layouts.some(item => item.id === layout.id)) throw error('notFound');
      if (destination.items.some(item => item.layoutId === layout.id)) return;
      addLayoutToBoards(saved, layout.id, [id], size);
      added = true;
    });
    showToast(t(added ? 'droppedOnBoard' : 'alreadyOnBoard', { name: board.name }), 'status');
  } catch (reason) {
    showError(reason.message);
  }
});

document.addEventListener('dragover', event => {
  if (isGalleryDrag(event)) {
    if (!event.defaultPrevented && event.dataTransfer) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'none';
    }
    return;
  }
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  if (handlesExploreDrop() && !dialog.open) main.querySelector('.drop-indicator').hidden = false;
});

document.addEventListener('dragleave', event => {
  if (!event.relatedTarget) main.querySelector('.drop-indicator')?.setAttribute('hidden', '');
});

document.addEventListener('drop', event => {
  if (isGalleryDrag(event)) {
    event.preventDefault();
    endGalleryDrag();
    return;
  }
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  main.querySelector('.drop-indicator')?.setAttribute('hidden', '');
  if (!handlesExploreDrop()) return;
  if (dialog.open) {
    dialog.querySelector('.drop-zone')?.classList.remove('is-over');
    addDraft?.useFiles(files);
  } else {
    addLayout(files);
  }
});

document.addEventListener('paste', event => {
  if (!handlesExploreDrop() || dialog.dataset.saving || !event.clipboardData) return;
  const images = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile()).filter(Boolean);
  const files = images.length ? images : [...event.clipboardData.files].filter(file => imageMime.test(file.type));
  if (!files.length) return;
  event.preventDefault();
  if (dialog.open) addDraft?.useFiles(files, true);
  else addLayout(files, true);
});

async function start() {
  try {
    state = await api('state');
    render();
    void initializeUpdates();
  } catch (reason) {
    main.innerHTML = `<p class="form-error" role="alert">${html(reason.message)}</p><button type="button" class="btn" data-action="retry">${txt('retry')}</button>`;
  }
}

start();
