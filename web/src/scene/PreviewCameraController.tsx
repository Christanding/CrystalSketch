import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { MOUSE, OrthographicCamera, Quaternion, TOUCH, Vector3, type Spherical, type Vector2 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";

import type { CameraInteractionStore } from "../model/cameraInteractionStore";
import type { ComparisonCameraStore } from "../model/comparisonCameraStore";
import type { PreviewSafeArea } from "../model/layout";
import {
  MAX_VIEW_SCALE,
  MIN_VIEW_SCALE,
  BASE_ORBIT_DRAG_SENSITIVITY,
  BASE_TRACKBALL_DRAG_SENSITIVITY,
  clampViewScale,
  type InteractionMode,
} from "../model/viewState";
import {
  computeCrystalCameraPose,
  type CrystalCameraPose,
  type CrystalCameraState,
} from "./crystalCamera";
import type { SceneLayout } from "./sceneLayout";
import {
  applyOrthographicFrustum,
  computeCameraFitZoom,
  computeOrthographicFrustum,
  type StandardCameraPose,
  type VectorTuple,
} from "./viewMath";

const CAMERA_TARGET = new Vector3(0, 0, 0);
const CAMERA_LOCAL_FORWARD = new Vector3(0, 0, 1);
const CAMERA_LOCAL_UP = new Vector3(0, 1, 0);
const CAMERA_COMMAND_ANIMATION_DURATION_MS = 260;
const CAMERA_CONTROLS_IDLE_EPSILON_RADIANS = 0.0005;
const CAMERA_CONTROLS_IDLE_FRAMES = 1;
const CAMERA_CONTROLS_IDLE_ZOOM_EPSILON = 0.0005;
const CAMERA_CONTROLS_STATE_NONE = -1;
const CAMERA_CONTROLS_STATE_ROTATE = 0;
const CAMERA_CONTROLS_STATE_TOUCH_ROTATE = 3;
const CAMERA_CONTROLS_STATE_ORBIT_TOUCH_DOLLY_ROTATE = 6;
const VIEW_SCALE_SYNC_EPSILON = 0.0005;
const FRUSTUM_SYNC_EPSILON = 0.000001;
const TRACKBALL_ZOOM_SPEED = 1.2;
const TRACKBALL_DYNAMIC_DAMPING_FACTOR = 0.2;
const TRACKBALL_NO_INERTIA_ROTATE_RESPONSE_MULTIPLIER = 1.6;
const TRACKBALL_NO_INERTIA_ZOOM_RESPONSE_MULTIPLIER = 4;

type CameraControls = OrbitControls | TrackballControls;

interface CameraControlsStateSource {
  keyState?: number;
  state?: number;
}

interface CameraControlsInteractionState {
  active: boolean;
  idleFrames: number;
  lastQuaternion: Quaternion;
  lastZoom: number;
  waitingForIdle: boolean;
}

export function PreviewCameraController({
  cameraAnimatedCommandVersion,
  cameraCommandVersion,
  cameraInteractionStore,
  comparisonCameraStore,
  comparisonViewId,
  cameraPose,
  cellVectors,
  interactionLocked,
  interactionMode,
  dragSensitivity,
  layout,
  mouseInertia,
  reducedMotion,
  onCameraCommandAnimationActiveChange,
  onCameraControlsInteractionActiveChange,
  resetCounter,
  safeArea,
}: {
  cameraAnimatedCommandVersion: number;
  cameraCommandVersion: number;
  cameraInteractionStore: CameraInteractionStore;
  comparisonCameraStore?: ComparisonCameraStore;
  comparisonViewId?: string;
  cameraPose: CrystalCameraPose;
  cellVectors: VectorTuple[];
  interactionLocked: boolean;
  interactionMode: InteractionMode;
  dragSensitivity: number;
  layout: SceneLayout;
  mouseInertia: boolean;
  reducedMotion: boolean;
  onCameraCommandAnimationActiveChange?: (isActive: boolean) => void;
  onCameraControlsInteractionActiveChange?: (
    isActive: boolean,
    quaternionSnapshot?: Quaternion,
  ) => void;
  resetCounter: number;
  safeArea: PreviewSafeArea;
}) {
  const { camera, gl, invalidate, size } = useThree();
  const controlsRef = useRef<CameraControls | null>(null);
  const cameraAnimationRef = useRef<CameraPoseAnimation | null>(null);
  const cameraControlsInteractionRef = useRef<CameraControlsInteractionState>({
    active: false,
    idleFrames: 0,
    lastQuaternion: new Quaternion(),
    lastZoom: camera instanceof OrthographicCamera ? camera.zoom : 0,
    waitingForIdle: false,
  });
  const isCameraAnimationActiveRef = useRef(false);
  const onCameraCommandAnimationActiveChangeRef = useRef(onCameraCommandAnimationActiveChange);
  const onCameraControlsInteractionActiveChangeRef = useRef(
    onCameraControlsInteractionActiveChange,
  );
  const cameraPoseRef = useRef(cameraPose);
  const hasAppliedInitialPoseRef = useRef(false);
  const lastCameraAnimatedCommandVersionRef = useRef(cameraAnimatedCommandVersion);
  const lastCameraCommandVersionRef = useRef(cameraCommandVersion);
  const lastFrameCameraQuaternionRef = useRef(new Quaternion());
  const lastLayoutSpanRef = useRef(layout.span);
  const lastResetCounterRef = useRef(resetCounter);
  const syncedViewScaleRef = useRef(cameraInteractionStore.getViewScaleSnapshot());
  const trackballDirectFlushPendingRef = useRef(false);
  const trackballInertiaPendingRef = useRef(false);
  const comparisonRef = useRef({ store: comparisonCameraStore, id: comparisonViewId });
  comparisonRef.current = { store: comparisonCameraStore, id: comparisonViewId };
  const comparisonUnitsPerPixelRef = useRef<number | null>(null);
  const comparisonModeRef = useRef(false);
  const comparisonFitPendingRef = useRef(false);
  const comparisonEntryViewScaleRef = useRef(1);
  const effectiveMouseInertia = mouseInertia && !reducedMotion;
  cameraPoseRef.current = cameraPose;
  const effectiveSafeArea = safeArea;
  const fitZoom = useMemo(
    () => computeCameraFitZoom(layout.cameraFitBounds, size.width, size.height, effectiveSafeArea),
    [effectiveSafeArea, layout.cameraFitBounds, size.height, size.width],
  );
  const comparisonMetricsRef = useRef({ width: size.width, height: size.height, safeArea: effectiveSafeArea, fitZoom });
  comparisonMetricsRef.current = { width: size.width, height: size.height, safeArea: effectiveSafeArea, fitZoom };
  // Controls can report a change before passive subscriptions catch up with a layout commit.
  const appliedProjectionRef = useRef(comparisonMetricsRef.current);
  onCameraCommandAnimationActiveChangeRef.current = onCameraCommandAnimationActiveChange;
  onCameraControlsInteractionActiveChangeRef.current =
    onCameraControlsInteractionActiveChange;

  const requestFrame = useCallback(() => {
    invalidate();
  }, [invalidate]);

  const activateComparisonView = useCallback(() => {
    const { store, id } = comparisonRef.current;
    if (store && id) store.setActiveView(id);
  }, []);
  const publishComparisonView = useCallback(() => {
    const { store, id } = comparisonRef.current;
    if (!store || !id || !(camera instanceof OrthographicCamera)) return;
    comparisonUnitsPerPixelRef.current = (camera.right - camera.left) / (camera.zoom * comparisonMetricsRef.current.width);
    store.publishView(id);
  }, [camera]);
  const restoreControlsTarget = useCallback(() => {
    controlsRef.current?.target.set(...cameraInteractionStore.getPanSnapshot()).add(CAMERA_TARGET);
  }, [cameraInteractionStore]);
  const publishCameraPanSnapshot = useCallback(() => {
    const target = controlsRef.current?.target;
    if (target) cameraInteractionStore.setPanSnapshot([target.x - CAMERA_TARGET.x, target.y - CAMERA_TARGET.y, target.z - CAMERA_TARGET.z]);
  }, [cameraInteractionStore]);

  useEffect(() => cameraInteractionStore.subscribePanCommand(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    clearCameraControlsMotion(controls);
    const target = new Vector3(...cameraInteractionStore.getPanSnapshot()).add(CAMERA_TARGET);
    camera.position.add(target.clone().sub(controls.target));
    controls.target.copy(target);
    camera.updateMatrixWorld();
    requestFrame();
  }), [camera, cameraInteractionStore, requestFrame]);

  const setCameraAnimationActive = useCallback(
    (isActive: boolean, forceNotify = false) => {
      if (isCameraAnimationActiveRef.current === isActive && !forceNotify) {
        return;
      }

      isCameraAnimationActiveRef.current = isActive;
      onCameraCommandAnimationActiveChangeRef.current?.(isActive);
    },
    [],
  );

  const getCameraZoomSnapshot = useCallback(
    () => (camera instanceof OrthographicCamera ? camera.zoom : 0),
    [camera],
  );

  const publishCameraViewScaleSnapshot = useCallback(
    (nextViewScale: number) => {
      if (Math.abs(nextViewScale - syncedViewScaleRef.current) < VIEW_SCALE_SYNC_EPSILON) {
        return;
      }

      syncedViewScaleRef.current = nextViewScale;
      cameraInteractionStore.setViewScaleSnapshot(nextViewScale);
    },
    [cameraInteractionStore],
  );

  const startCameraControlsInteraction = useCallback(() => {
    const interaction = cameraControlsInteractionRef.current;
    interaction.idleFrames = 0;
    interaction.lastQuaternion.copy(camera.quaternion);
    interaction.lastZoom = getCameraZoomSnapshot();
    interaction.waitingForIdle = false;

    if (interaction.active) {
      requestFrame();
      return;
    }

    interaction.active = true;
    onCameraControlsInteractionActiveChangeRef.current?.(true);
    requestFrame();
  }, [camera, getCameraZoomSnapshot, requestFrame]);

  const finishCameraControlsInteraction = useCallback(() => {
    const interaction = cameraControlsInteractionRef.current;
    if (!interaction.active) {
      return;
    }

    interaction.active = false;
    interaction.idleFrames = 0;
    interaction.lastQuaternion.copy(camera.quaternion);
    interaction.lastZoom = getCameraZoomSnapshot();
    interaction.waitingForIdle = false;
    onCameraControlsInteractionActiveChangeRef.current?.(
      false,
      camera.quaternion.clone(),
    );
  }, [camera, getCameraZoomSnapshot]);

  const requestCameraControlsInteractionFinish = useCallback(() => {
    const interaction = cameraControlsInteractionRef.current;
    if (!interaction.active) {
      return;
    }

    interaction.idleFrames = 0;
    interaction.lastQuaternion.copy(camera.quaternion);
    interaction.lastZoom = getCameraZoomSnapshot();
    interaction.waitingForIdle = true;
    requestFrame();
  }, [camera, getCameraZoomSnapshot, requestFrame]);

  const settleCameraControlsInteraction = useCallback(() => {
    const interaction = cameraControlsInteractionRef.current;
    if (!interaction.active || !interaction.waitingForIdle) {
      return;
    }

    const nextZoom = getCameraZoomSnapshot();
    const orientationDelta = interaction.lastQuaternion.angleTo(camera.quaternion);
    const zoomDelta = Math.abs(nextZoom - interaction.lastZoom);
    interaction.lastQuaternion.copy(camera.quaternion);
    interaction.lastZoom = nextZoom;

    if (
      orientationDelta > CAMERA_CONTROLS_IDLE_EPSILON_RADIANS ||
      zoomDelta > CAMERA_CONTROLS_IDLE_ZOOM_EPSILON
    ) {
      interaction.idleFrames = 0;
      return;
    }

    interaction.idleFrames += 1;
    if (interaction.idleFrames >= CAMERA_CONTROLS_IDLE_FRAMES) {
      finishCameraControlsInteraction();
    }
  }, [camera, finishCameraControlsInteraction, getCameraZoomSnapshot]);

  useLayoutEffect(() => {
    const commandChanged = cameraCommandVersion !== lastCameraCommandVersionRef.current;
    const animatedCommandChanged =
      cameraAnimatedCommandVersion !== lastCameraAnimatedCommandVersionRef.current;
    const resetChanged = resetCounter !== lastResetCounterRef.current;
    if (resetChanged) cameraInteractionStore.setPanSnapshot([0, 0, 0]);
    const layoutSpanChanged = Math.abs(layout.span - lastLayoutSpanRef.current) > 1e-8;
    const shouldAnimate =
      hasAppliedInitialPoseRef.current &&
      commandChanged &&
      animatedCommandChanged &&
      !resetChanged &&
      !layoutSpanChanged &&
      !reducedMotion;
    const localCommandChanged = commandChanged || resetChanged;
    if (localCommandChanged) {
      activateComparisonView();
      clearCameraControlsMotion(controlsRef.current);
    }

    lastCameraCommandVersionRef.current = cameraCommandVersion;
    lastCameraAnimatedCommandVersionRef.current = cameraAnimatedCommandVersion;
    lastResetCounterRef.current = resetCounter;
    lastLayoutSpanRef.current = layout.span;
    hasAppliedInitialPoseRef.current = true;

    trackballDirectFlushPendingRef.current = false;
    trackballInertiaPendingRef.current = false;

    if (shouldAnimate) {
      cameraAnimationRef.current = createCameraPoseAnimation(camera, cameraPoseRef.current, layout.span, cameraInteractionStore.getPanSnapshot());
      setCameraAnimationActive(true);
      requestFrame();
      return;
    }

    cameraAnimationRef.current = null;
    setCameraAnimationActive(false, commandChanged && animatedCommandChanged);
    applyStandardCameraPose(camera, cameraPoseRef.current, layout.span, cameraInteractionStore.getPanSnapshot());
    restoreControlsTarget();
    controlsRef.current?.update();
    if (localCommandChanged) publishComparisonView();
    requestFrame();
  }, [
    camera,
    cameraInteractionStore,
    activateComparisonView,
    cameraAnimatedCommandVersion,
    cameraCommandVersion,
    layout.span,
    requestFrame,
    publishComparisonView,
    restoreControlsTarget,
    resetCounter,
    reducedMotion,
    setCameraAnimationActive,
  ]);

  useLayoutEffect(() => {
    const nextViewScale = cameraInteractionStore.getViewScaleSnapshot();
    syncedViewScaleRef.current = nextViewScale;

    if (!(camera instanceof OrthographicCamera)) {
      return;
    }
    const comparisonMode = Boolean(comparisonCameraStore && comparisonViewId);
    const enteringComparison = comparisonMode && !comparisonModeRef.current;
    comparisonModeRef.current = comparisonMode;
    if (enteringComparison) {
      comparisonUnitsPerPixelRef.current = null;
      comparisonEntryViewScaleRef.current = nextViewScale;
      const rectangle = gl.domElement.getBoundingClientRect();
      comparisonFitPendingRef.current = rectangle.width > 0 && rectangle.height > 0
        && (Math.abs(rectangle.width - size.width) > 1 || Math.abs(rectangle.height - size.height) > 1);
    }
    if (comparisonMode && comparisonFitPendingRef.current) {
      const rectangle = gl.domElement.getBoundingClientRect();
      if (Math.abs(rectangle.width - size.width) <= 1 && Math.abs(rectangle.height - size.height) <= 1) {
        // A split-pane CSS change precedes ResizeObserver; fit once at its final size before linking scale.
        comparisonFitPendingRef.current = false;
        comparisonUnitsPerPixelRef.current = null;
      }
    }

    appliedProjectionRef.current = { width: size.width, height: size.height, safeArea: effectiveSafeArea, fitZoom };
    syncOrthographicFrustumToZoom(
      camera,
      size.width,
      size.height,
      comparisonCameraStore && comparisonViewId && comparisonUnitsPerPixelRef.current
        ? 1 / comparisonUnitsPerPixelRef.current
        : fitZoom * (comparisonMode ? comparisonEntryViewScaleRef.current : nextViewScale),
      effectiveSafeArea,
    );
    if (comparisonMode && !comparisonFitPendingRef.current) publishComparisonView();
    requestFrame();
  }, [
    camera,
    cameraInteractionStore,
    comparisonCameraStore,
    comparisonViewId,
    effectiveSafeArea,
    fitZoom,
    gl.domElement,
    publishComparisonView,
    requestFrame,
    size.height,
    size.width,
  ]);

  useEffect(() => {
    if (!(camera instanceof OrthographicCamera)) {
      return;
    }

    return cameraInteractionStore.subscribeViewScaleCommand(() => {
      activateComparisonView();
      const { viewScale: commandViewScale } =
        cameraInteractionStore.getViewScaleCommandSnapshot();
      const nextViewScale = clampViewScale(commandViewScale);
      syncedViewScaleRef.current = nextViewScale;
      const metrics = appliedProjectionRef.current;
      syncOrthographicFrustumToZoom(
        camera,
        metrics.width,
        metrics.height,
        metrics.fitZoom * nextViewScale,
        metrics.safeArea,
      );
      publishComparisonView();
      requestFrame();
    });
  }, [
    camera,
    activateComparisonView,
    cameraInteractionStore,
    requestFrame,
    publishComparisonView,
  ]);

  useEffect(() => {
    return cameraInteractionStore.subscribeCameraStateCommand(() => {
      const { cameraState } = cameraInteractionStore.getCameraStateCommandSnapshot();
      if (!cameraState) {
        return;
      }
      activateComparisonView();

      cameraAnimationRef.current = null;
      clearCameraControlsMotion(controlsRef.current);
      setCameraAnimationActive(false);
      applyStandardCameraPose(
        camera,
        computeCrystalCameraPose(cellVectors, cameraState, layout.span),
        layout.span,
        cameraInteractionStore.getPanSnapshot(),
      );
      restoreControlsTarget();
      trackballDirectFlushPendingRef.current = false;
      trackballInertiaPendingRef.current = false;
      controlsRef.current?.update();
      publishComparisonView();
      requestFrame();
    });
  }, [
    camera,
    activateComparisonView,
    cameraInteractionStore,
    cellVectors,
    layout.span,
    requestFrame,
    publishComparisonView,
    restoreControlsTarget,
    setCameraAnimationActive,
  ]);

  useEffect(() => {
    const controls =
      interactionMode === "trackball"
        ? new TrackballControls(camera, gl.domElement)
        : new OrbitControls(camera, gl.domElement);
    function handleControlsStart() {
      activateComparisonView();
      if (isCameraDirectionControlsInteraction(controls)) {
        startCameraControlsInteraction();
      }
      cameraAnimationRef.current = null;
      setCameraAnimationActive(false);
      requestFrame();
    }
    function handleControlsEnd() {
      requestCameraControlsInteractionFinish();
      requestFrame();
    }
    const activePointerIds = new Set<number>();
    function markTrackballEventFlushed() {
      if (!effectiveMouseInertia && controls instanceof TrackballControls) {
        trackballDirectFlushPendingRef.current = true;
      }
    }
    function handlePointerDown(event: PointerEvent) {
      activePointerIds.add(event.pointerId);
      requestFrame();
    }
    function handlePointerMove() {
      if (activePointerIds.size > 0) {
        if (!effectiveMouseInertia && controls instanceof TrackballControls) {
          flushTrackballControlsAfterPointerMove();
        } else {
          requestFrame();
        }
      }
    }
    function handlePointerEnd(event: PointerEvent) {
      activePointerIds.delete(event.pointerId);
      requestFrame();
    }
    function handleLostPointerCapture() {
      activePointerIds.clear();
      requestFrame();
    }
    function handleWheel() {
      if (!effectiveMouseInertia) {
        flushTrackballControlsAfterWheel();
      }
      requestFrame();
    }
    function flushTrackballControlsAfterPointerMove() {
      if (!(controls instanceof TrackballControls)) {
        return;
      }

      queueMicrotask(() => {
        if (controlsRef.current !== controls || activePointerIds.size === 0) {
          return;
        }

        // Trackball adds its active pointermove listener after ours, on
        // pointerdown. Queueing lets Trackball record this event's latest
        // delta before the no-inertia direct flush.
        controls.update();
        markTrackballEventFlushed();
        requestFrame();
      });
    }
    function flushTrackballControlsAfterWheel() {
      if (!(controls instanceof TrackballControls)) {
        return;
      }

      controls.update();
      markTrackballEventFlushed();
    }

    configureCameraControls(
      controls,
      interactionMode,
      interactionLocked,
      fitZoom,
      dragSensitivity,
      effectiveMouseInertia,
      Boolean(comparisonCameraStore && comparisonViewId),
    );
    trackballDirectFlushPendingRef.current = false;
    trackballInertiaPendingRef.current = false;
    controls.target.set(...cameraInteractionStore.getPanSnapshot()).add(CAMERA_TARGET);
    resizeCameraControls(controls);
    controls.addEventListener("start", handleControlsStart);
    controls.addEventListener("end", handleControlsEnd);
    gl.domElement.addEventListener("lostpointercapture", handleLostPointerCapture);
    gl.domElement.addEventListener("pointercancel", handlePointerEnd);
    gl.domElement.addEventListener("pointerdown", handlePointerDown);
    gl.domElement.addEventListener("pointermove", handlePointerMove);
    gl.domElement.addEventListener("pointerup", handlePointerEnd);
    gl.domElement.addEventListener("wheel", handleWheel);
    gl.domElement.addEventListener("pointerdown", activateComparisonView, true);
    gl.domElement.addEventListener("wheel", activateComparisonView, true);
    controls.update();
    requestFrame();
    controlsRef.current = controls;

    return () => {
      controls.removeEventListener("start", handleControlsStart);
      controls.removeEventListener("end", handleControlsEnd);
      gl.domElement.removeEventListener("lostpointercapture", handleLostPointerCapture);
      gl.domElement.removeEventListener("pointercancel", handlePointerEnd);
      gl.domElement.removeEventListener("pointerdown", handlePointerDown);
      gl.domElement.removeEventListener("pointermove", handlePointerMove);
      gl.domElement.removeEventListener("pointerup", handlePointerEnd);
      gl.domElement.removeEventListener("wheel", handleWheel);
      gl.domElement.removeEventListener("pointerdown", activateComparisonView, true);
      gl.domElement.removeEventListener("wheel", activateComparisonView, true);
      finishCameraControlsInteraction();
      controls.dispose();
      if (controlsRef.current === controls) {
        controlsRef.current = null;
      }
    };
  }, [
    camera,
    activateComparisonView,
    comparisonCameraStore,
    comparisonViewId,
    cameraInteractionStore,
    finishCameraControlsInteraction,
    gl.domElement,
    dragSensitivity,
    interactionMode,
    effectiveMouseInertia,
    requestFrame,
    requestCameraControlsInteractionFinish,
    resetCounter,
    setCameraAnimationActive,
    startCameraControlsInteraction,
  ]);

  useEffect(() => {
    return () => setCameraAnimationActive(false);
  }, [setCameraAnimationActive]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) {
      return;
    }

    configureCameraControls(
      controls,
      interactionMode,
      interactionLocked,
      fitZoom,
      dragSensitivity,
      effectiveMouseInertia,
      Boolean(comparisonCameraStore && comparisonViewId),
    );
    trackballDirectFlushPendingRef.current = false;
    trackballInertiaPendingRef.current = false;
    restoreControlsTarget();
    controls.update();
    requestFrame();
  }, [
    comparisonCameraStore,
    comparisonViewId,
    dragSensitivity,
    fitZoom,
    interactionLocked,
    interactionMode,
    effectiveMouseInertia,
    requestFrame,
    resetCounter,
    restoreControlsTarget,
  ]);

  useEffect(() => {
    resizeCameraControls(controlsRef.current);
    requestFrame();
  }, [requestFrame, size.height, size.width]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls || !(camera instanceof OrthographicCamera)) {
      return;
    }
    const orthographicCamera = camera;

    function handleControlsChange() {
      const metrics = appliedProjectionRef.current;
      const nextViewScale = syncOrthographicFrustumToCameraZoom(
        orthographicCamera,
        metrics.fitZoom,
        metrics.width,
        metrics.height,
        metrics.safeArea,
        Boolean(comparisonRef.current.store && comparisonRef.current.id),
      );

      publishCameraViewScaleSnapshot(nextViewScale);
      publishCameraPanSnapshot();
      publishComparisonView();
      requestFrame();
    }

    controls.addEventListener("change", handleControlsChange);
    return () => controls.removeEventListener("change", handleControlsChange);
  }, [
    camera,
    comparisonCameraStore,
    comparisonViewId,
    dragSensitivity,
    effectiveMouseInertia,
    interactionMode,
    publishCameraViewScaleSnapshot,
    publishCameraPanSnapshot,
    publishComparisonView,
    requestFrame,
    resetCounter,
  ]);

  useEffect(() => {
    if (!comparisonCameraStore || !comparisonViewId || !(camera instanceof OrthographicCamera)) return;
    const unregister = comparisonCameraStore.registerView(comparisonViewId, {
      readSnapshot: () => ({
        quaternion: camera.quaternion.toArray(),
        worldUnitsPerPixel: (camera.right - camera.left) / (camera.zoom * comparisonMetricsRef.current.width),
      }),
      stopMotion: () => {
        cameraAnimationRef.current = null;
        trackballDirectFlushPendingRef.current = false;
        trackballInertiaPendingRef.current = false;
        clearCameraControlsMotion(controlsRef.current);
        setCameraAnimationActive(false);
        finishCameraControlsInteraction();
      },
      applySnapshot: snapshot => {
        const controls = controlsRef.current;
        if (snapshot.quaternion) {
          const target = controls?.target ?? CAMERA_TARGET;
          const distance = Math.max(1e-6, camera.position.distanceTo(target));
          camera.quaternion.fromArray(snapshot.quaternion);
          camera.position.copy(CAMERA_LOCAL_FORWARD).applyQuaternion(camera.quaternion).multiplyScalar(distance).add(target);
          camera.up.copy(CAMERA_LOCAL_UP).applyQuaternion(camera.quaternion);
        }
        if (snapshot.worldUnitsPerPixel !== undefined) {
          const metrics = comparisonMetricsRef.current;
          comparisonUnitsPerPixelRef.current = snapshot.worldUnitsPerPixel;
          syncOrthographicFrustumToZoom(camera, metrics.width, metrics.height, 1 / snapshot.worldUnitsPerPixel, metrics.safeArea);
        }
        camera.updateMatrixWorld();
        publishCameraViewScaleSnapshot(camera.zoom / comparisonMetricsRef.current.fitZoom);
        requestFrame();
      },
    });
    comparisonUnitsPerPixelRef.current = (camera.right - camera.left) / (camera.zoom * comparisonMetricsRef.current.width);
    return () => {
      unregister();
      comparisonUnitsPerPixelRef.current = null;
    };
  }, [camera, comparisonCameraStore, comparisonViewId, layout.span,
    finishCameraControlsInteraction, publishCameraViewScaleSnapshot, requestFrame, setCameraAnimationActive]);

  useFrame(() => {
    const previousFrameQuaternion = lastFrameCameraQuaternionRef.current.copy(
      camera.quaternion,
    );
    const previousFrameZoom = getCameraZoomSnapshot();
    const animation = cameraAnimationRef.current;
    let controlsUpdated = false;
    if (animation) {
      const isComplete = applyCameraPoseAnimationFrame(camera, animation, performance.now());
      if (isComplete) {
        cameraAnimationRef.current = null;
        setCameraAnimationActive(false);
      }
      restoreControlsTarget();
      trackballDirectFlushPendingRef.current = false;
      trackballInertiaPendingRef.current = false;
      controlsRef.current?.update();
      controlsUpdated = true;
    } else if (!comparisonRef.current.store || !comparisonRef.current.id
      || comparisonRef.current.store.getActiveView() === comparisonRef.current.id) {
      controlsUpdated = updateCameraControlsForFrame(
        controlsRef.current,
        trackballDirectFlushPendingRef,
      );
    }

    if (camera instanceof OrthographicCamera) {
      const metrics = appliedProjectionRef.current;
      const nextViewScale = syncOrthographicFrustumToCameraZoom(
        camera,
        metrics.fitZoom,
        metrics.width,
        metrics.height,
        metrics.safeArea,
        Boolean(comparisonRef.current.store && comparisonRef.current.id),
      );
      publishCameraViewScaleSnapshot(nextViewScale);
    }

    settleCameraControlsInteraction();
    publishCameraPanSnapshot();
    publishComparisonView();

    const cameraMoved =
      previousFrameQuaternion.angleTo(camera.quaternion) >
        CAMERA_CONTROLS_IDLE_EPSILON_RADIANS ||
      Math.abs(getCameraZoomSnapshot() - previousFrameZoom) >
        CAMERA_CONTROLS_IDLE_ZOOM_EPSILON;
    const hasPendingTrackballInertia =
      effectiveMouseInertia &&
      controlsRef.current instanceof TrackballControls &&
      trackballInertiaPendingRef.current;
    if (hasPendingTrackballInertia && controlsUpdated && !cameraMoved) {
      trackballInertiaPendingRef.current = false;
    }
    if (cameraMoved) {
      trackballInertiaPendingRef.current = true;
    }
    if (cameraMoved || cameraAnimationRef.current || hasPendingTrackballInertia) {
      requestFrame();
    }
  });

  return null;
}

