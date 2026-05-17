"""
GlassLink G1 packet lab.

Extra reviewer-facing tools:
1. Decode pasted hex streams, including concatenated packets.
2. Run a deterministic stress simulation with fragmentation and corruption.

Examples:
    python packet_lab.py decode "AB 55 00 03 01 32 33"
    python packet_lab.py stress --count 200 --seed 7
"""

from __future__ import annotations

import argparse
import random
import re
from dataclasses import dataclass

from buffer import StreamBuffer
from protocol import build_packet, interpret_packet


COMMAND_SAMPLES = (
    (0x01, b"\x30", "app_to_device"),
    (0x01, b"\x31", "app_to_device"),
    (0x01, b"\x32", "app_to_device"),
    (0x17, b"", "app_to_device"),
    (0x17, b"\x58\x01", "device_to_app"),
    (0x22, b"\x30", "app_to_device"),
    (0x22, b"\x31", "app_to_device"),
    (0x45, b"\x01\x00\x00\x00\x00\x01\x00\x00\x01", "device_to_app"),
    (0x53, b"\x01\x5A", "device_to_app"),
    (0x59, b"\x07\xEA\x05\x11\x10\x2A\x00", "app_to_device"),
    (0x99, b"\x01\x02", "device_to_app"),
)


@dataclass(frozen=True)
class StressResult:
    sent: int
    received: int
    corrupted: int
    dropped: int
    fragments: int
    pending_bytes: int

    @property
    def delivery_rate(self) -> float:
        return self.received / self.sent if self.sent else 0.0


def parse_hex_stream(text: str) -> bytes:
    tokens = re.findall(r"[0-9a-fA-F]{2}", text)
    if not tokens:
        raise ValueError("no hex bytes found")
    return bytes(int(token, 16) for token in tokens)


def decode_hex_stream(text: str) -> list[str]:
    stream = parse_hex_stream(text)
    buffer = StreamBuffer()
    packets = buffer.feed(stream)
    lines = []

    for index, packet in enumerate(packets, start=1):
        lines.append(
            f"{index:02d}. {packet.direction:13} cmd=0x{packet.command:02X} "
            f"data={packet.data.hex(' ').upper() or '-'} :: {interpret_packet(packet)}"
        )

    if buffer.dropped_packets:
        lines.append(f"dropped_packets={buffer.dropped_packets}")
    if buffer.pending_bytes:
        lines.append(f"pending_bytes={buffer.pending_bytes}")
    if not lines:
        lines.append("No complete valid packets decoded yet.")

    return lines


def corrupt_packet(packet: bytes, rng: random.Random) -> bytes:
    mode = rng.choice(("crc", "truncate", "byte_flip"))
    data = bytearray(packet)

    if mode == "crc":
        data[-1] ^= 0xFF
        return bytes(data)
    if mode == "truncate":
        return bytes(data[:-rng.randint(1, min(3, len(data)))])

    index = rng.randint(2, len(data) - 1)
    data[index] ^= 0xFF
    return bytes(data)


def fragment(packet: bytes, rng: random.Random, mtu: int) -> list[bytes]:
    chunks = []
    start = 0
    while start < len(packet):
        size = rng.randint(1, mtu)
        chunks.append(packet[start : start + size])
        start += size
    return chunks


def run_stress(count: int, seed: int, corruption_rate: float, mtu: int) -> StressResult:
    rng = random.Random(seed)
    buffer = StreamBuffer()
    received = 0
    corrupted = 0
    fragments = 0

    for _ in range(count):
        cmd, payload, direction = rng.choice(COMMAND_SAMPLES)
        packet = build_packet(cmd, payload, direction)

        if rng.random() < corruption_rate:
            packet = corrupt_packet(packet, rng)
            corrupted += 1

        chunks = fragment(packet, rng, mtu)
        fragments += len(chunks)
        for chunk in chunks:
            received += len(buffer.feed(chunk))

    return StressResult(
        sent=count,
        received=received,
        corrupted=corrupted,
        dropped=buffer.dropped_packets,
        fragments=fragments,
        pending_bytes=buffer.pending_bytes,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Decode and stress-test GlassLink packets.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    decode = subparsers.add_parser("decode", help="Decode a pasted hex byte stream.")
    decode.add_argument("hex_stream", help="Example: 'AB 55 00 03 01 32 33'")

    stress = subparsers.add_parser("stress", help="Run deterministic stream stress test.")
    stress.add_argument("--count", type=int, default=200)
    stress.add_argument("--seed", type=int, default=7)
    stress.add_argument("--corruption-rate", type=float, default=0.10)
    stress.add_argument("--mtu", type=int, default=20)

    args = parser.parse_args()
    if args.command == "decode":
        for line in decode_hex_stream(args.hex_stream):
            print(line)
        return

    result = run_stress(args.count, args.seed, args.corruption_rate, args.mtu)
    print("GlassLink packet stress report")
    print(f"sent={result.sent}")
    print(f"received={result.received}")
    print(f"corrupted={result.corrupted}")
    print(f"dropped={result.dropped}")
    print(f"fragments={result.fragments}")
    print(f"pending_bytes={result.pending_bytes}")
    print(f"delivery_rate={result.delivery_rate:.2%}")


if __name__ == "__main__":
    main()
