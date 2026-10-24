"""API tests for the SiteTwin server (agent D). Run: uv run pytest tests/test_server.py -q

Every test runs against a fresh storage directory, with no API keys (chat uses the rule fallback)."""

from __future__ import annotations

import io
import json

import pytest
from fastapi.testclient import TestClient

HERO = "proc-factory-dev-003"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SITETWIN_STORAGE", str(tmp_path))
    monkeypatch.setenv("SITETWIN_FORCE_FALLBACK", "1")
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ELEVENLABS_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    from server import db, twin

    db.reset_engine()
    twin.invalidate()
    from agent import chat

    chat._sessions.clear()
    from server.main import app

    with TestClient(app) as test_client:
        yield test_client
    db.reset_engine()
    twin.invalidate()


def sse_frames(text: str) -> list[tuple[str, dict]]:
    frames = []
    for chunk in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in chunk.splitlines() if ": " in line)
        frames.append((lines["event"], json.loads(lines["data"])))
    return frames


def chat(client: TestClient, message: str, session: str = "t1") -> list[tuple[str, dict]]:
    response = client.post(f"/api/sites/{HERO}/chat", json={"session_id": session, "message": message})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    return sse_frames(response.text)


def test_sites_list(client):
    sites = client.get("/api/sites").json()
    assert len(sites) >= 66
    assert sites[0]["id"] == HERO
    keys = {"id", "name", "lat", "lon", "source", "building_id", "data_path", "floors", "demo_location", "kind"}
    assert keys <= set(sites[0])
    assert {site["kind"] for site in sites} >= {"factory", "campus", "airport", "mall"}


def test_building_and_unknown_site(client):
    building = client.get(f"/api/sites/{HERO}/building").json()
    assert building["building"]["name"] == "Fertigung Ost 27"
    assert len(building["spaces"]) > 50
    assert client.get("/api/sites/nope/building").status_code == 404


def test_route_payload(client):
    route = client.post(f"/api/sites/{HERO}/route", json={"from": "Office 0.30", "to": "Quality lab 0.21"}).json()
    assert route["reachable"] is True
    assert route["length_m"] == pytest.approx(47.85, abs=0.01)  # the dataset's route model
    assert route["space_path"][0].endswith("F0-S030") and route["space_path"][-1].endswith("F0-S021")
    assert route["floors"] and len(route["floors"][0]["points"]) >= 2
    assert any("turn" in step or "past" in step for step in route["steps"])  # landmark directions


def test_route_step_free_uses_lift(client):
    route = client.post(f"/api/sites/{HERO}/route",
                        json={"from": "Office 1.04", "to": "Quality lab 0.21", "step_free": True}).json()
    assert route["reachable"] and route["step_free"]
    assert [c["kind"] for c in route["connectors"]] == ["lift"]
    assert [f["level"] for f in route["floors"]][:2] == [1, 0]


def test_route_min_width_blocked(client):
    route = client.post(f"/api/sites/{HERO}/route",
                        json={"from": "Logistics zone H-C5", "to": "Office 0.30", "min_width_m": 1.5}).json()
    assert route["reachable"] is False
    assert route["min_width_m"] == 1.5
    assert isinstance(route.get("blocking_openings", []), list)


def test_unknown_place_is_400(client):
    response = client.post(f"/api/sites/{HERO}/route", json={"from": "Narnia", "to": "Office 0.30"})
    assert response.status_code == 400
    assert "detail" in response.json()