interface CameraPoseAnimation {
  pan: VectorTuple;
  durationMs: number;
  startDistance: number;
  startQuaternion: Quaternion;
  startTimeMs: number;
  targetDistance: number;
  targetPose: CrystalCameraPose;
  targetQuaternion: Quaternion;
  targetSpan: number;
}

function createCameraPoseAnimation(
  camera: { position: Vector3; quaternion: Quaternion },
  targetPose: CrystalCameraPose,
  targetSpan: number,
  pan: VectorTuple,
): CameraPoseAnimation {
  return {
    pan: [...pan],
    durationMs: CAMERA_COMMAND_ANIMATION_DURATION_MS,
    startDistance: Math.max(camera.position.distanceTo(new Vector3(...pan).add(CAMERA_TARGET)), 1e-6),
    startQuaternion: camera.quaternion.clone().normalize(),
    startTimeMs: performance.now(),
    targetDistance: Math.max(targetPose.distance, 1e-6),
    targetPose,
    targetQuaternion: targetPose.quaternion.clone().normalize(),
    targetSpan,
  };
}

function applyCameraPoseAnimationFrame(
  camera: {
    lookAt: (x: number, y: number, z: number) => void;
    position: Vector3;
    quaternion: Quaternion;
    up: Vector3;
  },
  animation: CameraPoseAnimation,
  nowMs: number,
): boolean {
  const progress = Math.max(
    0,
    Math.min(1, (nowMs - animation.startTimeMs) / animation.durationMs),
  );

  if (progress >= 1) {
    applyStandardCameraPose(camera, animation.targetPose, animation.targetSpan, animation.pan);
    return true;
  }

  const easedProgress = easeOutCubic(progress);
  const quaternion = animation.startQuaternion.clone().slerp(
    animation.targetQuaternion,
    easedProgress,
  );
  const outward = CAMERA_LOCAL_FORWARD.clone().applyQuaternion(quaternion).normalize();
  const up = CAMERA_LOCAL_UP.clone().applyQuaternion(quaternion).normalize();
  const distance =
    animation.startDistance +
    (animation.targetDistance - animation.startDistance) * easedProgress;

  const target = new Vector3(...animation.pan).add(CAMERA_TARGET);
  camera.position.copy(outward.multiplyScalar(distance)).add(target);
  camera.up.copy(up);
  camera.lookAt(target.x, target.y, target.z);
  return false;
}

