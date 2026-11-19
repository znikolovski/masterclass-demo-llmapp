/**
 * Widget resource metadata fixes applied to the UI-generated actions config before the runtime
 * registers widgets.
 *
 * `resource_meta.ui.domain` (or flat `resource_meta.domain`) asks the host for a dedicated widget
 * sandbox origin in a host-specific format; it is not the site that serves the widget. When it is
 * set to the EDS site itself (`*.aem.page` / `*.aem.live`), ChatGPT cannot render the widget and
 * the tool call surfaces as "timed out". The LLM Apps UI can keep re-emitting the value, so drop it.
 */
const EDS_HOST = /\.aem\.(page|live)$/i;

function isEdsOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    return EDS_HOST.test(new URL(value.includes('://') ? value : `https://${value}`).hostname);
  } catch {
    return false;
  }
}

/**
 * @param {object} actionsConfig parsed actions.json ({ actions: [...] })
 * @returns {string[]} names of actions whose widget domain was dropped
 */
function dropEdsWidgetDomains(actionsConfig) {
  const dropped = [];
  (actionsConfig?.actions || []).forEach((action) => {
    const meta = action?.resource_meta;
    if (!meta || typeof meta !== 'object') return;
    let changed = false;
    if (isEdsOrigin(meta.domain)) {
      delete meta.domain;
      changed = true;
    }
    if (meta.ui && typeof meta.ui === 'object' && isEdsOrigin(meta.ui.domain)) {
      delete meta.ui.domain;
      changed = true;
    }
    if (changed) dropped.push(action.name);
  });
  return dropped;
}

module.exports = { dropEdsWidgetDomains };
