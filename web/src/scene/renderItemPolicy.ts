import type { SceneSpec } from "../api/scene";
import type { ComponentOpacityState, StyleState } from "../model";

export interface OpacityRenderItem {
  opacity: number;
}

export function isRenderableItem(item: OpacityRenderItem): boolean {
  return Number.isFinite(item.opacity) && item.opacity > 0;
}

export function renderableItems<TItem extends OpacityRenderItem>(
  items: TItem[],
): TItem[] {
  return items.filter(isRenderableItem);
}

export function sceneHasTransparency(scene: SceneSpec, opacity: ComponentOpacityState, style: StyleState,
  showAtoms: boolean, showUnitCell: boolean): boolean {
  const translucent = (value: number | undefined) => value !== undefined && value > 0 && value < 100;
  if (showAtoms && translucent(opacity.atoms) || scene.bonds.length > 0 && translucent(opacity.bonds)
    || scene.polyhedra.length > 0 && translucent(opacity.polyhedra) || showUnitCell && translucent(opacity.unitCell)) return true;
  return [style.objectStyles.atomOverrides, style.objectStyles.elementOverrides,
    style.objectStyles.bondOverrides, style.objectStyles.bondFamilyOverrides]
    .some(overrides => Object.values(overrides).some(value => translucent(value.opacity)));
}
