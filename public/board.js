export const boardImageWidth = 320;
const boardImageGap = 24;
const boardColumnCount = 3;

function openColumnY(occupied, x, startY, { width, height }) {
  let y = startY;
  for (const item of occupied) {
    if (item.y >= y + height + boardImageGap) break;
    if (item.x < x + width + boardImageGap && item.x + item.width + boardImageGap > x) {
      y = Math.max(y, item.y + item.height + boardImageGap);
    }
  }
  return y;
}

export function placeBoardImages(existingItems, images, origin = { x: 56, y: 56 }) {
  const occupied = existingItems.toSorted((left, right) => left.y - right.y);
  return images.map(image => {
    let position = { x: origin.x, y: Infinity };
    for (let column = 0; column < boardColumnCount; column++) {
      const x = origin.x + column * (boardImageWidth + boardImageGap);
      const y = openColumnY(occupied, x, origin.y, image);
      if (y < position.y) position = { x, y };
      if (y === origin.y) break;
    }
    const placed = { ...image, ...position };
    const next = occupied.findIndex(item => item.y > placed.y);
    if (next === -1) occupied.push(placed);
    else occupied.splice(next, 0, placed);
    return placed;
  });
}

export function createBoardHistory(items, previous = [], following = []) {
  const history = {
    items,
    canUndo: previous.length > 0,
    canRedo: following.length > 0,
    edit(nextItems) {
      return createBoardHistory(nextItems, [...previous, items]);
    },
    undo() {
      if (!history.canUndo) return history;
      return createBoardHistory(previous.at(-1), previous.slice(0, -1), [...following, items]);
    },
    redo() {
      if (!history.canRedo) return history;
      return createBoardHistory(following.at(-1), [...previous, items], following.slice(0, -1));
    },
  };
  return history;
}

export function createBoardWork() {
  const active = new Set();
  return {
    run(task) {
      const job = task();
      active.add(job);
      const release = () => active.delete(job);
      job.then(release, release);
      return job;
    },
    async wait() {
      while (active.size > 0) await Promise.allSettled(active);
    },
  };
}

