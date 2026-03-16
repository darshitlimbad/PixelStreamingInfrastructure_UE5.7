// Copyright Epic Games, Inc. All Rights Reserved.
var enableRedirectionLinks = true;
var enableRESTAPI = true;

const defaultConfig = {
	// The port clients connect to the matchmaking service over HTTP
	HttpPort: 80,
	UseHTTPS: false,
	// The matchmaking port the signaling service connects to the matchmaker
	MatchmakerPort: 9999,

	// Log to file
	LogToFile: true,

	EnableWebserver: true,

	// Instance Manager configuration (set enabled: false to use legacy matchmaker behavior)
	InstanceManager: {
		enabled: false,
		signallingServerPath: '',
		signallingServerArgs: ['--serve'],
		ueAppPath: '',
		ueAppArgs: ['-RenderOffScreen', '-ResX=1920', '-ResY=1080', '-AudioMixer', '-ForceRes'],
		publicIp: 'localhost',
		playerPortRange: { start: 81, end: 100 },
		streamerPortRange: { start: 8889, end: 8920 },
		minInstances: 0,
		// Consumer NVIDIA GeForce GPUs are limited to 3 simultaneous NVENC encoders.
		maxInstances: 3,
		instanceBootTimeoutSeconds: 30,
		instanceIdleTimeoutSeconds: 60
	},

	// Session Manager configuration (set enabled: false to disable session tracking)
	SessionManager: {
		enabled: false,
		sessionDurationSeconds: 600,
		sessionWarnBeforeEndSeconds: 60,
		reconnectGraceSeconds: 30,
		cookieName: 'ps_session'
	}
};

// Similar to the Signaling Server (SS) code, load in a config.json file for the MM parameters
const argv = require('yargs').argv;

var configFile = (typeof argv.configFile != 'undefined') ? argv.configFile.toString() : 'config.json';
console.log(`configFile ${configFile}`);
const config = require('./modules/config.js').init(configFile, defaultConfig);
console.log("Config: " + JSON.stringify(config, null, '\t'));

const express = require('express');
var cors = require('cors');
const cookieParser = require('cookie-parser');
const app = express();
app.use(cookieParser());
app.use(express.json());

const http = require('http').Server(app);
const fs = require('fs');
const path = require('path');
const logging = require('./modules/logging.js');
logging.RegisterConsoleLogger();

if (config.LogToFile) {
	logging.RegisterFileLogger('./logs');
}

// Load new modules
const portPool = require('./modules/portPool.js');
const sessionManager = require('./modules/sessionManager.js');
const instanceManager = require('./modules/instanceManager.js');

// Determine if dynamic instance management is enabled
const instanceManagerEnabled = config.InstanceManager && config.InstanceManager.enabled;
const sessionManagerEnabled = config.SessionManager && config.SessionManager.enabled;

// Initialize modules if enabled
if (instanceManagerEnabled) {
	portPool.init({
		playerPortRange: config.InstanceManager.playerPortRange,
		streamerPortRange: config.InstanceManager.streamerPortRange
	});
}

if (sessionManagerEnabled) {
	sessionManager.init(config.SessionManager, (token, session) => {
		// Session expired callback — release the instance
		logging.log(`Session expired for token ${token.substring(0, 8)}..., releasing instance.`);
		if (instanceManagerEnabled && session.cirrusServerKey) {
			const cirrusServer = cirrusServers.get(session.cirrusServerKey);
			if (cirrusServer && cirrusServer.instanceId) {
				instanceManager.releaseInstance(cirrusServer.instanceId);
			}
		}
	});
}

if (instanceManagerEnabled) {
	const matchmakerConfig = {
		address: '127.0.0.1',
		port: config.MatchmakerPort
	};
	instanceManager.init(portPool, config.InstanceManager, matchmakerConfig);

	// When an instance becomes ready, check if someone in the queue can use it
	instanceManager.onInstanceReady = (instanceId, instance) => {
		logging.log(`Instance ${instanceId.substring(0, 8)}... is ready, checking queue...`);
		// The instance is now ready — next time a queued user polls, they'll get redirected
	};

	// When an instance is destroyed, clean up any associated session
	instanceManager.onInstanceDestroyed = (instanceId, instance) => {
		// Remove from cirrusServers if still tracked
		if (instance.connectionKey) {
			cirrusServers.delete(instance.connectionKey);
		}
	};
}

