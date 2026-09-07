from __future__ import annotations

import math
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from itertools import product
from time import monotonic
from typing import Any

import numpy as np
import spglib
from pymatgen.core import Element

from crystalsketch.structures.preview_limits import MAX_STRUCTURE_ATOMS

DEFAULT_SYMPREC = 1e-5
MIN_SYMPREC = 1e-8
MAX_SYMPREC = 0.1
MAX_NATIVE_PAIR_BUDGET = 2048**2
MAX_MAPPED_SITES = 1_000_000
MAX_MATCH_CHECKS = 4_000_000
TIME_BUDGET_SECONDS = 10.0
FIXED_COMPONENT_TOLERANCE = 1e-9  # Angstrom along the unchanged direct basis vector.


class ModelSymmetryError(ValueError):
    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass
class _Model:
    source: dict[str, Any]
    cell: np.ndarray
    original_positions: np.ndarray
    positions: np.ndarray
    numbers: np.ndarray
    site_ids: list[str]
    movable: np.ndarray


@dataclass
class _Budget:
    deadline: float
    remaining: int = MAX_MATCH_CHECKS

    def check(self, amount: int = 0) -> None:
        self.remaining -= amount
        if self.remaining < 0 or monotonic() > self.deadline:
            raise ModelSymmetryError(
                "symmetry-budget-exceeded", "Symmetry matching exceeded its work budget.", 413
            )


def find_model_symmetry(structure: object, *, symprec: object = DEFAULT_SYMPREC) -> dict:
    tolerance = _tolerance(symprec)
    model = _read_model(structure)
    budget = _Budget(monotonic() + TIME_BUDGET_SECONDS)
    dataset = _dataset(model, model.positions, tolerance, budget)
    return _find_result(dataset, model.site_ids, tolerance)


def impose_model_symmetry(
    structure: object, *, symprec: object = DEFAULT_SYMPREC, expected_number: object
) -> dict:
    tolerance = _tolerance(symprec)
    if type(expected_number) is not int or not 1 <= expected_number <= 230:
        raise ModelSymmetryError(
            "symmetry-invalid-request", "expectedNumber must be an integer from 1 to 230.", 400
        )
    model = _read_model(structure)
    budget = _Budget(monotonic() + TIME_BUDGET_SECONDS)
    dataset = _dataset(model, model.positions, tolerance, budget)
    if int(dataset.number) != expected_number:
        raise ModelSymmetryError(
            "symmetry-changed", "The current structure no longer has the expected symmetry.", 409
        )

    rotations = np.asarray(dataset.rotations, dtype=np.int64)
    translations = np.asarray(dataset.translations, dtype=float)
    _check_lattice_metric(model.cell, rotations)
    if len(rotations) * len(model.site_ids) > MAX_MAPPED_SITES:
        raise ModelSymmetryError(
            "symmetry-budget-exceeded", "Too many site-operation mappings to impose safely.", 413
        )

    matcher = _PeriodicMatcher(model, tolerance, budget)
    corrections = np.zeros_like(model.positions)
    mappings: list[tuple[np.ndarray, np.ndarray]] = []
    for rotation, translation in zip(rotations, translations, strict=True):
        budget.check()
        permutation, images, residuals = matcher.match(rotation, translation)
        corrections[permutation] += residuals
        mappings.append((permutation, images))
    corrections /= len(rotations)
    tiny = np.linalg.norm(corrections @ model.cell, axis=1) < 1e-12
    corrections[tiny] = 0

    # T/F constrains direct-coordinate components, not Cartesian x/y/z.
    fixed_motion = np.abs(corrections) * np.linalg.norm(model.cell, axis=1)
    if np.any(fixed_motion[~model.movable] > FIXED_COMPONENT_TOLERANCE):
        raise ModelSymmetryError(
            "symmetry-constraint-conflict", "This symmetry projection would move a fixed component."
        )
    corrections[~model.movable] = 0
    proposed_positions = model.original_positions + corrections
    actual_corrections = proposed_positions - model.original_positions
    candidate = model.positions + actual_corrections
    displacements = np.linalg.norm(actual_corrections @ model.cell, axis=1)
    if not np.isfinite(proposed_positions).all() or np.any(displacements > tolerance + 1e-9):
        raise ModelSymmetryError(
            "symmetry-verification-failed", "The proposed displacement exceeds the find tolerance."
        )

    # Keep the original matching and integer image choices; do not rematch a bad projection.
    residual_limit = min(1e-7, tolerance * 0.1)
    for rotation, translation, (permutation, images) in zip(
        rotations, translations, mappings, strict=True
    ):
        budget.check()
        residual = candidate @ rotation.T + translation - candidate[permutation] - images
        if np.any(np.linalg.norm(residual @ model.cell, axis=1) > residual_limit):
            raise ModelSymmetryError(
                "symmetry-verification-failed",
                "The proposed coordinates do not satisfy the found operations.",
            )
    try:
        verified = _dataset(model, candidate, tolerance, budget)
    except ModelSymmetryError as exc:
        if exc.code == "symmetry-budget-exceeded":
            raise
        raise ModelSymmetryError(
            "symmetry-verification-failed", "The proposed structure could not be verified."
        ) from exc
    if (
        int(verified.number) != expected_number
        or len(verified.rotations) != len(rotations)
        or _partition(verified.equivalent_atoms) != _partition(dataset.equivalent_atoms)
    ):
        raise ModelSymmetryError(
            "symmetry-verification-failed",
            "The proposed structure changed the expected symmetry grouping.",
        )

    result_structure = deepcopy(model.source)
    for site, position in zip(result_structure["sites"], proposed_positions, strict=True):
        site["fractionalPosition"] = position.tolist()
    return {
        "structure": result_structure,
        "result": _find_result(verified, model.site_ids, tolerance),
        "maxDisplacement": float(np.max(displacements)),
        "rmsDisplacement": float(np.sqrt(np.mean(displacements**2))),
    }


