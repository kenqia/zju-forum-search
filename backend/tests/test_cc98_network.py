import pytest

import app.cc98 as cc98


@pytest.mark.asyncio
async def test_cc98_client_does_not_use_system_proxy_by_default(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"id": "local-test-user"}

    class FakeAsyncClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def request(self, *args, **kwargs):
            captured["request"] = args
            return FakeResponse()

    monkeypatch.setattr(cc98.httpx, "AsyncClient", FakeAsyncClient)
    await cc98.HttpCC98Client().validate_token("test-token")

    assert captured["trust_env"] is False
    assert captured["request"][:2] == ("GET", "/me")


def test_authorization_header_accepts_devtools_formats():
    assert cc98._authorization_header("raw%2Btoken") == "Bearer raw+token"
    assert cc98._authorization_header('"Bearer raw%2Btoken"') == "Bearer raw+token"
    assert cc98._authorization_header("Bearer raw-token") == "Bearer raw-token"
