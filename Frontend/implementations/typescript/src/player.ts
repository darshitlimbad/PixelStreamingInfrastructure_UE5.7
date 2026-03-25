// Copyright Epic Games, Inc. All Rights Reserved.

export * from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.7';
export * from '@epicgames-ps/lib-pixelstreamingfrontend-ui-ue5.7';

import {
    Config,
    PixelStreaming,
    Logger,
    LogLevel,
    DeviceInfoSentEvent,
    DeviceInfoRequestedEvent,
    MobileDeviceDetectedEvent,
    DesktopDeviceDetectedEvent,
    DeviceOrientationChangedEvent,
    DevicePingEvent,
    DevicePongReceivedEvent
} from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.7';
import {
    Application,
    PixelStreamingApplicationStyle
} from '@epicgames-ps/lib-pixelstreamingfrontend-ui-ue5.7';

const PixelStreamingApplicationStyles =
    new PixelStreamingApplicationStyle();
PixelStreamingApplicationStyles.applyStyleSheet();

declare global {
    interface Window { pixelStreaming: PixelStreaming; }
}

document.body.onload = () => {
    Logger.InitLogging(LogLevel.Warning, true);

    const config = new Config({ useUrlParams: true });
    const stream = new PixelStreaming(config);

    attachDeviceEventLoggers(stream);

    const application = new Application({
        stream,
        onColorModeChanged: (isLightMode) => PixelStreamingApplicationStyles.setColorMode(isLightMode)
    });
    document.body.appendChild(application.rootElement);

    window.pixelStreaming = stream;
};

function attachDeviceEventLoggers(stream: PixelStreaming): void {
    stream.addEventListener('deviceInfoSent', (e: DeviceInfoSentEvent) =>
        console.log('deviceInfoSent', e.data)
    );

    stream.addEventListener('deviceInfoRequested', (e: DeviceInfoRequestedEvent) =>
        console.log('deviceInfoRequested', e.data)
    );

    stream.addEventListener('mobileDeviceDetected', (e: MobileDeviceDetectedEvent) =>
        console.log('mobileDeviceDetected', e.data)
    );

    stream.addEventListener('desktopDeviceDetected', (e: DesktopDeviceDetectedEvent) =>
        console.log('desktopDeviceDetected', e.data)
    );

    stream.addEventListener('deviceOrientationChanged', (e: DeviceOrientationChangedEvent) =>
        console.log('deviceOrientationChanged', e.data)
    );

    stream.addEventListener('devicePing', (e: DevicePingEvent) =>
        console.log(`devicePing [${e.data.direction}]`, e.data)
    );

    stream.addEventListener('devicePongReceived', (e: DevicePongReceivedEvent) =>
        console.log(`devicePongReceived - RTT: ${e.data.roundTripMs}ms`, e.data)
    );

    stream.addEventListener('webRtcConnected', () =>
        console.log('webRtcConnected - device detection active')
    );
    stream.addEventListener('webRtcDisconnected', () =>
        console.log('webRtcDisconnected')
    );


    // Config updates listener
}
