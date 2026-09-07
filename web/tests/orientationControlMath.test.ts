import { describe, expect, test } from "bun:test";

import {
  displayRollDegrees,
  formatRollValue,
  parseRollInput,
  rollDisplayAnimationProgress,
  rollValueInputWidth,
  shortestRollDelta,
  toPositiveRollDegrees,
} from "../src/app/controls/commonPanel/orientation/orientationControlMath";

describe("orientation control math", () => {
  test("formats roll values as positive display degrees", () => {
    expect(toPositiveRollDegrees(-1)).toBe(359);
    expect(displayRollDegrees(359.6)).toBe(0);
    expect(formatRollValue(-90)).toBe("270");
    expect(rollValueInputWidth("123456789")).toBe("8ch");
  });

  test("computes the shortest displayed roll animation path", () => {
    expect(shortestRollDelta(350, 10)).toBe(20);
    expect(shortestRollDelta(10, 350)).toBe(-20);
    expect(shortestRollDelta(0, 180)).toBe(180);
    expect(rollDisplayAnimationProgress(0.5)).toBeCloseTo(0.875);
  });

  test("parses numeric roll text with an optional degree suffix", () => {
    expect(parseRollInput("42°")).toBe(42);
    expect(parseRollInput("  -15 ")).toBe(-15);
    expect(parseRollInput("nope")).toBeNull();
  });

});
