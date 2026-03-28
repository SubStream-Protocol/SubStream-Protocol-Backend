# Creator Collaboration Revenue Attribution API

## Overview

The Creator Collaboration Revenue Attribution system enables creators to collaborate on content and fairly share the revenue generated through "Drips" (streaming payments). When two or more creators co-author content, the system temporarily overrides the default subscription split for the duration of that specific content, tracks exactly how many seconds were watched, and ensures the payout logic in the smart contract matches the offline attribution during withdrawal cycles.

## Features

- **Co-authored Content Support**: Multiple creators can collaborate on a single piece of content
- **Custom Split Ratios**: Flexible revenue sharing agreements between collaborators
- **Precise Watch Time Tracking**: Accurate second-by-second tracking for collaborative content
- **Temporary Split Overrides**: Collaboration-specific revenue splits that don't affect other content
- **Smart Contract Integration**: Payout data formatted for Stellar smart contract verification
- **Revenue Attribution Verification**: Ensures offline calculations match on-chain payouts
- **Comprehensive Analytics**: Detailed collaboration statistics and performance metrics

## Architecture

### Core Components

1. **CollaborationRevenueService** (`services/collaborationRevenueService.js`)
   - Collaboration creation and management
   - Revenue split calculation and attribution
   - Watch time tracking and aggregation
   - Smart contract payout data generation

2. **CollaborationWatchTimeMiddleware** (`middleware/collaborationWatchTime.js`)
   - Real-time watch time tracking for collaborative content
   - Session management and cleanup
   - WebSocket integration for live updates
   - Performance monitoring and statistics

3. **Collaboration API** (`routes/collaborations.js`)
   - Complete REST API for collaboration management
   - Watch time recording and attribution
   - Revenue calculation and statistics
   - Smart contract integration endpoints

### Database Schema

- `content_collaborations`: Collaboration metadata and tracking
- `collaboration_participants`: Creator participation and split ratios
- `collaboration_watch_logs`: Individual user watch time records
- `revenue_attribution_logs`: Historical attribution calculations
- `content`: Extended with collaboration flags and references

## Collaboration Model

### Revenue Split Logic

```
Total Revenue × Split Ratio = Attributed Revenue

Example:
- Total Revenue: 100 XLM
- Primary Creator: 60% (0.6) → 60 XLM
- Collaborator A: 25% (0.25) → 25 XLM  
- Collaborator B: 15% (0.15) → 15 XLM
```

### Watch Time Tracking

- **Minimum Threshold**: 30 seconds minimum watch time to count
- **User-level Tracking**: Each user's watch time tracked independently
- **Session Management**: Real-time session tracking with automatic cleanup
- **Aggregation**: Watch time aggregated per participant for revenue calculation

### Smart Contract Integration

The system generates payout data that matches smart contract requirements:

```javascript
{
  collaborationId: "collab_1234567890",
  contentId: "content-abc123",
  primaryCreator: "GABC...XYZ",
  participants: [
    {
      creatorAddress: "GABC...XYZ",
      splitRatio: 0.6,
      watchSeconds: 3600,
      attributedRevenue: 60.0
    },
    // ... other participants
  ],
  calculatedAt: "2024-03-15T12:00:00.000Z"
}
```

## API Endpoints

### Collaboration Management

#### Create Collaboration (Creator Only)
```http
POST /api/collaborations
```

**Request Body:**
```json
{
  "contentId": "content-123",
  "collaboratorAddresses": [
    "GDEF...XYZ",
    "GHI...XYZ"
  ],
  "splitRatios": {
    "GABC...XYZ": 0.6,
    "GDEF...XYZ": 0.25,
    "GHI...XYZ": 0.15
  },
  "status": "active"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "collaboration": {
      "id": "collab_abc123",
      "contentId": "content-123",
      "primaryCreatorAddress": "GABC...XYZ",
      "status": "active",
      "totalWatchSeconds": 0,
      "participants": [
        {
          "creatorAddress": "GABC...XYZ",
          "splitRatio": 0.6,
          "role": "primary",
          "watchSeconds": 0
        },
        {
          "creatorAddress": "GDEF...XYZ",
          "splitRatio": 0.25,
          "role": "collaborator",
          "watchSeconds": 0
        }
      ],
      "totalParticipants": 3
    },
    "message": "Collaboration created successfully"
  }
}
```

#### Get Collaboration Details
```http
GET /api/collaborations/:collaborationId
```

#### Update Collaboration Status (Primary Creator Only)
```http
PATCH /api/collaborations/:collaborationId/status
```

