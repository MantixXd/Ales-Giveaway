import os
import sys
from pathlib import Path

# In --windowed mode, sys.stdin/stdout/stderr are None — fix before anything else
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")
if sys.stdin is None:
    sys.stdin = open(os.devnull, "r")

# Ensure working directory is the exe's directory
if getattr(sys, 'frozen', False):
    os.chdir(Path(sys.executable).parent)


try:
    import asyncio
    import logging
    import threading
    import webbrowser

    import uvicorn

    # Add project root to path for imports
    sys.path.insert(0, str(Path(__file__).parent))

    from paths import get_base_dir, get_config_path
    from config.settings import load_settings
    from engine.giveaway import GiveawayEngine
    from connectors.twitch_connector import TwitchConnector
    from connectors.kick_connector import KickConnector
    from web.app import create_app
except Exception as e:
    import traceback
    print(f"\n=== IMPORT ERROR ===\n{e}\n")
    traceback.print_exc()
    input("\nPress Enter to close...")
    sys.exit(1)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("giveaway")


def open_browser(port: int) -> None:
    """Open control panel in default browser after a short delay."""
    import time
    time.sleep(1.5)
    url = f"http://localhost:{port}"
    logger.info(f"Opening browser: {url}")
    webbrowser.open(url)


def ensure_config() -> Path:
    """Copy default config.yaml next to .exe if it doesn't exist yet."""
    config_path = get_config_path()
    if not config_path.exists():
        default = Path(__file__).parent / "config.yaml"
        if default.exists() and default != config_path:
            import shutil
            shutil.copy2(default, config_path)
            logger.info(f"Created default config at {config_path}")
        else:
            # Write a minimal default config
            config_path.write_text(
                "# Giveaway Tool Configuration\n\n"
                "twitch_enabled: false\n"
                'twitch_channel: ""\n\n'
                "kick_enabled: false\n"
                'kick_channel_slug: ""\n'
                "kick_chatroom_id: null\n\n"
                'keyword: "!giveaway"\n'
                "allow_non_subs: true\n"
                "non_sub_weight: 1.0\n"
                'sub_weight_mode: "logarithmic"\n'
                "sub_constant_weight: 2.0\n\n"
                'host: "0.0.0.0"\n'
                "port: 8888\n",
                encoding="utf-8",
            )
            logger.info(f"Created default config at {config_path}")
    return config_path


class ConnectorManager:
    """Manages chat connectors with hot-reload support."""

    def __init__(self, engine: GiveawayEngine) -> None:
        self.engine = engine
        self._connectors: list[tuple[str, object]] = []
        self._tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        """Start connectors based on current settings."""
        settings = self.engine.settings

        if settings.twitch_enabled and settings.twitch_channel:
            tc = TwitchConnector(settings)
            tc.set_message_callback(self.engine.handle_chat_entry)
            self._connectors.append(("Twitch", tc))
            logger.info(f"Twitch connector: #{settings.twitch_channel}")

        if settings.kick_enabled and settings.kick_channel_slug:
            kc = KickConnector(settings)
            kc.set_message_callback(self.engine.handle_chat_entry)
            self._connectors.append(("Kick", kc))
            logger.info(f"Kick connector: {settings.kick_channel_slug}")

        for name, connector in self._connectors:
            task = asyncio.create_task(connector.start(), name=f"{name}-connector")
            self._tasks.append(task)

    async def stop(self) -> None:
        """Stop all running connectors."""
        for name, connector in self._connectors:
            await connector.stop()
        for task in self._tasks:
            task.cancel()
        self._connectors.clear()
        self._tasks.clear()

    async def restart(self) -> None:
        """Stop and re-start connectors with current settings."""
        logger.info("Reconnecting chat connectors...")
        await self.stop()
        await asyncio.sleep(0.5)
        await self.start()
        logger.info("Connectors restarted.")


async def main():
    config_path = ensure_config()
    settings = load_settings(config_path)
    engine = GiveawayEngine(settings)

    # Connector manager (shared with web routes for hot-reload)
    manager = ConnectorManager(engine)

    # Create web app
    app = create_app(engine, connector_manager=manager)

    # Start connectors
    await manager.start()

    # Auto-open browser
    logger.info(f"Starting web server on http://{settings.host}:{settings.port}")
    logger.info(f"Control panel: http://localhost:{settings.port}/")
    logger.info(f"OBS Overlay:   http://localhost:{settings.port}/overlay")

    threading.Thread(target=open_browser, args=(settings.port,), daemon=True).start()

    # Start web server
    config = uvicorn.Config(app, host=settings.host, port=settings.port, log_level="info")
    server = uvicorn.Server(config)

    try:
        await server.serve()
    finally:
        await manager.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"\n\n=== ERROR ===\n{e}\n")
        import traceback
        traceback.print_exc()
        input("\nPress Enter to close...")
    except KeyboardInterrupt:
        print("\nShutting down...")
