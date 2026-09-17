import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { FigureExportLayout } from "../../../model";
import type { RasterExportBounds } from "../../../scene/exportRenderer";
import { assertExportCanvasSize } from "../../../export/rasterCanvas";
import { figureExportLayerOffset, layoutCombinedExport, withFigureExportLayerOffset,
  type MovableFigureLayerId, type PreparedCombinedExport } from "../../../export/combinedExportRaster";

type Layout = FigureExportLayout | undefined;
export type FigurePreviewHistory = { past: Layout[]; future: Layout[] };
export interface FigurePreviewEditingActions {
  cancelDrag: () => boolean;
  undo: () => void;
  redo: () => void;
}

/** Preview-only history. Scene/model undo must never consume a layout shortcut. */
export function useFigurePreviewEditing({ prepared, layout, onLayoutChange, boardRef, editingRef, historyStore }: {
  prepared: PreparedCombinedExport;
  layout: Layout;
  onLayoutChange: (layout: Layout) => void;
  boardRef: RefObject<HTMLDivElement | null>;
  editingRef: RefObject<FigurePreviewEditingActions | null>;
  historyStore?: RefObject<FigurePreviewHistory>;
}) {
  const [draft, setDraft] = useState<{ layout: Layout } | null>(null);
  const displayLayout = draft ? draft.layout : layout;
  const currentLayout = useRef(displayLayout);
  currentLayout.current = displayLayout;
  const dragRef = useRef<{ id: MovableFigureLayerId; pointerId: number; x: number; y: number;
    scale: number; layout: Layout; element: HTMLButtonElement } | null>(null);
  const [dragBounds, setDragBounds] = useState<RasterExportBounds | null>(null);
  const [layoutError, setLayoutError] = useState(false);
  const [activeLayerId, setActiveLayerId] = useState<MovableFigureLayerId | null>(null);
  const localHistory = useRef<FigurePreviewHistory>({ past: [], future: [] });
  const historyRef = historyStore ?? localHistory;
  const [history, setHistory] = useState(() => historyRef.current);

  function updateHistory(next: FigurePreviewHistory) {
    historyRef.current = next;
    setHistory(next);
  }
  function recordChange(before: Layout, after: Layout) {
    if (!sameLayout(before, after)) updateHistory({ past: [...historyRef.current.past.slice(-99), before], future: [] });
  }
  function validateLayout(next: Layout): boolean {
    try {
      const { bounds } = layoutCombinedExport(prepared, next);
      assertExportCanvasSize(bounds.width, bounds.height, "combined");
      setLayoutError(false);
      return true;
    } catch {
      setLayoutError(true);
      return false;
    }
  }
  function commitLayout(next: Layout, record = true): boolean {
    if ((record && dragRef.current) || !validateLayout(next)) return false;
    if (record) recordChange(currentLayout.current, next);
    currentLayout.current = next;
    onLayoutChange(next);
    return true;
  }
  function releaseDrag() {
    const drag = dragRef.current;
    if (!drag) return null;
    dragRef.current = null;
    setDragBounds(null);
    setDraft(null);
    if (drag?.element.hasPointerCapture?.(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
    return drag;
  }
  function cancelDrag(): boolean {
    const drag = releaseDrag();
    if (!drag) return false;
    currentLayout.current = drag.layout;
    setLayoutError(false);
    return true;
  }
  function focusActiveLayer() {
    const board = boardRef.current;
    const button = [...(board?.querySelectorAll<HTMLButtonElement>("[data-preview-component]") ?? [])]
      .find(node => node.dataset.previewComponent === activeLayerId);
    (button ?? board?.closest<HTMLElement>('[role="dialog"]'))?.focus({ preventScroll: true });
  }
  function undo() {
    if (dragRef.current) return;
    const { past, future } = historyRef.current;
    if (!past.length) return;
    const before = currentLayout.current;
    if (commitLayout(past[past.length - 1], false)) {
      updateHistory({ past: past.slice(0, -1), future: [...future, before] });
      focusActiveLayer();
    }
  }
  function redo() {
    if (dragRef.current) return;
    const { past, future } = historyRef.current;
    if (!future.length) return;
    const before = currentLayout.current;
    if (commitLayout(future[future.length - 1], false)) {
      updateHistory({ past: [...past, before], future: future.slice(0, -1) });
      focusActiveLayer();
    }
  }
  useEffect(() => {
    const actions = { cancelDrag, undo, redo };
    editingRef.current = actions;
    return () => { if (editingRef.current === actions) editingRef.current = null; };
  });

  function startDrag(event: PointerEvent<HTMLButtonElement>, id: MovableFigureLayerId) {
    if (event.button !== 0 || dragRef.current) return;
    const bounds = layoutCombinedExport(prepared, currentLayout.current).bounds;
    const scale = (boardRef.current?.getBoundingClientRect().width ?? 0) / bounds.width;
    if (!Number.isFinite(scale) || scale <= 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    setActiveLayerId(id);
    dragRef.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, scale,
      layout: currentLayout.current, element: event.currentTarget };
    setDraft({ layout: currentLayout.current });
    setDragBounds(bounds);
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const origin = figureExportLayerOffset(drag.layout, drag.id);
    const next = withFigureExportLayerOffset(drag.layout, drag.id, {
      x: origin.x + (event.clientX - drag.x) / drag.scale / prepared.width,
      y: origin.y + (event.clientY - drag.y) / drag.scale / prepared.height,
    });
    if (validateLayout(next)) {
      currentLayout.current = next;
      setDraft({ layout: next });
    }
  }
  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!dragRef.current || event.pointerId !== dragRef.current.pointerId) return;
    const next = currentLayout.current;
    const drag = releaseDrag()!;
    if (!sameLayout(drag.layout, next) && commitLayout(next, false)) recordChange(drag.layout, next);
  }
  function interruptDrag(event: PointerEvent<HTMLButtonElement>) {
    if (dragRef.current?.pointerId === event.pointerId) cancelDrag();
  }

  return { activeLayerId, setActiveLayerId, displayLayout, dragBounds, layoutError, commitLayout,
    startDrag, moveDrag, finishDrag, interruptDrag, focusActiveLayer, undo, redo,
    canUndo: !dragBounds && history.past.length > 0, canRedo: !dragBounds && history.future.length > 0 };
}

function sameLayout(a: Layout, b: Layout): boolean {
  const ids: MovableFigureLayerId[] = ["legend", "crystalAxes",
    ...[...new Set([...Object.keys(a?.measurementLabels ?? {}), ...Object.keys(b?.measurementLabels ?? {})])]
      .map(id => `measurement:${id}` as const)];
  return ids.every(id => {
    const first = figureExportLayerOffset(a, id), second = figureExportLayerOffset(b, id);
    return first.x === second.x && first.y === second.y;
  }) && (["top", "right", "bottom", "left"] as const).every(side => a?.margins?.[side] === b?.margins?.[side]);
}
