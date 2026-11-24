const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

function authed(req, env) {
  const h = req.headers.get('authorization') || '';
  if (!h.startsWith('Basic ') || !env.ADMIN_PASSWORD) return false;
  try { return atob(h.slice(6)).split(':').slice(1).join(':') === env.ADMIN_PASSWORD; } catch { return false; }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url), path = u.pathname;

    // ---- admin (dilindungi password) ----
    if (path === '/admin' || path.startsWith('/api/admin')) {
      if (!authed(req, env)) return new Response('Login diperlukan', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="admin"' } });
      if (path === '/admin') return env.ASSETS.fetch(u.origin + '/admin.html');
      if (path === '/api/admin/pages') {
        const l = await env.DB.list({ prefix: 'page:' });
        return J(l.keys.map(k => k.name.slice(5)));
      }
      const m = path.match(/^\/api\/admin\/page\/([\w-]+)$/);
      if (m) {
        const k = 'page:' + m[1];
        if (req.method === 'GET') { const v = await env.DB.get(k); return v ? new Response(v, { headers: { 'content-type': 'application/json' } }) : J({}, 404); }
        if (req.method === 'PUT') { await env.DB.put(k, JSON.stringify(await req.json())); return J({ ok: 1 }); }
        if (req.method === 'DELETE') { await env.DB.delete(k); return J({ ok: 1 }); }
      }
      if (path === '/api/admin/img' && req.method === 'POST') {
        const b = await req.arrayBuffer();
        if (b.byteLength > 1500000) return J({ err: 'Gambar terlalu besar' }, 413);
        const id = crypto.randomUUID().slice(0, 12);
        await env.DB.put('img:' + id, b, { metadata: { t: req.headers.get('content-type') || 'image/webp' } });
        return J({ url: '/img/' + id });
      }
      return J({ err: 'not found' }, 404);
    }

    // ---- gambar ----
    if (path.startsWith('/img/')) {
      const r = await env.DB.getWithMetadata('img:' + path.slice(5), 'arrayBuffer');
      if (!r.value) return new Response('Not found', { status: 404 });
      return new Response(r.value, { headers: { 'content-type': (r.metadata && r.metadata.t) || 'image/webp', 'cache-control': 'public,max-age=31536000,immutable' } });
    }

    // ---- file statis (favicon dll) ----
    if (path.includes('.')) {
      if (path === '/admin.html' || path === '/index.html') return new Response('Not found', { status: 404 });
      return env.ASSETS.fetch(req);
    }

    // ---- halaman publik: /hujan, /bersih, dst ----
    const slug = path.replace(/^\/|\/$/g, '') || 'default';
    const v = await env.DB.get('page:' + slug);
    if (!v) return new Response('Halaman tidak ditemukan', { status: 404 });
    const t = await (await env.ASSETS.fetch(u.origin + '/index.html')).text();
    return new Response(t.replace('/*__DATA__*/null', () => v.replace(/</g, '\\u003c')), {
      headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'public,max-age=60' }
    });
  }
};
