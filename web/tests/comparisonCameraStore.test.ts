import { describe, expect, test } from "bun:test";
import { OrthographicCamera, Quaternion, Vector3 } from "three";
import { createComparisonCameraStore, type ComparisonCameraStore } from "../src/model/comparisonCameraStore";

function view(store: ComparisonCameraStore, id: string, orientation = new Quaternion(), viewportWidth = 800, frustumWidth = viewportWidth) {
  const camera = new OrthographicCamera(-frustumWidth / 2, frustumWidth / 2, 300, -300);
  camera.quaternion.copy(orientation);
  camera.zoom = 40;
  let updates = 0;
  let stops = 0;
  const unregister = store.registerView(id, {
    readSnapshot: () => ({
      quaternion: camera.quaternion.toArray(),
      worldUnitsPerPixel: frustumWidth / (camera.zoom * viewportWidth),
    }),
    applySnapshot: update => {
      updates += 1;
      if (update.quaternion) camera.quaternion.fromArray(update.quaternion);
      if (update.worldUnitsPerPixel) camera.zoom = frustumWidth / (update.worldUnitsPerPixel * viewportWidth);
      store.publishView(id);
    },
    stopMotion: () => { stops += 1; },
  });
  return { camera, unregister, updates: () => updates, stops: () => stops,
    units: () => frustumWidth / (camera.zoom * viewportWidth) };
}

describe("comparison camera store", () => {
  test("applies camera-local increments while preserving each view's starting orientation", () => {
    const store = createComparisonCameraStore({ uniformScale: false });
    const left = view(store, "left");
    const rightInitial = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const right = view(store, "right", rightInitial);
    const delta = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3);
    left.camera.quaternion.multiply(delta);
    store.publishView("left");
    expect(right.camera.quaternion.angleTo(rightInitial.clone().multiply(delta))).toBeLessThan(1e-7);
    expect(left.updates()).toBe(0);
    expect(right.updates()).toBe(1);
    store.publishView("left");
    expect(right.updates()).toBe(1);
    left.camera.quaternion.identity();
    store.publishView("left");
    expect(right.camera.quaternion.angleTo(rightInitial)).toBeLessThan(1e-7);
    expect(right.camera.quaternion.angleTo(left.camera.quaternion)).toBeGreaterThan(1);
  });

  test("does not jump or replay old rotations when synchronization is toggled", () => {
    const store = createComparisonCameraStore({ uniformScale: false });
    const left = view(store, "left");
    const right = view(store, "right");
    store.configure({ syncRotation: false });
    left.camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 1.1);
    store.publishView("left");
    expect(right.camera.quaternion.angleTo(new Quaternion())).toBe(0);
    store.configure({ syncRotation: true });
    expect(right.camera.quaternion.angleTo(new Quaternion())).toBe(0);
    const delta = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.2);
    left.camera.quaternion.multiply(delta);
    store.publishView("left");
    expect(right.camera.quaternion.angleTo(delta)).toBeLessThan(1e-7);
  });

  test("switches the active source and rejects late inertia broadcasts from the previous view", () => {
    const store = createComparisonCameraStore({ uniformScale: false });
    const left = view(store, "left");
    const right = view(store, "right");
    store.setActiveView("right");
    expect(left.stops()).toBe(1);
    left.camera.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.7);
    store.publishView("left");
    expect(right.updates()).toBe(0);
    right.camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0.4);
    store.publishView("right");
    expect(left.updates()).toBe(1);
    expect(right.updates()).toBe(0);
  });

  test("matches world units per CSS pixel across unequal frustums and viewport sizes", () => {
    const store = createComparisonCameraStore();
    const left = view(store, "left", new Quaternion(), 800, 800);
    const right = view(store, "right", new Quaternion(), 300, 600);
    expect(right.units()).toBeCloseTo(left.units());
    expect(right.camera.zoom).toBeCloseTo(80);
    left.camera.zoom = 20;
    store.publishView("left");
    expect(right.units()).toBeCloseTo(0.05);
    expect(right.camera.zoom).toBeCloseTo(40);
    right.camera.zoom = 10;
    store.publishView("right");
    expect(right.units()).toBeCloseTo(left.units());
    expect(left.camera.zoom).toBe(20);
    store.configure({ uniformScale: false });
    right.camera.zoom = 10;
    store.publishView("right");
    expect(left.camera.zoom).toBe(20);
    store.setActiveView("right");
    store.configure({ uniformScale: true });
    expect(left.units()).toBeCloseTo(right.units());
    expect(left.camera.zoom).toBeCloseTo(5);
  });

  test("aligns absolute orientation only when explicitly requested", () => {
    const store = createComparisonCameraStore({ syncRotation: false, uniformScale: false });
    const left = view(store, "left", new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 1.4));
    const right = view(store, "right");
    right.camera.zoom = 90;
    store.align("left");
    expect(right.camera.quaternion.angleTo(left.camera.quaternion)).toBeLessThan(1e-7);
    expect(right.camera.zoom).toBe(90);
  });

  test("unregister and reset release views without stale callbacks driving replacements", () => {
    const store = createComparisonCameraStore({ uniformScale: false });
    const left = view(store, "left");
    const oldRight = view(store, "right");
    const right = view(store, "right");
    oldRight.unregister();
    left.camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0.2);
    store.publishView("left");
    expect(oldRight.updates()).toBe(0);
    expect(right.updates()).toBe(1);
    right.unregister();
    store.reset();
    expect(store.getActiveView()).toBeNull();
    left.camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0.5);
    store.publishView("left");
    expect(right.updates()).toBe(1);
  });
});
