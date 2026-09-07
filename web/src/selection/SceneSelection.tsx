import { createContext, useContext, type ReactNode } from "react";

export type SceneSelection = { atoms: ReadonlySet<string>; bonds: ReadonlySet<string> };
export const EMPTY_SELECTION: SceneSelection = { atoms: new Set(), bonds: new Set() };
const Context = createContext<SceneSelection>(EMPTY_SELECTION);

export function SceneSelectionProvider({ value, children }: { value: SceneSelection; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSceneSelection() { return useContext(Context); }

export function selectSceneObject(selection: SceneSelection, kind: "atom" | "bond", id: string, additive: boolean): SceneSelection {
  const next = additive ? { atoms: new Set(selection.atoms), bonds: new Set(selection.bonds) }
    : { atoms: new Set<string>(), bonds: new Set<string>() };
  const target = kind === "atom" ? next.atoms : next.bonds;
  if (additive && target.has(id)) target.delete(id);
  else target.add(id);
  return next;
}
