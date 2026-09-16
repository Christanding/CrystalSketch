import { describe, expect, test } from "bun:test";
import { buildPrimitiveBVH, refitPrimitiveBVH } from "../src/scene/pathTracingPrimitiveBVH";

type Vec3 = [number, number, number];

function sphereBounds(spheres: Float32Array): Float64Array {
  const bounds = new Float64Array(spheres.length);
  for (let offset = 0; offset < spheres.length; offset += 6) {
    for (let axis = 0; axis < 3; axis++) {
      bounds[offset + axis] = spheres[offset + axis]! - spheres[offset + 3]!;
      bounds[offset + axis + 3] = spheres[offset + axis]! + spheres[offset + 3]!;
    }
  }
  return bounds;
}

function verifyTree(primitives: Float32Array, bounds = sphereBounds(primitives)): number {
  const snapshot = primitives.slice();
  const boundsSnapshot = bounds.slice();
  const { nodes, nodeCount } = buildPrimitiveBVH(primitives, bounds);
  expect(nodeCount).toBe(Math.max(0, primitives.length / 6 * 2 - 1));
  expect(nodes.length).toBe(nodeCount * 8);
  const seen = new Set<number>();
  let maxDepth = 0;
  function visit(index: number, ancestors: number[], depth: number): number {
    expect(index).toBeLessThan(nodeCount);
    maxDepth = Math.max(maxDepth, depth);
    const offset = index * 8;
    const escape = nodes[offset + 7]!;
    expect(Number.isInteger(escape)).toBe(true);
    expect(escape).toBeGreaterThan(index);
    expect(escape).toBeLessThanOrEqual(nodeCount);
    if (nodes[offset + 3] !== 0) {
      const original = nodes[offset + 5]!;
      expect(Number.isInteger(original)).toBe(true);
      expect(original).toBeGreaterThanOrEqual(0);
      expect(original).toBeLessThan(primitives.length / 6);
      expect(seen.has(original)).toBe(false);
      seen.add(original);
      expect(Array.from(nodes.subarray(offset, offset + 5))).toEqual(Array.from(primitives.subarray(original * 6, original * 6 + 5)));
      expect(nodes[offset + 6]).toBe(primitives[original * 6 + 5]!);
      expect(escape).toBe(index + 1);
      for (const ancestor of ancestors) {
        for (let axis = 0; axis < 3; axis++) {
          expect(nodes[ancestor * 8 + axis]!).toBeLessThanOrEqual(bounds[original * 6 + axis]!);
          expect(nodes[ancestor * 8 + 4 + axis]!).toBeGreaterThanOrEqual(bounds[original * 6 + axis + 3]!);
        }
      }
    } else {
      expect(nodes[offset + 3]).toBe(0);
      for (let axis = 0; axis < 3; axis++) {
        expect(nodes[offset + axis]!).toBeLessThanOrEqual(nodes[offset + 4 + axis]!);
      }
      const leftEnd = visit(index + 1, [...ancestors, index], depth + 1);
      expect(visit(leftEnd, [...ancestors, index], depth + 1)).toBe(escape);
    }
    return escape;
  }
  if (nodeCount) expect(visit(0, [], 0)).toBe(nodeCount);
  expect(seen.size).toBe(primitives.length / 6);
  expect(primitives).toEqual(snapshot);
  expect(bounds).toEqual(boundsSnapshot);
  return maxDepth;
}

function raySphere(spheres: Float32Array, offset: number, origin: Vec3, direction: Vec3): number {
  let a = 0;
  let b = 0;
  let c = -(spheres[offset + 3]! ** 2);
  for (let axis = 0; axis < 3; axis++) {
    const delta = origin[axis]! - spheres[offset + axis]!;
    a += direction[axis]! ** 2;
    b += delta * direction[axis]!;
    c += delta * delta;
  }
  const discriminant = b * b - a * c;
  if (discriminant < 0) return Infinity;
  const near = (-b - Math.sqrt(discriminant)) / a;
  const far = (-b + Math.sqrt(discriminant)) / a;
  return near >= 0 ? near : far >= 0 ? far : Infinity;
}

