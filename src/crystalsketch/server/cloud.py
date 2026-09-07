"""Cloud entry point; the local application's same-origin behavior is unchanged."""

import os

from fastapi.middleware.cors import CORSMiddleware

from crystalsketch.server.app import create_app

app = create_app(dev_static_fallback=False)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("CRYSTALSKETCH_WEB_ORIGIN", "https://christanding.github.io")],
    allow_methods=["GET", "POST"],
    allow_headers=[
        "Content-Type", "x-crystalsketch-filename", "x-crystalsketch-bond-cutoff-overrides",
    ],
    max_age=86400,
)
