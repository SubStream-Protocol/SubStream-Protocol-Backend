/**
 * Combine all resolvers into a single resolvers object
 */

const merchantResolvers = require('./merchantResolver');
const subscriptionResolvers = require('./subscriptionResolver');
const planResolvers = require('./planResolver');
const billingEventResolvers = require('./billingEventResolver');

/**
 * Merge resolver objects recursively
 */
function mergeResolvers(...resolverArrays) {
  const merged = {};

  for (const resolvers of resolverArrays) {
    for (const [key, value] of Object.entries(resolvers)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        merged[key] = { ...merged[key], ...value };
      } else {
        merged[key] = value;
      }
    }
  }

  return merged;
}

const resolvers = mergeResolvers(
  merchantResolvers,
  subscriptionResolvers,
  planResolvers,
  billingEventResolvers
);

module.exports = resolvers;
