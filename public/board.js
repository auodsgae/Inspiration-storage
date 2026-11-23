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

export function mountBoard({ element, selectionName, board, saveItems, uploadImage, t, showError }) {
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
  viewport.append(empty, plane);
  wrapper.append(viewport);
  element.replaceChildren(wrapper);

  let history = createBoardHistory(board.items);
  let savedHistory = history;
  const pending = [];
  const itemNodes = new Map();
  let saving = false;
  let selectedId = null;
  let view = { x: 0, y: 0, scale: 1 };
  let drag = null;
  let pinch = null;

  function showSelection(id) {
    itemNodes.get(selectedId)?.setAttribute('aria-pressed', 'false');
    const item = history.items.find((entry) => entry.id === id);
    selectedId = item?.id ?? null;
    itemNodes.get(selectedId)?.setAttribute('aria-pressed', 'true');
    const name = item?.name ?? '';
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
      button.setAttribute('aria-pressed', 'false');
      positionItem(button, item);
    }

    empty.hidden = history.items.length > 0;
    showSelection(selectedId);
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
    if (selectedId === null) return;
    endDrag();
    applyHistory(history.edit(history.items.filter((item) => item.id !== selectedId)));
  }

  function setView(next) {
    view = next;
    viewport.style.setProperty('--whiteboard-pan-x', `${view.x}px`);
    viewport.style.setProperty('--whiteboard-pan-y', `${view.y}px`);
    viewport.style.setProperty('--whiteboard-zoom', String(view.scale));
    viewport.style.setProperty('--whiteboard-inverse-zoom', String(1 / view.scale));
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

  function endDrag() {
    if (!drag) return;
    const { item, placement, corner, pointerId } = drag;
    drag = null;
    item?.style.removeProperty('transform');
    if (corner) positionItem(item, placement);
    delete viewport.dataset.dragging;
    delete viewport.dataset.resizing;
    if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
  }

  function startDrag(event) {
    const panning = event.button === 1;
    if ((event.button !== 0 && !panning) || !event.isPrimary || drag || pinch) return;
    const item = panning ? null : event.target.closest('.whiteboard-item');
    const placement = history.items.find(entry => entry.id === item?.dataset.itemId);
    const corner = placement && event.target.closest('.whiteboard-resize')?.dataset.corner;
    const focusTarget = item ?? viewport;
    focusTarget.focus({ preventScroll: true });
    if (!panning) showSelection(item?.dataset.itemId);
    drag = { item, placement, corner, pointerId: event.pointerId, x: event.clientX, y: event.clientY, view };
    viewport.setPointerCapture(event.pointerId);
    viewport.dataset.dragging = '';
    if (corner) viewport.dataset.resizing = corner;
    event.preventDefault();
  }

  function moveDrag(event) {
    if (event.pointerId !== drag?.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const scale = drag.view.scale;
    if (drag.corner) {
      positionItem(drag.item, resizeBoardImage(drag.placement, dx / scale, dy / scale, drag.corner));
    }
    else if (drag.item) drag.item.style.transform = `translate(${dx / scale}px, ${dy / scale}px)`;
    else setView({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy });
  }

  function finishDrag(event) {
    if (event.pointerId !== drag?.pointerId) return;
    const { placement, corner, view: originalView } = drag;
    const screenX = event.clientX - drag.x;
    const screenY = event.clientY - drag.y;
    if (!placement) moveDrag(event);
    endDrag();
    if (!placement || Math.hypot(screenX, screenY) < 3) return;
    const dx = screenX / originalView.scale;
    const dy = screenY / originalView.scale;
    const updated = corner ? resizeBoardImage(placement, dx, dy, corner)
      : { ...placement, x: placement.x + dx, y: placement.y + dy };
    if (updated.x === placement.x && updated.y === placement.y &&
        updated.width === placement.width && updated.height === placement.height) return;
    applyHistory(history.edit(history.items.map(item => item.id === updated.id ? updated : item)));
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
    if (event.defaultPrevented || event.altKey || event.target.isContentEditable
      || event.target.closest?.('input, textarea, select, [role="textbox"]')) return;
    if (event.target.closest?.('dialog') || viewport.closest('[inert]')) return;
    const key = event.key.toLowerCase();
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && ['+', '=', '-'].includes(key)) {
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
    } else if (selectedId !== null && !modifier
      && (key === 'delete' || key === 'backspace')) {
      event.preventDefault();
      removeSelection();
    }
  }

  async function uploadPlacement(file, index, point) {
    const { image } = await uploadImage(file);
    const preview = new window.Image();
    preview.src = image;
    try {
      await preview.decode();
    } catch {
      throw new Error(t('boardUploadError'));
    }
    const scale = Math.min(1, 320 / preview.naturalWidth, 280 / preview.naturalHeight);
    const width = Math.max(1, Math.round(preview.naturalWidth * scale));
    const height = Math.max(1, Math.round(preview.naturalHeight * scale));
    const name = file.name.replace(/\.[^.]+$/u, '').trim() || t('boardImageName');
    return {
      id: window.crypto.randomUUID(), layoutId: null, name, image,
      x: Math.round(point.x - width / 2 + index * 22),
      y: Math.round(point.y - height / 2 + index * 22),
      width, height,
    };
  }

  function dropFiles(event) {
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    delete viewport.dataset.dropping;
    const point = boardPoint(view, clientPoint(event));
    work.run(async () => {
      const results = await Promise.allSettled(files.map((file, index) => uploadPlacement(file, index, point)));
      if (signal.aborted) return;
      const added = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
      if (added.length > 0) {
        applyHistory(history.edit([...history.items, ...added]));
        if (!drag) showSelection(added.at(-1).id);
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
    const id = event.target.dataset.itemId;
    const item = history.items.find((entry) => entry.id === id);
    if (!item) return;
    showSelection(id);
    if (!isInView(item)) reveal(item);
  }, { signal });
  viewport.addEventListener('click', (event) => {
    const id = event.target.closest('.whiteboard-item')?.dataset.itemId;
    if (id) showSelection(id);
  }, { signal });
  viewport.addEventListener('auxclick', event => {
    if (event.button === 1) event.preventDefault();
  }, { signal });
  viewport.addEventListener('dragover', (event) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
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

  renderItems();
  if (history.items.length > 0 && !history.items.some(isInView)) reveal(history.items.at(-1));

  function unmount() {
    endDrag();
    listeners.abort();
    wrapper.remove();
  }
  unmount.whenIdle = work.wait;
  return unmount;
}
