import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { useState } from "react";

import { FigurePreviewDialog } from "../src/app/controls/commonPanel/FigurePreviewDialog";
import { ExportTabContent } from "../src/app/controls/commonPanel/ExportTab";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { createDefaultExportSettings, type FigureExportLayout } from "../src/model";
import type { FigurePreviewContent } from "../src/export/figurePreview";
import { i18n } from "../src/i18n";

const content: FigurePreviewContent = { kind: "combined", settings: createDefaultExportSettings(), prepared: {
  width: 200, height: 160, layers: [
    { id: "structure", image: { blob: new Blob(["structure"]), width: 200, height: 160 }, textItems: [], x: 0, y: 0 },
    { id: "legend", image: { blob: new Blob(["legend"]), width: 100, height: 24 }, textItems: [], x: 50, y: 180 },
    { id: "crystalAxes", image: { blob: new Blob(["axes"]), width: 48, height: 48 }, textItems: [], x: -64, y: 120 },
  ],
} };

const labeledContent: Extract<FigurePreviewContent, { kind: "combined" }> = {
  kind: "combined", settings: createDefaultExportSettings(), prepared: {
    width: 200, height: 160, layers: [content.prepared.layers[0]!,
      { id: "measurement:distance", label: "2.500 Å", image: { blob: new Blob(["distance"]), width: 32, height: 8 }, textItems: [], x: 60, y: 20 },
      { id: "measurement:angle", label: "90.00°", image: { blob: new Blob(["angle"]), width: 40, height: 10 }, textItems: [], x: 110, y: 80 },
    ],
  },
};

