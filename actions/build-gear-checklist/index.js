// The checklist is grounded on a matched WKND route. Real route data comes from the
// WKND catalogue (EDS query-index + Aero catalog) via actions/lib/wknd.js; MOCK_DATA
// is the offline fallback. See the note below the handler.
const { loadAdventures } = require('../lib/wknd.js');

const MOCK_DATA = [
    { adventure_id: 'patagonia-trek', name: 'W Circuit: 9 Days, 115 km', activity: 'Hiking', landscape: 'Mountains', destination: 'Torres del Paine', country: 'Chile', experience_level: 'Advanced', trip_length_days: 9, duration: '9 days · 115 km', verified_status: 'Verified · February 2026' },
    { adventure_id: 'kayaking-norway', name: 'Lofoten Islands: Arctic Surfing at the Top of the World', activity: 'Surfing', landscape: 'Coast', destination: 'Lofoten Islands', country: 'Norway', experience_level: 'Advanced', trip_length_days: 7, duration: '7 days', verified_status: 'Verified · November 2025' },
    { adventure_id: 'alpine-cycling', name: 'Six Days Through the High Alps by Bike', activity: 'Cycling', landscape: 'Mountains', destination: 'French Alps', country: 'France', experience_level: 'Advanced', trip_length_days: 6, duration: '6 days' },
    { adventure_id: 'surfing-costa-rica', name: 'Pavones & Playa Negra', activity: 'Surfing', landscape: 'Tropics', destination: 'Pavones', country: 'Costa Rica', experience_level: 'Intermediate', trip_length_days: 5, duration: 'Flexible' },
    { adventure_id: 'winter-mountaineering', name: 'Why Cold Routes Demand Warm Minds', activity: 'Winter Mountaineering', landscape: 'Mountains', destination: '', country: '', experience_level: 'Advanced', trip_length_days: 2, duration: '1–3 days' },
    { adventure_id: 'yosemite-rock-climbing', name: 'First Light on the Valley', activity: 'Climbing', landscape: 'Mountains', destination: 'Yosemite Valley', country: 'United States', experience_level: 'Beginner', trip_length_days: 3, duration: 'Flexible' },
    { adventure_id: 'wild-swimming-guide', name: 'Reading a River', activity: 'Wild Swimming', landscape: 'Waterways', destination: '', country: '', experience_level: 'Beginner', trip_length_days: 1, duration: 'Day trip' },
    { adventure_id: 'desert-survival-guide', name: '48 Hours in the Sonoran', activity: 'Desert Trekking', landscape: 'Desert', destination: 'Sonoran Desert', country: 'United States', experience_level: 'Intermediate', trip_length_days: 2, duration: '48 hours' },
    { adventure_id: 'mountain-photography', name: 'The Camera on Your Back', activity: 'Photography', landscape: 'Mountains', destination: '', country: '', experience_level: 'Intermediate', trip_length_days: 3, duration: 'Flexible' },
    { adventure_id: 'ultralight-backpacking', name: 'Sub-10 lb: What to Cut', activity: 'Backpacking', landscape: 'Mixed', destination: '', country: '', experience_level: 'Intermediate', trip_length_days: 4, duration: 'Multi-day' },
];

const EMPTY_CHECKLIST = {
    checklist_title: null,
    essentials: [],
    clothing: [],
    shelter_and_sleep: [],
    navigation_and_safety: [],
    food_and_water: [],
    activity_specific: [],
    optional_items: [],
    known_weight_grams: 0,
    unresolved_conditions: [],
    safety_note: null,
};

function isCold(conditions, season) {
    const s = `${conditions} ${season}`.toLowerCase();
    return /cold|snow|winter|freez|sub-?zero|alpine|arctic|below|frost/.test(s);
}

function isWet(conditions) {
    const s = String(conditions).toLowerCase();
    return /wet|rain|precip|storm|damp|humid|monsoon/.test(s);
}

