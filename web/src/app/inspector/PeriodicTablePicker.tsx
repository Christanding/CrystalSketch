import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Grid2X2, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  PERIODIC_TABLE_ELEMENTS,
  filterPeriodicElements,
  findPeriodicElement,
  type ElementCategory,
  type PeriodicTableElement,
} from "../../data/periodic-table";

const CATEGORY_COLORS: Record<ElementCategory, string> = {
  alkali: "#d6a18f", alkalineEarth: "#d0bb83", transition: "#b4a4c8", postTransition: "#95bcb9",
  metalloid: "#a8bd8c", nonmetal: "#8ab5d0", halogen: "#b9b78b", noble: "#c3a0ba",
  lanthanide: "#b6afcf", actinide: "#c6abb0", unknown: "#b4b4b4",
};
const CATEGORIES = Object.keys(CATEGORY_COLORS) as ElementCategory[];
const TABLE_ROWS = [1, 2, 3, 4, 5, 6, 7, 9, 10];
const TABLE_SIZING = {
  "--periodic-cell-height": "clamp(24px, calc((96dvh - 120px) / 10), 56px)",
  "--periodic-gap": "clamp(2px, 0.3vw, 4px)",
} as CSSProperties;

export function PeriodicTablePicker({ value, onChange, disabled = false, label }: {
  value?: string;
  onChange: (element: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [colorCategories, setColorCategories] = useState(true);
  const [focused, setFocused] = useState(value ?? "H");
  const [inspected, setInspected] = useState<string | undefined>(value);
  const searchRef = useRef<HTMLInputElement>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const matches = useMemo(() => filterPeriodicElements(query), [query]);
  const current = findPeriodicElement(value);
  const chinese = i18n.language.startsWith("zh");
  const searching = query.trim() !== "";
  const details = searching ? matches.find(element => element.symbol === inspected) ?? matches[0] : findPeriodicElement(inspected) ?? current;
  const focusedSymbol = matches.some(element => element.symbol === focused) ? focused : matches[0]?.symbol;

  function changeOpen(next: boolean) {
    setOpen(next);
    if (next) { setQuery(""); setFocused(value ?? "H"); setInspected(value); }
  }

  function choose(element: PeriodicTableElement) {
    onChange(element.symbol);
    setOpen(false);
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, element: PeriodicTableElement) {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    let next: PeriodicTableElement | undefined;
    if (searching) {
      const index = matches.findIndex(candidate => candidate.symbol === element.symbol);
      next = matches[Math.max(0, Math.min(matches.length - 1, index + direction[0]! + direction[1]!))];
    } else if (direction[0]) {
      next = PERIODIC_TABLE_ELEMENTS.filter(candidate => candidate.row === element.row
        && (candidate.column - element.column) * direction[0]! > 0)
        .sort((a, b) => Math.abs(a.column - element.column) - Math.abs(b.column - element.column))[0];
    } else {
      next = PERIODIC_TABLE_ELEMENTS.filter(candidate => (candidate.row - element.row) * direction[1]! > 0)
        .sort((a, b) => Math.abs(a.row - element.row) - Math.abs(b.row - element.row)
          || Math.abs(a.column - element.column) - Math.abs(b.column - element.column))[0];
    }
    if (next) { setFocused(next.symbol); buttonRefs.current.get(next.symbol)?.focus(); }
  }

  function elementButton(element: PeriodicTableElement) {
    const name = chinese ? element.nameZh : element.nameEn;
    return <Button key={element.symbol} variant="outline" type="button"
      ref={node => { if (node) buttonRefs.current.set(element.symbol, node); else buttonRefs.current.delete(element.symbol); }}
      aria-label={`${element.atomicNumber} ${element.symbol} ${element.nameZh} ${element.nameEn}`}
      aria-pressed={element.symbol === value}
      title={`${element.atomicNumber} · ${element.symbol} · ${element.nameZh} · ${element.nameEn}`}
      tabIndex={element.symbol === focusedSymbol ? 0 : -1}
      className={cn("relative flex h-[var(--periodic-cell-height)] min-w-0 flex-col justify-end gap-0 overflow-hidden rounded-[4px] px-0.5 py-0.5 shadow-none hover:border-foreground/50 focus-visible:ring-2 focus-visible:ring-ring",
        "min-[760px]:[@media(min-height:620px)]:gap-0.5 min-[760px]:[@media(min-height:620px)]:px-1 min-[760px]:[@media(min-height:620px)]:py-1",
        element.symbol === value && "border-primary ring-1 ring-inset ring-primary")}
      style={colorCategories ? {
        backgroundColor: `color-mix(in srgb, ${CATEGORY_COLORS[element.category]} 52%, var(--background))`,
        borderColor: `color-mix(in srgb, ${CATEGORY_COLORS[element.category]} 76%, var(--border))`,
      } : undefined}
      onClick={() => choose(element)} onKeyDown={event => navigate(event, element)}
      onFocus={() => { setFocused(element.symbol); setInspected(element.symbol); }}
      onMouseEnter={() => setInspected(element.symbol)}>
      <span className="absolute top-0.5 left-0.5 font-mono text-[clamp(8px,0.8vw,10px)] leading-none text-muted-foreground min-[760px]:[@media(min-height:620px)]:left-1">{element.atomicNumber}</span>
      <span className="text-[clamp(13px,1.25vw,18px)] font-semibold leading-[1.05]">{element.symbol}</span>
      <span className="hidden w-full truncate text-[10px] leading-[1.1] min-[760px]:[@media(min-height:620px)]:block">{name}</span>
    </Button>;
  }

  function elementDetails(compact = false) {
    return details ? <div className={cn("flex min-w-0 items-center", compact ? "gap-3" : "h-full gap-[clamp(12px,2vw,28px)] px-[clamp(12px,2vw,28px)]")}>
      <div className="flex shrink-0 flex-col gap-1">
        <span className="font-mono text-[10px] leading-none text-muted-foreground">{details.atomicNumber}</span>
        <strong className={cn("font-medium tracking-tight", compact ? "text-2xl leading-none" : "text-[clamp(24px,3.5vw,48px)] leading-none")}>{details.symbol}</strong>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <p className={cn("truncate font-medium", compact ? "text-xs" : "text-[clamp(12px,1.25vw,18px)]")}>
          {details.nameZh} <span className="font-normal text-muted-foreground">/ {details.nameEn}</span>
        </p>
        <p className="truncate text-[clamp(10px,0.9vw,12px)] text-muted-foreground">{t(`periodicTable.categories.${details.category}`)}</p>
        {current ? <p className="truncate text-[clamp(10px,0.9vw,12px)] text-muted-foreground">{t("periodicTable.current")}: <span className="font-medium text-foreground">{current.symbol}</span></p> : null}
      </div>
    </div> : <p className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("periodicTable.choose")}</p>;
  }

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild>
      <Button variant="outline" size="sm" className="w-full justify-between" disabled={disabled} aria-label={label ?? t("periodicTable.choose")}>
        <span>{current ? `${current.symbol} · ${chinese ? current.nameZh : current.nameEn}` : t("periodicTable.choose")}</span>
        <Grid2X2 data-icon="inline-end" />
      </Button>
    </DialogTrigger>
    <DialogContent showCloseButton={false} aria-describedby={undefined} onKeyDown={event => event.stopPropagation()}
      onOpenAutoFocus={event => { event.preventDefault(); searchRef.current?.focus(); }}
      style={TABLE_SIZING}
      className="grid max-h-[96dvh] w-[97vw] max-w-[1280px] grid-rows-[auto_minmax(0,1fr)_auto] gap-2 overflow-hidden p-2 sm:max-w-[1280px] min-[760px]:[@media(min-height:620px)]:gap-3 min-[760px]:[@media(min-height:620px)]:p-4">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 max-[499px]:grid-cols-[minmax(0,1fr)_auto]">
        <DialogTitle className="whitespace-nowrap text-base">{t("periodicTable.title")}</DialogTitle>
        <InputGroup className="h-8 max-w-sm max-[499px]:col-span-2 max-[499px]:row-start-2">
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput ref={searchRef} aria-label={t("periodicTable.search")} placeholder={t("periodicTable.search")}
            value={query} onChange={event => setQuery(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && searching && matches.length === 1) { event.preventDefault(); choose(matches[0]!); } }} />
        </InputGroup>
        <label className="ml-auto flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground max-[499px]:col-span-2 max-[499px]:row-start-3">
          <Switch checked={colorCategories} onCheckedChange={setColorCategories} />{t("periodicTable.colorCategories")}
        </label>
        <DialogClose asChild><Button variant="ghost" size="icon" className="size-7 max-[499px]:col-start-2 max-[499px]:row-start-1" aria-label={t("periodicTable.close")}><X /></Button></DialogClose>
      </div>
      <div className="min-h-0 w-full overflow-hidden p-0.5 max-[499px]:overflow-auto">
        {searching ? <div className="flex flex-col gap-3">
          {details ? elementDetails(true) : null}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(3.5rem,1fr))] gap-1.5" aria-label={t("periodicTable.title")}>
            {matches.map(elementButton)}
            {!matches.length ? <p role="status" className="col-span-full py-8 text-center text-sm text-muted-foreground">{t("periodicTable.noResults")}</p> : null}
          </div>
        </div> : <div role="grid" aria-label={t("periodicTable.title")} className="grid min-w-0 grid-cols-[repeat(18,minmax(0,1fr))] gap-[var(--periodic-gap)] max-[499px]:min-w-[32rem]"
          style={{ gridTemplateRows: "12px repeat(7, var(--periodic-cell-height)) 4px repeat(2, var(--periodic-cell-height))" }}>
          <div role="row" className="contents">
            {Array.from({ length: 18 }, (_, index) => <span key={index} role="columnheader" style={{ gridColumn: index + 1, gridRow: 1 }}
              className="text-center font-mono text-[clamp(8px,0.8vw,10px)] leading-none text-muted-foreground">{index + 1}</span>)}
          </div>
          <div role="presentation" aria-hidden="true" style={{ gridColumn: "3 / 13", gridRow: "2 / 5" }} className="min-h-0 min-w-0 overflow-hidden">{elementDetails()}</div>
          {TABLE_ROWS.map(row => <div key={row} role="row" className="contents">
            {(row === 9 || row === 10) ? <span role="rowheader" style={{ gridColumn: "1 / 3", gridRow: row + 1 }}
              className="flex items-center justify-end pr-1 text-[clamp(8px,0.9vw,12px)] text-muted-foreground">{t(row === 9 ? "periodicTable.lanthanides" : "periodicTable.actinides")}</span> : null}
            {(row === 6 || row === 7) ? <span role="gridcell" style={{ gridColumn: 3, gridRow: row + 1 }}
              className="flex items-center justify-center rounded-[4px] border border-dashed text-[clamp(8px,0.8vw,11px)] text-muted-foreground">{row === 6 ? "57–71" : "89–103"}</span> : null}
            {PERIODIC_TABLE_ELEMENTS.filter(element => element.row === row).map(element => <div key={element.symbol} role="gridcell"
              style={{ gridColumn: element.column, gridRow: row + 1 }} className="[&>button]:w-full">{elementButton(element)}</div>)}
          </div>)}
        </div>}
      </div>
      {colorCategories ? <div className="flex flex-wrap gap-x-2 gap-y-1 text-[10px] leading-3 text-muted-foreground [@media(max-height:359px)]:hidden">
        {CATEGORIES.map(category => <span key={category} className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm" style={{ backgroundColor: CATEGORY_COLORS[category] }} />
          {t(`periodicTable.categories.${category}`)}
        </span>)}
      </div> : null}
    </DialogContent>
  </Dialog>;
}
