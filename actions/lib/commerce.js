/* global fetch */
/*
 * WKND shop (Adobe Commerce mock backend) access for the shop tools.
 *
 * Commerce is the source of truth for products, prices, stock, carts and orders: nothing here
 * keeps cart state or falls back to mock data. Signed-in calls carry a short-lived delegated
 * shopper assertion (HS256, single-use jti) for the verified Auth0 `sub`, so ChatGPT and the WKND
 * website resolve the same customer and the same active cart (`customerCart`).
 *
 * Variables (LLM Apps UI → extra.variables):
 *   WKND_COMMERCE_GRAPHQL_URL       storefront-graphql web action (HTTPS); production default below
 *   WKND_COMMERCE_ASSERTION_SECRET  >= 32 bytes; equals the backend's MCP_DELEGATION_SECRET
 */
const { createHmac, createHash, randomUUID } = require('node:crypto');

const MCP_RESOURCE = 'https://28538-wkndsherpa.adobeio-static.net/api/v1/web/llm-apps/mcp';
const IDENTITY_ISSUER = 'https://dev-g4kzp3zwgwzs8oha.us.auth0.com/';
const SHOP_SCOPE = 'shop:cart';
const DELEGATION_AUDIENCE = 'urn:wknd-commerce:storefront';
const DEFAULT_GRAPHQL_URL = 'https://28538-wkndcommerce.adobeioruntime.net/api/v1/web/commerce/storefront-graphql';
const DM_ASSET_PREFIX = /^https:\/\/delivery-p\d+-e\d+\.adobeaemcloud\.com\/adobe\/assets\/urn:aaid:aem:[0-9a-f-]+$/i;
const SITE_HOST = 'wknd-adventures.run.place';
// A cold Commerce container (IMS token + DB connect) has measured ~22 s; the backend's own limit is
// 30 s and a keep-warm alarm normally avoids cold starts. A write that times out but commits is
// still safe — a retry with the old cart_version is rejected as cart_changed.
const FETCH_TIMEOUT_MS = 28000;
const PAYMENT_METHOD = 'wknd_demo_pay';
const DEMO_NOTICE = 'WKND Demo Pay — demonstration only. No payment is taken and nothing ships.';
const AU_STATES = {
  ACT: 'Australian Capital Territory',
  NSW: 'New South Wales',
  NT: 'Northern Territory',
  QLD: 'Queensland',
  SA: 'South Australia',
  TAS: 'Tasmania',
  VIC: 'Victoria',
  WA: 'Western Australia',
};
const PLACEHOLDER_EMAIL = /@users\.wknd\.example$/i;

class ShopError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/*
 * Sign-in prompt. The cart tools may be registered without per-action `requiresAuth` (the
 * LLM Apps UI configures auth app-wide), so the runtime's auth gate does not run for them.
 * Returning the same `_meta["mcp/www_authenticate"]` challenge the gate would is what makes
 * ChatGPT start (or step up) the WKND sign-in instead of showing a dead-end error.
 */
const RESOURCE_METADATA_URL = `${new URL(MCP_RESOURCE).origin}/.well-known/oauth-protected-resource`;
const SIGN_IN_CODES = { authentication_required: 'invalid_token', insufficient_scope: 'insufficient_scope' };

function signInChallenge(e) {
  return `Bearer error="${SIGN_IN_CODES[e.code]}", error_description="${e.message.replace(/"/g, "'")}", resource_metadata="${RESOURCE_METADATA_URL}", scope="${SHOP_SCOPE}"`;
}

/** Tool error result; `extra` (e.g. the current cart) lets widgets recover in place. */
function failure(error, extra = {}) {
  const e = error instanceof ShopError
    ? error : new ShopError(502, 'shop_unavailable', 'The WKND shop is unavailable. Please try again shortly.');
  return {
    isError: true,
    content: [{ type: 'text', text: e.message }],
    structuredContent: {
      view: 'error',
      error: { status: e.status, code: e.code, message: e.message },
      ...(e.details?.cart ? { cart: e.details.cart } : {}),
      ...extra,
    },
    ...(SIGN_IN_CODES[e.code] ? { _meta: { 'mcp/www_authenticate': [signInChallenge(e)] } } : {}),
  };
}

const text = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const money = (m) => (m && num(m.value) !== null ? { value: m.value, currency: text(m.currency, 3) || 'AUD' } : null);

