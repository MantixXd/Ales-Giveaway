from __future__ import annotations

import asyncio
import os
import sys
import logging

import socketio
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from engine.giveaway import GiveawayEngine
from paths import get_static_dir
from .routes import create_router

logger = logging.getLogger(__name__)

sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")

# Track connected clients for auto-shutdown
_connected_clients: set[str] = set()
_shutdown_task: asyncio.Task | None = None
_SHUTDOWN_DELAY = 5  # seconds after last client disconnects


async def _schedule_shutdown() -> None:
    """Shut down the process if no clients reconnect within the delay."""
    await asyncio.sleep(_SHUTDOWN_DELAY)
    if not _connected_clients:
        logger.info("All browser tabs closed — shutting down.")
        os._exit(0)


def create_app(engine: GiveawayEngine, connector_manager=None) -> socketio.ASGIApp:
    fastapi_app = FastAPI(title="Streamer Giveaway Tool")

    # Wire engine events to Socket.IO
    async def emit_event(event: str, data: dict) -> None:
        await sio.emit(event, data)

    engine.set_event_emitter(emit_event)

    # Register REST routes
    router = create_router(engine, connector_manager=connector_manager)
    fastapi_app.include_router(router)

    # Serve static files
    static_dir = get_static_dir()
    fastapi_app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    # Socket.IO events
    @sio.event
    async def connect(sid, environ):
        global _shutdown_task
        _connected_clients.add(sid)
        # Cancel pending shutdown if a client reconnects
        if _shutdown_task and not _shutdown_task.done():
            _shutdown_task.cancel()
            _shutdown_task = None
        # Send current status on connect
        await sio.emit("state_changed", {
            "state": engine.state.value,
            "keyword": engine.settings.keyword,
        }, to=sid)

    @sio.event
    async def disconnect(sid):
        global _shutdown_task
        _connected_clients.discard(sid)
        if not _connected_clients:
            _shutdown_task = asyncio.create_task(_schedule_shutdown())

    # Wrap FastAPI with Socket.IO ASGI app
    app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)
    return app
