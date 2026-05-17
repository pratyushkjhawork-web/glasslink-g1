from dataclasses import dataclass
from typing import Optional

HEADER_APP_TO_DEVICE = bytes([0xAB, 0x55])
HEADER_DEVICE_TO_APP = bytes([0xAC, 0x55])
MIN_PACKET_SIZE = 6  # header(2) + length(2) + command(1) + crc(1)


@dataclass(frozen=True)
class ParsedPacket:
    direction: str
    command: int
    data: bytes
    crc: int
    crc_valid: bool = True


def calculate_crc(cmd: int, data: bytes) -> int:
    """GlassLink G1 checksum: (cmd + sum(data)) & 0xFF."""
    # The checksum intentionally ignores header and length, exactly as specified.
    return (cmd + sum(data)) & 0xFF


def build_packet(cmd: int, data: bytes = b"", direction: str = "app_to_device") -> bytes:
    """
    Build one GlassLink G1 packet.

    Length is big-endian and covers command + data + CRC.
    Empty data is encoded as zero payload bytes. The parser/interpreter still
    accepts b"\x00" for request-style commands because the assignment wording
    says "0x00 if empty", but the builder keeps true zero-length payloads.
    """
    if not 0 <= cmd <= 0xFF:
        raise ValueError("cmd must fit in one byte")

    if direction == "app_to_device":
        header = HEADER_APP_TO_DEVICE
    elif direction == "device_to_app":
        header = HEADER_DEVICE_TO_APP
    else:
        raise ValueError("direction must be 'app_to_device' or 'device_to_app'")

    # Length is the framed payload only: command byte + data bytes + CRC byte.
    length = 1 + len(data) + 1
    crc = calculate_crc(cmd, data)
    return header + length.to_bytes(2, "big") + bytes([cmd]) + data + bytes([crc])


def parse_packet(raw: bytes) -> Optional[ParsedPacket]:
    """
    Parse a complete GlassLink G1 packet.

    Returns None for malformed, truncated, or CRC-corrupted packets. Streaming
    reassembly is handled by StreamBuffer in buffer.py.
    """
    if len(raw) < MIN_PACKET_SIZE:
        return None

    if raw[:2] == HEADER_APP_TO_DEVICE:
        direction = "app_to_device"
    elif raw[:2] == HEADER_DEVICE_TO_APP:
        direction = "device_to_app"
    else:
        return None

    # The length field is big-endian and starts after the 2-byte header.
    declared_length = int.from_bytes(raw[2:4], "big")
    if declared_length < 2:
        return None

    # parse_packet expects exactly one complete frame. StreamBuffer handles
    # partial frames and concatenated frames before calling this function.
    total_size = 4 + declared_length
    if len(raw) != total_size:
        return None

    cmd = raw[4]
    # Data sits between the command byte and final CRC byte.
    data = raw[5 : total_size - 1]
    received_crc = raw[total_size - 1]
    expected_crc = calculate_crc(cmd, data)
    if received_crc != expected_crc:
        return None

    return ParsedPacket(
        direction=direction,
        command=cmd,
        data=data,
        crc=received_crc,
        crc_valid=True,
    )


def interpret_packet(packet: Optional[ParsedPacket]) -> str:
    """Return a readable description without throwing on unknown or bad input."""
    if packet is None:
        return "Invalid packet (malformed, truncated, or CRC mismatch)"

    cmd = packet.command
    data = packet.data

    if cmd == 0x01:
        levels = {0x30: "low", 0x31: "medium", 0x32: "high"}
        level = levels.get(data[0], "unknown") if data else "missing"
        return f"Set LED brightness: {level}"

    if cmd == 0x17:
        # Request packets may have no data. Replies carry level and charging flag.
        if len(data) >= 2:
            charging = "charging" if data[1] == 0x01 else "not charging"
            return f"Battery: {data[0]}%, {charging}"
        if data in (b"", b"\x00"):
            return "Get battery request"
        return "Get battery request"

    if cmd == 0x22:
        modes = {0x30: "photo only", 0x31: "photo + HD upload"}
        mode = modes.get(data[0], "unknown") if data else "missing"
        return f"Take photo: {mode}"

    if cmd == 0x45:
        if len(data) != 9:
            return f"Action sync: malformed payload ({len(data)} bytes)"
        # The action sync payload is a fixed 9-byte bitmap in the order below.
        labels = ["photo", "recording", "mic", "vol+", "vol-", "nod", "shake", "music", "worn"]
        active = [label for label, value in zip(labels, data) if value]
        return "Action sync: " + (", ".join(active) if active else "all idle")

    if cmd == 0x53:
        if len(data) < 2:
            return "Charging status: malformed payload"
        charging = "charging" if data[0] == 0x01 else "not charging"
        return f"Charging status: {charging}, {data[1]}%"

    if cmd == 0x59:
        if len(data) != 7:
            return f"Sync phone time: malformed payload ({len(data)} bytes)"
        year = (data[0] << 8) | data[1]
        return f"Sync phone time: {year:04d}-{data[2]:02d}-{data[3]:02d} {data[4]:02d}:{data[5]:02d}:{data[6]:02d}"

    return f"Unknown command 0x{cmd:02X}: data={data.hex(' ').upper()}"


if __name__ == "__main__":
    sample = build_packet(0x01, bytes([0x32]))
    print(sample.hex(" ").upper())
    print(interpret_packet(parse_packet(sample)))
