/*
 * Test helpers for the WKND shop tools: a verified shopper context and a fake storefront GraphQL
 * endpoint keyed by operation name (ShopCart, ShopAdd, …).
 */
const MCP_RESOURCE = 'https://28538-wkndsherpa.adobeio-static.net/api/v1/web/llm-apps/mcp'
const ISSUER = 'https://dev-g4kzp3zwgwzs8oha.us.auth0.com/'
const SECRET = 'test-only-commerce-assertion-secret-32-bytes!'
const SUB = 'auth0|shopper-1'
const DM = 'https://delivery-p115476-e1135027.adobeaemcloud.com/adobe/assets/urn:aaid:aem:d6d5b8f3-540b-4be5-88a6-dbd99c3f30a1'

function shopper (overrides = {}) {
    return {
        authInfo: {
            token: 'private-mcp-access-token',
            clientId: 'chatgpt',
            scopes: ['shop:cart'],
            expiresAt: Math.floor(Date.now() / 1000) + 600,
            resource: MCP_RESOURCE,
            extra: { sub: SUB, iss: ISSUER, email: 'sam@example.com' },
            ...overrides
        },
        variables: { WKND_COMMERCE_ASSERTION_SECRET: SECRET }
    }
}

const money = (value) => ({ value, currency: 'AUD' })

function jacketView (overrides = {}) {
    return {
        __typename: 'ComplexProductView',
        sku: 'WKND-JKT-003',
        name: 'Torrent Rain Jacket',
        urlKey: 'torrent-rain-jacket',
        url: 'https://wknd-adventures.run.place/shop/products/torrent-rain-jacket',
        shortDescription: 'Packable rain shell.',
        inStock: true,
        images: [{ url: DM, label: 'Torrent Rain Jacket' }],
        attributes: [{ name: 'activity', label: 'Activity', value: 'Hiking' }],
        priceRange: {
            minimum: { final: { amount: money(249) }, regular: { amount: money(279) } },
            maximum: { final: { amount: money(249) } }
        },
        options: [
            { id: 'color', title: 'Colour', values: [
                { id: 'Y29sb3Ivb2NlYW4=', title: 'Deep Ocean', inStock: true, type: 'COLOR_HEX', value: '#1F4E66' },
                { id: 'Y29sb3IvY2hhbGs=', title: 'Chalk White', inStock: false, type: 'COLOR_HEX', value: '#EDEBE6' }
            ] },
            { id: 'size', title: 'Size', values: [
                { id: 'c2l6ZS9t', title: 'M', inStock: true, type: 'TEXT', value: 'M' }
            ] }
        ],
        ...overrides
    }
}

function lampView (overrides = {}) {
    return {
        __typename: 'SimpleProductView',
        sku: 'WKND-LGT-001',
        name: 'Alpine Start Headlamp 400',
        urlKey: 'alpine-start-headlamp-400',
        url: 'https://wknd-adventures.run.place/shop/products/alpine-start-headlamp-400',
        shortDescription: 'Bright and light.',
        inStock: true,
        images: [{ url: 'https://elsewhere.example/lamp.jpg', label: 'Lamp' }],
        attributes: [],
        price: { final: { amount: money(69) }, regular: { amount: money(69) } },
        ...overrides
    }
}

function cartItem (uid, quantity, unit, extra = {}) {
    return {
        uid,
        quantity,
        is_available: true,
        not_available_message: null,
        prices: {
            price_including_tax: money(unit),
            row_total_including_tax: money(unit * quantity),
            original_item_price: money(unit)
        },
        product: { sku: 'WKND-LGT-001', name: 'Alpine Start Headlamp 400', canonical_url: '/shop/products/alpine-start-headlamp-400', thumbnail: { url: DM, label: '' } },
        ...extra
    }
}

function cart (overrides = {}) {
    const items = overrides.items || [cartItem('line-1', 1, 69)]
    const total = items.reduce((n, i) => n + i.prices.row_total_including_tax.value, 0)
    return {
        id: 'masked-cart-id',
        email: null,
        total_quantity: items.reduce((n, i) => n + i.quantity, 0),
        items,
        prices: {
            grand_total: money(total),
            subtotal_including_tax: money(total),
            applied_taxes: [{ label: 'GST (10% incl.)', amount: money(Math.round(total / 11 * 100) / 100) }],
            discounts: []
        },
        applied_coupons: [],
        wknd_cart_version: 'v1',
        shipping_addresses: [],
        billing_address: null,
        selected_payment_method: { code: '', title: '' },
        ...overrides
    }
}

function readyCart (overrides = {}) {
    const method = { carrier_code: 'wknd', method_code: 'standard', carrier_title: 'WKND Shipping', method_title: 'Standard', amount: money(9.95), available: true }
    return cart({
        email: 'sam@example.com',
        shipping_addresses: [{
            firstname: 'Sam', lastname: 'Lee', street: ['1 Trail Rd'], city: 'Sydney', postcode: '2000', telephone: '0400000000',
            region: { code: 'NSW', label: 'New South Wales' }, country: { code: 'AU', label: 'Australia' },
            available_shipping_methods: [method], selected_shipping_method: method
        }],
        billing_address: { firstname: 'Sam', lastname: 'Lee' },
        selected_payment_method: { code: 'wknd_demo_pay', title: 'WKND Demo Pay' },
        ...overrides
    })
}

/**
 * Installs a fetch mock answering storefront GraphQL operations from `routes`
 * ({ ShopCart: (variables, request) => body, ... }). Returns the jest mock.
 */
function fakeCommerce (routes) {
    const calls = []
    global.fetch = jest.fn(async (url, init) => {
        const { query, variables } = JSON.parse(init.body)
        const operation = (query.match(/^\s*(?:query|mutation)\s+(\w+)/) || [])[1]
        calls.push({ operation, variables, headers: init.headers, url })
        const route = routes[operation]
        if (!route) throw new Error(`unexpected operation ${operation}`)
        const body = await route(variables, init)
        return { ok: true, status: 200, json: async () => body }
    })
    global.fetch.calls = calls
    return global.fetch
}

module.exports = {
    MCP_RESOURCE, ISSUER, SECRET, SUB, DM, shopper, money, jacketView, lampView, cartItem, cart, readyCart, fakeCommerce
}
