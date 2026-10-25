# Benchmark

A Claude agent answers every question. It works out what is being asked and calls tools on the building, and those tools compute every number. One command, no manual steps.

## 1. Setup (once)

Install [uv](https://docs.astral.sh/uv/). It also installs Python 3.12 if needed.

| OS | Command |
|---|---|
| macOS / Linux | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Windows (PowerShell) | `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 \| iex"` |

Open a new terminal, go to the repository root, and run:

```
uv sync
```

Create a file named `.env` in the repository root containing your Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

An `ANTHROPIC_API_KEY` environment variable works too.

## 2. Run

One call per building. `<building_dir>` is a building in the kit format: `building.json`, its floor plans and `questions.jsonl`.

```
uv run run_benchmark <building_dir> [answers.json]
```

`answers.json` is a JSON list with one `{"question_id": ..., "answer": ...}` per question. `answer` is the agent's reply, ending in `Answer: <value>`. Entries with the same `question_id` are replaced and all others kept, so repeated calls build up one file. The default is `SUBMISSION/answers.json`.

**Secret building:** pass a fresh output file, e.g. `uv run run_benchmark path/to/secret-building secret_answers.json`.

**Our submission** (`SUBMISSION/answers.json`, 145 test questions): one call for each folder in `data/test`, e.g. `uv run run_benchmark data/test/swiss-2`.

The full entries (question kind, the agent's tool calls, tokens) are written to `agent_output/benchmark/<building>.jsonl`. Questions run 8 at a time; a building takes under a minute and about $0.25.

**Without uv:** with Python 3.12 or later, from the repository root:

```
python -m venv .venv
.venv\Scripts\activate          (Windows)
source .venv/bin/activate       (macOS / Linux)
pip install -e .
run_benchmark <building_dir> [answers.json]
```

## How it answers

Each question gets its own Claude Opus 5.5 run with tool use ([agent/answer.py](../agent/answer.py)). There are no question templates: the agent reads the text, chooses the tools, and fills in their parameters.

| Tool | What it does |
|---|---|
| `find`, `list_spaces`, `list_assets` | Turn names, room numbers and types into ids. `list_spaces` also gives counts, areas and totals |
| `space_details` | One room: area, centroid, doors with widths and ids, stairs and lifts, contents, the rooms directly above and below, the rooms sharing a wall |
| `route` | Best route through stops. Each stop is a list of candidates, so "the nearest toilet" works. Supports step-free, closed elements, forklift and load width |
| `reachable_rooms` | Rooms reachable from a start under the same constraints |
| `what_if_door` | Adds a hypothetical door, then counts the rooms whose walk out of the building gets more than 1 m shorter |
| `straight_line_distance`, `calculate` | 3D distance between room centres; exact arithmetic |
| `submit_answer` | Commits the reply and its `Answer:` value, with the room, item and route behind it (routes by reference, so they come from the router, not from model text) |

The tools run on the deterministic core in [core/](../core/), which also powers the app. They follow the judges' rules (kit 1.1.0):
- walking is door to door, 15 cm off the walls
- stairs cost 2 m per metre climbed; a lift costs 15 m plus 1 m per metre
- there is no way round the outside, and closed elements are never used
- a route to an item or a room type ends in the nearest room that holds or matches it
- forklifts use only openings of at least 3 m, no stairs or lifts. Production bays (`production_zone`, `assembly_zone`, `additive_zone`) can be a destination but are never driven through. Which halls count as bays is our assumption.

## Results

Dev buildings, the answers scored with the kit's `benchmark/score.py`:

| Building | Correct |
|---|---|
| osm-way360544293 | 4 / 4 |
| proc-campus-dev-009 | 5 / 5 |
| proc-factory-dev-011 | 6 / 6 |
| resplan-1677 | 4 / 4 |
| swiss-450 | 4 / 4 |

Before that, on all warm-up and benchmark questions of four other dev buildings (route, element path and length compared too): proc-factory-dev-003 15 / 15, osm-way22744230 19 / 19, osm-way27326387 15 / 15, osm-way27917482 18 / 19. The one miss names a room whose name and number appear on three rooms of one floor; the text can't tell them apart.

With the ids from the kit's answers, the tools themselves reproduce every train and dev answer (`tests/test_benchmark_run.py`).

Tests (no API calls): `uv run pytest tests -q`.
