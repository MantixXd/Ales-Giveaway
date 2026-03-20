from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class Participant:
    user_id: str
    platform: str
    username: str
    display_name: str
    is_subscriber: bool
    sub_months: int
    weight: float
    entered_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "platform": self.platform,
            "username": self.username,
            "display_name": self.display_name,
            "is_subscriber": self.is_subscriber,
            "sub_months": self.sub_months,
            "weight": round(self.weight, 2),
            "entered_at": self.entered_at.isoformat(),
        }


@dataclass
class DrawResult:
    winner: Participant
    total_participants: int
    total_weight: float
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict:
        return {
            "winner": self.winner.to_dict(),
            "total_participants": self.total_participants,
            "total_weight": round(self.total_weight, 2),
            "timestamp": self.timestamp.isoformat(),
        }
