from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Awaitable, Callable, Protocol, runtime_checkable


@dataclass
class ChatEntry:
    platform: str  # "twitch" | "kick"
    user_id: str
    username: str
    display_name: str
    is_subscriber: bool
    sub_months: int  # 0 if not subscribed or unknown
    message: str
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


MessageCallback = Callable[[ChatEntry], Awaitable[None]]


@runtime_checkable
class ChatConnector(Protocol):
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    def set_message_callback(self, cb: MessageCallback) -> None: ...