def test_closure_changes_route_and_logs_event(client):
    body = {"from": "Office 1.04", "to": "Quality lab 0.21", "step_free": True}
    assert client.post(f"/api/sites/{HERO}/route", json=body).json()["reachable"]
    state = client.post(f"/api/sites/{HERO}/closures", json={"element_id": "Office lift", "closed": True}).json()
    assert state["closed"] == [f"{HERO}-V02"]
    assert client.post(f"/api/sites/{HERO}/route", json=body).json()["reachable"] is False
    stairs = client.post(f"/api/sites/{HERO}/route", json={**body, "step_free": False}).json()
    assert stairs["reachable"] and stairs["connectors"][0]["kind"] == "stairs"

    events = client.get(f"/api/sites/{HERO}/events").json()
    assert events[0]["type"] == "closure" and events[0]["payload"]["closed"] is True
    assert client.get(f"/api/sites/{HERO}/state").json()["closed"] == [f"{HERO}-V02"]

    client.post(f"/api/sites/{HERO}/closures", json={"element_id": f"{HERO}-V02", "closed": False})
    assert client.post(f"/api/sites/{HERO}/route", json=body).json()["reachable"]
    events = client.get(f"/api/sites/{HERO}/events?limit=1").json()
    assert len(events) == 1 and events[0]["title"] == "Office lift reopened"
    assert client.get(f"/api/sites/{HERO}/events?since=2999-01-01T00:00:00Z").json() == []


def test_move_asset(client):
    state = client.post(f"/api/sites/{HERO}/assets/{HERO}-A00001/move",
                        json={"space_id": "Production zone H-A4"}).json()
    override = state["asset_overrides"][f"{HERO}-A00001"]
    assert override["space_id"] == f"{HERO}-F0-S004"
    assert client.get(f"/api/sites/{HERO}/events").json()[0]["type"] == "asset_moved"


def test_bookable_rooms_and_bookings(client):
    window = "start=2030-01-07T14:00:00&end=2030-01-07T15:00:00"
    rooms = client.get(f"/api/sites/{HERO}/rooms/bookable?{window}&people=6").json()
    assert rooms and all(room["capacity"] >= 6 and room["free"] for room in rooms)
    assert all("Meeting" in room["name"] for room in rooms)
    target = rooms[0]["space_id"]
    booking = client.post(f"/api/sites/{HERO}/bookings", json={
        "space_id": target, "start": "2030-01-07T14:00:00", "end": "2030-01-07T15:00:00", "who": "Anna", "title": "Sync"}).json()
    assert booking["space_id"] == target and booking["id"]
    clash = client.post(f"/api/sites/{HERO}/bookings", json={
        "space_id": target, "start": "2030-01-07T14:30:00", "end": "2030-01-07T15:30:00"})
    assert clash.status_code == 409
    rooms = client.get(f"/api/sites/{HERO}/rooms/bookable?{window}&people=6").json()
    assert next(room for room in rooms if room["space_id"] == target)["free"] is False
    assert len(client.get(f"/api/sites/{HERO}/bookings").json()) == 1
    assert client.get(f"/api/sites/{HERO}/events").json()[0]["type"] == "booking"


def test_chat_without_key_routes(client):
    frames = chat(client, "Route from Office 1.04 to Quality lab 0.21 without stairs")
    actions = [data for event, data in frames if event == "action"]
    routes = [action for action in actions if action["type"] == "show_route"]
    assert routes and routes[0]["route"]["reachable"] and routes[0]["route"]["step_free"]
    understood = next(action for action in actions if action["type"] == "understood")
    assert "step-free" in understood["chips"]
    assert any(event == "delta" for event, _ in frames)
    assert frames[-1][0] == "done"
    reply = frames[-1][1]["reply"]
    assert "Quality lab 0.21" in reply and "ANTHROPIC_API_KEY" in reply


def test_chat_locate_then_there_then_close(client):
    frames = chat(client, "Where is the coordinate measuring machine?")
    actions = [data for event, data in frames if event == "action"]
    assert any(a["type"] == "highlight" and f"{HERO}-A00117" in a["ids"] for a in actions)
    assert any(a["type"] == "focus_floor" for a in actions)
    frames = chat(client, "Take me there")
    route = next(data["route"] for event, data in frames if event == "action" and data["type"] == "show_route")
    assert route["space_path"][-1] == f"{HERO}-F0-S021"
    frames = chat(client, "Close the office lift")
    assert any(event == "action" and data["type"] == "state_changed" for event, data in frames)
    assert client.get(f"/api/sites/{HERO}/state").json()["closed"] == [f"{HERO}-V02"]


