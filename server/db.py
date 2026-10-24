"""SQLite schema (SQLModel) for SiteTwin: sites, events, bookings, closures, asset moves, added doors.

The database lives in `storage/sitetwin.db`. Set SITETWIN_STORAGE to use another storage directory
(tests do this). Everything here is synchronous; FastAPI runs sync handlers in a thread pool."""

from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import Column, Text
from sqlmodel import Field, Session, SQLModel, create_engine, select

ROOT = Path(__file__).resolve().parent.parent


def storage_dir() -> Path:
    path = Path(os.environ.get("SITETWIN_STORAGE", ROOT / "storage"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


class SiteRow(SQLModel, table=True):
    __tablename__ = "sites"
    id: str = Field(primary_key=True)
    name: str
    lat: float
    lon: float
    source: str
    building_id: str
    data_path: str
    floors: int = 1
    demo_location: bool = True
    kind: str = "other"
    user_created: bool = False
    address: str | None = None
    created_at: str = Field(default_factory=now_iso)

    def to_site(self) -> dict:
        return {
            "id": self.id, "name": self.name, "lat": self.lat, "lon": self.lon, "source": self.source,
            "building_id": self.building_id, "data_path": self.data_path, "floors": self.floors,
            "demo_location": self.demo_location, "kind": self.kind, "address": self.address,
        }


class EventRow(SQLModel, table=True):
    __tablename__ = "events"
    id: str = Field(primary_key=True)
    ts: str = Field(index=True)
    site_id: str = Field(index=True)
    type: str
    title: str
    payload_json: str = Field(default="{}", sa_column=Column(Text))

    def to_event(self) -> dict:
        return {"id": self.id, "ts": self.ts, "site_id": self.site_id, "type": self.type,
                "title": self.title, "payload": json.loads(self.payload_json or "{}")}


class BookingRow(SQLModel, table=True):
    __tablename__ = "bookings"
    id: str = Field(primary_key=True)
    site_id: str = Field(index=True)
    space_id: str
    start: str
    end: str
    who: str = ""
    title: str = ""

    def to_booking(self) -> dict:
        return {"id": self.id, "site_id": self.site_id, "space_id": self.space_id, "start": self.start,
                "end": self.end, "who": self.who, "title": self.title}


class ClosureRow(SQLModel, table=True):
    __tablename__ = "closures"
    site_id: str = Field(primary_key=True)
    element_id: str = Field(primary_key=True)
    ts: str = Field(default_factory=now_iso)


class AssetMoveRow(SQLModel, table=True):
    __tablename__ = "asset_moves"
    site_id: str = Field(primary_key=True)
    asset_id: str = Field(primary_key=True)
    space_id: str
    floor_id: str
    x: float
    y: float
    ts: str = Field(default_factory=now_iso)


class AddedDoorRow(SQLModel, table=True):
    __tablename__ = "added_doors"
    id: str = Field(primary_key=True)
    site_id: str = Field(index=True)
    opening_json: str = Field(sa_column=Column(Text))
    ts: str = Field(default_factory=now_iso)


class AddedAssetRow(SQLModel, table=True):
    """Equipment/machines/furniture added by hand (contract Asset shape in asset_json)."""
    __tablename__ = "added_assets"
    id: str = Field(primary_key=True)
    site_id: str = Field(index=True)
    asset_json: str = Field(sa_column=Column(Text))
    ts: str = Field(default_factory=now_iso)


class AssetEditRow(SQLModel, table=True):
    """Edits of assets from building.json: the whole edited Asset, or removed=True when deleted."""
    __tablename__ = "asset_edits"
    site_id: str = Field(primary_key=True)
    asset_id: str = Field(primary_key=True)
    asset_json: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    removed: bool = False
    ts: str = Field(default_factory=now_iso)


class RemovedDeliveryRow(SQLModel, table=True):
    """Deleted deliveries (also hides ones that live in the capture job store)."""
    __tablename__ = "removed_deliveries"
    site_id: str = Field(primary_key=True)
    delivery_id: str = Field(primary_key=True)
    ts: str = Field(default_factory=now_iso)


class DeliveryRow(SQLModel, table=True):
    """Deliveries recorded through the server (seed script, or capture when it has no store of its own)."""
    __tablename__ = "deliveries"
    id: str = Field(primary_key=True)
    site_id: str = Field(index=True)
    ts: str
    payload_json: str = Field(sa_column=Column(Text))


_engine = None
_engine_path: Path | None = None


def engine():
    global _engine, _engine_path
    path = storage_dir() / "sitetwin.db"
    if _engine is None or _engine_path != path:
        _engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
        _engine_path = path
        SQLModel.metadata.create_all(_engine)
        _add_missing_columns(_engine)
    return _engine


def _add_missing_columns(eng) -> None:
    """create_all never alters existing tables; add columns introduced after a database was created."""
    from sqlalchemy import text

    with eng.begin() as conn:
        columns = {row[1] for row in conn.execute(text("PRAGMA table_info(sites)"))}
        if "address" not in columns:
            conn.execute(text("ALTER TABLE sites ADD COLUMN address VARCHAR"))


def session() -> Session:
    return Session(engine())


def reset_engine() -> None:
    """Forget the cached engine (tests switch SITETWIN_STORAGE)."""
    global _engine, _engine_path
    if _engine is not None:
        _engine.dispose()
    _engine, _engine_path = None, None


__all__ = [
    "AddedAssetRow", "AddedDoorRow", "AssetEditRow", "AssetMoveRow", "BookingRow", "ClosureRow", "DeliveryRow", "EventRow",
    "RemovedDeliveryRow", "SiteRow",
    "engine", "new_id", "now_iso", "reset_engine", "select", "session", "storage_dir", "ROOT",
]
