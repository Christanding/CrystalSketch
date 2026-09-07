import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SceneSpec } from "../../api/scene";
import { buildStructureScene } from "../../api/vaspWorker";
import { findModelSymmetry, imposeModelSymmetry, modelSymmetrySummary, ModelSymmetryError, type ModelSymmetryResult } from "../../api/modelSymmetry";
import { readCalculationStructure, PoscarExportError } from "../../export/poscarExport";
import { applyModelOperation, createModelState, ModelEditError, validateModelStructure,
  type ModelOperation, type ModelState, type Vec3 } from "../../model/structureModel";
import type { SceneSelection } from "../../selection/SceneSelection";
import type { LoadedPreviewSession } from "./useStructurePreview";
import type { useSceneEdits } from "./useSceneEdits";
import type { ModelingPanelController } from "../inspector/ModelingPanel";
import { createModelPatch } from "../../model/modelHistory";

const SYMMETRY_ERRORS = {
  "unavailable": "modeling.symmetryErrors.unavailable",
  "symmetry-invalid-request": "modeling.symmetryErrors.invalidRequest",
  "symmetry-invalid-cell": "modeling.symmetryErrors.invalidCell",
  "symmetry-invalid-tolerance": "modeling.symmetryErrors.invalidTolerance",
  "symmetry-budget-exceeded": "modeling.symmetryErrors.budget",
  "symmetry-not-found": "modeling.symmetryErrors.notFound",
  "symmetry-changed": "modeling.symmetryErrors.changed",
  "symmetry-lattice-change-required": "modeling.symmetryErrors.lattice",
  "symmetry-ambiguous-mapping": "modeling.symmetryErrors.ambiguous",
  "symmetry-constraint-conflict": "modeling.symmetryErrors.constraints",
  "symmetry-verification-failed": "modeling.symmetryErrors.verification",
} as const;
const OPERATION_LABELS = { vacancy: "modeling.vacancy", substitute: "modeling.substitute", interstitial: "modeling.interstitial",
  move: "modeling.move", constraints: "modeling.constraints", supercell: "modeling.supercell",
  center: "modeling.center", restore: "modeling.restore" } as const;
interface PreparedEdit {
  state: ModelState;
  scene: SceneSpec;
  revision: number;
  title: string;
  warnings: string[];
  affectedSites: number;
  maxDisplacement?: number;
  symmetry?: ModelSymmetryResult;
}
interface Options {
  session: LoadedPreviewSession | null;
  selection: SceneSelection;
  editing: ReturnType<typeof useSceneEdits>;
  readSession: () => LoadedPreviewSession | null;
  onCreateModel?: (model: ModelState, scene: SceneSpec) => Promise<void>;
  onLocatePoint: (point: Vec3) => void;
  updateModelSymmetry: (revision: number, symmetry: SceneSpec["summary"]["symmetry"], analysis?: ModelSymmetryResult) => void;
  active: boolean;
}

