const { createHmac } = require('node:crypto')
const handler = require('../../actions/check-booking/index.js')

const RESOURCE = 'https://28538-wkndsherpa.adobeio-static.net/api/v1/web/llm-apps/mcp'
const ISSUER = 'https://dev-g4kzp3zwgwzs8oha.us.auth0.com/'
const API = 'https://wknd-aero-api.jaggah.workers.dev'
const ID = 'BK_0123456789abcdef'
const SECRET = 'test-only-booking-assertion-key-at-least-32-bytes'
const PRIVATE = 'private-contact-owner-token-do-not-return'

function context() {
    return {
        authInfo: {
            token: PRIVATE,
            clientId: 'verified-client',
            scopes: ['bookings:read'],
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            resource: RESOURCE,
            extra: { sub: PRIVATE }
        },
        variables: { WKND_BOOKING_ASSERTION_SECRET: SECRET }
    }
}

function booking() {
    return {
        id: ID, status: 'confirmed', demo: true, createdAt: '2026-10-20T01:00:00Z',
        updatedAt: '2026-10-20T01:00:00Z', flightId: 'WK101',
        flight: {
            id: 'WK101', origin: 'LAX', destination: 'SFO', departTime: '09:30',
            duration: '1h 30m', cabin: 'Business', aircraft: 'A320',
            departureAt: null, arrivalAt: null, originTimeZone: null, destinationTimeZone: null,
            ownerId: PRIVATE
        },
        seats: ['1A'], passengerCount: 1, total: 450, currency: 'USD',
        adventure: { id: 'surf', title: 'Coastal surf', editorialUrl: 'https://wknd.site/adventures/surf', contact: PRIVATE },
        preparation: {
            itinerary: ['Published surf session'], packingList: ['Wetsuit'],
            permits: [], sourceUrl: 'https://wknd.site/adventures/surf', email: PRIVATE
        },
        ownerId: PRIVATE, owner: { sub: PRIVATE }, email: PRIVATE, phone: PRIVATE,
        accessToken: PRIVATE, billing: { contact: PRIVATE }
    }
}

function upstream(data, status = 200) {
    const response = { ok: status >= 200 && status < 300, status, json: jest.fn().mockResolvedValue(data) }
    global.fetch.mockResolvedValue(response)
    return response
}

