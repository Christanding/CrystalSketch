import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  type CSSProperties,
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CanvasTexture,
  Color,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  OrthographicCamera,
  Quaternion,
  Vector3,
} from "three";

import { PREVIEW_THEME_COLORS } from "../theme/previewTheme";
import { DEFAULT_CRYSTAL_AXIS_MATERIAL, type CrystalAxisColors, type CrystalAxisMaterialState } from "../model/appearance";
import { FIGURE_FONT_FAMILY, ensureFigureFonts } from "../theme/fonts";
import type { ResolvedTheme } from "../theme/themePreference";
import type { CameraOrientationRef } from "./LatticeScene";
import type { CameraPoseSnapshot } from "./cameraPose";
import { CrystalAxisLighting, CrystalAxisMaterial } from "./CrystalAxisMaterial";
import {
  computeOrientationGizmoAxes,
  type OrientationGizmoAxisLabel,
  type OrientationGizmoAxisSpec,
} from "./orientationGizmoMath";
import { pickOrientationGizmoAxis } from "./orientationGizmoHitTesting";
import type { VectorTuple } from "./viewMath";

export const ORIENTATION_GIZMO_CAMERA_POSITION: VectorTuple = [0, 0, 5];
const BASE_CAMERA_ZOOM = 53;
const BASE_INNER_CANVAS_SIZE = 588;
const CONE_LENGTH = 0.24;
const CONE_RADIUS = 0.13;
export const ORIENTATION_GIZMO_SCALE = 1.36;
const GIZMO_CANVAS_SCALE = 2.4;
const AXIS_HIT_RADIUS_PX = 18;
export const ORIENTATION_GIZMO_LABEL_DISTANCE = 1.3;
const LABEL_HIT_RADIUS_PX = 24;
const LABEL_SCALE = 0.38;
const LABEL_FILL_COLOR = PREVIEW_THEME_COLORS.light.gizmoLabel;
const LABEL_HALO_COLOR = PREVIEW_THEME_COLORS.light.gizmoLabelHalo;
const LABEL_HOVER_COLOR = PREVIEW_THEME_COLORS.light.gizmoLabelHover;
const LABEL_TEXTURE_SIZE = 1024;
const LABEL_FONT_SIZE = 608;
const LABEL_OUTLINE_WIDTH = 66;
const ORIGIN_SPHERE_RADIUS = 0.13;
const SHAFT_LENGTH = 0.82;
const SHAFT_RADIUS = 0.055;
export const ORIENTATION_GIZMO_ZOOM_PER_CANVAS_PIXEL = BASE_CAMERA_ZOOM / BASE_INNER_CANVAS_SIZE;
const Y_AXIS = new Vector3(0, 1, 0);

