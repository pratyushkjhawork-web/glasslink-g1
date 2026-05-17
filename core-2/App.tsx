/**
 * GlassLink G1 — BLE Protocol Simulator
 * Core Feature 2: Live Device Simulator
 *
 * Architecture:
 *   App.js  ──► protocol.js   (buildPacket / parsePacket / interpretPacket)
 *           ──► StreamBuffer  (fragmented / concatenated packet reassembly)
 *           ──► chaos.js      (10% corruption: byte-flip, truncate, bad-CRC)
 *
 * All BLE communication is simulated in-memory via React state.
 * No real hardware or backend required.
 *
 * Layout:
 *   [ Device Panel ] | [ Packet Log ] | [ App Panel ]
 *
 * Assumptions logged here (full list in README):
 *   - BLE MTU simulated at 20 bytes (real-world minimum per BT spec §3.2.8)
 *   - Packets larger than MTU are fragmented and reassembled via StreamBuffer
 *   - Unknown commands are logged as UNKNOWN, never crash the parser
 *   - Zero-length data fields are sent as 0x00 per spec §3 "0x00 if empty"
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Switch,
  StyleSheet,
  Platform,
  TextInput,
  Animated,
} from 'react-native';

// ─────────────────────────────────────────────
// SECTION 1 — PROTOCOL (ported from core-1)
// ─────────────────────────────────────────────

const HEADER_APP_TO_DEVICE = [0xAB, 0x55];
const HEADER_DEVICE_TO_APP = [0xAC, 0x55];
const MIN_PACKET_LENGTH = 6; // header(2) + length(2) + cmd(1) + crc(1)

const COMMANDS = {
  0x01: 'SET_LED',
  0x17: 'GET_BATTERY',
  0x22: 'TAKE_PHOTO',
  0x45: 'ACTION_SYNC',
  0x53: 'CHARGING_STATUS',
  0x59: 'SYNC_TIME',
};
const COMMAND_NAMES = COMMANDS as Record<number, string>;

/**
 * Compute CRC as defined in spec: (cmd + sum(data)) & 0xFF
 */
function computeCRC(cmd: number, data: number[]) {
  const dataSum = data.reduce((acc, b) => acc + b, 0);
  return (cmd + dataSum) & 0xFF;
}

/**
 * buildPacket(cmd, data, direction)
 * Returns a Uint8Array representing a complete GlassLink G1 packet.
 *
 * Spec mapping:
 *   Header  : 2 bytes — direction-dependent
 *   Length  : 2 bytes big-endian — covers cmd(1) + data(N) + crc(1)
 *   Command : 1 byte
 *   Data    : N bytes (0x00 if empty per spec)
 *   CRC     : 1 byte
 */
function buildPacket(cmd: number, data: number[] = [], direction = 'app->device') {
  if (typeof cmd !== 'number' || cmd < 0 || cmd > 0xFF) {
    throw new Error(`buildPacket: invalid cmd 0x${cmd?.toString(16)}`);
  }

  const safeData = data.length === 0 ? [0x00] : data;
  const header = direction === 'app->device'
    ? HEADER_APP_TO_DEVICE
    : HEADER_DEVICE_TO_APP;

  const crc = computeCRC(cmd, safeData);
  // length covers cmd(1) + data(N) + crc(1)
  const length = 1 + safeData.length + 1;

  return new Uint8Array([
    ...header,
    (length >> 8) & 0xFF,
    length & 0xFF,
    cmd,
    ...safeData,
    crc,
  ]);
}

/**
 * parsePacket(raw: Uint8Array)
 * Returns a parsed object or null on any failure.
 * Never throws — all errors are caught and returned as null.
 *
 * Returns:
 *   { header, direction, length, cmd, data, crc, valid, errorReason }
 */
function parsePacket(raw: Uint8Array) {
  try {
    if (!(raw instanceof Uint8Array)) return null;
    if (raw.length < MIN_PACKET_LENGTH) {
      return { valid: false, errorReason: `TOO_SHORT (${raw.length} bytes, need ≥${MIN_PACKET_LENGTH})` };
    }

    // Header check
    let direction = null;
    if (raw[0] === 0xAB && raw[1] === 0x55) direction = 'app->device';
    else if (raw[0] === 0xAC && raw[1] === 0x55) direction = 'device->app';
    else {
      return { valid: false, errorReason: `BAD_HEADER (${toHex(raw[0])} ${toHex(raw[1])})` };
    }

    // Length field (big-endian)
    const declaredLength = (raw[2] << 8) | raw[3];
    const expectedTotal = 4 + declaredLength; // header(2) + lengthField(2) + payload(declaredLength)

    if (raw.length < expectedTotal) {
      return {
        valid: false,
        errorReason: `TRUNCATED (have ${raw.length} bytes, need ${expectedTotal})`,
        direction,
        declaredLength,
      };
    }

    const cmd = raw[4];
    // data is everything between cmd and the final crc byte
    const data = Array.from(raw.slice(5, 4 + declaredLength - 1));
    const receivedCRC = raw[4 + declaredLength - 1];
    const expectedCRC = computeCRC(cmd, data.length === 0 ? [0x00] : data);

    const crcValid = receivedCRC === expectedCRC;

    return {
      valid: crcValid,
      errorReason: crcValid ? null : `CRC_MISMATCH (got ${toHex(receivedCRC)}, expected ${toHex(expectedCRC)})`,
      direction,
      cmd,
      cmdName: COMMAND_NAMES[cmd] ?? `UNKNOWN_0x${cmd.toString(16).toUpperCase().padStart(2, '0')}`,
      data,
      crc: receivedCRC,
      declaredLength,
      rawLength: raw.length,
    };
  } catch (err) {
    return { valid: false, errorReason: `PARSE_EXCEPTION: ${err.message}` };
  }
}

