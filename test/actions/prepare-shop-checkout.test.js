// Analytics is covered by test/lib/analytics.test.js; keep these handler tests offline.
jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }))

const handler = require('../../actions/prepare-shop-checkout/index.js')
const { shopper, cart, readyCart, fakeCommerce } = require('../fixtures/shop.js')

const ADDRESS = {
    firstname: 'Sam', lastname: 'Lee', street: '1 Trail Rd', city: 'Sydney', region: 'new south wales', postcode: '2000', telephone: '0400 000 000'
}

function routes (state, overrides = {}) {
    const ok = (name) => () => ({ data: { [name]: { cart: { id: 'masked-cart-id' } } } })
    return {
        ShopCart: () => ({ data: { customerCart: state.cart } }),
        ShopCustomer: () => ({ data: { customer: state.customer } }),
        ShopEmail: ok('setGuestEmailOnCart'),
        ShopCoupon: ok('applyCouponToCart'),
        ShopShipTo: (v) => { state.cart = readyCart({ shipping_addresses: readyCart().shipping_addresses.map((a) => ({ ...a, selected_shipping_method: v ? a.selected_shipping_method : null })) }); return ok('setShippingAddressesOnCart')() },
        ShopBillTo: ok('setBillingAddressOnCart'),
        ShopShipVia: ok('setShippingMethodsOnCart'),
        ShopPay: ok('setPaymentMethodOnCart'),
        ...overrides
    }
}

describe('prepare-shop-checkout', () => {
    const originalFetch = global.fetch
    afterEach(() => { global.fetch = originalFetch })

    test('applies email, address (billing same as shipping), method and Demo Pay in order', async () => {
        const state = { cart: cart(), customer: { email: 'auth0abc@users.wknd.example', addresses: [] } }
        fakeCommerce(routes(state))
        const result = await handler({ email: 'sam@example.com', shipping_address: ADDRESS, shipping_method: 'Express' }, shopper())
        const ops = global.fetch.calls.map((c) => c.operation)
        expect(ops).toEqual(['ShopCart', 'ShopCustomer', 'ShopEmail', 'ShopShipTo', 'ShopBillTo', 'ShopShipVia', 'ShopPay', 'ShopCart', 'ShopOffer'])
        const call = (op) => global.fetch.calls.find((c) => c.operation === op).variables.input
        expect(call('ShopShipTo').shipping_addresses[0].address).toMatchObject({ region: 'NSW', country_code: 'AU', street: ['1 Trail Rd'], save_in_address_book: false })
        expect(call('ShopBillTo').billing_address).toEqual({ same_as_shipping: true })
        expect(call('ShopShipVia').shipping_methods).toEqual([{ carrier_code: 'wknd', method_code: 'express' }])
        expect(call('ShopPay').payment_method).toEqual({ code: 'wknd_demo_pay' })
        expect(result.structuredContent).toMatchObject({ view: 'checkout', account_email: null, cart: { ready: true } })
        expect(result.content[0].text).toMatch(/Ready to place a WKND Demo Pay order/)
    })

    test('uses the account email but never a placeholder', async () => {
        const state = { cart: cart(), customer: { email: 'auth0abc@users.wknd.example', addresses: [] } }
        fakeCommerce(routes(state))
        await handler({}, shopper())
        expect(global.fetch.calls.map((c) => c.operation)).not.toContain('ShopEmail')

        state.customer.email = 'sam@example.com'
        fakeCommerce(routes(state))
        const result = await handler({}, shopper())
        expect(global.fetch.calls.find((c) => c.operation === 'ShopEmail').variables.input.email).toBe('sam@example.com')
        expect(result.structuredContent.account_email).toBe('sam@example.com')
    })

    test('ships to a saved address only when it belongs to the account', async () => {
        const state = { cart: cart(), customer: { email: 'sam@example.com', addresses: [{ uid: 'addr-1', firstname: 'Sam', lastname: 'Lee', street: ['1 Trail Rd'], city: 'Sydney', postcode: '2000', country_code: 'AU', region: { region_code: 'NSW' }, default_shipping: true }] } }
        fakeCommerce(routes(state))
        const ok = await handler({ saved_address_id: 'addr-1' }, shopper())
        expect(global.fetch.calls.find((c) => c.operation === 'ShopShipTo').variables.input.shipping_addresses).toEqual([{ customer_address_uid: 'addr-1' }])
        expect(ok.structuredContent.saved_addresses).toEqual([{ id: 'addr-1', label: 'Sam Lee, 1 Trail Rd, Sydney NSW 2000, AU', default: true }])

        fakeCommerce(routes({ ...state, cart: cart() }))
        const foreign = await handler({ saved_address_id: 'someone-elses' }, shopper())
        expect(foreign.structuredContent.error.code).toBe('address_not_found')
        expect(global.fetch.calls.map((c) => c.operation)).not.toContain('ShopShipTo')
    })

    test('a rejected coupon is a warning, not a failure', async () => {
        const state = { cart: readyCart(), customer: { email: 'sam@example.com', addresses: [] } }
        fakeCommerce(routes(state, { ShopCoupon: () => ({ data: null, errors: [{ message: 'The coupon code isn\'t valid.' }] }) }))
        const result = await handler({ coupon_code: 'nope' }, shopper())
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent.warnings[0]).toMatch(/NOPE was not applied/)
    })

    test('shows the cart as it now is when a later step fails', async () => {
        const state = { cart: cart(), customer: { email: 'sam@example.com', addresses: [] } }
        fakeCommerce(routes(state, { ShopShipVia: () => ({ data: null, errors: [{ message: 'Carrier with such method not found' }] }) }))
        const result = await handler({ shipping_address: ADDRESS, shipping_method: 'international' }, shopper())
        expect(result.structuredContent).toMatchObject({ error: { message: 'Carrier with such method not found' }, cart: { checkout: { shipping_address: { city: 'Sydney' } } } })
    })

    test.each([
        [{ shipping_address: { ...ADDRESS, region: 'Narnia' } }, 'invalid_address'],
        [{ shipping_address: { ...ADDRESS, telephone: 'call me' } }, 'invalid_address'],
        [{ shipping_address: ADDRESS, saved_address_id: 'addr-1' }, 'invalid_address'],
        [{ email: 'not-an-email' }, 'invalid_email'],
        [{ shipping_method: 'drone' }, 'invalid_shipping_method'],
        [{ coupon_code: '<x>' }, 'invalid_coupon']
    ])('validates %j before calling Commerce', async (args, code) => {
        global.fetch = jest.fn()
        expect((await handler(args, shopper())).structuredContent.error.code).toBe(code)
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('refuses an empty cart', async () => {
        fakeCommerce(routes({ cart: cart({ items: [] }), customer: {} }))
        expect((await handler({}, shopper())).structuredContent.error.code).toBe('cart_empty')
    })
})
