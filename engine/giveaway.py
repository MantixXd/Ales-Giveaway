from __future__ import annotations

import enum
import random
from typing import Awaitable, Callable, Optional

from connectors.base import ChatEntry
from config.settings import AppSettings
from .models import Participant, DrawResult
from .weighting import calculate_weight


class GiveawayState(str, enum.Enum):
    IDLE = "IDLE"
    OPEN = "OPEN"
    CLOSED = "CLOSED"
    DRAWN = "DRAWN"


EventEmitter = Callable[[str, dict], Awaitable[None]]


class GiveawayEngine:
    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self.state = GiveawayState.IDLE
        self.participants: dict[tuple[str, str], Participant] = {}  # (platform, user_id) -> Participant
        self.last_result: Optional[DrawResult] = None
        self._drawn_winners: set[tuple[str, str]] = set()
        self._emit: Optional[EventEmitter] = None

    def set_event_emitter(self, emitter: EventEmitter) -> None:
        self._emit = emitter

    async def _fire(self, event: str, data: dict) -> None:
        if self._emit:
            await self._emit(event, data)

    # --- State transitions ---

    async def start_giveaway(self, keyword: Optional[str] = None) -> dict:
        if self.state != GiveawayState.IDLE:
            return {"error": f"Cannot start: state is {self.state.value}"}

        if keyword:
            self.settings.keyword = keyword

        self.participants.clear()
        self.last_result = None
        self._drawn_winners.clear()
        self.state = GiveawayState.OPEN
        await self._fire("state_changed", {"state": self.state.value, "keyword": self.settings.keyword})
        return {"state": self.state.value, "keyword": self.settings.keyword}

    async def stop_entries(self) -> dict:
        if self.state != GiveawayState.OPEN:
            return {"error": f"Cannot stop: state is {self.state.value}"}

        self.state = GiveawayState.CLOSED
        await self._fire("state_changed", {"state": self.state.value, "count": len(self.participants)})
        return {"state": self.state.value, "count": len(self.participants)}

    async def draw_winner(self) -> dict:
        if self.state not in (GiveawayState.OPEN, GiveawayState.CLOSED, GiveawayState.DRAWN):
            return {"error": f"Cannot draw: state is {self.state.value}"}

        # Exclude already-drawn winners
        eligible = {k: p for k, p in self.participants.items()
                    if k not in self._drawn_winners}

        if not eligible:
            return {"error": "No eligible participants left"}

        participants = list(eligible.values())
        weights = [p.weight for p in participants]

        winner = random.choices(participants, weights=weights, k=1)[0]
        total_weight = sum(weights)

        self._drawn_winners.add((winner.platform, winner.user_id))

        self.last_result = DrawResult(
            winner=winner,
            total_participants=len(participants),
            total_weight=total_weight,
        )
        self.state = GiveawayState.DRAWN

        # Include all names for reel animation
        all_names = [p.display_name for p in self.participants.values()]

        result_data = self.last_result.to_dict()
        result_data["reel_names"] = all_names
        result_data["drawn_count"] = len(self._drawn_winners)
        result_data["eligible_remaining"] = len(eligible) - 1

        await self._fire("winner_drawn", result_data)
        await self._fire("state_changed", {
            "state": self.state.value,
            "drawn_count": len(self._drawn_winners),
            "eligible_remaining": len(eligible) - 1,
        })
        return result_data

    async def reset(self) -> dict:
        self.state = GiveawayState.IDLE
        self.participants.clear()
        self.last_result = None
        self._drawn_winners.clear()
        await self._fire("state_changed", {"state": self.state.value})
        return {"state": self.state.value}

    # --- Chat entry handler ---

    async def handle_chat_entry(self, entry: ChatEntry) -> None:
        if self.state != GiveawayState.OPEN:
            return

        # Empty keyword = register all messages
        if self.settings.keyword.strip() and self.settings.keyword.lower() not in entry.message.lower():
            return

        key = (entry.platform, entry.user_id)
        if key in self.participants:
            return  # duplicate

        if not entry.is_subscriber and not self.settings.allow_non_subs:
            return

        weight = calculate_weight(
            entry.is_subscriber,
            entry.sub_months,
            non_sub_weight=self.settings.non_sub_weight,
            mode=self.settings.sub_weight_mode,
            constant_weight=self.settings.sub_constant_weight,
            log_multiplier=self.settings.sub_log_multiplier,
            linear_multiplier=self.settings.sub_linear_multiplier,
        )

        participant = Participant(
            user_id=entry.user_id,
            platform=entry.platform,
            username=entry.username,
            display_name=entry.display_name,
            is_subscriber=entry.is_subscriber,
            sub_months=entry.sub_months,
            weight=weight,
        )
        self.participants[key] = participant

        await self._fire("participant_added", {
            "participant": participant.to_dict(),
            "count": len(self.participants),
        })

    # --- Getters ---

    def get_participants(self) -> list[dict]:
        return [p.to_dict() for p in self.participants.values()]

    def get_status(self) -> dict:
        return {
            "state": self.state.value,
            "keyword": self.settings.keyword,
            "participant_count": len(self.participants),
            "allow_non_subs": self.settings.allow_non_subs,
            "non_sub_weight": self.settings.non_sub_weight,
            "last_result": self.last_result.to_dict() if self.last_result else None,
        }
