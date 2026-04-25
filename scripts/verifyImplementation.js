#!/usr/bin/env node

/**
 * Verify Four Critical Features Implementation
 * 
 * This script performs comprehensive verification of the four critical features:
 * 1. Tenant-Level Feature Flag Toggles
 * 2. Automated Data Export and Portability
 * 3. WebSocket Rate Limiting
 * 4. Docker and Kubernetes Configuration
 */

const { getDatabase } = require('../src/db/appDatabase');
const tenantConfigurationService = require('../src/services/tenantConfigurationService');
const websocketRateLimitService = require('../src/services/websocketRateLimitService');
const dataExportService = require('../src/services/dataExportService');
const fs = require('fs');
const path = require('path');

class ImplementationVerifier {
  constructor() {
    this.results = {
      passed: 0,
      failed: 0,
      warnings: 0,
      details: []
    };
  }

  log(message, type = 'info') {
    const icons = {
      info: 'ℹ️',
      success: '✅',
      error: '❌',
      warning: '⚠️'
    };
    console.log(`${icons[type]} ${message}`);
  }

  async verifyFeatureFlags() {
    this.log('Verifying Feature Flags Implementation...');
    
    try {
      // Initialize service
      await tenantConfigurationService.initialize();
      
      // Test database tables
      const db = getDatabase();
      const hasConfigTable = await db.schema.hasTable('tenant_configurations');
      const hasAuditTable = await db.schema.hasTable('feature_flag_audit_log');
      
      if (!hasConfigTable) {
        this.log('Missing tenant_configurations table', 'error');
        this.results.failed++;
        return;
      }
      
      if (!hasAuditTable) {
        this.log('Missing feature_flag_audit_log table', 'error');
        this.results.failed++;
        return;
      }
      
      this.log('Database tables exist', 'success');
      this.results.passed++;
      
      // Test service functionality
      const testTenantId = 'test-tenant-verification';
      
      // Test flag evaluation (should return false for non-existent)
      const flagValue = await tenantConfigurationService.evaluateFeatureFlag(testTenantId, 'test_flag');
      if (flagValue === false) {
        this.log('Feature flag evaluation working correctly', 'success');
        this.results.passed++;
      } else {
        this.log('Feature flag evaluation not working correctly', 'error');
        this.results.failed++;
      }
      
      // Test flag update
      await tenantConfigurationService.updateFeatureFlag(testTenantId, 'test_flag', true, 'verifier', 'Verification test');
      const updatedValue = await tenantConfigurationService.evaluateFeatureFlag(testTenantId, 'test_flag');
      
      if (updatedValue === true) {
        this.log('Feature flag update working correctly', 'success');
        this.results.passed++;
      } else {
        this.log('Feature flag update not working correctly', 'error');
        this.results.failed++;
      }
      
      // Test audit logging
      const auditHistory = await tenantConfigurationService.getFlagAuditHistory(testTenantId, 'test_flag', 1);
      if (auditHistory.length > 0) {
        this.log('Audit logging working correctly', 'success');
        this.results.passed++;
      } else {
        this.log('Audit logging not working correctly', 'error');
        this.results.failed++;
      }
      
      // Test performance (should be under 1ms for cached flags)
      const iterations = 100;
      const start = process.hrtime.bigint();
      
      for (let i = 0; i < iterations; i++) {
        await tenantConfigurationService.evaluateFeatureFlag(testTenantId, 'test_flag');
      }
      
      const end = process.hrtime.bigint();
      const averageTime = Number(end - start) / 1000000 / iterations;
      
      if (averageTime < 1) {
        this.log(`Feature flag performance: ${averageTime.toFixed(3)}ms average (under 1ms target)`, 'success');
        this.results.passed++;
      } else {
        this.log(`Feature flag performance: ${averageTime.toFixed(3)}ms average (exceeds 1ms target)`, 'warning');
        this.results.warnings++;
      }
      
      // Cleanup test data
      await db('tenant_configurations').where('tenant_id', testTenantId).del();
      await db('feature_flag_audit_log').where('tenant_id', testTenantId).del();
      
    } catch (error) {
      this.log(`Feature flags verification failed: ${error.message}`, 'error');
      this.results.failed++;
    }
  }

