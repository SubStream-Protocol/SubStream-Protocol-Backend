# Deployment Guide: Four Critical Features Implementation

This guide provides step-by-step instructions for deploying the four critical features implementation to production.

## Prerequisites

- Node.js 20.11.0+
- Redis server
- PostgreSQL database
- AWS S3 bucket (for data exports)
- Kubernetes cluster (for production deployment)
- Docker installed

## Step 1: Push Changes to Remote Repository

Since I encountered permission issues, you'll need to push the branch manually:

```bash
# Push the feature branch
git push -u origin feature/tenant-flags-data-export-docker-ws-security

# Create pull request through GitHub UI
# Use the PR description provided in IMPLEMENTATION_SUMMARY.md
```

## Step 2: Database Migrations

Run the database migrations to add the new tables:

```bash
# Run all new migrations
npm run migrate

# Or run individual migrations if needed
npm run migrate:up 008_add_tenant_feature_flags
npm run migrate:up 009_add_data_export_tracking
npm run migrate:up 010_add_websocket_rate_limit_log
```

### Migration Details

**008_add_tenant_feature_flags.js**
- Creates `tenant_configurations` table for feature flags
- Creates `feature_flag_audit_log` table for audit trail
- Inserts default feature flags for existing tenants

**009_add_data_export_tracking.js**
- Creates `data_export_requests` table for export tracking
- Creates `data_export_rate_limits` table for export rate limiting

**010_add_websocket_rate_limit_log.js**
- Creates `websocket_rate_limit_log` table for security auditing
- Creates `tenant_rate_limits` table for custom rate limits

## Step 3: Environment Configuration

Update your `.env` file with the new required variables:

```bash
# Feature Flags Configuration
ENABLE_FEATURE_FLAGS=true
ENABLE_DATA_EXPORT=true
ENABLE_WEBSOCKET_RATE_LIMITING=true

# WebSocket Rate Limiting
WS_MAX_CONNECTIONS_PER_IP=5
WS_MAX_CONNECTIONS_PER_TENANT=10
WS_MAX_MESSAGES_PER_SECOND=10

# Data Export Configuration
S3_BUCKET=your-exports-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
EXPORT_RATE_LIMIT_DAYS=7
EXPORT_MAX_FILE_SIZE_MB=100

# Redis Configuration (ensure it's configured)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your-redis-password
REDIS_DB=0
```

## Step 4: Install Dependencies

Install the new dependencies required for the features:

```bash
# Install production dependencies
npm install

# The following new packages are included:
# - archiver (for ZIP creation)
# - csv-writer (for CSV export)
# - bull (for background job processing)
# - aws-sdk (for S3 integration)
```

## Step 5: Local Development Setup

For local development, start the services:

```bash
# Start the main application
npm start

# Start the data export worker (in separate terminal)
npm run worker

# Start WebSocket server (if using NestJS)
npm run start:ws
```

## Step 6: Docker Deployment

Build and test the Docker image:

```bash
# Build the Docker image
docker build -t substream-backend:latest .

# Test the container locally
docker run -p 3000:3000 --env-file .env substream-backend:latest

# Verify health check
curl http://localhost:3000/health
```

## Step 7: Kubernetes Deployment

### 7.1 Create Secrets

Create the Kubernetes secrets with your actual values:

```bash
# Create secrets file with actual values
cat > k8s/secrets-production.yaml << EOF
apiVersion: v1
kind: Secret
metadata:
  name: substream-secrets
  namespace: substream
type: Opaque
data:
  redis-password: $(echo -n "your-redis-password" | base64)
  s3-access-key-id: $(echo -n "your-s3-access-key" | base64)
  s3-secret-access-key: $(echo -n "your-s3-secret-key" | base64)
  creator-auth-secret: $(echo -n "your-auth-secret" | base64)
  # ... add other secrets as needed
EOF

# Apply secrets
kubectl apply -f k8s/secrets-production.yaml
```

### 7.2 Deploy to Kubernetes

```bash
# Create namespace
kubectl create namespace substream

# Apply ConfigMap
kubectl apply -f k8s/configmap.yaml

# Apply Secrets
kubectl apply -f k8s/secrets.yaml

# Apply Deployment
kubectl apply -f k8s/deployment.yaml

# Check deployment status
kubectl get pods -n substream
kubectl logs -f deployment/substream-backend -n substream
```

### 7.3 Verify Deployment

```bash
# Check service status
kubectl get svc -n substream

# Port forward for testing
kubectl port-forward service/substream-backend-service 3000:80 -n substream

# Test health endpoint
curl http://localhost:3000/health
```

## Step 8: Feature Flag Initialization

Initialize default feature flags for existing tenants:

```bash
# Run the initialization script (create this if needed)
node scripts/initializeFeatureFlags.js

# Or manually update via API
curl -X PUT http://localhost:3000/api/v1/config/flags/enable_data_export \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"value": true, "reason": "Enable data export feature"}'
```

