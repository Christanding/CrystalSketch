const BIN_COUNT = 16;
const MAX_PRIMITIVES = 12_000;
const MAX_SAH_DEPTH = 24;
const roundedFloat = new Float32Array(1);
const roundedBits = new Uint32Array(roundedFloat.buffer);

/** Round outward by one Float32 ULP, including signed zero and overflow. */
function outwardFloat(value: number, upper: boolean): number {
  roundedFloat[0] = value;
  const rounded = roundedFloat[0]!;
  if (rounded === (upper ? Infinity : -Infinity)) return rounded;
  if (rounded === 0) roundedBits[0] = upper ? 1 : 0x80000001;
  else roundedBits[0] = roundedBits[0]! + ((rounded > 0) === upper ? 1 : -1);
  return roundedFloat[0]!;
}

function emptyBounds(count = 1): Float64Array {
  const bounds = new Float64Array(count * 6);
  for (let i = 0; i < count; i++) {
    bounds.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], i * 6);
  }
  return bounds;
}

function mergeBounds(target: Float64Array, source: Float64Array, offset: number, targetOffset = 0): void {
  for (let axis = 0; axis < 3; axis++) {
    target[targetOffset + axis] = Math.min(target[targetOffset + axis]!, source[offset + axis]!);
    target[targetOffset + axis + 3] = Math.max(target[targetOffset + axis + 3]!, source[offset + axis + 3]!);
  }
}

function area(bounds: Float64Array): number {
  const x = bounds[3]! - bounds[0]!;
  const y = bounds[4]! - bounds[1]!;
  const z = bounds[5]! - bounds[2]!;
  return x * y + y * z + z * x;
}

/**
 * Input: [world center.xyz, signedRadius, materialIndex, extraIndex] per primitive.
 * Positive radii mark spheres (extraIndex = -1); negative radii mark cylinders
 * (extraIndex indexes their additional data). Callers supply conservative world
 * bounds [min.xyz, max.xyz] derived from the actual Float32 geometry parameters.
 * Preorder nodes use two RGBA texels each:
 * internal = [outward min.xyz, 0, outward max.xyz, escapeIndex];
 * leaf = [center.xyz, signedRadius, materialIndex, originalPrimitiveIndex, extraIndex, escapeIndex].
 * Enter an intersected internal node at index + 1; otherwise jump to escapeIndex.
 * A leaf advances to index + 1. The root escapes to nodeCount.
 */
