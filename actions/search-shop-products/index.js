// Search the WKND Adventures shop (live Commerce catalog: GST-inclusive AUD prices and stock).
const {
  searchProducts, failure, ShopError, text, formatMoney,
} = require('../lib/commerce.js');
const { withAnalytics } = require('../lib/analytics.js');

// A category path ("apparel/jackets") or name ("Jackets", "Base & Mid Layers"); resolved to a path.
const CATEGORY = /^[a-z0-9][a-z0-9 &/-]*$/;

function priceText(p) {
  if (p.price.min === null) return 'price unavailable';
  const min = formatMoney({ value: p.price.min, currency: p.price.currency });
  return p.price.max !== null && p.price.max !== p.price.min
    ? `${min}–${formatMoney({ value: p.price.max, currency: p.price.currency })}` : min;
}

function optionText(p) {
  return p.options.map((o) => `${o.title}: ${o.values.filter((v) => v.in_stock).map((v) => v.title).join('/') || 'sold out'}`).join('; ');
}

function productLine(p) {
  return `- ${p.name} [sku ${p.sku}] — ${priceText(p)}${p.in_stock ? '' : ' — sold out'}${p.options.length ? ` — ${optionText(p)}` : ''}`;
}

const handler = async (args = {}, extra) => {
  try {
    const query = text(args.query, 200);
    const category = text(args.category, 100).toLowerCase();
    if (category && !CATEGORY.test(category)) {
      throw new ShopError(400, 'invalid_category', 'Use a category such as "jackets", "apparel/jackets" or "accessories/packs".');
    }
    const toPrice = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    const minPrice = toPrice(args.min_price);
    const maxPrice = toPrice(args.max_price);
    if ([minPrice, maxPrice].some((v) => v !== undefined && (!Number.isFinite(v) || v < 0))
      || (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice)) {
      throw new ShopError(400, 'invalid_price_range', 'Use a non-negative AUD price range where min_price is at most max_price.');
    }
    const limit = Math.min(Math.max(Number.parseInt(args.limit, 10) || 6, 1), 12);
    const {
      total, products, category: categoryPath, relaxed,
    } = await searchProducts(extra, {
      phrase: query,
      category: category || undefined,
      activity: text(args.activity, 60) || undefined,
      minPrice,
      maxPrice,
      inStockOnly: args.in_stock_only !== false,
      limit,
    });
    const structuredContent = {
      view: 'products',
      query: query || null,
      total,
      products,
      category: categoryPath,
      relaxed,
    };
    const relaxedText = relaxed.length
      ? ` Nothing matched the ${relaxed.map((f) => (f === 'category' ? `category "${category}"` : `activity "${args.activity}"`)).join(' and ')}, so ${relaxed.length > 1 ? 'those filters were' : 'that filter was'} dropped.`
      : '';
    if (!products.length) {
      return {
        content: [{ type: 'text', text: `No WKND gear matched${query ? ` "${query}"` : ''}.${relaxedText} Try a broader search or remove filters.` }],
        structuredContent,
      };
    }
    const summary = `Found ${total} WKND product${total === 1 ? '' : 's'}${query ? ` for "${query}"` : ''}${categoryPath && !relaxed.includes('category') ? ` in ${categoryPath}` : ''}; showing ${products.length}.${relaxedText} Prices are AUD incl. GST. Configurable items need every option chosen before adding to the cart.`;
    return {
      content: [{ type: 'text', text: `${summary}\n${products.map(productLine).join('\n')}` }],
      structuredContent,
    };
  } catch (error) {
    return failure(error);
  }
};

module.exports = withAnalytics('search_shop_products', handler);
