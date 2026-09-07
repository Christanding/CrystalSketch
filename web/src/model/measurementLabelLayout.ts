import type { ResolvedMeasurement } from "./measurements";

type Point3 = readonly [number, number, number];
type Point2 = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export const LABEL_FONT_SIZE = 56;
export const LABEL_CANVAS_HEIGHT = 88;
export const MEASUREMENT_LABEL_CENTER: [number, number] = [0.5, 0.08];

export function measurementLabelSize(label: string, span: number, fontScale = 100) {
  const canvasWidth = Math.min(512, Math.max(96, label.length * LABEL_FONT_SIZE + 32));
  const fontPercent = Number.isFinite(fontScale) ? Math.min(250, Math.max(50, fontScale)) : 100;
  const height = safeSpan(span) * 0.042 * fontPercent / 100;
  return { canvasWidth, height, width: height * canvasWidth / LABEL_CANVAS_HEIGHT };
}

export function measurementLabelInkSize(label: string, span: number, fontScale = 100) {
  const sprite = measurementLabelSize(label, span, fontScale);
  // Advance widths come from bundled Geist Mono digits and WenKai punctuation/units.
  const advances: Record<string, number> = { " ": 0.35, ".": 0.35, "Å": 0.69, "°": 0.32, "-": 0.35, "+": 0.6 };
  const emWidth = [...label].reduce((sum, char) => sum + (/\d/.test(char) ? 0.6 : advances[char] ?? 1), 0);
  return {
    width: Math.min(sprite.width, sprite.height * (emWidth + 0.16) * LABEL_FONT_SIZE / LABEL_CANVAS_HEIGHT),
    height: sprite.height * 0.7,
    // Texture text is centered 3 canvas pixels below the canvas midpoint.
    centerOffsetY: sprite.height * (0.5 - MEASUREMENT_LABEL_CENTER[1] - 3 / LABEL_CANVAS_HEIGHT),
  };
}

export interface MeasurementLabelObstacle {
  position: Point3;
  radius: number;
}

export interface MeasurementLabelSegment {
  start: Point3;
  end: Point3;
  radius?: number;
}

export interface MeasurementLabelLayoutOptions {
  measurements: readonly ResolvedMeasurement[];
  cameraQuaternion: readonly [number, number, number, number];
  span: number;
  fontScale?: number;
  obstacles?: readonly MeasurementLabelObstacle[];
  segments?: readonly MeasurementLabelSegment[];
}

type CollisionItem =
  | { kind: "atom"; bounds: Bounds; center: Point2; radius: number }
  | { kind: "bond"; bounds: Bounds; start: Point2; end: Point2; radius: number }
  | { kind: "label"; bounds: Bounds };

