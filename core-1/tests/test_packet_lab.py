import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from packet_lab import decode_hex_stream, parse_hex_stream, run_stress
from protocol import build_packet


def test_decode_hex_stream_handles_concatenated_packets():
    first = build_packet(0x01, b"\x32")
    second = build_packet(0x22, b"\x31")
    hex_stream = (first + second).hex(" ")

    lines = decode_hex_stream(hex_stream)

    assert len(lines) == 2
    assert "Set LED brightness" in lines[0]
    assert "Take photo" in lines[1]


def test_decode_hex_stream_reports_pending_fragment():
    fragment = build_packet(0x53, b"\x01\x50", "device_to_app")[:5]

    lines = decode_hex_stream(fragment.hex(" "))

    assert lines == ["pending_bytes=5"]


def test_parse_hex_stream_accepts_common_formats():
    assert parse_hex_stream("AB:55 00-03 01 32 33") == bytes.fromhex("AB 55 00 03 01 32 33")


def test_stress_is_deterministic():
    first = run_stress(count=50, seed=12, corruption_rate=0.10, mtu=8)
    second = run_stress(count=50, seed=12, corruption_rate=0.10, mtu=8)

    assert first == second
    assert first.sent == 50
    assert first.fragments >= first.sent