describe("figure preview editing", () => {
  test("keeps cancellation available during export and hides completed progress when idle", () => {
    const cancel = mock(() => {});
    const exportFile = mock(() => {});
    const props = { error: null, settings: createDefaultExportSettings(), onSettingsChange: () => {},
      onExport: exportFile, onCancelExport: cancel,
      exportProgress: { phase: "rendering" as const, samples: 32, targetSamples: 192, elapsedMs: 4200 },
    };
    const { rerender } = render(<ExportTabContent {...props} isExporting />, { wrapper: TooltipProvider });
    expect((screen.getByRole("button", { name: i18n.t("actions.exportFormat", { format: "PNG" }) }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("progressbar", { name: i18n.t("rendering.sampleProgress") }).getAttribute("value")).toBe("32");
    const cancelButton = screen.getByRole("button", { name: i18n.t("rendering.cancelExport") }) as HTMLButtonElement;
    expect(cancelButton.disabled).toBe(false);
    fireEvent.click(cancelButton);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(exportFile).not.toHaveBeenCalled();
    rerender(<ExportTabContent {...props} isExporting={false} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("button", { name: i18n.t("rendering.cancelExport") })).toBeNull();
  });

  test("shows preview sampling progress while keeping cancel and close active", () => {
    const cancel = mock(() => {});
    const close = mock(() => {});
    const props = { open: true, loading: true, error: null, content: null,
      onLayoutChange: () => {}, onOpenChange: close, onCancelExport: cancel,
    };
    const { rerender } = render(<FigurePreviewDialog {...props}
      exportProgress={{ phase: "rendering", samples: 24, targetSamples: 64, elapsedMs: 3100 }} />);
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("24");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("rendering.cancelExport") }));
    expect(cancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("figurePreview.close") }));
    expect(close).toHaveBeenCalledWith(false);
    rerender(<FigurePreviewDialog {...props} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect((screen.getByRole("button", { name: i18n.t("rendering.cancelExport") }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("keeps accessory adjustments and margins after close, supports reset, and releases preview URLs", async () => {
    const createUrl = spyOn(URL, "createObjectURL").mockImplementation(() => "blob:preview-test");
    const revokeUrl = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      render(<PreviewHarness />);
      const legend = document.querySelector<HTMLButtonElement>('[data-preview-component="legend"]')!;
      const editingShortcut = mock(() => {});
      window.addEventListener("keydown", editingShortcut);
      fireEvent.keyDown(legend, { key: "Delete" });
      window.removeEventListener("keydown", editingShortcut);
      expect(editingShortcut).not.toHaveBeenCalled();
      fireEvent.keyDown(legend, { key: "ArrowRight", shiftKey: true });
      expect(readLayout().legend.x).toBe(0.05);
      expect(readLayout().crystalAxes.x).toBe(0);
      const margin = screen.getByRole("spinbutton", { name: i18n.t("figurePreview.marginSide", { side: i18n.t("figurePreview.top") }) });
      fireEvent.change(margin, { target: { value: "15" } });
      expect(readLayout().margins?.top).toBe(0.15);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("figurePreview.close") }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(readLayout().legend.x).toBe(0.05);
      expect(revokeUrl.mock.calls.length).toBe(3);
      fireEvent.click(screen.getByRole("button", { name: "Reopen preview" }));
      expect((screen.getByRole("spinbutton", { name: i18n.t("figurePreview.marginSide", { side: i18n.t("figurePreview.top") }) }) as HTMLInputElement).value).toBe("15");
      fireEvent.click(screen.getByRole("button", { name: i18n.t("figurePreview.reset") }));
      expect(screen.getByTestId("saved-preview-layout").textContent).toBe("null");
    } finally { createUrl.mockRestore(); revokeUrl.mockRestore(); }
  });

  test("converts pointer motion to export coordinates without moving the base structure", () => {
    const createUrl = spyOn(URL, "createObjectURL").mockImplementation(() => "blob:preview-test");
    const revokeUrl = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      render(<PreviewHarness />);
      const board = screen.getByTestId("figure-preview-image");
      board.getBoundingClientRect = () => ({ width: 264, height: 204 } as DOMRect);
      const axes = document.querySelector<HTMLButtonElement>('[data-preview-component="crystalAxes"]')!;
      axes.setPointerCapture = () => {};
      fireEvent.pointerDown(axes, { button: 0, pointerId: 1, clientX: 40, clientY: 80 });
      fireEvent.pointerMove(axes, { pointerId: 1, clientX: 80, clientY: 64 });
      fireEvent.pointerUp(axes, { pointerId: 1, clientX: 80, clientY: 64 });
      expect(readLayout().crystalAxes).toEqual({ x: 0.2, y: -0.1 });
      expect(readLayout().legend).toEqual({ x: 0, y: 0 });
      expect(content.prepared.layers[0]!.x).toBe(0);
      expect(content.prepared.layers[0]!.y).toBe(0);
    } finally { createUrl.mockRestore(); revokeUrl.mockRestore(); }
  });

  test("drags and nudges only the selected text without rebuilding raster URLs, and retains it after reopening", async () => {
    const createUrl = spyOn(URL, "createObjectURL").mockImplementation(() => "blob:label-test");
    const revokeUrl = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      render(<PreviewHarness previewContent={labeledContent} />);
      const board = screen.getByTestId("figure-preview-image");
      board.getBoundingClientRect = () => ({ width: 200, height: 160 } as DOMRect);
      const label = screen.getByRole("button", { name: i18n.t("figurePreview.moveMeasurement", { label: "2.500 Å" }) });
      label.setPointerCapture = () => {};
      fireEvent.pointerDown(label, { button: 0, pointerId: 4, clientX: 60, clientY: 20 });
      fireEvent.pointerMove(label, { pointerId: 99, clientX: 80, clientY: 4 });
      expect(screen.getByTestId("saved-preview-layout").textContent).toBe("null");
      fireEvent.pointerMove(label, { pointerId: 4, clientX: 80, clientY: 4 });
      fireEvent.pointerUp(label, { pointerId: 4 });
      expect(readLayout().measurementLabels).toEqual({ distance: { x: 0.1, y: -0.1 } });
      fireEvent.keyDown(label, { key: "ArrowDown", shiftKey: true });
      expect(readLayout().measurementLabels!.distance!.y).toBeCloseTo(-0.0375, 12);
      expect(readLayout().legend).toEqual({ x: 0, y: 0 });
      expect(labeledContent.prepared.layers.map(layer => [layer.x, layer.y])).toEqual([[0, 0], [60, 20], [110, 80]]);
      expect(createUrl).toHaveBeenCalledTimes(3);
      expect(label.style.minHeight).toBe("24px");
      const editingShortcut = mock(() => {});
      window.addEventListener("keydown", editingShortcut);
      fireEvent.keyDown(label, { key: "Delete" });
      window.removeEventListener("keydown", editingShortcut);
      expect(editingShortcut).not.toHaveBeenCalled();
      const saved = readLayout();
      fireEvent.click(screen.getByRole("button", { name: i18n.t("figurePreview.close") }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(revokeUrl).toHaveBeenCalledTimes(3);
      fireEvent.click(screen.getByRole("button", { name: "Reopen preview" }));
      expect(readLayout()).toEqual(saved);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("figurePreview.reset") }));
      expect(screen.getByTestId("saved-preview-layout").textContent).toBe("null");
    } finally { createUrl.mockRestore(); revokeUrl.mockRestore(); }
  });

  test("separate PDF structure preview edits text while retaining combined accessory layout and margins", () => {
    const createUrl = spyOn(URL, "createObjectURL").mockImplementation(() => "blob:label-test");
    const revokeUrl = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const initialLayout = { legend: { x: .3, y: .2 }, crystalAxes: { x: -.1, y: .1 },
      margins: { top: .2, right: .1, bottom: .1, left: .1 }, measurementLabels: { distance: { x: .1, y: .2 } } };
    try {
      render(<PreviewHarness initialLayout={initialLayout} previewContent={{ kind: "separate",
        files: [{ fileName: "legend.png", blob: new Blob(["legend"]), format: "png" }],
        structure: { fileName: "structure.pdf", prepared: labeledContent.prepared,
          settings: { ...labeledContent.settings, combineComponents: false, format: "pdf" } },
      }} />);
      expect(document.querySelector("iframe")).toBeNull();
      const label = screen.getByRole("button", { name: i18n.t("figurePreview.moveMeasurement", { label: "90.00°" }) });
      fireEvent.keyDown(label, { key: "ArrowRight", shiftKey: true });
      expect(readLayout().measurementLabels!.angle).toEqual({ x: .05, y: 0 });
      expect(readLayout().measurementLabels!.distance).toEqual(initialLayout.measurementLabels.distance);
      expect(readLayout().legend).toEqual(initialLayout.legend);
      expect(readLayout().margins).toEqual(initialLayout.margins);
      expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("figurePreview.resetLabels") }));
      expect(readLayout().measurementLabels).toBeUndefined();
      expect(readLayout().margins).toEqual(initialLayout.margins);
      fireEvent.click(screen.getByRole("button", { name: "legend.png" }));
      expect(screen.queryByTestId("figure-preview-image")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "structure.pdf" }));
      expect(screen.getByRole("button", { name: i18n.t("figurePreview.moveMeasurement", { label: "90.00°" }) })).toBeTruthy();
    } finally { createUrl.mockRestore(); revokeUrl.mockRestore(); }
  });
});

function PreviewHarness({ previewContent = content, initialLayout }: { previewContent?: FigurePreviewContent; initialLayout?: FigureExportLayout }) {
  const [open, setOpen] = useState(true);
  const [layout, setLayout] = useState<FigureExportLayout | undefined>(initialLayout);
  return <>
    <button onClick={() => setOpen(true)}>Reopen preview</button>
    <output data-testid="saved-preview-layout">{JSON.stringify(layout ?? null)}</output>
    <FigurePreviewDialog open={open} loading={false} error={null} content={previewContent} layout={layout}
      onLayoutChange={setLayout} onOpenChange={setOpen} />
  </>;
}

function readLayout(): FigureExportLayout {
  return JSON.parse(screen.getByTestId("saved-preview-layout").textContent!);
}
