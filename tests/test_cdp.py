import asyncio
import json

import pytest

from webgl_game_lab.cdp import CDP, clean_url, page_error, select_target
from webgl_game_lab.cli import main, runtime_expression, write_private


def target(identity, url):
    return {"id": identity, "url": url, "type": "iframe", "webSocketDebuggerUrl": "ws://localhost/mock"}


def test_selection_rejects_ambiguous_and_missing_target():
    targets = [target("a", "https://game.example.com/"), target("b", "https://game.example.com/")]
    with pytest.raises(ValueError, match="found 2"):
        select_target(targets, "game.example.com", None)
    with pytest.raises(ValueError, match="Specify"):
        select_target(targets, None, None)
    assert select_target(targets, None, "b")["id"] == "b"


def test_urls_redact_credentials_and_path_tokens():
    assert clean_url("https://alice:password@game.example.com/session/FAKE?token=secret#state") == "https://game.example.com"


def test_private_export_does_not_overwrite(tmp_path):
    out = tmp_path / "run.json"
    write_private(out, b"original")
    with pytest.raises(FileExistsError):
        write_private(out, b"replacement")
    assert out.read_bytes() == b"original"
    assert out.stat().st_mode & 0o777 == 0o600


def test_mutation_requires_installed_probe():
    assert "NOT_INSTALLED" in runtime_expression("hold")
    assert "lab.install" in runtime_expression("install")


def test_cdp_event_correlation_and_exception():
    class Socket:
        def __init__(self):
            self.messages = iter([
                {"method": "Debugger.scriptParsed", "params": {"scriptId": "fake"}},
                {"id": 1, "result": {"result": {"value": 7}}},
                {"id": 2, "result": {
                    "exceptionDetails": {}, "result": {"description": "INSTANCE: found 2"},
                }},
            ])

        async def send(self, raw):
            assert json.loads(raw)["method"]

        async def recv(self):
            return json.dumps(next(self.messages))

    async def scenario():
        client = CDP(Socket())
        assert await client.evaluate("7") == 7
        assert len(client.events) == 1
        with pytest.raises(RuntimeError, match="INSTANCE"):
            await client.evaluate("throws")

    asyncio.run(scenario())


@pytest.mark.parametrize("description", [
    "Error: token=FAKE_LOGIN_SECRET",
    "Error: HTTPS://game.example.com/?token=FAKE_LOGIN_SECRET",
    "Error: Authorization: Bearer FAKE_LOGIN_SECRET",
    "Error: LAYOUT: token=FAKE_LOGIN_SECRET",
])
def test_page_error_never_reflects_secrets(description):
    assert "FAKE_LOGIN_SECRET" not in str(page_error(description))


def test_cli_error_exit_is_sanitized(monkeypatch, capsys):
    async def fail(_):
        raise RuntimeError("Authorization: Bearer FAKE_LOGIN_SECRET")

    monkeypatch.setattr("webgl_game_lab.cli.execute", fail)
    monkeypatch.setattr("sys.argv", ["webgl-lab", "targets"])
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 1
    output = capsys.readouterr().out
    assert "FAKE_LOGIN_SECRET" not in output
    assert json.loads(output)["ok"] is False
