// actions/build-route-briefing/index.js
// MCP tool handler for build_route_briefing.
//
// Detail / single-object concept: the tool resolves ONE route report and returns
// its briefing fields FLAT as structuredContent (no wrapper key). The widget reads
// `item = _result?.structuredContent || {}`, so every return path must be a plain
// object with the same field shape — `{}` on not-found / missing input.

// Route catalogue. Real data is loaded from the WKND catalogue (EDS query-index +
// Aero catalog) via actions/lib/wknd.js; MOCK_DATA is the offline fallback. Route
// detail comes from the published EDS article (facts blocks / planning bullets) and
// its trekking-planner fragment (day-by-day stages) via loadRouteDetail();
// BRIEFING_DETAIL holds curated editorial overrides keyed by adventure_id.
const { loadAdventures, findAdventure, loadRouteDetail } = require('../lib/wknd.js');
const { withAnalytics } = require('../lib/analytics.js');

const MOCK_DATA = [
  { adventure_id: 'patagonia-trek', name: 'W Circuit: 9 Days, 115 km', title: 'W Circuit: 9 Days, 115 km', description: 'A full field account of the W Circuit in Torres del Paine — permit strategy, daily stage breakdowns, and refugio conditions.', image_url: 'https://wknd-adventures.run.place/media_1e4b49be43a70d306b1c312d0d78dd369b5ccce40.jpg?width=1200&format=pjpg&optimize=medium', category: 'Hiking', activity: 'Hiking', landscape: 'Mountains', region: 'Americas', destination: 'Torres del Paine', country: 'Chile', experience_level: 'Advanced', pace: 'Endurance', priority: 'Physical challenge', trip_length_days: 9, duration: '9 days · 115 km', verified_status: 'Verified · February 2026', match_reason: 'A demanding multi-day mountain expedition for experienced parties who want documented permit and stage detail.' },
  { adventure_id: 'kayaking-norway', name: 'Lofoten Islands: Arctic Surfing at the Top of the World', title: 'Lofoten Islands: Arctic Surfing at the Top of the World', description: "Seven days surfing between the Lofoten peaks — cold-water preparation, swell windows, and why Unstad produces some of Europe's best Arctic waves.", image_url: 'https://wknd-adventures.run.place/media_1bd10685af4f3d38127de55d4da60d4ef86518b8d.jpg?width=1200&format=pjpg&optimize=medium', category: 'Surfing', activity: 'Surfing', landscape: 'Coast', region: 'Europe', destination: 'Lofoten Islands', country: 'Norway', experience_level: 'Advanced', pace: 'Adrenaline', priority: 'Solitude', trip_length_days: 7, duration: '7 days', verified_status: 'Verified · November 2025', match_reason: 'Cold-water surf expedition for confident surfers comfortable in serious neoprene and remote conditions.' },
  { adventure_id: 'alpine-cycling', name: 'Six Days Through the High Alps by Bike', title: 'Six Days Through the High Alps by Bike', description: 'A self-supported traverse of the highest road passes in the Alps — Galibier, Izoard, Telegraphe — with notes on resupply and surface conditions.', image_url: 'https://wknd-adventures.run.place/media_1e56ff87aeb7dc7d3d4eb4acd41d468f583a00303.jpg?width=1200&format=pjpg&optimize=medium', category: 'Cycling', activity: 'Cycling', landscape: 'Mountains', region: 'Europe', destination: 'French Alps', country: 'France', experience_level: 'Advanced', pace: 'Endurance', priority: 'Physical challenge', trip_length_days: 6, duration: '6 days', match_reason: 'High-pass road cycling for fit riders who want climb-by-climb resupply and surface beta.' },
  { adventure_id: 'surfing-costa-rica', name: 'Pavones & Playa Negra', title: "Pavones and Playa Negra: Finding Your Feet on Costa Rica's Breaks", description: "Choosing the right break, reading the reef, and understanding crowd dynamics at two of Costa Rica's most distinctive surf spots.", image_url: 'https://wknd-adventures.run.place/media_168d4df680b92c68b36d08772450bd3d2ec2d19ce.jpg?width=1200&format=pjpg&optimize=medium', category: 'Surfing', activity: 'Surfing', landscape: 'Tropics', region: 'Americas', destination: 'Pavones', country: 'Costa Rica', experience_level: 'Intermediate', pace: 'Immersive', priority: 'Culture', trip_length_days: 5, duration: 'Flexible', match_reason: 'Warm-water point-break guide suited to intermediate surfers wanting break selection and etiquette detail.' },
  { adventure_id: 'winter-mountaineering', name: 'Why Cold Routes Demand Warm Minds', title: 'Why Cold Routes Demand Warm Minds', description: 'A winter mountaineering primer on judgment, layering, and decision-making when cold routes raise the consequences.', image_url: 'https://wknd-adventures.run.place/media_12bab1a689efff46698aae2d4591400d1208853ff.avif?width=1200&format=pjpg&optimize=medium', category: 'Winter Mountaineering', activity: 'Winter Mountaineering', landscape: 'Mountains', region: 'Alpine', experience_level: 'Advanced', pace: 'Endurance', priority: 'Technical challenge', trip_length_days: 2, duration: '1–3 days', match_reason: 'Steep-snow and mixed-terrain guidance for experienced mountaineers heading into winter conditions.' },
  { adventure_id: 'yosemite-rock-climbing', name: 'First Light on the Valley', title: 'First Light on the Valley', description: "A beginner's guide to climbing in Yosemite Valley — where to start, what to expect, and how to build competence on granite.", image_url: 'https://wknd-adventures.run.place/media_13abc2aa7399e068d346e9f883c5be81f0bdfabf5.avif?width=1200&format=pjpg&optimize=medium', category: 'Climbing', activity: 'Climbing', landscape: 'Mountains', region: 'Americas', destination: 'Yosemite Valley', country: 'United States', experience_level: 'Beginner', pace: 'Immersive', priority: 'Skill-building', trip_length_days: 3, duration: 'Flexible', match_reason: 'Introductory Valley cragging for first-time climbers building rock skills on bolted terrain.' },
  { adventure_id: 'wild-swimming-guide', name: 'Reading a River', title: 'Reading a River', description: 'A wild-swimming guide to judging current, temperature, and entry points before you get in cold mountain water.', image_url: 'https://wknd-adventures.run.place/media_183099ae6d06ddd8bbd52f5416f41782c6d9af77c.jpg?width=1200&format=pjpg&optimize=medium', category: 'Wild Swimming', activity: 'Wild Swimming', landscape: 'Waterways', region: 'Mountains', experience_level: 'Beginner', pace: 'Slow & immersive', priority: 'Solitude', trip_length_days: 1, duration: 'Day trip', match_reason: 'Approachable water-safety guidance for newcomers to cold-water and river swimming.' },
  { adventure_id: 'desert-survival-guide', name: '48 Hours in the Sonoran', title: '48 Hours in the Sonoran', description: 'A field guide to desert survival drawn from time in the Sonoran — heat, water, and moving safely through extreme conditions.', image_url: 'https://wknd-adventures.run.place/media_13f721df562523f0924be582404e750aaffab42e1.jpg?width=1200&format=pjpg&optimize=medium', category: 'Desert Trekking', activity: 'Desert Trekking', landscape: 'Desert', region: 'Americas', destination: 'Sonoran Desert', country: 'United States', experience_level: 'Intermediate', pace: 'Endurance', priority: 'Solitude', trip_length_days: 2, duration: '48 hours', match_reason: 'Hot-desert travel skills for prepared trekkers managing heat and scarce water.' },
  { adventure_id: 'mountain-photography', name: 'The Camera on Your Back', title: 'The Camera on Your Back', description: 'An honest guide to carrying a camera in the mountains — what to bring, what it costs you, and whether the trade-off is worth it.', image_url: 'https://wknd-adventures.run.place/media_1133e47f59378ddc186f3a3f410745aa74c3102bd.jpg?width=1200&format=pjpg&optimize=medium', category: 'Photography', activity: 'Photography', landscape: 'Mountains', region: 'Alpine', experience_level: 'Intermediate', pace: 'Slow & immersive', priority: 'Photography', trip_length_days: 3, duration: 'Flexible', match_reason: 'For photographers weighing image-making against the physical burden of gear on the trail.' },
  { adventure_id: 'ultralight-backpacking', name: 'Sub-10 lb: What to Cut', title: 'Sub-10 lb: What to Cut, What to Keep', description: 'An ultralight backpacking guide on paring a base weight below ten pounds without cutting what keeps you safe.', image_url: 'https://wknd-adventures.run.place/media_11fea14b0a8da0dcbcde423d0b4a86d48016fed3b.avif?width=1200&format=pjpg&optimize=medium', category: 'Gear Guide', activity: 'Backpacking', landscape: 'Mixed', region: 'General', experience_level: 'Intermediate', pace: 'Endurance', priority: 'Comfort / weight', trip_length_days: 4, duration: 'Multi-day', match_reason: 'Weight-optimization principles for backpackers refining a multi-day kit.' },
];

