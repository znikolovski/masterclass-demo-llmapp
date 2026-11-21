// Prepare the signed-in shopper's WKND cart for a WKND Demo Pay order: contact email, shipping
// address (new or saved), delivery method and coupon. Never places an order.
const {
  requireShopper, loadCart, assertVersion, graphql, failure, ShopError, formatMoney, text,
  loadOffer, applyOffer, removeOffer, offerText, hideProtectedCoupons, maskCodes,
  queries, constants,
} = require('../lib/commerce.js');
const { withAnalytics } = require('../lib/analytics.js');

const VERSION = /^[0-9a-f]{16}$/;
const EMAIL = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;
const METHODS = ['standard', 'express', 'international'];
const MISSING_LABELS = {
  items: 'items in the cart',
  available_items: 'all items in stock',
  email: 'a contact email',
  shipping_address: 'a shipping address',
  shipping_method: 'a delivery method',
  billing_address: 'a billing address',
  payment_method: 'WKND Demo Pay',
};

function requireText(value, field, max) {
  const v = text(value, max + 1);
  if (!v || v.length > max) throw new ShopError(400, 'invalid_address', `Shipping address needs a valid ${field}.`);
  return v;
}

function parseAddress(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ShopError(400, 'invalid_address', 'shipping_address must be an object.');
  }
  const country = text(input.country_code || 'AU', 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new ShopError(400, 'invalid_address', 'Use a two-letter country code such as AU.');
  const street = (Array.isArray(input.street) ? input.street : [input.street])
    .map((s) => text(s, 121)).filter(Boolean);
  if (!street.length || street.length > 2 || street.some((s) => s.length > 120)) {
    throw new ShopError(400, 'invalid_address', 'Shipping address needs one or two street lines.');
  }
  const postcode = requireText(input.postcode, 'postcode', 12);
  const telephone = requireText(input.telephone, 'phone number', 20);
  if (!/^[A-Za-z0-9 -]+$/.test(postcode)) throw new ShopError(400, 'invalid_address', 'Shipping address needs a valid postcode.');
  if (!/^[+0-9 ()-]{6,20}$/.test(telephone)) throw new ShopError(400, 'invalid_address', 'Shipping address needs a valid phone number.');
  let region = text(input.region, 80);
  if (country === 'AU') {
    const wanted = region.toUpperCase();
    const code = Object.keys(constants.AU_STATES)
      .find((c) => c === wanted || constants.AU_STATES[c].toUpperCase() === wanted);
    if (!code) throw new ShopError(400, 'invalid_address', `Use an Australian state or territory (${Object.keys(constants.AU_STATES).join(', ')}).`);
    region = code;
  }
  return {
    firstname: requireText(input.firstname, 'first name', 60),
    lastname: requireText(input.lastname, 'last name', 60),
    street,
    city: requireText(input.city, 'city or suburb', 80),
    region: region || undefined,
    postcode,
    country_code: country,
    telephone,
    save_in_address_book: false,
  };
}

function savedAddresses(customer) {
  return (customer?.addresses || []).slice(0, 10).map((a) => ({
    id: text(a.uid, 200),
    label: [
      [text(a.firstname, 60), text(a.lastname, 60)].filter(Boolean).join(' '),
      (a.street || []).map((s) => text(s, 120)).join(', '),
      [text(a.city, 80), text(a.region?.region_code || a.region?.region, 80), text(a.postcode, 12)].filter(Boolean).join(' '),
      text(a.country_code, 2),
    ].filter(Boolean).join(', '),
    default: a.default_shipping === true,
  }));
}

function checkoutText(cart, warnings) {
  const c = cart.checkout;
  const parts = [`Checkout for ${cart.item_count} item${cart.item_count === 1 ? '' : 's'} (cart version ${cart.version}).`];
  if (c.shipping_address) parts.push(`Shipping to ${[c.shipping_address.city, c.shipping_address.region, c.shipping_address.postcode, c.shipping_address.country].filter(Boolean).join(' ')}.`);
  if (c.shipping_methods.length) {
    parts.push(`Delivery options: ${c.shipping_methods.map((m) => `${m.code} (${m.title}, ${formatMoney(m.amount)})`).join('; ')}.${c.shipping_method ? ` Selected: ${c.shipping_method.code}.` : ''}`);
  }
  parts.push(`Total: ${formatMoney(cart.totals.grand_total)} incl. GST.`);
  if (cart.offer_applied) parts.push('The welcome-back offer is applied.');
  if (warnings.length) parts.push(`Notes: ${warnings.join(' ')}`);
  parts.push(cart.ready
    ? 'Ready to place a WKND Demo Pay order. The shopper must explicitly confirm the review in the cart widget; no payment is taken and nothing ships.'
    : `Still needed: ${cart.missing.map((m) => MISSING_LABELS[m] || m).join(', ')}.`);
  return parts.join(' ');
}

