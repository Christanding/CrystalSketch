import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type { AtomSpec, SceneSpec } from "../../api/scene";
import { DEFAULT_MEASUREMENT_STYLE, filterSceneToAtomIds, findAtomsBySourceNumber, firstNeighborAtomIds, resolveMeasurement, type SceneMeasurement, type MeasurementStyle } from "../../model/measurements";
import type { SceneSelection } from "../../selection/SceneSelection";
import { cloneModelReferences, mapModelReferences, mergeModelReferences, transitionModelReferences as transitionReferenceSnapshot,
  type ModelReferenceSnapshot, type ModelReferenceReplay } from "../../model/measurementModelMapping";
import type { ModelState } from "../../model/structureModel";

export type MeasurementTool = "inspect" | "distance" | "angle";
export interface MeasurementToolsSnapshot {
  appearance?: MeasurementStyle;
  measurements: SceneMeasurement[];
  focus: { atomIds: string[]; neighbors: boolean } | null;
}
const MAX_MEASUREMENTS = 50;

export function useMeasurementTools({ scene, visibleScene, resetToken, selection, select, initial }: {
  scene: SceneSpec | null;
  visibleScene: SceneSpec | null;
  resetToken: number;
  selection: SceneSelection;
  select: (selection: SceneSelection) => void;
  initial?: MeasurementToolsSnapshot;
}) {
  const [tool, setToolState] = useState<MeasurementTool>("inspect");
  const [draftIds, setDraftIds] = useState<string[]>([]);
  const [measurements, setMeasurementsState] = useState<SceneMeasurement[]>(() => initial?.measurements ?? []);
  const [labelStyle, setLabelStyle] = useState<MeasurementStyle>(() => ({ ...DEFAULT_MEASUREMENT_STYLE, ...initial?.appearance }));
  const [focus, setFocusState] = useState<MeasurementToolsSnapshot["focus"]>(() => initial?.focus ?? null);
  const modelReferences = useRef<ModelReferenceSnapshot>({ measurements, focus });
  modelReferences.current = { measurements, focus };
  const setMeasurements = useCallback((action: SetStateAction<SceneMeasurement[]>) => {
    const next = typeof action === "function" ? action(modelReferences.current.measurements) : action;
    modelReferences.current = { ...modelReferences.current, measurements: next };
    setMeasurementsState(next);
  }, []);
  const setFocus = useCallback((action: SetStateAction<MeasurementToolsSnapshot["focus"]>) => {
    const next = typeof action === "function" ? action(modelReferences.current.focus) : action;
    modelReferences.current = { ...modelReferences.current, focus: next };
    setFocusState(next);
  }, []);
  const getModelReferences = useCallback(() => cloneModelReferences(modelReferences.current), []);
  const restoreModelReferences = useCallback((target: ModelReferenceSnapshot, expected?: ModelReferenceSnapshot) => {
    const next = mergeModelReferences(modelReferences.current, target, expected);
    setMeasurements(next.measurements); setFocus(next.focus); setDraftIds([]);
  }, [setMeasurements, setFocus]);
  const remapModelReferences = useCallback((before: ModelState, after: ModelState, beforeScene: SceneSpec, afterScene: SceneSpec) => {
    restoreModelReferences(mapModelReferences(modelReferences.current, before, after, beforeScene, afterScene));
  }, [restoreModelReferences]);
  const transitionModelReferences = useCallback((before: ModelState, after: ModelState, beforeScene: SceneSpec,
    afterScene: SceneSpec, replay?: ModelReferenceReplay) => {
    const next = transitionReferenceSnapshot(modelReferences.current, before, after, beforeScene, afterScene, replay);
    setMeasurements(next.measurements); setFocus(next.focus); setDraftIds([]);
  }, [setMeasurements, setFocus]);
  const [search, setSearch] = useState("");
  const [searchNumber, setSearchNumber] = useState<number | null>(null);
  const previousReset = useRef(resetToken);
  useLayoutEffect(() => {
    if (previousReset.current === resetToken) return;
    previousReset.current = resetToken;
    setToolState("inspect"); setDraftIds([]); setMeasurements([]); setFocus(null);
    setLabelStyle({ ...DEFAULT_MEASUREMENT_STYLE });
    setSearch(""); setSearchNumber(null);
  }, [resetToken]);

  const draft = useMemo<SceneMeasurement | null>(() => {
    if (tool === "distance" && draftIds.length === 2) return { id: "draft", kind: "distance", atomIds: [draftIds[0]!, draftIds[1]!] };
    if (tool === "angle" && draftIds.length === 3) return { id: "draft", kind: "angle", atomIds: [draftIds[0]!, draftIds[1]!, draftIds[2]!] };
    return null;
  }, [tool, draftIds]);
  const currentMeasurement = useMemo(() => scene && draft ? resolveMeasurement(scene, draft) : null, [scene, draft]);
  const resolvedMeasurements = useMemo(() => measurements.map(definition => ({ definition, resolved: scene ? resolveMeasurement(scene, definition) : null })), [scene, measurements]);
  const focusIds = useMemo(() => {
    if (!scene || !focus) return null;
    const seeds = new Set(focus.atomIds);
    return focus.neighbors ? firstNeighborAtomIds(scene, seeds) : seeds;
  }, [scene, focus]);
  const focusedVisibleScene = useMemo(() => visibleScene && focusIds ? filterSceneToAtomIds(visibleScene, focusIds) : visibleScene, [visibleScene, focusIds]);
  const previewScene = useMemo(() => focusedVisibleScene ? {
    ...focusedVisibleScene, measurementStyle: labelStyle, measurements: draft && currentMeasurement ? [...measurements, draft] : measurements,
  } : null, [focusedVisibleScene, measurements, draft, currentMeasurement, labelStyle]);
  const exportScene = useMemo(() => {
    if (!scene) return null;
    return { ...scene, measurements, measurementStyle: labelStyle };
  }, [scene, measurements, labelStyle]);
  const exportVisibleScene = useMemo(() => focusedVisibleScene ? { ...focusedVisibleScene, measurements, measurementStyle: labelStyle } : null, [focusedVisibleScene, measurements, labelStyle]);
  const results = useMemo(() => scene && searchNumber !== null ? findAtomsBySourceNumber(scene, searchNumber) : [], [scene, searchNumber]);
  const draftAtoms = useMemo(() => draftIds.map(id => scene?.atoms.find(atom => atom.id === id)).filter((atom): atom is AtomSpec => Boolean(atom)), [scene, draftIds]);

  const setTool = useCallback((next: MeasurementTool) => {
    setToolState(next); setDraftIds([]);
    if (next === "distance" || next === "angle") select({ atoms: new Set(), bonds: new Set() });
  }, [select]);
  const clearDraft = useCallback(() => { setDraftIds([]); select({ atoms: new Set(), bonds: new Set() }); }, [select]);
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (event.target instanceof HTMLElement && event.target.closest("input,textarea,[contenteditable=true]"))) return;
      setToolState("inspect"); clearDraft();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [clearDraft]);
  const pickAtom = useCallback((id: string) => {
    if (tool !== "distance" && tool !== "angle") return;
    const required = tool === "distance" ? 2 : 3;
    const next = draftIds.length >= required ? [id] : draftIds.includes(id) ? draftIds : [...draftIds, id];
    setDraftIds(next);
    select({ atoms: new Set(next), bonds: new Set() });
  }, [draftIds, select, tool]);
  const pinMeasurement = useCallback(() => {
    if (!draft || !currentMeasurement || measurements.length >= MAX_MEASUREMENTS) return;
    setMeasurements(current => current.some(item => item.kind === draft.kind && item.atomIds.join("\0") === draft.atomIds.join("\0"))
      ? current : [...current, { ...draft, id: crypto.randomUUID() }]);
    clearDraft();
  }, [draft, currentMeasurement, measurements.length, clearDraft]);
  const selectedSeedIds = useMemo(() => {
    const ids = new Set(selection.atoms);
    for (const bond of scene?.bonds ?? []) if (selection.bonds.has(bond.id)) {
      const start = scene!.atoms[bond.startAtomIndex], end = scene!.atoms[bond.endAtomIndex];
      if (start) ids.add(start.id); if (end) ids.add(end.id);
    }
    return ids;
  }, [scene, selection]);
  const focusSelection = useCallback((neighbors: boolean) => {
    if (!selectedSeedIds.size) return;
    setFocus({ atomIds: [...selectedSeedIds], neighbors });
  }, [selectedSeedIds]);
  const locateAtom = useCallback((atom: AtomSpec) => {
    // Locating never silently changes persistent object visibility or periodic copies.
    setFocus(null); setToolState("inspect"); setDraftIds([]);
    select({ atoms: new Set([atom.id]), bonds: new Set() });
  }, [select]);
  const submitSearch = useCallback(() => {
    const value = Number(search.trim());
    setSearchNumber(search.trim() && Number.isInteger(value) && value >= 0 ? value : -1);
  }, [search]);
  const snapshot = useMemo(() => ({ measurements, focus, appearance: labelStyle }), [measurements, focus, labelStyle]);
  return {
    tool, setTool, draftAtoms, draft, currentMeasurement, clearDraft, pickAtom, pinMeasurement,
    labelStyle, setLabelStyle,
    canPin: Boolean(currentMeasurement) && measurements.length < MAX_MEASUREMENTS,
    resolvedMeasurements, removeMeasurement: (id: string) => setMeasurements(items => items.filter(item => item.id !== id)),
    clearMeasurements: () => setMeasurements([]), focus, focusSelection, exitFocus: () => setFocus(null),
    canFocus: selectedSeedIds.size > 0, search, setSearch, submitSearch, searchNumber, results, locateAtom,
    previewScene, exportScene, exportVisibleScene, snapshot, selection,
    getModelReferences, restoreModelReferences, remapModelReferences, transitionModelReferences,
  };
}
export type MeasurementToolsController = ReturnType<typeof useMeasurementTools>;
