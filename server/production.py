"""Production entrypoint: API, WebSockets, uploads, and frontend on one origin."""

from server.db import ROOT
from server.frontend import FrontendFiles
from server.main import app

# Mount last so existing /api, /ws, /storage, and documentation routes take priority.
app.mount("/", FrontendFiles(directory=ROOT / "web" / "dist", html=True), name="frontend")
