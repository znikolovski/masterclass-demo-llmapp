const read = require('../../actions/get-flight-gear-offer/index.js');
const claim = require('../../actions/claim-flight-gear-offer/index.js');
const addKit = require('../../actions/add-flight-gear-kit/index.js');
const {
  shopper, fakeCommerce, cart, cartItem, money,
} = require('../fixtures/shop.js');

const bookingId = 'BK_0123456789abcdef';
const expiresAt = new Date(Date.now() + 86400000).toISOString();
const offer = (status = 'ELIGIBLE') => ({
  status,
  reason: null,
  booking_id: bookingId,
  promotion_id: 'prm_test',
  bundle_id: 'bundle_test',
  name: 'Adventure Essentials — confirmed demo flight',
  percent_off: 50,
  expires_at: expiresAt,
  components: [
    { sku: 'WKND-HYD-002', quantity: 1, name: 'Collapsible Bottle 1L' },
    { sku: 'WKND-LGT-001', quantity: 1, name: 'Alpine Start Headlamp 400' },
    { sku: 'WKND-TRV-009', quantity: 1, name: 'Wilderness First Aid Kit' },
  ],
});

describe('flight-linked gear offer tools', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  test.each([read, claim])('requires sign-in and shop:cart without contacting Commerce', async (handler) => {
    global.fetch = jest.fn();
    expect(await handler({ booking_id: bookingId }, {})).toMatchObject({
      isError: true, structuredContent: { error: { status: 401 } },
    });
    expect(await handler({ booking_id: bookingId }, shopper({ scopes: ['bookings:read'] }))).toMatchObject({
      isError: true, structuredContent: { error: { status: 403 } },
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    {}, { booking_id: 'BK_other' }, { booking_id: bookingId, sub: 'another-shopper' },
    { booking_id: bookingId, claim: true },
  ])('rejects invalid arguments and caller-supplied authorization', async (args) => {
    global.fetch = jest.fn();
    expect(await read(args, shopper())).toMatchObject({
      isError: true, structuredContent: { error: { status: 400 } },
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('reads the same Aero offer with existing shopper delegation and no cart or claim mutation', async () => {
    fakeCommerce({
      WkndAeroBundleOffer: () => ({ data: { wkndAeroBundleOffer: { ...offer(), customerSub: 'private', token: 'private' } } }),
    });
    const result = await read({ booking_id: bookingId }, shopper());
    expect(result.structuredContent.offer).toEqual(offer());
    expect(result.structuredContent.terms).toMatch(/best eligible discount.*do not stack/);
    expect(global.fetch.calls).toHaveLength(1);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).query).toMatch(/^query WkndAeroBundleOffer/);
    expect(global.fetch.calls[0].variables).toEqual({ bookingId });
    expect(global.fetch.calls[0].headers['X-WKND-Delegation']).toBe('mcp');
    expect(global.fetch.calls[0].headers.Authorization).not.toContain('private-mcp-access-token');
    expect(JSON.stringify(result)).not.toMatch(/customerSub|private-mcp|private"/);
  });

  test('claims only the entitlement and reports the authoritative saved state', async () => {
    fakeCommerce({
      ClaimWkndAeroBundleOffer: () => ({ data: { claimWkndAeroBundleOffer: offer('CLAIMED') } }),
    });
    const result = await claim({ booking_id: bookingId }, shopper());
    expect(result.structuredContent).toMatchObject({
      mode: 'flight-offer', offer: { status: 'CLAIMED' },
      message: 'Offer saved to your account. No gear has been added or purchased.',
    });
    expect(global.fetch.calls).toHaveLength(1);
    const query = JSON.parse(global.fetch.mock.calls[0][1].body).query;
    expect(query).toMatch(/^mutation ClaimWkndAeroBundleOffer/);
    expect(query).not.toMatch(/customerCart|addProducts|placeOrder|coupon/i);
  });

  test.each(['INELIGIBLE', 'REDEEMED'])('does not present %s as a successful claim', async (status) => {
    fakeCommerce({
      ClaimWkndAeroBundleOffer: () => ({ data: { claimWkndAeroBundleOffer: offer(status) } }),
    });
    const result = await claim({ booking_id: bookingId }, shopper());
    expect(result.structuredContent.offer.status).toBe(status);
    expect(result.structuredContent.terms).toBe('');
    expect(result.structuredContent.message).not.toMatch(/Offer saved/);
  });

  test.each(['wrong-booking', 'expired', 'duplicate-component'])('rejects %s offer data', async (invalid) => {
    const value = offer();
    if (invalid === 'wrong-booking') value.booking_id = 'BK_aaaaaaaaaaaaaaaa';
    if (invalid === 'expired') value.expires_at = new Date(Date.now() - 1000).toISOString();
    if (invalid === 'duplicate-component') value.components.push(value.components[0]);
    fakeCommerce({ WkndAeroBundleOffer: () => ({ data: { wkndAeroBundleOffer: value } }) });
    expect(await read({ booking_id: bookingId }, shopper())).toMatchObject({
      isError: true, structuredContent: { error: { code: 'flight_offer_invalid' } },
    });
  });

  test('surfaces claim failure and tells the caller to recheck status rather than imply no change', async () => {
    fakeCommerce({
      ClaimWkndAeroBundleOffer: () => ({ errors: [{ message: 'Booking verification is unavailable.', path: ['claimWkndAeroBundleOffer'] }] }),
    });
    const result = await claim({ booking_id: bookingId }, shopper());
    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toMatch(/claim status could not be confirmed.*before retrying/);
    expect(global.fetch.calls).toHaveLength(1);
  });

  const kitItems = () => offer().components.map((component, index) => cartItem(`kit-${index}`, 1, 100, {
    product: { sku: component.sku, name: component.name },
  }));
  const kitRoutes = (before = []) => ({
    WkndAeroBundleOffer: () => ({ data: { wkndAeroBundleOffer: offer('CLAIMED') } }),
    ShopCart: () => ({ data: { customerCart: cart({ items: before }) } }),
    ShopFlightKitOffers: () => ({
      data: { wkndBundleOffers: [{ promotion_id: 'prm_test', bundle_id: 'bundle_test', cart_version: 'v1' }] },
    }),
    ShopCompleteFlightKit: () => ({
      data: { completeWkndBundle: {
        cart: cart({
          items: kitItems(),
          prices: {
            subtotal_including_tax: money(300), grand_total: money(150),
            discounts: [{ label: offer().name, amount: money(150) }],
          },
        }),
        user_errors: [],
      } },
    }),
  });

  test.each([
    { state: 'empty', items: [] },
    { state: 'partial', items: [kitItems()[0]] },
  ])('adds the whole missing $state kit with one atomic mutation and copies Commerce savings', async ({ items: before }) => {
    fakeCommerce(kitRoutes(before));
    const result = await addKit({ booking_id: bookingId }, shopper());
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.cart.totals).toMatchObject({
      grand_total: { value: 150, currency: 'AUD' },
      discounts: [{ label: offer().name, amount: { value: 150, currency: 'AUD' } }],
    });
    expect(global.fetch.calls.map((call) => call.operation)).toEqual([
      'WkndAeroBundleOffer', 'ShopCart', 'ShopFlightKitOffers', 'ShopCompleteFlightKit',
    ]);
    expect(global.fetch.calls.at(-1).variables).toEqual({
      cartId: 'masked-cart-id', promotionId: 'prm_test', bundleId: 'bundle_test', expected: 'v1',
    });
    expect(result.content[0].text).toMatch(/Total: A\$150\.00/);
  });

  test('does not duplicate an already complete kit', async () => {
    fakeCommerce(kitRoutes(kitItems()));
    const result = await addKit({ booking_id: bookingId }, shopper());
    expect(result.structuredContent.message).toMatch(/No duplicate gear/);
    expect(global.fetch.calls.map((call) => call.operation)).toEqual(['WkndAeroBundleOffer', 'ShopCart']);
  });

  test('does not add an unclaimed kit', async () => {
    fakeCommerce({ WkndAeroBundleOffer: () => ({ data: { wkndAeroBundleOffer: offer() } }) });
    expect(await addKit({ booking_id: bookingId }, shopper())).toMatchObject({
      isError: true, structuredContent: { error: { code: 'flight_offer_not_claimed' } },
    });
    expect(global.fetch.calls).toHaveLength(1);
  });

  test('rejects stale cart revision without writing or retrying', async () => {
    fakeCommerce({
      ...kitRoutes(),
      ShopCompleteFlightKit: () => ({ errors: [{
        message: 'Cart changed', path: ['completeWkndBundle'], extensions: { code: 'CART_CHANGED' },
      }] }),
    });
    expect(await addKit({ booking_id: bookingId }, shopper())).toMatchObject({
      isError: true, structuredContent: { error: { code: 'cart_changed' } },
    });
    expect(global.fetch.calls.filter((call) => call.operation === 'ShopCompleteFlightKit')).toHaveLength(1);
  });
});
