// Reference routes the audit cites for route-specific necessities. Real route data
// comes from the WKND catalogue (EDS query-index + Aero catalog) via
// actions/lib/wknd.js; MOCK_DATA is the offline fallback. NOTE: MOCK_AUDIT below is
// still a representative audit — a genuine item-level computation from `items` is the
// remaining follow-up (see the note below the handler).
const { loadAdventures } = require('../lib/wknd.js');
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

// Representative audit result matching outputSchema. In production this is computed
// from the user's `items` against WKND route-specific principles.
const MOCK_AUDIT = {
  current_weight_grams: 11800,
  potential_weight_grams: 9450,
  estimated_savings_grams: 2350,
  category_breakdown: ['Shelter: 2100 g', 'Sleep system: 1850 g', 'Cook system: 1200 g', 'Clothing: 3100 g', 'Electronics: 900 g', 'Safety & navigation: 1450 g', 'Miscellaneous: 1200 g'],
  recommended_cuts: [
    "Second insulated jacket — 480 g — one puffy plus active layers covers the W Circuit's February range; a duplicate is redundant.",
    'Camp chair — 620 g — refugios and established campsites provide seating; comfort item, not route-required.',
    'Full-size camera tripod — 750 g — a compact tabletop mount saves ~600 g with minimal loss for trail photos.',
  ],
  possible_swaps: [
    'Swap 2-person tent for a solo trekking-pole shelter — saves ~650 g (evidence-backed: WKND ultralight guide).',
    'Swap canister stove + steel pot for a titanium integrated system — saves ~300 g.',
    'Swap cotton layers for merino/synthetic — saves ~250 g and dries faster.',
  ],
  safety_critical_items: [
    'Waterproof hardshell — Patagonian weather turns fast; non-negotiable.',
    'Headlamp + spare batteries — required for pre-dawn stage starts.',
    'First-aid kit and blister care — 9-day remote route.',
    'Navigation (map + compass or GPS) — refugio-to-refugio routefinding.',
  ],
  missing_essentials: [
    'No listed water treatment — add filter or tablets for a 9-day route.',
    'No emergency shelter/bivy noted.',
  ],
  assumptions: [
    'Weights estimated where the list omitted them.',
    'February Patagonian shoulder-season conditions assumed.',
  ],
};

const EMPTY_AUDIT = {
  current_weight_grams: null,
  potential_weight_grams: null,
  estimated_savings_grams: null,
  category_breakdown: [],
  recommended_cuts: [],
  possible_swaps: [],
  safety_critical_items: [],
  missing_essentials: [],
  assumptions: [],
};

const handler = async ({
  items = [],
  adventure_id = '',
  activity = '',
  duration_days,
  season = '',
  conditions = '',
  goal = '',
} = {}, extra) => {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      content: [{ type: 'text', text: 'Please provide a packing list (items) to audit.' }],
      structuredContent: { ...EMPTY_AUDIT },
    };
  }
  if (!activity || typeof activity !== 'string' || !activity.trim()) {
    return {
      content: [{ type: 'text', text: 'Please provide the primary activity for the trip.' }],
      structuredContent: { ...EMPTY_AUDIT },
    };
  }
  if (!Number.isFinite(duration_days) || duration_days <= 0) {
    return {
      content: [{ type: 'text', text: 'Please provide a valid duration_days for the trip.' }],
      structuredContent: { ...EMPTY_AUDIT },
    };
  }

  // Preserve the referenced route (if any) so route-specific necessities stay in scope.
  const catalog = await loadAdventures(extra, MOCK_DATA);
  const route = adventure_id
    ? catalog.find((r) => r.adventure_id === adventure_id)
    : null;

  // Representative audit result. A real item-level computation from `items` (summing
  // weights, matching cuts/swaps against route necessities) is the remaining follow-up.
  const audit = MOCK_AUDIT;

  const savingsKg = (audit.estimated_savings_grams / 1000).toFixed(1);
  const dangerNote = audit.missing_essentials && audit.missing_essentials.length
    ? ` Dangerous omission to fix first: ${audit.missing_essentials[0]}`
    : '';
  const routeNote = route ? ` against the ${route.name} route.` : '.';
  const summary = `Audited ${items.length} item(s) for a ${duration_days}-day ${activity.trim()} trip${routeNote} `
    + `Biggest realistic saving is the shelter swap (~${savingsKg} kg total identified). `
    + `Swaps marked "evidence-backed" follow WKND's ultralight guidance; unlabeled cuts are personal-judgment calls — `
    + `keep every safety-critical item.${dangerNote}`;

  return {
    content: [{ type: 'text', text: summary }],
    // Detail concept — structuredContent is the flat audit object (no wrapper key).
    structuredContent: {
      current_weight_grams: audit.current_weight_grams,
      potential_weight_grams: audit.potential_weight_grams,
      estimated_savings_grams: audit.estimated_savings_grams,
      category_breakdown: audit.category_breakdown,
      recommended_cuts: audit.recommended_cuts,
      possible_swaps: audit.possible_swaps,
      safety_critical_items: audit.safety_critical_items,
      missing_essentials: audit.missing_essentials,
      assumptions: audit.assumptions,
    },
  };
};

module.exports = withAnalytics('audit_pack_weight', handler);

/*
 * TODO: Replace MOCK_AUDIT/MOCK_DATA with a real audit computation + API call.
 *
 * Suggested pattern (update based on actual site API):
 *   GET ${process.env.API_BASE_URL}/adventures/${adventure_id}
 *   Then compute weight totals from the user-supplied `items` and diff against
 *   the route's required-gear list.
 *
 * Environment variables to configure:
 *   API_BASE_URL   Base URL of the WKND API
 *   API_KEY        API key if required (add to .env and app.config.yaml)
 *
 * Example fetch:
 *   const res = await fetch(
 *     `${process.env.API_BASE_URL}/adventures/${encodeURIComponent(adventure_id)}`,
 *     { headers: { Authorization: `Bearer ${process.env.API_KEY}` } }
 *   )
 *   if (!res.ok) throw new Error(`API error: ${res.status}`)
 *   return await res.json()
 */
