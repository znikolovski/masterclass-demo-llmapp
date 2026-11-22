const { createHmac } = require('node:crypto')
const commerce = require('../../actions/lib/commerce.js')
const {
    MCP_RESOURCE, ISSUER, SECRET, SUB, DM, shopper, jacketView, lampView, cart, cartItem, fakeCommerce
} = require('../fixtures/shop.js')

const { requireShopper, graphql, normalizeProduct, normalizeCart, resolveOptions, ShopError } = commerce

describe('requireShopper', () => {
    test('accepts a verified, scoped, unexpired WKND shopper', () => {
        expect(requireShopper(shopper())).toMatchObject({ sub: SUB, email: 'sam@example.com' })
    })

    test.each([
        ['no auth', {}],
        ['no verified resource', { authInfo: { ...shopper().authInfo, resource: undefined } }],
        ['a non-https resource', { authInfo: { ...shopper().authInfo, resource: 'http://28538-wkndsherpa.adobeio-static.net/api/v1/web/llm-apps/mcp' } }],
        ['expired', { authInfo: { ...shopper().authInfo, expiresAt: Math.floor(Date.now() / 1000) - 1 } }],
        ['foreign issuer', { authInfo: { ...shopper().authInfo, extra: { sub: SUB, iss: 'https://evil.example/' } } }]
    ])('rejects %s as authentication_required', (_, extra) => {
        expect(() => requireShopper(extra)).toThrow(expect.objectContaining({ status: 401, code: 'authentication_required' }))
    })

    describe('per-deployment resource (verified by the LLM Apps runtime)', () => {
        const STAGE = 'https://28538-wkndsherpa-stage.adobeio-static.net/api/v1/web/llm-apps/mcp'
        const stage = (o = {}) => ({ ...shopper(), authInfo: { ...shopper().authInfo, resource: STAGE, ...o } })

        test('accepts a shopper on the Stage deployment, with no configuration', () => {
            expect(requireShopper(stage())).toMatchObject({ sub: SUB })
        })

        test('a scope step-up on Stage points at Stage metadata', () => {
            let error
            try { requireShopper(stage({ scopes: ['bookings:read'] })) } catch (e) { error = e }
            const result = commerce.failure(error)
            expect(result._meta['mcp/www_authenticate'][0])
                .toContain('resource_metadata="https://28538-wkndsherpa-stage.adobeio-static.net/.well-known/oauth-protected-resource"')
            expect(JSON.stringify(result.structuredContent)).not.toContain('resourceMetadata')
        })

        test('the Commerce assertion issuer is the same on Stage', async () => {
            const originalFetch = global.fetch
            try {
                const extra = stage()
                fakeCommerce({ ShopCart: () => ({ data: { customerCart: cart() } }) })
                await graphql(extra, 'query ShopCart { customerCart { id } }', {}, { shopper: requireShopper(extra) })
                const token = global.fetch.calls[0].headers.Authorization.split(' ')[1]
                expect(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).iss).toBe(MCP_RESOURCE)
            } finally {
                global.fetch = originalFetch
            }
        })
    })

    test('requires the shop:cart scope', () => {
        expect(() => requireShopper(shopper({ scopes: ['bookings:read'] })))
            .toThrow(expect.objectContaining({ status: 403, code: 'insufficient_scope' }))
    })
})

describe('failure', () => {
    const META = 'https://28538-wkndsherpa.adobeio-static.net/.well-known/oauth-protected-resource'

    test('missing sign-in returns the ChatGPT sign-in challenge', () => {
        const result = commerce.failure(new ShopError(401, 'authentication_required', 'Sign in with your WKND account to use your cart.'))
        expect(result.isError).toBe(true)
        expect(result._meta['mcp/www_authenticate']).toEqual([
            `Bearer error="invalid_token", error_description="Sign in with your WKND account to use your cart.", resource_metadata="${META}", scope="shop:cart"`
        ])
    })

    test('a missing scope asks for a step-up', () => {
        const result = commerce.failure(new ShopError(403, 'insufficient_scope', 'Needs "shop:cart".'))
        expect(result._meta['mcp/www_authenticate'][0]).toMatch(/^Bearer error="insufficient_scope", error_description="Needs 'shop:cart'\."/)
    })

    test('backend and other errors never trigger a sign-in loop', () => {
        expect(commerce.failure(new ShopError(401, 'shop_authentication_failed', 'x'))).not.toHaveProperty('_meta')
        expect(commerce.failure(new ShopError(409, 'cart_changed', 'x'))).not.toHaveProperty('_meta')
        expect(commerce.failure(new Error('boom'))).not.toHaveProperty('_meta')
    })
})

