import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { captureSceneVisibility, restoreObjectStyleVisibility, type SceneVisibilitySnapshot } from "./useSceneEdits";

import type { SceneSpec } from "../../api/scene";
import {
  DEFAULT_SHOW_CRYSTAL_AXIS_LABELS,
  DEFAULT_STRUCTURE_LINE_WIDTH,
  DEFAULT_UNIT_CELL_LINE_STYLE,
  baseColorSchemeForStyle,
  canonicalAtomsForObjectStyles,
  clearAtomOverridePropertyForElement,
  clearObjectStyleProperty,
  createCustomColormapFromStyle,
  createDefaultBondVisibilityOverrides,
  createDefaultComponentOpacity,
  createDefaultComponentVisibility,
  createDefaultStyle,
  defaultPreviewMeshQualityForScene,
  elementColorOverridesForStyle,
  setAtomOverrideProperty,
  setBondFamilyVisible,
  setBondRelationVisible,
  visibleSceneForComponents,
  type BondVisibilityOverrides,
  type ComponentOpacityState,
  type ComponentVisibilityState,
  type MeshQuality,
  type StructureLineWidthState,
  type StyleState,
  type UnitCellLineStyle,
} from "../../model";
import { deriveElementLegendEntries } from "../elementLegend";
import type { WorkspaceAppearance } from "../workspaceStorage";
import type {
  ConnectivityIntent,
  ConnectivityStatus,
} from "./useStructurePreview";

interface FigureAppearanceControllerOptions {
  recordVisibilityChange?: (before: SceneVisibilitySnapshot, after: SceneVisibilitySnapshot) => void;
  initialState?: WorkspaceAppearance;
  closeActiveColorPicker: () => void;
  connectivityStatus: ConnectivityStatus;
  requestConnectivity: (intent?: ConnectivityIntent) => Promise<boolean>;
  scene: SceneSpec | null;
}

