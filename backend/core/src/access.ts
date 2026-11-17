export interface Actor { id: string }
/** An adapter must verify signature, issuer, audience, expiry and identity using operator-configured trust. */
export interface AccessVerifier { verify(assertion: string): Promise<Actor | null> }
export interface Authorizer { allow(actor: Actor, operation: string, resource: string): Promise<boolean> }
export class AccessDenied extends Error {}
/** Never trusts request identity headers other than an assertion passed to the configured verifier. */
export async function requireAccess(request: Request, operation: string, resource: string, verifier?: AccessVerifier, authorizer?: Authorizer): Promise<Actor> {
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion || assertion.length > 16384 || !verifier || !authorizer) throw new AccessDenied();
  try {
    const actor = await verifier.verify(assertion);
    if (!actor || typeof actor.id !== 'string' || !actor.id.trim() || !(await authorizer.allow(actor, operation, resource))) throw new AccessDenied();
    return actor;
  } catch { throw new AccessDenied(); }
}
/** Cookie-based mutations need both an explicit origin allowlist and independently verified CSRF token. */
export function requireMutationProtection(request: Request, allowedOrigins: readonly string[], csrfVerified: boolean): void {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins.includes(origin) || csrfVerified !== true) throw new AccessDenied();
}
