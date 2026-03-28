const express = require('express');
const { logger } = require('../src/utils/logger');

/**
 * Create Behavioral Biometric management routes
 * @param {object} dependencies - Service dependencies
 * @returns {express.Router}
 */
function createBehavioralBiometricRoutes(dependencies = {}) {
  const router = express.Router();
  const behavioralService = dependencies.behavioralService;

  if (!behavioralService) {
    return router.status(503).json({
      success: false,
      error: 'Behavioral biometric service not available'
    });
  }

  /**
   * Start behavioral tracking session
   * POST /api/behavioral/session/start
   */
  router.post('/session/start', async (req, res) => {
    try {
      const { sessionId, sessionData } = req.body;

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          error: 'Session ID is required'
        });
      }

      const result = behavioralService.startSession(sessionId, sessionData);
      
      return res.status(200).json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.error('Error starting behavioral session', {
        error: error.message,
        sessionId: req.body?.sessionId,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to start behavioral session'
      });
    }
  });

  /**
   * Record behavioral events
   * POST /api/behavioral/events/batch
   */
  router.post('/events/batch', async (req, res) => {
    try {
      const { sessionId, events } = req.body;

      if (!sessionId || !Array.isArray(events)) {
        return res.status(400).json({
          success: false,
          error: 'Session ID and events array are required'
        });
      }

      const results = [];
      
      for (const event of events) {
        const result = behavioralService.recordEvent(sessionId, event);
        results.push(result);
      }

      const recordedCount = results.filter(r => r.recorded).length;
      
      return res.status(200).json({
        success: true,
        data: {
          recorded: recordedCount,
          total: events.length,
          results
        }
      });

    } catch (error) {
      logger.error('Error recording behavioral events', {
        error: error.message,
        sessionId: req.body?.sessionId,
        eventCount: req.body?.events?.length,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to record behavioral events'
      });
    }
  });

  /**
   * End behavioral tracking session
   * POST /api/behavioral/session/end
   */
  router.post('/session/end', async (req, res) => {
    try {
      const { sessionId, endTime, totalEvents } = req.body;

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          error: 'Session ID is required'
        });
      }

      const result = behavioralService.endSession(sessionId);
      
      return res.status(200).json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.error('Error ending behavioral session', {
        error: error.message,
        sessionId: req.body?.sessionId,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to end behavioral session'
      });
    }
  });

  /**
   * Analyze session for bot detection
   * POST /api/behavioral/session/analyze
   */
  router.post('/session/analyze', async (req, res) => {
    try {
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          error: 'Session ID is required'
        });
      }

      const result = behavioralService.analyzeSession(sessionId);
      
      return res.status(200).json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.error('Error analyzing behavioral session', {
        error: error.message,
        sessionId: req.body?.sessionId,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to analyze behavioral session'
      });
    }
  });

  /**
   * Get behavioral analytics
   * GET /api/behavioral/analytics
   */
  router.get('/analytics', async (req, res) => {
    try {
      const { period = '24h', includeDetails = 'false' } = req.query;

      const analytics = behavioralService.getBehavioralAnalytics({
        period,
        includeDetails: includeDetails === 'true'
      });
      
      return res.status(200).json({
        success: true,
        data: analytics
      });

    } catch (error) {
      logger.error('Error getting behavioral analytics', {
        error: error.message,
        period: req.query.period,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to get behavioral analytics'
      });
    }
  });

  /**
   * Check if address is on high-risk watch list
   * GET /api/behavioral/watchlist/:stellarAddress
   */
  router.get('/watchlist/:stellarAddress', async (req, res) => {
    try {
      const { stellarAddress } = req.params;

      if (!stellarAddress) {
        return res.status(400).json({
          success: false,
          error: 'Stellar address is required'
        });
      }

      const result = behavioralService.checkWatchList(stellarAddress);
      
      return res.status(200).json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.error('Error checking watch list', {
        error: error.message,
        stellarAddress: req.params.stellarAddress,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to check watch list'
      });
    }
  });

  /**
   * Get service statistics
   * GET /api/behavioral/stats
   */
  router.get('/stats', async (req, res) => {
    try {
      const stats = behavioralService.getServiceStats();
      
      return res.status(200).json({
        success: true,
        data: stats
      });

    } catch (error) {
      logger.error('Error getting behavioral stats', {
        error: error.message,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to get behavioral stats'
      });
    }
  });

  /**
   * Clean up old data
   * POST /api/behavioral/cleanup
   */
  router.post('/cleanup', async (req, res) => {
    try {
      behavioralService.cleanupOldData();
      
      return res.status(200).json({
        success: true,
        message: 'Old behavioral data cleaned up successfully'
      });

    } catch (error) {
      logger.error('Error cleaning up behavioral data', {
        error: error.message,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to clean up behavioral data'
      });
    }
  });

  /**
   * Get session details
   * GET /api/behavioral/session/:sessionId
   */
  router.get('/session/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          error: 'Session ID is required'
        });
      }

      const session = behavioralService.activeSessions.get(sessionId);
      
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          sessionId,
          startTime: session.startTime,
          totalEvents: session.totalEvents,
          botScore: session.botScore,
          riskLevel: session.riskLevel,
          isFlagged: session.isFlagged,
          isThrottled: session.isThrottled,
          duration: Date.now() - new Date(session.startTime).getTime()
        }
      });

    } catch (error) {
      logger.error('Error getting session details', {
        error: error.message,
        sessionId: req.params.sessionId,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to get session details'
      });
    }
  });

  /**
   * Get active sessions
   * GET /api/behavioral/sessions/active
   */
  router.get('/sessions/active', async (req, res) => {
    try {
      const activeSessions = Array.from(behavioralService.activeSessions.entries()).map(([sessionId, session]) => ({
        sessionId,
        startTime: session.startTime,
        totalEvents: session.totalEvents,
        botScore: session.botScore,
        riskLevel: session.riskLevel,
        isFlagged: session.isFlagged,
        isThrottled: session.isThrottled,
        duration: Date.now() - new Date(session.startTime).getTime()
      }));

      return res.status(200).json({
        success: true,
        data: {
          activeSessions,
          count: activeSessions.length
        }
      });

    } catch (error) {
      logger.error('Error getting active sessions', {
        error: error.message,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to get active sessions'
      });
    }
  });

  /**
   * Export behavioral data
   * GET /api/behavioral/export
   */
  router.get('/export', async (req, res) => {
    try {
      const { 
        period = '24h', 
        format = 'json', 
        includeDetails = 'false',
        type = 'all' 
      } = req.query;

      let data;
      let filename;
      let contentType;

      switch (type) {
        case 'sessions':
          data = await this.exportSessions(period, includeDetails === 'true');
          filename = `behavioral_sessions_${period}.${format}`;
          break;
        case 'events':
          data = await this.exportEvents(period);
          filename = `behavioral_events_${period}.${format}`;
          break;
        case 'watchlist':
          data = await this.exportWatchList();
          filename = `behavioral_watchlist.${format}`;
          break;
        case 'all':
        default:
          data = await this.exportAllData(period, includeDetails === 'true');
          filename = `behavioral_export_${period}.${format}`;
          break;
      }

      // Format response
      if (format === 'csv') {
        contentType = 'text/csv';
        data = this.convertToCSV(data);
      } else if (format === 'xml') {
        contentType = 'application/xml';
        data = this.convertToXML(data);
      } else {
        contentType = 'application/json';
        data = JSON.stringify(data, null, 2);
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.status(200).send(data);

    } catch (error) {
      logger.error('Error exporting behavioral data', {
        error: error.message,
        period: req.query.period,
        format: req.query.format,
        type: req.query.type,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to export behavioral data'
      });
    }
  });

  /**
   * Export sessions data
   * @param {string} period - Period string
   * @param {boolean} includeDetails - Include detailed data
   * @returns {object} Sessions data
   */
  async exportSessions(period, includeDetails) {
    const startDate = this.getStartDate(period);
    
    const sessions = behavioralService.database.db.prepare(`
      SELECT * FROM behavioral_sessions 
      WHERE start_time > ?
      ORDER BY start_time DESC
    `).all(startDate.toISOString());

    if (includeDetails) {
      // Add events for each session
      for (const session of sessions) {
        session.events = behavioralService.database.db.prepare(`
          SELECT * FROM behavioral_events 
          WHERE session_id = ?
          ORDER BY timestamp ASC
        `).all(session.session_id);
      }
    }

    return sessions;
  }

  /**
   * Export events data
   * @param {string} period - Period string
   * @returns {object} Events data
   */
  async exportEvents(period) {
    const startDate = this.getStartDate(period);
    
    return behavioralService.database.db.prepare(`
      SELECT * FROM behavioral_events 
      WHERE created_at > ?
      ORDER BY timestamp DESC
    `).all(startDate.toISOString());
  }

  /**
   * Export watch list data
   * @returns {object} Watch list data
   */
  async exportWatchList() {
    return behavioralService.database.db.prepare(`
      SELECT * FROM high_risk_watch_list 
      WHERE is_active = 1 
      ORDER BY added_at DESC
    `).all();
  }

  /**
   * Export all data
   * @param {string} period - Period string
   * @param {boolean} includeDetails - Include detailed data
   * @returns {object} All data
   */
  async exportAllData(period, includeDetails) {
    const [sessions, events, watchList] = await Promise.all([
      this.exportSessions(period, includeDetails),
      this.exportEvents(period),
      this.exportWatchList()
    ]);

    return {
      sessions,
      events,
      watchList,
      exportedAt: new Date().toISOString(),
      period,
      includeDetails
    };
  }

  /**
   * Convert data to CSV format
   * @param {object} data - Data to convert
   * @returns {string} CSV string
   */
  convertToCSV(data) {
    if (Array.isArray(data)) {
      if (data.length === 0) return '';
      
      const headers = Object.keys(data[0]);
      const csvRows = [headers.join(',')];
      
      for (const row of data) {
        const values = headers.map(header => {
          let value = row[header];
          if (value === null || value === undefined) return '';
          if (typeof value === 'object') value = JSON.stringify(value);
          return `"${String(value).replace(/"/g, '""')}"`;
        });
        csvRows.push(values.join(','));
      }
      
      return csvRows.join('\n');
    } else {
      // Convert object to CSV
      const flattenObject = (obj, prefix = '') => {
        const flattened = {};
        for (const [key, value] of Object.entries(obj)) {
          if (value === null || value === undefined) continue;
          
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            Object.assign(flattened, flattenObject(value, prefix ? `${prefix}.${key}` : key));
          } else {
            flattened[prefix ? `${prefix}.${key}` : key] = value;
          }
        }
        return flattened;
      };
      
      const flattened = flattenObject(data);
      const headers = Object.keys(flattened);
      const values = headers.map(header => {
        const value = flattened[header];
        if (value === null || value === undefined) return '';
        if (typeof value === 'object') value = JSON.stringify(value);
        return `"${String(value).replace(/"/g, '""')}"`;
      });
      
      return [headers.join(','), values.join(',')].join('\n');
    }
  }

  /**
   * Convert data to XML format
   * @param {object} data - Data to convert
   * @returns {string} XML string
   */
  convertToXML(data) {
    const objectToXML = (obj, indent = 0) => {
      const spaces = '  '.repeat(indent);
      let xml = '';
      
      for (const [key, value] of Object.entries(obj)) {
        if (value === null || value === undefined) continue;
        
        if (Array.isArray(value)) {
          xml += `${spaces}<${key}>\n`;
          value.forEach(item => {
            if (typeof item === 'object') {
              xml += objectToXML(item, indent + 1);
            } else {
              xml += `${spaces}  <item>${item}</item>\n`;
            }
          });
          xml += `${spaces}</${key}>\n`;
        } else if (typeof value === 'object') {
          xml += `${spaces}<${key}>\n`;
          xml += objectToXML(value, indent + 1);
          xml += `${spaces}</${key}>\n`;
        } else {
          xml += `${spaces}<${key}>${value}</${key}>\n`;
        }
      }
      
      return xml;
    };
    
    return `<?xml version="1.0" encoding="UTF-8"?>\n<data>\n${objectToXML(data, 1)}</data>`;
  }

  /**
   * Get start date for period
   * @param {string} period - Period string
   * @returns {Date} Start date
   */
  getStartDate(period) {
    const now = new Date();
    switch (period) {
      case '1h':
        return new Date(now.getTime() - 60 * 60 * 1000);
      case '24h':
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case '7d':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case '30d':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      default:
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }
  }

  return router;
}

module.exports = { createBehavioralBiometricRoutes };
