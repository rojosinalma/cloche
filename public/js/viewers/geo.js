// Map viewer (GeoJSON, GPX, KML) for the preview modal. mount(ctx) fetches the
// file's bytes from ctx.src (the one download), turns GPX and KML into
// GeoJSON in the browser (DOMParser: no DTDs, no external entities), and
// draws the shapes with Leaflet over the tiles the settings name, or over the
// plain background when the tile URL is empty. Settings arrive as data
// attributes on the map element (views/viewers/geo.erb).
const LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet-src.esm.js';
const LEAFLET_CSS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
const TOGEOJSON = 'https://cdn.jsdelivr.net/npm/@tmcw/togeojson@7.1.3/dist/togeojson.es.mjs';

const FIT_MAX_ZOOM = 16;
const FIT_PADDING = [24, 24];
const POPUP_VALUE_CHARS = 300;
const MAP_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '=', '_']);
const BADGES = { geojson: 'GeoJSON', json: 'GeoJSON', gpx: 'GPX', kml: 'KML' };
const GEOMETRIES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']);
// togeojson's per-point arrays (times, heart rate): one value per vertex, noise in a popup.
const HIDDEN_PROPS = new Set(['coordinateProperties']);

// Leaflet's stylesheet, added once to the page; a failed load is retried on the next file.
let cssReady = null;
const leafletCss = () => {
  cssReady ||= new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = LEAFLET_CSS;
    link.onload = resolve;
    link.onerror = () => { link.remove(); cssReady = null; reject(new Error('the map stylesheet did not load')); };
    document.head.append(link);
  });
  return cssReady;
};

const fail = (reason) => Object.assign(new Error(reason), { reason });

// GPX and KML never need a DTD: the doctype goes before parsing, so no entity
// is declared, expanded or fetched (an entity the file still uses is an error).
const DOCTYPE = /^(\uFEFF?\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*)<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>/i;

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text.replace(DOCTYPE, '$1'), 'application/xml');
  if (doc.doctype || doc.getElementsByTagName('parsererror').length) throw fail('it is not well-formed XML');
  return doc;
}

function parseJson(text) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw fail(`it is not valid JSON (${e.message})`);
  }
}

function convert(lib, format, doc) {
  try {
    return lib[format](doc);
  } catch (e) {
    throw fail(`it could not be read as ${BADGES[format]} (${e.message})`);
  }
}

// GeoJSON root → a flat list of features with one geometry each (a
// GeometryCollection splits into its parts, sharing the properties), so every
// layer gets the style of its own geometry type.
function features(data) {
  let list;
  if (data?.type === 'FeatureCollection' && Array.isArray(data.features)) list = data.features;
  else if (data?.type === 'Feature') list = [data];
  else if (GEOMETRIES.has(data?.type)) list = [{ type: 'Feature', properties: {}, geometry: data }];
  else throw fail('it is not GeoJSON (the top level is no FeatureCollection, Feature or geometry)');
  const flat = [];
  const add = (f, g) => {
    if (!g || typeof g !== 'object') return;
    if (g.type === 'GeometryCollection') (Array.isArray(g.geometries) ? g.geometries : []).forEach((p) => add(f, p));
    else if (GEOMETRIES.has(g.type)) flat.push({ type: 'Feature', properties: f.properties, geometry: g });
  };
  list.forEach((f) => { if (f && typeof f === 'object') add(f, f.geometry); });
  return flat;
}

const positions = (c) => (!Array.isArray(c) ? 0 : typeof c[0] === 'number' ? 1 : c.reduce((n, x) => n + positions(x), 0));

const kindOf = (type) => (type.endsWith('Point') ? 'point' : type.endsWith('LineString') ? 'line' : 'area');

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// The operator's attribution, reduced to text and http(s) links: it is
// rendered as HTML by Leaflet, so nothing else from the setting survives.
function attribution(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out = document.createElement('span');
  const walk = (from, to) => from.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) to.append(n.textContent);
    else if (n.nodeType === Node.ELEMENT_NODE) {
      const href = n.tagName === 'A' ? n.getAttribute('href') || '' : '';
      if (/^https?:\/\//i.test(href)) {
        const a = document.createElement('a');
        Object.assign(a, { href, target: '_blank', rel: 'noopener noreferrer' });
        walk(n, a);
        to.append(a);
      } else walk(n, to);
    }
  });
  walk(doc.body, out);
  return out.innerHTML;
}

const formatValue = (v) => {
  const s = v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > POPUP_VALUE_CHARS ? `${s.slice(0, POPUP_VALUE_CHARS)}…` : s;
};

// A feature's properties as a table, built from text nodes only.
function popup(feature) {
  const props = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const titleKey = ['name', 'title'].find((k) => props[k] !== undefined && props[k] !== null && typeof props[k] !== 'object');
  const entries = Object.entries(props).filter(([k]) => !HIDDEN_PROPS.has(k) && k !== titleKey);
  const box = document.createElement('div');
  box.className = 'geo-popup';
  if (titleKey) {
    const h = document.createElement('div');
    h.className = 'geo-popup-title';
    h.textContent = formatValue(props[titleKey]);
    box.append(h);
  }
  if (!entries.length && !titleKey) {
    const p = document.createElement('div');
    p.className = 'geo-popup-empty';
    p.textContent = 'No properties';
    box.append(p);
  }
  if (!entries.length) return box;
  const table = document.createElement('table');
  table.className = 't-table geo-props';
  const body = table.createTBody();
  entries.forEach(([k, v]) => {
    const row = body.insertRow();
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = k;
    row.append(th);
    row.insertCell().textContent = formatValue(v);
  });
  box.append(table);
  return box;
}

