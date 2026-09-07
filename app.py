import sys
from pathlib import Path

# Vercel loads this file without installing the repository's src-layout package.
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from crystalsketch.server.cloud import app  # noqa: E402, F401
