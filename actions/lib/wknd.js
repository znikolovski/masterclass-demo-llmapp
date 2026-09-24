/* global fetch, AbortController, URLSearchParams */
/*
 * Shared WKND data access for the adventure tools.
 *
 * Replaces the per-handler MOCK_DATA lookups with real integrations sourced from
 * the masterclass-demo codebase:
 *   - EDS query-index  (source of truth for editorial attributes / scalars)
 *   - Aero catalog API (commerce fields: price, image, gateway IATA, editorial URL)
 *   - Aero flights API (real travel logistics for permits/access)
 *   - B2B forms API    (real field-submission writes)
 *   - EDS attributes sheet (tabular/list data: gear, permits, pack reference)
 *
 * Each `load*` helper degrades gracefully: on any network/parse failure it returns
 * the caller's MOCK_DATA (or an empty result) so the tools never hard-break.
 *
 * Base URLs are read from declared app variables via `extra.variables.*` (authored
 * in the LLM Apps UI, mirrored locally through the downloaded actions.json). Sensible
 * production defaults are baked in so the tools work with zero configuration.
 */

const DEFAULTS = {
  WKND_CATALOG_BASE: 'https://wknd-aero-api.jaggah.workers.dev',
  WKND_B2B_BASE: 'https://wknd-b2b-api.jaggah.workers.dev',
  // The public production domain, not the internal `main--<repo>--<org>.aem.live`
  // alias: widget hosts (ChatGPT/Claude) enforce a CSP image/connect domain
  // allowlist declared in the LLM Apps UI, and only this domain is on it.
  WKND_EDS_BASE: 'https://wknd-adventures.run.place',
};

const FETCH_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Simple per-process cache. LLM App handlers are short-lived but warm instances
// reuse module state, so this saves repeat upstream calls within a session.
const cache = new Map();

/**
 * @param {object} [extra] handler `extra` arg
 * @param {string} name variable name
 * @returns {string}
 */
function getVar(extra, name) {
  const v = extra && extra.variables && extra.variables[name];
  return (typeof v === 'string' && v.trim()) ? v.trim().replace(/\/$/, '') : DEFAULTS[name];
}

/**
 * fetch JSON with a timeout. Throws on non-2xx or timeout.
 * @param {string} url
 * @returns {Promise<any>}
 */
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const norm = (v) => (typeof v === 'string' ? v.trim() : '');
const isSet = (v) => norm(v).length > 0 && norm(v).toLowerCase() !== 'null' && norm(v).toLowerCase() !== 'undefined';

// The Aero catalog worker syncs from the internal aem.live alias and bakes it into
// `images[].url` / `editorialUrl`, which the widget host's CSP does not allow —
// rewrite it to the configured production EDS base so those links/images resolve.
const INTERNAL_EDS_HOST = 'main--masterclass-demo--znikolovski.aem.live';
function toProdUrl(url, edsBase) {
  if (!isSet(url) || !url.includes(INTERNAL_EDS_HOST)) return url;
  try {
    return url.replace(INTERNAL_EDS_HOST, new URL(edsBase).host);
  } catch {
    return url;
  }
}

// The EDS query-index `title` is the page's SEO <title>/og:title, which carries a
// trailing brand suffix (e.g. "W Circuit: 9 Days, 115 km — WKND Adventures"). Strip
// it so structured tool output shows the clean adventure name, not the SEO title.
const BRAND_SUFFIX = /\s*[—-]\s*WKND Adventures\s*$/i;
const cleanTitle = (v) => norm(v).replace(BRAND_SUFFIX, '').trim();