export function useModelingController(options: Options) {
  const { t } = useTranslation();
  const latest = useRef(options);
  latest.current = options;
  const [prepared, setPrepared] = useState<PreparedEdit | null>(null);
  const preparedRef = useRef(prepared);
  preparedRef.current = prepared;
  const preparedSceneFor = useCallback((state: ModelState) => preparedRef.current?.state === state ? preparedRef.current.scene : undefined, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const symmetry = options.session?.model?.symmetry ?? null;
  const pending = useRef<AbortController | null>(null);
  const cancel = useCallback(() => {
    pending.current?.abort(); pending.current = null;
    preparedRef.current = null; setPrepared(null); setBusy(false);
  }, []);
  const revision = options.session?.model?.revision;
  useEffect(() => { cancel(); setError(null); }, [options.session?.id, revision, cancel]);
  useEffect(() => { if (!options.active) cancel(); }, [options.active, cancel]);
  useEffect(() => () => pending.current?.abort(), []);

  const report = useCallback((failure: unknown) => {
    if (failure instanceof DOMException && failure.name === "AbortError") return;
    if (failure instanceof ModelEditError) setError(t(`modeling.errors.${failure.code}`));
    else if (failure instanceof PoscarExportError) setError(t(`poscar.errors.${failure.code}`));
    else if (failure instanceof ModelSymmetryError) {
      setError(t(SYMMETRY_ERRORS[failure.code as keyof typeof SYMMETRY_ERRORS] ?? SYMMETRY_ERRORS.unavailable));
    } else setError(failure instanceof Error ? failure.message : t("modeling.failed"));
  }, [t]);

  function begin() {
    cancel(); setError(null); setBusy(true);
    const controller = new AbortController(); pending.current = controller;
    return controller;
  }
  function finish(controller: AbortController) {
    if (pending.current === controller) { pending.current = null; setBusy(false); }
  }
  function currentModel() {
    const session = latest.current.readSession();
    if (!session?.model) throw new Error(t("modeling.createCopy"));
    return session as LoadedPreviewSession & { model: NonNullable<LoadedPreviewSession["model"]> };
  }
  async function prepare(state: ModelState, title: string, warnings: string[], controller: AbortController,
    session: ReturnType<typeof currentModel>, maxDisplacement?: number, analysis?: ModelSymmetryResult) {
    const scene = await buildStructureScene(state.structure, { signal: controller.signal,
      cutoffOverrides: session.customBondingProfile?.cutoffOverrides, bondTolerance: session.scene.bondTolerance });
    controller.signal.throwIfAborted();
    if (latest.current.readSession()?.model?.revision !== session.model.revision) return;
    const next = { state, scene, revision: session.model.revision, title,
      affectedSites: createModelPatch(session.model.state, state).ids.length,
      warnings: warnings.map(warning => warning === "missing-radius-data" ? t("modeling.missingRadiusData") : warning), maxDisplacement,
      symmetry: analysis };
    preparedRef.current = next; setPrepared(next);
  }
  async function onPreviewOperation(operation: ModelOperation) {
    const controller = begin();
    try {
      const session = currentModel();
      const result = applyModelOperation(session.model.state, operation);
      await prepare(result.state, t(OPERATION_LABELS[operation.type]), result.warnings, controller, session);
    } catch (failure) { if (!controller.signal.aborted) report(failure); }
    finally { finish(controller); }
  }
  async function onCreateModel() {
    const controller = begin();
    try {
      const current = latest.current.readSession();
      if (!current?.file || !latest.current.onCreateModel) throw new PoscarExportError("sourceRequired");
      let model = createModelState(await readCalculationStructure(current.file, controller.signal));
      const atomsById = new Map(current.scene.atoms.map(atom => [atom.id, atom]));
      const deleted = [...new Set(latest.current.editing.snapshot.deleted.atoms.map(id =>
        atomsById.get(id)?.siteId ?? id.replace(/-image-[-\d]+$/, "")))];
      if (deleted.length) model = applyModelOperation(model, { type: "vacancy", siteIds: deleted }).state;
      const scene = await buildStructureScene(model.structure, { signal: controller.signal });
      controller.signal.throwIfAborted();
      await latest.current.onCreateModel(model, scene);
    } catch (failure) { if (!controller.signal.aborted) report(failure); }
    finally { finish(controller); }
  }
  async function onFindSymmetry(tolerance: number) {
    const controller = begin();
    try {
      const session = currentModel();
      latest.current.updateModelSymmetry(session.model.revision, { available: false, spaceGroup: null,
        spaceGroupNumber: null, pointGroup: null, pointGroupSchoenflies: null, crystalSystem: null, latticeSystem: null });
      const result = await findModelSymmetry(session.model.state.structure, tolerance, controller.signal);
      if (latest.current.readSession()?.model?.revision !== session.model.revision) return;
      latest.current.updateModelSymmetry(session.model.revision, modelSymmetrySummary(result), result);
    } catch (failure) { if (!controller.signal.aborted) report(failure); }
    finally { finish(controller); }
  }
  async function onPreviewImpose() {
    if (!symmetry) return;
    const controller = begin();
    try {
      const session = currentModel();
      const result = await imposeModelSymmetry(session.model.state.structure, symmetry, controller.signal);
      validateModelStructure(result.structure);
      const byId = new Map(result.structure.sites.map(site => [site.siteId, site]));
      const state = { structure: result.structure, defects: session.model.state.defects.map(defect => {
        const site = byId.get(defect.siteId);
        return site ? { ...defect, fractionalPosition: site.fractionalPosition } : defect;
      }) };
      await prepare(state, t("modeling.impose"), [], controller, session, result.maxDisplacement, result.result);
    } catch (failure) { if (!controller.signal.aborted) report(failure); }
    finally { finish(controller); }
  }
  const onApply = () => {
    const proposal = preparedRef.current;
    if (!proposal || latest.current.readSession()?.model?.revision !== proposal.revision) return;
    try {
      latest.current.editing.commitModel(proposal.state);
      const applied = latest.current.readSession();
      if (proposal.symmetry && applied?.model) latest.current.updateModelSymmetry(applied.model.revision,
        modelSymmetrySummary(proposal.symmetry), proposal.symmetry);
      cancel(); setError(null);
    }
    catch (failure) { report(failure); }
  };
  const model = options.session?.model?.state ?? null;
  const selected = options.session?.scene.atoms.filter(atom => options.selection.atoms.has(atom.id)).map(atom => atom.siteId) ?? [];
  const controller: ModelingPanelController = {
    model, selectedSiteIds: [...new Set(selected)], busy, error,
    preview: prepared ? { title: prepared.title, affectedSites: prepared.affectedSites,
      maxDisplacement: prepared.maxDisplacement, warnings: prepared.warnings } : null,
    symmetry: symmetry ? { spaceGroup: symmetry.symbol, spaceGroupNumber: symmetry.number,
      operationCount: symmetry.operationCount, tolerance: symmetry.tolerance } : null,
    onCreateModel: () => void onCreateModel(), onPreviewOperation: op => void onPreviewOperation(op),
    onApply, onCancel: cancel, onFindSymmetry: tolerance => void onFindSymmetry(tolerance), onPreviewImpose: () => void onPreviewImpose(),
    onLocateDefect: id => {
      const defect = model?.defects.find(item => item.id === id);
      if (defect) latest.current.onLocatePoint(defect.fractionalPosition);
    },
  };
  return { controller, previewScene: prepared?.scene ?? null, cancel, report, preparedSceneFor };
}
