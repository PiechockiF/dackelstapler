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

## 2. Sunday benchmark

```
uv run run_benchmark <building_dir> [questions.json] [answers.json]
```

For example: `uv run run_benchmark data/test/swiss-2`. This example works on every OS. Quote paths that contain spaces.

| Argument | Content |
|---|---|
| `<building_dir>` | Folder containing `building.json` (kit format) |
| `[questions.json]` | Optional. JSON list, one entry per question: `{"id": "Q1", "text": "...", "constraints": {...}}`. `constraints` is optional (e.g. `step_free`, `closed`, `forklift`, `min_width_m`) and is passed to the agent with the question. JSON lines and CSV work too. If omitted, `questions.json`, `.jsonl` or `.csv` next to the building is used; a bare file name is also looked up there |
| `[answers.json]` | Optional, default `SUBMISSION/answers.json` (next to this file). Written as a JSON list, one entry per question id, in input order |

Each entry in `answers.json` has:

| Field | Content |
|---|---|
| `id` | Question id |
| `answer` | Reply, ending in `Answer: <value>` (`no route` when none exists) |
| `item_id`, `room_id` | Located item and the room holding it. For routes, `room_id` is the destination room |
| `route` | Ordered node ids: every space passed from start to destination, with each floor's stairwell or lift stop |
| `element_path` | Door, opening, stair or lift used for each step (`route[i]` → `route[i+1]`) |
| `length_m` | Route length in metres |
| `reachable` | `false` when no route exists under the rules |

Entries also carry `question`, `kind`, the constraints applied, `stops` and `legs` for multi-stop tours, `trace` (the agent's tool calls), `usage` (tokens), and `error` if a question can't be answered.

Questions run 8 at a time. 19 questions take about 30 seconds and cost under $1.

**Without uv:** with Python 3.12 or later, from the repository root:

```
python -m venv .venv
.venv\Scripts\activate          (Windows)
source .venv/bin/activate       (macOS / Linux)
pip install -e .
run_benchmark <building_dir> [questions.json] [answers.json]
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
| `submit_answer` | Commits the `Answer:` value, the room and item, and the route (by reference, so the ids in `answers.json` come from the router, not from model text) |

The tools run on the deterministic core in [core/](../core/), which also powers the app. They follow the judges' rules (kit 1.1.0):
- walking is door to door, 15 cm off the walls
- stairs cost 2 m per metre climbed; a lift costs 15 m plus 1 m per metre
- there is no way round the outside, and closed elements are never used
- a route to an item or a room type ends in the nearest room that holds or matches it
- forklifts use only openings of at least 3 m, no stairs or lifts. Production bays (`production_zone`, `assembly_zone`, `additive_zone`) can be a destination but are never driven through. Which halls count as bays is our assumption.

## Results

`run_benchmark` on all warm-up and benchmark questions of four dev buildings (factory and three OSM buildings, up to 7 floors), each field compared with the kit's answers (ids, counts, route, element path, length, no-route):

| Building | Correct |
|---|---|
| proc-factory-dev-003 | 15 / 15 |
| osm-way22744230 | 19 / 19 |
| osm-way27326387 | 15 / 15 |
| osm-way27917482 | 18 / 19 |

The one miss names a room whose name and number appear on three rooms of one floor; the text can't tell them apart.

With the ids from the kit's answers, the tools themselves reproduce every train and dev answer (`tests/test_benchmark_run.py`).

## Kit test set (CSV submission)

```
uv run --env-file .env python -m benchmark.evaluate data/test --agent agent.answer:answer --submission-csv results/team_sitetwin.csv
```

This writes `results/team_sitetwin.csv` (145 rows). Run the same command on `data/dev` without `--submission-csv` to score the replies.

Tests (no API calls): `uv run pytest tests -q`.
