# Independent Cloudflare deployment

Simpledocs is independent of Lake Ave. The manual GitHub Actions workflow deploys
only the reviewed `main` branch, using repository secrets `CLOUDFLARE_ACCOUNT_ID`
and `CLOUDFLARE_API_TOKEN`. Scope the token to the intended account and required
Worker permissions. Never put token values in the repository or in chat.

This initial workflow deploys **no public route**. `workers_dev` and preview
URLs are disabled, and the Worker rejects requests without a verified Access
assertion. It does not create an Access application, hostname, D1, R2, or queues.
Before connecting the hostname, independently configure and verify Access, set
the team origin and application audience in the Worker, verify there is no
hostname collision, and review the routing change. Before binding D1, create the
database, apply and verify the reviewed migrations, and establish recovery and
backup procedures. No provider sending is enabled.
