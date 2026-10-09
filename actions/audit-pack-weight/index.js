// Audits the user's actual packing list: totals the supplied (or estimated) item
// weights by category, flags comfort cuts and duplicates, proposes lighter swaps for
// heavy items, and checks for missing essentials. The referenced route is resolved
// from the WKND catalogue (EDS query-index + Aero catalog) via actions/lib/wknd.js;
// MOCK_DATA is the offline fallback. Nothing route-specific is invented — a route
// only contributes its name and any gear published in the adventure-attributes sheet.
const { loadAdventures, loadAttributes, findAdventure } = require('../lib/wknd.js');
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

// Classification rules, first match wins. `estimate` (grams per unit) is used only when
// the list gives no weight; `cut` marks comfort items; `swap` proposes a lighter
// equivalent once the item is heavier than `above` grams; `safety` items are never cut.
const RULES = [
  { key: 'emergency', category: 'Safety & navigation', re: /emergency (bivy|bivvy|blanket|shelter)|space blanket|survival bag/, estimate: 150, safety: 'emergency shelter if someone is injured or benighted' },
  { key: 'first_aid', category: 'Safety & navigation', re: /first.?aid|medical kit|blister/, estimate: 250, safety: 'first-aid and blister care' },
  { key: 'headlamp', category: 'Safety & navigation', re: /head ?lamp|head ?torch|flashlight|torch/, estimate: 90, safety: 'light for early starts or getting caught out after dark' },
  { key: 'navigation', category: 'Safety & navigation', re: /\bmaps?\b|compass|\bgps\b|satellite|inreach|\bplb\b|beacon/, estimate: 120, safety: 'navigation and emergency communication' },
  { key: 'whistle', category: 'Safety & navigation', re: /whistle/, estimate: 10, safety: 'signalling for help' },
  { key: 'tent', category: 'Shelter', re: /tent|tarp|bivy|bivvy|hammock|shelter/, estimate: 1800, dupe: true, swap: { above: 1300, target: 'an ultralight 1-person tent or trekking-pole shelter', targetGrams: 900 } },
  { key: 'sleeping_bag', category: 'Sleep system', re: /sleeping bag|quilt/, estimate: 1100, dupe: true, swap: { above: 1000, target: 'a down quilt of the same temperature rating', targetGrams: 700 } },
  { key: 'pad', category: 'Sleep system', re: /sleeping pad|sleep pad|sleeping mat|\bmat\b|mattress/, estimate: 550, dupe: true, swap: { above: 500, target: 'an inflatable ultralight pad', targetGrams: 350 } },
  { key: 'pillow', category: 'Sleep system', re: /pillow/, estimate: 120, cut: 'a stuff sack filled with spare clothing does the same job' },
  { key: 'stove', category: 'Cook system', re: /stove|burner/, estimate: 350, dupe: true, swap: { above: 200, target: 'a minimalist canister-top stove', targetGrams: 90 } },
  { key: 'fuel', category: 'Cook system', re: /fuel|canister|\bgas\b/, estimate: 360 },
  { key: 'pot', category: 'Cook system', re: /\bpots?\b|\bpan\b|cookset|cook set|kettle|\bmug\b|\bcup\b/, estimate: 300, swap: { above: 250, target: 'a single titanium pot', targetGrams: 120 } },
  { key: 'utensil', category: 'Cook system', re: /spork|spoon|fork|utensil/, estimate: 20 },
  { key: 'water_treatment', category: 'Water', re: /filter|purif|tablets|steripen|uv pen/, estimate: 90, safety: 'safe drinking water' },
  { key: 'water_container', category: 'Water', re: /bottle|bladder|reservoir|hydration|flask/, estimate: 150, swap: { above: 250, target: 'a 1 L soft flask or recycled PET bottle', targetGrams: 40 } },
  { key: 'food', category: 'Food', re: /food|meal|snack|\bbars?\b|ration|dehydrated/, estimate: 700, consumable: true },
  { key: 'shell', category: 'Clothing', re: /rain|hard ?shell|\bshell\b|waterproof|poncho/, estimate: 400, safety: 'waterproof protection against wind and rain' },
  { key: 'cotton', category: 'Clothing', re: /cotton|jeans|denim|hoodie/, estimate: 600, swap: { above: 0, target: 'a merino or synthetic equivalent', ratio: 0.6, note: 'and it dries faster' } },
  { key: 'insulation', category: 'Clothing', re: /puffy|down jacket|insulated|synthetic jacket|insulation/, estimate: 450, dupe: true, insulation: true },
  { key: 'fleece', category: 'Clothing', re: /fleece|mid ?layer/, estimate: 350, insulation: true },
  { key: 'clothing', category: 'Clothing', re: /shirt|tee\b|base ?layer|thermal|legging|trousers|pants|shorts|socks|underwear|gloves|mitts|\bhat\b|beanie|buff|jacket|vest/, estimate: 200 },
  { key: 'footwear', category: 'Footwear', re: /boots?\b|shoes?\b|sandals?|trail runners?|gaiters?/, estimate: 900, swap: { above: 1400, target: 'trail runners (if the terrain allows)', targetGrams: 750 } },
  { key: 'backpack', category: 'Packs & storage', re: /backpack|rucksack|\bpack\b/, estimate: 1600, dupe: true, swap: { above: 1800, target: 'a frameless or lightweight framed pack', targetGrams: 1100 } },
  { key: 'storage', category: 'Packs & storage', re: /dry ?bag|stuff sack|pack liner|rain cover/, estimate: 80 },
  { key: 'tripod', category: 'Electronics', re: /tripod/, estimate: 750, cut: 'a compact tabletop mount or a rock does the job for trail photos' },
  { key: 'luxury_tech', category: 'Electronics', re: /drone|speaker|laptop|tablet|ipad/, estimate: 600, cut: 'comfort item, not needed for the route' },
  { key: 'electronics', category: 'Electronics', re: /phone|power ?bank|battery|charger|cable|camera|e-?reader|kindle|watch|radio/, estimate: 200 },
  { key: 'sun', category: 'Personal care', re: /sunscreen|\bspf\b|sunglasses|sun ?hat|lip balm/, estimate: 100 },
  { key: 'towel', category: 'Personal care', re: /towel/, estimate: 350, swap: { above: 200, target: 'a microfibre towel', targetGrams: 90 } },
  { key: 'toiletries', category: 'Personal care', re: /toothbrush|toothpaste|toiletr|soap|toilet paper|trowel|sanitiser|sanitizer|wipes/, estimate: 150 },
  { key: 'comfort', category: 'Miscellaneous', re: /chair|stool|camp table|book|novel|paperback|guitar|lantern|cast iron|hatchet|\baxe\b|machete|cooler/, estimate: 600, cut: 'comfort item, not route-required' },
  { key: 'poles', category: 'Miscellaneous', re: /trekking poles?|hiking poles?|\bpoles?\b/, estimate: 450 },
  { key: 'knife', category: 'Miscellaneous', re: /knife|multi-?tool/, estimate: 100 },
];
const DEFAULT_RULE = { key: 'other', category: 'Miscellaneous', estimate: 200 };

