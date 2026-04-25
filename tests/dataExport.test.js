const request = require('supertest');
const app = require('../index');
const dataExportService = require('../src/services/dataExportService');
const { getDatabase } = require('../src/db/appDatabase');

describe('Data Export Service', () => {
  let db;
  let testTenantId;
  
  beforeAll(async () => {
    db = getDatabase();
    
    // Create test tenant
    const [tenant] = await db('tenants').insert({
      name: 'Export Test Tenant',
      email: 'export-test@example.com',
      created_at: new Date(),
      updated_at: new Date()
    }).returning('*');
    
    testTenantId = tenant.id;
    
    // Initialize service
    dataExportService.initialize();
  });

  afterAll(async () => {
    // Clean up test data
    await db('data_export_requests').where('tenant_id', testTenantId).del();
    await db('data_export_rate_limits').where('tenant_id', testTenantId).del();
    await db('tenants').where('id', testTenantId).del();
  });

  beforeEach(async () => {
    // Clear test data
    await db('data_export_requests').where('tenant_id', testTenantId).del();
    await db('data_export_rate_limits').where('tenant_id', testTenantId).del();
  });

  describe('Export Request', () => {
    test('should create export request successfully', async () => {
      const exportRequest = await dataExportService.requestExport(
        testTenantId,
        'test@example.com',
        'json'
      );

      expect(exportRequest.success).toBe(true);
      expect(exportRequest.export_id).toBeDefined();
      expect(exportRequest.status).toBe('pending');
    });

    test('should enforce rate limiting', async () => {
      // First request should succeed
      await dataExportService.requestExport(testTenantId, 'test@example.com', 'json');
      
      // Second request should fail
      await expect(
        dataExportService.requestExport(testTenantId, 'test@example.com', 'json')
      ).rejects.toThrow('Rate limit exceeded');
    });

    test('should validate export format', async () => {
      await expect(
        dataExportService.requestExport(testTenantId, 'test@example.com', 'invalid')
      ).rejects.toThrow('Invalid export format');
    });
  });

  describe('Export Data Generation', () => {
    test('should generate complete export data', async () => {
      // Create test data
      await db('users').insert({
        tenant_id: testTenantId,
        email: 'user1@example.com',
        first_name: 'Test',
        last_name: 'User',
        created_at: new Date(),
        updated_at: new Date()
      });

      const exportData = await dataExportService.generateExportData(testTenantId, 'json');

      expect(exportData.metadata).toBeDefined();
      expect(exportData.files).toBeDefined();
      expect(exportData.files.tenant_info).toBeDefined();
      expect(exportData.files.users).toBeDefined();
      expect(exportData.files.users.length).toBe(1);
      expect(exportData.metadata.record_counts.users).toBe(1);
    });

    test('should generate CSV format correctly', async () => {
      // Create test data
      await db('users').insert({
        tenant_id: testTenantId,
        email: 'user1@example.com',
        first_name: 'Test',
        last_name: 'User',
        created_at: new Date(),
        updated_at: new Date()
      });

      const exportData = await dataExportService.generateExportData(testTenantId, 'csv');

      expect(exportData.files.users).toContain('email,first_name,last_name,created_at,updated_at');
      expect(exportData.files.users).toContain('user1@example.com,Test,User');
    });
  });

  describe('Archive Creation', () => {
    test('should create encrypted ZIP archive', async () => {
      const exportData = {
        format: 'json',
        files: {
          test: 'test content'
        },
        metadata: {
          tenant_id: testTenantId,
          export_date: new Date().toISOString()
        }
      };

      const archiveBuffer = await dataExportService.createEncryptedArchive(exportData, testTenantId);

      expect(archiveBuffer).toBeInstanceOf(Buffer);
      expect(archiveBuffer.length).toBeGreaterThan(0);
    });
  });

  describe('Rate Limit Management', () => {
    test('should check rate limits correctly', async () => {
      // Should allow first request
      await dataExportService.checkRateLimit(testTenantId);
      
      // Should block second request
      await expect(dataExportService.checkRateLimit(testTenantId))
        .rejects.toThrow('Rate limit exceeded');
    });

    test('should update rate limit after successful export', async () => {
      // Create initial rate limit
      await db('data_export_rate_limits').insert({
        tenant_id: testTenantId,
        export_count: 1,
        period_start: new Date(),
        last_export_at: new Date()
      });

      // Update rate limit
      await dataExportService.updateRateLimit(testTenantId);

      // Check updated count
      const rateLimit = await db('data_export_rate_limits')
        .where('tenant_id', testTenantId)
        .first();

      expect(rateLimit.export_count).toBe(2);
    });
  });
});

