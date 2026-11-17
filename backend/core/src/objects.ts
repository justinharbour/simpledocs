import { requireAccess, type AccessVerifier, type Authorizer } from './access.ts';
import { opaqueId } from './validation.ts';
export interface PrivateObject { body: ReadableStream<Uint8Array>; contentType: string }
export interface PrivateObjectStore { get(internalRef: string): Promise<PrivateObject | null> }
export interface ArtifactRepository { findInternalRef(artifactId: string): Promise<string | null> }
/** Authorization precedes lookup; references are never returned to callers. */
export async function readArtifact(request: Request, artifactId: string, dependencies: { verifier?: AccessVerifier; authorizer?: Authorizer; artifacts: ArtifactRepository; objects: PrivateObjectStore }): Promise<Response> {
  const id = opaqueId(artifactId);
  await requireAccess(request, 'artifact.read', id, dependencies.verifier, dependencies.authorizer);
  const internalRef = await dependencies.artifacts.findInternalRef(id);
  if (!internalRef) return new Response(null, { status: 404 });
  const object = await dependencies.objects.get(internalRef);
  if (!object) return new Response(null, { status: 404 });
  // Do not render untrusted uploaded content inline, regardless of claimed MIME type.
  return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } });
}