// Map an EDS query-index `image` value (often "./media_xxx.jpg?..." possibly
// concatenated) to a single absolute URL.
function resolveImage(raw, base) {
  if (!isSet(raw)) return '';
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return (trimmed.match(/^https?:\/\/[^\s"'<>]+/i) || [''])[0];
  const m = trimmed.match(/\.?\/?media_[a-f0-9]+\.(?:jpe?g|png|webp|avif)(?:\?[^./\s"'<>]*)?/i);
  if (!m) return '';
  let path = m[0].replace(/^\.\//, '');
  if (!path.startsWith('/')) path = `/${path}`;
  return `${base}${path}`;
}

// Category (EDS adventureCategory) -> a human activity label, used only to fill
// `activity` for catalogue entries that have no authored mock record.
const CATEGORY_ACTIVITY = {
  trekking: 'Hiking',
  climbing: 'Climbing',
  cycling: 'Cycling',
  water: 'Water',
  desert: 'Desert Trekking',
  'winter-alpine': 'Winter Mountaineering',
  photography: 'Photography',
  'general-outdoor': 'Hiking',
};

/** merge an EDS query-index row (source of truth for scalars) into a record */
function applyIndexRow(rec, row, base) {
  const set = (k, v) => { if (isSet(v)) rec[k] = norm(v); };
  const title = cleanTitle(row.title);
  set('title', title);
  if (isSet(title)) rec.name = title;
  set('description', row.description);
  set('experience_level', row.experienceLevel);
  set('pace', row.pace);
  set('priority', row.priority);
  set('landscape', row.landscape);
  set('region', row.region);
  set('country', row.country);
  set('destination', row.placeName);
  set('duration', row.duration);
  set('category', row.adventureCategory);
  if (isSet(row.tripLengthDays) && Number.isFinite(Number(row.tripLengthDays))) {
    rec.trip_length_days = Number(row.tripLengthDays);
  }
  set('verified_status', row.verifiedStatus);
  const img = resolveImage(row.image, base);
  if (img) rec.image_url = img;
  if (!isSet(rec.activity) && isSet(row.adventureCategory)) {
    rec.activity = CATEGORY_ACTIVITY[norm(row.adventureCategory).toLowerCase()] || norm(row.adventureCategory);
  }
}

/** merge an Aero catalog entity (commerce fields) into a record */
function applyCatalogEntity(rec, e, edsBase) {
  if (isSet(e.name)) { rec.title = rec.title || e.name; rec.name = rec.name || e.name; }
  if (isSet(e.description) && !isSet(rec.description)) rec.description = e.description;
  if (Array.isArray(e.images) && e.images[0] && isSet(e.images[0].url) && !isSet(rec.image_url)) {
    rec.image_url = toProdUrl(e.images[0].url, edsBase);
  }
  if (e.price && Number.isFinite(Number(e.price.final))) {
    rec.price = { currency: e.price.currency || 'USD', final: Number(e.price.final) };
  }
  if (isSet(e.destinationIata)) rec.destination_iata = e.destinationIata;
  if (isSet(e.adventureCategory)) {
    if (!isSet(rec.category)) rec.category = e.adventureCategory;
    if (!isSet(rec.activity)) {
      rec.activity = CATEGORY_ACTIVITY[norm(e.adventureCategory).toLowerCase()] || norm(e.adventureCategory);
    }
  }
  if (isSet(e.editorialUrl)) rec.editorial_url = toProdUrl(e.editorialUrl, edsBase);
}

/**
 * Load the WKND adventure catalogue as an array of records in the shape the tools
 * expect. Real EDS/catalog data is merged over the supplied MOCK_DATA, keyed by
 * adventure_id, with EDS winning for scalars and the catalog adding commerce fields.
 * On any failure the mock data is returned unchanged.
 *
 * @param {object} [extra]
 * @param {object[]} [mockData]
 * @returns {Promise<object[]>}
 */
async function loadAdventures(extra, mockData = []) {
  const edsBase = getVar(extra, 'WKND_EDS_BASE');
  const catalogBase = getVar(extra, 'WKND_CATALOG_BASE');
  const cacheKey = `adventures:${edsBase}:${catalogBase}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const byId = new Map(mockData.map((r) => [r.adventure_id, { ...r }]));

  try {
    const [index, catalog] = await Promise.all([
      fetchJson(`${edsBase}/query-index.json?limit=1000`).catch(() => null),
      fetchJson(`${catalogBase}/catalog/adventures/index.json`).catch(() => null),
    ]);
    if (!index && !catalog) throw new Error('no upstream data');

    for (const row of (index && index.data) || []) {
      const path = norm(row.path);
      if (!/^\/blog\//.test(path)) continue;
      const id = path.replace(/^\/blog\//, '').replace(/\/$/, '');
      if (!id) continue;
      const rec = byId.get(id) || { adventure_id: id };
      applyIndexRow(rec, row, edsBase);
      byId.set(id, rec);
    }
    for (const e of (catalog && catalog.data) || []) {
      const id = norm(e.sku);
      if (!id) continue;
      const rec = byId.get(id) || { adventure_id: id };
      applyCatalogEntity(rec, e, edsBase);
      byId.set(id, rec);
    }

    const value = [...byId.values()];
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    return mockData;
  }
}

/**
 * Optional per-adventure tabular data (gear, permits, pack reference) authored in
 * an EDS spreadsheet published at /data/adventure-attributes.json. Returns a map
 * keyed by adventure_id, or an empty map if the sheet does not exist yet.
 * @param {object} [extra]
 * @returns {Promise<Record<string, object>>}
 */
async function loadAttributes(extra) {
  const edsBase = getVar(extra, 'WKND_EDS_BASE');
  const cacheKey = `attributes:${edsBase}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const out = {};
  try {
    const sheet = await fetchJson(`${edsBase}/data/adventure-attributes.json`);
    for (const row of (sheet && sheet.data) || []) {
      const id = norm(row.adventureId || row.adventure_id);
      if (!id) continue;
      const split = (v) => (isSet(v) ? norm(v).split(/\s*[;|]\s*/).filter(Boolean) : []);
      out[id] = {
        gear: split(row.gear),
        gear_by_category: isSet(row.gearByCategory) ? norm(row.gearByCategory) : '',
        permits: split(row.permits),
        access_notes: isSet(row.accessNotes) ? norm(row.accessNotes) : '',
        pack_reference_kg: Number.isFinite(Number(row.packReferenceKg)) ? Number(row.packReferenceKg) : null,
      };
    }
  } catch {
    // sheet not published yet — callers fall back to their own logic
  }
  cache.set(cacheKey, { at: Date.now(), value: out });
  return out;
}

/**
 * Real flight search for the access/logistics portion of permit planning.
 * @param {object} extra
 * @param {{from?: string, to: string, date?: string}} params
 * @returns {Promise<any|null>}
 */
async function searchFlights(extra, params) {
  const base = getVar(extra, 'WKND_CATALOG_BASE');
  const qs = new URLSearchParams();
  if (isSet(params.from)) qs.set('from', params.from);
  if (isSet(params.to)) qs.set('to', params.to);
  if (isSet(params.date)) qs.set('date', params.date);
  try {
    return await fetchJson(`${base}/api/flights/search?${qs.toString()}`);
  } catch {
    return null;
  }
}

/**
 * Submit a field contribution to the real WKND B2B forms endpoint.
 * @param {object} extra
 * @param {string} slug form slug (e.g. 'wknd-adventure-interest')
 * @param {object} fields
 * @returns {Promise<{ok: boolean, status?: number, body?: any, error?: string}>}
 */
async function submitForm(extra, slug, fields) {
  const base = getVar(extra, 'WKND_B2B_BASE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/forms/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: fields }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  loadAdventures,
  loadAttributes,
  searchFlights,
  submitForm,
  getVar,
  _internal: { resolveImage, applyIndexRow, applyCatalogEntity },
};
