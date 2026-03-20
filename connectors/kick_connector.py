from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

import httpx
import websockets

from config.settings import AppSettings
from .base import ChatEntry, MessageCallback

logger = logging.getLogger(__name__)

PUSHER_URL = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false"


class KickConnector:
    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self._callback: Optional[MessageCallback] = None
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._running = False

    def set_message_callback(self, cb: MessageCallback) -> None:
        self._callback = cb

    async def _fetch_chatroom_id(self) -> int:
        """Fetch chatroom ID from Kick API using channel slug."""
        if self.settings.kick_chatroom_id:
            return self.settings.kick_chatroom_id

        url = f"https://kick.com/api/v2/channels/{self.settings.kick_channel_slug}"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
        }

        async with httpx.AsyncClient() as client:
            resp = await client.get(url, headers=headers, follow_redirects=True)
            resp.raise_for_status()
            data = resp.json()
            chatroom_id = data["chatroom"]["id"]
            logger.info(f"Kick chatroom ID for '{self.settings.kick_channel_slug}': {chatroom_id}")
            return chatroom_id

    async def start(self) -> None:
        self._running = True

        try:
            chatroom_id = await self._fetch_chatroom_id()
        except Exception as e:
            logger.error(f"Failed to fetch Kick chatroom ID: {e}")
            logger.error("Set 'kick_chatroom_id' manually in config.yaml")
            return

        while self._running:
            try:
                await self._connect(chatroom_id)
            except Exception as e:
                if self._running:
                    logger.warning(f"Kick WebSocket error: {e}. Reconnecting in 5s...")
                    await asyncio.sleep(5)

    async def _connect(self, chatroom_id: int) -> None:
        logger.info(f"Connecting to Kick chat (chatroom {chatroom_id})...")

        async with websockets.connect(PUSHER_URL) as ws:
            self._ws = ws

            # Wait for connection_established
            raw = await ws.recv()
            msg = json.loads(raw)
            if msg.get("event") != "pusher:connection_established":
                logger.warning(f"Unexpected first message: {msg}")

            # Subscribe to chatroom channel
            subscribe_msg = json.dumps({
                "event": "pusher:subscribe",
                "data": {"auth": "", "channel": f"chatrooms.{chatroom_id}.v2"}
            })
            await ws.send(subscribe_msg)
            logger.info(f"Subscribed to Kick chatrooms.{chatroom_id}.v2")

            # Listen for messages
            async for raw in ws:
                if not self._running:
                    break

                msg = json.loads(raw)
                event = msg.get("event", "")

                if event == "pusher:ping":
                    await ws.send(json.dumps({"event": "pusher:pong", "data": {}}))

                elif "ChatMessage" in event:
                    await self._handle_chat_message(msg)

    async def _handle_chat_message(self, msg: dict) -> None:
        if self._callback is None:
            return

        try:
            data_str = msg.get("data", "{}")
            data = json.loads(data_str) if isinstance(data_str, str) else data_str

            sender = data.get("sender", {})
            identity = sender.get("identity", {})

            # Extract subscription info
            badges = identity.get("badges", [])
            is_subscriber = False
            sub_months = 0

            for badge in badges:
                badge_type = badge.get("type", "")
                if badge_type == "subscriber" or "subscriber" in badge_type.lower():
                    is_subscriber = True
                    sub_months = badge.get("count", 0) or sender.get("months_subscribed", 0)
                    break

            # Fallback: check months_subscribed directly
            if not is_subscriber and sender.get("is_subscriber"):
                is_subscriber = True
                sub_months = sender.get("months_subscribed", 1)

            entry = ChatEntry(
                platform="kick",
                user_id=str(sender.get("id", "unknown")),
                username=sender.get("slug", sender.get("username", "unknown")),
                display_name=sender.get("username", "unknown"),
                is_subscriber=is_subscriber,
                sub_months=sub_months,
                message=data.get("content", ""),
            )

            await self._callback(entry)

        except Exception as e:
            logger.error(f"Error parsing Kick chat message: {e}")

    async def stop(self) -> None:
        self._running = False
        if self._ws:
            await self._ws.close()
            logger.info("Kick connector disconnected")
