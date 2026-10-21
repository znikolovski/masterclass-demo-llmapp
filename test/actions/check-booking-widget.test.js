const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const html = fs.readFileSync(path.join(__dirname, '../../actions/check-booking/widget.html'), 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const ID = 'BK_0123456789abcdef'

// A small DOM/host boundary harness; no browser, remote scripts, or real credentials.
function mount(openai) {
    const elements = []
    class Element {
        constructor(tag) {
            this.tag = tag
            this.children = []
            this.events = {}
            this.attributes = {}
            this.textContent = ''
            this.value = ''
            elements.push(this)
        }
        append(...children) { this.children.push(...children) }
        replaceChildren(...children) { this.children = children }
        setAttribute(key, value) { this.attributes[key] = value }
        addEventListener(name, callback) { this.events[name] = callback }
        reportValidity() { return true }
    }
    const ids = Object.fromEntries(['results', 'status', 'booking-id', 'lookup', 'list'].map((id) => [id, new Element(id === 'list' ? 'button' : 'div')]))
    const listeners = {}
    const parent = { postMessage: jest.fn() }
    const window = { parent, openai, addEventListener: (name, callback) => { listeners[name] = callback } }
    const document = {
        createElement: (tag) => new Element(tag),
        getElementById: (id) => ids[id],
        querySelectorAll: (selector) => selector === 'button' ? elements.filter((element) => element.tag === 'button') : []
    }
    vm.runInNewContext(script, { document, window, URL, Intl, Date, Map, Number, String, Error, Promise, setTimeout, clearTimeout })
    const text = (element = ids.results) => [element.textContent, ...element.children.map((child) => text(child))].join(' ')
    const message = (data, source = parent, origin = 'https://host.example') => listeners.message({ data, source, origin })
    return { ids, elements, parent, listeners, message, text }
}

async function flush() {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

function details(flight = {}) {
    return {
        mode: 'details',
        booking: { id: ID, status: 'confirmed', demo: true, flight, seats: ['1A'], preparation: {} }
    }
}

describe('check-booking widget', () => {
    afterEach(() => { jest.useRealTimers() })

    test('renders demo details, missing schedules and unknown preparation without invented dates or approvals', async () => {
        const widget = mount({ toolOutput: details({ origin: 'LAX', destination: 'SFO', departTime: '09:30' }) })
        await flush()
        expect(widget.text()).toContain('Demo booking — not a ticket')
        expect(widget.text()).toContain('Scheduled date and time unavailable')
        expect(widget.text()).toContain('Published departure time (no date) 09:30')
        expect(widget.text()).toContain('Unavailable — requirements have not been confirmed')
        expect(widget.ids.results.attributes['aria-busy']).toBe('false')
        expect(widget.ids.status.textContent).toBe('Booking details loaded.')
    })

    test('formats real scheduled instants with time zones and safely renders authored guidance', async () => {
        const data = details({
            departureAt: '2026-10-21T16:30:00Z', originTimeZone: 'America/Los_Angeles',
            arrivalAt: '2026-10-21T18:00:00Z', destinationTimeZone: 'America/Los_Angeles'
        })
        data.booking.preparation = { itinerary: ['<script>not executed</script>'], packingList: ['Published item'], permits: ['Ask the operator'], sourceUrl: 'javascript:alert(1)' }
        const widget = mount({ toolOutput: data })
        await flush()
        expect(widget.text()).toContain('(America/Los_Angeles)')
        expect(widget.text()).not.toContain('Scheduled date and time unavailable')
        expect(widget.text()).toContain('<script>not executed</script>')
        expect(widget.text()).toContain('not confirmation of a reservation, permit approval')
        expect(widget.elements.filter((element) => element.tag === 'a')).toHaveLength(0)
    })

    test('uses the host bridge for details and paging without an owner or direct private fetch', async () => {
        const callTool = jest.fn().mockResolvedValue({ structuredContent: details() })
        const widget = mount({ toolOutput: { mode: 'list', bookings: [{ id: ID, flight: {} }], nextCursor: 'page-2' }, callTool })
        await flush()
        const view = widget.elements.find((element) => element.textContent === 'View details')
        view.events.click()
        await flush()
        expect(callTool).toHaveBeenCalledWith('check-booking', { booking_id: ID })
        expect(widget.ids.status.textContent).toBe('Booking details loaded.')
        widget.listeners['openai:set_globals']({ detail: { globals: { toolOutput: { mode: 'list', bookings: [], nextCursor: 'page-2' } } } })
        const next = widget.elements.filter((element) => element.textContent === 'Next page').pop()
        next.events.click()
        await flush()
        expect(callTool).toHaveBeenLastCalledWith('check-booking', { cursor: 'page-2' })
    })

    test('shows empty and error states, clearing earlier private details on failure', async () => {
        const callTool = jest.fn().mockResolvedValue({ isError: true, structuredContent: { error: { message: 'Booking not found or not available to your account.' } } })
        const widget = mount({ toolOutput: details(), callTool })
        await flush()
        widget.ids.list.events.click()
        await flush()
        expect(callTool).toHaveBeenCalledWith('check-booking', {})
        expect(widget.text()).not.toContain(ID)
        expect(widget.ids.status.textContent).toContain('Booking not found')
        widget.listeners['openai:set_globals']({ detail: { globals: { toolOutput: { mode: 'list', bookings: [], nextCursor: null } } } })
        expect(widget.ids.status.textContent).toBe('No bookings found for your account.')
    })

    test('initializes the native MCP Apps bridge and ignores messages outside the parent origin', async () => {
        jest.useFakeTimers()
        const widget = mount()
        const request = widget.parent.postMessage.mock.calls[0][0]
        expect(request).toMatchObject({ method: 'ui/initialize', params: { protocolVersion: '2026-01-26' } })
        widget.message({ jsonrpc: '2.0', id: request.id, result: {} })
        await flush()
        expect(widget.parent.postMessage).toHaveBeenLastCalledWith({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, 'https://host.example')
        widget.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: details() } }, {})
        expect(widget.text()).not.toContain(ID)
        widget.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: details() } }, widget.parent, 'https://other.example')
        expect(widget.text()).not.toContain(ID)
        widget.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: details() } })
        expect(widget.text()).toContain(ID)
        widget.ids.list.events.click()
        const call = widget.parent.postMessage.mock.calls.at(-1)[0]
        expect(call).toMatchObject({ method: 'tools/call', params: { name: 'check-booking', arguments: {} } })
        widget.message({ jsonrpc: '2.0', id: call.id, result: { structuredContent: { mode: 'list', bookings: [], nextCursor: null } } })
        await flush()
        expect(widget.ids.status.textContent).toBe('No bookings found for your account.')
        expect(jest.getTimerCount()).toBe(0)
    })

    test('reports bridge failure instead of staying in an infinite loading state', async () => {
        jest.useFakeTimers()
        const widget = mount()
        jest.advanceTimersByTime(15000)
        await flush()
        expect(widget.ids.status.textContent).toContain('Open this tool in an MCP Apps host')
        expect(widget.ids.results.attributes['aria-busy']).toBe('false')
        expect(jest.getTimerCount()).toBe(0)
    })
})
