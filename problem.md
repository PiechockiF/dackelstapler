# Open problems before submission

Status on 24 October 2026. Everything here was checked against the challenge PDF ("Talk to Your Building"), the kit README (`outdated_organizer_info.md`) and the organizer's Discord note on route scoring.

## What already works

| Check | Result |
|---|---|
| Python tests (`uv run pytest tests -q`) | 94 / 94 pass |
| Scored benchmark on dev | 138 / 138, under 1 s, no API key |
| Scored benchmark on train | 515 / 517. The two misses have duplicate room names on one floor |
| Test submission (`submission/team_sitetwin.csv`) | 145 answers, reproducible byte for byte, each with an `Answer:` line |
| Web app | `tsc` clean, `oxlint` no errors, production build passes |
| Chat with API key, the 4 PDF questions (Fertigung Ost 27) | FIND, ROUTE, EDIT and REACT all handled well. It asks back about rooms that don't exist and re-plans after a closure |

## What "benchmark" means

There are three different things:

1. **Scored test set (kit).** 145 questions of 9 kinds (`largest_room`, `floor_area_total`, `errand`, `wide_delivery_count`, `step_free_reachable_count`, `room_stacked`, `shared_walls_count`, `straight_line_3d`, `what_if_door`). We submit a CSV `question_id,answer`, which `benchmark/score.py` scores from the last `Answer:` line. **Done.**
2. **Warm-up questions** (`questions_basic.jsonl`, train and dev only): `locate`, `count`, `route`, `route_step_free`, `route_with_closure`, `tour`. Not scored in the kit, but these are the PDF's FIND and ROUTE questions. **Not supported (0 / 90).**
3. **Sunday benchmark.** One new building plus `questions.json`, run with one command. The output holds the located item or room id, the route as an ordered list of spaces, and its length. Routes are scored with the organizer's distance rule (below). **Not supported.**

---

## Problem 1: route scoring uses a different distance model than our router (critical)

### The organizer's rule (Discord)

- Walking distance is measured **inside each space, door to door, about 15 cm off the walls**. Paths go around corners, never through walls.
- **Stairs:** 2 m of walking per metre climbed. **Lift:** 15 m (waiting and doors) plus 1 m per metre of height.
- Furniture and machines are not obstacles; only room and aisle outlines count.
- A route to an item ends in the room or bay that holds it.
- **Without stairs:** lifts, ramps and doors only.
- **Forklift:** forklift aisles and openings ≥ 3 m only. Pedestrian walkways don't count.
- Closed or blocked areas must be avoided.
- **Factory production bays are destinations only:** you can drive in to deliver, not through as a shortcut.
- If no route exists under the rules, the correct answer is to say so.
- **Scoring:** the answer is the ordered list of spaces. Each step must go through a real door, opening, stair or lift, and the rules must hold. The organizers then measure the route with their rule; our distance numbers are ignored. Score = best length ÷ our length. Full marks within 1%; an invalid route scores 0.

### Where our router differs

`core/building_map.py` uses the kit's starter model unchanged:

| | Our router | Organizer rule |
|---|---|---|
| Inside a room | Straight lines from one fixed point per room (`representative_point`) to each door. Can cut through walls and detours through the middle of long corridors | Door to door, 15 cm inset, around corners |
| Stairs | 12 m per floor | 2 m per metre (about 6 m per 3 m floor) |
| Lift | 15 m + 6 m per floor | 15 m + 1 m per metre (about 18 m per 3 m floor) |
| Outside | Zero-cost `outside` node joins all entrances, so a route may leave and re-enter for free | Probably invalid, since every step must be a real door |
| Forklift, production bays | Not modelled | Aisles ≥ 3 m only; bays are destinations only |

### Measured impact

A prototype of the organizer rule (`/tmp/routeproto/proto.py`) re-scored the kit's 161 reachable dev warm-up routes, which our router reproduces exactly:

| Outcome | Routes | Score |
|---|---|---|
| Same space sequence | 109 | full |
| Different sequence, within 1% | 22 | full |
| Uses the free `outside` shortcut | 15 | probably 0 |
| Worse sequence | 15 | 0.30–0.98 |
| **Average** | 161 | **≈ 0.88** (a router matching the rule would score ≈ 1.0) |

Another 11 routes become unreachable without the outside shortcut, so under the new rules the answer for those is "no route".

Example: Toilet 0.16 → Kitchen 1.03 (proc-campus-dev-001). Our router takes Staircase 2, which measures 75 m under the organizer's rule. Staircase 1 measures 26 m.

### Do not break the 9 scored kinds

The kit's expected answers for `errand` and `what_if_door` were generated with the old model, and our 138 / 138 depends on it. Keep the old model for those solvers. Use the new rule for route answers only.

---

## Problem 2: the benchmark entry point can't answer FIND or ROUTE (critical)

