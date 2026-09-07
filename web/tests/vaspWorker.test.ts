import { afterEach, expect, test } from "bun:test";
import { parseVaspFile } from "../src/api/vaspWorker";
import { parseVaspScene } from "../src/api/vasp";

const content = "CuI\n1\n6 0 0\n0 6 0\n0 0 6\nCu I\n1 1\nDirect\n.25 .25 .25\n.5 .5 .5";
const nativeWorker = globalThis.Worker;
const windowWorker = window.Worker;
afterEach(() => { globalThis.Worker = nativeWorker; window.Worker = windowWorker; });

test("large-file workers return the same structure and terminate after completion", async () => {
  let terminated = false;
  class TestWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(request: { content: string }) {
      queueMicrotask(() => this.onmessage?.({ data: { scene: parseVaspScene(request.content) } }));
    }
    terminate() { terminated = true; }
  }
  globalThis.Worker = window.Worker = TestWorker as unknown as typeof Worker;
  const file = new File([content, "\n".repeat(64 * 1024)], "POSCAR");
  expect(await parseVaspFile(file, {})).toEqual(parseVaspScene(content));
  expect(terminated).toBe(true);
});

test("cancelling a large parse terminates its worker without waiting for a result", async () => {
  let terminated = false;
  const controller = new AbortController();
  class TestWorker {
    postMessage() { queueMicrotask(() => controller.abort()); }
    terminate() { terminated = true; }
  }
  globalThis.Worker = window.Worker = TestWorker as unknown as typeof Worker;
  await expect(parseVaspFile(new File([content, "\n".repeat(64 * 1024)], "POSCAR"), { signal: controller.signal })).rejects.toThrow();
  expect(terminated).toBe(true);
});