**Request Body:**
```json
{
  "status": "completed"
}
```

### Watch Time Tracking

#### Record Watch Time
```http
POST /api/collaborations/watch-time
```

**Request Body:**
```json
{
  "contentId": "content-123",
  "watchSeconds": 120
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "contentId": "content-123",
    "userAddress": "GXYZ...ABC",
    "watchSeconds": 120,
    "result": {
      "isCollaborative": true,
      "recorded": true,
      "collaborationId": "collab_abc123",
      "watchSeconds": 120,
      "totalWatchSeconds": 1500
    }
  }
}
```

### Revenue Attribution

#### Calculate Revenue Attribution
```http
GET /api/collaborations/:collaborationId/attribution
```

**Query Parameters:**
- `startTime`: Period start (ISO date)
- `endTime`: Period end (ISO date)
- `totalRevenue`: Total revenue to attribute

**Response:**
```json
{
  "success": true,
  "data": {
    "attribution": {
      "collaborationId": "collab_abc123",
      "contentId": "content-123",
      "totalRevenue": 100.0,
      "currency": "XLM",
      "totalWatchSeconds": 7200,
      "totalAttributedRevenue": 100.0,
      "totalAttributedWatchTime": 7200,
      "attribution": [
        {
          "creatorAddress": "GABC...XYZ",
          "role": "primary",
          "watchSeconds": 4320,
          "watchTimeShare": 0.6,
          "splitRatio": 0.6,
          "revenueShare": 0.6,
          "attributedRevenue": 60.0,
          "currency": "XLM"
        },
        {
          "creatorAddress": "GDEF...XYZ",
          "role": "collaborator",
          "watchSeconds": 1800,
          "watchTimeShare": 0.25,
          "splitRatio": 0.25,
          "revenueShare": 0.25,
          "attributedRevenue": 25.0,
          "currency": "XLM"
        }
      ],
      "calculatedAt": "2024-03-15T12:00:00.000Z"
    }
  }
}
```

#### Get Content Attribution
```http
GET /api/collaborations/content/:contentId/attribution
```

### Analytics & Statistics

#### Get Creator Statistics (Creator Only)
```http
GET /api/collaborations/stats
```

**Query Parameters:**
- `status`: Filter by collaboration status (default: active)
- `startTime`: Period start
- `endTime`: Period end

**Response:**
```json
{
  "success": true,
  "data": {
    "creatorAddress": "GABC...XYZ",
    "totalCollaborations": 5,
    "totalWatchSeconds": 15000,
    "totalRevenue": 250.0,
    "collaboratorCount": 8,
    "topCollaborators": [
      {
        "creatorAddress": "GDEF...XYZ",
        "collaborationCount": 3,
        "totalWatchSeconds": 8000,
        "avgSplitRatio": 0.3
      }
    ],
    "period": {
      "startTime": "2024-02-15T00:00:00.000Z",
      "endTime": "2024-03-15T00:00:00.000Z",
      "status": "active"
    }
  }
}
```

### Smart Contract Integration

#### Get Payout Data for Smart Contract (Primary Creator Only)
```http
GET /api/collaborations/:collaborationId/payout-data
```

**Response:**
```json
{
  "success": true,
  "data": {
    "payoutData": {
      "collaborationId": "collab_abc123",
      "contentId": "content-123",
      "primaryCreator": "GABC...XYZ",
      "participants": [
        {
          "creatorAddress": "GABC...XYZ",
          "splitRatio": 0.6,
          "watchSeconds": 4320,
          "attributedRevenue": 60.0
        },
        {
          "creatorAddress": "GDEF...XYZ",
          "splitRatio": 0.25,
          "watchSeconds": 1800,
          "attributedRevenue": 25.0
        }
      ],
      "totalWatchSeconds": 7200,
      "calculatedAt": "2024-03-15T12:00:00.000Z",
      "signature": null
    }
  }
}
```

#### Verify Payout Attribution (Primary Creator Only)
```http
POST /api/collaborations/:collaborationId/verify-payout
```

**Request Body:**
```json
{
  "contractPayout": {
    "collaborationId": "collab_abc123",
    "participants": [
      {
        "creatorAddress": "GABC...XYZ",
        "splitRatio": 0.6,
        "watchSeconds": 4320,
        "attributedRevenue": 60.0
      }
    ],
    "totalWatchSeconds": 7200
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "verification": {
      "collaborationId": "collab_abc123",
      "matches": true,
      "discrepancies": [],
      "verifiedAt": "2024-03-15T12:00:00.000Z"
    }
  }
}
```

