"""Equipment catalog for manually added assets: type → category and typical footprint.

Footprints are the dataset medians (all building.json files under data/), so an item added by hand
looks like its neighbours. Unknown types are allowed; they get the 'equipment' category and 1 × 1 m."""

from __future__ import annotations

import re

# type: (category, width_m, depth_m)
CATALOG: dict[str, tuple[str, float, float]] = {
    # machines
    "cnc_mill": ("machine", 3.0, 2.5),
    "cnc_lathe": ("machine", 3.5, 2.0),
    "milling_machine": ("machine", 2.0, 1.8),
    "drill_press": ("machine", 0.8, 0.8),
    "press_brake": ("machine", 4.0, 1.8),
    "laser_cutter": ("machine", 1.4, 0.9),
    "waterjet_cutter": ("machine", 4.0, 3.0),
    "injection_moulding_machine": ("machine", 5.0, 2.0),
    "robot_cell": ("machine", 4.0, 4.0),
    "conveyor": ("machine", 6.0, 1.0),
    "coordinate_measuring_machine": ("machine", 2.0, 1.5),
    "3d_printer": ("machine", 0.6, 0.6),
    "industrial_3d_printer": ("machine", 1.5, 1.2),
    "curing_oven": ("machine", 1.2, 1.0),
    "compressor": ("machine", 1.5, 1.0),
    "boiler": ("machine", 1.0, 1.0),
    "hvac_unit": ("machine", 2.0, 1.2),
    "forklift": ("machine", 2.5, 1.2),
    # equipment
    "welding_station": ("equipment", 2.0, 2.0),
    "soldering_station": ("equipment", 1.2, 0.6),
    "oscilloscope_station": ("equipment", 1.2, 0.7),
    "fume_hood": ("equipment", 1.5, 0.8),
    "microscope": ("equipment", 0.5, 0.5),
    "pallet_jack": ("equipment", 1.6, 0.7),
    "forklift_charging_station": ("equipment", 1.5, 1.0),
    "server_rack": ("equipment", 0.6, 1.2),
    "ups_unit": ("equipment", 0.6, 0.8),
    "electrical_panel": ("equipment", 1.0, 0.3),
    "coffee_machine": ("equipment", 0.4, 0.4),
    "water_dispenser": ("equipment", 0.4, 0.4),
    "vending_machine": ("equipment", 0.9, 0.8),
    "fridge": ("equipment", 0.6, 0.65),
    "microwave": ("equipment", 0.5, 0.4),
    "dishwasher": ("equipment", 0.6, 0.6),
    "stove": ("equipment", 0.6, 0.6),
    "washing_machine": ("equipment", 0.6, 0.6),
    "printer": ("equipment", 0.6, 0.5),
    "multifunction_printer": ("equipment", 0.8, 0.7),
    "display_screen": ("equipment", 1.6, 0.3),
    "projector": ("equipment", 0.4, 0.3),
    "projector_screen": ("equipment", 2.4, 0.15),
    "whiteboard": ("equipment", 1.8, 0.1),
    "fire_extinguisher": ("equipment", 0.3, 0.3),
    "defibrillator": ("equipment", 0.4, 0.2),
    "eyewash_station": ("equipment", 0.5, 0.4),
    # furniture
    "workbench": ("furniture", 2.0, 0.8),
    "assembly_station": ("furniture", 2.4, 1.2),
    "inspection_bench": ("furniture", 2.0, 0.8),
    "packing_station": ("furniture", 2.0, 1.0),
    "lab_bench": ("furniture", 3.0, 0.8),
    "tool_cabinet": ("furniture", 1.0, 0.6),
    "chemical_cabinet": ("furniture", 1.0, 0.5),
    "pallet_rack": ("furniture", 2.7, 1.1),
    "shelf": ("furniture", 1.0, 0.4),
    "locker": ("furniture", 0.9, 0.5),
    "filing_cabinet": ("furniture", 0.5, 0.6),
    "desk": ("furniture", 1.4, 0.7),
    "office_chair": ("furniture", 0.6, 0.6),
    "chair": ("furniture", 0.5, 0.5),
    "meeting_table": ("furniture", 2.4, 1.1),
    "sofa": ("furniture", 2.0, 0.9),
    "plant": ("furniture", 0.4, 0.4),
}
DEFAULT_CATEGORY = "equipment"
DEFAULT_SIZE_M = (1.0, 1.0)
CATEGORIES = ("machine", "equipment", "furniture", "fixture")


def slug(text: str) -> str:
    """'Coffee machine' → 'coffee_machine'."""
    return re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")


ACRONYMS = {"cnc": "CNC", "ups": "UPS", "hvac": "HVAC", "3d": "3D", "it": "IT"}


def label(type_: str) -> str:
    """'coffee_machine' → 'Coffee machine', 'cnc_mill' → 'CNC mill'."""
    words = [ACRONYMS.get(word, word) for word in type_.replace("_", " ").split()]
    text = " ".join(words)
    return text[:1].upper() + text[1:]


def defaults(type_: str) -> tuple[str, float, float]:
    """(category, width_m, depth_m) for a type; unknown types get generic equipment defaults."""
    return CATALOG.get(type_, (DEFAULT_CATEGORY, *DEFAULT_SIZE_M))


def catalog() -> list[dict]:
    return [{"type": type_, "label": label(type_), "category": category, "width_m": width, "depth_m": depth}
            for type_, (category, width, depth) in CATALOG.items()]
