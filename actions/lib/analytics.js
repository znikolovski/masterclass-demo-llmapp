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
 * Sends two sibling objects per Adobe's documented dual-path model (a `data`
 * object is NOT sent to the AEP dataset, only used for direct Analytics
 * variable mapping — see https://experienceleague.adobe.com/en/docs/analytics/implementation/aep-edge/data-var-mapping):
 *   xdm             — full mcp.* field set, lands in the AEP dataset via schema
 *   data.__adobe.analytics — same fields re-keyed to eVar10-15/event22-24,
 *                     read directly by Adobe Analytics with no processing
 *                     rules or context-data key matching involved. Confirmed
 *                     free slots in this report suite (2026-09-24):
 *                       eVar10 mcpMethod (action name) eVar13 errorClass
 *                       eVar11 hostSession eVar14 organizationId
 *                       eVar12 status      eVar15 userIntent
 *                       event22 durationMs event23 inputSizeBytes event24 outputSizeBytes
 *
 * Configure via app variables (LLM Apps UI):
 *   WKND_ANALYTICS_DATASTREAM_ID — required; the datastream UUID
 *   WKND_ANALYTICS_ORG_ID        — required; IMS org (e.g. 28260E2056581D3B7F000101@AdobeOrg)
 *   WKND_ANALYTICS_XDM_TENANT    — required; tenant id owning the custom field group
 *                                  (leading underscore is added when omitted)
 * Missing any of these disables sending entirely (fail-soft, never blocks a tool call).
 *
 * TEMPORARY: the LLM Apps UI currently has no way to add these variables for
 * this app, so the values are hardcoded below as a fallback until that's
 * available. None of the three are secret (datastream ID and IMS org ID are
 * already public in any client-side Web SDK network request), so this is a
 * maintainability shortcut, not a credential leak. Revert to variables-only
 * (delete the FALLBACK_* constants and the `||` below) once the UI supports it.
 */

const FETCH_TIMEOUT_MS = 3000;
const EDGE_INTERACT_HOST = 'edge.adobedc.net';

const FALLBACK_DATASTREAM_ID = '56dee4fc-21a9-4e37-83ab-bdd874957aba';
const FALLBACK_ORG_ID = '28260E2056581D3B7F000101@AdobeOrg';
const FALLBACK_XDM_TENANT = 'ags050';

function getVar(extra, name) {
  const v = extra && extra.variables && extra.variables[name];
  return (typeof v === 'string' && v.trim()) ? v.trim() : '';
}

/** @param {object} [extra] handler `extra` arg @returns {{datastreamId:string,orgId:string,xdmTenant:string}|null} */
function readAnalyticsConfig(extra) {
  const datastreamId = getVar(extra, 'WKND_ANALYTICS_DATASTREAM_ID') || FALLBACK_DATASTREAM_ID;
  const orgId = getVar(extra, 'WKND_ANALYTICS_ORG_ID') || FALLBACK_ORG_ID;
  const configuredTenant = getVar(extra, 'WKND_ANALYTICS_XDM_TENANT') || FALLBACK_XDM_TENANT;
  const xdmTenant = configuredTenant.startsWith('_') ? configuredTenant : `_${configuredTenant}`;
  if (!datastreamId || !orgId || !xdmTenant) return null;
  if (!/^_[A-Za-z][A-Za-z0-9_]*$/.test(xdmTenant)) return null;
  return { datastreamId, orgId, xdmTenant };
}

function safeSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return 0;
  }
}

