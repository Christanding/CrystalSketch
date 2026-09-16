import {
  BufferAttribute, BufferGeometry, CylinderGeometry, DataTexture, FloatType, Mesh, MeshPhysicalMaterial,
  NearestFilter, RGBAFormat, Scene, ShaderMaterial, SphereGeometry, Vector3, type Material, type Object3D,
} from "three";
import type { WebGLPathTracer } from "three-gpu-pathtracer";
import { PRIMITIVE_INTERSECTION_GLSL } from "./pathTracingIntersections.glsl";
import { refitPrimitiveBVH } from "./pathTracingPrimitiveBVH";

/** The only private vendor access. This adapter is pinned to three-gpu-pathtracer 0.0.23. */
interface PrimitiveCompatibleTracer {
  scene: Scene;
  _materials: Material[];
  _pathTracer: { material: ShaderMaterial & { materialIndexAttribute: { updateFrom(attribute: BufferAttribute): void } } };
}
type Vec3 = [number, number, number];
const CYLINDER_KINDS = new Set(["bond", "unit-cell", "polyhedron-edge"]);
interface TracePrimitiveBase {
  mesh: Mesh<BufferGeometry, MeshPhysicalMaterial>;
  center: Vec3;
  radius: number;
}
export type TracePrimitive = TracePrimitiveBase & (
  | { kind: "sphere" }
  | { kind: "cylinder"; axis: Vec3; halfLength: number; capped: boolean; startColor: Vec3; endColor: Vec3 }
);

/** Unsupported shapes/materials stay in the original triangle BVH without approximation. */
export function collectTracePrimitives(scene: Scene, includeCylinders = true): TracePrimitive[] {
  scene.updateMatrixWorld(true);
  const primitives: TracePrimitive[] = [];
  const center = new Vector3(), scale = new Vector3();
  scene.traverseVisible(object => {
    if (!(object instanceof Mesh) || "isSkinnedMesh" in object || "isInstancedMesh" in object
      || "isBatchedMesh" in object || object.children.length > 0
      || !(object.material instanceof MeshPhysicalMaterial)) return;
    const { geometry, material } = object;
    if (material.flatShading || Object.keys(geometry.morphAttributes).length > 0
      || Object.values(material).some(value => value && typeof value === "object" && "isTexture" in value)) return;
    const matrix = object.matrixWorld;
    scale.setFromMatrixScale(matrix);
    if (!scale.toArray().every(value => Number.isFinite(value) && value > 0) || !(matrix.determinant() > 0)) return;
    // Equal column lengths alone do not rule out shear. Both primitives require orthogonal axes.
    const e = matrix.elements;
    if (Math.abs((e[0]! * e[4]! + e[1]! * e[5]! + e[2]! * e[6]!) / (scale.x * scale.y)) > 1e-8
      || Math.abs((e[0]! * e[8]! + e[1]! * e[9]! + e[2]! * e[10]!) / (scale.x * scale.z)) > 1e-8
      || Math.abs((e[4]! * e[8]! + e[5]! * e[9]! + e[6]! * e[10]!) / (scale.y * scale.z)) > 1e-8) return;
    center.setFromMatrixPosition(matrix);
    const position = center.toArray().map(Math.fround) as Vec3;
    if (!position.every(Number.isFinite)) return;
    const mesh = object as TracePrimitive["mesh"];
    if (object.userData.kind === "atom" && geometry instanceof SphereGeometry && !material.vertexColors) {
      const { radius, phiStart, phiLength, thetaStart, thetaLength } = geometry.parameters;
      if (phiStart !== 0 || phiLength !== 2 * Math.PI || thetaStart !== 0 || thetaLength !== Math.PI
        || Math.abs(scale.y / scale.x - 1) > 1e-8 || Math.abs(scale.z / scale.x - 1) > 1e-8) return;
      const worldRadius = Math.fround(radius * scale.x);
      if (Number.isFinite(worldRadius) && worldRadius > 0) {
        primitives.push({ kind: "sphere", mesh, center: position, radius: worldRadius });
      }
    } else if (includeCylinders && CYLINDER_KINDS.has(object.userData.kind)) {
      let radius: number, height: number, capped: boolean;
      const bicolor = geometry.userData.pathTracingCylinder === true;
      if (bicolor) {
        // Only our canonical two-strip, open-ended bond geometry carries this marker.
        radius = 1; height = 1; capped = false;
      } else if (geometry instanceof CylinderGeometry) {
        const p = geometry.parameters;
        if (p.radiusTop !== p.radiusBottom || p.thetaStart !== 0 || p.thetaLength !== 2 * Math.PI || material.vertexColors) return;
        radius = p.radiusTop; height = p.height; capped = !p.openEnded;
      } else return;
      if (Math.abs(scale.z / scale.x - 1) > 1e-8) return;
      const worldRadius = Math.fround(radius * scale.x), halfLength = Math.fround(height * scale.y / 2);
      if (![worldRadius, halfLength].every(value => Number.isFinite(value) && value > 0)) return;
      const axis = [e[4]! / scale.y, e[5]! / scale.y, e[6]! / scale.y].map(Math.fround) as Vec3;
      let startColor: Vec3 = [1, 1, 1], endColor: Vec3 = [1, 1, 1];
      if (bicolor) {
        const color = geometry.getAttribute("color");
        if (!material.vertexColors || !color || color.itemSize < 3 || color.count < 2) return;
        startColor = [color.getX(0), color.getY(0), color.getZ(0)];
        endColor = [color.getX(color.count - 1), color.getY(color.count - 1), color.getZ(color.count - 1)];
        if (![...startColor, ...endColor].every(Number.isFinite)) return;
      }
      primitives.push({ kind: "cylinder", mesh, center: position, radius: worldRadius,
        axis, halfLength, capped, startColor, endColor });
    }
  });
  return primitives;
}