// A list of all the Cirrus server which are connected to the Matchmaker.
var cirrusServers = new Map();

//
// Parse command line.
//

if (typeof argv.HttpPort != 'undefined') {
	config.HttpPort = argv.HttpPort;
}
if (typeof argv.MatchmakerPort != 'undefined') {
	config.MatchmakerPort = argv.MatchmakerPort;
}

http.listen(config.HttpPort, () => {
    console.log('HTTP listening on *:' + config.HttpPort);
});


if (config.UseHTTPS) {
	//HTTPS certificate details
	const options = {
		key: fs.readFileSync(path.join(__dirname, './certificates/client-key.pem')),
		cert: fs.readFileSync(path.join(__dirname, './certificates/client-cert.pem'))
	};

	var https = require('https').Server(options, app);

	//Setup http -> https redirect
	console.log('Redirecting http->https');
	app.use(function (req, res, next) {
		if (!req.secure) {
			if (req.get('Host')) {
				var hostAddressParts = req.get('Host').split(':');
				var hostAddress = hostAddressParts[0];
				return res.redirect(['https://', hostAddress, req.originalUrl].join(''));
			} else {
				console.error(`unable to get host name from header. Requestor ${req.ip}, url path: '${req.originalUrl}', available headers ${JSON.stringify(req.headers)}`);
				return res.status(400).send('Bad Request');
			}
		}
		next();
	});

	https.listen(443, function () {
		console.log('Https listening on 443');
	});
}

let htmlDirectory = 'html/sample'
if(config.EnableWebserver) {
	// Setup folders

	if (fs.existsSync('html/custom')) {
		app.use(express.static(path.join(__dirname, '/html/custom')))
		htmlDirectory = 'html/custom'
	} else {
		app.use(express.static(path.join(__dirname, '/html/sample')))
	}
}

// No servers are available so send some simple JavaScript to the client to make
// it retry after a short period of time.
function sendRetryResponse(res, extraData) {
	// find check if a custom template should be used or the sample one
	let html = fs.readFileSync(`${htmlDirectory}/queue/queue.html`, { encoding: 'utf8' })
	html = html.replace(/\$\{cirrusServers\.size\}/gm, cirrusServers.size)

	// Inject additional template data if provided
	if (extraData) {
		for (const [key, value] of Object.entries(extraData)) {
			const regex = new RegExp(`\\$\\{${key}\\}`, 'gm');
			html = html.replace(regex, String(value));
		}
	}

	res.setHeader('content-type', 'text/html')
	res.send(html)
}

// Get a Cirrus server if there is one available which has no clients connected.
function getAvailableCirrusServer() {
	for (cirrusServer of cirrusServers.values()) {
		if (cirrusServer.numConnectedClients === 0 && cirrusServer.ready === true) {

			// Check if we had at least 10 seconds since the last redirect, avoiding the
			// chance of redirecting 2+ users to the same SS before they click Play.
			// In other words, give the user 10 seconds to click play button the claim the server.
			if( cirrusServer.hasOwnProperty('lastRedirect')) {
				if( ((Date.now() - cirrusServer.lastRedirect) / 1000) < 10 )
					continue;
			}
			cirrusServer.lastRedirect = Date.now();

			return cirrusServer;
		}
	}

	console.log('WARNING: No empty Cirrus servers are available');
	return undefined;
}

/**
 * Get the connection key for a cirrus server object in the map.
 * @param {Object} targetServer - The cirrus server object to find
 * @returns {*} The connection key or null
 */
function getConnectionKeyForServer(targetServer) {
	for (const [key, server] of cirrusServers) {
		if (server === targetServer) return key;
	}
	return null;
}

// ============================================================================
// REST API Endpoints
// ============================================================================

