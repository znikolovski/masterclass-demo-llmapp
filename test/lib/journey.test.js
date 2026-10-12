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

  test('joins one server event to private widget metadata without exposing host IDs', async () => {
    const handler = withAnalytics('discover_adventures', async () => ({
      structuredContent: { adventures: [{ adventure_id: 'patagonia-trek' }], intent: 'Synthetic intent' },
      _meta: { existing: true },
    }));
    const result = await handler({}, { _meta: { 'openai/session': 'HOST_PRIVATE' } });
    const { event, query } = JSON.parse(spy.mock.calls[0][1].body);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(event.data.__adobe.analytics).toMatchObject({
      eVar30: result._meta.wkndJourney.id,
      eVar31: 'llm-app',
      eVar32: 'discover_adventures',
      eVar34: 'llmAppResult',
    });
    expect(event.data.__adobe.analytics.events.split(',')).toContain('event30');
    expect(query).toEqual({ identity: { fetch: ['ECID'] } });
    expect(result._meta.existing).toBe(true);
    expect(result._meta.wkndEdge.identityMap).toEqual({
      ECID: [{ id: '12345678901234567890', authenticatedState: 'ambiguous', primary: true }],
    });
    expect(JSON.stringify(result._meta)).not.toContain('HOST_PRIVATE');
    expect(JSON.stringify(result._meta.wkndJourney)).not.toContain('Synthetic intent');
  });

  test('does not create a successful discovery milestone for empty or failed results', async () => {
    const result = await withAnalytics('discover_adventures', async () => ({
      structuredContent: { adventures: [] },
    }))({});
    expect(result._meta).toBeUndefined();
    expect(JSON.parse(spy.mock.calls[0][1].body).event.data.__adobe.analytics.events).not.toContain('event30');
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
