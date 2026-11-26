const { flightOffer } = require('../lib/aero-offer.js');
const { failure } = require('../lib/commerce.js');

module.exports = async (args = {}, extra) => {
  try {
    return await flightOffer(args, extra);
  } catch (error) {
    return failure(error);
  }
};
