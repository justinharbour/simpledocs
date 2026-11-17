// Called only after the Access JWT has been verified. No provider sends here.
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (value, status = 200) => Response.json(value, { status, headers });
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleDraft(request, db, actor, id) {
  if (!ID.test(id)) return reply({ error: 'Invalid draft ID' }, 400);
  if (!db) return reply({ error: 'Draft storage unavailable' }, 503);
  if (request.method === 'GET') {
    const row = await db.prepare('SELECT revision, content_json, created_at, updated_at FROM mail_drafts WHERE id = ? AND actor_id = ?').bind(id, actor).first();
    return row ? reply({ id, revision: row.revision, content: JSON.parse(row.content_json), createdAt: row.created_at, updatedAt: row.updated_at }) : reply({ error: 'Not found' }, 404);
  }
  if (request.method !== 'PUT') return reply({ error: 'Method not allowed' }, 405);
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('content-type') !== 'application/json') return reply({ error: 'Invalid request origin or content type' }, 403);
  const length = Number(request.headers.get('content-length'));
  if (!Number.isSafeInteger(length) || length <= 0 || length > 65536) return reply({ error: 'Invalid content length' }, 413);
  let body;
  try {
    if (!request.body) return reply({ error: 'Invalid request body' }, 400);
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > length || size > 65536) { await reader.cancel(); return reply({ error: 'Request too large' }, 413); }
      chunks.push(value);
    }
    if (size !== length) return reply({ error: 'Invalid content length' }, 400);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return reply({ error: 'Invalid JSON' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isSafeInteger(body.revision) || body.revision < 0 || !body.content || typeof body.content !== 'object' || Array.isArray(body.content)) return reply({ error: 'Invalid draft' }, 400);
  const now = new Date().toISOString();
  const content = JSON.stringify(body.content);
  let result;
  if (body.revision === 0) {
    result = await db.prepare('INSERT INTO mail_drafts (id, actor_id, revision, content_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(id, actor, content, now, now).run();
  } else {
    result = await db.prepare('UPDATE mail_drafts SET content_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND actor_id = ? AND revision = ?').bind(content, now, id, actor, body.revision).run();
  }
  return result.meta.changes === 1 ? reply({ id, revision: body.revision + 1 }) : reply({ error: 'Draft conflict or not found' }, 409);
}