function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3;
}

function syncOrthographicFrustumToCameraZoom(
  camera: OrthographicCamera,
  fitZoom: number,
  width: number,
  height: number,
  safeArea: PreviewSafeArea,
  preservePhysicalScale = false,
): number {
  const nextViewScale = preservePhysicalScale ? camera.zoom / fitZoom : clampViewScale(camera.zoom / fitZoom);
  const nextZoom = fitZoom * nextViewScale;

  syncOrthographicFrustumToZoom(camera, width, height, nextZoom, safeArea);

  return nextViewScale;
}

function syncOrthographicFrustumToZoom(
  camera: OrthographicCamera,
  width: number,
  height: number,
  zoom: number,
  safeArea: PreviewSafeArea,
) {
  const frustum = computeOrthographicFrustum(width, height, zoom, safeArea);

  if (
    Math.abs(camera.zoom - zoom) > FRUSTUM_SYNC_EPSILON ||
    Math.abs(camera.left - frustum.left) > FRUSTUM_SYNC_EPSILON ||
    Math.abs(camera.right - frustum.right) > FRUSTUM_SYNC_EPSILON ||
    Math.abs(camera.top - frustum.top) > FRUSTUM_SYNC_EPSILON ||
    Math.abs(camera.bottom - frustum.bottom) > FRUSTUM_SYNC_EPSILON
  ) {
    applyOrthographicFrustum(camera, width, height, zoom, safeArea);
  }
}

