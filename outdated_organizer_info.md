# Talk to Your Building: Agent-First Indoor Navigation

**Industrial Agents Hackathon 2026**, in cooperation with UVC Partners and Anthropic. This is the student kit for Track 01.

## The story

You have walked into an office complex or a factory hall and had no idea where to go. Outdoors we solved this long ago: type where you want to be, and a map shows the way. Indoors, floor plans are PDFs, machines live in spreadsheets, and the one person who knows where the 3D printer is has gone home.

**Your mission:** give any building its own map you can talk to. Feed your system a floor plan and it learns the building. Then anyone can just talk to it.

A factory hall is a building that never stops changing. Machines move, aisles get blocked, deliveries arrive every hour. Think of the people who ask:

- **Service technician:** *"Which of the three presses is line 4, and how do I get there?"*
- **Forklift driver:** *"Aisle 4 is blocked. Fastest route to dock B?"*
- **Logistics:** *"Where is the steel drum delivered yesterday?"*

Questions your agent should answer:

- **Find:** *"Where is the 3D printer?"*
- **Route:** *"How do I get from the lobby to the CNC mill on floor 2 without stairs?"*
- **Edit:** *"Add a door between rooms 2.03 and 2.04."*
- **React:** *"The east lift is closed for maintenance. What changes?"*

## What you build

An app you talk to. It shows 2D or 3D views of buildings and floors, animated routes, and the things inside: rooms, desks, machines, equipment. It works for an existing building and can set up a new one quickly from floor plans.

The **agent** is the interaction layer: you say what you want and the system does it. The **core** underneath is mostly deterministic: a graph of rooms, doors, corridors, stairs and lifts, and a search that finds the best route.

This kit has everything you need to start. No company data and no NDA; everything is public or generated.

- **Data:** 280 buildings with floor plans, equipment lists and plan images.
- **Questions:** train and dev questions with answers, and the test questions you are scored on (without answers).
- **A working starter agent** built on the Claude API.
- **A scorer**, so you can measure yourself on dev before you submit.

Credits for Claude, Lovable and ElevenLabs come via the organizers. UX and voice can play a real role: a voice-in, voice-out agent counts towards Interaction.

---

## 1. The challenge

### Levels (each builds on the previous)

Every level earns points and builds on the one before, so a team that stops early still has something that works. This is the floor, not the ceiling: hit it first, then surprise us.

1. **Locate:** on one floor, talk to the agent, find things and see them on a view.
2. **Route:** A to B on one floor, with step-free routes, closed areas and multi-stop tours.
3. **Scale:** several floors, then several buildings, with stairs, lifts and walkways between them.
4. **Build:** create or update a building from floor plans, by conversation. A new building should take minutes, not days.
5. **Extend (optional, pick one and do it well rather than three badly):**
   - **Make things move:** tools or machines that change place via barcode, RFID or "this is now here", so the map stays current.
   - **Several users:** colleagues update the building while others ask questions.
   - **Industrial logistics:** route forklifts and materials through a hall with blocked aisles and delivery points.
   - **Capture on site:** build a new building by walking through it with a phone instead of starting from a floor plan.
   - **Accessibility:** wider doors, step-free and quiet routes.
   - **Presentation:** isometric stacked floors, animated routes, voice in and out.
   - **AR:** the route as an overlay on your phone. The hard part is knowing where you are (QR codes at doors, WiFi, other tricks).

   Or surprise us.

### Directions, not instructions

How you get there is up to you. A few directions that save hours:

- **Think in a graph.** Rooms and junctions are nodes; doors, corridors, stairs and lifts are edges; Dijkstra or A* finds the route. Agree on the data model in your first hour.
- **One floor first.** Make one question work end to end before 3D or a pretty interface. A flat 2D plan with the route drawn on it is a fine start; three.js gets you extruded floors later.
- **Spend your time on decisions.** AI writes most of the code, so think about the user: what should the agent ask when a request is vague? How does it show what it understood before it changes a plan? "Turn left at the printers" or room numbers?

### Put yourself in their shoes

Design for people, not for the jury. Would you trust this agent in a building you have never been in?

| Who | What they need |
|---|---|
| First day at work | Knows no room names. Asks "where do I get coffee?" |
| Wheelchair user | Step-free routes and wide doors, every time, without asking twice. |
| Service technician | Hands full, phone in pocket. Wants voice and "turn left at the press". |
| Facility manager | Moves a machine, closes a lift, adds a door. The map must keep up. |

Use what is possible today: voice in and out, an agent that asks back, showing what it understood, live updates from a scan, AR on the phone, directions people can follow.

