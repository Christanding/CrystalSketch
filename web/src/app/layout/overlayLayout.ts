import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type RefObject } from "react";

import type { PreviewSafeArea } from "../../model/layout";
import { BOTTOM_CONTROLS_BREAKPOINT_PX } from "../../model/layout";

const MAX_ORIENTATION_GIZMO_SIZE_PX = 280;
const MIN_ORIENTATION_GIZMO_SIZE_PX = 160;
const ORIENTATION_GIZMO_AVAILABLE_SIDE_RATIO = 0.35;

export interface ViewportSize {
  height: number;
  width: number;
}

export function orientationGizmoContainerStyle(
  safeArea: PreviewSafeArea,
  size: number,
  compact = false,
): CSSProperties {
  return {
    bottom: compact ? safeArea.bottom + 4 : Math.max(16, safeArea.bottom - 100),
    height: size,
    left: compact ? safeArea.left + 4 : Math.max(16, safeArea.left - 78),
    width: size,
  };
}

export function orientationGizmoSizeForViewport(
  viewportSize: ViewportSize,
  safeArea: PreviewSafeArea,
  compact = false,
): number {
  const availableWidth = Math.max(1, viewportSize.width - safeArea.left - safeArea.right);
  const availableHeight = Math.max(1, viewportSize.height - safeArea.top - safeArea.bottom);

  if (compact) return Math.max(1, Math.min(96, Math.max(64, Math.min(availableWidth, availableHeight) * 0.28), availableWidth - 8, availableHeight - 8));

  return Math.max(
    MIN_ORIENTATION_GIZMO_SIZE_PX,
    Math.min(
      Math.min(availableWidth, availableHeight) * ORIENTATION_GIZMO_AVAILABLE_SIDE_RATIO,
      MAX_ORIENTATION_GIZMO_SIZE_PX,
    ),
  );
}

export interface OverlayBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function previewLayoutForPanels(viewport: ViewportSize, panels: {
  left?: OverlayBounds | null;
  right?: OverlayBounds | null;
  tabs?: OverlayBounds | null;
  reopen?: OverlayBounds | null;
  inspection?: OverlayBounds | null;
}) {
  const availableArea: PreviewSafeArea = { left: 12, right: 12, top: 56, bottom: 8 };
  for (const header of [panels.tabs, panels.reopen]) {
    if (header) availableArea.top = Math.max(availableArea.top, header.top + header.height + 8);
  }
  if (viewport.width <= BOTTOM_CONTROLS_BREAKPOINT_PX) {
    for (const panel of [panels.left, panels.right]) {
      if (panel) availableArea.bottom = Math.max(availableArea.bottom, viewport.height - panel.top + 8);
    }
  } else {
    if (panels.left) availableArea.left = Math.max(availableArea.left, panels.left.left + panels.left.width + 8);
    if (panels.right) availableArea.right = Math.max(availableArea.right, viewport.width - panels.right.left + 8);
  }
  // CSS keeps panels below half-height; this also bounds the initial unmeasured frame.
  availableArea.left = Math.min(availableArea.left, Math.max(0, viewport.width - 64));
  availableArea.right = Math.min(availableArea.right, Math.max(0, viewport.width - availableArea.left - 64));
  availableArea.top = Math.min(availableArea.top, Math.max(0, viewport.height - 64));
  availableArea.bottom = Math.min(availableArea.bottom, Math.max(0, viewport.height - availableArea.top - 64));
  const top = Math.min(Math.max(availableArea.top, panels.inspection ? panels.inspection.top + panels.inspection.height + 8 : 0), Math.max(availableArea.top, viewport.height - availableArea.bottom - 40));
  const freeHeight = viewport.height - top - availableArea.bottom;
  const footer = Math.min(64, Math.max(44, freeHeight * 0.18), Math.max(0, freeHeight - 40));
  const safeArea = { ...availableArea, top, bottom: availableArea.bottom + footer };
  return { availableArea, safeArea };
}

export function compactLegendStyle(viewport: ViewportSize, availableArea: PreviewSafeArea, gizmoSize: number): CSSProperties {
  const start = availableArea.left + gizmoSize + 12;
  const width = Math.max(1, viewport.width - start - availableArea.right - 4);
  return { bottom: availableArea.bottom + 8, left: start + width / 2, maxWidth: width };
}