def test_create_site_from_building_json(client):
    building = client.get(f"/api/sites/{HERO}/building").json()
    files = {"file": ("building.json", io.BytesIO(json.dumps(building).encode()), "application/json")}
    site = client.post("/api/sites", data={"name": "Werk Test", "lat": "48.1", "lon": "11.5"}, files=files).json()
    assert site["id"].startswith("user-werk-test") and site["kind"] == "factory" and site["floors"] == 2
    assert any(s["id"] == site["id"] for s in client.get("/api/sites").json())
    assert len(client.get(f"/api/sites/{site['id']}/building").json()["spaces"]) == len(building["spaces"])
    route = client.post(f"/api/sites/{site['id']}/route", json={"from": "Office 0.30", "to": "Quality lab 0.21"}).json()
    assert route["reachable"]


def test_create_site_image_without_key_is_501(client):
    files = {"file": ("plan.png", io.BytesIO(b"\x89PNG\r\n\x1a\n" + b"0" * 64), "image/png")}
    response = client.post("/api/sites", data={"name": "Plan", "lat": "48.1", "lon": "11.5"}, files=files)
    assert response.status_code == 501
    assert "ANTHROPIC_API_KEY" in response.json()["detail"]


def test_bad_building_json_is_400(client):
    files = {"file": ("building.json", io.BytesIO(b'{"floors": []}'), "application/json")}
    assert client.post("/api/sites", data={"name": "Bad", "lat": "1", "lon": "2"}, files=files).status_code == 400


def test_voice_without_key_is_501(client):
    assert client.post("/api/voice/tts", json={"text": "hello"}).status_code == 501
    files = {"audio": ("a.webm", io.BytesIO(b"1234"), "audio/webm")}
    assert client.post("/api/voice/stt", files=files).status_code == 501


def test_deliveries_in_state(client):
    from server import twin

    twin.add_delivery({"id": "dl-test", "site_id": HERO, "label": "Steel drum", "note": "200 l",
                       "dims_m": {"w": 0.6, "d": 0.6, "h": 0.9}, "tolerance_m": 0.03, "floor_id": f"{HERO}-F0",
                       "space_id": f"{HERO}-F0-S015", "position": [-30.0, 76.0], "rotation_deg": 0.0,
                       "status": "ok", "check": {"declared": None, "route_fit": None, "floor_fit": None, "summary": "ok"}})
    state = client.get(f"/api/sites/{HERO}/state").json()
    assert any(d["id"] == "dl-test" for d in state["deliveries"])
    frames = chat(client, "Where's the steel drum that came in yesterday?", session="d1")
    assert any(event == "action" and data["type"] == "highlight" and data["ids"] == ["dl-test"] for event, data in frames)
    assert "Logistics zone H-C5" in frames[-1][1]["reply"]


def test_chat_uses_viewer_location_and_returns_spoken_location(client):
    origin = f"{HERO}-F0-S030"
    response = client.post(f"/api/sites/{HERO}/chat", json={
        "session_id": "location", "message": "Take me to Quality lab 0.21", "here": origin})
    frames = sse_frames(response.text)
    route = next(d["route"] for e, d in frames if e == "action" and d["type"] == "show_route")
    assert route["space_path"][0] == origin
    assert not route["connectors"]
    response = client.post(f"/api/sites/{HERO}/chat", json={
        "session_id": "location", "message": "I'm in Office 1.04", "here": origin})
    frames = sse_frames(response.text)
    location = next(d for e, d in frames if e == "action" and d["type"] == "set_location")
    assert location["space_id"] == f"{HERO}-F1-S004"
    frames = chat(client, "Take me to Quality lab 0.21 without stairs", session="location")
    route = next(d["route"] for e, d in frames if e == "action" and d["type"] == "show_route")
    assert route["space_path"][0] == location["space_id"]
    assert route["connectors"][0]["kind"] == "lift"