### Judging

Three things count, in this order: does it work, is it a pleasure to use, and what did you add that we did not ask for.

| Part | Points | What counts |
|---|---|---|
| Does it work | 55 | The Sunday benchmark plus automatic checks on buildings and questions you have not seen (levels 1–4): correct answers, valid routes, route length vs. the best route, buildings built correctly from plans. **Your test-set submission (section 6) is part of this.** |
| Interaction | 25 | A short scripted conversation with tricky users, rated on a rubric. Does it ask only what it needs, show what it understood, and give directions a person can follow? Voice counts here. |
| Creativity | 10 | Level 5 and add-ins: anything that makes the product better in a way we did not think of. |
| Submission demo | 10 | Your demo video and technical explanation: clear, convincing, and showing the real product. |

### Sunday benchmark

Shortly before code freeze, we release one new building nobody has seen, plus a question file. Your agent has to answer them, including the best routes. Don't tune to the test buildings. Build something that works on any building in this format.

- **Your run:** a single command in your repo, documented in `BENCHMARK.md`, with no manual steps between input and output.
- **Submission:** you run it yourselves and submit the output with your project. We may re-run your command on the same input to verify.
- **Scoring:** correct answers, valid routes and route length against the best route.

The exact release time and the file format for the Sunday building will be announced with the release.

### Submission and judging process

There are no pitch rooms. All teams submit online by code freeze through the organizers' platform:

1. A demo video of your app in action.
2. A short technical explanation (architecture and tech stack).
3. Your repository, including `BENCHMARK.md` and your answers file.

We review all Track 01 submissions and pick four finalists. Finalists present at the joint final pitch session at Tacto: 3 minutes plus 1 minute Q&A per team.

---

## 2. What's in the kit

```
README.md                  this file
ATTRIBUTION.md             data sources and licences (read before you share anything)
pyproject.toml             Python project for the starter agent and the scorer (uv or pip)
.env.example               copy to .env and add your ANTHROPIC_API_KEY
starter_agent/             a working example agent (Claude + tools); its own README explains it
benchmark/                 score.py (the official scorer) and evaluate.py (runs an agent, writes the submission)
data/
  manifest.csv             one row per building: split, source, licence, size, lifts, stairs, ...
  train/<building_id>/     200 buildings: plan, equipment, images, questions with answers
  dev/<building_id>/       40 buildings: same as train; use for self-evaluation
  test/<building_id>/      40 buildings: plan, equipment, images, questions WITHOUT answers
  test/questions.csv       all 145 test questions in one table
  test/submission_template.csv   question_id,answer with every test id, ready to fill in
```

Each building directory contains:

| File | What it is |
|---|---|
| `building.json` | The plan in the common format (section 3) |
| `equipment.csv` | One row per piece of furniture, fixture, machine or piece of equipment |
| `floor_<level>.png` / `.svg` | Plan with furniture |
| `floor_<level>_plain.png` | Plan without furniture |
| `questions.jsonl` | Benchmark questions. Answers are included in train and dev, not in test. |
| `questions_basic.jsonl` | Warm-up questions with answers (train and dev only) |

| Split | Buildings | Benchmark questions | Warm-up questions |
|---|---|---|---|
| train | 200 | 517 | 1,761 |
| dev | 40 | 138 | 369 |
| test | 40 | **145 (this is what you submit)** | – |

The buildings come from four sources:
- **Swiss Dwellings:** multi-floor residential buildings.
- **ResPlan:** single-floor homes.
- **OpenStreetMap indoor data for Munich:** TUM buildings, Munich Airport Terminal 2, Pasing Arcaden and others.
- **Procedural:** generated factories (production halls with machines, loading docks, office blocks) and campus buildings (lecture halls, labs, cores with stairs and lifts).

Test procedural buildings use layouts that train never sees: bigger halls, L-shaped wings, basements and more cores.

---

## 3. Data format

### Conventions

- **Units:** all coordinates are **metres** in a local frame, x to the right and y up.
- **One XY frame per building.** All floors share it, so floors stack. One exception: some Swiss Dwellings floors are centred per floor rather than aligned.
- **Floors:** `level` is an integer: 0 is the ground floor, -1 the first basement, 1 the first upper floor.
- **Outside:** an opening whose `space_ids` contain `"outside"` is an entrance.
- **Synthetic parts:** `synthetic: true` marks things this dataset added that weren't in the source data. Examples are recovered stair halls in Swiss Dwellings, lifts mapped only as a point in OSM, and doors guessed where OSM had none.

### `building.json`

