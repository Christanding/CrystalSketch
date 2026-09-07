import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { OrthographicCamera, Quaternion, Vector2, Vector3 } from "three";

import type { SceneSpec } from "../src/api/scene";
import { createComparisonCameraStore } from "../src/model/comparisonCameraStore";
import { computeCameraFitZoom } from "../src/scene/viewMath";

class MockControls {
  enabled = true;
  maxZoom = Infinity;
  minZoom = 0;
  keyState = -1;
  mouseButtons: Record<string, unknown> = {};
  noPan = false;
  noRotate = false;
  noZoom = false;
  dynamicDampingFactor = 0.2;
  rotateSpeed = 1;
  state = -1;
  staticMoving = false;
  target = new Vector3();
  touches: Record<string, unknown> = {};
  updateCalls = 0;
  zoomSpeed = 1.2;
  private listeners = new Map<string, Set<() => void>>();

  constructor() {
    latestControls = this;
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  dispose() {}

  handleResize() {}

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchTestEvent(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }

  update() {
    this.updateCalls += 1;
  }
}

class MockOrbitControls extends MockControls {}

class MockTrackballControls extends MockControls {}

let mockCamera = new OrthographicCamera();
let mockDomElement = document.createElement("canvas");
let mockViewportSize = { height: 800, width: 1000 };
let invalidateCalls = 0;
let latestFrameCallback: ((state?: unknown, delta?: number) => void) | null = null;
let latestCanvasCameraProps: unknown = null;
let latestCanvasFrameloop: unknown = null;
let latestControls: MockControls | null = null;
let latticeSceneRenderCount = 0;
const invalidateMock = () => { invalidateCalls += 1; };

function resetMockCamera() {
  mockCamera = new OrthographicCamera();
  mockDomElement = document.createElement("canvas");
  mockViewportSize = { height: 800, width: 1000 };
  invalidateCalls = 0;
  latestFrameCallback = null;
  latestCanvasCameraProps = null;
  latestCanvasFrameloop = null;
  latestControls = null;
  latticeSceneRenderCount = 0;
}

mock.module("@react-three/fiber", () => ({
  Canvas: ({
    camera,
    children,
    frameloop,
  }: {
    camera?: unknown;
    children: ReactNode;
    frameloop?: unknown;
  }) =>
    (() => {
      latestCanvasCameraProps = camera;
      latestCanvasFrameloop = frameloop;
      return (
        <div data-testid="lattice-canvas">
          {Children.toArray(children).filter(
            (child) =>
              isValidElement(child) &&
              typeof child.type === "function" &&
              (child.type.name === "PreviewCameraController" ||
                child.type.name === "DemandFrameInvalidator"),
          )}
        </div>
      );
    })(),
  useFrame: (callback: (state?: unknown, delta?: number) => void) => {
    latestFrameCallback = callback;
  },
  useThree: (selector?: (state: {
    camera: OrthographicCamera;
    gl: { domElement: HTMLCanvasElement };
    invalidate: () => void;
    size: { height: number; width: number };
  }) => unknown) => {
    const state = {
      camera: mockCamera,
      gl: {
        domElement: mockDomElement,
      },
      invalidate: invalidateMock,
      size: mockViewportSize,
    };
    return selector ? selector(state) : state;
  },
}));

mock.module("three/examples/jsm/controls/OrbitControls.js", () => ({
  OrbitControls: MockOrbitControls,
}));

mock.module("three/examples/jsm/controls/TrackballControls.js", () => ({
  TrackballControls: MockTrackballControls,
}));

const { createDefaultComponentOpacity, createDefaultStyle } =
  await import("../src/model");
const { createCameraInteractionStore } =
  await import("../src/app/cameraInteractionStore");
const { LatticeScene, computeSceneLayout } = await import("../src/scene/LatticeScene");
const {
  applyCrystalCameraRoll,
  computeCrystalCameraPose,
  computeCrystalCameraVectors,
  createDefaultCrystalCameraState,
  stateWithDirectAxis,
} = await import("../src/scene/crystalCamera");

function CountedLatticeScene(props: Parameters<typeof LatticeScene>[0]) {
  latticeSceneRenderCount += 1;
  return <LatticeScene {...props} />;
}

afterEach(() => {
  resetMockCamera();
});

describe("LatticeScene camera commands", () => {
  test("runs the main preview canvas on demand", () => {
    const scene = orthogonalScene();

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={createDefaultCrystalCameraState(scene.cell.vectors)}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    expect(latestCanvasFrameloop).toBe("demand");
  });

  test("initializes the canvas camera from the active crystal camera pose", () => {
    const scene = orthogonalScene();
    const defaultCamera = createDefaultCrystalCameraState(scene.cell.vectors);
    const aCamera = stateWithDirectAxis(scene.cell.vectors, defaultCamera, "a");
    const expectedPose = computeCrystalCameraPose(
      scene.cell.vectors,
      aCamera,
      4,
    );

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={aCamera}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    expect(latestCanvasCameraProps).toMatchObject({
      position: expectedPose.cameraPosition,
    });
  });

  test("applies drag sensitivity to camera controls", () => {
    const scene = orthogonalScene();

    const { rerender } = render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={createDefaultCrystalCameraState(scene.cell.vectors)}
        componentOpacity={createDefaultComponentOpacity()}
        dragSensitivity={2}
        interactionLocked={false}
        interactionMode="trackball"
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    expect(latestControls).toBeInstanceOf(MockTrackballControls);
    expect(latestControls?.rotateSpeed).toBe(4);
    expect(latestControls?.staticMoving).toBe(false);
    expect(latestControls?.zoomSpeed).toBe(1.2);

    rerender(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={createDefaultCrystalCameraState(scene.cell.vectors)}
        componentOpacity={createDefaultComponentOpacity()}
        dragSensitivity={0.75}
        interactionLocked={false}
        interactionMode="orbit"
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    expect(latestControls).toBeInstanceOf(MockOrbitControls);
    expect(latestControls?.rotateSpeed).toBe(0.375);
  });

  test("boosts direct trackball response when mouse inertia is disabled", () => {
    const scene = orthogonalScene();

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={createDefaultCrystalCameraState(scene.cell.vectors)}
        componentOpacity={createDefaultComponentOpacity()}
        dragSensitivity={2}
        interactionLocked={false}
        interactionMode="trackball"
        mouseInertia={false}
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    expect(latestControls).toBeInstanceOf(MockTrackballControls);
    expect(latestControls?.staticMoving).toBe(true);
    expect(latestControls?.rotateSpeed).toBeCloseTo(6.4);
    expect(latestControls?.zoomSpeed).toBeCloseTo(4.8);
  });

  test("disables trackball inertia when reduced motion is active", () => {
    const scene = orthogonalScene();

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={createDefaultCrystalCameraState(scene.cell.vectors)}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        mouseInertia
        reducedMotion
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    expect(latestControls?.staticMoving).toBe(true);
  });

  test("advances trackball inertia on every requested frame", () => {
    const scene = orthogonalScene();

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={createDefaultCrystalCameraState(scene.cell.vectors)}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        mouseInertia={true}
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    const controls = latestControls;
    expect(controls).toBeInstanceOf(MockTrackballControls);
    if (!controls) {
      return;
    }

    controls.updateCalls = 0;
    act(() => latestFrameCallback?.({}, 1 / 120));
    expect(controls.updateCalls).toBe(1);

    act(() => latestFrameCallback?.({}, 1 / 120));
    expect(controls.updateCalls).toBe(2);
  });

  test("does not request another demand frame when the camera is static", () => {
    const scene = orthogonalScene();

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={createDefaultCrystalCameraState(scene.cell.vectors)}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    invalidateCalls = 0;
    act(() => latestFrameCallback?.());

    expect(invalidateCalls).toBe(0);
  });

  test("requests a demand frame when controls report a change", () => {
    const scene = orthogonalScene();

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={createDefaultCrystalCameraState(scene.cell.vectors)}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    invalidateCalls = 0;
    act(() => latestControls?.dispatchTestEvent("change"));

    expect(invalidateCalls).toBeGreaterThan(0);
  });

  test("flushes no-inertia trackball pointer moves before the next demand frame", async () => {
    const scene = orthogonalScene();

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={createDefaultCrystalCameraState(scene.cell.vectors)}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        mouseInertia={false}
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    const controls = latestControls;
    expect(controls).toBeInstanceOf(MockTrackballControls);
    if (!controls) {
      return;
    }

    await act(async () => {
      fireEvent.pointerDown(mockDomElement, { pointerId: 1 });
    });
    controls.updateCalls = 0;
    invalidateCalls = 0;

    await act(async () => {
      fireEvent.pointerMove(mockDomElement, { pointerId: 1 });
      await Promise.resolve();
    });
    expect(controls.updateCalls).toBe(1);
    expect(invalidateCalls).toBe(1);

    await act(async () => {
      fireEvent.pointerMove(mockDomElement, { pointerId: 1 });
      await Promise.resolve();
    });
    expect(controls.updateCalls).toBe(2);
  });

  test("skips redundant trackball frame updates after no-inertia event flushes", async () => {
    const scene = orthogonalScene();

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={createDefaultCrystalCameraState(scene.cell.vectors)}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        mouseInertia={false}
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    const controls = latestControls;
    expect(controls).toBeInstanceOf(MockTrackballControls);
    if (!controls) {
      return;
    }

    await act(async () => {
      fireEvent.pointerDown(mockDomElement, { pointerId: 1 });
    });
    controls.updateCalls = 0;

    await act(async () => {
      fireEvent.pointerMove(mockDomElement, { pointerId: 1 });
      await Promise.resolve();
    });
    expect(controls.updateCalls).toBe(1);

    act(() => latestFrameCallback?.({}, 1 / 60));
    expect(controls.updateCalls).toBe(1);
  });

  test("flushes no-inertia trackball wheel events before the next demand frame", () => {
    const scene = orthogonalScene();

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={createDefaultCrystalCameraState(scene.cell.vectors)}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        mouseInertia={false}
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    const controls = latestControls;
    expect(controls).toBeInstanceOf(MockTrackballControls);
    if (!controls) {
      return;
    }

    controls.updateCalls = 0;
    invalidateCalls = 0;

    act(() => {
      fireEvent.wheel(mockDomElement, { deltaY: 120 });
    });
    expect(controls.updateCalls).toBe(1);
    expect(invalidateCalls).toBe(1);

    act(() => latestFrameCallback?.({}, 1 / 60));
    expect(controls.updateCalls).toBe(1);
  });

  test("requests a demand frame when preview render props change", () => {
    const scene = orthogonalScene();
    const props = {
      cameraCommandVersion: 0,
      cameraInteractionStore: createCameraInteractionStore(),
      cameraState: createDefaultCrystalCameraState(scene.cell.vectors),
      componentOpacity: createDefaultComponentOpacity(),
      interactionLocked: false,
      interactionMode: "trackball" as const,
      resetCounter: 0,
      scene,
      style: createDefaultStyle(),
    };

    const { rerender } = render(<LatticeScene {...props} />);

    invalidateCalls = 0;
    rerender(<LatticeScene {...props} showAtoms={false} />);

    expect(invalidateCalls).toBeGreaterThan(0);

    invalidateCalls = 0;
    rerender(
      <LatticeScene
        {...props}
        showAtoms={false}
        showUnitCell={false}
      />,
    );

    expect(invalidateCalls).toBeGreaterThan(0);
  });

  test("applies each command pose in the same render instead of lagging one command behind", () => {
    const scene = orthogonalScene();
    const defaultCamera = createDefaultCrystalCameraState(scene.cell.vectors);
    const aCamera = stateWithDirectAxis(scene.cell.vectors, defaultCamera, "a");
    const bCamera = stateWithDirectAxis(scene.cell.vectors, defaultCamera, "b");
    const props = {
      cameraCommandVersion: 0,
      cameraInteractionStore: createCameraInteractionStore(),
      cameraState: defaultCamera,
      componentOpacity: createDefaultComponentOpacity(),
      interactionLocked: false,
      interactionMode: "trackball" as const,
      resetCounter: 0,
      scene,
      style: createDefaultStyle(),
    };

    const { rerender } = render(<LatticeScene {...props} />);

    rerender(
      <LatticeScene
        {...props}
        cameraCommandVersion={1}
        cameraState={aCamera}
      />,
    );
    expect(mockCamera.position.x).toBeGreaterThan(0);
    expect(Math.abs(mockCamera.position.y)).toBeLessThan(1e-8);
    expect(Math.abs(mockCamera.position.z)).toBeLessThan(1e-8);

    rerender(
      <LatticeScene
        {...props}
        cameraCommandVersion={2}
        cameraState={bCamera}
      />,
    );
    expect(Math.abs(mockCamera.position.x)).toBeLessThan(1e-8);
    expect(mockCamera.position.y).toBeGreaterThan(0);
    expect(Math.abs(mockCamera.position.z)).toBeLessThan(1e-8);
  });

  test("animates flagged camera commands from the current pose to the target pose", () => {
    let now = 0;
    const nowSpy = spyOn(performance, "now").mockImplementation(() => now);
    const scene = orthogonalScene();
    const defaultCamera = createDefaultCrystalCameraState(scene.cell.vectors);
    const aCamera = stateWithDirectAxis(scene.cell.vectors, defaultCamera, "a");
    const props = {
      cameraAnimatedCommandVersion: 0,
      cameraCommandVersion: 0,
      cameraInteractionStore: createCameraInteractionStore(),
      cameraState: defaultCamera,
      componentOpacity: createDefaultComponentOpacity(),
      interactionLocked: false,
      interactionMode: "trackball" as const,
      resetCounter: 0,
      scene,
      style: createDefaultStyle(),
    };
    const animationActiveChanges: boolean[] = [];

    try {
      const { rerender } = render(<LatticeScene {...props} />);
      expectVectorClose(mockCamera.position, standardCameraPosition());

      rerender(
        <LatticeScene
          {...props}
          cameraAnimatedCommandVersion={1}
          cameraCommandVersion={1}
          cameraState={aCamera}
          onCameraCommandAnimationActiveChange={(isActive) => {
            animationActiveChanges.push(isActive);
          }}
        />,
      );
      expectVectorClose(mockCamera.position, standardCameraPosition());
      expect(animationActiveChanges).toEqual([true]);

      now = 130;
      act(() => latestFrameCallback?.());
      expect(mockCamera.position.x).toBeGreaterThan(0);
      expect(mockCamera.position.z).toBeGreaterThan(0);

      now = 280;
      act(() => latestFrameCallback?.());
      expect(mockCamera.position.x).toBeGreaterThan(0);
      expect(Math.abs(mockCamera.position.y)).toBeLessThan(1e-8);
      expect(Math.abs(mockCamera.position.z)).toBeLessThan(1e-8);
      expect(animationActiveChanges).toEqual([true, false]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("applies flagged camera commands immediately with reduced motion", () => {
    const scene = orthogonalScene();
    const defaultCamera = createDefaultCrystalCameraState(scene.cell.vectors);
    const aCamera = stateWithDirectAxis(scene.cell.vectors, defaultCamera, "a");
    const props = {
      cameraAnimatedCommandVersion: 0,
      cameraCommandVersion: 0,
      cameraInteractionStore: createCameraInteractionStore(),
      cameraState: defaultCamera,
      componentOpacity: createDefaultComponentOpacity(),
      interactionLocked: false,
      interactionMode: "trackball" as const,
      reducedMotion: true,
      resetCounter: 0,
      scene,
      style: createDefaultStyle(),
    };
    const { rerender } = render(<LatticeScene {...props} />);

    rerender(
      <LatticeScene
        {...props}
        cameraAnimatedCommandVersion={1}
        cameraCommandVersion={1}
        cameraState={aCamera}
      />,
    );

    expect(mockCamera.position.x).toBeGreaterThan(0);
    expect(Math.abs(mockCamera.position.y)).toBeLessThan(1e-8);
    expect(Math.abs(mockCamera.position.z)).toBeLessThan(1e-8);
  });

  test("applies external zoom without advancing control damping", () => {
    const scene = orthogonalScene();
    const defaultCamera = createDefaultCrystalCameraState(scene.cell.vectors);
    const cameraInteractionStore = createCameraInteractionStore();
    const props = {
      cameraCommandVersion: 0,
      cameraInteractionStore,
      cameraState: defaultCamera,
      componentOpacity: createDefaultComponentOpacity(),
      interactionLocked: false,
      interactionMode: "trackball" as const,
      resetCounter: 0,
      scene,
      style: createDefaultStyle(),
    };

    render(<LatticeScene {...props} />);
    const controls = latestControls;
    expect(controls).not.toBeNull();
    if (!controls) {
      return;
    }

    controls.updateCalls = 0;
    const initialZoom = mockCamera.zoom;
    act(() => cameraInteractionStore.requestViewScale(2));

    expect(mockCamera.zoom).toBeCloseTo(initialZoom * 2);
    expect(controls.updateCalls).toBe(0);
  });

  test("applies external zoom without rerendering the preview tree", () => {
    const scene = orthogonalScene();
    const defaultCamera = createDefaultCrystalCameraState(scene.cell.vectors);
    const cameraInteractionStore = createCameraInteractionStore();

    render(
      <CountedLatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={cameraInteractionStore}
        cameraState={defaultCamera}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    const initialRenderCount = latticeSceneRenderCount;
    act(() => cameraInteractionStore.requestViewScale(2));

    expect(latticeSceneRenderCount).toBe(initialRenderCount);
  });

  test("syncs control zoom to the interaction store without emitting commands", () => {
    const scene = orthogonalScene();
    const defaultCamera = createDefaultCrystalCameraState(scene.cell.vectors);
    const cameraInteractionStore = createCameraInteractionStore();
    const viewScaleSnapshots: number[] = [];
    cameraInteractionStore.subscribeViewScale(() => {
      viewScaleSnapshots.push(cameraInteractionStore.getViewScaleSnapshot());
    });
    const initialCommandVersion =
      cameraInteractionStore.getViewScaleCommandSnapshot().version;

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={cameraInteractionStore}
        cameraState={defaultCamera}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    const initialZoom = mockCamera.zoom;
    mockCamera.zoom = initialZoom * 1.006;
    act(() => latestControls?.dispatchTestEvent("change"));
    expect(viewScaleSnapshots).toHaveLength(1);
    expect(viewScaleSnapshots[0]).toBeCloseTo(1.006);
    expect(cameraInteractionStore.getViewScaleCommandSnapshot().version).toBe(
      initialCommandVersion,
    );
  });

  test("keeps the view scale snapshot aligned if a controls change event is missed", () => {
    const scene = orthogonalScene();
    const defaultCamera = createDefaultCrystalCameraState(scene.cell.vectors);
    const cameraInteractionStore = createCameraInteractionStore();
    const viewScaleSnapshots: number[] = [];
    cameraInteractionStore.subscribeViewScale(() => {
      viewScaleSnapshots.push(cameraInteractionStore.getViewScaleSnapshot());
    });
    const initialCommandVersion =
      cameraInteractionStore.getViewScaleCommandSnapshot().version;

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={cameraInteractionStore}
        cameraState={defaultCamera}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    const initialZoom = mockCamera.zoom;
    mockCamera.zoom = initialZoom * 1.006;
    act(() => latestFrameCallback?.());

    expect(viewScaleSnapshots).toHaveLength(1);
    expect(viewScaleSnapshots[0]).toBeCloseTo(1.006);
    expect(cameraInteractionStore.getViewScaleCommandSnapshot().version).toBe(
      initialCommandVersion,
    );
  });

  test("keeps missed control zoom snapshots out of preview tree renders", () => {
    const scene = orthogonalScene();
    const defaultCamera = createDefaultCrystalCameraState(scene.cell.vectors);
    const cameraInteractionStore = createCameraInteractionStore();

    render(
      <CountedLatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={cameraInteractionStore}
        cameraState={defaultCamera}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    const initialRenderCount = latticeSceneRenderCount;
    const initialZoom = mockCamera.zoom;
    mockCamera.zoom = initialZoom * 1.006;
    act(() => latestFrameCallback?.());

    expect(latticeSceneRenderCount).toBe(initialRenderCount);
  });

  test("applies camera state commands from the interaction store without rerendering", () => {
    const scene = orthogonalScene();
    const defaultCamera = createDefaultCrystalCameraState(scene.cell.vectors);
    const cameraInteractionStore = createCameraInteractionStore();
    const rolledCamera = applyCrystalCameraRoll(
      scene.cell.vectors,
      defaultCamera,
      90,
    );

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={cameraInteractionStore}
        cameraState={defaultCamera}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    expectVectorClose(
      mockCamera.up,
      computeCrystalCameraVectors(scene.cell.vectors, defaultCamera).up,
    );

    act(() => cameraInteractionStore.requestCameraState(rolledCamera));

    expectVectorClose(
      mockCamera.up,
      computeCrystalCameraVectors(scene.cell.vectors, rolledCamera).up,
    );
  });

  test("keeps user camera interaction active until controls settle", () => {
    const scene = orthogonalScene();
    const defaultCamera = createDefaultCrystalCameraState(scene.cell.vectors);
    const interactionChanges: {
      isActive: boolean;
      quaternionW: number | null;
    }[] = [];

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={defaultCamera}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        onCameraControlsInteractionActiveChange={(
          isActive,
          quaternionSnapshot,
        ) => {
          interactionChanges.push({
            isActive,
            quaternionW: quaternionSnapshot?.w ?? null,
          });
        }}
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    if (latestControls) {
      latestControls.state = 0;
    }
    act(() => latestControls?.dispatchTestEvent("start"));
    act(() => latestControls?.dispatchTestEvent("end"));
    expect(interactionChanges).toEqual([{ isActive: true, quaternionW: null }]);

    mockCamera.quaternion.set(0, 0, 0.15, 0.85).normalize();
    act(() => latestFrameCallback?.());
    expect(interactionChanges).toEqual([{ isActive: true, quaternionW: null }]);

    mockCamera.quaternion.set(0, 0, 0.25, 0.75).normalize();
    act(() => latestFrameCallback?.());
    expect(interactionChanges).toEqual([{ isActive: true, quaternionW: null }]);

    act(() => latestFrameCallback?.());

    expect(interactionChanges).toEqual([
      { isActive: true, quaternionW: null },
      { isActive: false, quaternionW: mockCamera.quaternion.w },
    ]);
  });

  test("does not report pure zoom controls as camera direction interaction", () => {
    const scene = orthogonalScene();
    const defaultCamera = createDefaultCrystalCameraState(scene.cell.vectors);
    const interactionChanges: boolean[] = [];

    render(
      <LatticeScene
        cameraCommandVersion={0}
        cameraInteractionStore={createCameraInteractionStore()}
        cameraState={defaultCamera}
        componentOpacity={createDefaultComponentOpacity()}
        interactionLocked={false}
        interactionMode="trackball"
        onCameraControlsInteractionActiveChange={(isActive) => {
          interactionChanges.push(isActive);
        }}
        resetCounter={0}
        scene={scene}
        style={createDefaultStyle()}
      />,
    );

    act(() => latestControls?.dispatchTestEvent("start"));
    act(() => latestControls?.dispatchTestEvent("end"));
    if (latestControls) {
      latestControls.state = 1;
    }
    act(() => latestControls?.dispatchTestEvent("start"));
    act(() => latestControls?.dispatchTestEvent("end"));

    expect(interactionChanges).toEqual([]);
  });

  test("receives comparison orientation and physical scale without changing pan or rerendering the tree", () => {
    const scene = orthogonalScene();
    const comparisonCameraStore = createComparisonCameraStore();
    const peerQuaternion = new Quaternion();
    comparisonCameraStore.registerView("peer", {
      readSnapshot: () => ({ quaternion: peerQuaternion.toArray(), worldUnitsPerPixel: 0.0001 }),
      applySnapshot: () => {},
      stopMotion: () => {},
    });
    const { unmount } = render(<CountedLatticeScene
      cameraCommandVersion={0}
      cameraInteractionStore={createCameraInteractionStore()}
      comparisonCameraStore={comparisonCameraStore}
      comparisonViewId="local"
      cameraState={createDefaultCrystalCameraState(scene.cell.vectors)}
      componentOpacity={createDefaultComponentOpacity()}
      interactionLocked={false}
      interactionMode="trackball"
      resetCounter={0}
      scene={scene}
      style={createDefaultStyle()}
    />);
    expect(mockCamera.zoom).toBeCloseTo(10000);
    const renderCount = latticeSceneRenderCount;
    const controls = latestControls!;
    controls.target.set(2, -1, 3);
    const distance = mockCamera.position.distanceTo(controls.target);
    peerQuaternion.setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 1.2);
    controls.updateCalls = 0;
    act(() => comparisonCameraStore.align("peer"));
    expect(controls.updateCalls).toBe(0);
    expect(mockCamera.quaternion.angleTo(peerQuaternion)).toBeLessThan(1e-7);
    expectVectorClose(controls.target, new Vector3(2, -1, 3));
    expect(mockCamera.position.distanceTo(controls.target)).toBeCloseTo(distance);
    act(() => latestFrameCallback?.());
    expect(mockCamera.zoom).toBeCloseTo(10000);
    expect(latticeSceneRenderCount).toBe(renderCount);
    unmount();
    comparisonCameraStore.reset();
  });

  test("switches comparison source before dragging, clears old inertia, and forwards crystal-axis commands", () => {
    const scene = orthogonalScene();
    const cameraState = createDefaultCrystalCameraState(scene.cell.vectors);
    const cameraInteractionStore = createCameraInteractionStore();
    const comparisonCameraStore = createComparisonCameraStore({ uniformScale: false });
    const peerQuaternion = new Quaternion();
    let peerUpdates = 0;
    let peerStops = 0;
    comparisonCameraStore.registerView("peer", {
      readSnapshot: () => ({ quaternion: peerQuaternion.toArray(), worldUnitsPerPixel: 0.01 }),
      applySnapshot: update => {
        peerUpdates += 1;
        if (update.quaternion) peerQuaternion.fromArray(update.quaternion);
        comparisonCameraStore.publishView("peer");
      },
      stopMotion: () => { peerStops += 1; },
    });
    const { unmount } = render(<LatticeScene
      cameraCommandVersion={0}
      cameraInteractionStore={cameraInteractionStore}
      comparisonCameraStore={comparisonCameraStore}
      comparisonViewId="local"
      cameraState={cameraState}
      componentOpacity={createDefaultComponentOpacity()}
      interactionLocked={false}
      interactionMode="trackball"
      resetCounter={0}
      scene={scene}
      style={createDefaultStyle()}
    />);
    act(() => fireEvent.pointerDown(mockDomElement, { pointerId: 1 }));
    expect(comparisonCameraStore.getActiveView()).toBe("local");
    expect(peerStops).toBe(1);
    const controls = Object.assign(latestControls!, {
      _lastAngle: 0.8, _movePrev: new Vector2(1, 0), _moveCurr: new Vector2(2, 3),
      _zoomStart: new Vector2(0, 0), _zoomEnd: new Vector2(0, 1),
    });
    const before = mockCamera.quaternion.clone();
    act(() => comparisonCameraStore.setActiveView("peer"));
    expect(controls._lastAngle).toBe(0);
    expect(controls._movePrev.equals(controls._moveCurr)).toBe(true);
    expect(controls._zoomStart.equals(controls._zoomEnd)).toBe(true);
    controls.updateCalls = 0;
    act(() => latestFrameCallback?.());
    expect(controls.updateCalls).toBe(0);
    expect(mockCamera.quaternion.angleTo(before)).toBeLessThan(1e-7);
    act(() => cameraInteractionStore.requestCameraState(stateWithDirectAxis(scene.cell.vectors, cameraState, "a")));
    expect(comparisonCameraStore.getActiveView()).toBe("local");
    expect(peerUpdates).toBe(1);
    unmount();
    comparisonCameraStore.reset();
  });

  test.each([0, 0.45])("synchronizes reset and crystal-axis increments with %s relative orientation offset", offsetAngle => {
    const scene = orthogonalScene();
    const cameraState = createDefaultCrystalCameraState(scene.cell.vectors);
    const defaultQuaternion = computeCrystalCameraPose(scene.cell.vectors, cameraState, 4).quaternion;
    const cameraInteractionStore = createCameraInteractionStore();
    const comparisonCameraStore = createComparisonCameraStore({ uniformScale: false });
    const peerQuaternion = new Quaternion();
    let peerUpdates = 0;
    comparisonCameraStore.registerView("peer", {
      readSnapshot: () => ({ quaternion: peerQuaternion.toArray(), worldUnitsPerPixel: 0.01 }),
      applySnapshot: update => {
        if (update.quaternion) { peerQuaternion.fromArray(update.quaternion); peerUpdates += 1; }
        comparisonCameraStore.publishView("peer");
      },
      stopMotion: () => {},
    });
    const props = {
      cameraCommandVersion: 0, cameraInteractionStore, comparisonCameraStore, comparisonViewId: "local",
      cameraState, componentOpacity: createDefaultComponentOpacity(), interactionLocked: false,
      interactionMode: "trackball" as const, resetCounter: 0, scene, style: createDefaultStyle(),
    };
    const { rerender, unmount } = render(<LatticeScene {...props} />);
    comparisonCameraStore.setActiveView("local");
    mockCamera.quaternion.setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.8);
    act(() => comparisonCameraStore.align("local"));
    comparisonCameraStore.configure({ syncRotation: false });
    comparisonCameraStore.setActiveView("peer");
    peerQuaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), offsetAngle));
    comparisonCameraStore.publishView("peer");
    comparisonCameraStore.configure({ syncRotation: true });
    const resetExpected = peerQuaternion.clone().multiply(mockCamera.quaternion.clone().invert()).multiply(defaultQuaternion);
    rerender(<LatticeScene {...props} resetCounter={1} />);
    expect(mockCamera.quaternion.angleTo(defaultQuaternion)).toBeLessThan(1e-7);
    expect(peerQuaternion.angleTo(resetExpected)).toBeLessThan(1e-7);
    expect(comparisonCameraStore.getActiveView()).toBe("local");
    const updatesAfterReset = peerUpdates;
    act(() => latestFrameCallback?.());
    expect(peerUpdates).toBe(updatesAfterReset);

    const axisState = stateWithDirectAxis(scene.cell.vectors, cameraState, "b");
    const axisQuaternion = computeCrystalCameraPose(scene.cell.vectors, axisState, 4).quaternion;
    const axisExpected = peerQuaternion.clone().multiply(defaultQuaternion.clone().invert()).multiply(axisQuaternion);
    act(() => cameraInteractionStore.requestCameraState(axisState));
    expect(peerQuaternion.angleTo(axisExpected)).toBeLessThan(1e-7);

    const secondResetExpected = peerQuaternion.clone().multiply(mockCamera.quaternion.clone().invert()).multiply(defaultQuaternion);
    act(() => {
      cameraInteractionStore.requestViewScale(1);
      cameraInteractionStore.requestCameraState(cameraState);
      rerender(<LatticeScene {...props} cameraCommandVersion={1} resetCounter={2} />);
    });
    expect(peerQuaternion.angleTo(secondResetExpected)).toBeLessThan(1e-7);
    expect(comparisonCameraStore.getActiveView()).toBe("local");
    unmount();
    comparisonCameraStore.reset();
  });

  test("restores and captures independent pan across document remounts", () => {
    const scene = orthogonalScene();
    const initialPan: [number, number, number] = [2, -1, 3];
    const cameraInteractionStore = createCameraInteractionStore(1, initialPan);
    initialPan[0] = 999;
    const props = {
      cameraCommandVersion: 0, cameraInteractionStore,
      cameraState: createDefaultCrystalCameraState(scene.cell.vectors),
      componentOpacity: createDefaultComponentOpacity(), interactionLocked: false,
      interactionMode: "trackball" as const, resetCounter: 0, scene, style: createDefaultStyle(),
    };
    const first = render(<LatticeScene {...props} />);
    expectVectorClose(latestControls!.target, new Vector3(2, -1, 3));
    expectVectorClose(mockCamera.position, standardCameraPosition().add(new Vector3(2, -1, 3)));
    act(() => {
      latestControls!.target.set(-4, 2, 1);
      latestControls!.dispatchTestEvent("change");
    });
    const savedPan = cameraInteractionStore.getPanSnapshot();
    expect(savedPan).toEqual([-4, 2, 1]);
    first.unmount();
    resetMockCamera();
    const restoredStore = createCameraInteractionStore(1, savedPan);
    savedPan[0] = 888;
    const second = render(<LatticeScene {...props} cameraInteractionStore={restoredStore} />);
    expectVectorClose(latestControls!.target, new Vector3(-4, 2, 1));
    expectVectorClose(mockCamera.position, standardCameraPosition().add(new Vector3(-4, 2, 1)));
    second.unmount();
  });

  test("consumes a measured mobile safe area without applying another viewport heuristic", () => {
    const scene = orthogonalScene();
    mockViewportSize = { width: 390, height: 844 };
    const cameraInteractionStore = createCameraInteractionStore(1.4, [2, -1, 3]);
    const safeArea = { left: 12, right: 12, top: 56, bottom: 400 };
    const props = {
      cameraCommandVersion: 0, cameraInteractionStore,
      cameraState: createDefaultCrystalCameraState(scene.cell.vectors),
      componentOpacity: createDefaultComponentOpacity(), interactionLocked: false,
      interactionMode: "trackball" as const, resetCounter: 0, scene, style: createDefaultStyle(), safeArea,
    };
    const { rerender, unmount } = render(<LatticeScene {...props} />);
    expect((mockCamera.top + mockCamera.bottom) / 2).toBeCloseTo((safeArea.top - safeArea.bottom) / (2 * mockCamera.zoom));
    const orientation = mockCamera.quaternion.clone();
    const nextArea = { ...safeArea, bottom: 260 };
    rerender(<LatticeScene {...props} safeArea={nextArea} />);
    expect((mockCamera.top + mockCamera.bottom) / 2).toBeCloseTo((nextArea.top - nextArea.bottom) / (2 * mockCamera.zoom));
    expect(cameraInteractionStore.getViewScaleSnapshot()).toBe(1.4);
    expect(cameraInteractionStore.getPanSnapshot()).toEqual([2, -1, 3]);
    expect(mockCamera.quaternion.angleTo(orientation)).toBeCloseTo(0);
    unmount();
  });

  test("keeps user zoom when a controls change arrives during a layout fit before passive listeners refresh", () => {
    const scene = orthogonalScene();
    mockViewportSize = { width: 390, height: 844 };
    const cameraInteractionStore = createCameraInteractionStore(1, [2, -1, 3]);
    const mobileArea = { left: 12, right: 12, top: 56, bottom: 400 };
    const props = {
      cameraCommandVersion: 0, cameraInteractionStore,
      cameraState: createDefaultCrystalCameraState(scene.cell.vectors),
      componentOpacity: createDefaultComponentOpacity(), interactionLocked: false,
      interactionMode: "trackball" as const, resetCounter: 0, scene, style: createDefaultStyle(),
    };
    const { rerender, unmount } = render(<LatticeScene {...props} safeArea={mobileArea} />);
    const orientation = mockCamera.quaternion.clone();
    const snapshots: number[] = [];
    const unsubscribe = cameraInteractionStore.subscribeViewScale(() => snapshots.push(cameraInteractionStore.getViewScaleSnapshot()));
    const updateProjectionMatrix = mockCamera.updateProjectionMatrix.bind(mockCamera);
    let reported = false;
    const projectionUpdate = spyOn(mockCamera, "updateProjectionMatrix").mockImplementation(() => {
      updateProjectionMatrix();
      if (!reported) {
        reported = true;
        // Trackball reports an external camera.zoom change while the previous listener is still installed.
        latestControls?.dispatchTestEvent("change");
      }
    });
    mockViewportSize = { width: 651, height: 407 };
    const narrowArea = { left: 12, right: 368, top: 160, bottom: 52 };
    try {
      rerender(<LatticeScene {...props} safeArea={narrowArea} />);
      // A second ResizeObserver measurement may commit before the next render frame.
      rerender(<LatticeScene {...props} safeArea={{ ...narrowArea, top: 168 }} />);
      act(() => latestFrameCallback?.());
      expect(reported).toBe(true);
      expect(cameraInteractionStore.getViewScaleSnapshot()).toBeCloseTo(1);
      expect(snapshots).toEqual([]);
      expect(cameraInteractionStore.getPanSnapshot()).toEqual([2, -1, 3]);
      expect(mockCamera.quaternion.angleTo(orientation)).toBeCloseTo(0);
    } finally { projectionUpdate.mockRestore(); unsubscribe(); unmount(); }
  });

  test("retains pan and physical scale when a comparison pane resizes, then clears pan on reset", () => {
    const scene = orthogonalScene();
    const cameraInteractionStore = createCameraInteractionStore(1, [2, -1, 3]);
    const comparisonCameraStore = createComparisonCameraStore();
    const safeArea = { left: 20, right: 20, top: 60, bottom: 116 };
    const props = {
      cameraCommandVersion: 0, cameraInteractionStore, comparisonCameraStore, comparisonViewId: "local",
      cameraState: createDefaultCrystalCameraState(scene.cell.vectors),
      componentOpacity: createDefaultComponentOpacity(), interactionLocked: false,
      interactionMode: "trackball" as const, resetCounter: 0, scene, style: createDefaultStyle(), safeArea,
    };
    const { rerender, unmount } = render(<LatticeScene {...props} />);
    const originalZoom = mockCamera.zoom;
    mockViewportSize = { width: 600, height: 800 };
    rerender(<LatticeScene {...props} />);
    expectVectorClose(latestControls!.target, new Vector3(2, -1, 3));
    expect(cameraInteractionStore.getPanSnapshot()).toEqual([2, -1, 3]);
    expect(mockCamera.zoom).toBeCloseTo(originalZoom);
    expect((mockCamera.top + mockCamera.bottom) / 2).toBeCloseTo((safeArea.top - safeArea.bottom) / (2 * mockCamera.zoom));
    rerender(<LatticeScene {...props} resetCounter={1} />);
    expectVectorClose(latestControls!.target, new Vector3());
    expect(cameraInteractionStore.getPanSnapshot()).toEqual([0, 0, 0]);
    expectVectorClose(mockCamera.position, standardCameraPosition());
    unmount();
    comparisonCameraStore.reset();
  });

  test("fits once after split-pane ResizeObserver settles and preserves orientation on entry and exit", () => {
    const scene = orthogonalScene();
    const cameraInteractionStore = createCameraInteractionStore();
    const comparisonCameraStore = createComparisonCameraStore({ uniformScale: false });
    mockViewportSize = { width: 1512, height: 764 };
    const singleSafeArea = { left: 420, right: 176, top: 40, bottom: 116 };
    const comparisonSafeArea = { left: 20, right: 20, top: 60, bottom: 116 };
    const props = {
      cameraCommandVersion: 0, cameraInteractionStore,
      cameraState: createDefaultCrystalCameraState(scene.cell.vectors),
      componentOpacity: createDefaultComponentOpacity(), interactionLocked: false,
      interactionMode: "trackball" as const, resetCounter: 0, scene, style: createDefaultStyle(),
    };
    const { rerender, unmount } = render(<LatticeScene {...props} safeArea={singleSafeArea} />);
    const initialZoom = mockCamera.zoom;
    const orientation = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.8);
    const distance = mockCamera.position.length();
    mockCamera.quaternion.copy(orientation);
    mockCamera.up.set(0, 1, 0).applyQuaternion(orientation);
    mockCamera.position.set(0, 0, distance).applyQuaternion(orientation);
    const rectangle = { width: 566, height: 679 };
    const rectSpy = spyOn(mockDomElement, "getBoundingClientRect").mockImplementation(() => rectangle as DOMRect);
    try {
      rerender(<LatticeScene {...props} comparisonCameraStore={comparisonCameraStore} comparisonViewId="local" safeArea={comparisonSafeArea} />);
      act(() => latestFrameCallback?.());
      mockViewportSize = { width: 566, height: 679 };
      rerender(<LatticeScene {...props} comparisonCameraStore={comparisonCameraStore} comparisonViewId="local" safeArea={comparisonSafeArea} />);
      const expectedZoom = computeCameraFitZoom(computeSceneLayout(scene).cameraFitBounds, 566, 679, comparisonSafeArea);
      expect(mockCamera.zoom).toBeCloseTo(expectedZoom);
      expect(cameraInteractionStore.getViewScaleSnapshot()).toBeCloseTo(1);
      expect(mockCamera.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
      expect(mockCamera.zoom / initialZoom).toBeCloseTo(Math.sqrt((526 * 503) / (916 * 608)));
      rectangle.width = 1512; rectangle.height = 764;
      rerender(<LatticeScene {...props} safeArea={singleSafeArea} />);
      mockViewportSize = { width: 1512, height: 764 };
      rerender(<LatticeScene {...props} safeArea={singleSafeArea} />);
      expect(mockCamera.zoom).toBeCloseTo(initialZoom);
      expect(mockCamera.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
    } finally {
      rectSpy.mockRestore();
      unmount();
      comparisonCameraStore.reset();
    }
  });
});

function orthogonalScene(): SceneSpec {
  return {
    atoms: [
      {
        element: "Si",
        fractionalPosition: [0, 0, 0],
        id: "Si-0",
        imageOffset: [0, 0, 0],
        imageReasons: [],
        isPeriodicImage: false,
        position: [0, 0, 0],
        siteId: "Si-0",
        siteIndex: 0,
        visibilityDependencies: [],
        visibilityDependencyGroups: [],
      },
    ],
    bonds: [],
    bondFamilies: [],
    cell: {
      vectors: [
        [2, 0, 0],
        [0, 3, 0],
        [0, 0, 4],
      ],
    },
    polyhedra: [],
    summary: {
      atomCount: 1,
      cell: {
        a: "2.00",
        alpha: "90.00",
        b: "3.00",
        beta: "90.00",
        c: "4.00",
        gamma: "90.00",
      },
      formula: "Si",
      symmetry: {
        available: false,
        crystalSystem: null,
        latticeSystem: null,
        pointGroup: null,
        pointGroupSchoenflies: null,
        spaceGroup: null,
        spaceGroupNumber: null,
      },
    },
  };
}

function standardCameraPosition() {
  const distance = 16;
  return new Vector3(
    (distance * 6) / Math.sqrt(41),
    (distance * 2) / Math.sqrt(41),
    distance / Math.sqrt(41),
  );
}

function expectVectorClose(actual: Vector3, expected: Vector3) {
  expect(actual.x).toBeCloseTo(expected.x);
  expect(actual.y).toBeCloseTo(expected.y);
  expect(actual.z).toBeCloseTo(expected.z);
}
