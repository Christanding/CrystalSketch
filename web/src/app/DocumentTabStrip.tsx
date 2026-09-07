import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function DocumentTabStrip({ documents, activeId, onSelect, onRename, onClose }: {
  documents: { id: string; title: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRename: (document: { id: string; title: string }) => void;
  onClose: (id: string) => void;
}) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const next = { left: element.scrollLeft > 1, right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1 };
    setEdges(previous => previous.left === next.left && previous.right === next.right ? previous : next);
  }, []);
  const revealActive = useCallback(() => {
    const element = viewport.current;
    const selected = element?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!element || !selected) return;
    const bounds = element.getBoundingClientRect(), item = selected.parentElement!.getBoundingClientRect();
    if (item.left < bounds.left) element.scrollLeft -= bounds.left - item.left;
    else if (item.right > bounds.right) element.scrollLeft += item.right - bounds.right;
  }, []);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || element.scrollWidth <= element.clientWidth) return;
      event.preventDefault();
      element.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { revealActive(); updateEdges(); });
    observer?.observe(element);
    if (track.current) observer?.observe(track.current);
    updateEdges();
    return () => { observer?.disconnect(); element.removeEventListener("wheel", onWheel); };
  }, [revealActive, updateEdges]);
  useLayoutEffect(() => {
    revealActive();
    updateEdges();
  }, [activeId, documents, revealActive, updateEdges]);
  const scroll = (direction: number) => {
    if (viewport.current) viewport.current.scrollLeft += direction * viewport.current.clientWidth * 0.75;
  };
  const overflowing = edges.left || edges.right;
  return <div className="flex min-w-0 flex-1 items-center gap-1">
    {overflowing ? <Button size="icon" variant="ghost" className="size-6 shrink-0" disabled={!edges.left}
      aria-label={t("documents.scrollLeft")} onClick={() => scroll(-1)}><ChevronLeft className="size-3.5" /></Button> : null}
    <div ref={viewport} role="tablist" aria-label={t("documents.tabs")} onScroll={updateEdges}
      className="document-tabs-scroll min-w-0 flex-1 overflow-x-auto overscroll-x-contain">
      <div ref={track} className="flex w-max min-w-full items-center gap-1">
        {documents.map((doc, index) => <div key={doc.id} className={cn("group flex h-8 shrink-0 items-center rounded-md border text-sm",
          doc.id === activeId ? "border-border bg-muted" : "border-transparent bg-card/80 hover:bg-muted/60")}>
          <button role="tab" aria-selected={doc.id === activeId} tabIndex={doc.id === activeId ? 0 : -1} title={doc.title}
            className="max-w-48 truncate px-3 py-1 outline-offset-[-2px]" onClick={() => onSelect(doc.id)} onDoubleClick={() => onRename(doc)}
            onKeyDown={event => {
              const next = event.key === "ArrowRight" ? (index + 1) % documents.length : event.key === "ArrowLeft" ? (index - 1 + documents.length) % documents.length
                : event.key === "Home" ? 0 : event.key === "End" ? documents.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              onSelect(documents[next]!.id);
              viewport.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
            }}>{doc.title}</button>
          <button title={t("documents.rename")} aria-label={`${t("documents.rename")} ${doc.title}`} className="p-1 text-muted-foreground hover:text-foreground" onClick={() => onRename(doc)}><Pencil size={12} /></button>
          <button title={t("documents.close")} aria-label={`${t("documents.close")} ${doc.title}`} className="mr-1 p-1 text-muted-foreground hover:text-foreground" onClick={() => onClose(doc.id)}><X size={14} /></button>
        </div>)}
      </div>
    </div>
    {overflowing ? <Button size="icon" variant="ghost" className="size-6 shrink-0" disabled={!edges.right}
      aria-label={t("documents.scrollRight")} onClick={() => scroll(1)}><ChevronRight className="size-3.5" /></Button> : null}
  </div>;
}
