/**
 * Behavioral Biometric Frontend Tracking Library
 * Silently tracks user interaction patterns for bot detection
 */
class BehavioralTracker {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      apiEndpoint: config.apiEndpoint || '/api/behavioral',
      sampleRate: config.sampleRate || 1.0,
      batchSize: config.batchSize || 10,
      flushInterval: config.flushInterval || 5000, // 5 seconds
      maxEventsPerSession: config.maxEventsPerSession || 1000,
      sessionTimeout: config.sessionTimeout || 30 * 60 * 1000, // 30 minutes
      debug: config.debug || false
    };

    // Session management
    this.sessionId = null;
    this.userId = null;
    this.sessionStartTime = null;
    this.eventQueue = [];
    this.isTracking = false;
    
    // Event tracking
    this.eventListeners = new Map();
    this.lastEventTime = null;
    this.eventCount = 0;
    
    // Performance monitoring
    this.performanceMetrics = {
      eventsCollected: 0,
      eventsSent: 0,
      errors: 0,
      averageLatency: 0
    };

    // Initialize if enabled
    if (this.config.enabled) {
      this.initialize();
    }
  }

  /**
   * Initialize behavioral tracking
   */
  initialize() {
    try {
      // Generate or retrieve session ID
      this.sessionId = this.getOrCreateSessionId();
      this.sessionStartTime = Date.now();
      this.isTracking = true;

      // Start session
      this.startSession();

      // Set up event listeners
      this.setupEventListeners();

      // Start periodic flush
      this.startPeriodicFlush();

      // Handle page unload
      this.setupPageUnloadHandler();

      this.log('Behavioral tracking initialized', {
        sessionId: this.sessionId
      });

    } catch (error) {
      this.logError('Failed to initialize behavioral tracking', error);
    }
  }

  /**
   * Get or create session ID
   * @returns {string} Session ID
   */
  getOrCreateSessionId() {
    // Try to get existing session ID from storage
    let sessionId = sessionStorage.getItem('behavioral_session_id');
    
    if (!sessionId) {
      // Generate new session ID
      sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      sessionStorage.setItem('behavioral_session_id', sessionId);
    }
    
    return sessionId;
  }

  /**
   * Start session with backend
   */
  async startSession() {
    try {
      const sessionData = {
        userAgent: navigator.userAgent,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        platform: navigator.platform,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen: {
          width: screen.width,
          height: screen.height
        },
        colorDepth: screen.colorDepth,
        pixelRatio: window.devicePixelRatio,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        connection: this.getConnectionInfo()
      };

      const response = await this.sendRequest('POST', '/session/start', {
        sessionId: this.sessionId,
        sessionData
      });

      if (response.tracking) {
        this.userId = response.fingerprint;
        this.log('Session started successfully', {
          sessionId: this.sessionId,
          fingerprint: response.fingerprint
        });
      }

    } catch (error) {
      this.logError('Failed to start session', error);
    }
  }

  /**
   * Get connection information
   * @returns {object} Connection info
   */
  getConnectionInfo() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    
    if (!connection) {
      return {};
    }

    return {
      effectiveType: connection.effectiveType,
      downlink: connection.downlink,
      rtt: connection.rtt,
      saveData: connection.saveData
    };
  }

  /**
   * Setup event listeners for behavioral tracking
   */
  setupEventListeners() {
    // Mouse events
    this.addEventListener(document, 'mousemove', this.handleMouseMove.bind(this));
    this.addEventListener(document, 'mousedown', this.handleMouseDown.bind(this));
    this.addEventListener(document, 'mouseup', this.handleMouseUp.bind(this));
    this.addEventListener(document, 'click', this.handleClick.bind(this));
    this.addEventListener(document, 'dblclick', this.handleDoubleClick.bind(this));
    this.addEventListener(document, 'contextmenu', this.handleContextMenu.bind(this));

    // Keyboard events
    this.addEventListener(document, 'keydown', this.handleKeyDown.bind(this));
    this.addEventListener(document, 'keyup', this.handleKeyUp.bind(this));
    this.addEventListener(document, 'keypress', this.handleKeyPress.bind(this));

    // Scroll events
    this.addEventListener(window, 'scroll', this.handleScroll.bind(this));
    this.addEventListener(window, 'wheel', this.handleWheel.bind(this));

    // Touch events (mobile)
    if ('ontouchstart' in window) {
      this.addEventListener(document, 'touchstart', this.handleTouchStart.bind(this));
      this.addEventListener(document, 'touchmove', this.handleTouchMove.bind(this));
      this.addEventListener(document, 'touchend', this.handleTouchEnd.bind(this));
    }

    // Focus events
    this.addEventListener(window, 'focus', this.handleFocus.bind(this));
    this.addEventListener(window, 'blur', this.handleBlur.bind(this));

    // Visibility change
    this.addEventListener(document, 'visibilitychange', this.handleVisibilityChange.bind(this));

    // Page navigation
    this.addEventListener(window, 'beforeunload', this.handleBeforeUnload.bind(this));
  }

  /**
   * Add event listener with error handling
   * @param {Element} element - Target element
   * @param {string} eventType - Event type
   * @param {Function} handler - Event handler
   */
  addEventListener(element, eventType, handler) {
    try {
      const wrappedHandler = (event) => {
        try {
          handler(event);
        } catch (error) {
          this.logError(`Error in ${eventType} handler`, error);
        }
      };

      element.addEventListener(eventType, wrappedHandler, { passive: true });
      
      // Store reference for cleanup
      if (!this.eventListeners.has(element)) {
        this.eventListeners.set(element, []);
      }
      this.eventListeners.get(element).push({ eventType, handler: wrappedHandler });
      
    } catch (error) {
      this.logError(`Failed to add ${eventType} listener`, error);
    }
  }

  /**
   * Handle mouse move events
   * @param {MouseEvent} event - Mouse event
   */
  handleMouseMove(event) {
    if (!this.shouldTrackEvent()) return;

    this.recordEvent('mousemove', {
      coordinates: {
        x: event.clientX,
        y: event.clientY
      },
      targetElement: this.getTargetElement(event.target),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      movementSpeed: this.calculateMovementSpeed(event),
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle mouse down events
   * @param {MouseEvent} event - Mouse event
   */
  handleMouseDown(event) {
    if (!this.shouldTrackEvent()) return;

    this.recordEvent('mousedown', {
      coordinates: {
        x: event.clientX,
        y: event.clientY
      },
      targetElement: this.getTargetElement(event.target),
      button: event.button,
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle mouse up events
   * @param {MouseEvent} event - Mouse event
   */
  handleMouseUp(event) {
    if (!this.shouldTrackEvent()) return;

    this.recordEvent('mouseup', {
      coordinates: {
        x: event.clientX,
        y: event.clientY
      },
      targetElement: this.getTargetElement(event.target),
      button: event.button,
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle click events
   * @param {MouseEvent} event - Click event
   */
  handleClick(event) {
    if (!this.shouldTrackEvent()) return;

    this.recordEvent('click', {
      coordinates: {
        x: event.clientX,
        y: event.clientY
      },
      targetElement: this.getTargetElement(event.target),
      button: event.button,
      clickCount: event.detail || 1,
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle double click events
   * @param {MouseEvent} event - Double click event
   */
  handleDoubleClick(event) {
    if (!this.shouldTrackEvent()) return;

    this.recordEvent('dblclick', {
      coordinates: {
        x: event.clientX,
        y: event.clientY
      },
      targetElement: this.getTargetElement(event.target),
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle context menu events
   * @param {MouseEvent} event - Context menu event
   */
  handleContextMenu(event) {
    if (!this.shouldTrackEvent()) return;

    this.recordEvent('contextmenu', {
      coordinates: {
        x: event.clientX,
        y: event.clientY
      },
      targetElement: this.getTargetElement(event.target),
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle key down events
   * @param {KeyboardEvent} event - Keyboard event
   */
  handleKeyDown(event) {
    if (!this.shouldTrackEvent()) return;

    this.recordEvent('keydown', {
      key: event.key,
      code: event.code,
      location: event.location,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle key up events
   * @param {KeyboardEvent} event - Keyboard event
   */
  handleKeyUp(event) {
    if (!this.shouldTrackEvent()) return;

    this.recordEvent('keyup', {
      key: event.key,
      code: event.code,
      location: event.location,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle key press events
   * @param {KeyboardEvent} event - Keyboard event
   */
  handleKeyPress(event) {
    if (!this.shouldTrackEvent()) return;

    this.recordEvent('keypress', {
      key: event.key,
      code: event.code,
      charCode: event.charCode,
      location: event.location,
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle scroll events
   * @param {Event} event - Scroll event
   */
  handleScroll(event) {
    if (!this.shouldTrackEvent()) return;

    this.recordEvent('scroll', {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      scrollDelta: this.calculateScrollDelta(event),
      targetElement: this.getTargetElement(event.target),
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle wheel events
   * @param {WheelEvent} event - Wheel event
   */
  handleWheel(event) {
    if (!this.shouldTrackEvent()) return;

    this.recordEvent('wheel', {
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaZ: event.deltaZ,
      deltaMode: event.deltaMode,
      targetElement: this.getTargetElement(event.target),
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle touch start events (mobile)
   * @param {TouchEvent} event - Touch event
   */
  handleTouchStart(event) {
    if (!this.shouldTrackEvent()) return;

    const touches = Array.from(event.touches).map(touch => ({
      identifier: touch.identifier,
      coordinates: {
        x: touch.clientX,
        y: touch.clientY
      },
      force: touch.force,
      radiusX: touch.radiusX,
      radiusY: touch.radiusY
    }));

    this.recordEvent('touchstart', {
      touches,
      targetElement: this.getTargetElement(event.target),
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle touch move events (mobile)
   * @param {TouchEvent} event - Touch event
   */
  handleTouchMove(event) {
    if (!this.shouldTrackEvent()) return;

    const touches = Array.from(event.touches).map(touch => ({
      identifier: touch.identifier,
      coordinates: {
        x: touch.clientX,
        y: touch.clientY
      },
      force: touch.force,
      radiusX: touch.radiusX,
      radiusY: touch.radiusY
    }));

    this.recordEvent('touchmove', {
      touches,
      targetElement: this.getTargetElement(event.target),
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle touch end events (mobile)
   * @param {TouchEvent} event - Touch event
   */
  handleTouchEnd(event) {
    if (!this.shouldTrackEvent()) return;

    const touches = Array.from(event.touches).map(touch => ({
      identifier: touch.identifier,
      coordinates: {
        x: touch.clientX,
        y: touch.clientY
      },
      force: touch.force,
      radiusX: touch.radiusX,
      radiusY: touch.radiusY
    }));

    this.recordEvent('touchend', {
      touches,
      targetElement: this.getTargetElement(event.target),
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle focus events
   * @param {FocusEvent} event - Focus event
   */
  handleFocus(event) {
    if (!this.shouldTrackEvent()) return;

    this.recordEvent('focus', {
      targetElement: this.getTargetElement(event.target),
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle blur events
   * @param {FocusEvent} event - Blur event
   */
  handleBlur(event) {
    if (!this.shouldTrackEvent()) return;

    this.recordEvent('blur', {
      targetElement: this.getTargetElement(event.target),
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle visibility change events
   * @param {Event} event - Visibility change event
   */
  handleVisibilityChange(event) {
    this.recordEvent('visibilitychange', {
      hidden: document.hidden,
      visibilityState: document.visibilityState,
      timestamp: event.timeStamp || Date.now()
    });
  }

  /**
   * Handle before unload events
   * @param {Event} event - Before unload event
   */
  handleBeforeUnload(event) {
    // End session when user leaves
    this.endSession();
  }

  /**
   * Setup page unload handler
   */
  setupPageUnloadHandler() {
    // Multiple approaches for different browsers
    window.addEventListener('beforeunload', () => {
      this.endSession();
    });

    window.addEventListener('pagehide', () => {
      this.endSession();
    });

    // For older browsers
    window.addEventListener('unload', () => {
      this.endSession();
    });
  }

  /**
   * Check if event should be tracked
   * @returns {boolean} Whether to track the event
   */
  shouldTrackEvent() {
    // Check if tracking is enabled
    if (!this.isTracking) return false;

    // Check sample rate
    if (Math.random() > this.config.sampleRate) return false;

    // Check event limit
    if (this.eventCount >= this.config.maxEventsPerSession) return false;

    // Check session timeout
    if (Date.now() - this.sessionStartTime > this.config.sessionTimeout) {
      this.endSession();
      this.initialize(); // Restart session
      return false;
    }

    return true;
  }

  /**
   * Record behavioral event
   * @param {string} eventType - Event type
   * @param {object} eventData - Event data
   */
  recordEvent(eventType, eventData) {
    try {
      const event = {
        type: eventType,
        timestamp: eventData.timestamp || Date.now(),
        sessionId: this.sessionId,
        ...eventData
      };

      // Add to queue
      this.eventQueue.push(event);
      this.eventCount++;
      this.lastEventTime = Date.now();

      // Flush queue if batch size reached
      if (this.eventQueue.length >= this.config.batchSize) {
        this.flushEvents();
      }

      this.performanceMetrics.eventsCollected++;

    } catch (error) {
      this.logError('Failed to record event', error);
    }
  }

  /**
   * Start periodic flush of events
   */
  startPeriodicFlush() {
    this.flushInterval = setInterval(() => {
      if (this.eventQueue.length > 0) {
        this.flushEvents();
      }
    }, this.config.flushInterval);
  }

  /**
   * Flush events to backend
   */
  async flushEvents() {
    if (this.eventQueue.length === 0) return;

    const events = this.eventQueue.splice(0, this.config.batchSize);
    const startTime = Date.now();

    try {
      const response = await this.sendRequest('POST', '/events/batch', {
        sessionId: this.sessionId,
        events: events
      });

      if (response.recorded) {
        this.performanceMetrics.eventsSent += events.length;
        const latency = Date.now() - startTime;
        
        // Update average latency
        const totalLatency = this.performanceMetrics.averageLatency * this.performanceMetrics.eventsSent + latency;
        this.performanceMetrics.averageLatency = totalLatency / (this.performanceMetrics.eventsSent + events.length);

        this.log('Events flushed successfully', {
          eventCount: events.length,
          latency,
          totalEvents: this.performanceMetrics.eventsSent
        });
      }

    } catch (error) {
      this.logError('Failed to flush events', error);
      this.performanceMetrics.errors++;
      
      // Put events back in queue for retry
      this.eventQueue.unshift(...events);
    }
  }

  /**
   * Send request to backend API
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint
   * @param {object} data - Request data
   * @returns {Promise} Response
   */
  async sendRequest(method, endpoint, data) {
    const url = this.config.apiEndpoint + endpoint;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Behavioral-Session-Id': this.sessionId
      }
    };

    if (method === 'POST' || method === 'PUT') {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Calculate movement speed
   * @param {MouseEvent} event - Mouse event
   * @returns {number} Movement speed
   */
  calculateMovementSpeed(event) {
    if (!this.lastMouseMoveEvent) {
      this.lastMouseMoveEvent = event;
      return 0;
    }

    const dx = event.clientX - this.lastMouseMoveEvent.clientX;
    const dy = event.clientY - this.lastMouseMoveEvent.clientY;
    const dt = event.timeStamp - this.lastMouseMoveEvent.timeStamp;

    const speed = dt > 0 ? Math.sqrt(dx * dx + dy * dy) / dt : 0;
    
    this.lastMouseMoveEvent = event;
    return speed;
  }

  /**
   * Calculate scroll delta
   * @param {Event} event - Scroll event
   * @returns {number} Scroll delta
   */
  calculateScrollDelta(event) {
    // This is a simplified calculation
    return Math.abs(window.scrollY - (this.lastScrollY || 0));
  }

  /**
   * Get target element information
   * @param {Element} element - Target element
   * @returns {object} Element information
   */
  getTargetElement(element) {
    if (!element) return null;

    const elementInfo = {
      tagName: element.tagName,
      id: element.id,
      className: element.className,
      textContent: element.textContent ? element.textContent.slice(0, 100) : null, // Limit text length
      attributes: {}
    };

    // Add important attributes
    const importantAttrs = ['type', 'name', 'role', 'aria-label', 'title', 'href', 'src', 'alt'];
    importantAttrs.forEach(attr => {
      if (element.hasAttribute(attr)) {
        elementInfo.attributes[attr] = element.getAttribute(attr);
      }
    });

    return elementInfo;
  }

  /**
   * End session tracking
   */
  async endSession() {
    if (!this.isTracking) return;

    try {
      // Flush remaining events
      if (this.eventQueue.length > 0) {
        await this.flushEvents();
      }

      // End session with backend
      const response = await this.sendRequest('POST', '/session/end', {
        sessionId: this.sessionId,
        endTime: Date.now(),
        totalEvents: this.eventCount
      });

      this.log('Session ended', {
        sessionId: this.sessionId,
        duration: Date.now() - this.sessionStartTime,
        totalEvents: this.eventCount,
        performance: this.performanceMetrics
      });

    } catch (error) {
      this.logError('Failed to end session', error);
    } finally {
      // Cleanup
      this.isTracking = false;
      this.eventQueue = [];
      this.eventCount = 0;
      
      if (this.flushInterval) {
        clearInterval(this.flushInterval);
      }
      
      // Remove event listeners
      this.cleanup();
    }
  }

  /**
   * Clean up event listeners
   */
  cleanup() {
    for (const [element, listeners] of this.eventListeners.entries()) {
      listeners.forEach(({ eventType, handler }) => {
        element.removeEventListener(eventType, handler);
      });
    }
    this.eventListeners.clear();
  }

  /**
   * Get performance metrics
   * @returns {object} Performance metrics
   */
  getPerformanceMetrics() {
    return {
      ...this.performanceMetrics,
      queueSize: this.eventQueue.length,
      isTracking: this.isTracking,
      sessionDuration: this.isTracking ? Date.now() - this.sessionStartTime : 0
    };
  }

  /**
   * Log message (debug mode only)
   * @param {string} message - Log message
   * @param {object} data - Additional data
   */
  log(message, data = {}) {
    if (this.config.debug) {
      console.log(`[BehavioralTracker] ${message}`, data);
    }
  }

  /**
   * Log error
   * @param {string} message - Error message
   * @param {Error} error - Error object
   */
  logError(message, error) {
    console.error(`[BehavioralTracker] ${message}`, error);
    this.performanceMetrics.errors++;
  }

  /**
   * Destroy tracker
   */
  destroy() {
    this.endSession();
  }
}

// Auto-initialize if script is loaded
if (typeof window !== 'undefined') {
  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.behavioralTracker = new BehavioralTracker();
    });
  } else {
    window.behavioralTracker = new BehavioralTracker();
  }
}

// Export for manual initialization
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BehavioralTracker;
}
