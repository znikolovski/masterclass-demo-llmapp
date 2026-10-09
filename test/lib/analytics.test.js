const {
  withAnalytics, sendMcpAnalyticsEvent, readAnalyticsConfig, ecidFromEdgeResponse,
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
      xdmTenant: `_${FALLBACK_XDM_TENANT}`,
    });
    expect(readAnalyticsConfig({ variables: {} })).toEqual({
      datastreamId: FALLBACK_DATASTREAM_ID,
      orgId: FALLBACK_ORG_ID,
      xdmTenant: `_${FALLBACK_XDM_TENANT}`,
    });
  });

  test('fills only the missing pieces from the fallback when partially set', () => {
    expect(readAnalyticsConfig({ variables: { WKND_ANALYTICS_DATASTREAM_ID: 'ds-123' } })).toEqual({
      datastreamId: 'ds-123',
      orgId: FALLBACK_ORG_ID,
      xdmTenant: `_${FALLBACK_XDM_TENANT}`,
    });
  });

  test('returns the config when fully set', () => {
    expect(readAnalyticsConfig(CONFIGURED_EXTRA)).toEqual({
      datastreamId: 'ds-123',
      orgId: '28260E2056581D3B7F000101@AdobeOrg',
      xdmTenant: '_wkndmcp',
    });
  });

  test('normalizes a prefixed tenant and rejects invalid tenant names', () => {
    expect(readAnalyticsConfig({ variables: { WKND_ANALYTICS_XDM_TENANT: '_wkndmcp' } }).xdmTenant).toBe('_wkndmcp');
    expect(readAnalyticsConfig({ variables: { WKND_ANALYTICS_XDM_TENANT: 'wknd-mcp' } })).toBeNull();
  });
});

describe('sendMcpAnalyticsEvent', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // TEMP: falls back to hardcoded config (see readAnalyticsConfig), so this
  // now sends under the fallback datastream rather than no-op'ing.
  test('still calls fetch when unconfigured, using the fallback datastream', async () => {
    await sendMcpAnalyticsEvent(undefined, { toolName: 'discover_adventures', mcpMethod: 'tools/call', status: 'ok' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(`https://edge.adobedc.net/ee/v2/interact?dataStreamId=${FALLBACK_DATASTREAM_ID}`);
    expect(JSON.parse(options.body).event.xdm._ags050.mcp.toolName).toBe('discover_adventures');
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
    expect(body.event.xdm._wkndmcp.mcp).toEqual({
      toolName: 'build_route_briefing',
      mcpMethod: 'tools/call',
      status: 'ok',
      organizationId: '28260E2056581D3B7F000101@AdobeOrg',
      durationMs: 42,
      inputSizeBytes: 100,
      outputSizeBytes: 200,
      userIntent: 'Plan a trip',
    });

    // Direct Analytics variable mapping at Adobe's documented data path —
    // processing rules. toolName is NOT re-keyed here; it maps to Page Name
    // via xdm.web.webPageDetails.name instead (asserted above).
    expect(body.event.data).toEqual({ __adobe: { analytics: {
      eVar10: 'tools/call',
      eVar12: 'ok',
      eVar14: '28260E2056581D3B7F000101@AdobeOrg',
      eVar15: 'Plan a trip',
      events: 'event22=42,event23=100,event24=200',
    } } });
  });

  test('includes errorClass on error status and omits it on success', async () => {
    await sendMcpAnalyticsEvent(CONFIGURED_EXTRA, {
      toolName: 'x', mcpMethod: 'tools/call', status: 'error', errorClass: 'TypeError', durationMs: 1, inputSize: 1, outputSize: 0,
    });
    const errBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(errBody.event.xdm._wkndmcp.mcp.errorClass).toBe('TypeError');
    expect(errBody.event.xdm._wkndmcp.mcp.status).toBe('error');
    expect(errBody.event.data.__adobe.analytics.eVar13).toBe('TypeError');
    expect(errBody.event.data.__adobe.analytics.eVar12).toBe('error');
  });

  test('includes hostSession as both a plain field and MCPHOSTUSER identity, absent otherwise', async () => {
    await sendMcpAnalyticsEvent(
      { ...CONFIGURED_EXTRA, _meta: { 'openai/session': 'sess-abc' } },
      { toolName: 'x', mcpMethod: 'tools/call', status: 'ok', durationMs: 1, inputSize: 1, outputSize: 1 },
    );
    const withSession = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(withSession.event.xdm._wkndmcp.mcp.hostSession).toBe('sess-abc');
    expect(withSession.event.xdm.identityMap).toEqual({
      MCPHOSTUSER: [{ id: 'sess-abc', authenticatedState: 'ambiguous', primary: true }],
    });
    expect(withSession.event.data.__adobe.analytics.eVar11).toBe('sess-abc');

    await sendMcpAnalyticsEvent(CONFIGURED_EXTRA, { toolName: 'x', mcpMethod: 'tools/call', status: 'ok', durationMs: 1, inputSize: 1, outputSize: 1 });
    const withoutSession = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(withoutSession.event.xdm._wkndmcp.mcp.hostSession).toBeUndefined();
    expect(withoutSession.event.xdm.identityMap).toBeUndefined();
    expect(withoutSession.event.data.__adobe.analytics.eVar11).toBeUndefined();
  });

  test('never throws when the request fails', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    await expect(sendMcpAnalyticsEvent(CONFIGURED_EXTRA, { toolName: 'x', mcpMethod: 'tools/call', status: 'ok' })).resolves.toMatchObject({ sent: false, error: 'network down' });
  });

  test('applies backfill timestamp and ECID, and returns the Edge ECID', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ handle: [{ type: 'identity:result', payload: [{ id: 'ecid-new', namespace: { code: 'ECID' } }] }] }),
    });
    const extra = { ...CONFIGURED_EXTRA, _meta: { 'openai/session': 'sess-1' } };
    const outcome = await sendMcpAnalyticsEvent(extra, { toolName: 'x', mcpMethod: 'tools/call', status: 'ok' }, {
      timestamp: '2026-01-02T03:04:05.000Z', ecid: 'ecid-old', fetchEcid: true,
    });
    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const { xdm } = sentBody.event;
    expect(sentBody.query).toEqual({ identity: { fetch: ['ECID'] } });
    expect(xdm.timestamp).toBe('2026-01-02T03:04:05.000Z');
    expect(xdm.identityMap.ECID[0]).toMatchObject({ id: 'ecid-old', primary: true });
    expect(xdm.identityMap.MCPHOSTUSER[0]).toMatchObject({ id: 'sess-1', primary: false });
    expect(outcome).toMatchObject({ sent: true, status: 200, ecid: 'ecid-new' });
  });

  test('dry run builds the payload without sending', async () => {
    const outcome = await sendMcpAnalyticsEvent(CONFIGURED_EXTRA, { toolName: 'x', mcpMethod: 'tools/call', status: 'ok' }, { dryRun: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcome.body.event.data.__adobe.analytics.eVar12).toBe('ok');
  });
});

