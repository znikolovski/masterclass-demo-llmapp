// The signed-in shopper's active WKND cart — the same cart the WKND website shows — plus the
// welcome-back offer when Commerce says it is available and saves more than the current discount.
const {
  requireShopper, restorePersonBinding, loadCart, loadOffer, offerText, hideProtectedCoupons, sanitizeOutput, failure, cartText, constants,
} = require('../lib/commerce.js');
const { withAnalytics } = require('../lib/analytics.js');

const handler = async (_args, extra) => {
  try {
    const shopper = requireShopper(extra);
    const {
      id, cart, appliedCoupons, serverVersion,
    } = await loadCart(extra, shopper);
    const decision = cart.lines.length
      ? await loadOffer(extra, shopper, id, appliedCoupons, serverVersion)
      : { code: null, offer: null };
    hideProtectedCoupons(cart, [decision.code]);
    const note = offerText(decision.offer);
    const personBinding = await restorePersonBinding(extra);
    return sanitizeOutput({
      content: [{ type: 'text', text: note ? `${cartText(cart)}\n${note}` : cartText(cart) }],
      structuredContent: {
        view: 'cart', cart, offer: decision.offer, notice: constants.DEMO_NOTICE,
      },
      ...(personBinding ? { _meta: { wkndPersonBinding: personBinding } } : {}),
    }, [decision.code]);
  } catch (error) {
    return failure(error);
  }
};

module.exports = withAnalytics('get_shop_cart', handler);
