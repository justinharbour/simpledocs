#!/usr/bin/env python3
"""Exercise the real encryption configuration with disposable local state only."""

import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
MARKER = b"simpledocs-local-encryption-test-marker"
KEY = "disposable-local-test-passphrase-12345"


def run(directory, environment, *args, succeeds=True):
    result = subprocess.run(
        ["tofu", *args, "-no-color"], cwd=directory, env=environment,
        text=True, capture_output=True, check=False,
    )
    if (result.returncode == 0) != succeeds:
        raise RuntimeError(f"tofu {args} returned {result.returncode}\n{result.stderr}\n{result.stdout}")
    return result


def main():
    original = (ROOT / "main.tf").read_text()
    # Remove only the remote backend; never connect to R2 during this test.
    start = original.index('  backend "s3" {')
    end = original.index('\n  encryption {', start)
    local = original[:start] + original[end:]
    local += f'\noutput "marker" {{ value = "{MARKER.decode()}" }}\n'
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("TF_", "AWS_", "TOFU_"))}
    env.update(TF_VAR_encryption_key=KEY, TF_VAR_r2_endpoint="https://example.invalid",
               TF_IN_AUTOMATION="1", TF_INPUT="0")
    with tempfile.TemporaryDirectory(prefix="simpledocs-encryption-") as tmp:
        path = Path(tmp)
        (path / "main.tf").write_text(local)
        run(path, env, "init", "-input=false")
        run(path, env, "apply", "-auto-approve", "-input=false")
        run(path, env, "plan", "-out=plan.bin", "-input=false")
        for filename in ("terraform.tfstate", "plan.bin"):
            assert MARKER not in (path / filename).read_bytes(), f"plaintext in {filename}"
        run(path, env, "show", "plan.bin")
        assert MARKER.decode() in run(path, env, "output", "marker").stdout
        wrong = {**env, "TF_VAR_encryption_key": "wrong-disposable-test-passphrase-12345"}
        run(path, wrong, "show", "plan.bin", succeeds=False)
        run(path, wrong, "output", "marker", succeeds=False)
        missing = dict(env)
        del missing["TF_VAR_encryption_key"]
        run(path, missing, "plan", "-input=false", succeeds=False)
        # Recovery is tested by restoring a copied encrypted state and the test key.
        backup = (path / "terraform.tfstate").read_bytes()
        (path / "terraform.tfstate").unlink()
        (path / "terraform.tfstate").write_bytes(backup)
        assert MARKER.decode() in run(path, env, "output", "marker").stdout
    print("PASS: local encrypted state/plan, wrong/missing key rejection, backup recovery")


if __name__ == "__main__":
    main()
