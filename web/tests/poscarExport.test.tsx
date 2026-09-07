import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, spyOn, test } from "bun:test";
import { parseVaspScene, parseVaspStructure } from "../src/api/vasp";
import { PoscarExportPanel } from "../src/app/controls/commonPanel/PoscarExportPanel";
import { useSceneEdits } from "../src/app/hooks/useSceneEdits";
import { usePoscarExportController } from "../src/app/hooks/usePoscarExportController";
import { createPoscar, PoscarExportError, preparePoscar, validatePoscarText, type PoscarErrorCode } from "../src/export/poscarExport";
import { i18n } from "../src/i18n";
import { applyModelOperation, createModelState, modelToScene } from "../src/model/structureModel";

const input = `CuI export test
1.0
6 0 0
0 6 0
0 0 6
Cu I
2 1
Selective dynamics
Direct
-0.00000001 0 1.25 F T F
0.5 0.5 0 T T T
0.25 0.25 0.25 T F T
`;
const source = () => ({ file: new File([input], "POSCAR"), fileName: "POSCAR", scene: parseVaspScene(input), deletedAtomIds: [] as string[] });
afterEach(cleanup);

test("POSCAR uses original coordinates and constraints, not wrapped/duplicated or hidden render atoms", async () => {
  const data = source();
  const preview = await preparePoscar(data);
  expect(data.scene.atoms.length).toBeGreaterThan(3);
  expect(data.scene.atoms.find(atom => atom.siteId === "Cu-0")!.fractionalPosition[0]).toBeGreaterThan(.99);
  expect(preview.atomCount).toBe(3);
  expect(preview.counts).toEqual([2, 1]);
  const reread = parseVaspStructure(preview.text);
  expect(reread).toEqual(parseVaspStructure(input));
});

test("exact deletions map once per site, bond deletions do not remove atoms, and undo restores export", () => {
  const data = source();
  const { result } = renderHook(() => useSceneEdits(data.scene, 0));
  const image = data.scene.atoms.find(atom => atom.isPeriodicImage && atom.siteId === "Cu-0")!;
  const exportCurrent = () => createPoscar(parseVaspStructure(input), data.scene, result.current.snapshot.deleted.atoms);
  act(() => result.current.deleteObjects({ atoms: new Set([image.id, "Cu-0"]), bonds: new Set() }));
  expect(exportCurrent().counts).toEqual([1, 1]);
  expect(exportCurrent().removedCount).toBe(1);
  expect(exportCurrent().removedPeriodicSites).toBe(true);
  act(() => result.current.undoDeletion());
  expect(exportCurrent().counts).toEqual([2, 1]);
  act(() => result.current.deleteObjects({ atoms: new Set(), bonds: new Set([data.scene.bonds[0]!.id]) }));
  expect(exportCurrent().atomCount).toBe(3);
});

test("removing the last atom of a species updates both the species header and counts", () => {
  const result = createPoscar(parseVaspStructure(input), source().scene, ["I-2"]);
  expect(result.species).toEqual(["Cu"]);
  expect(result.counts).toEqual([2]);
  expect(parseVaspStructure(result.text).sites).toHaveLength(2);
});

test.each([
  ["2", "Cartesian", "0.25 0.5 0.75", [[4, 0, 0], [2, 6, 0], [0, 0, 8]], [1 / 24, 1 / 6, 3 / 16]],
  ["-192", "Direct", ".1 .2 .3", [[4, 0, 0], [2, 6, 0], [0, 0, 8]], [.1, .2, .3]],
  ["2 3 4", "Cartesian", "0.25 0.5 0.75", [[4, 0, 0], [2, 9, 0], [0, 0, 16]], [1 / 24, 1 / 6, 3 / 16]],
] as [string, string, string, [number, number, number][], number[]][])("normalizes scale %s and %s with a skew cell", (scale, mode, coords, lattice, fractional) => {
  const file = `scaled\n${scale}\n2 0 0\n1 3 0\n0 0 4\nSi\n1\n${mode}\n${coords}\n`;
  const raw = parseVaspStructure(file);
  expect(raw.cell.vectors).toEqual(lattice);
  fractional.forEach((value, index) => expect(raw.sites[0]!.fractionalPosition[index]).toBeCloseTo(value, 14));
  const output = createPoscar(raw, parseVaspScene(file), []);
  expect(output.text.split("\n")[1]).toBe("1.0");
  expect(parseVaspStructure(output.text).cell.vectors).toEqual(lattice);
});

test("preserves repeated VASP species groups and accepts an empty title", () => {
  const file = "\n1\n8 0 0\n0 8 0\n0 0 8\nFe O Fe\n1 1 1\nDirect\n0 0 0\n.2 .2 .2\n.5 .5 .5\n";
  const output = createPoscar(parseVaspStructure(file), parseVaspScene(file), []);
  expect(output.species).toEqual(["Fe", "O", "Fe"]);
  expect(output.counts).toEqual([1, 1, 1]);
});

