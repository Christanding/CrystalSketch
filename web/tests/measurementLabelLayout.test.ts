import { describe, expect, test } from "bun:test";
import { Quaternion, Vector3 } from "three";
import {
  layoutMeasurementLabels, measurementLabelInkSize, measurementLabelSize,
  type MeasurementLabelLayoutOptions,
} from "../src/model/measurementLabelLayout";
import type { ResolvedMeasurement } from "../src/model/measurements";

type Point3 = [number, number, number];
type CameraQuaternion = [number, number, number, number];
const IDENTITY: CameraQuaternion = [0, 0, 0, 1];

describe("measurement label layout", () => {
  test("keeps an unobstructed distance label beside the midpoint instead of on the measured line", () => {
    const measurement = distance("distance");
    const anchor = layoutMeasurementLabels({ measurements: [measurement], cameraQuaternion: IDENTITY, span: 6 }).get("distance")!;
    const rect = labelBounds(measurement, anchor);
    expect(anchor[0]).toBeCloseTo(0, 12);
    expect(anchor[2]).toBeCloseTo(0, 12);
    expect(rect.minY).toBeGreaterThan(0);
    expect(Math.hypot(...anchor)).toBeLessThan(measurementLabelSize(measurement.label, 6).height);
  });

  test("keeps colliding labels near their anchors and separated in a rotated camera plane", () => {
    const measurement = distance("distance"), second = distance("second");
    const quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2).toArray();
    const result = layoutMeasurementLabels({ measurements: [measurement, second], cameraQuaternion: quaternion, span: 6 });
    const anchor = result.get("second")!;
    expect(intersects(labelBounds(measurement, result.get("distance")!, quaternion), labelBounds(second, anchor, quaternion))).toBe(false);
    expect(anchor[2]).toBeCloseTo(0, 12);
    expect(Math.hypot(...anchor)).toBeLessThan(measurementLabelSize(measurement.label, 6).height * 1.3);
  });

  test("moves an angle label outward from its arc and keeps straight-angle layouts finite in edge-on views", () => {
    const measurement = straightAngle("angle");
    for (const quaternion of [
      IDENTITY,
      new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2).toArray(),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI).toArray(),
    ]) {
      const options = { measurements: [measurement], cameraQuaternion: quaternion, span: 6 };
      const first = layoutMeasurementLabels(options).get("angle")!;
      expect(first.every(Number.isFinite)).toBe(true);
      expect(layoutMeasurementLabels(options).get("angle")).toEqual(first);
      expect(Math.hypot(first[0], first[1], first[2])).toBeLessThan(1);
    }
    const anchor = layoutMeasurementLabels({ measurements: [measurement], cameraQuaternion: IDENTITY, span: 6 }).get("angle")!;
    expect(labelBounds(measurement, anchor).minY).toBeGreaterThan(measurement.labelPosition[1]);
  });

  test("allows atom coverage instead of pushing a label away from its measurement", () => {
    const measurement = distance("distance");
    const options = { measurements: [measurement], cameraQuaternion: IDENTITY, span: 6 };
    const preferred = layoutMeasurementLabels(options).get("distance")!;
    const offset = measurementLabelInkSize(measurement.label, 6).centerOffsetY;
    const atomCenter: Point3 = [preferred[0], preferred[1] + offset, 0];
    const radius = 0.2;
    const anchor = layoutMeasurementLabels({ ...options, obstacles: [{ position: atomCenter, radius }] }).get("distance")!;
    const rect = labelBounds(measurement, anchor);
    expect(anchor).toEqual(preferred);
    const nearestX = Math.max(rect.minX, Math.min(rect.maxX, atomCenter[0]));
    const nearestY = Math.max(rect.minY, Math.min(rect.maxY, atomCenter[1]));
    expect(Math.hypot(nearestX - atomCenter[0], nearestY - atomCenter[1])).toBeLessThan(radius);
  });

  test("allows bond coverage instead of moving an otherwise isolated label", () => {
    const measurement = distance("distance");
    const options = { measurements: [measurement], cameraQuaternion: IDENTITY, span: 6 };
    const preferred = layoutMeasurementLabels(options).get("distance")!;
    const bondY = preferred[1] + measurementLabelInkSize(measurement.label, 6).centerOffsetY;
    const anchor = layoutMeasurementLabels({
      ...options, segments: [{ start: [-2, bondY, 0], end: [2, bondY, 0], radius: 0.03 }],
    }).get("distance")!;
    const rect = labelBounds(measurement, anchor);
    expect(anchor).toEqual(preferred);
    expect(rect.minY < bondY && rect.maxY > bondY).toBe(true);
  });

  test("lets visible distance and angle labels avoid each other and releases a hidden kind's space", () => {
    const angle = straightAngle("angle"), length = distance("distance");
    const options = { cameraQuaternion: IDENTITY, span: 6 };
    const all = layoutMeasurementLabels({ ...options, measurements: [angle, length] });
    const distanceOnly = layoutMeasurementLabels({ ...options, measurements: [length] });
    const angleOnly = layoutMeasurementLabels({ ...options, measurements: [angle] });
    expect(intersects(labelBounds(angle, all.get("angle")!), labelBounds(length, all.get("distance")!))).toBe(false);
    expect(all.get("distance")).not.toEqual(distanceOnly.get("distance"));
    expect(angleOnly.get("angle")).toEqual(all.get("angle"));
    expect(distanceOnly.size).toBe(1);
    expect(angleOnly.size).toBe(1);
  });

  test.each([150, 250])("scales ink collision boxes at %s percent while keeping labels close", fontScale => {
    const first = distance("first"), second = distance("second");
    const result = layoutMeasurementLabels({ measurements: [first, second], cameraQuaternion: IDENTITY, span: 6, fontScale });
    const size = measurementLabelSize(first.label, 6, fontScale);
    expect(size.height).toBeCloseTo(measurementLabelSize(first.label, 6).height * fontScale / 100, 12);
    expect(intersects(labelBounds(first, result.get("first")!, IDENTITY, 6, fontScale),
      labelBounds(second, result.get("second")!, IDENTITY, 6, fontScale))).toBe(false);
    expect(Math.hypot(...result.get("second")!)).toBeLessThanOrEqual(size.height * 1.3);
  });

  test("keeps 2.000 Å and 90.00° near their geometry at 250 percent, regardless of pin order", () => {
    const length: ResolvedMeasurement = {
      definition: { id: "length", kind: "distance", atomIds: ["vertex", "right"] },
      points: [[0, 0, 0], [2, 0, 0]], value: 2, label: "2.000 Å", labelPosition: [1, 0, 0],
    };
    const angle: ResolvedMeasurement = {
      definition: { id: "angle", kind: "angle", atomIds: ["right", "vertex", "up"] },
      points: [[2, 0, 0], [0, 0, 0], [0, 2, 0]], value: 90, label: "90.00°",
      labelPosition: [0.6 / Math.sqrt(2), 0.6 / Math.sqrt(2), 0],
    };
    const obstacles = [[0, 0, 0], [2, 0, 0], [0, 2, 0]].map(position => ({ position: position as Point3, radius: 0.25 }));
    const segments = [{ start: [0, 0, 0] as Point3, end: [2, 0, 0] as Point3, radius: 0.05 },
      { start: [0, 0, 0] as Point3, end: [0, 2, 0] as Point3, radius: 0.05 }];
    for (const measurements of [[length, angle], [length], [angle]]) {
      const placed = layoutMeasurementLabels({ measurements, cameraQuaternion: IDENTITY, span: 6, fontScale: 250, obstacles, segments });
      const rectangles = measurements.map(measurement => labelBounds(measurement, placed.get(measurement.definition.id)!, IDENTITY, 6, 250));
      if (rectangles.length === 2) expect(intersects(rectangles[0]!, rectangles[1]!)).toBe(false);
      for (const measurement of measurements) {
        const displacement = new Vector3(...placed.get(measurement.definition.id)!).sub(new Vector3(...measurement.labelPosition)).length();
        expect(displacement).toBeLessThanOrEqual(measurementLabelSize(measurement.label, 6, 250).height * 1.3);
      }
    }
    const options = { cameraQuaternion: IDENTITY, span: 6, fontScale: 250, obstacles, segments };
    const forward = layoutMeasurementLabels({ ...options, measurements: [length, angle] });
    const reverse = layoutMeasurementLabels({ ...options, measurements: [angle, length] });
    expect(forward).toEqual(reverse);
    expect(new Vector3(...forward.get("angle")!).distanceTo(new Vector3(...angle.labelPosition))).toBeLessThan(1e-12);
  });

  test("uses bundled glyph advances for collision spacing without shrinking the sprite safety canvas", () => {
    const safe = measurementLabelSize("2.000 Å", 10, 150);
    const ink = measurementLabelInkSize("2.000 Å", 10, 150);
    expect(safe.canvasWidth).toBe(424);
    expect(ink.width).toBeCloseTo(safe.height * (4 * 0.6 + 0.35 + 0.35 + 0.69 + 0.16) * 56 / 88, 12);
    expect(ink.width).toBeLessThan(safe.width * 0.6);
    expect(ink.centerOffsetY).toBeCloseTo(safe.height * (0.5 - 0.08 - 3 / 88), 12);
  });

  test.each([150, 250])("keeps the exported Zn-Cu-O angle anchored and nudges its distance down at %s percent", fontScale => {
    const length: ResolvedMeasurement = {
      definition: { id: "length", kind: "distance", atomIds: ["Zn-0", "Cu-1"] },
      points: [[5, 3, 3], [5, 5, 3]], value: 2, label: "2.000 Å", labelPosition: [5, 4, 3],
    };
    const angle: ResolvedMeasurement = {
      definition: { id: "angle", kind: "angle", atomIds: ["Zn-0", "Cu-1", "O-2"] },
      points: [[5, 3, 3], [5, 5, 3], [5, 5, 5]], value: 90, label: "90.00°",
      labelPosition: [5, 5 - 0.6 / Math.sqrt(2), 3 + 0.6 / Math.sqrt(2)],
    };
    const quaternion: CameraQuaternion = [0.5, 0.5, 0.5, 0.5];
    const obstacles = [...angle.points, [5, 6.8, 5] as Point3].map(position => ({ position, radius: 0.75 }));
    const result = layoutMeasurementLabels({ measurements: [length, angle], cameraQuaternion: quaternion, span: 10, fontScale, obstacles });
    const angleAnchor = result.get("angle")!, lengthAnchor = result.get("length")!;
    expect(new Vector3(...angleAnchor).distanceTo(new Vector3(...angle.labelPosition))).toBeLessThan(1e-12);
    expect(lengthAnchor[0]).toBe(5);
    expect(lengthAnchor[1]).toBe(4);
    expect(lengthAnchor[2]).toBeLessThan(3);
    expect(3 - lengthAnchor[2]).toBeLessThanOrEqual(measurementLabelSize(length.label, 10, fontScale).height * 0.5 + 1e-12);
    expect(intersects(labelBounds(length, lengthAnchor, quaternion, 10, fontScale), labelBounds(angle, angleAnchor, quaternion, 10, fontScale))).toBe(false);
  });

  test("does not change measurements or obstacles, and preserves anchor depth", () => {
    const measurement = distance("distance");
    measurement.points = measurement.points.map(([x, y]) => [x, y, 3]);
    measurement.labelPosition = [0, 0, 3];
    const options: MeasurementLabelLayoutOptions = {
      measurements: [measurement], cameraQuaternion: IDENTITY, span: 6,
      obstacles: [{ position: [0, 0.2, 3], radius: 0.3 }],
      segments: [{ start: [-2, 0.5, 3], end: [2, 0.5, 3], radius: 0.1 }],
    };
    const before = JSON.stringify(options);
    const result = layoutMeasurementLabels(options);
    expect(JSON.stringify(options)).toBe(before);
    expect(result.get("distance")![2]).toBe(3);
  });

  test("returns deterministic finite fallbacks with 50 crowded labels and 4096 projected atom obstacles", () => {
    const measurements = Array.from({ length: 50 }, (_, index) => distance(`distance-${index}`));
    const obstacles = Array.from({ length: 4096 }, (_, index) => ({
      position: [index % 64 / 8 - 4, Math.floor(index / 64) / 8 - 4, index % 3] as Point3, radius: 0.08,
    }));
    const options = { measurements, obstacles, cameraQuaternion: IDENTITY, span: 6, fontScale: 250 };
    const first = layoutMeasurementLabels(options);
    expect(first.size).toBe(50);
    expect([...first.values()].every(point => point.every(Number.isFinite))).toBe(true);
    expect(layoutMeasurementLabels(options)).toEqual(first);
  });

  test("handles empty input and invalid camera or size settings without non-finite anchors", () => {
    expect(layoutMeasurementLabels({ measurements: [], cameraQuaternion: IDENTITY, span: 6 }).size).toBe(0);
    const result = layoutMeasurementLabels({ measurements: [distance("distance")], cameraQuaternion: [0, 0, 0, 0], span: NaN, fontScale: Infinity });
    expect(result.get("distance")!.every(Number.isFinite)).toBe(true);
  });
});