function rayBox(
  nodes: Float32Array | Float64Array, offset: number, origin: Vec3, direction: Vec3,
  closest: number, upperOffset = 4,
): boolean {
  let near = 0;
  let far = closest;
  for (let axis = 0; axis < 3; axis++) {
    const min = nodes[offset + axis]!;
    const max = nodes[offset + upperOffset + axis]!;
    if (direction[axis] === 0) {
      if (origin[axis]! < min || origin[axis]! > max) return false;
    } else {
      const a = (min - origin[axis]!) / direction[axis]!;
      const b = (max - origin[axis]!) / direction[axis]!;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
      if (near > far) return false;
    }
  }
  return true;
}

function rayBVH(nodes: Float32Array, origin: Vec3, direction: Vec3): number {
  let closest = Infinity;
  for (let index = 0; index < nodes.length / 8;) {
    const offset = index * 8;
    if (nodes[offset + 3]! > 0) {
      closest = Math.min(closest, raySphere(nodes, offset, origin, direction));
      index++;
    } else if (rayBox(nodes, offset, origin, direction, closest)) index++;
    else index = nodes[offset + 7]!;
  }
  return closest;
}

describe("analytic primitive BVH", () => {
  test("refits enlarged and moved leaves without changing topology or missing new silhouettes", () => {
    const primitives = new Float32Array([0, 0, 0, 0.2, 0, -1, 3, 0, 0, 0.1, 1, -1, 6, 0, 0, 0.3, 2, -1]);
    const { nodes } = buildPrimitiveBVH(primitives, sphereBounds(primitives));
    const escapes = Array.from(nodes).filter((_, index) => index % 8 === 7);
    const leafIds = Array.from({ length: nodes.length / 8 }, (_, index) => nodes[index * 8 + 3] !== 0 ? nodes[index * 8 + 5] : null);
    primitives.set([0, 0, 0, 2, 7, -1], 0);
    primitives.set([9, -2, 0, 1, 8, -1], 6);
    refitPrimitiveBVH(nodes, primitives, sphereBounds(primitives));
    expect(Array.from(nodes).filter((_, index) => index % 8 === 7)).toEqual(escapes);
    expect(Array.from({ length: nodes.length / 8 }, (_, index) => nodes[index * 8 + 3] !== 0 ? nodes[index * 8 + 5] : null)).toEqual(leafIds);
    for (const origin of [[1.5, 0, 10], [9, -2, 10], [6, 0, 10], [12, 3, 10]] as Vec3[]) {
      const expected = Math.min(...[0, 6, 12].map(offset => raySphere(primitives, offset, origin, [0, 0, -1])));
      expect(rayBVH(nodes, origin, [0, 0, -1])).toBe(expected);
    }
    expect(() => refitPrimitiveBVH(nodes, primitives.subarray(6), sphereBounds(primitives.subarray(6)))).toThrow();
  });
  test("empty, single-sphere and single-cylinder layouts obey the stackless traversal contract", () => {
    expect(buildPrimitiveBVH(new Float32Array(), new Float64Array())).toEqual({ nodes: new Float32Array(), nodeCount: 0 });
    const sphere = new Float32Array([2, -3, 5, 0.75, 7, -1]);
    expect(buildPrimitiveBVH(sphere, sphereBounds(sphere)).nodes).toEqual(new Float32Array([2, -3, 5, 0.75, 7, 0, -1, 1]));
    verifyTree(sphere);
    const cylinder = new Float32Array([1, 2, 3, -0.5, 4, 9]);
    const cylinderBounds = new Float64Array([0.5, 1.5, 1, 1.5, 2.5, 5]);
    expect(buildPrimitiveBVH(cylinder, cylinderBounds).nodes).toEqual(new Float32Array([1, 2, 3, -0.5, 4, 0, 9, 1]));
    verifyTree(cylinder, cylinderBounds);
  });

  test("preorder children, escapes and conservative ancestor bounds cover each original sphere once", () => {
    const spheres = new Float32Array(Array.from({ length: 137 }, (_, i) => [
      Math.sin(i * 1.8) * 17, Math.cos(i * 0.7) * 9, i % 11 - 5, 0.01 + i % 7 / 3, i % 9, -1,
    ]).flat());
    verifyTree(spheres);
    expect(buildPrimitiveBVH(spheres, sphereBounds(spheres)).nodes).toEqual(buildPrimitiveBVH(spheres, sphereBounds(spheres)).nodes);
  });

  test("mixed and cylinder-only traversal preserves exactly the brute-force AABB hit set", () => {
    for (const cylindersOnly of [false, true]) {
      const primitives = new Float32Array(Array.from({ length: 257 }, (_, i) => {
        const cylinder = cylindersOnly || i % 2 === 1;
        return [Math.sin(i * 1.8) * 9, Math.cos(i * 0.7) * 6, i % 11 - 5, cylinder ? -0.15 : 0.3, i % 7, cylinder ? i : -1];
      }).flat());
      const bounds = new Float64Array(primitives.length);
      for (let offset = 0; offset < primitives.length; offset += 6) {
        for (let axis = 0; axis < 3; axis++) {
          // Exact AABBs for spheres and finite cylinders aligned along world Y.
          const extent = primitives[offset + 3]! < 0 && axis === 1 ? 0.4 + offset % 7 * 0.3 : Math.abs(primitives[offset + 3]!);
          bounds[offset + axis] = primitives[offset + axis]! - extent;
          bounds[offset + axis + 3] = primitives[offset + axis]! + extent;
        }
      }
      verifyTree(primitives, bounds);
      const { nodes } = buildPrimitiveBVH(primitives, bounds);
      for (let ray = 0; ray < 257; ray++) {
        const center: Vec3 = [primitives[ray * 6]!, primitives[ray * 6 + 1]!, primitives[ray * 6 + 2]!];
        const origin: Vec3 = ray % 3 === 0 ? [-20, center[1], center[2]] : [20, Math.sin(ray) * 10, Math.cos(ray) * 8];
        const direction: Vec3 = ray % 3 === 0 ? [1, 0, 0] : [center[0] - origin[0], center[1] - origin[1], center[2] - origin[2]];
        const expected: number[] = [];
        for (let primitive = 0; primitive < 257; primitive++) {
          if (rayBox(bounds, primitive * 6, origin, direction, Infinity, 3)) expected.push(primitive);
        }
        const actual: number[] = [];
        for (let index = 0; index < nodes.length / 8;) {
          const offset = index * 8;
          if (nodes[offset + 3] !== 0) {
            const primitive = nodes[offset + 5]!;
            if (rayBox(bounds, primitive * 6, origin, direction, Infinity, 3)) actual.push(primitive);
            index++;
          } else if (rayBox(nodes, offset, origin, direction, Infinity)) index++;
          else index = nodes[offset + 7]!;
        }
        expect(actual.sort((a, b) => a - b)).toEqual(expected);
      }
    }
  });

  test("12,000 coincident spheres split evenly and deep SAH distributions stay bounded", () => {
    const coincident = new Float32Array(Array.from({ length: 12_000 }, (_, i) => [1, 2, 3, 1, i % 5, -1]).flat());
    expect(verifyTree(coincident)).toBeLessThanOrEqual(Math.ceil(Math.log2(12_000)));
    const skewed = new Float32Array(Array.from({ length: 512 }, (_, i) => [1.15 ** i, 0, 0, 0.1, 0, -1]).flat());
    expect(verifyTree(skewed)).toBeLessThanOrEqual(24 + Math.ceil(Math.log2(512)));
  });

  test("Float32 packing never shrinks bounds at large coordinates, subnormal radii or overflow", () => {
    const smallest = 2 ** -149;
    verifyTree(new Float32Array([
      2 ** 24, -(2 ** 24), 0, 0.25, 0, -1,
      -(2 ** 24), 2 ** 24, 0, 0.25, 1, -1,
      0, smallest, -smallest, smallest, 2, -1,
    ]));
    const extreme = new Float32Array([3e38, -3e38, 0, 2e38, 0, -1, -3e38, 3e38, 0, 2e38, 1, -1]);
    verifyTree(extreme);
    const { nodes } = buildPrimitiveBVH(extreme, sphereBounds(extreme));
    expect(nodes[0]).toBe(-Infinity);
    expect(nodes[4]).toBe(Infinity);
  });

  test("stackless traversal agrees with brute-force nearest hits, including inside and parallel rays", () => {
    let seed = 0x31ad87;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
    const spheres = new Float32Array(Array.from({ length: 400 }, (_, i) => [
      random() * 24 - 12, random() * 24 - 12, random() * 24 - 12, random() * 0.65 + 0.05, i % 7, -1,
    ]).flat());
    const { nodes } = buildPrimitiveBVH(spheres, sphereBounds(spheres));
    const rays: [Vec3, Vec3][] = [];
    for (let i = 0; i < 800; i++) {
      const sphere = i % 400 * 6;
      const center: Vec3 = [spheres[sphere]!, spheres[sphere + 1]!, spheres[sphere + 2]!];
      const origin: Vec3 = i % 7 === 0 ? center : [random() * 60 - 30, random() * 60 - 30, random() * 60 - 30];
      const direction: Vec3 = i % 7 === 0 ? [1, 0, 0] : [center[0] - origin[0], center[1] - origin[1], center[2] - origin[2]];
      rays.push([origin, direction]);
      rays.push([origin, [random() - 0.5, random() - 0.5, random() - 0.5]]);
    }
    for (const [origin, direction] of rays) {
      let bruteForce = Infinity;
      for (let offset = 0; offset < spheres.length; offset += 6) {
        bruteForce = Math.min(bruteForce, raySphere(spheres, offset, origin, direction));
      }
      expect(rayBVH(nodes, origin, direction)).toBe(bruteForce);
    }
    const tangent = new Float32Array([0, 0, 0, 1, 0, -1, 20, 0, 0, 1, 1, -1]);
    expect(rayBVH(buildPrimitiveBVH(tangent, sphereBounds(tangent)).nodes, [-2, 1, 0], [1, 0, 0])).toBe(2);
    expect(rayBVH(buildPrimitiveBVH(tangent, sphereBounds(tangent)).nodes, [-2, 2, 0], [1, 0, 0])).toBe(Infinity);
  });

  test("rejects malformed, non-finite, invalid-radius, invalid-material and invalid-extra inputs", () => {
    const bounds = new Float64Array([-1, -1, -1, 1, 1, 1]);
    expect(() => buildPrimitiveBVH(new Float32Array(5), bounds)).toThrow(TypeError);
    expect(() => buildPrimitiveBVH(new Float32Array(6), new Float64Array(12))).toThrow(TypeError);
    expect(() => buildPrimitiveBVH([0, 0, 0, 1, 0, -1] as unknown as Float32Array, bounds)).toThrow(TypeError);
    expect(() => buildPrimitiveBVH(new Float32Array(6), new Float32Array(6) as unknown as Float64Array)).toThrow(TypeError);
    expect(() => buildPrimitiveBVH(new Float32Array(12_001 * 6), new Float64Array(12_001 * 6))).toThrow("at most 12000");
    for (const [offset, values] of [
      [0, [NaN, Infinity, -Infinity]], [1, [NaN, Infinity]], [2, [NaN, -Infinity]],
      [3, [0, -0, NaN, Infinity, -Infinity]], [4, [-1, 0.5, NaN, Infinity]], [5, [-2, 0, 0.5, NaN, Infinity]],
    ] as const) {
      for (const value of values) {
        const sphere = new Float32Array([0, 0, 0, 1, 0, -1]);
        sphere[offset] = value;
        expect(() => buildPrimitiveBVH(sphere, bounds)).toThrow(RangeError);
      }
    }
    for (const extra of [-1, -2, 0.5, NaN, Infinity]) {
      expect(() => buildPrimitiveBVH(new Float32Array([0, 0, 0, -1, 0, extra]), bounds)).toThrow(RangeError);
    }
  });

  test("rejects non-finite, reversed and center-excluding supplied bounds", () => {
    const sphere = new Float32Array([0, 0, 0, 1, 0, -1]);
    for (let axis = 0; axis < 3; axis++) {
      for (const value of [NaN, Infinity, -Infinity, 1, 2]) {
        const bounds = sphereBounds(sphere);
        bounds[axis] = value;
        expect(() => buildPrimitiveBVH(sphere, bounds)).toThrow(RangeError);
      }
      for (const value of [NaN, Infinity, -Infinity, -1]) {
        const bounds = sphereBounds(sphere);
        bounds[axis + 3] = value;
        expect(() => buildPrimitiveBVH(sphere, bounds)).toThrow(RangeError);
      }
    }
  });
});
