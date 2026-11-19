// One WKND shop product: options with live stock, and the exact variant when options are given.
const {
  getProducts, refineProduct, resolveOptions, failure, ShopError, text, formatMoney,
} = require('../lib/commerce.js');
const { withAnalytics } = require('../lib/analytics.js');

const SKU = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

const handler = async (args = {}, extra) => {
  try {
    const sku = text(args.sku, 100);
    if (!SKU.test(sku)) throw new ShopError(400, 'invalid_sku', 'Provide the product SKU from a shop search result.');
    const [product] = await getProducts(extra, [sku]);
    if (!product) throw new ShopError(404, 'product_not_found', `No WKND product has SKU ${sku}.`);

    let variant = null;
    let selection = null;
    const selectedOptions = {};
    const options = args.options && typeof args.options === 'object' && !Array.isArray(args.options) ? args.options : null;
    if (options && product.type === 'configurable') {
      selection = resolveOptions(product, options);
      if (selection.invalid.length) {
        throw new ShopError(400, 'invalid_option', `Unknown option value — ${selection.invalid.join('; ')}.`);
      }
      product.options.forEach((o) => {
        const value = o.values.find((v) => selection.ids.includes(v.id));
        if (value) selectedOptions[o.id] = value.id;
      });
      if (selection.ids.length) {
        const refined = await refineProduct(extra, product.sku, selection.ids);
        if (refined && refined.type === 'simple') variant = refined;
      }
    }

    const p = variant || product;
    const price = p.price.min === null ? 'price unavailable' : formatMoney({ value: p.price.min, currency: p.price.currency });
    const lines = [
      `${product.name} [sku ${product.sku}]${p.url ? ` — ${p.url}` : ''}`,
      variant ? `Selected variant ${variant.sku}: ${price}, ${variant.in_stock ? 'in stock' : 'sold out'}.` : `From ${price}${product.in_stock ? '' : ' — sold out'}.`,
      product.description,
      ...product.options.map((o) => `${o.title}: ${o.values.map((v) => `${v.title}${v.in_stock ? '' : ' (sold out)'}`).join(', ')}`),
    ];
    if (selection?.missing.length) lines.push(`Still to choose: ${selection.missing.join(', ')}.`);
    return {
      content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }],
      structuredContent: {
        view: 'products',
        total: 1,
        products: [product],
        selected_variant: variant,
        selected_options: selectedOptions,
        missing_options: selection?.missing || [],
      },
    };
  } catch (error) {
    return failure(error);
  }
};

module.exports = withAnalytics('get_shop_product', handler);