export function compactInspectionStyle(viewport: ViewportSize, availableArea: PreviewSafeArea): CSSProperties {
  return {
    "--compact-inspection-left": `${availableArea.left}px`,
    "--compact-inspection-right": `${availableArea.right}px`,
    "--compact-inspection-top": `${availableArea.top}px`,
    "--compact-inspection-height": `${Math.max(48, Math.min(140, (viewport.height - availableArea.top - availableArea.bottom) * 0.28))}px`,
  } as CSSProperties;
}

export function useMeasuredPreviewLayout({ enabled, viewport, editorRef, controlsHost, leftOpen, rightOpen, hasScene, hasInspection = false }: {
  enabled: boolean;
  viewport: ViewportSize;
  editorRef: RefObject<HTMLElement | null>;
  controlsHost: HTMLElement | null;
  leftOpen: boolean;
  rightOpen: boolean;
  hasScene: boolean;
  hasInspection?: boolean;
}) {
  const fallback = useMemo(() => {
    const bottomDock = viewport.width <= BOTTOM_CONTROLS_BREAKPOINT_PX;
    const height = bottomDock ? viewport.height * 0.46 : viewport.height;
    return previewLayoutForPanels(viewport, {
      left: leftOpen && !rightOpen ? { left: 0, top: viewport.height - height, width: Math.min(320, viewport.width), height } : null,
      right: rightOpen ? { left: Math.max(0, viewport.width - 360), top: viewport.height - height, width: Math.min(360, viewport.width), height } : null,
      reopen: !leftOpen ? { left: 16, top: 16, width: 56, height: 56 } : null,
    });
  }, [leftOpen, rightOpen, viewport.height, viewport.width]);
  const [measurement, setMeasurement] = useState<{ key: string; layout: typeof fallback } | null>(null);
  const key = `${viewport.width}:${viewport.height}:${leftOpen}:${rightOpen}:${hasScene}:${hasInspection}`;

  useLayoutEffect(() => {
    if (!enabled || !controlsHost || !editorRef.current) return;
    const editor = editorRef.current;
    const left = controlsHost.querySelector<HTMLElement>("#left-controls-sidebar");
    const right = controlsHost.querySelector<HTMLElement>("#inspector-sidebar");
    const tabs = editor.closest(".document-workspace")?.querySelector<HTMLElement>(".document-top-dock") ?? null;
    const reopen = controlsHost.querySelector<HTMLElement>('[aria-controls="left-controls-sidebar"][aria-expanded="false"]');
    const inspection = hasInspection ? controlsHost.querySelector<HTMLElement>(".document-inspection > aside") : null;
    let frame = 0;
    function measure() {
      const origin = editor.getBoundingClientRect();
      const bounds = (element: HTMLElement | null): OverlayBounds | null => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height };
      };
      const leftBounds = leftOpen && !rightOpen ? bounds(left) : null;
      const rightBounds = rightOpen ? bounds(right) : null;
      // Ignore the sideways open/close animation when reserving a panel's final footprint.
      if (leftBounds) leftBounds.left = 0;
      if (rightBounds) rightBounds.left = viewport.width - rightBounds.width;
      const layout = previewLayoutForPanels(viewport, { left: leftBounds, right: rightBounds, tabs: bounds(tabs), reopen: !leftOpen ? bounds(reopen) : null, inspection: bounds(inspection) });
      setMeasurement(current => current?.key === key && JSON.stringify(current.layout) === JSON.stringify(layout) ? current : { key, layout });
    }
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    for (const element of [editor, left, left?.firstElementChild, right, tabs, reopen, inspection]) if (element) observer?.observe(element);
    controlsHost.addEventListener("transitionend", schedule, true);
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      observer?.disconnect();
      controlsHost.removeEventListener("transitionend", schedule, true);
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [controlsHost, editorRef, enabled, hasInspection, hasScene, key, leftOpen, rightOpen, viewport.height, viewport.width]);
  return measurement?.key === key ? measurement.layout : fallback;
}

export function useViewportSize(): ViewportSize {
  const [viewportSize, setViewportSize] = useState(getViewportSize);

  useEffect(() => {
    function handleResize() {
      setViewportSize(getViewportSize());
    }

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return viewportSize;
}

function getViewportSize(): ViewportSize {
  return {
    height: window.innerHeight,
    width: window.innerWidth,
  };
}
