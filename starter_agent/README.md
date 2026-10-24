# Starter agent: an indoor "Google Maps" you can talk to

This is a small working example to build on. Claude handles the conversation, and a deterministic module (`building_map.py`) supplies every fact: rooms, things, routes and distances. Claude never makes up a route. It calls tools and explains what they return.

```
you ──► agent.py (Claude Opus 5.5, tool runner) ──► tools.py ──► building_map.py ──► building.json
                                                                   │  search, Dijkstra routes,
                                                                   │  closures, add a door
                                                       viewer.py ◄─┘  route images (PNG)
```

## Run it

You need Python 3.12, [uv](https://docs.astral.sh/uv/) and Claude API credentials: set `ANTHROPIC_API_KEY`, or run `ant auth login`.

```bash
uv sync
uv run python -m starter_agent data/dev/proc-factory-dev-003
```

```
you> where is the cnc mill?
you> I'm at the main entrance, how do I get there without stairs?
you> the office lift is closed for maintenance - what changes?
you> add a door between 1.04 and 1.05
you> show me the route
```

Route images and edited buildings go to `agent_output/`.

## Tools

| Tool | What it does | Level |
|---|---|---|
| `building_overview` | Floors, stairs and lifts, entrances, current closures | 1 |
| `search_building` | Finds rooms and things by name, room number or type, optionally on one floor | 1 |
| `find_route` | Shortest route with step-by-step directions and metres. Supports `step_free` and `via` stops for tours | 2–3 |
| `set_closed` | Closes or reopens a lift, staircase, door or room | 2 |
| `add_door` | Adds a door between neighbouring rooms and saves `building_edited.json` | 4 (start) |
| `show_route` | Draws the last route on each floor it crosses | viewer |

Routes follow the judges' rules, the same ones behind the dataset's expected answers: walking inside each space goes door to door, 15 cm off the walls and round corners; stairs cost 2 m per metre climbed; a lift costs 15 m per ride plus 1 m per metre climbed (heights from the floors' `elevation_m`); there is no shortcut round the outside of the building.

## Check how well it does

These commands use the warm-up set (`questions_basic.jsonl`). The real benchmark is `questions.jsonl`, scored with `benchmark.evaluate`, and the starter agent fails it on purpose. See section 6 of [../README.md](../README.md).

```bash
# Free: answers every question with the tools directly. Shows the tools can reach 100%.
uv run python -m starter_agent.evaluate data/dev --oracle

# Live agent on the first 10 dev questions (uses API credits)
uv run python -m starter_agent.evaluate data/dev --limit 10
```

The live score checks what the agent computed, not its wording. A route must be within 1% of the optimal length, a locate question must find the right asset, and a count answer must contain the right number. Each question runs in a fresh conversation, so you can see per-question token use.

## Where to take it next

- **Interaction (25 pts).** Tune `SYSTEM_PROMPT` in `agent.py`. Test with tricky users: vague ("the printer"), wrong ("room 9.99"), or changing their mind halfway.
- **Level 3 (scale).** Several buildings at once. Load more than one `BuildingMap`, link them with outdoor walkways, and add a `building` argument to the tools.
- **Level 4 (build).** Create a building from a floor-plan image. Send the PNG to Claude as an image, have it produce `spaces` and `openings` in the same JSON format, then load it with `BuildingMap` and check that every room can be reached.
- **Level 5 (extend).** Moving assets (an `update_asset_position` tool), forklift routes that avoid blocked aisles (close hall zones), voice, or a three.js view that stacks floors by `elevation_m`.
- **Cost.** The system prompt (with the building overview) is cached, so you only pay full price for it once. Lower `EFFORT` to `"low"` for quick lookups, or try `claude-sonnet-5-5` or `claude-haiku-5-5` and compare with the evaluator.

## Notes

- The model is `claude-opus-5-5` at `effort: "medium"`. Server-side fallbacks are switched on (`fallbacks: "default"`), so if a request is declined it is retried on a fallback model instead of failing. Remove the `betas` and `fallbacks` arguments in `agent.py` if you don't want this.
- `tool_runner` comes from the Anthropic Python SDK (beta helper). It runs the call-tools-and-feed-back-results loop. `agent.py` copies its history so that follow-up questions keep their context.
