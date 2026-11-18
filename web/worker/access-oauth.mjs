export const requiredCallbacks = [
  'com.justinharbour.simpledocs:/oauth/callback',
  'dev.justinharbour.simpledocs:/oauth/callback',
];

export function supportsNativeCallbacks(oauth) {
  const registration = oauth?.dynamic_client_registration;
  return oauth?.enabled === true && registration?.enabled === true &&
    Array.isArray(registration.allowed_uris) && requiredCallbacks.every(uri => registration.allowed_uris.includes(uri));
}
