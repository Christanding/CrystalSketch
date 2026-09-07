import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, AlertTriangleIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { defaultBondAlgorithmForScene, uploadStructurePreview, isBackendUnavailablePreviewError } from "../api/scene";
import { MAX_STRUCTURE_UPLOAD_BYTES } from "../model/structureLimits";
import { createComparisonCameraStore } from "../model/comparisonCameraStore";
import { ColorPickerRegistryProvider } from "./colorPickerRegistry";
import { DocumentTabStrip } from "./DocumentTabStrip";
import { createDocumentWorkspace, type DocumentEditorComponent, type DocumentEditorHandle } from "./documentState";
import { durableWorkspaceManifest, removeDocument, saveDocumentPreferences, saveDocumentSession, saveModelWorkspace, saveWorkspaceManifest, type StoredDocuments, type WorkspaceManifest } from "./documentStorage";
import type { ModelState } from "../model/structureModel";
import type { SceneSpec } from "../api/scene";

export function DocumentWorkspace({ initial, restoreFailed, editor: Editor }: {
  initial: StoredDocuments; restoreFailed: boolean; editor: DocumentEditorComponent;
}) {
  const { t } = useTranslation();
  const [manifest, setManifest] = useState(initial.manifest);
  const manifestRef = useRef(manifest);
  const documents = useRef(new Map(initial.documents.map(doc => [doc.session.id, doc])));
  const durableIds = useRef(new Set(initial.documents.map(doc => doc.session.id)));
  const handles = useRef(new Map<string, DocumentEditorHandle>());
  const [cameraLink] = useState(() => createComparisonCameraStore({ syncRotation: initial.manifest.syncRotation, uniformScale: initial.manifest.uniformScale }));
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState(restoreFailed ? t("workspace.storageError") : "");
  const [loading, setLoading] = useState("");
  const importController = useRef<AbortController | null>(null);
  const [rename, setRename] = useState<{ id: string; title: string } | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [candidate, setCandidate] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const capture = useCallback(() => {
    for (const [id, handle] of handles.current) {
      const snapshot = handle.snapshot();
      if (snapshot) {
        documents.current.set(id, snapshot);
        try {
          if (snapshot.session.model) void saveModelWorkspace(snapshot).catch(() => setError(t("workspace.storageError")));
          else saveDocumentPreferences(snapshot.preferences);
        } catch { setError(t("workspace.storageError")); }
      }
    }
  }, [t]);
  const commit = useCallback((next: WorkspaceManifest, requireSave = false) => {
    try { saveWorkspaceManifest(durableWorkspaceManifest(next, durableIds.current)); }
    catch { setError(t("workspace.storageError")); if (requireSave) return false; }
    manifestRef.current = next;
    setManifest(next);
    return true;
  }, [t]);
  const activate = useCallback((id: string) => {
    cameraLink.setActiveView(id);
    if (manifestRef.current.activeId === id) return;
    for (const handle of handles.current.values()) handle.closeColorPicker();
    capture();
    commit({ ...manifestRef.current, activeId: id });
  }, [cameraLink, capture, commit]);
  const chooseDocument = (id: string, side?: number) => {
    capture();
    const current = manifestRef.current;
    let compareIds = current.compareIds;
    if (compareIds) {
      const target = side ?? compareIds.indexOf(current.activeId!);
      const existing = compareIds.indexOf(id);
      if (existing !== -1 && existing !== target) {
        activate(id);
        return;
      }
      compareIds = [...compareIds];
      compareIds[target] = id;
    }
    for (const handle of handles.current.values()) handle.closeColorPicker();
    cameraLink.setActiveView(id);
    commit({ ...current, compareIds, activeId: id });
  };
  const register = useCallback((id: string, handle: DocumentEditorHandle) => {
    handles.current.set(id, handle);
    return () => { if (handles.current.get(id) === handle) handles.current.delete(id); };
  }, []);

  useLayoutEffect(() => {
    cameraLink.configure({ syncRotation: !!manifest.compareIds && manifest.syncRotation, uniformScale: !!manifest.compareIds && manifest.uniformScale });
    if (manifest.activeId) cameraLink.setActiveView(manifest.activeId);
  }, [cameraLink, manifest.compareIds, manifest.syncRotation, manifest.uniformScale, manifest.activeId]);
  useEffect(() => {
    window.addEventListener("pagehide", capture);
    window.addEventListener("beforeunload", capture);
    return () => { window.removeEventListener("pagehide", capture); window.removeEventListener("beforeunload", capture); };
  }, [capture]);
  useEffect(() => () => { importController.current?.abort(); cameraLink.reset(); }, [cameraLink]);

  async function openFiles(files: File[]) {
    if (!files.length) return;
    importController.current?.abort();
    const controller = new AbortController();
    importController.current = controller;
    capture();
    const inherited = documents.current.get(manifestRef.current.activeId ?? "")?.preferences;
    let first = true;
    const failures: string[] = [];
    for (let index = 0; index < files.length; index++) {
      if (controller.signal.aborted) break;
      const file = files[index]!;
      setLoading(`${index + 1}/${files.length} · ${file.name}`);
      try {
        if (file.size > MAX_STRUCTURE_UPLOAD_BYTES) throw new Error(t("validation.fileTooLarge"));
        const scene = await uploadStructurePreview(file, { signal: controller.signal });
        if (controller.signal.aborted) break;
        const id = crypto.randomUUID();
        const workspace = createDocumentWorkspace({ id, file, fileName: file.name, scene,
          bondingMode: defaultBondAlgorithmForScene(scene), customBondingProfile: null }, inherited);
        // Commit the recovery pointer only after the source data is durable.
        try { await saveDocumentSession(workspace.session); saveDocumentPreferences(workspace.preferences); durableIds.current.add(id); }
        catch { setError(t("workspace.storageError")); }
        if (controller.signal.aborted) { void removeDocument(id).catch(() => {}); break; }
        documents.current.set(id, workspace);
        const current = manifestRef.current;
        let title = file.name;
        let suffix = 2;
        while (current.documents.some(doc => doc.title === title)) title = `${file.name} (${suffix++})`;
        const next = { ...current, documents: [...current.documents, { id, title }] };
        if (first) {
          if (next.compareIds) {
            const pair: [string, string] = [...next.compareIds];
            pair[pair.indexOf(current.activeId!)] = id;
            next.compareIds = pair;
          }
          next.activeId = id;
          first = false;
        }
        capture();
        commit(next);
      } catch (reason) {
        if (!controller.signal.aborted) failures.push(`${file.name}: ${isBackendUnavailablePreviewError(reason)
          ? `${t("validation.pythonBackendUnavailable")} — ${t("validation.startLocalBackend")}`
          : `${t("validation.unsupportedFile")} — ${file.size > MAX_STRUCTURE_UPLOAD_BYTES ? t("validation.fileTooLarge") : t("validation.parseError")}`}`);
      }
    }
    if (importController.current === controller) {
      importController.current = null;
      setLoading("");
      if (failures.length) setError(failures.join("\n"));
    }
  }
  async function closeDocument(id: string) {
    if (handles.current.get(id)?.isBusy()) { setError(t("documents.waitForOperation")); return; }
    capture();
    const current = manifestRef.current;
    const nextDocuments = current.documents.filter(doc => doc.id !== id);
    const index = current.documents.findIndex(doc => doc.id === id);
    const compareIds = current.compareIds?.includes(id) ? null : current.compareIds;
    const activeId = current.activeId === id
      ? current.compareIds?.find(other => other !== id) ?? nextDocuments[Math.min(index, nextDocuments.length - 1)]?.id ?? null
      : current.activeId;
    if (!commit({ ...current, documents: nextDocuments, activeId, compareIds }, true)) return;
    documents.current.delete(id);
    handles.current.delete(id);
    await removeDocument(id).catch(() => setError(t("workspace.storageError")));
  }

  async function createModelCopy(sourceId: string, model: ModelState, scene: SceneSpec) {
    capture();
    const source = documents.current.get(sourceId);
    if (!source) throw new Error("The source document is no longer available.");
    const id = crypto.randomUUID();
    const workspace = createDocumentWorkspace({ ...source.session, id, scene,
      model: { state: model, revision: 0 }, symmetryResolved: false,
      bondingMode: "cartoon-distance", customBondingProfile: null }, source.preferences);
    workspace.preferences = { ...workspace.preferences, modelDocument: true,
      appearance: source.preferences.appearance, viewState: source.preferences.viewState,
      viewScale: source.preferences.viewScale, viewPan: source.preferences.viewPan,
      measurementTools: source.preferences.measurementTools,
      edits: { deleted: { atoms: [], bonds: source.preferences.edits.deleted.bonds }, history: [] } };
    await saveModelWorkspace(workspace);
    durableIds.current.add(id);
    documents.current.set(id, workspace);
    const current = manifestRef.current;
    const title = `${current.documents.find(doc => doc.id === sourceId)?.title ?? source.session.fileName} · ${t("modeling.title")}`;
    commit({ ...current, documents: [...current.documents, { id, title }], activeId: id,
      compareIds: current.compareIds ? current.compareIds.map(other => other === sourceId ? id : other) as [string, string] : null });
  }
  function beginCompare() {
    const other = manifest.documents.find(doc => doc.id !== manifest.activeId);
    if (!other) return;
    setCandidate(other.id);
    setCompareOpen(true);
  }
  const visibleIds: string[] = manifest.compareIds ?? (manifest.activeId ? [manifest.activeId] : []);
  // Stable document order keeps mounted renderers alive when swapping left/right.
  const mountedIds = manifest.documents.filter(doc => visibleIds.includes(doc.id)).map(doc => doc.id);
  if (!mountedIds.length) mountedIds.push("empty");
  const comparison = !!manifest.compareIds;
  const leftSidebarOpen = manifest.leftSidebarOpen ?? true;
  const comparisonControls = comparison ? <div className="space-y-2 text-sm">
    <label className="flex items-center justify-between gap-4 py-1">
      <span>{t("documents.syncRotation")}</span>
      <input type="checkbox" className="size-4 accent-foreground" checked={manifest.syncRotation} onChange={event => commit({ ...manifest, syncRotation: event.target.checked })} />
    </label>
    <label className="flex items-center justify-between gap-4 py-1">
      <span>{t("documents.uniformScale")}</span>
      <input type="checkbox" className="size-4 accent-foreground" checked={manifest.uniformScale} onChange={event => commit({ ...manifest, uniformScale: event.target.checked })} />
    </label>
    <div className="grid grid-cols-2 gap-2 border-t pt-2">
      <Button variant="outline" size="sm" onClick={() => manifest.activeId && cameraLink.align(manifest.activeId)}>{t("documents.align")}</Button>
      <Button variant="outline" size="sm" onClick={() => { capture(); commit({ ...manifest, compareIds: [manifest.compareIds![1], manifest.compareIds![0]] }); }}><ArrowLeftRight />{t("documents.swap")}</Button>
    </div>
    <Button variant="outline" size="sm" className="w-full" onClick={() => {
      const source = handles.current.get(manifest.activeId!)?.snapshot();
      if (source) for (const id of visibleIds) if (id !== manifest.activeId) handles.current.get(id)?.applyAppearance(source.preferences);
    }}>{t("documents.sameAppearance")}</Button>
  </div> : null;

  return <main className="document-workspace relative flex h-dvh min-w-80 flex-col overflow-hidden bg-background text-foreground"
    data-left-sidebar={leftSidebarOpen ? "open" : "closed"}
    onDragEnter={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDragLeave={() => { dragDepth.current--; if (dragDepth.current <= 0) setDragging(false); }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); void openFiles(Array.from(event.dataTransfer.files)); }}>
    <input ref={input} type="file" multiple className="hidden" aria-label={t("preview.structureFile")} onChange={event => {
      const files = Array.from(event.target.files ?? []); event.target.value = ""; void openFiles(files);
    }} />
    {manifest.documents.length ? <header className="document-top-dock absolute top-[29px] z-30 flex h-8 items-center">
      <DocumentTabStrip documents={manifest.documents} activeId={manifest.activeId}
        onSelect={id => chooseDocument(id)} onRename={setRename} onClose={id => void closeDocument(id)} />
    </header> : null}
    <div className={cn("relative min-h-0 flex-1", comparison && "comparison-workspace")}>
      {mountedIds.map(id => <div key={id} data-document-id={id} data-active={manifest.activeId === id} data-side={comparison ? visibleIds.indexOf(id) : undefined}
        className={cn("document-pane absolute inset-y-0 overflow-hidden transition-[width,left] duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduced:transition-none", !comparison && "inset-x-0", comparison && "border-l border-border")}
        onPointerDownCapture={() => id !== "empty" && activate(id)} onWheelCapture={() => id !== "empty" && activate(id)}>
        {comparison ? <div className={cn("absolute inset-x-3 top-[82px] z-10 flex h-8 items-center gap-2 rounded-lg border px-3 text-xs", manifest.activeId === id ? "bg-muted" : "bg-background")}>
          <select aria-label={t(visibleIds.indexOf(id) === 0 ? "documents.left" : "documents.right")} value={id}
            className="min-w-0 flex-1 bg-transparent outline-none" onChange={event => chooseDocument(event.target.value, visibleIds.indexOf(id))}>
            {manifest.documents.map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}
          </select>
          {manifest.activeId === id ? <span className="text-xs text-muted-foreground">{t("documents.editing")}</span> : null}
        </div> : null}
        <ColorPickerRegistryProvider><Editor initialWorkspace={documents.current.get(id) ?? null}
          leftSidebarOpen={leftSidebarOpen}
          onLeftSidebarOpenChange={open => commit({ ...manifestRef.current, leftSidebarOpen: open })}
          active={id === "empty" || id === manifest.activeId} comparison={comparison} controlsHost={controlsHost}
          comparisonControls={comparisonControls}
          canCompare={manifest.documents.length >= 2} onToggleCompare={() => {
            if (comparison) { capture(); commit({ ...manifest, compareIds: null }); } else beginCompare();
          }}
          comparisonCameraStore={cameraLink} onActivate={() => id !== "empty" && activate(id)}
          onOpen={() => input.current?.click()} onCreateModel={(model, scene) => createModelCopy(id, model, scene)}
          onClose={() => closeDocument(id)} register={register} /></ColorPickerRegistryProvider>
      </div>)}
      <div ref={setControlsHost} className="document-controls pointer-events-none absolute inset-0 z-20 overflow-clip" />
      {loading ? <div role="status" className="absolute bottom-3 right-3 z-40 flex items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm"><span data-testid="loading-structure-spinner" className="size-3 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground motion-enabled:animate-spin" /><span>{t("preview.loadingStructure")}</span><span>{loading}</span>
        <Button size="sm" variant="ghost" onClick={() => { importController.current?.abort(); setLoading(""); }}>{t("workspace.cancel")}</Button></div> : null}
      {error ? <Alert className="absolute bottom-4 left-4 z-50 max-h-48 max-w-md overflow-auto whitespace-pre-wrap bg-background" onDismiss={() => setError("")}><AlertTriangleIcon /><AlertDescription>{error}</AlertDescription></Alert> : null}
      {dragging ? <div className="pointer-events-none absolute inset-2 z-50 grid place-items-center rounded-xl border-2 border-dashed bg-background/90">{t("documents.drop")}</div> : null}
    </div>
    <Dialog open={!!rename} onOpenChange={open => { if (!open) setRename(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{t("documents.rename")}</DialogTitle></DialogHeader>
        <form onSubmit={event => { event.preventDefault(); if (!rename?.title.trim()) return; commit({ ...manifest, documents: manifest.documents.map(doc => doc.id === rename.id ? { ...doc, title: rename.title.trim() } : doc) }); setRename(null); }}>
          <Input aria-label={t("documents.name")} value={rename?.title ?? ""} maxLength={120} onChange={event => setRename(current => current ? { ...current, title: event.target.value } : null)} />
          <DialogFooter className="mt-4"><Button type="submit">{t("documents.save")}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
      <DialogContent><DialogHeader><DialogTitle>{t("documents.chooseCompare")}</DialogTitle></DialogHeader>
        <select className="h-10 w-full rounded-md border bg-background px-3" aria-label={t("documents.right")} value={candidate} onChange={event => setCandidate(event.target.value)}>
          {manifest.documents.filter(doc => doc.id !== manifest.activeId).map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}
        </select>
        <DialogFooter><Button disabled={!candidate} onClick={() => { capture(); commit({ ...manifest, compareIds: [manifest.activeId!, candidate] }); setCompareOpen(false); }}>{t("documents.compare")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </main>;
}
