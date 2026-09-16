import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  checkForUpdates, startUpdate, updateLogUrl, waitForUpdate, UpdateCheckError,
  type UpdateCheckErrorCode, type UpdateCheckResult, type UpdateJob, type UpdateJobStatus,
} from "../../api/updates";

type CheckState =
  | { status: "idle" | "checking" | "saving" | "starting" }
  | { status: "done"; result: UpdateCheckResult }
  | { status: "updating"; progress: UpdateJobStatus | null }
  | { status: "finished"; progress: UpdateJobStatus }
  | { status: "error"; code: UpdateCheckErrorCode; jobId?: string };

export function UpdateChecker({ currentVersion = import.meta.env.VITE_CRYSTALSKETCH_VERSION ?? "", onBeforeApply }: {
  currentVersion?: string; onBeforeApply?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<CheckState>({ status: "idle" });
  const [progressOpen, setProgressOpen] = useState(false);
  const request = useRef<AbortController | null>(null);
  const progressDialog = useRef<HTMLDivElement | null>(null);
  const busy = state.status === "checking" || state.status === "saving"
    || state.status === "starting" || state.status === "updating";
  const locked = progressOpen && busy;
  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, []);
  useLayoutEffect(() => {
    if (!locked) return;
    const isolateKeyboard = (event: KeyboardEvent) => {
      const dialog = progressDialog.current;
      if (event.target instanceof Node && dialog?.contains(event.target)) return;
      // Clicking the overlay can focus body without dismissing the modal.
      event.preventDefault();
      event.stopImmediatePropagation();
      dialog?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", isolateKeyboard, true);
    return () => document.removeEventListener("keydown", isolateKeyboard, true);
  }, [locked]);

  async function check() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    let job: UpdateJob | null = null;
    setProgressOpen(false);
    setState({ status: "checking" });
    try {
      const result = await checkForUpdates(currentVersion, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.status !== "available" || !result.supported || !result.intentToken || result.activeJob) {
        setState({ status: "done", result });
        return;
      }
      // Lock editing before saving; edits made after the save would be lost on reload.
      flushSync(() => {
        setProgressOpen(true);
        setState({ status: "saving" });
      });
      try { await onBeforeApply?.(); }
      catch {
        if (!controller.signal.aborted) setState({ status: "error", code: "save-failed" });
        return;
      }
      controller.signal.throwIfAborted();
      setState({ status: "starting" });
      const startedJob = await startUpdate(result.intentToken, controller.signal);
      job = startedJob;
      controller.signal.throwIfAborted();
      setState({ status: "updating", progress: null });
      const progress = await waitForUpdate(startedJob, { signal: controller.signal,
        onProgress: next => { if (!controller.signal.aborted) setState({ status: "updating", progress: next }); } });
      if (controller.signal.aborted) return;
      setState({ status: "finished", progress });
      if (progress.phase === "complete") window.location.reload();
    } catch (error) {
      if (!controller.signal.aborted) setState({ status: "error",
        code: error instanceof UpdateCheckError ? error.code : "request-failed",
        ...(job ? { jobId: job.jobId } : {}) });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  const result = state.status === "done" ? state.result : null;
  const progress = state.status === "finished" || state.status === "updating" ? state.progress : null;
  const canRetry = state.status === "error" || (state.status === "finished" && progress?.phase !== "complete");
  const phaseKey = progress?.phase === "complete" ? "updates.completed"
    : progress?.phase === "recovery-failed" ? "updates.recoveryFailed"
      : progress?.phase === "failed" ? (progress.restored ? "updates.updateFailed" : "updates.prepareFailed")
        : progress?.phase === "waiting-for-exit" ? "updates.reconnect"
          : progress ? `updates.${progress.phase}` as const : "updates.reconnect";
  const message = state.status === "done" && result
    ? result.status === "web" ? t("updates.webOnly") : t(result.status === "available" ? "updates.available" : "updates.latest",
      { version: result.status === "available" ? result.latestVersion : result.currentVersion })
    : state.status === "saving" ? t("updates.saving")
      : state.status === "starting" ? t("updates.starting")
      : state.status === "updating" || state.status === "finished" ? t(phaseKey)
      : state.status === "error" ? t(errorMessageKey(state.code)) : "";
  const logId = progress?.logAvailable ? progress.jobId : state.status === "error" ? state.jobId : undefined;

  return <div className="space-y-2">
    <p className="break-words text-[13px] text-muted-foreground">{t("updates.currentVersion", { version: result?.currentVersion || currentVersion || "—" })}</p>
    <p className="text-xs leading-relaxed text-muted-foreground">{t("updates.automaticUpdate")}</p>
    <Button type="button" variant="outline" size="sm" className="h-7 w-full text-[13px]"
      disabled={busy} onClick={() => { void check(); }}>
      {state.status === "checking" ? <LoadingSpinner /> : null}
      {t(state.status === "checking" ? "updates.checking" : "updates.check")}
    </Button>
    <p role="status" aria-live="polite" aria-atomic="true"
      className={state.status === "error" ? "text-xs leading-relaxed text-destructive" : "text-xs leading-relaxed text-muted-foreground"}>
      {progressOpen ? "" : message}
    </p>
    {result && result.status !== "web" && !result.supported ? <p className="text-xs leading-relaxed text-muted-foreground">
      {t(result.reason === "other-instance-running" ? "updates.otherInstances" : result.reason === "busy" ? "updates.busy" : "updates.unsupported")}
    </p> : null}
    {result?.activeJob ? <p className="text-xs text-muted-foreground">{t("updates.busy")}</p> : null}
    {logId && !progressOpen ? <Button asChild variant="link" size="sm" className="h-7 w-full text-xs">
      <a href={updateLogUrl(logId)} target="_blank" rel="noopener noreferrer">{t("updates.viewLog")}</a>
    </Button> : null}
    <Dialog open={progressOpen} onOpenChange={open => {
      if (!open && !busy && !request.current) setProgressOpen(false);
    }}>
      <DialogContent ref={progressDialog} showCloseButton={false}
        onKeyDown={event => event.stopPropagation()}
        onEscapeKeyDown={event => { if (busy || request.current) event.preventDefault(); }}
        onInteractOutside={event => { if (busy || request.current) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>{t("updates.updateTitle")}</DialogTitle>
          <DialogDescription>{t("updates.updateBody")}</DialogDescription>
        </DialogHeader>
        <p role="status" aria-live="polite" className="text-sm leading-relaxed">
          {busy ? <LoadingSpinner className="mr-2" /> : null}{message}
        </p>
        {logId ? <a href={updateLogUrl(logId)} target="_blank" rel="noopener noreferrer"
          className="text-sm underline underline-offset-4">{t("updates.viewLog")}</a> : null}
        {!busy ? <DialogFooter>
          <Button type="button" variant="outline"
            onClick={() => { if (!request.current) setProgressOpen(false); }}>{t("updates.close")}</Button>
          {canRetry ? <Button type="button" onClick={() => { void check(); }}>{t("updates.check")}</Button> : null}
        </DialogFooter> : null}
      </DialogContent>
    </Dialog>
  </div>;
}

function errorMessageKey(code: string) {
  if (code === "rate-limited") return "updates.rateLimited";
  if (code === "invalid-version") return "updates.invalidVersion";
  if (code === "expired") return "updates.expired";
  if (code === "busy") return "updates.busy";
  if (code === "other-instance-running") return "updates.otherInstances";
  if (code === "wait-timeout") return "updates.waitTimeout";
  if (code === "recovery-failed") return "updates.recoveryFailed";
  if (code === "save-failed") return "updates.saveFailed";
  if (["unsupported-installation", "source-installation", "unmanaged-server", "not-local"].includes(code)) return "updates.unsupported";
  if (code === "installation-changed") return "updates.expired";
  return "updates.failed";
}
