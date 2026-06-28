/**
 * subnet.js — Pure browser-side subnet calculation library
 * No external dependencies. No data leaves the browser.
 */

'use strict';

const Subnet = (() => {

  // ── Helpers ────────────────────────────────────────────────

  /** Convert dotted-decimal to 32-bit unsigned integer */
  function ipToInt(ip) {
    const parts = ip.trim().split('.');
    if (parts.length !== 4) throw new Error('Invalid IP address format');
    return parts.reduce((acc, part) => {
      const n = parseInt(part, 10);
      if (isNaN(n) || n < 0 || n > 255) throw new Error(`Invalid octet: ${part}`);
      return (acc << 8) | n;
    }, 0) >>> 0;
  }

  /** Convert 32-bit integer to dotted-decimal string */
  function intToIp(n) {
    n = n >>> 0;
    return [
      (n >>> 24) & 0xff,
      (n >>> 16) & 0xff,
      (n >>>  8) & 0xff,
       n         & 0xff,
    ].join('.');
  }

  /** Convert 32-bit integer to binary string (grouped by octet) */
  function intToBin(n) {
    n = n >>> 0;
    return [24, 16, 8, 0].map(shift =>
      ((n >>> shift) & 0xff).toString(2).padStart(8, '0')
    ).join('.');
  }

  /** Convert prefix length (0-32) to mask integer */
  function prefixToMask(prefix) {
    if (prefix < 0 || prefix > 32) throw new Error(`Prefix /${prefix} is out of range (0-32)`);
    return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  }

  /** Convert mask integer to prefix length, throws if not contiguous */
  function maskToPrefix(mask) {
    mask = mask >>> 0;
    // Validate contiguous mask: (mask + (mask & -mask)) must be 0 or power of 2
    const inv = (~mask) >>> 0;
    if (((inv + 1) & inv) !== 0) throw new Error('Subnet mask is not contiguous');
    let prefix = 0;
    let m = mask;
    while (m & 0x80000000) { prefix++; m = (m << 1) >>> 0; }
    return prefix;
  }

  /** Format a large number with commas */
  function commas(n) {
    return BigInt(n).toLocaleString();
  }

  /** Parse CIDR "a.b.c.d/prefix" or "a.b.c.d" */
  function parseCIDR(input) {
    input = input.trim();
    if (input.includes('/')) {
      const [ipPart, prefixPart] = input.split('/');
      const prefix = parseInt(prefixPart, 10);
      if (isNaN(prefix)) throw new Error(`Invalid prefix: /${prefixPart}`);
      return { ip: ipToInt(ipPart), prefix };
    }
    return { ip: ipToInt(input), prefix: 32 };
  }

  /** Parse mask string: "/24", "24", or "255.255.255.0" */
  function parseMask(s) {
    s = s.trim();
    if (s.startsWith('/')) s = s.slice(1);
    if (!s.includes('.')) {
      const p = parseInt(s, 10);
      if (isNaN(p)) throw new Error(`Invalid prefix: ${s}`);
      return p;
    }
    return maskToPrefix(ipToInt(s));
  }

  // ── RFC classification ─────────────────────────────────────

  function classifyRFC(ipInt) {
    const a = (ipInt >>> 24) & 0xff;
    const b = (ipInt >>> 16) & 0xff;
    const c = (ipInt >>>  8) & 0xff;

    if (a === 10) return 'RFC 1918 private (Class A)';
    if (a === 172 && b >= 16 && b <= 31) return 'RFC 1918 private (Class B)';
    if (a === 192 && b === 168) return 'RFC 1918 private (Class C)';
    if (a === 127) return 'Loopback (RFC 5735)';
    if (a === 169 && b === 254) return 'Link-local (RFC 3927)';
    if (a === 100 && b >= 64 && b <= 127) return 'Shared address space (RFC 6598)';
    if (a === 192 && b === 0 && c === 2) return 'Documentation (RFC 5737)';
    if (a === 198 && b >= 18 && b <= 19) return 'Benchmarking (RFC 2544)';
    if (a === 203 && b === 0 && c === 113) return 'Documentation (RFC 5737)';
    if (a >= 224 && a <= 239) return 'Multicast (RFC 5771)';
    if (a >= 240) return 'Reserved (RFC 1112)';
    if (a === 0) return 'This network (RFC 1122)';

    if (a < 128) return 'Public (Class A)';
    if (a < 192) return 'Public (Class B)';
    if (a < 224) return 'Public (Class C)';
    return 'Unknown';
  }

  // ── Main calculation ───────────────────────────────────────

  /**
   * calculate(cidrString) OR calculate(ipString, maskString)
   * Returns a rich result object.
   */
  function calculate(cidrOrIp, maskStr) {
    let ipInt, prefix;

    if (maskStr !== undefined) {
      ipInt  = ipToInt(cidrOrIp);
      prefix = parseMask(maskStr);
    } else {
      const parsed = parseCIDR(cidrOrIp);
      ipInt  = parsed.ip;
      prefix = parsed.prefix;
    }

    const maskInt      = prefixToMask(prefix);
    const networkInt   = (ipInt & maskInt) >>> 0;
    const broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0;
    const wildcardInt  = (~maskInt) >>> 0;
    const hostMin      = prefix < 31 ? networkInt + 1 : networkInt;
    const hostMax      = prefix < 31 ? broadcastInt - 1 : broadcastInt;
    const totalHosts   = prefix <= 30
      ? Math.pow(2, 32 - prefix)
      : prefix === 31 ? 2 : 1;
    const usableHosts  = prefix <= 30
      ? totalHosts - 2
      : totalHosts;

    // Class (legacy)
    const firstOctet = (networkInt >>> 24) & 0xff;
    let legacyClass;
    if (firstOctet < 128)       legacyClass = 'A';
    else if (firstOctet < 192)  legacyClass = 'B';
    else if (firstOctet < 224)  legacyClass = 'C';
    else if (firstOctet < 240)  legacyClass = 'D (Multicast)';
    else                        legacyClass = 'E (Reserved)';

    return {
      input:         cidrOrIp + (maskStr ? ` / ${maskStr}` : ''),
      prefix,
      ip:            intToIp(ipInt),
      ipInt,
      network:       intToIp(networkInt),
      networkInt,
      broadcast:     intToIp(broadcastInt),
      broadcastInt,
      subnetMask:    intToIp(maskInt),
      maskInt,
      wildcard:      intToIp(wildcardInt),
      wildcardInt,
      hostMin:       intToIp(hostMin),
      hostMinInt:    hostMin,
      hostMax:       intToIp(hostMax),
      hostMaxInt:    hostMax,
      totalHosts,
      usableHosts,
      cidr:          `${intToIp(networkInt)}/${prefix}`,
      legacyClass,
      rfc:           classifyRFC(networkInt),
      // Binary representations
      ipBin:         intToBin(ipInt),
      maskBin:       intToBin(maskInt),
      networkBin:    intToBin(networkInt),
      broadcastBin:  intToBin(broadcastInt),
    };
  }

  // ── Subnet splitting ───────────────────────────────────────

  /**
   * Split a network into subnets of a given prefix length.
   * Returns array of result objects (capped at maxResults).
   */
  function split(networkCIDR, newPrefix, maxResults = 256) {
    const base = calculate(networkCIDR);
    if (newPrefix <= base.prefix) {
      throw new Error(`New prefix /${newPrefix} must be larger than /${base.prefix}`);
    }
    if (newPrefix > 32) throw new Error('Prefix cannot exceed /32');

    const count = Math.pow(2, newPrefix - base.prefix);
    const blockSize = Math.pow(2, 32 - newPrefix);
    const results = [];
    const limit = Math.min(count, maxResults);

    for (let i = 0; i < limit; i++) {
      const netInt = (base.networkInt + i * blockSize) >>> 0;
      results.push(calculate(`${intToIp(netInt)}/${newPrefix}`));
    }

    return { subnets: results, total: count, truncated: count > maxResults };
  }

  return { calculate, split, commas };
})();
