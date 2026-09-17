import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Redo2, RotateCcw, Undo2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { FigureExportLayout } from "../../../model";
import type { RenderProgress } from "../../../model/renderSettings";
import { ExportRenderProgress } from "./ExportTab";
import type { FigurePreviewContent, FigurePreviewState } from "../../../export/figurePreview";
import {
  currentFigureExportMargins,
  defaultFigureExportLayout,
  layoutCombinedExport,
  figureExportLayerOffset,
  withFigureExportLayerOffset,
  structureOnlyFigureExportLayout,
  type MovableFigureLayerId,
} from "../../../export/combinedExportRaster";
import { exportBackgroundColor } from "../../../export/rasterCanvas";
import { useFigurePreviewEditing, type FigurePreviewEditingActions, type FigurePreviewHistory } from "./useFigurePreviewEditing";

interface FigurePreviewDialogProps extends FigurePreviewState {
  layout?: FigureExportLayout;
  exportProgress?: RenderProgress | null;
  onCancelExport?: () => void;
  onLayoutChange: (layout: FigureExportLayout | undefined) => void;
  onOpenChange: (open: boolean) => void;
}

const CHECKERBOARD_STYLE: CSSProperties = {
  backgroundColor: "#ffffff",
  backgroundImage: "conic-gradient(#e8e8e8 25%, transparent 0 50%, #e8e8e8 0 75%, transparent 0)",
  backgroundSize: "16px 16px",
};

