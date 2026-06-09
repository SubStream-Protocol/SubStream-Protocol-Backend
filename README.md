# SubStream Protocol Backend

A comprehensive backend API for the SubStream Protocol, supporting wallet-based authentication, tier-based content access, real-time analytics, and multi-region storage replication.

> **Version:** 1.0.0 (Production Ready)

---

## Table of Contents

- [Overview](#overview)
- [Core Architecture](#core-architecture)
- [Features](#features)
- [Quick Start](#quick-start)
- [API Endpoints](#api-endpoints)
- [Security](#security)
- [Deployment](#deployment)
- [Testing](#testing)
- [Contributing](#contributing)

---

## Overview

Enterprise-grade backend for the SubStream Protocol with 28+ production-ready features including real-time analytics, multi-tenancy, fraud prevention, compliance frameworks, and blockchain integration.

---

## Core Architecture

- **API Layer**: Express.js with NestJS integration for real-time features
- **Database**: PostgreSQL with Row-Level Security (RLS) for multi-tenancy
- **Message Queue**: RabbitMQ & BullMQ for async event processing
- **Cache Layer**: Redis for performance optimization and rate limiting
- **Storage**: S3/IPFS for media and data storage
- **Blockchain**: Soroban/Stellar integration for Web3 functionality
- **Real-time**: WebSockets for live analytics and streaming

---

## Features

### Video Transcoding & Streaming
- Multi-resolution transcoding (360p, 720p, 1080p)
- HLS streaming with adaptive bitrate
- Background queue-based transcoding with Redis
- Pay-per-second integration with subscription system
- **Service**: `src/services/videoTranscodingService.js`

### Authentication (SIWE / SEP-10)
- Wallet-based authentication using Sign In With Ethereum/Stellar
- SEP-10 Stellar Web Authentication (nonce-based challenge-response)
- JWT token generation and validation
- Multi-tier user support (Bronze, Silver, Gold)
- **Services**: `src/services/sep10Service.js`, `src/services/stellarAuthService.js`
- **Tests**: `tests/sep10Compliance.test.js`, `tests/sep10Integration.test.js`

### Real-time Analytics
- View-time event aggregation
- On-chain withdrawal event tracking
- Heatmap generation for content engagement
- Server-sent events and WebSocket streaming
- Creator analytics dashboard with MRR and churn metrics
- **Service**: `src/services/mrrAnalyticsService.js`
- **WebSocket**: `src/websocket/websocket.gateway.ts`

### Row-Level Security (RLS) Multi-Tenancy
- PostgreSQL kernel-level RLS policies preventing cross-tenant data leakage
- Automatic tenant context injection via `SET LOCAL app.current_tenant_id`
- SOC2 compliance with structural data separation
- Sub-100ms query performance with optimized indexes
- **Files**: `migrations/knex/012_implement_rls_multi_tenancy.js`, `src/services/rlsService.js`, `middleware/tenantRls.js`
- **Tests**: `tests/rlsSecurity.test.js`

### Tenant-Level Feature Flag Toggles
- Redis-backed caching with sub-1ms flag evaluation
- Token bucket algorithm for rate limiting
- Audit logging for all configuration changes
- Bulk operations for managing multiple flags
- **Endpoints**: `GET /api/v1/config/flags`, `PUT /api/v1/admin/config/flags/:tenantId/:flagName`
- **Files**: `src/services/tenantFeatureFlagService.js`, `src/middleware/featureFlagMiddleware.js`, `routes/featureFlagRoutes.js`

### Automated Data Export & Portability (GDPR)
- Background job processing with BullMQ
- Streaming architecture using Postgres cursors
- Encrypted ZIP archives with AES-256 S3 encryption
- Multiple formats: JSON and CSV
- 24-hour expiring S3 URLs for secure downloads
- **Endpoints**: `POST /api/v1/merchants/export-data`, `GET /api/v1/merchants/export-data/:exportId/status`
- **Files**: `src/services/dataExportService.js`, `routes/dataExport.js`, `workers/dataExportWorker.js`

### Docker & Kubernetes
- Multi-stage build with Node.js Alpine base
- Non-root user execution (UID 1001) with capability dropping
- Horizontal Pod Autoscaling (HPA)
- Health checks with proper HTTP endpoint validation
- **Image Size**: < 250MB
- **Manifests**: `k8s/`, `helm/`

### Tenant-Level Storage Quotas & Archival
- Tier-based quotas: Free (10K), Pro (100K), Enterprise (unlimited)
- Real-time enforcement with 403 responses
- Automated archival to S3 Glacier
- **Files**: `src/services/storageQuotaService.js`, `src/services/archivalService.js`

### Tenant-Specific API Key Scoping
- Cryptographically secure keys with `sk_` prefix
- bcrypt hashing for plain-text key storage
- Granular permissions (12 specific + admin:all)
- Redis-based per-key rate limiting
- **Files**: `src/services/apiKeyService.js`, `middleware/apiKeyAuth.js`

### Vesting Vault Enhancements
- Proxy/Wasm-Rotation Pattern for contract upgrades
- Schedule Consolidation with weighted average calculations
- Registry Map for active vault contract IDs
- Multi-lingual Token Purchase Agreements (10 languages)
- **Services**: `src/services/sorobanVaultManager.js`, `src/services/vestingScheduleManager.js`

### Device Fingerprinting & Fraud Prevention
- Browser-level device fingerprinting
- Redis-based suspicious activity tracking
- Behavioral biometric analysis for anomaly detection
- **Service**: `src/services/deviceFingerprintService.js`

### IP Intelligence & VPN Detection
- IP geolocation tracking
- VPN/Proxy detection
- Suspicious access pattern detection
- Datacenter identification
- **Service**: `src/services/ipIntelligenceService.js`
- **Tests**: `tests/ipIntelligence.test.js`

### Behavioral Biometric Analysis
- Mouse movement pattern analysis
- Keystroke dynamics monitoring
- Interaction velocity tracking
- **Service**: `src/services/behavioralBiometricService.js`
- **Tests**: `tests/behavioralBiometric.test.js`

### Automated Copyright Fingerprinting
- Perceptual hashing for video content
- Fingerprint matching database
- DMCA compliance
- **Service**: `src/services/automatedCopyrightFingerprinting.js`

### AML/KYC Scanning
- Sanctions list matching
- Risk scoring algorithms
- Document verification
- Transaction monitoring

### Rate Limiting & DDoS Protection
- Per-IP, per-user, and per-API-key rate limiting
- Sliding window algorithm with Redis backing
- **Service**: `src/services/rateLimiterService.js`
- **Tests**: `tests/rateLimiter.test.js`

### Pre-Billing Health Checks
- Account status verification
- Subscription validity checking
- Payment method validation
- **Service**: `src/services/preBillingHealthCheckService.js`
- **Tests**: `tests/preBillingHealthCheck.test.js`

### Subscription Management
- Tier management (Bronze, Silver, Gold)
- Auto-renewal, cancellation, trial periods, grace periods
- **Tests**: `tests/subscription.test.js`

### Stripe Migration & Billing
- Product sync with Stripe
- Subscription management and invoice tracking
- **Service**: `src/services/stripeMigration.js`
- **Tests**: `tests/stripeMigration.test.js`

### PII Scrubbing & Data Privacy
- Configurable PII detection patterns
- Dry-run mode for safety validation
- GDPR/CCPA compliant data deletion
- **Worker**: `workers/piiScrubbingWorker.js`
- **Tests**: `tests/piiScrubbing.test.js`

### Redis Caching Strategy
- Multi-layer cache invalidation
- Cache warming strategies and TTL management
- **Guide**: See deployment docs

### Zero-Downtime Migrations
- Backward-compatible migration patterns
- Health checking before migration application
- Blue-green deployment support
- **Config**: `knexfile.js`
- **Runner**: `migrations/runMigrations.js`, `migrations/healthChecker.js`

### Structured Logging & Error Tracking
- Winston-based structured logging with JSON output
- Sentry integration for real-time error tracking
- Discord webhook notifications for critical errors
- Correlation IDs for request tracing

### Swagger/OpenAPI Documentation
- Automatic API documentation generation
- Interactive Swagger UI at `/api/docs`
- **Generator**: `src/utils/swaggerGenerator.js`

### Distributed Tracing (OpenTelemetry)
- Cross-service transaction debugging
- Performance monitoring and troubleshooting
- **OpenTelemetry SDK**: `src/utils/opentelemetry.js`
- **Tracing Utils**: `src/utils/tracingUtils.js`

### Global Statistics & Aggregation
- Real-time stats calculation
- Historical trend analysis
- **Tests**: `tests/globalStats.test.js`

### Reconciliation Worker
- Daily comparison of on-chain SubscriptionBilled events against vault balances
- Financial data integrity verification
- **Worker**: `workers/reconciliationWorker.js`
- **Tests**: `tests/reconciliationWorker.test.js`

### ScaledUserProp Revenue Division
- ICML 2025 research algorithm for Sybil-resistant revenue division
- Engagement-intensity-based creator payouts
- **Tests**: `tests/scaledUserProp.test.js`

### Scholarship Contract (Soroban)
- Cross-contract call bounds for gas optimization
- Security hardening and reliability improvements
- **Tests**: `tests/scholarshipContract.test.js`

### Subscriber Map Indexing Optimization
- Advanced Postgres indexing for <100ms query times
- Optimized for creators with 10 to 100,000+ subscribers

### Sandbox Environment
- Complete developer testing environment
- Zero-value tokens and testnet blockchain operations
- Safe development without financial risk

### Email Notification Service
- Provider abstraction (AWS SES/SendGrid)
- Asynchronous processing with BullMQ
- Exponential backoff for rate limiting

### Multi-Region Storage
- IPFS content replication across multiple services
- Automatic failover between regions
- Support for Pinata, Web3.Storage, and Infura

### Disaster Recovery
- Database replication and point-in-time recovery
- Backup automation and multi-region failover

### Security Architecture
- mTLS mesh for service-to-service communication
- Secret lifecycle management
- SOC2 compliance framework
- Incident response runbook

---

## Quick Start

### Prerequisites
- Node.js 20.11.0+
- FFmpeg (for video transcoding)
- Redis (for caching and job queue)
- RabbitMQ (for async event processing)
- PostgreSQL

### Installation

```bash
git clone https://github.com/SubStream-Protocol/SubStream-Protocol-Backend.git
cd SubStream-Protocol-Backend
```

Install FFmpeg:
```bash
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y ffmpeg
# macOS
brew install ffmpeg
```

Install Redis:
```bash
# Ubuntu/Debian
sudo apt-get install redis-server && sudo systemctl start redis
# macOS
brew install redis && brew services start redis
```

Install RabbitMQ:
```bash
# Ubuntu/Debian
sudo apt-get install rabbitmq-server && sudo systemctl start rabbitmq-server
# macOS
brew install rabbitmq && brew services start rabbitmq
```

Install and configure:
```bash
npm install
cp .env.example .env
# Configure .env with JWT secret, IPFS keys, Redis, RabbitMQ, S3, FFmpeg path
```

Start services:
```bash
# API + Worker together
npm run dev

# Or separately:
npm run start:dev    # API server
npm run worker:dev   # Background worker
```

API available at `http://localhost:3000`

---

## API Endpoints

### Authentication
- `GET /auth/nonce?address={address}` - Get nonce for SIWE
- `POST /auth/login` - Authenticate with wallet signature

### Content
- `GET /content` - List content (filtered by user tier)
- `GET /content/{id}` - Get specific content
- `POST /content` - Create new content
- `PUT /content/{id}` - Update content (creator only)
- `DELETE /content/{id}` - Delete content (creator only)
- `GET /content/{id}/access` - Check access permissions

### Analytics
- `POST /analytics/view-event` - Record view-time event
- `POST /analytics/withdrawal-event` - Record withdrawal event
- `GET /analytics/heatmap/{videoId}` - Get content heatmap
- `GET /analytics/creator/{address}` - Get creator analytics
- `GET /analytics/stream/{videoId}` - Real-time analytics stream

### Storage
- `POST /storage/pin` - Pin content to multiple regions
- `GET /storage/content/{id}` - Get content with failover
- `GET /storage/health` - Check storage service health

### Feature Flags
- `GET /api/v1/config/flags` - Retrieve tenant flags
- `PUT /api/v1/admin/config/flags/:tenantId/:flagName` - Update flag
- `PUT /api/v1/admin/config/flags/:tenantId/bulk` - Bulk update

### Data Export
- `POST /api/v1/merchants/export-data` - Request export
- `GET /api/v1/merchants/export-data/:exportId/status` - Track progress

### Documentation
- `GET /api/docs` - Interactive Swagger UI
- `GET /` - API information
- `GET /health` - Health check

---

## Security

### Authentication & Authorization
- SEP-10 wallet-based authentication
- JWT token validation
- API key management with bcrypt hashing
- Multi-signature support for admin actions
- Tenant isolation via RLS

### Data Protection
- Row-Level Security at database level
- Encrypted PII scrubbing (GDPR/CCPA)
- AES-256 encryption for sensitive data
- Automatic archival to S3 Glacier

### Infrastructure Security
- mTLS mesh for service-to-service communication
- DDoS protection with multi-layer rate limiting
- IP intelligence filtering
- Behavioral biometric analysis
- Device fingerprinting for fraud prevention

### Compliance & Auditing
- Complete audit logging with immutable trails
- SOC2 compliance framework
- AML/KYC scanning
- DMCA-compliant copyright protection

---

## Deployment

### Local Development
```bash
npm install
redis-server
npm run migrate
npm run dev
```

### Docker
```bash
docker build -t substream-backend:latest .
docker run -p 3000:3000 substream-backend:latest
```

### Kubernetes
```bash
kubectl apply -f k8s/
kubectl get pods
kubectl logs -f deployment/substream-backend
```

### Production Checklist
- [ ] Configure all environment variables (see `.env.example`)
- [ ] Set up PostgreSQL database with RLS
- [ ] Configure Redis cluster
- [ ] Set up RabbitMQ cluster
- [ ] Create S3 buckets
- [ ] Configure CDN
- [ ] Set up monitoring and alerting (Sentry)
- [ ] Enable database backups and disaster recovery
- [ ] Run security audit
- [ ] Enable AML/KYC scanning
- [ ] Configure rate limiting

---

## Testing

```bash
npm test                              # All tests
npm test -- --coverage                # With coverage
npm run test:soroban                  # Soroban tests
npm run test:pii                      # PII scrubbing tests
```

### Test Coverage
- Unit tests for all services
- Integration tests for API endpoints
- Security tests for RLS and authentication
- Performance tests for caching and rate limiting
- Docker build validation
- K8s manifest validation

---

## Project Structure

```
├── routes/              # API route handlers
├── middleware/           # Express middleware
├── services/            # Business logic services
├── workers/             # Background workers (BullMQ)
├── src/                 # NestJS application and utilities
├── migrations/          # Database migrations (Knex)
├── seeds/               # Database seed files
├── contracts/           # Soroban smart contracts
├── tests/               # Test files
├── docs/                # Documentation
├── k8s/                 # Kubernetes manifests
├── helm/                # Helm charts
├── terraform/           # Infrastructure as code
├── scripts/             # Utility scripts
├── index.js             # Main application entry
├── worker.js            # Background worker entry
├── knexfile.js          # Database configuration
├── Dockerfile           # Container build
└── package.json         # Dependencies
```

---

## Environment Variables

See `.env.example` for all available configuration options including:
- `DATABASE_URL` - PostgreSQL connection
- `REDIS_URL` - Redis connection
- `RABBITMQ_URL` - RabbitMQ connection
- `JWT_SECRET` - JWT signing secret
- `SOROBAN_RPC_URL` - Stellar Soroban RPC
- `STRIPE_SECRET_KEY` - Stripe API key
- `IPFS_API_KEY` - IPFS service key
- `SENTRY_DSN` - Sentry error tracking

---

## Contributing

1. Fork the repository
2. Create a feature branch from `main`
3. Implement changes with tests
4. Run full test suite: `npm test`
5. Submit a pull request with detailed description

---

## License

MIT License - see LICENSE file for details.

---

**Status:** Production Ready