## Integration with CDN Token System

The collaboration system integrates seamlessly with the existing CDN token infrastructure:

### Enhanced Token Request

When requesting a CDN token for collaborative content:

```javascript
// Standard CDN token request
const tokenResponse = await fetch('/api/cdn/token', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer USER_JWT' },
  body: JSON.stringify({
    walletAddress: 'GXYZ...ABC',
    creatorAddress: 'GABC...XYZ',
    contentId: 'collaborative-content-123',
    segmentPath: 'video/segment1.ts'
  })
});
```

The system automatically detects collaborative content and prepares for watch time tracking.

### Watch Time Recording

After token issuance, watch time is automatically tracked:

```javascript
// Watch time is recorded automatically during content playback
// The middleware detects collaborative content and tracks watch time
// No additional API calls required from the client
```

## WebSocket Integration

For real-time watch time tracking and updates:

```javascript
// Connect to collaboration WebSocket
const ws = new WebSocket('wss://api.substream.protocol/collaborations/ws');

// Start watch time session
ws.send(JSON.stringify({
  type: 'start_session',
  sessionId: 'watch_1234567890',
  contentId: 'collaborative-content-123',
  userAddress: 'GXYZ...ABC'
}));

// Record watch time increments
ws.send(JSON.stringify({
  type: 'watch_time_increment',
  sessionId: 'watch_1234567890',
  seconds: 30
}));

// Get session info
ws.send(JSON.stringify({
  type: 'get_session_info',
  sessionId: 'watch_1234567890'
}));
```

### WebSocket Events

- **session_started**: Watch time session initiated
- **watch_time_recorded**: Watch time increment recorded
- **session_info**: Current session information
- **session_ended**: Session completed and recorded
- **error**: Session-related errors

## Configuration

### Environment Variables

```bash
# Creator Collaboration Configuration
COLLABORATION_ENABLED=true                    # Enable/disable collaboration system
COLLABORATION_DEFAULT_SPLIT_RATIO=0.5         # Default 50/50 split
COLLABORATION_MIN_WATCH_TIME_SECONDS=30        # Minimum watch time to count
COLLABORATION_CACHE_TTL=3600                  # Cache TTL in seconds (1 hour)
COLLABORATION_CACHE_PREFIX=collaboration:      # Redis key prefix
```

### Split Ratio Configuration

Default split ratios can be customized:

```javascript
// Equal split (default)
const splitRatios = {
  'GABC...XYZ': 0.5,
  'GDEF...XYZ': 0.5
};

// Weighted split
const splitRatios = {
  'GABC...XYZ': 0.6,  // Primary creator gets 60%
  'GDEF...XYZ': 0.25, // First collaborator gets 25%
  'GHI...XYZ': 0.15   // Second collaborator gets 15%
};
```

## Use Cases

### Basic Collaboration

```javascript
// Creator sets up collaboration
const collaboration = await fetch('/api/collaborations', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer CREATOR_JWT' },
  body: JSON.stringify({
    contentId: 'interview-episode-1',
    collaboratorAddresses: ['GDEF...XYZ'],
    splitRatios: {
      'GABC...XYZ': 0.7, // Interviewer gets 70%
      'GDEF...XYZ': 0.3  // Guest gets 30%
    }
  })
});
```

### Multi-Creator Collaboration

```javascript
// Multiple creators collaborate
const multiCollab = await fetch('/api/collaborations', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer CREATOR_JWT' },
  body: JSON.stringify({
    contentId: 'panel-discussion-123',
    collaboratorAddresses: ['GDEF...XYZ', 'GHI...XYZ', 'GJKL...MNO'],
    splitRatios: {
      'GABC...XYZ': 0.4,  // Host gets 40%
      'GDEF...XYZ': 0.2,  // Panelist 1 gets 20%
      'GHI...XYZ': 0.2,  // Panelist 2 gets 20%
      'GJKL...MNO': 0.2  // Panelist 3 gets 20%
    }
  })
});
```

### Revenue Attribution

```javascript
// Calculate revenue attribution for a period
const attribution = await fetch('/api/collaborations/collab_123/attribution?startTime=2024-03-01&endTime=2024-03-31&totalRevenue=500', {
  headers: { 'Authorization': 'Bearer CREATOR_JWT' }
});

const result = await attribution.json();
console.log('Revenue attribution:', result.data.attribution);

// Get smart contract payout data
const payoutData = await fetch('/api/collaborations/collab_123/payout-data', {
  headers: { 'Authorization': 'Bearer CREATOR_JWT' }
});

const payout = await payoutData.json();
console.log('Smart contract data:', payout.data.payoutData);
```

