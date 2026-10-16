from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
from unittest.mock import Mock, call
from urllib.error import HTTPError, URLError

import pytest

BASE_URL = "http://127.0.0.1:8765/"
CHECK_URL = BASE_URL + "api/updates/check"


@pytest.fixture
def update_probe(monkeypatch):
    script = Path(__file__).parents[1] / "scripts" / "smoke_install.py"
    spec = importlib.util.spec_from_file_location("smoke_install", script)
    assert spec is not None and spec.loader is not None
    smoke = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(smoke)
    opener = Mock()
    sleeps = []
    monkeypatch.setattr(smoke, "build_opener", lambda *_: opener)
    monkeypatch.setattr(smoke.time, "sleep", sleeps.append)
    return smoke, opener, sleeps


def limited() -> HTTPError:
    return HTTPError(CHECK_URL, 429, "Too Many Requests", {}, io.BytesIO(
        b'{"detail":{"code":"rate-limited"}}'
    ))


def success(**overrides) -> io.BytesIO:
    return io.BytesIO(json.dumps({
        "supported": True, "status": "latest", "currentVersion": "0.2.6",
        "latestVersion": "0.2.6", **overrides,
    }).encode())


@pytest.mark.parametrize("limits", [0, 1, 2])
def test_update_probe_passes_only_after_a_supported_response(update_probe, capsys, limits):
    smoke, opener, sleeps = update_probe
    errors = [limited() for _ in range(limits)]
    opener.open.side_effect = [*errors, success()]
    smoke.verify_update_check(BASE_URL)
    assert opener.open.call_args_list == [call(CHECK_URL, timeout=20)] * (limits + 1)
    assert sleeps == [60, 120][:limits]
    assert all(error.fp.closed for error in errors)
    output = capsys.readouterr().out
    assert output.count("WARN:") == limits
    assert output.count("PASS:") == 1


def test_persistent_limit_fails_after_the_bounded_budget(update_probe, capsys):
    smoke, opener, sleeps = update_probe
    opener.open.side_effect = [limited(), limited(), limited()]
    with pytest.raises(RuntimeError, match="after 3 attempts.*was not verified"):
        smoke.verify_update_check(BASE_URL)
    assert opener.open.call_count == 3
    assert sleeps == [60, 120]
    assert "PASS:" not in capsys.readouterr().out


@pytest.mark.parametrize("error", [
    HTTPError(CHECK_URL, 400, "Bad Request", {}, None),
    HTTPError(CHECK_URL, 403, "Forbidden", {}, None),
    HTTPError(CHECK_URL, 500, "Internal Server Error", {}, None),
    URLError("Connection refused"),
])
def test_other_http_and_connection_failures_are_not_retried(update_probe, capsys, error):
    smoke, opener, sleeps = update_probe
    opener.open.side_effect = [error]
    with pytest.raises(URLError) as raised:
        smoke.verify_update_check(BASE_URL)
    assert raised.value is error
    assert opener.open.call_count == 1 and sleeps == []
    assert "PASS:" not in capsys.readouterr().out


@pytest.mark.parametrize("body", [b'{"detail":{"code":"unexpected"}}', b'not JSON'])
def test_429_without_the_application_rate_limit_code_is_not_retried(update_probe, body):
    smoke, opener, sleeps = update_probe
    error = HTTPError(CHECK_URL, 429, "Too Many Requests", {}, io.BytesIO(body))
    opener.open.side_effect = [error]
    with pytest.raises(HTTPError) as raised:
        smoke.verify_update_check(BASE_URL)
    assert raised.value is error
    assert opener.open.call_count == 1 and sleeps == []


@pytest.mark.parametrize("response", [
    {"supported": False, "reason": "unsupported-installation"},
    {"status": "invalid"},
])
def test_retry_never_hides_an_unsupported_or_invalid_installation(update_probe, capsys, response):
    smoke, opener, sleeps = update_probe
    opener.open.side_effect = [limited(), success(**response)]
    with pytest.raises(RuntimeError, match="cannot update"):
        smoke.verify_update_check(BASE_URL)
    assert opener.open.call_count == 2 and sleeps == [60]
    assert "PASS:" not in capsys.readouterr().out
