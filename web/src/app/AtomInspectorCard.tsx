import { Copy, EyeOff, RotateCcw, SquareMousePointer, Trash2, X } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AtomSpec } from "../api/scene";
import { HexColorPicker, normalizeHexColor } from "./controls/HexColorPicker";
import { elementColorsForScheme } from "../model/colorSchemes";

import {
  atomInspectorCopyText,
  atomSiteIndex,
  formatAtomCoordinateForDisplay,
  formatCellOffset,
  type InspectedAtomInfo,
} from "./atomInspector";
import {
  resolveAtomAppearance,
  type StyleState,
} from "../model";
import type { ElementColorOverrides } from "./colorSchemes";
import { GLASS_SURFACE_CLASS, TOOL_ICON_BUTTON_CLASS } from "./surface";

export function AtomInspectorCard({
  colorScheme,
  colorOverrides,
  info,
  isInspectorOpen,
  onClose,
  onDelete,
  onHide,
  onLocateInObjects,
  onColorChange,
  selectedAtoms,
  style,
}: {
  colorScheme: StyleState["colorScheme"];
  colorOverrides?: ElementColorOverrides;
  info: InspectedAtomInfo;
  isInspectorOpen: boolean;
  onClose: () => void;
  onDelete: () => void;
  onHide: (atomId: string) => void;
  onLocateInObjects?: (atomId: string) => void;
  onColorChange?: (color: string | null, group?: object) => void;
  selectedAtoms?: readonly AtomSpec[];
  style: StyleState;
}) {
  const { t } = useTranslation();
  const colorSession = useRef<object>({});
  const changeColor = (color: string | null) => onColorChange?.(color, colorSession.current);
  const { atom, canonicalAtom } = info;
  const atomColor = resolveAtomAppearance({
    atom: canonicalAtom,
    colorOverrides,
    colorScheme,
    style,
  }).color;
  const sites = useMemo(() => [...new Map((selectedAtoms ?? [canonicalAtom]).map(atom => [atom.siteId, atom])).values()], [selectedAtoms, canonicalAtom]);
  const colors = [...new Set(sites.map(atom => normalizeHexColor(resolveAtomAppearance({ atom, colorOverrides, colorScheme, style }).color)))];
  const mixed = colors.length > 1;
  const selectionKey = sites.map(atom => atom.siteId).sort().join("|");
  const paletteColors = useMemo(() => [...new Set(Object.values({
    ...elementColorsForScheme(colorScheme), ...colorOverrides,
  }).map(color => normalizeHexColor(color)))], [colorScheme, colorOverrides]);
  const hasColorOverride = (selectedAtoms ?? [canonicalAtom]).some(atom =>
    style.objectStyles.atomOverrides[atom.siteId]?.color !== undefined || style.objectStyles.atomOverrides[atom.id]?.color !== undefined);
  const handleCopy = useCallback(() => {
    void navigator.clipboard?.writeText(atomInspectorCopyText(info));
  }, [info]);

  return (
    <aside
      aria-label={t("atomInspector.selectedAtom")}
      className={cn(
        "absolute right-16 top-4 z-30 w-[300px] rounded-xl border px-3 py-2.5 font-mono text-xs shadow-xl shadow-foreground/10",
        "transition-[right] duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduced:transition-none",
        "max-[760px]:right-4 max-[760px]:top-14 max-[760px]:w-[calc(100vw-2rem)]",
        isInspectorOpen ? "min-[761px]:right-[388px]" : null,
        GLASS_SURFACE_CLASS,
      )}
    >
      <div className={cn("grid h-7 items-center gap-2", sites.length > 1
        ? "grid-cols-[1.5rem_1.125rem_minmax(0,1fr)_1.5rem]"
        : "grid-cols-[1.5rem_1.125rem_minmax(0,1fr)_1.5rem_1.5rem_1.5rem_1.5rem]")}>
        <TooltipProvider delayDuration={500}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("actions.closeAtomInfo")}
                className={cn(TOOL_ICON_BUTTON_CLASS, "size-6 rounded-[9px] [&_svg]:size-3.25")}
                onClick={onClose}
              >
                <X aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("actions.closeAtomInfo")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {onColorChange ? <HexColorPicker key={selectionKey}
          pickerId={`inspector:atom-colors:${selectionKey}`}
          ariaLabel={t("atomInspector.changeSelectedColor", { count: sites.length })}
          inputLabel={t("atomInspector.selectedColor")}
          value={mixed ? "#808080" : colors[0] ?? atomColor}
          triggerClassName="rounded-full"
          swatchClassName="rounded-full"
          swatchStyle={mixed ? { background: `linear-gradient(135deg, ${colors[0]} 50%, ${colors[1]} 50%)` } : undefined}
          onOpenChange={open => { if (open) colorSession.current = {}; }}
          onInteractionStart={() => { colorSession.current = {}; }}
          onValueChange={changeColor}
          side="bottom" align="start"
          contentClassName="max-h-[min(calc(100dvh-1rem),var(--radix-popover-content-available-height))] overflow-y-auto"
        >
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">{t("atomInspector.currentPalette")}</span>
            <ToggleGroup type="single" value={mixed ? "" : colors[0] ?? atomColor} variant="outline" size="sm"
              className="grid max-h-16 grid-cols-7 gap-1 overflow-y-auto" aria-label={t("atomInspector.currentPalette")} onValueChange={color => { if (color) onColorChange(color); }}>
              {paletteColors.map(color => <ToggleGroupItem key={color} value={color} className="size-7 p-0"
                aria-label={t("atomInspector.usePaletteColor", { color })}>
                <span className="size-[18px] rounded-full border border-foreground/10" style={{ backgroundColor: color }} />
              </ToggleGroupItem>)}
            </ToggleGroup>
            <Button type="button" variant="ghost" size="sm" disabled={!hasColorOverride} onClick={() => onColorChange(null)}>
              <RotateCcw data-icon="inline-start" />{t("atomInspector.restoreElementColor")}
            </Button>
          </div>
        </HexColorPicker> : <span aria-hidden="true" className="size-3.5 shrink-0 rounded-full border border-foreground/10 shadow-sm" style={{ backgroundColor: atomColor }} />}
        <span className="min-w-0 truncate text-[0.78rem] font-semibold text-foreground">
          {sites.length > 1 ? t("atomInspector.selectedCount", { count: sites.length }) : `${canonicalAtom.element}:${atomSiteIndex(canonicalAtom)}`}
        </span>

        <TooltipProvider delayDuration={500}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("actions.deleteSelected")}
                className={cn(TOOL_ICON_BUTTON_CLASS, "size-6 rounded-[9px] [&_svg]:size-3.25")}
                onClick={onDelete}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("actions.deleteSelected")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {sites.length === 1 ? <>
        <TooltipProvider delayDuration={500}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("actions.hideAtom")}
                className={cn(TOOL_ICON_BUTTON_CLASS, "size-6 rounded-[9px] [&_svg]:size-3.25")}
                onClick={() => onHide(canonicalAtom.siteId)}
              >
                <EyeOff aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("actions.hideAtomShortcut")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <TooltipProvider delayDuration={500}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("actions.copyAtomInfo")}
                className={cn(TOOL_ICON_BUTTON_CLASS, "size-6 rounded-[9px] [&_svg]:size-3.25")}
                onClick={handleCopy}
              >
                <Copy aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("actions.copyAtomInfo")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <TooltipProvider delayDuration={500}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("actions.locateAtomInObjects")}
                className={cn(TOOL_ICON_BUTTON_CLASS, "size-6 rounded-[9px] [&_svg]:size-3.25")}
                onClick={() => onLocateInObjects?.(atom.id)}
              >
                <SquareMousePointer aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("actions.locateAtomInObjects")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        </> : null}
      </div>

      {sites.length === 1 ? <dl className="mt-2 grid grid-cols-[5.8rem_minmax(0,1fr)] gap-x-2 gap-y-1 tabular-nums">
        <dt className="whitespace-nowrap text-muted-foreground">{t("atomInspector.fractional")}</dt>
        <dd className="truncate text-right text-foreground">
          {formatAtomCoordinateForDisplay(atom.fractionalPosition)}
        </dd>
        <dt className="whitespace-nowrap text-muted-foreground">{t("atomInspector.cartesian")}</dt>
        <dd className="truncate text-right text-foreground">
          {formatAtomCoordinateForDisplay(atom.position)}
        </dd>
        <dt className="whitespace-nowrap text-muted-foreground">{t("atomInspector.cellOffset")}</dt>
        <dd className="truncate text-right text-foreground">
          {formatCellOffset(atom.imageOffset)}
        </dd>
      </dl> : null}
    </aside>
  );
}
