// Real integrations (actions/lib/wknd.js):
//   - loadAdventures: resolve the route from the WKND catalogue (EDS + Aero)
//   - loadAttributes: permit_requirements / access notes from the EDS attributes sheet
//   - searchFlights:  real transport legs from origin -> the route's gateway airport
// MOCK_DATA is the offline fallback for the route lookup. Detail arrays stay empty
// until the sheet/flights supply real data, so every return branch keeps its shape.
const { loadAdventures, loadAttributes, searchFlights } = require('../lib/wknd.js');
const { withAnalytics } = require('../lib/analytics.js');

const MOCK_DATA = [
    {
        adventure_id: 'patagonia-trek',
        name: 'W Circuit: 9 Days, 115 km',
        title: 'W Circuit: 9 Days, 115 km',
        description: 'A full field account of the W Circuit in Torres del Paine — permit strategy, daily stage breakdowns, and refugio conditions.',
        category: 'Hiking',
        activity: 'Hiking',
        landscape: 'Mountains',
        region: 'Americas',
        destination: 'Torres del Paine',
        country: 'Chile',
        experience_level: 'Advanced',
        pace: 'Endurance',
        priority: 'Physical challenge',
        trip_length_days: 9,
        duration: '9 days · 115 km',
        verified_status: 'Verified · February 2026',
        match_reason: 'A demanding multi-day mountain expedition for experienced parties who want documented permit and stage detail.',
    },
    {
        adventure_id: 'kayaking-norway',
        name: 'Lofoten Islands: Arctic Surfing at the Top of the World',
        title: 'Lofoten Islands: Arctic Surfing at the Top of the World',
        description: "Seven days surfing between the Lofoten peaks — cold-water preparation, swell windows, and why Unstad produces some of Europe's best Arctic waves.",
        category: 'Surfing',
        activity: 'Surfing',
        landscape: 'Coast',
        region: 'Europe',
        destination: 'Lofoten Islands',
        country: 'Norway',
        experience_level: 'Advanced',
        pace: 'Adrenaline',
        priority: 'Solitude',
        trip_length_days: 7,
        duration: '7 days',
        verified_status: 'Verified · November 2025',
        match_reason: 'Cold-water surf expedition for confident surfers comfortable in serious neoprene and remote conditions.',
    },
    {
        adventure_id: 'alpine-cycling',
        name: 'Six Days Through the High Alps by Bike',
        title: 'Six Days Through the High Alps by Bike',
        description: 'A self-supported traverse of the highest road passes in the Alps — Galibier, Izoard, Telegraphe — with notes on resupply and surface conditions.',
        category: 'Cycling',
        activity: 'Cycling',
        landscape: 'Mountains',
        region: 'Europe',
        destination: 'French Alps',
        country: 'France',
        experience_level: 'Advanced',
        pace: 'Endurance',
        priority: 'Physical challenge',
        trip_length_days: 6,
        duration: '6 days',
        match_reason: 'High-pass road cycling for fit riders who want climb-by-climb resupply and surface beta.',
    },
    {
        adventure_id: 'surfing-costa-rica',
        name: 'Pavones & Playa Negra',
        title: "Pavones and Playa Negra: Finding Your Feet on Costa Rica's Breaks",
        description: "Choosing the right break, reading the reef, and understanding crowd dynamics at two of Costa Rica's most distinctive surf spots.",
        category: 'Surfing',
        activity: 'Surfing',
        landscape: 'Tropics',
        region: 'Americas',
        destination: 'Pavones',
        country: 'Costa Rica',
        experience_level: 'Intermediate',
        pace: 'Immersive',
        priority: 'Culture',
        trip_length_days: 5,
        duration: 'Flexible',
        match_reason: 'Warm-water point-break guide suited to intermediate surfers wanting break selection and etiquette detail.',
    },
    {
        adventure_id: 'winter-mountaineering',
        name: 'Why Cold Routes Demand Warm Minds',
        title: 'Why Cold Routes Demand Warm Minds',
        description: 'A winter mountaineering primer on judgment, layering, and decision-making when cold routes raise the consequences.',
        category: 'Winter Mountaineering',
        activity: 'Winter Mountaineering',
        landscape: 'Mountains',
        region: 'Alpine',
        experience_level: 'Advanced',
        pace: 'Endurance',
        priority: 'Technical challenge',
        trip_length_days: 2,
        duration: '1–3 days',
        match_reason: 'Steep-snow and mixed-terrain guidance for experienced mountaineers heading into winter conditions.',
    },
    {
        adventure_id: 'yosemite-rock-climbing',
        name: 'First Light on the Valley',
        title: 'First Light on the Valley',
        description: "A beginner's guide to climbing in Yosemite Valley — where to start, what to expect, and how to build competence on granite.",
        category: 'Climbing',
        activity: 'Climbing',
        landscape: 'Mountains',
        region: 'Americas',
        destination: 'Yosemite Valley',
        country: 'United States',
        experience_level: 'Beginner',
        pace: 'Immersive',
        priority: 'Skill-building',
        trip_length_days: 3,
        duration: 'Flexible',
        match_reason: 'Introductory Valley cragging for first-time climbers building rock skills on bolted terrain.',
    },
    {
        adventure_id: 'wild-swimming-guide',
        name: 'Reading a River',
        title: 'Reading a River',
        description: 'A wild-swimming guide to judging current, temperature, and entry points before you get in cold mountain water.',
        category: 'Wild Swimming',
        activity: 'Wild Swimming',
        landscape: 'Waterways',
        region: 'Mountains',
        experience_level: 'Beginner',
        pace: 'Slow & immersive',
        priority: 'Solitude',
        trip_length_days: 1,
        duration: 'Day trip',
        match_reason: 'Approachable water-safety guidance for newcomers to cold-water and river swimming.',
    },
    {
        adventure_id: 'desert-survival-guide',
        name: '48 Hours in the Sonoran',
        title: '48 Hours in the Sonoran',
        description: 'A field guide to desert survival drawn from time in the Sonoran — heat, water, and moving safely through extreme conditions.',
        category: 'Desert Trekking',
        activity: 'Desert Trekking',
        landscape: 'Desert',
        region: 'Americas',
        destination: 'Sonoran Desert',
        country: 'United States',
        experience_level: 'Intermediate',
        pace: 'Endurance',
        priority: 'Solitude',
        trip_length_days: 2,
        duration: '48 hours',
        match_reason: 'Hot-desert travel skills for prepared trekkers managing heat and scarce water.',
    },
    {
        adventure_id: 'mountain-photography',
        name: 'The Camera on Your Back',
        title: 'The Camera on Your Back',
        description: 'An honest guide to carrying a camera in the mountains — what to bring, what it costs you, and whether the trade-off is worth it.',
        category: 'Photography',
        activity: 'Photography',
        landscape: 'Mountains',
        region: 'Alpine',
        experience_level: 'Intermediate',
        pace: 'Slow & immersive',
        priority: 'Photography',
        trip_length_days: 3,
        duration: 'Flexible',
        match_reason: 'For photographers weighing image-making against the physical burden of gear on the trail.',
    },
    {
        adventure_id: 'ultralight-backpacking',
        name: 'Sub-10 lb: What to Cut',
        title: 'Sub-10 lb: What to Cut, What to Keep',
        description: 'An ultralight backpacking guide on paring a base weight below ten pounds without cutting what keeps you safe.',
        category: 'Gear Guide',
        activity: 'Backpacking',
        landscape: 'Mixed',
        region: 'General',
        experience_level: 'Intermediate',
        pace: 'Endurance',
        priority: 'Comfort / weight',
        trip_length_days: 4,
        duration: 'Multi-day',
        match_reason: 'Weight-optimization principles for backpackers refining a multi-day kit.',
    },
];

