// Place a WKND Demo Pay order for the signed-in shopper's reviewed cart. No payment is taken and
// nothing ships. Requires the exact cart version and total the shopper confirmed, so a cart that
// changed after review (another tab, the website, a retry) is never ordered by mistake.
const {
  requireShopper, loadCart, assertVersion, graphql, failure, ShopError, formatMoney, text, num, maskCodes, sanitizeOutput,
  queries, constants,
} = require('../lib/commerce.js');
const { withAnalytics } = require('../lib/analytics.js');

const VERSION = /^[0-9a-f]{16}$/;
const ORDER_NUMBER = /^[A-Z0-9-]{4,40}$/;

const money = (m) => (m && num(m.value) !== null ? { value: m.value, currency: text(m.currency, 3) || 'AUD' } : null);

function normalizeOrder(o) {
  const number = text(o?.number, 40);
  if (!ORDER_NUMBER.test(number)) throw new ShopError(502, 'shop_unavailable', 'The shop returned an unexpected order.');
  const ship = o.shipping_address || {};
  return {
    number,
    status: text(o.status, 60),
    created_at: text(o.created_at, 40),
    email: text(o.email, 254),
    items: (o.items || []).map((i) => ({
      name: text(i.product_name, 200),
      sku: text(i.product_sku, 100),
      quantity: num(i.quantity_ordered) ?? 0,
      options: (i.selected_options || []).map((s) => ({ label: text(s.label, 60), value: text(s.value, 60) })),
      row_total: money(i.prices?.row_total_including_tax),
    })),
    totals: {
      subtotal: money(o.total?.subtotal_incl_tax),
      discounts: (o.total?.discounts || []).map((d) => ({ label: text(d.label, 120), amount: money(d.amount) })),
      shipping: money(o.total?.total_shipping),
      tax_included: money(o.total?.total_tax),
      grand_total: money(o.total?.grand_total),
    },
    shipping_method: text(o.shipping_method, 120),
    ship_to: [text(ship.city, 80), text(ship.region, 80), text(ship.postcode, 12), text(ship.country_code, 2)].filter(Boolean).join(' '),
    payment: text(o.payment_methods?.[0]?.name, 120) || 'WKND Demo Pay',
    url: `https://${constants.SITE_HOST}/shop/order?orderRef=${encodeURIComponent(number)}`,
  };
}

const handler = async (args = {}, extra) => {
  try {
    const shopper = requireShopper(extra);
    if (args.confirm !== true) {
      throw new ShopError(400, 'confirmation_required', 'Placing a demo order needs the shopper\'s explicit confirmation of the reviewed cart.');
    }
    if (!VERSION.test(String(args.cart_version ?? ''))) {
      throw new ShopError(400, 'invalid_cart_version', 'Provide the cart_version from the checkout review the shopper confirmed.');
    }
    const expectedTotal = Number(args.expected_grand_total);
    if (!Number.isFinite(expectedTotal) || expectedTotal < 0) {
      throw new ShopError(400, 'invalid_total', 'Provide expected_grand_total from the checkout review the shopper confirmed.');
    }

    const { id, cart } = await loadCart(extra, shopper);
    if (!cart.lines.length) {
      throw new ShopError(409, 'cart_already_ordered', 'There is no open cart to order. If you just placed this order, it was recorded — check your WKND orders.');
    }
    assertVersion(cart, args.cart_version);
    if (Math.abs((cart.totals.grand_total?.value ?? -1) - expectedTotal) > 0.005) {
      throw new ShopError(409, 'total_changed', `The total is now ${formatMoney(cart.totals.grand_total)}. Review the cart again before ordering.`, { cart });
    }
    if (!cart.ready) {
      throw new ShopError(400, 'checkout_incomplete', `Checkout is incomplete: ${cart.missing.join(', ')}.`, { cart });
    }

    const orderExpect = {
      grand_total: cart.totals.grand_total.value,
      items: cart.lines.map((l) => [l.sku, l.quantity]),
    };
    const { data, errors } = await graphql(extra, queries.PLACE_ORDER_MUTATION, { input: { cart_id: id } }, { shopper, orderExpect });
    const result = data.placeOrder;
    const orderError = (result?.errors || [])[0];
    if (orderError || !result?.orderV2) {
      if (orderError?.code === 'CART_NOT_ACTIVE') {
        throw new ShopError(409, 'cart_already_ordered', 'This cart was already ordered (perhaps in another window). Check your WKND orders.');
      }
      const message = maskCodes(text(orderError?.message || errors[0]?.message, 300)) || 'The shop could not place the order.';
      const current = await loadCart(extra, shopper).then((r) => r.cart).catch(() => undefined);
      // The welcome-back offer (or another promotion) is no longer valid for this shopper or cart.
      const offerCode = text(errors[0]?.extensions?.code, 60);
      if (constants.OFFER_ERROR_CODES.includes(offerCode) || /coupon|offer/i.test(message)) {
        throw new ShopError(409, 'offer_invalid', `${message} Remove the offer or use a different code, then review the order again.`, {
          subcode: offerCode || undefined, ...(current ? { cart: current } : {}),
        });
      }
      const code = /changed/i.test(message) ? 'cart_changed' : 'order_rejected';
      throw new ShopError(409, code, message, current ? { cart: current } : undefined);
    }
    const order = normalizeOrder(result.orderV2);
    const summary = `Demo order ${order.number} placed: ${order.items.reduce((n, i) => n + i.quantity, 0)} item(s), ${formatMoney(order.totals.grand_total)} incl. GST, ${order.shipping_method || 'WKND Shipping'} to ${order.ship_to}. ${constants.DEMO_NOTICE} View it at ${order.url}`;
    return sanitizeOutput({
      content: [{ type: 'text', text: summary }],
      structuredContent: { view: 'order', order, notice: constants.DEMO_NOTICE },
    });
  } catch (error) {
    return failure(error);
  }
};

module.exports = withAnalytics('place_shop_demo_order', handler);