/** Mirror the vendor's traversal and isMesh predicate; counts/dummy geometry are not evidence. */
export function hasTriangleMeshes(scene: Scene, primitives: readonly TracePrimitive[]): boolean {
  const analyticMeshes = new Set<Object3D>(primitives.map(primitive => primitive.mesh));
  let found = false;
  scene.traverseVisible(object => {
    if ("isMesh" in object && object.isMesh && !analyticMeshes.has(object)) found = true;
  });
  return found;
}

/** Preserve the triangle material prefix: GPU vertex indices already refer to this array. */
export function packTracePrimitives(tracer: WebGLPathTracer, primitives: readonly TracePrimitive[], includeBounds = true): {
  primitives: Float32Array; bounds: Float64Array; extraData: Float32Array;
} {
  const adapter = tracer as unknown as PrimitiveCompatibleTracer;
  const indices = new Map(adapter._materials.map((material, index) => [material, index]));
  const data = new Float32Array(primitives.length * 6);
  const bounds = new Float64Array(includeBounds ? primitives.length * 6 : 0);
  const extraData = new Float32Array(primitives.filter(primitive => primitive.kind === "cylinder").length * 12);
  let cylinderIndex = 0;
  primitives.forEach((primitive, index) => {
    const material = primitive.mesh.material;
    let materialIndex = indices.get(material);
    if (materialIndex === undefined) {
      materialIndex = adapter._materials.length;
      adapter._materials.push(material);
      indices.set(material, materialIndex);
    }
    const cylinder = primitive.kind === "cylinder";
    data.set([...primitive.center, cylinder ? -primitive.radius : primitive.radius, materialIndex,
      cylinder ? cylinderIndex : -1], index * 6);
    let extents: Vec3 = [primitive.radius, primitive.radius, primitive.radius];
    if (primitive.kind === "cylinder") {
      if (includeBounds) {
        const axisLength = Math.hypot(...primitive.axis);
        // Cover CPU/GPU normalization rounding as well as Float32 packing.
        const padding = 2e-6 * (primitive.halfLength + primitive.radius);
        extents = primitive.axis.map(value => {
          const component = value / axisLength;
          return primitive.halfLength * Math.abs(component)
            + primitive.radius * Math.sqrt(Math.max(0, 1 - component * component)) + padding;
        }) as Vec3;
      }
      extraData.set([...primitive.axis, primitive.halfLength, ...primitive.startColor, primitive.capped ? 1 : 0,
        ...primitive.endColor, 0], cylinderIndex++ * 12);
    }
    for (let axis = 0; includeBounds && axis < 3; axis++) {
      bounds[index * 6 + axis] = primitive.center[axis]! - extents[axis]!;
      bounds[index * 6 + axis + 3] = primitive.center[axis]! + extents[axis]!;
    }
  });
  tracer.updateMaterials();
  return { primitives: data, bounds, extraData };
}

