import { useFrame, useThree } from "@react-three/fiber";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CanvasTexture, Group, LinearFilter, Quaternion, SRGBColorSpace, Vector3, type Camera } from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

import type { SceneSpec } from "../api/scene";
import { measurementIsDisplayed, resolveMeasurement, type ResolvedMeasurement } from "../model/measurements";
import { createDefaultStyle, type StyleState } from "../model/appearance";
import {
  resolveAtomOpacityForStyle,
  resolveAtomRadiusForStyle,
  resolveAtomVisibleForStyle,
  resolveBondOpacityForStyle,
  resolveBondRadiusForStyle,
} from "../model/objectStyles";
import {
  LABEL_FONT_SIZE,
  LABEL_CANVAS_HEIGHT,
  MEASUREMENT_LABEL_CENTER,
  layoutMeasurementLabels,
  measurementLabelSize,
} from "../model/measurementLabelLayout";
import { ensureFigureFonts, FIGURE_FONT_FAMILY } from "../theme/fonts";
import { BOND_RADIUS } from "./sceneGeometry";
import type { VectorTuple } from "./viewMath";

export { MEASUREMENT_LABEL_CENTER, measurementLabelSize } from "../model/measurementLabelLayout";

const LINE_RENDER_ORDER = 50;
const LABEL_RENDER_ORDER = 51;
export const MEASUREMENT_LINE_WIDTH_RATIO = 0.0015;
const ignoreRaycast = () => {};
const DEFAULT_OBSTACLE_STYLE = createDefaultStyle();

export function displayedMeasurements(scene: SceneSpec): ResolvedMeasurement[] {
  return (scene.measurements ?? [])
    .filter(definition => measurementIsDisplayed(definition, scene.measurementStyle))
    .map(definition => resolveMeasurement(scene, definition))
    .filter((measurement): measurement is ResolvedMeasurement => measurement !== null);
}

export function measurementLayoutObstacles({
  scene,
  style = DEFAULT_OBSTACLE_STYLE,
  showAtoms = true,
  atomOpacity = 100,
  bondOpacity = 100,
}: {
  scene: SceneSpec;
  style?: StyleState;
  showAtoms?: boolean;
  atomOpacity?: number;
  bondOpacity?: number;
}) {
  const obstacles: { position: VectorTuple; radius: number }[] = [];
  const segments: { start: VectorTuple; end: VectorTuple; radius: number }[] = [];
  if (showAtoms) {
    for (const atom of scene.atoms) {
      if (!resolveAtomVisibleForStyle(atom, style.objectStyles)
        || resolveAtomOpacityForStyle(atom, style.objectStyles, atomOpacity) === 0) continue;
      obstacles.push({ position: atom.position, radius: resolveAtomRadiusForStyle(atom, style) });
    }
  }
  for (const bond of scene.bonds) {
    if (resolveBondOpacityForStyle(bond, style.objectStyles, bondOpacity) === 0) continue;
    const start = scene.atoms[bond.startAtomIndex];
    const end = scene.atoms[bond.endAtomIndex];
    if (!start || !end) continue;
    segments.push({
      start: start.position,
      end: end.position,
      radius: resolveBondRadiusForStyle(bond, style.objectStyles, BOND_RADIUS * style.bondThickness / 100),
    });
  }
  return { obstacles, segments };
}

