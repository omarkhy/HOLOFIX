"""
safety.py — hard stops, in plain code (not in a prompt), so no wording of a question can talk
the system into giving step-by-step instructions for something dangerous.

Two independent triggers:
  1. The SYMPTOM text matches a danger pattern (swollen battery, smoke, mains, airbag…).
  2. A SUSPECT PART carries a hazard in the parts graph (battery = lithium_battery…).
When either fires, diagnosis still explains what is likely wrong, but every fix becomes
"red / see a professional" with no steps.
"""

from __future__ import annotations

import re
from typing import Optional

# (pattern, message). Patterns are matched case-insensitively against the user's own words.
DANGER = [
    (r"swell|swollen|bulg|puff|pillow|(lift(ed|ing)?|raised|pushed up) (the )?(trackpad|case|keyboard)"
     r"|(trackpad|case|keyboard)\b.{0,30}\b(raised|lifted|lifting|pushed up)",
     "A swollen lithium battery can catch fire. Stop using and charging the device, keep it away from anything flammable, and take it to a repair professional. Do not press on it or puncture it."),
    # \b: "misfire" and "spark plug" are not emergencies.
    (r"smoke|smoking|burning smell|smells? (like )?burn|\bfire\b|\bflames?\b|\bsparks?\b(?! plugs?)",
     "Smoke, sparks or a burning smell mean a possible short circuit or battery failure. Unplug it if it is safe to do so, move it away from flammable things, and have it checked by a professional."),
    (r"punctur|pierc|crushed battery|leak(ing)? (from )?(the )?battery|battery (is )?(hot|very hot|leak)",
     "A damaged or overheating lithium battery is a fire risk. Do not use or charge the device; take it to a professional."),
    (r"mains|230 ?v|220 ?v|110 ?v|power supply (board|unit)|psu (inside|internal)|capacitor",
     "Mains voltage and large capacitors can stay dangerous after unplugging. Internal repairs are for a qualified technician."),
    (r"microwave", "Microwave ovens hold lethal voltages even when unplugged. Technician only."),
    (r"airbag|srs light|srs warning", "Airbag systems can deploy during work and cause injury. Technician only."),
    (r"brake|braking|abs light", "Brakes are safety-critical. Have them inspected by a professional before driving."),
    (r"fuel (leak|smell)|smell(s)? (of )?(fuel|petrol|gas(oline)?)|petrol leak",
     "A fuel leak is a fire risk. Do not start the engine; have it towed or inspected by a professional."),
    (r"high.?voltage|orange cable|hybrid battery|ev battery|traction battery",
     "Electric-vehicle high-voltage systems can be lethal. Certified technician only."),
]

HAZARD_MESSAGES = {
    "lithium_battery": "This involves the lithium battery. Battery work carries a fire risk: if it is swollen, damaged or hot, have it replaced by a professional.",
    "mains_voltage": "This involves mains voltage. Technician only.",
    "hv_capacitor": "This involves high-voltage capacitors that stay charged after unplugging. Technician only.",
    "ev_high_voltage": "This involves the high-voltage system. Certified technician only.",
    "airbag": "This involves the airbag system. Technician only.",
    "brakes": "This involves the brakes, which are safety-critical. Technician only.",
    "fuel_system": "This involves the fuel system (fire risk). Technician only.",
}


def symptom_stop(text: str) -> Optional[str]:
    """Message if the user's words describe a dangerous situation, else None."""
    for pattern, message in DANGER:
        if re.search(pattern, text, re.IGNORECASE):
            return message
    return None


# Hazards that ALWAYS mean "technician only", whatever the symptom. A lithium battery is not in this
# list: replacing a worn battery is a normal repair; only a swollen/damaged/hot one is a hard stop,
# and that is caught from the user's words by symptom_stop().
ALWAYS_STOP = {"mains_voltage", "hv_capacitor", "ev_high_voltage", "airbag", "brakes", "fuel_system"}

BATTERY_CAUTION = ("Lithium battery: before you start, check it is not swollen, punctured or hot. If it is, stop "
                   "and take it to a professional. Never pierce or bend it; discharge it below 25% first.")


def hazard_note(hazard: Optional[str]) -> Optional[str]:
    """Hard-stop message for a hazardous part, or None if the part may be repaired with care."""
    return HAZARD_MESSAGES.get(hazard) if hazard in ALWAYS_STOP else None