/**
 * interpretPacket(parsed)
 * Returns a human-readable string describing the packet contents.
 * Handles all 6 commands + unknown commands gracefully.
 */
function interpretPacket(parsed) {
  if (!parsed) return '⚠ null packet';
  if (!parsed.valid) return `✗ INVALID — ${parsed.errorReason}`;

  const d = parsed.data ?? [];

  switch (parsed.cmd) {
    case 0x01: {
      const level = d[0] === 0x30 ? 'LOW' : d[0] === 0x31 ? 'MEDIUM' : d[0] === 0x32 ? 'HIGH' : `UNKNOWN(${toHex(d[0])})`;
      return `💡 Set LED brightness → ${level}`;
    }
    case 0x17: {
      if (d.length < 2) return `🔋 Get Battery (reply) — malformed payload`;
      const charging = d[1] === 0x01 ? 'charging' : 'not charging';
      return `🔋 Battery → ${d[0]}% | ${charging}`;
    }
    case 0x22: {
      const mode = d[0] === 0x30 ? 'photo only' : d[0] === 0x31 ? 'photo + HD upload' : `UNKNOWN(${toHex(d[0])})`;
      return `📷 Take Photo → ${mode}`;
    }
    case 0x45: {
      if (d.length < 9) return `🔄 Action Sync — malformed (need 9 bytes, got ${d.length})`;
      const flags = ['photo', 'recording', 'mic', 'vol+', 'vol-', 'nod', 'shake', 'music', 'worn'];
      const active = flags.filter((_, i) => d[i] === 0x01);
      return `🔄 Action Sync → [${active.length > 0 ? active.join(', ') : 'all idle'}]`;
    }
    case 0x53: {
      if (d.length < 2) return `⚡ Charging Status — malformed payload`;
      const state = d[0] === 0x01 ? 'CHARGING' : 'NOT CHARGING';
      return `⚡ Charging Status → ${state} | ${d[1]}%`;
    }
    case 0x59: {
      if (d.length < 7) return `🕐 Sync Time — malformed (need 7 bytes, got ${d.length})`;
      const year = (d[0] << 8) | d[1];
      const [month, day, hour, min, sec] = d.slice(2, 7);
      return `🕐 Sync Time → ${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(min)}:${pad2(sec)}`;
    }
    default:
      return `❓ ${parsed.cmdName} — cmd=${toHex(parsed.cmd)} data=[${d.map(toHex).join(' ')}]`;
  }
}

// ─────────────────────────────────────────────
// SECTION 2 — STREAM BUFFER
// Handles fragmented packets split across multiple
// BLE notifications (real BLE MTU: 20–247 bytes).
// Assumption: we simulate MTU = 20 bytes.
// ─────────────────────────────────────────────

const SIMULATED_BLE_MTU = 20; // bytes per BLE notification (real-world minimum)

class StreamBuffer {
  _buf: Uint8Array;

  constructor() {
    this._buf = new Uint8Array(0);
  }

  /**
   * Feed raw bytes into the buffer.
   * Returns array of fully reassembled packets (Uint8Array[]).
   * Partial packets remain buffered until more bytes arrive.
   */
  feed(chunk: Uint8Array) {
    // Append chunk to existing buffer
    const merged = new Uint8Array(this._buf.length + chunk.length);
    merged.set(this._buf);
    merged.set(chunk, this._buf.length);
    this._buf = merged;

    const complete: Uint8Array[] = [];

    while (this._buf.length >= MIN_PACKET_LENGTH) {
      // Scan for a valid header starting at position 0
      // If header is invalid, discard one byte and re-scan (defensive)
      if (
        !(this._buf[0] === 0xAB && this._buf[1] === 0x55) &&
        !(this._buf[0] === 0xAC && this._buf[1] === 0x55)
      ) {
        this._buf = this._buf.slice(1);
        continue;
      }

      if (this._buf.length < 4) break; // need length field

      const declaredLength = (this._buf[2] << 8) | this._buf[3];
      const expectedTotal = 4 + declaredLength;

      if (this._buf.length < expectedTotal) break; // partial — wait for more

      complete.push(this._buf.slice(0, expectedTotal));
      this._buf = this._buf.slice(expectedTotal);
    }

    return complete;
  }

  clear() {
    this._buf = new Uint8Array(0);
  }

  get pendingBytes() {
    return this._buf.length;
  }
}

// ─────────────────────────────────────────────
// SECTION 3 — CHAOS ENGINE
// Randomly corrupts 10% of outgoing packets.
// Three corruption modes chosen randomly:
//   (a) byte-flip  — XOR a random byte with 0xFF
//   (b) truncation — drop last 2 bytes
//   (c) bad CRC    — flip the final CRC byte
// ─────────────────────────────────────────────

function maybeCorrupt(packet, chaosEnabled) {
  if (!chaosEnabled || Math.random() >= 0.10) {
    return { data: packet, corrupted: false, corruptionType: null };
  }

  const copy = new Uint8Array(packet);
  const roll = Math.floor(Math.random() * 3);

  if (roll === 0) {
    // byte-flip: pick any byte (skip header to keep it findable)
    const idx = 2 + Math.floor(Math.random() * (copy.length - 2));
    copy[idx] ^= 0xFF;
    return { data: copy, corrupted: true, corruptionType: 'BYTE_FLIP', corruptedIndex: idx };
  }

  if (roll === 1) {
    // truncation: drop last 2 bytes
    if (copy.length <= 3) {
      return { data: new Uint8Array(0), corrupted: true, corruptionType: 'FULL_TRUNCATION' };
    }
    return { data: copy.slice(0, copy.length - 2), corrupted: true, corruptionType: 'TRUNCATION' };
  }

  // bad CRC: flip the last byte (the CRC field)
  copy[copy.length - 1] ^= 0xFF;
  return { data: copy, corrupted: true, corruptionType: 'BAD_CRC' };
}