export function OrientationGizmo({
  axisColors,
  materialState = DEFAULT_CRYSTAL_AXIS_MATERIAL,
  cameraOrientationRef,
  cellVectors,
  className,
  frameRequestRef,
  eventScopeRef,
  onAxisClick,
  orientationVersion = 0,
  showLabels = true,
  style,
  theme = "light",
}: {
  axisColors: CrystalAxisColors;
  materialState?: CrystalAxisMaterialState;
  cameraOrientationRef: CameraOrientationRef;
  cellVectors: VectorTuple[];
  className?: string;
  frameRequestRef?: MutableRefObject<(() => void) | null>;
  eventScopeRef?: RefObject<HTMLElement | null>;
  onAxisClick?: (axis: OrientationGizmoAxisLabel) => void;
  orientationVersion?: number;
  showLabels?: boolean;
  style?: CSSProperties;
  theme?: ResolvedTheme;
}) {
  const previewTheme = PREVIEW_THEME_COLORS[theme];
  const visualCanvasRef = useRef<HTMLDivElement | null>(null);
  const hoveredAxisRef = useRef<OrientationGizmoAxisLabel | null>(null);
  const lastPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const clickSuppressionTimeoutRef = useRef<number | null>(null);
  const { a, b, c } = axisColors;
  const axes = useMemo(() => computeOrientationGizmoAxes(cellVectors, { a, b, c }), [cellVectors, a, b, c]);
  const [hoveredAxis, setHoveredAxis] = useState<OrientationGizmoAxisLabel | null>(null);

  const pickAxisFromPointer = useCallback(
    (event: { clientX: number; clientY: number; target?: EventTarget | null }) => {
      const scope = eventScopeRef?.current;
      if (scope) {
        const bounds = scope.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom
          || event.target instanceof Node && !scope.contains(event.target)) return null;
      }
      const rect = visualCanvasRef.current?.getBoundingClientRect();
      if (!rect) {
        return null;
      }

      return pickOrientationGizmoAxis({
        axes,
        cameraOrientation: cameraOrientationRef.current,
        config: {
          axisHitRadiusPx: AXIS_HIT_RADIUS_PX,
          axisStartDistance: ORIGIN_SPHERE_RADIUS * 1.25,
          axisTipDistance: SHAFT_LENGTH + CONE_LENGTH,
          gizmoScale: ORIENTATION_GIZMO_SCALE,
          labelDistance: ORIENTATION_GIZMO_LABEL_DISTANCE,
          labelHitRadiusPx: LABEL_HIT_RADIUS_PX,
          pixelsPerWorldUnit:
            Math.min(rect.width, rect.height) * ORIENTATION_GIZMO_ZOOM_PER_CANVAS_PIXEL,
        },
        pointer: {
          clientX: event.clientX,
          clientY: event.clientY,
        },
        rect,
      });
    },
    [axes, cameraOrientationRef, eventScopeRef],
  );

  const updateHoveredAxis = useCallback((nextAxis: OrientationGizmoAxisLabel | null) => {
    if (hoveredAxisRef.current === nextAxis) {
      return;
    }

    hoveredAxisRef.current = nextAxis;
    setHoveredAxis(nextAxis);
  }, []);

  useEffect(() => {
    if (!hoveredAxis) {
      return;
    }

    const previousBodyCursor = document.body.style.cursor;
    const previousDocumentCursor = document.documentElement.style.cursor;
    document.body.style.cursor = "pointer";
    document.documentElement.style.cursor = "pointer";
    return () => {
      document.body.style.cursor = previousBodyCursor;
      document.documentElement.style.cursor = previousDocumentCursor;
    };
  }, [hoveredAxis]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      lastPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
      };
      updateHoveredAxis(pickAxisFromPointer(event));
    }

    function handlePointerDown(event: PointerEvent) {
      lastPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
      };
      const axis = pickAxisFromPointer(event);
      if (!axis) {
        return;
      }

      updateHoveredAxis(null);
      suppressNextClickRef.current = true;
      if (clickSuppressionTimeoutRef.current) {
        window.clearTimeout(clickSuppressionTimeoutRef.current);
      }
      clickSuppressionTimeoutRef.current = window.setTimeout(() => {
        suppressNextClickRef.current = false;
        clickSuppressionTimeoutRef.current = null;
      }, 750);
      event.preventDefault();
      event.stopImmediatePropagation();
      onAxisClick?.(axis);
    }

    function handleClick(event: MouseEvent) {
      if (!suppressNextClickRef.current) {
        return;
      }

      suppressNextClickRef.current = false;
      if (clickSuppressionTimeoutRef.current) {
        window.clearTimeout(clickSuppressionTimeoutRef.current);
        clickSuppressionTimeoutRef.current = null;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    function clearHover() {
      updateHoveredAxis(null);
    }

    document.addEventListener("pointermove", handlePointerMove, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("click", handleClick, true);
    window.addEventListener("blur", clearHover);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("blur", clearHover);
      if (clickSuppressionTimeoutRef.current) {
        window.clearTimeout(clickSuppressionTimeoutRef.current);
      }
    };
  }, [onAxisClick, pickAxisFromPointer, updateHoveredAxis]);

  useEffect(() => {
    const lastPointer = lastPointerRef.current;
    if (!lastPointer) {
      return;
    }

    updateHoveredAxis(pickAxisFromPointer(lastPointer));
  }, [orientationVersion, pickAxisFromPointer, updateHoveredAxis]);

  return (
    <div
      aria-label="Orientation gizmo"
      className={className}
      style={{ ...style, overflow: "visible", pointerEvents: "none" }}
    >
      <div
        className="pointer-events-none absolute left-1/2 top-1/2"
        ref={visualCanvasRef}
        style={{
          height: `${GIZMO_CANVAS_SCALE * 100}%`,
          transform: "translate(-50%, -50%)",
          width: `${GIZMO_CANVAS_SCALE * 100}%`,
        }}
      >
        <Canvas
          flat
          orthographic
          camera={{
            position: ORIENTATION_GIZMO_CAMERA_POSITION,
            zoom: BASE_CAMERA_ZOOM,
            near: 0.1,
            far: 20,
          }}
          dpr={Math.min(3, window.devicePixelRatio * 1.5)}
          frameloop="demand"
          gl={{ antialias: true, alpha: true }}
          style={{ pointerEvents: "none" }}
        >
          <CrystalAxisLighting materialState={materialState} />
          <OrientationGizmoFrameRequester
            frameRequestRef={frameRequestRef}
            orientationVersion={orientationVersion}
          />
          <ResponsiveGizmoCamera />
          <OrientationGizmoScene
            axes={axes}
            materialState={materialState}
            cameraOrientationRef={cameraOrientationRef}
            hoveredAxis={hoveredAxis}
            labelColor={previewTheme.gizmoLabel}
            labelHaloColor={previewTheme.gizmoLabelHalo}
            labelHoverColor={previewTheme.gizmoLabelHover}
            showLabelHalo={previewTheme.showGizmoLabelHalo}
            showLabels={showLabels}
          />
        </Canvas>
      </div>
    </div>
  );
}