def _tolerance(value: object) -> float:
    if (
        not _number(value)
        or not math.isfinite(float(value))
        or not MIN_SYMPREC <= float(value) <= MAX_SYMPREC
    ):
        raise ModelSymmetryError(
            "symmetry-invalid-tolerance", "symprec must be between 1e-8 and 0.1 Angstrom.", 400
        )
    return float(value)


def _number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _vector(value: object) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 3
        and all(_number(item) and math.isfinite(float(item)) for item in value)
    )


def _read_model(value: object) -> _Model:
    if not isinstance(value, dict):
        raise ModelSymmetryError("symmetry-invalid-request", "structure must be an object.", 400)
    cell_data = value.get("cell")
    vectors = cell_data.get("vectors") if isinstance(cell_data, dict) else None
    if not isinstance(vectors, list) or len(vectors) != 3 or not all(map(_vector, vectors)):
        raise ModelSymmetryError("symmetry-invalid-cell", "A finite 3 by 3 lattice is required.")
    cell = np.asarray(vectors, dtype=float)
    singular_values = np.linalg.svd(cell, compute_uv=False)
    determinant = float(np.linalg.det(cell))
    if (
        not math.isfinite(determinant)
        or determinant <= 1e-10
        or singular_values[-1] <= 1e-6
        or singular_values[0] / singular_values[-1] > 1e5
    ):
        raise ModelSymmetryError(
            "symmetry-invalid-cell",
            "The lattice is degenerate, left-handed, or too ill-conditioned.",
        )
    species = value.get("species")
    if not isinstance(species, list) or not species:
        raise ModelSymmetryError(
            "symmetry-invalid-request", "species must be a non-empty list.", 400
        )
    try:
        numbers_by_species = [Element(symbol).Z for symbol in species if isinstance(symbol, str)]
    except (ValueError, KeyError) as exc:
        raise ModelSymmetryError(
            "symmetry-invalid-request", "Every species must be a chemical element.", 400
        ) from exc
    if len(numbers_by_species) != len(species):
        raise ModelSymmetryError("symmetry-invalid-request", "Invalid chemical element.", 400)
    sites = value.get("sites")
    if not isinstance(sites, list) or not sites:
        raise ModelSymmetryError("symmetry-invalid-request", "sites must be a non-empty list.", 400)
    if len(sites) > MAX_STRUCTURE_ATOMS or len(sites) ** 2 > MAX_NATIVE_PAIR_BUDGET:
        raise ModelSymmetryError(
            "symmetry-budget-exceeded",
            "The structure exceeds the symmetry analysis site budget.",
            413,
        )
    site_ids: list[str] = []
    positions, numbers, movable = [], [], []
    for site in sites:
        if not isinstance(site, Mapping):
            raise ModelSymmetryError("symmetry-invalid-request", "Invalid site record.", 400)
        site_id, species_index = site.get("siteId"), site.get("speciesIndex")
        flags = site.get("selectiveDynamics", [True, True, True])
        if (
            not isinstance(site_id, str)
            or not site_id.strip()
            or type(species_index) is not int
            or not 0 <= species_index < len(species)
            or not _vector(site.get("fractionalPosition"))
            or not isinstance(flags, list)
            or len(flags) != 3
            or any(type(flag) is not bool for flag in flags)
        ):
            raise ModelSymmetryError(
                "symmetry-invalid-request",
                "Invalid site identity, coordinates, or constraints.",
                400,
            )
        site_ids.append(site_id)
        positions.append(site["fractionalPosition"])
        numbers.append(numbers_by_species[species_index])
        movable.append(flags)
    if len(set(site_ids)) != len(site_ids):
        raise ModelSymmetryError("symmetry-invalid-request", "Site IDs must be unique.", 400)
    coordinates = np.asarray(positions, dtype=float)
    return _Model(
        source=value,
        cell=cell,
        original_positions=coordinates,
        positions=np.mod(coordinates, 1),
        numbers=np.asarray(numbers, dtype=np.intc),
        site_ids=site_ids,
        movable=np.asarray(movable, dtype=bool),
    )


