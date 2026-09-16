import { describe, expect, test } from "bun:test";

import { readFileSymmetry, uploadStructurePreview } from "../src/api/scene";
import { apiUrl } from "../src/api/url";

describe("scene API", () => {
  test("a remounted consumer does not inherit an aborted in-flight symmetry request", async () => {
    const originalFetch = globalThis.fetch;
    const file = new File(["structure"], "POSCAR");
    const first = new AbortController();
    let calls = 0;
    globalThis.fetch = Object.assign((_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      if (calls > 1) return Promise.resolve(Response.json({ available: true, spaceGroupNumber: 227 }));
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    }, { preconnect: originalFetch.preconnect });
    try {
      const abandoned = readFileSymmetry(file, first.signal);
      first.abort();
      const active = readFileSymmetry(file, new AbortController().signal);
      await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
      await expect(active).resolves.toMatchObject({ available: true, spaceGroupNumber: 227 });
      await expect(readFileSymmetry(file)).resolves.toMatchObject({ available: true });
      expect(calls).toBe(2);
    } finally { globalThis.fetch = originalFetch; }
  });

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
