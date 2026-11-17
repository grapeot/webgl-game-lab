"""CDP target selection and request correlation without cookie or token export."""

import asyncio
import json
import re
from urllib.parse import urlsplit, urlunsplit
from urllib.request import urlopen

import websockets


class LabError(RuntimeError):
    """An allowlisted diagnostic, never an arbitrary page exception."""


def page_error(description: str) -> LabError:
    prefix = r"^(?:Error: )?(UNSUPPORTED|LAYOUT|INSTANCE|NOT_INSTALLED|NOT_RUNNING):"
    match = re.match(prefix, description)
    if not match:
        return LabError("PAGE_ERROR: evaluation failed; inspect the page locally")
    code = match[1]
    messages = {
        "UNSUPPORTED": "Unity runtime unavailable",
        "LAYOUT": "incompatible runtime metadata or field layout",
        "INSTANCE": "expected exactly one initialized live game instance",
        "NOT_INSTALLED": "run install before this operation",
        "NOT_RUNNING": "no active timed run",
    }
    count = re.fullmatch(
        r"(?:Error: )?INSTANCE: expected one live instance; found (\d+)", description,
    )
    detail = f"; found {count[1]}" if count else ""
    return LabError(f"{code}: {messages[code]}{detail}")


def clean_url(url: str) -> str:
    """Discard userinfo, path, query and fragment from display URLs."""
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        if parsed.port:
            host += f":{parsed.port}"
        return urlunsplit((parsed.scheme, host, "", "", ""))
    except ValueError:
        return "[invalid-url]"


def list_targets(endpoint: str) -> list[dict]:
    with urlopen(endpoint.rstrip("/") + "/json/list", timeout=10) as response:
        return json.load(response)


def select_target(targets: list[dict], match: str | None, target_id: str | None) -> dict:
    if not target_id and not match:
        raise ValueError("Specify --match or --target; do not guess among signed-in pages")
    candidates = [
        t for t in targets
        if t.get("type") in {"page", "iframe"}
        and (t.get("id") == target_id if target_id else match in t.get("url", ""))
    ]
    if len(candidates) != 1:
        raise ValueError(f"Expected one CDP target; found {len(candidates)}")
    if not candidates[0].get("webSocketDebuggerUrl"):
        raise ValueError("Selected target has no debugger connection")
    return candidates[0]


class CDP:
    def __init__(self, socket):
        self.socket = socket
        self.sequence = 0
        self.events = []

    async def call(self, method: str, params: dict | None = None, timeout: float = 30):
        self.sequence += 1
        request_id = self.sequence
        request = {"id": request_id, "method": method, "params": params or {}}
        await self.socket.send(json.dumps(request))
        async with asyncio.timeout(timeout):
            while True:
                message = json.loads(await self.socket.recv())
                if message.get("id") != request_id:
                    self.events.append(message)
                    continue
                if "error" in message:
                    error = message["error"]
                    raise LabError(f"CDP_ERROR: {method} code {int(error.get('code', 0))}")
                return message.get("result", {})

    async def evaluate(self, expression: str):
        result = await self.call("Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "awaitPromise": True,
        })
        if "exceptionDetails" in result:
            value = result.get("result", {}).get("description", "JavaScript evaluation failed")
            raise page_error(value.splitlines()[0])
        return result.get("result", {}).get("value")


def connect(target: dict):
    return websockets.connect(target["webSocketDebuggerUrl"], max_size=100_000_000)
