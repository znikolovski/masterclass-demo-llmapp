const { addDisplayModes, withDisplayModes } = require('../../actions/lib/display-modes.js')

const read = (uri, meta) => JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<div></div>', ...(meta ? { _meta: meta } : {}) }] }
})

describe('addDisplayModes', () => {
    test('declares picture-in-picture on the cart widget resource, keeping other metadata', () => {
        const body = addDisplayModes(read('ui://get-shop-cart/widget.html', { ui: { prefersBorder: false }, 'openai/ui': { availableDisplayModes: ['inline'] } }))
        const meta = JSON.parse(body).result.contents[0]._meta
        expect(meta.ui).toEqual({ prefersBorder: false })
        expect(meta['openai/ui'].availableDisplayModes).toEqual(['inline', 'fullscreen', 'pip'])
    })

    test('adds metadata when the resource has none, and handles batches', () => {
        const batch = `[${read('ui://get-shop-cart/widget.html')},${read('ui://search-shop-products/widget.html')}]`
        const [cart, search] = JSON.parse(addDisplayModes(batch))
        expect(cart.result.contents[0]._meta['openai/ui'].availableDisplayModes).toContain('pip')
        expect(search.result.contents[0]._meta).toBeUndefined()
    })

    test('leaves other responses untouched', () => {
        const other = read('ui://search-shop-products/widget.html')
        expect(addDisplayModes(other)).toBe(other)
        expect(addDisplayModes('not json ui://')).toBe('not json ui://')
        expect(addDisplayModes('')).toBe('')
    })
})

describe('withDisplayModes', () => {
    test('rewrites main() response bodies and keeps the rest of createMain()', async () => {
        const app = { other: 1, main: async () => ({ statusCode: 200, headers: { a: 'b' }, body: read('ui://get-shop-cart/widget.html') }) }
        const wrapped = withDisplayModes(app)
        expect(wrapped.other).toBe(1)
        const res = await wrapped.main({})
        expect(res.statusCode).toBe(200)
        expect(res.headers).toEqual({ a: 'b' })
        expect(JSON.parse(res.body).result.contents[0]._meta['openai/ui'].availableDisplayModes).toContain('pip')
    })
})
