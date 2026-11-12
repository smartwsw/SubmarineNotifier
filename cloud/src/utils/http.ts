export interface ApiErrorBody {
  ok: false;
  error: { code: string; message: string };
  requestId: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Max-Age': '86400',
};

export function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function ok(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return jsonResponse({ ok: true, data }, status, extraHeaders);
}

export function fail(status: number, code: string, message: string, requestId: string, headers?: Record<string, string>): Response {
  const body: ApiErrorBody = { ok: false, error: { code, message }, requestId };
  return jsonResponse(body, status, headers);
}

export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  }
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

export function newRequestId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `req_${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}
