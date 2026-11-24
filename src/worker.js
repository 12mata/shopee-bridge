const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// isi <title>, meta description, Open Graph, dan canonical langsung dari server (terbaca Google & Facebook tanpa JavaScript)
function seo(html, o) {
  const tags = '<link rel="canonical" href="' + esc(o.url) + '">' +
    '<meta property="og:type" content="website"><meta property="og:url" content="' + esc(o.url) + '">' +
    '<meta property="og:title" content="' + esc(o.title) + '"><meta property="og:description" content="' + esc(o.desc) + '">' +
    (o.img ? '<meta property="og:image" content="' + esc(o.img) + '">' : '');
  return html
    .replace(/<title>[\s\S]*?<\/title>/, () => '<title>' + esc(o.title) + '</title>')
    .replace(/<meta name="description"[^>]*>/, () => '')
    .replace('</head>', () => '<meta name="description" content="' + esc(o.desc) + '">' + tags + '</head>');
}


// ---- menu navigasi: daftar halaman dari admin (disimpan di KV key "nav") ----
async function navItems(env) {
  const l = await env.DB.list({ prefix: 'page:' });
  const out = [];
  for (const k of l.keys) {
    const p = JSON.parse((await env.DB.get(k.name)) || '{}');
    if (p.showHome === false || !p.hero) continue;
    const s = k.name.slice(5);
    out.push({ slug: s, label: p.navLabel || p.brand || s });
  }
  return out;
}
async function rebuildNav(env, cur, curData) {
  let items = (await navItems(env)).filter(i => i.slug !== cur);
  if (curData && curData.showHome !== false && curData.hero) items.push({ slug: cur, label: curData.navLabel || curData.brand || cur });
  items.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  await env.DB.put('nav', JSON.stringify(items));
  return items;
}
async function getNav(env) {
  const v = await env.DB.get('nav');
  return v ? JSON.parse(v) : rebuildNav(env);
}
function navHtml(items, cur) {
  return [{ slug: '', label: 'Beranda' }].concat(items).map(i => '<a href="/' + esc(i.slug) + '"' + (i.slug === cur ? ' aria-current="page"' : '') + '>' + esc(i.label) + '</a>').join('');
}

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
      if (path === '/api/admin/fetch-img') {
        let t; try { t = new URL(u.searchParams.get('url') || ''); } catch { return J({ err: 'URL salah' }, 400); }
        if (t.protocol !== 'https:' || !/(^|\.)(susercontent\.com|shopee\.co\.id|shopee\.com)$/.test(t.hostname)) return J({ err: 'Hanya gambar dari Shopee' }, 400);
        const r = await fetch(t.href, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://shopee.co.id/' } });
        const ct = r.headers.get('content-type') || '';
        if (!r.ok || !ct.startsWith('image/')) return J({ err: 'Gagal ambil gambar (' + r.status + ')' }, 502);
        const b = await r.arrayBuffer();
        if (b.byteLength > 8e6) return J({ err: 'Terlalu besar' }, 413);
        return new Response(b, { headers: { 'content-type': ct } });
      }
      if (path === '/api/admin/site') {
        if (req.method === 'PUT') { await env.DB.put('site', JSON.stringify(await req.json())); return J({ ok: 1 }); }
        return new Response((await env.DB.get('site')) || '{}', { headers: { 'content-type': 'application/json' } });
      }
      if (path === '/api/admin/pages') {
        const l = await env.DB.list({ prefix: 'page:' });
        return J(l.keys.map(k => k.name.slice(5)));
      }
      const m = path.match(/^\/api\/admin\/page\/([\w-]+)$/);
      if (m) {
        const k = 'page:' + m[1];
        if (req.method === 'GET') { const v = await env.DB.get(k); return v ? new Response(v, { headers: { 'content-type': 'application/json' } }) : J({}, 404); }
        if (req.method === 'PUT') { const body = await req.json(); await env.DB.put(k, JSON.stringify(body)); await rebuildNav(env, m[1], body); return J({ ok: 1 }); }
        if (req.method === 'DELETE') { await env.DB.delete(k); await rebuildNav(env, m[1], null); return J({ ok: 1 }); }
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
      if (['/admin.html','/index.html','/home.html'].includes(path)) return new Response('Not found', { status: 404 });
      return env.ASSETS.fetch(req);
    }

    // ---- halaman publik: /hujan, /bersih, dst ----
    const slug = path.replace(/^\/|\/$/g, '');
    if (!slug) {
      const site = JSON.parse((await env.DB.get('site')) || '{}');
      const l = await env.DB.list({ prefix: 'page:' });
      const items = [];
      for (const k of l.keys) {
        const p = JSON.parse((await env.DB.get(k.name)) || '{}');
        if (p.showHome === false || !p.hero) continue;
        if (!site.pixelId && p.pixelId) site.pixelId = p.pixelId;
        [p.hero].concat(p.products || []).forEach(x => {
          if (x && x.name && x.link) items.push({ slug: k.name.slice(5), id: x.id, name: x.name, price: x.price, oldPrice: x.oldPrice, rating: x.rating, sold: x.sold, store: x.store, cat: x.cat || 'Lainnya', img: x.img, link: x.link, desc: x.desc, param: p.subIdParam || 'site_id' });
        });
      }
      const h = await (await env.ASSETS.fetch(u.origin + '/home.html')).text();
      const hs = seo(h, { title: site.seoTitle || site.brand || 'Etalase', desc: site.seoDesc || '', img: (items[0] && items[0].img) ? u.origin + items[0].img : '', url: u.origin + '/' });
      const nav = navHtml(await getNav(env), '');
      return new Response(hs.replace('<!--NAV-->', () => nav).replace('/*__DATA__*/null', () => JSON.stringify({ site, items: items.slice(0, 80) }).replace(/</g, '\\u003c')), { headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'public,max-age=60' } });
    }
    const v = await env.DB.get('page:' + slug);
    if (!v) return new Response('Halaman tidak ditemukan', { status: 404 });
    const t = await (await env.ASSETS.fetch(u.origin + '/index.html')).text();
    const c = JSON.parse(v), hero = c.hero || {};
    const ts = seo(t, { title: c.seoTitle || c.pageTitle || hero.name || '', desc: c.seoDesc || hero.sub || '', img: hero.img ? u.origin + hero.img : '', url: u.origin + '/' + slug });
    const nav = navHtml(await getNav(env), slug);
    return new Response(ts.replace('<!--NAV-->', () => nav).replace('/*__DATA__*/null', () => v.replace(/</g, '\\u003c')), {
      headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'public,max-age=60' }
    });
  }
};
