"""Per-session chat for one site, streamed as SSE (docs/CONTRACT.md "Chat stream").

With Anthropic credentials: Claude (claude-opus-5-5) runs the streaming tool runner over agent/tools.py;
text deltas and tool actions are forwarded as they happen. Without credentials (or if the API fails):
a small deterministic intent parser answers "where is X", "route from A to B", "close lift X",
"free rooms ..." with the same tools, so the app and the 3D view still work end to end."""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import threading
from collections.abc import Callable, Iterator
from datetime import datetime, timedelta

from server import twin
from server.twin import MapError
from agent.prompts import build_system_prompt, context_line
from agent.tools import TwinTools, make_tools

log = logging.getLogger("sitetwin.chat")

MODEL = os.environ.get("SITETWIN_CHAT_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("SITETWIN_CHAT_EFFORT", "low")
MAX_TOKENS = 16000
MAX_TOOL_ITERATIONS = 12
FALLBACK_BETA = "server-side-fallback-2026-07-01"
NO_KEY_NOTE = ("(No ANTHROPIC_API_KEY is set, so I'm running on simple built-in rules instead of Claude. "
               "Try: \"where is the CNC mill\", \"route from Office 0.30 to Quality lab 0.21 without stairs\", "
               "\"close the office lift\", \"free room for 6 at 14:00\".)")

Emit = Callable[[str, dict], None]


def llm_available() -> bool:
    if os.environ.get("SITETWIN_FORCE_FALLBACK"):
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


class ChatSession:
    def __init__(self, site_id: str, session_id: str) -> None:
        self.site_id = site_id
        self.session_id = session_id
        self.tools = TwinTools(site_id)
        self.messages: list[dict] = []
        self.lock = threading.Lock()
        self.note_given = False
        self.step_free_pref = False
        self.last_slot: datetime | None = None
        self._system: list[dict] | None = None
        self._tool_list: list | None = None

    def system(self) -> list[dict]:
        if self._system is None:
            text = build_system_prompt(twin.get_site(self.site_id), twin.get_map(self.site_id))
            self._system = [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]
        return self._system

    def tool_list(self) -> list:
        if self._tool_list is None:
            self._tool_list = make_tools(self.tools)
        return self._tool_list


_sessions: dict[tuple[str, str], ChatSession] = {}
_sessions_lock = threading.Lock()


def get_session(site_id: str, session_id: str) -> ChatSession:
    twin.get_site(site_id)  # raises NotFound
    with _sessions_lock:
        key = (site_id, session_id or "default")
        if key not in _sessions:
            _sessions[key] = ChatSession(site_id, session_id or "default")
        return _sessions[key]


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


def stream_chat(site_id: str, session_id: str, message: str, *, here: str | None = None) -> Iterator[str]:
    """Run one user turn in a worker thread and yield SSE frames as they are produced."""
    session = get_session(site_id, session_id)
    frames: queue.Queue = queue.Queue()
    parts: list[str] = []

    def emit(kind: str, data: dict) -> None:
        if kind == "delta":
            parts.append(data["text"])
        frames.put((kind, data))

    def worker() -> None:
        try:
            with session.lock:
                session.tools.emit = lambda action: emit("action", action)
                try:
                    if here is not None:
                        session.tools.here = session.tools.bm.resolve_space(here)
                        session.tools.here_is_default = False
                    run_turn(session, message, emit)
                    emit("action", {"type": "set_location", "space_id": session.tools.here})
                finally:
                    session.tools.emit = lambda action: None
        except Exception as error:  # noqa: BLE001 - always finish the stream
            log.exception("chat turn failed")
            emit("delta", {"text": f"Sorry, something went wrong: {error}"})
        finally:
            frames.put(("done", {"reply": "".join(parts).strip()}))

    threading.Thread(target=worker, daemon=True).start()
    while True:
        kind, data = frames.get()
        yield sse(kind, data)
        if kind == "done":
            return


def run_turn(session: ChatSession, message: str, emit: Emit) -> None:
    if llm_available():
        try:
            llm_turn(session, message, emit)
            return
        except Exception as error:  # noqa: BLE001 - auth/network/API trouble → rules
            log.warning("LLM turn failed, using rules: %s", error)
            emit("delta", {"text": f"(Claude is unavailable right now: {type(error).__name__}. Using built-in rules.) "})
            session.note_given = True
    fallback_turn(session, message, emit)


# ====================================================================== Claude

def llm_turn(session: ChatSession, message: str, emit: Emit) -> None:
    import anthropic

    client = anthropic.Anthropic()
    tools = session.tools
    now = twin.local_now().strftime("%A %Y-%m-%d %H:%M")
    context = context_line(now, tools.space_label(tools.here), tools.here_is_default)
    checkpoint = len(session.messages)
    session.messages.append({"role": "user", "content": [{"type": "text", "text": context},
                                                         {"type": "text", "text": message}]})
    try:
        runner = client.beta.messages.tool_runner(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            max_iterations=MAX_TOOL_ITERATIONS,
            system=session.system(),
            tools=session.tool_list(),
            messages=list(session.messages),
            stream=True,
            output_config={"effort": EFFORT},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        )
        wrote_text = False
        for stream in runner:
            new_block = True
            for event in stream:
                if event.type == "content_block_start":
                    new_block = True
                elif event.type == "content_block_delta" and getattr(event.delta, "type", "") == "text_delta":
                    text = event.delta.text
                    if new_block and wrote_text:
                        text = " " + text.lstrip()
                    new_block = False
                    wrote_text = True
                    emit("delta", {"text": text})
            final = stream.get_final_message()
            session.messages.append({"role": "assistant", "content": final.content})
            if final.stop_reason == "refusal":
                emit("delta", {"text": "Sorry, I can't help with that request."})
                break
            if final.stop_reason == "max_tokens":
                break
            tool_response = runner.generate_tool_call_response()
            if tool_response is not None:
                session.messages.append(tool_response)
    except Exception:
        del session.messages[checkpoint:]  # keep the history valid for the next turn
        raise


# ====================================================================== rules (no API key)

STEP_FREE_WORDS = ("without stairs", "no stairs", "step-free", "step free", "stepfree", "wheelchair", "rollstuhl",
                   "stufenlos", "ohne treppe", "barrierefrei", "pram", "stroller", "trolley", "crutches", "avoid stairs")
FILLER = re.compile(r"\b(the|a|an|my|our|please|der|die|das|den|dem|ein|eine|bitte)\b", re.I)
TRAILING = re.compile(r"\s+(that|which|who|we|delivered|that's|thats|from yesterday|der|die|das|von gestern)\b.*$", re.I)


def _say(emit: Emit, text: str) -> None:
    """Stream a reply word by word, like the model would."""
    words = re.findall(r"\S+\s*", text)
    for start in range(0, len(words), 4):
        emit("delta", {"text": "".join(words[start:start + 4])})


def _clean(phrase: str) -> str:
    phrase = TRAILING.sub("", phrase.strip(" ?!.,"))
    phrase = FILLER.sub(" ", phrase)
    return re.sub(r"\s+", " ", phrase).strip(" ?!.,")


def _best_place(tools: TwinTools, phrase: str) -> str:
    """Space id for a free-text place: exact names/ids, 'here/there', deliveries, then search."""
    raw = phrase.strip(" ?!.,")
    for candidate in (raw, _clean(raw)):
        try:
            return tools.resolve(candidate)
        except (MapError, KeyError):
            pass
    cleaned = _clean(raw)
    deliveries = tools.find_delivery(cleaned, emit=False, strict=True)["matches"]
    if deliveries:
        return deliveries[0]["space_id"]
    bm = tools.bm
    for query in [cleaned] + sorted((w for w in cleaned.split() if len(w) > 2), key=len, reverse=True):
        results = bm.search(query)
        if results:
            first = results[0]
            return first["id"] if first["kind"] == "space" else bm.assets[first["id"]]["space_id"]
    raise MapError(f"I couldn't find '{cleaned}' on this site.")


def _fuzzy_element(tools: TwinTools, phrase: str) -> str:
    bm = tools.bm
    cleaned = _clean(phrase)
    try:
        return bm.find_element(cleaned)
    except (MapError, KeyError):
        pass
    words = [w for w in cleaned.lower().split() if len(w) > 1]
    kind = "lift" if any(w in ("lift", "elevator", "aufzug") for w in words) else (
        "stairs" if any(w.startswith(("stair", "treppe")) for w in words) else None)
    connectors = list(bm.connectors.values())
    named = [c for c in connectors if any(w in c["name"].lower() for w in words if w not in ("lift", "stairs", "staircase"))]
    if kind:
        of_kind = [c for c in connectors if c["kind"] == kind]
        named = [c for c in named if c["kind"] == kind] or of_kind
    if named:
        return named[0]["id"]
    return _best_place(tools, cleaned)


def _parse_time(text: str) -> datetime | None:
    now = twin.local_now()
    match = re.search(r"\b(\d{1,2})[:.h](\d{2})\b", text) or re.search(r"\b(?:at|um|@)\s*(\d{1,2})\s*(am|pm|uhr)?\b", text)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2)) if match.lastindex and match.lastindex >= 2 and (match.group(2) or "").isdigit() else 0
    if "pm" in text and hour < 12:
        hour += 12
    day = now.date() + (timedelta(days=1) if re.search(r"\b(tomorrow|morgen)\b", text) else timedelta())
    return datetime(day.year, day.month, day.day, hour % 24, minute, tzinfo=twin.LOCAL_TZ)


