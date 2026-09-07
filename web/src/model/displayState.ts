import type {
  AtomSpec,
  BondSpec,
  PolyhedronSpec,
  SceneSpec,
  VisibilityDependency,
} from "../api/scene";
import {
  visibleSceneForObjectStyles,
  type ObjectStyleState,
} from "./objectStyles";
import {
  createDefaultBondVisibilityOverrides,
  isBondVisible,
  type BondVisibilityOverrides,
} from "./bondObjects";

export interface ComponentVisibilityState {
  hideUnbondedBoundary?: boolean;
  atoms: boolean;
  unitCell: boolean;
  bonds: boolean;
  polyhedra: boolean;
  boundaryAtoms: boolean;
  oneHopBondedAtoms: boolean;
}

export const DEFAULT_COMPONENT_VISIBILITY: ComponentVisibilityState = {
  atoms: true,
  unitCell: true,
  bonds: true,
  polyhedra: false,
  boundaryAtoms: true,
  oneHopBondedAtoms: false,
};

export interface ComponentOpacityState {
  atoms: number;
  unitCell: number;
  bonds: number;
  polyhedra: number;
}

export const DEFAULT_COMPONENT_OPACITY: ComponentOpacityState = {
  atoms: 100,
  unitCell: 100,
  bonds: 100,
  polyhedra: 40,
};

export const COMPONENT_OPACITY_MAX: ComponentOpacityState = {
  atoms: 100,
  unitCell: 100,
  bonds: 100,
  polyhedra: 100,
};

export function createDefaultComponentVisibility(
  scene: SceneSpec | null = null,
): ComponentVisibilityState {
  if (scene?.connectivity === "deferred") {
    return {
      ...DEFAULT_COMPONENT_VISIBILITY,
      bonds: false,
      polyhedra: false,
      oneHopBondedAtoms: false,
    };
  }
  return { ...DEFAULT_COMPONENT_VISIBILITY };
}

export function createDefaultComponentOpacity(): ComponentOpacityState {
  return { ...DEFAULT_COMPONENT_OPACITY };
}

export function componentOpacityEquals(
  firstOpacity: ComponentOpacityState,
  secondOpacity: ComponentOpacityState,
): boolean {
  return (
    firstOpacity.atoms === secondOpacity.atoms &&
    firstOpacity.unitCell === secondOpacity.unitCell &&
    firstOpacity.bonds === secondOpacity.bonds &&
    firstOpacity.polyhedra === secondOpacity.polyhedra
  );
}

export function countPeriodicImageAtoms(scene: SceneSpec | null): number {
  if (!scene) {
    return 0;
  }

  return scene.atoms.filter((atom) => atom.isPeriodicImage).length;
}

export function hasPeriodicImageAtoms(scene: SceneSpec | null): boolean {
  return countPeriodicImageAtoms(scene) > 0;
}

export function hasPolyhedra(scene: SceneSpec | null): boolean {
  return (scene?.polyhedra.length ?? 0) > 0;
}