const UNIT_GRAMS = { g: 1, gram: 1, grams: 1, kg: 1000, kgs: 1000, oz: 28.35, lb: 453.6, lbs: 453.6 };

function parseWeight(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const m = value.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(kgs?|grams?|g|oz|lbs?)\b/);
  if (!m) return null;
  return parseFloat(m[1].replace(',', '.')) * UNIT_GRAMS[m[2]];
}

function normalizeItem(raw) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    const qty = text.match(/^(\d+)\s*x\s+|\s+x\s*(\d+)\b/i);
    const name = text
      .replace(/^(\d+)\s*x\s+/i, '')
      .replace(/\s+x\s*\d+\b/i, '')
      .replace(/[\s(—–:-]*\d+(?:[.,]\d+)?\s*(kgs?|grams?|g|oz|lbs?)\b\)?/i, '')
      .trim() || text;
    return { name, quantity: qty ? Number(qty[1] || qty[2]) : 1, weight: parseWeight(text) };
  }
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || raw.item || raw.title || '').trim();
  if (!name) return null;
  const qty = Number(raw.quantity ?? raw.qty ?? raw.count ?? 1);
  let weight = parseWeight(raw.weight_grams ?? raw.weight_g ?? raw.grams);
  if (weight == null && raw.weight_kg != null) weight = Number(raw.weight_kg) * 1000 || null;
  if (weight == null && raw.weight_oz != null) weight = Number(raw.weight_oz) * UNIT_GRAMS.oz || null;
  if (weight == null && raw.weight != null) weight = parseWeight(typeof raw.weight === 'number' ? `${raw.weight} g` : raw.weight);
  return {
    name,
    quantity: Number.isFinite(qty) && qty > 0 ? Math.round(qty) : 1,
    weight,
    category: typeof raw.category === 'string' ? raw.category.trim() : '',
  };
}

