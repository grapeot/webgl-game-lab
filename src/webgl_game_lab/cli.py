"""JSON command interface. Browser gameplay is never started by this CLI."""

import argparse
import asyncio
import base64
import json
import os
from importlib.resources import files
from pathlib import Path

from .cdp import CDP, LabError, clean_url, connect, list_targets, select_target


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Unity WebGL 运行态观测与单局计时实验")
    p.add_argument("--cdp", default=os.getenv("WEBGL_CDP_URL", "http://127.0.0.1:9222"))
    p.add_argument("--match", default=os.getenv("WEBGL_TARGET_MATCH"))
    p.add_argument("--target")
    sub = p.add_subparsers(dest="command", required=True)
    commands = [
        "targets", "inspect", "preflight", "discover", "status", "map", "hold", "release", "stop",
    ]
    for command in commands:
        sub.add_parser(command)
    sub.add_parser("install").add_argument("--network", action="store_true")
    sub.add_parser("export").add_argument("--out", type=Path, default=Path(".local/run.json"))
    sub.add_parser("wasm-export").add_argument("--out", type=Path, default=Path(".local/game.wasm"))
    return p


def runtime_expression(command: str, network: bool = False) -> str:
    source = files("webgl_game_lab").joinpath("runtime.js").read_text()
    if command == "install":
        action = f"lab.install({json.dumps({'network': network})})"
        binding = ("const lab = globalThis.__webglGameLab || "
                   "(globalThis.__webglGameLab = globalThis.__createWebglGameLab());")
    elif command in {"hold", "release", "stop", "export"}:
        binding = ("const lab = globalThis.__webglGameLab; "
                   "if (!lab) throw new Error('NOT_INSTALLED: run install');")
        action = f"lab.{command}()"
    else:
        binding = "const lab = globalThis.__webglGameLab || globalThis.__createWebglGameLab();"
        action = f"lab.{command}()"
    return source + "\n(()=>{" + binding + "return " + action + ";})()"


INSPECT = """(() => ({
  unity: !!globalThis.unityInstance,
  heapBytes: globalThis.unityInstance?.Module?.HEAPU8?.byteLength ?? 0,
  scripts: [...document.scripts].map(s => {
    let origin = ''; try { origin = new URL(s.src).origin; } catch (_) {}
    return { origin, inlineBytes: s.src ? 0 : s.textContent.length };
  }),
  scope: 'loader-and-runtime-presence-only'
}))()"""


async def execute(args):
    targets = list_targets(args.cdp)
    if args.command == "targets":
        return [{"id": t.get("id"), "type": t.get("type"), "origin": clean_url(t.get("url", ""))}
                for t in targets if t.get("type") in {"page", "iframe"}]
    target = select_target(targets, args.match, args.target)
    async with connect(target) as socket:
        client = CDP(socket)
        if args.command == "inspect":
            return await client.evaluate(INSPECT)
        if args.command == "wasm-export":
            await client.call("Debugger.enable")
            scripts = [event["params"] for event in client.events
                       if event.get("method") == "Debugger.scriptParsed"
                       and event.get("params", {}).get("scriptLanguage") == "WebAssembly"]
            if len(scripts) != 1:
                raise RuntimeError(f"Expected one loaded WebAssembly module; found {len(scripts)}")
            result = await client.call(
                "Debugger.getScriptSource", {"scriptId": scripts[0]["scriptId"]},
            )
            if not result.get("bytecode"):
                raise RuntimeError("Browser did not expose loaded WebAssembly bytecode")
            data = base64.b64decode(result["bytecode"], validate=True)
            if data[:4] != b"\x00asm":
                raise RuntimeError("Returned bytecode is not WebAssembly")
            write_private(args.out, data)
            return {"out": str(args.out), "bytes": len(data),
                    "scope": "compiled-bytecode-not-CSharp-source"}
        expression = runtime_expression(args.command, getattr(args, "network", False))
        result = await client.evaluate(expression)
        if args.command == "export":
            serialized = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
            write_private(args.out, serialized.encode())
            return {"out": str(args.out), "samples": len(result.get("rows", [])),
                    "events": len(result.get("events", [])), "maps": len(result.get("maps", []))}
        return result


def write_private(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Refuse to silently overwrite an earlier experiment.
    with path.open("xb") as stream:
        os.chmod(path, 0o600)
        stream.write(data)


def main():
    args = parser().parse_args()
    try:
        result = asyncio.run(execute(args))
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    except Exception as error:
        # Unknown exception strings may contain credentials outside URL query strings.
        if isinstance(error, LabError):
            message = str(error)
        elif isinstance(error, FileExistsError):
            message = "OUTPUT_EXISTS: choose a new output path"
        elif isinstance(error, ValueError):
            message = "INVALID_ARGUMENT: specify exactly one matching target and valid input"
        else:
            message = "OPERATION_FAILED: inspect the local browser or connection configuration"
        failure = {"ok": False, "error": type(error).__name__, "message": message}
        print(json.dumps(failure, ensure_ascii=False))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