export function installPrimitiveGeometry(
  tracer: WebGLPathTracer, nodes: Float32Array, nodeCount: number, extraData: Float32Array, maxTextureSize: number,
  hasTriangles = true,
): { dispose(): void; restore(): void; update(nodes: Float32Array, extraData: Float32Array): void } {
  const material = (tracer as unknown as PrimitiveCompatibleTracer)._pathTracer.material;
  const originalShader = material.fragmentShader;
  const previousTriangleDefine = material.defines.CRYSTAL_HAS_TRIANGLES;
  const shader = primitiveIntersectionShader(originalShader);
  const texels = Math.max(1, nodeCount * 2 + extraData.length / 4);
  const width = Math.min(maxTextureSize, Math.max(1, Math.ceil(Math.sqrt(texels))));
  const height = Math.ceil(texels / width);
  if (height > maxTextureSize) throw new RangeError("The primitive BVH exceeds this GPU's texture size.");
  const data = new Float32Array(width * height * 4);
  data.set(nodes);
  data.set(extraData, nodes.length);
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const restoreSource = () => {
    material.fragmentShader = originalShader;
    delete material.uniforms.crystalPrimitiveNodes;
    delete material.uniforms.crystalPrimitiveNodeCount;
    if (previousTriangleDefine === undefined) delete material.defines.CRYSTAL_HAS_TRIANGLES;
    else material.defines.CRYSTAL_HAS_TRIANGLES = previousTriangleDefine;
  };
  try {
    material.uniforms.crystalPrimitiveNodes = { value: texture };
    material.uniforms.crystalPrimitiveNodeCount = { value: nodeCount };
    material.defines.CRYSTAL_HAS_TRIANGLES = hasTriangles ? 1 : 0;
    material.fragmentShader = shader;
    material.needsUpdate = true;
  } catch (error) {
    restoreSource();
    texture.dispose();
    throw error;
  }
  return {
    dispose: () => texture.dispose(),
    restore() { restoreSource(); texture.dispose(); material.needsUpdate = true; },
    update(nextNodes, nextExtraData) {
      if (nextNodes.length !== nodes.length || nextExtraData.length !== extraData.length) {
        throw new RangeError("Primitive texture updates require unchanged topology.");
      }
      data.set(nextNodes);
      data.set(nextExtraData, nextNodes.length);
      texture.needsUpdate = true;
      tracer.reset();
    },
  };
}

/**
 * Reconcile compatible snapshots without replacing the renderer, programs or BVH.
 * Analytic leaves may move/change radius; their existing topology is refitted.
 * Triangle vertices must be identical, but their material sharing may change.
 */
