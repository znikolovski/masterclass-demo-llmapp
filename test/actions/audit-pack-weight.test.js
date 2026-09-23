const handler = require('../../actions/audit-pack-weight/index.js');

const validItems = [
  { name: '2-person tent', weight_grams: 2100 },
  { name: 'Sleeping bag', weight_grams: 900 },
  { name: 'Camp chair', weight_grams: 620 },
];

const validArgs = {
  items: validItems,
  adventure_id: 'patagonia-trek',
  activity: 'Hiking',
  duration_days: 9,
  season: 'February',
  conditions: 'Patagonian shoulder season',
  goal: 'reduce weight',
};

describe('audit_pack_weight handler', () => {
  test('content is an array of text blocks', async () => {
    const out = await handler(validArgs);
    expect(Array.isArray(out.content)).toBe(true);
    expect(out.content[0]).toMatchObject({ type: 'text', text: expect.any(String) });
  });

  test('"review my W Circuit packing list" returns an audit', async () => {
    const out = await handler(validArgs);
    expect(out.content[0].text.length).toBeGreaterThan(0);
    expect(out.structuredContent.estimated_savings_grams).toBeGreaterThan(0);
    expect(Array.isArray(out.structuredContent.category_breakdown)).toBe(true);
    expect(out.structuredContent.category_breakdown.length).toBeGreaterThan(0);
  });

  test('structuredContent is a plain object, not a bare array', async () => {
    const out = await handler(validArgs);
    expect(typeof out.structuredContent).toBe('object');
    expect(Array.isArray(out.structuredContent)).toBe(false);
  });

  test('keeps safety-critical items separate from recommended cuts', async () => {
    const out = await handler(validArgs);
    const { safety_critical_items, recommended_cuts } = out.structuredContent;
    expect(Array.isArray(safety_critical_items)).toBe(true);
    expect(Array.isArray(recommended_cuts)).toBe(true);
    const overlap = safety_critical_items.filter((s) => recommended_cuts.includes(s));
    expect(overlap).toHaveLength(0);
  });

  test('narrative content mentions the largest saving and safety guidance', async () => {
    const out = await handler(validArgs);
    expect(out.content[0].text).toMatch(/kg|saving/i);
    expect(out.content[0].text).toMatch(/safety/i);
  });

  test('returns error when items is missing', async () => {
    const out = await handler({ activity: 'Hiking', duration_days: 9 });
    expect(out.content[0].text).toMatch(/items|packing list|provide/i);
    expect(typeof out.structuredContent).toBe('object');
    expect(Array.isArray(out.structuredContent)).toBe(false);
  });

  test('returns error when activity is missing', async () => {
    const out = await handler({ items: validItems, duration_days: 9 });
    expect(out.content[0].text).toMatch(/activity|provide/i);
  });

  test('returns error when duration_days is missing or invalid', async () => {
    const out = await handler({ items: validItems, activity: 'Hiking' });
    expect(out.content[0].text).toMatch(/duration_days|provide/i);
    expect(out.structuredContent.estimated_savings_grams).toBeNull();
  });

  test('empty items array is treated as missing', async () => {
    const out = await handler({ items: [], activity: 'Hiking', duration_days: 9 });
    expect(out.content[0].text).toMatch(/items|packing list|provide/i);
  });

  test('error branch keeps the same structuredContent key shape as success', async () => {
    const ok = await handler(validArgs);
    const err = await handler({});
    expect(Object.keys(err.structuredContent).sort()).toEqual(Object.keys(ok.structuredContent).sort());
  });
});