export function layoutMeasurementLabels({
  measurements, cameraQuaternion, span, fontScale = 100, obstacles = [], segments = [],
}: MeasurementLabelLayoutOptions): Map<string, [number, number, number]> {
  const result = new Map<string, [number, number, number]>();
  if (!measurements.length) return result;
  const scale = safeSpan(span);
  const { right, up } = cameraPlane(cameraQuaternion);
  const project = (point: Point3): Point2 => ({ x: dot(point, right), y: dot(point, up) });
  const index = new CollisionGrid(scale * 0.08);
  for (const obstacle of obstacles) {
    if (!finitePoint(obstacle.position)) continue;
    const center = project(obstacle.position);
    const radius = Number.isFinite(obstacle.radius) ? Math.max(0, obstacle.radius) : 0;
    index.add({ kind: "atom", center, radius, bounds: rectangle(center, radius * 2, radius * 2) });
  }
  const measurementSegments: MeasurementLabelSegment[] = measurements.flatMap(measurement =>
    measurement.points.slice(1).map((end, index) => ({ start: measurement.points[index]!, end, radius: scale * 0.00075 })));
  for (const segment of [...segments, ...measurementSegments]) {
    if (!finitePoint(segment.start) || !finitePoint(segment.end)) continue;
    const start = project(segment.start), end = project(segment.end);
    const radius = Number.isFinite(segment.radius) ? Math.max(0, segment.radius ?? 0) : 0;
    index.add({ kind: "bond", start, end, radius, bounds: {
      minX: Math.min(start.x, end.x) - radius, minY: Math.min(start.y, end.y) - radius,
      maxX: Math.max(start.x, end.x) + radius, maxY: Math.max(start.y, end.y) + radius,
    } });
  }

  // Angles have less freedom than distances, which can use either side of a bond.
  const ordered = [...measurements.filter(item => item.definition.kind === "angle"),
    ...measurements.filter(item => item.definition.kind === "distance")];
  for (const measurement of ordered) {
    const origin: Point3 = finitePoint(measurement.labelPosition) ? measurement.labelPosition : [0, 0, 0];
    const projectedOrigin = project(origin);
    const spriteHeight = measurementLabelSize(measurement.label, scale, fontScale).height;
    const { width, height, centerOffsetY } = measurementLabelInkSize(measurement.label, scale, fontScale);
    const gap = spriteHeight * 0.08;
    const candidates = labelCandidates(measurement, project, projectedOrigin, spriteHeight, centerOffsetY);
    let chosen = candidates[0]!;
    let bestScore = Infinity;
    for (const candidate of candidates) {
      const bounds = rectangle(candidate, width, height);
      const displacement = Math.hypot(candidate.x - candidates[0]!.x, candidate.y - candidates[0]!.y);
      let score = displacement ** 2 / spriteHeight ** 2;
      let geometryPenalty = 0;
      for (const item of index.query(expand(bounds, gap))) {
        if (item.kind === "label") score += collisionPenalty(bounds, item, gap);
        else if (geometryPenalty < 0.05) geometryPenalty = Math.min(0.05, geometryPenalty + collisionPenalty(bounds, item, gap));
        if (score + geometryPenalty >= bestScore) break;
      }
      score += geometryPenalty;
      if (score < bestScore) {
        bestScore = score;
        chosen = candidate;
      }
      if (bestScore === 0) break;
    }
    index.add({ kind: "label", bounds: rectangle(chosen, width, height) });
    const dx = chosen.x - projectedOrigin.x;
    const dy = chosen.y - projectedOrigin.y - centerOffsetY;
    result.set(measurement.definition.id, [
      origin[0] + right[0] * dx + up[0] * dy,
      origin[1] + right[1] * dx + up[1] * dy,
      origin[2] + right[2] * dx + up[2] * dy,
    ]);
  }
  return result;
}

function labelCandidates(
  measurement: ResolvedMeasurement, project: (point: Point3) => Point2, origin: Point2,
  height: number, centerOffsetY: number,
): Point2[] {
  const points = measurement.points.filter(finitePoint).map(project);
  let direction: Point2;
  if (measurement.definition.kind === "distance") {
    const first = points[0] ?? origin, last = points[1] ?? origin;
    const tangent = normalized({ x: last.x - first.x, y: last.y - first.y }, { x: 1, y: 0 });
    direction = { x: -tangent.y, y: tangent.x };
    if (direction.y < 0 || (direction.y === 0 && direction.x < 0)) direction = { x: -direction.x, y: -direction.y };
  } else {
    const vertex = points[1] ?? origin;
    direction = normalized({ x: origin.x - vertex.x, y: origin.y - vertex.y }, { x: 0, y: 1 });
  }
  const tangent = { x: direction.y, y: -direction.x };
  const center = { x: origin.x, y: origin.y + centerOffsetY };
  const candidates: Point2[] = [center,
    { x: center.x + tangent.x * height * 0.85, y: center.y + tangent.y * height * 0.85 },
    { x: center.x - tangent.x * height * 0.85, y: center.y - tangent.y * height * 0.85 }];
  const sides = measurement.definition.kind === "distance" ? [1, -1] : [1];
  for (const outward of [0.25, 0.5, 0.75, 1, 1.25]) {
    for (const side of sides) {
      for (const along of [0, -0.35, 0.35]) {
        candidates.push({
          x: center.x + direction.x * outward * height * side + tangent.x * along * height,
          y: center.y + direction.y * outward * height * side + tangent.y * along * height,
        });
      }
    }
  }
  return candidates;
}

