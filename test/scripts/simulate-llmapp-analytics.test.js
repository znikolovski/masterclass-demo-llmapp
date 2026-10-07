const { parseArgs, createRng, buildSchedule } = require('../../scripts/simulate-llmapp-analytics.js');

const CATALOG = [
  { adventure_id: 'patagonia-trek', title: 'W Circuit', activity: 'Hiking' },
  { adventure_id: 'alpine-cycling', title: 'High Alps', activity: 'Cycling' },
];

describe('simulate-llmapp-analytics', () => {
  test('parses options and rejects unknown ones', () => {
    expect(parseArgs(['--days=3', '--dry-run', '--seed=9'])).toMatchObject({ days: 3, dryRun: true, seed: 9 });
    expect(() => parseArgs(['--bogus'])).toThrow('Unknown');
  });

  test('builds a deterministic, chronological schedule inside the window', () => {
    const now = Date.UTC(2026, 9, 7, 12);
    const opts = { days: 7, sessionsPerDay: 10 };
    const a = buildSchedule(opts, createRng(1), CATALOG, now);
    const b = buildSchedule(opts, createRng(1), CATALOG, now);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(30);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i].startAt).toBeGreaterThanOrEqual(now - 7 * 864e5);
      expect(a[i].startAt).toBeLessThan(now);
      if (i) expect(a[i].startAt).toBeGreaterThanOrEqual(a[i - 1].startAt);
      expect(a[i].steps.length).toBeGreaterThan(0);
      if (a[i].hostSession) expect(a[i].hostSession).toMatch(/^sim-/);
    }
  });
});
