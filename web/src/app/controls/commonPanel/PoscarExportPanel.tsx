import { Download, FileCode2, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PoscarExportController } from "../../hooks/usePoscarExportController";

export function PoscarExportPanel({ controller, fileName, disabled = false }: {
  controller: PoscarExportController; fileName: string | null; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { metadata: preview, draft, error, busy, modified, open } = controller;

  return (
    <div className="flex flex-col gap-3 px-1.5 py-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm">POSCAR</span>
        <span className="text-xs text-muted-foreground">VASP · Direct</span>
      </div>
      {error ? <p role="alert" className="text-xs leading-relaxed text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" aria-label={t("poscar.preview")} onClick={() => void controller.preview()} disabled={disabled || busy}>
          <FileCode2 data-icon="inline-start" aria-hidden="true" />{t("poscar.previewAction")}
        </Button>
        <Button size="sm" aria-label={t("poscar.download")} onClick={() => void controller.exportFile()} disabled={disabled || busy}>
          {busy ? <LoaderCircle data-icon="inline-start" aria-hidden="true" className="animate-spin" />
            : <Download data-icon="inline-start" aria-hidden="true" />}{t("poscar.exportAction")}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={controller.changeOpen}>
        <DialogContent onKeyDown={event => event.stopPropagation()}
          className="max-h-[90dvh] grid-rows-[auto_auto_minmax(0,1fr)] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("poscar.preview")}</DialogTitle>
            <DialogDescription>{fileName} · {modified ? t("poscar.modified") : t("poscar.summary", {
              count: preview?.atomCount ?? 0, removed: preview?.removedCount ?? 0,
            })}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            {!modified ? <p>{t("poscar.potcar", { order: preview?.species.map((element, index) => `${element} (${preview.counts[index]})`).join(" → ") })}</p> : null}
            {error ? <p role="alert" className="text-destructive">{error}</p> : null}
            {controller.stale ? <Button size="sm" variant="outline" onClick={() => void controller.regenerate()} disabled={busy}>
              {t("modeling.regenerate")}</Button> : null}
          </div>
          <textarea aria-label={t("poscar.content")} dir="ltr" spellCheck={false} wrap="off"
            value={draft ?? ""} onChange={event => controller.changeDraft(event.target.value)} aria-invalid={Boolean(error)}
            className="h-[52dvh] min-h-40 w-full resize-none overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </DialogContent>
      </Dialog>
    </div>
  );
}
