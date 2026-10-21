const { createMain } = require('@adobe/llm-apps-runtime')
const { generateKeyPair, exportJWK, SignJWT } = require('jose')
const diagnostic = require('../actions/check-booking-auth/index.js')
const booking = require('../actions/check-booking/index.js')

const RESOURCE = 'https://28538-wkndsherpa.adobeio-static.net/api/v1/web/llm-apps/mcp'
const ISSUER = 'https://dev-g4kzp3zwgwzs8oha.us.auth0.com/'
let main
let privateKey

beforeAll(async () => {
    const pair = await generateKeyPair('RS256')
    privateKey = pair.privateKey
    const jwk = { ...await exportJWK(pair.publicKey), kid: 'diagnostic-test-key', alg: 'RS256' }
    const modules = {
        './check-booking-auth/index.js': diagnostic,
        './check-booking/index.js': booking
    }
    const moduleContext = key => modules[key]
    moduleContext.keys = () => Object.keys(modules)
    main = createMain({
        moduleContext,
        htmlContext: { keys: () => [] },
        actionsConfig: {
            auth: {
                enabled: true, issuer: ISSUER, resource: RESOURCE,
                jwksUri: `${ISSUER}.well-known/jwks.json`
            },
            actions: [
                { name: 'check-booking-auth', requiresAuth: false, inputSchema: { type: 'object', properties: {} } },
                { name: 'check-booking', requiresAuth: true, scopes: ['bookings:read'], inputSchema: { type: 'object', properties: {} } }
            ]
        },
        authFetchImpl: async () => Response.json({ keys: [jwk] })
    }).main
})

async function call(name, bearer) {
    const response = await main({
        __ow_method: 'post',
        __ow_body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name, arguments: {}, _meta: { 'openai/session': 'synthetic-test-session' } }
        }),
        __ow_headers: {
            'content-type': 'application/json', accept: 'application/json, text/event-stream',
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
        },
        MCP_SERVER_URL: RESOURCE,
        LOG_LEVEL: 'error'
    })
    expect(response.statusCode).toBe(200)
    return JSON.parse(response.body).result
}

async function token(claims = {}) {
    return new SignJWT({ scope: 'bookings:read', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'diagnostic-test-key' })
        .setIssuer(ISSUER).setAudience(RESOURCE).setSubject('synthetic-test-account')
        .setIssuedAt().setExpirationTime('5m').sign(privateKey)
}

test('diagnostic remains callable without auth while the real booking tool remains protected', async () => {
    const result = await call('check-booking-auth')
    expect(result.structuredContent).toMatchObject({
        request_headers_available: true, bearer_token_present: false, runtime_verified: false
    })
    expect(result._meta?.['mcp/www_authenticate']).toBeUndefined()
    const blocked = await call('check-booking')
    expect(blocked.isError).toBe(true)
    expect(blocked._meta['mcp/www_authenticate'][0]).toContain('invalid_token')
})

test('runtime supplies the actual bearer header and verified identity to the public diagnostic', async () => {
    const result = await call('check-booking-auth', await token())
    expect(result.structuredContent).toMatchObject({
        token_source: 'request_header', bearer_token_present: true, runtime_verified: true,
        runtime_has_booking_scope: true, issuer_matches: true, audience_matches: true
    })
    expect(JSON.stringify(result)).not.toContain('synthetic-test-account')
})

test('valid token with missing scope is diagnosed without bypassing the protected booking gate', async () => {
    const bearer = await token({ scope: 'openid' })
    const result = await call('check-booking-auth', bearer)
    expect(result.structuredContent).toMatchObject({
        runtime_verified: true, runtime_has_booking_scope: false, booking_scope_present: false
    })
    const blocked = await call('check-booking', bearer)
    expect(blocked._meta['mcp/www_authenticate'][0]).toContain('insufficient_scope')
})

test('unverified bearer remains visible for diagnosis but is not promoted to verified identity', async () => {
    const bearer = await new SignJWT({ scope: 'bookings:read' })
        .setProtectedHeader({ alg: 'RS256', kid: 'diagnostic-test-key' })
        .setIssuer(ISSUER).setAudience('https://wrong-resource.example/')
        .setIssuedAt().setExpirationTime('5m').sign(privateKey)
    const result = await call('check-booking-auth', bearer)
    expect(result.structuredContent).toMatchObject({
        bearer_token_present: true, runtime_verified: false, audience_matches: false
    })
    expect(result._meta?.['mcp/www_authenticate']).toBeUndefined()
})
