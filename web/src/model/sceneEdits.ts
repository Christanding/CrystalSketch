import type { SceneSpec } from "../api/scene";
import type { SceneSelection } from "../selection/SceneSelection";

export function applySceneDeletions(scene: SceneSpec | null, deleted: SceneSelection): SceneSpec | null {
  if (!scene || deleted.atoms.size + deleted.bonds.size === 0) return scene;
  const removedCoordination = new Set(scene.bonds.filter(bond => deleted.bonds.has(bond.id))
    .flatMap(bond => [`${bond.startAtomIndex}|${bond.endAtomIndex}`, `${bond.endAtomIndex}|${bond.startAtomIndex}`]));
  const indices = new Map<number, number>();
  const atoms = scene.atoms.filter((atom, index) => {
    if (deleted.atoms.has(atom.id)) return false;
    indices.set(index, indices.size);
    return true;
  });
  const bonds = scene.bonds.filter(bond => !deleted.bonds.has(bond.id)
    && indices.has(bond.startAtomIndex) && indices.has(bond.endAtomIndex))
    .map(bond => ({ ...bond, startAtomIndex: indices.get(bond.startAtomIndex)!, endAtomIndex: indices.get(bond.endAtomIndex)! }));
  const polyhedra = scene.polyhedra.filter(polyhedron => indices.has(polyhedron.centerAtomIndex)
    && polyhedron.hullAtomIndices.every(index => indices.has(index)
      && !removedCoordination.has(`${polyhedron.centerAtomIndex}|${index}`)))
    .map(polyhedron => ({ ...polyhedron, centerAtomIndex: indices.get(polyhedron.centerAtomIndex)!,
      hullAtomIndices: polyhedron.hullAtomIndices.map(index => indices.get(index)!) }));
  return { ...scene, atoms, bonds, polyhedra,
    summary: { ...scene.summary, atomCount: atoms.filter(atom => !atom.isPeriodicImage).length } };
}
