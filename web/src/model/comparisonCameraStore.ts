import { Quaternion } from "three";

export interface ComparisonCameraSnapshot {
  quaternion: [number, number, number, number];
  worldUnitsPerPixel: number;
}

export interface ComparisonCameraConfiguration {
  syncRotation: boolean;
  uniformScale: boolean;
}

export interface ComparisonCameraView {
  readSnapshot: () => ComparisonCameraSnapshot;
  applySnapshot: (snapshot: Partial<ComparisonCameraSnapshot>) => void;
  stopMotion: () => void;
}

export interface ComparisonCameraStore {
  configure: (configuration: Partial<ComparisonCameraConfiguration>) => void;
  getConfiguration: () => Readonly<ComparisonCameraConfiguration>;
  getActiveView: () => string | null;
  registerView: (id: string, view: ComparisonCameraView) => () => void;
  publishView: (id: string) => void;
  setActiveView: (id: string) => void;
  align: (sourceId: string) => void;
  reset: () => void;
}

interface RegisteredView {
  view: ComparisonCameraView;
  snapshot: ComparisonCameraSnapshot | null;
}

export function createComparisonCameraStore(
  initial: Partial<ComparisonCameraConfiguration> = {},
): ComparisonCameraStore {
  let configuration = { syncRotation: true, uniformScale: true, ...initial };
  let activeView: string | null = null;
  let applying = false;
  const views = new Map<string, RegisteredView>();

  function read(entry: RegisteredView) {
    const snapshot = entry.view.readSnapshot();
    const norm = Math.hypot(...snapshot.quaternion);
    if (!Number.isFinite(norm) || norm <= 0 || !Number.isFinite(snapshot.worldUnitsPerPixel) || snapshot.worldUnitsPerPixel <= 0) return null;
    return {
      quaternion: snapshot.quaternion.map(value => value / norm) as ComparisonCameraSnapshot["quaternion"],
      worldUnitsPerPixel: snapshot.worldUnitsPerPixel,
    };
  }

  function apply(entry: RegisteredView, snapshot: Partial<ComparisonCameraSnapshot>) {
    applying = true;
    try {
      entry.view.stopMotion();
      entry.view.applySnapshot(snapshot);
      entry.snapshot = read(entry);
    } finally {
      applying = false;
    }
  }

  function refreshBaselines() {
    for (const entry of views.values()) entry.snapshot = read(entry);
  }

  function synchronizeScale(sourceId: string | null) {
    const source = sourceId ? views.get(sourceId) : undefined;
    const snapshot = source ? read(source) : null;
    if (!snapshot) return;
    for (const [id, entry] of views) {
      if (id !== sourceId) apply(entry, { worldUnitsPerPixel: snapshot.worldUnitsPerPixel });
    }
    source!.snapshot = snapshot;
  }

  function setActiveView(id: string) {
    if (id === activeView) return;
    activeView = id;
    for (const [otherId, entry] of views) if (otherId !== id) entry.view.stopMotion();
    refreshBaselines();
  }

  return {
    configure(next) {
      const enableUniformScale = !configuration.uniformScale && next.uniformScale === true;
      configuration = { ...configuration, ...next };
      // Changing synchronization never replays a rotation accumulated while it was off.
      refreshBaselines();
      if (enableUniformScale) synchronizeScale(activeView);
    },
    getConfiguration: () => configuration,
    getActiveView: () => activeView,
    registerView(id, view) {
      views.get(id)?.view.stopMotion();
      const entry: RegisteredView = { view, snapshot: null };
      entry.snapshot = read(entry);
      views.set(id, entry);
      activeView ??= id;
      if (configuration.uniformScale && views.size > 1) synchronizeScale(views.has(activeView) ? activeView : views.keys().next().value!);
      return () => {
        if (views.get(id) !== entry) return;
        entry.view.stopMotion();
        views.delete(id);
        if (activeView === id) activeView = views.keys().next().value ?? null;
        refreshBaselines();
      };
    },
    publishView(id) {
      if (applying) return;
      const source = views.get(id);
      if (!source) return;
      const previous = source.snapshot;
      const current = read(source);
      source.snapshot = current;
      if (!current) return;
      if (activeView !== id) {
        const active = activeView ? views.get(activeView) : undefined;
        const activeSnapshot = active ? read(active) : null;
        if (configuration.uniformScale && activeSnapshot
          && Math.abs(current.worldUnitsPerPixel / activeSnapshot.worldUnitsPerPixel - 1) > 1e-9) {
          apply(source, { worldUnitsPerPixel: activeSnapshot.worldUnitsPerPixel });
        }
        return;
      }
      if (!previous) return;
      const previousQuaternion = new Quaternion(...previous.quaternion);
      const currentQuaternion = new Quaternion(...current.quaternion);
      const rotationChanged = configuration.syncRotation && Math.abs(previousQuaternion.dot(currentQuaternion)) < 1 - 1e-12;
      const scaleChanged = configuration.uniformScale && Math.abs(current.worldUnitsPerPixel / previous.worldUnitsPerPixel - 1) > 1e-9;
      if (!rotationChanged && !scaleChanged) return;
      const delta = previousQuaternion.invert().multiply(currentQuaternion);
      for (const [targetId, target] of views) {
        if (targetId === id) continue;
        const targetSnapshot = read(target);
        if (!targetSnapshot) continue;
        const update: Partial<ComparisonCameraSnapshot> = {};
        if (rotationChanged) update.quaternion = new Quaternion(...targetSnapshot.quaternion).multiply(delta).normalize().toArray();
        if (scaleChanged) update.worldUnitsPerPixel = current.worldUnitsPerPixel;
        apply(target, update);
      }
    },
    setActiveView,
    align(sourceId) {
      setActiveView(sourceId);
      const source = views.get(sourceId);
      const snapshot = source ? read(source) : null;
      if (!snapshot) return;
      for (const [id, entry] of views) if (id !== sourceId) apply(entry, { quaternion: [...snapshot.quaternion] });
      refreshBaselines();
    },
    reset() {
      for (const entry of views.values()) entry.view.stopMotion();
      views.clear();
      activeView = null;
    },
  };
}
