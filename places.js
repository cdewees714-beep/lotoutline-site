// Address autocomplete. Three sources, in this order:
//   1. Google Places API (New) when a key is configured in config.js (own dropdown, session tokens).
//   2. Harris County parcel records (HCAD layer on ArcGIS Online, no key): typing "9250 rai" lists every
//      Harris parcel at 9250 on a street starting with RAI, and picking one pulls the real parcel polygon.
//   3. Photon (OpenStreetMap geocoder, no key) for addresses outside Harris County, or when HCAD has no match.
// Usage: LO.places.suggest(text) -> [{id, main, secondary, text, src}]  (null = superseded by a newer keystroke)
//        LO.places.resolve(id, text, hit) -> {address, lat, lng, parcel?, ring?}
(function () {
  const KEY = (window.LO_CONFIG && window.LO_CONFIG.GOOGLE_PLACES_KEY) || '';
  const BASE = 'https://places.googleapis.com/v1';
  const HC = 'https://services.arcgis.com/su8ic9KbA7PYVxPS/arcgis/rest/services/Harris_County_Parcels/FeatureServer/1/query';
  const PHOTON = 'https://photon.komoot.io/api/';
  // Bias to the Houston–Galveston area; results anywhere in the US are still returned.
  const BIAS = { circle: { center: { latitude: 29.60, longitude: -95.20 }, radius: 120000 } };

  let token = null, seq = 0;
  const newToken = () => (token = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())));
  const cap = s => (s || '').trim().toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
  const SFX = { ST: 'St', DR: 'Dr', RD: 'Rd', LN: 'Ln', AVE: 'Ave', BLVD: 'Blvd', CT: 'Ct', CIR: 'Cir', PL: 'Pl', WAY: 'Way', TRL: 'Trl', PKWY: 'Pkwy', HWY: 'Hwy', TER: 'Ter', LOOP: 'Loop', CV: 'Cv', PT: 'Pt', FWY: 'Fwy' };

  // ---- 2. Harris County parcels ----
  function hcLine(a) {
    const street = [a.site_str_pfx, cap(a.site_str_name), SFX[(a.site_str_sfx || '').trim()] || cap(a.site_str_sfx), a.site_str_sfx_dir].map(s => (s || '').trim()).filter(Boolean).join(' ');
    const num = `${a.site_str_num}${(a.site_str_num_sfx || '').trim()}`;
    const main = `${num} ${street}`.trim();
    const secondary = [cap(a.site_city), a.site_zip ? `TX ${a.site_zip}` : 'TX'].filter(Boolean).join(', ');
    return { id: 'hcad:' + a.HCAD_NUM, main, secondary, text: `${main}, ${secondary}`, src: 'hcad', a };
  }
  async function hcSuggest(q) {
    const s = parseQ(q); if (!s) return [];
    let rows = await hcRows(s.num, s.name), near = false;
    if (!rows.length && s.name.length >= 3) { rows = await hcNear(s.num, s.name); near = rows.length > 0; }
    // A typed direction ("W") or suffix ("St", "Drive") narrows the list; if nothing matches it, show the unfiltered list.
    const f = rows.filter(a => (!s.dir || (a.site_str_pfx || '').trim().toUpperCase() === s.dir) && (!s.sfx || (a.site_str_sfx || '').trim().toUpperCase() === s.sfx));
    return (f.length ? f : rows).slice(0, 6).map(a => { const h = hcLine(a); if (near) h.secondary += ' · closest number on file'; return h; });
  }
  // "9250 w autauga st, houston" -> {num: 9250, dir: 'W', name: 'AUTAUGA', sfx: 'ST'}. The county keeps the
  // direction and suffix in their own columns, so they're split off before the name search.
  const WORDS = { STREET: 'ST', DRIVE: 'DR', ROAD: 'RD', LANE: 'LN', AVENUE: 'AVE', AV: 'AVE', BOULEVARD: 'BLVD', COURT: 'CT', CIRCLE: 'CIR', PLACE: 'PL', TRAIL: 'TRL', PARKWAY: 'PKWY', HIGHWAY: 'HWY', TERRACE: 'TER', COVE: 'CV', POINT: 'PT', FREEWAY: 'FWY' };
  const DIRS = { N: 'N', S: 'S', E: 'E', W: 'W', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NE: 'NE', NW: 'NW', SE: 'SE', SW: 'SW' };
  function parseQ(q) {
    const m = q.match(/^(\d{1,6})\s+([A-Za-z][A-Za-z0-9 .'-]*)/); if (!m) return null;   // house number + start of the street
    const t = m[2].split(',')[0].replace(/\b(houston|tx|texas|spring|katy|humble|pasadena|cypress|tomball)\b.*$/i, '').replace(/[.']/g, '').trim().toUpperCase().split(/\s+/).filter(Boolean);
    let dir = '', sfx = '';
    if (t.length > 1 && DIRS[t[0]]) dir = DIRS[t.shift()];
    if (t.length > 1) { const L = t[t.length - 1], v = SFX[L] ? L : WORDS[L]; if (v) { sfx = v; t.pop(); } }
    const name = t.join(' '); return name ? { num: +m[1], dir, sfx, name } : null;
  }
  // Every street at that house number starting with the typed letters. Up to 50 come back per call, so once a
  // short prefix has been fetched in full, the next keystrokes filter it in the browser with no network wait.
  const HC_FIELDS = 'HCAD_NUM,site_str_pfx,site_str_num,site_str_num_sfx,site_str_name,site_str_sfx,site_str_sfx_dir,site_city,site_zip';
  const hcCache = new Map(); let hcCtl = null;
  async function hcQuery(where, order) {
    if (hcCtl) hcCtl.abort(); const ctl = hcCtl = new AbortController();
    const p = new URLSearchParams({ where, outFields: HC_FIELDS, returnGeometry: 'false', resultRecordCount: '50', orderByFields: order, f: 'json' });
    const r = await fetch(`${HC}?${p}`, { signal: ctl.signal }); if (!r.ok) throw new Error('hcad ' + r.status);
    const j = await r.json(); if (j.error) throw new Error('hcad ' + j.error.code); return (j.features || []).map(f => f.attributes);
  }
  const sq = s => s.replace(/'/g, "''");
  async function hcRows(num, name) {
    for (let k = name.length; k >= 1; k--) { const c = hcCache.get(num + '|' + name.slice(0, k));
      if (c && (c.complete || k === name.length)) return c.rows.filter(a => (a.site_str_name || '').trim().toUpperCase().startsWith(name)); }
    const rows = await hcQuery(`site_str_num=${num} AND UPPER(site_str_name) LIKE '${sq(name)}%'`, 'site_str_name,site_str_sfx');
    hcCache.set(num + '|' + name, { rows, complete: rows.length < 50 }); return rows;
  }
  // No parcel at that exact number (common when adding the lot next door): the closest numbers on that street.
  async function hcNear(num, name) {
    const pick = rows => rows.filter(a => (a.site_str_name || '').trim().toUpperCase().startsWith(name))
      .sort((a, b) => Math.abs(a.site_str_num - num) - Math.abs(b.site_str_num - num)).slice(0, 4);
    for (let k = name.length; k >= 3; k--) { const c = hcCache.get('near|' + num + '|' + name.slice(0, k));
      if (c && (c.complete || k === name.length)) return pick(c.rows); }
    const rows = await hcQuery(`UPPER(site_str_name) LIKE '${sq(name)}%' AND site_str_num>=${Math.max(0, num - 60)} AND site_str_num<=${num + 60}`, 'site_str_num');
    hcCache.set('near|' + num + '|' + name, { rows, complete: rows.length < 50 }); return pick(rows);
  }
  async function hcResolve(hcad) {
    const p = new URLSearchParams({ where: `HCAD_NUM='${hcad.replace(/'/g, '')}'`, outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'json' });
    const r = await fetch(`${HC}?${p}`); if (!r.ok) return null;
    const j = await r.json(); const f = j.features && j.features[0]; if (!f || !f.geometry) return null;
    let ring = f.geometry.rings[0].map(([lng, lat]) => ({ lng, lat }));
    if (ring.length > 1 && Math.abs(ring[0].lng - ring[ring.length-1].lng) < 1e-12 && Math.abs(ring[0].lat - ring[ring.length-1].lat) < 1e-12) ring = ring.slice(0, -1);
    const a = f.attributes, c = { lng: ring.reduce((s, q) => s + q.lng, 0) / ring.length, lat: ring.reduce((s, q) => s + q.lat, 0) / ring.length };
    const sqft = a.land_sqft;
    const dims = [sqft ? Math.round(sqft).toLocaleString() + ' sq ft' : (a.StatedArea ? (+a.StatedArea).toFixed(3) + ' ac' : ''), ring.length + ' corners', a.legal_dscr_1, a.legal_dscr_2].filter(Boolean).join(' · ');
    return { lat: c.lat, lng: c.lng, ring, parcel: { cad: 'Harris CAD', hcad: a.HCAD_NUM, dims, legal: [a.legal_dscr_1, a.legal_dscr_2, a.legal_dscr_3, a.legal_dscr_4].filter(Boolean).join(' '), pts: ringToPts(ring) } };
  }
  // Scaled preview polygon for the little parcel badge (40×30 box)
  function ringToPts(ring) {
    const lats = ring.map(p => p.lat), lngs = ring.map(p => p.lng); const k = Math.cos(lats[0] * Math.PI / 180);
    const x0 = Math.min(...lngs) * k, x1 = Math.max(...lngs) * k, y0 = Math.min(...lats), y1 = Math.max(...lats); const s = 24 / Math.max(x1 - x0, y1 - y0, 1e-9);
    const w = (x1 - x0) * s, h = (y1 - y0) * s, ox = (40 - w) / 2, oy = (30 - h) / 2;
    return ring.map(p => `${(ox + (p.lng * k - x0) * s).toFixed(1)},${(oy + (y1 - p.lat) * s).toFixed(1)}`).join(' ');
  }

  // ---- 3. Photon (OSM) ----
  async function photonSuggest(q) {
    const p = new URLSearchParams({ q, limit: '5', lang: 'en', lat: '29.6', lon: '-95.2', bbox: '-98.5,27.5,-92.5,31.5' });
    const r = await fetch(`${PHOTON}?${p}`); if (!r.ok) return [];
    const j = await r.json();
    return (j.features || []).filter(f => f.properties.housenumber && f.properties.street).map(f => { const pr = f.properties;
      const main = `${pr.housenumber} ${pr.street}`; const secondary = [pr.city || pr.county, pr.state === 'Texas' ? 'TX' : pr.state, pr.postcode].filter(Boolean).join(', ');
      return { id: 'osm:' + pr.osm_id, main, secondary, text: `${main}, ${secondary}`, src: 'osm', lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }; });
  }

  // ---- 1. Google ----
  async function googleSuggest(q) {
    if (!token) newToken();
    const r = await fetch(`${BASE}/places:autocomplete`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY },
      body: JSON.stringify({ input: q, sessionToken: token, locationBias: BIAS, includedRegionCodes: ['us'], includedPrimaryTypes: ['street_address', 'premise', 'subpremise'], languageCode: 'en' }) });
    if (!r.ok) { console.warn('places autocomplete', r.status); return []; }
    const j = await r.json();
    return (j.suggestions || []).map(s => s.placePrediction).filter(Boolean).slice(0, 6).map(p => ({ id: 'g:' + p.placeId, src: 'google',
      main: p.structuredFormat && p.structuredFormat.mainText ? p.structuredFormat.mainText.text : p.text.text,
      secondary: p.structuredFormat && p.structuredFormat.secondaryText ? p.structuredFormat.secondaryText.text : '', text: p.text.text }));
  }
  async function googleResolve(id, fallbackText) {
    const r = await fetch(`${BASE}/places/${id}?sessionToken=${encodeURIComponent(token || '')}`, { headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'formattedAddress,location' } });
    token = null;
    if (!r.ok) return { address: fallbackText, lat: null, lng: null };
    const j = await r.json();
    return { address: (j.formattedAddress || fallbackText).replace(/, USA$/, ''), lat: j.location && j.location.latitude, lng: j.location && j.location.longitude };
  }

  async function suggest(text) {
    const q = text.trim(); if (q.length < 3) return [];
    const my = ++seq; let out = [];
    try {
      if (KEY) out = await googleSuggest(q);
      else { out = await hcSuggest(q).catch(() => []); if (my !== seq) return null;
        if (!out.length && /\d/.test(q) && q.length >= 6) out = await photonSuggest(q).catch(() => []); }
    } catch (e) { console.warn('suggest', e); }
    return my !== seq ? null : out;
  }

  // After a Harris pick we have the parcel itself; after Google/OSM we have coordinates, and the Harris
  // parcel (if any) is matched by position + house number when the order runs (satellite.js).
  async function resolve(id, fallbackText, hit) {
    const h = hit || {}; const kind = (id || '').split(':')[0], raw = (id || '').slice(kind.length + 1);
    if (kind === 'hcad') { const r = await hcResolve(raw).catch(() => null); return r ? Object.assign({ address: h.text || fallbackText }, r) : { address: h.text || fallbackText, lat: null, lng: null }; }
    if (kind === 'osm') return { address: h.text || fallbackText, lat: h.lat, lng: h.lng };
    if (kind === 'g' && KEY) return googleResolve(raw, fallbackText);
    token = null; return { address: fallbackText, lat: null, lng: null };
  }

  window.LO = window.LO || {};
  window.LO.places = { suggest, resolve, enabled: true, source: KEY ? 'google' : 'hcad+osm' };
})();