// Report-supported briefing detail keyed by adventure_id. The catalog cards above
// carry the summary fields (title/region/activity/duration/verified_status); the
// deeper stage/logistics detail lives here, mirroring what each WKND report documents.
// Reports without documented stage-level detail intentionally omit an entry — the
// handler then returns empty arrays / null and surfaces that gap in missing_information.
const BRIEFING_DETAIL = {
  'patagonia-trek': {
    daily_stages: [
      'Laguna Amarga → Refugio Las Torres',
      'Base Torres mirador & return',
      'Los Cuernos → Francés valley',
      'Británico lookout & Paine Grande',
      'Grey glacier & refugio',
      'Grey → Paine Grande → catamaran',
      'Buffer / weather contingency day',
    ],
    access: 'Bus from Puerto Natales to Laguna Amarga, then park shuttle to Torres trailhead. Catamaran across Lago Pehoé links the west side.',
    permits: 'Park entry ticket required; refugio and camp bookings must be reserved in advance through Las Torres and Vertice operators.',
    water: 'Streams along the route are described as drinkable; carry capacity for the exposed stretch to Grey.',
    accommodation: 'Mix of refugios and designated campsites; some free CONAF camps, others paid and operator-run.',
    weather_window: 'Report frames November–March as the trekking season, with strong, shifting winds even at peak season.',
    hazards: [
      'Sudden high winds on exposed ridgelines',
      'Rapid weather changes near the glaciers',
      'River crossings after heavy rain',
    ],
    essential_gear: [
      'Waterproof shell & wind layer',
      'Sturdy broken-in boots',
      'Trekking poles',
      '2L+ water capacity',
      'Warm insulating midlayer',
    ],
    constraint: 'The biggest planning constraint is booking: refugios and campsites must be reserved in advance and fill early, so lock lodging before fixing dates.',
    verification_notes: [
      'Confirm refugio and campsite availability with operators before departure',
      'Recheck catamaran timetable — schedule changes seasonally',
    ],
    missing_information: [
      'Exact per-day distances and elevation gain',
      'Current park entry pricing',
    ],
  },
};