export function useFigureAppearanceController({
  recordVisibilityChange,
  initialState,
  closeActiveColorPicker,
  connectivityStatus,
  requestConnectivity,
  scene,
}: FigureAppearanceControllerOptions) {
  const [componentVisibility, setComponentVisibility] = useState(
    () => initialState?.componentVisibility ?? createDefaultComponentVisibility(),
  );
  const [componentOpacity, setComponentOpacity] = useState(() => initialState?.componentOpacity ?? createDefaultComponentOpacity());
  const [style, setRawStyle] = useState(() => initialState?.style ?? createDefaultStyle());
  const [previewMeshQuality, setPreviewMeshQuality] = useState<MeshQuality>(
    () => initialState?.previewMeshQuality ?? defaultPreviewMeshQualityForScene(null),
  );
  const [unitCellLineStyle, setUnitCellLineStyle] = useState<UnitCellLineStyle>(
    initialState?.unitCellLineStyle ?? DEFAULT_UNIT_CELL_LINE_STYLE,
  );
  const [structureLineWidth, setStructureLineWidth] =
    useState<StructureLineWidthState>(initialState?.structureLineWidth ?? DEFAULT_STRUCTURE_LINE_WIDTH);
  const [showCrystalAxisLabels, setShowCrystalAxisLabels] = useState(
    initialState?.showCrystalAxisLabels ?? DEFAULT_SHOW_CRYSTAL_AXIS_LABELS,
  );
  const [bondVisibilityOverrides, setBondVisibilityOverrides] =
    useState<BondVisibilityOverrides>(() => initialState?.bondVisibilityOverrides ?? createDefaultBondVisibilityOverrides());
  const currentAppearance = useRef({ style, componentVisibility, bondVisibilityOverrides });
  currentAppearance.current = { style, componentVisibility, bondVisibilityOverrides };
  const commitVisibility = useCallback((next: typeof currentAppearance.current, record = true) => {
    const previous = currentAppearance.current;
    if (record) recordVisibilityChange?.(
      captureSceneVisibility(previous.style.objectStyles, previous.componentVisibility, previous.bondVisibilityOverrides),
      captureSceneVisibility(next.style.objectStyles, next.componentVisibility, next.bondVisibilityOverrides),
    );
    currentAppearance.current = next;
    setRawStyle(next.style);
    setComponentVisibility(next.componentVisibility);
    setBondVisibilityOverrides(next.bondVisibilityOverrides);
  }, [recordVisibilityChange]);
  const setStyle = useCallback<Dispatch<SetStateAction<StyleState>>>(value => {
    const previous = currentAppearance.current;
    const nextStyle = typeof value === "function" ? value(previous.style) : value;
    commitVisibility({ ...previous, style: nextStyle });
  }, [commitVisibility]);
  const restoreVisibilityState = useCallback((snapshot: SceneVisibilitySnapshot) => {
    const previous = currentAppearance.current;
    commitVisibility({
      style: { ...previous.style, objectStyles: restoreObjectStyleVisibility(previous.style.objectStyles, snapshot) },
      componentVisibility: snapshot.componentVisibility,
      bondVisibilityOverrides: { hiddenFamilies: new Set(snapshot.hiddenBondFamilies), hiddenBondRelations: new Set(snapshot.hiddenBondRelations) },
    }, false);
  }, [commitVisibility]);
  const colorSchemeSelectionRef = useRef({
    colorScheme: style.colorScheme,
    colorSchemeMode: style.colorSchemeMode,
  });

  // Symmetry/warning updates belong to the summary UI, not to GPU geometry.
  const geometryScene = useMemo(() => scene, [scene?.atoms, scene?.bonds,
    scene?.polyhedra, scene?.cell, scene?.bondFamilies, scene?.sourceFormat, scene?.connectivity]);
  const visibleScene = useMemo(
    () => visibleSceneForComponents(
      geometryScene,
      componentVisibility,
      style.objectStyles,
      bondVisibilityOverrides,
    ),
    [bondVisibilityOverrides, componentVisibility, geometryScene, style.objectStyles],
  );
  const objectStyleAtoms = useMemo(
    () => (scene ? canonicalAtomsForObjectStyles(scene.atoms) : []),
    [scene?.atoms],
  );
  const polyhedronElements = useMemo(() => {
    if (!scene) return [];
    return [...new Set(scene.polyhedra.flatMap(polyhedron => {
      const center = scene.atoms[polyhedron.centerAtomIndex];
      return center ? [center.element] : [];
    }))];
  }, [scene?.atoms, scene?.polyhedra]);
  const elementColorOverrides = useMemo(
    () => scene ? elementColorOverridesForStyle(scene.atoms, style) : undefined,
    [scene?.atoms, style],
  );
  const legendColorScheme = baseColorSchemeForStyle(style);
  const legendEntries = useMemo(
    () => deriveElementLegendEntries(geometryScene, legendColorScheme, elementColorOverrides),
    [elementColorOverrides, legendColorScheme, geometryScene],
  );

  useEffect(() => {
    const previousSelection = colorSchemeSelectionRef.current;
    const changedToPreset =
      style.colorSchemeMode === "preset" &&
      (previousSelection.colorSchemeMode !== "preset" ||
        previousSelection.colorScheme !== style.colorScheme);

    colorSchemeSelectionRef.current = {
      colorScheme: style.colorScheme,
      colorSchemeMode: style.colorSchemeMode,
    };
    if (changedToPreset) closeActiveColorPicker();
  }, [closeActiveColorPicker, style.colorScheme, style.colorSchemeMode]);

  const resetAppearance = useCallback((nextScene: SceneSpec | null) => {
    commitVisibility({ style: createDefaultStyle(), componentVisibility: createDefaultComponentVisibility(nextScene),
      bondVisibilityOverrides: createDefaultBondVisibilityOverrides() }, false);
    setComponentOpacity(createDefaultComponentOpacity());
    setPreviewMeshQuality(defaultPreviewMeshQualityForScene(nextScene));
    setUnitCellLineStyle(DEFAULT_UNIT_CELL_LINE_STYLE);
    setStructureLineWidth(DEFAULT_STRUCTURE_LINE_WIDTH);
    setShowCrystalAxisLabels(DEFAULT_SHOW_CRYSTAL_AXIS_LABELS);
  }, [commitVisibility]);

  const handleComponentVisibilityChange = useCallback(async (
    key: keyof ComponentVisibilityState,
    value: boolean,
  ) => {
    if (
      value &&
      (key === "bonds" || key === "polyhedra" || key === "oneHopBondedAtoms") &&
      connectivityStatus !== "ready"
    ) {
      const succeeded = await requestConnectivity(key);
      if (!succeeded) return;
    }

    const current = currentAppearance.current;
    commitVisibility({
      style: value && key === "atoms" ? { ...current.style, objectStyles: clearObjectStyleProperty(current.style.objectStyles, "visible") } : current.style,
      componentVisibility: { ...current.componentVisibility, [key]: value },
      bondVisibilityOverrides: value && key === "bonds" ? createDefaultBondVisibilityOverrides() : current.bondVisibilityOverrides,
    });
  }, [commitVisibility, connectivityStatus, requestConnectivity]);

  const handleComponentOpacityChange = useCallback((
    key: keyof ComponentOpacityState,
    value: number,
  ) => {
    setComponentOpacity((current) => ({ ...current, [key]: value }));
    if (key === "atoms") {
      setStyle((current) => ({
        ...current,
        objectStyles: clearObjectStyleProperty(current.objectStyles, "opacity"),
      }));
    }
  }, []);

  const handleComponentOpacityReset = useCallback(() => {
    setComponentOpacity(createDefaultComponentOpacity());
    setStyle((current) => ({
      ...current,
      objectStyles: clearObjectStyleProperty(current.objectStyles, "opacity"),
    }));
  }, []);

  const handleFogAffectsUnitCellChange = useCallback((fogAffectsUnitCell: boolean) => {
    setStyle((current) => ({ ...current, fogAffectsUnitCell }));
  }, []);

  const handleDistinguishSimilarColorsChange = useCallback((
    distinguishSimilarColors: boolean,
  ) => {
    setStyle((current) => ({ ...current, distinguishSimilarColors }));
  }, []);

  const handleLegendElementColorChange = useCallback((element: string, color: string) => {
    setStyle((current) => {
      const draft = scene
        ? createCustomColormapFromStyle(scene.atoms, current)
        : current.customColormap ?? createCustomColormapFromStyle([], current);
      const objectStyles = scene
        ? clearAtomOverridePropertyForElement(
            current.objectStyles,
            scene.atoms,
            element,
            "color",
          )
        : current.objectStyles;

      return {
        ...current,
        colorSchemeMode: "custom",
        colorScheme: draft.baseColorScheme,
        customColormap: {
          baseColorScheme: draft.baseColorScheme,
          elements: { ...draft.elements, [element]: color },
        },
        objectStyles,
      };
    });
  }, [scene]);

  const hideAtom = useCallback((atomId: string) => {
    setStyle((current) => ({
      ...current,
      objectStyles: setAtomOverrideProperty(
        current.objectStyles,
        atomId,
        "visible",
        false,
      ),
    }));
  }, []);

  const handleBondFamilyVisibilityChange = useCallback((
    familyKey: string,
    visible: boolean,
  ) => {
    const current = currentAppearance.current;
    commitVisibility({ ...current, bondVisibilityOverrides: setBondFamilyVisible(current.bondVisibilityOverrides, familyKey, visible) });
  }, [commitVisibility]);

  const setBondVisible = useCallback((
    bond: SceneSpec["bonds"][number],
    visible: boolean,
  ) => {
    const current = currentAppearance.current;
    commitVisibility({ ...current, bondVisibilityOverrides: setBondRelationVisible(current.bondVisibilityOverrides, bond, visible) });
  }, [commitVisibility]);

  return {
    restoreVisibilityState,
    geometryScene,
    bondVisibilityOverrides,
    componentOpacity,
    componentVisibility,
    elementColorOverrides,
    handleBondFamilyVisibilityChange,
    handleComponentOpacityChange,
    handleComponentOpacityReset,
    handleComponentVisibilityChange,
    handleDistinguishSimilarColorsChange,
    handleFogAffectsUnitCellChange,
    handleLegendElementColorChange,
    hideAtom,
    legendColorScheme,
    legendEntries,
    objectStyleAtoms,
    polyhedronElements,
    previewMeshQuality,
    resetAppearance,
    setBondVisible,
    setComponentOpacity,
    setPreviewMeshQuality,
    setShowCrystalAxisLabels,
    setStructureLineWidth,
    setStyle,
    setUnitCellLineStyle,
    showCrystalAxisLabels,
    structureLineWidth,
    style,
    unitCellLineStyle,
    visibleScene,
  };
}