const EMPTY_PLAN = {
    adventure_id: null,
    route_title: null,
    destination: null,
    travel_window: null,
    permit_requirements: [],
    preparation_steps: [],
    transport_and_trailhead: [],
    seasonal_access: [],
    official_checks: [],
    source_verification: null,
};

const handler = async ({ adventure_id = '', travel_window = '', origin = '', trip_style = '' } = {}, extra) => {
    if (!adventure_id || typeof adventure_id !== 'string' || !adventure_id.trim()) {
        return {
            content: [{ type: 'text', text: 'Please provide an adventure_id (a WKND route or destination) to plan permits and access for.' }],
            structuredContent: { ...EMPTY_PLAN },
        };
    }
    if (!travel_window || typeof travel_window !== 'string' || !travel_window.trim()) {
        return {
            content: [{ type: 'text', text: 'Please provide a travel_window (dates, month, or season) so lead times can be planned.' }],
            structuredContent: { ...EMPTY_PLAN },
        };
    }

    const catalog = await loadAdventures(extra, MOCK_DATA);
    const query = adventure_id.trim().toLowerCase();
    const report = catalog.find((r) => r.adventure_id.toLowerCase() === query)
        || catalog.find((r) => (r.title || '').toLowerCase() === query)
        || catalog.find((r) => (r.name || '').toLowerCase().includes(query))
        || catalog.find((r) => (r.title || '').toLowerCase().includes(query));

    if (!report) {
        return {
            content: [{ type: 'text', text: `No WKND report was found for "${adventure_id}", so no documented permit or access detail is available to plan from.` }],
            structuredContent: { ...EMPTY_PLAN },
        };
    }

    const destination = [report.destination, report.country].filter(Boolean).join(', ') || report.destination || null;

    // Permit + access detail from the EDS attributes sheet (real when published), and
    // real transport legs from the Aero flights API when an origin and the route's
    // gateway airport (destination_iata) are both known. Arrays stay empty when the
    // upstreams have nothing, preserving the output shape.
    const attrs = (await loadAttributes(extra))[report.adventure_id] || {};
    const permitRequirements = Array.isArray(attrs.permits) ? attrs.permits.slice() : [];

    const transport = [];
    if (attrs.access_notes) transport.push(attrs.access_notes);
    const gateway = report.destination_iata || '';
    if (origin && origin.trim() && gateway) {
        const flights = await searchFlights(extra, { from: origin.trim(), to: gateway });
        const offers = (flights && (flights.flights || flights.results || flights.data)) || [];
        if (Array.isArray(offers) && offers.length) {
            const f = offers[0];
            const price = f.price && (f.price.total || f.price.amount || f.price.final);
            transport.push(`Fly ${origin.trim().toUpperCase()} → ${gateway}`
                + (f.carrier || f.airline ? ` on ${f.carrier || f.airline}` : '')
                + (price ? ` from ${price}` : '')
                + ' (live fare via WKND Aero).');
        } else if (gateway) {
            transport.push(`Nearest gateway airport: ${gateway}. No live fares returned for ${origin.trim().toUpperCase()} → ${gateway}.`);
        }
    } else if (gateway) {
        transport.push(`Nearest gateway airport: ${gateway}. Provide an origin airport to fetch live fares.`);
    }

    const plan = {
        adventure_id: report.adventure_id,
        route_title: report.title || report.name || null,
        destination,
        travel_window: travel_window.trim(),
        permit_requirements: permitRequirements,
        preparation_steps: [],
        transport_and_trailhead: transport,
        seasonal_access: [],
        official_checks: [],
        source_verification: report.verified_status || null,
    };

    const routeName = plan.route_title || report.adventure_id;
    const summary = `Preparation plan for ${routeName} (${destination || 'destination on file'}) in ${plan.travel_window}. `
        + 'The earliest action is securing accommodation and permits together — bed reservations sell out first and gate the entire itinerary, so book them before locking transport. '
        + 'Current permit rules, fees, quotas, and reservation availability still need confirmation with the responsible official authority before you commit, as the archive reports published detail rather than issuing permits or making reservations.';

    return {
        content: [{ type: 'text', text: summary }],
        // structuredContent — flat single-object detail shape (widget reads sc directly, no wrapper key)
        structuredContent: {
            adventure_id: plan.adventure_id,
            route_title: plan.route_title,
            destination: plan.destination,
            travel_window: plan.travel_window,
            permit_requirements: plan.permit_requirements,
            preparation_steps: plan.preparation_steps,
            transport_and_trailhead: plan.transport_and_trailhead,
            seasonal_access: plan.seasonal_access,
            official_checks: plan.official_checks,
            source_verification: plan.source_verification,
        },
    };
};

module.exports = withAnalytics('plan_permits_and_access', handler);

/*
 * TODO: Replace MOCK_DATA with a real API call.
 *
 * Suggested endpoint pattern (update based on actual site API):
 *   GET ${process.env.API_BASE_URL}/destinations/${adventure_id}/logistics?window=${travel_window}
 *
 * The metadata fixture above carries the route identity (title, destination,
 * verified_status) but not the permit_requirements / preparation_steps /
 * transport_and_trailhead / seasonal_access / official_checks detail — those come
 * from the per-route WKND report and should populate the arrays returned above.
 *
 * Environment variables to configure:
 *   API_BASE_URL   Base URL of the WKND archive API
 *   API_KEY        API key if required (add to .env and app.config.yaml)
 *
 * Example fetch:
 *   const res = await fetch(
 *     `${process.env.API_BASE_URL}/destinations/${encodeURIComponent(adventure_id)}/logistics`,
 *     { headers: { 'Authorization': `Bearer ${process.env.API_KEY}` } }
 *   )
 *   if (!res.ok) throw new Error(`API error: ${res.status}`)
 *   return await res.json()
 */
