from __future__ import annotations

import json
import math
from urllib.parse import unquote

from fastapi import APIRouter, Header, HTTPException, Query, Request
from starlette.concurrency import run_in_threadpool

from crystalsketch.structures.preview_limits import (
    MAX_STRUCTURE_UPLOAD_BYTES,
    STRUCTURE_FILE_TOO_LARGE_MESSAGE,
)
from crystalsketch.structures.schema import (
    CustomBondRecalculationError,
    InvalidBondCutoffOverridesError,
    UnsupportedBondAlgorithmError,
    normalize_bond_algorithm,
    parse_bond_cutoff_overrides,
)

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/model-symmetry/find")
async def find_current_model_symmetry(request: Request) -> dict[str, object]:
    payload = await _uploaded_payload(request)
    return await run_in_threadpool(_model_symmetry_response, payload, False)


@router.post("/model-symmetry/impose")
async def impose_current_model_symmetry(request: Request) -> dict[str, object]:
    payload = await _uploaded_payload(request)
    return await run_in_threadpool(_model_symmetry_response, payload, True)


def _model_symmetry_response(payload: bytes, impose: bool) -> dict[str, object]:
    try:
        data = json.loads(
            payload, parse_float=_finite_json_float, parse_constant=_invalid_json_number
        )
        if not isinstance(data, dict):
            raise ValueError("Expected an object.")
    except (ValueError, UnicodeError) as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "symmetry-invalid-request",
                "message": "A valid finite JSON object is required.",
            },
        ) from exc

    from crystalsketch.structures.model_symmetry import (
        DEFAULT_SYMPREC,
        ModelSymmetryError,
        find_model_symmetry,
        impose_model_symmetry,
    )

    try:
        if impose:
            return impose_model_symmetry(
                data.get("structure"),
                symprec=data.get("symprec", DEFAULT_SYMPREC),
                expected_number=data.get("expectedNumber"),
            )
        return find_model_symmetry(
            data.get("structure"), symprec=data.get("symprec", DEFAULT_SYMPREC)
        )
    except ModelSymmetryError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail={"code": exc.code, "message": exc.message}
        ) from exc


def _invalid_json_number(value: str) -> float:
    raise ValueError(f"Non-finite JSON number: {value}")


