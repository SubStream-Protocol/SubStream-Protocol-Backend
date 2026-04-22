const { SlackAlertService } = require('../src/services/slackAlertService');

// Mock axios
jest.mock('axios');

describe('SlackAlertService', () => {
  let slackService;
  let mockConfig;

  beforeEach(() => {
    mockConfig = {
      slackWebhookUrl: 'https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK',
      slackChannel: '#alerts',
      slackUsername: 'Test Bot',
      slackIconEmoji: ':test:',
      slackAlertsEnabled: true,
      slackRateLimitMs: 1000
    };

    slackService = new SlackAlertService(mockConfig);
  });

  describe('constructor', () => {
    test('should initialize with correct configuration', () => {
      expect(slackService.webhookUrl).toBe(mockConfig.slackWebhookUrl);
      expect(slackService.channel).toBe(mockConfig.slackChannel);
      expect(slackService.username).toBe(mockConfig.slackUsername);
      expect(slackService.iconEmoji).toBe(mockConfig.slackIconEmoji);
      expect(slackService.enabled).toBe(true);
      expect(slackService.rateLimitMs).toBe(1000);
    });

    test('should use default values when not configured', () => {
      const minimalConfig = {
        slackWebhookUrl: 'https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK'
      };

      const minimalService = new SlackAlertService(minimalConfig);

      expect(minimalService.channel).toBe('#alerts');
      expect(minimalService.username).toBe('Soroban DLQ Bot');
      expect(minimalService.iconEmoji).toBe(':warning:');
    });
  });

  describe('sendAlert', () => {
    test('should send alert successfully', async () => {
      const mockAlert = {
        type: 'test',
        severity: 'info',
        title: 'Test Alert',
        message: 'This is a test alert',
        details: { key: 'value' },
        timestamp: '2023-01-01T00:00:00Z'
      };

      const mockResponse = { status: 200 };
      const axios = require('axios');
      axios.post.mockResolvedValue(mockResponse);

      const result = await slackService.sendAlert(mockAlert);

      expect(result.success).toBe(true);
      expect(axios.post).toHaveBeenCalledWith(
        mockConfig.slackWebhookUrl,
        expect.objectContaining({
          channel: '#alerts',
          username: 'Test Bot',
          icon_emoji: ':test:',
          attachments: expect.arrayContaining([
            expect.objectContaining({
              color: '#36a64f',
              title: 'Test Alert',
              text: 'This is a test alert'
            })
          ])
        }),
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        })
      );
    });

    test('should handle rate limiting', async () => {
      const mockAlert = {
        type: 'test',
        severity: 'info',
        title: 'Test Alert',
        message: 'This is a test alert',
        timestamp: '2023-01-01T00:00:00Z'
      };

      const axios = require('axios');
      axios.post.mockResolvedValue({ status: 200 });

      // First alert succeeds
      const firstResult = await slackService.sendAlert(mockAlert);
      expect(firstResult.success).toBe(true);

      // Second alert is rate limited
      const secondResult = await slackService.sendAlert(mockAlert);
      expect(secondResult.success).toBe(false);
      expect(secondResult.reason).toBe('rate_limited');
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('should return disabled when alerts disabled', async () => {
      slackService.setEnabled(false);

      const mockAlert = {
        type: 'test',
        severity: 'info',
        title: 'Test Alert',
        message: 'This is a test alert',
        timestamp: '2023-01-01T00:00:00Z'
      };

      const result = await slackService.sendAlert(mockAlert);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('disabled');
    });

    test('should handle network errors', async () => {
      const mockAlert = {
        type: 'test',
        severity: 'info',
        title: 'Test Alert',
        message: 'This is a test alert',
        timestamp: '2023-01-01T00:00:00Z'
      };

      const axios = require('axios');
      axios.post.mockRejectedValue(new Error('Network error'));

      const result = await slackService.sendAlert(mockAlert);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    test('should handle unexpected status codes', async () => {
      const mockAlert = {
        type: 'test',
        severity: 'info',
        title: 'Test Alert',
        message: 'This is a test alert',
        timestamp: '2023-01-01T00:00:00Z'
      };

      const axios = require('axios');
      axios.post.mockResolvedValue({ status: 500 });

      await expect(slackService.sendAlert(mockAlert)).rejects.toThrow('Unexpected status code: 500');
    });
  });

  describe('sendDlqAlert', () => {
    test('should format DLQ alert correctly', async () => {
      const mockDlqItem = {
        id: 'dlq_123',
        contract_id: 'CONTRACT_123',
        transaction_hash: 'tx_hash_123',
        event_index: 0,
        ledger_sequence: 12345,
        error_category: 'xdr_parsing',
        error_message: 'Invalid XDR format',
        original_attempt_count: 3
      };

      const mockError = new Error('XDR parsing failed');

      const axios = require('axios');
      axios.post.mockResolvedValue({ status: 200 });

      const result = await slackService.sendDlqAlert(mockDlqItem, mockError);

      expect(result.success).toBe(true);
      expect(axios.post).toHaveBeenCalledWith(
        mockConfig.slackWebhookUrl,
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({
              color: '#8b0000', // critical severity
              title: 'Soroban Event Processing Failed',
              text: 'Event tx_hash_123:0 failed processing after 3 attempts',
              fields: expect.arrayContaining([
                expect.objectContaining({
                  title: 'Severity',
                  value: 'CRITICAL'
                }),
                expect.objectContaining({
                  title: 'DLQ ID',
                  value: 'dlq_123'
                }),
                expect.objectContaining({
                  title: 'Error Category',
                  value: 'xdr_parsing'
                }),
                expect.objectContaining({
                  title: 'Transaction Hash',
                  value: '`tx_hash_123`'
                })
              ])
            })
          ])
        }),
        expect.any(Object)
      );
    });

    test('should use correct severity based on error category', async () => {
      const mockDlqItem = {
        id: 'dlq_123',
        contract_id: 'CONTRACT_123',
        transaction_hash: 'tx_hash_123',
        event_index: 0,
        ledger_sequence: 12345,
        error_category: 'network',
        error_message: 'Network timeout',
        original_attempt_count: 1
      };

      const axios = require('axios');
      axios.post.mockResolvedValue({ status: 200 });

      await slackService.sendDlqAlert(mockDlqItem, new Error('Network error'));

      expect(axios.post).toHaveBeenCalledWith(
        mockConfig.slackWebhookUrl,
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({
              color: '#ff9500' // warning severity
            })
          ])
        }),
        expect.any(Object)
      );
    });
  });

  describe('formatSlackMessage', () => {
    test('should format basic alert message', () => {
      const mockAlert = {
        type: 'test',
        severity: 'info',
        title: 'Test Alert',
        message: 'This is a test alert',
        details: {},
        timestamp: '2023-01-01T00:00:00Z'
      };

      const message = slackService.formatSlackMessage(mockAlert);

      expect(message).toEqual({
        channel: '#alerts',
        username: 'Test Bot',
        icon_emoji: ':test:',
        attachments: expect.arrayContaining([
          expect.objectContaining({
            color: '#36a64f',
            title: 'Test Alert',
            text: 'This is a test alert'
          })
        ])
      });
    });

    test('should include action buttons for DLQ alerts', () => {
      const mockAlert = {
        type: 'dlq_item_added',
        severity: 'error',
        title: 'DLQ Alert',
        message: 'Event failed',
        details: {
          dlqId: 'dlq_123'
        },
        timestamp: '2023-01-01T00:00:00Z'
      };

      // Mock BASE_URL
      process.env.BASE_URL = 'http://localhost:3000';

      const message = slackService.formatSlackMessage(mockAlert);

      expect(message.attachments[0].actions).toEqual([
        {
          type: 'button',
          text: 'View Details',
          url: 'http://localhost:3000/admin/dlq/item/dlq_123'
        },
        {
          type: 'button',
          text: 'Retry Event',
          url: 'http://localhost:3000/admin/dlq/retry',
          style: 'primary'
        }
      ]);

      // Clean up
      delete process.env.BASE_URL;
    });
  });

  describe('createFields', () => {
    test('should create fields for DLQ alert', () => {
      const mockAlert = {
        type: 'dlq_item_added',
        details: {
          dlqId: 'dlq_123',
          transactionHash: 'tx_hash_123',
          eventIndex: 0,
          ledgerSequence: 12345,
          errorMessage: 'XDR parsing failed'
        },
        timestamp: '2023-01-01T00:00:00Z'
      };

      const fields = slackService.createFields(mockAlert);

      expect(fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: 'Severity',
            value: expect.any(String),
            short: true
          }),
          expect.objectContaining({
            title: 'Time',
            value: expect.any(String),
            short: true
          }),
          expect.objectContaining({
            title: 'DLQ ID',
            value: 'dlq_123',
            short: true
          }),
          expect.objectContaining({
            title: 'Transaction Hash',
            value: '`tx_hash_123`',
            short: false
          })
        ])
      );
    });

    test('should truncate long field values', () => {
      const mockAlert = {
        details: {
          longField: 'a'.repeat(200)
        },
        timestamp: '2023-01-01T00:00:00Z'
      };

      const fields = slackService.createFields(mockAlert);

      const longField = fields.find(f => f.title === 'Longfield');
      expect(longField.value).toBe('`' + 'a'.repeat(100) + '...`');
    });

    test('should limit to 10 fields', () => {
      const mockAlert = {
        details: {},
        timestamp: '2023-01-01T00:00:00Z'
      };

      // Add 15 fields to details
      for (let i = 0; i < 15; i++) {
        mockAlert.details[`field_${i}`] = `value_${i}`;
      }

      const fields = slackService.createFields(mockAlert);
      expect(fields.length).toBeLessThanOrEqual(10);
    });
  });

  describe('getColorBySeverity', () => {
    test('should return correct colors for severity levels', () => {
      expect(slackService.getColorBySeverity('info')).toBe('#36a64f');
      expect(slackService.getColorBySeverity('warning')).toBe('#ff9500');
      expect(slackService.getColorBySeverity('error')).toBe('#ff0000');
      expect(slackService.getColorBySeverity('critical')).toBe('#8b0000');
      expect(slackService.getColorBySeverity('unknown')).toBe('#808080');
    });
  });

  describe('getAlertSeverity', () => {
    test('should return correct severity for error categories', () => {
      expect(slackService.getAlertSeverity('network')).toBe('warning');
      expect(slackService.getAlertSeverity('processing')).toBe('warning');
      expect(slackService.getAlertSeverity('validation')).toBe('error');
      expect(slackService.getAlertSeverity('xdr_parsing')).toBe('critical');
      expect(slackService.getAlertSeverity('database')).toBe('critical');
      expect(slackService.getAlertSeverity('unknown')).toBe('warning');
    });
  });

  describe('testConnection', () => {
    test('should test connection successfully', async () => {
      const axios = require('axios');
      axios.post.mockResolvedValue({ status: 200 });

      const result = await slackService.testConnection();

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect(axios.post).toHaveBeenCalledWith(
        mockConfig.slackWebhookUrl,
        expect.objectContaining({
          text: 'Test message from Soroban DLQ Bot'
        }),
        expect.any(Object)
      );
    });

    test('should handle connection failure', async () => {
      const axios = require('axios');
      axios.post.mockRejectedValue(new Error('Connection failed'));

      const result = await slackService.testConnection();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection failed');
    });

    test('should return disabled when alerts disabled', async () => {
      slackService.setEnabled(false);

      const result = await slackService.testConnection();

      expect(result.success).toBe(false);
      expect(result.reason).toBe('disabled');
    });
  });

  describe('getStats', () => {
    test('should return alert statistics', () => {
      slackService.stats.alertsSent = 10;
      slackService.stats.alertsFailed = 2;
      slackService.stats.rateLimited = 1;

      const stats = slackService.getStats();

      expect(stats.alertsSent).toBe(10);
      expect(stats.alertsFailed).toBe(2);
      expect(stats.rateLimited).toBe(1);
      expect(stats.enabled).toBe(true);
      expect(stats.webhookConfigured).toBe(true);
      expect(stats.uptime).toBeDefined();
    });
  });

  describe('setEnabled', () => {
    test('should enable/disable alerts', () => {
      slackService.setEnabled(false);
      expect(slackService.enabled).toBe(false);

      slackService.setEnabled(true);
      expect(slackService.enabled).toBe(true);
    });
  });

  describe('setRateLimit', () => {
    test('should update rate limit', () => {
      slackService.setRateLimit(2000);
      expect(slackService.rateLimitMs).toBe(2000);
    });
  });
});