```jsonc
{
  "building": { "id": "proc-factory-dev-003", "name": "Fertigung Ost 27", "source": "procedural",
                "source_ref": {...}, "license": "CC0-1.0", "attribution": "...", "split": "dev", "units": "m" },
  "floors": [ { "id": "proc-factory-dev-003-F0", "level": 0, "name": "Ground floor",
                "elevation_m": 0.0, "height_m": 8.0 } ],
  "spaces": [ { "id": "proc-factory-dev-003-F0-S021", "floor_id": "proc-factory-dev-003-F0",
                "type": "room",                 // room | corridor | stair | lift | hall | outdoor
                "room_type": "quality_lab",     // office, lab, toilet, production_zone, ... (see below)
                "name": "Quality lab 0.21", "ref": "0.21",
                "polygon": [[2.0, 10.5], [6.5, 10.5], [6.5, 15.0], [2.0, 15.0]],   // outline, not closed
                "synthetic": false } ],
  "openings": [ { "id": "proc-factory-dev-003-F0-O0035", "floor_id": "proc-factory-dev-003-F0",
                  "space_ids": ["...-S030", "...-S016"],   // the two spaces it joins; "outside" for entrances
                  "kind": "door",                          // door | opening (no door leaf) | entrance
                  "position": [12.4, -5.0], "width_m": 0.9, "step_free": true, "synthetic": false } ],
  "vertical_connectors": [ { "id": "...-V02", "kind": "lift",     // stairs | lift
                             "name": "Office lift",
                             "floor_ids": ["...-F0", "...-F1"],     // one stop per floor...
                             "space_ids": ["...-F0-S004", "...-F1-S004"],   // ...and the space it stops in
                             "step_free": true, "synthetic": false } ],
  "assets": [ { "id": "...-A00117", "name": "Coordinate measuring machine 0.21",
                "category": "machine",          // furniture | fixture | machine | equipment
                "type": "coordinate_measuring_machine",
                "space_id": "...-F0-S021", "floor_id": "...-F0",
                "position": [2.941, 12.964],
                "footprint": { "width_m": 2.0, "depth_m": 1.5, "rotation_deg": 90.0 },
                "source": "generated" } ]       // dataset = from the source data, generated = placed by rules
}
```

Notes:
- **Space names and refs:** `name` usually includes the room number (`ref`). Refs are unique per building for generated and Swiss/ResPlan buildings. OSM refs come from the map, and a few rooms share names such as "WC".
- **Room types** include: `bedroom`, `living_room`, `kitchen`, `bathroom`, `toilet`, `storage`, `corridor`, `balcony`, `stairwell`, `lift`, `office`, `meeting_room`, `seminar_room`, `lecture_hall`, `lab`, `makerspace`, `library`, `server_room`, `technical_room`, `lobby`, `canteen`, `shop`, `print_room`, `locker_room`, `production_zone`, `additive_zone`, `assembly_zone`, `warehouse_zone`, `logistics_zone`, `quality_lab` and `generic_room` (an OSM room with no type tag).
- **Door widths:** `width_m` matters for moving wide loads such as trolleys, pallets or beds. Swiss Dwellings and ResPlan widths come from the drawings. Procedural doors are 0.9 m for offices, 1.1 m for lifts, 1.2 m for labs, seminar rooms, meeting rooms, libraries, toilets and stairwells, and 1.6 m double doors for halls, storage, server and technical rooms. OSM doors default to 0.9 m.
- **Step-free:** `step_free: false` means steps, such as a stair connector or an entrance with steps.
- **Stairs and lifts:** a connector joins its stop spaces floor to floor in the order of their levels.
- **Asset names** are unique within a building, e.g. `Desk 2.03-B` is the second desk in room 2.03.

### `equipment.csv`

`asset_id, name, type, category, source, building_id, floor_level, floor_name, space_id, space_name, room_ref, room_type, x_m, y_m, width_m, depth_m, rotation_deg`. This is the same information as `assets` in `building.json`, flattened.

### `manifest.csv`

`building_id, split, source, group_id, name, license, floors, levels, spaces, rooms, openings, connectors, assets, has_stairs, has_lift, has_step_free_entrance, questions, path`. `path` is relative to `data/`. `group_id` prevents leakage between splits: buildings from one site are all in the same split.

### The route model behind the expected answers

Route lengths in the answers come from this graph, so your router reproduces them if you build the same one:

