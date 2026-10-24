"""The benchmark agent's tools (agent/answer.py) against the kit's labelled answers, and the run_benchmark
command's file handling. No API calls: the tools get the ids the kit's `inputs` and answers name, which is
what the agent has to find itself; the agent loop is faked."""

import json
from pathlib import Path

import pytest

import benchmark.run
from agent.answer import BenchmarkTools, evaluate_expression, load_map
from benchmark.score import score_reply, within
from core import solvers

DATA = Path(__file__).resolve().parent.parent / "data" / "dev"
BUILDINGS = ["proc-factory-dev-003", "swiss-1689", "osm-way27917482", "resplan-1677", "proc-campus-dev-001",
             "osm-way22744230", "osm-way27326387", "osm-way360544293"]
FACTORY = DATA / "proc-factory-dev-003"


def kit_questions(building_id: str, name: str) -> list[dict]:
    path = DATA / building_id / name
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def tools_for(building_id: str) -> BenchmarkTools:
    return BenchmarkTools(load_map(str((DATA / building_id).resolve())))


def check_route(tools: BenchmarkTools, stops: list[list[str]], expected: dict, **constraints) -> None:
    result = tools.route(stops, **constraints)
    record = tools.routes[result["route_ref"]]
    if expected.get("reachable") is False:
        assert record["reachable"] is False
        return
    legs = expected.get("legs") or [expected]
    assert record["length_m"] == pytest.approx(expected["optimal_length_m"], abs=0.011)
    assert record["route"] == legs[0]["space_path"] + [s for leg in legs[1:] for s in leg["space_path"][1:]]
    assert record["element_path"] == [element for leg in legs for element in leg["element_path"]]


@pytest.mark.parametrize("building_id", BUILDINGS)
def test_warm_up_answers_from_tools(building_id):
    tools = tools_for(building_id)
    for q in kit_questions(building_id, "questions_basic.jsonl"):
        expected, kind = q["answer"], q["kind"]
        if kind == "locate":
            asset = tools.bm.assets[expected["asset_id"]]
            found = tools.list_assets(asset_type=asset["type"])["results"]
            assert expected["asset_id"] in [row["id"] for row in found]
            assert tools.space_details(expected["asset_id"])["id"] == expected["space_id"]
        elif kind == "count":
            assert tools.list_assets(expected["asset_type"], expected["floor_level"])["count"] == expected["count"]
        elif kind == "tour":
            check_route(tools, [[stop] for stop in expected["stops"]], expected)
        else:
            closed = [expected["closed_element_id"]] if expected.get("closed_element_id") else None
            check_route(tools, [[expected["from_space_id"]], [expected["to_space_id"]]], expected,
                        step_free=kind == "route_step_free", closed=closed)


@pytest.mark.parametrize("building_id", BUILDINGS)
def test_benchmark_answers_from_tools(building_id):
    tools = tools_for(building_id)
    for q in kit_questions(building_id, "questions.jsonl"):
        i, expected, kind = q["inputs"], q["answer"], q["kind"]
        level = tools.level(i["floor_id"]) if "floor_id" in i else None
        if kind in ("largest_room", "floor_area_total"):
            listed = tools.list_spaces(level, i["room_type"])
            if kind == "largest_room":
                top = listed["largest_first"][0]
                assert top["id"] == expected["space_id"] and within(top["area_m2"], expected["area"])
            else:
                assert within(listed["total_area_m2"], expected)
        elif kind == "errand":
            target = tools.list_spaces(level, i["room_type"])["largest_first"][0]["id"]
            holders = [row["id"] for row in tools.list_assets(i["asset_type"])["results"]]
            result = tools.route([[i["start"]], holders, [target]])
            assert within(result["length_m"], expected)
        elif kind == "wide_delivery_count":
            result = tools.reachable_rooms(i["start"], level, step_free=True, min_width_m=i["min_width"])
            assert result["rooms_reached"] == expected["value"]
        elif kind == "step_free_reachable_count":
            result = tools.reachable_rooms(i["start"], level, step_free=True, closed=[i["closed"]])
            assert result["rooms_reached"] == expected["value"]
        elif kind == "room_stacked":
            details = tools.space_details(i["start"])
            key = "directly_above" if i["direction"] == "above" else "directly_below"
            assert details[key][0]["id"] == expected["space_id"]
        elif kind == "shared_walls_count":
            assert len(tools.space_details(i["start"])["shares_wall_with"]) == expected["value"]
        elif kind == "straight_line_3d":
            assert within(tools.straight_line_distance(i["first"], i["second"])["distance_m"], expected)
        elif kind == "what_if_door":
            result = tools.what_if_door(i["first"], i["second"], level)
            assert result["rooms_with_shorter_walk_out"] == expected["value"]
        else:
            pytest.fail(f"no tool check for kind {kind}")


