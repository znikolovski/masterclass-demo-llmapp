const handler = require('../../actions/build-gear-checklist/index.js');

const VALID = {
    adventure_id: 'patagonia-trek',
    activity: 'Hiking',
    terrain: 'alpine mountains',
    duration_days: 9,
    season: 'late March',
    conditions: 'cold, wet, windy',
    experience_level: 'Advanced',
    camping_style: 'wild camping',
};

describe('build_gear_checklist handler', () => {
    test('content is an array of text blocks', async () => {
        const out = await handler(VALID);
        expect(Array.isArray(out.content)).toBe(true);
        expect(out.content[0]).toMatchObject({ type: 'text', text: expect.any(String) });
    });

    test('"build me a WKND packing checklist for a 9-day Patagonian trek" happy path', async () => {
        const out = await handler(VALID);
        expect(out.content[0].text.length).toBeGreaterThan(0);
        expect(out.structuredContent.checklist_title).toEqual(expect.any(String));
        expect(out.structuredContent.essentials.length).toBeGreaterThan(0);
        expect(out.structuredContent.known_weight_grams).toBeGreaterThan(0);
    });

    test('structuredContent is a plain object, not a bare array', async () => {
        const out = await handler(VALID);
        expect(typeof out.structuredContent).toBe('object');
        expect(Array.isArray(out.structuredContent)).toBe(false);
    });

    test('returns error message when required args are missing', async () => {
        const out = await handler({});
        expect(out.content[0].text).toMatch(/activity|terrain|duration_days|season|provide/i);
    });

    test('missing-arg branch still returns the same structuredContent key shape', async () => {
        const out = await handler({});
        const keys = Object.keys(out.structuredContent).sort();
        const fullKeys = Object.keys((await handler(VALID)).structuredContent).sort();
        expect(keys).toEqual(fullKeys);
    });

    test('cold + wet conditions add waterproof and insulation layers', async () => {
        const out = await handler(VALID);
        const clothing = out.structuredContent.clothing.join(' ').toLowerCase();
        expect(clothing).toMatch(/waterproof/);
        expect(clothing).toMatch(/insulated|puffy/);
    });

    test('wild camping includes a shelter and sleep system', async () => {
        const out = await handler(VALID);
        expect(out.structuredContent.shelter_and_sleep.length).toBeGreaterThan(0);
        expect(out.structuredContent.shelter_and_sleep.join(' ').toLowerCase()).toMatch(/tent/);
    });

    test('unresolved conditions surface when experience level is omitted', async () => {
        const out = await handler({
            activity: 'Hiking',
            terrain: 'alpine',
            duration_days: 9,
            season: 'March',
            conditions: 'cold and wet',
        });
        expect(Array.isArray(out.structuredContent.unresolved_conditions)).toBe(true);
        expect(out.structuredContent.unresolved_conditions.length).toBeGreaterThan(0);
    });

    test('mild non-camping day trip omits tent and heavy insulation', async () => {
        const out = await handler({
            activity: 'Hiking',
            terrain: 'established trail',
            duration_days: 1,
            season: 'summer',
            conditions: 'mild and dry',
            camping_style: 'day trips',
        });
        expect(out.structuredContent.shelter_and_sleep.join(' ').toLowerCase()).not.toMatch(/tent/);
        expect(out.structuredContent.clothing.join(' ').toLowerCase()).not.toMatch(/puffy/);
    });
});
