// The signed-in shopper's active WKND cart — the same cart the WKND website shows — plus the
// welcome-back offer when Commerce says it is available and saves more than the current discount.
const {
  requireShopper, loadCart, loadOffer, offerText, hideProtectedCoupons, sanitizeOutput, failure, cartText, constants,
} = require('../lib/commerce.js');
const { withAnalytics } = require('../lib/analytics.js');

const handler = async (_args, extra) => {
  try {
    const shopper = requireShopper(extra);
    const {
      id, cart, appliedCoupons, reviewed,
    } = await loadCart(extra, shopper);
    const decision = cart.lines.length
      ? await loadOffer(extra, shopper, id, appliedCoupons, reviewed)
      : { code: null, offer: null };
    hideProtectedCoupons(cart, [decision.code]);
    const note = offerText(decision.offer);
    return sanitizeOutput({
      content: [{ type: 'text', text: note ? `${cartText(cart)}\n${note}` : cartText(cart) }],
      structuredContent: {
        view: 'cart', cart, offer: decision.offer, notice: constants.DEMO_NOTICE,
      },
    }, [decision.code]);
  } catch (error) {
    return failure(error);
  }
};

module.exports = withAnalytics('get_shop_cart', handler);
