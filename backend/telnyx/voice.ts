/** Pure projection only: callers must authenticate and durably deduplicate events first. */
export type CallPhase = "unknown" | "initiated" | "ringing" | "answered" | "ended";
export type VoiceEventType = "call.initiated" | "call.ringing" | "call.answered" | "call.hangup" | "call.recording.saved";

export interface VoiceEvent {
  eventId: string;
  callControlId: string;
  type: VoiceEventType;
  occurredAt: string;
  direction?: "inbound" | "outbound";
}

export interface CallProjection {
  callControlId: string;
  direction?: "inbound" | "outbound";
  phase: CallPhase;
  phaseAt?: string;
  /** Recording availability is not proof that the recording has been archived. */
  recording: "none" | "provider_reported";
}

const phaseFor: Partial<Record<VoiceEventType, CallPhase>> = {
  "call.initiated": "initiated", "call.ringing": "ringing",
  "call.answered": "answered", "call.hangup": "ended",
};
const rank: Record<CallPhase, number> = { unknown: 0, initiated: 1, ringing: 2, answered: 3, ended: 4 };

/**
 * Ignore stale and regressive phase changes, even if a provider event arrives late.
 * A recording event only signals follow-up work; no URL or recording bytes are
 * trusted or fetched here. A call leg is identified by call_control_id, not session ID.
 */
export function projectVoiceEvent(current: CallProjection | undefined, event: VoiceEvent): CallProjection {
  if (!event.eventId?.trim() || !event.callControlId?.trim() || !Number.isFinite(Date.parse(event.occurredAt))) {
    throw new TypeError("Invalid voice event");
  }
  if (current && current.callControlId !== event.callControlId) throw new TypeError("Call leg mismatch");
  if (current?.direction && event.direction && current.direction !== event.direction) throw new TypeError("Call direction mismatch");
  const result: CallProjection = current ? { ...current } : {
    callControlId: event.callControlId, phase: "unknown", recording: "none",
  };
  if (!result.direction && event.direction) result.direction = event.direction;
  if (event.type === "call.recording.saved") result.recording = "provider_reported";
  const next = phaseFor[event.type];
  if (next && rank[next] > rank[result.phase] && (!result.phaseAt || Date.parse(event.occurredAt) >= Date.parse(result.phaseAt))) {
    result.phase = next;
    result.phaseAt = event.occurredAt;
  }
  return result;
}

/** Never infer permission from UI state, provider events, or number ownership. */
export function voicePermissions(flags: Partial<Record<"voice.outbound" | "voice.inbound" | "voice.voicemail", boolean>>) {
  return {
    outbound: flags["voice.outbound"] === true,
    inbound: flags["voice.inbound"] === true,
    voicemail: flags["voice.inbound"] === true && flags["voice.voicemail"] === true,
  };
}
