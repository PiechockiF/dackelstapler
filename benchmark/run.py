"""Benchmark: answer the questions about one building and add them to answers.json.

  uv run run_benchmark <building_dir> [answers.json]

<building_dir> is one building in the kit format: building.json, its floor plans and questions.jsonl. A Claude
agent (agent/answer.py) answers every question with tools over the building; questions run in parallel.

answers.json is a JSON list of {"question_id", "answer"}, `answer` being the agent's reply ending in an
'Answer:' line. Entries for this building's question ids are replaced and all others kept, so one call per
building builds up the file for a whole split. Default: SUBMISSION/answers.json, the file the organizers grade.
The full entries (kind, tool trace, tokens) go to agent_output/benchmark/<building>.jsonl.
Needs ANTHROPIC_API_KEY, from the environment or a .env file in the repository root."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv

from agent.answer import answer_entry

WORKERS = 8  # questions answered at once
REPO = Path(__file__).resolve().parent.parent
QUESTIONS_FILE = "questions.jsonl"
DEFAULT_ANSWERS = REPO / "SUBMISSION" / "answers.json"  # graded file: SUBMISSION/ holds BENCHMARK.md and this
LOG_DIRECTORY = REPO / "agent_output" / "benchmark"


def find_building(path: Path) -> Path:
    """The directory with building.json: the path itself, the folder of a building.json path, or the only
    building below it (an unpacked release)."""
    if path.is_file():
        return path.parent
    if (path / "building.json").exists():
        return path
    found = sorted(path.rglob("building.json"))
    if len(found) != 1:
        raise SystemExit(f"run_benchmark: expected one building.json in {path}, found {len(found)}")
    return found[0].parent


def load_questions(building: Path) -> list[dict]:
    path = building / QUESTIONS_FILE
    if not path.is_file():
        raise SystemExit(f"run_benchmark: no {QUESTIONS_FILE} in {building}")
    return [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]


def merge(path: Path, answers: list[dict]) -> list[dict]:
    """The answers already in `path` minus this run's question ids, then this run's answers."""
    existing = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    new_ids = {entry["question_id"] for entry in answers}
    return [entry for entry in existing if entry["question_id"] not in new_ids] + answers


def run(building_dir: Path, answers_path: Path | None = None) -> list[dict]:
    building = find_building(building_dir)
    questions = load_questions(building)
    answers_path = answers_path or DEFAULT_ANSWERS
    print(f"[run_benchmark] {building.name}: {len(questions)} questions", flush=True)

    def answer_one(question: dict) -> dict:
        try:
            entry = answer_entry(building, question["question"])
        except Exception as error:  # noqa: BLE001 - one bad question must not stop the run
            entry = {"kind": None, "error": f"{type(error).__name__}: {error}",
                     "answer": f"I could not answer this ({error}).\nAnswer: unknown"}
        status = "ok" if "error" not in entry else f"ERROR {entry['error'][:100]}"
        print(f"[run_benchmark] {question['id']}  {entry.get('kind') or '?':20s} {status}", flush=True)
        return {"question_id": question["id"], "question": question["question"], **entry}

    with ThreadPoolExecutor(WORKERS) as pool:
        entries = list(pool.map(answer_one, questions))
    LOG_DIRECTORY.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIRECTORY / f"{building.name}.jsonl"
    log_path.write_text("".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in entries), encoding="utf-8")
    answers = [{"question_id": entry["question_id"], "answer": entry["answer"]} for entry in entries]
    answers_path.parent.mkdir(parents=True, exist_ok=True)
    merged = merge(answers_path, answers)
    answers_path.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    usage = Counter()
    for entry in entries:
        usage.update(entry.get("usage") or {})
    failed = sum("error" in entry for entry in entries)
    print(f"tokens: {dict(usage)}")
    print(f"{len(answers) - failed} / {len(answers)} answered for {building.name}; "
          f"{len(merged)} answers in {answers_path}; full entries in {log_path}")
    return answers


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="run_benchmark", description=__doc__.splitlines()[0])
    parser.add_argument("building_dir", type=Path, help="folder with building.json and questions.jsonl")
    parser.add_argument("answers", type=Path, nargs="?", default=None,
                        help="answers file to add to (default: SUBMISSION/answers.json)")
    arguments = parser.parse_args(argv)
    load_dotenv(REPO / ".env")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("run_benchmark: set ANTHROPIC_API_KEY (in the environment or in .env at the repository root)")
    sys.stdout.reconfigure(errors="replace")  # room names in the log must not crash a non-UTF-8 console
    run(arguments.building_dir, arguments.answers)


if __name__ == "__main__":
    main()
