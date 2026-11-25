const { loadAdventures, findAdventure, searchFlights } = require('../lib/wknd.js');
const { withAnalytics } = require('../lib/analytics.js');

const CHECKOUT = 'https://main--wknd-aero--znikolovski.aem.live/book/flights';
const AIRPORT = /^[A-Z]{3}$/;
const FLIGHT = /^WK\d{3}$/;
const QUOTE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE = 'WKND Aero demo flights, not real airline inventory or tickets. USD base fares per passenger; taxes and seat fees are extra. Aero refreshes the fare at checkout. No booking has been created.';
const DISCOUNT_NOTE = 'Discounts apply to WKND Shop gear, not this flight fare. A flight-linked Adventure Essentials offer requires a confirmed, eligible booking; review and claim it on the Aero confirmation before using it in Shop. Check your signed-in Shop cart for current audience-qualified, welcome-back and applied flight-linked discounts. Commerce determines eligibility and final savings; do not add or stack percentages yourself. No offer is claimed or applied by flight search.';
const text = (value) => (typeof value === 'string' ? value.trim() : '');

function reply(status, message, query, flights = [], isError = false) {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: {
      status, query, flights, currency: 'USD', demo: true, note: NOTE,
      discounts: { status: 'check-required', cart_tool: 'get-shop-cart', message: DISCOUNT_NOTE },
    },
    ...(isError ? { isError: true } : {}),
  };
}

async function handler(args = {}, extra) {
  const fields = ['adventure_id', 'origin', 'destination', 'depart', 'passengers'];
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some((field) => !fields.includes(field))
    || fields.filter((field) => field !== 'passengers')
      .some((field) => args[field] !== undefined && typeof args[field] !== 'string')) {
    return reply('needs-input', 'Provide only adventure_id, origin, destination, depart and passengers. Flight search cannot change bookings or discounts.', {}, [], true);
  }
  const query = {
    adventure_id: text(args.adventure_id),
    origin: text(args.origin).toUpperCase(),
    destination: text(args.destination).toUpperCase(),
    depart: text(args.depart),
    passengers: args.passengers === undefined ? null : args.passengers,
  };
  if ((query.origin && !AIRPORT.test(query.origin))
    || (query.destination && !AIRPORT.test(query.destination))
    || (query.passengers !== null
      && (!Number.isInteger(query.passengers) || query.passengers < 1 || query.passengers > 6))) {
    return reply('needs-input', 'Use three-letter airport codes and a passenger count from 1 to 6.', query, [], true);
  }
  if (query.depart && (!/^\d{4}-\d{2}-\d{2}$/.test(query.depart)
    || !Number.isFinite(Date.parse(`${query.depart}T00:00:00Z`))
    || new Date(`${query.depart}T00:00:00Z`).toISOString().slice(0, 10) !== query.depart
    || query.depart < new Date().toISOString().slice(0, 10))) {
    return reply('needs-input', 'Choose a valid departure date today or later (YYYY-MM-DD).', query, [], true);
  }
  try {
    let adventure;
    if (query.adventure_id) {
      const catalog = await loadAdventures(extra, [], { allowOfflineFallback: false });
      adventure = findAdventure(catalog, query.adventure_id);
      if (!adventure) return reply('not-found', 'That adventure is not in the published WKND catalog. Choose an adventure or specify an arrival airport.', query, [], true);
      query.adventure_id = adventure.adventure_id;
      const gateway = text(adventure.destination_iata).toUpperCase();
      if (AIRPORT.test(gateway)) {
        if (query.destination && query.destination !== gateway) {
          return reply('needs-input', `The published gateway for ${adventure.title} is ${gateway}. Confirm the adventure or search without an adventure_id for a different airport.`, query, [], true);
        }
        query.destination = gateway;
      }
    }
    if (!query.origin || !query.destination || !query.depart || query.passengers === null) {
      const missing = [
        !query.origin && 'departure airport',
        !query.destination && 'arrival airport (no published adventure gateway is available)',
        !query.depart && 'exact departure date',
        query.passengers === null && 'traveller count (1 to 6)',
      ].filter(Boolean);
      return reply('needs-input', `Please provide your ${missing.join(', ')}. Do not infer missing airports or dates.`, query);
    }
    if (query.origin === query.destination) {
      return reply('needs-input', 'Departure and arrival airports must differ.', query, [], true);
    }
    const data = await searchFlights(extra, {
      from: query.origin, to: query.destination, date: query.depart, passengers: query.passengers,
    }, { strict: true });
    if (!Array.isArray(data?.flights)) throw new Error('WKND Aero returned an invalid flight search.');
    const flights = data.flights.map((flight) => {
      if (!flight || typeof flight !== 'object' || !FLIGHT.test(flight.id) || !QUOTE.test(flight.quoteId)
        || flight.origin !== query.origin || flight.destination !== query.destination
        || typeof flight.departTime !== 'string' || !flight.departTime.startsWith(`${query.depart} `)
        || !Number.isFinite(flight.price) || flight.price < 0
        || !Number.isFinite(flight.expiresAt) || flight.expiresAt <= Date.now()
        || ['duration', 'cabin', 'aircraft'].some((field) => !text(flight[field]))
        || typeof flight.departureAt !== 'string' || !Number.isFinite(Date.parse(flight.departureAt))
        || typeof flight.arrivalAt !== 'string' || !Number.isFinite(Date.parse(flight.arrivalAt))) {
        throw new Error('WKND Aero returned an invalid or expired flight quote. Search again.');
      }
      const url = new URL(CHECKOUT);
      const params = {
        origin: query.origin, dest: query.destination, depart: query.depart,
        passengers: String(query.passengers), flight_id: flight.id, ref: 'wknd-llm-app',
        ...(query.adventure_id ? { adv: query.adventure_id } : {}),
      };
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
      return {
        id: flight.id, origin: flight.origin, destination: flight.destination,
        departure_at: flight.departureAt, arrival_at: flight.arrivalAt,
        origin_time_zone: flight.originTimeZone || null, destination_time_zone: flight.destinationTimeZone || null,
        duration: flight.duration, cabin: flight.cabin, aircraft: flight.aircraft,
        base_fare_per_person: flight.price, base_fare_total: flight.price * query.passengers,
        expires_at: new Date(flight.expiresAt).toISOString(), booking_url: url.href,
      };
    });
    const listing = flights.map((flight) => `${flight.id}: ${flight.departure_at}, ${flight.cabin}, USD ${flight.base_fare_per_person} base fare per passenger. Continue in Aero: ${flight.booking_url}`).join('\n');
    return reply('ready', `${flights.length ? `Found ${flights.length} demo flights` : 'No flights found'}${adventure ? ` for ${adventure.title}` : ''}.\n${NOTE}\n${DISCOUNT_NOTE}\n${listing}`, query, flights);
  } catch (error) {
    return reply('unavailable', error.message, query, [], true);
  }
}

module.exports = withAnalytics('search_flights', handler);