### Verification Process

```javascript
// Verify smart contract payout matches offline calculation
const verification = await fetch('/api/collaborations/collab_123/verify-payout', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer CREATOR_JWT' },
  body: JSON.stringify({
    contractPayout: smartContractResult
  })
});

const result = await verification.json();

if (result.data.verification.matches) {
  console.log('Payout verification successful');
} else {
  console.log('Discrepancies found:', result.data.verification.discrepancies);
}
```

## Performance Considerations

### Watch Time Tracking

- **Session Management**: In-memory tracking with Redis persistence
- **Batch Processing**: Watch time aggregated in batches to reduce database load
- **Minimum Threshold**: 30-second minimum prevents spam tracking
- **Automatic Cleanup**: Expired sessions automatically cleaned up

### Caching Strategy

- **Collaboration Data**: 1-hour cache for collaboration metadata
- **Revenue Attribution**: Cached calculations for repeated requests
- **User Sessions**: In-memory session tracking for performance

### Database Optimization

```sql
-- Optimized indexes for performance
CREATE INDEX idx_collaborations_content ON content_collaborations(content_id);
CREATE INDEX idx_participants_collaboration ON collaboration_participants(collaboration_id, creator_address);
CREATE INDEX idx_watch_logs_collaboration ON collaboration_watch_logs(collaboration_id, user_address);
CREATE INDEX idx_watch_logs_time ON collaboration_watch_logs(last_watched_at);
```

## Smart Contract Integration

### Payout Data Format

The system generates payout data compatible with Stellar smart contracts:

```javascript
const payoutData = {
  collaborationId: "collab_abc123",
  contentId: "content-xyz",
  primaryCreator: "GABC...XYZ",
  participants: [
    {
      creatorAddress: "GABC...XYZ",
      splitRatio: 0.6,
      watchSeconds: 3600,
      attributedRevenue: 60.0
    }
  ],
  totalWatchSeconds: 7200,
  calculatedAt: "2024-03-15T12:00:00.000Z"
};
```

### Verification Process

1. **Offline Calculation**: Backend calculates revenue attribution
2. **Smart Contract Payout**: On-chain distribution based on calculation
3. **Verification**: Backend verifies on-chain payout matches offline calculation
4. **Discrepancy Handling**: Any mismatches logged and flagged for review

### Withdrawal Cycle Integration

```javascript
// During withdrawal cycle
const collaborationData = await getActiveCollaborations();
const payoutCalculations = [];

for (const collaboration of collaborationData) {
  const attribution = await calculateRevenueAttribution(collaboration.id);
  const payoutData = formatForSmartContract(attribution);
  payoutCalculations.push(payoutData);
}

// Send to smart contract
const txResult = await executePayouts(payoutCalculations);

// Verify results
for (const payout of payoutCalculations) {
  await verifyPayoutAttribution(payout.collaborationId, txResult);
}
```

## Analytics and Reporting

### Collaboration Metrics

- **Total Collaborations**: Number of collaborative content pieces
- **Revenue Generated**: Total revenue from collaborative content
- **Watch Time Distribution**: How watch time is distributed among collaborators
- **Top Collaborators**: Most frequent collaboration partners
- **Split Ratio Analysis**: Most common split ratios and their effectiveness

### Performance Tracking

```javascript
// Get collaboration statistics
const stats = await fetch('/api/collaborations/stats', {
  headers: { 'Authorization': 'Bearer CREATOR_JWT' }
});

const result = await stats.json();
console.log('Collaboration performance:', result.data);

// Analyze top collaborators
result.data.topCollaborators.forEach(collaborator => {
  console.log(`Collaborated with ${collaborator.creatorAddress} ${collaborator.collaborationCount} times`);
  console.log(`Average split ratio: ${collaborator.avgSplitRatio}`);
  console.log(`Total watch time: ${collaborator.totalWatchSeconds} seconds`);
});
```

## Troubleshooting

### Common Issues

#### Collaboration Not Found

```bash
# Check if collaboration exists for content
curl "https://api.substream.protocol/api/collaborations/content/content-123" \
  -H "Authorization: Bearer TOKEN"
```

#### Watch Time Not Recording

```javascript
// Verify content is collaborative
const collaboration = await getCollaborationForContent(contentId);
if (!collaboration) {
  console.log('Content is not collaborative');
}

// Check minimum watch time threshold
if (watchSeconds < 30) {
  console.log('Watch time below minimum threshold');
}
```

