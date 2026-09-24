const { withAnalytics, sendMcpAnalyticsEvent, readAnalyticsConfig } = require('../../actions/lib/analytics.js');

const CONFIGURED_EXTRA = {
  variables: {
    WKND_ANALYTICS_DATASTREAM_ID: 'ds-123',
    WKND_ANALYTICS_ORG_ID: '28260E2056581D3B7F000101@AdobeOrg',
    WKND_ANALYTICS_XDM_TENANT: 'wkndmcp',
  },
};

describe('readAnalyticsConfig', () => {
  test('returns null when unconfigured', () => {
    expect(readAnalyticsConfig(undefined)).toBeNull();
    expect(readAnalyticsConfig({ variables: {} })).toBeNull();
  });

  test('returns null when only some variables are set', () => {
    expect(readAnalyticsConfig({ variables: { WKND_ANALYTICS_DATASTREAM_ID: 'ds-123' } })).toBeNull();
  });

  test('returns the config when fully set', () => {
    expect(readAnalyticsConfig(CONFIGURED_EXTRA)).toEqual({
      datastreamId: 'ds-123',
      orgId: '28260E2056581D3B7F000101@AdobeOrg',
      xdmTenant: 'wkndmcp',
    });
  });
});

describe('sendMcpAnalyticsEvent', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test('does not call fetch when unconfigured', async () => {
    await sendMcpAnalyticsEvent(undefined, { toolName: 'discover_adventures', mcpMethod: 'tools/call', status: 'ok' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('posts the full field set to the Edge interact endpoint under the configured tenant', async () => {
    await sendMcpAnalyticsEvent(CONFIGURED_EXTRA, {
      toolName: 'build_route_briefing',
      mcpMethod: 'tools/call',
      status: 'ok',
      durationMs: 42,
      inputSize: 100,
      outputSize: 200,
      userIntent: 'Plan a trip',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://edge.adobedc.net/ee/v2/interact?configId=ds-123');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.event.xdm.eventType).toBe('mcp.tool_call');
    expect(body.event.xdm.web.webPageDetails.name).toBe('mcp:build_route_briefing');
    expect(body.event.xdm.web.webPageDetails.pageViews.value).toBe(1);
    expect(body.event.xdm.wkndmcp.mcp).toEqual({
      toolName: 'build_route_briefing',
      mcpMethod: 'tools/call',
      status: 'ok',
      organizationId: '28260E2056581D3B7F000101@AdobeOrg',
      durationMs: 42,
      inputSizeBytes: 100,
      outputSizeBytes: 200,
      userIntent: 'Plan a trip',
    });
  });

  test('includes errorClass on error status and omits it on success', async () => {
    await sendMcpAnalyticsEvent(CONFIGURED_EXTRA, {
      toolName: 'x', mcpMethod: 'tools/call', status: 'error', errorClass: 'TypeError', durationMs: 1, inputSize: 1, outputSize: 0,
    });
    const errBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(errBody.event.xdm.wkndmcp.mcp.errorClass).toBe('TypeError');
    expect(errBody.event.xdm.wkndmcp.mcp.status).toBe('error');
  });

  test('includes MCPHOSTUSER identity from openai/session, absent otherwise', async () => {
    await sendMcpAnalyticsEvent(
      { ...CONFIGURED_EXTRA, _meta: { 'openai/session': 'sess-abc' } },
      { toolName: 'x', mcpMethod: 'tools/call', status: 'ok', durationMs: 1, inputSize: 1, outputSize: 1 },
    );
    const withSession = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(withSession.event.xdm.identityMap).toEqual({
      MCPHOSTUSER: [{ id: 'sess-abc', authenticatedState: 'ambiguous', primary: true }],
    });

    await sendMcpAnalyticsEvent(CONFIGURED_EXTRA, { toolName: 'x', mcpMethod: 'tools/call', status: 'ok', durationMs: 1, inputSize: 1, outputSize: 1 });
    const withoutSession = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(withoutSession.event.xdm.identityMap).toBeUndefined();
  });

  test('never throws when the request fails', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    await expect(sendMcpAnalyticsEvent(CONFIGURED_EXTRA, { toolName: 'x', mcpMethod: 'tools/call', status: 'ok' })).resolves.toBeUndefined();
  });
});

describe('withAnalytics', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test('preserves the handler return value and calling contract', async () => {
    const handler = jest.fn(async (args, extra) => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { args, hasExtra: !!extra } }));
    const wrapped = withAnalytics('discover_adventures', handler);

    const out = await wrapped({ activity: 'hiking' }, CONFIGURED_EXTRA);
    expect(handler).toHaveBeenCalledWith({ activity: 'hiking' }, CONFIGURED_EXTRA);
    expect(out.structuredContent.hasExtra).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.event.xdm.wkndmcp.mcp.status).toBe('ok');
    expect(body.event.xdm.wkndmcp.mcp.toolName).toBe('discover_adventures');
  });

  test('reports status=error and rethrows on handler failure, without swallowing the error', async () => {
    const boom = new TypeError('boom');
    const handler = jest.fn(async () => { throw boom; });
    const wrapped = withAnalytics('x', handler);

    await expect(wrapped({}, CONFIGURED_EXTRA)).rejects.toThrow('boom');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.event.xdm.wkndmcp.mcp.status).toBe('error');
    expect(body.event.xdm.wkndmcp.mcp.errorClass).toBe('TypeError');
  });

  test('is a no-op analytics-wise when unconfigured, and still works with no extra at all', async () => {
    const handler = jest.fn(async () => ({ content: [], structuredContent: {} }));
    const wrapped = withAnalytics('x', handler);
    await expect(wrapped({ a: 1 })).resolves.toEqual({ content: [], structuredContent: {} });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
