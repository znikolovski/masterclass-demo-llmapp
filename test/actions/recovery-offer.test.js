// Welcome-back (cart recovery) offer in get-shop-cart, prepare-shop-checkout and place-shop-demo-order.
jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }))

const getCart = require('../../actions/get-shop-cart/index.js')
const prepare = require('../../actions/prepare-shop-checkout/index.js')
const place = require('../../actions/place-shop-demo-order/index.js')
const { offerDecision, normalizeCart } = require('../../actions/lib/commerce.js')
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
const versionOf = (state) => normalizeCart(state.cart).version
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

    describe('prepare-shop-checkout offer actions (reviewed-version contract)', () => {
        // A fake Commerce with the reviewed-version mutations and a revision token (CAS).
        function routes (state, overrides = {}) {
            state.rev = state.rev || 1
            state.cart = { ...state.cart, wknd_cart_version: `v${state.rev}` }
            const write = (cart) => { state.rev += 1; state.cart = { ...cart, wknd_cart_version: `v${state.rev}` } }
            const codes = () => (state.cart.applied_coupons || []).map((c) => c.code)
            const changed = { errors: [{ message: 'Your cart changed since it was reviewed. Review the cart and try again.', extensions: { category: 'graphql-input', code: 'CART_CHANGED' } }] }
            return {
                ShopCart: () => ({ data: { customerCart: state.cart } }),
                ShopCustomer: () => ({ data: { customer: { email: 'sam@example.com', addresses: [] } } }),
                ShopOffer: () => ({ data: { wkndRecoveryOffer: state.offer } }),
                ShopApplyOffer: (v) => {
                    if (v.expected !== state.cart.wknd_cart_version) return changed
                    if (state.verdict) return { errors: [{ message: state.verdict.message, extensions: { category: 'graphql-input', code: state.verdict.code } }] }
                    if (codes().includes('RECOVER10')) return { data: { applyWkndRecoveryOffer: { outcome: 'ALREADY_APPLIED' } } }
                    write(withCoupon('RECOVER10', 25, readyCart))
                    return { data: { applyWkndRecoveryOffer: { outcome: 'APPLIED' } } }
                },
                ShopRemoveOffer: (v) => {
                    if (v.expected !== state.cart.wknd_cart_version) return changed
                    if (!codes().includes('RECOVER10')) return { data: { removeWkndRecoveryOffer: { outcome: 'NOT_APPLIED' } } }
                    write(readyCart())
                    return { data: { removeWkndRecoveryOffer: { outcome: 'REMOVED' } } }
                },
                ShopCoupon: (v) => { write(withCoupon(v.input.coupon_code, 20, readyCart)); return ok('applyCouponToCart')() },
                ShopPay: ok('setPaymentMethodOnCart'),
                ...overrides
            }
        }
        const reviewedVersion = async (state) => {
            const r = await getCart({}, shopper())
            global.fetch.calls.length = 0
            return r.structuredContent.cart.version
        }
        const ops = () => global.fetch.calls.map((c) => c.operation)

        test('applies through applyWkndRecoveryOffer with the server token bound to the reviewed cart_version', async () => {
            const state = { cart: withCoupon('TRAILREADY', 20, readyCart), offer: offer() }
            fakeCommerce(routes(state))
            const version = await reviewedVersion(state)
            const result = await prepare({ cart_version: version, apply_offer: true }, shopper())
            expect(ops()).toEqual(['ShopCart', 'ShopCustomer', 'ShopApplyOffer', 'ShopPay', 'ShopCart', 'ShopOffer'])
            expect(global.fetch.calls.find((c) => c.operation === 'ShopApplyOffer').variables).toEqual({ cartId: 'masked-cart-id', expected: 'v1' })
            expect(ops()).not.toContain('ShopCoupon')
            expect(result.isError).toBeUndefined()
            expect(result.structuredContent).toMatchObject({ view: 'checkout', offer: null, cart: { coupons: [], offer_applied: true } })
            expect(result.structuredContent.cart.version).not.toBe(version)
            expect(result.structuredContent.warnings[0]).toBe('Welcome-back offer applied. The total changed, so review it again before ordering.')
            expectNoCode(result)
            expect(JSON.stringify(result)).not.toMatch(/wknd_cart_version|"v\d+"/)
        })

        test('the server token is part of cart_version: same visible cart, new token → stale', async () => {
            const state = { cart: withCoupon('TRAILREADY', 20, readyCart), offer: offer() }
            fakeCommerce(routes(state))
            const version = await reviewedVersion(state)
            state.rev = 7
            state.cart = { ...state.cart, wknd_cart_version: 'v7' }
            const result = await prepare({ cart_version: version, apply_offer: true }, shopper())
            expect(result.structuredContent.error.code).toBe('cart_changed')
            expect(ops()).toEqual(['ShopCart'])
        })

        test('a cart written between the reviewed read and the apply is refused by Commerce (CAS) and never retried', async () => {
            const state = { cart: withCoupon('TRAILREADY', 20, readyCart), offer: offer() }
            const base = routes(state)
            fakeCommerce({
                ...base,
                ShopCustomer: () => {
                    // the website applies a better code after the reviewed read, before the apply
                    state.rev += 1
                    state.cart = { ...withCoupon('WKND10', 60, readyCart), wknd_cart_version: `v${state.rev}` }
                    return base.ShopCustomer()
                }
            })
            const version = await reviewedVersion(state)
            const result = await prepare({ cart_version: version, apply_offer: true }, shopper())
            expect(result).toMatchObject({ isError: true, structuredContent: { error: { status: 409, code: 'cart_changed' }, cart: { coupons: ['WKND10'] } } })
            expect(ops().filter((o) => o === 'ShopApplyOffer')).toHaveLength(1)
            expect(state.cart.applied_coupons).toEqual([{ code: 'WKND10' }])
        })

        test('ALREADY_APPLIED is an honest no-op', async () => {
            const state = { cart: withCoupon('RECOVER10', 25, readyCart), offer: offer({ status: 'CLAIMED' }) }
            fakeCommerce(routes(state))
            const version = await reviewedVersion(state)
            const result = await prepare({ cart_version: version, apply_offer: true }, shopper())
            expect(result.isError).toBeUndefined()
            expect(result.structuredContent.warnings[0]).toBe('The welcome-back offer is already applied to this cart, so nothing changed.')
            expect(result.structuredContent.cart.version).toBe(version)
        })

        test.each([
            ['OFFER_NOT_BETTER', 'Your cart already has an equal or better saving.', 'NOT_BENEFICIAL', /would not save more/],
            ['RECOVERY_OFFER_UNAVAILABLE', 'This offer isn\'t available for this cart.', 'UNAVAILABLE', /^This welcome-back offer isn’t available for this cart\.$/],
            ['SOMETHING_NEW', 'Unexpected.', 'UNAVAILABLE', /^This welcome-back offer isn’t available for this cart\.$/],
            ['COUPON_SHOPPER_INELIGIBLE', 'Coupon is not available for this shopper.', 'COUPON_SHOPPER_INELIGIBLE', /^Coupon is not available for this shopper\.$/],
            ['RECOVERY_ALREADY_REDEEMED', 'This offer has already been used.', 'RECOVERY_ALREADY_REDEEMED', /^This offer has already been used\.$/],
            ['COUPON_ELIGIBILITY_UNAVAILABLE', 'Coupon eligibility cannot currently be verified.', 'COUPON_ELIGIBILITY_UNAVAILABLE', /^Coupon eligibility cannot currently be verified\.$/]
        ])('Commerce %s → explicit offer_not_applied, cart unchanged', async (code, message, subcode, text) => {
            const state = { cart: withCoupon('TRAILREADY', 20, readyCart), offer: offer(), verdict: { code, message } }
            fakeCommerce(routes(state))
            const version = await reviewedVersion(state)
            const result = await prepare({ cart_version: version, apply_offer: true }, shopper())
            expect(result).toMatchObject({ isError: true, structuredContent: { error: { status: 409, code: 'offer_not_applied', subcode } } })
            expect(result.structuredContent.error.message).toMatch(text)
            expect(result.structuredContent.cart).toMatchObject({ version, coupons: ['TRAILREADY'], offer_applied: false })
            expectNoCode(result)
        })

        const schemaError = (field, type) => ({ errors: [{ message: `Cannot query field "${field}" on type "${type}".`, locations: [{ line: 1, column: 1 }], extensions: { category: 'graphql' } }] })

        test('a shop without the reviewed-version contract fails explicitly, never with a silent fallback', async () => {
            const state = { cart: withCoupon('RECOVER10', 25, readyCart), offer: offer({ status: 'CLAIMED' }) }
            fakeCommerce(routes(state, { ShopCart: () => schemaError('wknd_cart_version', 'Cart') }))
            const shown = await getCart({}, shopper())
            expect(shown).toMatchObject({ isError: true, structuredContent: { error: { status: 502, code: 'shop_contract_unavailable' } } })
            expect(JSON.stringify(shown)).not.toMatch(/wknd_cart_version|Cannot query field/)
            expect(ops()).toEqual(['ShopCart'])
            global.fetch.calls.length = 0
            const result = await prepare({ apply_offer: true, cart_version: '0123456789abcdef' }, shopper())
            expect(result.structuredContent.error).toMatchObject({ status: 502, code: 'shop_contract_unavailable' })
            expect(ops()).toEqual(['ShopCart'])
        })

        test.each([
            ['apply_offer', { apply_offer: true }, 'ShopApplyOffer', 'applyWkndRecoveryOffer'],
            ['remove_offer', { remove_offer: true }, 'ShopRemoveOffer', 'removeWkndRecoveryOffer']
        ])('an unpublished %s mutation is an explicit error with the real cart; no generic coupon fallback', async (_flag, args, op, field) => {
            const state = { cart: withCoupon('RECOVER10', 25, readyCart), offer: offer({ status: 'CLAIMED' }) }
            fakeCommerce(routes(state, { [op]: () => schemaError(field, 'Mutation') }))
            const version = await reviewedVersion(state)
            const result = await prepare({ ...args, cart_version: version }, shopper())
            expect(result.structuredContent.error).toMatchObject({ status: 502, code: 'shop_contract_unavailable' })
            expect(result.structuredContent.cart).toMatchObject({ version, offer_applied: true })
            expect(ops().filter((o) => o === op)).toHaveLength(1)
            expect(ops()).not.toContain('ShopCoupon')
            expectNoCode(result)
        })

        test.each([
            ['missing', undefined],
            ['null', null],
            ['not v-prefixed', '7'],
            ['leading zero', 'v07'],
            ['trailing text', 'v7 '],
            ['too long', `v${'9'.repeat(17)}`],
            ['not a string', 7]
        ])('a %s server version token fails closed: offer not actionable, no offer mutation', async (_label, token) => {
            const state = { cart: withCoupon('RECOVER10', 25, readyCart), offer: offer({ status: 'CLAIMED' }) }
            const base = routes(state)
            const answer = () => {
                const c = { ...state.cart, wknd_cart_version: token }
                if (token === undefined) delete c.wknd_cart_version
                return { data: { customerCart: c } }
            }
            fakeCommerce({ ...base, ShopCart: answer })
            const before = await getCart({}, shopper())
            expect(before.structuredContent.offer).toMatchObject({ status: 'UNAVAILABLE' })
            expect(ops()).not.toContain('ShopOffer')
            for (const [args, code] of [[{ apply_offer: true }, 'offer_not_applied'], [{ remove_offer: true }, 'offer_not_removed']]) {
                global.fetch.calls.length = 0
                const result = await prepare({ ...args, cart_version: before.structuredContent.cart.version }, shopper())
                expect(result.structuredContent.error).toMatchObject({ status: 409, code, subcode: 'REVIEWED_VERSION_UNAVAILABLE' })
                expect(ops()).not.toContain('ShopApplyOffer')
                expect(ops()).not.toContain('ShopRemoveOffer')
                expect(ops()).not.toContain('ShopCoupon')
                expectNoCode(result)
            }
        })

        test('the raw server revision is in the fingerprint: same visible cart, different revision → different cart_version', () => {
            const visible = withCoupon('TRAILREADY', 20, readyCart)
            const a = normalizeCart({ ...visible, wknd_cart_version: 'v41' })
            const b = normalizeCart({ ...visible, wknd_cart_version: 'v42' })
            expect(a.version).toMatch(/^[0-9a-f]{16}$/)
            expect(b.version).toMatch(/^[0-9a-f]{16}$/)
            expect(a.version).not.toBe(b.version)
            expect({ ...a, version: null }).toEqual({ ...b, version: null })
            expect(JSON.stringify([a, b])).not.toMatch(/v4[12]|wknd_cart_version/)
        })

        test('the server token never appears in any output, error or log', async () => {
            const REV = 918273645 // tokens v918273645, v918273646 after a write
            const leak = /v91827364\d|wknd_cart_version|expected_cart_version/
            const logs = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}))
            const echo = (code) => (v) => ({ errors: [{ message: `cart at ${v.expected} rejected`, extensions: { code } }] })
            try {
                const outputs = []
                const scenarios = [
                    [{ apply_offer: true }, 'TRAILREADY', {}],
                    [{ apply_offer: true }, 'TRAILREADY', { ShopApplyOffer: echo('OFFER_NOT_BETTER') }],
                    [{ apply_offer: true }, 'TRAILREADY', { ShopApplyOffer: echo('CART_CHANGED') }],
                    [{ apply_offer: true }, 'TRAILREADY', { ShopApplyOffer: echo('RECOVERY_ALREADY_REDEEMED') }],
                    [{ remove_offer: true }, 'RECOVER10', {}],
                    [{ remove_offer: true }, 'RECOVER10', { ShopRemoveOffer: echo(undefined) }]
                ]
                for (const [args, code, overrides] of scenarios) {
                    const state = { rev: REV, cart: withCoupon(code, code === 'RECOVER10' ? 25 : 20, readyCart), offer: offer() }
                    fakeCommerce(routes(state, overrides))
                    const shown = await getCart({}, shopper())
                    outputs.push(shown, await prepare({ ...args, cart_version: shown.structuredContent.cart.version }, shopper()))
                }
                const state = { rev: REV, cart: readyCart(), offer: offer() }
                fakeCommerce(routes(state))
                outputs.push(await prepare({ apply_offer: true, cart_version: '0123456789abcdef' }, shopper()))
                expect(outputs.filter((o) => o.isError).length).toBeGreaterThanOrEqual(4)
                expect(JSON.stringify(outputs)).not.toMatch(leak)
                expect(JSON.stringify(logs.map((l) => l.mock.calls))).not.toMatch(leak)
            } finally {
                logs.forEach((l) => l.mockRestore())
            }
        })

        test('an ordinary entered code is echoed in its warning, not redacted', async () => {
            const state = { cart: readyCart(), offer: offer() }
            fakeCommerce(routes(state, { ShopCoupon: () => ({ errors: [{ message: 'The coupon code "BOGUS1" is not valid.', extensions: { code: 'COUPON_NOT_FOUND' } }] }) }))
            const result = await prepare({ coupon_code: 'bogus1' }, shopper())
            expect(result.structuredContent.warnings[0]).toBe('Coupon BOGUS1 was not applied: The coupon code "BOGUS1" is not valid.')
        })

        test('apply_offer and coupon_code together are rejected before calling Commerce', async () => {
            global.fetch = jest.fn()
            const result = await prepare({ apply_offer: true, coupon_code: 'WKND10' }, shopper())
            expect(result.structuredContent.error).toMatchObject({ status: 400, code: 'conflicting_discounts' })
            expect(global.fetch).not.toHaveBeenCalled()
        })

        test.each([
            ['apply_offer', { apply_offer: true }],
            ['remove_offer', { remove_offer: true }]
        ])('%s: true requires the reviewed cart_version before anything is read or written', async (_flag, args) => {
            global.fetch = jest.fn()
            const result = await prepare(args, shopper())
            expect(result.structuredContent.error).toMatchObject({ status: 400, code: 'cart_version_required' })
            expect(global.fetch).not.toHaveBeenCalled()
        })

        test.each([
            ['apply_offer', { apply_offer: true }],
            ['remove_offer', { remove_offer: true }]
        ])('%s: a malformed cart_version is rejected before calling Commerce', async (_flag, args) => {
            global.fetch = jest.fn()
            const result = await prepare({ ...args, cart_version: 'latest' }, shopper())
            expect(result.structuredContent.error.code).toBe('invalid_cart_version')
            expect(global.fetch).not.toHaveBeenCalled()
        })

        test.each([
            ['apply_offer', 'invalid_apply_offer'],
            ['remove_offer', 'invalid_remove_offer']
        ])('%s must be a boolean', async (flag, code) => {
            global.fetch = jest.fn()
            const result = await prepare({ [flag]: 'yes' }, shopper())
            expect(result.structuredContent.error.code).toBe(code)
            expect(global.fetch).not.toHaveBeenCalled()
        })

        test.each([
            ['apply_offer', { apply_offer: true }],
            ['remove_offer', { remove_offer: true }]
        ])('a stale cart_version is rejected before any %s mutation', async (_flag, args) => {
            const state = { cart: withCoupon('RECOVER10', 25, readyCart), offer: offer() }
            fakeCommerce(routes(state))
            const result = await prepare({ ...args, cart_version: '0000000000000000' }, shopper())
            expect(result.structuredContent.error.code).toBe('cart_changed')
            expect(ops()).toEqual(['ShopCart'])
        })

        test('apply_offer: true and remove_offer: true together are rejected', async () => {
            global.fetch = jest.fn()
            const result = await prepare({ apply_offer: true, remove_offer: true, cart_version: '0000000000000000' }, shopper())
            expect(result.structuredContent.error).toMatchObject({ status: 400, code: 'conflicting_offer_actions' })
            expect(global.fetch).not.toHaveBeenCalled()
        })

        test('remove_offer: true with coupon_code is rejected', async () => {
            global.fetch = jest.fn()
            const result = await prepare({ remove_offer: true, coupon_code: 'WKND10', cart_version: '0000000000000000' }, shopper())
            expect(result.structuredContent.error).toMatchObject({ status: 400, code: 'conflicting_discounts' })
            expect(global.fetch).not.toHaveBeenCalled()
        })

        test.each([
            ['omitted', {}],
            ['apply_offer: false', { apply_offer: false }],
            ['remove_offer: false', { remove_offer: false }],
            ['both false', { apply_offer: false, remove_offer: false }]
        ])('%s leaves an applied offer in place (no offer mutation)', async (_label, flags) => {
            const state = { cart: withCoupon('RECOVER10', 25, readyCart), offer: offer({ status: 'CLAIMED' }) }
            fakeCommerce(routes(state))
            const result = await prepare({ ...flags }, shopper())
            expect(result.isError).toBeUndefined()
            expect(ops()).not.toContain('ShopApplyOffer')
            expect(ops()).not.toContain('ShopRemoveOffer')
            expect(ops()).not.toContain('ShopCoupon')
            expect(result.structuredContent.cart.offer_applied).toBe(true)
            expectNoCode(result)
        })

        test.each([
            ['apply_offer: false', { apply_offer: false }],
            ['remove_offer: false', { remove_offer: false }]
        ])('%s does not block an ordinary coupon and never touches the offer itself', async (_label, flags) => {
            const state = { cart: withCoupon('RECOVER10', 25, readyCart), offer: offer({ status: 'CLAIMED' }) }
            fakeCommerce(routes(state))
            const result = await prepare({ ...flags, coupon_code: 'trailready' }, shopper())
            expect(result.isError).toBeUndefined()
            expect(ops()).not.toContain('ShopRemoveOffer')
            expect(global.fetch.calls.find((c) => c.operation === 'ShopCoupon').variables.input.coupon_code).toBe('TRAILREADY')
        })

        test('remove_offer: true removes through removeWkndRecoveryOffer with the reviewed server token', async () => {
            const state = { cart: withCoupon('RECOVER10', 25, readyCart), offer: offer({ status: 'CLAIMED' }) }
            fakeCommerce(routes(state))
            const version = await reviewedVersion(state)
            const result = await prepare({ remove_offer: true, cart_version: version }, shopper())
            expect(global.fetch.calls.find((c) => c.operation === 'ShopRemoveOffer').variables).toEqual({ cartId: 'masked-cart-id', expected: 'v1' })
            expect(ops()).not.toContain('ShopCoupon')
            expect(result.structuredContent.warnings[0]).toBe('Welcome-back offer removed. The total changed, so review it again before ordering.')
            expect(result.structuredContent.cart).toMatchObject({ offer_applied: false })
            expect(result.structuredContent.cart.version).not.toBe(version)
            expect(ops()).toEqual(['ShopCart', 'ShopCustomer', 'ShopRemoveOffer', 'ShopPay', 'ShopCart', 'ShopOffer'])
            expectNoCode(result)
        })

        test('remove_offer: true with only an ordinary code applied changes nothing and says so (NOT_APPLIED)', async () => {
            const state = { cart: withCoupon('WKND10', 20, readyCart), offer: offer() }
            fakeCommerce(routes(state))
            const version = await reviewedVersion(state)
            const result = await prepare({ remove_offer: true, cart_version: version }, shopper())
            expect(result.structuredContent.warnings).toEqual(['No welcome-back offer is applied to this cart, so nothing changed.'])
            expect(result.structuredContent.cart).toMatchObject({ coupons: ['WKND10'], version })
        })

        test('a repeated remove_offer is honest about the unchanged cart', async () => {
            const state = { cart: withCoupon('RECOVER10', 25, readyCart), offer: offer({ status: 'CLAIMED' }) }
            fakeCommerce(routes(state))
            const first = await prepare({ remove_offer: true, cart_version: await reviewedVersion(state) }, shopper())
            expect(first.structuredContent.warnings[0]).toMatch(/^Welcome-back offer removed\./)
            const second = await prepare({ remove_offer: true, cart_version: first.structuredContent.cart.version }, shopper())
            expect(second.isError).toBeUndefined()
            expect(second.structuredContent.warnings).toEqual(['No welcome-back offer is applied to this cart, so nothing changed.'])
            expect(second.structuredContent.cart.version).toBe(first.structuredContent.cart.version)
        })

        test.each([
            ['apply_offer', { apply_offer: true }, 'ShopApplyOffer', () => ({ cart: withCoupon('TRAILREADY', 20, readyCart), offer: offer() })],
            ['remove_offer', { remove_offer: true }, 'ShopRemoveOffer', () => ({ cart: withCoupon('RECOVER10', 25, readyCart), offer: offer({ status: 'CLAIMED' }) })]
        ])('a Commerce CART_CHANGED on %s is a typed cart_changed conflict with the refreshed cart, never retried', async (_label, args, op, init) => {
            const state = init()
            const base = routes(state)
            fakeCommerce({ ...base, [op]: () => ({ errors: [{ message: 'Your cart changed while this was being updated.', extensions: { category: 'graphql-input', code: 'CART_CHANGED' } }] }) })
            const result = await prepare({ ...args, cart_version: await reviewedVersion(state) }, shopper())
            expect(result).toMatchObject({ isError: true, structuredContent: { error: { status: 409, code: 'cart_changed' } } })
            expect(result.structuredContent.cart).toBeDefined()
            expect(ops().filter((o) => o === op)).toHaveLength(1)
            expectNoCode(result)
        })

        test('a Commerce CART_CHANGED on an ordinary coupon is a typed conflict', async () => {
            const state = { cart: readyCart(), offer: offer() }
            fakeCommerce(routes(state, { ShopCoupon: () => ({ errors: [{ message: 'changed', extensions: { code: 'CART_CHANGED' } }] }) }))
            const result = await prepare({ coupon_code: 'WKND10', cart_version: await reviewedVersion(state) }, shopper())
            expect(result.structuredContent.error.code).toBe('cart_changed')
        })

        test('a failed removal is an explicit error with the real current cart', async () => {
            const state = { cart: withCoupon('RECOVER10', 25, readyCart), offer: offer({ status: 'CLAIMED' }) }
            fakeCommerce(routes(state, { ShopRemoveOffer: () => ({ errors: [{ message: 'Cannot remove RECOVER10 right now', extensions: { category: 'graphql' } }] }) }))
            const result = await prepare({ remove_offer: true, cart_version: await reviewedVersion(state) }, shopper())
            expect(result).toMatchObject({ isError: true, structuredContent: { error: { status: 409, code: 'offer_not_removed' }, cart: { offer_applied: true, coupons: [] } } })
            expectNoCode(result)
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
