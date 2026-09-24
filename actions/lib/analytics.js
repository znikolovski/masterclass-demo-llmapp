/* global fetch, AbortController */
/*
 * Custom Adobe Edge analytics for MCP tool calls.
 *
 * The installed @adobe/llm-apps-runtime (v1.1.5 — also the latest published
 * version) sends its own automatic Edge event per tool call, but its XDM
 * (see wrapHandlerWithEdge/_buildEdgeXdm in node_modules/@adobe/llm-apps-
 * runtime/src/loader.js) omits status, error class, MCP method, duration,
 * and input/output size entirely — those fields exist in the runtime only
 * in a *separate* internal buffer (wrapHandlerWithAnalytics) that feeds
 * Adobe's own LLM Apps platform telemetry, not the customer's Edge
 * datastream. Neither pipeline exposes readEdgeConfig/createEdgeClient to
 * consumers (not part of the package's "exports" map), so this module
 * reimplements the small interact() call itself rather than deep-importing
 * package internals.
 *
 * This sends ONE full event per tool call carrying every field the wiki's
 * step-4 mapping expects. It is meant to fully REPLACE the runtime's own
 * automatic Edge event for a given action (set `sendsEdgeEvent: false` on
 * that action in actions.json) — sending both would double-count every
 * tool call as two Analytics hits (Adobe Analytics only counts a hit when
 * an event carries a page-view/link-click signal, and both events would
 * carry one).
 *
 * Trade-off versus the runtime's own event: this does not attempt to
 * replicate its per-host identity/locale extraction (hostOrganization,
 * hostLocale, hostUserLocation, ECID stitching) — only host_session is
 * read, and only for ChatGPT (`_meta['openai/session']`, the one key the
 * runtime documents; Claude exposes no session _meta yet, a host
 * limitation, not something fixable here).
 *
 * Configure via app variables (LLM Apps UI):
 *   WKND_ANALYTICS_DATASTREAM_ID — required; the datastream UUID
 *   WKND_ANALYTICS_ORG_ID        — required; IMS org (e.g. 28260E2056581D3B7F000101@AdobeOrg)
 *   WKND_ANALYTICS_XDM_TENANT    — required; tenant id owning the custom field group
 * Missing any of these disables sending entirely (fail-soft, never blocks a tool call).
 */

const FETCH_TIMEOUT_MS = 3000;
const EDGE_INTERACT_HOST = 'edge.adobedc.net';

function getVar(extra, name) {
  const v = extra && extra.variables && extra.variables[name];
  return (typeof v === 'string' && v.trim()) ? v.trim() : '';
}

/** @param {object} [extra] handler `extra` arg @returns {{datastreamId:string,orgId:string,xdmTenant:string}|null} */
function readAnalyticsConfig(extra) {
  const datastreamId = getVar(extra, 'WKND_ANALYTICS_DATASTREAM_ID');
  const orgId = getVar(extra, 'WKND_ANALYTICS_ORG_ID');
  const xdmTenant = getVar(extra, 'WKND_ANALYTICS_XDM_TENANT');
  if (!datastreamId || !orgId || !xdmTenant) return null;
  return { datastreamId, orgId, xdmTenant };
}

function safeSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return 0;
  }
}

// ChatGPT-only today — see module doc above.
function hostSessionFromExtra(extra) {
  const v = extra && extra._meta && extra._meta['openai/session'];
  return (typeof v === 'string' && v.trim()) ? v.trim() : undefined;
}

/**
 * Send one MCP tool-call event to Adobe Edge with the full field set.
 * Fails silently (never throws) so analytics can never break a tool call.
 * @param {object} [extra] handler `extra` arg (read for config + host session)
 * @param {object} fields
 * @param {string} fields.toolName
 * @param {string} fields.mcpMethod
 * @param {'ok'|'error'} fields.status
 * @param {string} [fields.errorClass]
 * @param {number} fields.durationMs
 * @param {number} fields.inputSize
 * @param {number} fields.outputSize
 * @param {string} [fields.userIntent]
 * @returns {Promise<void>}
 */
async function sendMcpAnalyticsEvent(extra, fields) {
  const cfg = readAnalyticsConfig(extra);
  if (!cfg) return;

  const {
    toolName, mcpMethod, status, errorClass, durationMs, inputSize, outputSize, userIntent,
  } = fields;

  const mcp = {
    toolName,
    mcpMethod,
    status,
    organizationId: cfg.orgId,
  };
  if (errorClass) mcp.errorClass = errorClass;
  if (Number.isFinite(durationMs)) mcp.durationMs = durationMs;
  if (Number.isFinite(inputSize)) mcp.inputSizeBytes = inputSize;
  if (Number.isFinite(outputSize)) mcp.outputSizeBytes = outputSize;
  if (userIntent) mcp.userIntent = userIntent;

  // A plain field, not just identityMap: identityMap drives identity stitching,
  // not Analytics dimensions — the session-ID eVar mapping needs a normal path.
  const hostSession = hostSessionFromExtra(extra);
  if (hostSession) mcp.hostSession = hostSession;

  const xdm = {
    eventType: 'mcp.tool_call',
    timestamp: new Date().toISOString(),
    // Required for Adobe Analytics to count this as a hit (Occurrences), not
    // just an AEP dataset row — see wrapHandlerWithEdge's own comment on the
    // same requirement for its automatic event.
    web: { webPageDetails: { name: `mcp:${toolName}`, pageViews: { value: 1 } } },
    [cfg.xdmTenant]: { mcp },
  };

  if (hostSession) {
    xdm.identityMap = { MCPHOSTUSER: [{ id: hostSession, authenticatedState: 'ambiguous', primary: true }] };
  }

  const url = `https://${EDGE_INTERACT_HOST}/ee/v2/interact?configId=${encodeURIComponent(cfg.datastreamId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { xdm } }),
      signal: controller.signal,
    });
  } catch {
    // fail-soft — analytics must never affect the tool call
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wrap an MCP action handler so every call reports full analytics to Adobe
 * Edge (status, error class, duration, sizes, method, user intent) —
 * preserves the handler's exact (args, extra) => result contract; sending
 * is awaited (bounded by FETCH_TIMEOUT_MS) so it isn't dropped by the
 * platform freezing the container right after the response is returned,
 * but never changes the returned value or a thrown error.
 * @param {string} toolName
 * @param {(args: object, extra?: object) => Promise<object>} handler
 * @returns {(args: object, extra?: object) => Promise<object>}
 */
function withAnalytics(toolName, handler) {
  return async (args, extra) => {
    const startedAt = Date.now();
    const inputSize = safeSize(args);
    const userIntent = args && typeof args === 'object' ? args.userIntent : undefined;
    try {
      const result = await handler(args, extra);
      await sendMcpAnalyticsEvent(extra, {
        toolName,
        mcpMethod: 'tools/call',
        status: 'ok',
        durationMs: Date.now() - startedAt,
        inputSize,
        outputSize: safeSize(result),
        userIntent,
      });
      return result;
    } catch (err) {
      const errorClass = (err && err.constructor && err.constructor.name) || 'Error';
      await sendMcpAnalyticsEvent(extra, {
        toolName,
        mcpMethod: 'tools/call',
        status: 'error',
        errorClass,
        durationMs: Date.now() - startedAt,
        inputSize,
        outputSize: 0,
        userIntent,
      });
      throw err;
    }
  };
}

module.exports = {
  withAnalytics, sendMcpAnalyticsEvent, readAnalyticsConfig,
};