- **Nodes:** one per space, anchored at shapely's `Polygon(space.polygon).representative_point()`, plus one node per opening at its `position`.
- **Edges:** each space connects to each of its openings, weighted by the straight-line distance from the anchor to the opening.
- **Stairs:** 12 m per floor between consecutive stops. **Lifts:** a 15 m wait plus 6 m per floor.
- **Step-free routing** drops every edge with `step_free: false`.
- **Parallel connections:** a stair and a lift can join the same two spaces. Keep both; a simple graph would drop one.
- **Outside:** all entrances meet at one `"outside"` node at zero cost, so a route may go out one entrance and back in another for free. The benchmark questions only use cases where this shortcut makes no difference.

`starter_agent/building_map.py` implements exactly this model.

---

## 4. Questions

### Warm-up questions (`questions_basic.jsonl`, train and dev)

One search or one route each. Every line is `{"id", "building_id", "kind", "question", "answer"}`:

| Kind | Example | Answer fields |
|---|---|---|
| `locate` | "Where is the coordinate measuring machine?" | `asset_id`, `space_id`, `space_name`, `floor_level`, `position` |
| `count` | "How many chair items are on the floor 2?" | `count`, `asset_type`, `floor_level` |
| `route` | "How do I get from Office 0.30 (Ground floor) to Office 0.46 (Ground floor)?" | `from_space_id`, `to_space_id`, `optimal_length_m`, `space_path`, `element_path` |
| `route_step_free` | "Is there a step-free route from … to …?" | Same as route, or `reachable: false` |
| `route_with_closure` | "Lift 1 is closed for maintenance. How do I get from … to …?" | Route fields plus `closed_element_id`, or `reachable: false` |
| `tour` | "Starting at …, visit … then … in this order." | `stops`, `optimal_length_m`, `legs` |

### Benchmark questions (`questions.jsonl`; this is what is scored)

There are two groups.

- **Plan facts.** These need facts that a simple search-and-route agent never looks at, mainly **room areas** (from the polygons) and **door widths**. Most combine them with routing, step-free constraints or reachability.
- **Spatial reasoning.** These need the geometry itself: how floors stack in 3D, which walls rooms share, where room centres are, and what a change to the building would do across a whole floor. Exposing one more field isn't enough; your agent has to reason with polygons, coordinates and elevations.

| Kind | Example |
|---|---|
| `largest_room` | "Which is the largest kitchen on the floor 1, and how big is it in m²?" |
| `floor_area_total` | "Facilities want the total floor area of every office on the ground floor added together. How many square metres is that?" |
| `errand` | "I'm in Server room 0.42. I need to grab a stove from the room that has one closest to me, then carry it to the largest meeting room on the floor 1. I can carry it on the stairs. How far will I walk in total, in metres?" |
| `wide_delivery_count` | "I'm moving a 1.1 m wide trolley. It can't go on stairs or steps (lifts are fine), and every door it passes through must be at least 1.1 m wide. It arrives through the entrance into Lobby 0.01. Into how many rooms on the floor 2 can it be delivered?" |
| `step_free_reachable_count` | "Lift 1 is out of service. A wheelchair user comes in through the entrance into …. How many rooms on the floor 3 can they still reach?" |
| `room_stacked` | "There's water dripping from the ceiling in Office 0.29 (Ground floor). Which room is directly above it?" or "A washing machine is leaking onto the floor of Bathroom 2.04 (Floor 2). Which room directly below it will the water reach?" |
| `shared_walls_count` | "We're soundproofing Server room 1.14 (Floor 1). How many other rooms on that floor share a wall with it? Count every room whose wall runs along it for at least 1 m, with or without a door between them; corridors, stairwells and lifts don't count." |
| `straight_line_3d` | "We're planning a wireless sensor link between Lab 0.12 (Ground floor) and Office 3.07 (Floor 3). What is the straight-line distance in metres between the centres of the two rooms (each room's floor-plan centroid, at its floor's elevation)?" |
| `what_if_door` | "What if we add a door between Corridor 0.01 and Lecture hall 0.21 (Ground floor), in the middle of the wall they share? How many rooms on the floor 3 would then have a shorter walk out of the building, to their nearest entrance, by more than 1 m?" |

Precise definitions for the spatial questions:
- **Directly above / below:** the space on the next floor up or down whose outline covers most of this room's outline. These questions only use buildings whose floors share one XY frame (procedural and OSM).
- **Sharing a wall:** at least 1 m of one room's outline runs within 0.35 m of the other room's outline (walls have thickness).
- **Room centre:** the centroid of the room polygon, at the floor's `elevation_m`.
- **What-if door:** placed at the middle of the shared wall, and walked like any other door, between any two rooms, halls or corridors. The question is about a different floor than the door's. "Walk out of the building" is the route-model distance (section 3) to the nearest entrance.

Each question ends with an answer instruction such as *"Finish with a line 'Answer: <number>'"*.