function graphqlUrl(extra) {
  const raw = extra?.variables?.WKND_COMMERCE_GRAPHQL_URL;
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_GRAPHQL_URL;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ShopError(503, 'shop_configuration_error', 'Shop access is not configured: WKND_COMMERCE_GRAPHQL_URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ShopError(503, 'shop_configuration_error', 'Shop access is not configured: WKND_COMMERCE_GRAPHQL_URL must be an HTTPS URL.');
  }
  return url.href;
}

/**
 * The verified WKND shopper for this call (ownership always comes from sign-in, never from
 * tool arguments). Throws a 401/403 ShopError otherwise.
 */
function requireShopper(extra) {
  const auth = extra?.authInfo;
  const now = Math.floor(Date.now() / 1000);
  if (typeof auth?.extra?.sub !== 'string' || !auth.extra.sub.trim()
    || auth.resource !== MCP_RESOURCE
    || !Number.isSafeInteger(auth.expiresAt) || auth.expiresAt <= now
    || (auth.extra.iss !== undefined && auth.extra.iss !== IDENTITY_ISSUER)) {
    throw new ShopError(401, 'authentication_required', 'Sign in with your WKND account to use your cart.');
  }
  if (!Array.isArray(auth.scopes) || !auth.scopes.includes(SHOP_SCOPE)) {
    throw new ShopError(403, 'insufficient_scope', `Cart access requires the ${SHOP_SCOPE} permission. Sign in again and allow cart access.`);
  }
  const email = typeof auth.extra.email === 'string' && auth.extra.email.length <= 254 ? auth.extra.email : undefined;
  return { sub: auth.extra.sub, expiresAt: auth.expiresAt, email };
}

function assertion(shopper, extra, orderExpect) {
  const secret = extra?.variables?.WKND_COMMERCE_ASSERTION_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new ShopError(503, 'shop_configuration_error', 'Cart access is not configured: a shared assertion secret of at least 32 bytes is required.');
  }
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = {
    iss: MCP_RESOURCE,
    aud: DELEGATION_AUDIENCE,
    sub: shopper.sub,
    identity_issuer: IDENTITY_ISSUER,
    scope: SHOP_SCOPE,
    iat: now,
    exp: Math.min(now + 60, shopper.expiresAt),
    jti: randomUUID(),
    ...(shopper.email ? { email: shopper.email } : {}),
    // placeOrder only: the backend orders the cart only if it still matches what was reviewed
    ...(orderExpect ? { order_expect: orderExpect } : {}),
  };
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

/**
 * One storefront GraphQL request. A fresh single-use assertion is minted per request.
 * `orderExpect` ({ grand_total, items: [[sku, qty]] }) binds a placeOrder to the reviewed cart.
 * @returns {Promise<{ data: object, errors: object[] }>}
 */
async function graphql(extra, query, variables = {}, { shopper, orderExpect, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const url = graphqlUrl(extra);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-store' };
  if (shopper) {
    headers.Authorization = `Bearer ${assertion(shopper, extra, orderExpect)}`;
    headers['X-WKND-Delegation'] = 'mcp';
  }
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new ShopError(504, 'shop_timeout', 'The WKND shop timed out. Please try again.');
    }
    throw new ShopError(502, 'shop_unavailable', 'The WKND shop is unavailable. Please try again shortly.');
  }
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body || typeof body !== 'object') {
    throw new ShopError(502, 'shop_unavailable', 'The WKND shop is unavailable. Please try again shortly.');
  }
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const authError = errors.find((e) => ['graphql-authentication', 'graphql-authorization'].includes(e?.extensions?.category));
  if (authError) {
    throw new ShopError(401, 'shop_authentication_failed', 'Your WKND sign-in could not be confirmed by the shop. Sign in again; if this persists, the shop configuration needs attention.');
  }
  return { data: body.data || {}, errors };
}

/** Throws when a request returned GraphQL errors (the message is safe to show shoppers). */
function ensureNoErrors(errors, fallback = 'The shop could not complete that request.') {
  if (!errors.length) return;
  const message = text(errors[0]?.message, 300) || fallback;
  throw new ShopError(400, 'shop_request_rejected', message);
}

/* ---------------- catalog ---------------- */

const PRODUCT_FIELDS = `
  __typename sku name urlKey url shortDescription inStock
  images(roles: ["image", "thumbnail"]) { url label }
  attributes(roles: ["visible_in_plp"]) { name label value }
  ... on SimpleProductView { price { final { amount { value currency } } regular { amount { value currency } } } }
  ... on ComplexProductView {
    priceRange {
      minimum { final { amount { value currency } } regular { amount { value currency } } }
      maximum { final { amount { value currency } } }
    }
    options { id title values { id title inStock ... on ProductViewOptionValueSwatch { type value } } }
  }`;