describe('ecidFromEdgeResponse', () => {
  test('ignores non-ECID identities and missing handles', () => {
    expect(ecidFromEdgeResponse(null)).toBeUndefined();
    expect(ecidFromEdgeResponse({ handle: [{ type: 'identity:result', payload: [{ id: 'x', namespace: { code: 'CORE' } }] }] })).toBeUndefined();
  });
});

describe('withAnalytics', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
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
    const rawBody = fetchSpy.mock.calls[0][1].body;
    const body = JSON.parse(rawBody);
    expect(rawBody).not.toContain('hiking');
    expect(body.event.xdm._wkndmcp.mcp.status).toBe('ok');
    expect(body.event.xdm._wkndmcp.mcp.toolName).toBe('discover_adventures');
    expect(body.event.xdm._wkndmcp.mcp.mcpMethod).toBe('discover_adventures');
    expect(body.event.data.__adobe.analytics.eVar10).toBe('discover_adventures');
  });

  test('reports status=error and rethrows on handler failure, without swallowing the error', async () => {
    const boom = new TypeError('boom');
    const handler = jest.fn(async () => { throw boom; });
    const wrapped = withAnalytics('x', handler);

    await expect(wrapped({}, CONFIGURED_EXTRA)).rejects.toThrow('boom');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.event.xdm._wkndmcp.mcp.status).toBe('error');
    expect(body.event.xdm._wkndmcp.mcp.errorClass).toBe('TypeError');
  });

  test('reads userIntent the runtime moved from args onto extra', async () => {
    const handler = jest.fn(async () => ({ content: [], structuredContent: {} }));
    const wrapped = withAnalytics('discover_adventures', handler);
    const extra = { ...CONFIGURED_EXTRA, [Symbol('userIntent')]: 'Find trekking in Ohrid' };

    await wrapped({ region: 'Ohrid' }, extra);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.event.xdm._wkndmcp.mcp.userIntent).toBe('Find trekking in Ohrid');
    expect(body.event.data.__adobe.analytics.eVar15).toBe('Find trekking in Ohrid');
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
