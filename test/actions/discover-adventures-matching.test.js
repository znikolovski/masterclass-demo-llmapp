// Live catalogue records are sparse: only title/description and a coarse activity.
jest.mock('../../actions/lib/wknd.js', () => ({
  loadAdventures: jest.fn(async () => [
    { adventure_id: 'ohrid-north-macedonia', title: 'Ohrid Adventure Travel Guide: Trekking, Kayaking & Balkan Culture', description: "Discover Ohrid, North Macedonia — where Byzantine history meets alpine trails and one of Europe's oldest lakes.", activity: 'General Outdoor', category: 'trekking, kayaking, photography', region: 'Europe', experience_level: 'Beginner to Intermediate' },
    { adventure_id: 'ohrid-city-of-thousand-churches', title: 'Ohrid: City of a Thousand Churches', description: 'A UNESCO World Heritage city beside one of the oldest lakes.', activity: 'General Outdoor', category: 'general-outdoor', region: 'Europe' },
    { adventure_id: 'patagonia-trek', title: 'W Circuit: 9 Days, 115 km', description: 'Torres del Paine.', activity: 'Hiking', category: 'trekking', region: 'Americas', experience_level: 'Advanced', landscape: 'Mountains', trip_length_days: 9 },
    { adventure_id: 'surfing-costa-rica', title: 'Pavones and Playa Negra', description: 'Costa Rica surf guide.', activity: 'Water', category: 'water', experience_level: 'Intermediate' },
  ]),
}));
jest.mock('../../actions/lib/analytics.js', () => ({ withAnalytics: (_name, handler) => handler }));

const handler = require('../../actions/discover-adventures/index.js');

const ids = (out) => out.structuredContent.adventures.map((a) => a.adventure_id);

describe('discover_adventures matching on sparse live records', () => {
  test('finds Ohrid for free-form host arguments', async () => {
    const out = await handler({
      activity: 'trekking',
      experience_level: 'all levels',
      landscape: 'mountains, lake, and national park',
      region: 'Ohrid, North Macedonia',
      pace: 'any',
      priority: 'trekking and scenic hiking adventures',
      trip_length_days: 3,
      intent: 'The user wants trekking adventure options in Ohrid.',
    });
    expect(ids(out)).toEqual(['ohrid-north-macedonia']);
  });

  test('treats trekking and hiking as the same activity', async () => {
    const out = await handler({ activity: 'trekking' });
    expect(ids(out)).toEqual(expect.arrayContaining(['patagonia-trek', 'ohrid-north-macedonia']));
    expect(ids(out)).not.toContain('surfing-costa-rica');
  });

  test('landscape ranks results but does not exclude them', async () => {
    const out = await handler({ activity: 'hiking', landscape: 'desert canyons' });
    expect(ids(out)).toHaveLength(2);
  });

  test('"any" activity and level with only a region returns that region', async () => {
    const out = await handler({ activity: 'any', experience_level: 'any', region: 'Ohrid' });
    expect(ids(out)).toEqual(expect.arrayContaining(['ohrid-north-macedonia', 'ohrid-city-of-thousand-churches']));
    expect(ids(out)).toHaveLength(2);
    expect(out.content[0].text).toMatch(/^Found 2 WKND adventures in Ohrid/);
  });

  test('region still excludes other destinations', async () => {
    const out = await handler({ activity: 'hiking', experience_level: 'advanced', region: 'Ohrid' });
    expect(ids(out)).not.toContain('patagonia-trek');
  });

  test('explicit category includes multi-category records, not generic outdoor records', async () => {
    const out = await handler({ category: 'trekking' });
    expect(ids(out)).toEqual(expect.arrayContaining(['patagonia-trek', 'ohrid-north-macedonia']));
    expect(ids(out)).toHaveLength(2);
  });

  test('Europe and beginner filters intersect and exclude unknown levels', async () => {
    const out = await handler({ region: 'Europe', experience_level: 'beginner' });
    expect(ids(out)).toEqual(['ohrid-north-macedonia']);
    expect(out.content[0].text).toContain('suitable for beginner travelers');
  });

  test('specific water activities do not return the whole water category', async () => {
    expect(ids(await handler({ activity: 'surfing' }))).toEqual(['surfing-costa-rica']);
    expect(ids(await handler({ activity: 'kayaking' }))).toEqual(['ohrid-north-macedonia']);
    expect(ids(await handler({ activity: 'swimming' }))).toEqual([]);
  });

  test('canonical water category spans distinct water activities', async () => {
    expect(ids(await handler({ category: 'water' })))
      .toEqual(expect.arrayContaining(['ohrid-north-macedonia', 'surfing-costa-rica']));
  });

  test('unsupported filters return an explicit empty result', async () => {
    expect(ids(await handler({ category: 'skydiving' }))).toEqual([]);
    expect(ids(await handler({ experience_level: 'expert' }))).toEqual([]);
  });
});