def _dataset(model: _Model, positions: np.ndarray, tolerance: float, budget: _Budget):
    budget.check()
    try:
        dataset = spglib.get_symmetry_dataset(
            (model.cell, np.mod(positions, 1), model.numbers), symprec=tolerance
        )
    except Exception as exc:
        raise ModelSymmetryError(
            "symmetry-not-found", "Symmetry analysis failed for this structure."
        ) from exc
    budget.check()
    if dataset is None:
        raise ModelSymmetryError("symmetry-not-found", "No reliable symmetry dataset was found.")
    return dataset


def _find_result(dataset, site_ids: list[str], tolerance: float) -> dict:
    groups: dict[int, list[str]] = {}
    for index, representative in enumerate(dataset.equivalent_atoms):
        groups.setdefault(int(representative), []).append(site_ids[index])
    return {
        "number": int(dataset.number),
        "symbol": str(dataset.international),
        "pointGroup": str(dataset.pointgroup),
        "operationCount": len(dataset.rotations),
        "equivalentSites": list(groups.values()),
        "tolerance": tolerance,
    }


def _partition(equivalent_atoms) -> set[frozenset[int]]:
    groups: dict[int, set[int]] = {}
    for index, representative in enumerate(equivalent_atoms):
        groups.setdefault(int(representative), set()).add(index)
    return {frozenset(group) for group in groups.values()}


def _check_lattice_metric(cell: np.ndarray, rotations: np.ndarray) -> None:
    metric = cell @ cell.T
    transformed = rotations.transpose(0, 2, 1) @ metric @ rotations
    if not np.allclose(transformed, metric, rtol=1e-8, atol=1e-10):
        raise ModelSymmetryError(
            "symmetry-lattice-change-required",
            "The found symmetry requires lattice idealization; "
            "this operation keeps the cell fixed.",
        )


class _PeriodicMatcher:
    def __init__(self, model: _Model, tolerance: float, budget: _Budget) -> None:
        self.model, self.tolerance, self.budget = model, tolerance, budget
        self.reach = tolerance * np.linalg.norm(np.linalg.inv(model.cell), axis=0)
        self.bins = tuple(
            max(1, min(1_000_000, math.floor(1 / max(value, 1e-12)))) for value in self.reach
        )
        self.grid: dict[tuple[int, int, int, int], list[int]] = {}
        for index, (number, point) in enumerate(zip(model.numbers, model.positions, strict=True)):
            self.grid.setdefault((int(number), *self._bucket(point)), []).append(index)

    def _bucket(self, point: np.ndarray) -> tuple[int, int, int]:
        return tuple(
            int(math.floor(float(value % 1) * count)) % count
            for value, count in zip(point, self.bins, strict=True)
        )

    def match(self, rotation: np.ndarray, translation: np.ndarray):
        size = len(self.model.site_ids)
        permutation = np.empty(size, dtype=np.int64)
        images = np.empty((size, 3), dtype=np.int64)
        residuals = np.empty((size, 3), dtype=float)
        used: set[int] = set()
        transformed = self.model.positions @ rotation.T + translation
        for index, point in enumerate(transformed):
            self.budget.check()
            bucket = self._bucket(point)
            neighbors = [
                sorted({(value + shift) % count for shift in (-1, 0, 1)})
                for value, count in zip(bucket, self.bins, strict=True)
            ]
            matches = []
            for neighbor in product(*neighbors):
                for target in self.grid.get((int(self.model.numbers[index]), *neighbor), []):
                    self.budget.check(1)
                    delta = point - self.model.positions[target]
                    lower = np.ceil(delta - self.reach - 1e-12).astype(np.int64)
                    upper = np.floor(delta + self.reach + 1e-12).astype(np.int64)
                    choices = [
                        range(int(low), int(high) + 1)
                        for low, high in zip(lower, upper, strict=True)
                    ]
                    count = math.prod(map(len, choices))
                    self.budget.check(count)
                    if count > 64:
                        raise ModelSymmetryError(
                            "symmetry-budget-exceeded", "Periodic image search is too broad.", 413
                        )
                    for image in product(*choices):
                        residual = delta - image
                        if np.linalg.norm(residual @ self.model.cell) <= self.tolerance + 1e-10:
                            matches.append((target, image, residual))
                            if len(matches) > 1:
                                break
                    if len(matches) > 1:
                        break
                if len(matches) > 1:
                    break
            if len(matches) != 1 or matches[0][0] in used:
                raise ModelSymmetryError(
                    "symmetry-ambiguous-mapping",
                    "Found operations do not give a unique one-to-one same-element site mapping.",
                )
            target, image, residual = matches[0]
            permutation[index], images[index], residuals[index] = target, image, residual
            used.add(target)
        return permutation, images, residuals