def test_route_rules_and_submission():
    tools = tools_for(FACTORY.name)
    bm = tools.bm
    aisle = "proc-factory-dev-003-F0-S009"
    walk = tools.route([["proc-factory-dev-003-F0-S010"], ["proc-factory-dev-003-F0-S008"]], closed=[aisle])
    assert aisle not in tools.routes[walk["route_ref"]]["route"]
    fork = tools.route([["proc-factory-dev-003-F0-S015"], ["proc-factory-dev-003-F0-S001"]], forklift=True)
    record = tools.routes[fork["route_ref"]]
    assert not [s for s in record["route"][1:-1] if bm.spaces[s]["room_type"] in solvers.PRODUCTION_BAY_TYPES]
    assert all(bm.openings[e]["width_m"] >= solvers.FORKLIFT_MIN_WIDTH_M for e in record["element_path"])

    mills = [row["id"] for row in tools.list_assets("cnc_mill")["results"]]
    lobby = tools.list_spaces(room_type="lobby")["largest_first"][0]["id"]
    to_mill = tools.route([[lobby], mills], step_free=True)
    tools.submit(f"{to_mill['length_m']}", "Shortest step-free walk.", "route", route_ref=to_mill["route_ref"])
    entry = tools.submission
    assert bm.assets[entry["item_id"]]["type"] == "cnc_mill"
    assert entry["route"][-1] == entry["room_id"] == bm.assets[entry["item_id"]]["space_id"]
    assert entry["answer"].endswith(f"Answer: {to_mill['length_m']}")
    assert score_reply({"type": "number", "value": to_mill["length_m"], "relative_tolerance": 0.01,
                        "absolute_tolerance": 1.0}, entry["answer"])
    with pytest.raises(Exception):
        tools.submit("3", "x", route_ref=99)
    assert evaluate_expression("round(sum([1.25, 2.5]) * 2, 1)") == 7.5
    with pytest.raises(ValueError):
        evaluate_expression("__import__('os')")


def test_run_benchmark_file_shapes_and_order(tmp_path, monkeypatch):
    seen = []

    def fake_agent(building, text, given):
        seen.append(given.get("constraints"))
        return {"kind": "route", "answer": f"{text}\nAnswer: 1"}

    monkeypatch.setattr(benchmark.run, "answer_entry", fake_agent)
    text = "How do I get from Office 1.18 (Floor 1) to Quality lab 0.21 (Ground floor)?"
    shapes = {
        "list.json": json.dumps([{"id": "A", "text": text, "constraints": {"step_free": True}}, {"id": "B", "text": "?"}]),
        "wrapped.json": json.dumps({"questions": [{"question_id": "A", "question": text}]}),
        "keyed.json": json.dumps({"A": text}),
        "lines.jsonl": json.dumps({"id": "A", "prompt": text}) + "\n",
        "table.csv": f'id,text\nA,"{text}"\n',
    }
    for name, content in shapes.items():
        (tmp_path / name).write_text(content)
        benchmark.run.run(FACTORY, tmp_path / name, tmp_path / f"{name}.out")
        output = json.loads((tmp_path / f"{name}.out").read_text())
        entry = output["A"] if name == "keyed.json" else (output["answers"] if name == "wrapped.json" else output)[0]
        assert entry["answer"].startswith(text), name
    assert {"step_free": True} in seen
    assert [e["id"] for e in json.loads((tmp_path / "list.json.out").read_text())] == ["A", "B"]


def test_questions_file_fallbacks(tmp_path, monkeypatch):
    building = tmp_path / "release" / "building-x"
    building.mkdir(parents=True)
    (building / "building.json").write_text("{}")
    (building / "questions.jsonl").write_text("")
    find = benchmark.run.find_questions
    monkeypatch.chdir(tmp_path)
    assert find(building, building, None) == building / "questions.jsonl"  # omitted: next to the building
    assert find(building, building, Path("questions.jsonl")) == building / "questions.jsonl"  # name only
    (tmp_path / "release" / "questions.json").write_text("[]")
    release = tmp_path / "release"
    assert find(release, building, None) == release / "questions.json"  # an unpacked release's own file
    (tmp_path / "questions.jsonl").write_text("")
    assert find(building, building, Path("questions.jsonl")) == Path("questions.jsonl")  # as given wins
    with pytest.raises(SystemExit):
        find(building, building, Path("missing.json"))
