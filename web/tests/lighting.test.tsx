import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { Euler, Quaternion, Vector3 } from "three";
import { setMetalEnvironmentRotation } from "../src/scene/MetalEnvironment";

import { LightingControls, lightDirectionFromPoint } from "../src/app/inspector/LightingControls";
import { MaterialPresetLights } from "../src/scene/MaterialPresetLights";
import cartoonPreset from "../src/data/material-presets/presets/cartoon.json";
import type { MaterialPresetLight } from "../src/model/materialPresets";
import { isMetalMaterialPreset } from "../src/model/materialPresets";
import { createDefaultStyle, crystalAxisMaterialForStyle } from "../src/model/appearance";

describe("lighting controls", () => {
  test("passes the active material and explicit light controls to crystal axes without palette or radius coupling", () => {
    const style = { ...createDefaultStyle(), materialPreset: "colored-metal", mainLightIntensity: 0, ambientLightIntensity: 0.35, lightDirection: [125, -20] as [number, number] };
    const before = JSON.stringify(style);
    const axes = crystalAxisMaterialForStyle(style, 0);
    expect(axes).toEqual({ materialPreset: "colored-metal", mainLightIntensity: 0, ambientLightIntensity: 0.35, lightDirection: [125, -20], lightStrength: 0 });
    const otherAppearance = { ...style, atomRadius: 30, bondThickness: 80, colorScheme: "nord" };
    expect(crystalAxisMaterialForStyle(otherAppearance, 0)).toEqual(axes);
    expect(JSON.stringify(style)).toBe(before);
  });
  test("keeps studio reflections camera-relative under compound crystal rotations", () => {
    for (const camera of [new Quaternion(0.5, 0.5, 0.5, 0.5), new Quaternion().setFromEuler(new Euler(0.3, -0.8, 1.2))]) {
      const rotation = new Euler();
      setMetalEnvironmentRotation(rotation, camera, new Quaternion());
      const viewRay = new Vector3(0.2, 0.4, 0.7).normalize();
      const sampledRay = viewRay.clone().applyQuaternion(camera)
        .applyEuler(new Euler(-rotation.x, -rotation.y, -rotation.z));
      expect(sampledRay.distanceTo(viewRay)).toBeLessThan(1e-6);
    }
  });

  test("new finishes scale all light lobes consistently while preserving direction and zero strength", () => {
    for (const presetId of ["soft-ceramic", "satin-matte", "cel-shaded", "colored-metal", "soft-jade", "soft-velvet"]) {
      for (const strength of [0, 1.5]) {
        const lights = MaterialPresetLights({
          presetId, lighting: cartoonPreset.lighting as MaterialPresetLight[],
          intensityScale: strength, mainIntensity: 0.4, ambientIntensity: 0.8, direction: [20, 30],
        }).props.children;
        const unitScale = isMetalMaterialPreset(presetId) ? 1 : Math.PI;
        expect(lights.every((light: ReactElement<{intensityScale: number}>) => light.props.intensityScale === strength * unitScale)).toBe(true);
      }
    }
  });

  test("maps the sphere to camera-relative directions and clamps outside drags", () => {
    expect(lightDirectionFromPoint(0, 0)).toEqual([0, 0]);
    expect(lightDirectionFromPoint(1, 0)).toEqual([90, 0]);
    expect(lightDirectionFromPoint(0, 1)[1]).toBe(90);
    const [azimuth, elevation] = lightDirectionFromPoint(-5, -5);
    expect(azimuth).toBeCloseTo(-90, 5);
    expect(elevation).toBeCloseTo(-45, 5);
  });

  test("supports pointer capture, independent sliders, and keyboard aiming", () => {
    const directions: [number, number][] = [];
    const main: number[] = [];
    const ambient: number[] = [];
    render(<LightingControls direction={[0, 0]}
      onDirectionChange={value => directions.push(value)}
      onMainIntensityChange={value => main.push(value)}
      onAmbientIntensityChange={value => ambient.push(value)} />);
    const ball = screen.getByRole("button", { name: "Light direction" });
    ball.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON() {} });
    let captured = false;
    ball.setPointerCapture = () => { captured = true; };
    ball.hasPointerCapture = () => captured;
    ball.releasePointerCapture = () => { captured = false; };
    fireEvent.pointerMove(ball, { pointerId: 1, clientX: 94, clientY: 50 });
    expect(directions).toHaveLength(0);
    fireEvent.pointerDown(ball, { button: 0, pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(ball, { pointerId: 1, clientX: 94, clientY: 50 });
    expect(directions.at(-1)).toEqual([90, 0]);
    fireEvent.pointerUp(ball, { pointerId: 1, clientX: 94, clientY: 50 });
    expect(captured).toBe(false);
    fireEvent.keyDown(ball, { key: "ArrowUp" });
    expect(directions.at(-1)).toEqual([0, 2]);
    fireEvent.keyDown(ball, { key: "ArrowLeft", shiftKey: true });
    expect(directions.at(-1)).toEqual([-10, 0]);
    fireEvent.change(screen.getByRole("slider", { name: "Main light" }), { target: { value: "0" } });
    expect(main).toEqual([0]);
    expect(ambient).toEqual([]);
    fireEvent.change(screen.getByRole("slider", { name: "Ambient light" }), { target: { value: "1.5" } });
    expect(ambient).toEqual([1.5]);
  });

  test("overrides main and ambient independently without changing the fixed fill light", () => {
    const direction: [number, number] = [-30, 20];
    const elements = MaterialPresetLights({
      lighting: cartoonPreset.lighting as MaterialPresetLight[],
      direction, mainIntensity: 0, ambientIntensity: 1.2, intensityScale: 1.5,
    }).props.children;
    type LightElement = ReactElement<Record<string, unknown>, (props: Record<string, unknown>) => ReactElement<Record<string, unknown>>>;
    const lights = (elements as LightElement[]).map(element => element.type(element.props));
    expect(lights).toHaveLength(3);
    expect(lights[0]?.props.intensity).toBeCloseTo(1.8);
    expect(lights[1]?.props.intensity).toBe(0);
    expect(lights[1]?.props.direction).toEqual(direction);
    expect(lights[1]?.props.intensityScale).toBe(1.5);
    expect(lights[2]?.props.intensity).toBe(0.2);
    expect(lights[2]?.props.direction).toBeUndefined();
  });
});