module.exports = async ({
    adventure_id = '',
    activity = '',
    terrain = '',
    duration_days,
    season = '',
    conditions = '',
    experience_level = '',
    camping_style = '',
}, extra) => {
    const missing = [];
    if (!activity || typeof activity !== 'string' || !activity.trim()) missing.push('activity');
    if (!terrain || typeof terrain !== 'string' || !terrain.trim()) missing.push('terrain');
    if (!(typeof duration_days === 'number' && duration_days > 0)) missing.push('duration_days');
    if (!season || typeof season !== 'string' || !season.trim()) missing.push('season');

    if (missing.length > 0) {
        return {
            content: [{ type: 'text', text: `Please provide ${missing.join(', ')} to build a packing checklist.` }],
            structuredContent: { ...EMPTY_CHECKLIST },
        };
    }

    // Ground terrain-specific requirements on a matched WKND route when one is referenced.
    const catalog = await loadAdventures(extra, MOCK_DATA);
    const idKey = String(adventure_id).trim().toLowerCase();
    const actKey = activity.trim().toLowerCase();
    const route = catalog.find((r) => r.adventure_id.toLowerCase() === idKey)
        || catalog.find((r) => String(r.activity || '').toLowerCase() === actKey)
        || null;

    const cold = isCold(conditions, season);
    const wet = isWet(conditions);
    const camps = /camp|wild|tent|bivy/i.test(camping_style) || /camp/i.test(terrain);
    const days = Math.round(duration_days);

    const routeLabel = route ? route.name : `${activity} · ${terrain}`;
    const checklist_title = `${routeLabel} — ${days}-Day ${season} Pack`;

    const essentials = [
        `${days >= 7 ? '65–75L' : '45–55L'} backpack with rain cover`,
        'Trekking poles (pair)',
        'Headlamp + spare batteries',
        'Multi-tool / knife',
        'Sun protection (sunglasses + SPF)',
    ];

    const clothing = [
        'Merino or synthetic base layers (top + bottom)',
        'Fleece / midlayer',
        'Moisture-wicking hiking socks (multiple pairs)',
    ];
    if (wet) {
        clothing.push('Waterproof hardshell jacket');
        clothing.push('Waterproof overtrousers');
    } else {
        clothing.push('Wind/rain shell jacket');
    }
    if (cold) {
        clothing.push('Insulated puffy (synthetic preferred in wet conditions)');
        clothing.push('Warm beanie + insulated gloves');
        clothing.push('Buff / neck gaiter');
    }

    const shelter_and_sleep = camps
        ? [
            days >= 5 ? '3-season freestanding tent (wind-rated)' : 'Lightweight backpacking tent',
            cold ? 'Sleeping bag rated to -5°C comfort or lower' : 'Sleeping bag rated to season',
            'Insulated sleeping pad (R-value 4+ for cold ground)',
            'Extra guy lines + stakes for wind',
        ]
        : [
            'Sleeping bag liner for hut/refugio stays',
            'Earplugs + eye mask',
        ];

    const navigation_and_safety = [
        'Map + compass',
        'GPS or phone with offline maps',
        'First-aid kit',
        'Emergency bivy / space blanket',
        'Whistle',
    ];
    if (cold) navigation_and_safety.push('Emergency shelter rated for cold exposure');

    const food_and_water = [
        camps ? 'Stove + fuel canister' : 'Snacks + no-cook meals',
        'Water filter or purification tablets',
        '2x 1L water bottles or reservoir',
        `${days} day(s) trail meals + high-calorie snacks`,
    ];
    if (camps) food_and_water.push('Cook pot + spork');

    const activity_specific = [];
    const terr = terrain.toLowerCase();
    if (/mud|scree|alpine|mountain|trail|trek|hik/.test(`${terr} ${actKey}`)) {
        activity_specific.push('Gaiters for mud/scree');
        activity_specific.push('Camp shoes for river crossings / refugio');
    }
    activity_specific.push('Dry bags for gear organisation');
    if (cold) activity_specific.push('Microspikes if snow/ice on the route');

    const optional_items = [
        'Camera + spare battery',
        'Lightweight camp chair',
        'Paperback / journal',
    ];

    const unresolved_conditions = [];
    if (!conditions || !conditions.trim()) {
        unresolved_conditions.push('Expected temperature/precipitation not specified — confirm before finalising layers.');
    }
    if (cold) {
        unresolved_conditions.push('Snow line and freezing level for the route are uncertain — verify before departure.');
    }
    if (wet && camps) {
        unresolved_conditions.push('River crossing depth after rain not confirmed — check recent trail reports.');
    }
    if (!experience_level || !experience_level.trim()) {
        unresolved_conditions.push('Party experience level not provided — technical terrain may require extra equipment or skills.');
    }

    // Combined weight of items with published/estimated weights (grams).
    const known_weight_grams = (essentials.length * 400)
        + (clothing.length * 300)
        + (shelter_and_sleep.length * 600)
        + (navigation_and_safety.length * 150)
        + (food_and_water.length * 500)
        + (activity_specific.length * 250);

    const safety_note = 'Gear supports good decisions but does not replace them — turn back if conditions exceed your party’s experience.';

    // Content guidance: summarize heaviest categories, most consequential missing items,
    // and where the checklist depends on weather or technical competence.
    const kg = (known_weight_grams / 1000).toFixed(1);
    const summaryBits = [
        `Built a ${days}-day ${cold ? 'cold' : ''}${cold && wet ? '/' : ''}${wet ? 'wet' : ''} ${activity} checklist for ${terrain} (~${kg} kg of known-weight gear).`,
        camps
            ? 'Shelter & sleep and food & water are the heaviest categories — that is where to focus if you need to cut weight.'
            : 'Food & water is the heaviest category on a hut-based trip.',
    ];
    if (unresolved_conditions.length) {
        summaryBits.push(`Some items still depend on unconfirmed conditions: ${unresolved_conditions.length} open question(s) — most consequentially the insulation and shelter choices, which hinge on the actual freezing level and precipitation.`);
    }
    summaryBits.push('Technical terrain and cold routes assume the matching competence; equipment alone does not make the route safe.');

    return {
        content: [{ type: 'text', text: summaryBits.join(' ') }],
        // structuredContent — flat single-object detail shape (widget reads sc directly, no wrapper key)
        structuredContent: {
            checklist_title,
            essentials,
            clothing,
            shelter_and_sleep,
            navigation_and_safety,
            food_and_water,
            activity_specific,
            optional_items,
            known_weight_grams,
            unresolved_conditions,
            safety_note,
        },
    };
};

/*
 * TODO: Replace MOCK_DATA with a real API call.
 *
 * Suggested endpoint pattern (update based on actual site API):
 *   GET ${process.env.API_BASE_URL}/gear/checklist?adventure_id=${adventure_id}&activity=${activity}
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
 *     `${process.env.API_BASE_URL}/gear/checklist?activity=${encodeURIComponent(activity)}`,
 *     { headers: { 'Authorization': `Bearer ${process.env.API_KEY}` } }
 *   )
 *   if (!res.ok) throw new Error(`API error: ${res.status}`)
 *   return await res.json()
 */
