import { test } from './prepare-test-env-ava.js';

import { Far } from '../src/marshal.js';
import { stringify, parse } from '../src/marshal-stringify.js';
import { roundTripPairs } from './test-marshal.js';

const { isFrozen } = Object;

test('stringify parse round trip pairs', t => {
  for (const [plain, encoded] of roundTripPairs) {
    const str = stringify(plain);
    const encoding = JSON.stringify(encoded);
    t.is(str, encoding);
    const decoding = parse(str);
    t.deepEqual(decoding, plain);
    t.assert(isFrozen(decoding));
  }
});

test('marshal stringify', t => {
  t.is(stringify(harden([-0])), '[0]');
});

test('marshal parse', t => {
  t.deepEqual(parse('[0]'), [0]);
});

test('marshal stringify errors', t => {
  t.throws(() => stringify([]), {
    message: /Cannot pass non-frozen objects like .*. Use harden()/,
  });
  t.throws(() => stringify({}), {
    message: /Cannot pass non-frozen objects like .*. Use harden()/,
  });

  t.throws(() => stringify(harden(Promise.resolve(8))), {
    message: /Marshal's stringify rejects presences and promises .*/,
  });
  t.throws(() => stringify(Far('x', { foo: () => {} })), {
    message: /Marshal's stringify rejects presences and promises .*/,
  });
  t.throws(() => stringify(Far('y', {})), {
    message: /Marshal's stringify rejects presences and promises .*/,
  });
});

test('marshal parse errors', t => {
  t.throws(() => parse('{"@qclass":"slot","index":0}'), {
    message: /Marshal's parse must not encode any slot positions .*/,
  });
  t.throws(() => parse('X'), {
    message: /Unexpected token X in JSON at position 0*/,
  });
  t.throws(() => parse('{"@qclass":8}'), {
    message: /invalid qclass typeof "number"*/,
  });
  t.throws(() => parse('{"@qclass":"bogus"}'), {
    message: /unrecognized "@qclass" "bogus"*/,
  });
});