const handler = async (args = {}, extra) => {
  let shopper;
  let started = false;
  try {
    shopper = requireShopper(extra);
    if (args.cart_version !== undefined && !VERSION.test(String(args.cart_version))) {
      throw new ShopError(400, 'invalid_cart_version', 'cart_version must come from the latest cart.');
    }
    const email = args.email === undefined ? undefined : text(args.email, 255);
    if (email !== undefined && (!EMAIL.test(email) || email.length > 254)) {
      throw new ShopError(400, 'invalid_email', 'Provide a valid contact email.');
    }
    const method = args.shipping_method === undefined ? undefined : text(args.shipping_method, 20).toLowerCase();
    if (method !== undefined && !METHODS.includes(method)) {
      throw new ShopError(400, 'invalid_shipping_method', `Choose a delivery method: ${METHODS.join(', ')}.`);
    }
    const coupon = args.coupon_code === undefined ? undefined : text(args.coupon_code, 40).toUpperCase();
    if (coupon !== undefined && !/^[A-Z0-9_-]{2,40}$/.test(coupon)) {
      throw new ShopError(400, 'invalid_coupon', 'Coupon codes use letters and numbers only.');
    }
    const savedId = args.saved_address_id === undefined ? undefined : text(args.saved_address_id, 200);
    if (savedId !== undefined && args.shipping_address !== undefined) {
      throw new ShopError(400, 'invalid_address', 'Use either saved_address_id or shipping_address, not both.');
    }
    if (args.apply_offer !== undefined && typeof args.apply_offer !== 'boolean') {
      throw new ShopError(400, 'invalid_apply_offer', 'apply_offer must be true (apply the welcome-back offer) or false (remove it).');
    }
    if (args.apply_offer !== undefined && coupon !== undefined) {
      throw new ShopError(400, 'conflicting_discounts', 'Use either apply_offer or coupon_code, not both.');
    }
    const address = args.shipping_address === undefined ? undefined : parseAddress(args.shipping_address);

    const { id, cart: before, appliedCoupons } = await loadCart(extra, shopper);
    if (!before.lines.length) throw new ShopError(400, 'cart_empty', 'Your WKND cart is empty. Add gear before checking out.', { cart: before });
    assertVersion(before, args.cart_version);

    const { data: customerData, errors: customerErrors } = await graphql(extra, queries.CUSTOMER_QUERY, {}, { shopper });
    const customer = customerErrors.length ? null : customerData.customer;
    const saved = savedAddresses(customer);
    if (savedId !== undefined && !saved.some((a) => a.id === savedId)) {
      throw new ShopError(404, 'address_not_found', 'That saved address is not on your WKND account.', { cart: before });
    }

    started = true;
    const warnings = [];
    const run = async (query, input) => {
      const { errors } = await graphql(extra, query, { input }, { shopper });
      if (errors.length) throw new ShopError(400, 'shop_request_rejected', text(errors[0]?.message, 300) || 'The shop rejected that checkout detail.');
    };

    if (args.apply_offer === true) {
      const applied = await applyOffer(extra, shopper, id, appliedCoupons);
      warnings.push(`Welcome-back offer applied (saves ${formatMoney(applied.saving)}). The total changed, so review it again before ordering.`);
    } else if (args.apply_offer === false && await removeOffer(extra, shopper, id, appliedCoupons)) {
      warnings.push('Welcome-back offer removed.');
    }
    if (coupon) {
      const { errors } = await graphql(extra, queries.COUPON_MUTATION, { input: { cart_id: id, coupon_code: coupon } }, { shopper });
      if (errors.length) warnings.push(`Coupon ${coupon} was not applied: ${maskCodes(text(errors[0]?.message, 200))}`);
    }
    const accountEmail = customer?.email && !constants.PLACEHOLDER_EMAIL.test(customer.email) ? customer.email : null;
    const contact = email || (!before.checkout.email ? accountEmail : null);
    if (contact) await run(queries.EMAIL_MUTATION, { cart_id: id, email: contact });
    if (address || savedId) {
      await run(queries.SHIPPING_ADDRESS_MUTATION, {
        cart_id: id,
        shipping_addresses: [savedId ? { customer_address_uid: savedId } : { address }],
      });
      await run(queries.BILLING_ADDRESS_MUTATION, { cart_id: id, billing_address: { same_as_shipping: true } });
    }
    if (method) {
      await run(queries.SHIPPING_METHOD_MUTATION, {
        cart_id: id, shipping_methods: [{ carrier_code: 'wknd', method_code: method }],
      });
    }
    if (address || savedId || before.checkout.shipping_address) {
      await run(queries.PAYMENT_MUTATION, { cart_id: id, payment_method: { code: constants.PAYMENT_METHOD } });
    }

    const { id: cartId, cart, appliedCoupons: nowApplied } = await loadCart(extra, shopper);
    const decision = await loadOffer(extra, shopper, cartId, nowApplied);
    hideProtectedCoupons(cart, [decision.code]);
    const note = offerText(decision.offer);
    return {
      content: [{ type: 'text', text: note ? `${checkoutText(cart, warnings)} ${note}` : checkoutText(cart, warnings) }],
      structuredContent: {
        view: 'checkout',
        cart,
        offer: decision.offer,
        saved_addresses: saved,
        account_email: accountEmail,
        warnings,
        notice: constants.DEMO_NOTICE,
      },
    };
  } catch (error) {
    // Steps already applied stay applied; show the shopper the cart as it now is.
    if (started && error instanceof ShopError && !error.details?.cart) {
      try {
        error.details = { ...error.details, cart: (await loadCart(extra, shopper)).cart };
      } catch { /* keep the original error */ }
    }
    return failure(error);
  }
};

module.exports = withAnalytics('prepare_shop_checkout', handler);