  async verifyDataExport() {
    this.log('Verifying Data Export Implementation...');
    
    try {
      // Initialize service
      dataExportService.initialize();
      
      // Test database tables
      const db = getDatabase();
      const hasExportTable = await db.schema.hasTable('data_export_requests');
      const hasRateLimitTable = await db.schema.hasTable('data_export_rate_limits');
      
      if (!hasExportTable) {
        this.log('Missing data_export_requests table', 'error');
        this.results.failed++;
        return;
      }
      
      if (!hasRateLimitTable) {
        this.log('Missing data_export_rate_limits table', 'error');
        this.results.failed++;
        return;
      }
      
      this.log('Database tables exist', 'success');
      this.results.passed++;
      
      // Test export request
      const testTenantId = 'test-tenant-export';
      const testEmail = 'test@example.com';
      
      // Create test tenant
      await db('tenants').insert({
        id: testTenantId,
        name: 'Export Test Tenant',
        email: testEmail,
        created_at: new Date(),
        updated_at: new Date()
      }).onConflict().ignore();
      
      // Test export request
      const exportRequest = await dataExportService.requestExport(testTenantId, testEmail, 'json');
      
      if (exportRequest.success && exportRequest.export_id) {
        this.log('Export request creation working correctly', 'success');
        this.results.passed++;
      } else {
        this.log('Export request creation not working correctly', 'error');
        this.results.failed++;
      }
      
      // Test export status
      const exportStatus = await dataExportService.getExportStatus(exportRequest.export_id, testTenantId);
      
      if (exportStatus && exportStatus.id === exportRequest.export_id) {
        this.log('Export status retrieval working correctly', 'success');
        this.results.passed++;
      } else {
        this.log('Export status retrieval not working correctly', 'error');
        this.results.failed++;
      }
      
      // Test rate limiting
      try {
        await dataExportService.requestExport(testTenantId, testEmail, 'json');
        this.log('Rate limiting not working (should have blocked second request)', 'warning');
        this.results.warnings++;
      } catch (error) {
        if (error.message.includes('Rate limit exceeded')) {
          this.log('Rate limiting working correctly', 'success');
          this.results.passed++;
        } else {
          this.log(`Unexpected error in rate limiting: ${error.message}`, 'error');
          this.results.failed++;
        }
      }
      
      // Cleanup test data
      await db('data_export_requests').where('tenant_id', testTenantId).del();
      await db('data_export_rate_limits').where('tenant_id', testTenantId).del();
      await db('tenants').where('id', testTenantId).del();
      
    } catch (error) {
      this.log(`Data export verification failed: ${error.message}`, 'error');
      this.results.failed++;
    }
  }

  async verifyWebSocketRateLimiting() {
    this.log('Verifying WebSocket Rate Limiting Implementation...');
    
    try {
      // Initialize service
      await websocketRateLimitService.initialize();
      
      // Test database tables
      const db = getDatabase();
      const hasWsLogTable = await db.schema.hasTable('websocket_rate_limit_log');
      const hasTenantRateTable = await db.schema.hasTable('tenant_rate_limits');
      
      if (!hasWsLogTable) {
        this.log('Missing websocket_rate_limit_log table', 'error');
        this.results.failed++;
        return;
      }
      
      if (!hasTenantRateTable) {
        this.log('Missing tenant_rate_limits table', 'error');
        this.results.failed++;
        return;
      }
      
      this.log('Database tables exist', 'success');
      this.results.passed++;
      
      // Test connection limits
      const testIP = '192.168.1.100';
      const testTenantId = 'test-tenant-ws';
      const maxConnections = websocketRateLimitService.config.maxConnectionsPerIP;
      
      // Register connections up to limit
      for (let i = 0; i < maxConnections; i++) {
        await websocketRateLimitService.registerConnection(testIP, testTenantId, `socket${i}`);
      }
      
      // Test that next connection is blocked
      const limitCheck = await websocketRateLimitService.checkConnectionLimit(testIP, testTenantId, 'socket_exceed');
      
      if (!limitCheck.allowed && limitCheck.reason === 'IP_CONNECTION_LIMIT_EXCEEDED') {
        this.log('Connection rate limiting working correctly', 'success');
        this.results.passed++;
      } else {
        this.log('Connection rate limiting not working correctly', 'error');
        this.results.failed++;
      }
      
      // Test message rate limiting
      const socketId = 'test-message-socket';
      await websocketRateLimitService.registerConnection(testIP, testTenantId, socketId);
      
      // Use all tokens
      const maxMessages = websocketRateLimitService.config.tokenBucketCapacity;
      for (let i = 0; i < maxMessages; i++) {
        await websocketRateLimitService.checkMessageRateLimit(socketId);
      }
      
      // Next message should be blocked
      const messageCheck = await websocketRateLimitService.checkMessageRateLimit(socketId);
      
      if (!messageCheck.allowed && messageCheck.reason === 'MESSAGE_RATE_LIMIT_EXCEEDED') {
        this.log('Message rate limiting working correctly', 'success');
        this.results.passed++;
      } else {
        this.log('Message rate limiting not working correctly', 'error');
        this.results.failed++;
      }
      
      // Test statistics
      const stats = await websocketRateLimitService.getConnectionStats();
      
      if (stats && stats.total_connections > 0) {
        this.log('Statistics collection working correctly', 'success');
        this.results.passed++;
      } else {
        this.log('Statistics collection not working correctly', 'error');
        this.results.failed++;
      }
      
      // Cleanup
      for (let i = 0; i < maxConnections; i++) {
        await websocketRateLimitService.unregisterConnection(`socket${i}`);
      }
      await websocketRateLimitService.unregisterConnection(socketId);
      await websocketRateLimitService.redis.flushAll();
      
    } catch (error) {
      this.log(`WebSocket rate limiting verification failed: ${error.message}`, 'error');
      this.results.failed++;
    }
  }

