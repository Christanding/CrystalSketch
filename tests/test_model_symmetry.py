from copy import deepcopy
from itertools import product
from time import monotonic

import numpy as np
import pytest
from httpx import ASGITransport, AsyncClient

import crystalsketch.structures.model_symmetry as symmetry
from crystalsketch.server.app import create_app
from crystalsketch.structures.model_symmetry import (
    ModelSymmetryError,
    find_model_symmetry,
    impose_model_symmetry,
)


def fcc_model() -> dict:
    return model(
        [[3.5, 0, 0], [0, 3.5, 0], [0, 0, 3.5]],
        [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]],
    )


def model(cell: list, positions: list, species: list[str] | None = None) -> dict:
    return {
        "cell": {"vectors": cell},
        "species": species or ["Ni"],
        "sites": [
            {"siteId": f"site-{index}", "speciesIndex": 0, "fractionalPosition": point}
            for index, point in enumerate(positions)
        ],
    }


def test_find_reports_current_cell_site_groups_without_mutation() -> None:
    structure = fcc_model()
    original = deepcopy(structure)
    found = find_model_symmetry(structure, symprec=1e-5)
    assert found == {
        "number": 225,
        "symbol": "Fm-3m",
        "pointGroup": "m-3m",
        "operationCount": 192,
        "equivalentSites": [["site-0", "site-1", "site-2", "site-3"]],
        "tolerance": 1e-5,
    }
    assert structure == original


def test_perfect_supercell_stays_a_supercell_with_unchanged_ids_and_metadata() -> None:
    structure = model(
        [[7, 0, 0], [0, 7, 0], [0, 0, 7]], list(map(list, product((0, 0.5), repeat=3)))
    )
    structure["provenance"] = {"source": "synthetic-test"}
    structure["sites"][0]["selectiveDynamics"] = [False, False, False]
    original = deepcopy(structure)
    found = find_model_symmetry(structure)
    proposal = impose_model_symmetry(structure, expected_number=found["number"])
    assert len(proposal["structure"]["sites"]) == 8
    assert proposal["structure"] == original
    assert proposal["structure"] is not structure
    assert proposal["maxDisplacement"] == proposal["rmsDisplacement"] == 0
    assert structure == original


def test_small_coordinate_perturbation_projects_to_exact_symmetry_in_angstrom() -> None:
    structure = fcc_model()
    structure["sites"][0]["fractionalPosition"] = [0.0002, -0.0001, 0.0003]
    original = deepcopy(structure)
    proposal = impose_model_symmetry(structure, symprec=0.01, expected_number=225)
    output = proposal["structure"]
    assert output["cell"] == original["cell"]
    assert output["species"] == original["species"]
    assert [site["siteId"] for site in output["sites"]] == [
        site["siteId"] for site in original["sites"]
    ]
    assert 0 < proposal["maxDisplacement"] < 0.01
    positions = np.array([site["fractionalPosition"] for site in output["sites"]])
    initial = np.array([site["fractionalPosition"] for site in original["sites"]])
    lengths = np.linalg.norm((positions - initial) @ np.array(output["cell"]["vectors"]), axis=1)
    assert proposal["maxDisplacement"] == pytest.approx(max(lengths))
    assert proposal["rmsDisplacement"] == pytest.approx(np.sqrt(np.mean(lengths**2)))
    assert find_model_symmetry(output, symprec=1e-8)["number"] == 225
    assert structure == original


def test_hexagonal_metric_and_periodic_boundary_coordinates_are_preserved() -> None:
    structure = model(
        [[2.46, 0, 0], [-1.23, 2.46 * np.sqrt(3) / 2, 0], [0, 0, 6.8]],
        [[0, 0, 0.25], [0, 0, 0.75], [1 / 3, 2 / 3, 0.25], [2 / 3, 1 / 3, 0.75]],
        ["C"],
    )
    structure["sites"][0]["fractionalPosition"] = [1.0001, -0.0002, 0.2501]
    proposal = impose_model_symmetry(structure, symprec=0.01, expected_number=194)
    assert proposal["structure"]["cell"] == structure["cell"]
    assert proposal["structure"]["sites"][0]["fractionalPosition"][0] > 0.9
    assert len(proposal["structure"]["sites"]) == 4
    assert find_model_symmetry(proposal["structure"], symprec=1e-8)["number"] == 194


