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

/**
 * fetch text (HTML) with a timeout. Throws on non-2xx or timeout.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html' } });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return await res.text();
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
 * Resolve a user/model-supplied adventure reference (id, title, or place name such as
 * "Ohrid") to one catalogue record. Exact id/title/name wins, then a record whose
 * id/title/name/destination contains every meaningful word of the query. Never falls
 * back to an unrelated record (e.g. the first one with the same activity).
 * @param {object[]} catalog
 * @param {string} query
 * @returns {object|null}
 */
function findAdventure(catalog, query) {
  const q = norm(query).toLowerCase();
  if (!q || !Array.isArray(catalog)) return null;
  const fields = (r) => [r.adventure_id, r.title, r.name, r.destination, r.country]
    .filter(Boolean).map((v) => String(v).toLowerCase());
  const exact = catalog.find((r) => fields(r).slice(0, 3).includes(q));
  if (exact) return exact;
  const words = q.split(/[^a-z0-9\u00c0-\u024f]+/).filter((w) => w.length >= 3);
  if (!words.length) return null;
  const matches = catalog.filter((r) => {
    const hay = fields(r).join(' ').replace(/-/g, ' ');
    return words.every((w) => hay.includes(w));
  });
  // Several articles can share a place name (three Ohrid stories) — prefer the
  // bookable Aero catalogue product, which is "the adventure".
  return matches.find((r) => r.price) || matches[0] || null;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const stripHtml = (h) => decodeEntities(String(h).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const liTexts = (h) => [...String(h).matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
const mainOf = (html) => (String(html).match(/<main>([\s\S]*?)<\/main>/) || [null, String(html)])[1];

/**
 * Extract the planning facts an EDS adventure article publishes: the
 * `adventure-facts` block (label → bullet values), "Label: value" bullets under
 * headings (Plan Your Visit, Fast Facts, What to Pack…), plain bullet lists under
 * headings (What We Carried, Quick Facts), the hero tagline and the Target CTA
 * location prefix (used to find the article's trekking-planner fragment).
 * Lists containing links (More Stories / In the Field teasers) are ignored.
 * @param {string} html full page or .plain.html markup
 */
function parseArticle(html) {
  const main = mainOf(html);
  const facts = [];
  const lists = [];

  const fi = main.indexOf('class="adventure-facts"');
  if (fi >= 0) {
    const rest = main.slice(fi + 23);
    const end = rest.search(/<div class="|<\/main>/);
    const block = end >= 0 ? rest.slice(0, end) : rest;
    for (const m of block.matchAll(/<div>\s*<div>([^<]+?)<\/div>\s*<div>([\s\S]*?)<\/div>\s*<\/div>/g)) {
      const items = liTexts(m[2]).map(stripHtml).filter(Boolean);
      const values = items.length ? items : [stripHtml(m[2])].filter(Boolean);
      if (values.length) facts.push({ label: stripHtml(m[1]), values, heading: 'Useful information' });
    }
  }

  for (const m of main.matchAll(/<h([23])[^>]*>((?:(?!<\/?h[1-6])[\s\S])*?)<\/h\1>\s*<ul>([\s\S]*?)<\/ul>/g)) {
    if (/<a\s/i.test(m[2]) || /<a\s/i.test(m[3])) continue;
    const heading = stripHtml(m[2]);
    const items = [];
    for (const li of liTexts(m[3])) {
      const strong = li.match(/^\s*<strong>([\s\S]*?)<\/strong>\s*:?\s*([\s\S]*)$/);
      const text = stripHtml(li);
      const kv = text.match(/^([A-Z][^:]{1,30}):\s+(.+)$/);
      if (strong && stripHtml(strong[2])) {
        facts.push({ label: stripHtml(strong[1]).replace(/:$/, ''), values: [stripHtml(strong[2])], heading });
      } else if (kv) {
        facts.push({ label: kv[1].trim(), values: [kv[2].trim()], heading });
      } else if (text) {
        items.push(text);
      }
    }
    if (items.length) lists.push({ heading, items });
  }

  const hero = main.match(/class="hero-adventure"[\s\S]*?<div>\s*<div>([^<]+)<\/div>\s*<div>\s*<h1/);
  const target = main.match(/data-targetlocation="([a-z0-9-]+?)-cta-mbox"/);
  return {
    facts,
    lists,
    tagline: hero ? stripHtml(hero[1]) : '',
    target_prefix: target ? target[1] : null,
  };
}

/**
 * Extract a day-by-day itinerary from a `<prefix>-cf-trekking-planner` fragment,
 * e.g. "Day 1 (16km, moderate): Velestovo to the ridge camp at 1,800m." The
 * remaining sentences (water, elevation gain…) are returned as notes.
 * @param {string} html
 */
function parseItinerary(html) {
  const main = mainOf(html);
  const title = stripHtml((main.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [null, ''])[1]);
  const para = [...main.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => stripHtml(m[1]))
    .find((t) => /\bDay\s+\d+\s*\(/.test(t));
  if (!para) return null;
  const stages = [];
  const rest = para.replace(/Day\s+(\d+)\s*\(([^)]*)\):\s*([^.]+)\.\s*/g, (m, n, meta, text) => {
    stages.push({ day: Number(n), meta: meta.trim(), text: text.trim() });
    return '';
  });
  if (!stages.length) return null;
  const notes = rest.split(/(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
  return { title, stages, notes };
}

/**
 * Load the real published route detail for an adventure: facts parsed from the
 * EDS article (/blog/<id>) plus, when one exists, the day-by-day itinerary from its
 * trekking-planner fragment (/fragments/<id|target-prefix>-cf-trekking-planner).
 * Returns null when the article cannot be fetched.
 * @param {object} [extra]
 * @param {string} adventureId
 */
async function loadRouteDetail(extra, adventureId) {
  const id = norm(adventureId);
  if (!/^[a-z0-9-]+$/i.test(id)) return null;
  const edsBase = getVar(extra, 'WKND_EDS_BASE');
  const cacheKey = `route:${edsBase}:${id}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value = null;
  try {
    const article = parseArticle(await fetchText(`${edsBase}/blog/${id}`));
    const prefixes = [...new Set([id, article.target_prefix].filter(Boolean))];
    let itinerary = null;
    for (const p of prefixes) {
      // eslint-disable-next-line no-await-in-loop
      const html = await fetchText(`${edsBase}/fragments/${p}-cf-trekking-planner`).catch(() => null);
      itinerary = html ? parseItinerary(html) : null;
      if (itinerary) break;
    }
    value = { ...article, itinerary, source_url: `${edsBase}/blog/${id}` };
  } catch {
    value = null;
  }
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
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
  findAdventure,
  loadRouteDetail,
  loadAttributes,
  searchFlights,
  submitForm,
  getVar,
  _internal: {
    resolveImage, applyIndexRow, applyCatalogEntity, parseArticle, parseItinerary,
  },
};
