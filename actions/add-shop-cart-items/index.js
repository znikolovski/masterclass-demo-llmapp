// Add one explicitly chosen product/variant to the signed-in shopper's WKND cart.
// Flat arguments (sku, quantity, options, cart_version): the LLM Apps UI has no array type.
const {
  requireShopper, loadCart, assertVersion, getProducts, resolveOptions, graphql, normalizeCart,
  failure, ShopError, cartText, text, queries, constants,
} = require('../lib/commerce.js');
const { withAnalytics } = require('../lib/analytics.js');

const SKU = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const VERSION = /^[0-9a-f]{16}$/;
const MAX_QTY = 20;

function parseItem(args) {
  const sku = text(args.sku, 100);
  const quantity = args.quantity === undefined || args.quantity === null ? 1 : Number(args.quantity);
  if (!SKU.test(sku)) throw new ShopError(400, 'invalid_sku', 'Provide the product SKU from a shop search result.');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
    throw new ShopError(400, 'invalid_quantity', `Quantity must be a whole number from 1 to ${MAX_QTY}.`);
  }
  const options = args.options && typeof args.options === 'object' && !Array.isArray(args.options) ? args.options : {};
  return { sku, quantity, options };
}

const handler = async (args = {}, extra) => {
  try {
    const shopper = requireShopper(extra);
    const items = [parseItem(args || {})];
    if (args.cart_version !== undefined && !VERSION.test(String(args.cart_version))) {
      throw new ShopError(400, 'invalid_cart_version', 'cart_version must come from the latest cart.');
    }

    const products = await getProducts(extra, [...new Set(items.map((i) => i.sku))]);
    const bySku = new Map(products.map((p) => [p.sku, p]));
    const cartItems = items.map((item) => {
      const product = bySku.get(item.sku);
      if (!product) throw new ShopError(404, 'product_not_found', `No WKND product has SKU ${item.sku}.`);
      if (product.type !== 'configurable') {
        if (!product.in_stock) throw new ShopError(409, 'sold_out', `${product.name} is sold out.`);
        return { sku: item.sku, quantity: item.quantity };
      }
      const selection = resolveOptions(product, item.options);
      if (selection.invalid.length) throw new ShopError(400, 'invalid_option', `${product.name}: ${selection.invalid.join('; ')}.`);
      if (selection.missing.length) {
        throw new ShopError(400, 'options_required', `Choose ${selection.missing.join(' and ')} for ${product.name} before adding it.`);
      }
      if (selection.unavailable.length) {
        throw new ShopError(409, 'sold_out', `${product.name} is sold out in ${selection.unavailable.join(', ')}.`);
      }
      return { sku: item.sku, quantity: item.quantity, selected_options: selection.ids };
    });

    const { id, cart: before } = await loadCart(extra, shopper);
    assertVersion(before, args.cart_version);
    const { data, errors } = await graphql(extra, queries.ADD_MUTATION, { cartId: id, items: cartItems }, { shopper });
    const result = data.addProductsToCart;
    if (!result?.cart) {
      throw new ShopError(400, 'shop_request_rejected', text(errors[0]?.message, 300) || 'The shop could not add those items.');
    }
    const cart = normalizeCart(result.cart);
    const problems = (result.user_errors || []).map((e) => text(e.message, 300)).filter(Boolean);
    if (problems.length) {
      return failure(new ShopError(409, 'not_added', `Not added: ${problems.join(' ')}`), { cart });
    }
    const note = `Added ${items[0].quantity} × ${products.find((p) => p.sku === items[0].sku)?.name || items[0].sku} to your WKND cart.`;
    return {
      content: [{ type: 'text', text: `${note}\n${cartText(cart)}` }],
      structuredContent: {
        view: 'cart', cart, message: note, warnings: [], notice: constants.DEMO_NOTICE,
      },
    };
  } catch (error) {
    return failure(error);
  }
};

module.exports = withAnalytics('add_shop_cart_items', handler);
