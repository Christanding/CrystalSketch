"""Local privileged routes; browser origin and intent checks apply before any install action."""

from __future__ import annotations

from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, ConfigDict, StrictBool, ValidationError
from starlette.concurrency import run_in_threadpool

from crystalsketch.server.update_worker import LOOPBACK_HOSTS, UpdateError
from crystalsketch.server.updater import UpdateManager

router = APIRouter(prefix="/updates", include_in_schema=False)


class ApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    confirm: StrictBool


def local_request(request: Request) -> UpdateManager:
    authority = request.headers.get("host", "")
    try:
        parsed = urlsplit(f"http://{authority}")
        port = parsed.port or 80
        valid = (
            parsed.hostname in LOOPBACK_HOSTS
            and not parsed.username
            and not parsed.password
            and not parsed.path
            and not parsed.query
            and not parsed.fragment
        )
    except ValueError:
        valid = False
    origin = request.headers.get("origin")
    if (
        not valid
        or (origin is not None and origin != f"http://{authority}")
        or request.headers.get("sec-fetch-site") == "cross-site"
    ):
        raise HTTPException(403, detail={"code": "not-local"})
    manager: UpdateManager = request.app.state.update_manager
    if request.method == "POST" and (
        origin is None or manager.lifecycle is None or port != manager.lifecycle.port
    ):
        raise HTTPException(403, detail={"code": "not-local"})
    return manager


def update_failure(error: Exception) -> HTTPException:
    code = error.code if isinstance(error, UpdateError) else "update-failed"
    status = 409 if code in {"busy", "other-instance-running"} else 400
    if code in {"expired", "not-local"}:
        status = 403
    if code == "unknown-job":
        status = 404
    if code == "rate-limited":
        status = 429
    return HTTPException(status, detail={"code": code})


@router.get("/check")
async def check_updates(manager: Annotated[UpdateManager, Depends(local_request)]) -> JSONResponse:
    try:
        result = await run_in_threadpool(manager.check)
    except Exception as exc:
        raise update_failure(exc) from exc
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.post("/apply", status_code=202)
async def apply_update(
    request: Request, manager: Annotated[UpdateManager, Depends(local_request)]
) -> JSONResponse:
    if (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        != "application/json"
    ):
        raise HTTPException(415, detail={"code": "invalid-request"})
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 256:
            raise HTTPException(413, detail={"code": "invalid-request"})
    try:
        confirmation = ApplyRequest.model_validate_json(body)
        if confirmation.confirm is not True:
            raise HTTPException(400, detail={"code": "invalid-request"})
    except ValidationError as exc:
        raise HTTPException(400, detail={"code": "invalid-request"}) from exc
    try:
        result = await run_in_threadpool(
            manager.start, request.headers.get("x-crystalsketch-update-token", "")
        )
    except Exception as exc:
        raise update_failure(exc) from exc
    return JSONResponse(result, status_code=202, headers={"Cache-Control": "no-store"})


@router.get("/status/{identifier}")
def update_status(
    identifier: str, manager: Annotated[UpdateManager, Depends(local_request)]
) -> JSONResponse:
    try:
        return JSONResponse(manager.status(identifier), headers={"Cache-Control": "no-store"})
    except Exception as exc:
        raise update_failure(exc) from exc


@router.get("/log/{identifier}")
def update_log(
    identifier: str, manager: Annotated[UpdateManager, Depends(local_request)]
) -> PlainTextResponse:
    try:
        return PlainTextResponse(
            manager.log(identifier),
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )
    except Exception as exc:
        raise update_failure(exc) from exc


@router.get("/ready")
def update_ready(
    request: Request, manager: Annotated[UpdateManager, Depends(local_request)]
) -> JSONResponse:
    if not manager.ready(request.headers.get("x-crystalsketch-update-probe", "")):
        raise HTTPException(403, detail={"code": "not-local"})
    return JSONResponse({"version": manager.version}, headers={"Cache-Control": "no-store"})