function collisionPenalty(bounds: Bounds, item: CollisionItem, gap: number): number {
  if (item.kind === "label") {
    const padded = expand(item.bounds, gap);
    const width = Math.min(bounds.maxX, padded.maxX) - Math.max(bounds.minX, padded.minX);
    const height = Math.min(bounds.maxY, padded.maxY) - Math.max(bounds.minY, padded.minY);
    return width > 0 && height > 0 ? 1200 * (1 + width * height / area(bounds)) : 0;
  }
  if (item.kind === "atom") {
    const x = Math.max(bounds.minX, Math.min(bounds.maxX, item.center.x));
    const y = Math.max(bounds.minY, Math.min(bounds.maxY, item.center.y));
    const radius = item.radius + gap;
    const distance = Math.hypot(x - item.center.x, y - item.center.y);
    return distance < radius ? 0.02 * (2 - distance / radius) : 0;
  }
  return segmentIntersectsBounds(item.start, item.end, expand(bounds, item.radius + gap * 0.6)) ? 0.005 : 0;
}

function segmentIntersectsBounds(start: Point2, end: Point2, bounds: Bounds): boolean {
  let enter = 0, leave = 1;
  for (const [origin, delta, min, max] of [
    [start.x, end.x - start.x, bounds.minX, bounds.maxX],
    [start.y, end.y - start.y, bounds.minY, bounds.maxY],
  ] as const) {
    if (Math.abs(delta) < 1e-12) {
      if (origin < min || origin > max) return false;
    } else {
      const first = (min - origin) / delta, last = (max - origin) / delta;
      enter = Math.max(enter, Math.min(first, last));
      leave = Math.min(leave, Math.max(first, last));
      if (enter > leave) return false;
    }
  }
  return true;
}

class CollisionGrid {
  private readonly cells = new Map<string, CollisionItem[]>();
  private readonly large: CollisionItem[] = [];
  constructor(private readonly size: number) {}

  add(item: CollisionItem) {
    const range = this.range(item.bounds);
    if ((range.maxX - range.minX + 1) * (range.maxY - range.minY + 1) > 256) {
      this.large.push(item);
      return;
    }
    for (let x = range.minX; x <= range.maxX; x++) for (let y = range.minY; y <= range.maxY; y++) {
      const key = `${x},${y}`;
      const cell = this.cells.get(key);
      if (cell) cell.push(item);
      else this.cells.set(key, [item]);
    }
  }

  *query(bounds: Bounds) {
    const seen = new Set<CollisionItem>();
    for (const item of this.large) if (overlaps(bounds, item.bounds)) { seen.add(item); yield item; }
    const range = this.range(bounds);
    for (let x = range.minX; x <= range.maxX; x++) for (let y = range.minY; y <= range.maxY; y++) {
      for (const item of this.cells.get(`${x},${y}`) ?? []) {
        if (!seen.has(item) && overlaps(bounds, item.bounds)) { seen.add(item); yield item; }
      }
    }
  }

  private range(bounds: Bounds): Bounds {
    return {
      minX: Math.floor(bounds.minX / this.size), minY: Math.floor(bounds.minY / this.size),
      maxX: Math.floor(bounds.maxX / this.size), maxY: Math.floor(bounds.maxY / this.size),
    };
  }
}

function cameraPlane(quaternion: readonly [number, number, number, number]): { right: Point3; up: Point3 } {
  const norm = Math.hypot(...quaternion);
  const [x, y, z, w] = Number.isFinite(norm) && norm > 0
    ? quaternion.map(value => value / norm) as [number, number, number, number] : [0, 0, 0, 1];
  return {
    right: [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    up: [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
  };
}

function safeSpan(span: number): number { return Number.isFinite(span) && span > 0 ? span : 1; }
function finitePoint(point: Point3): boolean { return point.every(Number.isFinite); }
function dot(a: Point3, b: Point3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function normalized(point: Point2, fallback: Point2): Point2 {
  const length = Math.hypot(point.x, point.y);
  return length > 1e-10 ? { x: point.x / length, y: point.y / length } : fallback;
}
function rectangle(center: Point2, width: number, height: number): Bounds {
  return { minX: center.x - width / 2, maxX: center.x + width / 2, minY: center.y - height / 2, maxY: center.y + height / 2 };
}
function expand(bounds: Bounds, margin: number): Bounds {
  return { minX: bounds.minX - margin, maxX: bounds.maxX + margin, minY: bounds.minY - margin, maxY: bounds.maxY + margin };
}
function overlaps(a: Bounds, b: Bounds): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;
}
function area(bounds: Bounds): number { return (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY); }
