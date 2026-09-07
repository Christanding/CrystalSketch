import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { FigureExportLayout } from "../../../model";
import type { FigurePreviewContent, FigurePreviewState } from "../../../export/figurePreview";
import {
  currentFigureExportMargins,
  defaultFigureExportLayout,
  layoutCombinedExport,
} from "../../../export/combinedExportRaster";
import { assertExportCanvasSize, exportBackgroundColor } from "../../../export/rasterCanvas";
import type { RasterExportBounds } from "../../../scene/exportRenderer";

interface FigurePreviewDialogProps extends FigurePreviewState {
  layout?: FigureExportLayout;
  onLayoutChange: (layout: FigureExportLayout | undefined) => void;
  onOpenChange: (open: boolean) => void;
}

const CHECKERBOARD_STYLE: CSSProperties = {
  backgroundColor: "#ffffff",
  backgroundImage: "conic-gradient(#e8e8e8 25%, transparent 0 50%, #e8e8e8 0 75%, transparent 0)",
  backgroundSize: "16px 16px",
};

export function FigurePreviewDialog({ open, loading, error, content, layout, onLayoutChange, onOpenChange }: FigurePreviewDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} showCloseButton={false}
        onKeyDown={event => event.stopPropagation()}
        className="flex max-h-[92dvh] w-[min(76rem,calc(100vw-2rem))] flex-col gap-3 p-4 sm:max-w-none sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <DialogTitle>{t("figurePreview.title")}</DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label={t("figurePreview.close")}><X className="size-4" /></Button>
          </DialogClose>
        </div>
        {loading ? <div className="flex h-[55dvh] items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />{t("figurePreview.loading")}
        </div> : error ? <p role="alert" className="py-8 text-sm text-destructive">{error}</p> : content?.kind === "combined" ? (
          <CombinedPreview content={content} layout={layout} onLayoutChange={onLayoutChange} />
        ) : content?.kind === "separate" ? <SeparatePreview content={content} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CombinedPreview({ content, layout, onLayoutChange }: {
  content: Extract<FigurePreviewContent, { kind: "combined" }>;
  layout?: FigureExportLayout;
  onLayoutChange: (layout: FigureExportLayout | undefined) => void;
}) {
  const { t } = useTranslation();
  const { prepared, settings } = content;
  const hostRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: "legend" | "crystalAxes"; x: number; y: number; scale: number; layout: FigureExportLayout } | null>(null);
  const [hostSize, setHostSize] = useState({ width: 640, height: 480 });
  const [dragBounds, setDragBounds] = useState<RasterExportBounds | null>(null);
  const [layoutError, setLayoutError] = useState(false);
  const blobs = useMemo(() => prepared.layers.map(layer => layer.previewBlob ?? layer.image.blob), [prepared]);
  const urls = useBlobUrls(blobs);
  const rendered = layoutCombinedExport(prepared, layout);
  const displayBounds = dragBounds ?? rendered.bounds;
  const margins = currentFigureExportMargins(prepared, layout);
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

  function commitLayout(next: FigureExportLayout | undefined) {
    try {
      const { bounds } = layoutCombinedExport(prepared, next);
      assertExportCanvasSize(bounds.width, bounds.height, "combined");
      setLayoutError(false);
      onLayoutChange(next);
    } catch {
      setLayoutError(true);
    }
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, id: "legend" | "crystalAxes") {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const board = boardRef.current;
    if (!board) return;
    dragRef.current = { id, x: event.clientX, y: event.clientY,
      scale: board.getBoundingClientRect().width / rendered.bounds.width,
      layout: layout ?? defaultFigureExportLayout() };
    // Hold framing while dragging so automatic tight bounds cannot move the target.
    setDragBounds(rendered.bounds);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const origin = drag.layout[drag.id];
    commitLayout({ ...drag.layout, [drag.id]: {
      x: origin.x + (event.clientX - drag.x) / drag.scale / prepared.width,
      y: origin.y + (event.clientY - drag.y) / drag.scale / prepared.height,
    } });
  }

  function finishDrag() {
    dragRef.current = null;
    setDragBounds(null);
  }

  const componentLabel = (id: "legend" | "crystalAxes") => t(id === "legend" ? "exportPanel.legend" : "exportPanel.crystalAxes");
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
          const movable = layer.id === "legend" || layer.id === "crystalAxes" ? layer.id : null;
          return <div key={layer.id ?? index} style={position}>
            {urls[index] ? <img src={urls[index]} alt="" draggable={false} className="pointer-events-none size-full select-none" /> : null}
            {movable ? <button type="button"
              aria-label={t("figurePreview.moveComponent", { component: componentLabel(movable) })}
              data-preview-component={movable}
              className="absolute inset-0 touch-none cursor-grab rounded-sm border border-dashed border-sky-600/55 bg-transparent outline-none hover:border-sky-600 focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
              onPointerDown={event => startDrag(event, movable)} onPointerMove={moveDrag}
              onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
              onKeyDown={event => {
                const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
                if (!steps) return;
                event.preventDefault();
                const current = layout ?? defaultFigureExportLayout();
                const amount = event.shiftKey ? 10 : 1;
                commitLayout({ ...current, [movable]: { x: current[movable].x + steps[0]! * amount / prepared.width,
                  y: current[movable].y + steps[1]! * amount / prepared.height } });
              }} /> : null}
          </div>;
        })}
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t("figurePreview.margins")}</span>
        {(["top", "right", "bottom", "left"] as const).map(side => <label key={side} className="flex items-center gap-1.5">
          <span>{t(`figurePreview.${side}`)}</span>
          <Input type="number" min={0} step={0.5} className="h-8 w-17"
            aria-label={t("figurePreview.marginSide", { side: t(`figurePreview.${side}`) })}
            value={Math.round(margins[side] * 1000) / 10}
            onChange={event => {
              if (event.currentTarget.value.trim() === "") return;
              const value = Number(event.currentTarget.value);
              if (!Number.isFinite(value)) return;
              commitLayout({ ...(layout ?? defaultFigureExportLayout()), margins: { ...margins, [side]: Math.max(0, value) / 100 } });
            }} />
        </label>)}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">{rendered.bounds.width} × {rendered.bounds.height} px</span>
        <Button size="sm" variant="outline" onClick={() => commitLayout(undefined)}><RotateCcw className="size-3.5" />{t("figurePreview.reset")}</Button>
      </div>
    </div>
    {layoutError ? <p className="text-sm text-destructive" role="alert">{t("figurePreview.tooLarge")}</p> : null}
  </>;
}

function SeparatePreview({ content }: { content: Extract<FigurePreviewContent, { kind: "separate" }> }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(0);
  const blobs = useMemo(() => content.files.map(file => file.blob), [content]);
  const urls = useBlobUrls(blobs);
  const file = content.files[active];
  return <>
    {content.files.length > 1 ? <div className="flex flex-wrap gap-1" role="group" aria-label={t("figurePreview.files")}>
      {content.files.map((item, index) => <Button key={item.fileName} size="sm" variant={index === active ? "secondary" : "ghost"}
        aria-pressed={index === active} onClick={() => setActive(index)}>{item.fileName}</Button>)}
    </div> : null}
    <div className="flex h-[60dvh] min-h-52 items-center justify-center overflow-auto rounded-md border p-3" style={CHECKERBOARD_STYLE}>
      {file && urls[active] ? file.format === "pdf" ? <iframe title={file.fileName} src={urls[active]} className="size-full border-0" />
        : <img src={urls[active]} alt={file.fileName} className="max-h-full max-w-full object-contain" /> : null}
    </div>
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
