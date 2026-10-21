const handler = require('../../actions/check-booking-auth/index.js')

const RESOURCE = 'https://28538-wkndsherpa.adobeio-static.net/api/v1/web/llm-apps/mcp'
const ISSUER = 'https://dev-g4kzp3zwgwzs8oha.us.auth0.com/'
const PRIVATE = 'private-subject-email-and-secret'

function token(claims = {}) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${encode({ alg: 'RS256' })}.${encode({
        iss: ISSUER, aud: RESOURCE, scope: 'bookings:read',
        exp: Math.floor(Date.now() / 1000) + 300,
        sub: PRIVATE, email: PRIVATE, nested: { secret: PRIVATE }, ...claims
    })}.synthetic-signature`
}

function context(value) {
    return { requestInfo: { headers: { authorization: `Bearer ${value}` } } }
}

test('reports compatible unverified claims without disclosing tokens, identities or other claims', async () => {
    const value = token()
    const result = await handler({}, context(value))
    expect(result.structuredContent).toMatchObject({
        diagnostic_only: true, claim_checks_are_not_verification: true,
        bearer_token_present: true, runtime_verified: false, runtime_has_booking_scope: null,
        token_source: 'request_header', token_format: 'jwt',
        issuer_matches: true, audience_matches: true, booking_scope_present: true,
        expiry_present: true, token_expired: false
    })
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    expect(JSON.stringify(result)).not.toContain(value)
    expect(JSON.stringify(result)).not.toContain(PRIVATE)
})

test('distinguishes a missing bearer header from unavailable request headers', async () => {
    const absent = await handler({}, { requestInfo: { headers: {} } })
    expect(absent.structuredContent).toMatchObject({
        request_headers_available: true, bearer_token_present: false, token_source: 'none'
    })
    const unknown = await handler({ authInfo: { token: token(), scopes: ['bookings:read'] } })
    expect(unknown.structuredContent).toMatchObject({
        request_headers_available: false, bearer_token_present: null,
        runtime_verified: false, token_source: 'unavailable', audience_matches: null
    })
})

test('uses verified runtime context when request headers are unavailable', async () => {
    const result = await handler({}, {
        authInfo: { token: token(), scopes: ['bookings:read'], resource: RESOURCE }
    })
    expect(result.structuredContent).toMatchObject({
        token_source: 'verified_runtime', runtime_verified: true,
        runtime_has_booking_scope: true, runtime_resource_matches: true
    })
})

test('reports wrong audience, issuer, scope and expiration without treating permissions as scopes', async () => {
    const result = await handler({}, context(token({
        iss: 'https://different.example/', aud: ['https://different.example/api'],
        scope: 'openid', permissions: ['bookings:read'], exp: 1
    })))
    expect(result.structuredContent).toMatchObject({
        issuer_matches: false, audience_matches: false, booking_scope_present: false,
        expiry_present: true, token_expired: true, runtime_verified: false
    })
    const alternative = await handler({}, context(token({
        scope: null, scp: ['bookings:read'], aud: [RESOURCE], exp: null
    })))
    expect(alternative.structuredContent).toMatchObject({
        audience_matches: true, booking_scope_present: true, expiry_present: false, token_expired: null
    })
})

test.each([
    ['opaque', 'opaque-token', 'opaque_or_invalid'],
    ['encrypted', 'part.part.part.part.part', 'encrypted_token'],
    ['missing claims', 'header.e30.signature', 'jwt'],
    ['invalid JSON', 'header.bm90LWpzb24.signature', 'invalid_jwt_payload'],
    ['array payload', 'header.W10.signature', 'invalid_jwt_payload'],
    ['oversized', 'x'.repeat(16385), 'too_large_to_inspect']
])('bounds and classifies %s tokens without returning them', async (_label, value, format) => {
    const result = await handler({}, context(value))
    expect(result.structuredContent.token_format).toBe(format)
    expect(result.structuredContent.runtime_verified).toBe(false)
    expect(JSON.stringify(result)).not.toContain(value)
})

test('does not guess about an unreadable authorization header', async () => {
    const result = await handler({}, { requestInfo: { headers: { authorization: ['Bearer one', 'Bearer two'] } } })
    expect(result.structuredContent).toMatchObject({
        authorization_header_readable: false, bearer_token_present: null, token_source: 'unavailable'
    })
})
