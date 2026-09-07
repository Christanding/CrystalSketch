import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { useState } from "react";

import { FigurePreviewDialog } from "../src/app/controls/commonPanel/FigurePreviewDialog";
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

describe("figure preview editing", () => {
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
});

function PreviewHarness() {
  const [open, setOpen] = useState(true);
  const [layout, setLayout] = useState<FigureExportLayout>();
  return <>
    <button onClick={() => setOpen(true)}>Reopen preview</button>
    <output data-testid="saved-preview-layout">{JSON.stringify(layout ?? null)}</output>
    <FigurePreviewDialog open={open} loading={false} error={null} content={content} layout={layout}
      onLayoutChange={setLayout} onOpenChange={setOpen} />
  </>;
}

function readLayout(): FigureExportLayout {
  return JSON.parse(screen.getByTestId("saved-preview-layout").textContent!);
}
