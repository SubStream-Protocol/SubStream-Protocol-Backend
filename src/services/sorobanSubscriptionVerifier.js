const {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} = require('@stellar/stellar-sdk');

class SorobanSubscriptionVerifier {
  constructor(config) {
    this.config = config;
    this.server = config.soroban.rpcUrl ? new rpc.Server(config.soroban.rpcUrl) : null;
  }

  async verifySubscription(accessRequest) {
    this.assertConfigured();

    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);
    const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
    const contract = new Contract(this.config.soroban.contractId);
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.soroban.networkPassphrase,
    })
      .addOperation(
        contract.call(
          this.config.soroban.method,
          ...this.buildArguments(accessRequest),
        ),
      )
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simulation)) {
      const error = new Error(
        `Soroban simulation failed: ${simulation.error || 'unknown simulation error'}`,
      );
      error.statusCode = 502;
      throw error;
    }

    const result = simulation.result ? scValToNative(simulation.result.retval) : null;
    const normalized = normalizeSubscriptionResult(result);

    return {
      active: normalized.active,
      status: normalized.status,
      raw: result,
    };
  }

  buildArguments(accessRequest) {
    return this.config.soroban.argumentMapping
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [type, field] = entry.split(':');
        const value = accessRequest[field];

        if (value === undefined || value === null || value === '') {
          throw new Error(`Missing Soroban argument value for ${field}`);
        }

        switch (type) {
          case 'address':
            return Address.fromString(value).toScVal();
          case 'symbol':
            return nativeToScVal(value, { type: 'symbol' });
          case 'string':
            return nativeToScVal(String(value));
          case 'bool':
            return nativeToScVal(value === true || value === 'true');
          case 'u32':
          case 'u64':
          case 'i128':
            return nativeToScVal(Number(value), { type });
          default:
            throw new Error(`Unsupported Soroban argument type: ${type}`);
        }
      });
  }

  assertConfigured() {
    if (!this.server) {
      const error = new Error('SOROBAN_RPC_URL is required for subscription verification');
      error.statusCode = 503;
      throw error;
    }

    if (!this.config.soroban.sourceSecret) {
      const error = new Error('SOROBAN_SOURCE_SECRET is required for subscription verification');
      error.statusCode = 503;
      throw error;
    }
  }
}

function normalizeSubscriptionResult(value) {
  if (typeof value === 'boolean') {
    return { active: value, status: value ? 'active' : 'inactive' };
  }

  if (value && typeof value === 'object') {
    if (typeof value.active === 'boolean') {
      return { active: value.active, status: value.status || (value.active ? 'active' : 'inactive') };
    }

    if (typeof value.isActive === 'boolean') {
      return {
        active: value.isActive,
        status: value.status || (value.isActive ? 'active' : 'inactive'),
      };
    }

    if (typeof value.subscribed === 'boolean') {
      return {
        active: value.subscribed,
        status: value.status || (value.subscribed ? 'active' : 'inactive'),
      };
    }

    if (typeof value.status === 'string') {
      return {
        active: value.status.toLowerCase() === 'active',
        status: value.status,
      };
    }
  }

  return { active: false, status: 'inactive' };
}

module.exports = {
  SorobanSubscriptionVerifier,
  normalizeSubscriptionResult,
};