function configureCameraControls(
  controls: CameraControls,
  interactionMode: InteractionMode,
  interactionLocked: boolean,
  fitZoom: number,
  dragSensitivity: number,
  mouseInertia: boolean,
  comparisonMode = false,
) {
  controls.enabled = !interactionLocked;
  controls.minZoom = comparisonMode ? 1e-6 : fitZoom * MIN_VIEW_SCALE;
  controls.maxZoom = comparisonMode ? 1e6 : fitZoom * MAX_VIEW_SCALE;

  if (interactionMode === "trackball" && controls instanceof TrackballControls) {
    const rotateResponseMultiplier = mouseInertia
      ? 1
      : TRACKBALL_NO_INERTIA_ROTATE_RESPONSE_MULTIPLIER;
    const zoomResponseMultiplier = mouseInertia
      ? 1
      : TRACKBALL_NO_INERTIA_ZOOM_RESPONSE_MULTIPLIER;
    controls.rotateSpeed =
      BASE_TRACKBALL_DRAG_SENSITIVITY * dragSensitivity * rotateResponseMultiplier;
    controls.zoomSpeed = TRACKBALL_ZOOM_SPEED * zoomResponseMultiplier;
    controls.dynamicDampingFactor = TRACKBALL_DYNAMIC_DAMPING_FACTOR;
    controls.staticMoving = !mouseInertia;
    controls.noPan = true;
    controls.noZoom = interactionLocked;
    controls.noRotate = interactionLocked;
    controls.mouseButtons.LEFT = MOUSE.ROTATE;
    controls.mouseButtons.MIDDLE = MOUSE.DOLLY;
    controls.mouseButtons.RIGHT = null;
    return;
  }

  if (interactionMode === "orbit" && controls instanceof OrbitControls) {
    controls.rotateSpeed = BASE_ORBIT_DRAG_SENSITIVITY * dragSensitivity;
    controls.enableDamping = false;
    controls.enablePan = false;
    controls.enableRotate = !interactionLocked;
    controls.enableZoom = !interactionLocked;
    controls.mouseButtons.LEFT = MOUSE.ROTATE;
    controls.mouseButtons.MIDDLE = MOUSE.DOLLY;
    controls.mouseButtons.RIGHT = null;
    controls.touches.ONE = TOUCH.ROTATE;
    controls.touches.TWO = TOUCH.DOLLY_ROTATE;
  }
}

