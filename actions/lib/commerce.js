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
const PERSON_ENDPOINT = 'https://28538-wkndcommerce.adobeioruntime.net/api/v1/web/commerce/target-diagnostic';
const PERSON_FRESHNESS_MS = 300000;
const DM_ASSET_PREFIX = /^https:\/\/delivery-p\d+-e\d+\.adobeaemcloud\.com\/adobe\/assets\/urn:aaid:aem:[0-9a-f-]+$/i;
const SITE_HOST = 'wknd-adventures.run.place';
// A cold Commerce container loads its catalog snapshot first: ~13 s measured from a distant Runtime
// region (~2–3 s nearby); the backend's own limit is 30 s. A write that times out but commits is
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
// Protected Commerce promotion codes (the welcome-back recovery offer, Commerce POLICY_V1.code).
// They are entitlement-bound and never shown to the model or widgets; the offer's own code is
// hidden too when Commerce returns a different one.
const PROTECTED_COUPON_CODES = ['RECOVER10'];
const OFFER_READ_TIMEOUT_MS = 10000;
// Commerce eligibility errors whose messages are shown to shoppers as-is.
const OFFER_ERROR_CODES = ['COUPON_SHOPPER_INELIGIBLE', 'RECOVERY_ALREADY_REDEEMED', 'COUPON_ELIGIBILITY_UNAVAILABLE'];
// Commerce's opaque cart revision token (Cart.wknd_cart_version, `v<revision>`). Internal only:
// hashed into cart_version, sent back as expected_cart_version, never output or logged.
const SERVER_VERSION = /^v(?:0|[1-9][0-9]{0,15})$/;
// GraphQL validation messages for a field/argument/type the shop's schema doesn't have.
const SCHEMA_MISMATCH = /^(?:Cannot query field|Unknown argument|Unknown type|Field "[^"]+" argument "[^"]+" of type)/;

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
const SIGN_IN_CODES = { authentication_required: 'invalid_token', insufficient_scope: 'insufficient_scope' };
const resourceMetadataUrl = (resource) => `${new URL(resource).origin}/.well-known/oauth-protected-resource`;

// Points at this deployment's metadata when the runtime told us its resource (a scope step-up);
// with no token at all the runtime's own per-action auth gate normally answers first, and this
// Production fallback only applies to tools registered without it.
function signInChallenge(e) {
  const metadata = e.details?.resourceMetadata || resourceMetadataUrl(MCP_RESOURCE);
  return `Bearer error="${SIGN_IN_CODES[e.code]}", error_description="${e.message.replace(/"/g, "'")}", resource_metadata="${metadata}", scope="${SHOP_SCOPE}"`;
}

/** Tool error result; `extra` (e.g. the current cart) lets widgets recover in place. */
function failure(error, extra = {}) {
  const e = error instanceof ShopError
    ? error : new ShopError(502, 'shop_unavailable', 'The WKND shop is unavailable. Please try again shortly.');
  return sanitizeOutput({
    isError: true,
    content: [{ type: 'text', text: e.message }],
    structuredContent: {
      view: 'error',
      error: {
        status: e.status, code: e.code, message: e.message, ...(e.details?.subcode ? { subcode: e.details.subcode } : {}),
      },
      ...(e.details?.cart ? { cart: e.details.cart } : {}),
      ...extra,
    },
    ...(SIGN_IN_CODES[e.code] ? { _meta: { 'mcp/www_authenticate': [signInChallenge(e)] } } : {}),
  }, e.details?.protectedCodes);
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
 * tool arguments). Throws a 401/403 ShopError otherwise. The LLM Apps runtime has already
 * verified the token's signature, issuer and audience against this deployment's own resource
 * (Stage or Production) and reports that resource in `authInfo.resource`.
 */
