const path = require('path');

const { Networks } = require('@stellar/stellar-sdk');

const DEFAULT_CONTRACT_ID = 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L';

/**
 * Load runtime configuration from environment variables.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment values.
 * @returns {object}
 */
function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    auth: {
      creatorJwtSecret: env.CREATOR_AUTH_SECRET || 'development-only-creator-secret',
      issuer: env.CREATOR_AUTH_ISSUER || 'substream-backend',
      audience: env.CREATOR_AUTH_AUDIENCE || 'substream-creators',
    },
    database: {
      filename:
        env.DATABASE_FILENAME ||
        path.join(process.cwd(), 'data', 'substream-protocol.sqlite'),
    },
    cdn: {
      baseUrl: env.CDN_BASE_URL || '',
      tokenSecret: env.CDN_TOKEN_SECRET || 'development-only-cdn-secret',
      tokenTtlSeconds: Number(env.CDN_TOKEN_TTL_SECONDS || 300),
      issuer: env.CDN_TOKEN_ISSUER || 'substream-backend',
      audience: env.CDN_TOKEN_AUDIENCE || 'substream-cdn',
    },
    soroban: {
      rpcUrl: env.SOROBAN_RPC_URL || '',
      networkPassphrase: env.SOROBAN_NETWORK_PASSPHRASE || Networks.PUBLIC,
      contractId: env.SOROBAN_CONTRACT_ID || DEFAULT_CONTRACT_ID,
      sourceSecret: env.SOROBAN_SOURCE_SECRET || '',
      method: env.SOROBAN_SUBSCRIPTION_METHOD || 'has_active_subscription',
      argumentMapping:
        env.SOROBAN_SUBSCRIPTION_ARGUMENTS || 'address:walletAddress,address:creatorAddress',
    },
  };
}

module.exports = {
  DEFAULT_CONTRACT_ID,
  loadConfig,
};