def test_cartesian_matching_in_skew_cell_does_not_use_componentwise_fractional_rounding() -> None:
    structure = model([[1, 0, 0], [10, 0.1, 0], [0, 0, 2]], [[0, 0, 0]])
    prepared = symmetry._read_model(structure)
    matcher = symmetry._PeriodicMatcher(prepared, 0.05, symmetry._Budget(monotonic() + 2))
    permutation, images, residuals = matcher.match(np.eye(3), np.array([4.99, -0.499, 0]))
    assert permutation.tolist() == [0]
    assert images.tolist() == [[0, 0, 0]]
    assert np.linalg.norm(residuals[0] @ prepared.cell) == pytest.approx(0.0499)
    naive = residuals[0] - np.rint(residuals[0])
    assert np.linalg.norm(naive @ prepared.cell) > 1


@pytest.mark.parametrize("defect", ["vacancy", "substitution"])
def test_vacancy_or_dopant_is_not_replaced_by_the_pristine_cell(defect: str) -> None:
    structure = fcc_model()
    if defect == "vacancy":
        structure["sites"].pop(0)
    else:
        structure["species"].append("Cu")
        structure["sites"][0]["speciesIndex"] = 1
    original = deepcopy(structure)
    found = find_model_symmetry(structure, symprec=0.001)
    assert found["number"] != 225
    proposal = impose_model_symmetry(structure, symprec=0.001, expected_number=found["number"])
    assert proposal["structure"] == original
    with pytest.raises(ModelSymmetryError) as error:
        impose_model_symmetry(structure, symprec=0.001, expected_number=225)
    assert error.value.code == "symmetry-changed"
    assert structure == original


def test_fixed_components_are_kept_exactly_and_conflicting_projection_is_rejected() -> None:
    structure = fcc_model()
    for site in structure["sites"]:
        site["selectiveDynamics"] = [True, False, False]
    structure["sites"][0]["fractionalPosition"][0] = 0.0002
    proposal = impose_model_symmetry(structure, symprec=0.01, expected_number=225)
    for before, after in zip(structure["sites"], proposal["structure"]["sites"], strict=True):
        assert after["selectiveDynamics"] == [True, False, False]
        assert after["fractionalPosition"][1:] == before["fractionalPosition"][1:]
    structure["sites"][0]["fractionalPosition"][1] = 0.0002
    original = deepcopy(structure)
    with pytest.raises(ModelSymmetryError) as error:
        impose_model_symmetry(structure, symprec=0.01, expected_number=225)
    assert error.value.code == "symmetry-constraint-conflict"
    assert structure == original


def test_cell_idealization_is_not_disguised_as_coordinate_projection() -> None:
    structure = fcc_model()
    structure["cell"]["vectors"][0][0] += 0.0002
    assert find_model_symmetry(structure, symprec=0.01)["number"] == 225
    with pytest.raises(ModelSymmetryError) as error:
        impose_model_symmetry(structure, symprec=0.01, expected_number=225)
    assert error.value.code == "symmetry-lattice-change-required"


@pytest.mark.parametrize(
    "cell",
    [
        [[1, 0, 0], [0, 0, 0], [0, 0, 1]],
        [[-1, 0, 0], [0, 1, 0], [0, 0, 1]],
        [[1, 0, 0], [0, float("inf"), 0], [0, 0, 1]],
        [[1, 0, 0], [0, 1, 0]],
    ],
)
def test_bad_cells_have_a_stable_error(cell: list) -> None:
    with pytest.raises(ModelSymmetryError) as error:
        find_model_symmetry(model(cell, [[0, 0, 0]]))
    assert error.value.code == "symmetry-invalid-cell"


