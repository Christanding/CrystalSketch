import { describe, expect, test } from "bun:test";

import { readFileSymmetry, uploadStructurePreview } from "../src/api/scene";
import { apiUrl } from "../src/api/url";

describe("scene API", () => {
  test("routes cloud requests to the configured origin while preserving local defaults", async () => {
    const previousBase = process.env.VITE_CRYSTALSKETCH_API_URL;
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({});
    }, { preconnect: originalFetch.preconnect });
    try {
      delete process.env.VITE_CRYSTALSKETCH_API_URL;
      expect(apiUrl("/api/health")).toBe("/api/health");
      process.env.VITE_CRYSTALSKETCH_API_URL = "https://backend.example/";
      const file = new File(["structure"], "NaCl.cif");
      await uploadStructurePreview(file, { includeConnectivity: true });
      await readFileSymmetry(file);
      expect(calls).toEqual([
        "https://backend.example/api/structure-preview?includeConnectivity=true",
        "https://backend.example/api/structure-symmetry",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousBase === undefined) delete process.env.VITE_CRYSTALSKETCH_API_URL;
      else process.env.VITE_CRYSTALSKETCH_API_URL = previousBase;
    }
  });

  test("preserves the native AbortError from fetch", async () => {
    const originalFetch = globalThis.fetch;
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        throw abortError;
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      const request = uploadStructurePreview(new File(["structure"], "NaCl.cif"));
      await expect(request).rejects.toBe(abortError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
