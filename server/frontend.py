"""Serve the built React app alongside the API on a single deployment origin."""

from pathlib import Path

from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles


class FrontendFiles(StaticFiles):
    async def get_response(self, path, scope):
        # Missing API endpoints and assets must stay 404s, not return React HTML.
        if path.split("/", 1)[0] in {"api", "ws", "storage"}:
            raise HTTPException(status_code=404)
        try:
            return await super().get_response(path, scope)
        except HTTPException as error:
            if error.status_code != 404 or Path(path).suffix:
                raise
            return await super().get_response("index.html", scope)