describe('check-booking authenticated delegation', () => {
    const originalFetch = global.fetch
    beforeEach(() => { global.fetch = jest.fn() })
    afterEach(() => { global.fetch = originalFetch })

    test('gets own details with a verifiable, bounded assertion, never the MCP access token', async () => {
        const extra = context()
        extra.authInfo.expiresAt = Math.floor(Date.now() / 1000) + 25
        upstream(booking())
        const result = await handler({ booking_id: ID }, extra)
        const [url, options] = global.fetch.mock.calls[0]
        expect(url).toBe(`${API}/api/bookings/${ID}`)
        expect(options).toMatchObject({
            method: 'GET', cache: 'no-store', redirect: 'error',
            headers: { 'X-WKND-Delegation': 'mcp', 'Cache-Control': 'no-store' },
            signal: expect.any(AbortSignal)
        })
        const [header, claims, signature] = options.headers.Authorization.slice(7).split('.')
        expect(JSON.parse(Buffer.from(header, 'base64url'))).toEqual({ alg: 'HS256', typ: 'JWT' })
        const payload = JSON.parse(Buffer.from(claims, 'base64url'))
        expect(payload).toEqual({
            iss: RESOURCE, aud: API, sub: PRIVATE, identity_issuer: ISSUER,
            scope: 'bookings:read', iat: expect.any(Number), exp: extra.authInfo.expiresAt,
            jti: expect.stringMatching(/^[0-9a-f-]{36}$/)
        })
        expect(payload.exp - payload.iat).toBeGreaterThan(0)
        expect(payload.exp - payload.iat).toBeLessThanOrEqual(60)
        expect(signature).toBe(createHmac('sha256', SECRET).update(`${header}.${claims}`).digest('base64url'))
        expect(options.headers.Authorization).not.toBe(`Bearer ${PRIVATE}`)
        expect(result.structuredContent).toEqual({ mode: 'details', booking: {
            id: ID, status: 'confirmed', demo: true, createdAt: '2026-10-20T01:00:00Z',
            updatedAt: '2026-10-20T01:00:00Z', flightId: 'WK101',
            flight: {
                id: 'WK101', origin: 'LAX', destination: 'SFO', departTime: '09:30',
                duration: '1h 30m', cabin: 'Business', aircraft: 'A320',
                departureAt: null, arrivalAt: null, originTimeZone: null, destinationTimeZone: null
            },
            seats: ['1A'], passengerCount: 1, total: 450, currency: 'USD',
            adventure: { id: 'surf', title: 'Coastal surf', editorialUrl: 'https://wknd.site/adventures/surf' },
            preparation: {
                itinerary: ['Published surf session'], packingList: ['Wetsuit'], permits: [],
                sourceUrl: 'https://wknd.site/adventures/surf'
            }
        } })
        expect(JSON.stringify(result)).not.toContain(PRIVATE)
        expect(JSON.stringify(result)).not.toContain(SECRET)
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    })

    test('lists own summaries only and encodes an opaque cursor without adding an owner parameter', async () => {
        const cursor = 'page+/=&?'
        upstream({ bookings: [booking()], nextCursor: 'next-page' })
        const result = await handler({ cursor }, context())
        const url = new URL(global.fetch.mock.calls[0][0])
        expect(url.pathname).toBe('/api/bookings')
        expect([...url.searchParams]).toEqual([['cursor', cursor]])
        expect(result.structuredContent).toMatchObject({ mode: 'list', nextCursor: 'next-page', bookings: [{ id: ID }] })
        expect(Object.keys(result.structuredContent.bookings[0]).sort()).toEqual(['adventure', 'createdAt', 'demo', 'flight', 'id', 'status'])
        expect(JSON.stringify(result)).not.toContain(PRIVATE)
    })

    test('supports an empty first page with no cursor and a unique assertion for each call', async () => {
        upstream({ bookings: [], nextCursor: null })
        const extra = context()
        const result = await handler({}, extra)
        await handler({}, extra)
        expect(global.fetch.mock.calls[0][0]).toBe(`${API}/api/bookings`)
        expect(result.structuredContent).toEqual({ mode: 'list', bookings: [], nextCursor: null })
        const claims = global.fetch.mock.calls.map(([, options]) =>
            JSON.parse(Buffer.from(options.headers.Authorization.split('.')[1], 'base64url')))
        expect(claims[0].exp - claims[0].iat).toBe(60)
        expect(claims[0].jti).not.toBe(claims[1].jti)
    })

    test.each([
        ['no auth', (extra) => { delete extra.authInfo }],
        ['no subject', (extra) => { delete extra.authInfo.extra.sub }],
        ['empty subject', (extra) => { extra.authInfo.extra.sub = ' ' }],
        ['expired identity', (extra) => { extra.authInfo.expiresAt = 1 }],
        ['missing expiry', (extra) => { delete extra.authInfo.expiresAt }],
        ['wrong resource', (extra) => { extra.authInfo.resource = API }],
        ['wrong issuer', (extra) => { extra.authInfo.extra.iss = 'https://wrong.example/' }]
    ])('fails closed with 401 for %s even if UI auth is disabled', async (_, mutate) => {
        const extra = context()
        mutate(extra)
        const result = await handler({ booking_id: ID }, extra)
        expect(result).toMatchObject({ isError: true, structuredContent: { error: { status: 401 } } })
        expect(global.fetch).not.toHaveBeenCalled()
        expect(JSON.stringify(result)).not.toContain(PRIVATE)
    })

    test.each([undefined, [], ['profile'], 'bookings:read'])('requires an explicitly granted bookings:read scope: %p', async (scopes) => {
        const extra = context()
        extra.authInfo.scopes = scopes
        const result = await handler({}, extra)
        expect(result.structuredContent.error.status).toBe(403)
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test.each([undefined, '', 'short', 'é'.repeat(15)])('refuses missing or short secrets: %p', async (secret) => {
        const extra = context()
        extra.variables.WKND_BOOKING_ASSERTION_SECRET = secret
        const result = await handler({}, extra)
        expect(result.structuredContent.error).toMatchObject({ status: 503, code: 'booking_configuration_error' })
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('binds audience to a configured HTTPS origin and measures secret bytes, not characters', async () => {
        const extra = context()
        extra.variables = { WKND_BOOKING_API_BASE: 'https://bookings.example/', WKND_BOOKING_ASSERTION_SECRET: 'é'.repeat(16) }
        upstream({ bookings: [], nextCursor: null })
        await handler({}, extra)
        const [url, options] = global.fetch.mock.calls[0]
        const [header, claims, signature] = options.headers.Authorization.slice(7).split('.')
        expect(url).toBe('https://bookings.example/api/bookings')
        expect(JSON.parse(Buffer.from(claims, 'base64url')).aud).toBe('https://bookings.example')
        expect(signature).toBe(createHmac('sha256', extra.variables.WKND_BOOKING_ASSERTION_SECRET).update(`${header}.${claims}`).digest('base64url'))
    })

    test.each(['http://bookings.example', 'https://user:pass@bookings.example', 'https://bookings.example/api', 'https://bookings.example/?token=secret', 'not-a-url'])('refuses unsafe API configuration: %s', async (base) => {
        const extra = context()
        extra.variables.WKND_BOOKING_API_BASE = base
        const result = await handler({}, extra)
        expect(result.structuredContent.error.status).toBe(503)
        expect(global.fetch).not.toHaveBeenCalled()
        expect(JSON.stringify(result)).not.toContain(base)
    })

    test.each([
        { booking_id: '' }, { booking_id: '../other' }, { booking_id: 'BK_0123456789ABCDEF' },
        { booking_id: ID, cursor: 'next' }, { cursor: 123 }, { cursor: '' }, { cursor: '\n' },
        { cursor: 'x'.repeat(2049) }, { owner: PRIVATE }, { sub: PRIVATE }, null
    ])('rejects malformed inputs and ownership overrides: %p', async (args) => {
        const result = await handler(args, context())
        expect(result.structuredContent.error.status).toBe(400)
        expect(global.fetch).not.toHaveBeenCalled()
        expect(JSON.stringify(result)).not.toContain(PRIVATE)
    })

    test.each([
        [400, 400, 'booking_request_rejected'],
        [401, 401, 'booking_authentication_failed'],
        [403, 403, 'booking_forbidden'],
        [404, 404, 'booking_not_found'],
        [429, 502, 'booking_service_unavailable'],
        [500, 502, 'booking_service_unavailable'],
        [503, 502, 'booking_service_unavailable']
    ])('sanitizes upstream %s without reading the private error body', async (upstreamStatus, status, code) => {
        const response = upstream({ error: PRIVATE, token: SECRET }, upstreamStatus)
        const result = await handler({ booking_id: ID }, context())
        expect(result).toMatchObject({ isError: true, structuredContent: { error: { status, code } } })
        expect(response.json).not.toHaveBeenCalled()
        expect(JSON.stringify(result)).not.toContain(PRIVATE)
        expect(JSON.stringify(result)).not.toContain(SECRET)
    })

    test.each(['TimeoutError', 'AbortError', 'TypeError'])('does not leak network failures or fallback to mock bookings: %s', async (name) => {
        const failure = new Error(PRIVATE)
        failure.name = name
        global.fetch.mockRejectedValue(failure)
        const result = await handler({}, context())
        expect(result.isError).toBe(true)
        expect(result.structuredContent.error.status).toBe(name === 'TypeError' ? 502 : 504)
        expect(result.structuredContent.bookings).toBeUndefined()
        expect(JSON.stringify(result)).not.toContain(PRIVATE)
    })

    test.each([
        { id: 'BK_ffffffffffffffff' },
        { ...booking(), id: null }
    ])('rejects wrong or invalid details without surfacing the upstream data: %p', async (data) => {
        upstream(data)
        const result = await handler({ booking_id: ID }, context())
        expect(result.structuredContent.error.status).toBe(502)
    })

    test.each([
        { bookings: [], nextCursor: { token: PRIVATE } },
        { bookings: [null], nextCursor: null },
        { bookings: 'private', nextCursor: null }
    ])('rejects malformed lists: %p', async (data) => {
        upstream(data)
        const result = await handler({}, context())
        expect(result.structuredContent.error.status).toBe(502)
        expect(JSON.stringify(result)).not.toContain(PRIVATE)
    })

    test('keeps absent preparation unavailable and filters nested fields and non-HTTPS sources', async () => {
        const data = booking()
        data.preparation = { itinerary: [{ owner: PRIVATE }], permits: [null, ''], sourceUrl: 'javascript:alert(1)' }
        data.adventure.editorialUrl = 'https://user:password@example.com/'
        data.seats = ['1A', { contact: PRIVATE }]
        upstream(data)
        const result = await handler({ booking_id: ID }, context())
        expect(result.structuredContent.booking.preparation).toEqual({ itinerary: [], packingList: [], permits: [], sourceUrl: null })
        expect(result.structuredContent.booking.adventure.editorialUrl).toBeNull()
        expect(result.structuredContent.booking.seats).toEqual(['1A'])
        expect(JSON.stringify(result)).not.toContain(PRIVATE)
    })

    test('sanitizes a malformed JSON response', async () => {
        const response = upstream(null)
        response.json.mockRejectedValue(new Error(PRIVATE))
        const result = await handler({}, context())
        expect(result.structuredContent.error.status).toBe(502)
        expect(JSON.stringify(result)).not.toContain(PRIVATE)
    })
})