**Train and dev lines** also contain `skill`, the `inputs` behind the question, and the `answer`. Study them, and use them to test your tools.

**Test lines** contain only `id`, `building_id`, `kind` and `question`.

The answers are well defined. The right room always beats the runner-up by a clear margin, every constraint actually changes the answer, and the largest room is never simply the room with the most furniture. Don't hard-code anything: the questions are generated, and new ones work the same way.

---

## 5. Quick start

You need Python 3.12+ and [uv](https://docs.astral.sh/uv/) (or pip), plus an Anthropic API key.

```bash
uv sync
cp .env.example .env        # then put your key in .env
uv run --env-file .env python -m starter_agent data/dev/proc-factory-dev-003
```

Measure yourself on **dev** before you touch the test set:

```bash
# warm-up questions, tools only, free:
uv run python -m starter_agent.evaluate data/dev --oracle
# benchmark questions with the starter agent (uses credits; about $0.10–0.25 per question):
uv run --env-file .env python -m benchmark.evaluate data/dev --per-kind 3
# your own agent:
uv run --env-file .env python -m benchmark.evaluate data/dev --agent my_agent:answer
```

`--agent module:function` takes a function `answer(building_directory: Path, question_text: str) -> str` that returns your agent's full reply.

The starter agent scores **under 5% on the benchmark questions**. That is deliberate: its tools don't expose room areas, door widths or reachability, and it shows you where to start. See `starter_agent/README.md` for how it works and ideas to extend it.

---

## 6. Submission format

Submit **one CSV file** with exactly these two columns:

| Column | Content |
|---|---|
| `question_id` | The `id` of a test question, e.g. `osm-way363805324-H01` |
| `answer` | Your agent's **full reply** to that question. It may run over several lines, as long as it is quoted the normal CSV way. |

```csv
question_id,answer
proc-campus-test-000-H01,"The largest seminar room on the ground floor is Seminar room 0.32.
Answer: Seminar room 0.32, 61.4 m²"
proc-campus-test-000-H02,"I added up the 12 offices on floor 1.
Answer: 214.7"
```

Writing the file is easiest with the evaluator. It runs your agent on every test question and saves the CSV:

```bash
uv run --env-file .env python -m benchmark.evaluate data/test --agent my_agent:answer --submission-csv team_<name>.csv
```

`data/test/submission_template.csv` lists every test id, if you would rather fill it in another way. The file must be UTF-8 with a header row and at most 5 MB.

### How it is scored

Only the **last line of the reply that starts with `Answer:`** counts. `**Answer:**` in Markdown is fine.

| Answer type | Correct when |
|---|---|
| A room (`largest_room`) | The answer line names the expected room by its number or full name, **before** any runner-up room, and includes the area in m² within **±5%** |
| A distance in metres (`errand`) | The answer line holds **exactly one number**, within **±1%** (at least ±1 m) of the optimal length |
| An area in m² (`floor_area_total`) | Exactly one number, within **±5%** |
| A count (`wide_delivery_count`, `step_free_reachable_count`, `shared_walls_count`, `what_if_door`) | Exactly one number, **exactly** right |
| A room (`room_stacked`) | The answer line names the expected room, before any runner-up room |
| A 3D distance (`straight_line_3d`) | Exactly one number, within **±2%** |

A reply with no `Answer:` line is wrong. So is an answer line with a range or several numbers ("between 92 and 108 m"). Missing questions count as wrong. Rows with unknown ids are ignored, and if an id appears twice the first row counts. Your score is the share of the 145 test questions answered correctly. Judges also see the result per question kind.

`benchmark/score.py` is the exact scorer the judges use. Run it on dev to check your formatting.

---

## 7. Rules and tips

- **Generated answers only:** answers must come from your agent running on the data, not from hand-labelling test questions.
- **The Sunday building** arrives in the same format. Anything you hard-code to the test buildings will fail there.
- **Start small:** get the route graph right first (section 3). Check it against the warm-up answers on dev; the route lengths should match to the centimetre.
- **Expose the data:** give your agent tools for what the plans actually contain (areas, door widths, adjacency, reachability, positions), not only search.
- **Watch your costs:** each question can take many tool calls. Keep tool results compact, and use prompt caching for the building context.

## 8. Licences

The data comes under several licences: CC BY 4.0 (Swiss Dwellings, ResPlan), ODbL 1.0 (the OpenStreetMap buildings) and CC0 (procedural). See `ATTRIBUTION.md`. If you publish anything built from the OSM buildings, it must stay under the ODbL and credit OpenStreetMap contributors.
