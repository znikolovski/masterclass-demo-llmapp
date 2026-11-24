// General (audience-qualified) offers: best-effort consumer of Commerce's decision.
jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }))

const getCart = require('../../actions/get-shop-cart/index.js')
const prepare = require('../../actions/prepare-shop-checkout/index.js')
const { generalOfferDecision } = require('../../actions/lib/commerce.js')
const { shopper, cart, money, fakeCommerce } = require('../fixtures/shop.js')

const STAGE = 'https://28538-wkndsherpa-stage.adobeio-static.net/api/v1/web/llm-apps/mcp'
const stageShopper = () => shopper({ resource: STAGE })

const planner = (overrides = {}) => ({
    status: 'ELIGIBLE',
    percent_off: 10,
    max_discount: money(25),
    expires_at: null,
    saving: money(25),
    current_saving: money(0),
    ...overrides
})
const PLANNER_DTO = {
    kind: 'climbing_planner',
    status: 'ELIGIBLE',
    saving: money(25),
    current_saving: money(0),
    percent_off: 10,
    max_discount: money(25),
    expires_at: null
}
const recovery = (status = 'INELIGIBLE', overrides = {}) => ({
    status,
    coupon_code: 'RECOVER10',
    percent_off: 10,
    max_discount: money(25),
    expires_at: '2026-11-24T01:00:00.000Z',
    saving: money(25),
    current_saving: money(20),
    ...overrides
})
const routes = (recoveryOffer, general) => ({
    ShopCart: () => ({ data: { customerCart: cart() } }),
    ShopOffer: () => ({ data: { wkndRecoveryOffer: recoveryOffer } }),
    ShopPlannerOffer: general,
    ShopEmail: () => ({ data: { setGuestEmailOnCart: { cart: { id: 'masked-cart-id' } } } }),
    ShopPay: () => ({ data: { setPaymentMethodOnCart: { cart: { id: 'masked-cart-id' } } } }),
    ShopCustomer: () => ({ data: { customer: { email: 'sam@example.com', addresses: [] } } })
})

