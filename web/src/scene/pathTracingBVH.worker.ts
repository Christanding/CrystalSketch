import { BufferAttribute, BufferGeometry } from "three";
import { MeshBVH, type MeshBVHOptions, type SerializedBVH } from "three-mesh-bvh";
import { buildPrimitiveBVH } from "./pathTracingPrimitiveBVH";

type IndexArray = Uint16Array | Uint32Array;
// BVH 0.8.3 implements indirectBuffer, but omits it from SerializedBVH's declarations.
export interface PathTracingSerializedBVH extends SerializedBVH {
  index: IndexArray;
  indirectBuffer?: IndexArray | null;
}
export interface PathTracingMeshBVHRequest {
  type: "mesh";
  position: Float32Array;
  index: IndexArray | null;
  groups: BufferGeometry["groups"];
  options: Omit<MeshBVHOptions, "onProgress"> & { indirect?: boolean };
}
export type PathTracingBVHRequest = PathTracingMeshBVHRequest
  | { type: "primitives"; primitives: Float32Array; bounds: Float64Array };
export type PathTracingBVHResponse =
  | { type: "progress"; progress: number }
  | { type: "mesh"; serialized: PathTracingSerializedBVH }
  | { type: "primitives"; nodes: Float32Array; nodeCount: number }
  | { type: "error"; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PathTracingBVHRequest>) => void) | null;
  postMessage(message: PathTracingBVHResponse, transfer?: Transferable[]): void;
};

scope.onmessage = ({ data }) => {
  if (data.type === "primitives") {
    try {
      const result = buildPrimitiveBVH(data.primitives, data.bounds);
      scope.postMessage({ type: "primitives", ...result }, [result.nodes.buffer as ArrayBuffer]);
    } catch (error) {
      scope.postMessage({ type: "error", message: error instanceof Error ? error.message : "Primitive BVH generation failed." });
    }
    return;
  }
  const geometry = new BufferGeometry();
  try {
    geometry.setAttribute("position", new BufferAttribute(data.position, 3));
    if (data.index) geometry.setIndex(new BufferAttribute(data.index, 1));
    for (const group of data.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
    let lastProgressTime = 0;
    const bvh = new MeshBVH(geometry, { ...data.options,
      onProgress: progress => {
        const now = performance.now();
        if (now - lastProgressTime > 50) {
          scope.postMessage({ type: "progress", progress: Math.min(1, progress) });
          lastProgressTime = now;
        }
      },
    });
    const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false }) as PathTracingSerializedBVH;
    const buffers = [...serialized.roots, serialized.index.buffer, serialized.indirectBuffer?.buffer]
      .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
    scope.postMessage({ type: "mesh", serialized }, [...new Set(buffers)]);
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : "BVH generation failed." });
  } finally {
    geometry.dispose();
  }
};