def test_chat_rejects_invalid_viewer_location_before_streaming(client):
    response = client.post(f"/api/sites/{HERO}/chat", json={"message": "Take me there", "here": "missing-room"})
    assert response.status_code == 400
    assert "detail" in response.json()


def test_blocked_route_retains_request_for_reopening(client):
    body = {"from": "Office 1.04", "to": "Quality lab 0.21", "via": ["Office 0.30"], "step_free": True}
    client.post(f"/api/sites/{HERO}/closures", json={"element_id": "Office lift", "closed": True})
    blocked = client.post(f"/api/sites/{HERO}/route", json=body).json()
    assert not blocked["reachable"]
    assert blocked["from_space_id"] == f"{HERO}-F1-S004"
    assert blocked["to_space_id"] == f"{HERO}-F0-S021"
    assert blocked["via"] == [f"{HERO}-F0-S030"]
    client.post(f"/api/sites/{HERO}/closures", json={"element_id": "Office lift", "closed": False})
    reopened = client.post(f"/api/sites/{HERO}/route", json={
        "from": blocked["from_space_id"], "to": blocked["to_space_id"],
        "via": blocked["via"], "step_free": blocked["step_free"]}).json()
    assert reopened["reachable"]
    assert reopened["via"][0] in reopened["space_path"]


def test_site_preview_does_not_save_until_confirmed(client):
    building = client.get(f"/api/sites/{HERO}/building").json()
    before = client.get('/api/sites').json()
    response = client.post('/api/sites', data={
        'name': 'Review Test', 'lat': '48.1', 'lon': '11.5', 'preview': 'true'},
        files={'file': ('building.json', json.dumps(building).encode(), 'application/json')})
    assert response.status_code == 200
    draft = response.json()
    assert draft['building']['spaces'] and isinstance(draft['warnings'], list)
    assert client.get('/api/sites').json() == before
    from server import db
    assert not (db.storage_dir() / 'sites').exists()
    saved = client.post('/api/sites', data={'name': 'Review Test', 'lat': '48.1', 'lon': '11.5'},
                        files={'file': ('building.json', json.dumps(draft['building']).encode(), 'application/json')})
    assert saved.status_code == 200
    assert len(client.get('/api/sites').json()) == len(before) + 1
    assert client.get(f"/api/sites/{saved.json()['id']}/building").status_code == 200


@pytest.fixture()
def fake_vision(monkeypatch):
    """Claude vision replaced by synthetic extractions keyed by upload file name (see tests/test_stitch.py)."""
    from server import floorplan
    from tests.test_stitch import photo

    plans = {
        "eg.jpg": photo((0, 0, 40, 20), north_deg=0, level=0, label="Erdgeschoss"),
        "og-a.jpg": photo((0, 0, 26, 20), north_deg=135, level=1, label="1. Obergeschoss", offset=(5, 2)),
        "og-b.jpg": photo((10, 0, 40, 20), north_deg=45, level=1, label="1. Obergeschoss", offset=(5, 2)),
    }
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(floorplan, "extract_plan", lambda data, media_type, width_m=None: dict(plans[data.decode()]))
    return plans


def _plan_files(*names):
    return [("files", (name, io.BytesIO(name.encode()), "image/jpeg")) for name in names]