const fmt = (g) => (g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${Math.round(g)} g`);

function auditItems(rawItems, ctx) {
  const items = rawItems.map(normalizeItem).filter(Boolean).map((it) => {
    const rule = RULES.find((r) => r.re.test(it.name.toLowerCase())) || DEFAULT_RULE;
    const unit = it.weight != null ? it.weight : rule.estimate;
    return {
      ...it, rule, estimated: it.weight == null, unitGrams: unit, totalGrams: unit * it.quantity,
    };
  });

  const byCategory = new Map();
  for (const it of items) {
    const cat = it.rule === DEFAULT_RULE && it.category ? it.category : it.rule.category;
    byCategory.set(cat, (byCategory.get(cat) || 0) + it.totalGrams);
  }
  const current = Math.round(items.reduce((sum, it) => sum + it.totalGrams, 0));

  const cuts = [];
  const swaps = [];
  const safety = [];
  const handled = new Set();
  const tripLabel = `${ctx.days}-day ${ctx.activity}${ctx.routeName ? ` on ${ctx.routeName}` : ''}`;

  // Duplicates of single-carry items (tents, bags, stoves, packs, puffies).
  const groups = new Map();
  for (const it of items) {
    if (it.rule.dupe) groups.set(it.rule.key, [...(groups.get(it.rule.key) || []), it]);
  }
  for (const [, group] of groups) {
    const units = group.reduce((n, it) => n + it.quantity, 0);
    if (units < 2) continue;
    const keep = group.reduce((a, b) => (b.unitGrams > a.unitGrams ? b : a));
    for (const it of group) {
      const extra = it === keep ? it.quantity - 1 : it.quantity;
      if (extra <= 0) continue;
      const grams = it.unitGrams * extra;
      cuts.push({ grams, text: `${extra > 1 ? `${extra} × ` : ''}${it.name} — ${fmt(grams)} — duplicates your ${keep.name}; carry one unless it is shared gear for a partner.` });
      handled.add(it);
    }
  }

  for (const it of items) {
    const { rule } = it;
    if (rule.safety || (rule.insulation && ctx.cold)) {
      safety.push(`${it.name} — ${rule.safety || 'warm layer for cold conditions'}.`);
    }
    if (handled.has(it)) continue;
    if (rule.cut && !rule.safety) {
      cuts.push({ grams: it.totalGrams, text: `${it.name} — ${fmt(it.totalGrams)} — ${rule.cut}.` });
      continue;
    }
    if (rule.swap && it.unitGrams > rule.swap.above) {
      const { swap } = rule;
      const lighter = swap.ratio ? it.unitGrams * swap.ratio : swap.targetGrams;
      const saving = Math.round((it.unitGrams - lighter) * it.quantity);
      if (saving >= 50) {
        swaps.push({
          grams: saving,
          text: `Swap ${it.name} (${fmt(it.totalGrams)}) for ${swap.target} — saves ~${fmt(saving)}${swap.note ? ` ${swap.note}` : ''}.`,
        });
      }
    }
  }
  cuts.sort((a, b) => b.grams - a.grams);
  swaps.sort((a, b) => b.grams - a.grams);
  const savings = Math.min(current, Math.round([...cuts, ...swaps].reduce((s, c) => s + c.grams, 0)));

  const has = (...keys) => items.some((it) => keys.includes(it.rule.key));
  const missing = [];
  if (!has('water_treatment')) missing.push(`No water treatment listed — add a filter or purification tablets for a ${ctx.days}-day trip.`);
  if (!has('first_aid')) missing.push('No first-aid kit listed — add one with blister care.');
  if (!has('navigation')) missing.push('No navigation listed — add a map and compass or a GPS with offline maps.');
  if (!has('headlamp')) missing.push('No headlamp listed — add one with spare batteries.');
  if (!has('shell') && (ctx.wet || ctx.mountain)) missing.push(`No waterproof shell listed — ${ctx.wet ? 'rain is expected' : 'mountain weather can turn quickly'}.`);
  if (!has('insulation', 'fleece') && ctx.cold) missing.push('No warm insulating layer listed for cold conditions.');
  if (!has('emergency', 'tent') && ctx.days > 1) missing.push('No emergency shelter or bivy listed.');
  if (!has('sun')) missing.push('No sun protection listed (sunscreen, sunglasses).');
  for (const gear of ctx.routeGear) {
    const g = gear.toLowerCase();
    if (!items.some((it) => it.name.toLowerCase().includes(g) || g.includes(it.name.toLowerCase()))) {
      missing.push(`WKND's ${ctx.routeName || 'route'} gear list includes ${gear}, which isn't on your list.`);
    }
  }

  const estimated = items.filter((it) => it.estimated).map((it) => it.name);
  const assumptions = [];
  if (estimated.length) {
    const shown = estimated.slice(0, 6).join(', ');
    assumptions.push(`Typical weights estimated for ${estimated.length} item(s) without a listed weight: ${shown}${estimated.length > 6 ? ', …' : ''}.`);
  }
  if (items.some((it) => it.rule.consumable)) assumptions.push('Food and fuel are included in the current weight but never counted as cuts.');
  if (!has('tent') && ctx.days > 1) assumptions.push('No tent listed — assumed hut, guesthouse, or hotel stays.');
  assumptions.push(ctx.routeName
    ? `Route: ${ctx.routeName} (WKND catalogue).`
    : `No WKND route matched${ctx.adventureRef ? ` "${ctx.adventureRef}"` : ''} — general ${ctx.activity} principles applied.`);
  if (ctx.season || ctx.conditions) {
    assumptions.push(`Conditions as provided: ${[ctx.season, ctx.conditions].filter(Boolean).join(', ')}.`);
  }
  if (ctx.packReferenceKg) assumptions.push(`WKND reference pack weight for this route: ${ctx.packReferenceKg} kg.`);

  return {
    tripLabel,
    itemCount: items.length,
    current_weight_grams: current,
    potential_weight_grams: current - savings,
    estimated_savings_grams: savings,
    category_breakdown: [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat, grams]) => `${cat}: ${Math.round(grams)} g`),
    recommended_cuts: cuts.map((c) => c.text),
    possible_swaps: swaps.map((c) => c.text),
    safety_critical_items: safety,
    missing_essentials: missing,
    assumptions,
    biggest: [...cuts, ...swaps].sort((a, b) => b.grams - a.grams)[0] || null,
  };
}

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

  const [catalog, attributes] = await Promise.all([
    loadAdventures(extra, MOCK_DATA),
    loadAttributes(extra).catch(() => ({})),
  ]);
  const route = findAdventure(catalog, adventure_id);
  const attrs = (route && attributes[route.adventure_id]) || {};
  const conditionText = `${season} ${conditions}`.toLowerCase();
  const terrainText = `${activity} ${conditions} ${route ? `${route.landscape || ''} ${route.title || ''}` : ''}`.toLowerCase();

  const audit = auditItems(items, {
    days: Math.max(1, Math.round(duration_days)),
    activity: activity.trim(),
    adventureRef: String(adventure_id || '').trim(),
    routeName: route ? (route.title || route.name) : '',
    routeGear: Array.isArray(attrs.gear) ? attrs.gear : [],
    packReferenceKg: attrs.pack_reference_kg || null,
    season: String(season || '').trim(),
    conditions: String(conditions || '').trim(),
    cold: /cold|snow|ice|icy|freez|winter|sub-?zero|frost/.test(conditionText),
    wet: /wet|rain|storm|shower|monsoon|damp/.test(conditionText),
    mountain: /mountain|alpine|trek|hik|summit|ridge|peak/.test(terrainText),
  });

  if (audit.itemCount === 0) {
    return {
      content: [{ type: 'text', text: 'None of the listed items could be read — provide item names (and weights if known).' }],
      structuredContent: { ...EMPTY_AUDIT },
    };
  }

  const kg = (g) => (g / 1000).toFixed(1);
  const biggest = audit.biggest
    ? ` Biggest single saving: ${audit.biggest.text.split(' — ')[0]} (~${fmt(audit.biggest.grams)}).`
    : ' No clear cuts or swaps found — the list is already lean for this trip.';
  const dangerNote = audit.missing_essentials.length
    ? ` Fix first: ${audit.missing_essentials[0]}`
    : '';
  const goalNote = goal && String(goal).trim() ? ` Goal: ${String(goal).trim()}.` : '';
  const summary = `Audited ${audit.itemCount} item(s) for a ${audit.tripLabel}: ${kg(audit.current_weight_grams)} kg now, `
    + `~${kg(audit.potential_weight_grams)} kg possible (saving ~${kg(audit.estimated_savings_grams)} kg).${biggest}${goalNote} `
    + `Cuts are personal-judgment calls; keep every safety-critical item.${dangerNote}`;

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
module.exports.auditItems = auditItems;
