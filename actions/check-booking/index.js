const { createHmac, randomUUID } = require('node:crypto')

const MCP_RESOURCE = 'https://28538-wkndsherpa.adobeio-static.net/api/v1/web/llm-apps/mcp'
const IDENTITY_ISSUER = 'https://dev-g4kzp3zwgwzs8oha.us.auth0.com/'
const DEFAULT_API = 'https://wknd-aero-api.jaggah.workers.dev'
const BOOKING_ID = /^BK_[0-9a-f]{16}$/

function failure(status, code, message) {
    return {
        isError: true,
        content: [{ type: 'text', text: message }],
        structuredContent: { error: { status, code, message } }
    }
}

function text(value) {
    return typeof value === 'string' ? value.slice(0, 2000) : null
}

function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function validCursor(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 2048 && /^\P{Cc}+$/u.test(value)
}

function httpsUrl(value) {
    if (typeof value !== 'string') return null
    try {
        const url = new URL(value)
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
    } catch {
        return null
    }
}

function flight(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return {
        id: text(value.id),
        origin: text(value.origin),
        destination: text(value.destination),
        departTime: text(value.departTime),
        duration: text(value.duration) ?? number(value.duration),
        cabin: text(value.cabin),
        aircraft: text(value.aircraft),
        departureAt: text(value.departureAt),
        arrivalAt: text(value.arrivalAt),
        originTimeZone: text(value.originTimeZone),
        destinationTimeZone: text(value.destinationTimeZone)
    }
}

function adventure(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return {
        id: text(value.id),
        title: text(value.title),
        editorialUrl: httpsUrl(value.editorialUrl)
    }
}

function preparation(value) {
    // Empty or missing authored guidance is unknown, not confirmation that nothing is needed.
    const strings = (items) => Array.isArray(items)
        ? items.filter((item) => typeof item === 'string' && item.trim()).slice(0, 100).map(text)
        : []
    return {
        itinerary: strings(value?.itinerary),
        packingList: strings(value?.packingList),
        permits: strings(value?.permits),
        sourceUrl: httpsUrl(value?.sourceUrl)
    }
}

function projectBooking(value, details) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.id !== 'string' || !BOOKING_ID.test(value.id)) {
        throw new Error('Invalid booking response')
    }
    const booking = {
        id: value.id,
        status: text(value.status),
        demo: typeof value.demo === 'boolean' ? value.demo : null,
        createdAt: text(value.createdAt),
        flight: flight(value.flight),
        adventure: adventure(value.adventure)
    }
    if (details) Object.assign(booking, {
        updatedAt: text(value.updatedAt),
        flightId: text(value.flightId),
        seats: Array.isArray(value.seats) ? value.seats.filter((seat) => typeof seat === 'string').map(text) : [],
        passengerCount: number(value.passengerCount),
        total: number(value.total),
        currency: text(value.currency),
        preparation: preparation(value.preparation)
    })
    return booking
}

module.exports = async (args = {}, extra) => {
    const auth = extra?.authInfo
    const now = Math.floor(Date.now() / 1000)
    if (typeof auth?.extra?.sub !== 'string' || !auth.extra.sub.trim()
        || auth.resource !== MCP_RESOURCE
        || !Number.isSafeInteger(auth.expiresAt) || auth.expiresAt <= now
        || (auth.extra.iss !== undefined && auth.extra.iss !== IDENTITY_ISSUER)) {
        return failure(401, 'authentication_required', 'Sign in with a valid WKND account to view your bookings.')
    }
    if (!Array.isArray(auth.scopes) || !auth.scopes.includes('bookings:read')) {
        return failure(403, 'insufficient_scope', 'Booking access requires the bookings:read permission.')
    }

    if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some((key) => !['booking_id', 'cursor'].includes(key))) {
        return failure(400, 'invalid_arguments', 'Only booking_id and a list cursor are accepted; ownership comes from sign-in.')
    }
    const { booking_id: bookingId, cursor } = args
    if (bookingId !== undefined && (typeof bookingId !== 'string' || !BOOKING_ID.test(bookingId))) {
        return failure(400, 'invalid_booking_id', 'Use a booking ID in the form BK_ followed by 16 lowercase hexadecimal characters.')
    }
    if (cursor !== undefined && (bookingId !== undefined || !validCursor(cursor))) {
        return failure(400, 'invalid_cursor', 'Use a valid pagination cursor only when listing bookings.')
    }

    const variables = extra?.variables
    const secret = variables?.WKND_BOOKING_ASSERTION_SECRET
    if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
        return failure(503, 'booking_configuration_error', 'Booking access is not configured: a shared assertion secret of at least 32 bytes is required.')
    }
    let base
    try {
        base = new URL(variables?.WKND_BOOKING_API_BASE ?? DEFAULT_API)
        if (base.protocol !== 'https:' || base.username || base.password
            || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid API origin')
    } catch {
        return failure(503, 'booking_configuration_error', 'Booking access is not configured: WKND_BOOKING_API_BASE must be an HTTPS origin.')
    }

    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const payload = {
        iss: MCP_RESOURCE,
        aud: base.origin,
        sub: auth.extra.sub,
        identity_issuer: IDENTITY_ISSUER,
        scope: 'bookings:read',
        iat: now,
        exp: Math.min(now + 60, auth.expiresAt),
        jti: randomUUID()
    }
    const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`
    const signature = createHmac('sha256', secret).update(unsigned).digest('base64url')
    const url = new URL(bookingId ? `/api/bookings/${bookingId}` : '/api/bookings', base)
    if (cursor !== undefined) url.searchParams.set('cursor', cursor)

    try {
        const response = await fetch(url.href, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${unsigned}.${signature}`,
                'X-WKND-Delegation': 'mcp',
                Accept: 'application/json',
                'Cache-Control': 'no-store'
            },
            cache: 'no-store',
            redirect: 'error',
            signal: AbortSignal.timeout(8000)
        })
        if (!response.ok) {
            if (response.status === 401) return failure(401, 'booking_authentication_failed', 'Booking authentication failed. Sign in again; if this persists, the service configuration needs attention.')
            if (response.status === 403) return failure(403, 'booking_forbidden', 'You do not have permission to view these bookings.')
            if (response.status === 404) return failure(404, 'booking_not_found', 'Booking not found or not available to your account.')
            if (response.status === 400) return failure(400, 'booking_request_rejected', 'The booking service rejected this request. Check the booking ID or refresh the list.')
            return failure(502, 'booking_service_unavailable', 'The booking service is unavailable. Please try again later.')
        }
        const data = await response.json()
        let structuredContent
        if (bookingId) {
            if (data?.id !== bookingId) throw new Error('Unexpected booking')
            structuredContent = { mode: 'details', booking: projectBooking(data, true) }
        } else {
            if (!Array.isArray(data?.bookings) || data.bookings.length > 100
                || !(data.nextCursor === null || validCursor(data.nextCursor))) {
                throw new Error('Invalid booking list')
            }
            structuredContent = {
                mode: 'list',
                bookings: data.bookings.map((booking) => projectBooking(booking, false)),
                nextCursor: data.nextCursor
            }
        }
        // Text-only hosts need the same safe fields, not a raw upstream response.
        return {
            content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
            structuredContent
        }
    } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            return failure(504, 'booking_timeout', 'The booking service timed out. Please try again.')
        }
        return failure(502, 'booking_service_unavailable', 'Booking information is unavailable. Please try again later.')
    }
}
