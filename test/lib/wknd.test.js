// test/lib/wknd.test.js — offline tests for route matching and article parsing
const { findAdventure, _internal } = require('../../actions/lib/wknd.js');
const { auditItems } = require('../../actions/audit-pack-weight/index.js');

const { parseArticle, parseItinerary } = _internal;

describe('discovery page metadata', () => {
  test('reads authored metadata even when the query index is missing those fields', () => {
    const rec = { adventure_id: 'ohrid', category: 'general-outdoor' };
    _internal.applyPageMetadata(rec, `<html><head>
      <meta content="trekking, kayaking, photography" name="adventurecategory">
      <meta name='region' content='Europe'>
      <meta name="experiencelevel" content="Beginner to Intermediate">
      <meta name="placename" content="Lake &#x26; town">
    </head><body><p>Advanced trips elsewhere.</p></body></html>`, 'https://example.com');
    expect(rec).toMatchObject({
      category: 'trekking, kayaking, photography', region: 'Europe',
      experience_level: 'Beginner to Intermediate', destination: 'Lake & town',
    });
  });

  test('does not infer beginner suitability from prose or unrelated metadata', () => {
    const rec = { adventure_id: 'unknown' };
    _internal.applyPageMetadata(rec, '<html><head><meta name="description" content="Not for beginners"></head><body><p>Beginner</p></body></html>', 'https://example.com');
    expect(rec.experience_level).toBeUndefined();
  });

  test('uses an explicit hero continent for records without a region', () => {
    const rec = { adventure_id: 'ohrid' };
    _internal.applyPageMetadata(rec, ARTICLE, 'https://example.com');
    expect(rec.region).toBe('Europe');
  });
});

describe('live discovery catalog', () => {
  const originalFetch = global.fetch;
  let loadAdventures;
  beforeEach(() => {
    jest.isolateModules(() => {
      ({ loadAdventures } = require('../../actions/lib/wknd.js'));
    });
  });
  afterEach(() => { global.fetch = originalFetch; });

  test('only lists upstream records, enriches metadata, and caches the result', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('query-index')) return { ok: true, json: async () => ({ data: [{ path: '/blog/live', title: 'Live' }] }) };
      if (url.includes('index.json')) return { ok: true, json: async () => ({ data: [{ sku: 'live', adventureCategory: 'water' }] }) };
      return { ok: true, text: async () => '<head><meta name="region" content="Europe"><meta name="experiencelevel" content="Beginner"></head>' };
    });
    const fallback = [{ adventure_id: 'unpublished' }, { adventure_id: 'live', duration: 'Day trip' }];
    const out = await loadAdventures({}, fallback, { includePageMetadata: true });
    expect(out).toEqual([expect.objectContaining({
      adventure_id: 'live', region: 'Europe', experience_level: 'Beginner', duration: 'Day trip',
    })]);
    expect(await loadAdventures({}, fallback, { includePageMetadata: true })).toEqual(out);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('a published empty catalog does not become an offline catalog', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));
    expect(await loadAdventures({}, [{ adventure_id: 'unpublished' }])).toEqual([]);
  });

  test('general outdoor is not misclassified as hiking', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true, json: async () => ({ data: [{ sku: 'city', adventureCategory: 'general-outdoor' }] }),
    }));
    const out = await loadAdventures();
    expect(out[0].activity).toBe('General Outdoor');
  });

  test('never uses mock suitability when published level metadata is absent', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('/blog/')) return { ok: true, text: async () => '<head></head>' };
      return { ok: true, json: async () => ({ data: [{ sku: 'live', adventureCategory: 'water' }] }) };
    });
    const out = await loadAdventures({}, [{ adventure_id: 'live', experience_level: 'Beginner' }], {
      includePageMetadata: true,
    });
    expect(out[0].experience_level).toBeUndefined();
  });

  test('discovery reports upstream failure instead of returning a mock catalog', async () => {
    global.fetch = jest.fn(async () => { throw new Error('Unavailable'); });
    await expect(loadAdventures({}, [{ adventure_id: 'offline' }], {
      includePageMetadata: true, allowOfflineFallback: false,
    })).rejects.toThrow('Unable to load the published WKND adventure catalog');
  });
});

