import { isIP } from "node:net";

export type IpBlockReason =
  | "invalid_ip"
  | "unspecified"
  | "loopback"
  | "private"
  | "carrier_grade_nat"
  | "link_local"
  | "multicast"
  | "documentation"
  | "benchmark"
  | "reserved"
  | "metadata";

export type IpClassification =
  | { allowed: true; family: 4 | 6 }
  | { allowed: false; family?: 4 | 6; reason: IpBlockReason };

type V4Range = readonly [
  network: number,
  prefix: number,
  reason: IpBlockReason,
];

const v4 = (value: string): number | null => {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = (result * 256 + octet) >>> 0;
  }
  return result;
};

const cidr4 = (
  network: string,
  prefix: number,
  reason: IpBlockReason,
): V4Range => {
  const parsed = v4(network);
  if (parsed === null) throw new Error(`Invalid internal CIDR: ${network}`);
  return [parsed, prefix, reason];
};

const V4_BLOCKS: readonly V4Range[] = [
  cidr4("0.0.0.0", 8, "unspecified"),
  cidr4("10.0.0.0", 8, "private"),
  cidr4("100.64.0.0", 10, "carrier_grade_nat"),
  cidr4("127.0.0.0", 8, "loopback"),
  cidr4("169.254.0.0", 16, "link_local"),
  cidr4("172.16.0.0", 12, "private"),
  cidr4("192.0.0.0", 24, "reserved"),
  cidr4("192.0.2.0", 24, "documentation"),
  cidr4("192.88.99.0", 24, "reserved"),
  cidr4("192.168.0.0", 16, "private"),
  cidr4("198.18.0.0", 15, "benchmark"),
  cidr4("198.51.100.0", 24, "documentation"),
  cidr4("203.0.113.0", 24, "documentation"),
  cidr4("224.0.0.0", 4, "multicast"),
  cidr4("240.0.0.0", 4, "reserved"),
];

const isInV4Range = (
  address: number,
  network: number,
  prefix: number,
): boolean => {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === (network & mask) >>> 0;
};

const parseIpv6 = (input: string): Uint16Array | null => {
  let value = input.toLowerCase();
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);

  const ipv4Tail = value.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const parsed = v4(ipv4Tail);
    if (parsed === null) return null;
    value = `${value.slice(0, -ipv4Tail.length)}${((parsed >>> 16) & 0xffff).toString(16)}:${(
      parsed & 0xffff
    ).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word)))
    return null;
  return Uint16Array.from(words.map((word) => Number.parseInt(word, 16)));
};

const hasPrefix = (
  words: Uint16Array,
  prefix: readonly number[],
  bits: number,
): boolean => {
  for (let index = 0; index < Math.ceil(bits / 16); index += 1) {
    const used = Math.min(16, bits - index * 16);
    const mask = used === 16 ? 0xffff : (0xffff << (16 - used)) & 0xffff;
    if ((words[index]! & mask) !== ((prefix[index] ?? 0) & mask)) return false;
  }
  return true;
};

export const classifyIp = (address: string): IpClassification => {
  const family = isIP(address);
  if (family === 4) {
    const parsed = v4(address);
    if (parsed === null) return { allowed: false, reason: "invalid_ip" };
    for (const [network, prefix, reason] of V4_BLOCKS) {
      if (isInV4Range(parsed, network, prefix))
        return { allowed: false, family: 4, reason };
    }
    return { allowed: true, family: 4 };
  }
  if (family !== 6) return { allowed: false, reason: "invalid_ip" };
  const words = parseIpv6(address);
  if (!words) return { allowed: false, family: 6, reason: "invalid_ip" };

  if (words.every((word) => word === 0))
    return { allowed: false, family: 6, reason: "unspecified" };
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)
    return { allowed: false, family: 6, reason: "loopback" };
  if (hasPrefix(words, [0xfc00], 7))
    return { allowed: false, family: 6, reason: "private" };
  if (hasPrefix(words, [0xfe80], 10))
    return { allowed: false, family: 6, reason: "link_local" };
  if (hasPrefix(words, [0xff00], 8))
    return { allowed: false, family: 6, reason: "multicast" };
  if (hasPrefix(words, [0x2001, 0x0db8], 32))
    return { allowed: false, family: 6, reason: "documentation" };
  if (hasPrefix(words, [0x2001, 0x0002], 48))
    return { allowed: false, family: 6, reason: "benchmark" };
  if (hasPrefix(words, [0x2001, 0x0010], 28))
    return { allowed: false, family: 6, reason: "reserved" };
  if (hasPrefix(words, [0x0000, 0, 0, 0, 0, 0xffff], 96)) {
    const mapped = ((words[6]! << 16) | words[7]!) >>> 0;
    for (const [network, prefix, reason] of V4_BLOCKS) {
      if (isInV4Range(mapped, network, prefix))
        return { allowed: false, family: 6, reason };
    }
  }
  return { allowed: true, family: 6 };
};

export const assertPublicAddresses = (addresses: readonly string[]): void => {
  if (addresses.length === 0) throw new Error("dns_no_answers");
  for (const address of addresses) {
    const result = classifyIp(address);
    if (!result.allowed) throw new Error(`ssrf_blocked:${result.reason}`);
  }
};