// ─────────────────────────────────────────────
// SECTION 4 — HELPERS
// ─────────────────────────────────────────────

function toHex(byte: number) {
  return '0x' + (byte ?? 0).toString(16).toUpperCase().padStart(2, '0');
}

function toHexDump(uint8Array: Uint8Array | null) {
  if (!uint8Array || uint8Array.length === 0) return '(empty)';
  return Array.from(uint8Array)
    .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function formatTimestamp(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function currentTimeBytes() {
  const now = new Date();
  const year = now.getFullYear();
  return [
    (year >> 8) & 0xFF,
    year & 0xFF,
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ];
}

/**
 * Fragment a packet into MTU-sized chunks.
 * Real BLE devices fragment large packets across multiple notifications.
 * We simulate this for packets > SIMULATED_BLE_MTU bytes.
 */
function fragmentPacket(packet) {
  const chunks = [];
  for (let i = 0; i < packet.length; i += SIMULATED_BLE_MTU) {
    chunks.push(packet.slice(i, i + SIMULATED_BLE_MTU));
  }
  return chunks;
}

// ─────────────────────────────────────────────
// SECTION 5 — CONNECTION STATE MACHINE
// Simulates BLE connection lifecycle:
//   DISCONNECTED → CONNECTING → CONNECTED → DISCONNECTED
// This is a positive-signal detail — real apps manage this.
// ─────────────────────────────────────────────

const CONNECTION_STATES = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
};

// ─────────────────────────────────────────────
// SECTION 6 — ROOT APP COMPONENT
// ─────────────────────────────────────────────

export default function App() {
  // ── Connection state ──
  const [connState, setConnState] = useState(CONNECTION_STATES.DISCONNECTED);

  // ── Shared packet log ──
  const [packetLog, setPacketLog] = useState([]);

  // ── Chaos mode ──
  const [chaosMode, setChaosMode] = useState(false);

  // ── Statistics ──
  const [stats, setStats] = useState({
    total: 0,
    corrupted: 0,
    crcFailed: 0,
    fragmented: 0,
    reassembled: 0,
  });

  // ── App panel state (phone-side view) ──
  const [appState, setAppState] = useState({
    batteryLevel: null,
    isCharging: null,
    ledBrightness: null,
    lastEvent: null,
    deviceFlags: {
      photo: false, recording: false, mic: false,
      volUp: false, volDown: false, nod: false,
      shake: false, music: false, worn: false,
    },
  });

  // ── Device panel state (glasses-side) ──
  const [deviceState, setDeviceState] = useState({
    battery: 85,
    charging: false,
    ledBrightness: 'medium',
    worn: true,
  });

  // ── Stream buffers — one per direction ──
  const appBuffer = useRef(new StreamBuffer());
  const deviceBuffer = useRef(new StreamBuffer());

  // ── Packet log scroll ref ──
  const logScrollRef = useRef(null);

  // ── Auto-scroll when log updates ──
  useEffect(() => {
    if (logScrollRef.current) {
      setTimeout(() => logScrollRef.current?.scrollToEnd?.({ animated: true }), 50);
    }
  }, [packetLog]);

  // ─────────────────────────────────────────
  // Core transmission function
  // Handles: fragmentation, chaos corruption,
  // stream buffer reassembly, parsing, logging
  // ─────────────────────────────────────────

  const transmit = useCallback((packet, direction, meta = {}) => {
    if (connState !== CONNECTION_STATES.CONNECTED) return;

    const now = new Date();
    const fragments = fragmentPacket(packet);
    const wasFragmented = fragments.length > 1;

    // Determine which buffer receives this (opposite side from sender)
    const receivingBuffer = direction === 'app->device' ? deviceBuffer : appBuffer;

    let reassembled = null;
    const corruptionResults = [];

    fragments.forEach((fragment, fragIdx) => {
      const { data: maybeCorrupted, corrupted, corruptionType } = maybeCorrupt(fragment, chaosMode);
      corruptionResults.push({ corrupted, corruptionType });

      const completed = receivingBuffer.current.feed(maybeCorrupted);
      if (completed.length > 0) {
        reassembled = completed[0]; // take the first reassembled packet
      }
    });

    const anyCorrrupted = corruptionResults.some(r => r.corrupted);
    const corruptionType = corruptionResults.find(r => r.corrupted)?.corruptionType ?? null;

    // Parse whichever we have — prefer reassembled, fall back to raw packet
    const toParse = reassembled ?? packet;
    const parsed = parsePacket(toParse);
    const interpretation = interpretPacket(parsed);

    const logEntry = {
      id: `${Date.now()}-${Math.random()}`,
      timestamp: formatTimestamp(now),
      direction,
      raw: toParse,
      hexDump: toHexDump(toParse),
      parsed,
      interpretation,
      corrupted: anyCorrrupted,
      corruptionType,
      fragmented: wasFragmented,
      fragmentCount: fragments.length,
      pendingBytes: receivingBuffer.current.pendingBytes,
      meta,
    };

    setPacketLog(prev => [...prev, logEntry]);

    // Update statistics
    setStats(prev => ({
      total: prev.total + 1,
      corrupted: prev.corrupted + (anyCorrrupted ? 1 : 0),
      crcFailed: prev.crcFailed + (parsed && !parsed.valid && parsed.errorReason?.startsWith('CRC') ? 1 : 0),
      fragmented: prev.fragmented + (wasFragmented ? 1 : 0),
      reassembled: prev.reassembled + (reassembled ? 1 : 0),
    }));

    // Update receiver-side state if packet is valid
    if (parsed?.valid) {
      if (direction === 'device->app') {
        updateAppState(parsed);
      } else {
        updateDeviceStateFromCommand(parsed);
      }
    }
  }, [connState, chaosMode]);

  // ─────────────────────────────────────────
  // State updaters
  // ─────────────────────────────────────────

function updateAppState(parsed) {
    setAppState(prev => {
      const next = { ...prev };
      switch (parsed.cmd) {
        case 0x53:
          next.isCharging = parsed.data[0] === 0x01;
          next.batteryLevel = parsed.data[1];
          next.lastEvent = `Charging update received`;
          break;
        case 0x45: {
          const flagNames = ['photo', 'recording', 'mic', 'volUp', 'volDown', 'nod', 'shake', 'music', 'worn'];
          const flags = {} as typeof prev.deviceFlags;
          flagNames.forEach((name, i) => { flags[name] = parsed.data[i] === 0x01; });
          next.deviceFlags = flags;
          next.lastEvent = `Action sync received`;
          break;
        }
        default:
          next.lastEvent = `Received: ${parsed.cmdName}`;
      }
      return next;
    });
  }

  function updateDeviceStateFromCommand(parsed) {
    setDeviceState(prev => {
      const next = { ...prev };
      switch (parsed.cmd) {
        case 0x01:
          next.ledBrightness = parsed.data[0] === 0x30 ? 'low'
            : parsed.data[0] === 0x31 ? 'medium' : 'high';
          break;
        default:
          break;
      }
      return next;
    });
  }

  // ─────────────────────────────────────────
  // Connection simulation
  // ─────────────────────────────────────────

  function handleConnect() {
    setConnState(CONNECTION_STATES.CONNECTING);
    setTimeout(() => {
      setConnState(CONNECTION_STATES.CONNECTED);
      // Log a synthetic "connection established" entry
      setPacketLog(prev => [...prev, {
        id: `conn-${Date.now()}`,
        timestamp: formatTimestamp(new Date()),
        direction: 'system',
        raw: null,
        hexDump: null,
        parsed: null,
        interpretation: '🔗 BLE Connection established — GlassLink G1 connected (simulated)',
        corrupted: false,
        meta: { system: true },
      }]);
    }, 1200);
  }

  function handleDisconnect() {
    setConnState(CONNECTION_STATES.DISCONNECTED);
    appBuffer.current.clear();
    deviceBuffer.current.clear();
    setPacketLog(prev => [...prev, {
      id: `disc-${Date.now()}`,
      timestamp: formatTimestamp(new Date()),
      direction: 'system',
      raw: null,
      hexDump: null,
      parsed: null,
      interpretation: '🔌 BLE Connection terminated',
      corrupted: false,
      meta: { system: true },
    }]);
  }

  function clearLog() {
    setPacketLog([]);
    setStats({ total: 0, corrupted: 0, crcFailed: 0, fragmented: 0, reassembled: 0 });
  }

  // ─────────────────────────────────────────
  // DEVICE PANEL actions (glasses → phone)
  // ─────────────────────────────────────────

  function deviceSendChargingStatus() {
    const packet = buildPacket(
      0x53,
      [deviceState.charging ? 0x01 : 0x00, deviceState.battery],
      'device->app'
    );
    transmit(packet, 'device->app', { trigger: 'Charging Status button' });
  }

  function deviceSendActionSync(overrides = {}) {
    // 9 bytes: [photo, recording, mic, vol+, vol-, nod, shake, music, worn]
    const defaults = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, deviceState.worn ? 0x01 : 0x00];
    const keys = ['photo', 'recording', 'mic', 'volUp', 'volDown', 'nod', 'shake', 'music', 'worn'];
    keys.forEach((key, i) => { if (overrides[key]) defaults[i] = 0x01; });
    const packet = buildPacket(0x45, defaults, 'device->app');
    transmit(packet, 'device->app', { trigger: `Action Sync (${Object.keys(overrides).join(',') || 'idle'})` });
  }

  function deviceToggleCharging() {
    setDeviceState(prev => ({ ...prev, charging: !prev.charging }));
  }

  function deviceChangeBattery(delta) {
    setDeviceState(prev => ({
      ...prev,
      battery: Math.max(0, Math.min(100, prev.battery + delta)),
    }));
  }

  // ─────────────────────────────────────────
  // APP PANEL actions (phone → glasses)
  // ─────────────────────────────────────────

  function appSendSetLED(level) {
    const levelByte = level === 'low' ? 0x30 : level === 'medium' ? 0x31 : 0x32;
    const packet = buildPacket(0x01, [levelByte], 'app->device');
    transmit(packet, 'app->device', { trigger: `Set LED ${level}` });
  }

  function appSendTakePhoto(hdUpload = false) {
    const packet = buildPacket(0x22, [hdUpload ? 0x31 : 0x30], 'app->device');
    transmit(packet, 'app->device', { trigger: hdUpload ? 'Take Photo (HD)' : 'Take Photo' });
  }

  function appSendSyncTime() {
    const packet = buildPacket(0x59, currentTimeBytes(), 'app->device');
    transmit(packet, 'app->device', { trigger: 'Sync Time' });
  }

  function appRequestBattery() {
    // Get battery: spec says reply [level%, charging_status], but doesn't say
    // how to request it. Assumption: cmd 0x17 with empty data = request.
    // We simulate the device auto-replying after 300ms.
    const requestPacket = buildPacket(0x17, [], 'app->device');
    transmit(requestPacket, 'app->device', { trigger: 'Request Battery' });
    setTimeout(() => {
      const replyPacket = buildPacket(
        0x17,
        [deviceState.battery, deviceState.charging ? 0x01 : 0x00],
        'device->app'
      );
      transmit(replyPacket, 'device->app', { trigger: 'Battery Reply (auto)' });
    }, 300);
  }

  // ─────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────

  const isConnected = connState === CONNECTION_STATES.CONNECTED;
  const isConnecting = connState === CONNECTION_STATES.CONNECTING;

  return (
    <View style={styles.root}>
      {/* ── TOP BAR ── */}
      <View style={styles.topBar}>
        <Text style={styles.topBarTitle}>GlassLink G1 — BLE Simulator</Text>
        <View style={styles.topBarRight}>
          {/* Chaos mode toggle */}
          <View style={styles.chaosRow}>
            <Text style={[styles.chaosLabel, chaosMode && styles.chaosLabelActive]}>
              ⚡ CHAOS {chaosMode ? 'ON' : 'OFF'}
            </Text>
            <Switch
              value={chaosMode}
              onValueChange={setChaosMode}
              trackColor={{ false: '#2a2a3a', true: '#ff3b30' }}
              thumbColor={chaosMode ? '#ff6b6b' : '#555'}
            />
          </View>

          {/* Connection button */}
          <TouchableOpacity
            style={[
              styles.connBtn,
              isConnected && styles.connBtnConnected,
              isConnecting && styles.connBtnConnecting,
            ]}
            onPress={isConnected ? handleDisconnect : handleConnect}
            disabled={isConnecting}
          >
            <Text style={styles.connBtnText}>
              {isConnecting ? '⟳ Connecting…' : isConnected ? '⬤ Disconnect' : '○ Connect'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── STATS BAR ── */}
      <View style={styles.statsBar}>
        {[
          ['Packets', stats.total],
          ['Corrupted', stats.corrupted],
          ['CRC Fail', stats.crcFailed],
          ['Fragmented', stats.fragmented],
          ['Reassembled', stats.reassembled],
          [`MTU`, `${SIMULATED_BLE_MTU}B`],
        ].map(([label, val]) => (
          <View key={label} style={styles.statCell}>
            <Text style={styles.statVal}>{val}</Text>
            <Text style={styles.statLabel}>{label}</Text>
          </View>
        ))}
      </View>

      {/* ── MAIN 3-COLUMN LAYOUT ── */}
      <View style={styles.columns}>

        {/* ══ DEVICE PANEL (left) ══ */}
        <View style={[styles.panel, styles.devicePanel]}>
          <ScrollView style={styles.panelScroll} contentContainerStyle={styles.panelScrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelHeaderIcon}>🕶</Text>
            <Text style={styles.panelHeaderTitle}>GlassLink G1</Text>
            <Text style={styles.panelHeaderSub}>Device (Glasses)</Text>
          </View>

          {/* Device internal state */}
          <View style={styles.stateCard}>
            <Text style={styles.stateCardTitle}>Internal State</Text>
            <StateRow label="Battery" value={`${deviceState.battery}%`} />
            <StateRow label="Charging" value={deviceState.charging ? '⚡ Yes' : '○ No'} />
            <StateRow label="Worn" value={deviceState.worn ? '✓ Yes' : '✗ No'} />
            <StateRow label="LED" value={deviceState.ledBrightness.toUpperCase()} />
          </View>

          {/* Battery controls */}
          <SectionLabel text="Battery Controls" />
          <View style={styles.buttonRow}>
            <PanelButton
              label="−10%"
              onPress={() => {
                const nextBattery = Math.max(0, deviceState.battery - 10);
                setDeviceState(prev => ({ ...prev, battery: nextBattery }));
                const packet = buildPacket(
                  0x53,
                  [deviceState.charging ? 0x01 : 0x00, nextBattery],
                  'device->app'
                );
                transmit(packet, 'device->app', { trigger: 'Battery −10%' });
              }}
              disabled={!isConnected}
              color="#e67e22"
            />
            <PanelButton
              label="+10%"
              onPress={() => {
                const nextBattery = Math.min(100, deviceState.battery + 10);
                setDeviceState(prev => ({ ...prev, battery: nextBattery }));
                const packet = buildPacket(
                  0x53,
                  [deviceState.charging ? 0x01 : 0x00, nextBattery],
                  'device->app'
                );
                transmit(packet, 'device->app', { trigger: 'Battery +10%' });
              }}
              disabled={!isConnected}
              color="#27ae60"
            />
          </View>
          <PanelButton
            label={deviceState.charging ? '⚡ Unplug Charger' : '🔌 Plug Charger'}
            onPress={() => {
              // Compute next charging state explicitly here — do NOT rely on
              // setDeviceState having applied before buildPacket reads it.
              // React state updates are async; reading deviceState.charging
              // after calling setDeviceState gives the OLD value (stale closure).
              const nextCharging = !deviceState.charging;
              setDeviceState(prev => ({ ...prev, charging: nextCharging }));
              const packet = buildPacket(
                0x53,
                [nextCharging ? 0x01 : 0x00, deviceState.battery],
                'device->app'
              );
              transmit(packet, 'device->app', {
                trigger: nextCharging ? 'Plug Charger' : 'Unplug Charger',
              });
            }}
            disabled={!isConnected}
            color="#8e44ad"
            fullWidth
          />
          <PanelButton
            label="📡 Send Charging Status"
            onPress={deviceSendChargingStatus}
            disabled={!isConnected}
            color="#2980b9"
            fullWidth
          />

          {/* Gesture / event buttons */}
          <SectionLabel text="Gesture Events" />
          <PanelButton
            label="📷 Photo Taken"
            onPress={() => deviceSendActionSync({ photo: true })}
            disabled={!isConnected}
            color="#16a085"
            fullWidth
          />
          <PanelButton
            label="↕ Nod Detected"
            onPress={() => deviceSendActionSync({ nod: true })}
            disabled={!isConnected}
            color="#16a085"
            fullWidth
          />
          <PanelButton
            label="↔ Shake Detected"
            onPress={() => deviceSendActionSync({ shake: true })}
            disabled={!isConnected}
            color="#16a085"
            fullWidth
          />
          <PanelButton
            label="🎤 Mic Active"
            onPress={() => deviceSendActionSync({ mic: true })}
            disabled={!isConnected}
            color="#16a085"
            fullWidth
          />
          <PanelButton
            label="🎵 Music Active"
            onPress={() => deviceSendActionSync({ music: true })}
            disabled={!isConnected}
            color="#16a085"
            fullWidth
          />
          <PanelButton
            label="🔄 All Idle Sync"
            onPress={() => deviceSendActionSync({})}
            disabled={!isConnected}
            color="#7f8c8d"
            fullWidth
          />
          <PanelButton
            label={deviceState.worn ? '🕶 Remove Glasses' : '🕶 Wear Glasses'}
            onPress={() => {
              // Same pattern — compute next value before setState, pass explicitly.
              const nextWorn = !deviceState.worn;
              setDeviceState(prev => ({ ...prev, worn: nextWorn }));
              const defaults = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, nextWorn ? 0x01 : 0x00];
              const packet = buildPacket(0x45, defaults, 'device->app');
              transmit(packet, 'device->app', {
                trigger: nextWorn ? 'Wear Glasses' : 'Remove Glasses',
              });
            }}
            disabled={!isConnected}
            color="#c0392b"
            fullWidth
          />
          </ScrollView>
        </View>

        {/* ══ PACKET LOG (centre) ══ */}
        <View style={styles.logPanel}>
          <View style={styles.logHeader}>
            <Text style={styles.logHeaderTitle}>📟 Packet Log</Text>
            <TouchableOpacity onPress={clearLog} style={styles.clearBtn}>
              <Text style={styles.clearBtnText}>Clear</Text>
            </TouchableOpacity>
          </View>

          {/* Direction legend */}
          <View style={styles.legend}>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: COLORS.appToDevice }]} />
              <Text style={styles.legendText}>App → Device</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: COLORS.deviceToApp }]} />
              <Text style={styles.legendText}>Device → App</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: COLORS.corrupted }]} />
              <Text style={styles.legendText}>Corrupted</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: COLORS.system }]} />
              <Text style={styles.legendText}>System</Text>
            </View>
          </View>

          <ScrollView
            ref={logScrollRef}
            style={styles.logScroll}
            contentContainerStyle={styles.logScrollContent}
          >
            {packetLog.length === 0 && (
              <Text style={styles.logEmpty}>
                Connect to start capturing packets.{'\n'}
                All packets will appear here with timestamps,{'\n'}
                direction arrows, hex dumps, and parsed meaning.
              </Text>
            )}
            {packetLog.map(entry => (
              <PacketLogEntry key={entry.id} entry={entry} />
            ))}
          </ScrollView>
        </View>

        {/* ══ APP PANEL (right) ══ */}
        <View style={[styles.panel, styles.appPanel]}>
          <ScrollView style={styles.panelScroll} contentContainerStyle={styles.panelScrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelHeaderIcon}>📱</Text>
            <Text style={styles.panelHeaderTitle}>Companion App</Text>
            <Text style={styles.panelHeaderSub}>Phone (App)</Text>
          </View>

          {/* Live device state as seen by the phone */}
          <View style={styles.stateCard}>
            <Text style={styles.stateCardTitle}>Received Device State</Text>
            <StateRow
              label="Battery"
              value={appState.batteryLevel !== null ? `${appState.batteryLevel}%` : '—'}
            />
            <StateRow
              label="Charging"
              value={appState.isCharging === null ? '—'
                : appState.isCharging ? '⚡ Yes' : '○ No'}
            />
            <StateRow
              label="LED"
              value={appState.ledBrightness?.toUpperCase() ?? '—'}
            />
            <StateRow
              label="Last Event"
              value={appState.lastEvent ?? '—'}
            />
          </View>

          {/* Device flags received via 0x45 Action Sync */}
          <View style={styles.flagGrid}>
            {Object.entries(appState.deviceFlags).map(([key, val]) => (
              <View key={key} style={[styles.flagCell, val && styles.flagCellActive]}>
                <Text style={[styles.flagText, val && styles.flagTextActive]}>
                  {key}
                </Text>
              </View>
            ))}
          </View>

          {/* LED control */}
          <SectionLabel text="LED Control" />
          <View style={styles.buttonRow}>
            {['low', 'medium', 'high'].map(level => (
              <PanelButton
                key={level}
                label={level.charAt(0).toUpperCase() + level.slice(1)}
                onPress={() => appSendSetLED(level)}
                disabled={!isConnected}
                color={level === 'low' ? '#555' : level === 'medium' ? '#f39c12' : '#f1c40f'}
              />
            ))}
          </View>

          {/* Camera commands */}
          <SectionLabel text="Camera" />
          <PanelButton
            label="📷 Take Photo"
            onPress={() => appSendTakePhoto(false)}
            disabled={!isConnected}
            color="#2980b9"
            fullWidth
          />
          <PanelButton
            label="📷 Take Photo (HD Upload)"
            onPress={() => appSendTakePhoto(true)}
            disabled={!isConnected}
            color="#1a6fa8"
            fullWidth
          />

          {/* System commands */}
          <SectionLabel text="System" />
          <PanelButton
            label="🕐 Sync Time"
            onPress={appSendSyncTime}
            disabled={!isConnected}
            color="#16a085"
            fullWidth
          />
          <PanelButton
            label="🔋 Request Battery"
            onPress={appRequestBattery}
            disabled={!isConnected}
            color="#8e44ad"
            fullWidth
          />

          {/* Chaos mode explanation */}
          <View style={styles.chaosInfoCard}>
            <Text style={styles.chaosInfoTitle}>⚡ Chaos Mode</Text>
            <Text style={styles.chaosInfoText}>
              When enabled, 10% of outgoing packets are randomly corrupted via byte-flip,
              truncation, or CRC mutation. The parser handles all three gracefully — watch the
              log for ✗ INVALID entries.
            </Text>
            {chaosMode && (
              <Text style={styles.chaosInfoActive}>ACTIVE — corrupting ~10% of packets</Text>
            )}
          </View>

          {/* BLE spec note */}
          <View style={styles.specsCard}>
            <Text style={styles.specsTitle}>BLE Simulation Notes</Text>
            <Text style={styles.specsText}>
              MTU: {SIMULATED_BLE_MTU} bytes (real min per BT Core §3.2.8).
              Packets &gt; {SIMULATED_BLE_MTU}B are fragmented and reassembled
              via StreamBuffer. Fragmented count tracked in stats bar.
            </Text>
          </View>
          </ScrollView>
        </View>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────
