# Simpledocs OpenTofu state foundation

This root includes an opt-in Telnyx fax outbound profile, disabled by default;
see [TELNYX.md](TELNYX.md) for provider risks and the missing fax resources.
It is not yet approved for production use.
It reserves `simpledocs/prod/terraform.tfstate` and its `.tflock` companion in
`tfstate-r2-shared`; this is a proposed namespace, not proof of ownership.
Do not run remote `init`, plan, or apply until collisions, credential scope,
R2 locking, backups, and key recovery have been independently verified.

Future trusted GitHub Actions jobs must map repository secret
`TOFU_ENCRYPTION_KEY` to `TF_VAR_encryption_key`, variable `CF_S3_ENDPOINT`
to `TF_VAR_r2_endpoint`, and secrets `CF_ACCESS_KEY_ID` and
`CF_SECRET_ACCESS_KEY` to `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
Never place credentials in backend config or logs. GitHub secret presence does
not prove its strength or that a recoverable copy exists. Store a secure backup
of the long, random encryption key independently; loss of it makes state and
plans unrecoverable. Restrict state and plan access even when encrypted.

Do not rename the encryption key provider or method after state is written.
Key rotation requires a tested OpenTofu fallback migration and backup. OpenTofu
encryption does not prevent deletion or rollback; maintain and test independent
backups and recovery, including the key, before first production write.

`TF_ENCRYPTION` can override code configuration: trusted automation must ensure
it is unset. Do not allow untrusted pull requests to access production secrets.

Run `python3 infra/tofu/test_encryption.py` with OpenTofu installed to test
encryption and recovery using disposable local state and a disposable key. This
does not verify R2 behavior or recoverability of the production key.

`verify_r2_lock.py` is a manual integration test, not yet run. The proposed
`verify-r2-lock.yml` workflow only executes on `main`, after review and promotion,
and uses the repository R2 endpoint variable and S3 secrets. The script needs
OpenTofu and AWS CLI. It creates and deletes a randomly named disposable state object
under `simpledocs/verification/`, not the production key. A failed test may
leave objects or a lock requiring manual inspection. A successful test proves
only the operations exercised, not least-privilege credential scope or backup
recovery. Inspect the run log for the generated key if manual cleanup is needed.