if(enableRESTAPI) {
	// Handle REST signalling server only request.
	app.options('/signallingserver', cors())
	app.get('/signallingserver', cors(),  (req, res) => {
		cirrusServer = getAvailableCirrusServer();
		if (cirrusServer != undefined) {
			res.json({ signallingServer: `${cirrusServer.address}:${cirrusServer.port}`});
			console.log(`Returning ${cirrusServer.address}:${cirrusServer.port}`);
		} else {
			res.json({ signallingServer: '', error: 'No signalling servers available'});
		}
	});
}

// Session API endpoints (available when session manager is enabled)
if (sessionManagerEnabled) {
	// Get session status by token
	app.get('/api/session/:token', (req, res) => {
		const session = sessionManager.getSession(req.params.token);
		if (!session) {
			return res.status(404).json({ error: 'Session not found', expired: true });
		}
		res.json({
			timeRemainingSeconds: session.timeRemainingSeconds,
			totalSeconds: session.totalSeconds,
			expired: session.expired,
			state: session.state,
			warnBeforeEndSeconds: session.warnBeforeEndSeconds
		});
	});

	// End session voluntarily
	app.post('/api/session/end', (req, res) => {
		const token = req.cookies[sessionManager.getCookieName()];
		if (!token) {
			return res.status(400).json({ error: 'No session token found' });
		}
		const session = sessionManager.getSession(token);
		if (session && session.cirrusServerKey) {
			const cirrusServer = cirrusServers.get(session.cirrusServerKey);
			if (cirrusServer && cirrusServer.instanceId && instanceManagerEnabled) {
				instanceManager.releaseInstance(cirrusServer.instanceId);
			}
		}
		sessionManager.destroySession(token);
		res.clearCookie(sessionManager.getCookieName());
		res.json({ success: true });
	});
}

// Queue status endpoint (available when instance manager is enabled)
if (instanceManagerEnabled) {
	app.get('/api/queue/status', (req, res) => {
		const counts = instanceManager.getCounts();
		const queueStatus = sessionManagerEnabled ? sessionManager.getQueueStatus() : { queueLength: 0, estimatedWaitSeconds: 0 };
		res.json({
			queueLength: queueStatus.queueLength,
			activeInstances: counts.total,
			readyInstances: counts.ready,
			occupiedInstances: counts.occupied,
			spawningInstances: counts.spawning,
			maxInstances: counts.maxInstances,
			estimatedWaitSeconds: queueStatus.estimatedWaitSeconds
		});
	});

	// Admin endpoint: get all instance statuses
	app.get('/api/instances/status', (req, res) => {
		res.json(instanceManager.getStatus());
	});
}

// ============================================================================
// Redirection / Main Entry Point
// ============================================================================

