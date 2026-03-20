from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from typing import Optional

import asyncio
import logging

from engine.giveaway import GiveawayEngine
from paths import get_static_dir, get_config_path

import yaml

logger = logging.getLogger(__name__)


def _save_config(settings) -> None:
    """Persist current settings to config.yaml."""
    data = {
        "twitch_enabled": settings.twitch_enabled,
        "twitch_channel": settings.twitch_channel,
        "kick_enabled": settings.kick_enabled,
        "kick_channel_slug": settings.kick_channel_slug,
        "kick_chatroom_id": settings.kick_chatroom_id,
        "keyword": settings.keyword,
        "allow_non_subs": settings.allow_non_subs,
        "non_sub_weight": settings.non_sub_weight,
        "sub_weight_mode": settings.sub_weight_mode,
        "sub_constant_weight": settings.sub_constant_weight,
        "sub_log_multiplier": settings.sub_log_multiplier,
        "sub_linear_multiplier": settings.sub_linear_multiplier,
        "host": settings.host,
        "port": settings.port,
    }
    path = get_config_path()
    with open(path, "w", encoding="utf-8") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True)


class StartRequest(BaseModel):
    keyword: Optional[str] = None


class ConfigUpdate(BaseModel):
    twitch_enabled: Optional[bool] = None
    twitch_channel: Optional[str] = None
    kick_enabled: Optional[bool] = None
    kick_channel_slug: Optional[str] = None
    keyword: Optional[str] = None
    allow_non_subs: Optional[bool] = None
    non_sub_weight: Optional[float] = None
    sub_weight_mode: Optional[str] = None
    sub_constant_weight: Optional[float] = None
    sub_log_multiplier: Optional[float] = None
    sub_linear_multiplier: Optional[float] = None


def create_router(engine: GiveawayEngine, connector_manager=None) -> APIRouter:
    router = APIRouter()
    static_dir = get_static_dir()

    @router.get("/", response_class=HTMLResponse)
    async def control_panel():
        return (static_dir / "index.html").read_text(encoding="utf-8")

    @router.get("/overlay", response_class=HTMLResponse)
    async def overlay():
        return (static_dir / "overlay.html").read_text(encoding="utf-8")

    @router.get("/api/status")
    async def get_status():
        return engine.get_status()

    @router.post("/api/giveaway/start")
    async def start_giveaway(req: StartRequest = StartRequest()):
        return await engine.start_giveaway(req.keyword)

    @router.post("/api/giveaway/stop")
    async def stop_entries():
        return await engine.stop_entries()

    @router.post("/api/giveaway/draw")
    async def draw_winner():
        return await engine.draw_winner()

    @router.post("/api/giveaway/reset")
    async def reset():
        return await engine.reset()

    @router.get("/api/participants")
    async def get_participants():
        return engine.get_participants()

    @router.get("/api/config")
    async def get_config():
        s = engine.settings
        return {
            "keyword": s.keyword,
            "allow_non_subs": s.allow_non_subs,
            "non_sub_weight": s.non_sub_weight,
            "sub_weight_mode": s.sub_weight_mode,
            "sub_constant_weight": s.sub_constant_weight,
            "sub_log_multiplier": s.sub_log_multiplier,
            "sub_linear_multiplier": s.sub_linear_multiplier,
            "twitch_enabled": s.twitch_enabled,
            "twitch_channel": s.twitch_channel,
            "kick_enabled": s.kick_enabled,
            "kick_channel_slug": s.kick_channel_slug,
        }

    @router.put("/api/config")
    async def update_config(update: ConfigUpdate):
        # Track whether channel settings changed (need reconnect)
        old_channels = (
            engine.settings.twitch_enabled,
            engine.settings.twitch_channel,
            engine.settings.kick_enabled,
            engine.settings.kick_channel_slug,
        )

        if update.twitch_enabled is not None:
            engine.settings.twitch_enabled = update.twitch_enabled
        if update.twitch_channel is not None:
            engine.settings.twitch_channel = update.twitch_channel
        if update.kick_enabled is not None:
            engine.settings.kick_enabled = update.kick_enabled
        if update.kick_channel_slug is not None:
            engine.settings.kick_channel_slug = update.kick_channel_slug
        if update.keyword is not None:
            engine.settings.keyword = update.keyword
        if update.allow_non_subs is not None:
            engine.settings.allow_non_subs = update.allow_non_subs
        if update.non_sub_weight is not None:
            engine.settings.non_sub_weight = update.non_sub_weight
        if update.sub_weight_mode is not None:
            engine.settings.sub_weight_mode = update.sub_weight_mode
        if update.sub_constant_weight is not None:
            engine.settings.sub_constant_weight = update.sub_constant_weight
        if update.sub_log_multiplier is not None:
            engine.settings.sub_log_multiplier = update.sub_log_multiplier
        if update.sub_linear_multiplier is not None:
            engine.settings.sub_linear_multiplier = update.sub_linear_multiplier

        # Persist to config.yaml
        _save_config(engine.settings)

        # Reconnect if channel settings changed
        new_channels = (
            engine.settings.twitch_enabled,
            engine.settings.twitch_channel,
            engine.settings.kick_enabled,
            engine.settings.kick_channel_slug,
        )
        reconnected = False
        if connector_manager and old_channels != new_channels:
            logger.info("Channel settings changed, reconnecting...")
            asyncio.create_task(connector_manager.restart())
            reconnected = True

        return {"ok": True, "reconnected": reconnected, **engine.get_status()}

    return router
