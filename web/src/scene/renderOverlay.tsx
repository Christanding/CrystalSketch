import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useThree } from "@react-three/fiber";
import { Camera, Color, Group, Scene, WebGLRenderer } from "three";

export const ANNOTATION_LAYER = 1;

/** Keep measurements sharp and out of the AO/depth pass, including transparent exports. */
export function AnnotationLayer({ position, children }: { position: [number, number, number]; children: ReactNode }) {
  const group = useRef<Group>(null);
  const invalidate = useThree(state => state.invalidate);
  useLayoutEffect(() => {
    group.current?.traverse(object => object.layers.set(ANNOTATION_LAYER));
    invalidate();
  });
  return <group ref={group} position={position}>{children}</group>;
}

export function renderAnnotationOverlay(renderer: WebGLRenderer, scene: Scene, camera: Camera, clear = false) {
  const mask = camera.layers.mask;
  const background = scene.background;
  const autoClear = renderer.autoClear;
  const alpha = renderer.getClearAlpha();
  const color = renderer.getClearColor(new Color());
  try {
    scene.background = null;
    camera.layers.set(ANNOTATION_LAYER);
    renderer.setClearColor(0, 0);
    renderer.autoClear = false;
    if (clear) renderer.clear(true, true, true);
    else renderer.clearDepth();
    renderer.render(scene, camera);
  } finally {
    camera.layers.mask = mask;
    scene.background = background;
    renderer.autoClear = autoClear;
    renderer.setClearColor(color, alpha);
  }
}
