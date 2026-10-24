"""Sunday benchmark: answer a question file about one building and write answers.json.

  uv run run_benchmark <building_dir> [questions.json] [answers.json]
  uv run python -m benchmark.run <building_dir> [questions.json] [answers.json]     (same thing)

Without a questions file it uses the questions.json/.jsonl/.csv next to the building; a questions file name
that isn't found where you run the command is also looked up there. Answers default to ./answers.json.

A Claude agent (agent/answer.py) answers every question with tools over the building; questions run in
parallel. One entry per question id, in the input's order: the kind, the full reply (`answer`, ending in an
'Answer:' line), the located item or room id, for routes the ordered space ids, the opening/stair/lift ids
and the length in metres, and the agent's tool calls. BENCHMARK.md lists every output field.
Needs ANTHROPIC_API_KEY, from the environment or a .env file in the repository root."""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv

from agent.answer import answer_entry

ID_KEYS = ("id", "question_id", "qid", "uid")
TEXT_KEYS = ("text", "question", "question_text", "prompt", "query", "q")
LIST_KEYS = ("questions", "items", "data", "entries")
WORKERS = 8  # questions answered at once
REPO = Path(__file__).resolve().parent.parent
QUESTION_FILES = ("questions.json", "questions.jsonl", "questions.csv")


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


def find_questions(given: Path, building: Path, name: Path | None) -> Path:
    """The questions file: `name` as given, else in the given folder or the building folder; with no name,
    the first of QUESTION_FILES in those folders."""
    folders = list(dict.fromkeys(folder for folder in (given if given.is_dir() else given.parent, building)))
    if name is not None:
        candidates = [name] + ([folder / name for folder in folders] if not name.is_absolute() else [])
    else:
        candidates = [folder / file for folder in folders for file in QUESTION_FILES]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise SystemExit("run_benchmark: no questions file found; tried " + ", ".join(str(c) for c in candidates))


def load_questions(path: Path) -> tuple[list[dict], str | None]:
    """Question entries from a JSON list, {"questions": [...]}, {id: text or entry}, JSON lines or CSV.
    Returns the entries and the list key (or "" for an id-keyed object, None for a plain list)."""
    raw = path.read_text(encoding="utf-8-sig")
    shape = None
    if path.suffix.lower() == ".csv":
        rows = csv.DictReader(io.StringIO(raw, newline=""))
        data = [{(key or "").strip().lower(): value for key, value in row.items()} for row in rows]
    else:
        try:
            data = json.loads(raw) if path.suffix.lower() != ".jsonl" else None
        except json.JSONDecodeError:
            data = None
        if data is None:
            data = [json.loads(line) for line in raw.splitlines() if line.strip()]
        has_list = isinstance(data, dict) and any(isinstance(data.get(key), list) for key in LIST_KEYS)
        if isinstance(data, dict) and not has_list and any(key in data for key in (*ID_KEYS, *TEXT_KEYS)):
            data = [data]  # a single question
        if isinstance(data, dict):
            shape = next((key for key in LIST_KEYS if isinstance(data.get(key), list)), "")
            data = data[shape] if shape else [
                {"id": key, **(value if isinstance(value, dict) else {"text": value})} for key, value in data.items()
            ]
    entries = []
    for index, item in enumerate(data):
        item = item if isinstance(item, dict) else {"text": str(item)}
        question_id = next((item[key] for key in ID_KEYS if item.get(key) not in (None, "")), f"Q{index + 1:03d}")
        text = next((item[key] for key in TEXT_KEYS if isinstance(item.get(key), str)), "")
        entries.append({"id": question_id, "text": text, "fields": item})
    return entries, shape


def run(building_dir: Path, questions_path: Path | None = None, answers_path: Path | None = None) -> list[dict]:
    building = find_building(building_dir)
    questions_path = find_questions(building_dir, building, questions_path)
    answers_path = answers_path or Path("answers.json")
    print(f"[run_benchmark] {building.name}: questions from {questions_path}", flush=True)
    entries, shape = load_questions(questions_path)

    def answer_one(item: dict) -> dict:
        try:
            entry = answer_entry(building, item["text"], item["fields"])
        except Exception as error:  # noqa: BLE001 - one bad question must not stop the run
            entry = {"kind": None, "error": f"{type(error).__name__}: {error}",
                     "answer": f"I could not answer this ({error}).\nAnswer: unknown"}
        status = "ok" if "error" not in entry else f"ERROR {entry['error'][:100]}"
        print(f"[run_benchmark] {item['id']}  {entry.get('kind') or '?':20s} {status}", flush=True)
        return {"id": item["id"], "question": item["text"], **entry}

    with ThreadPoolExecutor(WORKERS) as pool:
        answers = list(pool.map(answer_one, entries))
    tally, usage = Counter(), Counter()
    for entry in answers:
        tally[(entry.get("kind") or "unknown", "error" not in entry)] += 1
        usage.update(entry.get("usage") or {})
    if shape is None:
        output: object = answers
    elif shape == "":
        output = {str(entry["id"]): {k: v for k, v in entry.items() if k != "id"} for entry in answers}
    else:
        output = {"answers": answers}
    answers_path.parent.mkdir(parents=True, exist_ok=True)
    answers_path.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("\nkind                  answered / total")
    for kind in sorted({kind for kind, _ in tally}):
        done, failed = tally[(kind, True)], tally[(kind, False)]
        print(f"  {kind:20s} {done:4d} / {done + failed}")
    print(f"tokens: {dict(usage)}")
    print(f"{len(answers)} answers for {building.name} written to {answers_path}")
    return answers


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="run_benchmark", description=__doc__.splitlines()[0])
    parser.add_argument("building_dir", type=Path, help="folder with building.json (or the building.json itself)")
    parser.add_argument("questions", type=Path, nargs="?", default=None,
                        help="questions file (JSON, JSON lines or CSV); default: the one in the building folder")
    parser.add_argument("answers", type=Path, nargs="?", default=None, help="where to write answers (default: answers.json)")
    arguments = parser.parse_args(argv)
    load_dotenv(REPO / ".env")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("run_benchmark: set ANTHROPIC_API_KEY (in the environment or in .env at the repository root)")
    sys.stdout.reconfigure(errors="replace")  # room names in the log must not crash a non-UTF-8 console
    run(arguments.building_dir, arguments.questions, arguments.answers)


if __name__ == "__main__":
    main()