// Caps a string to N utf8 bytes without splitting a multi-byte character —
// matches the runtime's own userIntent truncation (see USER_INTENT_EXTRA_KEY
// handling in loader.js) so an unusually long value can't get rejected by a
// schema field's max-length constraint.
function truncateUtf8Bytes(value, maxBytes) {
  if (typeof value !== 'string') return undefined;
  let bytes = Buffer.byteLength(value, 'utf8');
  let out = value;
  while (bytes > maxBytes) {
    out = out.slice(0, -1);
    bytes = Buffer.byteLength(out, 'utf8');
  }
  return out || undefined;
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
 * @param {object} [options] backfill/simulation overrides (unused by live tool calls)
 * @param {Date|string|number} [options.timestamp] event time; defaults to now
 * @param {string} [options.ecid] ECID returned by an earlier Edge call for the same visitor
 * @param {boolean} [options.dryRun] build the payload but do not send it
 * @param {boolean} [options.fetchEcid] ask Edge to return the visitor's ECID
 * @returns {Promise<{sent:boolean,status?:number,ecid?:string,error?:string,body?:object}|null>}
 */
async function sendMcpAnalyticsEvent(extra, fields, options = {}) {
  const cfg = readAnalyticsConfig(extra);
  if (!cfg) return null;

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
  const truncatedUserIntent = truncateUtf8Bytes(userIntent, 255);
  if (truncatedUserIntent) mcp.userIntent = truncatedUserIntent;

  // A plain field, not just identityMap: identityMap drives identity stitching,
  // not Analytics dimensions — the session-ID eVar mapping needs a normal path.
  const hostSession = hostSessionFromExtra(extra);
  if (hostSession) mcp.hostSession = hostSession;

  const xdm = {
    eventType: 'mcp.tool_call',
    timestamp: new Date(options.timestamp ?? Date.now()).toISOString(),
    // Required for Adobe Analytics to count this as a hit (Occurrences), not
    // just an AEP dataset row — see wrapHandlerWithEdge's own comment on the
    // same requirement for its automatic event.
    web: { webPageDetails: { name: `mcp:${toolName}`, pageViews: { value: 1 } } },
    [cfg.xdmTenant]: { mcp },
  };

  if (hostSession || options.ecid) {
    xdm.identityMap = {};
    if (options.ecid) xdm.identityMap.ECID = [{ id: options.ecid, authenticatedState: 'ambiguous', primary: true }];
    if (hostSession) {
      xdm.identityMap.MCPHOSTUSER = [{ id: hostSession, authenticatedState: 'ambiguous', primary: !options.ecid }];
    }
  }

  // Direct Analytics variable mapping (see module doc) — bypasses processing
  // rules entirely. Re-keys the same values already computed above for `mcp`.
  const analyticsVars = {
    eVar10: mcp.mcpMethod,
    eVar12: mcp.status,
    eVar14: mcp.organizationId,
  };
  if (mcp.hostSession) analyticsVars.eVar11 = mcp.hostSession;
  if (mcp.errorClass) analyticsVars.eVar13 = mcp.errorClass;
  if (mcp.userIntent) analyticsVars.eVar15 = mcp.userIntent;

  const eventPairs = [];
  if (Number.isFinite(mcp.durationMs)) eventPairs.push(`event22=${mcp.durationMs}`);
  if (Number.isFinite(mcp.inputSizeBytes)) eventPairs.push(`event23=${mcp.inputSizeBytes}`);
  if (Number.isFinite(mcp.outputSizeBytes)) eventPairs.push(`event24=${mcp.outputSizeBytes}`);
  if (eventPairs.length) analyticsVars.events = eventPairs.join(',');

  // Adobe's Analytics variable mapping contract reads these fields from this
  // exact path in the Edge event payload, including for direct interact calls.
  const data = { __adobe: { analytics: analyticsVars } };
  const body = { event: { xdm, data } };
  if (options.fetchEcid) body.query = { identity: { fetch: ['ECID'] } };
  if (options.dryRun) return { sent: false, body };

  const url = `https://${EDGE_INTERACT_HOST}/ee/v2/interact?dataStreamId=${encodeURIComponent(cfg.datastreamId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const quiet = Boolean(options.timestamp || options.ecid || options.fetchEcid);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '<unreadable body>');
      // TEMP DEBUG — remove once processing-rule mapping is confirmed working.
      if (!quiet) console.error('[analytics] edge interact rejected', response.status, errorBody);
      return {
        sent: false, status: response.status, error: errorBody, body,
      };
    }
    // TEMP DEBUG — remove once processing-rule mapping is confirmed working.
    if (!quiet) console.log('[analytics] edge interact accepted', response.status);
    const responseBody = typeof response.json === 'function' ? await response.json().catch(() => null) : null;
    return {
      sent: true, status: response.status, ecid: ecidFromEdgeResponse(responseBody) || options.ecid, body,
    };
  } catch (err) {
    // TEMP DEBUG — remove once processing-rule mapping is confirmed working.
    if (!quiet) console.error('[analytics] edge interact request failed', err && err.message);
    // fail-soft — analytics must never affect the tool call
    return { sent: false, error: (err && err.message) || 'request failed', body };
  } finally {
    clearTimeout(timer);
  }
}

function ecidFromEdgeResponse(responseBody) {
  const handles = (responseBody && responseBody.handle) || [];
  for (const handle of handles) {
    if (handle.type !== 'identity:result') continue;
    const match = (handle.payload || []).find((p) => p && p.namespace && p.namespace.code === 'ECID');
    if (match && match.id) return match.id;
  }
  return undefined;
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
  const wrapped = (args, extra) => invokeWithAnalytics(toolName, handler, args, extra);
  // Lets scripts/simulate-llmapp-analytics.js run the real handler with a backdated event.
  wrapped.toolName = toolName;
  wrapped.invokeWithAnalytics = (args, extra, options) => invokeWithAnalytics(toolName, handler, args, extra, options);
  return wrapped;
}

/**
 * When a tool's schema declares userIntent, the runtime strips it from args
 * before the handler runs and hands it over on `extra` under a private
 * Symbol('userIntent') (loader.js wrapHandlerStrippingUserIntent), so live
 * calls never see args.userIntent. Fall back to that Symbol by description.
 */
function userIntentFrom(args, extra) {
  if (args && typeof args === 'object' && args.userIntent !== undefined) return args.userIntent;
  if (!extra || typeof extra !== 'object') return undefined;
  const key = Object.getOwnPropertySymbols(extra).find((s) => s.description === 'userIntent');
  return key ? extra[key] : undefined;
}

/**
 * Run one handler call and report it. `options` is forwarded to
 * sendMcpAnalyticsEvent; `options.onAnalytics` receives its send result.
 */
async function invokeWithAnalytics(toolName, handler, args, extra, options = {}) {
  const { onAnalytics, ...sendOptions } = options;
  const report = async (fields) => {
    const outcome = await sendMcpAnalyticsEvent(extra, fields, sendOptions);
    if (onAnalytics) onAnalytics(outcome, fields);
  };
  const startedAt = Date.now();
  const inputSize = safeSize(args);
  const userIntent = userIntentFrom(args, extra);
  try {
    const result = await handler(args, extra);
    await report({
      toolName,
      mcpMethod: toolName,
      status: 'ok',
      durationMs: Date.now() - startedAt,
      inputSize,
      outputSize: safeSize(result),
      userIntent,
    });
    return result;
  } catch (err) {
    const errorClass = (err && err.constructor && err.constructor.name) || 'Error';
    await report({
      toolName,
      mcpMethod: toolName,
      status: 'error',
      errorClass,
      durationMs: Date.now() - startedAt,
      inputSize,
      outputSize: 0,
      userIntent,
    });
    throw err;
  }
}

module.exports = {
  withAnalytics,
  invokeWithAnalytics,
  sendMcpAnalyticsEvent,
  ecidFromEdgeResponse,
  readAnalyticsConfig,
  FALLBACK_DATASTREAM_ID,
  FALLBACK_ORG_ID,
  FALLBACK_XDM_TENANT,
};