test("rejects empty structures, uncertain elements, invalid coordinates/cells and unmapped deletions", () => {
  const data = source(), raw = parseVaspStructure(input);
  const check = (run: () => unknown, code: PoscarErrorCode) => {
    try { run(); throw new Error("expected export failure"); }
    catch (error) { expect(error).toBeInstanceOf(PoscarExportError); expect((error as PoscarExportError).code).toBe(code); }
  };
  check(() => createPoscar(raw, data.scene, raw.sites.map(site => site.siteId)), "emptyStructure");
  check(() => createPoscar({ ...raw, species: ["X1", "I"] }, data.scene, []), "unknownElement");
  check(() => createPoscar({ ...raw, cell: { vectors: [[0, 0, 0], [0, 1, 0], [0, 0, 1]] } }, data.scene, []), "invalidCell");
  check(() => createPoscar({ ...raw, sites: raw.sites.map((site, i) => i ? site : { ...site, fractionalPosition: [NaN, 0, 0] }) }, data.scene, []), "invalidCoordinates");
  check(() => createPoscar(raw, data.scene, ["Si-100"]), "unmatchedDeletion");
  expect(() => parseVaspStructure(input.replace("F T F", "F T"))).toThrow("T/F");
});

test("preview and downloaded bytes are identical, including the no-extension POSCAR filename", async () => {
  await i18n.changeLanguage("zh-CN");
  const createUrl = spyOn(URL, "createObjectURL").mockReturnValue("blob:poscar-test");
  const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe("POSCAR");
  });
  try {
    const data = source();
    function Harness() { const controller = usePoscarExportController(data); return <PoscarExportPanel controller={controller} fileName="POSCAR" />; }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "预览 POSCAR" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    const text = (screen.getByLabelText("POSCAR 文件内容") as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "导出 POSCAR" }));
    await waitFor(() => expect(createUrl).toHaveBeenCalled());
    const blob = createUrl.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("application/octet-stream");
    expect(await blob.text()).toBe(text);
    expect(text).toBe(createPoscar(parseVaspStructure(input), source().scene, [], "POSCAR").text);
  } finally { createUrl.mockRestore(); revoke.mockRestore(); click.mockRestore(); }
});

test("edited POSCAR persists after closing; malformed edits block export with a line diagnostic", async () => {
  const data = source();
  const { result } = renderHook(() => usePoscarExportController(data));
  await act(async () => { await result.current.preview(); });
  const original = result.current.draft!;
  act(() => result.current.changeDraft(original.replace("2  1", "20  1")));
  act(() => result.current.changeOpen(false));
  expect(result.current.error).toMatch(/行|Line/);
  const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    await act(async () => { await result.current.exportFile(); });
    expect(click).not.toHaveBeenCalled();
    expect(result.current.open).toBe(true);
    act(() => result.current.changeDraft(original.replace("-0.0000000100000000", "0.1250000000000000")));
    act(() => result.current.changeOpen(false));
    expect(result.current.error).toBeNull();
    expect(validatePoscarText(result.current.draft!).atomCount).toBe(3);
    await act(async () => { await result.current.preview(); });
    expect(result.current.draft).toContain("0.1250000000000000");
  } finally { click.mockRestore(); }
});

test("strict text validation rejects extra lines, hex numbers, missing flags and invalid species", () => {
  const original = createPoscar(parseVaspStructure(input), source().scene, []).text;
  expect(validatePoscarText(original).atomCount).toBe(3);
  expect(() => validatePoscarText(original + "0 0 0\n")).toThrow("rows");
  expect(() => validatePoscarText(original.replace("1.0", "0x2"))).toThrow("scale");
  expect(() => validatePoscarText(original.replace("F T F", "F T"))).toThrow("coordinates");
  expect(() => validatePoscarText(original.replace("Cu  I", "Xx  I"))).toThrow("species");
});

test("edited POSCAR survives a model revision but cannot download until explicitly regenerated", async () => {
  const data = source();
  const original = createModelState(parseVaspStructure(input));
  const removed = applyModelOperation(original, { type: "vacancy", siteIds: [original.structure.sites[1]!.siteId] }).state;
  const first = { ...data, scene: modelToScene(original), model: { structure: original.structure, revision: 0 } };
  const next = { ...data, scene: modelToScene(removed), model: { structure: removed.structure, revision: 1 } };
  const createUrl = spyOn(URL, "createObjectURL").mockReturnValue("blob:revision-poscar");
  const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const { result, rerender, unmount } = renderHook(({ current }) => usePoscarExportController(current), { initialProps: { current: first } });
  try {
    await act(async () => { await result.current.preview(); });
    const edited = result.current.draft!.replace("POSCAR", "Edited by user");
    act(() => { result.current.changeDraft(edited); result.current.changeOpen(false); });
    rerender({ current: next });
    expect(result.current.draft).toBe(edited);
    expect(result.current.stale).toBe(true);
    expect(result.current.snapshot).toEqual({ text: edited, baseModelRevision: 0, modified: true });
    await act(async () => { await result.current.exportFile(); });
    expect(click).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
    expect(result.current.error).toBe(i18n.t("modeling.staleDraft"));
    await act(async () => { await result.current.regenerate(); });
    expect(result.current.stale).toBe(false);
    expect(result.current.modified).toBe(false);
    expect(validatePoscarText(result.current.draft!).atomCount).toBe(2);
    await act(async () => { await result.current.exportFile(); });
    expect(click).toHaveBeenCalledTimes(1);
    const downloaded = createUrl.mock.calls[0]![0] as Blob;
    expect(await downloaded.text()).toBe(result.current.draft!);
  } finally { unmount(); createUrl.mockRestore(); revoke.mockRestore(); click.mockRestore(); }
});
