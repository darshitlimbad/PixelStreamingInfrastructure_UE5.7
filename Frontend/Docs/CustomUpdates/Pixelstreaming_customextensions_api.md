# Pixel Streaming — Custom Extensions API

> Custom events, device detection, and handshake protocol added to the UE 5.7 Pixel Streaming frontend library.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Device Detection](#device-detection)
  - [DeviceInfo Interface](#deviceinfo-interface)
  - [DeviceDetector Class](#devicedetector-class)
- [Ping-Pong Handshake Protocol](#ping-pong-handshake-protocol)
- [Custom Events Reference](#custom-events-reference)
  - [DevicePingEvent](#devicepingevent)
  - [DevicePongReceivedEvent](#devicepongreceivedevent)
  - [DeviceInfoSentEvent](#deviceinfosentevent)
  - [DeviceInfoRequestedEvent](#deviceinforequestedevent)
  - [MobileDeviceDetectedEvent](#mobiledevicedetectedevent)
  - [DesktopDeviceDetectedEvent](#desktopdevicedetectedevent)
  - [DeviceOrientationChangedEvent](#deviceorientationchangedevent)
  - [HandshakeTimeoutEvent](#handshaketimeoutevent)
- [Custom Message Handlers](#custom-message-handlers)
  - [archviz_deviceControl](#archviz_devicecontrol)
  - [archviz_appCommand](#archviz_appcommand)
- [PixelStreaming Class — New Public API](#pixelstreaming-class--new-public-api)
- [Usage Examples](#usage-examples)

---

## Overview

These extensions add three capabilities to the Pixel Streaming frontend:

1. **Device Detection** — Comprehensive client fingerprinting (OS, browser, brand, model, connection, orientation) via `DeviceDetector`.
2. **Ping-Pong Handshake** — A retry-based protocol that verifies bidirectional data channel communication with UE before sending device info.
3. **Custom Events** — Eight new `PixelStreamingEvent` subtypes that let application code react to device lifecycle milestones.

All additions are opt-in listeners; they do not alter existing Pixel Streaming behaviour.

---

## Architecture

```
Browser                                      Unreal Engine
───────                                      ──────────────
 DataChannel opens ──┐
 Video initialized ──┤
                     ▼
            _tryInitiateHandshake()
                     │
         ┌───────────┴───────────┐
         │  devicePing (JSON)    │──────────►  archviz_deviceControl
         │  retry every 4 s     │              handler receives ping
         │  timeout at 120 s    │
         │                      │◄──────────  devicePong (JSON)
         ▼                      │
   _handleDevicePong()          │
         │                      │
         ▼                      │
   sendDeviceInfo() ────────────┼──────────►  deviceInfo (JSON)
         │                      │
    Events dispatched:          │
    • DevicePingEvent           │
    • DevicePongReceivedEvent   │
    • DeviceInfoSentEvent       │
    • MobileDeviceDetectedEvent │
      or DesktopDeviceDetectedEvent
```

---

## Device Detection

### DeviceInfo Interface

Returned by `DeviceDetector.getDeviceInfo()` and included in several events.

| Property | Type | Description |
|---|---|---|
| `platform` | `string` | `navigator.platform` value |
| `userAgent` | `string` | Full user-agent string |
| `touchSupported` | `boolean` | Whether the device supports touch input |
| `screenWidth` | `number` | `screen.width` in pixels |
| `screenHeight` | `number` | `screen.height` in pixels |
| `devicePixelRatio` | `number` | CSS pixel ratio (`window.devicePixelRatio`) |
| `isMobile` | `boolean` | `true` for phones |
| `isTablet` | `boolean` | `true` for tablets (iPads, Android tablets) |
| `browserName` | `string` | Detected browser name (Chrome, Safari, Edge, Firefox, Opera, Samsung Internet) |
| `browserVersion` | `string` | Browser version string |
| `osName` | `string` | OS name (Android, iOS, iPadOS, macOS, Windows, Linux, Chrome OS) |
| `osVersion` | `string` | OS version string |
| `deviceBrand` | `string` | Manufacturer (Samsung, Apple, Google, Xiaomi, etc.) |
| `deviceModel` | `string` | Model identifier (e.g. `SM-G991B`, `Pixel 7`) |
| `deviceType` | `'mobile' \| 'tablet' \| 'desktop' \| 'tv' \| 'wearable' \| 'console' \| 'unknown'` | Categorical device classification |
| `connectionType` | `string` | Network effective type (`4g`, `3g`, `wifi`, etc.) |
| `connectionSpeed` | `string` | Downlink speed string (e.g. `10 Mbps`) |
| `timestamp` | `number` | `Date.now()` when info was collected |
| `deviceId` | `string` | Canvas-based fingerprint ID (`device_<hash>`) |
| `orientation` | `string` | Current orientation (`portrait-primary`, `landscape-primary`, etc.) |
| `maxTouchPoints` | `number` | `navigator.maxTouchPoints` |
| `hardwareConcurrency` | `number` | Logical CPU core count |
| `colorDepth` | `number` | `screen.colorDepth` |
| `pixelDepth` | `number` | `screen.pixelDepth` |

### DeviceDetector Class

Static utility — no instantiation required.

```typescript
import { DeviceDetector, DeviceInfo } from '../Util/DeviceDetector';

const info: DeviceInfo = DeviceDetector.getDeviceInfo();
```

**Key behaviours:**

- The `deviceId` is generated once per page load via canvas fingerprinting and cached for the session.
- iPad detection handles the `MacIntel` + touch heuristic introduced in iPadOS 13+.
- Connection info uses the Network Information API (available in Chromium browsers; falls back to `'unknown'`).

---

## Ping-Pong Handshake Protocol

The handshake ensures the data channel is fully operational in both directions before device info is transmitted.

| Constant | Value | Purpose |
|---|---|---|
| `PING_RETRY_INTERVAL_MS` | `4000` | Interval between ping retries |
| `PING_TIMEOUT_MS` | `120000` | Maximum time before giving up |

**Sequence:**

1. Both `dataChannelOpen` and `videoInitialized` events must fire (dual-gate).
2. `_tryInitiateHandshake()` sends the first `devicePing` immediately, then starts a 4 s retry interval.
3. On receiving `devicePong` from UE, the retry loop stops, `_pingPongVerified` is set to `true`, and `sendDeviceInfo()` is called.
4. If no pong is received within 120 s, a `HandshakeTimeoutEvent` is dispatched and retries stop.

**State reset:** Calling `pixelStreaming.disconnect()` resets all handshake state (`_dataChannelReady`, `_videoReady`, `_pingPongVerified`, `deviceInfoSent`) so a subsequent `connect()` performs the handshake again.

---

## Custom Events Reference

All events extend the native `Event` class and are part of the `PixelStreamingEvent` union type. Listen via `pixelStreaming.addEventListener(type, callback)`.

---

### DevicePingEvent

Dispatched when a ping is sent to UE or received from UE.

| Field | Type | Description |
|---|---|---|
| `type` | `'devicePing'` | Event discriminator |
| `data.direction` | `'sent' \| 'received'` | Whether the ping was outgoing or incoming |
| `data.timestamp` | `number` | `Date.now()` at dispatch |

```typescript
pixelStreaming.addEventListener('devicePing', (e) => {
    console.log(`Ping ${e.data.direction} at ${e.data.timestamp}`);
});
```

---

### DevicePongReceivedEvent

Dispatched when UE responds to a ping, confirming bidirectional communication.

| Field | Type | Description |
|---|---|---|
| `type` | `'devicePongReceived'` | Event discriminator |
| `data.roundTripMs` | `number` | Round-trip time in milliseconds |
| `data.originalTimestamp` | `number` | Timestamp from the original ping |
| `data.serverTimestamp` | `number` | Timestamp set by UE in the pong |

```typescript
pixelStreaming.addEventListener('devicePongReceived', (e) => {
    console.log(`RTT: ${e.data.roundTripMs}ms`);
});
```

---

### DeviceInfoSentEvent

Dispatched after device information is successfully sent to UE.

| Field | Type | Description |
|---|---|---|
| `type` | `'deviceInfoSent'` | Event discriminator |
| `data.deviceInfo` | `DeviceInfo` | The full device info payload |

---

### DeviceInfoRequestedEvent

Dispatched when UE explicitly requests device info via a `requestDeviceInfo` message.

| Field | Type | Description |
|---|---|---|
| `type` | `'deviceInfoRequested'` | Event discriminator |
| `data.message` | `{ type: string; timestamp?: number }` | The request message from UE |

---

### MobileDeviceDetectedEvent

Dispatched when the connected device is classified as mobile or tablet.

| Field | Type | Description |
|---|---|---|
| `type` | `'mobileDeviceDetected'` | Event discriminator |
| `data.deviceInfo` | `DeviceInfo` | The full device info payload |

---

### DesktopDeviceDetectedEvent

Dispatched when the connected device is classified as desktop.

| Field | Type | Description |
|---|---|---|
| `type` | `'desktopDeviceDetected'` | Event discriminator |
| `data.deviceInfo` | `DeviceInfo` | The full device info payload |

---

### DeviceOrientationChangedEvent

Dispatched when the device orientation changes (debounced, 300 ms).

| Field | Type | Description |
|---|---|---|
| `type` | `'deviceOrientationChanged'` | Event discriminator |
| `data.orientationData.type` | `'orientationChange'` | Fixed string |
| `data.orientationData.data.orientation` | `string` | New orientation type |
| `data.orientationData.data.width` | `number` | `window.innerWidth` |
| `data.orientationData.data.height` | `number` | `window.innerHeight` |
| `data.orientationData.data.angle` | `number` | Orientation angle (0, 90, 180, 270) |

---

### HandshakeTimeoutEvent

Dispatched when the ping-pong handshake fails after exhausting retries.

| Field | Type | Description |
|---|---|---|
| `type` | `'handshakeTimeout'` | Event discriminator |
| `data.attempts` | `number` | Total ping attempts made |
| `data.elapsedMs` | `number` | Total elapsed time in milliseconds |

```typescript
pixelStreaming.addEventListener('handshakeTimeout', (e) => {
    console.error(`Handshake failed: ${e.data.attempts} attempts over ${e.data.elapsedMs}ms`);
    // Show fallback UI or retry logic
});
```

---

## Custom Message Handlers

Two custom data channel message handlers are registered automatically in `setupDeviceDetection()`.

### archviz_deviceControl

Direction: **FromStreamer** (UE → Browser)

Handles device-management messages. The `type` field in the JSON payload determines behaviour:

| `type` value | Action |
|---|---|
| `devicePong` | Stops ping retry, marks channel verified, triggers `sendDeviceInfo()` |
| `devicePing` | Auto-replies with `devicePong` (UE-initiated ping) |
| `requestDeviceInfo` | Sends device info to UE, dispatches `DeviceInfoRequestedEvent` |

**Expected JSON format** (after UTF-16 decoding, skipping first byte):

```json
{
    "type": "devicePong",
    "originalTimestamp": 1700000000000,
    "serverTimestamp": 1700000000050
}
```

### archviz_appCommand

Direction: **FromStreamer** (UE → Browser)

Handles application-level commands from UE. Currently supports:

| `command` value | Action |
|---|---|
| `ConfigFlagChanged` | Calls `config.setFlagEnabled(parsed.flag, parsed.value)` to toggle a config flag |

**Expected JSON format:**

```json
{
    "command": "ConfigFlagChanged",
    "flag": "FlagName",
    "value": true
}
```

---

## PixelStreaming Class — New Public API

Methods and accessors added to the `PixelStreaming` class:

| Method | Return | Description |
|---|---|---|
| `sendDevicePing()` | `void` | Manually send a ping to UE |
| `sendDeviceInfo()` | `void` | Send device info to UE (normally automatic after pong) |
| `handleDeviceInfoRequest(message)` | `void` | Handle an explicit device info request from UE |
| `getDeviceInfo()` | `DeviceInfo \| null` | Returns cached device info, or `null` if not yet collected |
| `hasDeviceInfoBeenSent()` | `boolean` | Whether device info was successfully sent to UE |

---

## Usage Examples

### Listening for device type to adapt UI

```typescript
const ps = new PixelStreaming(config);

ps.addEventListener('mobileDeviceDetected', (e) => {
    enableTouchControls();
    showMobileOverlay();
    console.log(`Mobile device: ${e.data.deviceInfo.deviceBrand} ${e.data.deviceInfo.deviceModel}`);
});

ps.addEventListener('desktopDeviceDetected', (_e) => {
    enableMouseKeyboardControls();
});
```

### Monitoring handshake health

```typescript
ps.addEventListener('devicePongReceived', (e) => {
    if (e.data.roundTripMs > 500) {
        showLatencyWarning();
    }
});

ps.addEventListener('handshakeTimeout', (e) => {
    showConnectionError(`UE not responding after ${e.data.attempts} pings`);
});
```

### Reacting to orientation changes

```typescript
ps.addEventListener('deviceOrientationChanged', (e) => {
    const { orientation, width, height } = e.data.orientationData.data;
    resizeViewport(width, height);
    console.log(`Orientation: ${orientation}`);
});
```

### Sending a custom command after handshake completes

```typescript
ps.addEventListener('deviceInfoSent', (_e) => {
    // Safe to send app-level messages — bidirectional channel is verified
    ps.emitUIInteraction({ type: 'appReady', timestamp: Date.now() });
});
```

---

*Generated for the Pixel Streaming Frontend custom extensions — UE 5.7*