function OrientationGizmoFrameRequester({
  frameRequestRef,
  orientationVersion,
}: {
  frameRequestRef?: MutableRefObject<(() => void) | null>;
  orientationVersion: number;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const requestFrame = useCallback(() => {
    invalidate();
  }, [invalidate]);

  useEffect(() => {
    if (!frameRequestRef) {
      return;
    }

    frameRequestRef.current = requestFrame;
    return () => {
      if (frameRequestRef.current === requestFrame) {
        frameRequestRef.current = null;
      }
    };
  }, [frameRequestRef, requestFrame]);

  useEffect(() => {
    requestFrame();
  }, [orientationVersion, requestFrame]);

  return null;
}

function ResponsiveGizmoCamera() {
  const { camera, invalidate, size } = useThree();

  useEffect(() => {
    if (!(camera instanceof OrthographicCamera)) {
      return;
    }

    camera.zoom = Math.min(size.width, size.height) * ORIENTATION_GIZMO_ZOOM_PER_CANVAS_PIXEL;
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, invalidate, size.height, size.width]);

  return null;
}

function OrientationGizmoScene({
  axes,
  materialState,
  cameraOrientationRef,
  hoveredAxis,
  labelColor,
  labelHaloColor,
  labelHoverColor,
  showLabelHalo,
  showLabels,
}: {
  axes: OrientationGizmoAxisSpec[];
  materialState: CrystalAxisMaterialState;
  cameraOrientationRef: CameraOrientationRef;
  hoveredAxis: OrientationGizmoAxisLabel | null;
  labelColor: string;
  labelHaloColor: string;
  labelHoverColor: string;
  showLabelHalo: boolean;
  showLabels: boolean;
}) {
  const groupRef = useRef<Group | null>(null);
  const nextRotationRef = useRef(new Quaternion());

  useFrame(() => {
    const group = groupRef.current;
    if (!group) {
      return;
    }

    group.quaternion.copy(nextRotationRef.current.copy(cameraOrientationRef.current).invert());
  });

  return (
    <group ref={groupRef}>
      <OrientationGizmoAxes
        axes={axes}
        materialState={materialState}
        hoveredAxis={hoveredAxis}
        labelColor={labelColor}
        labelHaloColor={labelHaloColor}
        labelHoverColor={labelHoverColor}
        showLabelHalo={showLabelHalo}
        showLabels={showLabels}
      />
    </group>
  );
}

export function StaticOrientationGizmoScene({
  axes,
  materialState = DEFAULT_CRYSTAL_AXIS_MATERIAL,
  cameraPose,
  labelColor = LABEL_FILL_COLOR,
  labelHaloColor = LABEL_HALO_COLOR,
  showLabelHalo = true,
  showLabels = true,
}: {
  axes: OrientationGizmoAxisSpec[];
  materialState?: CrystalAxisMaterialState;
  cameraPose: CameraPoseSnapshot;
  labelColor?: string;
  labelHaloColor?: string;
  showLabelHalo?: boolean;
  showLabels?: boolean;
}) {
  const rotation = useMemo(
    () => new Quaternion(...cameraPose.quaternion).invert(),
    [cameraPose],
  );

  return (
    <group quaternion={rotation}>
      <OrientationGizmoAxes
        axes={axes}
        materialState={materialState}
        hoveredAxis={null}
        labelColor={labelColor}
        labelHaloColor={labelHaloColor}
        showLabelHalo={showLabelHalo}
        showLabels={showLabels}
      />
    </group>
  );
}

function OrientationGizmoAxes({
  axes,
  materialState,
  hoveredAxis,
  labelColor = LABEL_FILL_COLOR,
  labelHaloColor = LABEL_HALO_COLOR,
  labelHoverColor = LABEL_HOVER_COLOR,
  showLabelHalo = true,
  showLabels = true,
}: {
  axes: OrientationGizmoAxisSpec[];
  materialState: CrystalAxisMaterialState;
  hoveredAxis: OrientationGizmoAxisLabel | null;
  labelColor?: string;
  labelHaloColor?: string;
  labelHoverColor?: string;
  showLabelHalo?: boolean;
  showLabels?: boolean;
}) {
  return (
    <group scale={ORIENTATION_GIZMO_SCALE}>
      {axes.map((axis) => (
        <AxisArrow
          axis={axis}
          materialState={materialState}
          hovered={axis.label === hoveredAxis}
          key={axis.label}
          labelColor={labelColor}
          labelHaloColor={labelHaloColor}
          labelHoverColor={labelHoverColor}
          showLabelHalo={showLabelHalo}
          showLabel={showLabels}
        />
      ))}
      <mesh renderOrder={4}>
        <sphereGeometry args={[ORIGIN_SPHERE_RADIUS, 40, 24]} />
        <CrystalAxisMaterial materialState={materialState} color="#f3f2ee" target="atom" />
      </mesh>
    </group>
  );
}

function AxisArrow({
  axis,
  materialState,
  hovered,
  labelColor,
  labelHaloColor,
  labelHoverColor,
  showLabelHalo,
  showLabel,
}: {
  axis: OrientationGizmoAxisSpec;
  materialState: CrystalAxisMaterialState;
  hovered: boolean;
  labelColor: string;
  labelHaloColor: string;
  labelHoverColor: string;
  showLabelHalo: boolean;
  showLabel: boolean;
}) {
  const axisRotation = useMemo(
    () => new Quaternion().setFromUnitVectors(Y_AXIS, new Vector3(...axis.direction)),
    [axis.direction],
  );
  const materialColor = hovered ? `#${new Color(axis.color).lerp(new Color("#ffffff"), 0.3).getHexString()}` : axis.color;

  return (
    <group quaternion={axisRotation}>
      <mesh position={[0, SHAFT_LENGTH / 2, 0]}>
        <cylinderGeometry args={[SHAFT_RADIUS, SHAFT_RADIUS, SHAFT_LENGTH, 32]} />
        <CrystalAxisMaterial materialState={materialState} color={materialColor} />
      </mesh>
      <mesh position={[0, SHAFT_LENGTH + CONE_LENGTH / 2, 0]}>
        <coneGeometry args={[CONE_RADIUS, CONE_LENGTH, 40]} />
        <CrystalAxisMaterial materialState={materialState} color={materialColor} />
      </mesh>
      {showLabel ? (
        <AxisLabel
          hovered={hovered}
          label={axis.label}
          labelColor={labelColor}
          labelHaloColor={labelHaloColor}
          labelHoverColor={labelHoverColor}
          showHalo={showLabelHalo}
          position={[0, ORIENTATION_GIZMO_LABEL_DISTANCE, 0]}
        />
      ) : null}
    </group>
  );
}

function AxisLabel({
  hovered,
  label,
  labelColor,
  labelHaloColor,
  labelHoverColor,
  position,
  showHalo,
}: {
  hovered: boolean;
  label: string;
  labelColor: string;
  labelHaloColor: string;
  labelHoverColor: string;
  position: VectorTuple;
  showHalo: boolean;
}) {
  const [fontReady, setFontReady] = useState(() => document.fonts?.check('500 16px "LXGW WenKai"') ?? true);
  useEffect(() => {
    let active = true;
    if (!fontReady && document.fonts) {
      void ensureFigureFonts().then(() => {
        if (active) setFontReady(true);
      });
    }
    return () => { active = false; };
  }, [fontReady]);
  const fillTexture = useMemo(() => createLabelAlphaMap(label, "fill"), [label, fontReady]);
  const outlineTexture = useMemo(() => createLabelAlphaMap(label, "outline"), [label, fontReady]);
  const fillColor = hovered ? labelHoverColor : labelColor;

  useEffect(() => () => fillTexture.dispose(), [fillTexture]);
  useEffect(() => () => outlineTexture.dispose(), [outlineTexture]);

  return (
    <group position={position}>
      {showHalo ? (
        <sprite
          renderOrder={9}
          scale={[LABEL_SCALE, LABEL_SCALE, 1]}
        >
          <spriteMaterial
            alphaMap={outlineTexture}
            toneMapped={false}
            color={labelHaloColor}
            depthTest
            depthWrite={false}
            alphaTest={0.18}
            transparent
          />
        </sprite>
      ) : null}
      <sprite
        renderOrder={10}
        scale={[LABEL_SCALE, LABEL_SCALE, 1]}
      >
        <spriteMaterial
          alphaMap={fillTexture}
          toneMapped={false}
          color={fillColor}
          depthTest
          depthWrite={false}
          alphaTest={0.08}
          transparent
        />
      </sprite>
    </group>
  );
}

function createLabelAlphaMap(label: string, layer: "fill" | "outline") {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  canvas.width = LABEL_TEXTURE_SIZE;
  canvas.height = LABEL_TEXTURE_SIZE;

  if (context) {
    context.fillStyle = "#000000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = `italic 500 ${LABEL_FONT_SIZE}px ${FIGURE_FONT_FAMILY}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.miterLimit = 2;
    context.fillStyle = "#ffffff";
    if (layer === "outline") {
      drawLabelOutline(context, label);
    } else {
      context.fillText(label, canvas.width / 2, canvas.height / 2 + 4);
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = NoColorSpace;
  texture.generateMipmaps = true;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;

  return texture;
}

function drawLabelOutline(context: CanvasRenderingContext2D, label: string) {
  const centerX = context.canvas.width / 2;
  const centerY = context.canvas.height / 2 + 4;

  context.lineWidth = LABEL_OUTLINE_WIDTH;
  context.strokeStyle = "#ffffff";
  context.strokeText(label, centerX, centerY);
}
