import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Context = { params: Promise<{ path: string[] }> };

async function forward(request: NextRequest, context: Context) {
  const token = process.env.FORGE_COORDINATOR_TOKEN;
  if (!token) return Response.json({ error: 'web_proxy_not_configured' }, { status: 503 });
  const base = new URL(process.env.FORGE_API_URL ?? 'http://127.0.0.1:4400');
  if (!['http:', 'https:'].includes(base.protocol)) {
    return Response.json({ error: 'invalid_coordinator_url' }, { status: 500 });
  }
  const { path } = await context.params;
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  if (mutation) {
    const origin = request.headers.get('origin');
    const fetchSite = request.headers.get('sec-fetch-site');
    const contentType = request.headers.get('content-type') ?? '';
    const expectedOrigin = process.env.FORGE_WEB_ORIGIN ?? new URL(request.url).origin;
    if (
      origin !== expectedOrigin ||
      fetchSite !== 'same-origin' ||
      !contentType.toLowerCase().startsWith('application/json')
    ) {
      return Response.json({ error: 'same_origin_json_required' }, { status: 403 });
    }
  }
  const suffix = path.map(encodeURIComponent).join('/');
  const target = new URL(suffix === 'health' ? '/health' : `/api/${suffix}`, base);
  target.search = request.nextUrl.search;
  const response = await fetch(target, {
    method: request.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(request.headers.get('content-type')
        ? { 'content-type': request.headers.get('content-type')! }
        : {}),
    },
    ...(request.method === 'GET' || request.method === 'HEAD'
      ? {}
      : { body: await request.text() }),
    cache: 'no-store',
    signal: request.signal,
  });
  return new Response(response.body, {
    status: response.status,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