// SECTION 7 — SUB-COMPONENTS
// ─────────────────────────────────────────────

/**
 * PacketLogEntry
 * Renders one row in the packet log:
 *   [timestamp] [direction arrow] [interpretation] \n [hex dump]
 * Colour-coded by direction and corruption status.
 */
function PacketLogEntry({ entry }) {
  const isSystem = entry.meta?.system;
  const dirColor = isSystem
    ? COLORS.system
    : entry.corrupted
    ? COLORS.corrupted
    : entry.direction === 'app->device'
    ? COLORS.appToDevice
    : COLORS.deviceToApp;

  const arrow = entry.direction === 'app->device' ? '→'
    : entry.direction === 'device->app' ? '←'
    : '⬡';

  return (
    <View style={[styles.logEntry, { borderLeftColor: dirColor }]}>
      <View style={styles.logEntryHeader}>
        <Text style={[styles.logTimestamp]}>{entry.timestamp}</Text>
        <Text style={[styles.logArrow, { color: dirColor }]}>{arrow}</Text>
        {entry.corrupted && (
          <Text style={styles.logCorruptBadge}>⚡ {entry.corruptionType}</Text>
        )}
        {entry.fragmented && (
          <Text style={styles.logFragBadge}>🔗 {entry.fragmentCount} frags</Text>
        )}
      </View>
      <Text style={[styles.logInterpretation, { color: entry.corrupted ? COLORS.corrupted : '#e0e0e0' }]}>
        {entry.interpretation}
      </Text>
      {entry.hexDump && (
        <Text style={styles.logHexDump}>{entry.hexDump}</Text>
      )}
      {entry.parsed && !entry.parsed.valid && entry.parsed.errorReason && (
        <Text style={styles.logError}>↳ {entry.parsed.errorReason}</Text>
      )}
    </View>
  );
}

