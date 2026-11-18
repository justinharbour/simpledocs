// Public to Access on the production destination only. The Worker is the only
// enforcement for these: pairing is unauthenticated and rate-limited, and every
// /tv/api/* request must carry a valid, unrevoked TV bearer token.
export const TV_PATHS = Object.freeze(['/tv/pair/start', '/tv/pair/poll', '/tv/api/*']);
