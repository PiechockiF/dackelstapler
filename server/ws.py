"""WebSocket event bus. Server → client only; clients filter by site_id.

Use `await broadcast(message)` from async code, or `publish(message)` from sync code / worker threads
(chat tool calls, sync REST handlers); publish hops onto the server's event loop."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

log = logging.getLogger("sitetwin.ws")
router = APIRouter()

_clients: set[WebSocket] = set()
_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


async def broadcast(message: dict) -> None:
    """Send a JSON message to every connected client. Never raises."""
    if not _clients:
        return
    text = json.dumps(message, ensure_ascii=False, default=str)
    dead = []
    for client in list(_clients):
        try:
            await client.send_text(text)
        except Exception:  # noqa: BLE001 - a broken socket must not break the publisher
            dead.append(client)
    for client in dead:
        _clients.discard(client)


def publish(message: dict) -> None:
    """Fire-and-forget broadcast usable from any thread."""
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is not None:
        running.create_task(broadcast(message))
    elif _loop is not None and _loop.is_running():
        asyncio.run_coroutine_threadsafe(broadcast(message), _loop)


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    bind_loop(asyncio.get_running_loop())
    _clients.add(websocket)
    try:
        while True:
            await websocket.receive_text()  # clients may send pings; ignored
    except WebSocketDisconnect:
        pass
    finally:
        _clients.discard(websocket)
