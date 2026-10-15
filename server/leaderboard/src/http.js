// Response helpers. Everything the worker returns is JSON, never cached by browsers, and
// carries a strict set of headers since nothing here is meant to be rendered or framed.

export class HttpError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex',
};

export function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...BASE_HEADERS, ...headers },
  });
}

export function noContent(headers = {}) {
  return new Response(null, { status: 204, headers: { ...BASE_HEADERS, ...headers } });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json(err.status, { ok: false, error: err.code }, err.headers);
  }
  console.error('unhandled', err?.stack || err);
  return json(500, { ok: false, error: 'server' });
}

// Answering before an upload has finished can leave the connection unusable for the next
// request (wrangler's dev proxy trips over it), so a moderately oversized body is read to the
// end and thrown away. Anything bigger than DRAIN_LIMIT is simply cut off.
const DRAIN_LIMIT = 1024 * 1024;

async function discard(reader, seen) {
  try {
    while (seen <= DRAIN_LIMIT) {
      const { done, value } = await reader.read();
      if (done) return;
      seen += value.byteLength;
    }
    await reader.cancel();
  } catch {
    /* client went away */
  }
}

// Reads the body as UTF-8 text without ever buffering more than `max` bytes, whether or not
// the client sent a truthful Content-Length.
export async function readText(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > max) throw new HttpError(413, 'too_large');
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await discard(reader, size);
      throw new HttpError(413, 'too_large');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

export async function readJsonObject(request, max) {
  const text = await readText(request, max);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_body');
  return body;
}
