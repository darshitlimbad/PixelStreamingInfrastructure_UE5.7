// Copyright Epic Games, Inc. All Rights Reserved.

/**
 * Instance Manager
 *
 * Manages the lifecycle of Signalling Server (Wilbur) + UE application process
 * pairs. Handles spawning, tracking, crash recovery, and destruction of instances.
 *
 * IMPORTANT: We bypass start.bat and run `node dist/index.js` directly because
 * start.bat uses internal pipe operations (echo | findstr) that hang when
 * spawned as a child process with piped stdio from Node.js.
 *
 * This means:
 * - The SignallingWebServer must be built ONCE beforehand (run start.bat manually)
 * - After that, dist/index.js exists and we spawn it directly
 * - STUN/TURN peer_options are constructed here, not by start.bat
 * - All server args are passed directly to node dist/index.js
 *
 * Consumer NVIDIA GeForce GPUs are limited to 3 simultaneous NVENC encoders.
 * The default maxInstances: 3 reflects this hardware constraint.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logging = require('./logging.js');

class InstanceManager {
    constructor() {
        this.instances = new Map();
        this.config = null;
        this.portPool = null;
        this.initialized = false;

        this.onInstanceReady = null;
        this.onInstanceDestroyed = null;

        // Spawn failure cooldown
        this._recentFailures = [];
        this._failureWindowMs = 30000;
        this._maxFailures = 3;
        this._cooldownUntil = 0;
        this._cooldownDurationMs = 60000;

        this._matchmakerRoot = path.resolve(__dirname, '..');
    }

    /**
     * Initialize the instance manager.
     */
    init(portPool, config, matchmakerConfig) {
        this.portPool = portPool;
        this.matchmakerConfig = matchmakerConfig;
        this.config = {
            enabled: config.enabled !== false,
            // Path to SignallingWebServer directory (not start.bat)
            signallingServerDir: config.signallingServerDir || '../SignallingWebServer',
            // STUN/TURN config — we build peer_options JSON from these
            stun: config.stun || '',
            turn: config.turn || '',
            turnUser: config.turnUser || '',
            turnPass: config.turnPass || '',
            // Extra args passed directly to node dist/index.js
            signallingServerArgs: config.signallingServerArgs || ['--serve'],
            ueAppPath: config.ueAppPath || '',
            ueAppArgs: config.ueAppArgs || ['-RenderOffScreen', '-ResX=1920', '-ResY=1080', '-AudioMixer', '-ForceRes'],
            publicIp: config.publicIp || 'localhost',
            minInstances: config.minInstances || 0,
            maxInstances: config.maxInstances || 3,
            instanceBootTimeoutSeconds: config.instanceBootTimeoutSeconds || 30,
            instanceIdleTimeoutSeconds: config.instanceIdleTimeoutSeconds || 60
        };

        if (!this.config.enabled) {
            logging.log('InstanceManager: Disabled in config, skipping initialization.');
            this.initialized = true;
            return;
        }

        // Verify dist/index.js exists
        const entryPoint = this._getWilburEntryPoint();
        if (!fs.existsSync(entryPoint)) {
            logging.error(`InstanceManager: Wilbur entry point not found at: ${entryPoint}`);
            logging.error('InstanceManager: Run SignallingWebServer/platform_scripts/cmd/start.bat manually once to build the project.');
            this.config.enabled = false;
            this.initialized = true;
            return;
        }

        this.initialized = true;
        logging.log(`InstanceManager: Initialized (min: ${this.config.minInstances}, max: ${this.config.maxInstances})`);
        logging.log(`InstanceManager: Wilbur entry: ${entryPoint}`);

        if (this.config.stun) {
            logging.log(`InstanceManager: STUN server: ${this.config.stun}`);
        }
        if (this.config.turn) {
            logging.log(`InstanceManager: TURN server: ${this.config.turn}`);
        }

        // Pre-spawn warm pool
        if (this.config.minInstances > 0) {
            logging.log(`InstanceManager: Pre-spawning ${this.config.minInstances} warm instance(s)...`);
            for (let i = 0; i < this.config.minInstances; i++) {
                this._spawnInstance(true);
            }
        }
    }

    /**
     * Request a new instance.
     */
    requestInstance() {
        if (!this.config.enabled) return null;

        // Check for idle ready instance
        for (const [id, instance] of this.instances) {
            if (instance.state === 'ready') {
                instance.state = 'occupied';
                logging.log(`InstanceManager: Assigned existing ready instance ${id.substring(0, 8)}...`);
                return this._getInstanceInfo(id);
            }
        }

        // Don't spawn if one is already booting
        for (const instance of this.instances.values()) {
            if (instance.state === 'spawning') {
                logging.log(`InstanceManager: An instance is already spawning. Waiting for it to be ready.`);
                return null;
            }
        }

        // Max capacity check
        if (this.instances.size >= this.config.maxInstances) {
            logging.warn(`InstanceManager: At max capacity (${this.config.maxInstances}). Cannot spawn new instance.`);
            return null;
        }

        // Cooldown check
        const now = Date.now();
        if (now < this._cooldownUntil) {
            const remainingSec = Math.ceil((this._cooldownUntil - now) / 1000);
            logging.warn(`InstanceManager: In spawn cooldown (${remainingSec}s remaining). Refusing to spawn.`);
            return null;
        }

        return this._spawnInstance(false);
    }

    /**
     * Release an instance.
     */
    releaseInstance(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance) return;

        let warmCount = 0;
        for (const inst of this.instances.values()) {
            if (inst.isWarmPool && (inst.state === 'ready' || inst.state === 'idle')) {
                warmCount++;
            }
        }

        if (instance.isWarmPool && warmCount <= this.config.minInstances) {
            instance.state = 'ready';
            logging.log(`InstanceManager: Instance ${instanceId.substring(0, 8)}... returned to warm pool`);
            return;
        }

        this._destroyInstance(instanceId);
    }

    findByPlayerPort(playerPort) {
        for (const [id, instance] of this.instances) {
            if (instance.playerPort === playerPort) return this._getInstanceInfo(id);
        }
        return null;
    }

    findByConnectionKey(connectionKey) {
        for (const [id, instance] of this.instances) {
            if (instance.connectionKey === connectionKey) return this._getInstanceInfo(id);
        }
        return null;
    }

    associateConnection(connectionKey, address, port) {
        for (const [id, instance] of this.instances) {
            if (instance.playerPort === port) {
                instance.connectionKey = connectionKey;
                logging.log(`InstanceManager: Associated connection to instance ${id.substring(0, 8)}... (port ${port})`);
                return;
            }
        }
    }

    markReady(connectionKey) {
        for (const [id, instance] of this.instances) {
            if (instance.connectionKey === connectionKey) {
                if (instance.state === 'spawning') {
                    instance.state = 'ready';
                    if (instance.bootTimeout) {
                        clearTimeout(instance.bootTimeout);
                        instance.bootTimeout = null;
                    }
                    logging.log(`InstanceManager: Instance ${id.substring(0, 8)}... is now ready`);
                    if (this.onInstanceReady) this.onInstanceReady(id, instance);
                }
                return;
            }
        }
    }

    getStatus() {
        const statuses = [];
        for (const [id] of this.instances) statuses.push(this._getInstanceInfo(id));
        return statuses;
    }

    getCounts() {
        let spawning = 0, ready = 0, occupied = 0;
        for (const instance of this.instances.values()) {
            switch (instance.state) {
                case 'spawning': spawning++; break;
                case 'ready': ready++; break;
                case 'occupied': occupied++; break;
            }
        }
        return { total: this.instances.size, spawning, ready, occupied, maxInstances: this.config.maxInstances };
    }

    shutdown() {
        logging.log('InstanceManager: Shutting down all instances...');
        for (const [id] of this.instances) this._destroyInstance(id);
    }

    // ---- Private ----

    /**
     * Get the path to dist/index.js
     */
    _getWilburEntryPoint() {
        const ssDir = path.resolve(this._matchmakerRoot, this.config.signallingServerDir);
        return path.join(ssDir, 'dist', 'index.js');
    }

    /**
     * Get the SignallingWebServer root directory (CWD for wilbur)
     */
    _getWilburCwd() {
        return path.resolve(this._matchmakerRoot, this.config.signallingServerDir);
    }

    /**
     * Find the Node.js executable.
     * Checks for bundled node in PSI first, then falls back to system node.
     */
    _getNodePath() {
        const ssDir = this._getWilburCwd();
        const isWin = process.platform === 'win32';

        if (isWin) {
            // PSI bundles node under platform_scripts/cmd/node/
            const bundled = path.join(ssDir, 'platform_scripts', 'cmd', 'node', 'node.exe');
            if (fs.existsSync(bundled)) {
                return bundled;
            }
        } else {
            const bundled = path.join(ssDir, 'platform_scripts', 'bash', 'node', 'bin', 'node');
            if (fs.existsSync(bundled)) {
                return bundled;
            }
        }

        // System node
        return process.execPath;
    }

    /**
     * Build the --peer_options JSON string from STUN/TURN config.
     * This replicates what start.bat does internally.
     */
    _buildPeerOptions() {
        const stun = this.config.stun;
        const turn = this.config.turn;
        const turnUser = this.config.turnUser;
        const turnPass = this.config.turnPass;

        if (!stun && !turn) return null;

        const iceServers = [];

        if (stun && turn) {
            iceServers.push({
                urls: [`stun:${stun}`, `turn:${turn}`],
                username: turnUser,
                credential: turnPass
            });
        } else if (stun) {
            iceServers.push({
                urls: [`stun:${stun}`]
            });
        } else if (turn) {
            iceServers.push({
                urls: [`turn:${turn}`],
                username: turnUser,
                credential: turnPass
            });
        }

        return JSON.stringify({ iceServers });
    }

    /**
     * Spawn a new Wilbur + UE instance pair.
     *
     * Runs: node dist/index.js [args...]
     * NOT start.bat (which hangs due to internal findstr pipe issue)
     */
    _spawnInstance(isWarmPool) {
        const ports = this.portPool.allocate();
        if (!ports) {
            logging.error('InstanceManager: Failed to allocate ports for new instance.');
            return null;
        }

        const instanceId = crypto.randomUUID();
        const { playerPort, streamerPort } = ports;

        const instance = {
            instanceId,
            playerPort,
            streamerPort,
            state: 'spawning',
            isWarmPool,
            wilburProcess: null,
            ueProcess: null,
            connectionKey: null,
            bootTimeout: null,
            createdAt: Date.now()
        };

        // =====================================================
        // Spawn Wilbur — node dist/index.js directly
        // =====================================================
        try {
            const nodePath = this._getNodePath();
            const entryPoint = this._getWilburEntryPoint();
            const wilburCwd = this._getWilburCwd();

            // Build server args
            const wilburArgs = [
                entryPoint,
                '--player_port', String(playerPort),
                '--streamer_port', String(streamerPort),
                '--sfu_port', String(streamerPort + 1000),
                '--use_matchmaker',
                '--matchmaker_address', this.matchmakerConfig.address || '127.0.0.1',
                '--matchmaker_port', String(this.matchmakerConfig.port || 9999),
                '--public_ip', this.config.publicIp,
                ...this.config.signallingServerArgs
            ];

            // Add peer_options if STUN/TURN is configured
            const peerOptions = this._buildPeerOptions();
            if (peerOptions) {
                wilburArgs.push('--peer_options', peerOptions);
            }

            logging.log(`InstanceManager: Wilbur command: ${nodePath} ${path.basename(entryPoint)} --player_port ${playerPort} --streamer_port ${streamerPort} ...`);
            logging.log(`InstanceManager: Wilbur cwd: ${wilburCwd}`);

            const wilburProcess = spawn(nodePath, wilburArgs, {
                cwd: wilburCwd,
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            instance.wilburProcess = wilburProcess;

            // Capture output for debugging (first 30 lines)
            let lineCount = 0;
            const maxLines = 30;

            if (wilburProcess.stdout) {
                wilburProcess.stdout.on('data', (data) => {
                    for (const line of data.toString().trim().split('\n')) {
                        if (line.trim() && lineCount < maxLines) {
                            logging.log(`[Wilbur:${playerPort}] ${line.trim()}`);
                            lineCount++;
                        }
                    }
                });
            }

            if (wilburProcess.stderr) {
                wilburProcess.stderr.on('data', (data) => {
                    for (const line of data.toString().trim().split('\n')) {
                        if (line.trim()) {
                            logging.error(`[Wilbur:${playerPort}:ERR] ${line.trim()}`);
                        }
                    }
                });
            }

            wilburProcess.on('exit', (code, signal) => {
                logging.warn(`InstanceManager: Wilbur for ${instanceId.substring(0, 8)}... exited (code: ${code}, signal: ${signal})`);
                this._handleProcessExit(instanceId, 'wilbur');
            });

            wilburProcess.on('error', (err) => {
                logging.error(`InstanceManager: Wilbur error for ${instanceId.substring(0, 8)}...: ${err.message}`);
                this._handleProcessExit(instanceId, 'wilbur');
            });

            logging.log(`InstanceManager: Spawned Wilbur for instance ${instanceId.substring(0, 8)}... (player: ${playerPort}, streamer: ${streamerPort})`);
        } catch (err) {
            logging.error(`InstanceManager: Failed to spawn Wilbur: ${err.message}`);
            this.portPool.release(playerPort, streamerPort);
            return null;
        }

        // =====================================================
        // Spawn UE application
        // =====================================================
        if (this.config.ueAppPath) {
            try {
                const ueArgs = [
                    `-PixelStreamingURL=ws://127.0.0.1:${streamerPort}`,
                    ...this.config.ueAppArgs
                ];

                const ueAppPath = path.resolve(this._matchmakerRoot, this.config.ueAppPath);
                const ueAppCwd = path.dirname(ueAppPath);
                const ueExt = path.extname(ueAppPath).toLowerCase();
                const isWin = process.platform === 'win32';

                logging.log(`InstanceManager: Spawning UE app: ${ueAppPath}`);

                let ueProcess;
                if (isWin && (ueExt === '.bat' || ueExt === '.cmd')) {
                    ueProcess = spawn('cmd.exe', ['/c', ueAppPath, ...ueArgs], {
                        cwd: ueAppCwd, detached: true, stdio: 'ignore'
                    });
                } else {
                    ueProcess = spawn(ueAppPath, ueArgs, {
                        cwd: ueAppCwd, detached: true, stdio: 'ignore'
                    });
                }

                instance.ueProcess = ueProcess;

                ueProcess.on('exit', (code, signal) => {
                    logging.warn(`InstanceManager: UE for ${instanceId.substring(0, 8)}... exited (code: ${code}, signal: ${signal})`);
                    this._handleProcessExit(instanceId, 'ue');
                });

                ueProcess.on('error', (err) => {
                    logging.error(`InstanceManager: UE error for ${instanceId.substring(0, 8)}...: ${err.message}`);
                    this._handleProcessExit(instanceId, 'ue');
                });

                logging.log(`InstanceManager: Spawned UE app for instance ${instanceId.substring(0, 8)}...`);
            } catch (err) {
                logging.error(`InstanceManager: Failed to spawn UE app: ${err.message}`);
                if (instance.wilburProcess) this._killProcess(instance.wilburProcess);
                this.portPool.release(playerPort, streamerPort);
                return null;
            }
        }

        // Boot timeout
        instance.bootTimeout = setTimeout(() => {
            if (instance.state === 'spawning') {
                logging.warn(`InstanceManager: Instance ${instanceId.substring(0, 8)}... boot timed out after ${this.config.instanceBootTimeoutSeconds}s`);
            }
        }, this.config.instanceBootTimeoutSeconds * 1000);

        this.instances.set(instanceId, instance);
        return this._getInstanceInfo(instanceId);
    }

    _handleProcessExit(instanceId, processType) {
        const instance = this.instances.get(instanceId);
        if (!instance || instance.state === 'stopped') return;

        logging.log(`InstanceManager: Handling ${processType} exit for ${instanceId.substring(0, 8)}...`);

        if (instance.state === 'spawning') {
            const now = Date.now();
            this._recentFailures.push(now);
            this._recentFailures = this._recentFailures.filter(t => now - t < this._failureWindowMs);
            if (this._recentFailures.length >= this._maxFailures) {
                this._cooldownUntil = now + this._cooldownDurationMs;
                logging.error(`InstanceManager: ${this._recentFailures.length} spawn failures in ${this._failureWindowMs / 1000}s. ` +
                    `Entering ${this._cooldownDurationMs / 1000}s cooldown.`);
            }
        }

        if (processType === 'wilbur' && instance.ueProcess) this._killProcess(instance.ueProcess);
        else if (processType === 'ue' && instance.wilburProcess) this._killProcess(instance.wilburProcess);

        instance.state = 'stopped';
        this.portPool.release(instance.playerPort, instance.streamerPort);
        if (instance.bootTimeout) clearTimeout(instance.bootTimeout);
        this.instances.delete(instanceId);

        logging.log(`InstanceManager: Instance ${instanceId.substring(0, 8)}... cleaned up after ${processType} exit`);
        if (this.onInstanceDestroyed) this.onInstanceDestroyed(instanceId, instance);
    }

    _killProcess(proc) {
        if (!proc || !proc.pid) return;
        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore' });
            } else {
                process.kill(-proc.pid, 'SIGTERM');
            }
        } catch (e) {
            try { proc.kill(); } catch (e2) { /* ignore */ }
        }
    }

    _destroyInstance(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance) return;

        instance.state = 'stopped';
        if (instance.bootTimeout) { clearTimeout(instance.bootTimeout); instance.bootTimeout = null; }

        this._killProcess(instance.ueProcess);
        this._killProcess(instance.wilburProcess);
        this.portPool.release(instance.playerPort, instance.streamerPort);
        this.instances.delete(instanceId);

        logging.log(`InstanceManager: Destroyed instance ${instanceId.substring(0, 8)}...`);
        if (this.onInstanceDestroyed) this.onInstanceDestroyed(instanceId, instance);
    }

    _getInstanceInfo(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance) return null;
        return {
            instanceId,
            playerPort: instance.playerPort,
            streamerPort: instance.streamerPort,
            state: instance.state,
            isWarmPool: instance.isWarmPool,
            createdAt: instance.createdAt,
            connectionKey: instance.connectionKey
        };
    }
}

module.exports = new InstanceManager();