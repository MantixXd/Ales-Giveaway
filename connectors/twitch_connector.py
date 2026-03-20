from __future__ import annotations

import asyncio
import logging
import re
from typing import Optional

from config.settings import AppSettings
from .base import ChatEntry, MessageCallback

logger = logging.getLogger(__name__)

IRC_HOST = "irc.chat.twitch.tv"
IRC_PORT = 6667


class TwitchConnector:
    """Connects to Twitch chat via anonymous IRC (justinfan) — no tokens needed."""

    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self._callback: Optional[MessageCallback] = None
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._running = False

    def set_message_callback(self, cb: MessageCallback) -> None:
        self._callback = cb

    async def start(self) -> None:
        self._running = True
        channel = self.settings.twitch_channel.lower().lstrip("#")

        while self._running:
            try:
                await self._connect(channel)
            except Exception as e:
                if self._running:
                    logger.warning(f"Twitch IRC error: {e}. Reconnecting in 5s...")
                    await asyncio.sleep(5)

    async def _connect(self, channel: str) -> None:
        logger.info(f"Connecting to Twitch IRC (#{channel})...")

        self._reader, self._writer = await asyncio.open_connection(IRC_HOST, IRC_PORT)

        # Request tags capability (gives us badge/sub info)
        self._send("CAP REQ :twitch.tv/tags twitch.tv/commands")
        # Anonymous login
        self._send("NICK justinfan12345")
        self._send(f"JOIN #{channel}")

        logger.info(f"Twitch connected to #{channel} (anonymous)")

        while self._running:
            try:
                raw = await asyncio.wait_for(self._reader.readline(), timeout=300)
            except asyncio.TimeoutError:
                # Send ping to keep alive
                self._send("PING :tmi.twitch.tv")
                continue

            if not raw:
                break

            line = raw.decode("utf-8", errors="replace").strip()

            if line.startswith("PING"):
                self._send("PONG :tmi.twitch.tv")
                continue

            if "PRIVMSG" in line:
                await self._handle_privmsg(line)

    def _send(self, msg: str) -> None:
        if self._writer:
            self._writer.write(f"{msg}\r\n".encode("utf-8"))

    async def _handle_privmsg(self, line: str) -> None:
        if self._callback is None:
            return

        try:
            # Parse IRC line with tags:
            # @badge-info=subscriber/14;badges=subscriber/12;...
            #   :user!user@user.tmi.twitch.tv PRIVMSG #channel :message text
            tags = {}
            rest = line

            if line.startswith("@"):
                tag_str, rest = line.split(" ", 1)
                tag_str = tag_str[1:]  # remove @
                for part in tag_str.split(";"):
                    if "=" in part:
                        k, v = part.split("=", 1)
                        tags[k] = v

            # Extract username and message
            match = re.match(r":(\w+)!\S+ PRIVMSG #\S+ :(.*)", rest)
            if not match:
                return

            username = match.group(1)
            message = match.group(2)

            # Parse subscriber info from tags
            is_subscriber = False
            sub_months = 0

            badges = tags.get("badges", "")
            badge_info = tags.get("badge-info", "")

            for badge in badges.split(","):
                if badge.startswith("subscriber/") or badge.startswith("founder/"):
                    is_subscriber = True
                    break

            for info in badge_info.split(","):
                if info.startswith("subscriber/"):
                    try:
                        sub_months = int(info.split("/")[1])
                    except (IndexError, ValueError):
                        sub_months = 1 if is_subscriber else 0
                    break

            if is_subscriber and sub_months == 0:
                sub_months = 1

            entry = ChatEntry(
                platform="twitch",
                user_id=tags.get("user-id", username),
                username=username,
                display_name=tags.get("display-name", username),
                is_subscriber=is_subscriber,
                sub_months=sub_months,
                message=message,
            )

            await self._callback(entry)

        except Exception as e:
            logger.error(f"Error parsing Twitch message: {e}")

    async def stop(self) -> None:
        self._running = False
        if self._writer:
            self._writer.close()
            logger.info("Twitch connector disconnected")
