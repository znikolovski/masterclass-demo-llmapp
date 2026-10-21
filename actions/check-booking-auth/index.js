const ISSUER = 'https://dev-g4kzp3zwgwzs8oha.us.auth0.com/'
const RESOURCE = 'https://28538-wkndsherpa.adobeio-static.net/api/v1/web/llm-apps/mcp'
const SCOPE = 'bookings:read'

function inspectToken(token) {
    const checks = {
        token_format: token ? 'opaque_or_invalid' : 'unavailable',
        issuer_matches: null,
        audience_matches: null,
        booking_scope_present: null,
        expiry_present: null,
        token_expired: null
    }
    if (!token) return checks
    if (token.length > 16384) return { ...checks, token_format: 'too_large_to_inspect' }
    if (token.split('.').length === 5) return { ...checks, token_format: 'encrypted_token' }
    const jwt = token.match(/^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/)
    if (!jwt) return checks
    let claims
    try {
        claims = JSON.parse(Buffer.from(jwt[1], 'base64url').toString('utf8'))
    } catch {
        return { ...checks, token_format: 'invalid_jwt_payload' }
    }
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
        return { ...checks, token_format: 'invalid_jwt_payload' }
    }
    const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ')
        : (Array.isArray(claims.scp) ? claims.scp : [])
    const hasExpiry = typeof claims.exp === 'number' && Number.isFinite(claims.exp)
    return {
        token_format: 'jwt',
        issuer_matches: typeof claims.iss === 'string'
            && claims.iss.replace(/\/+$/, '') === ISSUER.replace(/\/+$/, ''),
        audience_matches: claims.aud === RESOURCE
            || (Array.isArray(claims.aud) && claims.aud.includes(RESOURCE)),
        booking_scope_present: scopes.includes(SCOPE),
        expiry_present: hasExpiry,
        token_expired: hasExpiry ? claims.exp <= Math.floor(Date.now() / 1000) : null
    }
}

module.exports = async (_args, extra) => {
    const headers = extra?.requestInfo?.headers
    const headersAvailable = !!headers && typeof headers === 'object' && !Array.isArray(headers)
    const header = headersAvailable
        ? Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
        : undefined
    const headerReadable = headersAvailable && (header === undefined || typeof header === 'string')
    const bearer = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i)?.[1] : undefined
    const auth = extra?.authInfo
    const verifiedToken = typeof auth?.token === 'string' && auth.token ? auth.token : undefined
    const token = bearer || verifiedToken

    // Decoded claim comparisons are diagnostics only, never proof of authentication.
    const diagnostics = {
        diagnostic_only: true,
        claim_checks_are_not_verification: true,
        request_headers_available: headersAvailable,
        authorization_header_readable: headerReadable,
        bearer_token_present: token ? true : (headerReadable ? false : null),
        token_source: bearer ? 'request_header'
            : (verifiedToken ? 'verified_runtime' : (headerReadable ? 'none' : 'unavailable')),
        runtime_verified: !!auth,
        runtime_has_booking_scope: auth ? Array.isArray(auth.scopes) && auth.scopes.includes(SCOPE) : null,
        runtime_resource_matches: auth ? auth.resource === RESOURCE : null,
        ...inspectToken(token)
    }
    return {
        content: [{ type: 'text', text: JSON.stringify(diagnostics) }],
        structuredContent: diagnostics
    }
}