export const MeasurementAnnotations = memo(function MeasurementAnnotations({
  scene,
  color = "#333333",
  scale = 1,
  style,
  showAtoms = true,
  atomOpacity = 100,
  bondOpacity = 100,
}: {
  scene: SceneSpec;
  color?: string;
  scale?: number;
  style?: StyleState;
  showAtoms?: boolean;
  atomOpacity?: number;
  bondOpacity?: number;
}) {
  const measurements = useMemo(() => displayedMeasurements(scene),
    [scene.atoms, scene.measurements, scene.measurementStyle?.displayMode]);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

  return (
    <>
      {measurements.map(measurement => (
        <MeasurementAnnotation key={measurement.definition.id} color={color} measurement={measurement} scale={safeScale} />
      ))}
      {scene.measurementStyle?.showLabels !== false && measurements.length > 0 ? (
        <MeasurementLabels
          scene={scene}
          measurements={measurements}
          color={scene.measurementStyle?.color ?? color}
          fontScale={scene.measurementStyle?.fontScale ?? 100}
          fontWeight={scene.measurementStyle?.fontWeight ?? 400}
          scale={safeScale}
          style={style}
          showAtoms={showAtoms}
          atomOpacity={atomOpacity}
          bondOpacity={bondOpacity}
        />
      ) : null}
    </>
  );
});

function MeasurementAnnotation({
  color,
  measurement,
  scale,
}: {
  color: string;
  measurement: ResolvedMeasurement;
  scale: number;
}) {
  const lines = useMemo(() => {
    const result = [createLine(measurement.points.flat(), color, scale, true)];
    const arc = measurementAngleArcPositions(measurement);
    if (arc.length > 0) result.push(createLine(arc, color, scale, false));
    return result;
  }, [color, measurement, scale]);

  useEffect(() => () => {
    for (const line of lines) {
      line.geometry.dispose();
      line.material.dispose();
    }
  }, [lines]);

  return (
    <group>
      {lines.map((line, index) => <primitive key={index} object={line} />)}
    </group>
  );
}

function MeasurementLabels({
  scene, measurements, color, fontScale, fontWeight, scale, style, showAtoms, atomOpacity, bondOpacity,
}: {
  scene: SceneSpec;
  measurements: ResolvedMeasurement[];
  color: string;
  fontScale: number;
  fontWeight: 300 | 400 | 500 | 600;
  scale: number;
  style?: StyleState;
  showAtoms: boolean;
  atomOpacity: number;
  bondOpacity: number;
}) {
  const groupRef = useRef<Group>(null);
  const { camera, invalidate } = useThree();
  const obstacles = useMemo(() => measurementLayoutObstacles({ scene, style, showAtoms, atomOpacity, bondOpacity }),
    [scene.atoms, scene.bonds, style, showAtoms, atomOpacity, bondOpacity]);
  const inputs = useMemo(() => ({ measurements, span: scale, fontScale, ...obstacles }),
    [measurements, scale, fontScale, obstacles]);
  const lastLayout = useRef<{ inputs: typeof inputs; orientation: Quaternion } | null>(null);
  const updateLayout = useCallback((activeCamera: Camera) => {
    const group = groupRef.current;
    if (!group) return;
    const previous = lastLayout.current;
    if (previous?.inputs === inputs && Math.abs(previous.orientation.dot(activeCamera.quaternion)) > 1 - 1e-12) return;
    const positions = layoutMeasurementLabels({ ...inputs, cameraQuaternion: activeCamera.quaternion.toArray() });
    for (const sprite of group.children) {
      const position = positions.get(sprite.name);
      if (position) sprite.position.set(...position);
    }
    lastLayout.current = { inputs, orientation: activeCamera.quaternion.clone() };
  }, [inputs]);
  useLayoutEffect(() => {
    updateLayout(camera);
    invalidate();
  }, [camera, invalidate, updateLayout]);
  useFrame(({ camera: activeCamera }) => updateLayout(activeCamera));

  return (
    <group ref={groupRef}>
      {measurements.map(measurement => (
        <MeasurementLabel
          key={measurement.definition.id}
          id={measurement.definition.id}
          color={color}
          fontScale={fontScale}
          fontWeight={fontWeight}
          label={measurement.label}
          position={measurement.labelPosition}
          scale={scale}
        />
      ))}
    </group>
  );
}

