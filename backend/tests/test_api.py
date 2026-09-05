from fastapi.testclient import TestClient

from app.main import app
import app.main as main
from app.cc98 import CC98Error

class FakeAuthClient:
    async def validate_token(self, token):
        if token == "bad":
            raise CC98Error("invalid", kind="auth", status_code=401)



def test_health_and_login_contract():
    original = main.cc98_client
    main.cc98_client = FakeAuthClient()
    client = TestClient(app)
    assert client.get("/api/health").json() == {"status": "ok"}
    response = client.post("/api/auth/login", json={"access_token": "fake-token"})
    assert response.status_code == 200
    assert response.json()["authenticated"] is True
    assert "fake-token" not in response.text
    status = client.get("/api/auth/status")
    assert status.status_code == 200
    main.cc98_client = original


def test_search_requires_session():
    client = TestClient(app)
    response = client.post("/api/search", params={"query": "高数"})
    assert response.status_code == 401


def test_login_rejects_invalid_token():
    original = main.cc98_client
    main.cc98_client = FakeAuthClient()
    response = TestClient(app).post("/api/auth/login", json={"access_token": "bad"})
    main.cc98_client = original
    assert response.status_code == 401


def test_expired_session_is_rejected():
    from app.auth import SessionStore
    from datetime import datetime, timedelta, timezone
    store = SessionStore()
    session_id = store.create("fake", datetime.now(timezone.utc) - timedelta(seconds=1))
    assert store.get(session_id) is None
