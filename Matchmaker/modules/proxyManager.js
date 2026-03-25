// Copyright Epic Games, Inc. All Rights Reserved.

/**
 * Proxy Manager
 *
 * Wraps the `http-proxy` library to provide reverse-proxy functionality for
 * routing HTTP and WebSocket traffic to internal Wilbur (Signalling Server)
 * instances. Each user session is proxied to a specific localhost port.
 *
 * Usage:
 *   proxyManager.init({ proxyTimeout: 30000 });
 *   proxyManager.proxyHttp(playerPort, req, res);
 *   proxyManager.proxyWs(playerPort, req, socket, head);
 */

const httpProxy = require('http-proxy');
const logging = require('./logging.js');

class ProxyManager {
    constructor() {
        this.proxy = null;
        this.config = null;
        this.initialized = false;
    }

    /**
     * Initialize the proxy server.
     * @param {Object} options
     * @param {number} [options.proxyTimeout=30000] - Timeout for proxy requests in ms
     */
    init(options = {}) {
        this.config = {
            proxyTimeout: options.proxyTimeout || 30000
        };

        this.proxy = httpProxy.createProxyServer({
            ws: true,
            xfwd: true,              // Automatically add X-Forwarded-* headers
            proxyTimeout: this.config.proxyTimeout,
            timeout: this.config.proxyTimeout
        });

        // Handle proxy errors for HTTP requests
        this.proxy.on('error', (err, req, res) => {
            logging.error(`ProxyManager: HTTP proxy error for ${req.url}: ${err.message}`);

            // res might be a Socket (for WS errors) — only send HTTP response if it's a ServerResponse
            if (res && typeof res.writeHead === 'function' && !res.headersSent) {
                if (err.code === 'ECONNREFUSED') {
                    res.writeHead(502, { 'Content-Type': 'text/plain' });
                    res.end('Bad Gateway: Instance is not available');
                } else if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
                    res.writeHead(504, { 'Content-Type': 'text/plain' });
                    res.end('Gateway Timeout: Instance did not respond in time');
                } else {
                    res.writeHead(502, { 'Content-Type': 'text/plain' });
                    res.end('Bad Gateway: Proxy error');
                }
            }
        });

        this.initialized = true;
        logging.log(`ProxyManager: Initialized (timeout: ${this.config.proxyTimeout}ms)`);
    }

    /**
     * Proxy an HTTP request to the internal Wilbur instance.
     *
     * NOTE: When used with Express `app.use('/session/:sessionId', handler)`,
     * Express automatically strips the mount path from `req.url`. So a request
     * to `/session/abc123/index.js` arrives in the handler with `req.url === '/index.js'`.
     * This means no manual path stripping is needed for HTTP requests.
     *
     * @param {number} playerPort - Internal port of the Wilbur instance
     * @param {http.IncomingMessage} req - The incoming HTTP request
     * @param {http.ServerResponse} res - The HTTP response object
     */
    proxyHttp(playerPort, req, res) {
        if (!this.initialized) {
            logging.error('ProxyManager: Not initialized, cannot proxy HTTP request');
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error: Proxy not initialized');
            return;
        }

        const target = `http://127.0.0.1:${playerPort}`;

        this.proxy.web(req, res, { target }, (err) => {
            // This callback is called on error if no 'error' event listener handles it
            // Our 'error' listener above handles it, so this is a fallback
            logging.error(`ProxyManager: Fallback error handler for HTTP proxy to port ${playerPort}: ${err.message}`);
        });
    }

    /**
     * Proxy a WebSocket upgrade request to the internal Wilbur instance.
     *
     * IMPORTANT: The caller must rewrite `req.url` to strip the `/session/<uuid>`
     * prefix BEFORE calling this method. The `upgrade` event fires on the raw
     * HTTP server, not through Express, so there is no automatic path stripping.
     *
     * @param {number} playerPort - Internal port of the Wilbur instance
     * @param {http.IncomingMessage} req - The upgrade request
     * @param {net.Socket} socket - The network socket
     * @param {Buffer} head - The first packet of the upgraded stream
     */
    proxyWs(playerPort, req, socket, head) {
        if (!this.initialized) {
            logging.error('ProxyManager: Not initialized, cannot proxy WebSocket');
            socket.destroy();
            return;
        }

        const target = `ws://127.0.0.1:${playerPort}`;

        // Handle socket-level errors to prevent unhandled exceptions
        socket.on('error', (err) => {
            logging.error(`ProxyManager: WebSocket socket error on port ${playerPort}: ${err.message}`);
        });

        this.proxy.ws(req, socket, head, { target }, (err) => {
            logging.error(`ProxyManager: WebSocket proxy error to port ${playerPort}: ${err.message}`);
            socket.destroy();
        });
    }

    /**
     * Gracefully shut down the proxy server.
     */
    shutdown() {
        if (this.proxy) {
            this.proxy.close();
            logging.log('ProxyManager: Shut down');
        }
    }
}

module.exports = new ProxyManager();