function createLine(positions: number[], color: string, scale: number, dashed: boolean): Line2 {
  const geometry = new LineGeometry().setPositions(positions);
  const material = new LineMaterial({
    color,
    dashed,
    dashSize: scale * 0.012,
    gapSize: scale * 0.008,
    linewidth: scale * MEASUREMENT_LINE_WIDTH_RATIO,
    worldUnits: true,
    // Bond cylinders share the measured segment; annotations must remain visible over them.
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    transparent: true,
  });
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  line.renderOrder = LINE_RENDER_ORDER;
  line.raycast = ignoreRaycast;
  return line;
}

export function measurementAngleArcPositions(measurement: ResolvedMeasurement): number[] {
  if (measurement.definition.kind !== "angle" || measurement.value < 1e-6) return [];
  const [first, vertex, last] = measurement.points;
  if (!first || !vertex || !last) return [];
  const origin = new Vector3(...vertex);
  const firstArm = new Vector3(...first).sub(origin);
  const lastArm = new Vector3(...last).sub(origin);
  const radius = Math.min(firstArm.length(), lastArm.length()) * 0.26;
  const start = firstArm.normalize();
  const end = lastArm.normalize();
  const tangent = end.clone().addScaledVector(start, -start.dot(end));
  if (tangent.lengthSq() < 1e-16) {
    tangent.set(...measurement.labelPosition).sub(origin);
    tangent.addScaledVector(start, -start.dot(tangent));
  }
  if (tangent.lengthSq() < 1e-16) return [];
  tangent.normalize();
  const radians = measurement.value * Math.PI / 180;
  const segments = Math.max(4, Math.ceil(radians / Math.PI * 40));
  const positions: number[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = radians * index / segments;
    const point = origin.clone()
      .addScaledVector(start, Math.cos(angle) * radius)
      .addScaledVector(tangent, Math.sin(angle) * radius);
    positions.push(point.x, point.y, point.z);
  }
  return positions;
}

function MeasurementLabel({
  id,
  color,
  fontScale,
  fontWeight,
  label,
  position,
  scale,
}: {
  id: string;
  color: string;
  fontScale: number;
  fontWeight: 300 | 400 | 500 | 600;
  label: string;
  position: [number, number, number];
  scale: number;
}) {
  const [fontReady, setFontReady] = useState(() => measurementFontsReady(fontWeight));
  useEffect(() => {
    let active = true;
    if (measurementFontsReady(fontWeight)) {
      setFontReady(true);
    } else {
      setFontReady(false);
      void ensureFigureFonts().then(() => {
        if (active) setFontReady(true);
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [fontWeight]);
  const texture = useMemo(() => createLabelTexture(label, color, fontWeight), [color, label, fontWeight, fontReady]);
  useEffect(() => () => texture.dispose(), [texture]);
  const { width, height } = measurementLabelSize(label, scale, fontScale);

  return (
    <sprite
      name={id}
      position={position}
      center={MEASUREMENT_LABEL_CENTER}
      scale={[width, height, 1]}
      renderOrder={LABEL_RENDER_ORDER}
      raycast={ignoreRaycast}
    >
      <spriteMaterial
        map={texture}
        depthTest={false}
        depthWrite={false}
        fog={false}
        toneMapped={false}
        transparent
      />
    </sprite>
  );
}

function measurementFontsReady(fontWeight: number): boolean {
  return typeof document === "undefined" || !document.fonts
    || (document.fonts.check('500 16px "LXGW WenKai"')
      && document.fonts.check(`${fontWeight} 16px "CrystalSketch Numerals"`));
}

function createLabelTexture(label: string, color: string, fontWeight: number): CanvasTexture {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  canvas.height = LABEL_CANVAS_HEIGHT;
  canvas.width = measurementLabelSize(label, 1).canvasWidth;
  if (context) {
    const font = `${fontWeight} ${LABEL_FONT_SIZE}px ${FIGURE_FONT_FAMILY}`;
    context.font = font;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = color;
    context.fillText(label, canvas.width / 2, canvas.height / 2 + 3, canvas.width - 24);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  return texture;
}