def _finite_json_float(value: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        return _invalid_json_number(value)
    return result


@router.post("/structure-symmetry")
async def create_structure_symmetry(request: Request) -> dict[str, object]:
    payload = await _uploaded_payload(request)
    filename = _uploaded_filename(request)
    return await run_in_threadpool(_read_symmetry, payload, filename)


def _read_symmetry(payload: bytes, filename: str) -> dict[str, object]:
    from crystalsketch.structures.readers import StructureReadError, read_structure_bytes
    from crystalsketch.structures.summary import build_symmetry_summary

    try:
        return dict(build_symmetry_summary(read_structure_bytes(payload, filename)))
    except StructureReadError as exc:
        raise HTTPException(status_code=400, detail={"message": str(exc)}) from exc


@router.post("/structure-data")
async def create_structure_data(request: Request) -> dict[str, object]:
    payload = await _uploaded_payload(request)
    return await run_in_threadpool(_read_structure_data, payload, _uploaded_filename(request))


def _read_structure_data(payload: bytes, filename: str) -> dict[str, object]:
    from crystalsketch.structures.preview_limits import (
        PreviewLimitExceeded,
        enforce_structure_atom_limit,
    )
    from crystalsketch.structures.readers import StructureReadError, read_structure_bytes
    from crystalsketch.structures.summary import has_valid_3d_periodic_cell

    try:
        structure = read_structure_bytes(payload, filename)
        enforce_structure_atom_limit(len(structure))
    except StructureReadError as exc:
        raise HTTPException(status_code=400, detail={"message": str(exc)}) from exc
    except PreviewLimitExceeded as exc:
        raise HTTPException(status_code=413, detail={"message": str(exc)}) from exc
    if not structure.is_ordered:
        raise HTTPException(status_code=422, detail={"code": "disordered-structure"})
    if any(value > 0 for value in structure.site_properties.get("implicit_hydrogens", [])):
        raise HTTPException(status_code=422, detail={"code": "implicit-hydrogens"})
    if not has_valid_3d_periodic_cell(structure):
        raise HTTPException(status_code=422, detail={"code": "invalid-cell"})

    species: list[str] = []
    sites = []
    for index, site in enumerate(structure):
        symbol = site.specie.symbol
        if symbol not in species:
            species.append(symbol)
        record = {
            "siteId": f"{symbol}-{index}",
            "speciesIndex": species.index(symbol),
            "fractionalPosition": site.frac_coords.tolist(),
        }
        if "selective_dynamics" in site.properties:
            record["selectiveDynamics"] = [
                bool(value) for value in site.properties["selective_dynamics"]
            ]
        sites.append(record)
    return {
        "cell": {"vectors": structure.lattice.matrix.tolist()}, "species": species, "sites": sites
    }


@router.post("/structure-preview")
async def create_structure_preview(
    request: Request,
    bond_algorithm: str | None = Query(default=None, alias="bondAlgorithm"),
    include_connectivity: bool | None = Query(default=None, alias="includeConnectivity"),
    bond_cutoff_overrides: str | None = Header(
        default=None,
        alias="x-crystalsketch-bond-cutoff-overrides",
    ),
) -> dict[str, object]:
    filename = _uploaded_filename(request)
    try:
        normalized_bond_algorithm = normalize_bond_algorithm(bond_algorithm)
    except UnsupportedBondAlgorithmError as exc:
        raise HTTPException(status_code=400, detail={"message": str(exc)}) from exc
    try:
        normalized_cutoff_overrides = parse_bond_cutoff_overrides(bond_cutoff_overrides)
    except InvalidBondCutoffOverridesError as exc:
        raise HTTPException(status_code=400, detail={"message": str(exc)}) from exc

    payload = await _uploaded_payload(request)
    StructureReadError, PreviewLimitExceeded, create_preview = _structure_preview_dependencies()
    try:
        return await create_preview(
            payload,
            filename=filename,
            bond_algorithm=normalized_bond_algorithm,
            bond_cutoff_overrides=normalized_cutoff_overrides,
            include_connectivity=include_connectivity,
        )
    except StructureReadError as exc:
        raise HTTPException(status_code=400, detail={"message": str(exc)}) from exc
    except InvalidBondCutoffOverridesError as exc:
        raise HTTPException(status_code=400, detail={"message": str(exc)}) from exc
    except CustomBondRecalculationError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "bond-recalculation-failed", "message": str(exc)},
        ) from exc
    except PreviewLimitExceeded as exc:
        raise HTTPException(
            status_code=413,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc


async def _uploaded_payload(request: Request) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            upload_size = int(content_length)
        except ValueError:
            upload_size = None
        if upload_size is not None and upload_size > MAX_STRUCTURE_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail={
                    "code": "upload-too-large",
                    "message": STRUCTURE_FILE_TOO_LARGE_MESSAGE,
                },
            )

    payload = bytearray()
    async for chunk in request.stream():
        if len(payload) + len(chunk) > MAX_STRUCTURE_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail={
                    "code": "upload-too-large",
                    "message": STRUCTURE_FILE_TOO_LARGE_MESSAGE,
                },
            )
        payload.extend(chunk)
    return bytes(payload)


def _uploaded_filename(request: Request) -> str:
    encoded_name = request.headers.get("x-crystalsketch-filename")
    if encoded_name:
        return unquote(encoded_name)
    return "uploaded structure"


def _structure_preview_dependencies():
    from crystalsketch.server.preview_service import create_structure_preview
    from crystalsketch.structures.preview_limits import PreviewLimitExceeded
    from crystalsketch.structures.readers import StructureReadError

    return StructureReadError, PreviewLimitExceeded, create_structure_preview
