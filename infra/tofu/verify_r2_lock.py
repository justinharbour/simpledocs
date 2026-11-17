#!/usr/bin/env python3
"""Manual isolated R2 lock test. Requires tofu and AWS CLI; never uses prod state."""
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
from urllib.parse import urlparse


def main():
    endpoint = os.environ["CF_S3_ENDPOINT"]
    url = urlparse(endpoint)
    if url.scheme != "https" or not url.hostname or not url.hostname.endswith(".r2.cloudflarestorage.com") or url.path not in ("", "/") or url.query or url.fragment or url.username or url.password or url.port:
        raise ValueError("Expected an HTTPS Cloudflare R2 account endpoint")
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        if not os.environ.get(name):
            raise ValueError(f"Missing {name}")
    key = f"simpledocs/verification/{secrets.token_hex(16)}/terraform.tfstate"
    print(f"Isolated test key: {key}", flush=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("TF_", "TOFU_", "AWS_ENDPOINT"))}
    env.update(TF_IN_AUTOMATION="1", TF_INPUT="0", AWS_EC2_METADATA_DISABLED="true",
               TF_VAR_key=secrets.token_urlsafe(32), TF_VAR_endpoint=endpoint)
    config = '''
variable "key" {
  type = string
  sensitive = true
}
variable "endpoint" { type = string }
terraform {
  backend "s3" {
    bucket = "tfstate-r2-shared"
    key = "KEY_PLACEHOLDER"
    region = "auto"
    endpoints = { s3 = var.endpoint }
    use_path_style = true
    use_lockfile = true
    skip_credentials_validation = true
    skip_region_validation = true
    skip_requesting_account_id = true
    skip_s3_checksum = true
  }
  encryption {
    key_provider "pbkdf2" "test" { passphrase = var.key }
    method "aes_gcm" "test" { keys = key_provider.pbkdf2.test }
    state {
      method = method.aes_gcm.test
      enforced = true
    }
    plan {
      method = method.aes_gcm.test
      enforced = true
    }
  }
}
resource "terraform_data" "hold" {
  provisioner "local-exec" { command = "sleep 30" }
}
'''.replace('KEY_PLACEHOLDER', key)
    with tempfile.TemporaryDirectory(prefix="simpledocs-r2-lock-") as tmp:
        root = Path(tmp)
        for name in ("holder", "contender"):
            directory = root / name
            directory.mkdir()
            (directory / "main.tf").write_text(config)
            subprocess.run(["tofu", "init", "-input=false", "-no-color"], cwd=directory, env=env, check=True, stdout=subprocess.DEVNULL)
        holder = subprocess.Popen(["tofu", "apply", "-auto-approve", "-input=false", "-no-color"], cwd=root / "holder", env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            # Wait until OpenTofu has acquired the lock rather than assuming timing.
            for _ in range(100):
                head = subprocess.run(["aws", "s3api", "head-object", "--bucket", "tfstate-r2-shared", "--key", key + ".tflock", "--endpoint-url", endpoint], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if head.returncode == 0:
                    break
                if holder.poll() is not None:
                    raise RuntimeError("Holder exited before acquiring lock")
                time.sleep(0.2)
            else:
                raise RuntimeError("Lock not observed; no cleanup attempted")
            contender = subprocess.run(["tofu", "plan", "-input=false", "-lock-timeout=2s", "-no-color"], cwd=root / "contender", env=env, capture_output=True, text=True)
            if contender.returncode == 0 or "Error acquiring the state lock" not in contender.stderr:
                raise RuntimeError("Contender did not fail with the expected lock error")
            print("PASS: second OpenTofu process rejected while lock held", flush=True)
            if holder.wait(timeout=90) != 0:
                raise RuntimeError("Holder apply failed")
            subprocess.run(["tofu", "plan", "-input=false", "-lock-timeout=5s", "-no-color"], cwd=root / "contender", env=env, check=True, stdout=subprocess.DEVNULL)
            print("PASS: lock released and reacquired; encrypted state read", flush=True)
            # Remove only the unique test state after the lock is released. On
            # failure, leave objects for manual inspection rather than guess.
            subprocess.run(["aws", "s3api", "delete-object", "--bucket", "tfstate-r2-shared", "--key", key, "--endpoint-url", endpoint], env=env, check=True, stdout=subprocess.DEVNULL)
            print("PASS: deleted isolated test state", flush=True)
        finally:
            if holder.poll() is None:
                holder.terminate()
                holder.wait(timeout=10)


if __name__ == "__main__":
    main()
