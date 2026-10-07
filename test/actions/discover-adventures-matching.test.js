// Live catalogue records are sparse: only title/description and a coarse activity.
jest.mock('../../actions/lib/wknd.js', () => ({
  loadAdventures: jest.fn(async () => [
    { adventure_id: 'ohrid-north-macedonia', title: 'Ohrid Adventure Travel Guide: Trekking, Kayaking & Balkan Culture', description: "Discover Ohrid, North Macedonia — where Byzantine history meets alpine trails and one of Europe's oldest lakes.", activity: 'Hiking' },
    { adventure_id: 'ohrid-city-of-thousand-churches', title: 'Ohrid: City of a Thousand Churches', description: 'A UNESCO World Heritage city beside one of the oldest lakes.', activity: 'Hiking' },
    { adventure_id: 'patagonia-trek', title: 'W Circuit: 9 Days, 115 km', description: 'Torres del Paine.', activity: 'Hiking', region: 'Americas', landscape: 'Mountains', trip_length_days: 9 },
    { adventure_id: 'surfing-costa-rica', title: 'Pavones and Playa Negra', description: 'Costa Rica surf guide.', activity: 'Water' },
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
    expect(ids(out)).toEqual(['ohrid-north-macedonia', 'ohrid-city-of-thousand-churches']);
    expect(out.content[0].text).toMatch(/any experience level/);
  });

  test('treats trekking and hiking as the same activity', async () => {
    const out = await handler({ activity: 'trekking', experience_level: 'beginner' });
    expect(ids(out)).toEqual(expect.arrayContaining(['patagonia-trek', 'ohrid-north-macedonia']));
    expect(ids(out)).not.toContain('surfing-costa-rica');
  });

  test('landscape ranks results but does not exclude them', async () => {
    const out = await handler({ activity: 'hiking', experience_level: 'advanced', landscape: 'desert canyons' });
    expect(ids(out)).toHaveLength(3);
  });

  test('"any" activity and level with only a region returns that region', async () => {
    const out = await handler({ activity: 'any', experience_level: 'any', region: 'Ohrid' });
    expect(ids(out)).toEqual(expect.arrayContaining(['ohrid-north-macedonia', 'ohrid-city-of-thousand-churches']));
    expect(ids(out)).toHaveLength(2);
    expect(out.content[0].text).toMatch(/^Found 2 WKND adventures suited to any experience level/);
  });

  test('region still excludes other destinations', async () => {
    const out = await handler({ activity: 'hiking', experience_level: 'advanced', region: 'Ohrid' });
    expect(ids(out)).not.toContain('patagonia-trek');
  });
});
