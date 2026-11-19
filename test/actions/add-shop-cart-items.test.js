// Analytics is covered by test/lib/analytics.test.js; keep these handler tests offline.
jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }))

const handler = require('../../actions/add-shop-cart-items/index.js')
const { normalizeCart } = require('../../actions/lib/commerce.js')
const { shopper, jacketView, lampView, cart, cartItem, fakeCommerce } = require('../fixtures/shop.js')

describe('add-shop-cart-items', () => {
    const originalFetch = global.fetch
    afterEach(() => { global.fetch = originalFetch })

    function routes (overrides = {}) {
        return {
            ShopProducts: () => ({ data: { products: [jacketView(), lampView()] } }),
            ShopCart: () => ({ data: { customerCart: cart() } }),
            ShopAdd: () => ({ data: { addProductsToCart: { cart: cart({ items: [cartItem('line-1', 1, 69), cartItem('line-2', 1, 249)] }), user_errors: [] } } }),
            ...overrides
        }
    }

    test('adds a fully specified variant (flat sku/options arguments) to the shopper\'s own cart', async () => {
        fakeCommerce(routes())
        const version = normalizeCart(cart()).version
        const result = await handler({ sku: 'WKND-JKT-003', options: { colour: 'Deep Ocean', size: 'M' }, cart_version: version }, shopper())
        const add = global.fetch.calls.find((c) => c.operation === 'ShopAdd')
        expect(add.variables).toEqual({
            cartId: 'masked-cart-id',
            items: [{ sku: 'WKND-JKT-003', quantity: 1, selected_options: ['Y29sb3Ivb2NlYW4=', 'c2l6ZS9t'] }]
        })
        expect(result.structuredContent).toMatchObject({ view: 'cart', cart: { item_count: 2 }, warnings: [] })
        expect(result.content[0].text).toMatch(/^Added 1 × Torrent Rain Jacket to your WKND cart/)
    })

    test('honours an explicit quantity for simple products', async () => {
        fakeCommerce(routes())
        await handler({ sku: 'WKND-LGT-001', quantity: 3 }, shopper())
        const add = global.fetch.calls.find((c) => c.operation === 'ShopAdd')
        expect(add.variables.items).toEqual([{ sku: 'WKND-LGT-001', quantity: 3 }])
    })

    test('requires every option before touching the cart', async () => {
        fakeCommerce(routes())
        const result = await handler({ sku: 'WKND-JKT-003', options: { size: 'M' } }, shopper())
        expect(result.structuredContent.error).toMatchObject({ code: 'options_required', message: expect.stringMatching(/Choose Colour/) })
        expect(global.fetch.calls.map((c) => c.operation)).toEqual(['ShopProducts', 'ShopVariants'])
    })

    test('refuses a sold-out combination even when each option is in stock, before touching the cart', async () => {
        fakeCommerce(routes({
            ShopVariants: () => ({ data: { v0: { variants: [{ selections: ['Y29sb3Ivb2NlYW4=', 'c2l6ZS9t'], product: { inStock: false } }] } } })
        }))
        const result = await handler({ sku: 'WKND-JKT-003', options: { colour: 'Deep Ocean', size: 'M' } }, shopper())
        expect(result.structuredContent.error).toMatchObject({
            code: 'sold_out', message: 'Torrent Rain Jacket is sold out in Deep Ocean / M. Choose another colour or size.'
        })
        expect(global.fetch.calls.map((c) => c.operation)).toEqual(['ShopProducts', 'ShopVariants'])
    })

    test('explains a variant that sold out between the check and the add', async () => {
        fakeCommerce(routes({
            ShopAdd: () => ({ data: { addProductsToCart: { cart: cart(), user_errors: [{ code: 'NOT_SALABLE', message: 'Product that you are trying to add is not available.' }] } } })
        }))
        const result = await handler({ sku: 'WKND-JKT-003', options: { colour: 'Deep Ocean', size: 'M' } }, shopper())
        expect(result.structuredContent.error).toMatchObject({ code: 'not_added', message: 'Not added: That item has just sold out in the option you chose.' })
    })

    test('refuses sold-out choices', async () => {
        fakeCommerce(routes())
        const result = await handler({ sku: 'WKND-JKT-003', options: { colour: 'Chalk White', size: 'M' } }, shopper())
        expect(result.structuredContent.error.code).toBe('sold_out')
    })

    test('a stale or replayed add is rejected and returns the current cart', async () => {
        fakeCommerce(routes())
        const result = await handler({ sku: 'WKND-LGT-001', cart_version: '0123456789abcdef' }, shopper())
        expect(result.isError).toBe(true)
        expect(result.structuredContent).toMatchObject({ error: { status: 409, code: 'cart_changed' }, cart: { lines: [{ line_id: 'line-1' }] } })
        expect(global.fetch.calls.map((c) => c.operation)).not.toContain('ShopAdd')
    })

    test('reports Commerce rejections with the cart', async () => {
        fakeCommerce(routes({
            ShopAdd: () => ({ data: { addProductsToCart: { cart: cart(), user_errors: [{ code: 'INSUFFICIENT_STOCK', message: 'Only 1 left.' }] } } })
        }))
        const result = await handler({ sku: 'WKND-LGT-001', quantity: 2 }, shopper())
        expect(result.structuredContent).toMatchObject({ error: { code: 'not_added', message: expect.stringMatching(/Only 1 left/) }, cart: { item_count: 1 } })
    })

    test.each([
        [{}, 'invalid_sku'],
        [{ sku: '../admin' }, 'invalid_sku'],
        [{ sku: 'WKND-LGT-001', quantity: 0 }, 'invalid_quantity'],
        [{ sku: 'WKND-LGT-001', quantity: 1.5 }, 'invalid_quantity'],
        [{ sku: 'WKND-LGT-001', quantity: 21 }, 'invalid_quantity'],
        [{ sku: 'WKND-LGT-001', cart_version: 'nope' }, 'invalid_cart_version']
    ])('validates %j', async (args, code) => {
        global.fetch = jest.fn()
        expect((await handler(args, shopper())).structuredContent.error.code).toBe(code)
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('requires sign-in', async () => {
        global.fetch = jest.fn()
        expect((await handler({ sku: 'WKND-LGT-001' }, {})).structuredContent.error.status).toBe(401)
    })
})
