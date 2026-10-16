// "I don't have photos" intake: builds a listing kit from public imagery and the county parcel map.
// Usage: LO.sat.buildKit(order, {onProgress}) -> fills order.photos with the kit views, each a {name, img, pts, geo, view}
//        LO.sat.carry(order, srcIndex)       -> re-projects the confirmed pins from one view onto every other view
// Kit: close-up / block / neighborhood on satellite imagery, block + neighborhood on a street map, a 10-mile map with the
//      property as a labeled dot, and the parcel map. Street maps are the same tile math as the imagery, just a different source.
// Sources: Esri World Imagery and World Street Map tiles (public tile services, attribution burned into each image);
//          Harris County parcel polygons (HCAD layer on ArcGIS Online, CORS-enabled). Other counties fall back
//          to a rectangle sized from the parcel description until their GIS endpoint is wired in.
(function () {
  // Basemaps. Street tiles are never probed for the grey placeholder: a park or a bayou is a flat beige tile and would trip it;
  // past their real max zoom they just 404, which loadTile already treats as a miss.
  const BASES = {
    sat:    { tile: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile', bg: '#2b3a2f', probe: true,
              attr: 'Imagery \u00A9 Esri, Maxar, Earthstar Geographics & the GIS User Community' },
    street: { tile: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile', bg: '#F2EFE9', probe: false,
              attr: 'Map \u00A9 Esri, HERE, Garmin, OpenStreetMap contributors & the GIS User Community' },
    // Light-gray canvas (base + labels) for the region map: quiet enough that the dot is the only thing in color. Served to zoom 16.
    canvas: { tile: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile',
                     'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile'], bg: '#E8E8E8', probe: false,
              attr: 'Map \u00A9 Esri, HERE, Garmin, OpenStreetMap contributors & the GIS User Community' } };
  const REGION_MI = 2;                      // the "where it sits" map: miles from the lot to the top and bottom edge. 5, not 10: HAR 1.25.5 allows the
                                            // property's immediate vicinity, and the lot inset keeps the property the primary focus.
  const HC_PARCELS = 'https://services.arcgis.com/su8ic9KbA7PYVxPS/arcgis/rest/services/Harris_County_Parcels/FeatureServer/1/query';
  // Galveston CAD's own ArcGIS Online parcel layer (public, CORS-open). SITUS is one string with no suffix ("65 LAKESIDE HITCHCOCK, TX 77563"),
  // vacant lots have a blank SITUS, so the subject is also matched on LEGAL ("LOT 65 (65-1) BAYOU VISTA ADDN 2"). See docs/GALVESTON.md.
  const GC_PARCELS = 'https://services2.arcgis.com/7Zo7vX4Yxo9Z7Vw3/arcgis/rest/services/MyMapService/FeatureServer/0/query';
  // Fort Bend + Montgomery: the City of Houston's current FBCAD / MCAD parcel layers (public, no key, CORS-open; refreshed from the CADs).
  // San Jacinto: the CAD's own layer, hosted by BIS (its GIS vendor) on ArcGIS Online (public, no key, CORS *). Owner fields are never requested.
  const COH = 'https://geohwp.houstontx.gov/arcgis/rest/services/03_BaseData_External/Parcels_Current/FeatureServer';
  const splitAddr = s => { const m = (s || '').trim().match(/^(\d+[A-Za-z]?)\s+([^,]+?)(?:,|\s+[A-Z][A-Za-z ]+\s+TX\b)/); return m ? [m[1], m[2]] : ['', '']; };
  // ADDING A COUNTY (standing rule, decision 10/12/2026): every new county also gets its Address-step pieces, in the same change:
  // an ID_FORMAT entry (tax ID and parcel ID dash pattern), a BY_ID lookup, its second ID mapped to `pid` if it keeps one,
  // and the county name/cities in whichCounty. Checklist: docs/COUNTIES.md. Mirror it in lotoutline/parcel.py.
  const COUNTIES = {
    fortbend: { cad: 'Fort Bend CAD', url: `${COH}/5/query`, fields: 'PARCEL_ID,ADDRESS,LEGALDSCR1,TOT_LANDAR,ACREAGE',
      box: [29.25, 29.80, -96.10, -95.42], words: /fort bend|sugar land|missouri city|richmond|rosenberg|stafford|fulshear|needville|meadows place|sienna|pecan grove|first colony|cinco ranch|mission bend|weston lakes|simonton|thompsons|orchard|beasley|kendleton|arcola/i,
      map: a => { const [n, st] = splitAddr(a.ADDRESS); return { HCAD_NUM: a.PARCEL_ID, site_str_num: n, site_str_name: st, legal_dscr_1: a.LEGALDSCR1, land_sqft: a.TOT_LANDAR, StatedArea: a.ACREAGE }; } },
    montgomery: { cad: 'Montgomery CAD', url: `${COH}/3/query`, fields: 'PARCEL_ID,ADDRESS,SUB_BLOCK,SUB_LOT,Tract,Shape__Area',
      box: [30.03, 30.63, -95.83, -95.07], words: /montgomery|conroe|the woodlands|magnolia|willis|porter|new caney|splendora|oak ridge north|shenandoah|panorama village|montgomery tx|patton village|roman forest|pinehurst|stagecoach|cut and shoot|dobbin|grangerland|woodbranch/i,
      map: a => { const [n, st] = splitAddr(a.ADDRESS); const legal = [a.SUB_BLOCK != null ? 'Block ' + a.SUB_BLOCK : '', a.SUB_LOT ? 'Lot ' + a.SUB_LOT : '', a.Tract ? 'Tract ' + a.Tract : ''].filter(Boolean).join(', ');
        return { HCAD_NUM: a.PARCEL_ID, site_str_num: n, site_str_name: st, legal_dscr_1: legal, land_sqft: a.Shape__Area }; } },
    sanjacinto: { cad: 'San Jacinto CAD', url: 'https://services8.arcgis.com/Cj28SFmpkCtGCeEQ/arcgis/rest/services/SanJacintoCADWebService/FeatureServer/0/query',
      fields: 'prop_id,geo_id,legal_desc,legal_acreage,situs_num,situs_street,situs_street_sufix,tract_or_lot',
      box: [30.33, 30.86, -95.36, -94.83], words: /san jacinto|coldspring|cold spring|shepherd|oakhurst|point blank|pointblank|evergreen|camilla|stephen creek/i,
      map: a => ({ HCAD_NUM: a.geo_id || a.prop_id, pid: a.geo_id ? a.prop_id : null, site_str_num: a.situs_num || '', site_str_name: [a.situs_street, a.situs_street_sufix].filter(Boolean).join(' '), legal_dscr_1: a.legal_desc, StatedArea: a.legal_acreage, lot: a.tract_or_lot }) },
  };
  const W = 1600, H = 1067;                  // 3:2, matches the rest of the order
  const MAX_UP = 3.2;                       // never blow imagery up more than this; past it the close-up turns to mush

  // ---- web mercator ----
  const px = (lng, lat, z) => { const n = 256 * Math.pow(2, z); const s = Math.min(.9999, Math.max(-.9999, Math.sin(lat * Math.PI / 180)));
    return { x: (lng + 180) / 360 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n }; };
  const geo = (x, y, z) => { const n = 256 * Math.pow(2, z); const lng = x / n * 360 - 180; const t = Math.PI * (1 - 2 * y / n);
    return { lng, lat: 180 / Math.PI * Math.atan(Math.sinh(t)) }; };
  const ftPerDeg = lat => ({ lat: 364000, lng: 364000 * Math.cos(lat * Math.PI / 180) });

  // ---- geocode fallback when Places gave no coordinates (typed address, no key) ----
  // Esri's US geocoder first (street-level, knows which Memorial Dr is which); OpenStreetMap's Nominatim as the backup.
  async function geocode(addr) {
    try { const r = await fetch('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&maxLocations=1&countryCode=USA&outFields=Addr_type&SingleLine=' + encodeURIComponent(addr));
      const j = r.ok ? await r.json() : null, c = j && j.candidates && j.candidates[0];
      if (c && c.score >= 85 && /PointAddress|StreetAddress|Subaddress|StreetInt/.test((c.attributes && c.attributes.Addr_type) || 'PointAddress')) return { lat: c.location.y, lng: c.location.x }; } catch (e) { console.warn('esri geocode', e); }
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(addr));
    const j = r.ok ? await r.json() : [];
    if (!j.length) throw new Error("We couldn't place that address on the map. Check the spelling and try again.");
    return { lat: +j[0].lat, lng: +j[0].lon };
  }

  // ---- Harris County parcels: subject + neighbors in a ~400 ft window ----
  async function harrisParcels(g, addr, win = 220) {
    const f = ftPerDeg(g.lat), dLat = win / f.lat, dLng = win / f.lng;
    const env = [g.lng - dLng, g.lat - dLat, g.lng + dLng, g.lat + dLat].join(',');
    const u = `${HC_PARCELS}?where=1%3D1&geometry=${env}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&outSR=4326&resultRecordCount=2000&f=json`;
    const r = await fetch(u); if (!r.ok) return null; const j = await r.json(); if (!j.features || !j.features.length) return null;
    const feats = j.features.map(ft => ({ a: ft.attributes, ring: ft.geometry.rings[0].map(([lng, lat]) => ({ lng, lat })) }));
    const num = (addr.match(/^\s*(\d+)/) || [])[1], street = (addr.replace(/^\s*\d+[A-Za-z]?\s+/, '').split(',')[0] || '').toLowerCase().replace(/\b(st|street|dr|drive|rd|road|ln|lane|ave|avenue|blvd|boulevard|ct|court|cir|circle|way|pl|place)\b\.?/g, '').trim();
    const streetOf = a => `${a.site_str_name || ''}`.toLowerCase().trim();
    // Matched = house number AND street agree with the county record. A number alone (65 Tarpon for 65 Lakeside) is only a guess.
    let subj = feats.find(x => x.a.site_str_num == num && street && streetOf(x.a) && street.startsWith(streetOf(x.a).split(' ')[0]));
    const matched = !!subj; if (!subj) subj = feats.find(x => x.a.site_str_num == num);
    if (!subj) { // nearest centroid to the geocode: a guess, flagged unmatched so it never reaches an agent unchecked
      const d = x => { const c = centroid(x.ring); return Math.hypot(c.lng - g.lng, c.lat - g.lat); };
      subj = feats.slice().sort((a, b) => d(a) - d(b))[0];
    }
    return { subject: subj, neighbors: feats.filter(x => x !== subj), matched };
  }
  // ---- Galveston County parcels: same window, CAD field names mapped onto the Harris ones the kit already draws ----
  async function galvestonParcels(g, addr, win = 220) {
    const f = ftPerDeg(g.lat), dLat = win / f.lat, dLng = win / f.lng;
    const env = [g.lng - dLng, g.lat - dLat, g.lng + dLng, g.lat + dLat].join(',');
    const u = `${GC_PARCELS}?where=1%3D1&geometry=${env}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=GEOID,PID,SITUS,SITUS_NO,LEGAL,ACRES&outSR=4326&resultRecordCount=2000&f=json`;
    const r = await fetch(u); if (!r.ok) return null; const j = await r.json(); if (!j.features || !j.features.length) return null;
    const feats = j.features.map(ft => { const a = ft.attributes, m = (a.SITUS || '').trim().match(/^(\d+[A-Za-z]?)\s+(.*?)\s+[A-Z ]+,\s*TX/);
      return { a: { ...a, HCAD_NUM: a.GEOID, site_str_num: m ? m[1] : '', site_str_name: m ? m[2] : '', legal_dscr_1: a.LEGAL, StatedArea: a.ACRES }, ring: ft.geometry.rings[0].map(([lng, lat]) => ({ lng, lat })) }; });
    const num = (addr.match(/^\s*(\d+)/) || [])[1], street = (addr.replace(/^\s*\d+[A-Za-z]?\s+/, '').split(',')[0] || '').toLowerCase().replace(/\b(st|street|dr|drive|rd|road|ln|lane|ave|avenue|blvd|boulevard|ct|court|cir|circle|way|pl|place)\b\.?/g, '').trim();
    const streetOf = a => `${a.site_str_name || ''}`.toLowerCase().trim();
    // Matched = number + street, or (vacant lots have no situs) exactly one blank-situs parcel whose legal is "LOT <number>".
    let subj = feats.find(x => x.a.site_str_num == num && street && streetOf(x.a) && street.startsWith(streetOf(x.a).split(' ')[0]));
    if (!subj) { const lots = feats.filter(x => new RegExp(`\\bLOTS?\\s+(?:[\\d&,\\s]*\\b)?${num}\\b`).test(x.a.LEGAL || '') && !(x.a.SITUS || '').trim()); if (lots.length === 1) subj = lots[0]; }
    const matched = !!subj; if (!subj) subj = feats.find(x => x.a.site_str_num == num);
    if (!subj) { const d = x => { const c = centroid(x.ring); return Math.hypot(c.lng - g.lng, c.lat - g.lat); }; subj = feats.slice().sort((a, b) => d(a) - d(b))[0]; }
    return { subject: subj, neighbors: feats.filter(x => x !== subj), matched };
  }
  // ---- Fort Bend / Montgomery / San Jacinto: same window and matching, fields mapped onto the Harris names ----
  async function countyParcels(cfg, g, addr, win = 220) {
    const f = ftPerDeg(g.lat), dLat = win / f.lat, dLng = win / f.lng;
    const env = [g.lng - dLng, g.lat - dLat, g.lng + dLng, g.lat + dLat].join(',');
    const u = `${cfg.url}?where=1%3D1&geometry=${env}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${cfg.fields}&outSR=4326&resultRecordCount=2000&f=json`;
    const r = await fetch(u); if (!r.ok) return null; const j = await r.json(); if (!j.features || !j.features.length) return null;
    const feats = j.features.filter(ft => ft.geometry && ft.geometry.rings).map(ft => ({ a: cfg.map(ft.attributes), ring: ft.geometry.rings[0].map(([lng, lat]) => ({ lng, lat })) }));
    if (!feats.length) return null;
    const num = (addr.match(/^\s*(\d+)/) || [])[1], street = (addr.replace(/^\s*\d+[A-Za-z]?\s+/, '').split(',')[0] || '').toLowerCase().replace(/\b(st|street|dr|drive|rd|road|ln|lane|ave|avenue|blvd|boulevard|ct|court|cir|circle|way|pl|place|trl|trail|pkwy|parkway|hwy|highway|fm)\b\.?/g, '').trim();
    const streetOf = a => `${a.site_str_name || ''}`.toLowerCase().trim();
    const inside = x => { let c = false; const R = x.ring; for (let i = 0, k = R.length - 1; i < R.length; k = i++) { const A = R[i], B = R[k]; if ((A.lat > g.lat) !== (B.lat > g.lat) && g.lng < (B.lng - A.lng) * (g.lat - A.lat) / (B.lat - A.lat) + A.lng) c = !c; } return c; };
    const bare = t => t.replace(/\b(st|street|dr|drive|rd|road|ln|lane|ave|avenue|blvd|boulevard|ct|court|cir|circle|way|pl|place|trl|trail|pkwy|parkway|hwy|highway|fm)\b\.?/g, '').replace(/\s+/g, ' ').trim();
    let subj = (num && street && feats.find(x => x.a.site_str_num == num && bare(streetOf(x.a)) === street))
            || (num && feats.find(x => x.a.site_str_num == num && street && streetOf(x.a) && street.startsWith(bare(streetOf(x.a)).split(' ')[0])));
    const matched = !!subj; if (!subj) subj = (num && feats.find(x => x.a.site_str_num == num)) || feats.find(inside);   // guesses only
    if (!subj) { const d = x => { const c = centroid(x.ring); return Math.hypot(c.lng - g.lng, c.lat - g.lat); }; subj = feats.slice().sort((a, b) => d(a) - d(b))[0]; }
    return { subject: subj, neighbors: feats.filter(x => x !== subj), matched };
  }
  // Which county: the address words first, then the rough box around each county. Harris and Galveston keep their own lookups.
  function whichCounty(addr, g) {
    const isGalveston = /galveston|hitchcock|bayou vista|league city|friendswood|dickinson|texas city|la marque|santa fe|kemah|tiki island|jamaica beach|clear lake shores|crystal beach|bolivar|san leon|bacliff/i.test(addr);
    if (isGalveston) return 'galveston';
    for (const [k, c] of Object.entries(COUNTIES)) if (c.words.test(addr)) return k;
    if (/houston|bellaire|west university|pasadena|katy|spring|humble|cypress|tomball|kingwood|harris|baytown|jersey village|seabrook|webster|la porte|deer park|channelview|crosby|huffman|atascocita/i.test(addr)) return 'harris';
    if (g.lat > 29.0 && g.lat < 29.66 && g.lng > -95.30 && g.lng < -94.35 && !(g.lat > 29.49 && g.lng < -94.90)) return 'galveston';
    if (g.lat > 29.49 && g.lat < 30.17 && g.lng > -95.97 && g.lng < -94.90) return 'harris';
    for (const [k, c] of Object.entries(COUNTIES)) { const [a, b, x, y] = c.box; if (g.lat > a && g.lat < b && g.lng > x && g.lng < y) return k; }
    return null;
  }
  // One county's parcels around a point; win = half-width of the window in feet (the block plat map asks for more than 220).
  const runCounty = (k, g, addr, win = 220) => k === 'harris' ? harrisParcels(g, addr, win) : k === 'galveston' ? galvestonParcels(g, addr, win) : countyParcels(COUNTIES[k], g, addr, win);
  // Parcel for an address: the guessed county first; if it finds nothing, the other counties are tried (county lines don't follow city names).
  async function lookupParcels(g, addr) {
    const first = whichCounty(addr, g); const order = [first, 'harris', 'fortbend', 'montgomery', 'galveston', 'sanjacinto'].filter((k, i, a) => k && a.indexOf(k) === i);
    const run = (k, gg = g, win = 220) => k === 'harris' ? harrisParcels(gg, addr, win) : k === 'galveston' ? galvestonParcels(gg, addr, win) : countyParcels(COUNTIES[k], gg, addr, win);
    const label = k => k === 'harris' ? 'Harris CAD' : k === 'galveston' ? 'Galveston CAD' : COUNTIES[k].cad;
    let guess = null;
    for (const k of first ? order : []) { try { let p = await run(k);
        if (p && !p.matched) { const wide = await run(k, g, 1000); if (wide && wide.matched) { const near = await run(k, centroid(wide.subject.ring), 220); p = near && near.matched ? near : wide; } }
        if (p && p.matched) return { parcels: p, cad: label(k), key: k, matched: true };
        if (p && !guess) guess = { parcels: p, cad: label(k), key: k, matched: false };
      } catch (e) { console.warn('parcels', k, e); } }
    return guess || { parcels: null, cad: null, key: null, matched: false };
  }
  // Center of the shape by area (a curved front with many points doesn't pull it off center).
  const areaCenter = ring => { const c0 = ring[0]; let A = 0, X = 0, Y = 0; for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length], ax = p.lng - c0.lng, ay = p.lat - c0.lat, bx = q.lng - c0.lng, by = q.lat - c0.lat, cr = ax * by - bx * ay; A += cr; X += (ax + bx) * cr; Y += (ay + by) * cr; }
    return A ? { lng: c0.lng + X / (3 * A), lat: c0.lat + Y / (3 * A) } : centroid(ring); };
  const centroid = ring => { const n = ring.length; return { lng: ring.reduce((s, p) => s + p.lng, 0) / n, lat: ring.reduce((s, p) => s + p.lat, 0) / n }; };
  // Drop corners that sit on a straight side (some CAD layers carry extra vertices along a line); keeps real corners.
  const straighten = (ring, deg = 4) => { let r = ring.slice(); if (r.length <= 4) return r; const k = Math.cos(r[0].lat * Math.PI / 180);
    const turn = (a, b, c) => { const t1 = Math.atan2(b.lat - a.lat, (b.lng - a.lng) * k), t2 = Math.atan2(c.lat - b.lat, (c.lng - b.lng) * k); let d = Math.abs(t2 - t1) * 180 / Math.PI; return d > 180 ? 360 - d : d; };
    let changed = true; while (changed && r.length > 3) { changed = false; for (let i = 0; i < r.length && r.length > 3; i++) { const a = r[(i - 1 + r.length) % r.length], b = r[i], c = r[(i + 1) % r.length]; if (turn(a, b, c) < deg) { r.splice(i, 1); changed = true; break; } } } return r; };
  const dedupe = ring => { const out = ring.slice(); if (out.length > 1 && Math.abs(out[0].lng - out[out.length-1].lng) < 1e-12 && Math.abs(out[0].lat - out[out.length-1].lat) < 1e-12) out.pop(); return out; };

  // ---- rectangle from "60 × 132 ft" when there is no parcel service for the county ----
  function rectParcel(g, dims) {
    const m = (dims || '').match(/(\d+)\s*[×x]\s*(\d+)/); const w = m ? +m[1] : 60, d = m ? +m[2] : 120; const f = ftPerDeg(g.lat);
    const dx = w / 2 / f.lng, dy = d / 2 / f.lat;
    return [{ lng: g.lng - dx, lat: g.lat + dy }, { lng: g.lng + dx, lat: g.lat + dy }, { lng: g.lng + dx, lat: g.lat - dy }, { lng: g.lng - dx, lat: g.lat - dy }];
  }

  // ---- tiles ----
  const loadOne = (url, probeIt) => new Promise(res => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(probeIt && isPlaceholder(im) ? null : im); im.onerror = () => res(null); im.src = url; });
  // A basemap is one tile service or a stack of them (base + labels); the stack resolves to an array drawn in order, null if the base is missing.
  // blankTile=false: Esri answers 404 instead of its grey "Map data not yet available" square, so a missing zoom is a plain miss.
  const loadTile = async (z, x, y, base) => { const urls = [].concat(base.tile).map((t, i) => `${t}/${z}/${y}/${x}` + (base.probe && i === 0 ? '?blankTile=false' : '')); const ims = await Promise.all(urls.map((u, i) => loadOne(u, base.probe && i === 0))); return ims[0] ? ims.filter(Boolean) : null; };
  // Esri serves a flat grey "Map data not yet available" tile (HTTP 200) past the imagery's real max zoom.
  // Backstop if a mirror ignores blankTile: the placeholder is colorless light grey with thin white lettering. Sample at 32px with
  // smoothing on (a 16px nearest-neighbour shrink lands on the lettering and fooled the old check), and judge by the median, not min/max.
  const probe = document.createElement('canvas'); probe.width = probe.height = 32;
  function isPlaceholder(im) { const g = probe.getContext('2d', { willReadFrequently: true }); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(im, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data, v = []; let color = 0;
    for (let i = 0; i < d.length; i += 4) { v.push((d[i] + d[i+1] + d[i+2]) / 3); if (Math.abs(d[i] - d[i+1]) > 8 || Math.abs(d[i+1] - d[i+2]) > 8) color++; }
    if (color > v.length * 0.02) return false; v.sort((a, b) => a - b); const med = v[v.length >> 1];
    return med > 175 && med < 235 && v.filter(x => Math.abs(x - med) < 25).length > v.length * 0.85; }
  // z = tile zoom, s = how much the tiles are enlarged on the 1600x1067 sheet (1 = native pixels), baseKey = 'sat' | 'street'
  async function satellite(center, z, s, label, baseKey = 'sat', decorate, underlay) {
    const base = BASES[baseKey];
    const c = px(center.lng, center.lat, z); const left = c.x - W / 2 / s, top = c.y - H / 2 / s;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'); g.fillStyle = base.bg; g.fillRect(0, 0, W, H); g.imageSmoothingQuality = 'high';
    const x0 = Math.floor(left / 256), x1 = Math.floor((left + W / s) / 256), y0 = Math.floor(top / 256), y1 = Math.floor((top + H / s) / 256);
    const jobs = []; let ok = 0, miss = 0;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(loadTile(z, x, y, base).then(ims => { if (ims) ok++; else miss++; return { x, y, ims }; }));
    const tiles = await Promise.all(jobs);
    if (!ok || miss > ok) return null;      // zoom not served here; caller steps out one level
    const view = { kind: 'sat', base: baseKey, z, s, left, top };
    // Layer by layer across the sheet (base everywhere, then the underlay, then labels) so nothing we draw covers a place name.
    const layers = Math.max(...tiles.map(t => t.ims ? t.ims.length : 0));
    for (let L = 0; L < layers; L++) { if (L === 1 && underlay) await underlay(g, view);
      tiles.forEach(({ x, y, ims }) => { if (ims && ims[L]) g.drawImage(ims[L], (x * 256 - left) * s, (y * 256 - top) * s, 256 * s + 0.5, 256 * s + 0.5); }); }
    if (layers < 2 && underlay) await underlay(g, view);
    if (decorate) decorate(g, view);
    g.save(); g.font = '600 20px Figtree, system-ui, sans-serif'; g.textBaseline = 'bottom'; const t = base.attr; const tw = g.measureText(t).width;
    g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(W - tw - 28, H - 36, tw + 28, 36); g.fillStyle = '#fff'; g.fillText(t, W - tw - 14, H - 9); g.restore();
    const img = await toImage(cv);
    return { img, view, label };
  }
  // Freeways for the region map: Esri's public USA Freeway System lines (Interstates, US and state highways, Beltway 8), CORS-open.
  const FREEWAYS = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Freeway_System/FeatureServer/2/query';
  const routeName = a => { const n = (a.NUMBER || '').trim(), c = (a.CLASS || '').trim(); return c === 'I' ? 'I-' + n : c === 'U' ? 'US ' + n : n === '8' ? 'Beltway 8' : n === '99' ? 'Grand Pkwy' : 'SH ' + n; };
  async function drawFreeways(g, v) {
    const a = geo(v.left, v.top, v.z), b = geo(v.left + W / v.s, v.top + H / v.s, v.z);
    const u = `${FREEWAYS}?where=1%3D1&geometry=${a.lng},${b.lat},${b.lng},${a.lat}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=CLASS,NUMBER&outSR=4326&maxAllowableOffset=0.0002&f=json`;
    let feats = []; try { const r = await fetch(u); if (r.ok) feats = (await r.json()).features || []; } catch (e) { console.warn('freeways', e); }
    if (!feats.length) return;
    const P = (lng, lat) => { const q = px(lng, lat, v.z); return { x: (q.x - v.left) * v.s, y: (q.y - v.top) * v.s }; };
    const paths = feats.map(f => ({ name: routeName(f.attributes), lines: (f.geometry.paths || []).map(pt => pt.map(([lng, lat]) => P(lng, lat))) }));
    const stroke = (w, c) => { g.lineWidth = w; g.strokeStyle = c; paths.forEach(f => f.lines.forEach(l => { g.beginPath(); l.forEach((q, i) => i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)); g.stroke(); })); };
    g.save(); g.lineJoin = g.lineCap = 'round'; stroke(12, '#FFFFFF'); stroke(7, '#E9A43B'); g.restore();
    // one route tag per highway, on the visible stretch nearest the middle of the sheet, never on top of another tag
    const tags = []; g.save(); g.font = '700 22px Figtree, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const byName = {}; paths.forEach(f => (byName[f.name] = byName[f.name] || []).push(...f.lines.flat()));
    Object.entries(byName).forEach(([name, pts]) => { const vis = pts.filter(q => q.x > 90 && q.x < W - 90 && q.y > 60 && q.y < H - 80); if (!vis.length) return;
      vis.sort((p, q) => Math.hypot(p.x - W / 2, p.y - H / 2) - Math.hypot(q.x - W / 2, q.y - H / 2));
      const tw = g.measureText(name).width + 20, th = 34; const spot = vis.filter((q, i) => i % 3 === 0).find(q => Math.hypot(q.x - W / 2, q.y - H / 2) > 120 && !tags.some(t => Math.abs(t.x - q.x) < (t.w + tw) / 2 + 12 && Math.abs(t.y - q.y) < th + 8));
      if (!spot) return; tags.push({ x: spot.x, y: spot.y, w: tw });
      g.fillStyle = '#1E2A22'; g.beginPath(); g.roundRect(spot.x - tw / 2, spot.y - th / 2, tw, th, 8); g.fill(); g.strokeStyle = '#FFFFFF'; g.lineWidth = 2.5; g.stroke();
      g.fillStyle = '#FFFFFF'; g.fillText(name, spot.x, spot.y + 1); });
    g.restore();
  }
  // Region map: the lot is a sub-pixel speck at this scale, so instead of the outline it gets a labeled dot burned in.
  const metersPerPx = (lat, z) => 156543.03 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
  async function region(center, addr, extra) {
    // pick the canvas zoom that shows REGION_MI miles from the lot to the top edge at 1-2x enlargement (canvas tiles go to zoom 16)
    let z = 16; while (z > 10 && (H / 2) / (REGION_MI * 1609.34 / metersPerPx(center.lat, z)) < 1) z--;
    const s = Math.min(2, Math.max(1, (H / 2) / (REGION_MI * 1609.34 / metersPerPx(center.lat, z))));
    const label = addr.split(',')[0].trim();
    return satellite(center, z, s, 'Where it sits', 'canvas', (g, v) => {
      const q = px(center.lng, center.lat, v.z); const x = (q.x - v.left) * v.s, y = (q.y - v.top) * v.s;
      g.save(); g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 10; g.shadowOffsetY = 3;
      g.beginPath(); g.arc(x, y, 16, 0, Math.PI * 2); g.fillStyle = '#FFFFFF'; g.fill(); g.shadowColor = 'transparent';
      g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fillStyle = '#2F7A56'; g.fill();
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fillStyle = '#FFFFFF'; g.fill();
      g.font = '700 28px "Bricolage Grotesque", Figtree, system-ui, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left'; const tw = g.measureText(label).width;
      const bx = x + 26, by = y - 24, bw = tw + 32, bh = 48; const flip = bx + bw > W - 40;      // keep the tag on the sheet near the right edge
      const tx = flip ? x - 26 - bw : bx; g.shadowColor = 'rgba(0,0,0,.3)'; g.shadowBlur = 12; g.shadowOffsetY = 3;
      g.fillStyle = '#FFFFFF'; g.beginPath(); g.roundRect(tx, by, bw, bh, 10); g.fill(); g.shadowColor = 'transparent';
      g.strokeStyle = '#2F7A56'; g.lineWidth = 2.5; g.stroke(); g.fillStyle = '#1E2A22'; g.fillText(label, tx + 16, y + 1); g.restore();
      if (extra) extra(g, v);
    }, drawFreeways);
  }
  const toImage = cv => new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = cv.toDataURL('image/jpeg', 0.92); });
  const projectRing = (ring, v) => ring.map(p => { const q = px(p.lng, p.lat, v.z); return { x: (q.x - v.left) * v.s, y: (q.y - v.top) * v.s }; });
  const unproject = (pts, v) => pts.map(p => geo(p.x / v.s + v.left, p.y / v.s + v.top, v.z));
  // size of the lot in native tile pixels at zoom z (longest side of its bounding box)
  const lotPx = (ring, z) => { const P = ring.map(p => px(p.lng, p.lat, z)); const xs = P.map(p => p.x), ys = P.map(p => p.y); return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)); };

  // ---- parcel map: plat-style sheet, north up, subject drawn plain (the style pass adds the outline + highlight) ----
  const rrect = (g, x, y, w, h, r) => { r = Math.min(r, w / 2, h / 2); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  // Parcel map: always the county's own lot lines in one fixed house style (deep green line, pale green lot, white
  // footage pills). The agent's pins and look never touch it (app.html skips the overlay for view.kind 'map').
  async function parcelMap(parcels, mainRing, addr, cad, list, groups) {
    const SUBJ = groups && groups.length > 1 ? groups.map(gr => gr.ring) : [mainRing], membersOf = gi => groups && groups.length > 1 ? groups[gi].members.map(m => list[m]) : (list || []);
    const multi = list && list.length > 1, ids = new Set((list || []).map(x => String(x.id)));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    g.fillStyle = '#FBFAF6'; g.fillRect(0, 0, W, H);
    const allP = SUBJ.flat(), c = { lng: (Math.min(...allP.map(p => p.lng)) + Math.max(...allP.map(p => p.lng))) / 2, lat: (Math.min(...allP.map(p => p.lat)) + Math.max(...allP.map(p => p.lat))) / 2 }, f = ftPerDeg(c.lat);
    const toFt = p => ({ x: (p.lng - c.lng) * f.lng, y: -(p.lat - c.lat) * f.lat });
    const sub = allP.map(toFt); const ext = Math.max(...sub.map(p => Math.abs(p.x)), ...sub.map(p => Math.abs(p.y)));
    const scale = (H * 0.30) / Math.max(ext, 30);        // subject fills roughly the middle 60% of the sheet height
    const cx = W * 0.5, cy = H * 0.5;
    const S = p => { const q = toFt(p); return { x: cx + q.x * scale, y: cy + q.y * scale }; };
    const view = { kind: 'map', S };
    // faint section grid like a plat sheet
    g.strokeStyle = '#EFEDE5'; g.lineWidth = 1; for (let x = 0; x < W; x += 80) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); } for (let y = 0; y < H; y += 80) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    const ring = (r) => { g.beginPath(); r.forEach((p, i) => { const q = S(p); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); }); g.closePath(); };
    // neighbors
    g.font = '500 17px Figtree, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    (parcels ? parcels.neighbors : []).filter(n => !ids.has(String(n.a.HCAD_NUM))).forEach(n => { ring(n.ring); g.fillStyle = '#F2F3EE'; g.fill(); g.strokeStyle = '#C6CEC7'; g.lineWidth = 1.5; g.lineJoin = 'round'; g.stroke();
      const q = S(centroid(n.ring)); if (q.x > 20 && q.x < W - 20 && q.y > 20 && q.y < H - 20 && !(q.y > H - 90 && q.x > W - 520) && n.a.site_str_num) { g.fillStyle = '#8C978F'; g.fillText(n.a.site_str_num, q.x, q.y); } });
    // subject lot lines (plain) + dimensions in feet along each side
    SUBJ.forEach((subjectRing, gi) => {
    ring(subjectRing); g.fillStyle = '#E9F3EC'; g.fill();
    if (multi) { // how the parcels fit together: light dashed lines inside the one outline, each parcel's tax ID in its middle
      // only the parcel edges that run inside the outline (an edge along the outside is already the outline)
      const U = subjectRing.map(toFt), near = (p) => { let m = Infinity; for (let i = 0; i < U.length; i++) { const a = U[i], b = U[(i + 1) % U.length], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0; m = Math.min(m, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)); } return m; };
      g.save(); ring(subjectRing); g.clip(); g.strokeStyle = '#5F806C'; g.lineWidth = 2.6; g.setLineDash([14, 9]);
      membersOf(gi).forEach(x => x.ring.forEach((a, i) => { const b = x.ring[(i + 1) % x.ring.length], fa = toFt(a), fb = toFt(b), mid = { x: (fa.x + fb.x) / 2, y: (fa.y + fb.y) / 2 };
        if (near(mid) < 3 && near(fa) < 3 && near(fb) < 3) return; const pa = S(a), pb = S(b); g.beginPath(); g.moveTo(pa.x, pa.y); g.lineTo(pb.x, pb.y); g.stroke(); })); g.restore();
      g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
      membersOf(gi).forEach(x => { const q = S(areaCenter(x.ring)); g.font = '700 28px "Bricolage Grotesque", Figtree, system-ui, sans-serif'; g.fillStyle = '#1E2A22'; g.fillText(x.area.toLocaleString() + ' sq ft', q.x, q.y - 10);
        g.font = '500 14px Figtree, system-ui, sans-serif'; g.fillStyle = '#7B8A7F'; g.fillText('Tax ID ' + x.id, q.x, q.y + 18); }); g.restore(); }
    g.strokeStyle = '#1F5F45'; g.lineWidth = 4; g.lineJoin = 'round'; ring(subjectRing); g.stroke();
    // Footage: large and bold so it reads in an MLS thumbnail; a side too short for the big size gets the largest size that fits it.
    g.fillStyle = '#1E2A22';
    // Runs of short, gently turning sides (a cul-de-sac curve) get one label with their total length, placed on the run's longest piece.
    const R = subjectRing, nR = R.length, segLen = i => { const fa = toFt(R[i]), fb = toFt(R[(i + 1) % nR]); return Math.hypot(fb.x - fa.x, fb.y - fa.y); };
    const ang = i => { const fa = toFt(R[i]), fb = toFt(R[(i + 1) % nR]); return Math.atan2(fb.y - fa.y, fb.x - fa.x); };
    const bend = i => { let d = Math.abs(ang(i) - ang((i - 1 + nR) % nR)) * 180 / Math.PI; return d > 180 ? 360 - d : d; };
    let start = 0; for (let i = 0; i < nR; i++) if (bend(i) >= 15) { start = i; break; }
    const runs = []; for (let k = 0; k < nR; k++) { const i = (start + k) % nR; if (k === 0 || bend(i) >= 15) runs.push([i]); else runs[runs.length - 1].push(i); }
    const runLen = new Map(), skip = new Set(); runs.forEach(run => { const tot = run.reduce((t, i) => t + segLen(i), 0); const best = run.reduce((m, i) => segLen(i) > segLen(m) ? i : m, run[0]); run.forEach(i => { if (i !== best) skip.add(i); }); runLen.set(best, tot); });
    for (let i = 0; i < subjectRing.length; i++) { if (skip.has(i)) continue; const a = subjectRing[i], b = subjectRing[(i + 1) % subjectRing.length]; const fa = toFt(a), fb = toFt(b); const len = runLen.get(i) ?? Math.hypot(fb.x - fa.x, fb.y - fa.y); if (len < 8) continue;
      const pa = S(a), pb = S(b); const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2; const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
      const nx = -Math.sin(ang), ny = Math.cos(ang); const cq = S(centroid(subjectRing)); const out = ((mx + nx * 10 - cq.x) ** 2 + (my + ny * 10 - cq.y) ** 2) > ((mx - nx * 10 - cq.x) ** 2 + (my - ny * 10 - cq.y) ** 2) ? 1 : -1;
      const t = Math.round(len) + "'", room = Math.hypot(pb.x - pa.x, pb.y - pa.y) * 0.8; let fs = 36;
      g.font = `700 ${fs}px Figtree, system-ui, sans-serif`; const w36 = g.measureText(t).width + 16; if (w36 > room) fs = Math.max(16, Math.floor(36 * room / w36));
      g.font = `700 ${fs}px Figtree, system-ui, sans-serif`; const tw = g.measureText(t).width, bh = fs * 1.3, off = bh / 2 + 6;
      g.save(); g.translate(mx + nx * off * out, my + ny * off * out); let ra = ang; if (ra > Math.PI / 2 || ra < -Math.PI / 2) ra += Math.PI; g.rotate(ra);
      g.beginPath(); rrect(g, -tw / 2 - 10, -bh / 2, tw + 20, bh, bh / 2); g.fillStyle = '#FFFFFF'; g.fill(); g.strokeStyle = '#CFD8D1'; g.lineWidth = 1.5; g.setLineDash([]); g.stroke(); g.fillStyle = '#1E2A22'; g.fillText(t, 0, 1); g.restore(); }
    });
    // Lot size in the middle of the lot: CAD's land square footage when the county gives it, else the drawn shape's own area.
    if (!multi) { const ft = mainRing.map(toFt); const shape = Math.abs(ft.reduce((t, p, i) => { const q = ft[(i + 1) % ft.length]; return t + p.x * q.y - q.x * p.y; }, 0)) / 2;
      const a = parcels && parcels.subject.a; const sqft = multi ? list.reduce((t, x) => t + x.area, 0) : a ? lotSqft(a, mainRing) : Math.round(shape);
      const P = mainRing.map(S), xs = P.map(p => p.x), lotW = Math.max(...xs) - Math.min(...xs); const t1 = sqft.toLocaleString() + ' sq ft';
      let fs = 44; g.font = `700 ${fs}px "Bricolage Grotesque", Figtree, system-ui, sans-serif`; const w = g.measureText(t1).width; if (w > lotW * 0.82) fs = Math.max(18, Math.floor(fs * lotW * 0.82 / w));
      const m = centroid(mainRing), q = S(m); g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#1E2A22';
      g.font = `700 ${fs}px "Bricolage Grotesque", Figtree, system-ui, sans-serif`; g.fillText(t1, q.x, q.y); g.restore(); }
    // north arrow + scale bar
    g.save(); g.translate(W - 90, 90); g.strokeStyle = '#1E2A22'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(0, 34); g.lineTo(0, -34); g.stroke(); g.beginPath(); g.moveTo(0, -40); g.lineTo(-11, -16); g.lineTo(11, -16); g.closePath(); g.fillStyle = '#1E2A22'; g.fill();
    g.font = '700 20px Figtree, system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('N', 0, 60); g.restore();
    const bar = 50 * scale; g.save(); g.translate(60, H - 70); g.fillStyle = '#1E2A22'; g.fillRect(0, 0, bar, 6); g.fillRect(bar, 0, bar, 6); g.fillStyle = '#FFFFFF'; g.fillRect(bar, 1, bar, 4); g.strokeStyle = '#1E2A22'; g.lineWidth = 1; g.strokeRect(0, 0, bar * 2, 6);
    g.font = '600 16px Figtree, system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = '#1E2A22'; g.fillText("0", -4, 12); g.fillText("50'", bar - 10, 12); g.fillText("100'", bar * 2 - 14, 12); g.restore();
    // title block
    const a = parcels && parcels.subject.a; const lines = [addr.split(',')[0], [cad, multi ? list.length + ' parcels, ' + (SUBJ.length > 1 ? SUBJ.length + ' outlines' : 'one outline') : a && a.HCAD_NUM ? 'Acct ' + a.HCAD_NUM : ''].filter(Boolean).join(' · ')];
    if (multi) { lines.push('Tax IDs ' + list.slice(0, 3).map(x => x.id).join(', ') + (list.length > 3 ? ` +${list.length - 3} more` : '')); const tot = list.reduce((t, x) => t + x.area, 0); lines.push((tot / 43560).toFixed(3) + ' ac · ' + tot.toLocaleString() + ' sq ft combined'); }
    else if (a) { const legal = [a.legal_dscr_1, a.legal_dscr_2, a.legal_dscr_3].filter(Boolean).join(' '); if (legal) lines.push(legal); const sf = lotSqft(a, mainRing); lines.push([(sf / 43560).toFixed(3) + ' ac', sf.toLocaleString() + ' sq ft'].join(' · ')); }
    const TF = '700 38px "Bricolage Grotesque", system-ui, sans-serif', LF = '600 23px Figtree, system-ui, sans-serif';
    g.save(); g.textAlign = 'left'; g.textBaseline = 'top'; const bw = Math.min(W - 280, Math.max(420, ...lines.map((l, i) => { g.font = i ? LF : TF; return g.measureText(l).width; })) + 52);
    const bh2 = 44 + 44 + (lines.length - 1) * 33 + 10; g.save(); g.shadowColor = 'rgba(30,42,34,.10)'; g.shadowBlur = 18; g.shadowOffsetY = 4; g.beginPath(); rrect(g, 40, 40, bw, bh2, 12); g.fillStyle = '#FFFFFF'; g.fill(); g.restore();
    g.beginPath(); rrect(g, 40, 40, bw, bh2, 12); g.strokeStyle = '#DDE3DE'; g.lineWidth = 1.5; g.stroke(); g.fillStyle = '#2F7A56'; g.fillRect(40, 52, 4, bh2 - 24);
    lines.forEach((l, i) => { g.font = i ? LF : TF; g.fillStyle = i ? '#3F4C43' : '#1E2A22'; let t = l; while (g.measureText(t).width > bw - 52 && t.length > 8) t = t.slice(0, -2).trimEnd() + '\u2026'; g.fillText(t, 64, 58 + (i ? 52 + (i - 1) * 33 : 0)); });
    g.font = '500 17px Figtree, system-ui, sans-serif'; g.fillStyle = '#7B8A7F'; g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText('Parcel lines: ' + (parcels ? cad + ' public GIS' : 'sized from the parcel description') + ' · north up · not a survey', W - 40, H - 54); g.restore();
    // No lotoutline.com mark: HAR 1.25.1 bars URLs on MLS images, and this sheet goes in the MLS folder.
    const img = await toImage(cv);
    return { img, view, label: 'Plat map' };
  }

  // ---- MLS focus (HAR 1.25.5: "the primary focus of images ... must be of the listed property") ----
  // Every wider sheet gets the lot marked with a red pin and its address, plus an inset card: the close-up imagery cropped
  // around the lot. The inset is drawn clean here; app.html's renderFinal draws the agent's confirmed outline into it
  // (view.inset.map), so the inset always matches the close-up's pins and look.
  function drawSubject(g, C, street, below = 18) { g.save();
    const py = C.y - 46; g.shadowColor = 'rgba(0,0,0,.3)'; g.shadowBlur = 8; g.shadowOffsetY = 2; g.beginPath(); g.arc(C.x, py, 20, Math.PI * 0.85, Math.PI * 0.15); g.lineTo(C.x, C.y - 6); g.closePath(); g.fillStyle = '#D7262E'; g.fill(); g.shadowColor = 'transparent';
    g.lineWidth = 3; g.strokeStyle = '#FFFFFF'; g.stroke(); g.beginPath(); g.arc(C.x, py, 7, 0, Math.PI * 2); g.fillStyle = '#FFFFFF'; g.fill();
    g.font = '700 24px "Bricolage Grotesque", Figtree, system-ui, sans-serif'; const aw = g.measureText(street).width + 36, ab = { x: Math.max(12, Math.min(W - 12 - aw, C.x - aw / 2)), y: C.y + below, w: aw, h: 42 };
    g.shadowColor = 'rgba(0,0,0,.25)'; g.shadowBlur = 12; g.shadowOffsetY = 3; g.beginPath(); g.roundRect(ab.x, ab.y, aw, 42, 10); g.fillStyle = '#D7262E'; g.fill(); g.shadowColor = 'transparent';
    g.fillStyle = '#FFFFFF'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(street, ab.x + aw / 2, ab.y + 22); g.restore(); return [ab, { x: C.x - 24, y: py - 24, w: 48, h: 70 }]; }
  // Crop of the close-up around the lot, 3:2, kept clear of the close-up's attribution strip.
  function insetSource(close, ring) { const P = projectRing(ring, close.view), xs = P.map(p => p.x), ys = P.map(p => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2; let w = Math.max(Math.max(...xs) - Math.min(...xs), (Math.max(...ys) - Math.min(...ys)) * 1.5) * 1.7, h = w / 1.5;
    w = Math.min(w, W); h = Math.min(h, H - 40); w = Math.min(w, h * 1.5); h = w / 1.5;
    return { img: close.img, view: close.view, crop: { x: Math.max(0, Math.min(W - w, cx - w / 2)), y: Math.max(0, Math.min(H - 40 - h, cy - h / 2)), w, h } }; }
  function drawInset(g, src, x, y, w, caption) { const h = w / 1.5, c = src.crop; shadowBox(g, x - 8, y - 8, w + 16, h + 52, 14);
    g.drawImage(src.img, c.x, c.y, c.w, c.h, x, y, w, h); g.save(); g.font = '700 20px Figtree, system-ui, sans-serif'; g.fillStyle = '#1F242E'; g.textBaseline = 'middle'; g.fillText(caption, x + 4, y + h + 23); g.restore();
    const k = w / c.w, v = src.view; return { rect: { x, y, w, h }, map: p => { const q = px(p.lng, p.lat, v.z); return { x: x + ((q.x - v.left) * v.s - c.x) * k, y: y + ((q.y - v.top) * v.s - c.y) * k }; } }; }
  // One lot size for every sheet: the county's land square feet, else its stated acres, else the drawn shape. Acres are always derived from it.
  const lotSqft = (a, ring) => Math.round((a && +a.land_sqft) || (a && +(a.StatedArea || a.ACRES || a.Acreage) * 43560) || ringArea(ring));
  const lotCaption = (ring, a) => { const sf = lotSqft(a, ring); return 'The lot · ' + (sf / 43560).toFixed(3) + ' ac · ' + sf.toLocaleString() + ' sq ft'; };
  // Decorator for a wider sheet: pin + address on the lot, inset bottom left. Records the inset on the holder for renderFinal.
  const focus = (ring, street, src, caption, holder, iw = 420) => (g, v) => { const P = projectRing(ring, v), C = { x: P.reduce((t, p) => t + p.x, 0) / P.length, y: P.reduce((t, p) => t + p.y, 0) / P.length };
    const half = (Math.max(...P.map(p => p.y)) - Math.min(...P.map(p => p.y))) / 2; drawSubject(g, { x: C.x, y: C.y - half }, street, half * 2 + 22);
    if (src) holder.inset = drawInset(g, src, 32, H - 36 - 24 - iw / 1.5 - 44, iw, caption); };

  // ---- block plat map: the subject's whole block from the county lot lines, subject in green (decision 10/14/2026: in every package) ----
  // The block is found from the lot lines themselves: lots within 3 ft of each other, flood-filled from the subject, so a
  // block split across two subdivisions or plats still reads as one (3710 Maroneal: Braes Heights Sec 1 + Sec 2 R/P).
  // Guards: a big unaddressed parcel (a reserve, a right-of-way strip) can't join the block, and a run-away fill (more than
  // 90 lots or wider than 2,600 ft) falls back to a plain ~5x frame around the lot with no block line.
  const segPt = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
    const q = { x: a.x + t * dx, y: a.y + t * dy }; return { d: Math.hypot(p.x - q.x, p.y - q.y), q }; };
  // closest pair of points between two rings (in feet): [distance, point on A, point on B]
  function ringGap(A, B) { let best = [Infinity, null, null];
    const one = (P, Q, flip) => { for (const p of P) for (let i = 0; i < Q.length; i++) { const r = segPt(p, Q[i], Q[(i + 1) % Q.length]); if (r.d < best[0]) best = flip ? [r.d, r.q, p] : [r.d, p, r.q]; } };
    one(A, B, false); one(B, A, true); return best; }
  async function blockPlatMap(key, cad, mainRing, subjA, addr, list) {
    const c0 = areaCenter(mainRing), f = ftPerDeg(c0.lat), toFt = p => ({ x: (p.lng - c0.lng) * f.lng, y: -(p.lat - c0.lat) * f.lat });
    const ids = new Set((list && list.length ? list.map(x => x.id) : [subjA && subjA.HCAD_NUM]).filter(v => v != null).map(String));
    let feats = [];
    for (const win of [800, 1500]) {
      let r = null; for (let t = 0; t < 2 && !r; t++) { if (t) await new Promise(ok => setTimeout(ok, 1500)); try { r = await runCounty(key, c0, addr, win); } catch (e) { console.warn('block parcels', e); } }   // one retry: the City of Houston server drops the odd request
      if (!r) return null; feats = [r.subject, ...r.neighbors].map(x => ({ a: x.a, ring: dedupe(x.ring), ft: dedupe(x.ring).map(toFt) }));
      feats.forEach(x => { const xs = x.ft.map(p => p.x), ys = x.ft.map(p => p.y); x.bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        x.area = Math.abs(x.ft.reduce((t, p, i) => { const q = x.ft[(i + 1) % x.ft.length]; return t + p.x * q.y - q.x * p.y; }, 0)) / 2; });
      const inside = (R, p) => { let c = false; for (let i = 0, k = R.length - 1; i < R.length; k = i++) { const A = R[i], B = R[k]; if ((A.y > p.y) !== (B.y > p.y) && p.x < (B.x - A.x) * (p.y - A.y) / (B.y - A.y) + A.x) c = !c; } return c; };
      let seeds = feats.filter(x => ids.has(String(x.a.HCAD_NUM))); if (!seeds.length) seeds = feats.filter(x => inside(x.ft, { x: 0, y: 0 })).slice(0, 1);
      if (!seeds.length) return null;
      // When the legal description names a block, the fill only walks lots in that same block number (any section or plat),
      // so a landscape reserve or a lot across an alley can't leak it into the next block. No block number: lot lines alone.
      const blkOf = a => { const m = [a.legal_dscr_1, a.legal_dscr_2, a.LEGAL, a.legal_desc].filter(Boolean).join(' ').match(/\bBL(?:OC)?K\.?\s*([A-Z0-9-]+)/i); return m ? m[1].toUpperCase().replace(/^0+(?=\d)/, '') : null; };
      const want = blkOf(seeds[0].a);
      const subjArea = Math.max(...seeds.map(x => x.area)), ok = x => !(x.area > subjArea * 6 && !String(x.a.site_str_num || '').trim()) && (!want || blkOf(x.a) === want);
      const blk = new Set(seeds), fr = seeds.slice();
      while (fr.length && blk.size <= 90) { const a = fr.pop();
        for (const b of feats) { if (blk.has(b) || !ok(b) || b.bb[0] > a.bb[2] + 3 || b.bb[2] < a.bb[0] - 3 || b.bb[1] > a.bb[3] + 3 || b.bb[3] < a.bb[1] - 3) continue;
          if (ringGap(a.ft, b.ft)[0] < 3) { blk.add(b); fr.push(b); } } }
      const B = [...blk], bx = [Math.min(...B.map(x => x.bb[0])), Math.min(...B.map(x => x.bb[1])), Math.max(...B.map(x => x.bb[2])), Math.max(...B.map(x => x.bb[3]))];
      const runaway = blk.size > 90 || bx[2] - bx[0] > 2600 || bx[3] - bx[1] > 2600;
      const touches = bx[0] < -win + 40 || bx[1] < -win + 40 || bx[2] > win - 40 || bx[3] > win - 40;
      if (!runaway && touches && win < 1500) continue;                 // the block runs past the window: look wider once
      const lone = blk.size <= seeds.length;   // the lot is its own block (a reserve, an acreage tract): show its surroundings instead
      feats.blk = runaway || lone ? new Set(seeds) : blk; feats.box = runaway || lone ? null : bx; feats.seeds = seeds; break;
    }
    const blk = feats.blk, seeds = feats.seeds; if (!blk) return null;
    // frame: the block (or ~5x the lot when there's no clean block), lower half of the sheet clear of the title card
    let bx = feats.box; if (!bx) { const s = seeds.flatMap(x => x.ft), ext = Math.max(120, ...s.map(p => Math.max(Math.abs(p.x), Math.abs(p.y)))) * 5; bx = [-ext, -ext * 0.66, ext, ext * 0.66]; }
    const scale = Math.min(W * 0.70 / (bx[2] - bx[0]), H * 0.52 / (bx[3] - bx[1]));   // px per ft
    const mx = (bx[0] + bx[2]) / 2, my = (bx[1] + bx[3]) / 2 - 18 / scale;
    const P = q => ({ x: W / 2 + (q.x - mx) * scale, y: H / 2 + (q.y - my) * scale }), S = p => P(toFt(p));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    g.fillStyle = '#FBFAF6'; g.fillRect(0, 0, W, H);
    const path = (ctx, R) => { ctx.beginPath(); R.forEach((q, i) => { const s = P(q); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.closePath(); };
    const onSheet = x => { const a = P({ x: x.bb[0], y: x.bb[1] }), b = P({ x: x.bb[2], y: x.bb[3] }); return b.x > 0 && a.x < W && b.y > 0 && a.y < H; };
    const vis = feats.filter(onSheet), clearOf = (q, pad = 0) => q.x > 24 && q.x < W - 24 && q.y > 24 && q.y < H - 24 && !(q.y < 200 + pad && q.x < 640) && !(q.y > H - 110 && (q.x < 420 || q.x > W - 520));
    // a house number only where it fits inside its lot at this scale (a long canal row at block scale would be a smear of digits)
    const fits = (x, t) => g.measureText(String(t)).width < Math.sqrt(x.area) * scale * 0.8;
    const inAny = q => vis.some(x => q.x > x.bb[0] && q.x < x.bb[2] && q.y > x.bb[1] && q.y < x.bb[3] && (() => { let c = false; const R = x.ft; for (let i = 0, k = R.length - 1; i < R.length; k = i++) { const A = R[i], B = R[k]; if ((A.y > q.y) !== (B.y > q.y) && q.x < (B.x - A.x) * (q.y - A.y) / (B.y - A.y) + A.x) c = !c; } return c; })());
    g.lineJoin = 'round'; g.textAlign = 'center'; g.textBaseline = 'middle';
    // neighbors: faint lines and house numbers
    g.strokeStyle = '#DFE3DD'; g.lineWidth = 1.5; vis.filter(x => !blk.has(x)).forEach(x => { path(g, x.ft); g.stroke(); });
    g.font = '500 15px Figtree, system-ui, sans-serif'; g.fillStyle = '#B2BAB3';
    vis.filter(x => !blk.has(x)).forEach(x => { const q = S(areaCenter(x.ring)); if (x.a.site_str_num && clearOf(q) && fits(x, x.a.site_str_num)) g.fillText(x.a.site_str_num, q.x, q.y); });
    if (feats.box) {
      // block: union of its lots in white with a dark rim. Hairline gaps between CAD lots are closed (dilate, then erode by the
      // same amount) so the rim follows the real block edge instead of standing off it.
      const r = Math.min(8, Math.max(2, 4 * scale)), mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); x.lineJoin = 'round'; return [c, x]; };
      const ring16 = (dst, src, rad) => { for (const k of [1, 0.5]) for (let a = 0; a < 16; a++) dst.drawImage(src, Math.cos(a * Math.PI / 8) * rad * k, Math.sin(a * Math.PI / 8) * rad * k); };
      const [m, mg] = mk(); mg.fillStyle = mg.strokeStyle = '#000'; mg.lineWidth = r * 2; blk.forEach(x => { path(mg, x.ft); mg.fill(); mg.stroke(); });
      const [inv, ig] = mk(); ig.fillStyle = '#000'; ig.fillRect(-20, -20, W + 40, H + 40); ig.globalCompositeOperation = 'destination-out'; ig.drawImage(m, 0, 0);
      const [inv2, i2] = mk(); i2.drawImage(inv, 0, 0); ring16(i2, inv, r);
      const [cl, cg] = mk(); cg.fillStyle = '#000'; cg.fillRect(0, 0, W, H); cg.globalCompositeOperation = 'destination-out'; cg.drawImage(inv2, 0, 0);
      const tint = col => { const [t, tg] = mk(); tg.drawImage(cl, 0, 0); tg.globalCompositeOperation = 'source-in'; tg.fillStyle = col; tg.fillRect(0, 0, W, H); return t; };
      const rim = tint('#4C5A50'), fill = tint('#FFFFFF');
      ring16(g, rim, 2.5);
      g.drawImage(fill, 0, 0);
    } else { blk.forEach(x => { path(g, x.ft); g.fillStyle = '#FFFFFF'; g.fill(); }); }
    g.strokeStyle = '#B9C2BB'; g.lineWidth = 2; feats.filter(x => blk.has(x) && !seeds.includes(x)).forEach(x => { path(g, x.ft); g.stroke(); });
    g.font = '600 18px Figtree, system-ui, sans-serif'; g.fillStyle = '#6E7A72';
    feats.filter(x => blk.has(x) && !seeds.includes(x)).forEach(x => { const q = S(areaCenter(x.ring)); if (x.a.site_str_num && clearOf(q) && fits(x, x.a.site_str_num)) g.fillText(x.a.site_str_num, q.x, q.y); });
    // subject: every parcel on the order, pale green, deep green edge, house number in the middle
    const subj = seeds.length ? seeds.map(x => x.ft) : [mainRing.map(toFt)];
    subj.forEach(R => { path(g, R); g.fillStyle = '#CFE7D6'; g.fill(); });
    g.strokeStyle = '#1F5F45'; g.lineWidth = 4.5; subj.forEach(R => { path(g, R); g.stroke(); });
    { const sa = ((seeds.find(x => ids.has(String(x.a.HCAD_NUM))) || {}).a) || subjA || {}; const num = sa.site_str_num || (addr.match(/^\s*(\d+)/) || [])[1]; if (num) { const q = S(areaCenter(mainRing)), R = mainRing.map(S), lotW = Math.max(...R.map(p => p.x)) - Math.min(...R.map(p => p.x));
      let fs = 24; g.font = `700 ${fs}px Figtree, system-ui, sans-serif`; const w = g.measureText(num).width; if (w > lotW * 0.85) fs = Math.max(13, Math.floor(fs * lotW * 0.85 / w));
      g.font = `700 ${fs}px Figtree, system-ui, sans-serif`; if (g.measureText(num).width <= lotW * 0.9) { g.fillStyle = '#1F5F45'; g.fillText(num, q.x, q.y); } } }
    // a lot that's only a few pixels across at block scale gets a green ring around it so the eye finds it
    { const R = subj.flat().map(P), xs = R.map(p => p.x), ys = R.map(p => p.y), span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      if (span < 60) { const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2, r = span / 2 + 22;
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.strokeStyle = 'rgba(31,95,69,.9)'; g.lineWidth = 3.5; g.stroke(); } }
    // street names: in the gap between the two rows of lots that face each street (odd one side, even the other)
    { const by = new Map(); vis.forEach(x => { const n = String(x.a.site_str_name || '').trim(), k = parseInt(x.a.site_str_num, 10); if (!n || !k) return; if (!by.has(n)) by.set(n, []); by.get(n).push({ k, x }); });
      const ctr = { x: mx, y: my + 18 / scale }, placed = [];
      by.forEach((L, name) => { const ev = L.filter(o => o.k % 2 === 0).map(o => o.x), od = L.filter(o => o.k % 2 === 1).map(o => o.x); if (ev.length < 2 || od.length < 2) return;
        let best = null; ev.forEach(a => { const cA = { x: (a.bb[0] + a.bb[2]) / 2, y: (a.bb[1] + a.bb[3]) / 2 };
          const b = od.reduce((m, o) => { const d = Math.hypot((o.bb[0] + o.bb[2]) / 2 - cA.x, (o.bb[1] + o.bb[3]) / 2 - cA.y); return !m || d < m[0] ? [d, o] : m; }, null)[1];
          const [d, p1, p2] = ringGap(a.ft, b.ft); if (d < 20 || d > 130) return; const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }; const q = P(mid); if (inAny(mid)) return;
          if (!clearOf(q, 40)) return; const dc = Math.hypot(mid.x - ctr.x, mid.y - ctr.y); if (!best || dc < best.dc) best = { dc, mid, a }; });
        if (!best) return;
        const near = ev.map(o => ({ o, d: Math.hypot((o.bb[0] + o.bb[2]) / 2 - (best.a.bb[0] + best.a.bb[2]) / 2, (o.bb[1] + o.bb[3]) / 2 - (best.a.bb[1] + best.a.bb[3]) / 2) })).sort((u, v) => u.d - v.d).slice(0, 4).map(u => ({ x: (u.o.bb[0] + u.o.bb[2]) / 2, y: (u.o.bb[1] + u.o.bb[3]) / 2 }));
        const ax = near.reduce((t, p) => t + p.x, 0) / near.length, ay = near.reduce((t, p) => t + p.y, 0) / near.length;
        const sxx = near.reduce((t, p) => t + (p.x - ax) ** 2, 0), syy = near.reduce((t, p) => t + (p.y - ay) ** 2, 0), sxy = near.reduce((t, p) => t + (p.x - ax) * (p.y - ay), 0);
        let ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
        const q = P(best.mid); if (placed.some(p => Math.hypot(p.x - q.x, p.y - q.y) < 140)) return; placed.push(q);
        const t = name.toUpperCase().replace(/\s+/g, ' ').split('').join('\u2009');
        g.font = '600 19px Figtree, system-ui, sans-serif'; const half = g.measureText(t).width / 2;
        const unP = (x, y) => ({ x: (x - W / 2) / scale + mx, y: (y - H / 2) / scale + my });   // the whole name has to sit in the street, not just its middle
        if ([-1, -0.5, 0.5, 1].some(k => { const sx = q.x + Math.cos(ang) * half * k, sy = q.y + Math.sin(ang) * half * k; return inAny(unP(sx, sy)) || !clearOf({ x: sx, y: sy }); })) { placed.pop(); return; }
        g.save(); g.translate(q.x, q.y); g.rotate(ang); g.font = '600 19px Figtree, system-ui, sans-serif'; g.fillStyle = '#6B786F'; g.fillText(t, 0, 0); g.restore(); }); }
    // north arrow + scale bar (same marks as the plat map)
    g.save(); g.translate(W - 90, 90); g.strokeStyle = '#1E2A22'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(0, 34); g.lineTo(0, -34); g.stroke(); g.beginPath(); g.moveTo(0, -40); g.lineTo(-11, -16); g.lineTo(11, -16); g.closePath(); g.fillStyle = '#1E2A22'; g.fill();
    g.font = '700 20px Figtree, system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('N', 0, 60); g.restore();
    const step = [25, 50, 100, 200, 250, 500, 1000].find(v => v * scale >= 70) || 1000, bar = step * scale;
    g.save(); g.translate(W - 80 - bar * 2, H - 86); g.fillStyle = '#1E2A22'; g.fillRect(0, 0, bar * 2, 6); g.fillStyle = '#FFFFFF'; g.fillRect(bar, 1, bar - 1, 4); g.strokeStyle = '#1E2A22'; g.lineWidth = 1; g.strokeRect(0, 0, bar * 2, 6);
    g.font = '600 16px Figtree, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top'; g.fillStyle = '#1E2A22'; g.fillText('0', 0, 12); g.fillText(step + "'", bar, 12); g.fillText(step * 2 + "'", bar * 2, 12); g.restore();
    // legend
    g.save(); g.translate(48, H - 92); g.beginPath(); rrect(g, 0, 0, 30, 20, 4); g.fillStyle = '#CFE7D6'; g.fill(); g.strokeStyle = '#1F5F45'; g.lineWidth = 3; g.stroke();
    g.font = '600 17px Figtree, system-ui, sans-serif'; g.fillStyle = '#1E2A22'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(list && list.length > 1 ? 'The lots' : 'The lot', 42, 10);
    if (feats.box) { g.strokeStyle = '#4C5A50'; g.lineWidth = 4; g.beginPath(); g.moveTo(150, 10); g.lineTo(184, 10); g.stroke(); g.fillText('The block', 196, 10); } g.restore();
    // title card, same frame as the plat map
    const a = ((seeds.find(x => ids.has(String(x.a.HCAD_NUM))) || {}).a) || subjA || {}, legal = [a.legal_dscr_1, a.legal_dscr_2].filter(Boolean).join(' '), blkNo = (legal.match(/\bBLK\.?\s*([\w-]+)|\bBLOCK\s+([\w-]+)/i) || []).slice(1).find(Boolean);
    const lines = [addr.split(',')[0], (blkNo ? 'Block ' + blkNo : 'The block') + (feats.box ? ` · ${blk.size} lots` : ''), [legal, a.HCAD_NUM ? 'Acct ' + a.HCAD_NUM : ''].filter(Boolean).join(' · ')].filter(Boolean);
    g.save(); g.textAlign = 'left'; g.textBaseline = 'top'; const fnt = i => i ? '500 17px Figtree, system-ui, sans-serif' : '700 26px "Bricolage Grotesque", system-ui, sans-serif';
    const bw = Math.min(W - 700, Math.max(380, ...lines.map((l, i) => { g.font = fnt(i); return g.measureText(l).width; })) + 48), bh2 = 36 + lines.length * 26 + 10;
    g.save(); g.shadowColor = 'rgba(30,42,34,.10)'; g.shadowBlur = 18; g.shadowOffsetY = 4; g.beginPath(); rrect(g, 40, 40, bw, bh2, 12); g.fillStyle = '#FFFFFF'; g.fill(); g.restore();
    g.beginPath(); rrect(g, 40, 40, bw, bh2, 12); g.strokeStyle = '#DDE3DE'; g.lineWidth = 1.5; g.stroke(); g.fillStyle = '#2F7A56'; g.fillRect(40, 52, 4, bh2 - 24);
    lines.forEach((l, i) => { g.font = fnt(i); g.fillStyle = i ? '#4C5A50' : '#1E2A22'; g.fillText(l, 64, 56 + (i ? 14 : 0) + i * 26, bw - 48); });
    g.font = '500 14px Figtree, system-ui, sans-serif'; g.fillStyle = '#7B8A7F'; g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText('Lot lines: ' + cad + ' public GIS · north up · not a survey', W - 40, H - 30); g.restore();
    // No lotoutline.com mark (HAR 1.25.1).
    const img = await toImage(cv);
    return { img, view: { kind: 'map', S }, label: 'Block plat map' };
  }
  // Both plat sheets for an order that brought its own photos (the kit builds them itself). Every package gets them.
  // Built from the parcel the agent confirmed on the Address step (order.parcelList); with none, only from a county match
  // tied to the address, never a nearest-parcel guess.
  async function platMaps(order) {
    const list = order.parcelList && order.parcelList.length ? order.parcelList : null; let parcels = null, cad = null, key = null;
    if (list && list[0].key) { key = list[0].key; cad = list[0].cad; const ring0 = list[0].ring, c = areaCenter(ring0);
      const r = await runCounty(key, c, order.addr, 220); if (r) { const all = [r.subject, ...r.neighbors]; const sub = all.find(x => String(x.a.HCAD_NUM) === String(list[0].id));
        if (sub) parcels = { subject: sub, neighbors: all.filter(x => x !== sub) }; } }
    if (!parcels) { const g = order.geo && order.geo.lat != null ? order.geo : await geocode(order.addr); order.geo = g;
      const r = await lookupParcels(g, order.addr); if (!r.parcels || !r.matched) return []; parcels = r.parcels; cad = r.cad; key = r.key; }
    const ring = order.geoRing && order.geoRing.length >= 3 ? order.geoRing : straighten(dedupe(parcels.subject.ring));
    const base = order.addr.split(',')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'), out = [];
    try { const pm = await parcelMap(parcels, ring, order.addr, cad, list, order.groups); out.push({ ...pm, name: `${base}_plat-map.jpg` }); } catch (e) { console.warn('plat map', e); }
    try { const bm = await blockPlatMap(key, cad, ring, parcels.subject.a, order.addr, list); if (bm) out.push({ ...bm, name: `${base}_block-plat-map.jpg` }); } catch (e) { console.warn('block plat map', e); }
    return out;
  }

  // ---- What's nearby: the commercial map ----
  // Places come from Esri's World Geocoding category search (no key, CORS-open; shown on an Esri basemap, never stored).
  // Shopping centers become callout boxes listing what's in them; schools, parks and stand-alone groceries are pins.
  // MLS-safe by design: names only, no logos, no phone numbers or links (HAR 1.25.1), one-mile frame with the lot in the
  // middle (1.25.5). Brand logos stay off until a licensed logo source is signed (see project doc retail-map-handoff.md).
  const GEOCODE = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates';
  const NEAR_COLOR = { Grocery: '#1E9E5A', Dining: '#E8701A', Coffee: '#8A5A3B', Shopping: '#D6337F', Banking: '#2563EB', Fitness: '#7C3AED', Medical: '#DC2F3C', School: '#E0A100', Park: '#0F9488' };
  const NEAR_Q = [['Shopping Center', 'Center'], ['Grocery', 'Grocery'], ['Restaurant', 'Dining'], ['Coffee Shop', 'Coffee'], ['Pharmacy', 'Medical'], ['Hospital', 'Medical'],
                  ['Fitness Center', 'Fitness'], ['Bank', 'Banking'], ['Department Store', 'Shopping'], ['School', 'School'], ['Park', 'Park']];
  const NOT_A_SCHOOL = /weekday|mother'?s day out|\bmdo\b|athletic|field|stadium|natatorium|gym\b|kumon|testmaster|tutor|mathnasium|sylvan|huntington|learning (center|ctr)|driving|beauty|barber|cosmetolog|dance|music|martial|karate|swim|nurse|legal|academics|daycare|day care|child ?care|preschool|pre-school|kids|college prep|test prep|language|cooking|art studio|gymnastics/i;
  const IS_SCHOOL = /\b(elementary|elem|middle|high|intermediate|junior|school|academy|prep)\b/i;
  const NOT_A_PARK = /ymca|club|parking|garage|rv park|business park|office park|industrial|apartment|mobile home|trailer|ballpark lot/i;
  const normName = s => s.toLowerCase().replace(/&/g, ' and ').replace(/['’.]/g, '').replace(/\b(the|pharmacy|food markets?|supermarket|eatery|restaurant|shopping center|inc|llc)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const NOT_A_PLACE = /corporate|coporate|headquarters|\bhq\b|media|marketing|consult|office|storage|warehouse|distribution|wholesale only/i;
  // Names as people say them: drop a trailing location tag ("Market Street-The Woodlands", "Hunan's - Bellaire").
  const shortName = n => { let t = n.replace(/\s+[-\u2013|]\s+.*$/, '').replace(/-(?=[A-Z][a-z]).*$/, '').trim(); if (t.length < 3) t = n; if (t.length > 30) t = t.slice(0, 30).replace(/\s+\S*$/, '').replace(/\s+(and|&|of|the|at|de|la|no)$/i, '').replace(/\s+(and|&|of|the|at|de|la|no)$/i, ''); return t.replace(/\s+(inc|llc|no \d+)$/i, ''); };
  async function placesNear(c, radius = 1) {
    const f = ftPerDeg(c.lat), dLat = (radius + 0.1) * 5280 / f.lat, dLng = (radius + 0.1) * 5280 / f.lng;
    const ext = [c.lng - dLng, c.lat - dLat, c.lng + dLng, c.lat + dLat].join(',');
    const one = async ([q, cat]) => { try {
      const r = await fetch(`${GEOCODE}?f=json&category=${encodeURIComponent(q)}&location=${c.lng},${c.lat}&searchExtent=${ext}&maxLocations=50&outFields=PlaceName,Type`);
      if (!r.ok) return []; const j = await r.json();
      return (j.candidates || []).map(x => ({ name: shortName(((x.attributes && x.attributes.PlaceName) || x.address || '').trim()), q, cat, lng: x.location.x, lat: x.location.y }));
    } catch (e) { console.warn('places', q, e); return []; } };
    const all = (await Promise.all(NEAR_Q.map(one))).flat();
    all.forEach(p => { p.mi = Math.hypot((p.lng - c.lng) * f.lng, (p.lat - c.lat) * f.lat) / 5280; p.key = normName(p.name); });
    const keep = all.filter(p => p.name && p.key && p.mi <= radius + 0.05 && !NOT_A_PLACE.test(p.name)
      && (p.cat !== 'School' || (IS_SCHOOL.test(p.name) && !NOT_A_SCHOOL.test(p.name)))
      && (p.cat !== 'Park' || !NOT_A_PARK.test(p.name))
      && (p.cat !== 'Banking' || !/commercial|office|mortgage|lending|loan|wealth|trust co|financial services|atm/i.test(p.name))
      && (p.q !== 'Pharmacy' || /pharm|cvs|walgreens|\brx\b|drug|h-e-b|heb|kroger|walmart|randall|costco/i.test(p.name)));
    // one entry per name and category, the nearest (six Starbucks become one)
    const best = new Map(); keep.sort((a, b) => a.mi - b.mi).forEach(p => { const k = p.cat + '|' + p.key; if (!best.has(k)) best.set(k, p); });
    return [...best.values()];
  }
  // Group the places: shopping centers that sit within ~150 m of each other are one complex; each store, restaurant, coffee
  // shop, gym, bank or pharmacy within ~280 m of a center belongs to it. Returns up to 4 centers (2+ members) and the pins.
  function groupPlaces(places, c) {
    const f = ftPerDeg(c.lat), mBetween = (a, b) => Math.hypot((a.lng - b.lng) * f.lng, (a.lat - b.lat) * f.lat) * 0.3048;
    const centers = []; places.filter(p => p.cat === 'Center').forEach(p => { const toks = k => k.replace(/\btowne\b/g, 'town').replace(/\bcentre\b/g, 'center').split(' ').sort().join(' ');   // Towne Center Lakeside = Lakeside Town Center
      const m = centers.find(x => mBetween(x, p) < 150 || x.key === p.key || toks(x.key) === toks(p.key) || x.key.startsWith(p.key + ' ') || p.key.startsWith(x.key + ' '));
      if (m) { if (p.name.length < m.name.length) Object.assign(m, { name: p.name, key: p.key }); } else centers.push({ ...p, members: [] }); });
    const biz = places.filter(p => ['Grocery', 'Dining', 'Coffee', 'Fitness', 'Banking', 'Shopping'].includes(p.cat) || (p.cat === 'Medical' && p.q === 'Pharmacy'));
    biz.forEach(p => { let bestC = null, d = 280; centers.forEach(x => { const m = mBetween(x, p); if (m < d) { d = m; bestC = x; } }); if (bestC) { bestC.members.push(p); p.inCenter = bestC; } });
    const brand = p => { const t = p.key.split(' '); return (t[0] || '').length >= 3 ? t[0] : t.slice(0, 2).join(' '); };   // P.F. Chang's x2 -> one
    const PRI = { Grocery: 0, Medical: 1, Coffee: 2, Dining: 3, Shopping: 4, Fitness: 5, Banking: 6 }, CAP = { Grocery: 2, Medical: 1, Coffee: 1, Dining: 3, Shopping: 2, Fitness: 1, Banking: 1 };
    const shown = centers.filter(x => new Set(x.members.map(brand)).size >= 2).sort((a, b) => b.members.length - a.members.length || a.mi - b.mi).slice(0, 4);
    shown.forEach(x => { const used = {}, items = [], brands = new Set(), ok = p => !brands.has(brand(p)) && !/photo center|\batm\b|gas station|fuel/i.test(p.name);
      x.members.slice().sort((a, b) => PRI[a.cat] - PRI[b.cat] || a.mi - b.mi).forEach(p => { if (items.length < 4 && (used[p.cat] || 0) < CAP[p.cat] && ok(p)) { used[p.cat] = (used[p.cat] || 0) + 1; items.push(p); brands.add(brand(p)); } });
      for (const p of x.members) { if (items.length >= 4) break; if (!items.includes(p) && ok(p) && (p.cat !== 'Banking' || (used.Banking || 0) < 1)) { used[p.cat] = (used[p.cat] || 0) + 1; items.push(p); brands.add(brand(p)); } } x.items = items; });
    const inShown = p => p.inCenter && shown.includes(p.inCenter);
    const pick = (cat, n, test = () => true) => places.filter(p => p.cat === cat && test(p) && !inShown(p)).sort((a, b) => a.mi - b.mi).slice(0, n);
    const pins = [...pick('Grocery', 2), ...pick('School', 3), ...pick('Park', 2), ...pick('Medical', 1, p => p.q === 'Hospital' && !/emergency|\ber\b|urgent/i.test(p.name))];
    return { centers: shown, pins };
  }
  const shadowBox = (g, x, y, w, h, r, fill = '#FFFFFF', line = '#DAD6CE') => { g.save(); g.shadowColor = 'rgba(30,42,34,.18)'; g.shadowBlur = 16; g.shadowOffsetY = 4;
    g.beginPath(); g.roundRect(x, y, w, h, r); g.fillStyle = fill; g.fill(); g.restore(); g.beginPath(); g.roundRect(x, y, w, h, r); g.strokeStyle = line; g.lineWidth = 1.5; g.stroke(); };
  const fmtMi = m => m < 0.1 ? 'under 0.1 mi' : m.toFixed(1) + ' mi';
  async function nearbyMap(center, ring, addr, insetSrc, caption) { const holder = {};
    // One mile first; if that's mostly homes (no shopping center), three miles; if still bare, no sheet (an empty map looks broken).
    let RAD = 1, places = await placesNear(center, 1), grp = groupPlaces(places, center);
    if (!grp.centers.length) { const wide = await placesNear(center, 3), g3 = groupPlaces(wide, center); if (g3.centers.length || g3.pins.length > grp.pins.length + 1) { RAD = 3; places = wide; grp = g3; } }
    const { centers, pins } = grp; if (!centers.length && pins.length < 3) return null;
    const R1 = H * 0.40; let z = 16, s = R1 / (RAD * 1609.34 / metersPerPx(center.lat, z)); while (s < 0.95 && z > 11) { z--; s *= 2; }
    const street = addr.split(',')[0].trim();
    const r = await satellite(center, z, s, "What's nearby", 'canvas', (g, v) => {
      const P = p => { const q = px(p.lng, p.lat, v.z); return { x: (q.x - v.left) * v.s, y: (q.y - v.top) * v.s }; };
      const C = P(center), mile = RAD * 1609.34 / metersPerPx(center.lat, v.z) * v.s, busy = [];
      const hits = (b) => busy.some(o => b.x < o.x + o.w + 8 && b.x + b.w + 8 > o.x && b.y < o.y + o.h + 6 && b.y + b.h + 6 > o.y) || b.x < 12 || b.y < 12 || b.x + b.w > W - 12 || b.y + b.h > H - 46;
      g.save(); g.fillStyle = 'rgba(251,250,246,.28)'; g.fillRect(0, 0, W, H); g.restore();      // soften the basemap so the callouts lead
      // half-mile and one-mile rings
      g.save(); g.setLineDash([16, 11]); g.lineWidth = 2.5; g.strokeStyle = 'rgba(43,49,64,.55)'; [1, 0.5].forEach(m => { g.beginPath(); g.arc(C.x, C.y, mile * m, 0, Math.PI * 2); g.stroke(); }); g.restore();
      // title card
      g.save(); g.textBaseline = 'alphabetic'; g.font = '700 34px "Bricolage Grotesque", Figtree, system-ui, sans-serif'; const t1w = g.measureText(street).width; g.font = '500 20px Figtree, system-ui, sans-serif';
      const sub = "What's nearby · within " + (RAD === 1 ? '1 mile' : RAD + ' miles'), t2w = g.measureText(sub).width, tw = Math.max(t1w, t2w) + 56; shadowBox(g, 24, 24, tw, 96, 14); busy.push({ x: 24, y: 24, w: tw, h: 96 });
      g.fillStyle = '#2F7A56'; g.fillRect(24, 38, 5, 68); g.fillStyle = '#1E2A22'; g.font = '700 34px "Bricolage Grotesque", Figtree, system-ui, sans-serif'; g.fillText(street, 46, 68);
      g.fillStyle = '#4C5A50'; g.font = '500 20px Figtree, system-ui, sans-serif'; g.fillText(sub, 46, 100); g.restore();
      // north arrow, top right
      g.save(); g.translate(W - 62, 62); g.beginPath(); g.arc(0, 0, 34, 0, Math.PI * 2); g.fillStyle = '#FFFFFF'; g.fill(); g.strokeStyle = '#DAD6CE'; g.lineWidth = 1.5; g.stroke();
      g.beginPath(); g.moveTo(0, -24); g.lineTo(10, 8); g.lineTo(0, 1); g.lineTo(-10, 8); g.closePath(); g.fillStyle = '#1E2A22'; g.fill(); g.font = '700 14px Figtree, system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('N', 0, 24); g.restore();
      busy.push({ x: W - 100, y: 24, w: 76, h: 76 });
      // legend + disclaimer, bottom left: drawn last, from only the categories that made it onto the sheet. Room is reserved now.
      const LBL = { Medical: 'Medical', School: 'Schools', Park: 'Parks', Banking: 'Banks' }, drawnCats = new Set();
      const disc = 'Straight-line distances, approximate. Names show nearby places, not endorsements. Schools are locations, not zones.';
      const lh = 78, lx = 24, ly = H - 36 - 14 - lh; g.save(); g.font = '500 14px Figtree, system-ui, sans-serif'; const dw = g.measureText(disc).width; g.restore();
      busy.push({ x: lx, y: ly, w: Math.max(dw + 40, 1000), h: lh });
      const drawLegend = () => { const used = Object.keys(NEAR_COLOR).filter(k => drawnCats.has(k)); g.save(); g.font = '500 18px Figtree, system-ui, sans-serif';
        const items = used.map(k => ({ k, t: LBL[k] || k, w: g.measureText(LBL[k] || k).width + 26 })); const lw = Math.max(items.reduce((t, i) => t + i.w + 22, 0), dw) + 40;
        shadowBox(g, lx, ly, lw, lh, 12); let x = lx + 20; g.textBaseline = 'middle';
        items.forEach(i => { g.beginPath(); g.arc(x + 8, ly + 26, 8, 0, Math.PI * 2); g.fillStyle = NEAR_COLOR[i.k]; g.fill(); g.font = '500 18px Figtree, system-ui, sans-serif'; g.fillStyle = '#1F242E'; g.fillText(i.t, x + 22, ly + 27); x += i.w + 22; });
        g.font = '500 14px Figtree, system-ui, sans-serif'; g.fillStyle = '#5B6170'; g.fillText(disc, lx + 20, ly + 58); g.restore(); };
      // ring labels, upper right of each ring
      g.save(); g.font = '700 17px Figtree, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      [[1, RAD === 1 ? '1 MILE' : RAD + ' MILES'], [0.5, RAD === 1 ? '\u00BD MILE' : (RAD / 2) + ' MILES']].forEach(([m, t]) => { const a = -Math.PI / 3, x0 = C.x + mile * m * Math.cos(a), y0 = C.y + mile * m * Math.sin(a), w = g.measureText(t).width + 26;
        const b = { x: x0 - w / 2, y: y0 - 15, w, h: 30 }; if (hits(b)) return; g.beginPath(); g.roundRect(b.x, b.y, w, 30, 15); g.fillStyle = '#FFFFFF'; g.fill(); g.strokeStyle = '#2B3140'; g.lineWidth = 1.5; g.stroke(); g.fillStyle = '#2B3140'; g.fillText(t, x0, y0 + 1); busy.push(b); });
      g.restore();
      // subject: the lot itself, a red pin over it and the address tag under it
      const L = ring.map(P); g.save(); g.beginPath(); L.forEach((q, i) => i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)); g.closePath(); g.fillStyle = 'rgba(255,214,48,.85)'; g.fill(); g.strokeStyle = '#D7262E'; g.lineWidth = 3; g.stroke();
      g.restore(); busy.push(...drawSubject(g, C, street));
      const IW = 360, IH = IW / 1.5, IX = W - 24 - 8 - IW, IY = H - 36 - 16 - 44 - IH; if (insetSrc) { holder.inset = drawInset(g, insetSrc, IX, IY, IW, caption); busy.push({ x: IX - 8, y: IY - 8, w: IW + 16, h: IH + 52 }); }
      // shopping-center callouts in a left and a right column, each stacked in the order of its anchor, leader line to the center
      const boxes = centers.map(cn => { const a = P(cn); g.font = '700 26px Figtree, system-ui, sans-serif'; const tw = g.measureText(cn.name).width; g.font = '600 17px Figtree, system-ui, sans-serif'; const dw2 = g.measureText(fmtMi(cn.mi)).width + 22;
        g.font = '500 23px Figtree, system-ui, sans-serif'; const iw = Math.max(...cn.items.map(p => g.measureText(p.name).width + 32)); return { cn, ax: a.x, ay: a.y, w: Math.min(500, Math.max(tw + dw2 + 16, iw) + 40), items: cn.items.slice() }; });
      const hOf = b => 20 + 34 + 12 + b.items.length * 35 + 14;
      let left = boxes.filter(b => b.ax < C.x), right = boxes.filter(b => b.ax >= C.x);
      while (left.length - right.length > 1) { left.sort((a, b) => b.ax - a.ax); right.push(left.shift()); }
      while (right.length - left.length > 1) { right.sort((a, b) => a.ax - b.ax); left.push(right.shift()); }
      const place = (col, side) => { const top = side === 'l' ? 24 + 96 + 18 : 24 + 76 + 18, bot = side === 'l' ? ly - 16 : insetSrc ? IY - 8 - 16 : H - 36 - 14;
        col.sort((a, b) => a.ay - b.ay);
        for (let guard = 0; guard < 12; guard++) { const tot = col.reduce((t, b) => t + hOf(b) + 14, -14); if (tot <= bot - top) break;
          const big = col.slice().sort((a, b) => b.items.length - a.items.length)[0]; if (big.items.length > 2) big.items.pop(); else col.pop(); }
        let y = top; col.forEach(b => { b.h = hOf(b); b.y = Math.max(y, Math.min(b.ay - b.h / 2, bot - b.h)); y = b.y + b.h + 14; });
        for (let i = col.length - 1, lim = bot; i >= 0; i--) { const b = col[i]; if (b.y + b.h > lim) b.y = lim - b.h; lim = b.y - 14; }
        col.forEach(b => { b.x = side === 'l' ? 24 : W - 24 - b.w; }); };
      place(left, 'l'); place(right, 'r');
      [...left, ...right].forEach(b => {
        const ex = Math.max(b.x, Math.min(b.ax, b.x + b.w)), ey = Math.max(b.y + 22, Math.min(b.ay, b.y + b.h - 22));
        g.save(); g.strokeStyle = 'rgba(43,49,64,.75)'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(b.ax, b.ay); g.lineTo(ex, ey); g.stroke();
        g.beginPath(); g.arc(b.ax, b.ay, 7, 0, Math.PI * 2); g.fillStyle = '#FFFFFF'; g.fill(); g.lineWidth = 3.5; g.strokeStyle = '#2B3140'; g.stroke(); g.restore();
      });
      [...left, ...right].forEach(b => { shadowBox(g, b.x, b.y, b.w, b.h, 14); busy.push(b);
        g.save(); g.textBaseline = 'middle'; const d = fmtMi(b.cn.mi); g.font = '600 17px Figtree, system-ui, sans-serif'; const dw2 = g.measureText(d).width + 22;
        g.beginPath(); g.roundRect(b.x + b.w - 20 - dw2, b.y + 20, dw2, 30, 15); g.fillStyle = '#F0EDE7'; g.fill(); g.fillStyle = '#3A3F4B'; g.textAlign = 'center'; g.fillText(d, b.x + b.w - 20 - dw2 / 2, b.y + 36);
        g.textAlign = 'left'; g.font = '700 26px Figtree, system-ui, sans-serif'; g.fillStyle = '#1F242E'; let title = b.cn.name; const room = b.w - 40 - dw2 - 12;
        while (g.measureText(title).width > room && title.length > 4) title = title.slice(0, -2).trimEnd() + '…'; g.fillText(title.replace(/……$/, '…'), b.x + 20, b.y + 36);
        g.strokeStyle = '#E4E0D8'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(b.x + 20, b.y + 64); g.lineTo(b.x + b.w - 20, b.y + 64); g.stroke();
        b.items.forEach((p, i) => { drawnCats.add(p.cat); const y = b.y + 66 + i * 35 + 19; g.beginPath(); g.arc(b.x + 28, y, 8, 0, Math.PI * 2); g.fillStyle = NEAR_COLOR[p.cat]; g.fill();
          g.font = '500 23px Figtree, system-ui, sans-serif'; g.fillStyle = '#1F242E'; let n = p.name; while (g.measureText(n).width > b.w - 66 && n.length > 4) n = n.slice(0, -2).trimEnd() + '…'; g.fillText(n, b.x + 44, y + 1); });
        g.restore(); });
      // pins: dot on the place, name tag to the right (or left), skipped if the tag would cover something already drawn
      pins.forEach(p => { const q = P(p); if (q.x < 20 || q.y < 20 || q.x > W - 20 || q.y > H - 50) return; g.save(); g.font = '600 18px Figtree, system-ui, sans-serif';
        const w = g.measureText(p.name).width + 22, h = 32; const opts = [{ x: q.x + 16, y: q.y - h / 2, w, h }, { x: q.x - 16 - w, y: q.y - h / 2, w, h }, { x: q.x - w / 2, y: q.y + 14, w, h }, { x: q.x - w / 2, y: q.y - 14 - h, w, h },
          { x: q.x + 16, y: q.y - h - 6, w, h }, { x: q.x + 16, y: q.y + 6, w, h }, { x: q.x - 16 - w, y: q.y - h - 6, w, h }, { x: q.x - 16 - w, y: q.y + 6, w, h }];
        const b = opts.find(o => !hits(o) && !hits({ x: q.x - 10, y: q.y - 10, w: 20, h: 20 })); if (!b) { g.restore(); return; }
        drawnCats.add(p.cat); g.beginPath(); g.arc(q.x, q.y, 10, 0, Math.PI * 2); g.fillStyle = NEAR_COLOR[p.cat]; g.fill(); g.lineWidth = 3; g.strokeStyle = '#FFFFFF'; g.stroke();
        shadowBox(g, b.x, b.y, b.w, b.h, 9); g.fillStyle = '#1F242E'; g.textBaseline = 'middle'; g.fillText(p.name, b.x + 11, b.y + h / 2 + 1); busy.push(b, { x: q.x - 12, y: q.y - 12, w: 24, h: 24 }); g.restore(); });
      drawLegend();
    });
    if (!r) return null;
    r.view = { ...r.view, inset: holder.inset, kind: 'map', S: p => { const q = px(p.lng, p.lat, r.view.z); return { x: (q.x - r.view.left) * r.view.s, y: (q.y - r.view.top) * r.view.s }; } };
    r.places = { centers: centers.map(x => ({ name: x.name, mi: +x.mi.toFixed(2), items: x.items.map(p => p.name) })), pins: pins.map(p => ({ name: p.name, cat: p.cat, mi: +p.mi.toFixed(2) })) };
    return r;
  }

  // ---- Lot orientation + sun path (Marketing folder) ----
  // Front/back come from the county map itself: a side with no neighboring parcel behind it is open (a street, water or a
  // reserve). One open side = front; two or more = we only name the directions (corner, through or water lot), never guess.
  // Sun path is the theoretical sunrise/sunset bearing on June 21 and December 21. No shade or "sunny yard" claims.
  const WINDS = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast', 'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest'];
  const ABBR = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const wind = b => Math.round((((b % 360) + 360) % 360) / 22.5) % 16;
  const inPoly = (pt, P) => { let c = false; for (let i = 0, k = P.length - 1; i < P.length; k = i++) { const a = P[i], b = P[k]; if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
  function lotSides(ring, neighbors) {
    const c = centroid(ring), f = ftPerDeg(c.lat), toFt = p => ({ x: (p.lng - c.lng) * f.lng, y: (p.lat - c.lat) * f.lat });   // y = north
    const R = ring.map(toFt); const A = R.reduce((t, p, i) => { const q = R[(i + 1) % R.length]; return t + p.x * q.y - q.x * p.y; }, 0);
    const NB = neighbors ? neighbors.map(n => n.ring.map(toFt)) : null;
    return R.map((a, i) => { const b = R[(i + 1) % R.length], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1; let nx = dy / L, ny = -dx / L; if (A < 0) { nx = -nx; ny = -ny; }
      const open = NB ? [0.2, 0.5, 0.8].every(t => { const s = { x: a.x + dx * t + nx * 10, y: a.y + dy * t + ny * 10 }; return !NB.some(P => inPoly(s, P)); }) : null;
      return { i, len: L, bearing: (Math.atan2(nx, ny) * 180 / Math.PI + 360) % 360, open }; });
  }
  // sunrise/sunset bearing (degrees from north) for a solar declination, plus the midday sun's height
  const andList = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  const sunDay = (lat, decl) => { const r = Math.PI / 180, x = Math.sin(decl * r) / Math.cos(lat * r); const rise = Math.acos(Math.max(-1, Math.min(1, x))) / r; return { rise, set: 360 - rise, noonAlt: 90 - Math.abs(lat - decl) }; };
  // What each side of the lot faces. Streets: US Census TIGERweb road centerlines (public, CORS-open, carries street
  // names): a side faces a street when lines run out from at least 2 of 3 points along it cross a public road within 90 ft
  // (property line to centerline). Driveways, alleys, parking aisles and walkways don't count. Water: Esri's street map
  // pixels (water is the only blue fill). This replaces "no neighboring parcel behind it", which called a canal the front.
  const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer';
  async function roadsNear(c, f, win = 260) { const dLat = win / f.lat, dLng = win / f.lng, env = [c.lng - dLng, c.lat - dLat, c.lng + dLng, c.lat + dLat].join(',');
    const one = async L => { try { const r = await fetch(`${TIGER}/${L}/query?where=1%3D1&geometry=${env}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=NAME,MTFCC&outSR=4326&f=json`);
      const j = r.ok ? await r.json() : {}; return (j.features || []).filter(x => x.geometry && !/^S17(10|20|30|40|50|80)$/.test(x.attributes.MTFCC || '')).map(x => ({ name: x.attributes.NAME || '', paths: x.geometry.paths })); } catch (e) { console.warn('tiger', L, e); return []; } };
    return (await Promise.all([2, 6, 8].map(one))).flat(); }
  async function sideKinds(ring, sides) {
    const c = centroid(ring), f = ftPerDeg(c.lat), toFt = p => ({ x: (p.lng - c.lng) * f.lng, y: (p.lat - c.lat) * f.lat });
    const roads = (await roadsNear(c, f)).map(r => ({ name: r.name, segs: r.paths.flatMap(P => P.slice(1).map((q, i) => [toFt({ lng: P[i][0], lat: P[i][1] }), toFt({ lng: q[0], lat: q[1] })])) }));
    // ray (o + t*d, 0 <= t <= len) against segment a-b: distance along the ray, or null
    const cross = (o, d, len, a, b) => { const ex = b.x - a.x, ey = b.y - a.y, den = d.x * ey - d.y * ex; if (Math.abs(den) < 1e-9) return null;
      const t = ((a.x - o.x) * ey - (a.y - o.y) * ex) / den, u = ((a.x - o.x) * d.y - (a.y - o.y) * d.x) / den; return t >= 0 && t <= len && u >= 0 && u <= 1 ? t : null; };
    // water from the street map's blue fill
    const z = 18, tiles = new Map(); const at = async (lng, lat) => { const q = px(lng, lat, z), tx = Math.floor(q.x / 256), ty = Math.floor(q.y / 256), k = tx + ',' + ty;
      if (!tiles.has(k)) tiles.set(k, loadOne(`${BASES.street.tile}/${z}/${ty}/${tx}`, false).then(im => { if (!im) return null; const cv = document.createElement('canvas'); cv.width = cv.height = 256; const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0); return g; }));
      const g = await tiles.get(k); return g ? g.getImageData(Math.floor(q.x) - tx * 256, Math.floor(q.y) - ty * 256, 1, 1).data : null; };
    const blue = d => d && d[2] > d[0] + 25 && d[2] > 150;
    return Promise.all(sides.map(async sd => { const A = ring[sd.i], B = ring[(sd.i + 1) % ring.length], fa = toFt(A), fb = toFt(B), br = sd.bearing * Math.PI / 180, d = { x: Math.sin(br), y: Math.cos(br) };
      const hits = []; let wet = 0;
      for (const t of [0.25, 0.5, 0.75]) { const o = { x: fa.x + (fb.x - fa.x) * t, y: fa.y + (fb.y - fa.y) * t }; let best = null;
        roads.forEach(r => r.segs.forEach(([a, b]) => { const h = cross(o, d, 90, a, b); if (h != null && (!best || h < best.d)) best = { d: h, name: r.name }; })); if (best) hits.push(best);
        let w = 0; for (const off of [25, 40, 55]) if (blue(await at(A.lng + (B.lng - A.lng) * t + d.x * off / f.lng, A.lat + (B.lat - A.lat) * t + d.y * off / f.lat))) w++; if (w >= 2) wet++; }
      const names = hits.map(h => h.name).filter(Boolean), street = names.sort((a, b) => names.filter(x => x === b).length - names.filter(x => x === a).length)[0] || '';
      return { ...sd, kind: hits.length >= 2 ? 'road' : wet >= 2 ? 'water' : 'land', street }; })); }
  async function orientationMap(parcels, ring, addr, cad) {
    if (!ring || ring.length < 3) return null;
    const c = centroid(ring), f = ftPerDeg(c.lat), sides = lotSides(ring, parcels ? parcels.neighbors : null).filter(s => s.len >= 15);
    let kinds = []; try { kinds = await sideKinds(ring, sides); } catch (e) { console.warn('side kinds', e); }
    // one entry per compass direction (a curved or jagged side is several short pieces facing the same way)
    const byWind = (list, k) => { const m = new Map(); list.filter(s => s.kind === k).forEach(s => { const w = wind(s.bearing); if (!m.has(w) || m.get(w).len < s.len) m.set(w, s); }); return [...m.values()]; };
    const roads = byWind(kinds, 'road'), waters = byWind(kinds, 'water');
    let front = null, back = null;
    if (roads.length === 1) { front = roads[0]; back = kinds.filter(s => s.kind !== 'road').sort((a, b) => Math.abs(Math.abs(a.bearing - front.bearing) - 180) - Math.abs(Math.abs(b.bearing - front.bearing) - 180))[0] || null;
      if (back && Math.abs(Math.abs(back.bearing - front.bearing) - 180) > 50) back = null; }
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'); g.fillStyle = '#FBFAF6'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#EFEDE5'; g.lineWidth = 1; for (let x = 0; x < W; x += 80) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); } for (let y = 0; y < H; y += 80) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    const CX = 540, CY = 548, RR = 410, rad = b => (b - 90) * Math.PI / 180;
    // lot + neighbors, north up, inside the dial
    const toFt = p => ({ x: (p.lng - c.lng) * f.lng, y: -(p.lat - c.lat) * f.lat }); const sub = ring.map(toFt), ext = Math.max(...sub.map(p => Math.max(Math.abs(p.x), Math.abs(p.y))), 25);
    const k = (RR * 0.36) / ext, S = p => { const q = toFt(p); return { x: CX + q.x * k, y: CY + q.y * k }; };
    const path = r => { g.beginPath(); r.forEach((p, i) => { const q = S(p); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); }); g.closePath(); };
    g.save(); g.beginPath(); g.arc(CX, CY, RR * 0.70, 0, Math.PI * 2); g.fillStyle = '#FFFFFF'; g.fill(); g.clip();
    (parcels ? parcels.neighbors : []).forEach(n => { path(n.ring); g.fillStyle = '#F2F3EE'; g.fill(); g.strokeStyle = '#C6CEC7'; g.lineWidth = 1.5; g.stroke(); });
    path(ring); g.fillStyle = 'rgba(255,214,48,.55)'; g.fill(); g.strokeStyle = '#D7262E'; g.lineWidth = 5; g.lineJoin = 'round'; g.stroke(); g.restore();
    g.beginPath(); g.arc(CX, CY, RR * 0.70, 0, Math.PI * 2); g.strokeStyle = '#C6CEC7'; g.lineWidth = 2; g.stroke();
    // compass dial
    g.save(); g.beginPath(); g.arc(CX, CY, RR, 0, Math.PI * 2); g.strokeStyle = '#1E2A22'; g.lineWidth = 2.5; g.stroke();
    for (let d = 0; d < 360; d += 22.5) { const big = d % 90 === 0, a = rad(d), r1 = RR - (big ? 22 : 12); g.beginPath(); g.moveTo(CX + Math.cos(a) * r1, CY + Math.sin(a) * r1); g.lineTo(CX + Math.cos(a) * RR, CY + Math.sin(a) * RR); g.lineWidth = big ? 3 : 1.5; g.stroke(); }
    g.font = '800 30px "Bricolage Grotesque", Figtree, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#1E2A22';
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([t, d]) => { const a = rad(d); g.fillText(t, CX + Math.cos(a) * (RR + 30), CY + Math.sin(a) * (RR + 30)); }); g.restore();
    // sun paths: summer (outer) and winter (inner) arcs from sunrise bearing through south to sunset bearing
    const SUM = '#E8701A', WIN = '#2563EB', sum = sunDay(c.lat, 23.44), win = sunDay(c.lat, -23.44);
    const sunArc = (d, r, col) => { g.save(); g.strokeStyle = col; g.lineWidth = 7; g.lineCap = 'round'; g.beginPath(); g.arc(CX, CY, r, rad(d.rise), rad(d.set), false); g.stroke();
      [d.rise, d.set].forEach(b => { const a = rad(b), x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r; g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.fillStyle = col; g.fill(); g.strokeStyle = '#FFFFFF'; g.lineWidth = 3; g.stroke(); });
      const a = rad(180), x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r; g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fillStyle = '#FFFFFF'; g.fill(); g.strokeStyle = col; g.lineWidth = 4; g.stroke(); g.restore(); };
    sunArc(sum, RR * 0.90, SUM); sunArc(win, RR * 0.80, WIN);
    // open-side tags on the lot: FRONT / BACK when we can tell, OPEN otherwise
    const R = ring; const tag = (s, t, col) => { const a = S(R[s.i]), b = S(R[(s.i + 1) % R.length]), br = s.bearing * Math.PI / 180, nx = Math.sin(br), ny = -Math.cos(br);
      const x = (a.x + b.x) / 2 + nx * 44, y = (a.y + b.y) / 2 + ny * 44; g.save(); g.font = '800 17px Figtree, system-ui, sans-serif'; const w = g.measureText(t).width + 24;
      g.beginPath(); g.roundRect(x - w / 2, y - 16, w, 32, 16); g.fillStyle = col; g.fill(); g.fillStyle = '#FFFFFF'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, x, y + 1); g.restore(); };
    const stTag = s => (s.street ? s.street.toUpperCase() : 'STREET') + ' · ' + ABBR[wind(s.bearing)];
    if (front) tag(front, stTag(front), '#1F5F45'); else { const seenSt = new Set(); roads.slice().sort((a, b) => b.len - a.len).forEach(s => { const k = s.street || ABBR[wind(s.bearing)]; if (seenSt.has(k) || seenSt.size >= 3) return; seenSt.add(k); tag(s, stTag(s), '#1F5F45'); }); }
    waters.slice(0, 2).forEach(s => tag(s, 'WATER · ' + ABBR[wind(s.bearing)], '#2563EB'));
    // right panel: what the sheet says, in words
    const street = addr.split(',')[0].trim(); const X = 1040, Wp = W - X - 48;
    const lines = [];
    // Only what the maps show: the street side(s) and any water. Nothing is said when no street is found next to the lot.
    if (front) { lines.push(['Front faces ' + WINDS[wind(front.bearing)], front.street ? 'On ' + front.street + '.' : 'The street side of the lot.']); if (back) lines.push(['Back faces ' + WINDS[wind(back.bearing)], back.kind === 'water' ? 'On the water.' : '']); }
    else if (roads.length > 1) { const by = new Map(); roads.forEach(r => { const k = r.street || 'A street'; if (!by.has(k)) by.set(k, []); by.get(k).push(WINDS[wind(r.bearing)]); });
      lines.push([by.size > 1 ? 'Streets on ' + by.size + ' sides' : 'Street frontage', [...by].map(([n, w]) => n + ' on the ' + andList(w) + ' side' + (w.length > 1 ? 's' : '')).join('; ') + '.']); }
    const wNote = waters.filter(w => !(back && back.i === w.i)); if (wNote.length) lines.push(['On the water', 'Water on the ' + andList(wNote.map(s => WINDS[wind(s.bearing)])) + ' side' + (wNote.length > 1 ? 's' : '') + '.']);
    lines.push(['Summer sun', `Rises in the ${WINDS[wind(sum.rise)]}, sets in the ${WINDS[wind(sum.set)]}.`]);
    lines.push(['Winter sun', `Rises in the ${WINDS[wind(win.rise)]}, sets in the ${WINDS[wind(win.set)]}.`]);
    if (c.lat > 23.5) lines.push(['Midday sun', 'Due south all year, highest in June, lowest in December.']);
    g.save(); g.textBaseline = 'alphabetic'; g.fillStyle = '#1E2A22'; g.font = '700 38px "Bricolage Grotesque", Figtree, system-ui, sans-serif'; g.fillText(street, X, 112);
    g.font = '500 21px Figtree, system-ui, sans-serif'; g.fillStyle = '#4C5A50'; g.fillText('Lot orientation and sun path', X, 148); g.fillStyle = '#2F7A56'; g.fillRect(X, 172, 64, 4);
    const wrap = (t, font, maxW) => { g.font = font; const out = []; let cur = ''; t.split(' ').forEach(w => { const n = cur ? cur + ' ' + w : w; if (g.measureText(n).width > maxW && cur) { out.push(cur); cur = w; } else cur = n; }); if (cur) out.push(cur); return out; };
    let y = 222; lines.forEach(([h, b]) => { g.font = '700 25px Figtree, system-ui, sans-serif'; g.fillStyle = '#1E2A22'; g.fillText(h, X, y); y += 30;
      if (b) wrap(b, '500 20px Figtree, system-ui, sans-serif', Wp).forEach(l => { g.font = '500 20px Figtree, system-ui, sans-serif'; g.fillStyle = '#4C5A50'; g.fillText(l, X, y); y += 27; }); y += 16; });
    // legend
    y += 14; [[SUM, 'Sun path, June 21'], [WIN, 'Sun path, December 21']].forEach(([col, t]) => { g.strokeStyle = col; g.lineWidth = 7; g.lineCap = 'round'; g.beginPath(); g.moveTo(X, y - 8); g.lineTo(X + 44, y - 8); g.stroke();
      g.beginPath(); g.arc(X + 44, y - 8, 9, 0, Math.PI * 2); g.fillStyle = col; g.fill(); g.font = '600 20px Figtree, system-ui, sans-serif'; g.fillStyle = '#1E2A22'; g.fillText(t, X + 66, y); y += 36; });
    y += 10; wrap(`Lot lines from the ${cad || 'county'} parcel map, streets from US Census maps. Sun path is theoretical; trees and buildings decide real shade. Not a survey.`, '500 19px Figtree, system-ui, sans-serif', Wp)
      .forEach(l => { g.font = '500 19px Figtree, system-ui, sans-serif'; g.fillStyle = '#5B6A5F'; g.fillText(l, X, y); y += 26; });
    g.restore();
    const img = await toImage(cv);
    return { img, view: { kind: 'map', S }, label: 'Orientation & sun', facts: { front: front && WINDS[wind(front.bearing)], back: back && WINDS[wind(back.bearing)], streets: roads.map(s => WINDS[wind(s.bearing)] + (s.street ? ' (' + s.street + ')' : '')), water: waters.map(s => WINDS[wind(s.bearing)]) } };
  }

  // ---- Listing check: what an existing HAR listing is missing (free, no AI: counts and captions from the gallery) ----
  // har = the har-gallery function's reply { photos:[{description}] }. Returns short findings for the Upgrade step.
  function listingCheck(har, isLot) {
    const ph = (har && har.photos) || [], n = ph.length, out = [];
    const need = isLot ? 1 : 6;
    if (n < need) out.push({ bad: true, t: `${n} photo${n === 1 ? '' : 's'} on the listing. HAR asks for at least ${need}.` });
    else if (n < 15) out.push({ bad: true, t: `Only ${n} photos. Listings with a full gallery get more clicks.` });
    else out.push({ bad: false, t: `${n} photos on the listing.` });
    const blank = ph.filter(p => !(p.description || '').trim()).length;
    if (blank) out.push({ bad: true, t: blank === n ? 'None of the photos have descriptions.' : `${blank} of ${n} photos have no description.` });
    const words = ph.map(p => (p.description || '').toLowerCase()).join(' ');
    if (!/aerial|drone|overhead|satellite|bird/.test(words)) out.push({ bad: true, t: 'No aerial or overhead view of the lot.' });
    if (!/plat|survey|parcel|lot line|lot size|dimension/.test(words)) out.push({ bad: true, t: 'No lot map with dimensions.' });
    if (!/nearby|shopping|grocery|restaurant|minutes|miles|close to/.test(words)) out.push({ bad: true, t: "Nothing shows what's nearby." });
    return out;
  }

  // ---- the kit ----
  async function buildKit(order, { onProgress } = {}) {
    const say = t => onProgress && onProgress(t);
    say('Placing the address on the map…');
    const g = order.geo && order.geo.lat != null ? order.geo : await geocode(order.addr);
    order.geo = g;
    say('Pulling the parcel from the county…');
    let { parcels, cad: cadFound, matched, key: countyKey } = await lookupParcels(g, order.addr);
    // A parcel picked from the address suggestions (places.js) is the subject; the county query above only supplies the neighbors.
    const picked = order.parcel && order.parcel.hcad && order.geoRing && order.geoRing.length >= 3;
    if (picked && parcels) { const sub = parcels.neighbors.concat([parcels.subject]).find(x => x.a.HCAD_NUM === order.parcel.hcad) || parcels.subject; parcels = { subject: sub, neighbors: parcels.neighbors.concat([parcels.subject]).filter(x => x !== sub) }; }
    // A parcel the county records don't tie to this address is a guess. Never build on a guess: the agent confirms it on the
    // Address step (Use this parcel / tax ID lookup), which sets order.parcel.hcad and order.geoRing.
    if (!picked && parcels && !matched) throw new Error("We couldn't tie this address to one county parcel for certain. Go back to the address and look the lot up by its tax ID, or pick the closest parcel we found.");
    const ring = picked ? order.geoRing.slice() : parcels ? straighten(dedupe(parcels.subject.ring)) : rectParcel(g, order.parcel && order.parcel.dims);
    const cad = picked ? (order.parcel.cad || 'Harris CAD') : parcels ? cadFound : (order.parcel && order.parcel.cad) || 'County parcel';
    // Several separate pieces on one order: frame all of them (the main piece keeps the pins).
    const frame = order.groups && order.groups.length > 1 ? order.groups.flatMap(gr => gr.ring) : ring;
    const c = frame === ring ? centroid(ring) : { lng: (Math.min(...frame.map(p => p.lng)) + Math.max(...frame.map(p => p.lng))) / 2, lat: (Math.min(...frame.map(p => p.lat)) + Math.max(...frame.map(p => p.lat))) / 2 };
    order.geoRing = ring; order.cad = cad;
    if (parcels && !picked) { const a = parcels.subject.a; const ac = a.StatedArea || a.Acreage; order.parcel = { cad, dims: [ac ? (+ac).toFixed(3) + ' ac' : '', ring.length + ' corners', a.legal_dscr_1].filter(Boolean).join(' · '), pts: order.parcel && order.parcel.pts }; }
    const views = [];
    // Close-up: sharpest zoom the imagery really has, enlarged so the lot fills ~55% of the sheet (capped).
    say('Fetching the close-up…'); let close = null;
    for (const z of [20, 19, 18, 17]) { const s = Math.min(MAX_UP, Math.max(1, H * 0.55 / lotPx(frame, z))); close = await satellite(c, z, s, 'Close-up'); if (close) break; }
    if (!close) throw new Error('Satellite imagery is not available for this spot.');
    const zmax = close.view.z, street = order.addr.split(',')[0].trim(), src = insetSource(close, ring), cap = lotCaption(ring, parcels && parcels.subject && parcels.subject.a);
    // Every sheet is built to go on the MLS (HAR 1.25.5): the lot is the subject of each one. Close-ups show it outright; wider
    // sheets add a pin with the address and an inset of the lot. Order below = suggested upload order (files are numbered).
    let zb = zmax; while (zb > 14 && lotPx(frame, zb) > H * 0.25) zb--;            // big lots: step out until the lot is a quarter of the frame or less
    const blockS = Math.min(2, Math.max(1, H * 0.18 / lotPx(frame, zb)));
    say('Fetching the block…'); const block = await satellite(c, zb, blockS, 'The block');
    say('Drawing the street maps…'); const hBlk = {}, hArea = {}, hSat = {}, hReg = {};
    const sm = await Promise.all([satellite(c, zb, blockS, 'Block map', 'street'), satellite(c, zb - 2, 1, 'Neighborhood map', 'street', focus(ring, street, src, cap, hArea))]);
    say('Drawing the plat map…'); const plat = await parcelMap(parcels, ring, order.addr, cad, order.parcelList, order.groups);
    say('Drawing the block…'); let blockPlat = null;   // decision 10/14/2026: the block plat map goes in every package
    if (parcels && countyKey) try { blockPlat = await blockPlatMap(countyKey, cad, ring, parcels.subject.a, order.addr, order.parcelList); } catch (e) { console.warn('block plat map', e); }
    say('Fetching the neighborhood…'); const area = await satellite(c, zb - 2, 1, 'The neighborhood', 'sat', focus(ring, street, src, cap, hSat));
    say('Placing it in the city…'); const reg = await region(c, order.addr, (g, v) => { hReg.inset = drawInset(g, src, 32, H - 36 - 24 - 320 - 44, 480, cap); });
    say('Finding the shopping and schools nearby…'); let nb = null;
    try { nb = await nearbyMap(c, ring, order.addr, src, cap); if (nb) order.nearby = nb.places; } catch (e) { console.warn('nearby map', e); }
    say('Working out which way the lot faces…'); let or = null;
    try { or = await orientationMap(parcels, ring, order.addr, cad); if (or) order.orientation = or.facts; } catch (e) { console.warn('orientation', e); }
    const withInset = (r, h) => r && h.inset ? { ...r, view: { ...r.view, inset: h.inset } } : r;
    views.push({ ...close, slug: 'aerial-close' });
    views.push({ ...plat, slug: 'plat-map' });
    if (blockPlat) views.push({ ...blockPlat, slug: 'block-plat-map' });
    if (block) views.push({ ...block, slug: 'aerial-block' });
    if (sm[0]) views.push({ ...sm[0], slug: 'street-map-block' });
    views.push({ ...close, slug: 'aerial-close-no-lines', label: 'Close-up, no lines', dot: true });
    if (nb) views.push({ ...nb, slug: 'whats-nearby' });
    if (or) views.push({ ...or, slug: 'orientation-sun' });
    if (area) views.push({ ...withInset(area, hSat), slug: 'aerial-neighborhood' });
    if (sm[1]) views.push({ ...withInset(sm[1], hArea), slug: 'street-map-neighborhood' });
    if (reg) views.push({ ...withInset(reg, hReg), slug: 'map-2mi', dot: true });
    const base = order.addr.split(',')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    order.photos = views.map((v, i) => {
      // The city map carries no outline: the lot is smaller than a pixel there and the dot is already drawn in.
      const pts = v.dot ? [] : v.view.kind === 'sat' ? projectRing(ring, v.view) : ring.map(p => v.view.S(p));
      return { name: `${String(i + 1).padStart(2, '0')}_${base}_${v.slug}.jpg`, img: v.img, pts, auto: pts.map(q => ({ ...q })), carriedPts: null, mask: null, sat: true, dot: !!v.dot, label: v.label, view: v.view, conf: 1 }; });
    return order.photos;
  }
  const COUNT = 11;  // images in a full kit (fewer when a street zoom is missing or there's nothing nearby to map)

  // confirmed pins on one view -> geo -> every other view (exact: all views share the same map projection)

  // Parcel check: the county ring over satellite imagery, sides in feet, corners numbered 1..n to match the pins on the
  // confirm step. Shown to the agent beside their example photo so they can set pins against something independent.
  async function parcelCheck(order) {
    const ring = order.geoRing; if (!ring || ring.length < 3) return null;
    const c = centroid(ring), f = ftPerDeg(c.lat);
    const toFt = p => ({ x: (p.lng - c.lng) * f.lng, y: -(p.lat - c.lat) * f.lat });
    const sides = ring.map((p, i) => { const a = toFt(p), b = toFt(ring[(i + 1) % ring.length]); return Math.hypot(a.x - b.x, a.y - b.y); });
    const ft = ring.map(toFt); const area = Math.abs(ft.reduce((s, p, i) => { const q = ft[(i + 1) % ft.length]; return s + p.x * q.y - q.x * p.y; }, 0)) / 2;
    for (let z = 19; z >= 16; z--) {
      const s = Math.min(4, Math.max(1, (H * 0.72) / lotPx(ring, z)));      // lot spans about 70% of the sheet height
      const r = await satellite(c, z, s, 'Parcel check', 'sat', (g, v) => {
        const P = projectRing(ring, v);
        g.save(); g.beginPath(); P.forEach((q, i) => i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)); g.closePath();
        g.fillStyle = 'rgba(247,201,72,.26)'; g.fill(); g.lineJoin = 'round'; g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 9; g.stroke(); g.strokeStyle = '#E62E2E'; g.lineWidth = 5; g.stroke();
        g.font = '700 26px Figtree, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        P.forEach((a, i) => { const b = P[(i + 1) % P.length]; const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; const t = Math.round(sides[i]) + ' ft'; const tw = g.measureText(t).width;
          g.fillStyle = 'rgba(30,42,34,.86)'; g.beginPath(); g.roundRect(mx - tw / 2 - 10, my - 19, tw + 20, 38, 9); g.fill(); g.fillStyle = '#fff'; g.fillText(t, mx, my + 1); });
        P.forEach((q, i) => { g.beginPath(); g.arc(q.x, q.y, 17, 0, Math.PI * 2); g.fillStyle = 'rgba(0,0,0,.45)'; g.fill(); g.beginPath(); g.arc(q.x, q.y, 14, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
          g.fillStyle = '#E62E2E'; g.font = '800 18px Figtree, system-ui, sans-serif'; g.fillText(String(i + 1), q.x, q.y + 1); });
        const hdr = `${(order.parcel && order.parcel.cad) || 'County'} parcel · ${Math.round(area).toLocaleString()} sq ft · pins match the numbers`;
        g.font = '700 24px Figtree, system-ui, sans-serif'; g.textAlign = 'left'; const tw = g.measureText(hdr).width;
        g.fillStyle = 'rgba(30,42,34,.86)'; g.beginPath(); g.roundRect(22, 22, tw + 32, 48, 12); g.fill(); g.fillStyle = '#fff'; g.fillText(hdr, 38, 47); g.restore();
      });
      if (r) return { img: r.img, sides, area, ring };
    }
    return null;
  }

  function carry(order, src) {
    const s = order.photos[src]; if (!s || s.view.kind !== 'sat') return;
    const ring = unproject(s.pts, s.view); order.geoRing = ring;
    order.photos.forEach((p, i) => { if (i === src || p.dot) return; p.pts = p.view.kind === 'sat' ? projectRing(ring, p.view) : ring.map(q => p.view.S(q)); p.conf = 1; });
  }

  window.LO = window.LO || {};
  // Address step: find the parcel as soon as an address is picked, so both intakes start from the county lines.
  // One parcel, in the shape the Address step keeps for every parcel on the order.
  const ringArea = ring => { const c = centroid(ring), f = ftPerDeg(c.lat); const P = ring.map(p => ({ x: (p.lng - c.lng) * f.lng, y: (p.lat - c.lat) * f.lat }));
    return Math.abs(P.reduce((t, p, i) => { const q = P[(i + 1) % P.length]; return t + p.x * q.y - q.x * p.y; }, 0)) / 2; };
  function parcelRecord(sub, key, cad) { const ring = straighten(dedupe(sub.ring)), a = sub.a, ac = a.StatedArea || a.Acreage || (a.ACRES != null ? a.ACRES : null);
    const area = Math.round((a.land_sqft && +a.land_sqft) || (ac && +ac * 43560) || ringArea(ring));
    // Parcel ID: the county's second number for the same parcel where it keeps one (Galveston PID, San Jacinto property ID); otherwise the tax ID is the parcel ID.
    const pid0 = a.pid != null ? a.pid : a.PID != null ? a.PID : null, pid = pid0 != null && String(pid0) !== String(a.HCAD_NUM) ? String(pid0) : null;
    return { key, cad, id: String(a.HCAD_NUM), pid, ring, area, acres: area / 43560, legal: a.legal_dscr_1 || a.LEGAL || '', situs: [a.site_str_num, a.site_str_name].filter(Boolean).join(' '),
      dims: [ac ? (+ac).toFixed(3) + ' ac' : area.toLocaleString() + ' sq ft', a.legal_dscr_1 || a.LEGAL].filter(Boolean).join(' · ') }; }
  // Address step: find the parcel as soon as an address is picked, so both intakes start from the county lines.
  async function findParcel(order) { const g = order.geo && order.geo.lat != null ? order.geo : await geocode(order.addr); order.geo = g;
    const { parcels, cad, key } = await lookupParcels(g, order.addr); if (!parcels) return null; const rec = parcelRecord(parcels.subject, key, cad);
    return { ring: rec.ring, rec, parcel: { cad, dims: rec.dims, hcad: rec.id } }; }
  // Another parcel on the same order, by tax ID (dashes optional) in the first parcel's county.
  const dash = (d, parts) => { let i = 0; return parts.map(n => d.slice(i, i += n)).join('-'); };
  const BY_ID = {
    harris: raw => { const d = raw.replace(/\D/g, ''); return d && { url: HC_PARCELS, where: `HCAD_NUM='${d}'`, fields: 'HCAD_NUM,site_str_num,site_str_name,legal_dscr_1,StatedArea,land_sqft', map: a => a, cad: 'Harris CAD' }; },
    galveston: raw => { const d = raw.replace(/\D/g, ''); if (!d) return null; const where = d.length <= 7 ? `PID=${+d}` : `GEOID='${d.length === 15 ? dash(d, [4, 4, 4, 3]) : raw.trim()}'`;
      return { url: GC_PARCELS, where, fields: 'GEOID,PID,SITUS,LEGAL,ACRES', cad: 'Galveston CAD',
        map: a => { const m = (a.SITUS || '').trim().match(/^(\d+[A-Za-z]?)\s+(.*?)\s+[A-Z ]+,\s*TX/); return { ...a, HCAD_NUM: a.GEOID, site_str_num: m ? m[1] : '', site_str_name: m ? m[2] : '', legal_dscr_1: a.LEGAL, StatedArea: a.ACRES }; } }; },
    fortbend: raw => { const d = raw.replace(/\D/g, ''); if (!d) return null; const id = d.length === 16 ? dash(d, [4, 2, 3, 4, 3]) : raw.trim(); return { ...COUNTIES.fortbend, where: `PARCEL_ID='${id.replace(/'/g, '')}'` }; },
    montgomery: raw => { const d = raw.replace(/\D/g, ''); return d && { ...COUNTIES.montgomery, where: `PARCEL_ID=${+d}` }; },
    sanjacinto: raw => { const d = raw.replace(/\D/g, ''); if (!d) return null; const where = d.length <= 6 && !/-/.test(raw) ? `prop_id=${+d}` : `geo_id='${d.length === 11 ? dash(d, [4, 3, 4]) : raw.trim().replace(/'/g, '')}'`; return { ...COUNTIES.sanjacinto, where }; },
  };
  // How each county writes its numbers: dash groups (digits per group) or plain digits up to max. Used to format the add-parcel box as the agent types.
  const ID_FORMAT = {
    harris:     { tax: { groups: [3, 3, 3, 4] }, parcel: { groups: [3, 3, 3, 4] } },          // HCAD account = parcel number
    galveston:  { tax: { groups: [4, 4, 4, 3] }, parcel: { max: 7 } },                         // geographic ID / property ID
    fortbend:   { tax: { groups: [4, 2, 3, 4, 3] }, parcel: { groups: [4, 2, 3, 4, 3] } },
    montgomery: { tax: { max: 12 }, parcel: { max: 12 } },
    sanjacinto: { tax: { groups: [4, 3, 4] }, parcel: { max: 6 } },                            // geo ID / property ID
  };
  function formatId(key, kind, raw) { const f = (ID_FORMAT[key] || {})[kind]; const d = String(raw || '').replace(/\D/g, ''); if (!f) return String(raw || '');
    if (!f.groups) return d.slice(0, f.max); const out = []; let i = 0; for (const n of f.groups) { if (i >= d.length) break; out.push(d.slice(i, i += n)); } return out.join('-'); }
  const idMask = (key, kind) => { const f = (ID_FORMAT[key] || {})[kind]; return !f ? '' : f.groups ? f.groups.map(n => 'x'.repeat(n)).join('-') : 'up to ' + f.max + ' digits'; };
  async function parcelById(key, raw) { const q = BY_ID[key] && BY_ID[key](raw); if (!q) return null;
    const u = `${q.url}?where=${encodeURIComponent(q.where)}&outFields=${q.fields}&returnGeometry=true&outSR=4326&f=json`;
    const r = await fetch(u); if (!r.ok) return null; const j = await r.json(); const ft = (j.features || []).find(f => f.geometry && f.geometry.rings); if (!ft) return null;
    return parcelRecord({ a: q.map(ft.attributes), ring: ft.geometry.rings[0].map(([lng, lat]) => ({ lng, lat })) }, key, q.cad); }
  async function parcelAtAddress(addr) { const o = { addr }; const r = await findParcel(o); return r && r.rec; }
  // County picker on the Address step: every Texas county; the ones in COUNTY_KEYS have tax records we can search (add new ones here too, see docs/COUNTIES.md).
  const TX_COUNTIES = 'Anderson,Andrews,Angelina,Aransas,Archer,Armstrong,Atascosa,Austin,Bailey,Bandera,Bastrop,Baylor,Bee,Bell,Bexar,Blanco,Borden,Bosque,Bowie,Brazoria,Brazos,Brewster,Briscoe,Brooks,Brown,Burleson,Burnet,Caldwell,Calhoun,Callahan,Cameron,Camp,Carson,Cass,Castro,Chambers,Cherokee,Childress,Clay,Cochran,Coke,Coleman,Collin,Collingsworth,Colorado,Comal,Comanche,Concho,Cooke,Coryell,Cottle,Crane,Crockett,Crosby,Culberson,Dallam,Dallas,Dawson,Deaf Smith,Delta,Denton,DeWitt,Dickens,Dimmit,Donley,Duval,Eastland,Ector,Edwards,Ellis,El Paso,Erath,Falls,Fannin,Fayette,Fisher,Floyd,Foard,Fort Bend,Franklin,Freestone,Frio,Gaines,Galveston,Garza,Gillespie,Glasscock,Goliad,Gonzales,Gray,Grayson,Gregg,Grimes,Guadalupe,Hale,Hall,Hamilton,Hansford,Hardeman,Hardin,Harris,Harrison,Hartley,Haskell,Hays,Hemphill,Henderson,Hidalgo,Hill,Hockley,Hood,Hopkins,Houston,Howard,Hudspeth,Hunt,Hutchinson,Irion,Jack,Jackson,Jasper,Jeff Davis,Jefferson,Jim Hogg,Jim Wells,Johnson,Jones,Karnes,Kaufman,Kendall,Kenedy,Kent,Kerr,Kimble,King,Kinney,Kleberg,Knox,Lamar,Lamb,Lampasas,La Salle,Lavaca,Lee,Leon,Liberty,Limestone,Lipscomb,Live Oak,Llano,Loving,Lubbock,Lynn,McCulloch,McLennan,McMullen,Madison,Marion,Martin,Mason,Matagorda,Maverick,Medina,Menard,Midland,Milam,Mills,Mitchell,Montague,Montgomery,Moore,Morris,Motley,Nacogdoches,Navarro,Newton,Nolan,Nueces,Ochiltree,Oldham,Orange,Palo Pinto,Panola,Parker,Parmer,Pecos,Polk,Potter,Presidio,Rains,Randall,Reagan,Real,Red River,Reeves,Refugio,Roberts,Robertson,Rockwall,Runnels,Rusk,Sabine,San Augustine,San Jacinto,San Patricio,San Saba,Schleicher,Scurry,Shackelford,Shelby,Sherman,Smith,Somervell,Starr,Stephens,Sterling,Stonewall,Sutton,Swisher,Tarrant,Taylor,Terrell,Terry,Throckmorton,Titus,Tom Green,Travis,Trinity,Tyler,Upshur,Upton,Uvalde,Val Verde,Van Zandt,Victoria,Walker,Waller,Ward,Washington,Webb,Wharton,Wheeler,Wichita,Wilbarger,Willacy,Williamson,Wilson,Winkler,Wise,Wood,Yoakum,Young,Zapata,Zavala'.split(',');
  const COUNTY_KEYS = { 'Harris': 'harris', 'Galveston': 'galveston', 'Fort Bend': 'fortbend', 'Montgomery': 'montgomery', 'San Jacinto': 'sanjacinto' };
  const guessCounty = (addr, g) => { try { return whichCounty(addr || '', g && g.lat != null ? g : { lat: 0, lng: 0 }); } catch (e) { return null; } };
  // Caption fact sheet: nearest grocery, shopping, dining and coffee, with straight-line miles.
  async function shopsNear(c) { if (!c || c.lat == null) return []; const places = await placesNear(c, 3), f = ftPerDeg(c.lat);
    const mi = p => Math.hypot((p.lng - c.lng) * f.lng, (p.lat - c.lat) * f.lat) / 5280, out = [];
    for (const [cat, k] of [['Grocery', 2], ['Center', 1], ['Dining', 2], ['Coffee', 1]]) {
      const seen = new Set(); places.filter(p => p.cat === cat && p.name).map(p => ({ name: p.name, cat, mi: +mi(p).toFixed(2) })).sort((a, b) => a.mi - b.mi)
        .forEach(p => { if (seen.size < k && !seen.has(p.name)) { seen.add(p.name); out.push(p); } }); }
    return out; }
  window.LO.sat = { shopsNear, TX_COUNTIES, COUNTY_KEYS, guessCounty, buildKit, carry, parcelCheck, findParcel, parcelById, parcelAtAddress, straighten, formatId, idMask, ID_FORMAT, listingCheck, nearbyMap, orientationMap, blockPlatMap, platMaps, lookupParcels, PRICE: 35, COUNT };
})();
