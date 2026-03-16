// Copyright Epic Games, Inc. All Rights Reserved.

/**
 * Session Manager
 *
 * Manages user sessions with UUID tokens, time limits, reconnection grace
 * periods, and a waiting queue. Session tokens are stored in browser cookies
 * to survive page reloads.
 */

const crypto = require('crypto');
const logging = require('./logging.js');

class SessionManager {
    constructor() {
        this.sessions = new Map();     // token -> session object
        this.queue = [];               // ordered list of { requestId, resolve, timestamp }
        this.config = null;
        this.initialized = false;

        // Callback invoked when a session expires or grace period ends
        this.onSessionExpired = null;
    }

    /**
     * Initialize with configuration.
     * @param {Object} config
     * @param {number} config.sessionDurationSeconds - Max session time (default: 600)
     * @param {number} config.sessionWarnBeforeEndSeconds - Warning before expiry (default: 60)
     * @param {number} config.reconnectGraceSeconds - Grace period for reconnects (default: 30)
     * @param {string} config.cookieName - Cookie name for session token (default: 'ps_session')
     * @param {Function} onSessionExpired - Callback(token, session) when session expires
     */
    init(config, onSessionExpired) {
        this.config = {
            sessionDurationSeconds: config.sessionDurationSeconds || 600,
            sessionWarnBeforeEndSeconds: config.sessionWarnBeforeEndSeconds || 60,
            reconnectGraceSeconds: config.reconnectGraceSeconds || 30,
            cookieName: config.cookieName || 'ps_session'
        };
        this.onSessionExpired = onSessionExpired || null;
        this.initialized = true;
        logging.log(`SessionManager: Initialized (duration: ${this.config.sessionDurationSeconds}s, grace: ${this.config.reconnectGraceSeconds}s)`);
    }

    /**
     * Create a new session tied to a specific Cirrus server connection key.
     * @param {*} cirrusServerKey - The key identifying the Cirrus server in the cirrusServers Map
     * @param {string} cirrusAddress - The address:port of the assigned Cirrus server
     * @returns {{ token: string, expiresAt: number }}
     */
    createSession(cirrusServerKey, cirrusAddress) {
        const token = crypto.randomUUID();
        const now = Date.now();
        const expiresAt = now + (this.config.sessionDurationSeconds * 1000);

        const session = {
            token,
            cirrusServerKey,
            cirrusAddress,
            createdAt: now,
            expiresAt,
            state: 'active',     // 'active', 'grace', 'expired'
            graceTimer: null,
            expiryTimer: null
        };

        // Set up the session expiry timer
        session.expiryTimer = setTimeout(() => {
            this._expireSession(token);
        }, this.config.sessionDurationSeconds * 1000);

        this.sessions.set(token, session);
        logging.log(`SessionManager: Created session ${token.substring(0, 8)}... for ${cirrusAddress} (expires in ${this.config.sessionDurationSeconds}s)`);

        return { token, expiresAt };
    }

    /**
     * Get session info by token.
     * @param {string} token
     * @returns {Object|null} Session info or null if not found/expired
     */
    getSession(token) {
        if (!token) return null;

        const session = this.sessions.get(token);
        if (!session) return null;

        const now = Date.now();
        const timeRemainingMs = Math.max(0, session.expiresAt - now);

        return {
            token: session.token,
            cirrusServerKey: session.cirrusServerKey,
            cirrusAddress: session.cirrusAddress,
            timeRemainingSeconds: Math.ceil(timeRemainingMs / 1000),
            totalSeconds: this.config.sessionDurationSeconds,
            expired: session.state === 'expired',
            state: session.state,
            warnBeforeEndSeconds: this.config.sessionWarnBeforeEndSeconds,
            createdAt: session.createdAt
        };
    }

    /**
     * Find a session by its assigned Cirrus server key.
     * @param {*} cirrusServerKey
     * @returns {Object|null}
     */
    findSessionByCirrusKey(cirrusServerKey) {
        for (const session of this.sessions.values()) {
            if (session.cirrusServerKey === cirrusServerKey && session.state !== 'expired') {
                return this.getSession(session.token);
            }
        }
        return null;
    }

