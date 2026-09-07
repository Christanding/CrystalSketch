import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { useState } from "react";

import { ModelingPanel, type ModelingPanelController } from "../src/app/inspector/ModelingPanel";
import { PeriodicTablePicker } from "../src/app/inspector/PeriodicTablePicker";
import { useModelingController } from "../src/app/hooks/useModelingController";
import { useSceneEdits } from "../src/app/hooks/useSceneEdits";
import { useStructurePreview, type LoadedPreviewSession } from "../src/app/hooks/useStructurePreview";
import { PERIODIC_TABLE_ELEMENTS, PERIODIC_ELEMENT_SYMBOLS, filterPeriodicElements, findPeriodicElement } from "../src/data/periodic-table";
import { elementRadiusSymbols } from "../src/model/elementRadii";
import { applyModelOperation, createModelState, modelToScene, type ModelOperation, type ModelState } from "../src/model/structureModel";
import { i18n } from "../src/i18n";

describe("periodic table", () => {
  test("covers 118 unique numbered elements, preserves known registry symbols and standard grid positions", () => {
    expect(PERIODIC_TABLE_ELEMENTS).toHaveLength(118);
    expect(new Set(PERIODIC_ELEMENT_SYMBOLS).size).toBe(118);
    expect(PERIODIC_TABLE_ELEMENTS.map(element => element.atomicNumber)).toEqual(Array.from({ length: 118 }, (_, i) => i + 1));
    expect(new Set(PERIODIC_TABLE_ELEMENTS.map(element => `${element.row}:${element.column}`)).size).toBe(118);
    expect(elementRadiusSymbols().filter(symbol => !["D", "XX"].includes(symbol)).every(symbol => findPeriodicElement(symbol))).toBe(true);
    expect(PERIODIC_TABLE_ELEMENTS.every(element => element.nameEn && element.nameZh && element.column >= 1 && element.column <= 18)).toBe(true);
    expect(findPeriodicElement("He")).toMatchObject({ row: 1, column: 18, atomicNumber: 2 });
    expect(findPeriodicElement("Cu")).toMatchObject({ row: 4, column: 11, atomicNumber: 29, nameEn: "Copper", nameZh: "铜" });
    expect(findPeriodicElement("Og")).toMatchObject({ row: 7, column: 18, atomicNumber: 118 });
    expect(PERIODIC_TABLE_ELEMENTS.filter(element => element.row === 9)).toHaveLength(15);
    expect(PERIODIC_TABLE_ELEMENTS.filter(element => element.row === 10)).toHaveLength(15);
    expect(filterPeriodicElements("cu").map(element => element.symbol)).toEqual(["Cu"]);
    expect(filterPeriodicElements("29").map(element => element.symbol)).toEqual(["Cu"]);
    expect(filterPeriodicElements("铜").map(element => element.symbol)).toEqual(["Cu"]);
    expect(filterPeriodicElements("ogan").map(element => element.symbol)).toEqual(["Og"]);
  });

  test("opens a complete table, navigates by keyboard and returns only the explicitly chosen element", async () => {
    const user = userEvent.setup();
    const onChange = mock(() => {});
    render(<PeriodicTablePicker value="Cu" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: i18n.t("periodicTable.choose") }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("button").filter(button => /^\d+ /.test(button.getAttribute("aria-label") ?? ""))).toHaveLength(118);
    const copper = within(dialog).getByRole("button", { name: "29 Cu 铜 Copper" });
    copper.focus();
    fireEvent.keyDown(copper, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("30 Zn 锌 Zinc");
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("Zn");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("searches by atomic number and cancels with Escape without changing the selected element", async () => {
    const user = userEvent.setup();
    const onChange = mock(() => {});
    render(<PeriodicTablePicker value="Cu" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: i18n.t("periodicTable.choose") }));
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("periodicTable.search") }), { target: { value: "118" } });
    expect(screen.getByRole("button", { name: "118 Og 鿫 Oganesson" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "29 Cu 铜 Copper" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("modeling panel transactions", () => {
  test("keeps legacy data read-only until the modeling-copy action is chosen", () => {
    const create = mock(() => {});
    render(<ModelingPanel controller={{ ...controllerDefaults(), model: null, onCreateModel: create }} />);
    expect(screen.queryByRole("button", { name: i18n.t("modeling.vacancy") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.createCopy") }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("choosing an element edits only the form, then preview/apply commits one substitution", async () => {
    const user = userEvent.setup();
    render(<ModelingHarness />);
    const selected = selectedSection();
    await user.click(within(selected).getByRole("button", { name: i18n.t("modeling.element") }));
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("periodicTable.search") }), { target: { value: "Zn" } });
    await user.click(screen.getByRole("button", { name: "30 Zn 锌 Zinc" }));
    expect(readModel().structure.species[readModel().structure.sites[0]!.speciesIndex]).toBe("Cu");
    expect(screen.getByTestId("applied-count").textContent).toBe("0");
    fireEvent.click(within(selectedSection()).getByRole("button", { name: i18n.t("modeling.substitute") }));
    expect(readOperation()).toEqual({ type: "substitute", siteIds: ["site-a"], element: "Zn" });
    expect(readModel().structure.species[readModel().structure.sites[0]!.speciesIndex]).toBe("Cu");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.apply") }));
    expect(readModel().structure.species[readModel().structure.sites[0]!.speciesIndex]).toBe("Zn");
    expect(screen.getByTestId("applied-count").textContent).toBe("1");
    expect(readModel().defects[0]!.kind).toBe("substitution");
  });

  test("cancels vacancy preview with Escape and does not consume Cmd/Ctrl+Z", () => {
    render(<ModelingHarness />);
    const vacancy = within(selectedSection()).getByRole("button", { name: i18n.t("modeling.vacancy") });
    const historyKey = mock((event: KeyboardEvent) => event.defaultPrevented);
    window.addEventListener("keydown", historyKey);
    fireEvent.keyDown(vacancy, { key: "z", metaKey: true });
    window.removeEventListener("keydown", historyKey);
    expect(historyKey).toHaveBeenCalledTimes(1);
    expect(historyKey.mock.results[0]!.value).toBe(false);
    fireEvent.click(vacancy);
    expect(readModel().structure.sites).toHaveLength(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("button", { name: i18n.t("modeling.apply") })).toBeNull();
    expect(readModel().structure.sites).toHaveLength(2);
    expect(screen.getByTestId("applied-count").textContent).toBe("0");
    fireEvent.click(within(selectedSection()).getByRole("button", { name: i18n.t("modeling.vacancy") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.apply") }));
    const vacancyLabel = `${i18n.t("modeling.vacancy")} · Cu #1`;
    expect(screen.getByRole("button", { name: i18n.t("modeling.locateDefect", { defect: vacancyLabel }) })).toBeTruthy();
  });

  test("converts Direct and Cartesian fields for the same point, validates drafts and previews constraints", () => {
    render(<ModelingHarness />);
    const selected = selectedSection();
    fireEvent.click(within(selected).getByText(i18n.t("modeling.cartesian")));
    const x = within(selected).getByRole("textbox", { name: i18n.t("modeling.coordinateAxis", { axis: "x" }) }) as HTMLInputElement;
    expect(x.value).toBe("1.25");
    fireEvent.change(x, { target: { value: "" } });
    fireEvent.click(within(selected).getByRole("button", { name: i18n.t("modeling.move") }));
    expect(x.getAttribute("aria-invalid")).toBe("true");
    expect(readOperation()).toBeNull();
    fireEvent.change(x, { target: { value: "2.25" } });
    fireEvent.click(within(selected).getByRole("button", { name: i18n.t("modeling.move") }));
    expect(readOperation()).toEqual({ type: "move", siteId: "site-a", coordinates: "cartesian", position: [2.25, 1, 1] });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.cancel") }));
    fireEvent.click(within(selectedSection()).getByRole("checkbox", { name: i18n.t("modeling.freeAxis", { axis: "a" }) }));
    fireEvent.click(within(selectedSection()).getByRole("button", { name: i18n.t("modeling.previewConstraints") }));
    expect(readOperation()).toEqual({ type: "constraints", siteIds: ["site-a"], flags: [false, true, true] });
  });

  test("routes supercell, interstitial and defect actions through preview while locate stays view-only", () => {
    const locate = mock(() => {});
    render(<ModelingHarness onLocate={locate} />);
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("modeling.repeatAxis", { axis: "a" }) }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.supercell") }));
    expect(readOperation()).toEqual({ type: "supercell", repeat: [2, 1, 1] });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.cancel") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.addInterstitial") }));
    expect(readOperation()).toEqual({ type: "interstitial", element: "Cu", coordinates: "direct", position: [0.5, 0.5, 0.5] });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.apply") }));
    const defect = readModel().defects[0]!;
    const displayNumber = readModel().structure.sites.find(site => site.siteId === defect.siteId)!.displayAtomNumber;
    const label = `${i18n.t("modeling.interstitial")} · Cu #${displayNumber}`;
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.locateDefect", { defect: label }) }));
    expect(locate).toHaveBeenCalledWith(defect.id);
    expect(readOperation()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.centerDefect", { defect: label }) }));
    expect(readOperation()).toEqual({ type: "center", defectId: defect.id });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.cancel") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.restoreDefect", { defect: label }) }));
    expect(readOperation()).toEqual({ type: "restore", defectId: defect.id });
  });

  test("requires Find before Impose and blocks old symmetry results after a tolerance edit", () => {
    const find = mock(() => {});
    const impose = mock(() => {});
    const controller = { ...controllerDefaults(), onFindSymmetry: find, onPreviewImpose: impose };
    const { rerender } = render(<ModelingPanel controller={controller} />);
    expect((screen.getByRole("button", { name: i18n.t("modeling.impose") }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.find") }));
    expect(find).toHaveBeenCalledWith(1e-5);
    rerender(<ModelingPanel controller={{ ...controller, symmetry: { spaceGroup: "P1", spaceGroupNumber: 1, operationCount: 1, tolerance: 1e-5 } }} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.impose") }));
    expect(impose).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("modeling.tolerance") }), { target: { value: "0.001" } });
    expect((screen.getByRole("button", { name: i18n.t("modeling.impose") }) as HTMLButtonElement).disabled).toBe(true);
  });

  test.each(["0.2", "0.01"])("rehydrates the successful tolerance and never imposes a cached result after Find(%s) fails", async failedTolerance => {
    const model = initialModel();
    let saved: LoadedPreviewSession = { id: "symmetry-cache", file: null, fileName: "POSCAR",
      model: { state: model, revision: 0 }, scene: modelToScene(model), bondingMode: "cartoon-distance", customBondingProfile: null };
    const calls: { action: string; tolerance: number }[] = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (url, options) => {
      const body = JSON.parse(options!.body as string);
      const action = String(url).split("/").at(-1)!;
      calls.push({ action, tolerance: body.symprec });
      if (action === "find" && calls.length === 2) return new Response(JSON.stringify({ detail: {
        code: body.symprec === 0.2 ? "symmetry-invalid-tolerance" : "symmetry-not-found" } }),
        { status: 400, headers: { "content-type": "application/json" } });
      const result = { number: 1, symbol: "P1", pointGroup: "1", operationCount: 1,
        equivalentSites: model.structure.sites.map(site => [site.siteId]), tolerance: body.symprec };
      return new Response(JSON.stringify(action === "impose"
        ? { structure: body.structure, result, maxDisplacement: 0, rmsDisplacement: 0 } : result),
      { headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    const capture = (session: LoadedPreviewSession) => { saved = session; };
    const toleranceInput = () => screen.getByRole("textbox", { name: i18n.t("modeling.tolerance") }) as HTMLInputElement;
    const imposeButton = () => screen.getByRole("button", { name: i18n.t("modeling.impose") }) as HTMLButtonElement;
    const find = (value: string) => {
      fireEvent.change(toleranceInput(), { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: i18n.t("modeling.find") }));
    };
    try {
      const first = render(<SymmetryHarness session={saved} onSession={capture} />);
      find("0.01");
      await waitFor(() => expect(imposeButton().disabled).toBe(false));
      expect(saved.model?.symmetry?.tolerance).toBe(0.01);
      first.unmount();
      const restored = render(<SymmetryHarness session={saved} onSession={capture} />);
      expect(toleranceInput().value).toBe("0.01");
      expect(imposeButton().disabled).toBe(false);
      find(failedTolerance);
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
      expect(imposeButton().disabled).toBe(true);
      expect(saved.model?.symmetry).toBeUndefined();
      fireEvent.click(imposeButton());
      expect(calls).toEqual([{ action: "find", tolerance: 0.01 }, { action: "find", tolerance: Number(failedTolerance) }]);
      restored.unmount();
      render(<SymmetryHarness session={saved} onSession={capture} />);
      expect(imposeButton().disabled).toBe(true);
      find("0.001");
      await waitFor(() => expect(imposeButton().disabled).toBe(false));
      expect(saved.model?.symmetry?.tolerance).toBe(Number(toleranceInput().value));
      fireEvent.click(imposeButton());
      await waitFor(() => expect(calls.at(-1)).toEqual({ action: "impose", tolerance: 0.001 }));
    } finally { fetchMock.mockRestore(); }
  });
});

function initialModel(): ModelState {
  return createModelState({ cell: { vectors: [[4, 0, 0], [1, 4, 0], [0, 0, 4]] }, species: ["Cu", "I"], sites: [
    { siteId: "site-a", speciesIndex: 0, fractionalPosition: [0.25, 0.25, 0.25] },
    { siteId: "site-b", speciesIndex: 1, fractionalPosition: [0.75, 0.75, 0.75] },
  ] });
}

function controllerDefaults(): ModelingPanelController {
  return { model: initialModel(), selectedSiteIds: ["site-a"], busy: false, error: null, preview: null, symmetry: null,
    onCreateModel() {}, onPreviewOperation() {}, onApply() {}, onCancel() {}, onFindSymmetry() {}, onPreviewImpose() {}, onLocateDefect() {} };
}

function SymmetryHarness({ session, onSession }: { session: LoadedPreviewSession; onSession: (session: LoadedPreviewSession) => void }) {
  const preview = useStructurePreview({ initialSession: session,
    onBondAlgorithmSceneLoaded() {}, onPreviewCleared() {}, resetLoadedPreviewState() {} });
  const editing = useSceneEdits(preview.scene, 0);
  const modeling = useModelingController({ session: preview.session, readSession: preview.readSession,
    updateModelSymmetry: preview.updateModelSymmetry, editing, active: true,
    selection: { atoms: new Set(), bonds: new Set() }, onLocatePoint() {} });
  if (preview.session) onSession(preview.session);
  return <ModelingPanel controller={modeling.controller} />;
}

function ModelingHarness({ onLocate = () => {} }: { onLocate?: (id: string) => void }) {
  const [model, setModel] = useState(initialModel);
  const [operation, setOperation] = useState<ModelOperation | null>(null);
  const [candidate, setCandidate] = useState<ModelState | null>(null);
  const [count, setCount] = useState(0);
  return <>
    <output data-testid="committed-model">{JSON.stringify(model)}</output>
    <output data-testid="draft-operation">{JSON.stringify(operation)}</output>
    <output data-testid="applied-count">{count}</output>
    <ModelingPanel controller={{ ...controllerDefaults(), model, onLocateDefect: onLocate,
      preview: operation ? { title: operation.type, affectedSites: 1 } : null,
      onPreviewOperation: next => { setOperation(next); setCandidate(applyModelOperation(model, next).state); },
      onCancel: () => { setOperation(null); setCandidate(null); },
      onApply: () => { if (!candidate) return; setModel(candidate); setCandidate(null); setOperation(null); setCount(current => current + 1); },
    }} />
  </>;
}

function selectedSection() { return screen.getByRole("region", { name: i18n.t("modeling.selectedSites", { count: 1 }) }); }
function readModel(): ModelState { return JSON.parse(screen.getByTestId("committed-model").textContent!); }
function readOperation(): ModelOperation | null { return JSON.parse(screen.getByTestId("draft-operation").textContent!); }
