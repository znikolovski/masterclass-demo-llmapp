const { withAnalytics } = require('../../actions/lib/analytics.js');

describe('discovery journey handoff', () => {
  let spy;
  beforeEach(() => {
    spy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        handle: [{ type: 'identity:result', payload: [{ id: '12345678901234567890', namespace: { code: 'ECID' } }] }],
      }),
    });
  });
  afterEach(() => spy.mockRestore());

  test('retains private correlation without collecting or forwarding Edge identity', async () => {
    const handler = withAnalytics('discover_adventures', async () => ({
      structuredContent: { adventures: [{ adventure_id: 'patagonia-trek' }], intent: 'Synthetic intent' },
      _meta: { existing: true },
    }));
    const result = await handler({}, { _meta: { 'openai/session': 'HOST_PRIVATE' } });
    expect(spy).not.toHaveBeenCalled();
    expect(result._meta.wkndJourney.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result._meta.existing).toBe(true);
    expect(result._meta.wkndEdge).toBeUndefined();
    expect(JSON.stringify(result._meta)).not.toContain('HOST_PRIVATE');
    expect(JSON.stringify(result._meta.wkndJourney)).not.toContain('Synthetic intent');
  });

  test('does not create a successful discovery milestone for empty or failed results', async () => {
    const result = await withAnalytics('discover_adventures', async () => ({
      structuredContent: { adventures: [] },
    }))({});
    expect(result._meta).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  test('retains correlation but not fabricated identity when Edge fails', async () => {
    spy.mockResolvedValue({ ok: false, status: 503, text: async () => 'Unavailable' });
    const result = await withAnalytics('discover_adventures', async () => ({
      structuredContent: { adventures: [{}] },
    }))({});
    expect(result._meta.wkndJourney.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result._meta.wkndEdge).toBeUndefined();
  });
});
