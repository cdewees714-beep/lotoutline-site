/* Lot Outline saved orders + per-user preferences (Supabase). Loaded after auth.js.
   Every order is a row in public.orders (state jsonb holds the whole order so it reopens exactly where it was left).
   Uploaded originals go to the private storage bucket "order-photos" under <user id>/<order id>/; HAR and example photos
   are stored by URL only. Nothing here ever deletes a finished order: the history does not expire. */
(() => {
  const sb = LO.sb, BUCKET = 'order-photos';
  const uid = async () => (await LO.session())?.user?.id || null;

  // Keys that hold live objects (images, canvases, functions) or caches that are rebuilt on load.
  const SKIP = new Set(['img', 'mask', 'file', 'view', 'ref', 'refRing', 'uploading']);
  const clean = v => JSON.parse(JSON.stringify(v, (k, x) => {
    if (SKIP.has(k) || typeof x === 'function') return undefined;
    if (typeof HTMLElement !== 'undefined' && x instanceof HTMLElement) return undefined;
    if (typeof Blob !== 'undefined' && x instanceof Blob) return undefined;
    if (typeof ImageBitmap !== 'undefined' && x instanceof ImageBitmap) return undefined;
    return x; }));

  const STEP_NAMES = { photos: { 1: 'Address', 2: 'Photos', 3: 'Confirm pins', 4: 'Carrying', 5: 'Look', 6: 'Pay' },
                       satellite: { 1: 'Address', 7: 'Imagery', 3: 'Confirm lot', 5: 'Look', 6: 'Pay' } };

  async function create(fields){ const u = await uid(); if (!u) return null;
    const { data, error } = await sb.from('orders').insert({ user_id: u, status: 'draft', ...fields }).select('id').single();
    if (error) { console.warn('order create', error); return null; } return data.id; }
  async function update(id, fields){ const { error } = await sb.from('orders').update(fields).eq('id', id); if (error) { console.warn('order save', error); return false; } return true; }
  async function load(id){ const { data, error } = await sb.from('orders').select('*').eq('id', id).single(); if (error) { console.warn('order load', error); return null; } return data; }
  async function list(){ const { data, error } = await sb.from('orders').select('id,address,photo_count,price_cents,status,mode,step,thumb,created_at,updated_at,finalized_at').order('updated_at', { ascending: false });
    if (error) { console.warn('order list', error); return []; } return data || []; }
  // Delete any of the agent's own orders (in process or finished): the row and every saved photo in its folder.
  async function remove(id){ const u = await uid(); if (!u) return false; const dir = `${u}/${id}`;
    for (let i = 0; i < 20; i++) { const { data } = await sb.storage.from(BUCKET).list(dir, { limit: 1000 }); if (!data || !data.length) break;
      const { error } = await sb.storage.from(BUCKET).remove(data.map(o => `${dir}/${o.name}`)); if (error) { console.warn('photo delete', error); break; } }
    const { error } = await sb.from('orders').delete().eq('id', id); if (error) console.warn('order delete', error); return !error; }

  // Originals up to 12 MB go up untouched; bigger files are re-encoded at full size (JPEG 0.92) to keep storage sane.
  async function upload(orderId, file, img){ const u = await uid(); if (!u) return null;
    let body = file, ext = (file.name.match(/\.(jpe?g|png|webp|heic|tiff?)$/i) || [, 'jpg'])[1].toLowerCase();
    if (file.size > 12e6 && img) { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
      body = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92)); ext = 'jpg'; }
    const path = `${u}/${orderId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, body, { contentType: body.type || 'image/jpeg', upsert: false });
    if (error) { console.warn('photo upload', error); return null; } return path; }
  async function signed(paths){ if (!paths.length) return {}; const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(paths, 60 * 60 * 12);
    if (error) { console.warn('signed urls', error); return {}; } return Object.fromEntries((data || []).map(d => [d.path, d.signedUrl])); }
  const loadImg = (src, cors) => new Promise(res => { const im = new Image(); if (cors) im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });

  // Saved photo records -> live photo objects (img and mask loaded). Photos whose file is gone come back as null and are dropped.
  async function loadPhotos(recs, onProgress){ const urls = await signed(recs.map(r => r.path).filter(Boolean)); let n = 0;
    const out = await Promise.all(recs.map(async r => { const src = r.path ? urls[r.path] : r.src; const img = src ? await loadImg(src, !!r.path || /^https?:/.test(src)) : null;
      onProgress && onProgress(++n, recs.length); if (!img) return null;
      const p = { ...r, img, mask: null }; if (r.maskSrc) p.mask = await loadImg(r.maskSrc); return p; }));
    return out.filter(Boolean); }

  async function prefs(){ const u = await uid(); if (!u) return {}; const { data } = await sb.from('profiles').select('prefs').eq('id', u).single(); return data?.prefs || {}; }
  async function savePrefs(p){ const u = await uid(); if (!u) return false; const { error } = await sb.from('profiles').update({ prefs: p }).eq('id', u); if (error) console.warn('prefs save', error); return !error; }

  LO.orders = { create, update, load, list, remove, upload, loadPhotos, prefs, savePrefs, clean, STEP_NAMES };
})();
