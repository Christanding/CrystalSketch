import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { Matrix4, OrthographicCamera, Vector2 } from "three";
import type { SceneSpec } from "../api/scene";
import type { ComponentOpacityState, StyleState, StructureLineWidthState, UnitCellLineStyle } from "../model";
import { isPhysicalMaterialPreset } from "../model/materialPresets";
import { IDLE_RENDER_PROGRESS, RENDER_QUALITY, type RenderProgress, type RenderSettings } from "../model/renderSettings";
import type { SceneLayout } from "./sceneLayout";
import type { PathTracingSession } from "./pathTracingRenderer";
import type { CrystalPathTraceScene, CrystalPathTraceSceneOptions } from "./pathTracingScene";
import { configureStudioScene, createStudioEnvironment } from "./studioEnvironment";

interface PreviewProps {
  scene: SceneSpec; style: StyleState; settings: RenderSettings; layout: SceneLayout;
  componentOpacity: ComponentOpacityState; showAtoms: boolean; showUnitCell: boolean;
  lightStrength: number; background: string; unitCellColor: string; structureLineWidth: StructureLineWidthState;
  unitCellLineStyle: UnitCellLineStyle;
  paused: boolean; restart: number; onProgress?: (progress: RenderProgress) => void;
  onVisibleChange: (visible: boolean) => void;
}

interface PreviewRuntime {
  sceneChanged(): void;
  lightingChanged(): void;
  pausedChanged(): void;
  exposureChanged(): void;
  checkView(): void;
}

