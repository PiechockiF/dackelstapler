# Benchmark: how to reproduce our submission

One command, no API key, no manual steps:

```bash
uv run python -m benchmark.evaluate data/test --agent agent.answer:answer --submission-csv submission/team_sitetwin.csv
```

It writes `submission/team_sitetwin.csv` (145 rows, `question_id,answer`) and finishes in about a second.
The same command on `data/dev` or `data/train` (without `--submission-csv`) scores the replies with
`benchmark/score.py` and prints the result per question kind.

## What it does

`agent/answer.py` exports `answer(building_directory, question_text) -> str`. For each question it:

1. **Parses the question** with templates for the 9 benchmark kinds. Room names (with the floor in
   parentheses), floors ("ground floor", "floor 2", "basement 1"), room types and asset types are
   resolved against the building's own `building.json`. The parser was validated on all 800
   train/dev/test questions.
2. **Solves it deterministically** with the shared core in `core/` (the same code the SiteTwin app uses):
   - `largest_room`, `floor_area_total`: shapely polygon areas of the spaces with that `room_type`.
   - `errand`: route-model distance to the nearest room holding the asset, plus the route to the largest room of the type (stairs allowed).
   - `wide_delivery_count`: rooms on the floor reachable from the entry space with no stairs or steps and only doors at least as wide as the load.
   - `step_free_reachable_count`: same, step-free, with the named lift/stair closed.
   - `room_stacked`: the space on the next floor up/down with the largest overlap with this room's outline.
   - `shared_walls_count`: rooms on the same floor where at least 1 m of outline runs within 0.35 m of this room's outline. Corridors, stairwells, lifts and outdoor spaces (balconies) don't count.
   - `straight_line_3d`: distance between polygon centroids at each floor's `elevation_m`.
   - `what_if_door`: adds a door at the middle of the shared wall, recomputes every room's distance to its nearest entrance through the shared `outside` node, and counts rooms on the asked floor that improve by more than 1 m.
   Routing uses the starter's cost model unchanged (kit 1.1.0: door to door 15 cm off the walls, stairs 2 m and lifts 15 m + 1 m per metre climbed, no way round the outside).
3. **Replies** with a short explanation and a final `Answer: ...` line: one number for numeric kinds, or the room name (plus its ref if the name doesn't contain it) and the area in m² for `largest_room`.

If no template matches and `ANTHROPIC_API_KEY` is set, `claude-haiku-5-5` extracts the same parameters as
JSON for the same solvers. Without a key the reply says it could not interpret the question. The
benchmark questions never need this fallback.

## Results

| Split | Score |
|---|---|
| dev | 138 / 138 (100%) |
| train | 515 / 517 (99.6%) |

The two train misses are questions whose room name appears on two or three rooms of the same floor
(e.g. three rooms called "Büro"). The text can't tell them apart. No dev or test question has such a
duplicate.

Other checks:

```bash
uv run pytest tests -q                                   # core tests on dev buildings
uv run python -m starter_agent.evaluate data/dev --oracle   # warm-up oracle, 369/369
```
