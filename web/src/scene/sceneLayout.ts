import { Box3, Vector3 } from "three";

import type { SceneSpec } from "../api/scene";
import type { AtomRadiusStyleModel } from "../model/objectStyles";
import {
  computeCrystalCameraPose,
  createDefaultCrystalCameraState,
  type CrystalCameraPose,
  type CrystalCameraState,
} from "./crystalCamera";
import { cellCenter, cellCorners } from "./sceneGeometry";
import {
  type CameraFitBounds,
  computeStandardCameraPose,
  type StandardCameraPose,
  type VectorTuple,
} from "./viewMath";

export interface SceneStructureLayout {
  cameraFitBounds: CameraFitBounds;
  depthFadingBackOffset: number;
  depthFadingFrontOffset: number;
  groupPosition: VectorTuple;
  span: number;
  standardPose: StandardCameraPose;
}

export interface SceneLayout extends SceneStructureLayout {
  cameraPose: CrystalCameraPose;
}

export function computeSceneLayout(
  scene: SceneSpec,
  _atomRadiusModel: AtomRadiusStyleModel = "uniform",
  cameraState?: CrystalCameraState,
): SceneLayout {
  const structureLayout = computeSceneStructureLayout(scene);
  const cameraPose = computeCrystalCameraPose(
    scene.cell.vectors,
    cameraState ?? createDefaultCrystalCameraState(scene.cell.vectors),
    structureLayout.span,
  );

  return {
    ...structureLayout,
    cameraPose,
  };
}

export function computeSceneStructureLayout(
  scene: SceneSpec,
  _atomRadiusModel: AtomRadiusStyleModel = "uniform",
): SceneStructureLayout {
  const points = cellCorners(scene.cell.vectors);
  const box = new Box3().setFromPoints(points);
  const center = cellCenter(scene.cell.vectors);
  const size = box.getSize(new Vector3());
  const span = Math.max(1, size.x, size.y, size.z);
  const standardPose = computeStandardCameraPose(scene.cell.vectors, span);
  const groupPosition: VectorTuple = [-center.x, -center.y, -center.z];
  const defaultCameraPose = computeCrystalCameraPose(
    scene.cell.vectors,
    createDefaultCrystalCameraState(scene.cell.vectors),
    span,
  );

  const depthFadingRange = computeDepthFadingRange(
    scene,
    groupPosition,
    standardPose,
    span,
  );

  return {
    cameraFitBounds: computeProjectedCameraFitBounds(
      scene,
      groupPosition,
      defaultCameraPose,
    ),
    depthFadingBackOffset: depthFadingRange.backOffset,
    depthFadingFrontOffset: depthFadingRange.frontOffset,
    groupPosition,
    span,
    standardPose,
  };
}

function computeDepthFadingRange(
  scene: SceneSpec,
  groupPosition: VectorTuple,
  standardPose: Pick<StandardCameraPose, "outward">,
  span: number,
): { backOffset: number; frontOffset: number } {
  const outward = new Vector3(...standardPose.outward).normalize();
  const offset = new Vector3(...groupPosition);
  const points =
    scene.atoms.length > 0
      ? scene.atoms.map((atom) => new Vector3(...atom.position))
      : cellCorners(scene.cell.vectors);
  let nearestFrontProjection = 0;
  let nearestBackProjection = 0;

  for (const point of points) {
    const projected = point.clone().add(offset).dot(outward);
    nearestFrontProjection = Math.max(nearestFrontProjection, projected);
    nearestBackProjection = Math.min(nearestBackProjection, projected);
  }

  const minimumOffset = 0.01 * Math.max(1, span);

  return {
    backOffset: Math.max(minimumOffset, -nearestBackProjection),
    frontOffset: -nearestFrontProjection,
  };
}

function computeProjectedCameraFitBounds(
  scene: SceneSpec,
  groupPosition: VectorTuple,
  cameraPose: Pick<CrystalCameraPose, "cameraUp" | "outward">,
): CameraFitBounds {
  const outward = new Vector3(...cameraPose.outward).normalize();
  const cameraUp = new Vector3(...cameraPose.cameraUp).normalize();
  const right = cameraUp.clone().cross(outward).normalize();
  const screenUp = outward.clone().cross(right).normalize();
  const offset = new Vector3(...groupPosition);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function includePoint(point: Vector3 | VectorTuple) {
    const localPoint = Array.isArray(point)
      ? new Vector3(...point)
      : point.clone();
    localPoint.add(offset);
    const x = localPoint.dot(right);
    const y = localPoint.dot(screenUp);

    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  for (const corner of cellCorners(scene.cell.vectors)) {
    includePoint(corner);
  }

  return {
    projectedHeight: Math.max(1, maxY - minY),
    projectedWidth: Math.max(1, maxX - minX),
  };
}