function verifiedResource(auth) {
  try {
    const url = new URL(auth?.resource);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function requireShopper(extra) {
  const auth = extra?.authInfo;
  const now = Math.floor(Date.now() / 1000);
  const resource = verifiedResource(auth);
  if (typeof auth?.extra?.sub !== 'string' || !auth.extra.sub.trim()
    || !resource
    || !Number.isSafeInteger(auth.expiresAt) || auth.expiresAt <= now
    || (auth.extra.iss !== undefined && auth.extra.iss !== IDENTITY_ISSUER)) {
    throw new ShopError(401, 'authentication_required', 'Sign in with your WKND account to use your cart.');
  }
  if (!Array.isArray(auth.scopes) || !auth.scopes.includes(SHOP_SCOPE)) {
    throw new ShopError(403, 'insufficient_scope', `Cart access requires the ${SHOP_SCOPE} permission. Sign in again and allow cart access.`, { resourceMetadata: resourceMetadataUrl(resource) });
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
    // Commerce's configured delegation issuer (an identifier, the same in every workspace).
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

/** Accept only the published Production idLinkage lease, never a caller-provided identity. */
function personBindingFrom(dto, now = Date.now()) {
  const binding = dto?.binding;
  if (dto?.environment !== 'production' || dto.evidence !== false
    || dto.financialAuthorization !== false || dto.apiVersion !== 'wknd.person-binding/v1'
    || dto.purpose !== 'idLinkage' || dto.status !== 'ok' || dto.consent !== 'granted'
    || dto.reason !== undefined || !Array.isArray(dto.semanticAllowlist)
    || dto.semanticAllowlist.length !== 0 || !binding) return null;
  const fixed = {
    source: 'server-issued',
    purpose: 'idLinkage',
    environment: 'production',
    runtimeNamespace: '28538-wkndcommerce',
    orgId: '28260E2056581D3B7F000101@AdobeOrg',
    dpid: '1547309',
    namespace: 'wkndCustomerId',
    issuer: PERSON_ENDPOINT,
    freshnessMs: PERSON_FRESHNESS_MS,
  };
  if (['personAlias', 'consentGeneration', 'issuedAt', 'expiresAt']
    .some((key) => typeof binding[key] !== 'string')
    || Object.entries(fixed).some(([key, value]) => binding[key] !== value)
    || !/^wpa_[0-9a-f]{32}$/.test(binding.personAlias)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.consentGeneration)) return null;
  const issued = Date.parse(binding.issuedAt);
  const expires = Date.parse(binding.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)
    || new Date(issued).toISOString() !== binding.issuedAt
    || new Date(expires).toISOString() !== binding.expiresAt
    || expires - issued !== PERSON_FRESHNESS_MS || issued > now || now >= expires) return null;
  return {
    ...fixed,
    personAlias: binding.personAlias,
    consentGeneration: binding.consentGeneration,
    issuedAt: binding.issuedAt,
    expiresAt: binding.expiresAt,
  };
}

async function readPersonBinding(extra, op) {
  if (!['person-status', 'person-binding'].includes(op)) return null;
  try {
    const principal = requireShopper(extra);
    if (verifiedResource(extra?.authInfo) !== MCP_RESOURCE) return null;
    const response = await fetch(PERSON_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'X-WKND-Delegation': 'mcp',
        Authorization: `Bearer ${assertion(principal, extra)}`,
      },
      body: JSON.stringify({ op }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(OFFER_READ_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return personBindingFrom(await response.json());
  } catch {
    return null;
  }
}

/** Restore only an existing grant, then recheck its authoritative alias and generation. */
async function restorePersonBinding(extra) {
  const before = await readPersonBinding(extra, 'person-binding');
  if (!before) return null;
  const after = await readPersonBinding(extra, 'person-status');
  if (!after || after.personAlias !== before.personAlias
    || after.consentGeneration !== before.consentGeneration
    || Date.now() >= Date.parse(before.expiresAt)
    || Date.now() >= Date.parse(after.expiresAt)) return null;
  return after;
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
  // A document this app needs isn't in the shop's schema (e.g. the shop is older than this app):
  // fail explicitly rather than degrade. Validation errors carry no execution `path`.
  if (errors.some((e) => !e?.path && SCHEMA_MISMATCH.test(text(e?.message, 300)))) {
    throw new ShopError(502, 'shop_contract_unavailable', 'The WKND shop isn’t running the version this app needs yet, so nothing was changed. Please try again later.');
  }
  return { data: body.data || {}, errors };
}

/**
 * Commerce refuses a coupon write whose cart changed concurrently (CART_CHANGED, revision guard).
 * Surfaces it as a typed cart_changed conflict; callers attach the refreshed cart and never retry.
 */
function throwIfCartChanged(errors) {
  if (errors.some((e) => e?.extensions?.code === 'CART_CHANGED')) {
    throw new ShopError(409, 'cart_changed', 'Your cart changed while this was being updated (perhaps on the WKND website), so nothing was changed. Review the updated cart and try again.');
  }
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

const CATEGORIES_QUERY = `query ShopCategories {
  productSearch(phrase: "", page_size: 1, current_page: 1) {
    facets { attribute buckets { ... on CategoryView { path name } } }
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

const CATEGORY_TTL_MS = 10 * 60 * 1000;
let categoryCache = null;

/**
 * Adds `sold_out` (option value id lists) to configurable products: a combination such as
 * "Glacier Blue / M" can be sold out while each value is in stock on its own. One aliased request;
 * on failure the field is left unset and per-value stock still applies.
 */
async function attachSoldOutVariants(extra, products, { timeoutMs } = {}) {
  const configurable = (products || []).filter((p) => p?.type === 'configurable').slice(0, 12);
  if (!configurable.length) return products;
  const vars = {};
  const fields = configurable.map((p, i) => {
    vars[`s${i}`] = p.sku;
    return `v${i}: variants(sku: $s${i}) { variants { selections product { inStock } } }`;
  });
  const query = `query ShopVariants(${configurable.map((_, i) => `$s${i}: String!`).join(', ')}) { ${fields.join(' ')} }`;
  try {
    const { data } = await graphql(extra, query, vars, { timeoutMs });
    configurable.forEach((p, i) => {
      const list = data?.[`v${i}`]?.variants;
      if (!Array.isArray(list)) return;
      p.sold_out = list
        .filter((v) => v?.product?.inStock === false && Array.isArray(v.selections))
        .map((v) => v.selections.filter((s) => typeof s === 'string'));
    });
  } catch {
    // availability per option value still applies
  }
  return products;
}

/** Option value titles for value ids, in option order ("Glacier Blue / M"). */
function comboTitle(product, valueIds) {
  return (product?.options || [])
    .map((o) => o.values.find((v) => valueIds.includes(v.id))?.title)
    .filter(Boolean)
    .join(' / ');
}

/** "Sold out: Glacier Blue / M, Basalt Black / XS" for the model, or '' when none. */
function soldOutText(product) {
  const combos = (product?.sold_out || []).map((c) => comboTitle(product, c)).filter(Boolean);
  return combos.length ? `Sold out: ${combos.join(', ')}` : '';
}

/** Whether the exact variant for these option value ids is sold out. */
function isSoldOutCombination(product, valueIds) {
  return (product?.sold_out || []).some((combo) => combo.length === valueIds.length
    && combo.every((id) => valueIds.includes(id)));
}

/** Known category paths and names (cached per container). */
async function categoryList(extra) {
  if (categoryCache && Date.now() < categoryCache.expires) return categoryCache.list;
  const { data, errors } = await graphql(extra, CATEGORIES_QUERY);
  ensureNoErrors(errors);
  const facet = (data.productSearch?.facets || []).find((f) => f?.attribute === 'categoryPath');
  const list = (facet?.buckets || [])
    .filter((b) => typeof b?.path === 'string' && b.path)
    .map((b) => ({ path: b.path.toLowerCase(), name: text(b.name, 100).toLowerCase() }));
  if (list.length) categoryCache = { list, expires: Date.now() + CATEGORY_TTL_MS };
  return list;
}

const singular = (word) => word.replace(/(?<!s)s$/, '');
const categoryKey = (value) => singular(value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim());

/**
 * Maps what a shopper or model calls a category ("jackets", "Backpacks", "apparel/jackets") to a
 * catalog category path, or null when nothing matches.
 */
async function resolveCategory(extra, value) {
  const wanted = categoryKey(value);
  if (!wanted) return null;
  const list = await categoryList(extra);
  const keys = (c) => [c.path, c.path.split('/').pop(), c.name].map(categoryKey);
  const exact = list.find((c) => keys(c).includes(wanted));
  if (exact) return exact.path;
  const partial = list.filter((c) => keys(c).some((k) => k.split(' ').includes(wanted)));
  return partial.length === 1 ? partial[0].path : null;
}

/**
 * Catalog search. Category and activity narrow the search, but when they leave nothing they are
 * relaxed (activity first, then category) and reported in `relaxed`, so a guessed filter does not
 * hide gear that matches the phrase.
 */
async function searchProducts(extra, {
  phrase = '', category, activity, minPrice, maxPrice, inStockOnly, limit,
}) {
  const base = [{ attribute: 'visibility', in: ['Search', 'Catalog, Search'] }];
  if (minPrice !== undefined || maxPrice !== undefined) {
    base.push({ attribute: 'price', range: { from: minPrice ?? 0, to: maxPrice ?? 1000000 } });
  }
  if (inStockOnly) base.push({ attribute: 'inStock', eq: 'true' });
  const relaxed = [];
  let categoryPath;
  if (category) {
    categoryPath = await resolveCategory(extra, category).catch(() => null);
    if (!categoryPath) relaxed.push('category');
  }
  const attempts = [{ categoryPath, activity }];
  if (activity) attempts.push({ categoryPath, activity: undefined });
  if (categoryPath) attempts.push({ categoryPath: undefined, activity: undefined });
  let result = {};
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const filter = [...base];
    if (attempt.categoryPath) filter.push({ attribute: 'categoryPath', eq: attempt.categoryPath });
    if (attempt.activity) filter.push({ attribute: 'activity', eq: attempt.activity });
    // eslint-disable-next-line no-await-in-loop
    const { data, errors } = await graphql(extra, SEARCH_QUERY, { phrase, filter, pageSize: limit });
    ensureNoErrors(errors);
    result = data.productSearch || {};
    if (num(result.total_count) || i === attempts.length - 1) {
      if (activity && !attempt.activity) relaxed.push('activity');
      if (categoryPath && !attempt.categoryPath) relaxed.push('category');
      break;
    }
  }
  return {
    total: num(result.total_count) ?? 0,
    products: (result.items || []).map((i) => normalizeProduct(i?.productView)).filter(Boolean),
    category: categoryPath || null,
    relaxed,
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

/*
 * Cart documents. Every cart selection includes Commerce's opaque revision token
 * (Cart.wknd_cart_version), so it is part of cart_version: a shopper's reviewed cart_version pins
 * exactly one backend cart revision. These need a Commerce release with the reviewed-version
 * contract; there is no fallback (release Commerce first in each environment, then this app).
 */
const CART_SELECTION = `${CART_FIELDS}\n  wknd_cart_version`;
const CART_QUERY = `query ShopCart { customerCart { ${CART_SELECTION} } }`;
const BUNDLE_OFFERS_QUERY = `query ShopFlightKitOffers($cartId: String!) {
  wkndBundleOffers(cart_id: $cartId) { promotion_id bundle_id cart_version }
}`;
const COMPLETE_BUNDLE_MUTATION = `mutation ShopCompleteFlightKit(
  $cartId: String!, $promotionId: String!, $bundleId: String!, $expected: String!
) {
  completeWkndBundle(cart_id: $cartId, promotion_id: $promotionId,
    bundle_id: $bundleId, expected_cart_version: $expected) {
    cart { ${CART_SELECTION} }
    user_errors { code message }
  }
}`;
const ADD_MUTATION = `mutation ShopAdd($cartId: String!, $items: [CartItemInput!]!) {
  addProductsToCart(cartId: $cartId, cartItems: $items) {
    cart { ${CART_SELECTION} }
    user_errors { code message }
  }
}`;
const UPDATE_MUTATION = `mutation ShopUpdate($input: UpdateCartItemsInput!) {
  updateCartItems(input: $input) { cart { ${CART_SELECTION} } errors { code message } }
}`;
const APPLY_OFFER_MUTATION = `mutation ShopApplyOffer($cartId: String!, $expected: String!) {
  applyWkndRecoveryOffer(cart_id: $cartId, expected_cart_version: $expected) { outcome }
}`;
const REMOVE_OFFER_MUTATION = `mutation ShopRemoveOffer($cartId: String!, $expected: String!) {
  removeWkndRecoveryOffer(cart_id: $cartId, expected_cart_version: $expected) { outcome }
}`;

/** The server revision token if well formed, else null (offer changes then fail closed). */
function serverVersionOf(cart) {
  const token = typeof cart?.wknd_cart_version === 'string' ? cart.wknd_cart_version : '';
  return SERVER_VERSION.test(token) ? token : null;
}
const EMAIL_MUTATION = `mutation ShopEmail($input: SetGuestEmailOnCartInput!) {
  setGuestEmailOnCart(input: $input) { cart { id } }
}`;
const COUPON_MUTATION = `mutation ShopCoupon($input: ApplyCouponToCartInput!) {
  applyCouponToCart(input: $input) { cart { id } }
}`;
// No `reason`: ineligibility reasons describe shopper behaviour and are never forwarded.
const OFFER_FIELDS = 'status coupon_code percent_off max_discount { value currency } expires_at saving { value currency } current_saving { value currency }';
const OFFER_QUERY = `query ShopOffer($cartId: String!) { wkndRecoveryOffer(cart_id: $cartId) { ${OFFER_FIELDS} } }`;
// Commerce's engine-selected climbing planner offer (same v1 fields; applied automatically, no
// claim mutation). Read best effort on the verified Stage and Production deployments.
const GENERAL_OFFER_QUERY = 'query ShopPlannerOffer($cartId: String!) { wkndPlannerOffer(cart_id: $cartId) { status percent_off max_discount { value currency } expires_at saving { value currency } current_saving { value currency } } }';
const GENERAL_OFFER_RESOURCES = [
  'https://28538-wkndsherpa-stage.adobeio-static.net/api/v1/web/llm-apps/mcp',
  MCP_RESOURCE,
];
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
  // Commerce's revision token is hashed in (raw, before any output sanitising), never returned.
  summary.version = cartVersion(summary, text(cart.wknd_cart_version, 120) || null);
  summary.missing = missingForOrder(summary);
  summary.ready = summary.missing.length === 0;
  hideProtectedCoupons(summary, PROTECTED_COUPON_CODES);
  return summary;
}

/**
 * Removes protected promotion codes from a normalized cart (after its version was computed, so
 * applying or removing one still changes cart_version). `offer_applied` tells widgets and the
 * model that the welcome-back offer is on the cart without revealing its code.
 */
function hideProtectedCoupons(cart, codes) {
  const hidden = new Set(codes.filter(Boolean).map((c) => String(c).toUpperCase()));
  const visible = cart.coupons.filter((c) => !hidden.has(c.toUpperCase()));
  const applied = visible.length !== cart.coupons.length;
  cart.coupons = visible;
  cart.offer_applied = Boolean(cart.offer_applied || applied);
  return cart;
}

/** Replaces any protected promotion code in shopper-facing text. */
function maskCodes(value, codes = []) {
  return [...PROTECTED_COUPON_CODES, ...codes].filter(Boolean).reduce(
    (out, code) => out.replace(new RegExp(`(?<![A-Za-z0-9])${String(code).replace(/[^A-Za-z0-9]/g, '\\$&')}(?![A-Za-z0-9])`, 'gi'), 'welcome-back offer'),
    String(value ?? ''),
  );
}

/**
 * Masks protected promotion codes in every string of a tool result (content text, structured
 * content, errors, warnings). Shopper-entered ordinary codes are left as they are.
 */
function sanitizeOutput(value, codes = []) {
  if (typeof value === 'string') return maskCodes(value, codes);
  if (Array.isArray(value)) return value.map((v) => sanitizeOutput(v, codes));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeOutput(v, codes)]));
  }
  return value;
}

/**
 * Fingerprint of everything that changes what an order would contain or cost. Writes may pass the
 * version they were based on; a mismatch means the cart changed elsewhere (another tab, the website).
 */
function cartVersion(cart, serverToken = null) {
  const basis = JSON.stringify([
    serverToken,
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
  const appliedCoupons = (data.customerCart?.applied_coupons || []).map((c) => text(c?.code, 40).toUpperCase()).filter(Boolean);
  // `appliedCoupons` (raw, may include protected codes) and `serverVersion` (Commerce's revision
  // token, hashed into this same read's cart.version) are for handler decisions only, never output.
  return {
    id: data.customerCart?.id,
    cart: normalizeCart(data.customerCart),
    appliedCoupons,
    serverVersion: serverVersionOf(data.customerCart),
  };
}

/* ---------------- welcome-back (cart recovery) offer ---------------- */

const OFFER_COPY = {
  SIGN_IN_REQUIRED: 'Sign in with your WKND account to use the welcome-back offer.',
  ALREADY_APPLIED: 'The welcome-back offer is already applied to this cart.',
  NOT_BENEFICIAL: 'The welcome-back offer would not save more than the discount already on this cart, so it was not applied.',
  REDEEMED: 'This offer has already been used.',
  UNAVAILABLE: 'The welcome-back offer can’t be checked right now. Please try again shortly.',
  CART_CHANGED: 'Your cart changed while the offer was being applied, so it was not applied. Review the cart and try again.',
  RECOVERY_ALREADY_REDEEMED: 'This offer has already been used.',
  COUPON_ELIGIBILITY_UNAVAILABLE: 'The welcome-back offer can’t be checked right now. Please try again shortly.',
  DEFAULT: 'This welcome-back offer isn’t available for this cart.',
};
const OFFER_STATUSES = ['SIGN_IN_REQUIRED', 'UNAVAILABLE', 'INELIGIBLE', 'ELIGIBLE', 'CLAIMED', 'REDEEMED'];

/** A Commerce Money with a finite, non-negative value and an explicit ISO currency, or null. */
function offerMoney(m) {
  if (!m || typeof m.value !== 'number' || !Number.isFinite(m.value) || m.value < 0) return null;
  if (typeof m.currency !== 'string' || !/^[A-Z]{3}$/.test(m.currency)) return null;
  return { value: m.value, currency: m.currency };
}

/**
 * Commerce decides eligibility and savings; this only applies the agreed display rule:
 * ELIGIBLE/CLAIMED, saving > current saving (both valid, same currency), and its code not already
 * on the cart. Not signed in / ineligible / redeemed → no offer. A failed or malformed answer →
 * an explicit, non-actionable { status: 'UNAVAILABLE', message } (never mistaken for "no offer").
 * @returns {{ status: string, code: string|null, show: boolean, why: string|null, offer: object|null }}
 */
function offerDecision(raw, appliedCoupons = []) {
  const status = OFFER_STATUSES.includes(raw?.status) ? raw.status : 'UNAVAILABLE';
  const code = text(raw?.coupon_code, 40).toUpperCase() || null;
  const result = (why, offer = null) => ({
    status, code, show: !why, why, offer,
  });
  const unavailable = () => result('UNAVAILABLE', { kind: 'welcome_back', status: 'UNAVAILABLE', message: OFFER_COPY.UNAVAILABLE });
  if (['SIGN_IN_REQUIRED', 'INELIGIBLE', 'REDEEMED'].includes(status)) return result(status);
  if (status === 'UNAVAILABLE') return unavailable();
  const saving = offerMoney(raw.saving);
  const current = offerMoney(raw.current_saving);
  if (!code || !saving || !current || saving.currency !== current.currency) return unavailable();
  if (appliedCoupons.includes(code)) return result('ALREADY_APPLIED');
  if (!(saving.value > current.value)) return result('NOT_BENEFICIAL');
  const hidden = [...PROTECTED_COUPON_CODES, code];
  return result(null, {
    kind: 'welcome_back',
    status,
    saving,
    current_saving: current,
    percent_off: num(raw.percent_off),
    max_discount: offerMoney(raw.max_discount),
    expires_at: text(raw.expires_at, 40) || null,
    replaces_code: appliedCoupons.find((c) => !hidden.includes(c)) || null,
  });
}

/**
 * The offer to show with the cart. A failed lookup returns the explicit UNAVAILABLE state, and so
 * does a cart without a well-formed server revision token (the offer couldn't be changed safely).
 * On Stage, Commerce's general offers are read alongside (see displayedOffer).
 */
async function loadOffer(extra, shopper, cartId, appliedCoupons, serverVersion) {
  const general = GENERAL_OFFER_RESOURCES.includes(verifiedResource(extra?.authInfo))
    ? loadGeneralOffer(extra, shopper, cartId, serverVersion) : Promise.resolve(null);
  return displayedOffer(await loadRecoveryOffer(extra, shopper, cartId, appliedCoupons, serverVersion), await general);
}

async function loadRecoveryOffer(extra, shopper, cartId, appliedCoupons, serverVersion) {
  if (!cartId) return offerDecision(null, appliedCoupons);
  if (!SERVER_VERSION.test(serverVersion || '')) return offerDecision(null, appliedCoupons);
  try {
    const { data, errors } = await graphql(extra, OFFER_QUERY, { cartId }, { shopper, timeoutMs: OFFER_READ_TIMEOUT_MS });
    if (errors.length) return offerDecision(null, appliedCoupons);
    return offerDecision(data.wkndRecoveryOffer, appliedCoupons);
  } catch (e) {
    if (e instanceof ShopError && ['shop_authentication_failed', 'shop_contract_unavailable'].includes(e.code)) throw e;
    return offerDecision(null, appliedCoupons);
  }
}

/* ---------------- general (audience-qualified) offers ---------------- */

const PLANNER_UNAVAILABLE = 'The climbing planner offer can’t be checked right now, so no climbing discount is shown.';

/**
 * Commerce's climbing planner offer decoded with the v1 rules: ELIGIBLE/CLAIMED with valid
 * same-currency savings and saving > current saving → shown (CLAIMED = engine-selected; once
 * applied it appears as a cart totals discount instead); UNAVAILABLE or malformed → the explicit
 * non-actionable state; anything else → null. Only display fields are kept (no audience, draft,
 * provider or evidence fields), and the message is our own copy.
 */
function generalOfferDecision(raw) {
  const kind = 'climbing_planner';
  if (!raw || typeof raw !== 'object') return null;
  const unavailable = { kind, status: 'UNAVAILABLE', message: PLANNER_UNAVAILABLE };
  if (raw.status === 'UNAVAILABLE') return unavailable;
  if (!['ELIGIBLE', 'CLAIMED'].includes(raw.status)) return null;
  const saving = offerMoney(raw.saving);
  const current = offerMoney(raw.current_saving);
  if (!saving || !current || saving.currency !== current.currency) return unavailable;
  if (!(saving.value > current.value)) return null;
  const max = offerMoney(raw.max_discount);
  return {
    kind,
    status: raw.status,
    saving,
    current_saving: current,
    percent_off: num(raw.percent_off),
    max_discount: max && max.currency === saving.currency ? max : null,
    expires_at: text(raw.expires_at, 40) || null,
  };
}

/** Commerce's general offer for the cart, or null; never fails the cart (best effort). */
async function loadGeneralOffer(extra, shopper, cartId, serverVersion) {
  if (!cartId || !SERVER_VERSION.test(serverVersion || '')) return null;
  try {
    const { data, errors } = await graphql(extra, GENERAL_OFFER_QUERY, { cartId }, { shopper, timeoutMs: OFFER_READ_TIMEOUT_MS });
    return errors.length ? null : generalOfferDecision(data?.wkndPlannerOffer);
  } catch {
    return null;
  }
}

/**
 * One offer slot per cart. Commerce picks the best saving; this only chooses what to show:
 * the claimable welcome-back offer first, then an actionable general offer, then whichever
 * explicit "can't be checked" state there is. The recovery code stays in the decision for redaction.
 */
function displayedOffer(recovery, general) {
  const actionable = (o) => o && o.status !== 'UNAVAILABLE';
  const offer = [recovery.offer, general].find(actionable) || recovery.offer || general || null;
  return { ...recovery, offer };
}

function offerNotApplied(subcode, message, details = {}) {
  return new ShopError(409, 'offer_not_applied', message || OFFER_COPY[subcode] || OFFER_COPY.DEFAULT, { ...details, subcode });
}

const REVIEWED_UNAVAILABLE = 'The welcome-back offer can’t be changed here right now. Please try again later.';

/**
 * Applies the welcome-back offer with Commerce's reviewed-version mutation: Commerce claims it,
 * checks it saves strictly more than the current promotion, and writes only if the cart is still
 * at `serverVersion` — the token from the same read whose cart_version the shopper reviewed (the
 * caller asserts that first). The protected code never leaves Commerce. No fallback and no retry.
 * @returns {Promise<{ outcome: 'APPLIED'|'ALREADY_APPLIED' }>}
 */
async function applyOffer(extra, shopper, cartId, serverVersion) {
  if (!SERVER_VERSION.test(serverVersion || '')) throw offerNotApplied('REVIEWED_VERSION_UNAVAILABLE', REVIEWED_UNAVAILABLE);
  const { data, errors } = await graphql(extra, APPLY_OFFER_MUTATION, { cartId, expected: serverVersion }, { shopper });
  throwIfCartChanged(errors);
  if (errors.length) {
    const code = text(errors[0]?.extensions?.code, 60);
    if (code === 'OFFER_NOT_BETTER') throw offerNotApplied('NOT_BENEFICIAL');
    if (OFFER_ERROR_CODES.includes(code)) {
      // Shown as-is unless it mentions the revision token (then the fixed copy for that code).
      const message = text(errors[0].message, 200);
      throw offerNotApplied(code, message.includes(serverVersion) || /cart_version/i.test(message) ? undefined : message);
    }
    throw offerNotApplied('UNAVAILABLE', OFFER_COPY.DEFAULT);
  }
  const outcome = data.applyWkndRecoveryOffer?.outcome;
  if (!['APPLIED', 'ALREADY_APPLIED'].includes(outcome)) throw offerNotApplied('UNAVAILABLE', OFFER_COPY.DEFAULT);
  return { outcome };
}

/**
 * Removes only the welcome-back offer's protected coupon with Commerce's reviewed-version
 * mutation (any other coupon is left alone; entitlements and redemptions untouched). Same
 * reviewed-token binding as applyOffer.
 * @returns {Promise<{ removed: boolean }>} removed=false when none was applied (NOT_APPLIED)
 */
async function removeOffer(extra, shopper, cartId, serverVersion) {
  if (!SERVER_VERSION.test(serverVersion || '')) {
    throw new ShopError(409, 'offer_not_removed', REVIEWED_UNAVAILABLE, { subcode: 'REVIEWED_VERSION_UNAVAILABLE' });
  }
  const { data, errors } = await graphql(extra, REMOVE_OFFER_MUTATION, { cartId, expected: serverVersion }, { shopper });
  throwIfCartChanged(errors);
  const outcome = errors.length ? null : data.removeWkndRecoveryOffer?.outcome;
  if (!['REMOVED', 'NOT_APPLIED'].includes(outcome)) {
    throw new ShopError(409, 'offer_not_removed', 'The welcome-back offer could not be removed. Review your current cart and try again.', { subcode: 'UNAVAILABLE' });
  }
  return { removed: outcome === 'REMOVED' };
}

const formatDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
};

/** Model-facing description of a displayable offer (no code, no eligibility reasons). */
function offerText(offer) {
  if (!offer) return '';
  if (offer.kind === 'climbing_planner') {
    if (offer.status === 'UNAVAILABLE') return `${offer.message} Do not promise a climbing discount.`;
    const ends = formatDate(offer.expires_at);
    const terms = [
      offer.percent_off !== null ? `${offer.percent_off}% off selected climbing gear` : null,
      offer.max_discount ? `up to ${formatMoney(offer.max_discount)}` : null,
      ends ? `ends ${ends}` : null,
    ].filter(Boolean).join(', ');
    return `A WKND climbing planner offer saves ${formatMoney(offer.saving)} on this cart${terms ? ` (${terms})` : ''}. WKND applies it automatically while the cart qualifies; there is nothing to claim, so do not call apply_offer for it.`;
  }
  if (offer.status === 'UNAVAILABLE') return `${offer.message} Do not promise a welcome-back discount.`;
  const ends = formatDate(offer.expires_at);
  const terms = [
    offer.percent_off !== null ? `${offer.percent_off}% off gear` : null,
    offer.max_discount ? `up to ${formatMoney(offer.max_discount)}` : null,
    ends ? `ends ${ends}` : null,
    'one use per account',
  ].filter(Boolean).join(', ');
  return `A WKND welcome-back offer saves ${formatMoney(offer.saving)} on this cart (${terms}).${offer.replaces_code ? ` It replaces code ${offer.replaces_code}.` : ''} Apply it only if the shopper asks: call prepare_shop_checkout with apply_offer: true and this cart_version.`;
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
  return `Your WKND cart (${cart.item_count} item${cart.item_count === 1 ? '' : 's'}, version ${cart.version}):\n${lines.join('\n')}\n${cart.offer_applied ? 'The welcome-back offer is applied.\n' : ''}Total: ${formatMoney(cart.totals.grand_total)} incl. GST${cart.totals.shipping ? '' : ' (before shipping)'}.`;
}

module.exports = {
  ShopError,
  failure,
  requireShopper,
  personBindingFrom,
  restorePersonBinding,
  graphql,
  ensureNoErrors,
  throwIfCartChanged,
  searchProducts,
  getProducts,
  refineProduct,
  bestMatches,
  resolveOptions,
  attachSoldOutVariants,
  isSoldOutCombination,
  comboTitle,
  soldOutText,
  normalizeProduct,
  normalizeCart,
  loadCart,
  loadOffer,
  applyOffer,
  removeOffer,
  offerDecision,
  generalOfferDecision,
  displayedOffer,
  offerText,
  hideProtectedCoupons,
  maskCodes,
  sanitizeOutput,
  assertVersion,
  cartText,
  formatMoney,
  text,
  num,
  imageUrl,
  queries: {
    CART_QUERY,
    BUNDLE_OFFERS_QUERY,
    COMPLETE_BUNDLE_MUTATION,
    ADD_MUTATION,
    UPDATE_MUTATION,
    EMAIL_MUTATION,
    COUPON_MUTATION,
    OFFER_QUERY,
    GENERAL_OFFER_QUERY,
    APPLY_OFFER_MUTATION,
    REMOVE_OFFER_MUTATION,
    SHIPPING_ADDRESS_MUTATION,
    BILLING_ADDRESS_MUTATION,
    SHIPPING_METHOD_MUTATION,
    PAYMENT_MUTATION,
    CUSTOMER_QUERY,
    PLACE_ORDER_MUTATION,
  },
  constants: {
    MCP_RESOURCE, IDENTITY_ISSUER, SHOP_SCOPE, DELEGATION_AUDIENCE, DEFAULT_GRAPHQL_URL, PAYMENT_METHOD, DEMO_NOTICE, AU_STATES, PLACEHOLDER_EMAIL, SITE_HOST,
    PROTECTED_COUPON_CODES, OFFER_ERROR_CODES,
  },
};