function PanelButton({ label, onPress, disabled, color, fullWidth = false }) {
  return (
    <TouchableOpacity
      style={[
        styles.panelBtn,
        fullWidth && styles.panelBtnFull,
        disabled
          ? { backgroundColor: '#1e1e2e', borderColor: '#2a2a3e' }
          : { backgroundColor: color, borderColor: 'rgba(255,255,255,0.12)' },
      ]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <Text style={[styles.panelBtnText, disabled && styles.panelBtnTextDisabled]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function StateRow({ label, value }) {
  return (
    <View style={styles.stateRow}>
      <Text style={styles.stateLabel}>{label}</Text>
      <Text style={styles.stateValue}>{value}</Text>
    </View>
  );
}

function SectionLabel({ text }) {
  return <Text style={styles.sectionLabel}>{text}</Text>;
}

// ─────────────────────────────────────────────
// SECTION 8 — COLOURS & STYLES
// ─────────────────────────────────────────────

const COLORS = {
  appToDevice: '#4fc3f7',   // blue — phone sending to glasses
  deviceToApp: '#81c784',   // green — glasses sending to phone
  corrupted: '#ef5350',     // red — corrupted packets
  system: '#b0bec5',        // grey — system / connection events
  bg: '#0d0d14',
  surface: '#13131f',
  surfaceAlt: '#1a1a2e',
  border: '#2a2a3e',
  text: '#e0e0e0',
  textSub: '#8a8aaa',
  accent: '#4fc3f7',
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
    fontFamily: Platform.OS === 'web' ? "'JetBrains Mono', 'Courier New', monospace" : 'monospace',
  },

  // ── Top bar ──
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.surface,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  topBarTitle: {
    color: COLORS.accent,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: Platform.OS === 'web' ? "'JetBrains Mono', monospace" : 'monospace',
  },
  topBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  chaosRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chaosLabel: {
    color: COLORS.textSub,
    fontSize: 12,
    fontWeight: '600',
  },
  chaosLabelActive: {
    color: COLORS.corrupted,
  },
  connBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: '#1e3a5f',
    borderWidth: 1,
    borderColor: COLORS.accent,
  },
  connBtnConnected: {
    backgroundColor: '#1e3d1e',
    borderColor: '#81c784',
  },
  connBtnConnecting: {
    backgroundColor: '#3a3a1e',
    borderColor: '#f39c12',
  },
  connBtnText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '600',
  },

  // ── Stats bar ──
  statsBar: {
    flexDirection: 'row',
    backgroundColor: COLORS.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingVertical: 6,
    paddingHorizontal: 12,
    gap: 0,
  },
  statCell: {
    flex: 1,
    alignItems: 'center',
    borderRightWidth: 1,
    borderRightColor: COLORS.border,
    paddingVertical: 2,
  },
  statVal: {
    color: COLORS.accent,
    fontSize: 14,
    fontWeight: '700',
  },
  statLabel: {
    color: COLORS.textSub,
    fontSize: 9,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  // ── 3-column layout ──
  columns: {
    flex: 1,
    flexDirection: 'row',
  },

  // ── Panel shared ──
  // overflow:'scroll' is not valid in React Native — panels are
  // wrapped in ScrollView in JSX instead.
  panel: {
    width: 240,
    backgroundColor: COLORS.surface,
    borderRightWidth: 1,
    borderRightColor: COLORS.border,
  },
  panelScroll: {
    flex: 1,
  },
  panelScrollContent: {
    padding: 12,
    paddingBottom: 24,
  },
  devicePanel: {
    borderRightColor: COLORS.border,
  },
  appPanel: {
    borderLeftWidth: 1,
    borderLeftColor: COLORS.border,
    borderRightWidth: 0,
  },
  panelHeader: {
    alignItems: 'center',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    marginBottom: 10,
  },
  panelHeaderIcon: {
    fontSize: 28,
    marginBottom: 4,
  },
  panelHeaderTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  panelHeaderSub: {
    color: COLORS.textSub,
    fontSize: 10,
    marginTop: 2,
  },

  // ── State card ──
  stateCard: {
    backgroundColor: COLORS.surfaceAlt,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  stateCardTitle: {
    color: COLORS.textSub,
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 6,
  },
  stateRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  stateLabel: {
    color: COLORS.textSub,
    fontSize: 11,
  },
  stateValue: {
    color: COLORS.text,
    fontSize: 11,
    fontWeight: '600',
  },

  // ── Flag grid ──
  flagGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginBottom: 10,
  },
  flagCell: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#2a2a3e',
  },
  flagCellActive: {
    backgroundColor: '#1a3a2e',
    borderColor: '#81c784',
  },
  flagText: {
    color: COLORS.textSub,
    fontSize: 9,
    fontWeight: '600',
  },
  flagTextActive: {
    color: '#81c784',
  },

  // ── Buttons ──
  sectionLabel: {
    color: COLORS.textSub,
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 10,
    marginBottom: 5,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: 8,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 4,
  },
  // panelBtn is used in two modes:
  //   default (inside buttonRow) — flex:1 to share row width equally
  //   fullWidth — alignSelf stretch, no flex
  panelBtn: {
    flex: 1,
    paddingVertical: 9,
    paddingHorizontal: 8,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 5,
    minHeight: 36,
    // subtle inner border for depth
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  panelBtnFull: {
    flex: 0,
    alignSelf: 'stretch',
  },
  panelBtnText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  panelBtnTextDisabled: {
    color: '#444455',
  },

  // ── Packet log ──
  logPanel: {
    flex: 1,
    backgroundColor: COLORS.bg,
    display: 'flex',
    flexDirection: 'column',
  },
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  logHeaderTitle: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  clearBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#2a2a3a',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  clearBtnText: {
    color: COLORS.textSub,
    fontSize: 10,
  },
  legend: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingVertical: 5,
    gap: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    color: COLORS.textSub,
    fontSize: 9,
  },
  logScroll: {
    flex: 1,
  },
  logScrollContent: {
    padding: 10,
    gap: 4,
  },
  logEmpty: {
    color: COLORS.textSub,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 40,
    lineHeight: 20,
  },
  logEntry: {
    backgroundColor: COLORS.surface,
    borderRadius: 6,
    padding: 8,
    marginBottom: 4,
    borderLeftWidth: 3,
  },
  logEntryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
  },
  logTimestamp: {
    color: COLORS.textSub,
    fontSize: 10,
    fontFamily: Platform.OS === 'web' ? "'JetBrains Mono', monospace" : 'monospace',
  },
  logArrow: {
    fontSize: 12,
    fontWeight: '700',
  },
  logCorruptBadge: {
    color: COLORS.corrupted,
    fontSize: 9,
    backgroundColor: '#2d1414',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: '#5c2020',
  },
  logFragBadge: {
    color: '#f39c12',
    fontSize: 9,
    backgroundColor: '#2d2214',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: '#5c4420',
  },
  logInterpretation: {
    color: COLORS.text,
    fontSize: 11,
    marginBottom: 4,
  },
  logHexDump: {
    color: '#7986cb',
    fontSize: 10,
    fontFamily: Platform.OS === 'web' ? "'JetBrains Mono', monospace" : 'monospace',
    letterSpacing: 0.5,
  },
  logError: {
    color: COLORS.corrupted,
    fontSize: 10,
    marginTop: 2,
    fontFamily: Platform.OS === 'web' ? "'JetBrains Mono', monospace" : 'monospace',
  },

  // ── Chaos info card ──
  chaosInfoCard: {
    marginTop: 12,
    padding: 10,
    backgroundColor: '#1a0d0d',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#5c2020',
  },
  chaosInfoTitle: {
    color: COLORS.corrupted,
    fontSize: 10,
    fontWeight: '700',
    marginBottom: 4,
  },
  chaosInfoText: {
    color: COLORS.textSub,
    fontSize: 9,
    lineHeight: 14,
  },
  chaosInfoActive: {
    color: COLORS.corrupted,
    fontSize: 9,
    fontWeight: '700',
    marginTop: 5,
  },

  // ── Specs card ──
  specsCard: {
    marginTop: 8,
    padding: 10,
    backgroundColor: '#0d1a1a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1a3a3a',
  },
  specsTitle: {
    color: COLORS.accent,
    fontSize: 10,
    fontWeight: '700',
    marginBottom: 4,
  },
  specsText: {
    color: COLORS.textSub,
    fontSize: 9,
    lineHeight: 14,
  },
});
