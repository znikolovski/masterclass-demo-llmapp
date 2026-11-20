// The WKND shop lookup is mocked so these tests never depend on the live Commerce service.
jest.mock('../../actions/lib/commerce.js', () => ({
    ...jest.requireActual('../../actions/lib/commerce.js'),
    bestMatches: jest.fn(async (_extra, phrases) => phrases.map(() => null)),
}));

const { bestMatches } = require('../../actions/lib/commerce.js');
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

describe('build_gear_checklist WKND shop matches', () => {
    const product = (sku, name, type = 'simple') => ({
        sku, name, type, url: `https://wknd-adventures.run.place/shop/products/${sku.toLowerCase()}`,
        image: null, image_alt: name, in_stock: true, description: 'x', attributes: {}, options: [],
        price: { currency: 'AUD', min: 69, max: 69, regular: 69 },
    });

    test('matches sellable checklist items to WKND products in one lookup', async () => {
        bestMatches.mockImplementationOnce(async (_extra, phrases) => phrases.map((phrase) => {
            if (phrase === 'alpine start headlamp') return product('WKND-LGT-001', 'Alpine Start Headlamp 400');
            if (phrase === 'expedition 65 backpack') return product('WKND-PCK-003', 'Expedition 65 Backpack', 'configurable');
            return null;
        }));
        const out = await handler(VALID);
        expect(bestMatches).toHaveBeenLastCalledWith(undefined, expect.any(Array), { timeoutMs: 20000 });
        const phrases = bestMatches.mock.calls.at(-1)[1];
        expect(new Set(phrases).size).toBe(phrases.length);
        expect(phrases).toEqual(expect.arrayContaining(['expedition 65 backpack', 'merino 250 zip neck', 'alpine shell jacket']));
        expect(phrases).not.toContain(expect.stringMatching(/tent|stove/));
        expect(out.structuredContent.shop_status).toBe('ok');
        expect(out.structuredContent.shop_matches).toEqual([
            { group: 'essentials', item: '65–75L backpack with rain cover', product: expect.objectContaining({ sku: 'WKND-PCK-003', type: 'configurable' }) },
            { group: 'essentials', item: 'Headlamp + spare batteries', product: expect.objectContaining({ sku: 'WKND-LGT-001', price: expect.objectContaining({ min: 69 }) }) },
        ]);
        expect(out.structuredContent.shop_matches[0].product).not.toHaveProperty('description');
        expect(out.content[0].text).toMatch(/Headlamp \+ spare batteries → Alpine Start Headlamp 400 \[sku WKND-LGT-001\]/);
        expect(out.content[0].text).toMatch(/Expedition 65 Backpack \[sku WKND-PCK-003\] A\$69\.00 \(choose options\)/);
    });

    test('mild trips map to lighter gear', async () => {
        await handler({ activity: 'Hiking', terrain: 'trail', duration_days: 2, season: 'summer', conditions: 'mild and dry' });
        const phrases = bestMatches.mock.calls.at(-1)[1];
        expect(phrases).toEqual(expect.arrayContaining(['trek 45 backpack', 'merino 150 crew', 'torrent rain jacket']));
        expect(phrases).not.toContain('ridgeline down jacket');
    });

    test('the checklist still works when the shop is unavailable', async () => {
        bestMatches.mockRejectedValueOnce(new Error('down'));
        const out = await handler(VALID);
        expect(out.structuredContent.essentials.length).toBeGreaterThan(0);
        expect(out.structuredContent).toMatchObject({ shop_status: 'unavailable', shop_matches: [] });
        expect(out.content[0].text).toMatch(/could not be checked/);
    });

    test('no matches leaves the checklist unchanged', async () => {
        const out = await handler(VALID);
        expect(out.structuredContent).toMatchObject({ shop_status: 'none', shop_matches: [] });
        expect(out.content[0].text).not.toMatch(/WKND shop/);
    });
});