export function createPrimitiveSceneUpdater(
  tracer: WebGLPathTracer, source: Scene, primitives: TracePrimitive[], triangleGeometry: BufferGeometry,
  nodes: Float32Array, installed: ReturnType<typeof installPrimitiveGeometry>, includeCylinders: boolean,
): (next: Scene) => boolean {
  const adapter = tracer as unknown as PrimitiveCompatibleTracer;
  const meshesIn = (scene: Scene) => {
    const meshes: Mesh[] = [];
    scene.updateMatrixWorld(true);
    scene.traverseVisible(object => { if (object instanceof Mesh) meshes.push(object); });
    return meshes;
  };
  let meshes = meshesIn(source);
  let worlds = meshes.map(mesh => mesh.matrixWorld.clone());
  const analytic = new Set(primitives.map(primitive => primitive.mesh));
  let triangles = meshes.filter(mesh => !analytic.has(mesh as TracePrimitive["mesh"]))
    .sort((a, b) => a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0);
  // A wholly analytic scene still has the vendor's stable degenerate placeholder.
  const placeholderMaterials = triangles.length ? [] : adapter._materials.slice(0, 1);
  const attributeNames = ["index", "position", "normal", "tangent", "uv", "color"] as const;
  const attributeIn = (geometry: BufferGeometry, name: typeof attributeNames[number]) => name === "index" ? geometry.index : geometry.getAttribute(name);
  const attributeVersion = (attribute: ReturnType<typeof attributeIn>) => attribute
    ? "version" in attribute ? attribute.version : attribute.data.version : -1;
  const captureGeometry = (geometry: BufferGeometry) => ({ geometry,
    attributes: attributeNames.map(name => { const attribute = attributeIn(geometry, name); return { attribute, version: attributeVersion(attribute) }; }),
    groups: geometry.groups.map(group => ({ ...group })),
  });
  let geometryStates = meshes.map(mesh => analytic.has(mesh as TracePrimitive["mesh"]) ? null : captureGeometry(mesh.geometry));
  const geometryEqual = (a: BufferGeometry, b: BufferGeometry) => {
    if (a === b) return true;
    for (const name of ["index", "position", "normal", "tangent", "uv", "color"]) {
      const left = name === "index" ? a.index : a.getAttribute(name);
      const right = name === "index" ? b.index : b.getAttribute(name);
      if (!left || !right) { if (left !== right) return false; continue; }
      if (left.itemSize !== right.itemSize || left.normalized !== right.normalized
        || left.array.length !== right.array.length) return false;
      for (let index = 0; index < left.array.length; index++) if (left.array[index] !== right.array[index]) return false;
    }
    return a.groups.length === b.groups.length && a.groups.every((group, index) => {
      const next = b.groups[index]!;
      return group.start === next.start && group.count === next.count && group.materialIndex === next.materialIndex;
    });
  };
  return next => {
    const nextMeshes = meshesIn(next);
    if (meshes.length !== nextMeshes.length) return false;
    const pairs = new Map<Mesh, Mesh>();
    for (let index = 0; index < meshes.length; index++) {
      const before = meshes[index]!, after = nextMeshes[index]!;
      if (before.name !== after.name || before.userData.kind !== after.userData.kind
        || !(after.material instanceof MeshPhysicalMaterial)) return false;
      pairs.set(before, after);
    }
    const collected = collectTracePrimitives(next, includeCylinders);
    if (collected.length !== primitives.length) return false;
    const byMesh = new Map(collected.map(primitive => [primitive.mesh as Mesh, primitive]));
    const nextPrimitives: TracePrimitive[] = [];
    for (const primitive of primitives) {
      const replacement = byMesh.get(pairs.get(primitive.mesh)!);
      if (!replacement || primitive.kind !== replacement.kind) return false;
      nextPrimitives.push(replacement);
    }
    for (let index = 0; index < meshes.length; index++) {
      const after = nextMeshes[index]!;
      if (byMesh.has(after)) continue;
      const previous = geometryStates[index];
      if (!previous || !worlds[index]!.equals(after.matrixWorld)) return false;
      if (previous.geometry === after.geometry) {
        if (previous.attributes.some(({ attribute, version }, i) => {
          const current = attributeIn(after.geometry, attributeNames[i]!);
          return current !== attribute || attributeVersion(current) !== version;
        }) || previous.groups.length !== after.geometry.groups.length || previous.groups.some((group, i) => {
          const next = after.geometry.groups[i]!;
          return group.start !== next.start || group.count !== next.count || group.materialIndex !== next.materialIndex;
        })) return false;
      } else if (!geometryEqual(previous.geometry, after.geometry)) return false;
    }
    // Keep the original triangle mesh order, not the new snapshots' random UUID order.
    const nextTriangles = triangles.map(mesh => pairs.get(mesh)!);
    adapter._materials = nextTriangles.length
      ? nextTriangles.map(mesh => mesh.material as Material) : placeholderMaterials.slice();
    if (nextTriangles.length) {
      const attribute = triangleGeometry.getAttribute("materialIndex") as BufferAttribute;
      const index = triangleGeometry.index;
      for (const group of triangleGeometry.groups) {
        for (let vertex = group.start; vertex < group.start + group.count; vertex++) {
          attribute.setX(index ? index.getX(vertex) : vertex, group.materialIndex!);
        }
      }
      attribute.needsUpdate = true;
      adapter._pathTracer.material.materialIndexAttribute.updateFrom(attribute);
    }
    const boundsChanged = primitives.some((before, i) => {
      const after = nextPrimitives[i]!;
      return before.radius !== after.radius || before.center.some((value, axis) => value !== after.center[axis])
        || before.kind === "cylinder" && (after.kind !== "cylinder" || before.halfLength !== after.halfLength
          || before.axis.some((value, axis) => value !== after.axis[axis]));
    });
    const packed = packTracePrimitives(tracer, nextPrimitives, boundsChanged);
    if (boundsChanged) refitPrimitiveBVH(nodes, packed.primitives, packed.bounds);
    else for (let offset = 0; offset < nodes.length; offset += 8) {
      if (nodes[offset + 3] !== 0) nodes[offset + 4] = packed.primitives[nodes[offset + 5]! * 6 + 4]!;
    }
    installed.update(nodes, packed.extraData);
    adapter.scene = next;
    meshes = nextMeshes;
    worlds = meshes.map(mesh => mesh.matrixWorld.clone());
    geometryStates = meshes.map(mesh => byMesh.has(mesh) ? null : captureGeometry(mesh.geometry));
    triangles = nextTriangles;
    primitives = nextPrimitives;
    return true;
  };
}

