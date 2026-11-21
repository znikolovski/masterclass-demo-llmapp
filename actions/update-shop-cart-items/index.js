// Change the quantity of (or remove, with quantity 0) one line in the signed-in shopper's WKND
// cart. Flat arguments (line_id, quantity, cart_version): the LLM Apps UI has no array type.
// Quantities are absolute, so repeating the same update is safe.
const {
  requireShopper, loadCart, assertVersion, graphql, normalizeCart, failure, ShopError, cartText,
  text, queries, constants, sanitizeOutput,
} = require('../lib/commerce.js');
const { withAnalytics } = require('../lib/analytics.js');

const VERSION = /^[0-9a-f]{16}$/;
const MAX_QTY = 20;

const handler = async (args = {}, extra) => {
  try {
    const shopper = requireShopper(extra);
    const lineId = text(args?.line_id, 200);
    const quantity = Number(args?.quantity);
    if (!lineId) throw new ShopError(400, 'invalid_line', 'Provide the line_id of a line in the current cart.');
    if (args?.quantity === undefined || args?.quantity === null || args?.quantity === ''
      || !Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QTY) {
      throw new ShopError(400, 'invalid_quantity', `Quantity must be a whole number from 0 to ${MAX_QTY} (0 removes the line).`);
    }
    const parsed = [{ cart_item_uid: lineId, quantity }];
    if (args.cart_version !== undefined && !VERSION.test(String(args.cart_version))) {
      throw new ShopError(400, 'invalid_cart_version', 'cart_version must come from the latest cart.');
    }

    const { id, cart: before } = await loadCart(extra, shopper);
    assertVersion(before, args.cart_version);
    const known = new Set(before.lines.map((l) => l.line_id));
    const unknown = parsed.filter((p) => !known.has(p.cart_item_uid));
    if (unknown.length) {
      throw new ShopError(404, 'line_not_found', 'That item is no longer in your cart. Review the updated cart.', { cart: before });
    }

    const { data, errors } = await graphql(extra, queries.UPDATE_MUTATION, {
      input: { cart_id: id, cart_items: parsed },
    }, { shopper });
    const result = data.updateCartItems;
    if (!result?.cart) {
      throw new ShopError(400, 'shop_request_rejected', text(errors[0]?.message, 300) || 'The shop could not update your cart.');
    }
    const cart = normalizeCart(result.cart);
    const problems = (result.errors || []).map((e) => text(e.message, 300)).filter(Boolean);
    const note = problems.length ? `Cart updated with adjustments: ${problems.join(' ')}` : (quantity === 0 ? 'Removed from your cart.' : 'Cart updated.');
    return sanitizeOutput({
      content: [{ type: 'text', text: `${note}\n${cartText(cart)}` }],
      structuredContent: {
        view: 'cart', cart, message: note, warnings: problems, notice: constants.DEMO_NOTICE,
      },
    });
  } catch (error) {
    return failure(error);
  }
};

module.exports = withAnalytics('update_shop_cart_items', handler);
