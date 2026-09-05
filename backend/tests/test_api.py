from fastapi.testclient import TestClient

from app.main import app


def test_health_and_login_contract():
    client = TestClient(app)
    assert client.get("/api/health").json() == {"status": "ok"}
    response = client.post("/api/auth/login", json={"access_token": "fake-token"})
    assert response.status_code == 200
    assert response.json()["authenticated"] is True
    assert "fake-token" not in response.text
    status = client.get("/api/auth/status")
    assert status.status_code == 200


def test_search_requires_session():
    client = TestClient(app)
    response = client.post("/api/search", params={"query": "高数"})
    assert response.status_code == 401
