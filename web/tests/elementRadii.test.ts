import { describe, expect, test } from "bun:test";

import {
  elementRadiusForModel,
  elementRadiusSymbols,
  hasElementRadius,
} from "../src/app/elementRadii";

describe("element radii", () => {
  test("uses the CuI atomic radii while retaining other radius models", () => {
    expect(elementRadiusForModel("O", "uniform")).toBeCloseTo(1);
    expect(elementRadiusForModel("O", "atomic")).toBeCloseTo(0.63);
    expect(elementRadiusForModel("O", "vdw")).toBeCloseTo(1.52);
    expect(elementRadiusForModel("O", "ionic")).toBeCloseTo(1.4);
    expect(elementRadiusForModel("Sr", "atomic")).toBeCloseTo(1);
  });

  test("reports coverage through frontend element symbols", () => {
    expect(hasElementRadius("O")).toBe(true);
    expect(hasElementRadius("Missing")).toBe(false);
    expect(elementRadiusSymbols()).toContain("XX");
  });

  test("fails loudly when no display radius is defined", () => {
    expect(() => elementRadiusForModel("Missing", "uniform")).toThrow(
      "No element radius is defined for element Missing.",
    );
  });
});