## Step 9: Testing the Implementation

### 9.1 Feature Flags Testing

```bash
# Test feature flag evaluation
curl http://localhost:3000/api/v1/config/flags \
  -H "Authorization: Bearer your-token"

# Test admin override
curl -X PUT http://localhost:3000/api/v1/admin/tenants/{tenant-id}/flags/enable_data_export \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"value": true, "reason": "Admin override"}'
```

### 9.2 Data Export Testing

```bash
# Request data export
curl -X POST http://localhost:3000/api/v1/merchants/export-data \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"format": "json", "email": "test@example.com"}'

# Check export status
curl http://localhost:3000/api/v1/merchants/export-data/{export-id}/status \
  -H "Authorization: Bearer your-token"
```

### 9.3 WebSocket Rate Limiting Testing

```bash
# Test WebSocket connection limits
# Use WebSocket client to connect multiple times from same IP
# Verify rate limiting kicks in after 5 connections

# Test message rate limiting
# Send messages rapidly through WebSocket
# Verify throttling after 10 messages per second
```

## Step 10: Monitoring and Alerting

### 10.1 Health Checks

Monitor these endpoints:
- `/health` - Application health
- `/ready` - Readiness probe
- `/api/v1/config/metrics` - Feature flag metrics
- WebSocket connection statistics

### 10.2 Key Metrics to Monitor

- Feature flag evaluation latency (should be <1ms)
- Data export job queue length
- WebSocket connection counts
- Rate limit violations
- Redis performance
- Database query performance

### 10.3 Alerting Setup

Set up alerts for:
- Feature flag evaluation latency >5ms
- Data export job failures
- WebSocket connection limit violations
- Redis connection failures
- High memory/CPU usage

## Step 11: Security Considerations

### 11.1 Review Security Settings

- Verify Redis is secured with authentication
- Ensure S3 bucket has proper IAM policies
- Review rate limiting thresholds
- Validate audit log retention policies

### 11.2 Security Testing

```bash
# Test rate limiting bypass attempts
# Test unauthorized access to admin endpoints
# Test data export access controls
# Verify audit trail integrity
```

## Step 12: Performance Optimization

### 12.1 Database Optimization

```sql
-- Create recommended indexes if not automatically created
CREATE INDEX CONCURRENTLY idx_tenant_config_tenant_flag 
ON tenant_configurations(tenant_id, flag_name);

CREATE INDEX CONCURRENTLY idx_export_tenant_status 
ON data_export_requests(tenant_id, status);

CREATE INDEX CONCURRENTLY idx_ws_log_timestamp 
ON websocket_rate_limit_log(created_at);
```

### 12.2 Redis Optimization

```bash
# Monitor Redis memory usage
redis-cli info memory

# Set appropriate eviction policies
redis-cli config set maxmemory-policy allkeys-lru

# Monitor slow queries
redis-cli slowlog get 10
```

## Step 13: Rollback Plan

If issues arise, rollback procedures:

### 13.1 Database Rollback

```bash
# Rollback migrations
npm run migrate:rollback

# Or rollback specific migrations
npm run migrate:down 010_add_websocket_rate_limit_log
npm run migrate:down 009_add_data_export_tracking
npm run migrate:down 008_add_tenant_feature_flags
```

### 13.2 Application Rollback

```bash
# Revert to previous commit
git checkout previous-stable-branch

# Redeploy previous version
kubectl rollout undo deployment/substream-backend -n substream
```

## Step 14: Documentation Updates

Update the following documentation:
- API documentation with new endpoints
- Deployment guides
- User guides for data export
- Admin guides for feature flags
- Security documentation

## Support and Troubleshooting

### Common Issues

1. **Feature flag caching issues**
   - Clear Redis cache: `redis-cli flushall`
   - Restart application

2. **Data export failures**
   - Check S3 credentials and permissions
   - Verify BullMQ worker is running
   - Check database connectivity

3. **WebSocket rate limiting not working**
   - Verify Redis connectivity
   - Check middleware configuration
   - Review rate limit thresholds

### Log Locations

- Application logs: Check container logs
- Database logs: PostgreSQL logs
- Redis logs: Redis server logs
- Worker logs: BullMQ worker logs

### Support Contacts

- Development team: dev-team@substream.app
- Operations: ops-team@substream.app
- Security: security@substream.app

---

## Production Readiness Checklist

- [ ] All database migrations run successfully
- [ ] Environment variables configured
- [ ] Redis cluster operational
- [ ] S3 bucket configured and accessible
- [ ] Kubernetes deployment successful
- [ ] Health checks passing
- [ ] Feature flags tested
- [ ] Data export tested
- [ ] WebSocket rate limiting tested
- [ ] Monitoring and alerting configured
- [ ] Security review completed
- [ ] Performance benchmarks met
- [ ] Documentation updated
- [ ] Rollback plan tested

Once all items are checked, the implementation is ready for production deployment!
