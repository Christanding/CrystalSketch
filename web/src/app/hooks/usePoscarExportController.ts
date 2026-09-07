import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PoscarExportError, PoscarFormatError, preparePoscar, validatePoscarText,
  type PoscarPreview, type PoscarSource } from "../../export/poscarExport";
import { downloadBlob } from "../../export/zipExport";

export interface SavedPoscarDraft { text: string; baseModelRevision: number | null; modified: boolean }

export function usePoscarExportController(source: PoscarSource | null,
  options: { blockedReason?: string; initialDraft?: SavedPoscarDraft } = {}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(options.initialDraft?.text ?? null);
  const [metadata, setMetadata] = useState<PoscarPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modified, setModified] = useState(options.initialDraft?.modified ?? false);
  const [baseModelRevision, setBaseModelRevision] = useState<number | null>(options.initialDraft?.baseModelRevision ?? source?.model?.revision ?? null);
  const pending = useRef<AbortController | null>(null);
  const deletionKey = JSON.stringify(source?.deletedAtomIds ?? []);
  const modelRevision = source?.model?.revision ?? null;
  const previous = useRef({ file: source?.file, deletionKey, modelRevision });
  const stale = draft !== null && baseModelRevision !== modelRevision;

  useEffect(() => {
    const changedSource = previous.current.file !== source?.file || previous.current.deletionKey !== deletionKey;
    const changedModel = previous.current.modelRevision !== modelRevision;
    previous.current = { file: source?.file, deletionKey, modelRevision };
    if (changedSource || changedModel && !modified) {
      setDraft(null); setMetadata(null); setError(null); setOpen(false); setBusy(false); setModified(false);
      setBaseModelRevision(modelRevision);
    } else if (changedModel) { setError(t("modeling.staleDraft")); setBusy(false); }
    return () => { pending.current?.abort(); };
  }, [source?.file, deletionKey, modelRevision]);

  function report(failure: unknown) {
    setError(failure instanceof PoscarFormatError ? t("poscar.formatError", {
      line: failure.line, reason: t(`poscar.format.${failure.code}`),
    }) : failure instanceof PoscarExportError ? t(`poscar.errors.${failure.code}`)
      : failure instanceof Error ? failure.message : t("poscar.errors.invalidCoordinates"));
  }

  async function generateDraft() {
    if (!source) throw new PoscarExportError("sourceRequired");
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      const result = await preparePoscar(source, controller.signal);
      controller.signal.throwIfAborted();
      setDraft(result.text); setMetadata(result); setModified(false); setBaseModelRevision(modelRevision); setError(null);
      return result.text;
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function currentDraft() {
    if (draft !== null) return draft;
    return generateDraft();
  }

  async function preview() {
    if (busy) return;
    if (options.blockedReason) { setError(options.blockedReason); return; }
    setError(null);
    try { await currentDraft(); setOpen(true); }
    catch (failure) { if (!(failure instanceof DOMException && failure.name === "AbortError")) report(failure); }
  }

  async function exportFile() {
    if (busy) return;
    if (options.blockedReason) { setError(options.blockedReason); return; }
    setError(null);
    try {
      if (stale) throw new Error(t("modeling.staleDraft"));
      const text = await currentDraft();
      validatePoscarText(text);
      downloadBlob(new Blob([text], { type: "application/octet-stream" }), "POSCAR");
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === "AbortError")) { report(failure); if (draft !== null) setOpen(true); }
    }
  }

  function changeDraft(text: string) { setDraft(text); setModified(true); setError(null); }
  function changeOpen(value: boolean) {
    setOpen(value);
    if (!value && draft !== null) {
      try { validatePoscarText(draft); setError(null); }
      catch (failure) { report(failure); }
    }
  }

  async function regenerate() {
    if (busy || options.blockedReason) return;
    try { await generateDraft(); }
    catch (failure) { if (!(failure instanceof DOMException && failure.name === "AbortError")) report(failure); }
  }
  const snapshot = useMemo<SavedPoscarDraft | undefined>(() => modified && draft !== null
    ? { text: draft, baseModelRevision, modified } : undefined, [draft, baseModelRevision, modified]);

  return { draft, metadata, error, open, busy, modified, preview, exportFile, changeDraft, changeOpen, stale, regenerate, snapshot };
}

export type PoscarExportController = ReturnType<typeof usePoscarExportController>;
