# simpledocs

An open-source communications workspace for fax, voice, voicemail, and physical mail. Simpledocs is intended to bring documents and delivery records together without turning everyday tasks into a complicated workflow.

> **Project status: planning.** This repository does not yet contain a working application. Do not use it to send communications or store sensitive records.

## Planned capabilities

- Send and receive fax through Telnyx, with delivery records and document attachments.
- Make and receive calls in a browser softphone, with voicemail and call history.
- Send physical mail through PostGrid, inspect and approve a provider-generated proof before sending, and record available tracking and return-receipt information.
- Send the same document through multiple selected channels while tracking each delivery separately.
- Enable or disable capabilities individually, including inbound fax and inbound voice, with an optional shared phone number where supported by the provider.
- Keep records in Cloudflare D1 and documents and proofs in R2, behind Cloudflare Access.

Mail classes, tracking, return receipts, phone-number routing, and proofs depend on provider capabilities, destination, and account configuration. A status such as “completed” is not necessarily evidence of delivery. See [the implementation plan](docs/plan.md) for the safeguards and open questions.

## Intended stack

Astro and Starwind UI for the interface; Cloudflare Workers, D1 and R2 for hosting and storage; Telnyx and PostGrid for delivery. Cloudflare Workers Builds will deploy the application. Standard GitHub-hosted runners will run public-repository checks.

## Contributing

Pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening one. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
