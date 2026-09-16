import { useEffect, useRef, useState } from "react";
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
  | { status: "updating"; job: UpdateJob; progress: UpdateJobStatus | null }
  | { status: "finished"; progress: UpdateJobStatus }
  | { status: "error"; code: UpdateCheckErrorCode; jobId?: string };

export function UpdateChecker({ currentVersion = import.meta.env.VITE_CRYSTALSKETCH_VERSION ?? "", onBeforeApply }: {
  currentVersion?: string; onBeforeApply?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<CheckState>({ status: "idle" });
  const [confirmation, setConfirmation] = useState<UpdateCheckResult | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, []);

  async function check() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setState({ status: "checking" });
    try {
      const result = await checkForUpdates(currentVersion, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setState({ status: "done", result });
    } catch (error) {
      if (!controller.signal.aborted) setState({ status: "error",
        code: error instanceof UpdateCheckError ? error.code : "request-failed" });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  async function observeUpdate(job: UpdateJob, controller: AbortController) {
    setState({ status: "updating", job, progress: null });
    const progress = await waitForUpdate(job, { signal: controller.signal,
      onProgress: next => { if (!controller.signal.aborted) setState({ status: "updating", job, progress: next }); } });
    if (controller.signal.aborted) return;
    setState({ status: "finished", progress });
    if (progress.phase === "complete") window.location.reload();
  }

  async function install() {
    if (request.current || !confirmation?.supported || confirmation.status !== "available"
      || !confirmation.intentToken) return;
    const controller = new AbortController();
    request.current = controller;
    let job: UpdateJob | null = null;
    setState({ status: "saving" });
    try {
      try { await onBeforeApply?.(); }
      catch {
        if (!controller.signal.aborted) setState({ status: "error", code: "save-failed" });
        return;
      }
      controller.signal.throwIfAborted();
      setState({ status: "starting" });
      job = await startUpdate(confirmation.intentToken, controller.signal);
      await observeUpdate(job, controller);
    } catch (error) {
      if (!controller.signal.aborted) setState({ status: "error",
        code: error instanceof UpdateCheckError ? error.code : "request-failed",
        ...(job ? { jobId: job.jobId } : {}) });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  const result = state.status === "done" ? state.result : null;
  const available = result?.status === "available" && result.supported && Boolean(result.intentToken);
  const busy = state.status === "checking" || state.status === "saving"
    || state.status === "starting" || state.status === "updating";
  const locked = confirmation !== null && busy;
  const canConfirm = state.status === "done" || (state.status === "error" && state.code === "save-failed");
  const progress = state.status === "finished" || state.status === "updating" ? state.progress : null;
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
    <Button type="button" variant="outline" size="sm" className="h-7 w-full text-[13px]"
      disabled={busy} onClick={() => { void check(); }}>
      {state.status === "checking" ? <LoadingSpinner /> : null}
      {t(state.status === "checking" ? "updates.checking" : "updates.check")}
    </Button>
    <p role="status" aria-live="polite" aria-atomic="true"
      className={state.status === "error" ? "text-xs leading-relaxed text-destructive" : "text-xs leading-relaxed text-muted-foreground"}>
      {confirmation ? "" : message}
    </p>
    {result && result.status !== "web" && !result.supported ? <p className="text-xs leading-relaxed text-muted-foreground">
      {t(result.reason === "other-instance-running" ? "updates.otherInstances" : result.reason === "busy" ? "updates.busy" : "updates.unsupported")}
    </p> : null}
    {result?.activeJob ? <p className="text-xs text-muted-foreground">{t("updates.busy")}</p> : null}
    {available ? <Button type="button" variant="outline" size="sm" className="h-7 w-full text-[13px]"
      onClick={() => setConfirmation(result)}>{t("updates.install")}</Button> : null}
    {logId && !confirmation ? <Button asChild variant="link" size="sm" className="h-7 w-full text-xs">
      <a href={updateLogUrl(logId)} target="_blank" rel="noopener noreferrer">{t("updates.viewLog")}</a>
    </Button> : null}
    <Dialog open={confirmation !== null} onOpenChange={open => {
      if (!open && !locked && !request.current) setConfirmation(null);
    }}>
      <DialogContent showCloseButton={!locked}
        onKeyDown={event => event.stopPropagation()}
        onEscapeKeyDown={event => { if (locked || request.current) event.preventDefault(); }}
        onInteractOutside={event => { if (locked || request.current) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>{t("updates.confirmTitle", { version: confirmation?.latestVersion })}</DialogTitle>
          <DialogDescription>{t("updates.confirmBody")}</DialogDescription>
        </DialogHeader>
        {state.status !== "done" ? <p role="status" aria-live="polite" className="text-sm leading-relaxed">
          {busy ? <LoadingSpinner className="mr-2" /> : null}{message}
        </p> : null}
        {logId ? <a href={updateLogUrl(logId)} target="_blank" rel="noopener noreferrer"
          className="text-sm underline underline-offset-4">{t("updates.viewLog")}</a> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={locked}
            onClick={() => { if (!request.current) setConfirmation(null); }}>{t("updates.cancel")}</Button>
          <Button type="button" onClick={() => { void install(); }} disabled={busy || !canConfirm}>{t("updates.confirm")}</Button>
        </DialogFooter>
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
