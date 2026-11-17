# Contributing

Contributions are welcome, including documentation, accessibility improvements, bug fixes, and tests. For a substantial change, open an issue first so we can agree on the approach.

1. Fork the repository, or create a branch if you have write access, and branch from `develop`, the default branch.
2. Keep changes focused, include relevant tests, and update documentation where behavior changes.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for commits and pull request titles (for example, `fix: handle duplicate webhook events`).
4. Open a pull request against `develop` describing the problem, approach, and verification. Never commit directly to `develop` or `main`.

Pull requests run the `CI` workflow. It checks workflow files, pull request titles and dependency changes on GitHub-hosted runners. Fork pull requests receive no secrets and a read-only token. The `pr-gate` check passes only when those checks pass. Until the web and native application projects are scaffolded and wired into CI, its job summary lists them as "NOT RUN" rather than verified.

The application is not scaffolded yet; setup and verification commands will be documented as they become available. Do not include real phone numbers, addresses, documents, credentials, or production webhook payloads in issues, tests, or pull requests. Use synthetic fixtures instead.

Pull requests from forks must not have access to production secrets or privileged deployment credentials. Do not use `pull_request_target` to execute untrusted pull request code.
