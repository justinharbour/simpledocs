# Apple TV access

An Apple TV pairs with the owner's account through a short code approved in Settings → Apple TV. The pairing produces a bearer token that is stored only as a hash and grants read-only access to the owner's dashboard, activity, and historical documents (including PDFs). A TV token cannot send, approve, change settings, or reach `/api/*`. Anyone holding a token can read those documents until it is revoked, so revoke any device you no longer use from Settings → Apple TV; revocation takes effect on the next request.