def _route_reply(result: dict) -> str:
    if not result["reachable"]:
        kind = "step-free " if result.get("step_free") else ""
        reply = f"There's no {kind}route from {result['from']} to {result['to']} right now"
        if result.get("closed_names"):
            reply += f" while {', '.join(result['closed_names'][:3])} is closed"
        reply += "."
        if result.get("blocking_openings"):
            widths = ", ".join(f"{o['width_m']:g} m" for o in result["blocking_openings"][:3])
            reply += f" Doors on the way are too narrow ({widths})."
        if result.get("step_free"):
            reply += " Tell me if stairs are fine for you."
        return reply
    steps = result["steps"][1:-1]
    body = " ".join(steps[:5]) + (" The route is on screen." if len(steps) > 5 else "")
    return f"{result['to']} is {result['length_m']:.0f} m from {result['from']}. {body}"


def fallback_turn(session: ChatSession, message: str, emit: Emit) -> None:
    tools = session.tools
    text = message.strip()
    lowered = text.lower()
    reply = ""
    try:
        reply = _rules(session, text, lowered)
    except (MapError, twin.BookingConflict, ValueError) as error:
        reply = friendly(str(error))
    if not session.note_given:
        reply = f"{reply} {NO_KEY_NOTE}".strip()
        session.note_given = True
    _say(emit, reply)
    _ = tools


