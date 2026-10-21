import { isIP } from "node:net";

type IpBlockReason =
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

type V4Range = readonly [network: number, prefix: number, reason: IpBlockReason];

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

const cidr4 = (network: string, prefix: number, reason: IpBlockReason): V4Range => {
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

const isInV4Range = (address: number, network: number, prefix: number): boolean => {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === (network & mask) >>> 0;
};

const v4Block = (address: number): IpBlockReason | undefined =>
  V4_BLOCKS.find(([network, prefix]) => isInV4Range(address, network, prefix))?.[2];

type V6Range = readonly [prefix: readonly number[], bits: number, reason: IpBlockReason];

// The blocks of 2000::/3 IANA's special-purpose registry does not list as
// globally reachable, and the IETF protocol block whole: what its few
// reachable exceptions hold (anycast relays, AS112 sinks, identifiers) is
// never a website. The benchmarking block sits inside it and keeps its name.
const V6_GLOBAL_BLOCKS: readonly V6Range[] = [
  [[0x2001, 0x0002, 0x0000], 48, "benchmark"],
  [[0x2001, 0x0000], 23, "reserved"],
  [[0x2001, 0x0db8], 32, "documentation"],
  [[0x3fff], 20, "documentation"],
];

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
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return Uint16Array.from(words.map((word) => Number.parseInt(word, 16)));
};

const hasPrefix = (words: Uint16Array, prefix: readonly number[], bits: number): boolean => {
  for (let index = 0; index < Math.ceil(bits / 16); index += 1) {
    const used = Math.min(16, bits - index * 16);
    const mask = used === 16 ? 0xffff : (0xffff << (16 - used)) & 0xffff;
    if (((words[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false;
  }
  return true;
};

const v4At = (words: Uint16Array, index: number): number =>
  (((words[index] ?? 0) << 16) | (words[index + 1] ?? 0)) >>> 0;

// The forms whose packets end up at an IPv4 address they carry: IPv4-mapped,
// NAT64's well-known prefix and 6to4. Each is as public as that address.
const carriedV4 = (words: Uint16Array): number | undefined => {
  if (hasPrefix(words, [0, 0, 0, 0, 0, 0xffff], 96)) return v4At(words, 6);
  if (hasPrefix(words, [0x0064, 0xff9b, 0, 0, 0, 0], 96)) return v4At(words, 6);
  if (hasPrefix(words, [0x2002], 16)) return v4At(words, 1);
  return undefined;
};

export const classifyIp = (address: string): IpClassification => {
  const family = isIP(address);
  if (family === 4) {
    const parsed = v4(address);
    if (parsed === null) return { allowed: false, reason: "invalid_ip" };
    const reason = v4Block(parsed);
    return reason ? { allowed: false, family: 4, reason } : { allowed: true, family: 4 };
  }
  if (family !== 6) return { allowed: false, reason: "invalid_ip" };
  const words = parseIpv6(address);
  if (!words) return { allowed: false, family: 6, reason: "invalid_ip" };

  if (words.every((word) => word === 0))
    return { allowed: false, family: 6, reason: "unspecified" };
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)
    return { allowed: false, family: 6, reason: "loopback" };
  const carried = carriedV4(words);
  if (carried !== undefined) {
    const reason = v4Block(carried);
    return reason ? { allowed: false, family: 6, reason } : { allowed: true, family: 6 };
  }
  if (hasPrefix(words, [0xfc00], 7)) return { allowed: false, family: 6, reason: "private" };
  if (hasPrefix(words, [0xfe80], 10)) return { allowed: false, family: 6, reason: "link_local" };
  if (hasPrefix(words, [0xff00], 8)) return { allowed: false, family: 6, reason: "multicast" };
  // Outside 2000::/3 every address is special-purpose or held back by the
  // IETF: IPv4-compatible, local-use NAT64, site-local, discard-only.
  if (!hasPrefix(words, [0x2000], 3)) return { allowed: false, family: 6, reason: "reserved" };
  for (const [prefix, bits, reason] of V6_GLOBAL_BLOCKS) {
    if (hasPrefix(words, prefix, bits)) return { allowed: false, family: 6, reason };
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

const NAMES_NO_VISITOR: ReadonlySet<IpBlockReason> = new Set([
  "invalid_ip",
  "unspecified",
  "loopback",
  "private",
  "carrier_grade_nat",
  "link_local",
]);

/**
 * Whether a client address the edge wrote can stand for one visitor. A
 * private, CGNAT, loopback or link-local address, in any of its IPv6 forms, is
 * an ingress, a proxy or a shared network that many visitors arrive through,
 * and so is a value that is no address at all; a limit per client must not
 * count all of them as one.
 */
export const namesAVisitor = (address: string): boolean => {
  const classified = classifyIp(address);
  return classified.allowed || !NAMES_NO_VISITOR.has(classified.reason);
};