// Leaflet's controls carry title= tooltips; the house tooltip is data-tip.
const retitle = (el) => el.querySelectorAll('[title]').forEach((n) => { n.dataset.tip = n.title; n.removeAttribute('title'); });

export async function mount(ctx) {
  const el = ctx.$('[data-role="map"]');
  const loading = ctx.$('[data-role="loading"]');
  const fitBtn = ctx.$('[data-role="fit"]');
  const d = el.dataset;
  const conf = {
    tileUrl: (d.tileUrl || '').trim(), attribution: d.tileAttribution || '', maxZoom: Number(d.tileMaxZoom) || 19,
    maxFeatures: Number(d.maxFeatures) || 0, maxPoints: Number(d.maxPoints) || 0
  };
  const format = (ctx.item.format || '').toLowerCase();
  ctx.setBadge(BADGES[format] || 'GeoJSON');

  let map = null;
  let layer = null;
  let observer = null;
  let fitted = false;
  const handle = {
    show() { if (map) { map.invalidateSize(); fit(); } },
    // Leaflet pans and zooms a focused map from a document listener; the modal must not move on as well.
    key(e) { return Boolean(map) && el.contains(document.activeElement) && MAP_KEYS.has(e.key); },
    dispose() { observer?.disconnect(); map?.remove(); map = null; }
  };
  const fit = (force = false) => {
    if (!map || !layer || (fitted && !force) || !el.clientWidth || !el.clientHeight) return;
    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: Math.min(FIT_MAX_ZOOM, conf.maxZoom) });
    else map.setView([0, 0], 2);
    fitted = true;
  };
  const refuse = (message, icon) => { fitBtn.hidden = true; ctx.notice(message, icon); return handle; };

  try {
    const lib = import(LEAFLET);
    const xmlLib = format === 'gpx' || format === 'kml' ? import(TOGEOJSON) : null;
    [lib, xmlLib].forEach((p) => p?.catch(() => {})); // awaited below; no unhandled rejection meanwhile
    const r = await fetch(ctx.src, { signal: ctx.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    const data = xmlLib ? convert(await xmlLib, format, parseXml(text)) : parseJson(text);
    const list = features(data);
    const points = list.reduce((n, f) => n + positions(f.geometry.coordinates), 0);
    ctx.setStats(` · ${plural(list.length, 'feature')} · ${plural(points, 'point')}`);
    if (conf.maxFeatures && list.length > conf.maxFeatures) {
      return refuse(`This file has ${plural(list.length, 'feature')}, above the ${conf.maxFeatures.toLocaleString()} feature limit of the map viewer.`, 'file-earmark-x');
    }
    if (conf.maxPoints && points > conf.maxPoints) {
      return refuse(`This file has ${plural(points, 'point')}, above the ${conf.maxPoints.toLocaleString()} point limit of the map viewer.`, 'file-earmark-x');
    }
    if (!list.length) return refuse(`${ctx.item.name} holds no shapes to show on a map.`, 'info-circle');

    const [L] = await Promise.all([lib, leafletCss()]);
    if (ctx.signal.aborted) return null;
    map = L.map(el, { maxZoom: conf.maxZoom, worldCopyJump: true, zoomSnap: 0.5 });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>');
    if (conf.tileUrl) {
      L.tileLayer(conf.tileUrl, {
        maxZoom: conf.maxZoom, attribution: attribution(conf.attribution), referrerPolicy: 'strict-origin-when-cross-origin'
      }).addTo(map);
    }
    try {
      layer = L.geoJSON(list, {
        style: (f) => ({ className: `geo-shape geo-${kindOf(f.geometry.type)}` }),
        pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 6, className: 'geo-shape geo-point' }),
        onEachFeature: (f, l) => l.bindPopup(() => popup(f), { maxWidth: 360, autoPanPadding: FIT_PADDING })
      }).addTo(map);
    } catch (e) {
      throw fail(`a shape has invalid coordinates (${e.message})`);
    }
    // Points above lines and areas, so a waypoint on a track stays clickable (paths exist once the map has a view).
    map.whenReady(() => layer?.eachLayer((l) => { if (kindOf(l.feature.geometry.type) === 'point') l.bringToFront(); }));
    retitle(el);
    loading.hidden = true;
    fitBtn.disabled = false;
    fitBtn.addEventListener('click', () => fit(true), { signal: ctx.signal });
    observer = new ResizeObserver(() => { if (map) { map.invalidateSize(); fit(); } });
    observer.observe(el);
    fit();
    return handle;
  } catch (e) {
    if (e.name === 'AbortError' || ctx.signal.aborted) return null;
    handle.dispose();
    if (e.reason) return refuse(`${ctx.item.name} cannot be shown on a map: ${e.reason}.`, 'exclamation-triangle');
    console.error(e);
    return refuse(`Could not load ${ctx.item.name} on a map: ${e.message}`, 'exclamation-triangle');
  }
}
