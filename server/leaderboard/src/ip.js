// Which "network" a request comes from, for rate limiting and for telling players apart.
//
// An IPv4 address is used as is. An IPv6 client is reduced to its /64: every home or phone gets
// at least that many addresses and the OS rotates through them on its own (privacy addresses),
// so keying on the full address would let anyone post as a fresh client at will, and would give
// ordinary players a new identity every day.

function parseIpv6(text) {
  let s = text;
  // A trailing dotted quad (::ffff:192.0.2.1) stands for the last two groups.
  const quad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (quad) {
    const b = quad.slice(1).map(Number);
    if (b.some((n) => n > 255)) return null;
    s = `${s.slice(0, quad.index)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 2 ? gap < 1 : gap !== 0) return null;

  const groups = [...head, ...Array(halves.length === 2 ? gap : 0).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

export function networkOf(ip) {
  const addr = String(ip ?? '')
    .trim()
    .toLowerCase()
    .replace(/%.*$/, ''); // zone id
  if (!addr.includes(':')) return addr;

  const g = parseIpv6(addr);
  if (!g) return addr;
  // An IPv4-mapped address is really an IPv4 client.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}
