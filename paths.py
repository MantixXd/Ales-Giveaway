"""Resolve file paths for both normal and PyInstaller-bundled execution."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _is_frozen() -> bool:
    return getattr(sys, "frozen", False)


def get_base_dir() -> Path:
    """Directory where the .exe (or main.py) lives."""
    if _is_frozen():
        return Path(sys.executable).parent
    return Path(__file__).parent


def get_bundle_dir() -> Path:
    """Directory where bundled data files live (static/, etc.)."""
    if _is_frozen():
        # PyInstaller extracts --add-data files into sys._MEIPASS
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).parent


def get_static_dir() -> Path:
    return get_bundle_dir() / "web" / "static"


def get_appdata_dir() -> Path:
    """Return %APPDATA%/GiveawayTool/, creating it if needed."""
    appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    d = appdata / "GiveawayTool"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_config_path() -> Path:
    if _is_frozen():
        return get_appdata_dir() / "config.yaml"
    return get_base_dir() / "config.yaml"