export function visibleSceneForComponents(
  scene: SceneSpec | null,
  visibility: ComponentVisibilityState,
  objectStyles?: ObjectStyleState,
  bondVisibility: BondVisibilityOverrides = createDefaultBondVisibilityOverrides(),
): SceneSpec | null {
  if (!scene) {
    return scene;
  }

  const atomIndexMap = new Map<number, number>();
  const connectedBoundaryAtoms = new Set<number>();
  if (visibility.hideUnbondedBoundary) {
    scene.bonds.forEach(bond => {
      const start = scene.atoms[bond.startAtomIndex];
      const end = scene.atoms[bond.endAtomIndex];
      if (start?.isPeriodicImage && end && !end.isPeriodicImage) connectedBoundaryAtoms.add(bond.startAtomIndex);
      if (end?.isPeriodicImage && start && !start.isPeriodicImage) connectedBoundaryAtoms.add(bond.endAtomIndex);
    });
  }
  const atoms: AtomSpec[] = [];
  scene.atoms.forEach((atom, atomIndex) => {
    if (isAtomAvailable(atom, visibility) && (!visibility.hideUnbondedBoundary
      || !atom.imageReasons.includes("boundary") || connectedBoundaryAtoms.has(atomIndex))) {
      atomIndexMap.set(atomIndex, atoms.length);
      atoms.push(atom);
    }
  });
  if (scene.sourceFormat === "vasp") {
    // Extra images belong to a visible original/boundary source, never to another extra image.
    const bondedToVisibleSource = new Set<number>();
    for (const bond of scene.bonds) {
      for (const [source, target] of [[bond.startAtomIndex, bond.endAtomIndex], [bond.endAtomIndex, bond.startAtomIndex]] as const) {
        const atom = scene.atoms[source];
        if (atom && atomIndexMap.has(source) && (!atom.isPeriodicImage || atom.imageReasons.includes("boundary"))) {
          bondedToVisibleSource.add(target);
        }
      }
    }
    const availableIndices = [...atomIndexMap.keys()];
    atoms.length = 0;
    atomIndexMap.clear();
    for (const index of availableIndices) {
      const atom = scene.atoms[index]!;
      if (atom.isPeriodicImage && !atom.imageReasons.includes("boundary") && !bondedToVisibleSource.has(index)) continue;
      atomIndexMap.set(index, atoms.length);
      atoms.push(atom);
    }
  }
  const bonds = visibility.bonds
    ? scene.bonds.flatMap((bond) =>
        isBondVisible(bond, bondVisibility)
          ? remapBond(bond, atomIndexMap)
          : [],
      )
    : [];
  const polyhedra = visibility.polyhedra
    ? scene.polyhedra.flatMap((polyhedron) => remapPolyhedron(polyhedron, atomIndexMap))
    : [];

  const visibleScene = {
    ...scene,
    atoms,
    bonds,
    polyhedra,
  };

  if (!objectStyles) {
    return visibleScene;
  }

  return visibleSceneForObjectStyles(visibleScene, objectStyles);
}

function isAtomAvailable(atom: AtomSpec, visibility: ComponentVisibilityState): boolean {
  if (!atom.isPeriodicImage) {
    return true;
  }

  return dependencyGroupsAllow(atom.visibilityDependencyGroups, visibility);
}

function remapBond(
  bond: BondSpec,
  atomIndexMap: Map<number, number>,
): BondSpec[] {
  const startAtomIndex = atomIndexMap.get(bond.startAtomIndex);
  const endAtomIndex = atomIndexMap.get(bond.endAtomIndex);
  if (startAtomIndex === undefined || endAtomIndex === undefined) {
    return [];
  }

  return [{ ...bond, startAtomIndex, endAtomIndex }];
}

function remapPolyhedron(
  polyhedron: PolyhedronSpec,
  atomIndexMap: Map<number, number>,
): PolyhedronSpec[] {
  const hullAtomIndices: number[] = [];
  for (const atomIndex of polyhedron.hullAtomIndices) {
    const visibleAtomIndex = atomIndexMap.get(atomIndex);
    if (visibleAtomIndex === undefined) {
      return [];
    }
    hullAtomIndices.push(visibleAtomIndex);
  }

  const centerAtomIndex = atomIndexMap.get(polyhedron.centerAtomIndex);
  if (centerAtomIndex === undefined) {
    return [];
  }

  return [{ ...polyhedron, centerAtomIndex, hullAtomIndices }];
}

function dependencyGroupsAllow(
  dependencyGroups: VisibilityDependency[][],
  visibility: ComponentVisibilityState,
): boolean {
  if (dependencyGroups.length === 0) {
    return true;
  }

  return dependencyGroups.some((dependencyGroup) =>
    dependencyGroup.every((dependency) => dependencyEnabled(dependency, visibility)),
  );
}

function dependencyEnabled(
  dependency: VisibilityDependency,
  visibility: ComponentVisibilityState,
): boolean {
  if (dependency === "boundaryAtoms") {
    return visibility.boundaryAtoms;
  }

  return visibility.oneHopBondedAtoms;
}
