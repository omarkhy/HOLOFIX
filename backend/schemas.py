"""
schemas.py — the single source of truth for HOLOFIX data.

Everything flows through PartsGraph:
  Muse Spark extraction  ->  PartsGraph (validated here)  ->  JSON  ->  Three.js viewer
  Diagnosis engine reads PartsGraph to know which part ids it may highlight.

Design choices (things to be able to explain in an interview):
- Connections live in ONE list at graph level, not inside each part, so an edge is
  stored once and can't be described differently from each end.
- Geometry is deliberately coarse: a shape type + a rough size + a layer index.
  The viewer builds stylised shapes from that; we never claim accurate CAD.
- Every part carries provenance (source_url + confidence). Fallback templates are
  flagged provenance="generated" so the UI can label them "unverified".
- Hazards are data, not prompt text: safety rules in safety.py key off Part.hazard,
  so a hard stop can't be talked around by the LLM.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator, model_validator

ID_PATTERN = r"^[a-z0-9_]+$"  # snake_case ids, e.g. "logic_board"


# ---------- Enums: closed vocabularies the LLM must pick from ----------

class ShapeType(str, Enum):
    """Which procedural primitive the viewer draws. Resemblance, not replica."""
    slab = "slab"            # flat rectangle: battery cell, display panel, chassis
    board = "board"          # PCB with chip bumps on top
    chip = "chip"            # small square: SoC, RAM, SSD controller
    cylinder = "cylinder"    # fan, speaker magnet, motor, car battery post
    cable = "cable"          # flex cable / wiring harness (thin curved tube)
    box = "box"              # generic block: fuse box, starter, ECU
    frame = "frame"          # hollow rectangle: bezel, trackpad frame
    screw = "screw"          # tiny cylinder, used for fastener markers


class Serviceability(str, Enum):
    replaceable = "replaceable"          # remove with screws/connectors
    glued = "glued"                      # replaceable but adhesive (care needed)
    soldered = "soldered"                # on the board; board-level repair only
    not_serviceable = "not_serviceable"  # e.g. sealed unit


class ConnectionKind(str, Enum):
    power = "power"
    data = "data"
    mechanical = "mechanical"   # screwed/clipped to
    thermal = "thermal"         # heat spreader / heat pipe


class Hazard(str, Enum):
    """Anything in here triggers a safety hard stop (diagnosis only, no steps)."""
    lithium_battery = "lithium_battery"
    mains_voltage = "mains_voltage"
    hv_capacitor = "hv_capacitor"
    ev_high_voltage = "ev_high_voltage"
    airbag = "airbag"
    brakes = "brakes"
    fuel_system = "fuel_system"


class Provenance(str, Enum):
    sourced = "sourced"       # extracted from a cited teardown/guide/spec
    generated = "generated"   # fallback template or model guess -> "unverified"


class Difficulty(str, Enum):
    green = "green"     # do it at home
    yellow = "yellow"   # needs tools / care
    red = "red"         # technician only


# ---------- Building blocks ----------

class Device(BaseModel):
    model_name: str = Field(..., description="As typed/resolved, e.g. 'MacBook Air (M1, 2020)'")
    variant_id: str = Field(..., pattern=ID_PATTERN, description="e.g. 'macbook_air_m1_2020'")
    category: str = Field(..., description="laptop, phone, car, ...")
    configuration: dict[str, str] = Field(
        default_factory=dict,
        description="Purchase-time options, e.g. {'ram': '8 GB', 'storage': '256 GB'}",
    )


class System(BaseModel):
    """A group of parts. parent_id makes a tree -> hierarchical explode for cars."""
    id: str = Field(..., pattern=ID_PATTERN)
    name: str
    parent_id: Optional[str] = Field(None, description="None = top-level system")


class Size(BaseModel):
    """Rough size RELATIVE to the device bounding box (each axis 0..1).
    w = width (x), d = depth (y, front-to-back), h = thickness (z)."""
    w: float = Field(..., gt=0, le=1)
    d: float = Field(..., gt=0, le=1)
    h: float = Field(..., gt=0, le=1)


class Position(BaseModel):
    """Centre of the part on the device footprint, 0..1 from front-left corner.
    Vertical placement comes from Part.layer, not from here."""
    x: float = Field(..., ge=0, le=1)
    y: float = Field(..., ge=0, le=1)


class Part(BaseModel):
    id: str = Field(..., pattern=ID_PATTERN)
    name: str
    function: str = Field(..., description="One sentence: what it does")
    system_id: str
    layer: int = Field(..., ge=0, description="Stack order, 0 = bottom. Explode moves along this axis.")
    shape: ShapeType
    size: Size
    position: Position
    serviceability: Serviceability
    specs: dict[str, str] = Field(
        default_factory=dict,
        description="Values for THIS configuration only, e.g. {'capacity': '49.9 Wh'}",
    )
    hazard: Optional[Hazard] = None
    source_url: Optional[str] = None
    confidence: float = Field(..., ge=0, le=1)

    @field_validator("source_url")
    @classmethod
    def url_looks_real(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not re.match(r"^https?://", v):
            raise ValueError(f"source_url must start with http(s)://, got {v!r}")
        return v


class Connection(BaseModel):
    """A REAL link between two parts. Drawn as a glowing fibre. Never decorative."""
    source: str
    target: str
    kind: ConnectionKind
    label: Optional[str] = Field(None, description="e.g. 'battery flex', 'eDP display cable'")


class RepairStep(BaseModel):
    order: int = Field(..., ge=1)
    action: str = Field(..., description="e.g. 'Remove the 10 bottom-case screws'")
    removes_part_ids: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    # Precise numbers (screw lengths, torques) ONLY if a source is cited below.
    fastener_detail: Optional[str] = None
    source_url: Optional[str] = None

    @model_validator(mode="after")
    def no_precise_specs_without_source(self) -> "RepairStep":
        if self.fastener_detail and not self.source_url:
            raise ValueError("fastener_detail given without source_url (rule: never invent precise specs)")
        return self


class RepairPath(BaseModel):
    target_part_id: str
    difficulty: Difficulty
    steps: list[RepairStep]


# ---------- The whole graph ----------

class PartsGraph(BaseModel):
    schema_version: str = "1.0"
    device: Device
    provenance: Provenance
    systems: list[System]
    parts: list[Part]
    connections: list[Connection] = Field(default_factory=list)
    repair_paths: list[RepairPath] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list, description="All URLs consulted")

    @model_validator(mode="after")
    def check_references(self) -> "PartsGraph":
        """Catch the typical LLM failure: referring to ids that don't exist."""
        errors: list[str] = []

        system_ids = [s.id for s in self.systems]
        part_ids = [p.id for p in self.parts]

        # 1. ids must be unique
        for name, ids in (("system", system_ids), ("part", part_ids)):
            dupes = {i for i in ids if ids.count(i) > 1}
            if dupes:
                errors.append(f"duplicate {name} ids: {sorted(dupes)}")

        sys_set, part_set = set(system_ids), set(part_ids)

        # 2. system tree + part -> system references
        for s in self.systems:
            if s.parent_id is not None and s.parent_id not in sys_set:
                errors.append(f"system '{s.id}' has unknown parent '{s.parent_id}'")
        for p in self.parts:
            if p.system_id not in sys_set:
                errors.append(f"part '{p.id}' has unknown system '{p.system_id}'")

        # 3. connections
        for c in self.connections:
            for end in (c.source, c.target):
                if end not in part_set:
                    errors.append(f"connection {c.source}->{c.target}: unknown part '{end}'")
            if c.source == c.target:
                errors.append(f"self-connection on '{c.source}'")

        # 4. repair paths
        for rp in self.repair_paths:
            if rp.target_part_id not in part_set:
                errors.append(f"repair path targets unknown part '{rp.target_part_id}'")
            for st in rp.steps:
                for pid in st.removes_part_ids:
                    if pid not in part_set:
                        errors.append(f"repair step {st.order} removes unknown part '{pid}'")

        if errors:
            raise ValueError("PartsGraph reference errors:\n  - " + "\n  - ".join(errors))
        return self