function updateCameraControlsForFrame(
  controls: CameraControls | null,
  trackballDirectFlushPendingRef: { current: boolean },
) {
  if (!controls) {
    return false;
  }

  if (controls instanceof TrackballControls && trackballDirectFlushPendingRef.current) {
    trackballDirectFlushPendingRef.current = false;
    return false;
  }

  trackballDirectFlushPendingRef.current = false;
  controls.update();
  return true;
}

function clearCameraControlsMotion(controls: CameraControls | null) {
  if (!controls) return;
  // r171 exposes no stop-inertia API; clear only accumulated control deltas, preserving target and pose.
  const motion = controls as CameraControls & {
    _lastAngle?: number;
    _movePrev?: Vector2; _moveCurr?: Vector2;
    _zoomStart?: Vector2; _zoomEnd?: Vector2;
    _panStart?: Vector2; _panEnd?: Vector2;
    _touchZoomDistanceStart?: number; _touchZoomDistanceEnd?: number;
    _sphericalDelta?: Spherical; _scale?: number; _panOffset?: Vector3;
  };
  if (motion._lastAngle !== undefined) motion._lastAngle = 0;
  if (motion._moveCurr) motion._movePrev?.copy(motion._moveCurr);
  if (motion._zoomEnd) motion._zoomStart?.copy(motion._zoomEnd);
  if (motion._panEnd) motion._panStart?.copy(motion._panEnd);
  if (motion._touchZoomDistanceEnd !== undefined) motion._touchZoomDistanceStart = motion._touchZoomDistanceEnd;
  motion._sphericalDelta?.set(0, 0, 0);
  motion._panOffset?.set(0, 0, 0);
  if (motion._scale !== undefined) motion._scale = 1;
}