export default function PathTracingPreview(props: PreviewProps) {
  const { gl, camera, invalidate } = useThree();
  const current = useRef(props);
  current.current = props;
  const live = useRef<PreviewRuntime | null>(null);
  const [sessionVersion, setSessionVersion] = useState(0);
  const snapshotStyle = useMemo(() => props.style, [props.style.materialPreset, props.style.physicalMaterial,
    props.style.atomRadius, props.style.atomRadiusModel, props.style.bondThickness, props.style.bondColor,
    props.style.bondColorMode, props.style.colorScheme, props.style.colorSchemeMode, props.style.customColormap,
    props.style.distinguishSimilarColors, props.style.polyhedronColors, props.style.objectStyles]);
  const geometryScene = useMemo(() => props.scene, [props.scene.atoms, props.scene.bonds, props.scene.polyhedra, props.scene.cell]);
  const traceable = isPhysicalMaterialPreset(props.style.materialPreset);

  useEffect(() => {
    if (!traceable) {
      current.current.onProgress?.({ ...IDLE_RENDER_PROGRESS, phase: "unsupported", message: "unsupported-material" });
      return;
    }
    const parent = gl.domElement.parentElement;
    if (!parent) return;
    const controller = new AbortController();
    const canvas = document.createElement("canvas");
    canvas.dataset.pathTracingPreview = "";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:none;";
    parent.insertBefore(canvas, gl.domElement);
    const previousStyle = { position: gl.domElement.style.position, zIndex: gl.domElement.style.zIndex };
    gl.domElement.style.position = "relative";
    gl.domElement.style.zIndex = "1";
    let session: PathTracingSession | null = null;
    let snapshot: CrystalPathTraceScene | null = null;
    let environment: ReturnType<typeof createStudioEnvironment> | null = null;
    let environmentPreset: RenderSettings["studio"] | null = null;
    let inFlight: Promise<void> | null = null;
    let animation = 0, timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0, sceneVersion = 0, elapsedMs = 0, reportedAt = 0, lastTickAt = 0, presentedAt = 0;
    let gpuWorkPending = false;
    let visible = false, interacting = false, preparing = false, pendingScene = false;
    let dirtyCamera = false, dirtyLighting = false, builtLineScale = 0;
    const world = new Matrix4(), projection = new Matrix4(), drawingSize = new Vector2();
    const target = RENDER_QUALITY[props.settings.quality].previewSamples;
    const lineScale = () => (camera instanceof OrthographicCamera
      ? (camera.top - camera.bottom) / camera.zoom : current.current.layout.span) / Math.max(1, gl.domElement.clientHeight);
    const dimensions = () => {
      gl.getDrawingBufferSize(drawingSize);
      const scale = Math.min(RENDER_QUALITY[current.current.settings.quality].previewScale,
        1600 / Math.max(drawingSize.x, drawingSize.y), Math.sqrt(1_500_000 / (drawingSize.x * drawingSize.y)));
      return [Math.max(1, Math.round(drawingSize.x * scale)), Math.max(1, Math.round(drawingSize.y * scale))] as const;
    };
    const setVisible = (next: boolean) => {
      if (visible === next) return;
      visible = next;
      canvas.style.display = next ? "block" : "none";
      current.current.onVisibleChange(next);
      invalidate();
    };
    const report = (phase: RenderProgress["phase"], message?: string, force = false) => {
      const now = performance.now();
      if (!force && now - reportedAt < 180) return;
      reportedAt = now;
      current.current.onProgress?.({ phase, samples: dirtyCamera || dirtyLighting || pendingScene ? 0 : Math.floor(session?.samples ?? 0),
        targetSamples: target, elapsedMs, ...(message ? { message } : {}) });
    };
    const stop = () => {
      generation++;
      cancelAnimationFrame(animation); animation = 0; lastTickAt = 0;
      clearTimeout(timer); timer = undefined;
    };
    const fail = (error: unknown) => {
      if (controller.signal.aborted) return;
      stop(); setVisible(false);
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      report(code === "geometry-limit" ? "unsupported" : "error",
        code === "geometry-limit" ? "scene-too-large" : error instanceof Error ? error.message : "render-failed", true);
      controller.abort(error);
      session?.dispose(); session = null; live.current = null;
    };
    const replaceSession = () => {
      stop(); controller.abort();
      session?.dispose(); session = null; live.current = null;
      // Changed topology/triangle geometry keeps the original fresh-context path.
      // A disposed WebGL context cannot be immediately reused on the same canvas.
      setSessionVersion(value => value + 1);
    };
    const canRender = () => Boolean(session && !controller.signal.aborted && !document.hidden
      && !current.current.paused && !interacting && !preparing && !pendingScene && !dirtyCamera && !dirtyLighting);
    const wake = () => {
      if (!canRender() || inFlight) return;
      if (session!.samples >= 8) setVisible(true);
      if (session!.samples >= target) { report("complete", undefined, true); return; }
      if (!animation && timer === undefined) {
        if (!lastTickAt) lastTickAt = performance.now();
        animation = requestAnimationFrame(tick);
      }
    };
    const tick = () => {
      animation = 0;
      if (!canRender() || inFlight) return;
      const version = generation, started = performance.now();
      if (lastTickAt) elapsedMs += started - lastTickAt;
      lastTickAt = started;
      const isCurrent = () => version === generation && canRender();
      const work = (async () => {
        const [width, height] = dimensions();
        session!.resize(width, height);
        gpuWorkPending = true;
        const samples = session!.renderSample();
        if (samples >= 8 && (!visible || samples >= target || started - presentedAt >= 1000 / 30)) {
          if (session!.present()) presentedAt = started;
        }
        if (samples >= target) {
          await session!.waitForGpu();
          gpuWorkPending = false;
        }
        if (!isCurrent()) return;
        if (samples >= target) { elapsedMs += performance.now() - started; lastTickAt = 0; }
        if (samples >= 8) setVisible(true);
        report(samples >= target ? "complete" : "rendering", undefined, samples >= target);
      })();
      inFlight = work;
      void work.catch(error => {
        // Only a superseded task's expected cancellation is ignorable. GPU errors
        // remain fatal even if pause/navigation changed the generation meanwhile.
        if (!(error instanceof DOMException && error.name === "AbortError" && !isCurrent())) fail(error);
      }).finally(() => {
        if (inFlight === work) inFlight = null;
        wake();
      });
    };
    const configureLighting = (scene: CrystalPathTraceScene["scene"]) => {
      const latest = current.current;
      if (!environment || environmentPreset !== latest.settings.studio) {
        const previous = environment;
        environment = createStudioEnvironment(latest.settings.studio);
        environmentPreset = latest.settings.studio;
        previous?.dispose();
      }
      scene.background = null;
      scene.environment = environment;
      scene.userData.studioRadius = latest.layout.span;
      configureStudioScene(scene, camera, latest.settings, latest.style, latest.lightStrength);
      canvas.style.backgroundColor = latest.background;
    };
    const scheduleSync = (delay: number) => {
      clearTimeout(timer);
      timer = undefined;
      if (controller.signal.aborted || document.hidden || interacting) return;
      timer = setTimeout(() => { timer = undefined; void synchronize().catch(fail); }, delay);
    };
    const synchronize = async () => {
      if (preparing || controller.signal.aborted || interacting) return;
      if (!pendingScene && !dirtyCamera && !dirtyLighting) { wake(); return; }
      preparing = true;
      let nextSnapshot: CrystalPathTraceScene | null = null;
      try {
        // The original one-tile-per-frame cadence won the GPU A/B tests. Drain
        // its queued work before mutating textures/materials for another view.
        await inFlight?.catch(() => {});
        controller.signal.throwIfAborted();
        if (gpuWorkPending && session) { await session.waitForGpu(); gpuWorkPending = false; }
        controller.signal.throwIfAborted();
        if (pendingScene) {
          pendingScene = false;
          const version = sceneVersion, latest = current.current, scale = lineScale();
          report(latest.paused ? "paused" : "preparing", undefined, true);
          const [{ createCrystalPathTraceScene }, { createPathTracingSession }] = await Promise.all([
            import("./pathTracingScene"), import("./pathTracingRenderer"),
          ]);
          const nextOptions: CrystalPathTraceSceneOptions = { scene: latest.scene, style: latest.style,
            componentOpacity: latest.componentOpacity, groupPosition: latest.layout.groupPosition,
            showAtoms: latest.showAtoms, showUnitCell: latest.showUnitCell, unitCellColor: latest.unitCellColor,
            unitCellLineStyle: latest.unitCellLineStyle,
            unitCellRadius: scale * latest.structureLineWidth.unitCell / 2,
            polyhedronEdgeRadius: scale * latest.structureLineWidth.polyhedra / 2,
            quality: latest.settings.quality, signal: controller.signal };
          if (session && snapshot?.updateAppearance(nextOptions)) {
            configureLighting(snapshot.scene);
            if (!session.updateScene(snapshot.scene)) { replaceSession(); return; }
          } else {
            nextSnapshot = await createCrystalPathTraceScene(nextOptions);
            controller.signal.throwIfAborted();
            if (version !== sceneVersion) return;
            configureLighting(nextSnapshot.scene);
            if (session) {
              if (!session.updateScene(nextSnapshot.scene)) { replaceSession(); return; }
            } else {
              const [width, height] = dimensions();
              session = await createPathTracingSession({ canvas, scene: nextSnapshot.scene, camera,
                width, height, settings: latest.settings, signal: controller.signal });
            }
            controller.signal.throwIfAborted();
            const previous = snapshot;
            snapshot = nextSnapshot; nextSnapshot = null;
            previous?.dispose();
          }
          builtLineScale = scale;
        }
        if (!session || !snapshot || pendingScene) return;
        const viewVersion = generation, scale = lineScale(), latest = current.current;
        if (builtLineScale > 0 && Math.abs(scale / builtLineScale - 1) > 1e-3) {
          snapshot.updateLineRadii(scale * latest.structureLineWidth.unitCell / 2,
            scale * latest.structureLineWidth.polyhedra / 2);
          if (!session.updateScene(snapshot.scene)) { replaceSession(); return; }
          builtLineScale = scale;
        }
        controller.signal.throwIfAborted();
        session.updateCamera(camera);
        configureLighting(snapshot.scene);
        session.updateLighting();
        session.setExposure(current.current.settings.exposure);
        world.copy(camera.matrixWorld); projection.copy(camera.projectionMatrix);
        elapsedMs = 0;
        if (viewVersion === generation) { dirtyCamera = false; dirtyLighting = false; }
        if (current.current.paused) report("paused", undefined, true);
      } finally {
        nextSnapshot?.dispose();
        preparing = false;
        if (!controller.signal.aborted) {
          if (pendingScene) scheduleSync(0);
          else if (dirtyCamera || dirtyLighting) scheduleSync(dirtyCamera ? 450 : 0);
          else { clearTimeout(timer); timer = undefined; wake(); }
        }
      }
    };
    const cameraChanged = () => {
      const firstChange = !dirtyCamera;
      dirtyCamera = true;
      stop(); setVisible(false);
      if (firstChange) { elapsedMs = 0; report(current.current.paused ? "paused" : "preparing", "resampling", true); }
      scheduleSync(pendingScene ? 0 : 450);
    };
    const pointerDown = () => { interacting = true; stop(); setVisible(false); };
    const pointerUp = () => {
      if (!interacting) return;
      interacting = false;
      if (pendingScene || dirtyCamera || dirtyLighting) scheduleSync(dirtyCamera ? 450 : 0);
      else wake();
    };
    const visibility = () => {
      if (document.hidden) stop();
      else if (pendingScene || dirtyCamera || dirtyLighting) scheduleSync(dirtyCamera ? 450 : 0);
      else wake();
    };
    live.current = {
      sceneChanged() {
        pendingScene = true; sceneVersion++; stop(); setVisible(false); elapsedMs = 0;
        report(current.current.paused ? "paused" : "preparing", undefined, true); scheduleSync(0);
      },
      lightingChanged() {
        dirtyLighting = true; stop(); setVisible(false); elapsedMs = 0;
        report(current.current.paused ? "paused" : "preparing", undefined, true); scheduleSync(0);
      },
      pausedChanged() {
        stop();
        if (current.current.paused) {
          try { session?.present(); report("paused", undefined, true); } catch (error) { fail(error); }
        }
        else if (pendingScene || dirtyCamera || dirtyLighting) scheduleSync(dirtyCamera ? 450 : 0);
        else wake();
      },
      exposureChanged() {
        try { session?.setExposure(current.current.settings.exposure); } catch (error) { fail(error); }
      },
      checkView() {
        camera.updateMatrixWorld();
        const [width, height] = dimensions();
        if (!world.equals(camera.matrixWorld) || !projection.equals(camera.projectionMatrix)
          || session && !preparing && (canvas.width !== width || canvas.height !== height)) {
          world.copy(camera.matrixWorld); projection.copy(camera.projectionMatrix);
          cameraChanged();
        }
      },
    };
    gl.domElement.addEventListener("pointerdown", pointerDown);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerUp);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stop(); controller.abort(); live.current = null;
      session?.dispose(); snapshot?.dispose(); environment?.dispose();
      canvas.remove();
      gl.domElement.style.position = previousStyle.position;
      gl.domElement.style.zIndex = previousStyle.zIndex;
      gl.domElement.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerUp);
      document.removeEventListener("visibilitychange", visibility);
      current.current.onVisibleChange(false);
      invalidate();
    };
  }, [gl, camera, traceable, props.settings.quality, props.restart, sessionVersion, invalidate]);

  useEffect(() => { live.current?.sceneChanged(); }, [gl, camera, traceable, props.settings.quality, props.restart, sessionVersion,
    geometryScene, snapshotStyle, props.componentOpacity, props.layout.groupPosition, props.layout.span,
    props.showAtoms, props.showUnitCell, props.unitCellColor, props.structureLineWidth, props.unitCellLineStyle]);
  useEffect(() => { live.current?.lightingChanged(); }, [props.settings.studio, props.settings.environmentRotation,
    props.style.lightDirection, props.style.ambientLightIntensity, props.style.mainLightIntensity, props.lightStrength, props.background]);
  useEffect(() => { live.current?.pausedChanged(); }, [props.paused]);
  useEffect(() => { live.current?.exposureChanged(); }, [props.settings.exposure]);
  useFrame(() => { live.current?.checkView(); }, 2);
  return null;
}