const SEARCH_QUERY = `query ShopSearch($phrase: String!, $filter: [SearchClauseInput!], $pageSize: Int) {
  productSearch(phrase: $phrase, filter: $filter, page_size: $pageSize, current_page: 1) {
    total_count
    items { productView { ${PRODUCT_FIELDS} } }
  }
}`;

const PRODUCTS_QUERY = `query ShopProducts($skus: [String]) { products(skus: $skus) { ${PRODUCT_FIELDS} } }`;

const REFINE_QUERY = `query ShopRefine($sku: String!, $optionIds: [String!]!) {
  refineProduct(sku: $sku, optionIds: $optionIds) { ${PRODUCT_FIELDS} }
}`;

function slug(value) {
  return text(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product';
}

/** Dynamic Media OpenAPI rendition for an asset base URL; WKND site images pass through. */
function imageUrl(url, name, width = 480) {
  if (typeof url !== 'string') return null;
  if (DM_ASSET_PREFIX.test(url)) return `${url}/as/${slug(name)}.webp?width=${width}`;
  return siteUrl(url);
}

function siteUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === SITE_HOST ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeProduct(view) {
  if (!view || typeof view !== 'object' || typeof view.sku !== 'string') return null;
  const complex = view.__typename === 'ComplexProductView';
  const image = (view.images || [])[0];
  const finalMin = complex ? view.priceRange?.minimum?.final?.amount : view.price?.final?.amount;
  const finalMax = complex ? view.priceRange?.maximum?.final?.amount : view.price?.final?.amount;
  const regular = complex ? view.priceRange?.minimum?.regular?.amount : view.price?.regular?.amount;
  const attributes = {};
  (view.attributes || []).slice(0, 12).forEach((a) => {
    if (a && typeof a.name === 'string' && (typeof a.value === 'string' || typeof a.value === 'number')) {
      attributes[a.name] = { label: text(a.label, 60), value: typeof a.value === 'string' ? text(a.value, 120) : a.value };
    }
  });
  return {
    sku: view.sku,
    name: text(view.name, 200),
    type: complex ? 'configurable' : 'simple',
    url: siteUrl(view.url),
    description: text(view.shortDescription, 400),
    image: imageUrl(image?.url, view.name),
    image_alt: text(image?.label, 200) || text(view.name, 200),
    in_stock: view.inStock === true,
    price: {
      currency: text(finalMin?.currency, 3) || 'AUD',
      min: num(finalMin?.value),
      max: num(finalMax?.value),
      regular: num(regular?.value),
    },
    attributes,
    options: complex ? (view.options || []).map((o) => ({
      id: text(o.id, 60),
      title: text(o.title, 60),
      values: (o.values || []).map((v) => ({
        id: text(v.id, 200),
        title: text(v.title, 60),
        in_stock: v.inStock === true,
        swatch: v.type === 'COLOR_HEX' && /^#[0-9a-f]{3,8}$/i.test(v.value || '') ? v.value : null,
      })),
    })) : [],
  };
}

async function searchProducts(extra, {
  phrase = '', category, activity, minPrice, maxPrice, inStockOnly, limit,
}) {
  const filter = [{ attribute: 'visibility', in: ['Search', 'Catalog, Search'] }];
  if (category) filter.push({ attribute: 'categoryPath', eq: category });
  if (activity) filter.push({ attribute: 'activity', eq: activity });
  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.push({ attribute: 'price', range: { from: minPrice ?? 0, to: maxPrice ?? 1000000 } });
  }
  if (inStockOnly) filter.push({ attribute: 'inStock', eq: 'true' });
  const { data, errors } = await graphql(extra, SEARCH_QUERY, { phrase, filter, pageSize: limit });
  ensureNoErrors(errors);
  const result = data.productSearch || {};
  return {
    total: num(result.total_count) ?? 0,
    products: (result.items || []).map((i) => normalizeProduct(i?.productView)).filter(Boolean),
  };
}

async function getProducts(extra, skus) {
  const { data, errors } = await graphql(extra, PRODUCTS_QUERY, { skus });
  ensureNoErrors(errors);
  return (data.products || []).map(normalizeProduct).filter(Boolean);
}

async function refineProduct(extra, sku, optionIds) {
  const { data, errors } = await graphql(extra, REFINE_QUERY, { sku, optionIds });
  ensureNoErrors(errors);
  return normalizeProduct(data.refineProduct);
}