export function boardPoint(view, point) {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

export function boardItemsInRect(items, view, bounds) {
  const { x, y } = boardPoint(view, bounds);
  const right = x + bounds.width / view.scale;
  const bottom = y + bounds.height / view.scale;
  return items.filter(item => item.x < right && item.x + item.width > x &&
    item.y < bottom && item.y + item.height > y).map(item => item.id);
}

export function zoomBoardView(view, requestedScale, anchor) {
  const scale = Math.max(0.125, Math.min(8, requestedScale));
  const world = boardPoint(view, anchor);
  return { scale, x: anchor.x - world.x * scale, y: anchor.y - world.y * scale };
}

export function resizeBoardImage(item, dx, dy, corner = 'se') {
  const { width, height } = item;
  const fromLeft = corner.endsWith('w');
  const fromTop = corner.startsWith('n');
  const longest = Math.max(width, height);
  const outwardX = fromLeft ? -dx : dx;
  const outwardY = fromTop ? -dy : dy;
  const projected = 1 + (outwardX * width + outwardY * height) / (width ** 2 + height ** 2);
  const factor = Math.max(Math.min(1, 24 / longest), Math.min(Math.max(1, 12000 / longest), projected));
  const nextWidth = width * factor;
  const nextHeight = height * factor;
  return {
    ...item,
    x: fromLeft ? item.x + (width - nextWidth) : item.x,
    y: fromTop ? item.y + (height - nextHeight) : item.y,
    width: nextWidth,
    height: nextHeight,
  };
}

export function mountBoard({ element, selectionName, board, saveItems, saveView, uploadImage, isInternalDrag, t, showError }) {
  const document = element.ownerDocument;
  const window = document.defaultView;
  const listeners = new window.AbortController();
  const { signal } = listeners;
  const work = createBoardWork();

  function create(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content) node.textContent = content;
    return node;
  }

  const wrapper = create('div', 'whiteboard');

  const viewport = create('div', 'whiteboard-viewport');
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', t('boardCanvas'));
  const empty = create('div', 'whiteboard-empty');
  empty.append(create('p', 'whiteboard-empty-title', t('boardEmptyTitle')),
    create('p', 'whiteboard-empty-hint', t('boardEmptyHint')));
  const plane = create('div', 'whiteboard-plane');
  const marquee = create('div', 'whiteboard-marquee');
  marquee.hidden = true;
  marquee.setAttribute('aria-hidden', 'true');
  viewport.append(empty, plane, marquee);
  wrapper.append(viewport);
  element.replaceChildren(wrapper);

  let history = createBoardHistory(board.items);
  let savedHistory = history;
  const pending = [];
  const itemNodes = new Map();
  let saving = false;
  let selectedIds = new Set();
  let view = board.view ?? { x: 0, y: 0, scale: 1 };
  let pendingView = null;
  let viewTimer;
  let spaceHeld = false;
  let drag = null;
  let pinch = null;

  function showSelection(ids) {
    const next = new Set([...ids].filter(id => itemNodes.has(id)));
    for (const id of selectedIds) {
      if (!next.has(id)) itemNodes.get(id)?.setAttribute('aria-pressed', 'false');
    }
    for (const id of next) {
      if (!selectedIds.has(id)) itemNodes.get(id).setAttribute('aria-pressed', 'true');
    }
    selectedIds = next;
    viewport.toggleAttribute('data-single-selection', next.size === 1);
    const name = next.size > 1 ? t('boardSelectedCount', { count: next.size }) : next.size
      ? history.items.find(item => next.has(item.id)).name : '';
    if (selectionName.textContent !== name) selectionName.textContent = name;
    selectionName.title = name;
  }

  function positionItem(node, item) {
    node.style.left = `${item.x}px`;
    node.style.top = `${item.y}px`;
    node.style.width = `${item.width}px`;
    node.style.height = `${item.height}px`;
  }

  function renderItems() {
    const currentIds = new Set(history.items.map((item) => item.id));
    for (const [id, button] of itemNodes) {
      if (currentIds.has(id)) continue;
      if (document.activeElement === button) viewport.focus({ preventScroll: true });
      button.remove();
      itemNodes.delete(id);
    }

    for (const item of history.items) {
      let button = itemNodes.get(item.id);
      if (!button) {
        button = create('button', 'whiteboard-item');
        button.type = 'button';
        button.dataset.itemId = item.id;
        button.setAttribute('aria-pressed', 'false');
        const image = create('img');
        image.alt = '';
        image.draggable = false;
        image.src = item.image;
        button.append(image);
        for (const corner of ['nw', 'ne', 'sw', 'se']) {
          const resize = create('span', 'whiteboard-resize');
          resize.dataset.corner = corner;
          resize.setAttribute('aria-hidden', 'true');
          button.append(resize);
        }
        plane.append(button);
        itemNodes.set(item.id, button);
      }
      button.title = item.name;
      button.setAttribute('aria-label', item.name);
      positionItem(button, item);
    }

    empty.hidden = history.items.length > 0;
    showSelection(selectedIds);
  }

  async function persist() {
    if (saving) return;
    saving = true;
    while (pending.length > 0) {
      const next = pending[0];
      try {
        await saveItems(next.items);
      } catch (error) {
        pending.length = 0;
        history = savedHistory;
        if (!signal.aborted) {
          endDrag();
          renderItems();
          showError(error?.message || t('boardSaveError'));
        }
        break;
      }
      savedHistory = next;
      pending.shift();
    }
    saving = false;
  }

  function applyHistory(next) {
    if (next === history) return;
    history = next;
    renderItems();
    pending.push(next);
    if (!saving) work.run(persist);
  }

  function undo() {
    endDrag();
    applyHistory(history.undo());
  }

  function redo() {
    endDrag();
    applyHistory(history.redo());
  }

  function removeSelection() {
    if (selectedIds.size === 0) return;
    endDrag();
    applyHistory(history.edit(history.items.filter(item => !selectedIds.has(item.id))));
  }

  function renderView() {
    viewport.style.setProperty('--whiteboard-pan-x', `${view.x}px`);
    viewport.style.setProperty('--whiteboard-pan-y', `${view.y}px`);
    viewport.style.setProperty('--whiteboard-zoom', String(view.scale));
    viewport.style.setProperty('--whiteboard-inverse-zoom', String(1 / view.scale));
  }

  function flushView() {
    window.clearTimeout(viewTimer);
    if (!pendingView) return;
    const next = pendingView;
    pendingView = null;
    work.run(async () => {
      try {
        await saveView(next);
      } catch (error) {
        if (!signal.aborted) showError(error?.message || t('boardSaveError'));
      }
    });
  }

  function setView(next) {
    if (view.x === next.x && view.y === next.y && view.scale === next.scale) return;
    view = next;
    renderView();
    pendingView = view;
    window.clearTimeout(viewTimer);
    viewTimer = window.setTimeout(flushView, 220);
  }

  function centerPoint() {
    return { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
  }

  function clientPoint(event) {
    const bounds = viewport.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function isInView(item) {
    const x = item.x * view.scale + view.x;
    const y = item.y * view.scale + view.y;
    return x + item.width * view.scale > 0 && x < viewport.clientWidth
      && y + item.height * view.scale > 0 && y < viewport.clientHeight;
  }

  function reveal(item) {
    const center = centerPoint();
    setView({ ...view,
      x: center.x - (item.x + item.width / 2) * view.scale,
      y: center.y - (item.y + item.height / 2) * view.scale,
    });
  }

  function endDrag(cancelled = true) {
    if (!drag) return;
    const { item, placement, pointerId, mode, moveIds, selectionBefore } = drag;
    drag = null;
    if (mode === 'move') {
      for (const id of moveIds) itemNodes.get(id)?.style.removeProperty('transform');
    }
    if (mode === 'resize') positionItem(item, placement);
    if (mode === 'select' && cancelled) showSelection(selectionBefore);
    marquee.hidden = true;
    delete viewport.dataset.panning;
    delete viewport.dataset.resizing;
    if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
  }

  function startDrag(event) {
    const panning = event.button === 1 || (event.button === 0 && spaceHeld);
    if ((event.button !== 0 && !panning) || !event.isPrimary || drag || pinch) return;
    const item = panning ? null : event.target.closest('.whiteboard-item');
    const id = item?.dataset.itemId;
    const placement = history.items.find(entry => entry.id === id);
    const corner = placement && event.target.closest('.whiteboard-resize')?.dataset.corner;
    const mode = panning ? 'pan' : corner ? 'resize' : item ? 'move' : 'select';
    const additive = event.ctrlKey || event.metaKey;
    const selectionBefore = selectedIds;
    if (mode === 'move' && !selectedIds.has(id)) {
      showSelection(additive ? [...selectedIds, id] : [id]);
    }
    drag = { mode, item, placement, corner, additive, selectionBefore, moveIds: selectedIds,
      pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: clientPoint(event), view, moved: false };
    (item ?? viewport).focus({ preventScroll: true });
    viewport.setPointerCapture(event.pointerId);
    if (mode === 'pan') viewport.dataset.panning = '';
    if (corner) viewport.dataset.resizing = corner;
    event.preventDefault();
  }

  function moveDrag(event) {
    if (event.pointerId !== drag?.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    const scale = drag.view.scale;
    if (drag.mode === 'pan') {
      setView({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy });
    } else if (drag.mode === 'resize') {
      positionItem(drag.item, resizeBoardImage(drag.placement, dx / scale, dy / scale, drag.corner));
    } else if (drag.mode === 'move') {
      const transform = `translate(${dx / scale}px, ${dy / scale}px)`;
      for (const id of drag.moveIds) {
        const node = itemNodes.get(id);
        if (node) node.style.transform = transform;
      }
    } else {
      const point = clientPoint(event);
      const bounds = { x: Math.min(drag.start.x, point.x), y: Math.min(drag.start.y, point.y),
        width: Math.abs(drag.start.x - point.x), height: Math.abs(drag.start.y - point.y) };
      marquee.hidden = false;
      positionItem(marquee, bounds);
      const hits = boardItemsInRect(history.items, drag.view, bounds);
      showSelection(drag.additive ? [...drag.selectionBefore, ...hits] : hits);
    }
  }

  function finishDrag(event) {
    if (event.pointerId !== drag?.pointerId) return;
    moveDrag(event);
    const { mode, placement, corner, additive, selectionBefore, moveIds, moved, x, y, view: originalView } = drag;
    endDrag(false);
    if (mode === 'pan') return;
    if (mode === 'select') {
      if (!moved && !additive) showSelection([]);
      return;
    }
    if (!moved) {
      if (mode === 'move') {
        const id = placement.id;
        if (additive) {
          const next = new Set(selectionBefore);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          showSelection(next);
        } else showSelection([id]);
      }
      return;
    }
    const dx = (event.clientX - x) / originalView.scale;
    const dy = (event.clientY - y) / originalView.scale;
    if (dx === 0 && dy === 0) return;
    if (mode === 'move') {
      applyHistory(history.edit(history.items.map(item => moveIds.has(item.id)
        ? { ...item, x: item.x + dx, y: item.y + dy } : item)));
      return;
    }
    const updated = resizeBoardImage(placement, dx, dy, corner);
    if (updated.x === placement.x && updated.y === placement.y &&
        updated.width === placement.width && updated.height === placement.height) return;
    applyHistory(history.edit(history.items.map(item => item.id === updated.id ? updated : item)));
  }

  function setSpaceHeld(held) {
    spaceHeld = held;
    viewport.toggleAttribute('data-pan-ready', held);
  }

  function wheelCanvas(event) {
    event.preventDefault();
    if (drag || pinch) return;
    const units = event.deltaMode === 1 ? 16 : 1;
    const xScale = event.deltaMode === 2 ? viewport.clientWidth : units;
    const yScale = event.deltaMode === 2 ? viewport.clientHeight : units;
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * yScale * 0.004);
      setView(zoomBoardView(view, view.scale * factor, clientPoint(event)));
      return;
    }
    const horizontal = event.shiftKey && !event.deltaX;
    const dx = horizontal ? event.deltaY : event.deltaX;
    const dy = horizontal ? 0 : event.deltaY;
    setView({ ...view, x: view.x - dx * xScale, y: view.y - dy * yScale });
  }

  function startPinch(event) {
    event.preventDefault();
    endDrag();
    const point = clientPoint(event);
    const onCanvas = point.x >= 0 && point.x < viewport.clientWidth && point.y >= 0 && point.y < viewport.clientHeight;
    pinch = { view, anchor: onCanvas ? point : centerPoint() };
  }

  function updatePinch(event) {
    event.preventDefault();
    if (pinch && Number.isFinite(event.scale) && event.scale > 0) {
      setView(zoomBoardView(pinch.view, pinch.view.scale * event.scale, pinch.anchor));
    }
  }

  function handleKeys(event) {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.target.isContentEditable
      || event.target.closest?.('input, textarea, select, [role="textbox"]')) return;
    if (event.target.closest?.('dialog') || viewport.closest('[inert]')) return;
    const key = event.key.toLowerCase();
    const modifier = event.ctrlKey || event.metaKey;
    if (key === ' ' && !modifier) {
      if (!event.target.closest?.('button, a, summary') || viewport.contains(event.target)) {
        event.preventDefault();
        setSpaceHeld(true);
      }
    } else if (modifier && ['+', '=', '-'].includes(key)) {
      event.preventDefault();
      if (!drag && !pinch) {
        const factor = key === '-' ? 1 / 1.2 : 1.2;
        setView(zoomBoardView(view, view.scale * factor, centerPoint()));
      }
    } else if (modifier && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (event.ctrlKey && key === 'y') {
      event.preventDefault();
      redo();
    } else if (selectedIds.size > 0 && !modifier
      && (key === 'delete' || key === 'backspace')) {
      event.preventDefault();
      removeSelection();
    }
  }

  async function uploadBoardImage(file) {
    const { image } = await uploadImage(file);
    const preview = new window.Image();
    preview.src = image;
    try {
      await preview.decode();
    } catch {
      throw new Error(t('boardUploadError'));
    }
    const scale = Math.min(1, boardImageWidth / preview.naturalWidth, 280 / preview.naturalHeight);
    const width = Math.max(1, Math.round(preview.naturalWidth * scale));
    const height = Math.max(1, Math.round(preview.naturalHeight * scale));
    const name = file.name.replace(/\.[^.]+$/u, '').trim() || t('boardImageName');
    return { id: window.crypto.randomUUID(), layoutId: null, name, image, width, height };
  }

  function dropFiles(event) {
    if (isInternalDrag(event)) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    delete viewport.dataset.dropping;
    const point = boardPoint(view, clientPoint(event));
    work.run(async () => {
      const results = await Promise.allSettled(files.map(uploadBoardImage));
      if (signal.aborted) return;
      const images = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
      if (images.length > 0) {
        const origin = {
          x: Math.round(point.x - images[0].width / 2),
          y: Math.round(point.y - images[0].height / 2),
        };
        const added = placeBoardImages(history.items, images, origin);
        applyHistory(history.edit([...history.items, ...added]));
        if (!drag) {
          const visible = added.findLast(isInView);
          if (!visible) reveal(added[0]);
          showSelection([(visible ?? added[0]).id]);
        }
      }
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) showError(failed.reason?.message || t('boardUploadError'));
    });
  }

  viewport.addEventListener('pointerdown', startDrag, { signal });
  viewport.addEventListener('pointermove', moveDrag, { signal });
  viewport.addEventListener('pointerup', finishDrag, { signal });
  viewport.addEventListener('pointercancel', (event) => {
    if (event.pointerId === drag?.pointerId) endDrag();
  }, { signal });
  viewport.addEventListener('lostpointercapture', (event) => {
    if (event.pointerId === drag?.pointerId) endDrag();
  }, { signal });
  viewport.addEventListener('wheel', wheelCanvas, { signal, passive: false });
  viewport.addEventListener('gesturestart', startPinch, { signal, passive: false });
  viewport.addEventListener('gesturechange', updatePinch, { signal, passive: false });
  viewport.addEventListener('gestureend', event => {
    event.preventDefault();
    pinch = null;
  }, { signal, passive: false });
  viewport.addEventListener('focusin', (event) => {
    if (drag) return;
    const id = event.target.dataset.itemId;
    const item = history.items.find((entry) => entry.id === id);
    if (!item) return;
    showSelection([id]);
    if (!isInView(item)) reveal(item);
  }, { signal });
  viewport.addEventListener('click', (event) => {
    if (event.detail !== 0) return;
    const id = event.target.closest('.whiteboard-item')?.dataset.itemId;
    if (id) showSelection([id]);
  }, { signal });
  viewport.addEventListener('contextmenu', event => {
    if (event.ctrlKey && event.target.closest('.whiteboard-item')) event.preventDefault();
  }, { signal });
  viewport.addEventListener('auxclick', event => {
    if (event.button === 1) event.preventDefault();
  }, { signal });
  viewport.addEventListener('dragover', (event) => {
    if (isInternalDrag(event) || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    viewport.dataset.dropping = '';
  }, { signal });
  viewport.addEventListener('dragleave', (event) => {
    if (!viewport.contains(event.relatedTarget)) delete viewport.dataset.dropping;
  }, { signal });
  viewport.addEventListener('drop', dropFiles, { signal });
  window.addEventListener('keydown', handleKeys, { signal });
  window.addEventListener('keyup', event => {
    if (event.key === ' ') setSpaceHeld(false);
  }, { signal });
  window.addEventListener('blur', () => {
    setSpaceHeld(false);
    endDrag();
  }, { signal });

  renderView();
  renderItems();
  if (!board.view && history.items.length > 0 && !history.items.some(isInView)) reveal(history.items.at(-1));

  function unmount() {
    endDrag();
    flushView();
    listeners.abort();
    wrapper.remove();
  }
  unmount.whenIdle = async () => {
    do {
      flushView();
      await work.wait();
    } while (pendingView);
  };
  return unmount;
}
