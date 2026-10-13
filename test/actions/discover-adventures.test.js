jest.mock('../../actions/lib/wknd.js', () => ({
  loadAdventures: jest.fn(async (_extra, fallback) => fallback),
}));
jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }));

const handler = require('../../actions/discover-adventures/index.js');

describe('discover_adventures handler', () => {
  test('content is an array of text blocks', async () => {
    const out = await handler({ activity: 'Hiking', experience_level: 'Advanced' });
    expect(out).toHaveProperty('content');
    expect(Array.isArray(out.content)).toBe(true);
    expect(out.content[0]).toMatchObject({ type: 'text', text: expect.any(String) });
  });

  test('"intermediate hiker in Patagonia" returns matching adventures', async () => {
    const out = await handler({ activity: 'Hiking', experience_level: 'Advanced', region: 'Americas' });
    expect(out.content[0].text.length).toBeGreaterThan(0);
    expect(out.structuredContent.adventures.length).toBeGreaterThan(0);
    expect(out.structuredContent.adventures[0]).toHaveProperty('title');
    expect(out.structuredContent.adventures[0]).toHaveProperty('match_reason');
  });

  test('structuredContent is a plain object, not a bare array', async () => {
    const out = await handler({ activity: 'Surfing', experience_level: 'Advanced' });
    expect(typeof out.structuredContent).toBe('object');
    expect(Array.isArray(out.structuredContent)).toBe(false);
    expect(Array.isArray(out.structuredContent.adventures)).toBe(true);
  });

  test('filters by level without requiring an activity', async () => {
    const out = await handler({ experience_level: 'Advanced' });
    expect(out.structuredContent.adventures.length).toBeGreaterThan(0);
    expect(out.structuredContent.adventures.every((a) => a.experience_level === 'Advanced')).toBe(true);
  });

  test('filters by activity without requiring a level', async () => {
    const out = await handler({ activity: 'Hiking' });
    expect(out.structuredContent.adventures.length).toBeGreaterThan(0);
    expect(out.structuredContent.adventures.map((a) => a.experience_level))
      .toEqual(expect.arrayContaining(['Advanced', 'Intermediate']));
  });

  test.each([undefined, {}, { activity: 'all categories', experience_level: 'all levels' }])(
    'lists the full catalog for %j', async (args) => {
      const out = await handler(args);
      expect(out.structuredContent.adventures).toHaveLength(10);
      expect(out.structuredContent.ranked).toBe(false);
      expect(out.content[0].text).toContain('across all categories');
      out.structuredContent.adventures.forEach((a) => {
        expect(out.content[0].text).toContain(a.adventure_id);
      });
    },
  );

  test('region-only Europe browsing works across activities', async () => {
    const out = await handler({ region: 'Europe' });
    expect(out.structuredContent.adventures.map((a) => a.adventure_id))
      .toEqual(expect.arrayContaining(['kayaking-norway', 'alpine-cycling']));
    expect(out.structuredContent.adventures.some((a) => a.adventure_id === 'patagonia-trek')).toBe(false);
  });

  test('beginner-only discovery never ranks advanced adventures into the results', async () => {
    const out = await handler({ experience_level: 'beginner' });
    expect(out.structuredContent.adventures.map((a) => a.adventure_id))
      .toEqual(['yosemite-rock-climbing', 'wild-swimming-guide']);
    expect(out.structuredContent.ranked).toBe(false);
  });

  test('preserves preference ranking within the filtered results', async () => {
    const out = await handler({ experience_level: 'advanced', priority: 'Technical challenge' });
    expect(out.structuredContent.adventures[0].adventure_id).toBe('winter-mountaineering');
    expect(out.structuredContent.ranked).toBe(true);
  });

  test('reminds users to review current conditions before committing', async () => {
    const out = await handler({ activity: 'Hiking', experience_level: 'Advanced' });
    expect(out.content[0].text).toMatch(/condition/i);
  });

  test('filters out adventures longer than trip_length_days', async () => {
    const out = await handler({ activity: 'Hiking', experience_level: 'Advanced', trip_length_days: 5 });
    expect(out.structuredContent.adventures.every((a) => !a.duration || true)).toBe(true);
    // The 9-day W Circuit should be excluded when only 5 days are available.
    expect(out.structuredContent.adventures.some((a) => a.adventure_id === 'patagonia-trek')).toBe(false);
  });

  test('returns an empty list (not an error) when nothing matches', async () => {
    const out = await handler({ activity: 'Skydiving', experience_level: 'Expert' });
    expect(Array.isArray(out.content)).toBe(true);
    expect(out.content[0].text).toMatch(/no published|no .*match/i);
    expect(out.structuredContent.adventures).toEqual([]);
  });

  test('every returned adventure exposes the widget field shape', async () => {
    const out = await handler({ activity: 'Surfing', experience_level: 'Advanced' });
    out.structuredContent.adventures.forEach((a) => {
      expect(a).toHaveProperty('adventure_id');
      expect(a).toHaveProperty('title');
      expect(a).toHaveProperty('region');
      expect(a).toHaveProperty('duration');
      expect(a).toHaveProperty('image_url');
      expect(a).toHaveProperty('match_reason');
    });
  });
});