/**
 * Best in-stock product for each search phrase, in one request (aliased productSearch fields).
 * @param {string[]} phrases
 * @returns {Promise<Array<object|null>>} one normalized product (or null) per phrase
 */
async function bestMatches(extra, phrases, { timeoutMs } = {}) {
  if (!phrases.length) return [];
  const variables = {
    filter: [{ attribute: 'visibility', in: ['Search', 'Catalog, Search'] }, { attribute: 'inStock', eq: 'true' }],
  };
  const fields = phrases.map((phrase, i) => {
    variables[`p${i}`] = phrase;
    return `m${i}: productSearch(phrase: $p${i}, filter: $filter, page_size: 1, current_page: 1) { items { productView { ${PRODUCT_FIELDS} } } }`;
  });
  const query = `query ShopMatches(${phrases.map((_, i) => `$p${i}: String!`).join(', ')}, $filter: [SearchClauseInput!]) {\n${fields.join('\n')}\n}`;
  const { data, errors } = await graphql(extra, query, variables, { timeoutMs });
  ensureNoErrors(errors);
  return phrases.map((_, i) => normalizeProduct(data[`m${i}`]?.items?.[0]?.productView));
}

/**
 * Map shopper-friendly selections ({ size: 'M', Colour: 'Deep Ocean' } or value ids) onto a
 * configurable product's option value ids.
 * @returns {{ ids: string[], missing: string[], invalid: string[], unavailable: string[] }}
 */
function resolveOptions(product, selections = {}) {
  const out = {
    ids: [], missing: [], invalid: [], unavailable: [],
  };
  const entries = Object.entries(selections || {})
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => [k.trim().toLowerCase(), v.trim()]);
  const aliases = (o) => [o.id.toLowerCase(), o.title.toLowerCase(), o.id === 'color' ? 'colour' : '', o.title.toLowerCase() === 'colour' ? 'color' : ''];
  (product.options || []).forEach((option) => {
    const entry = entries.find(([k]) => aliases(option).includes(k));
    if (!entry) {
      out.missing.push(option.title);
      return;
    }
    const wanted = entry[1].toLowerCase();
    const value = option.values.find((v) => v.id === entry[1] || v.title.toLowerCase() === wanted);
    if (!value) {
      out.invalid.push(`${option.title}: ${entry[1]} (choose ${option.values.map((v) => v.title).join(', ')})`);
      return;
    }
    if (!value.in_stock) out.unavailable.push(`${option.title}: ${value.title}`);
    out.ids.push(value.id);
  });
  return out;
}

/* ---------------- cart ---------------- */

const CART_FIELDS = `
  id email total_quantity
  items {
    uid quantity is_available not_available_message
    prices {
      price_including_tax { value currency }
      row_total_including_tax { value currency }
      original_item_price { value currency }
    }
    product { sku name canonical_url thumbnail { url label } }
    ... on ConfigurableCartItem {
      configurable_options { option_label value_label }
      configured_variant { sku }
    }
  }
  prices {
    grand_total { value currency }
    subtotal_including_tax { value currency }
    applied_taxes { label amount { value currency } }
    discounts { label amount { value currency } }
  }
  applied_coupons { code }
  shipping_addresses {
    firstname lastname street city postcode telephone
    region { code label }
    country { code label }
    available_shipping_methods { carrier_code method_code carrier_title method_title amount { value currency } available }
    selected_shipping_method { carrier_code method_code carrier_title method_title amount { value currency } }
  }
  billing_address { firstname lastname }
  selected_payment_method { code title }`;

