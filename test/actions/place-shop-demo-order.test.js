// Analytics is covered by test/lib/analytics.test.js; keep these handler tests offline.
jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }))

const handler = require('../../actions/place-shop-demo-order/index.js')
const { normalizeCart } = require('../../actions/lib/commerce.js')
const { shopper, cart, readyCart, fakeCommerce } = require('../fixtures/shop.js')

const ORDER = {
    number: 'WKND-DEMO-261119-ABC123', email: 'sam@example.com', created_at: '2026-11-19T00:00:00Z', status: 'Processing (demo)',
    shipping_method: 'WKND Shipping - Standard',
    items: [{ product_name: 'Alpine Start Headlamp 400', product_sku: 'WKND-LGT-001', quantity_ordered: 1, selected_options: [], prices: { row_total_including_tax: { value: 69, currency: 'AUD' } } }],
    total: {
        grand_total: { value: 78.95, currency: 'AUD' }, subtotal_incl_tax: { value: 69, currency: 'AUD' },
        total_shipping: { value: 9.95, currency: 'AUD' }, total_tax: { value: 7.18, currency: 'AUD' }, discounts: []
    },
    shipping_address: { firstname: 'Sam', lastname: 'Lee', city: 'Sydney', postcode: '2000', region: 'New South Wales', country_code: 'AU' },
    payment_methods: [{ name: 'WKND Demo Pay (demo — no charge)' }]
}

describe('place-shop-demo-order', () => {
    const originalFetch = global.fetch
    afterEach(() => { global.fetch = originalFetch })

    const ready = readyCart()
    const reviewed = normalizeCart(ready)
    const confirmed = { cart_version: reviewed.version, expected_grand_total: reviewed.totals.grand_total.value, confirm: true }

    test('places the reviewed cart and returns a demo receipt', async () => {
        fakeCommerce({
            ShopCart: () => ({ data: { customerCart: ready } }),
            ShopPlaceOrder: () => ({ data: { placeOrder: { errors: [], orderV2: ORDER } } })
        })
        const result = await handler(confirmed, shopper())
        expect(global.fetch.calls[1].variables).toEqual({ input: { cart_id: 'masked-cart-id' } })
        const claims = JSON.parse(Buffer.from(global.fetch.calls[1].headers.Authorization.split('.')[1], 'base64url'))
        expect(claims.order_expect).toEqual({ grand_total: reviewed.totals.grand_total.value, items: [['WKND-LGT-001', 1]] })
        const cartClaims = JSON.parse(Buffer.from(global.fetch.calls[0].headers.Authorization.split('.')[1], 'base64url'))
        expect(cartClaims).not.toHaveProperty('order_expect')
        expect(result.structuredContent).toMatchObject({
            view: 'order',
            order: {
                number: 'WKND-DEMO-261119-ABC123', ship_to: 'Sydney New South Wales 2000 AU',
                url: 'https://wknd-adventures.run.place/shop/order?orderRef=WKND-DEMO-261119-ABC123',
                totals: { grand_total: { value: 78.95 } }
            }
        })
        expect(result.content[0].text).toMatch(/No payment is taken and nothing ships/)
    })

    test('requires explicit confirmation of a reviewed version and total', async () => {
        global.fetch = jest.fn()
        expect((await handler({ ...confirmed, confirm: 'yes' }, shopper())).structuredContent.error.code).toBe('confirmation_required')
        expect((await handler({ ...confirmed, cart_version: undefined }, shopper())).structuredContent.error.code).toBe('invalid_cart_version')
        expect((await handler({ ...confirmed, expected_grand_total: 'lots' }, shopper())).structuredContent.error.code).toBe('invalid_total')
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('never orders a cart that changed after review', async () => {
        const changed = readyCart({ email: 'other@example.com' })
        fakeCommerce({ ShopCart: () => ({ data: { customerCart: changed } }) })
        const result = await handler(confirmed, shopper())
        expect(result.structuredContent).toMatchObject({ error: { code: 'cart_changed' }, cart: { checkout: { email: 'other@example.com' } } })
        expect(global.fetch.calls.map((c) => c.operation)).toEqual(['ShopCart'])
    })

    test('never orders at a different total', async () => {
        fakeCommerce({ ShopCart: () => ({ data: { customerCart: ready } }) })
        const result = await handler({ ...confirmed, expected_grand_total: 1 }, shopper())
        expect(result.structuredContent.error.code).toBe('total_changed')
    })

    test('refuses an incomplete checkout', async () => {
        const incomplete = cart()
        const v = normalizeCart(incomplete)
        fakeCommerce({ ShopCart: () => ({ data: { customerCart: incomplete } }) })
        const result = await handler({ cart_version: v.version, expected_grand_total: v.totals.grand_total.value, confirm: true }, shopper())
        expect(result.structuredContent.error).toMatchObject({ code: 'checkout_incomplete', message: expect.stringMatching(/email, shipping_address/) })
    })

    test('a replay after the order was placed does not order again', async () => {
        fakeCommerce({ ShopCart: () => ({ data: { customerCart: cart({ items: [] }) } }) })
        expect((await handler(confirmed, shopper())).structuredContent.error.code).toBe('cart_already_ordered')

        fakeCommerce({
            ShopCart: () => ({ data: { customerCart: ready } }),
            ShopPlaceOrder: () => ({ data: { placeOrder: { errors: [{ code: 'CART_NOT_ACTIVE', message: 'The cart isn\'t active.' }], orderV2: null } } })
        })
        expect((await handler(confirmed, shopper())).structuredContent.error.code).toBe('cart_already_ordered')
    })

    test('surfaces stock failures with the refreshed cart', async () => {
        fakeCommerce({
            ShopCart: () => ({ data: { customerCart: ready } }),
            ShopPlaceOrder: () => ({ data: { placeOrder: { errors: [{ code: 'INSUFFICIENT_STOCK', message: 'Not all of your products are available.' }], orderV2: null } } })
        })
        const result = await handler(confirmed, shopper())
        expect(result.structuredContent).toMatchObject({ error: { code: 'order_rejected', message: 'Not all of your products are available.' }, cart: { ready: true } })
    })

    test('a cart changed between review and placement is reported as cart_changed', async () => {
        fakeCommerce({
            ShopCart: () => ({ data: { customerCart: ready } }),
            ShopPlaceOrder: () => ({ data: { placeOrder: { errors: [{ code: 'UNABLE_TO_PLACE_ORDER', message: 'Your cart changed after you reviewed it. Review the cart and try again.' }], orderV2: null } } })
        })
        const result = await handler(confirmed, shopper())
        expect(result.structuredContent).toMatchObject({ error: { code: 'cart_changed' }, cart: { ready: true } })
    })

    test('requires sign-in', async () => {
        global.fetch = jest.fn()
        expect((await handler(confirmed, {})).structuredContent.error.status).toBe(401)
    })
})
