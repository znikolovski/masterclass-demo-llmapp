// Analytics is covered by test/lib/analytics.test.js; keep these handler tests offline.
jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }))

const { jacketView, lampView, fakeCommerce } = require('../fixtures/shop.js')

const CATEGORIES = () => ({
    data: {
        productSearch: {
            facets: [{
                attribute: 'categoryPath',
                buckets: [
                    { path: 'apparel', name: 'Apparel' },
                    { path: 'apparel/jackets', name: 'Jackets' },
                    { path: 'apparel/base-layers', name: 'Base & Mid Layers' },
                    { path: 'accessories/packs', name: 'Backpacks' }
                ]
            }]
        }
    }
})
const found = (...views) => ({ data: { productSearch: { total_count: views.length, items: views.map((productView) => ({ productView })) } } })
const searches = () => global.fetch.calls.filter((c) => c.operation === 'ShopSearch')
const filterOf = (call, attribute) => call.variables.filter.find((f) => f.attribute === attribute)

describe('search-shop-products', () => {
    const originalFetch = global.fetch
    let handler
    beforeEach(() => {
        // fresh module state: the category list is cached per container
        jest.resetModules()
        handler = require('../../actions/search-shop-products/index.js')
    })
    afterEach(() => { global.fetch = originalFetch })

    test('searches the live catalog with filters and returns products for the widget', async () => {
        fakeCommerce({ ShopCategories: CATEGORIES, ShopSearch: () => found(jacketView(), lampView()) })
        const result = await handler({ query: 'rain', category: 'Apparel/Jackets', activity: 'Hiking', max_price: 300, limit: 50 }, {})
        expect(searches()).toHaveLength(1)
        const { variables } = searches()[0]
        expect(variables).toMatchObject({ phrase: 'rain', pageSize: 12 })
        expect(variables.filter).toEqual(expect.arrayContaining([
            { attribute: 'categoryPath', eq: 'apparel/jackets' },
            { attribute: 'activity', eq: 'Hiking' },
            { attribute: 'price', range: { from: 0, to: 300 } },
            { attribute: 'inStock', eq: 'true' }
        ]))
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent).toMatchObject({ view: 'products', query: 'rain', total: 2, category: 'apparel/jackets', relaxed: [] })
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
        ['jackets', 'apparel/jackets'],
        ['Jacket', 'apparel/jackets'],
        ['base & mid layers', 'apparel/base-layers'],
        ['backpacks', 'accessories/packs'],
        ['packs', 'accessories/packs']
    ])('resolves the category %j to %s', async (category, path) => {
        fakeCommerce({ ShopCategories: CATEGORIES, ShopSearch: () => found(jacketView()) })
        const result = await handler({ category }, {})
        expect(filterOf(searches()[0], 'categoryPath')).toEqual({ attribute: 'categoryPath', eq: path })
        expect(result.structuredContent.category).toBe(path)
    })

    test('drops an activity filter that leaves nothing, and says so', async () => {
        fakeCommerce({
            ShopCategories: CATEGORIES,
            ShopSearch: (v) => (v.filter.some((f) => f.attribute === 'activity') ? found() : found(jacketView()))
        })
        const result = await handler({ query: 'jackets', category: 'jackets', activity: 'skiing' }, {})
        expect(searches()).toHaveLength(2)
        expect(filterOf(searches()[1], 'categoryPath')).toEqual({ attribute: 'categoryPath', eq: 'apparel/jackets' })
        expect(filterOf(searches()[1], 'activity')).toBeUndefined()
        expect(result.structuredContent).toMatchObject({ total: 1, relaxed: ['activity'] })
        expect(result.content[0].text).toMatch(/Nothing matched the activity "skiing", so that filter was dropped/)
    })

    test('drops the category last, keeping the phrase', async () => {
        fakeCommerce({
            ShopCategories: CATEGORIES,
            ShopSearch: (v) => (v.filter.some((f) => ['activity', 'categoryPath'].includes(f.attribute)) ? found() : found(lampView()))
        })
        const result = await handler({ query: 'headlamp', category: 'backpacks', activity: 'Hiking' }, {})
        expect(searches()).toHaveLength(3)
        expect(searches()[2].variables).toMatchObject({ phrase: 'headlamp' })
        expect(result.structuredContent.relaxed).toEqual(['activity', 'category'])
        expect(result.content[0].text).toMatch(/activity "Hiking" and category "backpacks", so those filters were dropped/)
    })

    test('searches without an unknown category instead of returning nothing', async () => {
        fakeCommerce({ ShopCategories: CATEGORIES, ShopSearch: () => found(lampView()) })
        const result = await handler({ query: 'headlamp', category: 'lighting gear' }, {})
        expect(searches()).toHaveLength(1)
        expect(filterOf(searches()[0], 'categoryPath')).toBeUndefined()
        expect(result.structuredContent).toMatchObject({ category: null, relaxed: ['category'] })
    })

    test('marks sold-out option combinations for the widget and the model', async () => {
        fakeCommerce({
            ShopSearch: () => found(jacketView(), lampView()),
            ShopVariants: (v) => {
                expect(v).toEqual({ s0: 'WKND-JKT-003' })
                return { data: { v0: { variants: [
                    { selections: ['Y29sb3Ivb2NlYW4=', 'c2l6ZS9t'], product: { inStock: false } },
                    { selections: ['Y29sb3IvY2hhbGs=', 'c2l6ZS9t'], product: { inStock: true } }
                ] } } }
            }
        })
        const result = await handler({ query: 'rain' }, {})
        const [jacket, lamp] = result.structuredContent.products
        expect(jacket.sold_out).toEqual([['Y29sb3Ivb2NlYW4=', 'c2l6ZS9t']])
        expect(lamp.sold_out).toBeUndefined()
        expect(result.content[0].text).toMatch(/Torrent Rain Jacket .* — Sold out: Deep Ocean \/ M/)
    })

    test('still returns results when variant stock cannot be read', async () => {
        fakeCommerce({ ShopSearch: () => found(jacketView()), ShopVariants: () => { throw new Error('down') } })
        const result = await handler({ query: 'rain' }, {})
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent.products[0].sold_out).toBeUndefined()
    })

    test('caches the category list', async () => {
        fakeCommerce({ ShopCategories: CATEGORIES, ShopSearch: () => found(jacketView()) })
        await handler({ category: 'jackets' }, {})
        await handler({ category: 'backpacks' }, {})
        expect(global.fetch.calls.filter((c) => c.operation === 'ShopCategories')).toHaveLength(1)
    })

    test.each([
        [{ category: '../admin' }, 'invalid_category'],
        [{ category: 'jackets?x=1' }, 'invalid_category'],
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