/** Strict anchors fail on vendor upgrades instead of silently omitting a ray channel. */
export function primitiveIntersectionShader(source: string): string {
  const replace = (pattern: RegExp, replacement: string, count: number) => {
    const matches = source.match(pattern)?.length ?? 0;
    if (matches !== count) throw new Error("Incompatible path tracing primitive hook: expected " + count + ", found " + matches + ".");
    source = source.replace(pattern, replacement);
  };
  replace(/bvhIntersectFirstHit\( bvh,/g, "crystalIntersectFirstHit(", 2);
  replace(/uTexelFetch1D\( materialIndexAttribute, surfaceHit\.faceIndices\.x \)\.r/g,
    "crystalMaterialIndex( materialIndexAttribute, surfaceHit.faceIndices )", 2);
  replace(/uTexelFetch1D\( materialIndexAttribute, faceIndices\.x \)\.r/g,
    "crystalMaterialIndex( materialIndexAttribute, faceIndices )", 1);
  replace(/textureSampleBarycoord\(\s*attributesArray,\s*(ATTR_\w+),\s*surfaceHit\.barycoord,\s*surfaceHit\.faceIndices\.xyz\s*\)/g,
    "crystalAttribute( attributesArray, $1, surfaceHit.faceIndices, surfaceHit.barycoord )", 7);
  // Zero-weight lobes contribute exactly nothing and do not consume random samples.
  // Nonzero sheen/iridescence retain the complete original evaluation (including pearl/velvet).
  replace(/vec3 iridescenceF = evalIridescence\( 1\.0, surf\.iridescenceIor, dot\( wi, wh \), surf\.iridescenceThickness, f0Color \);\s*F = mix\( F, iridescenceF,  surf\.iridescence \);/g,
    "if ( surf.iridescence != 0.0 ) { $& }", 1);
  replace(/color \*= mix\( 1\.0, sheenAlbedoScaling\( wo, wi, surf \), surf\.sheen \);\s*color \+= sheenColor\( wo, wi, halfVector, surf \) \* surf\.sheen;/g,
    "if ( surf.sheen != 0.0 ) { $& }", 1);
  replace(/uniform BVH bvh;/g, "uniform BVH bvh;\n" + PRIMITIVE_INTERSECTION_GLSL, 1);
  return source;
}
