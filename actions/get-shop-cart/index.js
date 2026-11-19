// The signed-in shopper's active WKND cart — the same cart the WKND website shows.
const {
  requireShopper, loadCart, failure, cartText, constants,
} = require('../lib/commerce.js');
const { withAnalytics } = require('../lib/analytics.js');

const handler = async (_args, extra) => {
  try {
    const shopper = requireShopper(extra);
    const { cart } = await loadCart(extra, shopper);
    return {
      content: [{ type: 'text', text: cartText(cart) }],
      structuredContent: { view: 'cart', cart, notice: constants.DEMO_NOTICE },
    };
  } catch (error) {
    return failure(error);
  }
};

module.exports = withAnalytics('get_shop_cart', handler);