    /**
     * Start the disconnect grace period for a session.
     * If the user doesn't reconnect within the grace period, the session is destroyed.
     * @param {string} token
     */
    startDisconnectGrace(token) {
        const session = this.sessions.get(token);
        if (!session || session.state === 'expired') return;

        session.state = 'grace';
        logging.log(`SessionManager: Session ${token.substring(0, 8)}... entered grace period (${this.config.reconnectGraceSeconds}s)`);

        session.graceTimer = setTimeout(() => {
            logging.log(`SessionManager: Grace period expired for session ${token.substring(0, 8)}...`);
            this._expireSession(token);
        }, this.config.reconnectGraceSeconds * 1000);
    }

    /**
     * Cancel the grace period (user reconnected).
     * @param {string} token
     */
    cancelGrace(token) {
        const session = this.sessions.get(token);
        if (!session) return;

        if (session.graceTimer) {
            clearTimeout(session.graceTimer);
            session.graceTimer = null;
        }

        if (session.state === 'grace') {
            session.state = 'active';
            logging.log(`SessionManager: Grace period cancelled for session ${token.substring(0, 8)}... (user reconnected)`);
        }
    }

    /**
     * Destroy a session immediately.
     * @param {string} token
     */
    destroySession(token) {
        const session = this.sessions.get(token);
        if (!session) return;

        if (session.expiryTimer) {
            clearTimeout(session.expiryTimer);
            session.expiryTimer = null;
        }
        if (session.graceTimer) {
            clearTimeout(session.graceTimer);
            session.graceTimer = null;
        }

        this.sessions.delete(token);
        logging.log(`SessionManager: Destroyed session ${token.substring(0, 8)}...`);
    }

    /**
     * Add a user to the waiting queue.
     * @returns {{ requestId: string, position: number }}
     */
    enqueue() {
        const requestId = crypto.randomUUID();
        this.queue.push({ requestId, timestamp: Date.now() });
        const position = this.queue.length;
        logging.log(`SessionManager: User ${requestId.substring(0, 8)}... added to queue at position ${position}`);
        return { requestId, position };
    }

    /**
     * Remove the next user from the queue.
     * @returns {{ requestId: string, timestamp: number } | null}
     */
    dequeue() {
        return this.queue.shift() || null;
    }

    /**
     * Get queue status for a specific request or general status.
     * @param {string} [requestId] - Optional specific request ID
     * @returns {{ queueLength: number, position: number|null, estimatedWaitSeconds: number }}
     */
    getQueueStatus(requestId) {
        let position = null;
        if (requestId) {
            const index = this.queue.findIndex(q => q.requestId === requestId);
            position = index >= 0 ? index + 1 : null;
        }

        return {
            queueLength: this.queue.length,
            position,
            estimatedWaitSeconds: this.queue.length * 30  // rough estimate: 30s per instance boot
        };
    }

    /**
     * Get the cookie name for session tokens.
     * @returns {string}
     */
    getCookieName() {
        return this.config ? this.config.cookieName : 'ps_session';
    }

    /**
     * Get the number of active sessions.
     * @returns {number}
     */
    activeCount() {
        let count = 0;
        for (const session of this.sessions.values()) {
            if (session.state !== 'expired') count++;
        }
        return count;
    }

    /**
     * Internal: expire a session and fire the callback.
     * @private
     */
    _expireSession(token) {
        const session = this.sessions.get(token);
        if (!session) return;

        session.state = 'expired';

        if (session.expiryTimer) {
            clearTimeout(session.expiryTimer);
            session.expiryTimer = null;
        }
        if (session.graceTimer) {
            clearTimeout(session.graceTimer);
            session.graceTimer = null;
        }

        logging.log(`SessionManager: Session ${token.substring(0, 8)}... expired`);

        if (this.onSessionExpired) {
            this.onSessionExpired(token, session);
        }

        // Clean up after a short delay to allow final status checks
        setTimeout(() => {
            this.sessions.delete(token);
        }, 60000);
    }
}

module.exports = new SessionManager();