function distance(id: string): ResolvedMeasurement {
  return {
    definition: { id, kind: "distance", atomIds: [`${id}-a`, `${id}-b`] },
    points: [[-2, 0, 0], [2, 0, 0]], value: 4, label: "4.000 Å", labelPosition: [0, 0, 0],
  };
}

function straightAngle(id: string): ResolvedMeasurement {
  return {
    definition: { id, kind: "angle", atomIds: [`${id}-a`, `${id}-b`, `${id}-c`] },
    points: [[-20 / 3, -2, 0], [0, -2, 0], [20 / 3, -2, 0]], value: 180,
    label: "180.00°", labelPosition: [0, 0, 0],
  };
}

function labelBounds(measurement: ResolvedMeasurement, anchor: Point3, quaternion: CameraQuaternion = IDENTITY, span = 6, fontScale = 100) {
  const point = new Vector3(...anchor).applyQuaternion(new Quaternion(...quaternion).invert());
  const { width, height, centerOffsetY } = measurementLabelInkSize(measurement.label, span, fontScale);
  return {
    minX: point.x - width / 2, maxX: point.x + width / 2,
    minY: point.y + centerOffsetY - height / 2, maxY: point.y + centerOffsetY + height / 2,
  };
}

function intersects(a: ReturnType<typeof labelBounds>, b: ReturnType<typeof labelBounds>) {
  return a.maxX > b.minX && a.minX < b.maxX && a.maxY > b.minY && a.minY < b.maxY;
}
