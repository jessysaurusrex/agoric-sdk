/* global __dirname */
// eslint-disable-next-line import/order
import { test } from '../../tools/prepare-test-env-ava.js';
// eslint-disable-next-line import/order
import path from 'path';
import bundleSource from '@agoric/bundle-source';
import { getAllState, setAllState } from '@agoric/swing-store-simple';
import { provideHostStorage } from '../../src/hostStorage.js';
import { buildKernelBundles, buildVatController } from '../../src/index.js';

function capdata(body, slots = []) {
  return harden({ body, slots });
}

function capargs(args, slots = []) {
  return capdata(JSON.stringify(args), slots);
}

function copy(data) {
  return JSON.parse(JSON.stringify(data));
}

test.before(async t => {
  const kernelBundles = await buildKernelBundles();
  const dynamicBundle = await bundleSource(
    path.join(__dirname, 'replay-dynamic.js'),
  );
  t.context.data = { kernelBundles, dynamicBundle };
});

test('replay bundleSource-based dynamic vat', async t => {
  const config = {
    vats: {
      bootstrap: {
        sourceSpec: path.join(__dirname, 'replay-bootstrap.js'),
        parameters: { dynamicBundle: t.context.data.dynamicBundle },
      },
    },
    bootstrap: 'bootstrap',
  };

  // XXX TODO: also copy and check transcripts
  const hostStorage1 = provideHostStorage();
  {
    const c1 = await buildVatController(copy(config), [], {
      hostStorage: hostStorage1,
      kernelBundles: t.context.data.kernelBundles,
    });
    c1.pinVatRoot('bootstrap');
    const r1 = c1.queueToVatRoot(
      'bootstrap',
      'createBundle',
      capargs([]),
      'panic',
    );
    await c1.run();
    t.deepEqual(c1.kpResolution(r1), capargs('created'));
  }

  // Now we abandon that swingset and start a new one, with the same state.
  // we could re-use the Storage object, but I'll be paranoid and create a
  // new one.

  const state1 = getAllState(hostStorage1);
  const hostStorage2 = provideHostStorage();
  setAllState(hostStorage2, state1);
  {
    const c2 = await buildVatController(copy(config), [], {
      hostStorage: hostStorage2,
    });
    const r2 = c2.queueToVatRoot('bootstrap', 'check', capargs([]), 'panic');
    await c2.run();
    t.deepEqual(c2.kpResolution(r2), capargs('ok'));
  }
});

test('replay bundleName-based dynamic vat', async t => {
  const config = {
    vats: {
      bootstrap: { sourceSpec: path.join(__dirname, 'replay-bootstrap.js') },
    },
    bundles: {
      dynamic: { sourceSpec: path.join(__dirname, 'replay-dynamic.js') },
    },
    bootstrap: 'bootstrap',
  };

  // XXX TODO: also copy and check transcripts
  const hostStorage1 = provideHostStorage();
  {
    const c1 = await buildVatController(copy(config), [], {
      hostStorage: hostStorage1,
      kernelBundles: t.context.data.kernelBundles,
    });
    c1.pinVatRoot('bootstrap');
    const r1 = c1.queueToVatRoot(
      'bootstrap',
      'createNamed',
      capargs([]),
      'panic',
    );
    await c1.run();
    t.deepEqual(c1.kpResolution(r1), capargs('created'));
  }

  const state1 = getAllState(hostStorage1);
  const hostStorage2 = provideHostStorage();
  setAllState(hostStorage2, state1);
  {
    const c2 = await buildVatController(copy(config), [], {
      hostStorage: hostStorage2,
    });
    const r2 = c2.queueToVatRoot('bootstrap', 'check', capargs([]), 'panic');
    await c2.run();
    t.deepEqual(c2.kpResolution(r2), capargs('ok'));
  }
});
