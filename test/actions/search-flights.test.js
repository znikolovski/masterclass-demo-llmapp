jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }));
jest.mock('../../actions/lib/wknd.js', () => ({
  loadAdventures: jest.fn(),
  findAdventure: jest.fn(),
  searchFlights: jest.fn(),
}));
const { loadAdventures, findAdventure, searchFlights } = require('../../actions/lib/wknd.js');
const handler = require('../../actions/search-flights/index.js');
const args = { adventure_id: 'patagonia-trek', origin: 'MEL', depart: '2027-02-12', passengers: 2 };
const flight = () => ({
  id: 'WK101', quoteId: 'aabbccdd-1234-4567-abcd-aabbccddeeff', expiresAt: Date.now() + 60000,
  origin: 'MEL', destination: 'PUQ', departTime: '2027-02-12 08:30',
  departureAt: '2027-02-11T21:30:00Z', arrivalAt: '2027-02-12T03:00:00Z',
  originTimeZone: 'Australia/Melbourne', destinationTimeZone: 'America/Punta_Arenas',
  cabin: 'Economy', duration: '5h 30m', aircraft: 'Boeing 737', price: 299,
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2027-01-01T00:00:00Z'));
  jest.clearAllMocks();
  loadAdventures.mockResolvedValue([]);
  findAdventure.mockReturnValue({ adventure_id: 'patagonia-trek', title: 'Patagonia trek', destination_iata: 'PUQ' });
  searchFlights.mockResolvedValue({ flights: [flight()] });
});
afterEach(() => { jest.useRealTimers(); });
test('uses the published gateway and carries the chosen flight and trip into checkout', async () => {
  const result = await handler(args);
  expect(searchFlights).toHaveBeenCalledWith(undefined, { from: 'MEL', to: 'PUQ', date: args.depart, passengers: 2 }, { strict: true });
  const out = result.structuredContent.flights[0];
  expect(out.base_fare_total).toBe(598);
  expect(new URL(out.booking_url).searchParams.get('flight_id')).toBe('WK101');
  expect(new URL(out.booking_url).searchParams.get('adv')).toBe('patagonia-trek');
  expect(new URL(out.booking_url).searchParams.get('passengers')).toBe('2');
  expect(result.content[0].text).toMatch(/not real airline inventory.*refreshes the fare/);
  expect(result.content[0].text).toMatch(/requires a confirmed, eligible booking/);
  expect(result.structuredContent.discounts).toMatchObject({ status: 'check-required', cart_tool: 'get-shop-cart' });
});
test('asks for missing travel details without searching using backend defaults', async () => {
  const result = await handler({ adventure_id: args.adventure_id });
  expect(result.structuredContent.status).toBe('needs-input');
  expect(result.structuredContent.query.destination).toBe('PUQ');
  expect(searchFlights).not.toHaveBeenCalled();
});
test('requires the traveller count even when route and date are complete', async () => {
  expect((await handler({ ...args, passengers: undefined })).content[0].text).toMatch(/traveller count/);
  expect(searchFlights).not.toHaveBeenCalled();
});
test('rejects unexpected discount-changing arguments and invalid input types', async () => {
  expect((await handler({ ...args, discount_percent: 50 })).isError).toBe(true);
  expect((await handler({ ...args, adventure_id: 123 })).isError).toBe(true);
  expect((await handler(null)).isError).toBe(true);
  expect(searchFlights).not.toHaveBeenCalled();
});
test.each([0, 7, 1.5])('rejects unsupported traveller count %s', async (passengers) => {
  expect((await handler({ ...args, passengers })).isError).toBe(true);
  expect(searchFlights).not.toHaveBeenCalled();
});
test.each(['2027-02-30', 'tomorrow', '2020-01-01'])('rejects invalid date %s', async (depart) => {
  expect((await handler({ ...args, depart })).isError).toBe(true);
  expect(searchFlights).not.toHaveBeenCalled();
});
test('does not invent an airport for an adventure with no published gateway', async () => {
  findAdventure.mockReturnValue({ adventure_id: 'unknown', title: 'Unknown' });
  expect((await handler(args)).content[0].text).toMatch(/arrival airport/);
  expect(searchFlights).not.toHaveBeenCalled();
});
test('rejects a conflicting arrival airport instead of silently changing it', async () => {
  expect((await handler({ ...args, destination: 'LAX' })).isError).toBe(true);
  expect(searchFlights).not.toHaveBeenCalled();
});
test('surfaces upstream failure and expired or wrong-route quotes', async () => {
  searchFlights.mockRejectedValueOnce(new Error('Flight search unavailable'));
  expect((await handler(args)).structuredContent.status).toBe('unavailable');
  searchFlights.mockResolvedValueOnce({ flights: [{ ...flight(), destination: 'LAX' }] });
  expect((await handler(args)).isError).toBe(true);
  searchFlights.mockResolvedValueOnce({ flights: [{ ...flight(), expiresAt: Date.now() - 1 }] });
  expect((await handler(args)).isError).toBe(true);
  searchFlights.mockResolvedValueOnce({ flights: [{ ...flight(), cabin: undefined }] });
  expect((await handler(args)).isError).toBe(true);
});
