// Copyright Epic Games, Inc. All Rights Reserved.

/**
 * Port Pool Manager
 *
 * Manages allocation and release of port pairs (player + streamer) from
 * configured port ranges. Ensures no two instances share the same ports.
 */

const logging = require('./logging.js');

class PortPool {
    constructor() {
        this.availablePlayerPorts = new Set();
        this.availableStreamerPorts = new Set();
        this.allocatedPairs = new Map(); // key -> { playerPort, streamerPort }
        this.initialized = false;
    }

    /**
     * Initialize the port pool from config ranges.
     * @param {Object} config - { playerPortRange: { start, end }, streamerPortRange: { start, end } }
     */
    init(config) {
        if (!config || !config.playerPortRange || !config.streamerPortRange) {
            throw new Error('PortPool: config must include playerPortRange and streamerPortRange with { start, end }');
        }

        const { playerPortRange, streamerPortRange } = config;

        if (playerPortRange.start >= playerPortRange.end) {
            throw new Error(`PortPool: Invalid playerPortRange: ${playerPortRange.start}-${playerPortRange.end}`);
        }
        if (streamerPortRange.start >= streamerPortRange.end) {
            throw new Error(`PortPool: Invalid streamerPortRange: ${streamerPortRange.start}-${streamerPortRange.end}`);
        }

        this.availablePlayerPorts.clear();
        this.availableStreamerPorts.clear();
        this.allocatedPairs.clear();

        for (let port = playerPortRange.start; port <= playerPortRange.end; port++) {
            this.availablePlayerPorts.add(port);
        }
        for (let port = streamerPortRange.start; port <= streamerPortRange.end; port++) {
            this.availableStreamerPorts.add(port);
        }

        this.initialized = true;
        logging.log(`PortPool: Initialized with ${this.availablePlayerPorts.size} player ports and ${this.availableStreamerPorts.size} streamer ports`);
    }

    /**
     * Allocate a port pair (player + streamer).
     * @returns {{ playerPort: number, streamerPort: number } | null} The allocated port pair, or null if exhausted.
     */
    allocate() {
        if (!this.initialized) {
            logging.error('PortPool: Not initialized. Call init() first.');
            return null;
        }

        if (this.availablePlayerPorts.size === 0) {
            logging.warn('PortPool: No available player ports.');
            return null;
        }
        if (this.availableStreamerPorts.size === 0) {
            logging.warn('PortPool: No available streamer ports.');
            return null;
        }

        const playerPort = this.availablePlayerPorts.values().next().value;
        const streamerPort = this.availableStreamerPorts.values().next().value;

        this.availablePlayerPorts.delete(playerPort);
        this.availableStreamerPorts.delete(streamerPort);

        const key = `${playerPort}:${streamerPort}`;
        this.allocatedPairs.set(key, { playerPort, streamerPort });

        logging.log(`PortPool: Allocated pair - player: ${playerPort}, streamer: ${streamerPort} (${this.availablePlayerPorts.size} player ports remaining)`);
        return { playerPort, streamerPort };
    }

    /**
     * Release a previously allocated port pair back to the pool.
     * @param {number} playerPort
     * @param {number} streamerPort
     */
    release(playerPort, streamerPort) {
        const key = `${playerPort}:${streamerPort}`;
        if (!this.allocatedPairs.has(key)) {
            logging.warn(`PortPool: Attempted to release untracked pair - player: ${playerPort}, streamer: ${streamerPort}`);
            return;
        }

        this.allocatedPairs.delete(key);
        this.availablePlayerPorts.add(playerPort);
        this.availableStreamerPorts.add(streamerPort);

        logging.log(`PortPool: Released pair - player: ${playerPort}, streamer: ${streamerPort} (${this.availablePlayerPorts.size} player ports available)`);
    }

    /**
     * Get the number of available port pairs.
     * @returns {number} Minimum of available player and streamer ports.
     */
    availableCount() {
        return Math.min(this.availablePlayerPorts.size, this.availableStreamerPorts.size);
    }

    /**
     * Get the number of currently allocated port pairs.
     * @returns {number}
     */
    allocatedCount() {
        return this.allocatedPairs.size;
    }
}

module.exports = new PortPool();
