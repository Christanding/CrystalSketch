import { apiUrl } from "./url";

const UPDATE_TIMEOUT_MS = 10_000;
const JOB_ID = /^[a-f0-9]{32}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type UpdateCheckErrorCode = string;

export class UpdateCheckError extends Error {
  constructor(readonly code: UpdateCheckErrorCode, options?: ErrorOptions) {
    super(`Update check failed: ${code}`, options);
    this.name = "UpdateCheckError";
  }
}

export interface UpdateCheckResult {
  status: "available" | "latest" | "web";
  currentVersion: string;
  latestVersion?: string;
  supported: boolean;
  reason?: string | null;
  intentToken?: string;
  activeJob?: string;
}

export type UpdatePhase = "download" | "validate" | "backup" | "installing" | "restart" | "restore"
  | "waiting-for-exit" | "complete" | "failed" | "recovery-failed";
const UPDATE_PHASES = new Set<UpdatePhase>(["download", "validate", "backup", "installing", "restart",
  "restore", "waiting-for-exit", "complete", "failed", "recovery-failed"]);

export interface UpdateJob {
  jobId: string;
  version: string;
  phase: UpdatePhase;
}

export interface UpdateJobStatus extends UpdateJob {
  serverVersion: string;
  oldVersion: string;
  code: string | null;
  restored: boolean;
  logAvailable: boolean;
}

interface SemanticVersion {
  version: string;
  core: [string, string, string];
  prerelease: string[];
}

// SemVer 2.0.0, with the conventional Git tag v prefix. Build metadata has no precedence.
function parseVersion(input: string): SemanticVersion {
  const version = input.trim().replace(/^[vV]/, "");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) throw new UpdateCheckError("invalid-version");
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new UpdateCheckError("invalid-version");
  }
  return { version, core: [match[1]!, match[2]!, match[3]!], prerelease };
}

function compareNumeric(first: string, second: string): -1 | 0 | 1 {
  if (first.length !== second.length) return first.length < second.length ? -1 : 1;
  return first === second ? 0 : first < second ? -1 : 1;
}

/** Compares arbitrary-size numeric identifiers without lossy Number conversion. */
export function compareVersions(first: string, second: string): -1 | 0 | 1 {
  const a = parseVersion(first), b = parseVersion(second);
  for (let index = 0; index < 3; index++) {
    const order = compareNumeric(a.core[index]!, b.core[index]!);
    if (order) return order;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index], right = b.prerelease[index];
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return compareNumeric(left, right);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function localEndpoint(path: string): string | null {
  if (typeof window === "undefined" || !LOCAL_HOSTS.has(window.location.hostname)) return null;
  const url = new URL(apiUrl(path), window.location.origin);
  return url.origin === window.location.origin ? url.href : null;
}

/** The local service owns install detection, latest-release lookup and one-use update intents. */
export async function checkForUpdates(
  currentVersion: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<UpdateCheckResult> {
  signal?.throwIfAborted();
  const endpoint = localEndpoint("/api/updates/check");
  if (!endpoint) return { status: "web", supported: false, currentVersion, reason: "web" };
  const value = await localRequest(endpoint, { signal });
  if (!isRecord(value) || !["available", "latest"].includes(String(value.status))
    || typeof value.currentVersion !== "string" || typeof value.latestVersion !== "string"
    || typeof value.supported !== "boolean") throw new UpdateCheckError("invalid-response");
  parseVersion(value.currentVersion);
  parseVersion(value.latestVersion);
  const available = compareVersions(value.latestVersion, value.currentVersion) > 0;
  if ((value.status === "available") !== available || (value.activeJob !== undefined
    && (typeof value.activeJob !== "string" || !JOB_ID.test(value.activeJob)))) {
    throw new UpdateCheckError("invalid-response");
  }
  if (available && value.supported && !value.activeJob
    && (typeof value.intentToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.intentToken))) {
    throw new UpdateCheckError("invalid-response");
  }
  return { status: value.status as "available" | "latest", currentVersion: value.currentVersion,
    latestVersion: value.latestVersion, supported: value.supported,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.intentToken === "string" ? { intentToken: value.intentToken } : {}),
    ...(typeof value.activeJob === "string" ? { activeJob: value.activeJob } : {}) };
}

