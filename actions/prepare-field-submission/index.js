// The tool matches a contribution's destination/activity to a documented WKND route.
// Real route data comes from the WKND catalogue (EDS query-index + Aero catalog) via
// actions/lib/wknd.js; MOCK_DATA is the offline fallback. A real write path exists
// (lib.submitForm -> B2B forms API) but is intentionally not auto-invoked here — this
// tool *prepares* a package for editorial review rather than submitting it, and the
// B2B forms are contact/interest forms, not an editorial-submission schema.
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

const TYPE_LABELS = {
  'route story': 'Completed-route story',
  'route-story': 'Completed-route story',
  'completed-route story': 'Completed-route story',
  'field dispatch': 'Field dispatch',
  'gear reflection': 'Gear reflection',
  'route correction': 'Route correction',
  correction: 'Route correction',
};

function canonicalType(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return TYPE_LABELS[key] || String(raw || '').trim();
}

function firstSentence(text, maxLen) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const match = clean.match(/^.*?[.!?](\s|$)/);
  let out = match ? match[0].trim() : clean;
  if (out.length > maxLen) out = `${out.slice(0, maxLen - 1).trim()}…`;
  return out;
}

function findRoute(catalog, destination, activity) {
  const dest = String(destination || '').trim().toLowerCase();
  const act = String(activity || '').trim().toLowerCase();
  if (dest) {
    const byDest = catalog.find((a) => String(a.destination || '').toLowerCase() === dest)
      || catalog.find((a) => String(a.destination || '').toLowerCase().includes(dest))
      || catalog.find((a) => String(a.name || '').toLowerCase().includes(dest));
    if (byDest) return byDest;
  }
  if (act) {
    const byAct = catalog.find((a) => String(a.activity || '').toLowerCase() === act);
    if (byAct) return byAct;
  }
  return null;
}

function buildSections(type) {
  switch (type) {
    case 'Field dispatch':
      return ['Where & when', 'Conditions observed', 'What changed on the ground', 'Practical takeaways'];
    case 'Gear reflection':
      return ['Gear reviewed', 'How it was used', 'What held up / what failed', 'Recommendation'];
    case 'Route correction':
      return ['What the current guide states', 'The correction', 'Evidence for the change', 'Date verified'];
    default:
      return ['Overview & why this route', 'Route logistics and timeline', 'Stage or day breakdown', 'Conditions and resupply notes', 'Gear notes', 'Closing reflections'];
  }
}