`agent/answer.py` only has templates for the 9 scored kinds. On 90 dev warm-up questions (15 per kind) it answered **0**. Without a key the reply is "could not interpret". With `ANTHROPIC_API_KEY` set, the Haiku fallback returns "unknown kind unsupported", because it only maps onto the same 9 solvers.

The routing logic exists (the starter oracle scores 369 / 369), so this needs new templates and output fields, not new algorithms.

## Problem 3: no single Sunday command

The PDF asks for one command such as `run_benchmark <building_dir> <questions.json> <answers.json>`, documented in `BENCHMARK.md`. `benchmark.evaluate` only accepts a split folder of `*/questions.jsonl` files and writes a CSV. Also, the PDF says `answers.json` while the kit README says CSV, and the PDF still has TODOs for the schema. The safe choice is to write both.

## Problem 4: building from floor plans works for one floor only (Level 4)

Test: `proc-campus-dev-000/floor_0.png` uploaded with `preview=true` (Claude vision, about 32 s):

- Room and door counts were right: 28 / 28 spaces, 29 / 29 openings.
- Room types were wrong: 17 offices against the true 7, and it missed the toilets and kitchen. Names came out as bare numbers ("0.02" instead of "Office 0.02").
- Total area was about 15% low (849 vs 1002 m²) because no scale (`width_m`) was given.
- **One file per upload**, so a multi-storey building can't be built and stairs and lifts aren't linked across floors.
- It needs the API key.

The PDF scores "correct buildings built from plans" under the 55 points.

## Problem 5: voice is off

`ELEVENLABS_API_KEY` is empty and `/api/health` reports `voice: false`. Voice in and out counts toward Interaction (25 points).

## Problem 6: the no-key fallback chat misses edits

"Add a door between Office 1.03 and Office 1.04" is treated as a search for Office 1.04. The chat with the key handles it. This only matters if the key fails during the demo.

## Problem 7: repo cleanup

- There are 57 `* 2.*` duplicate files (macOS copy artefacts). 53 are identical to their originals. Four are **older** versions: `web/src/pages/SitePage 2.tsx`, `web/src/twin/Popover 2.tsx`, `web/src/twin/actions 2.ts` and `web/src/twin/uiStore 2.ts`. Delete them all.
- `web/ios/` is 136 MB, including `DerivedData`, and isn't gitignored. `oxlint` also scans it.
- A stray `ChatGPT Image 24 Oct 2026, 13_46_41.png` sits in the repo root, and `industrial-agents-hackathon-2026-ios-build.log` sits in the parent folder.

## Problem 8: submission items missing

- Demo video.
- Short technical explanation (architecture and tech stack). `docs/INTEGRATION.md` covers part of it.
- `README.md` still opens with the original plan instead of a description of the product.

## Lower priority

- Routes between buildings over walkways (Level 3) aren't supported, but the kit has no walkway data to test with.
- The 3D scene bundle (`TwinScene`) is 3.1 MB minified, which slows the first load.

---

## Plan

1. **New router** in `core/` following the organizer rule:
   - door-to-door geodesics inside each space polygon inset by 0.15 m, with per-space caching
   - stairs 2 m/m and lifts 15 m + 1 m/m, using floor `elevation_m`
   - no `outside` transit
   - closures, step-free, forklift (≥ 3 m aisles) and production bays as destinations only
   - an explicit "no route" answer
2. **New question kinds** in `agent/answer.py` (locate, count, route, step-free route, route with closure, tour) that return the item or room id, the ordered space list and the length.
3. **`run_benchmark <building_dir> <questions.json> <answers.json>`**, which also writes the CSV, documented in `BENCHMARK.md`.
4. **The app's routes use the same router.** Displayed routes then match what's scored, and the animated path goes around corners instead of through walls.
5. Keep the old model for the 9 scored kinds. Re-run dev, train and tests after every change.
6. Cleanup (Problem 7), the ElevenLabs key, multi-floor plan upload, then the demo video and the technical explanation.

## Questions for the organizers

1. Can a route leave through one entrance and come back in through another? If so, how is the outside distance counted?
2. Where does a route start and end inside the first and last room: the room centre (representative point or centroid), or the door?
3. Where inside a stairwell or lift space are the stairs or the lift door, for measuring the walk from the door?
4. Should a lift or stair space appear once per floor in the space list (as in the kit's `space_path`) or only once?
5. Which room types count as forklift aisles, pedestrian walkways and production bays? The kit data has no aisle, walkway or ramp types. The factory halls are `production_zone`, `assembly_zone`, `warehouse_zone`, `logistics_zone` and `additive_zone`. Will the Sunday building add new types?
6. Are `errand` and `what_if_door` answers still scored with the kit's route model?
7. What is the final schema of `questions.json` and `answers.json`, and is the CSV submission still required?

Until they answer, defaults: route starts and ends at the room's representative point, no outside shortcut, lifts and stairs listed once per floor.
