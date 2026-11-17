# Contributing

Contributions are welcome, including documentation, accessibility improvements, bug fixes, and tests. For a substantial change, open an issue first so we can agree on the approach.

1. Fork the repository and create a descriptive branch from the default branch.
2. Keep changes focused, include relevant tests, and update documentation where behavior changes.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) (for example, `fix: handle duplicate webhook events`).
4. Open a pull request describing the problem, approach, and verification. Never commit directly to `main`.

The application is not scaffolded yet; setup and verification commands will be documented as they become available. Do not include real phone numbers, addresses, documents, credentials, or production webhook payloads in issues, tests, or pull requests. Use synthetic fixtures instead.

Pull requests from forks must not have access to production secrets or privileged deployment credentials. Do not use `pull_request_target` to execute untrusted pull request code.
