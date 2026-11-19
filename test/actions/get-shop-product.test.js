// Analytics is covered by test/lib/analytics.test.js; keep these handler tests offline.
jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }))

const handler = require('../../actions/get-shop-product/index.js')
const { jacketView, fakeCommerce } = require('../fixtures/shop.js')

describe('get-shop-product', () => {
    const originalFetch = global.fetch
    afterEach(() => { global.fetch = originalFetch })

    test('returns option availability and the exact variant for chosen options', async () => {
        fakeCommerce({
            ShopProducts: () => ({ data: { products: [jacketView()] } }),
            ShopRefine: (variables) => ({
                data: {
                    refineProduct: {
                        __typename: 'SimpleProductView', sku: 'WKND-JKT-003-OCEA-M', name: 'Torrent Rain Jacket — Deep Ocean / M',
                        url: 'https://wknd-adventures.run.place/shop/products/torrent-rain-jacket', inStock: variables.optionIds.length === 2,
                        images: [], attributes: [], price: { final: { amount: { value: 249, currency: 'AUD' } }, regular: { amount: { value: 249, currency: 'AUD' } } }
                    }
                }
            })
        })
        const result = await handler({ sku: 'WKND-JKT-003', options: { colour: 'Deep Ocean', size: 'M' } }, {})
        expect(global.fetch.calls.find((c) => c.operation === 'ShopRefine').variables).toEqual({ sku: 'WKND-JKT-003', optionIds: ['Y29sb3Ivb2NlYW4=', 'c2l6ZS9t'] })
        expect(result.structuredContent).toMatchObject({
            view: 'products', total: 1, selected_variant: { sku: 'WKND-JKT-003-OCEA-M', in_stock: true }, missing_options: [],
            selected_options: { color: 'Y29sb3Ivb2NlYW4=', size: 'c2l6ZS9t' }
        })
        expect(result.content[0].text).toMatch(/Selected variant WKND-JKT-003-OCEA-M: A\$249\.00, in stock/)
    })

    test('lists remaining choices for a partial selection', async () => {
        fakeCommerce({
            ShopProducts: () => ({ data: { products: [jacketView()] } }),
            ShopRefine: () => ({ data: { refineProduct: jacketView() } })
        })
        const result = await handler({ sku: 'WKND-JKT-003', options: { size: 'M' } }, {})
        expect(result.structuredContent.selected_variant).toBeNull()
        expect(result.structuredContent.selected_options).toEqual({ size: 'c2l6ZS9t' })
        expect(result.structuredContent.missing_options).toEqual(['Colour'])
        expect(result.content[0].text).toMatch(/Still to choose: Colour/)
    })

    test('reports unknown products and invalid input', async () => {
        fakeCommerce({ ShopProducts: () => ({ data: { products: [] } }) })
        expect((await handler({ sku: 'NOPE-1' }, {})).structuredContent.error.code).toBe('product_not_found')
        expect((await handler({ sku: '../x' }, {})).structuredContent.error.code).toBe('invalid_sku')
    })
})
