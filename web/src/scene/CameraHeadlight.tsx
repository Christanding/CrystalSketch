import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { DirectionalLight, Object3D, Vector3 } from "three";

import { PREVIEW_HEADLIGHT_INTENSITY } from "./renderAppearance";

const HEADLIGHT_TARGET = new Vector3(0, 0, 0);
const DEFAULT_CAMERA_RELATIVE_LIGHT_OFFSET = [0.32, 0.22, 0] as const;
const MIN_LIGHT_DISTANCE = 4;

export function CameraHeadlight({
  direction,
  color,
  intensity = PREVIEW_HEADLIGHT_INTENSITY,
  intensityScale = 1,
  offset = DEFAULT_CAMERA_RELATIVE_LIGHT_OFFSET,
}: {
  direction?: [number, number];
  color?: string | number;
  intensity?: number;
  intensityScale?: number;
  offset?: readonly [number, number, number];
}) {
  const { camera } = useThree();
  const lightRef = useRef<DirectionalLight | null>(null);
  const lightOffsetRef = useRef(new Vector3());
  const cameraRelativeLightOffset = useMemo(
    () => new Vector3(...offset),
    [offset],
  );
  const targetObject = useMemo(() => {
    const object = new Object3D();
    object.position.copy(HEADLIGHT_TARGET);
    return object;
  }, []);

  useFrame(() => {
    const light = lightRef.current;
    if (!light) {
      return;
    }

    const lightDistance = Math.max(camera.position.distanceTo(HEADLIGHT_TARGET), MIN_LIGHT_DISTANCE);
    lightOffsetRef.current
      .copy(cameraRelativeLightOffset)
      .multiplyScalar(lightDistance)
      .applyQuaternion(camera.quaternion);

    if (direction) {
      const azimuth = direction[0] * Math.PI / 180;
      const elevation = direction[1] * Math.PI / 180;
      light.position.set(Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation),
        Math.cos(elevation) * Math.cos(azimuth)).multiplyScalar(lightDistance).applyQuaternion(camera.quaternion);
    } else {
      light.position.copy(camera.position).add(lightOffsetRef.current);
    }
    targetObject.position.copy(HEADLIGHT_TARGET);
    targetObject.updateMatrixWorld();
  });

  return (
    <>
      <primitive object={targetObject} />
      <directionalLight
        ref={lightRef}
        color={color}
        intensity={intensity * intensityScale}
        target={targetObject}
      />
    </>
  );
}
