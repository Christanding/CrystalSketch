import { ChevronDown, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AtomSpec, SceneSpec } from "../../api/scene";
import type { SceneSelection } from "../../selection/SceneSelection";
import { formatAtomSite } from "./atomAppearanceModel";

export interface DeletedObjectRecoveryProps {
  sourceScene?: SceneSpec;
  deletedSelection?: { atoms: string[]; bonds: string[] };
  onRestoreObjects?: (selection: SceneSelection) => void;
}

export function DeletedObjects({ kind, sourceScene, deletedSelection, onRestoreObjects, disabled = false }: DeletedObjectRecoveryProps & {
  kind: "atoms" | "bonds";
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => {
    if (!sourceScene || !deletedSelection) return [];
    const atoms = new Set(deletedSelection.atoms), bonds = new Set(deletedSelection.bonds);
    if (kind === "atoms") return sourceScene.atoms.filter(atom => atoms.has(atom.id)).map(atom => ({
      id: atom.id, label: atomLabel(atom), restoreAtoms: [atom.id], restoreBonds: [] as string[], needsEndpoints: false,
    }));
    return sourceScene.bonds.flatMap(bond => {
      const start = sourceScene.atoms[bond.startAtomIndex], end = sourceScene.atoms[bond.endAtomIndex];
      if (!start || !end) return [];
      const restoreAtoms = [...new Set([start.id, end.id].filter(id => atoms.has(id)))];
      if (!bonds.has(bond.id) && !restoreAtoms.length) return [];
      return [{ id: bond.id, label: `${atomLabel(start)}–${atomLabel(end)}`,
        restoreAtoms, restoreBonds: [bond.id], needsEndpoints: restoreAtoms.length > 0 }];
    });
  }, [kind, sourceScene?.atoms, sourceScene?.bonds, deletedSelection?.atoms, deletedSelection?.bonds]);
  const previousCount = useRef(rows.length);
  useEffect(() => {
    if (previousCount.current === 0 && rows.length) setExpanded(true);
    else if (!rows.length) setExpanded(false);
    previousCount.current = rows.length;
  }, [rows.length]);
  if (!rows.length) return null;
  const title = t(kind === "atoms" ? "objectsPanel.deletedAtoms" : "objectsPanel.deletedBonds");
  return <Collapsible open={expanded} onOpenChange={setExpanded} data-slot={`deleted-${kind}`}>
    <div className="py-4"><Separator className="opacity-60" /></div>
    <div className="flex min-h-6 items-center gap-1 px-2.5 text-[11px] font-medium text-muted-foreground">
      <span className="flex items-baseline gap-1.5"><span>{title}</span><span className="tabular-nums">{rows.length}</span></span>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={`${title} ${rows.length}`}
          className="size-6 rounded-md text-foreground/70 hover:bg-muted/35 hover:text-foreground">
          <ChevronDown aria-hidden="true" className={cn("transition-transform duration-240 motion-reduced:transition-none", expanded ? "rotate-0" : "-rotate-90")} />
        </Button>
      </CollapsibleTrigger>
    </div>
    <CollapsibleContent>
      {rows.some(row => row.needsEndpoints) ? <p className="px-2.5 pb-1 text-[11px] leading-relaxed text-muted-foreground">{t("objectsPanel.restoreDeletedEndpointsHint")}</p> : null}
      <div className="max-h-60 overflow-y-auto">
        {rows.map(row => {
          const restoreLabel = kind === "atoms" ? t("objectsPanel.restoreDeletedAtomFor", { atom: row.label })
            : t(row.needsEndpoints ? "objectsPanel.restoreDeletedEndpointBondFor" : "objectsPanel.restoreDeletedBondFor", { bond: row.label });
          return <div key={row.id} data-slot="deleted-object-row" className="flex min-h-7 items-center gap-2 rounded-md px-2.5 text-muted-foreground hover:bg-muted/35">
            <span className="min-w-0 flex-1 truncate" title={row.label}>{row.label}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="size-6 shrink-0 rounded-[8px]"
                  disabled={disabled || !onRestoreObjects} aria-label={restoreLabel}
                  onClick={() => onRestoreObjects?.({ atoms: new Set(row.restoreAtoms), bonds: new Set(row.restoreBonds) })}>
                  <RotateCcw aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{restoreLabel}</TooltipContent>
            </Tooltip>
          </div>;
        })}
      </div>
    </CollapsibleContent>
  </Collapsible>;
}

function atomLabel(atom: AtomSpec): string {
  return `${formatAtomSite(atom)}${atom.isPeriodicImage ? ` [${atom.imageOffset.join(", ")}]` : ""}`;
}