if(enableRedirectionLinks) {
	// Handle standard URL.
	app.get('/', (req, res) => {
		// --- Session reconnection check ---
		if (sessionManagerEnabled) {
			const sessionToken = req.cookies[sessionManager.getCookieName()];
			if (sessionToken) {
				const existingSession = sessionManager.getSession(sessionToken);
				if (existingSession && !existingSession.expired) {
					// Valid session exists — redirect back to the same instance
					const prefix = config.UseHTTPS ? 'https://' : 'http://';
					sessionManager.cancelGrace(sessionToken);
					console.log(`Session reconnect: redirecting to ${existingSession.cirrusAddress}`);
					const wsPrefix = config.UseHTTPS ? 'wss' : 'ws';
				return res.redirect(`${prefix}${existingSession.cirrusAddress}/?ss=${wsPrefix}://${existingSession.cirrusAddress}`);
				} else {
					// Expired or invalid session — clear the cookie
					res.clearCookie(sessionManager.getCookieName());
				}
			}
		}

		// --- Normal flow: find available server ---
		cirrusServer = getAvailableCirrusServer();
		if (cirrusServer != undefined) {
			let prefix = cirrusServer.https ? 'https://' : 'http://';

			// Create session if session manager is enabled
			if (sessionManagerEnabled) {
				const connectionKey = getConnectionKeyForServer(cirrusServer);
				const { token } = sessionManager.createSession(connectionKey, `${cirrusServer.address}:${cirrusServer.port}`);
				res.cookie(sessionManager.getCookieName(), token, {
					httpOnly: true,
					sameSite: 'strict',
					path: '/',
					maxAge: config.SessionManager.sessionDurationSeconds * 1000
				});
			}

			const wsPrefix = cirrusServer.https ? 'wss' : 'ws';
			res.redirect(`${prefix}${cirrusServer.address}:${cirrusServer.port}/`);
			console.log(`Redirect to ${cirrusServer.address}:${cirrusServer.port}`);
		} else if (instanceManagerEnabled) {
			// No servers available — try spawning a new one
			const newInstance = instanceManager.requestInstance();
			if (newInstance) {
				console.log(`Spawning new instance on ports player:${newInstance.playerPort} streamer:${newInstance.streamerPort}`);
				// Instance is spawning — send queue page, user will auto-retry and get redirected
				// when the instance registers with matchmaker and streamer connects
				sendRetryResponse(res, {
					queuePosition: 1,
					queueLength: 0,
					status: 'spawning'
				});
			} else {
				// At max capacity — send queue page with position
				const queueStatus = sessionManagerEnabled ? sessionManager.getQueueStatus() : { queueLength: 0 };
				sendRetryResponse(res, {
					queuePosition: queueStatus.queueLength + 1,
					queueLength: queueStatus.queueLength,
					status: 'full'
				});
			}
		} else {
			sendRetryResponse(res);
		}
	});

	// Handle URL with custom HTML.
	app.get('/custom_html/:htmlFilename', (req, res) => {
		cirrusServer = getAvailableCirrusServer();
		if (cirrusServer != undefined) {
			let prefix = cirrusServer.https ? 'https://' : 'http://';
			const wsPrefix2 = cirrusServer.https ? 'wss' : 'ws';
			res.redirect(`${prefix}${cirrusServer.address}:${cirrusServer.port}/custom_html/${req.params.htmlFilename}?ss=${wsPrefix2}://${cirrusServer.address}:${cirrusServer.port}`);
			console.log(`Redirect to ${cirrusServer.address}:${cirrusServer.port}`);
		} else {
			sendRetryResponse(res);
		}
	});
}

//
// Connection to Cirrus.
//

const net = require('net');

function disconnect(connection) {
	console.log(`Ending connection to remote address ${connection.remoteAddress}`);
	connection.end();
}

