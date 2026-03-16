// Copyright Epic Games, Inc. All Rights Reserved.
import net from 'net';
import { SignallingServer } from '@epicgames-ps/lib-pixelstreamingsignalling-ue5.7';
import { Logger } from '@epicgames-ps/lib-pixelstreamingsignalling-ue5.7';

export interface IMatchmakerConfig {
    matchmakerAddress: string;
    matchmakerPort: number;
    publicIp: string;
    playerPort: number;
    useHttps: boolean;
    retryInterval: number;
    pingInterval: number;
}

/**
 * Manages a TCP connection from the Signalling Server (Wilbur) to a Matchmaker server.
 * Sends JSON messages over TCP to report streamer/player connect/disconnect events,
 * allowing the Matchmaker to track available servers and redirect clients.
 *
 * This module hooks into the existing StreamerRegistry and PlayerRegistry EventEmitter
 * events ('added'/'removed') and does not modify any core Signalling library code.
 */
export class MatchmakerConnection {
    private config: IMatchmakerConfig;
    private signallingServer: SignallingServer;
    private socket: net.Socket | null = null;
    private connected: boolean = false;
    private reconnecting: boolean = false;
    private pingIntervalHandle: ReturnType<typeof setInterval> | null = null;

    constructor(signallingServer: SignallingServer, config: IMatchmakerConfig) {
        this.signallingServer = signallingServer;
        this.config = config;

        Logger.info(
            `MatchmakerConnection: Configured to connect to ${config.matchmakerAddress}:${config.matchmakerPort}`
        );

        this.registerEventHandlers();
        this.connect();
    }

    /**
     * Hook into the signalling server's registries to detect
     * streamer and player connect/disconnect events.
     */
    private registerEventHandlers(): void {
        this.signallingServer.streamerRegistry.on('added', (_streamerId: string) => {
            Logger.info('MatchmakerConnection: Streamer connected, notifying matchmaker.');
            this.sendMessage({ type: 'streamerConnected' });
        });

        this.signallingServer.streamerRegistry.on('removed', (_streamerId: string) => {
            Logger.info('MatchmakerConnection: Streamer disconnected, notifying matchmaker.');
            this.sendMessage({ type: 'streamerDisconnected' });
        });

        this.signallingServer.playerRegistry.on('added', (_playerId: string) => {
            Logger.info('MatchmakerConnection: Player connected, notifying matchmaker.');
            this.sendMessage({ type: 'clientConnected' });
        });

        this.signallingServer.playerRegistry.on('removed', (_playerId: string) => {
            Logger.info('MatchmakerConnection: Player disconnected, notifying matchmaker.');
            this.sendMessage({ type: 'clientDisconnected' });
        });
    }

    /**
     * Establishes the TCP connection to the Matchmaker server.
     */
    private connect(): void {
        this.socket = new net.Socket();

        this.socket.on('connect', () => {
            this.connected = true;
            this.reconnecting = false;
            Logger.info(
                `MatchmakerConnection: Connected to matchmaker at ${this.config.matchmakerAddress}:${this.config.matchmakerPort}`
            );

            // Send initial connect message with current state
            const connectMessage = {
                type: 'connect',
                address: this.config.publicIp,
                port: this.config.playerPort,
                https: this.config.useHttps,
                ready: this.signallingServer.streamerRegistry.count() > 0,
                playerConnected: this.signallingServer.playerRegistry.count() > 0
            };
            this.sendMessage(connectMessage);

            // Start keepalive ping interval
            this.startPingInterval();
        });

        this.socket.on('error', (error: Error) => {
            Logger.error(`MatchmakerConnection: TCP error: ${error.message}`);
        });

        this.socket.on('close', () => {
            this.connected = false;
            this.stopPingInterval();

            if (!this.reconnecting) {
                Logger.warn(
                    'MatchmakerConnection: Connection to matchmaker closed. Will attempt reconnection.'
                );
                this.scheduleReconnect();
            }
        });

        Logger.info(
            `MatchmakerConnection: Connecting to matchmaker at ${this.config.matchmakerAddress}:${this.config.matchmakerPort}...`
        );
        this.socket.connect(this.config.matchmakerPort, this.config.matchmakerAddress);
    }

    /**
     * Schedule a reconnection attempt after the configured retry interval.
     */
    private scheduleReconnect(): void {
        this.reconnecting = true;
        Logger.info(
            `MatchmakerConnection: Reconnecting to matchmaker in ${this.config.retryInterval / 1000} seconds...`
        );
        setTimeout(() => {
            this.reconnecting = false;
            this.connect();
        }, this.config.retryInterval);
    }

    /**
     * Start the periodic ping keepalive to the matchmaker.
     */
    private startPingInterval(): void {
        this.stopPingInterval();
        this.pingIntervalHandle = setInterval(() => {
            this.sendMessage({ type: 'ping' });
        }, this.config.pingInterval);
    }

    /**
     * Stop the periodic ping keepalive.
     */
    private stopPingInterval(): void {
        if (this.pingIntervalHandle) {
            clearInterval(this.pingIntervalHandle);
            this.pingIntervalHandle = null;
        }
    }

    /**
     * Send a JSON message to the Matchmaker over TCP.
     */
    private sendMessage(message: object): void {
        if (!this.connected || !this.socket) {
            Logger.debug(
                `MatchmakerConnection: Cannot send message, not connected. Message type: ${(message as { type?: string }).type}`
            );
            return;
        }

        try {
            this.socket.write(JSON.stringify(message));
        } catch (error: unknown) {
            Logger.error(`MatchmakerConnection: Failed to send message: ${(error as Error).message}`);
        }
    }
}
