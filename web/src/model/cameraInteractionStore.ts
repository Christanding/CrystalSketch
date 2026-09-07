import {
  DEFAULT_VIEW_SCALE,
  clampViewScale,
} from "./viewState";
import type { CrystalCameraState } from "./crystalCameraState";
import type { VectorTuple } from "./vector";

type Listener = () => void;

export interface CameraViewScaleCommandSnapshot {
  version: number;
  viewScale: number;
}

export interface CameraStateCommandSnapshot {
  cameraState: CrystalCameraState | null;
  version: number;
}

export interface CameraInteractionStore {
  getCameraStateCommandSnapshot: () => CameraStateCommandSnapshot;
  getViewScaleCommandSnapshot: () => CameraViewScaleCommandSnapshot;
  getViewScaleSnapshot: () => number;
  getPanSnapshot: () => VectorTuple;
  requestCameraState: (cameraState: CrystalCameraState) => void;
  requestViewScale: (viewScale: number) => void;
  setViewScaleSnapshot: (viewScale: number) => void;
  setPanSnapshot: (pan: VectorTuple) => void;
  requestPanTarget: (pan: VectorTuple) => void;
  subscribePanCommand: (listener: Listener) => () => void;
  subscribeCameraStateCommand: (listener: Listener) => () => void;
  subscribeViewScale: (listener: Listener) => () => void;
  subscribeViewScaleCommand: (listener: Listener) => () => void;
}

export function createCameraInteractionStore(
  initialViewScale = DEFAULT_VIEW_SCALE,
  initialPan: VectorTuple = [0, 0, 0],
): CameraInteractionStore {
  let viewScale = clampViewScale(initialViewScale);
  let pan: VectorTuple = initialPan.every(Number.isFinite) ? [...initialPan] : [0, 0, 0];
  let commandSnapshot: CameraViewScaleCommandSnapshot = {
    version: 0,
    viewScale,
  };
  let cameraStateCommandSnapshot: CameraStateCommandSnapshot = {
    cameraState: null,
    version: 0,
  };
  const cameraStateCommandListeners = new Set<Listener>();
  const viewScaleListeners = new Set<Listener>();
  const commandListeners = new Set<Listener>();
  const panListeners = new Set<Listener>();

  function notify(listeners: Set<Listener>) {
    for (const listener of listeners) {
      listener();
    }
  }

  function setViewScaleSnapshot(nextViewScale: number) {
    const clampedViewScale = clampViewScale(nextViewScale);
    if (Object.is(clampedViewScale, viewScale)) {
      return;
    }

    viewScale = clampedViewScale;
    notify(viewScaleListeners);
  }

  return {
    getCameraStateCommandSnapshot: () => cameraStateCommandSnapshot,
    getViewScaleCommandSnapshot: () => commandSnapshot,
    getViewScaleSnapshot: () => viewScale,
    getPanSnapshot: () => [...pan],
    setPanSnapshot: nextPan => {
      if (nextPan.every(Number.isFinite)) pan = [...nextPan];
    },
    requestPanTarget: nextPan => {
      if (!nextPan.every(Number.isFinite)) return;
      pan = [...nextPan];
      notify(panListeners);
    },
    subscribePanCommand: listener => {
      panListeners.add(listener);
      return () => { panListeners.delete(listener); };
    },
    requestCameraState: (cameraState: CrystalCameraState) => {
      cameraStateCommandSnapshot = {
        cameraState,
        version: cameraStateCommandSnapshot.version + 1,
      };
      notify(cameraStateCommandListeners);
    },
    requestViewScale: (nextViewScale: number) => {
      const clampedViewScale = clampViewScale(nextViewScale);
      setViewScaleSnapshot(clampedViewScale);
      commandSnapshot = {
        version: commandSnapshot.version + 1,
        viewScale: clampedViewScale,
      };
      notify(commandListeners);
    },
    setViewScaleSnapshot,
    subscribeCameraStateCommand: (listener: Listener) => {
      cameraStateCommandListeners.add(listener);
      return () => cameraStateCommandListeners.delete(listener);
    },
    subscribeViewScale: (listener: Listener) => {
      viewScaleListeners.add(listener);
      return () => viewScaleListeners.delete(listener);
    },
    subscribeViewScaleCommand: (listener: Listener) => {
      commandListeners.add(listener);
      return () => commandListeners.delete(listener);
    },
  };
}