export function buildPrimitiveBVH(
  primitives: Float32Array, bounds: Float64Array,
): { nodes: Float32Array; nodeCount: number } {
  if (!(primitives instanceof Float32Array) || !(bounds instanceof Float64Array)
    || primitives.length % 6 !== 0 || bounds.length !== primitives.length) {
    throw new TypeError("Primitive BVH requires six Float32 primitive values and six Float64 bounds per primitive.");
  }
  const primitiveCount = primitives.length / 6;
  if (primitiveCount > MAX_PRIMITIVES) throw new RangeError(`Primitive BVH supports at most ${MAX_PRIMITIVES} primitives.`);
  for (let offset = 0; offset < primitives.length; offset += 6) {
    const radius = primitives[offset + 3]!;
    const material = primitives[offset + 4]!;
    const extra = primitives[offset + 5]!;
    if (!Number.isFinite(radius) || radius === 0 || !Number.isInteger(material) || material < 0
      || (radius > 0 ? extra !== -1 : !Number.isInteger(extra) || extra < 0)) {
      throw new RangeError("Primitive BVH requires nonzero finite radii, non-negative integer materials and valid extra indices.");
    }
    for (let axis = 0; axis < 3; axis++) {
      const center = primitives[offset + axis]!;
      const min = bounds[offset + axis]!;
      const max = bounds[offset + axis + 3]!;
      if (!Number.isFinite(center) || !Number.isFinite(min) || !Number.isFinite(max) || min > center || max < center) {
        throw new RangeError("Primitive BVH bounds must be finite, ordered and contain the finite primitive center.");
      }
    }
  }
  const nodeCount = Math.max(0, primitiveCount * 2 - 1);
  const nodes = new Float32Array(nodeCount * 8);
  const order = new Uint32Array(primitiveCount);
  for (let i = 0; i < primitiveCount; i++) order[i] = i;
  let nextNode = 0;

  function emit(start: number, end: number, depth: number): void {
    const offset = nextNode++ * 8;
    if (end - start === 1) {
      const primitive = order[start]!;
      nodes.set(primitives.subarray(primitive * 6, primitive * 6 + 5), offset);
      nodes[offset + 5] = primitive;
      nodes[offset + 6] = primitives[primitive * 6 + 5]!;
      nodes[offset + 7] = nextNode;
      return;
    }

    const nodeBounds = emptyBounds();
    const centers = emptyBounds();
    for (let i = start; i < end; i++) {
      const primitive = order[i]!;
      mergeBounds(nodeBounds, bounds, primitive * 6);
      for (let axis = 0; axis < 3; axis++) {
        const center = primitives[primitive * 6 + axis]!;
        centers[axis] = Math.min(centers[axis]!, center);
        centers[axis + 3] = Math.max(centers[axis + 3]!, center);
      }
    }
    for (let axis = 0; axis < 3; axis++) {
      nodes[offset + axis] = outwardFloat(nodeBounds[axis]!, false);
      nodes[offset + 4 + axis] = outwardFloat(nodeBounds[axis + 3]!, true);
    }
    const binFor = (primitive: number, axis: number) => Math.min(BIN_COUNT - 1, Math.floor(
      (primitives[primitive * 6 + axis]! - centers[axis]!) / (centers[axis + 3]! - centers[axis]!) * BIN_COUNT,
    ));

    let bestCost = Infinity;
    let bestAxis = -1;
    let bestBin = -1;
    for (let axis = 0; depth < MAX_SAH_DEPTH && axis < 3; axis++) {
      if (centers[axis] === centers[axis + 3]) continue;
      const counts = new Uint32Array(BIN_COUNT);
      const bins = emptyBounds(BIN_COUNT);
      for (let i = start; i < end; i++) {
        const primitive = order[i]!;
        const bin = binFor(primitive, axis);
        counts[bin] = counts[bin]! + 1;
        mergeBounds(bins, bounds, primitive * 6, bin * 6);
      }
      const leftCounts = new Uint32Array(BIN_COUNT);
      const leftCosts = new Float64Array(BIN_COUNT);
      const leftBounds = emptyBounds();
      let leftCount = 0;
      for (let bin = 0; bin < BIN_COUNT; bin++) {
        if (counts[bin]) mergeBounds(leftBounds, bins, bin * 6);
        leftCount += counts[bin]!;
        leftCounts[bin] = leftCount;
        leftCosts[bin] = leftCount ? leftCount * area(leftBounds) : 0;
      }
      const rightBounds = emptyBounds();
      let rightCount = 0;
      for (let bin = BIN_COUNT - 1; bin > 0; bin--) {
        if (counts[bin]) mergeBounds(rightBounds, bins, bin * 6);
        rightCount += counts[bin]!;
        if (!rightCount || !leftCounts[bin - 1]) continue;
        const cost = leftCosts[bin - 1]! + rightCount * area(rightBounds);
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestBin = bin - 1;
        }
      }
    }

    let middle = start;
    if (bestAxis >= 0) {
      let right = end - 1;
      while (middle <= right) {
        if (binFor(order[middle]!, bestAxis) <= bestBin) middle++;
        else {
          const swap = order[middle]!;
          order[middle] = order[right]!;
          order[right--] = swap;
        }
      }
    }
    // Coincident centers and deep, unbalanced SAH trees use a bounded median split.
    if (middle === start || middle === end) {
      let axis = 0;
      for (let candidate = 1; candidate < 3; candidate++) {
        if (centers[candidate + 3]! - centers[candidate]! > centers[axis + 3]! - centers[axis]!) axis = candidate;
      }
      if (centers[axis] !== centers[axis + 3]) {
        order.subarray(start, end).sort((a, b) => primitives[a * 6 + axis]! - primitives[b * 6 + axis]! || a - b);
      }
      middle = start + Math.floor((end - start) / 2);
    }
    emit(start, middle, depth + 1);
    emit(middle, end, depth + 1);
    nodes[offset + 7] = nextNode;
  }

  if (primitiveCount) emit(0, primitiveCount, 0);
  return { nodes, nodeCount };
}

/** Keep topology and leaf ordering while refreshing primitive data and conservative bounds. */
export function refitPrimitiveBVH(nodes: Float32Array, primitives: Float32Array, bounds: Float64Array): void {
  const count = primitives.length / 6;
  if (!Number.isInteger(count) || bounds.length !== primitives.length
    || nodes.length !== Math.max(0, count * 2 - 1) * 8) {
    throw new RangeError("Primitive BVH refit requires unchanged topology.");
  }
  // Leaves carry originalPrimitiveIndex independently of their SAH order.
  // Internal nodes can then merge their two children in reverse preorder.
  const fittedBounds = new Float64Array(nodes.length / 8 * 6);
  for (let node = nodes.length / 8 - 1; node >= 0; node--) {
    const offset = node * 8, target = node * 6;
    if (nodes[offset + 3] !== 0) {
      const primitive = nodes[offset + 5]!;
      if (!Number.isInteger(primitive) || primitive < 0 || primitive >= count) {
        throw new RangeError("Invalid primitive BVH leaf during refit.");
      }
      nodes.set(primitives.subarray(primitive * 6, primitive * 6 + 5), offset);
      nodes[offset + 6] = primitives[primitive * 6 + 5]!;
      fittedBounds.set(bounds.subarray(primitive * 6, primitive * 6 + 6), target);
    } else {
      const left = node + 1, right = Math.trunc(nodes[left * 8 + 7]!);
      for (let axis = 0; axis < 3; axis++) {
        const min = Math.min(fittedBounds[left * 6 + axis]!, fittedBounds[right * 6 + axis]!);
        const max = Math.max(fittedBounds[left * 6 + axis + 3]!, fittedBounds[right * 6 + axis + 3]!);
        fittedBounds[target + axis] = min;
        fittedBounds[target + axis + 3] = max;
        nodes[offset + axis] = outwardFloat(min, false);
        nodes[offset + axis + 4] = outwardFloat(max, true);
      }
    }
  }
}