export function FigurePreviewDialog({ open, loading, error, content, layout, exportProgress, onCancelExport, onLayoutChange, onOpenChange }: FigurePreviewDialogProps) {
  const { t } = useTranslation();
  const editingRef = useRef<FigurePreviewEditingActions | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} showCloseButton={false}
        onEscapeKeyDown={event => { if (editingRef.current?.cancelDrag()) event.preventDefault(); }}
        onKeyDown={event => {
          event.stopPropagation();
          if (!(event.metaKey || event.ctrlKey) || event.altKey
            || (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]"))) return;
          const key = event.key.toLowerCase();
          if (key !== "z" && key !== "y") return;
          event.preventDefault();
          if (key === "y" || event.shiftKey) editingRef.current?.redo();
          else editingRef.current?.undo();
        }}
        className="flex max-h-[92dvh] w-[min(76rem,calc(100vw-2rem))] flex-col gap-3 p-4 sm:max-w-none sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <DialogTitle>{t("figurePreview.title")}</DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label={t("figurePreview.close")}><X className="size-4" /></Button>
          </DialogClose>
        </div>
        {loading ? <div className="grid h-[55dvh] place-items-center">
          <div className="w-full max-w-72">
            <ExportRenderProgress exportProgress={exportProgress} onCancelExport={onCancelExport} label={t("figurePreview.loading")} />
          </div>
        </div> : error ? <p role="alert" className="py-8 text-sm text-destructive">{error}</p> : content?.kind === "combined" ? (
          <CombinedPreview content={content} layout={layout} onLayoutChange={onLayoutChange} editingRef={editingRef} />
        ) : content?.kind === "separate" ? <SeparatePreview content={content} layout={layout} onLayoutChange={onLayoutChange} editingRef={editingRef} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CombinedPreview({ content, layout, onLayoutChange, structureOnly = false, editingRef, historyStore }: {
  content: Extract<FigurePreviewContent, { kind: "combined" }>;
  layout?: FigureExportLayout;
  onLayoutChange: (layout: FigureExportLayout | undefined) => void;
  structureOnly?: boolean;
  editingRef: RefObject<FigurePreviewEditingActions | null>;
  historyStore?: RefObject<FigurePreviewHistory>;
}) {
  const { t } = useTranslation();
  const { prepared, settings } = content;
  const hostRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [hostSize, setHostSize] = useState({ width: 640, height: 480 });
  const { activeLayerId, setActiveLayerId, displayLayout, dragBounds, layoutError, commitLayout,
    startDrag, moveDrag, finishDrag, interruptDrag, focusActiveLayer, undo, redo, canUndo, canRedo } =
    useFigurePreviewEditing({ prepared, layout, onLayoutChange, boardRef, editingRef, historyStore });
  const blobs = useMemo(() => prepared.layers.map(layer => layer.previewBlob ?? layer.image.blob), [prepared]);
  const urls = useBlobUrls(blobs);
  const rendered = layoutCombinedExport(prepared, displayLayout);
  const displayBounds = dragBounds ?? rendered.bounds;
  const margins = currentFigureExportMargins(prepared, displayLayout);
  const scale = Math.min(hostSize.width / displayBounds.width, hostSize.height / displayBounds.height, 1);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setHostSize({ width: Math.max(1, host.clientWidth - 24), height: Math.max(1, host.clientHeight - 24) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const componentLabel = (id: "legend" | "crystalAxes") => t(id === "legend" ? "exportPanel.legend" : "exportPanel.crystalAxes");
  const activeLayer = prepared.layers.find(layer => layer.id === activeLayerId);
  const activeName = activeLayer?.label ?? (activeLayerId === "legend" || activeLayerId === "crystalAxes" ? componentLabel(activeLayerId) : "");
  const activeOffset = activeLayerId ? figureExportLayerOffset(displayLayout, activeLayerId) : { x: 0, y: 0 };
  return <>
    <div ref={hostRef} className="flex h-[min(60dvh,44rem)] min-h-52 items-center justify-center overflow-hidden rounded-md border bg-muted/30">
      <div ref={boardRef} data-testid="figure-preview-image" className="relative shrink-0 overflow-hidden shadow-sm"
        style={{ width: displayBounds.width * scale, height: displayBounds.height * scale,
          ...(settings.background === "transparent" ? CHECKERBOARD_STYLE : { backgroundColor: exportBackgroundColor(settings.background) ?? undefined }) }}>
        {rendered.layers.map((layer, index) => {
          const position: CSSProperties = {
            position: "absolute", left: (layer.x - displayBounds.minX) * scale, top: (layer.y - displayBounds.minY) * scale,
            width: layer.image.width * scale, height: layer.image.height * scale,
          };
          const movable: MovableFigureLayerId | null = layer.id && layer.id !== "structure" ? layer.id : null;
          const isMeasurement = movable?.startsWith("measurement:");
          return <div key={layer.id ?? index} style={position}>
            {urls[index] ? <img src={urls[index]} alt="" draggable={false} className="pointer-events-none size-full select-none" /> : null}
            {movable ? <button type="button"
              aria-label={isMeasurement ? t("figurePreview.moveMeasurement", { label: layer.label ?? "" })
                : t("figurePreview.moveComponent", { component: componentLabel(movable as "legend" | "crystalAxes") })}
              data-preview-component={movable}
              aria-pressed={activeLayerId === movable}
              onFocus={() => setActiveLayerId(movable)}
              style={isMeasurement ? { inset: "auto", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
                width: "100%", height: "100%", minWidth: 24, minHeight: 24 } : undefined}
              className="absolute inset-0 touch-none cursor-grab rounded-sm border border-dashed border-sky-600/55 bg-transparent outline-none hover:border-sky-600 focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
              onPointerDown={event => startDrag(event, movable)} onPointerMove={moveDrag}
              onPointerUp={finishDrag} onPointerCancel={interruptDrag} onLostPointerCapture={interruptDrag}
              onKeyDown={event => {
                const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
                if (!steps || dragBounds) return;
                event.preventDefault();
                const current = figureExportLayerOffset(layout, movable);
                const amount = event.shiftKey ? 10 : 1;
                commitLayout(withFigureExportLayerOffset(layout, movable, {
                  x: current.x + steps[0]! * amount / prepared.width,
                  y: current.y + steps[1]! * amount / prepared.height,
                }));
              }} /> : null}
          </div>;
        })}
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("figurePreview.editLayout")}>
      <Button size="sm" variant="outline" disabled={!canUndo} onClick={undo}><Undo2 className="size-3.5" />{t("figurePreview.undo")}</Button>
      <Button size="sm" variant="outline" disabled={!canRedo} onClick={redo}><Redo2 className="size-3.5" />{t("figurePreview.redo")}</Button>
      {activeLayerId ? <Button size="sm" variant="outline" className="h-auto min-h-8 whitespace-normal text-left"
        disabled={Boolean(dragBounds) || (activeOffset.x === 0 && activeOffset.y === 0)}
        onClick={() => {
          commitLayout(withFigureExportLayerOffset(layout, activeLayerId, { x: 0, y: 0 }));
          focusActiveLayer();
        }}>
        <RotateCcw className="size-3.5" />{t("figurePreview.resetSelected", { label: activeName })}
      </Button> : <span className="text-xs text-muted-foreground">{t("figurePreview.selectToReset")}</span>}
    </div>
    {prepared.layers.some(layer => layer.id?.startsWith("measurement:")) ?
      <p className="text-xs text-muted-foreground">{t("figurePreview.dragLabelsHint")}</p> : null}
    <div className="flex flex-wrap items-center justify-between gap-3">
      {!structureOnly ? <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t("figurePreview.margins")}</span>
        {(["top", "right", "bottom", "left"] as const).map(side => <label key={side} className="flex items-center gap-1.5">
          <span>{t(`figurePreview.${side}`)}</span>
          <Input type="number" min={0} step={0.5} className="h-8 w-17" disabled={Boolean(dragBounds)}
            aria-label={t("figurePreview.marginSide", { side: t(`figurePreview.${side}`) })}
            value={Math.round(margins[side] * 1000) / 10}
            onChange={event => {
              if (event.currentTarget.value.trim() === "") return;
              const value = Number(event.currentTarget.value);
              if (!Number.isFinite(value)) return;
              commitLayout({ ...(layout ?? defaultFigureExportLayout()), margins: { ...margins, [side]: Math.max(0, value) / 100 } });
            }} />
        </label>)}
      </div> : null}
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">{rendered.bounds.width} × {rendered.bounds.height} px</span>
        <Button size="sm" variant="outline" disabled={Boolean(dragBounds)} onClick={() => commitLayout(undefined)}><RotateCcw className="size-3.5" />{t(structureOnly ? "figurePreview.resetLabels" : "figurePreview.reset")}</Button>
      </div>
    </div>
    {layoutError ? <p className="text-sm text-destructive" role="alert">{t("figurePreview.tooLarge")}</p> : null}
  </>;
}

function SeparatePreview({ content, layout, onLayoutChange, editingRef }: {
  content: Extract<FigurePreviewContent, { kind: "separate" }>;
  layout?: FigureExportLayout;
  onLayoutChange: (layout: FigureExportLayout | undefined) => void;
  editingRef: RefObject<FigurePreviewEditingActions | null>;
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState(0);
  const historyStore = useRef<FigurePreviewHistory>({ past: [], future: [] });
  const blobs = useMemo(() => content.files.map(file => file.blob), [content]);
  const urls = useBlobUrls(blobs);
  const structure = content.structure;
  const isStructure = Boolean(structure && active === 0);
  const fileIndex = active - (structure ? 1 : 0);
  const file = content.files[fileIndex];
  const names = [...(structure ? [structure.fileName] : []), ...content.files.map(item => item.fileName)];
  return <>
    {names.length > 1 ? <div className="flex flex-wrap gap-1" role="group" aria-label={t("figurePreview.files")}>
      {names.map((name, index) => <Button key={name} size="sm" variant={index === active ? "secondary" : "ghost"}
        aria-pressed={index === active} onClick={() => setActive(index)}>{name}</Button>)}
    </div> : null}
    {isStructure && structure ? <CombinedPreview content={{ kind: "combined", prepared: structure.prepared, settings: structure.settings }}
      structureOnly editingRef={editingRef} historyStore={historyStore} layout={structureOnlyFigureExportLayout(layout)} onLayoutChange={next => {
        const { measurementLabels: _old, ...accessories } = layout ?? defaultFigureExportLayout();
        onLayoutChange(next?.measurementLabels ? { ...accessories, measurementLabels: next.measurementLabels } : accessories);
      }} /> : <div className="flex h-[60dvh] min-h-52 items-center justify-center overflow-auto rounded-md border p-3" style={CHECKERBOARD_STYLE}>
      {file && urls[fileIndex] ? file.format === "pdf" ? <iframe title={file.fileName} src={urls[fileIndex]} className="size-full border-0" />
        : <img src={urls[fileIndex]} alt={file.fileName} className="max-h-full max-w-full object-contain" /> : null}
    </div>}
    <p className="text-xs text-muted-foreground">{t("figurePreview.separateHint")}</p>
  </>;
}

function useBlobUrls(blobs: Blob[]) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const next = blobs.map(blob => URL.createObjectURL(blob));
    setUrls(next);
    return () => { next.forEach(url => URL.revokeObjectURL(url)); };
  }, [blobs]);
  return urls;
}