const CATALOG = [
  { adventure_id: 'patagonia-trek', title: 'W Circuit: 9 Days, 115 km', activity: 'Hiking' },
  { adventure_id: 'ohrid-city-of-thousand-churches', title: 'Ohrid: City of a Thousand Churches', activity: 'Hiking' },
  { adventure_id: 'ohrid-macedonia', title: 'Ohrid, North Macedonia', activity: 'Hiking', price: { final: 900 } },
];

describe('findAdventure', () => {
  test('a place name never falls back to an unrelated route with the same activity', () => {
    const r = findAdventure(CATALOG, 'Ohrid');
    expect(r.adventure_id).toMatch(/^ohrid/);
    expect(r.adventure_id).toBe('ohrid-macedonia'); // bookable product preferred
  });
  test('exact id wins', () => {
    expect(findAdventure(CATALOG, 'ohrid-city-of-thousand-churches').adventure_id)
      .toBe('ohrid-city-of-thousand-churches');
  });
  test('activity alone does not match a route', () => {
    expect(findAdventure(CATALOG, 'hiking')).toBeNull();
  });
});

const ARTICLE = `<main>
<div><div class="hero-adventure"><div><div><picture></picture></div></div>
<div><div>Destination Guide · Europe · Trekking</div><div><h1 id="x">Ohrid</h1></div></div></div></div>
<div class="secondary"><div class="adventure-facts">
  <div><div><h2 id="u">Useful information</h2></div></div>
  <div><div>Permits</div><div><ul><li>Carry your passport</li></ul></div></div>
</div></div>
<div class="secondary">
  <h3 id="plan">Plan Your Visit</h3>
  <ul>
    <li><strong>Getting there:</strong> Flights to Skopje</li>
    <li>Altitude: 695 m</li>
  </ul>
</div>
<div data-targetzone="on" data-targetlocation="ohrid-cta-mbox"></div>
<h2 id="more">More Stories</h2>
<h3><a href="/blog/patagonia-trek">W Circuit</a></h3><ul><li>teaser</li></ul>
</main>`;

describe('parseArticle / parseItinerary', () => {
  test('extracts facts blocks, labelled bullets, tagline and target prefix — not teasers', () => {
    const a = parseArticle(ARTICLE);
    expect(a.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Permits', values: ['Carry your passport'] }),
      expect.objectContaining({ label: 'Getting there', values: ['Flights to Skopje'] }),
      expect.objectContaining({ label: 'Altitude', values: ['695 m'] }),
    ]));
    expect(JSON.stringify(a)).not.toMatch(/W Circuit|teaser/);
    expect(a.tagline).toContain('Europe');
    expect(a.target_prefix).toBe('ohrid');
  });

  test('parses day-by-day stages and notes from a planner fragment', () => {
    const it = parseItinerary('<main><h2>Galichica traverse</h2><p>Crosses to Prespa. Day 1 (16km, moderate): Velestovo to the ridge camp at 1,800m. Day 2 (22km, strenuous): full ridge traverse. Water at the lower camp.</p></main>');
    expect(it.stages).toEqual([
      { day: 1, meta: '16km, moderate', text: 'Velestovo to the ridge camp at 1,800m' },
      { day: 2, meta: '22km, strenuous', text: 'full ridge traverse' },
    ]);
    expect(it.notes).toEqual(['Crosses to Prespa.', 'Water at the lower camp.']);
  });

  test('no itinerary paragraph returns null', () => {
    expect(parseItinerary('<main><p>Just prose.</p></main>')).toBeNull();
  });
});

describe('auditItems', () => {
  const ctx = {
    days: 3, activity: 'Hiking', routeName: 'Ohrid, North Macedonia', routeGear: [],
  };
  test('totals come from the supplied items, with no other route leaking in', () => {
    const a = auditItems([
      { name: 'Backpack', weight_grams: 1200 },
      { name: 'Puffy jacket', weight_grams: 400 },
      { name: 'Puffy jacket', weight_grams: 350 },
      { name: 'Camp chair', weight_grams: 620 },
    ], ctx);
    expect(a.current_weight_grams).toBe(2570);
    expect(JSON.stringify(a)).not.toMatch(/W Circuit|Patagonia|Torres/);
    expect(a.estimated_savings_grams).toBeGreaterThan(0);
    expect(a.missing_essentials.join(' ')).toMatch(/water/i);
  });
});
