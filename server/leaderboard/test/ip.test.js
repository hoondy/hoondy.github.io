// Runs without a server: `node --test test/ip.test.js`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkOf } from '../src/ip.js';

test('IPv4 addresses are kept as they are', () => {
  assert.equal(networkOf('203.0.113.7'), '203.0.113.7');
  assert.equal(networkOf(' 10.0.0.1 '), '10.0.0.1');
});

test('IPv6 addresses are reduced to their /64', () => {
  const net = '2001:db8:1:2::/64';
  for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::9', '2001:DB8:1:2:1234:5678:9abc:def0', '2001:0db8:0001:0002:0:0:0:0', '2001:db8:1:2::1%en0']) {
    assert.equal(networkOf(ip), net, ip);
  }
  assert.equal(networkOf('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(networkOf('2001:db8:5:6::a'), networkOf('2001:db8:5:6:1234:5678:9abc:def0'));
  assert.notEqual(networkOf('2001:db8:5:6::a'), networkOf('2001:db8:5:7::a'));
  assert.equal(networkOf('::1'), '0:0:0:0::/64');
  assert.equal(networkOf('::'), '0:0:0:0::/64');
  assert.equal(networkOf('64:ff9b::192.0.2.1'), '64:ff9b:0:0::/64');
});

test('IPv4-mapped IPv6 addresses count as IPv4', () => {
  assert.equal(networkOf('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(networkOf('::ffff:c000:201'), '192.0.2.1');
});

test('anything unparseable is used verbatim', () => {
  for (const ip of ['1::2::3', '1:2:3:4:5:6:7:8:9', 'g::1', '::ffff:300.1.1.1', '1:2:3:4:5:6:7::8:9']) {
    assert.equal(networkOf(ip), ip, ip);
  }
});
