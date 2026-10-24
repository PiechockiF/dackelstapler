# Open problems before submission

Status on 24 October 2026. Everything here was checked against the challenge PDF ("Talk to Your Building"), the kit README (`outdated_organizer_info.md`) and the organizer's Discord note on route scoring.

## What already works

| Check                                                     | Result                                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Python tests (`uv run pytest tests -q`)                   | 94 / 94 pass                                                                                                         |
| Scored benchmark on dev                                   | 138 / 138, under 1 s, no API key                                                                                     |
| Scored benchmark on train                                 | 515 / 517. The two misses have duplicate room names on one floor                                                     |
| Test submission (`submission/team_sitetwin.csv`)          | 145 answers, reproducible byte for byte, each with an `Answer:` line                                                 |
| Web app                                                   | `tsc` clean, `oxlint` no errors, production build passes                                                             |
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

|                           | Our router                                                                                                                                                 | Organizer rule                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Inside a room             | Straight lines from one fixed point per room (`representative_point`) to each door. Can cut through walls and detours through the middle of long corridors | Door to door, 15 cm inset, around corners              |
| Stairs                    | 12 m per floor                                                                                                                                             | 2 m per metre (about 6 m per 3 m floor)                |
| Lift                      | 15 m + 6 m per floor                                                                                                                                       | 15 m + 1 m per metre (about 18 m per 3 m floor)        |
| Outside | Zero-cost `outside` node joins all entrances, so a route may leave and re-enter for free. Also, `SiteRoute.space_path` silently drops `outside`, so for 26 dev routes the list we'd submit jumps between two spaces that share no door: invalid whatever the organizers decide | Probably invalid: the note lists rooms, corridors, aisles, stairwells and lifts as spaces, not outside |
| Forklift | `min_width_m=3` already does it on kit data: office corridors and `Hall access` lobbies only connect through doors under 3 m, so only Main aisles and halls remain | Aisles and openings ≥ 3 m only |
| Production bays | Not modelled. Hall-to-hall openings are 14–17 m wide, so forklift routes can cut through bays | Destinations only |

### Measured impact

A prototype of the organizer rule (`/tmp/routeproto/proto.py`: visibility graph inside each polygon inset by 0.15 m) re-scored the kit's warm-up routes (`route`, `route_step_free`, `route_with_closure`). Our router reproduces all 172 reachable dev routes node for node (re-checked 24 October), so these are the routes we would submit today:

| Outcome | dev | train | Score |
|---|---|---|---|
| Same space sequence | 130 | 673 | full |
| Different sequence, within 1% | 2 | 4 | full |
| Worse sequence | 14 | 17 | 0.36–0.98 |
| Uses `outside`, an indoor route exists | 15 | 42 | probably 0 |
| Uses `outside`, no indoor route exists | 11 | 69 | 0 if outside is forbidden (then the answer is "no route") |
| **Average** (outside counted as 0) | 172 | 805 | **0.82 / 0.86** (a router matching the rule would score ≈ 1.0) |

The routes that only work via outside are almost all Swiss apartment buildings (8 dev, 59 train) plus a few OSM ones.

Example: Toilet 0.16 → Kitchen 1.03 (proc-campus-dev-001). Our router takes Staircase 2, which measures 75 m under the organizer's rule. Staircase 1 measures 26 m (score 0.36).

### Can we check the 15 cm offset against known answers?

No. Nothing in the repo or the upstream kit (unchanged since 23 October) has lengths under the new rule. The test set has no answers, the train/dev `optimal_length_m` values come from the old model (our router matches them to the centimetre), and the PDF's promised example answer file never arrived.

What we can measure is whether the open assumptions change which route we pick. Base assumptions are a 0.15 m inset, routes starting and ending at the room's representative point, and stairs or lift at the stairwell's representative point. Each row grades our base pick under one changed assumption (161 dev and 736 train routes that exist without outside):

| Assumption changed | Picks that differ (dev / train) | Full marks (dev / train) | Worst score |
|---|---|---|---|
| Offset 0 m | 0 / 0 | 161 / 736 | 1.00 |
| Offset 0.30 m | 1 / 1 | 160 / 735 | 0.98 |
| Start and end at the room's best door | 2 / 4 | 159 / 734 | 0.79 |
| Stairs and lift at the stairwell's door | 7 / 14 | 161 / 732 | 0.93 |
| Both at the door | 8 / 15 | 160 / 731 | 0.79 |

**The offset doesn't matter**: 0 m and 0.15 m pick identical routes everywhere, so it needs no calibration. Where the route starts and ends inside the first and last room changes a handful of routes; everything else stays within 1%.

### Factory rules on kit data

- Walking routes never pass through a hall, under either distance model (0 of 90 dev and train factory routes). The bay rule only changes forklift routes.
- For forklifts, the bay definition decides what is reachable at all. Counting from the docks through ≥ 3 m openings, the halls that become unreachable out of 291 are: 23 if only `production_zone` is a bay, 41 if `production`, `assembly` and `additive` zones are, and 56 if all five hall types are. A wrong guess flips "route" against "no route", which scores 0 either way.
- There are no ramps or step types. The only openings that aren't step-free are 30 entrances in non-factory buildings, so the existing `step_free` flag already implements "without stairs".