@pytest.mark.parametrize("tolerance", [0, -0.1, True, float("nan"), 0.2, "0.01"])
def test_invalid_tolerance_has_a_stable_error(tolerance: object) -> None:
    with pytest.raises(ModelSymmetryError) as error:
        find_model_symmetry(fcc_model(), symprec=tolerance)
    assert error.value.code == "symmetry-invalid-tolerance"


@pytest.mark.parametrize(
    "change",
    [
        lambda data: data["sites"][1].update(siteId="site-0"),
        lambda data: data["sites"][0].update(speciesIndex=True),
        lambda data: data["sites"][0].update(fractionalPosition=[0, 0, float("nan")]),
        lambda data: data["sites"][0].update(selectiveDynamics=[1, 0, 1]),
        lambda data: data.update(species=["NotAnElement"]),
    ],
)
def test_invalid_sites_and_species_are_rejected(change) -> None:
    structure = fcc_model()
    change(structure)
    with pytest.raises(ModelSymmetryError) as error:
        find_model_symmetry(structure)
    assert error.value.code == "symmetry-invalid-request"


def test_ambiguous_same_element_matching_is_rejected() -> None:
    structure = model([[5, 0, 0], [0, 5, 0], [0, 0, 5]], [[0, 0, 0], [0.0001, 0, 0]])
    matcher = symmetry._PeriodicMatcher(
        symmetry._read_model(structure), 0.01, symmetry._Budget(monotonic() + 2)
    )
    with pytest.raises(ModelSymmetryError) as error:
        matcher.match(np.eye(3), np.zeros(3))
    assert error.value.code == "symmetry-ambiguous-mapping"


def test_native_and_mapping_budgets_fail_explicitly(monkeypatch) -> None:
    monkeypatch.setattr(symmetry, "MAX_NATIVE_PAIR_BUDGET", 1)
    with pytest.raises(ModelSymmetryError) as error:
        find_model_symmetry(fcc_model())
    assert error.value.code == "symmetry-budget-exceeded"
    monkeypatch.setattr(symmetry, "MAX_NATIVE_PAIR_BUDGET", 2048**2)
    monkeypatch.setattr(symmetry, "MAX_MAPPED_SITES", 1)
    with pytest.raises(ModelSymmetryError) as error:
        impose_model_symmetry(fcc_model(), expected_number=225)
    assert error.value.code == "symmetry-budget-exceeded"
    monkeypatch.setattr(symmetry, "TIME_BUDGET_SECONDS", -1)
    with pytest.raises(ModelSymmetryError) as error:
        find_model_symmetry(fcc_model())
    assert error.value.code == "symmetry-budget-exceeded"


@pytest.mark.anyio
async def test_json_endpoints_return_candidates_and_stable_errors() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://test"
    ) as client:
        found = await client.post(
            "/api/model-symmetry/find", json={"structure": fcc_model(), "symprec": 0.01}
        )
        assert found.status_code == 200
        assert found.json()["number"] == 225
        imposed = await client.post(
            "/api/model-symmetry/impose",
            json={
                "structure": fcc_model(),
                "symprec": 0.01,
                "expectedNumber": 225,
            },
        )
        assert imposed.status_code == 200
        assert imposed.json()["structure"] == fcc_model()
        stale = await client.post(
            "/api/model-symmetry/impose",
            json={
                "structure": fcc_model(),
                "expectedNumber": 1,
            },
        )
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "symmetry-changed"
        bad = await client.post("/api/model-symmetry/find", content=b'{"symprec":NaN}')
        assert bad.status_code == 400
        assert bad.json()["detail"]["code"] == "symmetry-invalid-request"


@pytest.mark.anyio
async def test_json_endpoints_share_the_upload_size_limit(monkeypatch) -> None:
    import crystalsketch.server.routes as routes

    monkeypatch.setattr(routes, "MAX_STRUCTURE_UPLOAD_BYTES", 32)
    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://test"
    ) as client:
        response = await client.post("/api/model-symmetry/find", json={"structure": fcc_model()})
    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "upload-too-large"
