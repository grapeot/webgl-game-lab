import subprocess
from pathlib import Path


def test_synthetic_runtime_regressions():
    root = Path(__file__).resolve().parents[1]
    subprocess.run(["node", "tests/runtime.test.cjs"], cwd=root, check=True, timeout=30)
