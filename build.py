"""Build standalone .exe using PyInstaller.

Usage:
    pip install pyinstaller
    python build.py

Output: dist/GiveawayTool/GiveawayTool.exe + config.yaml
"""

import subprocess
import shutil
from pathlib import Path

ROOT = Path(__file__).parent
DIST = ROOT / "dist" / "GiveawayTool"


def build():
    import sys
    pyinstaller_bin = str(Path(sys.executable).parent / "Scripts" / "pyinstaller.exe")
    cmd = [
        pyinstaller_bin,
        "--noconfirm",
        "--name", "GiveawayTool",
        # Collect as directory (--onedir), not single-file
        # Single-file is slow to start and has temp extraction issues
        "--onedir",
        # Console window stays open so streamer sees logs
        "--console",
        # Icon (optional, skip if not present)
        # "--icon", "icon.ico",
        # Bundle static web files
        "--add-data", f"web/static;web/static",
        # Bundle paths helper
        "--add-data", f"paths.py;.",
        # Hidden imports that PyInstaller may miss
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.loops",
        "--hidden-import", "uvicorn.loops.auto",
        "--hidden-import", "uvicorn.protocols",
        "--hidden-import", "uvicorn.protocols.http",
        "--hidden-import", "uvicorn.protocols.http.auto",
        "--hidden-import", "uvicorn.protocols.websockets",
        "--hidden-import", "uvicorn.protocols.websockets.auto",
        "--hidden-import", "uvicorn.lifespan",
        "--hidden-import", "uvicorn.lifespan.on",
        "--hidden-import", "uvicorn.lifespan.off",
        "--hidden-import", "engineio.async_drivers.threading",
        "--hidden-import", "engineio.async_drivers.asgi",
        # Collect all submodules for these packages
        "--collect-submodules", "twitchio",
        "--collect-submodules", "socketio",
        "--collect-submodules", "engineio",
        "--collect-submodules", "uvicorn",
        # Entry point
        str(ROOT / "main.py"),
    ]

    print("Building .exe with PyInstaller...")
    print(f"Command: {' '.join(cmd)}")
    subprocess.run(cmd, cwd=str(ROOT), check=True)

    # Copy config.yaml next to the .exe
    config_src = ROOT / "config.yaml"
    config_dst = DIST / "config.yaml"
    if config_src.exists():
        shutil.copy2(config_src, config_dst)
        print(f"Copied config.yaml to {config_dst}")

    # Copy DLLs that PyInstaller misses (conda env) into _internal/
    conda_bin = Path(sys.executable).parent / "Library" / "bin"
    internal_dir = DIST / "_internal"
    dlls_to_copy = [
        "libssl-3-x64.dll",
        "libcrypto-3-x64.dll",
        "liblzma.dll",
        "ffi.dll",
        "libexpat.dll",
        "libbz2.dll",
    ]
    for dll_name in dlls_to_copy:
        dll_src = conda_bin / dll_name
        if dll_src.exists():
            shutil.copy2(dll_src, internal_dir / dll_name)
            print(f"Copied {dll_name} to _internal/")

    print()
    print("=" * 50)
    print("BUILD COMPLETE!")
    print(f"Output: {DIST}")
    print()
    print("To distribute:")
    print(f"  1. Zip the folder: {DIST}")
    print(f"  2. Streamer unzips, edits config.yaml")
    print(f"  3. Double-clicks GiveawayTool.exe")
    print(f"  4. Browser opens automatically")
    print("=" * 50)


if __name__ == "__main__":
    build()