export async function startUpdate(intentToken: string, signal?: AbortSignal): Promise<UpdateJob> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(intentToken)) throw new UpdateCheckError("expired");
  const endpoint = localEndpoint("/api/updates/apply");
  if (!endpoint) throw new UpdateCheckError("unsupported-installation");
  const value = await localRequest(endpoint, { method: "POST", signal,
    headers: { "Content-Type": "application/json", "X-CrystalSketch-Update-Token": intentToken },
    body: JSON.stringify({ confirm: true }) });
  return readJob(value);
}

function readJob(value: unknown): UpdateJob {
  if (!isRecord(value) || typeof value.jobId !== "string" || !JOB_ID.test(value.jobId)
    || typeof value.version !== "string" || typeof value.phase !== "string"
    || !UPDATE_PHASES.has(value.phase as UpdatePhase)) throw new UpdateCheckError("invalid-response");
  parseVersion(value.version);
  return { jobId: value.jobId, version: value.version, phase: value.phase as UpdatePhase };
}

export async function readUpdateStatus(jobId: string, signal?: AbortSignal): Promise<UpdateJobStatus> {
  if (!JOB_ID.test(jobId)) throw new UpdateCheckError("unknown-job");
  const endpoint = localEndpoint(`/api/updates/status/${jobId}`);
  if (!endpoint) throw new UpdateCheckError("unsupported-installation");
  const value = await localRequest(endpoint, { signal });
  const job = readJob(value);
  if (!isRecord(value) || job.jobId !== jobId || typeof value.serverVersion !== "string"
    || typeof value.oldVersion !== "string" || typeof value.restored !== "boolean"
    || typeof value.logAvailable !== "boolean") throw new UpdateCheckError("invalid-response");
  parseVersion(value.serverVersion);
  parseVersion(value.oldVersion);
  return { ...job, serverVersion: value.serverVersion, oldVersion: value.oldVersion,
    restored: value.restored, logAvailable: value.logAvailable,
    code: typeof value.code === "string" ? value.code : null };
}

/** Poll only a user-confirmed job. A completed log is insufficient without the matching live version. */
export async function waitForUpdate(job: UpdateJob, { signal, onProgress }: {
  signal?: AbortSignal; onProgress?: (status: UpdateJobStatus | null) => void;
} = {}): Promise<UpdateJobStatus> {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const status = await readUpdateStatus(job.jobId, signal);
      if (status.version !== job.version) throw new UpdateCheckError("invalid-response");
      const verified = status.phase === "complete"
        && parseVersion(status.serverVersion).version === parseVersion(job.version).version;
      onProgress?.(status.phase === "complete" && !verified ? { ...status, phase: "restart" } : status);
      if (verified || status.phase === "failed" || status.phase === "recovery-failed") return status;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof UpdateCheckError && ["expired", "not-local", "unknown-job"].includes(error.code)) throw error;
      onProgress?.(null);
    }
    await abortableDelay(1000, signal);
  }
  throw new UpdateCheckError("wait-timeout");
}

export function updateLogUrl(jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new UpdateCheckError("unknown-job");
  const endpoint = localEndpoint(`/api/updates/log/${jobId}`);
  if (!endpoint) throw new UpdateCheckError("unsupported-installation");
  return endpoint;
}

async function localRequest(endpoint: string, init: RequestInit): Promise<unknown> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new UpdateCheckError("offline");
  const signal = init.signal;
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new UpdateCheckError("timeout"));
  }, UPDATE_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      ...init, signal: controller.signal, credentials: "omit", cache: "no-store", mode: "same-origin",
    });
    let value: unknown;
    try { value = await response.json(); }
    catch (error) { throw new UpdateCheckError("invalid-response", { cause: error }); }
    if (!response.ok) {
      const detail = isRecord(value) && isRecord(value.detail) ? value.detail : null;
      throw new UpdateCheckError(typeof detail?.code === "string" ? detail.code
        : response.status === 429 ? "rate-limited" : "request-failed");
    }
    controller.signal.throwIfAborted();
    return value;
  } catch (error) {
    signal?.throwIfAborted();
    if (timedOut) throw new UpdateCheckError("timeout");
    if (error instanceof UpdateCheckError) throw error;
    throw new UpdateCheckError(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "request-failed", { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
