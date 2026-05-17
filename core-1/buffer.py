from protocol import HEADER_APP_TO_DEVICE, HEADER_DEVICE_TO_APP, MIN_PACKET_SIZE, ParsedPacket, parse_packet


class StreamBuffer:
    """
    Reassembles packets from a byte stream.

    BLE notifications can split one packet across chunks or concatenate several
    packets in one chunk. This buffer keeps incomplete bytes until enough data
    arrives and skips garbage before the next known header. The max packet size
    guard prevents a corrupted length field from blocking the stream forever.
    """

    def __init__(self, max_packet_size: int = 64) -> None:
        self._buffer = bytearray()
        self.dropped_packets = 0
        self.max_packet_size = max_packet_size

    def feed(self, data: bytes) -> list[ParsedPacket]:
        self._buffer.extend(data)
        packets: list[ParsedPacket] = []

        while len(self._buffer) >= MIN_PACKET_SIZE:
            header_pos = self._find_header()
            if header_pos == -1:
                # Keep one possible header byte so a split AB/55 or AC/55 header
                # across BLE notifications can still be recovered.
                self._keep_possible_partial_header()
                break

            if header_pos > 0:
                # Drop noise before the next valid frame header.
                del self._buffer[:header_pos]

            if len(self._buffer) < 4:
                break

            declared_length = int.from_bytes(self._buffer[2:4], "big")
            if declared_length < 2:
                # A valid frame must at least contain command + CRC.
                del self._buffer[0]
                self.dropped_packets += 1
                continue

            total_size = 4 + declared_length
            if total_size > self.max_packet_size:
                # A corrupted length byte can claim a huge frame. Drop one byte
                # and rescan so later packets are not blocked forever.
                del self._buffer[0]
                self.dropped_packets += 1
                continue

            if len(self._buffer) < total_size:
                # Incomplete frame: wait for the next BLE notification chunk.
                break

            raw = bytes(self._buffer[:total_size])
            parsed = parse_packet(raw)
            if parsed is None:
                # Usually a CRC failure. The frame boundary was still known, so
                # remove it and continue scanning the remaining stream.
                self.dropped_packets += 1
            else:
                packets.append(parsed)

            del self._buffer[:total_size]

        return packets

    def clear(self) -> None:
        self._buffer.clear()
        self.dropped_packets = 0

    @property
    def pending_bytes(self) -> int:
        return len(self._buffer)

    def _find_header(self) -> int:
        for idx in range(len(self._buffer) - 1):
            if bytes(self._buffer[idx : idx + 2]) in (HEADER_APP_TO_DEVICE, HEADER_DEVICE_TO_APP):
                return idx
        return -1

    def _keep_possible_partial_header(self) -> None:
        if self._buffer and self._buffer[-1] in (HEADER_APP_TO_DEVICE[0], HEADER_DEVICE_TO_APP[0]):
            last = self._buffer[-1]
            self._buffer.clear()
            self._buffer.append(last)
        else:
            self._buffer.clear()
