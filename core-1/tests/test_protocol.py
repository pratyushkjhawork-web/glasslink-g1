import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from buffer import StreamBuffer
from protocol import build_packet, interpret_packet, parse_packet


def test_build_and_parse_roundtrip():
    packet = build_packet(0x01, bytes([0x32]))
    parsed = parse_packet(packet)

    assert parsed is not None
    assert parsed.command == 0x01
    assert parsed.data == bytes([0x32])
    assert parsed.direction == "app_to_device"
    assert parsed.crc_valid is True


def test_corrupt_crc_returns_none():
    packet = bytearray(build_packet(0x01, bytes([0x32])))
    packet[-1] ^= 0xFF

    assert parse_packet(bytes(packet)) is None
    assert "Invalid packet" in interpret_packet(None)


def test_truncated_packet_returns_none():
    packet = build_packet(0x01, bytes([0x32]))

    assert parse_packet(packet[:4]) is None


def test_extra_bytes_after_packet_return_none():
    packet = build_packet(0x22, bytes([0x30]))

    assert parse_packet(packet + b"\x00") is None


def test_stream_buffer_concatenated_packets():
    buf = StreamBuffer()
    p1 = build_packet(0x01, bytes([0x32]))
    p2 = build_packet(0x22, bytes([0x30]))

    packets = buf.feed(p1 + p2)

    assert [packet.command for packet in packets] == [0x01, 0x22]


def test_stream_buffer_fragmented_packet():
    buf = StreamBuffer()
    full = build_packet(0x59, bytes([0x07, 0xEA, 0x05, 0x11, 0x10, 0x2A, 0x00]))

    assert buf.feed(full[:5]) == []
    packets = buf.feed(full[5:])

    assert len(packets) == 1
    assert packets[0].command == 0x59


def test_stream_buffer_skips_garbage_before_header():
    buf = StreamBuffer()
    packet = build_packet(0x53, bytes([0x01, 90]), direction="device_to_app")

    packets = buf.feed(b"\x00\x99garbage" + packet)

    assert len(packets) == 1
    assert packets[0].direction == "device_to_app"


def test_stream_buffer_drops_bad_crc_and_continues():
    buf = StreamBuffer()
    bad = bytearray(build_packet(0x01, bytes([0x31])))
    bad[-1] ^= 0xFF
    good = build_packet(0x22, bytes([0x31]))

    packets = buf.feed(bytes(bad) + good)

    assert len(packets) == 1
    assert packets[0].command == 0x22
    assert buf.dropped_packets == 1


def test_zero_length_payload():
    packet = build_packet(0x17, b"")
    parsed = parse_packet(packet)

    assert packet == bytes.fromhex("AB 55 00 02 17 17")
    assert parsed is not None
    assert parsed.command == 0x17
    assert parsed.data == b""
    assert interpret_packet(parsed) == "Get battery request"


def test_zero_marker_payload_is_tolerated_for_request():
    packet = build_packet(0x17, b"\x00")
    parsed = parse_packet(packet)

    assert packet == bytes.fromhex("AB 55 00 03 17 00 17")
    assert parsed is not None
    assert parsed.data == b"\x00"
    assert interpret_packet(parsed) == "Get battery request"


def test_unknown_command_interpretation():
    parsed = parse_packet(build_packet(0xFF, bytes([0x01])))

    assert parsed is not None
    assert "Unknown command 0xFF" in interpret_packet(parsed)


def test_device_to_app_direction():
    packet = build_packet(0x45, bytes([1, 0, 0, 0, 0, 1, 0, 0, 1]), direction="device_to_app")
    parsed = parse_packet(packet)

    assert parsed is not None
    assert parsed.direction == "device_to_app"
    assert "photo" in interpret_packet(parsed)
    assert "nod" in interpret_packet(parsed)


def test_invalid_build_arguments():
    with pytest.raises(ValueError):
        build_packet(0x100)
    with pytest.raises(ValueError):
        build_packet(0x01, direction="sideways")
