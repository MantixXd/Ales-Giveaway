from __future__ import annotations

import math


def calculate_weight(
    is_subscriber: bool,
    sub_months: int,
    *,
    non_sub_weight: float = 1.0,
    mode: str = "logarithmic",
    constant_weight: float = 2.0,
    log_multiplier: float = 1.0,
    linear_multiplier: float = 1.0,
) -> float:
    """Calculate weighted entry value.

    Modes:
        logarithmic: 1 + multiplier * log2(months+1)  — diminishing returns
        linear:      months + 1                        — proportional to tenure
        constant:    fixed value for any subscriber
    """
    if not is_subscriber:
        return non_sub_weight

    if mode == "linear":
        return 1.0 + linear_multiplier * sub_months
    elif mode == "constant":
        return constant_weight
    else:  # logarithmic (default)
        return 1.0 + log_multiplier * math.log2(sub_months + 1)
