import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Quaternion } from "three";
import { stateFromViewVectors, vectorsFromCameraQuaternion } from "../../scene/crystalCamera";
import type { LoadedPreviewSession } from "./useStructurePreview";
import type { CameraInteractionStore } from "../../model/cameraInteractionStore";
import type { SavedWorkspace, WorkspacePreferences } from "../workspaceStorage";
import { saveDocumentPreferences, saveDocumentSession, saveModelWorkspace } from "../documentStorage";

export function useWorkspacePersistence(session: LoadedPreviewSession | null, preferences: WorkspacePreferences | null, cameraStore: CameraInteractionStore, orientationRef: RefObject<Quaternion>) {
  const latest = useRef({ preferences, session });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  const [saveError, setSaveError] = useState(false);
  useLayoutEffect(() => { latest.current = { preferences, session }; }, [preferences, session]);
  const getSnapshot = useCallback(() => {
    const { preferences, session } = latest.current;
    if (!preferences || !session || preferences.sessionId !== session.id) return null;
    const viewState = preferences.viewState;
    const vectors = vectorsFromCameraQuaternion(orientationRef.current);
    const camera = stateFromViewVectors(session.scene.cell.vectors, viewState.camera.primary, viewState.camera.secondary, vectors.up, vectors.outward);
    return { session, preferences: { ...preferences, viewState: { ...viewState, camera }, viewScale: cameraStore.getViewScaleSnapshot(), viewPan: cameraStore.getPanSnapshot() } };
  }, [cameraStore, orientationRef]);
  const reportSaveError = useCallback(() => { if (mounted.current) setSaveError(true); }, []);
  const saveSnapshot = useCallback((snapshot: SavedWorkspace | null) => {
    try {
      if (snapshot?.session.model) void saveModelWorkspace(snapshot).catch(reportSaveError);
      else if (snapshot) saveDocumentPreferences(snapshot.preferences);
    } catch { reportSaveError(); }
  }, [reportSaveError]);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const flush = useCallback(() => {
    clearTimer();
    try { saveSnapshot(getSnapshot()); }
    catch { reportSaveError(); }
  }, [clearTimer, getSnapshot, reportSaveError, saveSnapshot]);
  const schedule = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(flush, 150);
  }, [clearTimer, flush]);
  useEffect(() => {
    if (!session || session.model) return;
    let active = true;
    void saveDocumentSession(session).catch(() => { if (active) setSaveError(true); });
    return () => { active = false; };
  }, [session]);
  useEffect(() => {
    mounted.current = true;
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      mounted.current = false;
      clearTimer();
      let snapshot: SavedWorkspace | null = null;
      try { snapshot = getSnapshot(); } catch { reportSaveError(); }
      // StrictMode immediately reattaches effects; only a real unmount flushes.
      queueMicrotask(() => { if (!mounted.current) saveSnapshot(snapshot); });
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, [clearTimer, flush, getSnapshot, reportSaveError, saveSnapshot]);
  useEffect(() => { schedule(); }, [preferences, session, schedule]);
  useEffect(() => cameraStore.subscribeViewScale(schedule), [cameraStore, schedule]);
  return { getSnapshot, saveError, dismissSaveError: () => setSaveError(false) };
}
