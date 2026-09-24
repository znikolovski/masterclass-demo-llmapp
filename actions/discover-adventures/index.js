// Real data comes from the WKND catalogue (EDS query-index + Aero catalog) via
// actions/lib/wknd.js. MOCK_DATA is retained as the offline fallback used when the
// upstream APIs are unreachable. See the note below the handler.
const { loadAdventures } = require('../lib/wknd.js');

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

const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

module.exports = async ({ activity = '', experience_level = '', landscape = '', pace = '', priority = '', trip_length_days, region = '' } = {}, extra) => {
  if (!activity || typeof activity !== 'string' || !activity.trim()) {
    return {
      content: [{ type: 'text', text: 'Please provide an activity (e.g. hiking, surfing, cycling) to match adventures.' }],
      // structuredContent.adventures — bare array outputSchema; key derived from actionName "discover_adventures"
      structuredContent: { adventures: [] },
    };
  }
  if (!experience_level || typeof experience_level !== 'string' || !experience_level.trim()) {
    return {
      content: [{ type: 'text', text: 'Please provide an experience_level (e.g. beginner, intermediate, advanced) to match adventures.' }],
      structuredContent: { adventures: [] },
    };
  }

  const activityQ = norm(activity);
  const levelQ = norm(experience_level);
  const landscapeQ = norm(landscape);
  const paceQ = norm(pace);
  const priorityQ = norm(priority);
  const regionQ = norm(region);
  const maxDays = Number.isFinite(Number(trip_length_days)) && Number(trip_length_days) > 0 ? Number(trip_length_days) : null;

  const matchesActivity = (a) => {
    const act = norm(a.activity);
    if (!act) return false; // never match records with no activity on a blank prefix
    return act.includes(activityQ) || activityQ.includes(act);
  };

  const catalog = await loadAdventures(extra, MOCK_DATA);

  let results = catalog.filter((a) => {
    if (!matchesActivity(a)) return false;
    if (landscapeQ && norm(a.landscape) !== landscapeQ) return false;
    if (regionQ && !norm(a.region).includes(regionQ) && !norm(a.destination).includes(regionQ) && !norm(a.country).includes(regionQ)) return false;
    if (maxDays !== null && Number.isFinite(Number(a.trip_length_days)) && Number(a.trip_length_days) > maxDays) return false;
    return true;
  });

  // Score by how well the softer preferences line up, so the strongest match leads.
  const score = (a) => {
    let s = 0;
    if (norm(a.experience_level) === levelQ) s += 3;
    if (paceQ && norm(a.pace).includes(paceQ)) s += 2;
    if (priorityQ && norm(a.priority).includes(priorityQ)) s += 2;
    if (landscapeQ && norm(a.landscape) === landscapeQ) s += 1;
    if (regionQ && norm(a.region).includes(regionQ)) s += 1;
    return s;
  };
  results = results
    .map((a) => ({ a, s: score(a) }))
    .sort((x, y) => y.s - x.s)
    .map((x) => x.a);

  const adventures = results.map((a) => ({
    adventure_id: a.adventure_id,
    title: a.title,
    region: a.region,
    activity: a.activity,
    duration: a.duration,
    experience_level: a.experience_level,
    physical_demand: a.physical_demand ?? null,
    technical_skill: a.technical_skill ?? null,
    remoteness: a.remoteness ?? null,
    verified_status: a.verified_status ?? '',
    match_reason: a.match_reason,
    summary: a.description ?? '',
    image_url: a.image_url,
  }));

  if (adventures.length === 0) {
    return {
      content: [{ type: 'text', text: `No published WKND adventures matched ${activity} at the ${experience_level} level with those preferences. Try widening the activity, region, or available time.` }],
      structuredContent: { adventures: [] },
    };
  }

  const lead = adventures[0];
  const summary = `Found ${adventures.length} WKND ${activity} adventure${adventures.length === 1 ? '' : 's'} suited to an ${experience_level} traveler — ${lead.title} leads the list because it best fits your stated pace, priority, and available time. Review current terrain and weather conditions before committing to any route.`;

  return {
    content: [{ type: 'text', text: summary }],
    // structuredContent.adventures — bare array outputSchema; key derived from actionName "discover_adventures"
    structuredContent: { adventures },
  };
};

/*
 * Data source (real): actions/lib/wknd.js `loadAdventures(extra, MOCK_DATA)`.
 * It merges the WKND catalogue keyed by adventure_id:
 *   - EDS query-index  ${WKND_EDS_BASE}/query-index.json     — editorial scalars
 *       (experienceLevel, pace, priority, landscape, region, country, duration,
 *        tripLengthDays, verifiedStatus) authored in each page's Metadata block
 *   - Aero catalog     ${WKND_CATALOG_BASE}/catalog/adventures/index.json — commerce
 *       fields (name, description, image, price, destinationIata, editorialUrl)
 * EDS wins for scalars; MOCK_DATA fills any gaps and is the fallback when both
 * upstreams are unreachable. Base URLs come from extra.variables (WKND_EDS_BASE,
 * WKND_CATALOG_BASE) with production defaults baked into the lib.
 */
