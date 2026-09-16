import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { checkForUpdates, compareVersions, startUpdate, updateLogUrl, waitForUpdate } from "../src/api/updates";
import { UpdateChecker } from "../src/app/inspector/UpdateChecker";
import { i18n } from "../src/i18n";

const TOKEN = "a".repeat(43);
const JOB = "b".repeat(32);
const checked = (currentVersion = "1.0.0", latestVersion = "2.0.0", supported = true) => ({
  status: compareVersions(latestVersion, currentVersion) > 0 ? "available" : "latest",
  currentVersion, latestVersion, supported, ...(supported ? { intentToken: TOKEN } : { reason: "source-installation" }),
});
const jobStatus = (phase = "complete", serverVersion = "2.0.0") => ({
  jobId: JOB, version: "2.0.0", oldVersion: "1.0.0", serverVersion, phase,
  code: null, restored: false, logAvailable: true,
});
const fetchHandler = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  Object.assign(handler, { preconnect: globalThis.fetch.preconnect });

describe("update version comparison", () => {
  test("compares numeric versions and ignores v prefixes and build metadata without numeric precision loss", () => {
    expect(compareVersions("v1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("  V1.2.3+macos.2 ", "1.2.3+windows.1")).toBe(0);
    expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
    expect(compareVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBe(1);
  });

  test("orders prerelease identifiers according to SemVer, including numeric identifiers", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
      "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let index = 1; index < ordered.length; index++) {
      expect(compareVersions(ordered[index - 1]!, ordered[index]!)).toBe(-1);
      expect(compareVersions(ordered[index]!, ordered[index - 1]!)).toBe(1);
    }
    expect(compareVersions("1.0.0-rc.1", "v1.0.0-rc.1+build.4")).toBe(0);
  });

  test("rejects ambiguous, malformed and unsafe version strings", () => {
    for (const value of ["", "1.2", "release-1.2.3", "01.2.3", "1.2.3-01", "1.2.3-rc..1",
      "1.2.3+", "v1.2.3/../../evil", "1.2.3?next=https://example.com"]) {
      expect(() => compareVersions(value, "1.0.0")).toThrow();
    }
  });
});

describe("local update API", () => {
  test("uses the same-origin server's actual version and installation support without sending structure data", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fetchHandler(async () => Response.json(checked())));
    try {
      const result = await checkForUpdates("0.9.0");
      expect(result).toMatchObject({ currentVersion: "1.0.0", latestVersion: "2.0.0", supported: true, intentToken: TOKEN });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`${window.location.origin}/api/updates/check`);
      expect(init).toMatchObject({ credentials: "omit", cache: "no-store", mode: "same-origin" });
      expect(init?.body).toBeUndefined();
    } finally { fetchMock.mockRestore(); }
  });

  test("sends only explicit confirmation and the short-lived intent, never a command, URL or path", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(jobStatus("download", "1.0.0")));
    try {
      expect(await startUpdate(TOKEN)).toEqual({ jobId: JOB, version: "2.0.0", phase: "download" });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`${window.location.origin}/api/updates/apply`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe('{"confirm":true}');
      expect(new Headers(init?.headers).get("X-CrystalSketch-Update-Token")).toBe(TOKEN);
      expect(updateLogUrl(JOB)).toBe(`${window.location.origin}/api/updates/log/${JOB}`);
      expect(() => updateLogUrl("../../private")).toThrow();
    } finally { fetchMock.mockRestore(); }
  });

  test("rejects malformed or inconsistent capability responses and never accepts an unsafe job ID", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    try {
      for (const value of [null, [], {}, { ...checked(), intentToken: "bad" },
        { ...checked(), status: "latest" }, { ...checked(), activeJob: "../../outside" }]) {
        fetchMock.mockImplementation(fetchHandler(async () => Response.json(value)));
        await expect(checkForUpdates("1.0.0")).rejects.toMatchObject({ code: "invalid-response" });
      }
      fetchMock.mockImplementation(fetchHandler(async () => new Response("<html>unavailable</html>")));
      await expect(checkForUpdates("1.0.0")).rejects.toMatchObject({ code: "invalid-response" });
    } finally { fetchMock.mockRestore(); }
  });

  test("preserves rate-limit and expired-intent errors without retrying an install", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    try {
      fetchMock.mockResolvedValueOnce(Response.json({ detail: { code: "rate-limited" } }, { status: 429 }));
      await expect(checkForUpdates("1.0.0")).rejects.toMatchObject({ code: "rate-limited" });
      fetchMock.mockResolvedValueOnce(Response.json({ detail: { code: "expired" } }, { status: 403 }));
      await expect(startUpdate(TOKEN)).rejects.toMatchObject({ code: "expired" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      await expect(checkForUpdates("1.0.0")).rejects.toMatchObject({ code: "request-failed" });
    } finally { fetchMock.mockRestore(); }
  });

  test("does not contact the server when explicitly offline", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    const original = Object.getOwnPropertyDescriptor(navigator, "onLine");
    try {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
      await expect(checkForUpdates("1.0.0")).rejects.toMatchObject({ code: "offline" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
      if (original) Object.defineProperty(navigator, "onLine", original);
      else Reflect.deleteProperty(navigator, "onLine");
    }
  });

  test("aborts an unfinished request at the ten-second deadline and preserves caller cancellation", async () => {
    const timers = spyOn(globalThis, "setTimeout");
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fetchHandler((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));
    try {
      const pending = checkForUpdates("1.0.0");
      const timeout = timers.mock.calls.find(([, delay]) => delay === 10_000)?.[0];
      expect(typeof timeout).toBe("function");
      if (typeof timeout === "function") timeout();
      await expect(pending).rejects.toMatchObject({ code: "timeout" });
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      const controller = new AbortController();
      const cancelled = checkForUpdates("1.0.0", { signal: controller.signal });
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    } finally { fetchMock.mockRestore(); timers.mockRestore(); }
  });

  test("waits for both completed installation and the matching restarted server version", async () => {
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(jobStatus("complete", "1.0.0")))
      .mockResolvedValueOnce(Response.json(jobStatus("complete", "2.0.0")));
    const phases: string[] = [];
    try {
      const result = await waitForUpdate({ jobId: JOB, version: "2.0.0", phase: "download" }, {
        onProgress: status => { if (status) phases.push(status.phase); },
      });
      expect(phases).toEqual(["restart", "complete"]);
      expect(result.serverVersion).toBe("2.0.0");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { fetchMock.mockRestore(); }
  });
});