describe('Data Export API Routes', () => {
  let authToken;
  let testTenantId;

  beforeAll(async () => {
    const db = getDatabase();
    
    // Create test tenant and user
    const [tenant] = await db('tenants').insert({
      name: 'API Export Test Tenant',
      email: 'api-export-test@example.com',
      created_at: new Date(),
      updated_at: new Date()
    }).returning('*');

    testTenantId = tenant.id;
    authToken = 'Bearer mock-token';
  });

  describe('POST /api/v1/merchants/export-data', () => {
    test('should create export request', async () => {
      const response = await request(app)
        .post('/api/v1/merchants/export-data')
        .set('Authorization', authToken)
        .send({
          format: 'json',
          email: 'test@example.com'
        })
        .expect(202);

      expect(response.body.success).toBe(true);
      expect(response.body.data.export_id).toBeDefined();
      expect(response.body.data.status).toBe('pending');
    });

    test('should require authentication', async () => {
      await request(app)
        .post('/api/v1/merchants/export-data')
        .expect(401);
    });

    test('should validate format', async () => {
      const response = await request(app)
        .post('/api/v1/merchants/export-data')
        .set('Authorization', authToken)
        .send({
          format: 'invalid'
        })
        .expect(500);

      expect(response.body.error).toBe('Internal Server Error');
    });
  });

  describe('GET /api/v1/merchants/export-data/:exportId/status', () => {
    test('should return export status', async () => {
      // Create export request first
      const db = getDatabase();
      const [exportRequest] = await db('data_export_requests').insert({
        tenant_id: testTenantId,
        requester_email: 'test@example.com',
        export_format: 'json',
        status: 'completed',
        s3_url: 'https://example.com/export.zip',
        s3_url_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        created_at: new Date(),
        completed_at: new Date()
      }).returning('*');

      const response = await request(app)
        .get(`/api/v1/merchants/export-data/${exportRequest.id}/status`)
        .set('Authorization', authToken)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('completed');
      expect(response.body.data.s3_url).toBe('https://example.com/export.zip');
    });

    test('should return 404 for non-existent export', async () => {
      await request(app)
        .get('/api/v1/merchants/export-data/non-existent-id/status')
        .set('Authorization', authToken)
        .expect(404);
    });
  });

  describe('GET /api/v1/merchants/export-data', () => {
    test('should return export history', async () => {
      const response = await request(app)
        .get('/api/v1/merchants/export-data')
        .set('Authorization', authToken)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.exports).toBeDefined();
      expect(Array.isArray(response.body.data.exports)).toBe(true);
      expect(response.body.data.pagination).toBeDefined();
    });

    test('should support pagination', async () => {
      const response = await request(app)
        .get('/api/v1/merchants/export-data?limit=5&offset=0')
        .set('Authorization', authToken)
        .expect(200);

      expect(response.body.data.pagination.limit).toBe(5);
      expect(response.body.data.pagination.offset).toBe(0);
    });
  });

  describe('DELETE /api/v1/merchants/export-data/:exportId', () => {
    test('should cancel pending export', async () => {
      // Create pending export request
      const db = getDatabase();
      const [exportRequest] = await db('data_export_requests').insert({
        tenant_id: testTenantId,
        requester_email: 'test@example.com',
        export_format: 'json',
        status: 'pending',
        created_at: new Date()
      }).returning('*');

      const response = await request(app)
        .delete(`/api/v1/merchants/export-data/${exportRequest.id}`)
        .set('Authorization', authToken)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('cancelled');
    });

    test('should not cancel completed export', async () => {
      // Create completed export request
      const db = getDatabase();
      const [exportRequest] = await db('data_export_requests').insert({
        tenant_id: testTenantId,
        requester_email: 'test@example.com',
        export_format: 'json',
        status: 'completed',
        created_at: new Date(),
        completed_at: new Date()
      }).returning('*');

      await request(app)
        .delete(`/api/v1/merchants/export-data/${exportRequest.id}`)
        .set('Authorization', authToken)
        .expect(400);
    });
  });

  describe('GET /api/v1/merchants/export-data/schema', () => {
    test('should return export schema', async () => {
      const response = await request(app)
        .get('/api/v1/merchants/export-data/schema')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.version).toBe('1.0');
      expect(response.body.data.tables).toBeDefined();
      expect(response.body.data.export_formats).toBeDefined();
      expect(response.body.data.security_notes).toBeDefined();
    });
  });
});
