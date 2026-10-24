"""Deployment routing: React deep links must not shadow API or missing assets."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.frontend import FrontendFiles


@pytest.fixture
def client(tmp_path):
    (tmp_path / "index.html").write_text("<html>SiteTwin</html>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log('SiteTwin')")
    app = FastAPI()

    @app.get("/api/health")
    def health():
        return {"ok": True}

    app.mount("/", FrontendFiles(directory=tmp_path, html=True))
    with TestClient(app) as test_client:
        yield test_client


@pytest.mark.parametrize("path", ["/", "/capture", "/sites/factory-1"])
def test_frontend_and_deep_links(client, path):
    response = client.get(path)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "SiteTwin" in response.text


def test_api_and_assets_take_priority(client):
    assert client.get("/api/health").json() == {"ok": True}
    assert client.get("/assets/app.js").text == "console.log('SiteTwin')"


@pytest.mark.parametrize("path", ["/api/missing", "/storage/missing", "/ws", "/assets/missing.js"])
def test_missing_resources_do_not_return_frontend(client, path):
    response = client.get(path)
    assert response.status_code == 404
    assert "<html>" not in response.text