describe('graphql', () => {
    const originalFetch = global.fetch
    afterEach(() => { global.fetch = originalFetch })

    test('signs a short-lived single-use assertion and never forwards the MCP token', async () => {
        const extra = shopper()
        fakeCommerce({ ShopCart: () => ({ data: { customerCart: cart() } }) })
        await graphql(extra, 'query ShopCart { customerCart { id } }', {}, { shopper: requireShopper(extra) })
        await graphql(extra, 'query ShopCart { customerCart { id } }', {}, { shopper: requireShopper(extra) })
        const [first, second] = global.fetch.calls
        expect(first.url).toBe(commerce.constants.DEFAULT_GRAPHQL_URL)
        expect(first.headers['X-WKND-Delegation']).toBe('mcp')
        expect(JSON.stringify(first.headers)).not.toContain('private-mcp-access-token')
        const [header, body, signature] = first.headers.Authorization.slice(7).split('.')
        expect(signature).toBe(createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url'))
        const claims = JSON.parse(Buffer.from(body, 'base64url'))
        expect(claims).toMatchObject({
            iss: MCP_RESOURCE, aud: 'urn:wknd-commerce:storefront', sub: SUB, identity_issuer: ISSUER, scope: 'shop:cart', email: 'sam@example.com'
        })
        expect(claims.exp - claims.iat).toBeLessThanOrEqual(60)
        const secondClaims = JSON.parse(Buffer.from(second.headers.Authorization.split('.')[1], 'base64url'))
        expect(secondClaims.jti).not.toBe(claims.jti)
    })

    test('catalog reads are anonymous', async () => {
        fakeCommerce({ ShopProducts: () => ({ data: { products: [] } }) })
        await graphql({}, 'query ShopProducts { products(skus: []) { sku } }')
        expect(global.fetch.calls[0].headers.Authorization).toBeUndefined()
    })

    test('refuses to sign without a configured secret', async () => {
        const extra = { ...shopper(), variables: {} }
        global.fetch = jest.fn()
        await expect(graphql(extra, 'query ShopCart { customerCart { id } }', {}, { shopper: requireShopper(extra) }))
            .rejects.toMatchObject({ status: 503, code: 'shop_configuration_error' })
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('rejects a non-HTTPS endpoint override', async () => {
        global.fetch = jest.fn()
        await expect(graphql({ variables: { WKND_COMMERCE_GRAPHQL_URL: 'http://localhost/graphql' } }, 'query X { a }'))
            .rejects.toMatchObject({ status: 503 })
    })

    test('maps Commerce authentication errors to a sign-in error', async () => {
        fakeCommerce({ ShopCart: () => ({ data: null, errors: [{ message: 'nope', extensions: { category: 'graphql-authentication' } }] }) })
        const extra = shopper()
        await expect(graphql(extra, 'query ShopCart { customerCart { id } }', {}, { shopper: requireShopper(extra) }))
            .rejects.toMatchObject({ status: 401, code: 'shop_authentication_failed' })
    })

    test('maps timeouts and upstream failures', async () => {
        global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' }))
        await expect(graphql({}, 'query X { a }')).rejects.toMatchObject({ status: 504, code: 'shop_timeout' })
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
        await expect(graphql({}, 'query X { a }')).rejects.toMatchObject({ status: 502, code: 'shop_unavailable' })
    })
})

describe('bestMatches', () => {
    const originalFetch = global.fetch
    afterEach(() => { global.fetch = originalFetch })

    test('looks up every phrase in one anonymous, in-stock-only request', async () => {
        fakeCommerce({
            ShopMatches: () => ({ data: { m0: { items: [{ productView: lampView() }] }, m1: { items: [] } } })
        })
        const result = await commerce.bestMatches({}, ['headlamp', 'tent'], { timeoutMs: 6000 })
        expect(global.fetch).toHaveBeenCalledTimes(1)
        const [call] = global.fetch.calls
        expect(call.headers.Authorization).toBeUndefined()
        expect(call.variables).toMatchObject({ p0: 'headlamp', p1: 'tent' })
        expect(call.variables.filter).toContainEqual({ attribute: 'inStock', eq: 'true' })
        expect(result.map((p) => p && p.sku)).toEqual(['WKND-LGT-001', null])
    })

    test('makes no request without phrases', async () => {
        global.fetch = jest.fn()
        expect(await commerce.bestMatches({}, [])).toEqual([])
        expect(global.fetch).not.toHaveBeenCalled()
    })
})

describe('normalizeProduct', () => {
    test('builds Dynamic Media renditions and keeps only WKND links', () => {
        const p = normalizeProduct(jacketView())
        expect(p).toMatchObject({
            sku: 'WKND-JKT-003', type: 'configurable', in_stock: true,
            url: 'https://wknd-adventures.run.place/shop/products/torrent-rain-jacket',
            image: `${DM}/as/torrent-rain-jacket.webp?width=480`,
            price: { currency: 'AUD', min: 249, max: 249, regular: 279 }
        })
        expect(p.options[0].values[0]).toEqual({ id: 'Y29sb3Ivb2NlYW4=', title: 'Deep Ocean', in_stock: true, swatch: '#1F4E66' })
        const foreign = normalizeProduct(lampView({ url: 'https://evil.example/x' }))
        expect(foreign.url).toBeNull()
        expect(foreign.image).toBeNull()
    })

    test('drops malformed swatches', () => {
        const view = jacketView()
        view.options[0].values[0].value = 'url(javascript:alert(1))'
        expect(normalizeProduct(view).options[0].values[0].swatch).toBeNull()
    })
})

describe('resolveOptions', () => {
    const product = normalizeProduct(jacketView())

    test('accepts option ids, titles and colour/color aliases case-insensitively', () => {
        expect(resolveOptions(product, { colour: 'deep ocean', SIZE: 'm' })).toEqual({
            ids: ['Y29sb3Ivb2NlYW4=', 'c2l6ZS9t'], missing: [], invalid: [], unavailable: []
        })
        expect(resolveOptions(product, { color: 'Y29sb3Ivb2NlYW4=', Size: 'M' }).ids).toHaveLength(2)
    })

    test('reports missing, unknown and sold-out choices', () => {
        expect(resolveOptions(product, { size: 'M' }).missing).toEqual(['Colour'])
        expect(resolveOptions(product, { colour: 'Neon', size: 'M' }).invalid[0]).toMatch(/Neon/)
        expect(resolveOptions(product, { colour: 'Chalk White', size: 'M' }).unavailable).toEqual(['Colour: Chalk White'])
    })
})

describe('normalizeCart', () => {
    test('versions the cart by content and lists what an order still needs', () => {
        const one = normalizeCart(cart())
        const two = normalizeCart(cart({ items: [cartItem('line-1', 2, 69)] }))
        expect(one.version).toMatch(/^[0-9a-f]{16}$/)
        expect(one.version).not.toBe(two.version)
        expect(normalizeCart(cart()).version).toBe(one.version)
        expect(one.missing).toEqual(['email', 'shipping_address', 'shipping_method', 'billing_address', 'payment_method'])
        expect(one.ready).toBe(false)
        expect(one.lines[0]).toMatchObject({ line_id: 'line-1', quantity: 1, row_total: { value: 69, currency: 'AUD' } })
    })

    test('hides placeholder account emails', () => {
        expect(normalizeCart(cart({ email: 'auth0abc@users.wknd.example' })).checkout.email).toBeNull()
    })

    test('flags unavailable lines', () => {
        const c = normalizeCart(cart({ items: [cartItem('line-1', 3, 69, { is_available: false, not_available_message: 'Only 1 left' })] }))
        expect(c.lines[0]).toMatchObject({ available: false, message: 'Only 1 left' })
        expect(c.missing).toContain('available_items')
    })

    test('rejects a missing cart', () => {
        expect(() => normalizeCart(null)).toThrow(ShopError)
    })
})
