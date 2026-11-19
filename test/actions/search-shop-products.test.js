// Analytics is covered by test/lib/analytics.test.js; keep these handler tests offline.
jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }))

const handler = require('../../actions/search-shop-products/index.js')
const { jacketView, lampView, fakeCommerce } = require('../fixtures/shop.js')

describe('search-shop-products', () => {
    const originalFetch = global.fetch
    afterEach(() => { global.fetch = originalFetch })

    test('searches the live catalog with filters and returns products for the widget', async () => {
        fakeCommerce({
            ShopSearch: () => ({ data: { productSearch: { total_count: 2, items: [{ productView: jacketView() }, { productView: lampView() }] } } })
        })
        const result = await handler({ query: 'rain', category: 'Apparel/Jackets', activity: 'Hiking', max_price: 300, limit: 50 }, {})
        const { variables } = global.fetch.calls[0]
        expect(variables).toMatchObject({ phrase: 'rain', pageSize: 12 })
        expect(variables.filter).toEqual(expect.arrayContaining([
            { attribute: 'categoryPath', eq: 'apparel/jackets' },
            { attribute: 'activity', eq: 'Hiking' },
            { attribute: 'price', range: { from: 0, to: 300 } },
            { attribute: 'inStock', eq: 'true' }
        ]))
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent).toMatchObject({ view: 'products', query: 'rain', total: 2 })
        expect(result.structuredContent.products.map((p) => p.sku)).toEqual(['WKND-JKT-003', 'WKND-LGT-001'])
        expect(result.content[0].text).toMatch(/Torrent Rain Jacket \[sku WKND-JKT-003\]/)
        expect(result.content[0].text).toMatch(/Colour: Deep Ocean;/)
    })

    test('can include sold-out products', async () => {
        fakeCommerce({ ShopSearch: () => ({ data: { productSearch: { total_count: 0, items: [] } } }) })
        const result = await handler({ query: 'tent', in_stock_only: false }, {})
        expect(global.fetch.calls[0].variables.filter).not.toContainEqual({ attribute: 'inStock', eq: 'true' })
        expect(result.structuredContent.products).toEqual([])
        expect(result.content[0].text).toMatch(/No WKND gear matched "tent"/)
    })

    test.each([
        [{ category: '../admin' }, 'invalid_category'],
        [{ min_price: 50, max_price: 10 }, 'invalid_price_range'],
        [{ max_price: -1 }, 'invalid_price_range']
    ])('rejects %j', async (args, code) => {
        global.fetch = jest.fn()
        const result = await handler(args, {})
        expect(result.isError).toBe(true)
        expect(result.structuredContent.error.code).toBe(code)
        expect(global.fetch).not.toHaveBeenCalled()
    })
})