### Do not break the 9 scored kinds

The kit's expected answers for `errand` and `what_if_door` were generated with the old model, and our 138 / 138 depends on it. Keep the old model for those solvers. Use the new rule for route answers only.

---

## Problem 2: the benchmark entry point can't answer FIND or ROUTE (critical)

`agent/answer.py` only has templates for the 9 scored kinds. On 90 dev warm-up questions (15 per kind) it answered **0**. Without a key the reply is "could not interpret". With `ANTHROPIC_API_KEY` set, the Haiku fallback returns "unknown kind unsupported", because it only maps onto the same 9 solvers.

Locate and count need only templates and output fields. Route, step-free, closure and tour answers also need the new router from Problem 1, because the old router's picks score about 0.82 on dev. Also:

- **Route to an item:** when several rooms hold one, route to the nearest under the metric (a multi-target search), since the score compares against the best possible length.
- **Constraints as fields:** the PDF says `questions.json` entries have "id, text, optional constraints such as step-free", so read those fields as well as the text.
- **Output:** the PDF asks for "the route as an ordered list of node ids", the Discord note for "the ordered list of spaces". Output space ids in kit `space_path` style, with every floor's stairwell or lift space listed, and add the element ids (`element_path`) too.
- **Blocked aisles:** "Aisle 4 is blocked" has to resolve to a space ("Main aisle H-B4"). Today `resolve_connector` needs the exact name.

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

1. **New router** in `core/` following the organizer rule (start from `/tmp/routeproto/proto.py`):
   - door-to-door geodesics inside each space polygon inset by 0.15 m, with per-space caching
   - stairs 2 m/m and lifts 15 m + 1 m/m, using floor `elevation_m`
   - routes start and end at a door of the first and last room
   - no `outside` transit, and `outside` kept in the space list if it is ever allowed
   - closures (including blocked aisles), step-free, forklift (≥ 3 m openings) and production bays as destinations only
   - routes to an item go to the nearest room that holds one
   - an explicit "no route" answer
2. **New question kinds** in `agent/answer.py` (locate, count, route, step-free route, route with closure, forklift, tour) that return the item or room id, the ordered space ids, the element ids and the length. Constraints are read from question fields as well as the text. A tour is one list with its legs joined.
3. **`run_benchmark <building_dir> <questions.json> <answers.json>`**, which also writes the CSV, documented in `BENCHMARK.md`.
4. **The app's routes use the same router.** Displayed routes then match what's scored, and the animated path goes around corners instead of through walls.
5. Keep the old model for the 9 scored kinds. Re-run dev, train and tests after every change. Use the prototype's `measure()` as the regression check: the new router's pick must never measure longer than the kit route's.
6. Cleanup (Problem 7), the ElevenLabs key, multi-floor plan upload, then the demo video and the technical explanation.

## Questions for the organizers

Ordered by how many answers they decide on kit data:

1. **Outside:** can a route leave through one entrance and come back in through another? If so, how is the outside distance counted? This decides 11 dev and 69 train routes between "route via outside" and "no route", and 15 dev and 42 train more where an indoor route exists.
2. **Production bays:** which hall types are bays, and which spaces are forklift aisles and pedestrian walkways? The kit has no aisle, walkway or ramp types; the halls are `production_zone`, `assembly_zone`, `additive_zone`, `warehouse_zone` and `logistics_zone`. Depending on the answer, 23, 41 or 56 of 291 factory halls can't be reached by forklift. Does the bay rule also apply to walking routes? (On kit data, walking routes never pass through a hall.) Will the Sunday building add new types?
3. **Route ends:** where does a route start and end inside the first and last room: the room centre (representative point or centroid), or the door? This changes 2 dev and 4 train picks (worst score 0.79).
4. **Stairwells:** where inside a stairwell or lift space are the stairs or the lift door, for measuring the walk from the door? This changes 7 dev and 14 train picks, all scoring 0.93 or more.
5. Should a lift or stair space appear once per floor in the space list (as in the kit's `space_path`) or only once?
6. Is a tour scored as one route with its legs joined, or leg by leg?
7. Are `errand` and `what_if_door` answers still scored with the kit's route model?
8. What is the final schema of `questions.json` and `answers.json`, and is the CSV submission still required?

No need to ask about the 15 cm offset: 0 m, 0.15 m and 0.30 m pick the same routes (see Problem 1).

Until they answer, the defaults are:
- Routes start and end at a door of the first and last room. That matches "door to door" and "ends in the room, not at its exact position".
- No outside shortcut. For the routes that only exist via outside, this is a coin flip.
- Lifts and stairs listed once per floor, as in the kit.
- Bays are `production_zone`, `assembly_zone` and `additive_zone`, where the machines stand. Warehouse and logistics zones stay drivable.
