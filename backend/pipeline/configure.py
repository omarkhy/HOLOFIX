"""
configure.py — step 2: a chosen variant -> its purchase-time options (like a store configurator).

Why it matters for repair: on the M1 MacBook Air, memory and storage are chosen at purchase and
soldered forever. The configuration changes which specs we show and what can be upgraded.

Two calls, same pattern as identify.py: web research, then structuring into ConfigOptions.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from backend import meta_client
from backend.pipeline.identify import Variant


class ConfigOption(BaseModel):
    key: str = Field(..., pattern=r"^[a-z0-9_]+$", description="e.g. memory, storage, chip, color")
    label: str = Field(..., description="Shown to the user, e.g. 'Memory'")
    choices: list[str] = Field(..., min_length=1, description="e.g. ['8 GB', '16 GB']")
    default: str = Field(..., description="The base model's choice; must be one of choices")
    upgradeable_later: Optional[bool] = Field(None, description="False if soldered/fixed at purchase; None if unknown")
    note: Optional[str] = Field(None, description="One line, e.g. 'Soldered into the M1 package'")


class ConfigOptions(BaseModel):
    variant_id: str
    options: list[ConfigOption]
    sources: list[str] = Field(default_factory=list)


RESEARCH_PROMPT = """Device: {model_name} (model numbers: {numbers}).

Search the web for the configuration options a buyer could choose when purchasing THIS exact model:
processor/chip and GPU variants, memory (RAM), storage, colour, and any other build-to-order option
(e.g. display, keyboard is NOT needed). For each option list every choice and the base-model default.
Also say whether each can be upgraded after purchase (e.g. soldered RAM = no). Cite source URLs."""

STRUCTURE_PROMPT = """Turn these research notes into the JSON schema for {model_name} (variant_id: {variant_id}).

Rules:
- Keys: chip, memory, storage, color when they exist; other options only if real for this model.
- 'default' must be exactly one of 'choices'.
- Only list choices this exact model was sold with. Omit an option rather than guessing.
- sources: URLs from the notes only.

Research notes:
{notes}

URLs found:
{urls}"""


def configure(variant: Variant) -> ConfigOptions:
    notes, urls = meta_client.web_research(RESEARCH_PROMPT.format(
        model_name=variant.model_name, numbers=", ".join(variant.model_numbers) or "unknown"),
        label=f"Looking up how the {variant.model_name} was sold…")
    result = meta_client.structured(
        STRUCTURE_PROMPT.format(model_name=variant.model_name, variant_id=variant.variant_id,
                                notes=notes, urls="\n".join(urls) or "(none)"),
        ConfigOptions, label="Reading the purchase options…",
    )
    result.variant_id = variant.variant_id
    for opt in result.options:                       # a default outside the choices would break the UI
        if opt.default not in opt.choices:
            opt.default = opt.choices[0]
    result.sources = [u for u in result.sources if u in urls] or urls
    return result
