// Analytics is covered by test/lib/analytics.test.js; keep these handler tests offline.
jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }))

const handler = require('../../actions/update-shop-cart-items/index.js')
const { shopper, cart, cartItem, fakeCommerce } = require('../fixtures/shop.js')

describe('update-shop-cart-items', () => {
    const originalFetch = global.fetch
    afterEach(() => { global.fetch = originalFetch })

    test('sets an absolute quantity (flat line_id/quantity arguments) on the shopper\'s cart', async () => {
        fakeCommerce({
            ShopCart: () => ({ data: { customerCart: cart({ items: [cartItem('line-1', 1, 69), cartItem('line-2', 1, 69)] }) } }),
            ShopUpdate: () => ({ data: { updateCartItems: { cart: cart({ items: [cartItem('line-1', 3, 69), cartItem('line-2', 1, 69)] }), errors: [] } } })
        })
        const result = await handler({ line_id: 'line-1', quantity: 3 }, shopper())
        expect(global.fetch.calls[1].variables).toEqual({
            input: { cart_id: 'masked-cart-id', cart_items: [{ cart_item_uid: 'line-1', quantity: 3 }] }
        })
        expect(result.structuredContent).toMatchObject({ view: 'cart', message: 'Cart updated.', cart: { item_count: 4 } })
    })

    test('quantity 0 removes the line', async () => {
        fakeCommerce({
            ShopCart: () => ({ data: { customerCart: cart({ items: [cartItem('line-1', 1, 69), cartItem('line-2', 1, 69)] }) } }),
            ShopUpdate: () => ({ data: { updateCartItems: { cart: cart({ items: [cartItem('line-1', 1, 69)] }), errors: [] } } })
        })
        const result = await handler({ line_id: 'line-2', quantity: 0 }, shopper())
        expect(global.fetch.calls[1].variables.input.cart_items).toEqual([{ cart_item_uid: 'line-2', quantity: 0 }])
        expect(result.structuredContent).toMatchObject({ message: 'Removed from your cart.', cart: { item_count: 1 } })
    })

    test('surfaces stock adjustments', async () => {
        fakeCommerce({
            ShopCart: () => ({ data: { customerCart: cart() } }),
            ShopUpdate: () => ({ data: { updateCartItems: { cart: cart(), errors: [{ code: 'INSUFFICIENT_STOCK', message: 'Only 1 left.' }] } } })
        })
        const result = await handler({ line_id: 'line-1', quantity: 5 }, shopper())
        expect(result.structuredContent.warnings).toEqual(['Only 1 left.'])
    })

    test('rejects lines that are no longer in the cart, returning the cart', async () => {
        fakeCommerce({ ShopCart: () => ({ data: { customerCart: cart() } }) })
        const result = await handler({ line_id: 'gone', quantity: 1 }, shopper())
        expect(result.structuredContent).toMatchObject({ error: { code: 'line_not_found' }, cart: { lines: [{ line_id: 'line-1' }] } })
        expect(global.fetch.calls.map((c) => c.operation)).toEqual(['ShopCart'])
    })

    test.each([
        [{ line_id: 'line-1', quantity: -1 }, 'invalid_quantity'],
        [{ line_id: 'line-1', quantity: 21 }, 'invalid_quantity'],
        [{ line_id: 'line-1', quantity: 1.5 }, 'invalid_quantity'],
        [{ line_id: 'line-1' }, 'invalid_quantity'],
        [{ quantity: 1 }, 'invalid_line'],
        [{}, 'invalid_line']
    ])('validates %j', async (args, code) => {
        global.fetch = jest.fn()
        expect((await handler(args, shopper())).structuredContent.error.code).toBe(code)
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('requires sign-in', async () => {
        global.fetch = jest.fn()
        expect((await handler({ line_id: 'line-1', quantity: 1 }, {})).structuredContent.error.status).toBe(401)
    })
})
