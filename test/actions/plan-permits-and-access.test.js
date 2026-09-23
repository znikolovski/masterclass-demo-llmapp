const handler = require('../../actions/plan-permits-and-access/index.js');

describe('plan_permits_and_access handler', () => {
    test('returns content block shape on happy path', async () => {
        const out = await handler({ adventure_id: 'patagonia-trek', travel_window: 'March' });
        expect(out).toHaveProperty('content');
        expect(Array.isArray(out.content)).toBe(true);
        expect(out.content[0]).toMatchObject({ type: 'text', text: expect.any(String) });
    });

    test('"Lay out every WKND permit for the W Circuit this March" resolves the route logistics', async () => {
        const out = await handler({ adventure_id: 'patagonia-trek', travel_window: 'March', origin: 'Denver' });
        expect(out.structuredContent.route_title).toBe('W Circuit: 9 Days, 115 km');
        expect(out.structuredContent.destination).toBe('Torres del Paine, Chile');
        expect(out.structuredContent.travel_window).toBe('March');
        expect(out.structuredContent.source_verification).toBe('Verified · February 2026');
        expect(out.content[0].text.length).toBeGreaterThan(0);
    });

    test('structuredContent is a plain object, not a bare array', async () => {
        const out = await handler({ adventure_id: 'patagonia-trek', travel_window: 'March' });
        expect(typeof out.structuredContent).toBe('object');
        expect(Array.isArray(out.structuredContent)).toBe(false);
    });

    test('structuredContent carries the documented logistics array fields', async () => {
        const out = await handler({ adventure_id: 'patagonia-trek', travel_window: 'March' });
        const sc = out.structuredContent;
        expect(Array.isArray(sc.permit_requirements)).toBe(true);
        expect(Array.isArray(sc.preparation_steps)).toBe(true);
        expect(Array.isArray(sc.transport_and_trailhead)).toBe(true);
        expect(Array.isArray(sc.seasonal_access)).toBe(true);
        expect(Array.isArray(sc.official_checks)).toBe(true);
    });

    test('resolves a route by partial title match', async () => {
        const out = await handler({ adventure_id: 'W Circuit', travel_window: 'March' });
        expect(out.structuredContent.adventure_id).toBe('patagonia-trek');
    });

    test('returns error message when adventure_id is missing', async () => {
        const out = await handler({ travel_window: 'March' });
        expect(out.content[0].text).toMatch(/adventure_id|provide/i);
    });

    test('returns error message when travel_window is missing', async () => {
        const out = await handler({ adventure_id: 'patagonia-trek' });
        expect(out.content[0].text).toMatch(/travel_window|provide/i);
    });

    test('unknown route returns a not-found message with the same key shape', async () => {
        const out = await handler({ adventure_id: 'nonexistent-route-xyz', travel_window: 'March' });
        expect(out.content[0].text).toMatch(/no wknd report|not found|no documented/i);
        expect(typeof out.structuredContent).toBe('object');
        expect(Array.isArray(out.structuredContent)).toBe(false);
        expect(out.structuredContent.route_title).toBeNull();
        expect(Array.isArray(out.structuredContent.preparation_steps)).toBe(true);
    });
});
