const { flightOffer } = require('../lib/aero-offer.js');
const {
  requireShopper, loadCart, graphql, ensureNoErrors, throwIfCartChanged, normalizeCart,
  failure, ShopError, cartText, formatMoney, sanitizeOutput, queries,
} = require('../lib/commerce.js');

module.exports = async (args = {}, extra) => {
  try {
    const shopper = requireShopper(extra);
    const { structuredContent: { offer } } = await flightOffer(args, extra);
    if (offer.status !== 'CLAIMED') {
      throw new ShopError(409, 'flight_offer_not_claimed', 'Claim an available flight-linked offer before adding its kit. No kit was added.');
    }
    const { id, cart: before, serverVersion } = await loadCart(extra, shopper);
    const complete = offer.components.every(({ sku, quantity }) => before.lines
      .filter((line) => line.sku === sku).reduce((sum, line) => sum + line.quantity, 0) >= quantity);
    let cart = before;
    if (!complete) {
      const decision = await graphql(extra, queries.BUNDLE_OFFERS_QUERY, { cartId: id }, { shopper });
      ensureNoErrors(decision.errors);
      if (!Array.isArray(decision.data.wkndBundleOffers)) {
        throw new ShopError(502, 'flight_kit_unavailable', 'Kit addition is unavailable. Review your cart and offer before retrying.');
      }
      const quote = decision.data.wkndBundleOffers.find((item) => item.promotion_id === offer.promotion_id
        && item.bundle_id === offer.bundle_id);
      if (!quote) {
        throw new ShopError(409, 'flight_kit_unavailable', 'This kit is not currently eligible for one-click completion. Check your offer, stock and existing discounts. No kit was added.');
      }
      if (!serverVersion || quote.cart_version !== serverVersion) {
        throw new ShopError(409, 'cart_changed', 'Your cart changed while checking this kit. Review the current cart and try again.');
      }
      const result = await graphql(extra, queries.COMPLETE_BUNDLE_MUTATION, {
        cartId: id, promotionId: offer.promotion_id, bundleId: offer.bundle_id, expected: serverVersion,
      }, { shopper });
      throwIfCartChanged(result.errors);
      ensureNoErrors(result.errors, 'The kit could not be added. Check your cart and offer before retrying.');
      if (!result.data.completeWkndBundle?.cart
        || result.data.completeWkndBundle.user_errors?.length) {
        throw new ShopError(502, 'flight_kit_unavailable', 'The kit addition could not be confirmed. Check your cart before retrying.');
      }
      cart = normalizeCart(result.data.completeWkndBundle.cart);
    }
    const message = complete
      ? 'Your cart already contains the complete kit. No duplicate gear was added.'
      : 'All missing kit products were added together. Review the current cart discounts before separate gear checkout. Your flight is unchanged.';
    const savings = cart.totals.discounts.length
      ? cart.totals.discounts.map((discount) => `${discount.label}: ${formatMoney(discount.amount)} saving`).join('\n')
      : 'Commerce has not applied a cart discount.';
    return sanitizeOutput({
      content: [{ type: 'text', text: `${message}\n${cartText(cart)}\n${savings}` }],
      structuredContent: { mode: 'flight-offer', view: 'cart', offer, cart, message },
    });
  } catch (error) {
    return failure(error);
  }
};
