const EventEmitter = require('events');

/**
 * SubscriptionService maintains cached subscriber counts and handles
 * subscription events (subscribed, unsubscribed, expired).
 */
class SubscriptionService extends EventEmitter {
  /**
   * @param {{database: import('../db/appDatabase').AppDatabase, auditLogService?: any}} options
   */
  constructor({ database, auditLogService } = {}) {
    super();
    if (!database) throw new Error('database is required');
    this.database = database;
    this.auditLogService = auditLogService || null;
  }

  /**
   * Handle an incoming subscription event.
   * Event shape: { type: 'subscribed'|'unsubscribed'|'expired', creatorId: string, walletAddress?: string, timestamp?: string }
   */
  async handleEvent(event) {
    if (!event || !event.type || !event.creatorId) {
      throw new Error('Invalid subscription event');
    }

    const creatorId = String(event.creatorId);
    const type = String(event.type).toLowerCase();

    let newCount;

    switch (type) {
      case 'subscribed':
        if (event.walletAddress) {
          const result = this.database.createOrActivateSubscription(creatorId, String(event.walletAddress));
          newCount = result.count;
          if (result.changed) this.emit('subscribed', { creatorId, newCount, walletAddress: event.walletAddress });
        } else {
          // fallback to simple increment if wallet address not provided
          newCount = this.database.incrementCreatorSubscriberCount(creatorId);
          this.emit('subscribed', { creatorId, newCount, walletAddress: null });
        }
        break;
      case 'unsubscribed':
      case 'expired':
        if (event.walletAddress) {
          const result = this.database.deactivateSubscription(creatorId, String(event.walletAddress));
          newCount = result.count;
          if (result.changed) this.emit('unsubscribed', { creatorId, newCount, walletAddress: event.walletAddress });
        } else {
          // fallback to simple decrement
          newCount = this.database.decrementCreatorSubscriberCount(creatorId);
          this.emit('unsubscribed', { creatorId, newCount, walletAddress: null });
        }
        break;
      default:
        throw new Error(`Unsupported subscription event type: ${event.type}`);
    }

    // Optionally append an audit log if service provided
    try {
      if (this.auditLogService && typeof this.auditLogService.append === 'function') {
        const timestamp = event.timestamp || new Date().toISOString();
        const action = type === 'subscribed' ? 'SUBSCRIBER_ADDED' : 'SUBSCRIBER_REMOVED';

        this.auditLogService.append({
          creatorId,
          actionType: action,
          entityType: 'subscription',
          entityId: event.walletAddress || 'unknown',
          timestamp,
          ipAddress: event.ipAddress || 'system',
          metadata: { walletAddress: event.walletAddress || null, resulting_count: newCount },
        });
      }
    } catch (err) {
      // Audit failures should not block subscription processing
      // eslint-disable-next-line no-console
      console.warn('Failed to append subscription audit log:', err && err.message);
    }

    return { creatorId, newCount };
  }
}

module.exports = {
  SubscriptionService,
};
