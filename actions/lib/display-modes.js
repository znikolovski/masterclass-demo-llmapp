/**
 * Display modes for widget resources that the runtime cannot declare.
 *
 * @adobe/llm-apps-runtime only forwards `inline`/`fullscreen` in a resource's
 * `_meta["openai/ui"].availableDisplayModes`, but ChatGPT offers picture-in-picture (`pip`) only
 * to widgets whose resource declares it. This adds the modes below to matching `resources/read`
 * results in the MCP response body (JSON, single or batch).
 */
const EXTRA_DISPLAY_MODES = {
  'ui://get-shop-cart/widget.html': ['inline', 'fullscreen', 'pip'],
};

function addModes(content) {
  const modes = content && EXTRA_DISPLAY_MODES[content.uri];
  if (!modes) return false;
  const meta = content._meta && typeof content._meta === 'object' ? content._meta : {};
  const ui = meta['openai/ui'] && typeof meta['openai/ui'] === 'object' ? meta['openai/ui'] : {};
  const current = Array.isArray(ui.availableDisplayModes) ? ui.availableDisplayModes : [];
  content._meta = { ...meta, 'openai/ui': { ...ui, availableDisplayModes: [...new Set([...current, ...modes])] } };
  return true;
}

/**
 * @param {string} body MCP JSON-RPC response body
 * @returns {string} body with extra display modes, or the original body when nothing matched
 */
function addDisplayModes(body) {
  if (typeof body !== 'string' || !body.includes('ui://')) return body;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  let changed = false;
  (Array.isArray(parsed) ? parsed : [parsed]).forEach((message) => {
    (message?.result?.contents || []).forEach((content) => {
      if (addModes(content)) changed = true;
    });
  });
  return changed ? JSON.stringify(parsed) : body;
}

/**
 * Wraps createMain()'s result ({ main, ... }) so widget resources declare the extra display modes.
 * @param {{ main: Function }} app
 */
function withDisplayModes(app) {
  const { main } = app;
  return {
    ...app,
    main: async function mainWithDisplayModes(params) {
      const response = await main(params);
      if (response && typeof response.body === 'string') {
        return { ...response, body: addDisplayModes(response.body) };
      }
      return response;
    },
  };
}

module.exports = { addDisplayModes, withDisplayModes, EXTRA_DISPLAY_MODES };