const CART_QUERY = `query ShopCart { customerCart { ${CART_FIELDS} } }`;
const ADD_MUTATION = `mutation ShopAdd($cartId: String!, $items: [CartItemInput!]!) {
  addProductsToCart(cartId: $cartId, cartItems: $items) {
    cart { ${CART_FIELDS} }
    user_errors { code message }
  }
}`;
const UPDATE_MUTATION = `mutation ShopUpdate($input: UpdateCartItemsInput!) {
  updateCartItems(input: $input) { cart { ${CART_FIELDS} } errors { code message } }
}`;
const EMAIL_MUTATION = `mutation ShopEmail($input: SetGuestEmailOnCartInput!) {
  setGuestEmailOnCart(input: $input) { cart { id } }
}`;
const COUPON_MUTATION = `mutation ShopCoupon($input: ApplyCouponToCartInput!) {
  applyCouponToCart(input: $input) { cart { id } }
}`;
const SHIPPING_ADDRESS_MUTATION = `mutation ShopShipTo($input: SetShippingAddressesOnCartInput!) {
  setShippingAddressesOnCart(input: $input) { cart { id } }
}`;
const BILLING_ADDRESS_MUTATION = `mutation ShopBillTo($input: SetBillingAddressOnCartInput!) {
  setBillingAddressOnCart(input: $input) { cart { id } }
}`;
const SHIPPING_METHOD_MUTATION = `mutation ShopShipVia($input: SetShippingMethodsOnCartInput!) {
  setShippingMethodsOnCart(input: $input) { cart { id } }
}`;
const PAYMENT_MUTATION = `mutation ShopPay($input: SetPaymentMethodOnCartInput!) {
  setPaymentMethodOnCart(input: $input) { cart { id } }
}`;
const CUSTOMER_QUERY = `query ShopCustomer {
  customer {
    email
    addresses {
      uid firstname lastname street city postcode telephone country_code default_shipping
      region { region region_code }
    }
  }
}`;
const PLACE_ORDER_MUTATION = `mutation ShopPlaceOrder($input: PlaceOrderInput) {
  placeOrder(input: $input) {
    errors { code message }
    orderV2 {
      number email created_at status shipping_method
      items {
        product_name product_sku quantity_ordered
        selected_options { label value }
        prices { row_total_including_tax { value currency } }
      }
      total {
        grand_total { value currency }
        subtotal_incl_tax { value currency }
        total_shipping { value currency }
        total_tax { value currency }
        discounts { label amount { value currency } }
      }
      shipping_address { firstname lastname city postcode region country_code }
      payment_methods { name }
    }
  }
}`;

function addressSummary(a) {
  if (!a) return null;
  return {
    name: [text(a.firstname, 60), text(a.lastname, 60)].filter(Boolean).join(' '),
    street: (Array.isArray(a.street) ? a.street : []).map((s) => text(s, 120)).filter(Boolean),
    city: text(a.city, 80),
    region: text(a.region?.code || a.region?.region_code || a.region?.label || a.region?.region || a.region, 80),
    postcode: text(a.postcode, 20),
    country: text(a.country?.code || a.country_code, 2),
    telephone: text(a.telephone, 30),
  };
}

function shippingMethod(m) {
  if (!m) return null;
  return {
    code: text(m.method_code, 40),
    carrier: text(m.carrier_code, 40),
    title: text(m.method_title, 120),
    amount: money(m.amount),
  };
}

function normalizeCart(cart) {
  if (!cart || typeof cart !== 'object') throw new ShopError(502, 'shop_unavailable', 'The shop returned an unexpected cart.');
  const ship = (cart.shipping_addresses || [])[0] || null;
  const currency = text(cart.prices?.grand_total?.currency, 3) || 'AUD';
  const lines = (cart.items || []).map((item) => {
    const thumb = item.product?.thumbnail;
    const options = (item.configurable_options || []).map((o) => ({ label: text(o.option_label, 60), value: text(o.value_label, 60) }));
    return {
      line_id: text(item.uid, 200),
      sku: text(item.configured_variant?.sku || item.product?.sku, 100),
      parent_sku: text(item.product?.sku, 100),
      name: text(item.product?.name, 200),
      options,
      quantity: num(item.quantity) ?? 0,
      unit_price: money(item.prices?.price_including_tax),
      regular_price: money(item.prices?.original_item_price),
      row_total: money(item.prices?.row_total_including_tax),
      available: item.is_available !== false,
      message: item.is_available === false ? text(item.not_available_message, 200) : null,
      image: imageUrl(thumb?.url, item.product?.name, 240),
      url: item.product?.canonical_url ? siteUrl(`https://${SITE_HOST}${item.product.canonical_url}`) : null,
    };
  });
  const email = text(cart.email, 254);
  const summary = {
    item_count: num(cart.total_quantity) ?? lines.reduce((n, l) => n + l.quantity, 0),
    currency,
    lines,
    totals: {
      subtotal: money(cart.prices?.subtotal_including_tax),
      discounts: (cart.prices?.discounts || []).map((d) => ({ label: text(d.label, 120), amount: money(d.amount) })),
      shipping: ship?.selected_shipping_method ? money(ship.selected_shipping_method.amount) : null,
      tax_included: (cart.prices?.applied_taxes || []).map((t) => ({ label: text(t.label, 60), amount: money(t.amount) })),
      grand_total: money(cart.prices?.grand_total),
    },
    coupons: (cart.applied_coupons || []).map((c) => text(c.code, 40)).filter(Boolean),
    checkout: {
      email: email && !PLACEHOLDER_EMAIL.test(email) ? email : null,
      shipping_address: ship ? addressSummary(ship) : null,
      shipping_methods: ship ? (ship.available_shipping_methods || []).filter((m) => m.available !== false).map(shippingMethod) : [],
      shipping_method: ship ? shippingMethod(ship.selected_shipping_method) : null,
      billing_address_set: Boolean(cart.billing_address),
      payment_method: cart.selected_payment_method?.code === PAYMENT_METHOD ? PAYMENT_METHOD : null,
    },
  };
  summary.version = cartVersion(summary);
  summary.missing = missingForOrder(summary);
  summary.ready = summary.missing.length === 0;
  return summary;
}

