"""Tiny client for the Jarvis bridge. Standard library only.

    from jarvis_client import jarvis_say, jarvis_state

    jarvis_state("listening")            # mic open / wake word heard
    jarvis_state("thinking")             # request sent to Gemini / n8n
    jarvis_say("Done. Opening VS Code.") # wallpaper speaks the reply and pulses
    jarvis_state("idle")

    # If FRIDAY already speaks the reply with its own voice, don't let the wallpaper talk too:
    jarvis_say(reply, speak=False)       # sphere reacts, no second voice
    jarvis_state("speaking")             # ...then jarvis_state("idle") when FRIDAY finishes

Both functions return the number of wallpapers that received the message, or None if the
bridge is not reachable. They never raise, so they cannot crash FRIDAY.
"""
import json
import urllib.error
import urllib.request

BRIDGE = "http://127.0.0.1:3000"


def _post(path, payload, timeout):
    request = urllib.request.Request(
        BRIDGE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response).get("delivered", 0)
    except (urllib.error.URLError, OSError, ValueError):
        return None


def jarvis_say(text, level="info", speak=True, timeout=3):
    """level: info | warn | critical. speak=False shows the reaction without the wallpaper's voice."""
    return _post("/alert", {"text": str(text), "level": level, "speak": bool(speak)}, timeout)


def jarvis_state(state, timeout=3):
    """state: idle | listening | thinking | speaking."""
    return _post("/state", {"state": state}, timeout)