#### Revenue Attribution Mismatch

```javascript
// Verify payout calculation
const verification = await verifyPayoutAttribution(collaborationId, contractPayout);

if (!verification.matches) {
  console.log('Discrepancies:', verification.discrepancies);
  
  // Check specific fields
  verification.discrepancies.forEach(discrepancy => {
    console.log(`${discrepancy.field}: offline=${discrepancy.offline}, contract=${discrepancy.contract}`);
  });
}
```

### Debug Mode

```bash
# Enable debug logging
DEBUG=collaboration:* npm start
```

## Future Enhancements

Planned improvements:

1. **Dynamic Split Ratios**: Split ratios that change based on contribution metrics
2. **Multi-Content Collaborations**: Collaborations spanning multiple content pieces
3. **Revenue Pooling**: Shared revenue pools for creator groups
4. **Automated Split Suggestions**: AI-powered split ratio recommendations
5. **Cross-Platform Collaboration**: Support for collaborations across platforms
6. **Advanced Analytics**: Machine learning for collaboration success prediction
7. **Smart Contract Templates**: Pre-built contract templates for common collaboration types
8. **Real-time Revenue Tracking**: Live revenue attribution during content consumption

## API Examples

### Complete Collaboration Workflow

```javascript
// 1. Create collaboration
const collaboration = await fetch('/api/collaborations', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer CREATOR_JWT' },
  body: JSON.stringify({
    contentId: 'podcast-episode-45',
    collaboratorAddresses: ['GDEF...XYZ', 'GHI...XYZ'],
    splitRatios: {
      'GABC...XYZ': 0.5,  // Host
      'GDEF...XYZ': 0.3,  // Co-host
      'GHI...XYZ': 0.2   // Guest
    }
  })
});

const collabResult = await collaboration.json();
console.log('Collaboration created:', collabResult.data.collaboration.id);

// 2. Content consumption (automatic watch time tracking)
// Users watch the collaborative content through the CDN
// Watch time is automatically recorded by the middleware

// 3. Calculate revenue attribution
const attribution = await fetch(`/api/collaborations/${collabResult.data.collaboration.id}/attribution?totalRevenue=200`, {
  headers: { 'Authorization': 'Bearer CREATOR_JWT' }
});

const attrResult = await attribution.json();
console.log('Revenue attribution:', attrResult.data.attribution);

// 4. Get smart contract payout data
const payoutData = await fetch(`/api/collaborations/${collabResult.data.collaboration.id}/payout-data`, {
  headers: { 'Authorization': 'Bearer CREATOR_JWT' }
});

const payoutResult = await payoutData.json();
console.log('Smart contract data:', payoutResult.data.payoutData);

// 5. Execute smart contract payout (integration point)
const contractResult = await executeSmartContractPayout(payoutResult.data.payoutData);

// 6. Verify payout matches offline calculation
const verification = await fetch(`/api/collaborations/${collabResult.data.collaboration.id}/verify-payout`, {
  method: 'POST',
  headers: { 'Authorization': 'Bearer CREATOR_JWT' },
  body: JSON.stringify({
    contractPayout: contractResult
  })
});

const verifyResult = await verification.json();
console.log('Verification result:', verifyResult.data.verification);
```

### Real-time Watch Time Tracking

```javascript
// WebSocket connection for real-time tracking
const ws = new WebSocket('wss://api.substream.protocol/collaborations/ws');

ws.onopen = () => {
  // Start watching collaborative content
  ws.send(JSON.stringify({
    type: 'start_session',
    sessionId: 'watch_session_123',
    contentId: 'collaborative-content-456',
    userAddress: 'GXYZ...ABC'
  }));
};

// Simulate watch time increments during playback
setInterval(() => {
  ws.send(JSON.stringify({
    type: 'watch_time_increment',
    sessionId: 'watch_session_123',
    seconds: 10 // 10 seconds of watch time
  }));
}, 10000); // Every 10 seconds

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  switch (data.type) {
    case 'watch_time_recorded':
      console.log(`Watch time: ${data.totalWatchTime} seconds`);
      break;
    case 'session_ended':
      console.log('Session completed and recorded');
      break;
    case 'error':
      console.error('Session error:', data.message);
      break;
  }
};
```

---

This Creator Collaboration Revenue Attribution system enables fair and transparent revenue sharing for collaborative content, ensuring that all creators receive their proper share based on agreed-upon split ratios and actual watch time contributions.
