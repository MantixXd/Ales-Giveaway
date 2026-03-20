from __future__ import annotations

from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel


class AppSettings(BaseModel):
    # Twitch
    twitch_enabled: bool = True
    twitch_token: str = ""
    twitch_client_id: str = ""
    twitch_client_secret: str = ""
    twitch_channel: str = ""

    # Kick
    kick_enabled: bool = False
    kick_channel_slug: str = ""
    kick_chatroom_id: Optional[int] = None

    # Giveaway
    keyword: str = "!giveaway"
    allow_non_subs: bool = True
    non_sub_weight: float = 1.0
    sub_weight_mode: str = "logarithmic"  # "logarithmic", "linear", "constant"
    sub_constant_weight: float = 2.0  # used when mode is "constant"
    sub_log_multiplier: float = 1.0  # scales logarithmic curve steepness
    sub_linear_multiplier: float = 1.0  # scales linear curve steepness

    # Web
    host: str = "0.0.0.0"
    port: int = 8888


def load_settings(path: str | Path = "config.yaml") -> AppSettings:
    p = Path(path)
    if p.exists():
        with open(p, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return AppSettings(**data)
    return AppSettings()
