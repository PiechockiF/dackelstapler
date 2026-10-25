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


def test_run_benchmark_adds_one_building_at_a_time(tmp_path, monkeypatch):
    monkeypatch.setattr(benchmark.run, "answer_entry", lambda building, text: {"kind": "x", "answer": f"{text}\nAnswer: 1"})
    monkeypatch.setattr(benchmark.run, "LOG_DIRECTORY", tmp_path / "log")
    for name, ids in {"b1": ["A", "B"], "b2": ["C"]}.items():
        (tmp_path / name).mkdir()
        (tmp_path / name / "building.json").write_text("{}")
        lines = [json.dumps({"id": i, "question": f"q{i}"}) for i in ids]
        (tmp_path / name / "questions.jsonl").write_text("\n".join(lines) + "\n")
    answers = tmp_path / "answers.json"
    for name in ("b1", "b2", "b1"):  # b1 again: its entries are replaced, not duplicated
        benchmark.run.run(tmp_path / name, answers)
    output = json.loads(answers.read_text())
    assert [entry["question_id"] for entry in output] == ["C", "A", "B"]
    assert all(set(entry) == {"question_id", "answer"} for entry in output)
    assert output[1]["answer"] == "qA\nAnswer: 1"