function resizeCameraControls(controls: CameraControls | null) {
  if (controls instanceof TrackballControls) {
    controls.handleResize();
  }
}

function isCameraDirectionControlsInteraction(controls: CameraControls): boolean {
  const stateSource = controls as CameraControlsStateSource;
  const state =
    stateSource.keyState !== undefined &&
    stateSource.keyState !== CAMERA_CONTROLS_STATE_NONE
      ? stateSource.keyState
      : stateSource.state;

  return (
    state === CAMERA_CONTROLS_STATE_ROTATE ||
    state === CAMERA_CONTROLS_STATE_TOUCH_ROTATE ||
    state === CAMERA_CONTROLS_STATE_ORBIT_TOUCH_DOLLY_ROTATE
  );
}

function applyStandardCameraPose(
  camera: { lookAt: (x: number, y: number, z: number) => void; position: Vector3; up: Vector3 },
  standardPose: StandardCameraPose,
  span: number,
  pan: VectorTuple,
) {
  const offset = new Vector3(...pan);
  camera.position.set(...standardPose.cameraPosition).add(offset);
  camera.up.set(...standardPose.cameraUp);
  const target = new Vector3(...standardPose.target).add(offset);
  camera.lookAt(target.x, target.y, target.z);

  if (camera instanceof OrthographicCamera) {
    camera.near = 0.01;
    camera.far = Math.max(1000, standardPose.distance + span * 8);
    camera.updateProjectionMatrix();
  }

}
