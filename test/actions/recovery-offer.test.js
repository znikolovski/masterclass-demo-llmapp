// Welcome-back (cart recovery) offer in get-shop-cart, prepare-shop-checkout and place-shop-demo-order.
jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }))

const getCart = require('../../actions/get-shop-cart/index.js')
const prepare = require('../../actions/prepare-shop-checkout/index.js')
const place = require('../../actions/place-shop-demo-order/index.js')
const { offerDecision } = require('../../actions/lib/commerce.js')
const { shopper, cart, readyCart, money, fakeCommerce } = require('../fixtures/shop.js')

const OFFER_LABEL = 'Welcome back — 10% off your gear (max $25)'

function offer (overrides = {}) {
    return {
        status: 'ELIGIBLE',
        coupon_code: 'RECOVER10',
        percent_off: 10,
        max_discount: money(25),
        expires_at: '2026-11-24T01:00:00.000Z',
        saving: money(25),
        current_saving: money(20),
        ...overrides
    }
}

const withCoupon = (code, discount, base = cart) => base({
    applied_coupons: [{ code }],
    prices: { ...base().prices, discounts: [{ label: code === 'RECOVER10' ? OFFER_LABEL : `${code} — $20 off`, amount: money(discount) }] }
})

const ok = (name) => () => ({ data: { [name]: { cart: { id: 'masked-cart-id' } } } })
const expectNoCode = (result) => expect(JSON.stringify(result)).not.toMatch(/RECOVER10/i)