def _rules(session: ChatSession, text: str, lowered: str) -> str:
    tools = session.tools
    if any(word in lowered for word in STEP_FREE_WORDS):
        session.step_free_pref = True
    step_free = session.step_free_pref

    # "I'm in 1.04"
    match = re.search(r"\b(?:i'?m|i am|ich bin)\s+(?:in|at|im|bei|in der|in dem)\s+(.+)$", lowered)
    if match and not re.search(r"\b(where|route|way|wo)\b", lowered):
        space_id = _best_place(tools, match.group(1))
        info = tools.set_location(space_id)
        return f"Got it, you're in {info['you_are_in']}."

    # closures
    match = re.search(r"\b(reopen|re-open|unblock|open again|öffne|wieder offen)\b\s*(.*)$", lowered)
    if match:
        element = _fuzzy_element(tools, match.group(2) or text)
        result = tools.set_closed(element, False)
        return f"{result['name']} is open again." + _replan_note(result)
    match = (re.search(r"\b(?:close|block|shut|sperre?|schließe?)\b\s+(.+?)(?:\s+for\s+.*|\s+wegen\s+.*)?$", lowered)
             or re.search(r"^(.+?)\s+(?:is|ist)\s+(?:closed|blocked|out of order|broken|under maintenance|gesperrt|defekt)", lowered))
    if match:
        element = _fuzzy_element(tools, match.group(1))
        result = tools.set_closed(element, True)
        return f"Done, {result['name']} is closed for everyone." + _replan_note(result)

    # rooms
    if re.search(r"\b(free|available|frei|book|buch)\w*\b.*\b(room|raum|rooms|räume)\b|\broom for\b|\bmeeting room\b.*\bfor\b", lowered):
        start = _parse_time(lowered) or (twin.local_now() + timedelta(minutes=15 - twin.local_now().minute % 15)).replace(second=0, microsecond=0)
        people_match = re.search(r"(\d+)\s*(?:people|persons|personen|leute|ppl|of us|seats)", lowered) or re.search(r"\bfor\s+(\d+)\b(?!\s*[:.h]\d)", lowered)
        people = int(people_match.group(1)) if people_match else 1
        result = tools.free_rooms(start.isoformat(timespec="minutes"), None, people)
        rooms = result["free_rooms"]
        if not rooms:
            return f"No bookable room for {people} is free at {start:%H:%M}."
        session.last_slot = start
        if re.search(r"\b(book|buch)", lowered):
            booked = tools.book_room(rooms[0]["space_id"], start.isoformat(timespec="minutes"))
            return f"Booked {booked['room']} at {start:%H:%M} for an hour. It seats {rooms[0]['capacity']}."
        names = ", ".join(f"{room['name']} ({room['capacity']} seats)" for room in rooms[:3])
        return f"Free at {start:%H:%M} for {people}: {names}. Say \"book it\" to take the first one."
    if re.fullmatch(r"\s*(book it|book that|ja,? buchen|buchen)\s*[.!]?\s*", lowered) and tools.last_target:
        start = session.last_slot or (twin.local_now() + timedelta(minutes=15 - twin.local_now().minute % 15)).replace(second=0, microsecond=0)
        booked = tools.book_room(tools.last_target, start.isoformat(timespec="minutes"))
        return f"Booked {booked['room']} from {start:%H:%M} for an hour."

    # recent changes
    if re.search(r"\b(what changed|what's new|whats new|recent|changes|news|deliveries|lieferungen|was ist neu)\b", lowered):
        hours = 168 if re.search(r"\b(week|woche)\b", lowered) else 24
        result = tools.recent_changes(hours)
        if not result["events"]:
            return f"Nothing changed in the last {hours} hours."
        titles = "; ".join(event["title"] for event in result["events"][:5])
        return f"{result['count']} changes in the last {'week' if hours == 168 else 'day'}. Latest: {titles}."

    # routes
    width_match = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:m|metres|meters|meter)\s*(?:wide|breit)", lowered)
    min_width = float(width_match.group(1).replace(",", ".")) if width_match else (1.2 if "pallet" in lowered or "palette" in lowered else None)
    match = re.search(r"\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+(?:without|with|via|step|avoiding|no)\b.*)?$", lowered) \
        or re.search(r"\bvon\s+(.+?)\s+(?:zu|zum|zur|nach)\s+(.+?)(?:\s+(?:ohne|mit|über)\b.*)?$", lowered)
    if match:
        start, destination = _best_place(tools, match.group(1)), _best_place(tools, match.group(2))
        return _route_reply(tools.route(start, destination, step_free, min_width))
    match = re.search(r"\b(?:take me|bring me|guide me|navigate|route|way|get|go|directions|führe mich|bring mich|weg)\b"
                      r"(?:\s+me)?(?:\s+(?:to|zu|zum|zur|nach))?\s+(.+?)(?:\s+(?:without|with|step|avoiding|ohne|mit)\b.*)?$", lowered)
    if match:
        target = match.group(1).strip()
        if target in ("there", "it", "dorthin", "dahin", "hin") or target.startswith("there"):
            target = "there"
        destination = _best_place(tools, target)
        return _route_reply(tools.route("here", destination, step_free, min_width))

    # locate
    match = re.search(r"\b(?:where(?:'s| is| are| do i find| can i find)?|find|locate|show me|wo ist|wo sind|zeig mir)\s+(.+)$", lowered)
    if match:
        query = _clean(match.group(1))
        result = tools.locate(query)
        if result["deliveries"]:
            delivery = result["deliveries"][0]
            when = twin.parse_time(delivery["ts"]).astimezone(twin.LOCAL_TZ).strftime("%a %H:%M") if delivery.get("ts") else ""
            return f"The {delivery['label']} is in {delivery['where']}, delivered {when}. Want me to take you there?"
        first = result["results"][0]
        where = tools.space_label(first["space_id"] if first["kind"] == "asset" else first["id"])
        away = f", about {first['walk_m_from_person']:.0f} m from you" if first.get("walk_m_from_person") else ""
        if result["matches"] > 1:
            return f"The nearest is {first['name']} in {where}{away}. I highlighted all {result['matches']}. Want a route there?"
        return f"{first['name']} is in {where}{away}. Want a route there?"

    # bare place name → locate it
    try:
        result = tools.locate(_clean(text))
        first = result["results"][0] if result["results"] else None
        if first:
            where = tools.space_label(first["space_id"] if first["kind"] == "asset" else first["id"])
            return f"{first['name']} is in {where}. Want a route there?"
    except MapError:
        pass
    return ("I can find things, plan routes (also step-free or for wide loads), close lifts or doors, "
            "move machines and book rooms. What do you need?")


def friendly(message: str) -> str:
    """Drop ids and raw closure lists from core error messages before speaking them."""
    message = re.sub(r"\s*\[[^\]]*\]", "", message)
    message = re.sub(r"\s+with the current closures\s*\.?", " with the current closures.", message)
    return re.sub(r"\s+", " ", message).strip()


def _replan_note(result: dict) -> str:
    replanned = result.get("previous_route_replanned")
    if not replanned:
        return ""
    if not replanned.get("reachable"):
        return " Your last route is now blocked - there is no way around it."
    return f" I re-planned your route: now {replanned['length_m']:.0f} m."