describe("update checker interaction", () => {
  test("shows the build version without automatic checks and installs after one explicit check", async () => {
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(checked()))
      .mockResolvedValueOnce(Response.json(jobStatus("download", "1.0.0")))
      .mockResolvedValueOnce(Response.json(jobStatus()));
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    try {
      render(<UpdateChecker />);
      expect(screen.getByText(i18n.t("updates.currentVersion", { version: import.meta.env.VITE_CRYSTALSKETCH_VERSION }))).toBeTruthy();
      expect(screen.getByText(i18n.t("updates.automaticUpdate"))).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByRole("link")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.check") }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST", "GET"]);
      expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{"confirm":true}');
      expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("X-CrystalSketch-Update-Token")).toBe(TOKEN);
    } finally { fetchMock.mockRestore(); reload.mockRestore(); }
  });

  test("prevents duplicate clicks and aborts the active lookup on unmount", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fetchHandler((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));
    try {
      const view = render(<UpdateChecker currentVersion="1.0.0" />);
      const button = screen.getByRole("button", { name: i18n.t("updates.check") });
      act(() => { fireEvent.click(button); fireEvent.click(button); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((screen.getByRole("button", { name: i18n.t("updates.checking") }) as HTMLButtonElement).disabled).toBe(true);
      view.unmount();
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      await act(async () => { await Promise.resolve(); });
    } finally { fetchMock.mockRestore(); }
  });

  test("reports a rate limit and lets the user explicitly retry without retaining a cached result", async () => {
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ detail: { code: "rate-limited" } }, { status: 429 }))
      .mockResolvedValueOnce(Response.json(checked("1.0.0", "1.0.0")));
    try {
      render(<UpdateChecker currentVersion="1.0.0" />);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.check") }));
      await screen.findByText(i18n.t("updates.rateLimited"));
      expect(screen.queryByRole("link")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.check") }));
      await waitFor(() => expect(screen.getByRole("status").textContent)
        .toBe(i18n.t("updates.latest", { version: "1.0.0" })));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("link")).toBeNull();
    } finally { fetchMock.mockRestore(); }
  });

  test.each([
    { name: "source installation", result: checked("1.0.0", "2.0.0", false), message: i18n.t("updates.unsupported") },
    { name: "up-to-date installation", result: checked("1.0.0", "1.0.0"), message: i18n.t("updates.latest", { version: "1.0.0" }) },
    { name: "active update job", result: { ...checked(), activeJob: JOB }, message: i18n.t("updates.busy") },
  ])("$name does not save or start another installation", async ({ result, message }) => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(result));
    const save = mock(async () => {});
    try {
      render(<UpdateChecker currentVersion="1.0.0" onBeforeApply={save} />);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.check") }));
      await screen.findByText(message);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });

  test("the hosted web version never makes an installation request", async () => {
    const hostname = Object.getOwnPropertyDescriptor(window.location, "hostname");
    const fetchMock = spyOn(globalThis, "fetch");
    const save = mock(async () => {});
    try {
      Object.defineProperty(window.location, "hostname", { configurable: true, value: "christanding.github.io" });
      render(<UpdateChecker currentVersion="1.0.0" onBeforeApply={save} />);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.check") }));
      await screen.findByText(i18n.t("updates.webOnly"));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
      if (hostname) Object.defineProperty(window.location, "hostname", hostname);
      else Reflect.deleteProperty(window.location, "hostname");
    }
  });

  test("awaits successful saving under an unclosable, keyboard-isolated modal before any apply request", async () => {
    let finishSave: (() => void) | undefined;
    let acceptUpdate: ((response: Response) => void) | undefined;
    const saveContext: { dialog: HTMLElement | null; guardReady: boolean } = { dialog: null, guardReady: false };
    const save = mock(() => {
      saveContext.dialog = screen.queryByRole("dialog");
      const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      saveContext.guardReady = event.defaultPrevented;
      return new Promise<void>(resolve => { finishSave = resolve; });
    });
    const keyboard = mock(() => {});
    window.addEventListener("keydown", keyboard);
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(checked()))
      .mockImplementationOnce(fetchHandler(() => new Promise(resolve => { acceptUpdate = resolve; })))
      .mockResolvedValueOnce(Response.json(jobStatus()));
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    try {
      render(<UpdateChecker currentVersion="1.0.0" onBeforeApply={save} />);
      const check = screen.getByRole("button", { name: i18n.t("updates.check") });
      fireEvent.click(check);
      await screen.findByText(i18n.t("updates.saving"));
      expect(save).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((check as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      const dialog = screen.getByRole("dialog");
      expect(saveContext.dialog).toBe(dialog);
      expect(saveContext.guardReady).toBe(true);
      fireEvent.keyDown(dialog, { key: "Delete" });
      fireEvent.keyDown(dialog, { key: "Escape" });
      fireEvent.pointerDown(document.body);
      fireEvent.keyDown(document.body, { key: "Delete" });
      fireEvent.keyDown(document.body, { key: "Backspace" });
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(document.activeElement).toBe(dialog);
      fireEvent.click(check);
      expect(keyboard).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => { finishSave?.(); });
      await screen.findByText(i18n.t("updates.starting"));
      fireEvent.click(check);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenCalledTimes(1);
      await act(async () => { acceptUpdate?.(Response.json(jobStatus("download", "1.0.0"))); });
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally { window.removeEventListener("keydown", keyboard); fetchMock.mockRestore(); reload.mockRestore(); }
  });

  test("unmounting during saving never starts an installation after the save resolves", async () => {
    let finishSave: (() => void) | undefined;
    const save = mock(() => new Promise<void>(resolve => { finishSave = resolve; }));
    const keyboard = mock(() => {});
    window.addEventListener("keydown", keyboard);
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(checked()));
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    try {
      const view = render(<UpdateChecker currentVersion="1.0.0" onBeforeApply={save} />);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.check") }));
      await screen.findByText(i18n.t("updates.saving"));
      view.unmount();
      fireEvent.keyDown(document.body, { key: "Delete" });
      expect(keyboard).toHaveBeenCalledTimes(1);
      await act(async () => { finishSave?.(); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
    } finally { window.removeEventListener("keydown", keyboard); fetchMock.mockRestore(); reload.mockRestore(); }
  });

  test("a failed save leaves the installation untouched and a single new check can retry", async () => {
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(checked()))
      .mockResolvedValueOnce(Response.json(checked()))
      .mockResolvedValueOnce(Response.json(jobStatus("download", "1.0.0")))
      .mockResolvedValueOnce(Response.json(jobStatus()));
    const save = mock(async () => {}).mockRejectedValueOnce(new Error("storage unavailable"));
    const keyboard = mock(() => {});
    window.addEventListener("keydown", keyboard);
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    try {
      render(<UpdateChecker currentVersion="1.0.0" onBeforeApply={save} />);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.check") }));
      await screen.findByText(i18n.t("updates.saveFailed"));
      fireEvent.keyDown(document.body, { key: "Delete" });
      expect(keyboard).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("link")).toBeNull();
      expect((screen.getByRole("button", { name: i18n.t("updates.close") }) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.check") }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(save).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "GET", "POST", "GET"]);
    } finally { window.removeEventListener("keydown", keyboard); fetchMock.mockRestore(); reload.mockRestore(); }
  });

  test.each([
    { phase: "failed", restored: true, message: i18n.t("updates.updateFailed") },
    { phase: "failed", restored: false, message: i18n.t("updates.prepareFailed") },
    { phase: "recovery-failed", restored: false, message: i18n.t("updates.recoveryFailed") },
  ])("reports $phase (restored=$restored) with logs, without reloading or automatically retrying", async ({ phase, restored, message }) => {
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(checked()))
      .mockResolvedValueOnce(Response.json(jobStatus("download", "1.0.0")))
      .mockResolvedValueOnce(Response.json({ ...jobStatus(phase, "1.0.0"), restored, code: "install-failed" }));
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    try {
      render(<UpdateChecker currentVersion="1.0.0" />);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.check") }));
      await screen.findByText(message);
      expect(reload).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("link", { name: i18n.t("updates.viewLog") }).getAttribute("href"))
        .toBe(`${window.location.origin}/api/updates/log/${JOB}`);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.close") }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("status").textContent).toBe(message);
      expect(screen.getByRole("link", { name: i18n.t("updates.viewLog") })).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally { fetchMock.mockRestore(); reload.mockRestore(); }
  });

  test("an expired intent requires another explicit check and never retries the apply request", async () => {
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(checked()))
      .mockResolvedValueOnce(Response.json({ detail: { code: "expired" } }, { status: 403 }));
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    try {
      render(<UpdateChecker currentVersion="1.0.0" />);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.check") }));
      await screen.findByText(i18n.t("updates.expired"));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("link")).toBeNull();
      expect(reload).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); reload.mockRestore(); }
  });

  test("unmounting during update observation aborts the status request and does not reload", async () => {
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(checked()))
      .mockResolvedValueOnce(Response.json(jobStatus("download", "1.0.0")))
      .mockImplementationOnce(fetchHandler((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })));
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    try {
      const view = render(<UpdateChecker currentVersion="1.0.0" />);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.check") }));
      await screen.findByText(i18n.t("updates.reconnect"));
      expect(fetchMock).toHaveBeenCalledTimes(3);
      view.unmount();
      expect(fetchMock.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
      await act(async () => { await Promise.resolve(); });
      expect(reload).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally { fetchMock.mockRestore(); reload.mockRestore(); }
  });
});