// Map article fact labels (adventure-facts rows, "Label: value" bullets) onto the
// briefing fields. First matching rule wins; unmatched facts become key_facts.
const FIELD_RULES = [
  ['essential_gear', /what to bring|what we carried|gear|pack|footwear|sun protection/i],
  ['access', /getting there|access|reachable|how to get|arriv/i],
  ['permits', /permit|entry fee|ticket/i],
  ['water', /^water|drinking/i],
  ['accommodation', /accommodation|lodging|where to stay|camps?$/i],
  ['weather_window', /best time|best season|season|weather|when to go/i],
  ['hazards', /safety|hazard|risk/i],
];
const LIST_FIELDS = ['hazards', 'essential_gear'];
const CONTINENT = /\b(Europe|Balkans|Asia|Africa|Americas|North America|South America|Oceania|Alpine|Arctic)\b/;

const uniq = (arr) => {
  const seen = new Set();
  return arr.filter((v) => {
    const k = String(v).toLowerCase();
    if (!v || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Turn the published article + planner fragment into briefing fields. */
function fromArticle(detail) {
  const out = {
    access: [], permits: [], water: [], accommodation: [], weather_window: [],
    hazards: [], essential_gear: [], key_facts: [], daily_stages: [],
  };
  if (!detail) return out;
  for (const { label, values } of detail.facts || []) {
    const rule = FIELD_RULES.find(([, re]) => re.test(label));
    if (!rule) {
      out.key_facts.push(`${label}: ${values.join('; ')}`);
    } else if (rule[0] === 'essential_gear') {
      values.forEach((v) => {
        // "Trekking poles, sunscreen, swimwear" is a list; prose stays whole with its label.
        const parts = v.split(/\s*,\s*/);
        if (parts.length > 1 && parts.every((x) => x.length <= 40 && !/[.]/.test(x))) out.essential_gear.push(...parts);
        else out.essential_gear.push(/what to bring|carried|gear|pack/i.test(label) ? v : `${label}: ${v}`);
      });
    } else if (rule[0] === 'hazards') {
      values.forEach((v) => out.hazards.push(...v.split(/\s*;\s*/)));
    } else {
      out[rule[0]].push(...values);
    }
  }
  for (const { heading, items } of detail.lists || []) {
    if (/carried|pack|gear|bring/i.test(heading)) out.essential_gear.push(...items);
    else {
      items.forEach((t) => (/\b(reachable|airport|flights?)\b/i.test(t) ? out.access : out.key_facts).push(t));
    }
  }
  const it = detail.itinerary;
  if (it && it.stages.length) {
    out.daily_stages = it.stages.map((st) => `${st.text.charAt(0).toUpperCase()}${st.text.slice(1)}${st.meta ? ` (${st.meta})` : ''}`);
    for (const note of it.notes) {
      if (/water/i.test(note)) out.water.push(note);
      else out.key_facts.push(note);
    }
    const km = it.stages.map((st) => Number((st.meta.match(/([\d.]+)\s*km/i) || [])[1]));
    out.itinerary_title = it.title.replace(/\s+[—–-]\s+.*$/, '');
    out.duration = `${it.stages.length} days${km.every(Number.isFinite) ? ` · ${km.reduce((a, b) => a + b, 0)} km` : ''}`;
  }
  out.region = ((detail.tagline || '').match(CONTINENT) || [])[1] || '';
  return out;
}

function buildBriefing(report, routeDetail) {
  const detail = BRIEFING_DETAIL[report.adventure_id] || {};
  const art = fromArticle(routeDetail);
  const sentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);
  const pickText = (k) => {
    if (detail[k]) return detail[k];
    const vals = uniq(art[k]);
    // drop a short value already contained in a longer one (e.g. "May–September")
    return vals.filter((v) => !vals.some((o) => o !== v && o.toLowerCase().includes(v.toLowerCase())))
      .map(sentence).join(' ');
  };
  const pickList = (k, max) => uniq(Array.isArray(detail[k]) && detail[k].length ? detail[k] : art[k]).slice(0, max);

  const briefing = {
    adventure_id: report.adventure_id,
    title: report.title || report.name || '',
    region: [report.destination, report.country].filter(Boolean).join(' · ') || report.region || art.region || '',
    activity: report.activity || report.category || '',
    duration: report.duration || (report.trip_length_days ? `${report.trip_length_days} days` : '') || art.duration || '',
    verified_status: report.verified_status || '',
    last_verified_date: (report.verified_status || '').replace(/^.*·\s*/, '') || '',
    daily_stages: pickList('daily_stages', 14),
    access: pickText('access'),
    permits: pickText('permits'),
    water: pickText('water'),
    accommodation: pickText('accommodation'),
    weather_window: pickText('weather_window'),
    hazards: pickList('hazards', 8),
    essential_gear: pickList('essential_gear', 12),
    key_facts: uniq(art.key_facts).slice(0, 10),
    verification_notes: Array.isArray(detail.verification_notes) ? detail.verification_notes.slice() : [],
    missing_information: Array.isArray(detail.missing_information) ? detail.missing_information.slice() : [],
    source_url: routeDetail ? routeDetail.source_url : '',
  };

  if (!detail.daily_stages && art.daily_stages.length) {
    briefing.verification_notes.push(`Stages come from the WKND ${art.itinerary_title || 'trekking planner'} — confirm camp and water availability before departure`);
  }
  if (!briefing.verification_notes.length && routeDetail) {
    briefing.verification_notes.push('Details are from the published WKND article — recheck seasonal access and opening times before departure');
  }
  // Say what the report does not document rather than inventing it.
  const gaps = [
    ['daily_stages', 'a day-by-day stage breakdown'], ['access', 'access / getting there'],
    ['permits', 'permits'], ['water', 'water sources'], ['accommodation', 'accommodation or camps'],
    ['weather_window', 'a weather window'],
  ].filter(([k]) => (Array.isArray(briefing[k]) ? !briefing[k].length : !briefing[k])).map(([, l]) => l);
  if (gaps.length) briefing.missing_information.push(`This report does not document ${gaps.join(', ')}.`);
  return briefing;
}

const handler = async (args, extra) => {
  const {
    adventure_id = '',
    travel_window = '',
    party_experience = '',
    briefing_depth = '',
  } = args || {};

  if (!adventure_id || !String(adventure_id).trim()) {
    return {
      content: [{ type: 'text', text: 'Please tell me which WKND route or expedition report to build a briefing for (a route title or id, e.g. "W Circuit").' }],
      structuredContent: {},
    };
  }

  // Resolve the route from the real WKND catalogue (EDS query-index + Aero catalog),
  // falling back to MOCK_DATA if the upstreams are unreachable. The narrative stage
  // detail is applied from BRIEFING_DETAIL by adventure_id in buildBriefing().
  const catalog = await loadAdventures(extra, MOCK_DATA);
  const report = findAdventure(catalog, adventure_id);

  if (!report) {
    return {
      content: [{ type: 'text', text: `I couldn't find a WKND report matching "${adventure_id}". Try one of the documented routes such as the W Circuit in Torres del Paine.` }],
      structuredContent: {},
    };
  }

  // Real published detail: facts from the EDS article and, where one exists, the
  // day-by-day itinerary from its trekking-planner fragment.
  const routeDetail = await loadRouteDetail(extra, report.adventure_id);
  const briefing = buildBriefing(report, routeDetail);

  const context = [
    travel_window && `travel window ${travel_window}`,
    party_experience && `party experience ${party_experience}`,
    briefing_depth && `depth ${briefing_depth}`,
  ].filter(Boolean).join(', ');

  const hasStages = briefing.daily_stages.length > 0;
  // Content guidance handoff: name the route's biggest planning constraint and the
  // detail to verify closest to departure — narrative for the model, not the widget DOM.
  const detail = BRIEFING_DETAIL[report.adventure_id];
  let constraint;
  if (detail && detail.constraint) constraint = detail.constraint;
  else if (hasStages) constraint = `The documented itinerary runs ${briefing.daily_stages.length} stages${briefing.water ? `; water: ${briefing.water.replace(/\.$/, '')}` : ''}.`;
  else constraint = 'This report is a destination guide rather than a logged itinerary — no day-by-day stages are documented, so plan the schedule from a primary source.';
  const verifyClosest = briefing.verification_notes.length
    ? ` Closest to departure, verify: ${briefing.verification_notes.join('; ')}.`
    : '';
  const facts = [briefing.access && `Access: ${briefing.access}`, briefing.weather_window && `When: ${briefing.weather_window}`,
    briefing.permits && `Permits: ${briefing.permits}`].filter(Boolean).join(' ');

  const summary = `Route briefing for ${briefing.title}${briefing.region ? ` (${briefing.region})` : ''}`
    + `${context ? ` — ${context}` : ''}. `
    + `${hasStages ? `${briefing.daily_stages.length} daily stages documented; ${briefing.verified_status || 'verification date not stated'}.` : `${briefing.verified_status || 'No verification date stated'}.`} `
    + `${constraint}${facts ? ` ${facts}` : ''}${verifyClosest}`;

  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: briefing,
  };
};

module.exports = withAnalytics('build_route_briefing', handler);
