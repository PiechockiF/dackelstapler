"""Score the agent on the dataset's questions.jsonl files.

  uv run python -m starter_agent.evaluate data/dev --oracle      # tools only, no API calls
  uv run python -m starter_agent.evaluate data/dev --limit 10    # live agent (uses credits)

Live scoring reads what the agent actually computed (its last route, the assets it located), not its prose,
except for counts, where the number must appear in the answer."""

import argparse
import json
import re
from collections import Counter
from pathlib import Path

import anthropic

from starter_agent.agent import BuildingAgent
from starter_agent.building_map import BuildingMap, MapError

QUESTIONS_FILENAME = "questions_basic.jsonl"
ROUTE_TOLERANCE = 0.01
ROUTE_KINDS = {"route", "route_step_free", "route_with_closure", "tour"}
OUTPUT_DIRECTORY = Path("agent_output") / "eval"


def load_questions(directory: Path, limit: int | None) -> list[tuple[Path, dict]]:
    questions = []
    for path in sorted(directory.glob(f"*/{QUESTIONS_FILENAME}")):
        with path.open(encoding="utf-8") as handle:
            questions += [(path.parent, json.loads(line)) for line in handle if line.strip()]
    return questions[:limit] if limit else questions


def expected_unreachable(answer: dict) -> bool:
    return answer.get("reachable") is False


def route_matches(building_map: BuildingMap, answer: dict) -> bool:
    route = building_map.last_route
    if expected_unreachable(answer):
        return route is None or route.length_m == 0
    if route is None:
        return False
    optimal = answer["optimal_length_m"]
    return abs(route.length_m - optimal) <= max(ROUTE_TOLERANCE * optimal, ROUTE_TOLERANCE)


def score(question: dict, building_map: BuildingMap, reply: str) -> bool:
    answer = question["answer"]
    if question["kind"] == "locate":
        return answer["asset_id"] in building_map.located_asset_ids
    if question["kind"] == "count":
        return str(answer["count"]) in re.findall(r"\d+", reply)
    if question["kind"] in ROUTE_KINDS:
        return route_matches(building_map, answer)
    return False


def oracle_answer(question: dict, building_map: BuildingMap) -> str:
    """Answer with the tools directly, as a perfect agent would call them."""
    answer = question["answer"]
    kind = question["kind"]
    if kind == "locate":
        building_map.located_asset_ids = [answer["asset_id"]]
        return ""
    if kind == "count":
        floor_level = answer["floor_level"]
        matches = [
            asset
            for asset in building_map.assets.values()
            if asset["type"] == answer["asset_type"]
            and building_map.floors[asset["floor_id"]]["level"] == floor_level
        ]
        return str(len(matches))
    if "closed_element_id" in answer:
        building_map.set_closed(answer["closed_element_id"], closed=True)
    try:
        if kind == "tour":
            stops = answer["stops"]
            building_map.route(stops[0], stops[-1], via=stops[1:-1])
        else:
            building_map.route(
                answer["from_space_id"], answer["to_space_id"], step_free=kind == "route_step_free"
            )
    except MapError:
        building_map.last_route = None
    return ""


def evaluate(directory: Path, limit: int | None, oracle: bool) -> None:
    results: Counter[tuple[str, bool]] = Counter()
    usage: Counter[str] = Counter()
    client = None if oracle else anthropic.Anthropic()
    walks_cache: dict[Path, dict] = {}
    for building_directory, question in load_questions(directory, limit):
        building_map = BuildingMap.load_cached(building_directory, walks_cache)
        if oracle:
            reply = oracle_answer(question, building_map)
        else:
            agent = BuildingAgent(building_map, OUTPUT_DIRECTORY, client)
            try:
                reply = agent.ask(question["question"])
            except anthropic.APIError as error:
                print(f"[eval] {question['id']}: API error {error}")
                reply = ""
            usage.update(agent.usage)
        correct = score(question, building_map, reply)
        results[(question["kind"], correct)] += 1
        print(f"[eval] {question['id']:40s} {question['kind']:20s} {'OK ' if correct else 'BAD'}")
    report(results, usage)


def report(results: Counter[tuple[str, bool]], usage: Counter[str]) -> None:
    kinds = sorted({kind for kind, _ in results})
    total_correct = sum(count for (_, correct), count in results.items() if correct)
    total = sum(results.values())
    print("\nkind                  correct / total")
    for kind in kinds:
        print(f"  {kind:20s} {results[(kind, True)]:4d} / {results[(kind, True)] + results[(kind, False)]}")
    print(f"  {'all':20s} {total_correct:4d} / {total}")
    if usage:
        print(f"tokens: {dict(usage)}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="starter_agent.evaluate")
    parser.add_argument("directory", type=Path, help="a split directory such as data/dev")
    parser.add_argument("--limit", type=int, default=None, help="only the first N questions")
    parser.add_argument("--oracle", action="store_true", help="answer with the tools directly (no API calls)")
    arguments = parser.parse_args()
    evaluate(arguments.directory, arguments.limit, arguments.oracle)


if __name__ == "__main__":
    main()
