import {
  Material, Vector4, type Camera, type MeshStandardMaterial, type Object3D,
  type Scene, type Texture, type WebGLRenderer,
} from "three";

type MaterialObject = Object3D & { material: Material | Material[] };
type SceneEntry = { object: MaterialObject; material: Material | Material[] };
type AoMaterial = MeshStandardMaterial & { transmission?: number };
const ADAPTER_VERSION = "native-ao-r171-v1";

function transparentMaterial(material: Material): boolean {
  return material.transparent || material.opacity < 1 || ((material as AoMaterial).transmission ?? 0) > 0;
}

function sceneEntries(scene: Scene, camera: Camera): SceneEntry[] {
  const entries: SceneEntry[] = [];
  scene.traverseVisible(object => {
    if (!object.layers.test(camera.layers)) return;
    const candidate = object as MaterialObject;
    if (candidate.material) entries.push({ object: candidate, material: candidate.material });
  });
  return entries;
}

export function sceneHasTransparentMaterials(scene: Scene, camera: Camera): boolean {
  return sceneEntries(scene, camera).some(entry => (Array.isArray(entry.material) ? entry.material : [entry.material])
    .some(material => material.visible && transparentMaterial(material)));
}

/** Keep native tone mapping, transmission and transparent sorting in the final draw. */
export function createNativeAmbientOcclusionRenderer(renderer: WebGLRenderer) {
  const aoTexture = { value: null as Texture | null };
  const viewport = { value: new Vector4() };
  const hidden = new Material();
  hidden.visible = false;
  const cache = new Map<Material, { material: AoMaterial; version: number; cacheKey: string; frame: number }>();
  let activeRestore: (() => void) | null = null;
  let disposed = false;
  let frame = 0;

  function adaptedMaterial(source: Material, currentFrame: number): Material {
    if (transparentMaterial(source) || !(source as AoMaterial).isMeshStandardMaterial || !source.colorWrite) return source;
    const cacheKey = `${source.version}:${source.customProgramCacheKey()}`;
    let entry = cache.get(source);
    if (!entry) {
      const material = source.clone() as AoMaterial;
      material.onBeforeCompile = function (shader, gl) {
        source.onBeforeCompile.call(this, shader, gl);
        const marker = "#include <tonemapping_fragment>";
        if (!shader.fragmentShader.includes(marker)) throw new Error("The material shader no longer supports native AO composition.");
        shader.uniforms.n8NativeAo = aoTexture;
        shader.uniforms.n8NativeViewport = viewport;
        shader.fragmentShader = `uniform highp sampler2D n8NativeAo;
          uniform vec4 n8NativeViewport;\n${shader.fragmentShader}`.replace(marker, `
          vec2 n8AoUv = (gl_FragCoord.xy - n8NativeViewport.xy) / n8NativeViewport.zw;
          gl_FragColor.rgb *= clamp(texture2D(n8NativeAo, n8AoUv).r, 0.0, 1.0);
          ${marker}`);
      };
      material.customProgramCacheKey = () => `${ADAPTER_VERSION}:${source.version}:${source.customProgramCacheKey()}`;
      material.onBeforeRender = function (...args) {
        source.onBeforeRender.call(this, ...args);
        args[0].getCurrentViewport(viewport.value);
      };
      entry = { material, version: source.version, cacheKey, frame: -1 };
      cache.set(source, entry);
    }
    // R3F updates roughness, colors, opacity and other uniforms in place without
    // incrementing Material.version. Copy once per material/frame, not once per mesh.
    if (entry.frame !== currentFrame) {
      entry.material.copy(source as AoMaterial);
      entry.material.defines = { ...(source as AoMaterial).defines };
      if (entry.version !== source.version || entry.cacheKey !== cacheKey) entry.material.needsUpdate = true;
      entry.version = source.version;
      entry.cacheKey = cacheKey;
      entry.frame = currentFrame;
    }
    return entry.material;
  }

  function withMaterials<T>(entries: SceneEntry[], replace: (material: Material) => Material, draw: () => T): T {
    const restore = () => { for (const entry of entries) entry.object.material = entry.material; };
    activeRestore = restore;
    try {
      for (const entry of entries) entry.object.material = Array.isArray(entry.material)
        ? entry.material.map(replace) : replace(entry.material);
      return draw();
    } finally {
      restore();
      activeRestore = null;
    }
  }

  return {
    render(scene: Scene, camera: Camera, renderFactor: () => Texture) {
      if (disposed) throw new Error("The native AO renderer has been disposed.");
      const entries = sceneEntries(scene, camera);
      const currentFrame = ++frame;
      try {
        const factor = withMaterials(entries, material => transparentMaterial(material) ? hidden : material, renderFactor);
        if (disposed) throw new Error("The native AO renderer has been disposed.");
        aoTexture.value = factor;
        withMaterials(entries, material => adaptedMaterial(material, currentFrame), () => renderer.render(scene, camera));
      } finally {
        for (const [source, entry] of cache) {
          if (entry.frame !== currentFrame) { entry.material.dispose(); cache.delete(source); }
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeRestore?.();
      for (const entry of cache.values()) entry.material.dispose();
      cache.clear();
      hidden.dispose();
      aoTexture.value = null;
    },
  };
}