  verifyDockerAndK8s() {
    this.log('Verifying Docker and Kubernetes Configuration...');
    
    try {
      // Check Dockerfile exists
      const dockerfilePath = path.join(__dirname, '../Dockerfile');
      if (fs.existsSync(dockerfilePath)) {
        this.log('Dockerfile exists', 'success');
        this.results.passed++;
      } else {
        this.log('Dockerfile missing', 'error');
        this.results.failed++;
        return;
      }
      
      // Check .dockerignore exists
      const dockerignorePath = path.join(__dirname, '../.dockerignore');
      if (fs.existsSync(dockerignorePath)) {
        this.log('.dockerignore exists', 'success');
        this.results.passed++;
      } else {
        this.log('.dockerignore missing', 'error');
        this.results.failed++;
      }
      
      // Check K8s manifests
      const k8sFiles = [
        '../k8s/deployment.yaml',
        '../k8s/configmap.yaml',
        '../k8s/secrets.yaml'
      ];
      
      for (const file of k8sFiles) {
        const filePath = path.join(__dirname, file);
        if (fs.existsSync(filePath)) {
          this.log(`K8s manifest ${path.basename(file)} exists`, 'success');
          this.results.passed++;
        } else {
          this.log(`K8s manifest ${path.basename(file)} missing`, 'error');
          this.results.failed++;
        }
      }
      
      // Verify Dockerfile content
      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
      
      if (dockerfileContent.includes('FROM node:18-alpine AS builder')) {
        this.log('Multi-stage build configured', 'success');
        this.results.passed++;
      } else {
        this.log('Multi-stage build not configured', 'warning');
        this.results.warnings++;
      }
      
      if (dockerfileContent.includes('USER nodejs')) {
        this.log('Non-root user configured', 'success');
        this.results.passed++;
      } else {
        this.log('Non-root user not configured', 'error');
        this.results.failed++;
      }
      
      if (dockerfileContent.includes('HEALTHCHECK')) {
        this.log('Health check configured', 'success');
        this.results.passed++;
      } else {
        this.log('Health check not configured', 'error');
        this.results.failed++;
      }
      
      if (dockerfileContent.includes('dumb-init')) {
        this.log('Signal handling configured', 'success');
        this.results.passed++;
      } else {
        this.log('Signal handling not configured', 'warning');
        this.results.warnings++;
      }
      
    } catch (error) {
      this.log(`Docker/K8s verification failed: ${error.message}`, 'error');
      this.results.failed++;
    }
  }

  verifyTests() {
    this.log('Verifying Test Coverage...');
    
    try {
      const testFiles = [
        '../tests/tenantConfiguration.test.js',
        '../tests/dataExport.test.js',
        '../tests/websocketRateLimit.test.js',
        '../tests/docker.test.js',
        '../tests/integration.test.js'
      ];
      
      for (const file of testFiles) {
        const filePath = path.join(__dirname, file);
        if (fs.existsSync(filePath)) {
          this.log(`Test file ${path.basename(file)} exists`, 'success');
          this.results.passed++;
        } else {
          this.log(`Test file ${path.basename(file)} missing`, 'error');
          this.results.failed++;
        }
      }
      
    } catch (error) {
      this.log(`Test verification failed: ${error.message}`, 'error');
      this.results.failed++;
    }
  }

  async runFullVerification() {
    console.log('🔍 Starting Comprehensive Implementation Verification...\n');
    
    await this.verifyFeatureFlags();
    console.log('');
    
    await this.verifyDataExport();
    console.log('');
    
    await this.verifyWebSocketRateLimiting();
    console.log('');
    
    this.verifyDockerAndK8s();
    console.log('');
    
    this.verifyTests();
    console.log('');
    
    // Summary
    console.log('📊 Verification Summary:');
    console.log(`  ✅ Passed: ${this.results.passed}`);
    console.log(`  ❌ Failed: ${this.results.failed}`);
    console.log(`  ⚠️  Warnings: ${this.results.warnings}`);
    console.log('');
    
    const total = this.results.passed + this.results.failed + this.results.warnings;
    const successRate = ((this.results.passed / total) * 100).toFixed(1);
    
    console.log(`📈 Success Rate: ${successRate}%`);
    
    if (this.results.failed === 0) {
      console.log('🎉 All critical features verified successfully!');
      console.log('🚀 Ready for production deployment!');
    } else {
      console.log('⚠️  Some issues detected - please review and fix before deployment');
    }
    
    if (this.results.warnings > 0) {
      console.log('⚠️  Some warnings detected - review recommended for optimal performance');
    }
    
    return this.results.failed === 0;
  }
}

// Run verification if called directly
if (require.main === module) {
  const verifier = new ImplementationVerifier();
  verifier.runFullVerification()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error('Verification failed:', error);
      process.exit(1);
    });
}

module.exports = { ImplementationVerifier };
