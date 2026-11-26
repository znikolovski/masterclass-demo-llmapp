const { flightOffer } = require('../lib/aero-offer.js');
const { failure } = require('../lib/commerce.js');

module.exports = async (args = {}, extra) => {
  try {
    return await flightOffer(args, extra, true);
  } catch (error) {
    return failure(error, {
      message: 'The claim status could not be confirmed. Check your flight-linked offer before retrying. Claiming never adds or purchases gear.',
    });
  }
};