const matchmaker = net.createServer((connection) => {
	connection.on('data', (data) => {
		try {
			message = JSON.parse(data);

			if(message)
				console.log(`Message TYPE: ${message.type}`);
		} catch(e) {
			console.log(`ERROR (${e.toString()}): Failed to parse Cirrus information from data: ${data.toString()}`);
			disconnect(connection);
			return;
		}
		if (message.type === 'connect') {
			// A Cirrus server connects to this Matchmaker server.
			cirrusServer = {
				address: message.address,
				port: message.port,
				https: message.https,
				numConnectedClients: 0,
				lastPingReceived: Date.now()
			};
			cirrusServer.ready = message.ready === true;

			// Handles disconnects between MM and SS to not add dupes with numConnectedClients = 0 and redirect users to same SS
			// Check if player is connected and doing a reconnect. message.playerConnected is a new variable sent from the SS to
			// help track whether or not a player is already connected when a 'connect' message is sent (i.e., reconnect).
			if(message.playerConnected == true) {
				cirrusServer.numConnectedClients = 1;
			}

			// Find if we already have a ciruss server address connected to (possibly a reconnect happening)
			let server = [...cirrusServers.entries()].find(([key, val]) => val.address === cirrusServer.address && val.port === cirrusServer.port);

			// if a duplicate server with the same address isn't found -- add it to the map as an available server to send users to.
			if (!server || server.size <= 0) {
				console.log(`Adding connection for ${cirrusServer.address.split(".")[0]} with playerConnected: ${message.playerConnected}`)
				cirrusServers.set(connection, cirrusServer);
            } else {
				console.log(`RECONNECT: cirrus server address ${cirrusServer.address.split(".")[0]} already found--replacing. playerConnected: ${message.playerConnected}`)
				var foundServer = cirrusServers.get(server[0]);

				// Make sure to retain the numConnectedClients from the last one before the reconnect to MM
				if (foundServer) {
					cirrusServers.set(connection, cirrusServer);
					console.log(`Replacing server with original with numConn: ${cirrusServer.numConnectedClients}`);
					cirrusServers.delete(server[0]);
				} else {
					cirrusServers.set(connection, cirrusServer);
					console.log("Connection not found in Map() -- adding a new one");
				}
			}

			// Associate this connection with an instance if instance manager is tracking it
			if (instanceManagerEnabled) {
				instanceManager.associateConnection(connection, message.address, message.port);
			}

		} else if (message.type === 'streamerConnected') {
			// The stream connects to a Cirrus server and so is ready to be used
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.ready = true;
				console.log(`Cirrus server ${cirrusServer.address}:${cirrusServer.port} ready for use`);

				// Notify instance manager that this instance is now ready
				if (instanceManagerEnabled) {
					instanceManager.markReady(connection);
				}
			} else {
				disconnect(connection);
			}
		} else if (message.type === 'streamerDisconnected') {
			// The stream disconnects from a Cirrus server
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.ready = false;
				console.log(`Cirrus server ${cirrusServer.address}:${cirrusServer.port} no longer ready for use`);
			} else {
				disconnect(connection);
			}
		} else if (message.type === 'clientConnected') {
			// A client connects to a Cirrus server.
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.numConnectedClients++;
				console.log(`Client connected to Cirrus server ${cirrusServer.address}:${cirrusServer.port}`);

				// Cancel any grace period for this server's session
				if (sessionManagerEnabled) {
					const session = sessionManager.findSessionByCirrusKey(connection);
					if (session) {
						sessionManager.cancelGrace(session.token);
					}
				}
			} else {
				disconnect(connection);
			}
		} else if (message.type === 'clientDisconnected') {
			// A client disconnects from a Cirrus server.
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.numConnectedClients--;
				console.log(`Client disconnected from Cirrus server ${cirrusServer.address}:${cirrusServer.port}`);

				if(cirrusServer.numConnectedClients === 0) {
					// this make this server immediately available for a new client
					cirrusServer.lastRedirect = 0;

					// Start grace period if session manager is enabled
					if (sessionManagerEnabled) {
						const session = sessionManager.findSessionByCirrusKey(connection);
						if (session) {
							sessionManager.startDisconnectGrace(session.token);
						}
					}
				}
			} else {
				disconnect(connection);
			}
		} else if (message.type === 'ping') {
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.lastPingReceived = Date.now();
			} else {
				disconnect(connection);
			}
		} else {
			console.log('ERROR: Unknown data: ' + JSON.stringify(message));
			disconnect(connection);
		}
	});

	// A Cirrus server disconnects from this Matchmaker server.
	connection.on('error', () => {
		cirrusServer = cirrusServers.get(connection);
		if(cirrusServer) {
			cirrusServers.delete(connection);
			console.log(`Cirrus server ${cirrusServer.address}:${cirrusServer.port} disconnected from Matchmaker`);
		} else {
			console.log(`Disconnected machine that wasn't a registered cirrus server, remote address: ${connection.remoteAddress}`);
		}
	});
});

matchmaker.listen(config.MatchmakerPort, () => {
	console.log('Matchmaker listening on *:' + config.MatchmakerPort);
});

// Graceful shutdown
process.on('SIGINT', () => {
	console.log('Matchmaker shutting down...');
	if (instanceManagerEnabled) {
		instanceManager.shutdown();
	}
	process.exit(0);
});

process.on('SIGTERM', () => {
	console.log('Matchmaker shutting down...');
	if (instanceManagerEnabled) {
		instanceManager.shutdown();
	}
	process.exit(0);
});
