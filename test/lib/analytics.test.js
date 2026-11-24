const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {
  withAnalytics, sendMcpAnalyticsEvent, disableCustomerEdgeEvents,
} = require('../../actions/lib/analytics.js');

describe('optional customer telemetry', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unexpected network'));
  });
  afterEach(() => fetchSpy.mockRestore());

  test.each([
    undefined,
    {
      authInfo: { token: 'MCP_TOKEN', scopes: ['shop:cart'], extra: { sub: 'auth0|private' } },
      _meta: { 'openai/session': 'HOST_PRIVATE', consent: 'granted' },
      __ow_headers: { 'x-consent': 'granted' },
      variables: { WKND_ANALYTICS_DATASTREAM_ID: 'configured-datastream' },
    },
  ])('configuration and caller identity are not collection grants', async (extra) => {
    const output = { content: [{ type: 'text', text: 'cart' }], structuredContent: { total: 25 } };
    const handler = jest.fn().mockResolvedValue(output);
    await expect(withAnalytics('get_shop_cart', handler)({}, extra)).resolves.toBe(output);
    expect(handler).toHaveBeenCalledWith({}, extra);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('backdating and identity overrides cannot enable collection', async () => {
    await expect(sendMcpAnalyticsEvent({}, { toolName: 'x' }, {
      timestamp: '2026-01-01T00:00:00.000Z', ecid: 'fake-ecid', fetchEcid: true,
    })).resolves.toEqual({ sent: false, reason: 'collection-consent-unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('dry-run payload contains no synthetic pageview and is never sent', async () => {
    const outcome = await sendMcpAnalyticsEvent({}, {
      toolName: 'build_route_briefing', mcpMethod: 'build_route_briefing', status: 'ok',
    }, { dryRun: true });
    expect(outcome.body.event.xdm.eventType).toBe('mcp.tool_call');
    expect(outcome.body.event.xdm).not.toHaveProperty('web');
    expect(JSON.stringify(outcome.body)).not.toContain('pageViews');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('preserves thrown errors without telemetry', async () => {
    const error = new TypeError('tool failure');
    await expect(withAnalytics('x', async () => { throw error; })({})).rejects.toBe(error);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('opts every UI-generated action out of runtime automatic Edge collection', () => {
    const config = {
      actions: [
        { name: 'get_shop_cart', sendsEdgeEvent: true, requiresAuth: true },
        { name: 'discover_adventures', resource_meta: { ui: { domain: 'https://widget.example' } } },
      ],
    };
    disableCustomerEdgeEvents(config);
    expect(config.actions).toEqual([
      { name: 'get_shop_cart', sendsEdgeEvent: false, requiresAuth: true },
      { name: 'discover_adventures', sendsEdgeEvent: false, resource_meta: { ui: { domain: 'https://widget.example' } } },
    ]);
  });

  test('the actual bundle entry applies the opt-out before runtime registration, preserving auth', () => {
    const config = { actions: [{ name: 'get_shop_cart', requiresAuth: true, sendsEdgeEvent: true }] };
    const createMain = jest.fn(() => ({ main: 'registered' }));
    const entryRequire = (name) => {
      if (name === '@adobe/llm-apps-runtime') return { createMain };
      if (name === './actions.json') return config;
      if (name === './actions/lib/analytics.js') return { disableCustomerEdgeEvents };
      return require('../../actions/lib/resource-meta.js');
    };
    entryRequire.context = () => ({});
    const sandbox = { require: entryRequire, module: { exports: {} } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../entry.js'), 'utf8'), sandbox);
    expect(createMain).toHaveBeenCalledWith(expect.objectContaining({
      actionsConfig: { actions: [{ name: 'get_shop_cart', requiresAuth: true, sendsEdgeEvent: false }] },
    }));
    expect(sandbox.module.exports).toEqual({ main: 'registered' });
  });
});
