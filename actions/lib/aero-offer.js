const {
  requireShopper, graphql, ensureNoErrors, ShopError, text,
} = require('./commerce.js');

const FIELDS = `status reason booking_id promotion_id bundle_id name percent_off expires_at
  components { sku quantity name }`;
const BOOKING_ID = /^BK_[0-9a-f]{16}$/;

function projectOffer(value, bookingId) {
  if (!value || value.booking_id !== bookingId
    || !['ELIGIBLE', 'CLAIMED', 'REDEEMED', 'INELIGIBLE'].includes(value.status)
    || !Array.isArray(value.components) || value.components.length > 20) {
    throw new ShopError(502, 'flight_offer_invalid', 'The flight offer service returned invalid information. Check your offer again.');
  }
  if (['ELIGIBLE', 'CLAIMED'].includes(value.status)
    && (!value.promotion_id || !value.bundle_id || !value.name || value.percent_off !== 50
      || !Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) <= Date.now()
      || !value.components.length
      || new Set(value.components.map((item) => item?.sku)).size !== value.components.length
      || value.components.some((item) => typeof item?.sku !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(item.sku)
        || typeof item.name !== 'string' || !item.name.trim()
        || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 20))) {
    throw new ShopError(502, 'flight_offer_invalid', 'The flight offer details are invalid or expired. Check your offer again.');
  }
  return {
    status: value.status,
    reason: text(value.reason) || null,
    booking_id: bookingId,
    promotion_id: text(value.promotion_id) || null,
    bundle_id: text(value.bundle_id) || null,
    name: text(value.name) || null,
    percent_off: typeof value.percent_off === 'number' ? value.percent_off : null,
    expires_at: text(value.expires_at) || null,
    components: value.components.map((item) => ({
      sku: text(item?.sku, 100), quantity: item?.quantity, name: text(item?.name),
    })),
  };
}

async function flightOffer(args, extra, claim = false) {
  const shopper = requireShopper(extra);
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some((key) => key !== 'booking_id')
    || typeof args.booking_id !== 'string' || !BOOKING_ID.test(args.booking_id)) {
    throw new ShopError(400, 'invalid_booking_id', 'Provide only the booking_id from your Aero confirmation (BK_ followed by 16 lowercase hexadecimal characters). Ownership comes from sign-in.');
  }
  const root = claim ? 'claimWkndAeroBundleOffer' : 'wkndAeroBundleOffer';
  const query = `${claim ? 'mutation ClaimWkndAeroBundleOffer' : 'query WkndAeroBundleOffer'}($bookingId: String!) {
    ${root}(booking_id: $bookingId) { ${FIELDS} }
  }`;
  const { data, errors } = await graphql(extra, query, { bookingId: args.booking_id }, { shopper });
  ensureNoErrors(errors, 'The flight-linked gear offer could not be confirmed. Check its status before retrying.');
  const offer = projectOffer(data[root], args.booking_id);
  let message;
  if (offer.status === 'ELIGIBLE') {
    message = 'Your flight-linked gear offer is available. Claim it only after your explicit confirmation.';
  } else if (offer.status === 'CLAIMED') {
    message = 'Offer saved to your account. No gear has been added or purchased.';
  } else if (offer.status === 'REDEEMED') {
    message = 'This flight-linked offer has already been used.';
  } else {
    message = 'No flight-linked offer is available for this booking and account.';
  }
  const terms = ['ELIGIBLE', 'CLAIMED'].includes(offer.status)
    ? `${offer.name}: ${offer.percent_off}% off one exact complete kit until ${offer.expires_at}. `
      + 'One use per booking and shopper. The best eligible discount applies; offers do not stack. '
      + 'Use Add kit to cart with the same WKND account; Commerce calculates the actual cart savings. Gear checkout is separate from your flight. This is not an airfare discount.'
    : '';
  const structuredContent = { mode: 'flight-offer', offer, message, terms };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

module.exports = { flightOffer };