const handler = async ({
  submission_type = '',
  draft_text = '',
  destination = '',
  activity = '',
  condition_date = '',
  contributor_bio = '',
  supporting_sources = [],
} = {}, extra) => {
  const emptyShape = {
    submission_type: null,
    proposed_title: null,
    destination: null,
    activity: null,
    condition_date: null,
    submission_summary: null,
    draft_sections: [],
    contributor_bio: null,
    evidence_checklist: [],
    missing_information: [],
    editorial_flags: [],
    readiness_status: null,
  };

  const missingRequired = [];
  if (!submission_type || typeof submission_type !== 'string' || !submission_type.trim()) missingRequired.push('submission_type');
  if (!draft_text || typeof draft_text !== 'string' || !draft_text.trim()) missingRequired.push('draft_text');
  if (!contributor_bio || typeof contributor_bio !== 'string' || !contributor_bio.trim()) missingRequired.push('contributor_bio');

  if (missingRequired.length > 0) {
    return {
      content: [{ type: 'text', text: `Please provide ${missingRequired.join(', ')} to prepare a WKND submission.` }],
      structuredContent: { ...emptyShape },
    };
  }

  const type = canonicalType(submission_type);
  const catalog = await loadAdventures(extra, MOCK_DATA);
  const route = findRoute(catalog, destination, activity);

  const resolvedDestination = String(destination || '').trim() || (route ? route.destination || route.name : '') || null;
  const resolvedActivity = String(activity || '').trim() || (route ? route.activity : '') || null;

  const lead = firstSentence(draft_text, 60);
  const proposed_title = route
    ? `${route.name} — ${type}`
    : (lead ? `${lead} — ${type}` : type);

  const summaryBase = firstSentence(draft_text, 220)
    || `A prepared ${type.toLowerCase()} for WKND Adventures.`;
  const submission_summary = resolvedDestination
    ? `${summaryBase}${/[.!?…]$/.test(summaryBase) ? '' : '.'} Route: ${resolvedDestination}${resolvedActivity ? ` (${resolvedActivity})` : ''}.`
    : summaryBase;

  const draft_sections = buildSections(type);

  const sources = Array.isArray(supporting_sources)
    ? supporting_sources.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
    : [];
  const evidence_checklist = sources.length > 0
    ? sources
    : ['Draft text on file'];

  const missing_information = [];
  if (!condition_date || !String(condition_date).trim()) missing_information.push('Date or date range the route/conditions were personally experienced');
  if (sources.length === 0) missing_information.push('Supporting evidence: dated photos, GPS tracks, coordinates, or official references');
  if (!resolvedDestination) missing_information.push('Relevant route or destination');
  if (!resolvedActivity) missing_information.push('Relevant outdoor activity');

  const editorial_flags = [];
  if (/\b(safe|safety|danger|risk|crossing|rescue|fatal|death|avalanche)\b/i.test(draft_text)) {
    editorial_flags.push('Safety statement in the draft requires editorial verification before publication');
  }
  if (/\b(permit|fee|price|cost|\$|€|£)\b/i.test(draft_text)) {
    editorial_flags.push('Permit fees / prices change — confirm current figures before publication');
  }
  if (type === 'Route correction') {
    editorial_flags.push('Factual correction — WKND editorial must verify against the current published guide');
  }
  if (condition_date && String(condition_date).trim()) {
    editorial_flags.push(`Conditions dated ${String(condition_date).trim()} may have changed since — flag time-sensitivity`);
  }
  if (editorial_flags.length === 0) {
    editorial_flags.push('No safety or factual claims auto-flagged — standard editorial review still applies');
  }

  const ready = missing_information.length === 0;
  const readiness_status = ready
    ? 'Ready to send — package appears complete pending WKND editorial review'
    : `Needs revision — add ${missing_information.length} missing detail(s) before sending`;

  const narrative = ready
    ? `Prepared a ${type.toLowerCase()} package${resolvedDestination ? ` for ${resolvedDestination}` : ''}. Evidence and dates are in place; ${editorial_flags.length} item(s) still need editorial verification. WKND retains full editorial control over whether the contribution is published or a correction is accepted.`
    : `Prepared a ${type.toLowerCase()} package${resolvedDestination ? ` for ${resolvedDestination}` : ''}. What's ready: the draft outline, contributor bio, and ${evidence_checklist.length} evidence item(s). What still needs evidence: ${missing_information.length} detail(s), and ${editorial_flags.length} claim(s) require editorial verification. WKND retains full editorial control over publication and correction decisions — preparing this package does not submit it or imply acceptance.`;

  return {
    content: [{ type: 'text', text: narrative }],
    // Detail concept — structuredContent IS the item (flat, no wrapper key).
    structuredContent: {
      submission_type: type,
      proposed_title,
      destination: resolvedDestination,
      activity: resolvedActivity,
      condition_date: String(condition_date || '').trim() || null,
      submission_summary,
      draft_sections,
      contributor_bio: contributor_bio.trim(),
      evidence_checklist,
      missing_information,
      editorial_flags,
      readiness_status,
    },
  };
};

module.exports = withAnalytics('prepare_field_submission', handler);

/*
 * TODO: Replace MOCK_DATA with a real API call.
 *
 * Suggested endpoint pattern (update based on actual site API):
 *   GET ${process.env.API_BASE_URL}/adventures?destination=${destination}&activity=${activity}
 *
 * Environment variables to configure:
 *   API_BASE_URL   Base URL of the website's API
 *   API_KEY        API key if required (add to .env and app.config.yaml)
 *
 * Authentication: check the website's developer docs or network requests
 *   captured during browsing for the correct auth header pattern.
 *
 * Example fetch:
 *   const res = await fetch(
 *     `${process.env.API_BASE_URL}/adventures?destination=${encodeURIComponent(destination)}`,
 *     { headers: { 'Authorization': `Bearer ${process.env.API_KEY}` } }
 *   )
 *   if (!res.ok) throw new Error(`API error: ${res.status}`)
 *   return await res.json()
 */
