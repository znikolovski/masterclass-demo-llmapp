# Adobe LLM Apps boilerplate

Starter repo for building [Adobe LLM Apps](#) — AI tools with optional interactive widgets — on Adobe I/O Runtime. Implements the [Model Context Protocol](https://modelcontextprotocol.io/) so tools render in any MCP-compatible host (Claude, Cursor, ChatGPT, …).

Built on the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) with the [MCP Apps extension](https://modelcontextprotocol.github.io/ext-apps/api/documents/Overview.html). The server runtime lives in the standalone [`@adobe/llm-apps-runtime`](https://www.npmjs.com/package/@adobe/llm-apps-runtime) package — this repo is the thin scaffold around it.

## The developer contract

You write **handlers only**. Everything else — tool name, description, input schema, annotations, widget visibility, permissions, CSP — lives in the Adobe LLM Apps UI and is materialized into `actions.json` by the deploy pipeline.

- **Metadata** → authored in the UI, stored in the DB.
- **Handler code** → authored in this repo, deployed from your branch.
- **Local dev** → download `actions.json` from the UI to mirror production exactly.

You never hand-edit metadata in this repo, never register a tool in code, never re-publish the UI to change a description.

## Quick start

```bash
npm install
npm run dev:local
```

`dev:local` builds with webpack and starts a plain Node.js HTTP server on `http://localhost:9080`. No Adobe credentials required — use this for 95% of handler iteration.

```
  LLM Apps local server running
  Endpoint: http://localhost:9080
```

Point Claude Desktop, Cursor, or MCP Inspector at that URL. See [Connecting a host](#connecting-a-host).

To deploy to Adobe I/O Runtime instead, see [Running on Adobe I/O Runtime](#running-on-adobe-io-runtime).

## Workflow

```
1. Write handler       actions/<name>/index.js
2. Download config     Actions page → Download actions.json (mirrors prod)
3. Run locally         npm run dev:local
4. Ship it             git push → deploy pipeline builds & deploys
```

### 1. Write a handler

```js
// actions/weather-lookup/index.js
module.exports = async ({ city }) => {
  const { temperatureC } = await fetchWeather(city)
  return {
    content: [
      { type: 'text', text: `${city}: ${temperatureC}°C` }
    ],
    structuredContent: { city, temperatureC }
  }
}
```

A handler is a plain async function. It receives the tool's `arguments` object and must return `{ content, structuredContent? }`. See [`content` vs `structuredContent`](#content-vs-structuredcontent).

### 2. Download `actions.json`

On the Actions page of your app in the LLM Apps UI, click **Download actions.json** and drop the file at the repo root. This is the exact same payload the deploy pipeline writes in production.

`actions.json` is gitignored — it's per-developer local state, not part of the repo. If you skip this step, handlers still register (with empty metadata) but you won't see the real title, description, input schema, or widget behavior configured in the UI.

### 3. Run locally

```bash
npm run dev:local
```

Restart after handler changes — webpack inlines everything into `dist/index.js` at build time.

### 4. Ship it

```bash
git push origin your-branch
```

The deploy pipeline clones your repo, fetches the latest metadata from the API, writes `actions.json`, runs `npm install && npm run build`, and deploys to I/O Runtime. You don't build or deploy manually.

## Authoring with Claude (optional)

This repo ships a Claude skill at [`.claude/skills/llm-apps-action-author/`](.claude/skills/llm-apps-action-author/SKILL.md) that automates steps 1 and 4. Claude Code and Cursor auto-discover it when you open this repo.

### What it does

- Scaffolds handler + optional `widget.html` from templates.
- Validates the handler export shape and return contract.
- Redirects you back to the UI whenever you try to edit metadata in code.
- Explains widget resolution (`widget.html` > EDS config > tool-only).

### Example prompts

- **Scaffold a tool-only action.**
  > "Add a new action called `currency-convert` that takes `amount`, `from`, `to` and returns the converted amount as text."

- **Scaffold an action with a custom HTML widget.**
  > "Scaffold a new action `weather-lookup` with a widget. The handler should return a short text summary plus structured data for the widget."

- **Fill in a handler you already scaffolded.**
  > "Implement the handler in `actions/currency-convert/index.js`. It should call `https://api.exchangerate.host/convert` and return the converted amount. Don't hand-edit `actions.json`."

- **Validate before shipping.**
  > "Run the skill's `validate-handler.js` against every file under `actions/*/index.js` and tell me what fails."

- **Debug a tool that isn't appearing.**
  > "My `echo` tool isn't showing up in the Inspector. Use the skill's troubleshooting guide to figure out why."

- **Refuse metadata edits in code.**
  > "Change the description of my `weather-lookup` tool to 'Look up current weather by city'."

  The skill will redirect you to the LLM Apps UI instead of editing `actions.json`.

### CLI-only usage (without Claude)

The skill's scripts are zero-dependency and usable from any shell:

```bash
# Create actions/weather-lookup/index.js + widget.html from templates
bash .claude/skills/llm-apps-action-author/scripts/scaffold-action.sh weather-lookup --widget

# Sanity-check a handler's export shape and return contract
node .claude/skills/llm-apps-action-author/scripts/validate-handler.js actions/weather-lookup/index.js
```

## Widget cases

| Case | Handler | Widget source | Authored in |
|---|---|---|---|
| Tool only | required | — | handler code + UI metadata |
| EDS widget | optional | `widget_type: "EDS"` + `eds_widget` in `actions.json` | UI only |
| Custom HTML widget | optional | `actions/<name>/widget.html` | handler code + `widget.html` file + UI metadata |

**Resolution priority** (checked in order):

1. `widget.html` file in the action directory
2. EDS config in `actions.json`
3. No widget (tool-only)

### Tool only

Just a handler, no widget file, no EDS config. The tool returns text; the host shows that text inline.

### EDS widget

No local file needed. Configure `widget_type: "EDS"` and `eds_widget.script_url` + `eds_widget.widget_embed_url` in the UI; the loader generates an `<aem-embed>` template automatically. Use this when the widget is an AEM Edge Delivery page.

### Custom HTML widget

When you need a fully custom, self-contained widget, drop a `widget.html` file next to your `index.js`. It's inlined into the `ui://<name>/widget.html` resource at build time. The file must be self-contained — use inline `<script>` blocks, not external bundles that need webpack to resolve. See the [MCP Apps examples](https://modelcontextprotocol.github.io/ext-apps/api/documents/Examples.html) for the postMessage contract between your widget and the host.

During local dev you can round-trip a custom widget without the UI: the `widget.html` you commit wins over any EDS config.

## Auth in actions

Same split as everything else: **whether** an action requires auth lives in the UI, **how your handler uses the token** lives in code. See `actions/whoami/index.js` for a working reference.

In the llm-apps UI, per action you can set:

- `requiresAuth: true` — this action needs a valid, verified token before your handler runs.
- `scopes: [...]` — a token must carry all of these to reach your handler.

And at the app level, an `auth` block (issuer, JWKS URI, resource, supported scopes) that describes the identity provider you're trusting. Both are UI-only concerns — nothing to configure in this repo.

When both are set, the runtime verifies the caller's bearer token (signature, issuer, audience, expiry) **before** your handler ever runs, and forwards the result as the handler's second argument:

```js
module.exports = async (args, extra) => {
    const authInfo = extra?.authInfo
    // {
    //   token: '<raw bearer token>',
    //   clientId: '<client_id/azp claim>',
    //   scopes: ['orders:read', ...],
    //   expiresAt: <unix seconds>,
    //   resource: '<verified audience>',
    //   extra: { sub: '<subject claim>', ...other allow-listed claims }
    // }
}
```

If the action isn't `requiresAuth: true`, or the app's `auth` block isn't enabled, `authInfo` is simply `undefined` — treat that as "no identity available," not an error.

**Reading the caller's identity** — safe to use directly (`authInfo.extra.sub`, `authInfo.clientId`, `authInfo.scopes`).

**Calling another API as the caller** — forward `authInfo.token` as a normal Bearer header, exactly like a browser would:

```js
const response = await fetch(upstreamUrl, {
    headers: { Authorization: `Bearer ${authInfo.token}` }
})
```

Rules that matter here specifically:

- **Never log or return the raw token** (or any header containing it) — it's a live credential, and `console.log` output on I/O Runtime is retained.
- Missing/insufficient auth is enforced by the runtime **before** your handler runs — you don't need to re-check `requiresAuth`/`scopes` yourself.
- Locally (`npm run dev:local`), without a real IdP wired into your `actions.json`'s `auth` block, `authInfo` will always be `undefined` — write your handler to degrade gracefully (see `whoami`'s fallback message), and cover both branches in your tests. `test/actions/whoami.test.js` shows how: hand-construct an `extra.authInfo` object shaped like the real thing, no MCP server or real token needed.

## Variables & secrets in actions

Same split again: declaring a variable (name, and type `string` or `secret`) is done in the llm-apps UI; reading it is your handler's job. See `actions/greet/index.js` for a working reference.

Once declared and deployed, the runtime forwards every variable into the handler's second argument as `extra.variables`, keyed by name — `string` and `secret` types surface identically, nothing in code distinguishes them:

```js
module.exports = async (args, extra) => {
    const prefix = extra?.variables?.GREETING_PREFIX || 'Hello'
}
```

**Never log or return a `secret`-typed value** — same rule as `authInfo.token` above.

Locally (`npm run dev:local`), simulate declared variables with `--param` flags (the same mechanism already used for `LLMA_ANALYTICS_*`):

```bash
node server/local.js \
  --param 'LLMA_VARIABLE_NAMES=["GREETING_PREFIX"]' \
  --param GREETING_PREFIX=Howdy
```

Without those flags, `extra.variables` is `undefined` and `greet` falls back to its default greeting — degrade gracefully, same as `authInfo`.

## Authenticated WKND booking lookup

The upstream boilerplate is
[`adobe-rnd/llm-apps-boilerplate`](https://github.com/adobe-rnd/llm-apps-boilerplate).
The integration through `b164c16d4afcab24f80453e6a061f177e8a7cd7c` used
`@adobe/llm-apps-runtime` 1.2.0 from the upstream lockfile, while retaining
WKND handlers, analytics, tests, and EDS widget configuration. The app now depends
on runtime `^1.7.0` (required by the LLM Apps UI for user-intent platform filtering;
1.5.0+ adds Gemini widget support); upstream's example actions were not merged.
After pulling this update, redeploy through LLM Apps so it rebuilds the action
with the new runtime and UI-owned metadata. Installing dependencies locally does
not update the deployed MCP server. Reconnect and verify the booking tool in the
real host after deployment; a successful local build does not establish that an
OAuth reconnect loop is resolved.

`actions/check-booking/index.js` implements the deployed **`check-booking`**
tool (hyphenated, not `check_booking`). Existing public tools are unchanged.
The handler and the website's `check-booking` EDS block support:

- `{ "booking_id": "BK_0123456789abcdef" }`: details of a booking owned by the
  signed-in caller.
- `{}`: the caller's booking summaries; `{ "cursor": "<nextCursor>" }`: the next
  page. **Listing cannot be invoked through the deployed schema until the UI
  makes `booking_id` optional and adds optional string `cursor`.** The current
  required-string `booking_id` schema remains compatible with detail lookup.

There are no owner, email, subject, or account arguments. Identity comes only
from verified `extra.authInfo.extra.sub`; ownership is enforced by the Worker,
not by filtering an unprotected list in this app. The handler explicitly refuses
missing identity, expired/mismatched resource context, or missing `bookings:read`,
even if UI authorization was accidentally disabled. Do not expose a raw Runtime
action that lets untrusted callers supply `extra.authInfo`.

### Required Adobe LLM Apps UI settings

Metadata remains UI-owned: **do not edit `actions.json`**. Before deployment:

1. Enable application authentication with issuer
   `https://dev-g4kzp3zwgwzs8oha.us.auth0.com/`, its Auth0 JWKS endpoint
   `https://dev-g4kzp3zwgwzs8oha.us.auth0.com/.well-known/jwks.json`, resource
   `https://28538-wkndsherpa.adobeio-static.net/api/v1/web/llm-apps/mcp`,
   and supported scope `bookings:read`. Auth0 must issue tokens for this resource
   and grant that scope.
2. On **`check-booking`**, set `requiresAuth: true`, required scope
   `bookings:read`, and select an **EDS widget** with:
   - Script URL: `https://main--masterclass-demo--znikolovski.aem.page/scripts/aem-embed.js`
   - Widget URL: `https://main--masterclass-demo--znikolovski.aem.page/eds-widgets/check-booking`

   The page contains the `check-booking` EDS block and uses the shared LLM Apps
   SDK. Do not add a local `actions/check-booking/widget.html`: it would override
   the EDS configuration. Allow the action to be
   called by the widget as well as the model for details, paging, and refresh.
   Keep `booking_id` a string; make it optional and add optional string `cursor`
   when enabling list mode. Never add owner inputs.
3. Declare these app variables, which the runtime passes in `extra.variables`:

   | Variable | UI type | Value |
   | --- | --- | --- |
   | `WKND_BOOKING_API_BASE` | `string` | Optional HTTPS **origin**; defaults to `https://wknd-aero-api.jaggah.workers.dev`. No path, query, credentials, or fragment. |
   | `WKND_BOOKING_ASSERTION_SECRET` | Server-side secret | Required shared UTF-8 signing key, at least **32 bytes**, provisioned out of band and identical to the Worker's secret. The current UI does not support secrets; do not save it as an ordinary Variable. Secure runtime provisioning remains required. Never commit or print it. |

4. Download fresh `actions.json` from the UI if local protocol testing is needed.
   Deployment regenerates metadata and builds the EDS wrapper from these URLs.
   The EDS block uses the shared SDK for initial results, updates, tool calls,
   links, and resizing. It never fetches private bookings directly; all booking
   calls use the host bridge and the tool's authorization.

### Temporary reconnect diagnostic

`actions/check-booking-auth/index.js` is a tool-only diagnostic for the current
reconnect investigation. In LLM Apps, register **`check-booking-auth`** with
authentication **not required**, no required scopes, no widget, and model
visibility. Use this explicit empty input schema so the SDK passes both tool
arguments and request context:

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

Keep application authentication enabled and keep **`check-booking`** protected
with `bookings:read`. Deploy the latest repository code and refreshed UI metadata,
then ask ChatGPT to run `check-booking-auth` and display its status flags. The
diagnostic returns the same flags in text and structured content, never tokens,
claim values, user identifiers, request headers, secrets, or bookings. Its handler
does not log, fetch, or change data.

`runtime_verified` reports whether the Runtime supplied verified auth context.
The other JWT claim checks are **unverified diagnostics**, not authorization:

| Result | Meaning |
| --- | --- |
| `bearer_token_present: false` | No bearer token is visible in the request context. |
| `bearer_token_present: null` | Headers and a verified token are unavailable; token presence is unknown. |
| `runtime_verified: true`, `runtime_has_booking_scope: false` | Token verification passed but `bookings:read` was not granted. |
| `runtime_verified: false`, `audience_matches: false` | Visible JWT claims target a different audience; check Auth0's MCP API identifier and requested resource. |
| `token_expired: true` | The visible JWT expiration has passed. |
| `runtime_verified: false`, compatible claim checks | Claims alone cannot establish validity; investigate signature/key validation and the issued token. |

Remove the diagnostic from the UI and repository after the investigation. It
does not replace booking authentication or resolve signing-key provisioning.

### Worker deployment prerequisite and trust boundary

The handler only makes HTTPS, nonredirecting, eight-second-timeout, `no-store`
GET requests to `/api/bookings` or `/api/bookings/<booking_id>`. It sends
`X-WKND-Delegation: mcp` and `Authorization: Bearer <HS256 assertion>` — **never**
the caller's MCP access token, whose audience is not the Worker. The assertion
uses `alg: HS256`, `typ: JWT`, the MCP resource as `iss`, the configured Worker
origin as `aud`, the verified subject as `sub`, the Auth0 issuer as
`identity_issuer`, `scope: "bookings:read"`, current `iat`, a fresh UUID `jti`,
and `exp` at most 60 seconds later and no later than the caller's expiry.

**This companion change alone does not establish backend owner mapping.** The
parent Worker/checkout implementation must be deployed before end-to-end
authenticated lookup works. It must independently verify the delegation marker,
signature, issuer, audience, identity issuer, scope, and lifetime, accept
delegation only for read-only GET operations, and map ownership using the same
Auth0 issuer + subject stored by authenticated checkout. Old anonymous demo
bookings must not become claimable by ID or email. Worker and app secrets must
match; there is no unsigned or mock fallback.

Upstream 401/403/404 are explicit tool errors with safe messages; service,
transport, malformed-response, and timeout errors remain errors, not successful
empty lists. Upstream bodies and credentials are never echoed on errors.
Successful responses project only the documented booking/flight/adventure/
preparation fields: no tokens, contact details, or owner identifiers in either
text or widget data. No private response caching or widget storage is used.

The EDS widget supports list/detail navigation, keyboard forms, narrow screens,
loading/error/empty states, and a demo badge. Scheduled instants use their
published time zones; absent instants never acquire an invented date. Empty or
missing preparation arrays are explicitly **unavailable / not confirmed**,
not “no permit needed.” Standalone/preview pages never display sample private
bookings. Nonempty preparation is published guidance, not proof
of approval. The app does no enrichment or mock-derived guidance; the Worker
must populate preparation only from real published attributes when available.

Focused local validation (mocked verified auth and Worker responses, no live
credentials):

```bash
npx eslint actions/check-booking/index.js test/actions/check-booking*.test.js
npx jest test/actions/check-booking --runInBand
node .claude/skills/llm-apps-action-author/scripts/validate-handler.js actions/check-booking/index.js
npm run build
```

EDS widget browser coverage lives in the website repository:
`node tools/scripts/test-check-booking-widget.mjs`.

The existing `test/server.test.js` replaces and removes local `actions.json`.
Preserve any UI-downloaded copy before running the full `npm test` suite and
download it again before metadata-dependent smoke tests or builds. Without a
download, `prebuild` creates only an empty local placeholder.

Real signed-in host testing still requires the UI changes, a working Auth0
consent flow, the shared secret, and the deployed owner-aware Worker. In
particular, test account A versus account B, deny account B access to A's booking,
confirm paging and logout behavior, and verify the host does not reuse another
account's private widget result.

## WKND shop in ChatGPT: shared cart and Demo Pay checkout

Seven tools bring the WKND Adventures shop (`/shop` on the website, backed by the mock Adobe
Commerce service in the sibling `wknd-commerce` App Builder repo) into the conversation. A signed-in
shopper gets **the same cart** in ChatGPT and on the website, and can check out in chat with
**WKND Demo Pay** — demonstration only: no payment details are collected, nothing is charged, nothing
ships.

| Tool (UI name) | Auth | Annotations | Dedicated EDS widget | Purpose |
| --- | --- | --- | --- | --- |
| `search-shop-products` | none | read-only | `/eds-widgets/search-shop-products-demo` | Live catalog search with category/activity/price/stock filters |
| `get-shop-product` | none | read-only | `/eds-widgets/get-shop-product-demo` | One product: options with live stock; exact variant when `options` are given (preselected in the widget) |
| `get-shop-cart` | `shop:cart` | read-only | `/eds-widgets/get-shop-cart-demo` | The shopper's active cart |
| `add-shop-cart-items` | `shop:cart` | write | none (tool-only) | Add explicitly chosen SKUs/variants; called by the widgets or the model |
| `update-shop-cart-items` | `shop:cart` | write, idempotent | none (tool-only) | Absolute quantities per line (`0` removes); called by the cart widget or the model |
| `prepare-shop-checkout` | `shop:cart` | write | `/eds-widgets/prepare-shop-checkout-demo` | Email, new or saved address, delivery method, coupon, Demo Pay. Never orders |
| `place-shop-demo-order` | `shop:cart` | write, destructive | none (tool-only) | Places the **reviewed** cart (version + total must match); called by the checkout widget |

Handlers live in `actions/<tool>/index.js`; Commerce access, the delegated assertion and normalisation
live in `actions/lib/commerce.js`. Every tool with a UI has its **own EDS block** in the website repo,
named after the tool (`blocks/<tool>/`), with its own widget page `/eds-widgets/<tool>-demo`. Shared
rendering lives in `scripts/llmapp-shop.js` and `styles/llmapp-shop.css`. Widgets hand off between
steps through the conversation (for example, the cart's "Check out" asks the assistant to run
`prepare-shop-checkout`, which opens the checkout widget). Do not add `widget.html` to these action
directories: it would override the EDS widget.

**Gear checklist → shop.** `build-gear-checklist` matches checklist items to in-stock WKND products in
one batched lookup (`shop_matches`, `shop_status` in its result; curated rules in
`SHOP_RULES`). The match is best effort (6-second timeout): if the shop is unavailable the checklist
is returned unchanged with `shop_status: "unavailable"`. Its widget shows the matched product under
each item, with **Add to cart** for simple products (via `add-shop-cart-items`) and **Choose options**
for products with sizes or colours (a follow-up that opens the `get-shop-product` widget). Gear the
shop does not sell (tents, stoves, maps) stays a plain checklist item.

### How the shared cart works

- Commerce stays the source of truth: this app keeps no cart state and has no mock fallback.
- Catalog reads are anonymous. Cart and checkout calls carry a 60-second HS256 **delegated shopper
  assertion** (`X-WKND-Delegation: mcp`, `iss` = MCP resource, `aud` = `urn:wknd-commerce:storefront`,
  verified Auth0 `sub`, `scope: shop:cart`, single-use `jti`), signed with
  `WKND_COMMERCE_ASSERTION_SECRET`. The MCP access token is never forwarded.
- `storefront-graphql` verifies the assertion and resolves the customer by Auth0 `sub` — the same
  customer, and therefore the same `customerCart`, the website's Auth0 sign-in resolves. A first
  sign-in in ChatGPT creates the customer; the website fills in the profile on its next sign-in.
  Guest carts merge into it when the shopper signs in on the website (drop-in behaviour).
- Every cart result carries a `version` (a hash of lines, totals, contact, address, delivery and
  payment). Writes may pass `cart_version`; if the cart changed elsewhere (website tab, another chat,
  a retry) the call fails with `cart_changed` and returns the current cart instead of applying a
  stale or duplicate change. `place-shop-demo-order` **requires** `cart_version`,
  `expected_grand_total` and `confirm: true`. Its assertion also signs the reviewed lines and total
  (`order_expect`), which the backend checks against the exact cart revision it claims, so a cart
  edited between review and placement is never ordered and one cart produces at most one order.
- The website refreshes a signed-in shopper's cart when its tab regains focus, so changes made in
  ChatGPT (or an order placed there) appear without a reload.

### Required Adobe LLM Apps UI settings

1. **App auth:** add `shop:cart` to the supported scopes (next to `bookings:read`). In Auth0, define
   `shop:cart` on the API whose identifier is the MCP resource and allow the ChatGPT client to request
   it.
2. **Variables:**

   | Variable | UI type | Value |
   | --- | --- | --- |
   | `WKND_COMMERCE_GRAPHQL_URL` | `string` | Optional HTTPS URL of the `storefront-graphql` web action. Defaults to production `https://28538-wkndcommerce.adobeioruntime.net/api/v1/web/commerce/storefront-graphql`. |
   | `WKND_COMMERCE_ASSERTION_SECRET` | Server-side secret | Required for cart tools: ≥ 32 bytes, identical to `wknd-commerce`'s `WKND_MCP_DELEGATION_SECRET`. Same provisioning caveat as `WKND_BOOKING_ASSERTION_SECRET`: never commit, print or store it as an ordinary variable. |

3. **Per tool:** if the UI offers per-action auth, set `requiresAuth: true` with required scope
   `shop:cart` on the five cart tools. If auth can only be set app-wide (current UI), leave the
   cart tools without it: their handlers verify the WKND sign-in and `shop:cart` themselves and,
   when missing, return the same `_meta["mcp/www_authenticate"]` challenge the runtime gate
   would, so ChatGPT still prompts the shopper to sign in. `search-shop-products` and
   `get-shop-product` work without sign-in.
   Give each tool with a UI its own **EDS widget**: script URL
   `https://main--masterclass-demo--znikolovski.aem.live/scripts/llmapp-embed.js` (the site's
   widget loader; it skips the site's `scripts.js` so Gemini can bundle it) and widget URL
   `https://main--masterclass-demo--znikolovski.aem.live/eds-widgets/<tool>-demo` — that is
   `…/search-shop-products-demo`, `…/get-shop-product-demo`, `…/get-shop-cart-demo` and `…/prepare-shop-checkout-demo`.
   `add-shop-cart-items`, `update-shop-cart-items` and `place-shop-demo-order` have no widget.
   Allow `app` visibility on the add/update tools so the widgets can call them. Give
   `place-shop-demo-order` **`app` visibility only**: the model then cannot place orders; the
   shopper does, with the checkout widget's "Place demo order" button after reviewing the totals.
4. **Widget CSP:** connect domains `https://main--masterclass-demo--znikolovski.aem.live`,
   `https://main--masterclass-demo--znikolovski.aem.page` and `https://edge.adobedc.net`; resource
   domains the same two EDS origins plus `https://delivery-p115476-e1135027.adobeaemcloud.com`
   (product images), `https://wknd-adventures.run.place`, `https://fonts.googleapis.com` and
   `https://fonts.gstatic.com`. Leave **Domain** empty: it requests a host-specific sandbox origin,
   not the site serving the widget. `entry.js` drops an `*.aem.page`/`*.aem.live` domain anyway,
   because ChatGPT cannot render a widget with it. The widgets call tools through the host bridge only.
5. **Input schemas** (all objects use `"additionalProperties": false`):

   | Tool | Properties |
   | --- | --- |
   | `search-shop-products` | `query` string (put what the shopper wants here, e.g. "rain jacket"); `category` string (path or name: `apparel/jackets`, `jackets`, `backpacks`); `activity` string (e.g. `Hiking`, `Trekking`); `min_price`, `max_price` number (AUD incl. GST); `in_stock_only` boolean (default true); `limit` integer 1–12. Category names resolve to catalog paths; a category or activity that leaves no results is dropped (activity first) and reported in `relaxed` |
   | `get-shop-product` | `sku` string (required); `options` object of option → value, e.g. `{ "colour": "Deep Ocean", "size": "M" }` |
   | `get-shop-cart` | none |
   | `add-shop-cart-items` | `sku` string (required); `quantity` integer 1–20 (default 1); `options` object of option → value, e.g. `{ "colour": "Deep Ocean", "size": "M" }`; `cart_version` string. One product per call (the UI has no array type) |
   | `update-shop-cart-items` | `line_id` string (required); `quantity` integer 0–20 (required; 0 removes the line); `cart_version` string. One line per call |
   | `prepare-shop-checkout` | `cart_version`, `email`, `saved_address_id`, `shipping_method` (`standard`, `express`, `international`), `coupon_code` strings; `shipping_address` object `{ firstname, lastname, street (string or 1–2 strings), city, region, postcode, country_code, telephone }`; `apply_offer`, `remove_offer` booleans (see Welcome-back offer) |
   | `place-shop-demo-order` | `cart_version` string, `expected_grand_total` number, `confirm` boolean — all required |

Backend prerequisite: deploy `wknd-commerce` with `WKND_MCP_DELEGATION_ISSUER` (this MCP resource)
and `WKND_MCP_DELEGATION_SECRET`. Without them every cart tool returns a sign-in error.

### Welcome-back offer (cart recovery)

`get-shop-cart` and `prepare-shop-checkout` return `structuredContent.offer` when Commerce
(`wkndRecoveryOffer`) reports the shopper's welcome-back offer as `ELIGIBLE` or `CLAIMED`, both
`saving` and `current_saving` are valid amounts in the same currency, the saving is strictly larger,
and the offer is not already applied. Signed out, ineligible, redeemed, not beneficial, applied or an
empty cart → `offer: null`. A failed lookup, a Commerce `UNAVAILABLE`, or a malformed answer →
`offer: { kind: 'welcome_back', status: 'UNAVAILABLE', message }` (explicit, never an Apply card).
Commerce decides eligibility and the saving; the app only displays it. A shown offer carries
`status`, `saving`, `current_saving`, `percent_off`, `max_discount`, `expires_at` and
`replaces_code` (the shopper's own code it would replace; never a protected code). Eligibility
reasons are never requested. Protected promotion codes (the offer's own code, plus the pinned
`RECOVER10` fallback) never reach the model or widgets: they are dropped from `cart.coupons` (the
cart says `offer_applied: true`) and masked in every string of every shop tool result; ordinary
shopper-entered codes are shown as usual. `cart_version` still hashes the raw codes.

Offer actions on `prepare-shop-checkout` (both optional Booleans; omitted or `false` is a no-op and
never blocks an ordinary `coupon_code`). They use only Commerce's reviewed-version contract
(`Cart.wknd_cart_version`, `applyWkndRecoveryOffer` and `removeWkndRecoveryOffer`,
wknd-commerce#7):

- Every cart read and cart mutation selects Commerce's revision token (`wknd_cart_version`,
  `v<revision>`) and hashes it, raw, into `cart_version`. The shopper's reviewed 16-hex
  `cart_version` therefore pins exactly one backend cart revision: the handler asserts it first,
  then sends the token from that same read as `expected_cart_version` (it never fetches a fresh
  token after the check). The token is never returned to the model or widgets, nor logged.
- `apply_offer: true` requires the reviewed `cart_version`, then calls
  `applyWkndRecoveryOffer(cart_id, expected_cart_version)`. Commerce claims the offer, checks it saves
  strictly more than the current promotion and writes only if the cart is still in the reviewed
  revision (`CART_CHANGED` otherwise; nothing written). `APPLIED` changes the total (review again);
  `ALREADY_APPLIED` is an honest no-op.
- `remove_offer: true` requires the reviewed `cart_version`, then calls
  `removeWkndRecoveryOffer(cart_id, expected_cart_version)`: only the protected welcome-back coupon is
  removed (`REMOVED`); with none applied it changes nothing and says so (`NOT_APPLIED`).
  Entitlements, redemptions and ordinary codes are untouched.
- A Commerce `CART_CHANGED` on any coupon write is a `cart_changed` conflict with the refreshed
  cart; it is never retried.
- A missing or malformed token fails closed: both actions return `REVIEWED_VERSION_UNAVAILABLE`
  without calling Commerce, and the offer is shown only as the non-actionable `UNAVAILABLE` state.
  There is no generic claim, generic coupon, clear-all or plural-remove fallback for the protected
  code.
- `apply_offer: true` with `remove_offer: true` → `conflicting_offer_actions`; either `true` with
  `coupon_code` → `conflicting_discounts`; either `true` without `cart_version` →
  `cart_version_required`. All are rejected before calling Commerce.

Release order (strict, per environment; there is no runtime fallback or feature flag): deploy
wknd-commerce#7 to an environment and verify it there, then deploy this app to the same
environment. Stage readiness does not authorise a Production release. Against an older Commerce
the cart tools fail explicitly with `shop_contract_unavailable` (502) rather than degrading.

A refusal to apply is an explicit `offer_not_applied` error (`subcode` = `NOT_BENEFICIAL` for
`OFFER_NOT_BETTER`, `UNAVAILABLE` for `RECOVERY_OFFER_UNAVAILABLE` or anything unexpected,
`REVIEWED_VERSION_UNAVAILABLE`, or the Commerce eligibility code, whose code-free message is shown
as-is unless it mentions the cart revision). A failed removal is `offer_not_removed` with the real
current cart. `place-shop-demo-order` reports an offer that stopped being
valid as `offer_invalid` with the current cart. Email consent is never changed here; shoppers manage
it at `https://wknd-adventures.run.place/account`.

### Climbing planner offer (general offer)

On **Stage and Production**, `get-shop-cart` and `prepare-shop-checkout` also read Commerce's
engine-selected `wkndPlannerOffer(cart_id)`, which has the same fields as `wkndRecoveryOffer`
without a code. It is read in parallel and best effort: if the field is missing or fails, the cart
and the welcome-back result are unchanged. The resource must match the verified Stage or
Production MCP deployment; Commerce owns audience qualification and offer activation.
- It is decoded with the v1 rules into `offer` `{ kind: 'climbing_planner', status, saving,
  current_saving, percent_off, max_discount, expires_at }`. UNAVAILABLE or malformed money gives
  the non-actionable state with our own message. Audience, draft, provider and evidence fields
  are dropped.
- It is applied automatically, so there is no claim mutation and `apply_offer` does not apply to
  it. Once applied it appears as a cart totals discount label; `offer_applied` stays
  welcome-back only.
- One offer is shown per cart: the claimable welcome-back offer first, then the planner offer.
  Commerce, not this app, chooses the best saving.
- Live AAM qualification is validated separately. A planner offer shown here is Commerce's demo
  decision, not verified audience membership.

### Production person binding

Successful Production cart and checkout reads also restore an existing authoritative `idLinkage`
grant through `target-diagnostic` (`wknd.person-binding/v1`, live 0.0.5). Each request reuses the
Commerce assertion signer with a fresh single-use signature; the runtime-verified shopper principal
is required. The MCP access token is never forwarded as a direct ShopperToken.

The only operations are `person-binding`, followed by a no-store `person-status` recheck. Neither
creates consent. Only the exact Production server-issued lease is accepted: canonical org/DPID/
namespace/issuer, `wpa_` alias, UUID consent generation, and UTC millisecond timestamps with an exact
five-minute lifetime. Alias or generation changes, withdrawal, expiry, malformed responses, or auth/
configuration failures discard the binding without changing cart totals or offer behavior.

The validated lease is returned only in private `_meta.wkndPersonBinding`, not model text or
`structuredContent`. No lease is cached across calls. A returned lease is not continuing-consent
proof: acting clients must clear it on withdrawal and expire it locally; another client's lease can
remain bounded by its five-minute expiry. No upstream deletion or realtime AAM removal is promised.
`semanticAllowlist` remains empty: there is no event adapter, membership claim, financial
authorization, consent writer, or delegated withdrawal operation.

LLM Apps UI (both Stage and Production, then redeploy): on `prepare-shop-checkout` add two
properties, each type **Boolean**, not required:

- `apply_offer`, description:

  > Set to true only when the shopper explicitly asks to apply the WKND welcome-back offer shown with their cart. Omit or set false to leave it unchanged. The shop decides eligibility and saving. Pass the latest cart_version. Do not combine true with remove_offer:true or coupon_code.

- `remove_offer`, description:

  > Set to true only when the shopper explicitly asks to remove the applied WKND welcome-back offer. Omit or set false to leave it unchanged. Pass the latest cart_version. Do not combine true with apply_offer:true or coupon_code.

No other metadata, auth, CSP or widget URL changes.

### Checkout scope

This is a private demo of in-chat checkout against a mock store. Production ChatGPT checkout is a
separate, gated workstream: OpenAI's plugin guidelines require external merchant checkout today, and
native (Instant) Checkout is limited to approved partners using the Agentic Commerce checkout and
delegated-payment specs. Do not reuse this flow for real payments.

Tests: `npx jest test/lib/commerce.test.js test/actions/*shop* test/actions/recovery-offer.test.js test/actions/build-gear-checklist.test.js`.

## Adobe Analytics for MCP actions

### WKND discovery: catalog browsing and filters

`discover_adventures` accepts an empty argument object to list the complete published
catalog. All filters are optional and combine: `{ "region": "Europe" }`,
`{ "experience_level": "beginner" }`, or
`{ "region": "Europe", "experience_level": "beginner" }` require no activity.
`{ "category": "trekking" }` filters authored categories; `activity` supports
specific activities such as hiking, surfing, kayaking, and cycling. `all`/`any`
mean no filter. Experience level is a suitability filter, not merely a ranking
hint: unknown or nonmatching levels are excluded. Pace, priority, and landscape
still rank matching adventures.

Discovery reads published page metadata when the query index omits it, with EDS
categories taking precedence over coarse commerce categories. Explicit European
locations (including the Alps, Balkans, and UK) match Europe; incidental references
in descriptions do not establish location or suitability. Unpublished fallback
records are not added to a successfully loaded live catalog. Discovery reports an
upstream error if both catalog sources fail, rather than presenting demo data as
a live catalog. Demo defaults never establish beginner suitability.
Text output includes every result, and the EDS widget renders the entire returned
list. `structuredContent.ranked` is false for browsing and true for preference ranking.

**Required Adobe LLM Apps UI update (metadata is not managed in this repo):**
remove `activity` and `experience_level` from the discovery action's required input
fields; make `category`, `activity`, `region`, `experience_level`, `landscape`,
`pace`, `priority`, `trip_length_days`, and `intent` optional. Add the `category`
string property with canonical values `trekking`, `water`, `climbing`, `cycling`,
`desert`, `winter-alpine`, `photography`, and `general-outdoor`. Keep it optional
so `{}` means all categories. The description should instruct the model to omit
unspecified filters, use region/level alone or together, and use `category` for
category listings rather than inventing personalization preferences. Preserve
existing output fields and allow `category` and `editorial_url` on adventure
items and `ranked` on the structured result. Download the updated `actions.json`
for local MCP validation, deploy the handler, and refresh the host's tool discovery
so it no longer caches the old required-input schema.

Optional customer analytics is **OFF**. The runtime contract currently provides no verified explicit
collection-consent signal; login, cart scope, host/session metadata, caller headers and an `idLinkage`
grant are not collection consent. `actions/lib/analytics.js` sends no live or backdated Edge requests
and preserves tool results. Synthetic `xdm.web.webPageDetails`/`pageViews` were removed.

The existing payload builder and mappings remain available for local dry-run inspection only.
Datastream variables or fallback configuration do not enable collection.

Before runtime registration, `entry.js` applies `sendsEdgeEvent: false` to every UI-generated action
using the runtime's existing opt-out. This prevents its automatic customer Edge event from bypassing
the disabled custom sender; other tool metadata, Variables and authentication are unchanged.

### Backfilling a week of report data

`npm run simulate:analytics -- --dry-run` can inspect local payloads but still executes handlers and
can contact their data providers. Do not run it as qualification evidence. Dropping `--dry-run` does
not enable Edge collection; backdated timestamps, ECIDs and simulated host sessions cannot grant
consent.

Generated kit/briefing output, planning engagement and private discovery correlation are not
approved AAM qualification events. No new event names, report-suite slots or audiences were added.

## `content` vs `structuredContent`

| | `content` | `structuredContent` |
|---|---|---|
| Consumer | LLM / text-only hosts | Widget iframe |
| Format | `[{ type: 'text', text: '...' }]` | Plain object (NOT a bare array) |
| Token cost | Counts against the context window | Zero (not sent to LLM) |

Always return `content` — it's the fallback for hosts that don't render widgets. Add `structuredContent` only when you have a widget that needs data.

## Connecting a host

Start the server (`npm run dev:local` or `npm run dev`), grab the printed URL, and plug it into your host as `<MCP_URL>`.

### curl

```bash
# List tools
curl -sX POST "<MCP_URL>" \
  -H 'content-type: application/json' \
  -H 'accept: application/json;q=1.0, text/event-stream;q=0.5' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Call the echo tool
curl -sX POST "<MCP_URL>" \
  -H 'content-type: application/json' \
  -H 'accept: application/json;q=1.0, text/event-stream;q=0.5' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello"}}}'
```

Both headers are required — the MCP streamable-http transport rejects other combinations.

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Transport Type = `streamable-http`, URL = `<MCP_URL>`.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "llm-apps-local": {
      "transport": {
        "type": "streamable-http",
        "url": "<MCP_URL>"
      }
    }
  }
}
```

Restart Claude Desktop. Tools appear under the plug icon.

### Cursor

Add to `~/.cursor/mcp.json` (or your workspace `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "llm-apps-local": {
      "url": "<MCP_URL>"
    }
  }
}
```

## Testing

```bash
npm test                       # all tests (handler units + server integration)
npx jest test/actions/echo     # only the echo handler tests
```

### Handler unit tests

Handler tests live in `test/actions/`, mirroring the `actions/` structure. Keeping tests outside `actions/` is load-bearing — webpack bundles everything under `actions/` into `dist/index.js`, so co-locating tests would ship them to I/O Runtime.

```
test/
└── actions/
    └── echo.test.js   # tests actions/echo/index.js
```

Copy `test/actions/echo.test.js` to test your own handlers in isolation — no MCP server, no network:

```js
// test/actions/my-action.test.js
const handler = require('../../actions/my-action/index.js')

test('returns expected text', async () => {
  const out = await handler({ city: 'London' })
  expect(out.content[0].text).toContain('London')
})
```

### Integration tests

`test/server.test.js` exercises the full request stack — action loading, MCP protocol, tool calls, resource reads. Use the developer integration test at the bottom of that file as a template for testing actions end-to-end:

```js
const path = require('path')
const { createMain } = require('@adobe/llm-apps-runtime')

const { main } = createMain({ actionsDir: path.join(__dirname, '..', 'actions') })

test('weather-lookup returns temperature', async () => {
  const res = await main({
    __ow_method: 'post',
    __ow_body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'weather-lookup', arguments: { city: 'London' } }
    }),
    __ow_headers: {
      'content-type': 'application/json',
      accept: 'application/json;q=1.0, text/event-stream;q=0.5'
    },
    LOG_LEVEL: 'info'
  })
  expect(JSON.parse(res.body).result.content[0].text).toContain('°C')
})
```

## Project layout

```
your-llm-app/
├── entry.js                   # Webpack entry — require.context + createMain invocation
├── actions/                   # Your handler directories (deployable files only)
│   ├── echo/
│   │   └── index.js           # Handler (plain async function)
│   ├── whoami/
│   │   └── index.js           # Handler reading extra.authInfo — see "Auth in actions"
│   └── greet/
│       └── index.js           # Handler reading extra.variables — see "Variables & secrets in actions"
├── test/
│   ├── actions/
│   │   ├── echo.test.js       # Handler unit tests (mirrors actions/ layout)
│   │   ├── whoami.test.js     # Same, but hand-builds extra.authInfo — no real IdP needed
│   │   └── greet.test.js      # Same, but hand-builds extra.variables — no deploy pipeline needed
│   ├── fixtures/actions.json  # Test config
│   └── server.test.js         # Server integration tests
├── server/
│   └── local.js               # Local dev HTTP server (no Adobe credentials)
├── actions.json               # Gitignored; download from UI or written by deploy pipeline
├── app.config.yaml            # I/O Runtime config (action name, memory, timeout)
├── webpack.config.js
└── package.json
```

## How action discovery works

`actions.json` is the source of truth for which tools get registered. For each entry, the loader looks for `actions/<name>/index.js`; if it exists, that module is the handler (it must export an async function). If the folder is missing, the tool still registers with a default handler that returns empty content — useful for widget-only actions. Widgets are resolved by checking for `widget.html` first, then falling back to the EDS template if `widget_type: "EDS"` is set. If `actions.json` is missing entirely (local dev before you've downloaded it), the loader falls back to scanning `actions/` and registers each handler with empty metadata, printing a banner so you notice.

The runtime logic lives in [`@adobe/llm-apps-runtime`](https://www.npmjs.com/package/@adobe/llm-apps-runtime). `entry.js` is the thin layer that calls webpack's `require.context` (compile-time path resolution) and passes the resulting maps to `createMain`. You don't touch `entry.js` unless you rename the `actions/` directory.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev:local` | Build + start a plain Node.js server on `http://localhost:9080` (no `aio` login). |
| `npm run dev` | `aio app run` — deploys to your I/O Runtime namespace and prints a public HTTPS URL. Requires `aio app use`. |
| `npm run build` | Webpack → `dist/index.js`. |
| `npm run deploy` | Build + `aio app deploy`. In practice the pipeline handles this. |
| `npm test` | Jest — handler units + server integration. |
| `npm run lint` / `format` | ESLint / Prettier over `actions/`. |

## Running on Adobe I/O Runtime

One-time: link this repo to a Console workspace.

```bash
aio app use           # interactive: pick org / project / workspace
```

That writes `.env` (runtime namespace + auth key) and `.aio` (project context). Both are gitignored.

Then:

```bash
npm run dev           # aio app run — deploys and prints a URL like
                      # https://<namespace>.adobeioruntime.net/api/v1/web/llm-apps/mcp
```

Use that URL as `<MCP_URL>` in [Connecting a host](#connecting-a-host). It changes per namespace — never hard-code it.

## License

See [LICENSE](LICENSE).
