import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Color, InstancedMesh, Scene, type Camera, type WebGLRenderer } from "three";

import type { SceneSpec } from "../api/scene";
import { baseColorSchemeForStyle, elementColorOverridesForStyle, resolveAtomVisibleForStyle, type StyleState } from "../model";
import { EMPTY_SELECTION, useSceneSelection } from "../selection/SceneSelection";
import { PREVIEW_THEME_COLORS } from "../theme/previewTheme";
import type { ResolvedTheme } from "../theme/themePreference";
import { createAtomRenderItems, type AtomRenderItem } from "./AtomRenderItems";
import {
  ATOM_SELECTION_RIM_FRAGMENT_SHADER,
  ATOM_SELECTION_RIM_VERTEX_SHADER,
  populateAtomSelectionRim,
} from "./BatchedAtoms";
import type { VectorTuple } from "./viewMath";

interface EquivalentSiteOverlayProps {
  atomOpacity: number;
  editingRimVisible: boolean;
  groupPosition: VectorTuple;
  inspectedAtomId: string | null;
  scene: SceneSpec;
  showAtoms: boolean;
  siteIds: ReadonlySet<string>;
  style: StyleState;
  theme: ResolvedTheme;
}

/** Preview-only geometry: it never joins the structure, AO, export or path-tracing scenes. */
export function EquivalentSiteOverlay(props: EquivalentSiteOverlayProps) {
  const { camera, gl, invalidate } = useThree();
  const selection = useSceneSelection();
  const overlay = useMemo(() => new Scene(), []);
  const items = useMemo(() => equivalentSiteRenderItems({
    ...props, selectedAtomIds: selection.atoms,
  }), [props.atomOpacity, props.editingRimVisible, props.inspectedAtomId, props.scene.atoms, props.showAtoms,
    props.siteIds, props.style, selection.atoms]);
  const groups = useMemo(() => ({
    equivalent: items.filter(item => !item.editingSelected),
    selected: items.filter(item => item.editingSelected),
  }), [items]);

  useLayoutEffect(() => { invalidate(); }, [invalidate, items]);

  // Run after the realtime/annotation pass. An invalidate updates a completed or
  // paused preview without touching the separate path-tracer's sample schedule.
  useFrame(() => {
    if (items.length > 0) renderEquivalentSiteOverlay(gl, overlay, camera);
  }, 3);

  return items.length > 0 ? createPortal(
    <group position={props.groupPosition}>
      <EquivalentSiteRim items={groups.equivalent} color={props.theme === "dark" ? "#38bdf8" : "#0284c7"} />
      <EquivalentSiteRim items={groups.selected} color={PREVIEW_THEME_COLORS[props.theme].selectionHighlight} />
    </group>,
    overlay,
  ) : null;
}

function EquivalentSiteRim({ items, color }: { items: readonly AtomRenderItem[]; color: string }) {
  const mesh = useRef<InstancedMesh>(null);
  const invalidate = useThree(state => state.invalidate);
  const uniforms = useMemo(() => ({
    selectionColor: { value: new Color(color) },
    selectionOpacity: { value: 0.9 },
  }), [color]);

  useLayoutEffect(() => {
    if (mesh.current) populateAtomSelectionRim(mesh.current, items);
    invalidate();
  }, [invalidate, items]);

  return items.length > 0 ? (
    <instancedMesh ref={mesh} args={[undefined, undefined, items.length]} raycast={ignoreRaycast}>
      <sphereGeometry args={[1, 32, 24]} />
      <shaderMaterial
        depthTest={false}
        depthWrite={false}
        fragmentShader={ATOM_SELECTION_RIM_FRAGMENT_SHADER}
        toneMapped={false}
        transparent
        uniforms={uniforms}
        vertexShader={ATOM_SELECTION_RIM_VERTEX_SHADER}
      />
    </instancedMesh>
  ) : null;
}

export function equivalentSiteRenderItems({
  atomOpacity, editingRimVisible = true, inspectedAtomId, scene, selectedAtomIds = EMPTY_SELECTION.atoms, showAtoms, siteIds, style,
}: Pick<EquivalentSiteOverlayProps, "atomOpacity" | "inspectedAtomId" | "scene" | "showAtoms" | "siteIds" | "style"> & {
  editingRimVisible?: boolean;
  selectedAtomIds?: ReadonlySet<string>;
}) {
  if (!showAtoms || siteIds.size === 0) return [];
  const editingSelected = (id: string) => id === inspectedAtomId || selectedAtomIds.has(id);
  // Respect periodic-image filtering and every existing visibility/opacity/radius
  // override. Only defer to the original editing rim while it is actually drawn;
  // the traced preview hides that layer, so its selected members need a yellow rim here.
  return createAtomRenderItems({
    atomOpacity,
    atoms: scene.atoms.filter(atom => siteIds.has(atom.siteId)
      && (!editingRimVisible || !editingSelected(atom.id))
      && resolveAtomVisibleForStyle(atom, style.objectStyles)),
    colorScheme: baseColorSchemeForStyle(style),
    colorOverrides: elementColorOverridesForStyle(scene.atoms, style),
    style,
  }).map(item => ({ ...item, editingSelected: editingSelected(item.id) }));
}

export function renderEquivalentSiteOverlay(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
  const autoClear = renderer.autoClear;
  try {
    renderer.autoClear = false;
    renderer.render(scene, camera);
  } finally {
    renderer.autoClear = autoClear;
  }
}

function ignoreRaycast() {}
