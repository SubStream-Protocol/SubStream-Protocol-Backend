const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

/**
 * SQLite-backed application database wrapper.
 */
class AppDatabase {
  /**
   * Insert a notification for a creator.
   * @param {{creatorId: string, type: string, message: string, metadata?: object, timestamp?: string}} notification
   * @returns {object}
   */
  insertNotification(notification) {
    const id = crypto.randomUUID();
    const timestamp = notification.timestamp || new Date().toISOString();
    this.ensureCreator(notification.creatorId);
    this.db.prepare(
      'INSERT INTO notifications (id, creator_id, type, message, metadata_json, timestamp, read) VALUES (?, ?, ?, ?, ?, ?, 0)'
    ).run(
      id,
      notification.creatorId,
      notification.type,
      notification.message,
      JSON.stringify(notification.metadata || {}),
      timestamp
    );
    return this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  }

  /**
   * List notifications for a creator (most recent first).
   * @param {string} creatorId
   * @returns {object[]}
   */
  listNotificationsByCreatorId(creatorId) {
    return this.db.prepare(
      'SELECT * FROM notifications WHERE creator_id = ? ORDER BY timestamp DESC, id DESC'
    ).all(creatorId);
  }

  /**
   * Mark a notification as read.
   * @param {string} notificationId
   * @returns {object}
   */
  markNotificationAsRead(notificationId) {
    this.db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(notificationId);
    return this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(notificationId);
  }
  /**
   * @param {string} filename SQLite filename or `:memory:`.
   */
  constructor(filename) {
    this.filename = filename;
    this.ensureDirectory();
  this.db = new Database(filename);
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS creators (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS creator_settings (
        creator_id TEXT PRIMARY KEY REFERENCES creators(id),
        flow_rate TEXT NOT NULL,
        currency TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        title TEXT,
        visibility TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS coop_splits (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        split_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS creator_audit_logs (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        action_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        ip_address TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        creator_id TEXT NOT NULL REFERENCES creators(id),
        wallet_address TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        subscribed_at TEXT NOT NULL,
        unsubscribed_at TEXT,
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT,
        timestamp TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS email_queue (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        to_address TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL
      );
        PRIMARY KEY (creator_id, wallet_address)
      );

      CREATE INDEX IF NOT EXISTS idx_creator_audit_logs_creator_timestamp
        ON creator_audit_logs (creator_id, timestamp DESC);
    `);

    this.ensureSubscriberCountColumn();
  }

  /**
   * Ensure the parent directory for the database file exists.
   */
  ensureDirectory() {
    if (this.filename !== ':memory:') {
      const dir = path.dirname(this.filename);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Ensure the creators table has a subscriber_count column.
   * This is a noop for in-memory DBs that already have the column.
   */
  ensureSubscriberCountColumn() {
    try {
      const info = this.db.prepare('PRAGMA table_info(creators);').all();
      const hasColumn = info.some((col) => col.name === 'subscriber_count');
      if (!hasColumn) {
        this.db.exec('ALTER TABLE creators ADD COLUMN subscriber_count INTEGER DEFAULT 0');
      }
    } catch (error) {
      console.warn('ensureSubscriberCountColumn failed:', error.message);
    }
  }

  /**
   * Execute work inside a database transaction.
   *
   * @template T
   * @param {() => T} callback Work to execute.
   * @returns {T}
   */
  transaction(callback) {
    this.db.exec('BEGIN');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Ensure a creator row exists, inserting a stub if absent.
   *
   * @param {string} creatorId Creator identifier.
   */
  ensureCreator(creatorId) {
    this.db
      .prepare(
        'INSERT INTO creators (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(creatorId, new Date().toISOString());
  }

  /**
   * Seed a video for tests or local setup.
   *
   * @param {{id: string, creatorId: string, title?: string, visibility: string}} video Video seed.
   */
  seedVideo(video) {
    this.ensureCreator(video.creatorId);
    this.db
      .prepare(
        'INSERT INTO videos (id, creator_id, title, visibility, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(video.id, video.creatorId, video.title || null, video.visibility, new Date().toISOString());
  }

  /**
   * Seed a co-op split for tests or local setup.
   *
   * @param {{id: string, creatorId: string, splits: object[]}} split Split seed.
   */
  seedCoopSplit(split) {
    this.ensureCreator(split.creatorId);
    this.db
      .prepare(
        'INSERT INTO coop_splits (id, creator_id, split_json, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(split.id, split.creatorId, JSON.stringify(split.splits), new Date().toISOString());
  }

  /**
   * Seed creator settings for tests or local setup.
   *
   * @param {{creatorId: string, flowRate: string, currency?: string}} settings Settings seed.
   * @returns {void}
   */
  seedCreatorSettings(settings) {
    this.ensureCreator(settings.creatorId);
    this.db
      .prepare(
        'INSERT INTO creator_settings (creator_id, flow_rate, currency, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(creator_id) DO UPDATE SET flow_rate = excluded.flow_rate, currency = excluded.currency, updated_at = excluded.updated_at',
      )
      .run(settings.creatorId, settings.flowRate, settings.currency || null, new Date().toISOString());
  }

  /**
   * Get creator settings for a creator.
   *
   * @param {string} creatorId Creator identifier.
   * @returns {object|null}
   */
  getCreatorSettings(creatorId) {
    const row = this.db
      .prepare(
        'SELECT creator_id AS creatorId, flow_rate AS flowRate, currency, updated_at AS updatedAt FROM creator_settings WHERE creator_id = ?',
      )
      .get(creatorId);
    return row || null;
  }

  /**
   * Create or update creator settings.
   *
   * @param {{creatorId: string, flowRate: string, currency: string|null, updatedAt: string}} settings Settings data.
   * @returns {object}
   */
  upsertCreatorSettings(settings) {
    this.ensureCreator(settings.creatorId);
    this.db
      .prepare(
        'INSERT INTO creator_settings (creator_id, flow_rate, currency, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(creator_id) DO UPDATE SET flow_rate = excluded.flow_rate, currency = excluded.currency, updated_at = excluded.updated_at',
      )
      .run(settings.creatorId, settings.flowRate, settings.currency, settings.updatedAt);
    return this.getCreatorSettings(settings.creatorId);
  }

  /**
   * Fetch a video.
   *
   * @param {string} videoId Video identifier.
   * @returns {object|null}
   */
  getVideoById(videoId) {
    const row = this.db
      .prepare(
        'SELECT id, creator_id AS creatorId, title, visibility, updated_at AS updatedAt FROM videos WHERE id = ?',
      )
      .get(videoId);
    return row || null;
  }

  /**
   * Update the visibility of an existing video.
   *
   * @param {{videoId: string, visibility: string, updatedAt: string}} input Update payload.
   * @returns {object}
   */
  updateVideoVisibility(input) {
    this.db
      .prepare('UPDATE videos SET visibility = ?, updated_at = ? WHERE id = ?')
      .run(input.visibility, input.updatedAt, input.videoId);
    return this.getVideoById(input.videoId);
  }

  /**
   * Fetch a co-op split by identifier.
   *
   * @param {string} splitId Split identifier.
   * @returns {object|null}
   */
  getCoopSplitById(splitId) {
    const row = this.db
      .prepare(
        'SELECT id, creator_id AS creatorId, split_json AS splitJson, updated_at AS updatedAt FROM coop_splits WHERE id = ?',
      )
      .get(splitId);
    if (!row) {
      return null;
    }
    return {
      ...row,
      splits: JSON.parse(row.splitJson),
    };
  }

  /**
   * Update an existing co-op split.
   *
   * @param {{splitId: string, splits: object[], updatedAt: string}} input Update payload.
   * @returns {object}
   */
  updateCoopSplit(input) {
    this.db
      .prepare('UPDATE coop_splits SET split_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(input.splits), input.updatedAt, input.splitId);
    return this.getCoopSplitById(input.splitId);
  }

  /**
   * Insert an immutable audit log entry.
   *
   * @param {{creatorId: string, actionType: string, entityType: string, entityId: string, timestamp: string, ipAddress: string, metadata: object}} entry Audit log payload.
   * @returns {object}
   */
  insertAuditLog(entry) {
    const id = crypto.randomUUID();
    this.ensureCreator(entry.creatorId);
    this.db
      .prepare(
        'INSERT INTO creator_audit_logs (id, creator_id, action_type, entity_type, entity_id, timestamp, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        entry.creatorId,
        entry.actionType,
        entry.entityType,
        entry.entityId,
        entry.timestamp,
        entry.ipAddress,
        JSON.stringify(entry.metadata || {}),
        entry.timestamp,
      );

    return this.db
      .prepare(
        'SELECT id, creator_id AS creatorId, action_type AS actionType, entity_type AS entityType, entity_id AS entityId, timestamp, ip_address AS ipAddress, metadata_json AS metadataJson, created_at AS createdAt FROM creator_audit_logs WHERE id = ?',
      )
      .get(id);
  }

  /**
   * List audit logs for a creator in reverse chronological order.
   *
   * @param {string} creatorId Creator identifier.
   * @returns {object[]}
   */
  listAuditLogsByCreatorId(creatorId) {
    return this.db
      .prepare(
        'SELECT id, creator_id AS creatorId, action_type AS actionType, entity_type AS entityType, entity_id AS entityId, timestamp, ip_address AS ipAddress, metadata_json AS metadataJson, created_at AS createdAt FROM creator_audit_logs WHERE creator_id = ? ORDER BY timestamp DESC, id DESC',
      )
      .all(creatorId);
  }

  /**
   * Get the cached subscriber count for a creator.
   * Ensures the creator row exists and returns a number (0 if missing).
   *
   * @param {string} creatorId
   * @returns {number}
   */
  getCreatorSubscriberCount(creatorId) {
    this.ensureCreator(creatorId);
    const row = this.db
      .prepare('SELECT subscriber_count AS subscriberCount FROM creators WHERE id = ?')
      .get(creatorId);
    return (row && Number(row.subscriberCount)) || 0;
  }

  /**
   * Increment the subscriber count for a creator by 1.
   * Returns the new count.
   *
   * @param {string} creatorId
   * @returns {number}
   */
  incrementCreatorSubscriberCount(creatorId) {
    return this.transaction(() => {
      this.ensureCreator(creatorId);
      this.db
        .prepare(
          'UPDATE creators SET subscriber_count = COALESCE(subscriber_count, 0) + 1 WHERE id = ?',
        )
        .run(creatorId);
      return this.getCreatorSubscriberCount(creatorId);
    });
  }

  /**
   * Decrement the subscriber count for a creator by 1, clamped at 0.
   * Returns the new count.
   *
   * @param {string} creatorId
   * @returns {number}
   */
  decrementCreatorSubscriberCount(creatorId) {
    return this.transaction(() => {
      this.ensureCreator(creatorId);
      this.db
        .prepare(
          'UPDATE creators SET subscriber_count = MAX(COALESCE(subscriber_count, 0) - 1, 0) WHERE id = ?',
        )
        .run(creatorId);
      return this.getCreatorSubscriberCount(creatorId);
    });
  }

  /**
   * Set the subscriber count explicitly.
   *
   * @param {string} creatorId
   * @param {number} count
   * @returns {number}
   */
  setCreatorSubscriberCount(creatorId, count) {
    return this.transaction(() => {
      this.ensureCreator(creatorId);
      const safe = Math.max(0, Math.floor(Number(count) || 0));
      this.db
        .prepare('UPDATE creators SET subscriber_count = ? WHERE id = ?')
        .run(safe, creatorId);
      return this.getCreatorSubscriberCount(creatorId);
    });
  }

  /**
   * Get a subscription row for a creator and wallet.
   *
   * @param {string} creatorId
   * @param {string} walletAddress
   * @returns {object|null}
   */
  getSubscription(creatorId, walletAddress) {
    const row = this.db
      .prepare(
        'SELECT creator_id AS creatorId, wallet_address AS walletAddress, active, subscribed_at AS subscribedAt, unsubscribed_at AS unsubscribedAt FROM subscriptions WHERE creator_id = ? AND wallet_address = ?',
      )
      .get(creatorId, walletAddress);
    return row || null;
  }

  /**
   * Create or activate a subscription for a wallet.
   * Returns { changed: boolean, count: number }.
   *
   * @param {string} creatorId
   * @param {string} walletAddress
   */
  createOrActivateSubscription(creatorId, walletAddress) {
    return this.transaction(() => {
      this.ensureCreator(creatorId);
      const existing = this.getSubscription(creatorId, walletAddress);
      const now = new Date().toISOString();

      if (existing && existing.active === 1) {
        return { changed: false, count: this.getCreatorSubscriberCount(creatorId) };
      }

      if (existing) {
        this.db
          .prepare(
            'UPDATE subscriptions SET active = 1, subscribed_at = ?, unsubscribed_at = NULL WHERE creator_id = ? AND wallet_address = ?',
          )
          .run(now, creatorId, walletAddress);
      } else {
        this.db
          .prepare(
            'INSERT INTO subscriptions (creator_id, wallet_address, active, subscribed_at) VALUES (?, ?, 1, ?)',
          )
          .run(creatorId, walletAddress, now);
      }

      this.db
        .prepare(
          'UPDATE creators SET subscriber_count = COALESCE(subscriber_count, 0) + 1 WHERE id = ?',
        )
        .run(creatorId);

      return { changed: true, count: this.getCreatorSubscriberCount(creatorId) };
    });
  }

  /**
   * Deactivate a subscription if it is currently active.
   * Returns { changed: boolean, count: number }.
   *
   * @param {string} creatorId
   * @param {string} walletAddress
   */
  deactivateSubscription(creatorId, walletAddress) {
    return this.transaction(() => {
      this.ensureCreator(creatorId);
      const existing = this.getSubscription(creatorId, walletAddress);
      const now = new Date().toISOString();

      if (!existing || existing.active !== 1) {
        return { changed: false, count: this.getCreatorSubscriberCount(creatorId) };
      }

      this.db
        .prepare(
          'UPDATE subscriptions SET active = 0, unsubscribed_at = ? WHERE creator_id = ? AND wallet_address = ?',
        )
        .run(now, creatorId, walletAddress);

      this.db
        .prepare(
          'UPDATE creators SET subscriber_count = MAX(COALESCE(subscriber_count, 0) - 1, 0) WHERE id = ?',
        )
        .run(creatorId);

      return { changed: true, count: this.getCreatorSubscriberCount(creatorId) };
    });
  }

  /**
   * Count active subscriptions for a creator (derived from subscriptions table).
   *
   * @param {string} creatorId
   * @returns {number}
   */
  countActiveSubscriptions(creatorId) {
    const row = this.db
      .prepare('SELECT COUNT(1) AS ct FROM subscriptions WHERE creator_id = ? AND active = 1')
      .get(creatorId);
    return (row && Number(row.ct)) || 0;
  }
}

module.exports = {
  AppDatabase,
};