/**
 * Fingerprint of everything that changes what an order would contain or cost. Writes may pass the
 * version they were based on; a mismatch means the cart changed elsewhere (another tab, the website).
 */
function cartVersion(cart) {
  const basis = JSON.stringify([
    cart.lines.map((l) => [l.line_id, l.sku, l.quantity, l.row_total?.value]),
    cart.coupons,
    cart.checkout.email,
    cart.checkout.shipping_address,
    cart.checkout.shipping_method?.code,
    cart.checkout.payment_method,
    cart.totals.grand_total?.value,
  ]);
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

function missingForOrder(cart) {
  const missing = [];
  if (!cart.lines.length) missing.push('items');
  if (cart.lines.some((l) => !l.available)) missing.push('available_items');
  if (!cart.checkout.email) missing.push('email');
  if (!cart.checkout.shipping_address) missing.push('shipping_address');
  if (!cart.checkout.shipping_method) missing.push('shipping_method');
  if (!cart.checkout.billing_address_set) missing.push('billing_address');
  if (!cart.checkout.payment_method) missing.push('payment_method');
  return missing;
}

async function loadCart(extra, shopper) {
  const { data, errors } = await graphql(extra, CART_QUERY, {}, { shopper });
  ensureNoErrors(errors);
  return { id: data.customerCart?.id, cart: normalizeCart(data.customerCart) };
}

function assertVersion(cart, expected) {
  if (expected !== undefined && expected !== cart.version) {
    throw new ShopError(409, 'cart_changed', 'Your cart changed since it was last shown (perhaps on the WKND website). Review the updated cart and try again.', { cart });
  }
}

const formatMoney = (m) => (m ? `${m.currency === 'AUD' ? 'A$' : `${m.currency} `}${m.value.toFixed(2)}` : '—');

function cartText(cart) {
  if (!cart.lines.length) return 'Your WKND cart is empty.';
  const lines = cart.lines.map((l) => `- ${l.quantity} × ${l.name}${l.options.length ? ` (${l.options.map((o) => o.value).join(' / ')})` : ''} [line ${l.line_id}] — ${formatMoney(l.row_total)}${l.available ? '' : ` — ${l.message || 'unavailable'}`}`);
  return `Your WKND cart (${cart.item_count} item${cart.item_count === 1 ? '' : 's'}, version ${cart.version}):\n${lines.join('\n')}\nTotal: ${formatMoney(cart.totals.grand_total)} incl. GST${cart.totals.shipping ? '' : ' (before shipping)'}.`;
}

module.exports = {
  ShopError,
  failure,
  requireShopper,
  graphql,
  ensureNoErrors,
  searchProducts,
  getProducts,
  refineProduct,
  bestMatches,
  resolveOptions,
  normalizeProduct,
  normalizeCart,
  loadCart,
  assertVersion,
  cartText,
  formatMoney,
  text,
  num,
  imageUrl,
  queries: {
    ADD_MUTATION,
    UPDATE_MUTATION,
    EMAIL_MUTATION,
    COUPON_MUTATION,
    SHIPPING_ADDRESS_MUTATION,
    BILLING_ADDRESS_MUTATION,
    SHIPPING_METHOD_MUTATION,
    PAYMENT_MUTATION,
    CUSTOMER_QUERY,
    PLACE_ORDER_MUTATION,
  },
  constants: {
    MCP_RESOURCE, IDENTITY_ISSUER, SHOP_SCOPE, DELEGATION_AUDIENCE, DEFAULT_GRAPHQL_URL, PAYMENT_METHOD, DEMO_NOTICE, AU_STATES, PLACEHOLDER_EMAIL, SITE_HOST,
  },
};