def test_multi_plan_preview_stitches_and_confirm_keeps_ids(client, fake_vision):
    address = "Freddie-Mercury-Straße 5, 80797 München"
    form = {"lat": "48.17", "lon": "11.54", "address": address, "name": "", "preview": "true"}
    response = client.post("/api/sites", data=form, files=_plan_files("eg.jpg", "og-a.jpg", "og-b.jpg"))
    assert response.status_code == 200, response.text
    draft = response.json()
    building = draft["building"]
    assert [f["level"] for f in building["floors"]] == [0, 1]
    assert building["vertical_connectors"] and len(draft["extractions"]) == 3
    assert building["building"]["address"] == address
    assert [p["level"] for p in building["building"]["plans"]] == [0, 1, 1]
    assert draft["site_id"].startswith("user-freddie-mercury")

    files = [("file", ("building.json", io.BytesIO(json.dumps(building).encode()), "application/json"))]
    files += _plan_files("eg.jpg", "og-a.jpg", "og-b.jpg")
    site = client.post("/api/sites", data={"lat": "48.17", "lon": "11.54", "address": address,
                                           "site_id": draft["site_id"], "kind": "office"}, files=files).json()
    assert site["id"] == draft["site_id"] and site["name"] == address and site["address"] == address
    assert site["source"] == "floor_plan" and site["floors"] == 2
    from server import db
    plans_dir = db.storage_dir() / "sites" / site["id"] / "plans"
    assert len(list(plans_dir.glob("*.jpg"))) == 3
    assert len(json.loads((plans_dir / "extractions.json").read_text(encoding="utf-8"))["extractions"]) == 3
    rebuilt = client.post(f"/api/sites/{site['id']}/rebuild")
    assert rebuilt.status_code == 200, rebuilt.text
    assert rebuilt.json()["floors"] == 2 and (plans_dir.parent / "building.prev.json").exists()
    saved = client.get(f"/api/sites/{site['id']}/building").json()
    assert saved["building"]["id"] == site["id"]
    upper = next(s["id"] for s in saved["spaces"] if s["name"] == "EDV" and s["floor_id"].endswith("-F1"))
    ground = next(s["id"] for s in saved["spaces"] if s["name"] == "Besprechung" and s["floor_id"].endswith("-F0"))
    route = client.post(f"/api/sites/{site['id']}/route", json={"from": upper, "to": ground}).json()
    assert route["reachable"] and route["connectors"]


def test_restitch_applies_level_override_without_claude(client, fake_vision, monkeypatch):
    form = {"lat": "48.1", "lon": "11.5", "name": "Haus", "preview": "true"}
    draft = client.post("/api/sites", data=form, files=_plan_files("eg.jpg", "og-a.jpg")).json()
    from server import floorplan
    monkeypatch.setattr(floorplan, "extract_plan", lambda *a, **k: pytest.fail("restitch must not call Claude"))
    again = client.post("/api/sites/restitch", json={
        "extractions": draft["extractions"], "matches": draft["matches"], "level_overrides": {"1": 2},
        "site_id": draft["site_id"], "name": "Haus"}).json()
    assert again["site_id"] == draft["site_id"]
    assert [f["level"] for f in again["building"]["floors"]] == [0, 2]


def test_site_name_falls_back_to_coordinates(client):
    building = client.get(f"/api/sites/{HERO}/building").json()
    files = {"file": ("building.json", io.BytesIO(json.dumps(building).encode()), "application/json")}
    site = client.post("/api/sites", data={"lat": "48.1", "lon": "11.5"}, files=files).json()
    assert site["name"] == "Standort 48.1000, 11.5000"


def test_geocode_proxies_photon(client, monkeypatch):
    from server import geocode

    async def fake_get(url, params):
        assert "photon" in url and params["q"] == "Freddie-Mercury-Straße 5"
        return {"features": [{"geometry": {"coordinates": [11.54, 48.17]}, "properties": {
            "street": "Freddie-Mercury-Straße", "housenumber": "5", "postcode": "80797", "city": "München",
            "countrycode": "DE"}}]}

    monkeypatch.setattr(geocode, "_get", fake_get)
    geocode._cache.clear()
    [hit] = client.get("/api/geocode", params={"q": "Freddie-Mercury-Straße 5"}).json()
    assert hit == {"label": "Freddie-Mercury-Straße 5, 80797 München", "lat": 48.17, "lon": 11.54}