describe('general offers', () => {
    const originalFetch = global.fetch
    afterEach(() => { global.fetch = originalFetch })

    test('Stage shows Commerce’s climbing planner offer with display fields only and no claim step', async () => {
        fakeCommerce(routes(recovery(), () => ({
            data: { wkndPlannerOffer: planner({ audience_key: 'climbing-planner', draft_id: 'pdr_x', source: 'target-aam-decision', financialAuthorization: false }) }
        })))
        const result = await getCart({}, stageShopper())
        expect(result.structuredContent.offer).toEqual(PLANNER_DTO)
        expect(result.content[0].text).toMatch(/climbing planner offer saves A\$25\.00 on this cart \(10% off selected climbing gear, up to A\$25\.00\)\. WKND applies it automatically.*do not call apply_offer/)
        expect(JSON.stringify(result)).not.toMatch(/pdr_|climbing-planner|target-aam|financialAuthorization|RECOVER10/)
        expect(global.fetch.calls.find((c) => c.operation === 'ShopPlannerOffer').variables).toEqual({ cartId: 'masked-cart-id' })
    })

    test('a claimable welcome-back offer is shown ahead of the general offer', async () => {
        fakeCommerce(routes(recovery('ELIGIBLE'), () => ({ data: { wkndPlannerOffer: planner() } })))
        const result = await getCart({}, stageShopper())
        expect(result.structuredContent.offer.kind).toBe('welcome_back')
        expect(JSON.stringify(result)).not.toMatch(/RECOVER10/)
    })

    test('a missing or failing provider never changes the cart or the welcome-back result', async () => {
        for (const general of [
            () => ({ errors: [{ message: 'Cannot query field "wkndPlannerOffer" on type "Query".' }] }),
            () => { throw new Error('network down') },
            () => ({ data: { wkndPlannerOffer: null } })
        ]) {
            fakeCommerce(routes(recovery(), general))
            const result = await getCart({}, stageShopper())
            expect(result.isError).toBeFalsy()
            expect(result.structuredContent.offer).toBeNull()
            expect(result.structuredContent.cart.lines).toHaveLength(1)
        }
    })

    test('Production reads the same server-selected offer without internal metadata', async () => {
        fakeCommerce(routes(recovery(), () => ({ data: { wkndPlannerOffer: planner() } })))
        const result = await getCart({}, shopper())
        expect(result.structuredContent.offer).toEqual(PLANNER_DTO)
        expect(global.fetch.calls.map((c) => c.operation)).toContain('ShopPlannerOffer')
        expect(JSON.stringify(result)).not.toMatch(/RECOVER10|audience_key|draft_id/)
    })

    test.each([getCart, prepare])('Production restores only a server lease in private metadata without changing offers', async (handler) => {
        fakeCommerce(routes(recovery(), () => ({ data: { wkndPlannerOffer: planner() } })))
        const commerceFetch = global.fetch
        const now = Date.now()
        const binding = {
            source: 'server-issued', purpose: 'idLinkage', personAlias: `wpa_${'a'.repeat(32)}`,
            environment: 'production', runtimeNamespace: '28538-wkndcommerce',
            orgId: '28260E2056581D3B7F000101@AdobeOrg', dpid: '1547309', namespace: 'wkndCustomerId',
            issuer: 'https://28538-wkndcommerce.adobeioruntime.net/api/v1/web/commerce/target-diagnostic',
            consentGeneration: '11111111-1111-4111-8111-111111111111',
            issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300000).toISOString(), freshnessMs: 300000,
        }
        const personCalls = []
        global.fetch = async (url, options) => {
            if (url !== binding.issuer) return commerceFetch(url, options)
            personCalls.push(JSON.parse(options.body))
            return { ok: true, json: async () => ({
                environment: 'production', evidence: false, financialAuthorization: false,
                apiVersion: 'wknd.person-binding/v1', purpose: 'idLinkage', semanticAllowlist: [],
                status: 'ok', consent: 'granted', binding,
            }) }
        }
        const result = await handler({}, shopper())
        expect(personCalls).toEqual([{ op: 'person-binding' }, { op: 'person-status' }])
        expect(result._meta.wkndPersonBinding).toEqual(binding)
        expect(result.structuredContent.offer).toEqual(PLANNER_DTO)
        expect(JSON.stringify(result.structuredContent)).not.toMatch(/wpa_|consentGeneration|auth0/)
        expect(result.content[0].text).not.toContain(binding.personAlias)
    })

    test.each([stageShopper, shopper])('checkout shows the same decision for supported deployments', async (context) => {
        fakeCommerce(routes(recovery(), () => ({ data: { wkndPlannerOffer: planner() } })))
        const result = await prepare({}, context())
        expect(result.structuredContent.offer).toEqual(PLANNER_DTO)
    })

    test('decoding follows the v1 rules', () => {
        expect(generalOfferDecision(null)).toBeNull()
        expect(generalOfferDecision(planner({ status: 'INELIGIBLE' }))).toBeNull()
        expect(generalOfferDecision(planner({ saving: money(25), current_saving: money(25) }))).toBeNull()
        const unavailable = { kind: 'climbing_planner', status: 'UNAVAILABLE', message: expect.stringMatching(/can’t be checked/) }
        expect(generalOfferDecision(planner({ status: 'UNAVAILABLE', message: 'raw provider text' }))).toEqual(unavailable)
        expect(generalOfferDecision(planner({ current_saving: undefined }))).toEqual(unavailable)
        expect(generalOfferDecision(planner({ saving: { value: '25', currency: 'AUD' } }))).toEqual(unavailable)
        expect(generalOfferDecision(planner({ max_discount: { value: 25, currency: 'USD' } })).max_discount).toBeNull()
        expect(generalOfferDecision(planner({ status: 'CLAIMED', expires_at: '2026-12-01T09:00:00.000Z' })))
            .toEqual({ ...PLANNER_DTO, status: 'CLAIMED', expires_at: '2026-12-01T09:00:00.000Z' })
    })
})
