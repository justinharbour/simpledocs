# AI voicemail (draft; not ready for deployment)

The web phone's availability policy is independent of its connection: online or scheduled hours permit ringing only when a browser heartbeat is current. Offline bypasses ringing. Schedule times are local wall time in the configured IANA timezone; overnight intervals continue into the next day. Default is online and UTC; an empty schedule means offline. The settings editor supports one interval per day. The native apps currently have no native WebRTC softphone; they do not expose this control.

## Provider setup for a future reviewed deployment

Apply migration `0017_ai_voicemail.sql` through the normal reviewed deployment path. Configure existing inbound Telnyx Call Control, signature verification, voicemail number, API token, greeting and R2 recording storage as described in `voice-webhooks.md`. Create a Telnyx AI assistant with an appropriate enabled model, speech recognition and voice, and set `TELNYX_AI_ASSISTANT_ID` to its ID. Set `AI_TOOL_BASE_URL` to the public HTTPS origin of this Worker, with no path. Ensure the three `/api/webhooks/telnyx/ai/*` endpoints can reach the Worker without interactive Cloudflare Access; they authenticate using per-call bearer credentials supplied to Telnyx as webhook headers. Do not log these headers, bodies, or Telnyx call-control IDs. The configured AI assistant's stored tools and instructions are overridden per call; review provider retention, subprocessors, data location and recording consent rules before use. Enter only approved facts in Settings; the knowledgebase is initially empty.

On answer, the Worker uses Telnyx's `ai_assistant_start` command with inline instructions and webhook tools. A definite 4xx rejection falls back to the existing greeting and recording; a missing configuration uses the existing flow. An ambiguous request or 5xx does not start a competing recording, since the assistant may already be active. This can leave silence if the provider fails after accepting the command; there is no confirmed readiness watchdog. The ordinary voicemail flow still requires the existing greeting configuration.

Tools save one request of each kind per call in D1. The bearer is random per call, stored only as a digest, expires after four hours, and is bound to the `x-telnyx-call-control-id` header; duplicate identical tool calls are idempotent, conflicting duplicates are rejected. Voice events remain Ed25519-verified separately. Requests are visible to the voice owner on the Calls page. The model is instructed to disclose AI processing, avoid sensitive information, and say it does not know where knowledge is absent; these are model instructions, not a guarantee against hallucination or prompt injection.

**SMS is not sent by the agent.** It records an explicitly requested SMS conversation and the model's reported consent for owner review. Model output is not independently verifiable consent, and the current SMS path does not enforce a durable opt-out/suppression ledger. Implement verified consent, opt-out and delivery reconciliation before automatic texting. There is no automatic callback or outbound call.

## Remaining blockers before merge or use

- Integrate and retest with drafts #62, #63 and #64; review migration numbering and conflicts.
- Verify Telnyx actually propagates custom authorization and call-control headers for inline tools, tests each tool's schema, and confirms call-control fallback behavior with a controlled test number after separate approval. No live test has been performed.
- Establish a retention/deletion policy and UI for AI requests, sessions, knowledge and provider-side conversations; caller data is currently retained indefinitely in D1.
- Add reliable startup failure/readiness handling and safe recovery for ambiguous provider responses. A success response does not establish that greeting audio began.
- Establish consent/opt-out enforcement before automated SMS; do not represent recorded requests as sent texts.
- Review the availability editor's one-interval-per-day limitation before editing schedules created via API with multiple intervals on the same day.

Provider references: [Start AI Assistant](https://developers.telnyx.com/api-reference/call-commands/start-ai-assistant), [Attach an AI Assistant to a Call](https://developers.telnyx.com/docs/voice/programmable-voice/ai-assistant-start), [webhook tool context](https://developers.telnyx.com/docs/inference/ai-assistants/async-tools).
