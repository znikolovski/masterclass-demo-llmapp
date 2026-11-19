// Analytics is covered by test/lib/analytics.test.js; keep these handler tests offline.
jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }))

const handler = require('../../actions/get-shop-cart/index.js')
const { shopper, cart, fakeCommerce } = require('../fixtures/shop.js')

describe('get-shop-cart', () => {
    const originalFetch = global.fetch
    afterEach(() => { global.fetch = originalFetch })

    test('returns the shopper\'s canonical Commerce cart', async () => {
        fakeCommerce({ ShopCart: () => ({ data: { customerCart: cart() } }) })
        const result = await handler({}, shopper())
        expect(global.fetch.calls[0].headers['X-WKND-Delegation']).toBe('mcp')
        expect(result.structuredContent).toMatchObject({ view: 'cart', cart: { item_count: 1, lines: [{ line_id: 'line-1' }] } })
        expect(result.structuredContent.cart).not.toHaveProperty('id')
        expect(result.content[0].text).toMatch(/1 × Alpine Start Headlamp 400 \[line line-1\]/)
    })

    test('requires sign-in without calling Commerce', async () => {
        global.fetch = jest.fn()
        const result = await handler({}, {})
        expect(result).toMatchObject({ isError: true, structuredContent: { view: 'error', error: { status: 401 } } })
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('reports an empty cart plainly', async () => {
        fakeCommerce({ ShopCart: () => ({ data: { customerCart: cart({ items: [] }) } }) })
        const result = await handler({}, shopper())
        expect(result.content[0].text).toBe('Your WKND cart is empty.')
    })
})