describe('welcome-back offer', () => {
    const originalFetch = global.fetch
    afterEach(() => { global.fetch = originalFetch })

    describe('get-shop-cart', () => {
        test('shows a beneficial offer with its terms and the code it replaces, never its own code', async () => {
            fakeCommerce({
                ShopCart: () => ({ data: { customerCart: withCoupon('TRAILREADY', 20) } }),
                ShopOffer: () => ({ data: { wkndRecoveryOffer: offer() } })
            })
            const result = await getCart({}, shopper())
            expect(result.structuredContent.offer).toEqual({
                kind: 'welcome_back',
                status: 'ELIGIBLE',
                saving: money(25),
                current_saving: money(20),
                percent_off: 10,
                max_discount: money(25),
                expires_at: '2026-11-24T01:00:00.000Z',
                replaces_code: 'TRAILREADY'
            })
            expect(result.content[0].text).toMatch(/saves A\$25\.00 on this cart \(10% off gear, up to A\$25\.00, ends 24 Nov 2026, one use per account\)\. It replaces code TRAILREADY\./)
            expect(global.fetch.calls.find((c) => c.operation === 'ShopOffer').variables).toEqual({ cartId: 'masked-cart-id' })
            expectNoCode(result)
        })

        test('never asks Commerce for ineligibility reasons', async () => {
            fakeCommerce({
                ShopCart: () => ({ data: { customerCart: cart() } }),
                ShopOffer: () => ({ data: { wkndRecoveryOffer: offer({ status: 'INELIGIBLE', coupon_code: null }) } })
            })
            await getCart({}, shopper())
            const request = JSON.parse(global.fetch.mock.calls[1][1].body)
            expect(request.query).not.toMatch(/reason/)
        })

        test.each([
            ['the current discount saves more (WKND10)', offer({ saving: money(19), current_saving: money(21) })],
            ['saving equals the current discount', offer({ saving: money(20), current_saving: money(20) })],
            ['the offer was already used', offer({ status: 'REDEEMED', coupon_code: null, saving: null })],
            ['the shopper is not eligible', offer({ status: 'INELIGIBLE', coupon_code: null, saving: null })],
            ['the shopper is signed out at Commerce', offer({ status: 'SIGN_IN_REQUIRED', coupon_code: null, saving: null })],
            ['the saving is zero', offer({ saving: money(0), current_saving: money(0) })]
        ])('returns no offer when %s', async (_label, value) => {
            fakeCommerce({
                ShopCart: () => ({ data: { customerCart: withCoupon('WKND10', 21) } }),
                ShopOffer: () => ({ data: { wkndRecoveryOffer: value } })
            })
            const result = await getCart({}, shopper())
            expect(result.structuredContent.offer).toBeNull()
            expect(result.content[0].text).not.toMatch(/welcome-back/i)
        })

        const UNAVAILABLE = { kind: 'welcome_back', status: 'UNAVAILABLE', message: 'The welcome-back offer can’t be checked right now. Please try again shortly.' }

        test.each([
            ['the lookup fails', () => ({ errors: [{ message: 'boom', extensions: { category: 'internal' } }] })],
            ['the lookup throws', () => { throw new Error('network') }],
            ['Commerce reports UNAVAILABLE', () => ({ data: { wkndRecoveryOffer: offer({ status: 'UNAVAILABLE', coupon_code: null, saving: null, current_saving: null }) } })],
            ['the status is unknown', () => ({ data: { wkndRecoveryOffer: offer({ status: 'SOMETHING_NEW' }) } })],
            ['an eligible offer has no saving', () => ({ data: { wkndRecoveryOffer: offer({ saving: null }) } })],
            ['an eligible offer has no current saving', () => ({ data: { wkndRecoveryOffer: offer({ current_saving: null }) } })],
            ['the saving is negative', () => ({ data: { wkndRecoveryOffer: offer({ saving: money(-5) }) } })],
            ['the saving is not a number', () => ({ data: { wkndRecoveryOffer: offer({ saving: { value: '25', currency: 'AUD' } }) } })],
            ['the saving has no currency', () => ({ data: { wkndRecoveryOffer: offer({ saving: { value: 25 } }) } })],
            ['the currencies differ', () => ({ data: { wkndRecoveryOffer: offer({ saving: { value: 25, currency: 'NZD' } }) } })],
            ['an eligible offer has no code', () => ({ data: { wkndRecoveryOffer: offer({ coupon_code: null }) } })]
        ])('keeps the cart and reports an explicit, non-actionable UNAVAILABLE when %s', async (_label, route) => {
            fakeCommerce({ ShopCart: () => ({ data: { customerCart: withCoupon('TRAILREADY', 20) } }), ShopOffer: route })
            const result = await getCart({}, shopper())
            expect(result.isError).toBeUndefined()
            expect(result.structuredContent).toMatchObject({ view: 'cart', cart: { item_count: 1, coupons: ['TRAILREADY'] } })
            expect(result.structuredContent.offer).toEqual(UNAVAILABLE)
            expect(result.content[0].text).toMatch(/can’t be checked right now\. Please try again shortly\. Do not promise a welcome-back discount\./)
            expectNoCode(result)
        })

        test('an empty cart does not look up the offer', async () => {
            fakeCommerce({ ShopCart: () => ({ data: { customerCart: cart({ items: [] }) } }) })
            const result = await getCart({}, shopper())
            expect(result.structuredContent.offer).toBeNull()
            expect(global.fetch.calls.map((c) => c.operation)).toEqual(['ShopCart'])
        })

        test.each([
            ['expired (INELIGIBLE)', offer({ status: 'INELIGIBLE', coupon_code: null, saving: null })],
            ['redeemed', offer({ status: 'REDEEMED', coupon_code: null, saving: null })],
            ['unavailable', offer({ status: 'UNAVAILABLE', coupon_code: null, saving: null })]
        ])('hides an applied RECOVER10 by the pinned fallback when the offer is %s', async (_label, value) => {
            fakeCommerce({
                ShopCart: () => ({ data: { customerCart: withCoupon('RECOVER10', 25) } }),
                ShopOffer: () => ({ data: { wkndRecoveryOffer: value } })
            })
            const result = await getCart({}, shopper())
            expect(result.structuredContent.cart).toMatchObject({ coupons: [], offer_applied: true })
            expectNoCode(result)
        })

        test('hides a dynamic protected code reported by the offer, but never an ordinary entered code', async () => {
            fakeCommerce({
                ShopCart: () => ({ data: { customerCart: cart({ applied_coupons: [{ code: 'WB-7Q2X' }] }) } }),
                ShopOffer: () => ({ data: { wkndRecoveryOffer: offer({ status: 'CLAIMED', coupon_code: 'WB-7Q2X' }) } })
            })
            const dynamic = await getCart({}, shopper())
            expect(dynamic.structuredContent.cart).toMatchObject({ coupons: [], offer_applied: true })
            expect(JSON.stringify(dynamic)).not.toMatch(/WB-7Q2X/)

            fakeCommerce({
                ShopCart: () => ({ data: { customerCart: withCoupon('WKND10', 21) } }),
                ShopOffer: () => ({ data: { wkndRecoveryOffer: offer({ saving: money(19), current_saving: money(21) }) } })
            })
            const ordinary = await getCart({}, shopper())
            expect(ordinary.structuredContent.cart).toMatchObject({ coupons: ['WKND10'], offer_applied: false })
        })

        test('replaces_code never names a protected code', async () => {
            fakeCommerce({
                ShopCart: () => ({ data: { customerCart: cart({ applied_coupons: [{ code: 'RECOVER10' }] }) } }),
                ShopOffer: () => ({ data: { wkndRecoveryOffer: offer({ coupon_code: 'WB-NEW1' }) } })
            })
            const result = await getCart({}, shopper())
            expect(result.structuredContent.offer).toMatchObject({ status: 'ELIGIBLE', replaces_code: null })
            expectNoCode(result)
            expect(JSON.stringify(result)).not.toMatch(/WB-NEW1/)
        })

        test('an applied offer is reported without its code and still changes cart_version', async () => {
            fakeCommerce({
                ShopCart: () => ({ data: { customerCart: withCoupon('RECOVER10', 6.9) } }),
                ShopOffer: () => ({ data: { wkndRecoveryOffer: offer({ status: 'CLAIMED' }) } })
            })
            const applied = await getCart({}, shopper())
            expect(applied.structuredContent.cart).toMatchObject({ coupons: [], offer_applied: true, totals: { discounts: [{ label: OFFER_LABEL }] } })
            expect(applied.structuredContent.offer).toBeNull()
            expect(applied.content[0].text).toMatch(/The welcome-back offer is applied\./)
            expectNoCode(applied)

            fakeCommerce({ ShopCart: () => ({ data: { customerCart: cart() } }), ShopOffer: () => ({ data: { wkndRecoveryOffer: offer() } }) })
            const plain = await getCart({}, shopper())
            expect(plain.structuredContent.cart.version).not.toBe(applied.structuredContent.cart.version)
        })
    })

    describe('prepare-shop-checkout apply_offer', () => {
        function routes (state, overrides = {}) {
            return {
                ShopCart: () => ({ data: { customerCart: state.cart } }),
                ShopCustomer: () => ({ data: { customer: { email: 'sam@example.com', addresses: [] } } }),
                ShopOffer: () => ({ data: { wkndRecoveryOffer: state.offer } }),
                ShopClaimOffer: () => {
                    state.offer = { ...state.offer, status: 'CLAIMED' }
                    return { data: { claimWkndRecoveryOffer: state.offer } }
                },
                ShopCoupon: (v) => {
                    state.cart = withCoupon(v.input.coupon_code, 25, readyCart)
                    return ok('applyCouponToCart')()
                },
                ShopRemoveCoupon: () => { state.cart = readyCart(); return ok('removeCouponFromCart')() },
                ShopPay: ok('setPaymentMethodOnCart'),
                ...overrides
            }
        }

        test('claims then applies the offer server-side, replacing the current code', async () => {
            const state = { cart: withCoupon('TRAILREADY', 20, readyCart), offer: offer() }
            fakeCommerce(routes(state))
            const version = (await (async () => {
                const r = await getCart({}, shopper())
                return r.structuredContent.cart.version
            })())
            global.fetch.calls.length = 0
            const result = await prepare({ cart_version: version, apply_offer: true }, shopper())
            expect(global.fetch.calls.map((c) => c.operation)).toEqual(['ShopCart', 'ShopCustomer', 'ShopOffer', 'ShopClaimOffer', 'ShopCart', 'ShopCoupon', 'ShopPay', 'ShopCart', 'ShopOffer'])
            expect(global.fetch.calls.find((c) => c.operation === 'ShopCoupon').variables.input).toEqual({ cart_id: 'masked-cart-id', coupon_code: 'RECOVER10' })
            expect(result.isError).toBeUndefined()
            expect(result.structuredContent).toMatchObject({ view: 'checkout', offer: null, cart: { coupons: [], offer_applied: true } })
            expect(result.structuredContent.cart.version).not.toBe(version)
            expect(result.structuredContent.warnings[0]).toMatch(/Welcome-back offer applied \(saves A\$25\.00\)/)
            expectNoCode(result)
        })

        test('an already claimed offer is applied without claiming again', async () => {
            const state = { cart: readyCart(), offer: offer({ status: 'CLAIMED', current_saving: money(0) }) }
            fakeCommerce(routes(state))
            const result = await prepare({ apply_offer: true }, shopper())
            expect(global.fetch.calls.map((c) => c.operation)).not.toContain('ShopClaimOffer')
            expect(result.structuredContent.cart.offer_applied).toBe(true)
        })

        test.each([
            ['INELIGIBLE', offer({ status: 'INELIGIBLE', coupon_code: null, saving: null }), 'This welcome-back offer isn’t available for this cart.'],
            ['REDEEMED', offer({ status: 'REDEEMED', coupon_code: null, saving: null }), 'This offer has already been used.'],
            ['NOT_BENEFICIAL', offer({ saving: money(15), current_saving: money(20) }), /would not save more/]
        ])('refuses explicitly when %s, without claiming', async (subcode, value, message) => {
            const state = { cart: withCoupon('WKND10', 20, readyCart), offer: value }
            fakeCommerce(routes(state))
            const result = await prepare({ apply_offer: true }, shopper())
            expect(result).toMatchObject({ isError: true, structuredContent: { error: { status: 409, code: 'offer_not_applied', subcode } } })
            expect(result.structuredContent.error.message).toEqual(expect.stringMatching(message))
            expect(result.structuredContent.cart).toMatchObject({ coupons: ['WKND10'] })
            expect(global.fetch.calls.map((c) => c.operation)).not.toContain('ShopClaimOffer')
            expect(global.fetch.calls.map((c) => c.operation)).not.toContain('ShopCoupon')
        })

        test.each([
            ['denied (INELIGIBLE)', offer({ status: 'INELIGIBLE', coupon_code: null, saving: null }), 'INELIGIBLE'],
            ['already redeemed', offer({ status: 'REDEEMED', coupon_code: null, saving: null }), 'REDEEMED'],
            ['still ELIGIBLE (not reserved)', offer(), 'ELIGIBLE'],
            ['claimed but no longer beneficial', offer({ status: 'CLAIMED', saving: money(15), current_saving: money(20) }), 'NOT_BENEFICIAL'],
            ['claimed with a malformed saving', offer({ status: 'CLAIMED', saving: { value: 25, currency: 'USD' } }), 'UNAVAILABLE']
        ])('a claim that comes back %s is not applied and leaves the cart unchanged', async (_label, claim, subcode) => {
            const state = { cart: withCoupon('TRAILREADY', 20, readyCart), offer: offer() }
            fakeCommerce(routes(state, { ShopClaimOffer: () => ({ data: { claimWkndRecoveryOffer: claim } }) }))
            const before = (await getCart({}, shopper())).structuredContent.cart
            global.fetch.calls.length = 0
            const result = await prepare({ apply_offer: true, cart_version: before.version }, shopper())
            expect(result.structuredContent.error).toMatchObject({ code: 'offer_not_applied', subcode })
            expect(result.structuredContent.cart).toMatchObject({ version: before.version, coupons: ['TRAILREADY'], offer_applied: false })
            expect(global.fetch.calls.map((c) => c.operation)).not.toContain('ShopCoupon')
        })

        test('a claim error is not applied', async () => {
            const state = { cart: readyCart(), offer: offer() }
            fakeCommerce(routes(state, { ShopClaimOffer: () => ({ errors: [{ message: 'nope', extensions: { category: 'graphql' } }] }) }))
            const result = await prepare({ apply_offer: true }, shopper())
            expect(result.structuredContent.error).toMatchObject({ code: 'offer_not_applied', subcode: 'UNAVAILABLE' })
            expect(global.fetch.calls.map((c) => c.operation)).not.toContain('ShopCoupon')
        })

        test('a cart that changes between the claim and the apply is not applied (race)', async () => {
            const state = { cart: withCoupon('TRAILREADY', 20, readyCart), offer: offer() }
            fakeCommerce(routes(state, {
                ShopClaimOffer: () => {
                    // the website changes the cart (a better code) after the review, mid-apply
                    state.cart = withCoupon('WKND10', 60, readyCart)
                    return { data: { claimWkndRecoveryOffer: offer({ status: 'CLAIMED' }) } }
                }
            }))
            const before = (await getCart({}, shopper())).structuredContent.cart
            global.fetch.calls.length = 0
            const result = await prepare({ apply_offer: true, cart_version: before.version }, shopper())
            expect(result.structuredContent.error).toMatchObject({ code: 'offer_not_applied', subcode: 'CART_CHANGED' })
            expect(result.structuredContent.cart).toMatchObject({ coupons: ['WKND10'] })
            expect(global.fetch.calls.map((c) => c.operation)).not.toContain('ShopCoupon')
        })

        test('the claim\'s own fresh comparison decides, not the earlier read', async () => {
            const state = { cart: withCoupon('TRAILREADY', 20, readyCart), offer: offer({ saving: money(25), current_saving: money(20) }) }
            fakeCommerce(routes(state, {
                ShopClaimOffer: () => ({ data: { claimWkndRecoveryOffer: offer({ status: 'CLAIMED', saving: money(22), current_saving: money(20) }) } })
            }))
            const result = await prepare({ apply_offer: true }, shopper())
            expect(result.isError).toBeUndefined()
            expect(result.structuredContent.warnings[0]).toMatch(/saves A\$22\.00/)
        })

        test('an ordinary entered code is echoed in its warning, not redacted', async () => {
            const state = { cart: readyCart(), offer: offer() }
            fakeCommerce(routes(state, { ShopCoupon: () => ({ errors: [{ message: 'The coupon code "BOGUS1" is not valid.', extensions: { code: 'COUPON_NOT_FOUND' } }] }) }))
            const result = await prepare({ coupon_code: 'bogus1' }, shopper())
            expect(result.structuredContent.warnings[0]).toBe('Coupon BOGUS1 was not applied: The coupon code "BOGUS1" is not valid.')
        })

        test.each([
            ['COUPON_SHOPPER_INELIGIBLE', 'Coupon is not available for this shopper.'],
            ['RECOVERY_ALREADY_REDEEMED', 'This offer has already been used.'],
            ['COUPON_ELIGIBILITY_UNAVAILABLE', 'Coupon eligibility cannot currently be verified.']
        ])('shows Commerce %s verbatim', async (code, message) => {
            const state = { cart: readyCart(), offer: offer() }
            fakeCommerce(routes(state, {
                ShopCoupon: () => ({ data: { applyCouponToCart: null }, errors: [{ message, extensions: { category: 'graphql-input', code } }] })
            }))
            const result = await prepare({ apply_offer: true }, shopper())
            expect(result.structuredContent.error).toMatchObject({ code: 'offer_not_applied', subcode: code, message })
            expectNoCode(result)
        })

        test('apply_offer and coupon_code together are rejected before calling Commerce', async () => {
            global.fetch = jest.fn()
            const result = await prepare({ apply_offer: true, coupon_code: 'WKND10' }, shopper())
            expect(result.structuredContent.error).toMatchObject({ status: 400, code: 'conflicting_discounts' })
            expect(global.fetch).not.toHaveBeenCalled()
        })

        test('apply_offer must be a boolean', async () => {
            global.fetch = jest.fn()
            const result = await prepare({ apply_offer: 'yes' }, shopper())
            expect(result.structuredContent.error.code).toBe('invalid_apply_offer')
        })

        test('a stale cart_version is rejected before anything is claimed', async () => {
            const state = { cart: readyCart(), offer: offer() }
            fakeCommerce(routes(state))
            const result = await prepare({ apply_offer: true, cart_version: '0000000000000000' }, shopper())
            expect(result.structuredContent.error.code).toBe('cart_changed')
            expect(global.fetch.calls.map((c) => c.operation)).toEqual(['ShopCart'])
        })

        test('apply_offer: false removes an applied offer', async () => {
            const state = { cart: withCoupon('RECOVER10', 25, readyCart), offer: offer({ status: 'CLAIMED' }) }
            fakeCommerce(routes(state))
            const result = await prepare({ apply_offer: false }, shopper())
            expect(global.fetch.calls.map((c) => c.operation)).toContain('ShopRemoveCoupon')
            expect(result.structuredContent.warnings).toContain('Welcome-back offer removed.')
            expect(result.structuredContent.cart.offer_applied).toBe(false)
        })

        test('apply_offer: false leaves a shopper-entered code alone', async () => {
            const state = { cart: withCoupon('WKND10', 20, readyCart), offer: offer() }
            fakeCommerce(routes(state))
            await prepare({ apply_offer: false }, shopper())
            expect(global.fetch.calls.map((c) => c.operation)).not.toContain('ShopRemoveCoupon')
        })
    })

    describe('place-shop-demo-order', () => {
        test('an offer that is no longer valid asks for a re-review, without the code', async () => {
            const state = { cart: withCoupon('RECOVER10', 25, readyCart) }
            fakeCommerce({
                ShopCart: () => ({ data: { customerCart: state.cart } }),
                ShopPlaceOrder: () => ({ data: { placeOrder: null }, errors: [{ message: 'Coupon is not available for this shopper.', extensions: { category: 'graphql', code: 'COUPON_SHOPPER_INELIGIBLE' } }] })
            })
            const first = await getCart({}, shopper())
            const reviewed = first.structuredContent.cart
            const result = await place({ confirm: true, cart_version: reviewed.version, expected_grand_total: reviewed.totals.grand_total.value }, shopper())
            expect(result.structuredContent.error).toMatchObject({ status: 409, code: 'offer_invalid', subcode: 'COUPON_SHOPPER_INELIGIBLE' })
            expect(result.structuredContent.error.message).toMatch(/^Coupon is not available for this shopper\. Remove the offer/)
            expect(result.structuredContent.cart).toMatchObject({ offer_applied: true, coupons: [] })
            expectNoCode(result)
        })

        test('masks a protected code inside an order error message', async () => {
            const state = { cart: withCoupon('RECOVER10', 25, readyCart) }
            fakeCommerce({
                ShopCart: () => ({ data: { customerCart: state.cart } }),
                ShopOffer: () => ({ data: { wkndRecoveryOffer: offer({ status: 'CLAIMED' }) } }),
                ShopPlaceOrder: () => ({ data: { placeOrder: { errors: [{ code: 'UNDEFINED', message: 'The coupon code "RECOVER10" is not valid.' }], orderV2: null } } })
            })
            const reviewed = (await getCart({}, shopper())).structuredContent.cart
            const result = await place({ confirm: true, cart_version: reviewed.version, expected_grand_total: reviewed.totals.grand_total.value }, shopper())
            expect(result.structuredContent.error.code).toBe('offer_invalid')
            expectNoCode(result)
        })
    })

    test('offerDecision never shows an offer whose code is already on the cart', () => {
        expect(offerDecision(offer({ status: 'CLAIMED' }), ['RECOVER10'])).toMatchObject({ show: false, why: 'ALREADY_APPLIED', offer: null })
    })
})
