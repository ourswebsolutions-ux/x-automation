"""Entry point used by the desktop app: python -I run.py

Isolated mode (-I) ignores PYTHON* environment variables and the user's
site-packages, and does not add the script's folder to sys.path — so the
engine's own folder is added here explicitly.
"""
import os
import stat
import sys


def _close_inherited_sockets() -> None:
    """Close sockets leaked into this process by the parent (POSIX only).

    Some parent sockets (e.g. a debugging listener) are not close-on-exec;
    the engine must never hold a listening port, even an inherited one.
    """
    if os.name != "posix" or not os.path.isdir("/proc/self/fd"):
        return
    for name in os.listdir("/proc/self/fd"):
        fd = int(name)
        if fd <= 2:
            continue
        try:
            if stat.S_ISSOCK(os.fstat(fd).st_mode):
                os.close(fd)
        except OSError:
            pass


_close_inherited_sockets()
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from axora_engine.main import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
