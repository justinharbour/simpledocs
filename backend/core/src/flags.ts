export const features = ['fax.outbound', 'fax.inbound', 'voice.outbound', 'voice.inbound', 'voice.voicemail', 'mail.outbound'] as const;
export type Feature = typeof features[number];
/** Caller must obtain each signal from trusted server-side configuration, not the client. */
export function featureAvailable(feature: string, flags: Readonly<Partial<Record<Feature, boolean>>> | undefined, configured: boolean, providerVerified: boolean): boolean {
  return features.includes(feature as Feature) && flags?.[feature as Feature] === true && configured === true && providerVerified === true;
}
