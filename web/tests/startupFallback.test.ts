import { expect, test } from "bun:test";

const indexHtml = await Bun.file(new URL("../index.html", import.meta.url)).text();

test("keeps an HTML fallback visible until the frontend starts", () => {
  expect(indexHtml).toContain("Starting CrystalSketch");
  expect(indexHtml).toContain("data-startup-fallback");
  expect(indexHtml).toContain("JavaScript is disabled");
});

test("turns a stalled startup into an actionable browser message", () => {
  expect(indexHtml).toContain("CrystalSketch could not start");
  expect(indexHtml).toContain("Crystal --verbose");
  expect(indexHtml).toContain("setTimeout");
});
