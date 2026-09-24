const {
  withAnalytics, sendMcpAnalyticsEvent, readAnalyticsConfig,
  FALLBACK_DATASTREAM_ID, FALLBACK_ORG_ID, FALLBACK_XDM_TENANT,
} = require('../../actions/lib/analytics.js');

const CONFIGURED_EXTRA = {
  variables: {
    WKND_ANALYTICS_DATASTREAM_ID: 'ds-123',
    WKND_ANALYTICS_ORG_ID: '28260E2056581D3B7F000101@AdobeOrg',
    WKND_ANALYTICS_XDM_TENANT: 'wkndmcp',
  },
};

describe('readAnalyticsConfig', () => {
  // TEMP: the LLM Apps UI has no way to add these variables yet, so an unset
  // variable falls back to a hardcoded value (see FALLBACK_* in analytics.js)
  // instead of disabling sending. Revert these two cases to "returns null"
  // once the UI supports variables and the fallback is removed.
  test('falls back to hardcoded values when unconfigured', () => {
    expect(readAnalyticsConfig(undefined)).toEqual({
      datastreamId: FALLBACK_DATASTREAM_ID,
      orgId: FALLBACK_ORG_ID,
      xdmTenant: FALLBACK_XDM_TENANT,
    });
    expect(readAnalyticsConfig({ variables: {} })).toEqual({
      datastreamId: FALLBACK_DATASTREAM_ID,
      orgId: FALLBACK_ORG_ID,
      xdmTenant: FALLBACK_XDM_TENANT,
    });
  });

  test('fills only the missing pieces from the fallback when partially set', () => {
    expect(readAnalyticsConfig({ variables: { WKND_ANALYTICS_DATASTREAM_ID: 'ds-123' } })).toEqual({
      datastreamId: 'ds-123',
      orgId: FALLBACK_ORG_ID,
      xdmTenant: FALLBACK_XDM_TENANT,
    });
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

  // TEMP: falls back to hardcoded config (see readAnalyticsConfig), so this
  // now sends under the fallback datastream rather than no-op'ing.
  test('still calls fetch when unconfigured, using the fallback datastream', async () => {
    await sendMcpAnalyticsEvent(undefined, { toolName: 'discover_adventures', mcpMethod: 'tools/call', status: 'ok' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`https://edge.adobedc.net/ee/v2/interact?dataStreamId=${FALLBACK_DATASTREAM_ID}`);
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
    expect(url).toBe('https://edge.adobedc.net/ee/v2/interact?dataStreamId=ds-123');
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

  test('includes hostSession as both a plain field and MCPHOSTUSER identity, absent otherwise', async () => {
    await sendMcpAnalyticsEvent(
      { ...CONFIGURED_EXTRA, _meta: { 'openai/session': 'sess-abc' } },
      { toolName: 'x', mcpMethod: 'tools/call', status: 'ok', durationMs: 1, inputSize: 1, outputSize: 1 },
    );
    const withSession = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(withSession.event.xdm.wkndmcp.mcp.hostSession).toBe('sess-abc');
    expect(withSession.event.xdm.identityMap).toEqual({
      MCPHOSTUSER: [{ id: 'sess-abc', authenticatedState: 'ambiguous', primary: true }],
    });

    await sendMcpAnalyticsEvent(CONFIGURED_EXTRA, { toolName: 'x', mcpMethod: 'tools/call', status: 'ok', durationMs: 1, inputSize: 1, outputSize: 1 });
    const withoutSession = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(withoutSession.event.xdm.wkndmcp.mcp.hostSession).toBeUndefined();
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

  // TEMP: falls back to hardcoded config when unconfigured (see readAnalyticsConfig),
  // so this now still sends rather than no-op'ing — the handler contract itself
  // (works fine with no `extra` at all) is what this test actually guards.
  test('still works with no extra at all, sending under the fallback config', async () => {
    const handler = jest.fn(async () => ({ content: [], structuredContent: {} }));
    const wrapped = withAnalytics('x', handler);
    await expect(wrapped({ a: 1 })).resolves.toEqual({ content: [], structuredContent: {} });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
