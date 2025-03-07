/* global HandledPromise */

import { Remotable, passStyleOf, makeMarshal } from '@agoric/marshal';
import { assert, details as X } from '@agoric/assert';
import { isPromise } from '@agoric/promise-kit';
import { insistVatType, makeVatSlot, parseVatSlot } from '../parseVatSlots.js';
import { insistCapData } from '../capdata.js';
import { insistMessage } from '../message.js';
import { makeVirtualObjectManager } from './virtualObjectManager.js';

const DEFAULT_VIRTUAL_OBJECT_CACHE_SIZE = 3; // XXX ridiculously small value to force churn for testing

// 'makeLiveSlots' is a dispatcher which uses javascript Maps to keep track
// of local objects which have been exported. These cannot be persisted
// beyond the runtime of the javascript environment, so this mechanism is not
// going to work for our in-chain hosts.

/**
 * Instantiate the liveslots layer for a new vat and then populate the vat with
 * a new root object and its initial associated object graph, if any.
 *
 * @param {*} syscall  Kernel syscall interface that the vat will have access to
 * @param {*} forVatID  Vat ID label, for use in debug diagostics
 * @param {number} cacheSize  Maximum number of entries in the virtual object state cache
 * @param {boolean} enableDisavow
 * @param {boolean} enableVatstore
 * @param {*} vatPowers
 * @param {*} vatParameters
 * @param {*} gcTools { WeakRef, FinalizationRegistry, waitUntilQuiescent, gcAndFinalize }
 * @param {Console} console
 * @returns {*} { vatGlobals, inescapableGlobalProperties, dispatch, setBuildRootObject }
 *
 * setBuildRootObject should be called, once, with a function that will
 * create a root object for the new vat The caller provided buildRootObject
 * function produces and returns the new vat's root object:
 *
 * buildRootObject(vatPowers, vatParameters)
 */
function build(
  syscall,
  forVatID,
  cacheSize,
  enableDisavow,
  enableVatstore,
  vatPowers,
  vatParameters,
  gcTools,
  console,
) {
  const { WeakRef, FinalizationRegistry } = gcTools;
  const enableLSDebug = false;
  function lsdebug(...args) {
    if (enableLSDebug) {
      console.log(...args);
    }
  }

  let didRoot = false;

  const outstandingProxies = new WeakSet();

  /**
   * Translation and tracking tables to map in-vat object/promise references
   * to/from vat-format slot strings.
   *
   * Exports: pass-by-presence objects (Remotables) in the vat are exported
   * as o+NN slots, as are "virtual object" exports. Promises are exported as
   * p+NN slots. We retain a strong reference to all exports via the
   * `exportedRemotables` Set until (TODO) the kernel tells us all external
   * references have been dropped via dispatch.dropExports, or by some
   * unilateral revoke-object operation executed by our user-level code.
   *
   * Imports: o-NN slots are represented as a Presence. p-NN slots are
   * represented as an imported Promise, with the resolver held in an
   * additional table (importedPromisesByPromiseID) to handle a future
   * incoming resolution message. We retain a weak reference to the Presence,
   * and use a FinalizationRegistry to learn when the vat has dropped it, so
   * we can notify the kernel. We retain strong references to unresolved
   * Promises. When an import is added, the finalizer is added to
   * `droppedRegistry`.
   *
   * slotToVal is a Map whose keys are slots (strings) and the values are
   * WeakRefs. If the entry is present but wr.deref()===undefined (the
   * weakref is dead), treat that as if the entry was not present. The same
   * slotToVal table is used for both imports and returning exports. The
   * subset of those which need to be held strongly (exported objects and
   * promises, imported promises) are kept alive by `exportedRemotables`.
   *
   * valToSlot is a WeakMap whose keys are Remotable/Presence/Promise
   * objects, and the keys are (string) slot identifiers. This is used
   * for both exports and returned imports.
   *
   * We use two weak maps plus the strong `exportedRemotables` set, because
   * it seems simpler than using four separate maps (import-vs-export times
   * strong-vs-weak).
   */

  const valToSlot = new WeakMap(); // object -> vref
  const slotToVal = new Map(); // vref -> WeakRef(object)
  const exportedRemotables = new Set(); // objects
  const pendingPromises = new Set(); // Promises
  const importedDevices = new Set(); // device nodes
  const deadSet = new Set(); // vrefs that are finalized but not yet reported

  function retainExportedRemotable(vref) {
    // if the vref corresponds to a Remotable, keep a strong reference to it
    // until the kernel tells us to release it
    const { type, allocatedByVat, virtual } = parseVatSlot(vref);
    if (type === 'object' && allocatedByVat && !virtual) {
      const remotable = slotToVal.get(vref).deref();
      assert(remotable, X`somehow lost Remotable for ${vref}`);
      exportedRemotables.add(remotable);
    }
  }

  /*
    Imports are in one of 5 states: UNKNOWN, REACHABLE, UNREACHABLE,
    COLLECTED, FINALIZED. Note that there's no actual state machine with those
    values, and we can't observe all of the transitions from JavaScript, but
    we can describe what operations could cause a transition, and what our
    observations allow us to deduce about the state:

    * UKNOWN moves to REACHABLE when a crank introduces a new import
    * userspace holds a reference only in REACHABLE
    * REACHABLE moves to UNREACHABLE only during a userspace crank
    * UNREACHABLE moves to COLLECTED when GC runs, which queues the finalizer
    * COLLECTED moves to FINALIZED when a new turn runs the finalizer
    * liveslots moves from FINALIZED to UNKNOWN by syscalling dropImports

    convertSlotToVal either imports a vref for the first time, or
    re-introduces a previously-seen vref. It transitions from:

    * UNKNOWN to REACHABLE by creating a new Presence
    * UNREACHABLE to REACHABLE by re-using the old Presence that userspace
      forgot about
    * COLLECTED/FINALIZED to REACHABLE by creating a new Presence

    Our tracking tables hold data that depends on the current state:

    * slotToVal holds a WeakRef in [REACHABLE, UNREACHABLE, COLLECTED]
    * that WeakRef .deref()s into something in [REACHABLE, UNREACHABLE]
    * deadSet holds the vref only in FINALIZED
    * re-introduction must ensure the vref is not in the deadSet

    Each state thus has a set of perhaps-measurable properties:

    * UNKNOWN: slotToVal[vref] is missing, vref not in deadSet
    * REACHABLE: slotToVal has live weakref, userspace can reach
    * UNREACHABLE: slotToVal has live weakref, userspace cannot reach
    * COLLECTED: slotToVal[vref] has dead weakref
    * FINALIZED: slotToVal[vref] is missing, vref is in deadSet

    Our finalizer callback is queued by the engine's transition from
    UNREACHABLE to COLLECTED, but the vref might be re-introduced before the
    callback has a chance to run. There might even be multiple copies of the
    finalizer callback queued. So the callback must deduce the current state
    and only perform cleanup (i.e. delete the slotToVal entry and add the
    vref to the deadSet) in the COLLECTED state.

  */

  function finalizeDroppedImport(vref) {
    const wr = slotToVal.get(vref);
    // The finalizer for a given Presence might run in any state:
    // * COLLECTED: most common. Action: move to FINALIZED
    // * REACHABLE/UNREACHABLE: after re-introduction. Action: ignore
    // * FINALIZED: after re-introduction and subsequent finalizer invocation
    //   (second finalizer executed for the same vref). Action: be idempotent
    // * UNKNOWN: after re-introduction, multiple finalizer invocation,
    //   and post-crank cleanup does dropImports and deletes vref from
    //   deadSet. Action: ignore

    if (wr && !wr.deref()) {
      // we're in the COLLECTED state, or FINALIZED after a re-introduction
      deadSet.add(vref);
      slotToVal.delete(vref);
      // console.log(`-- adding ${vref} to deadSet`);
    }
  }
  const droppedRegistry = new FinalizationRegistry(finalizeDroppedImport);

  function processDroppedRepresentative(_vref) {
    // no-op, to be implemented by virtual object manager
    return false;
  }

  function processDeadSet() {
    let doMore = false;
    const [importsToDrop, importsToRetire, exportsToRetire] = [[], [], []];

    for (const vref of deadSet) {
      const { virtual, allocatedByVat, type } = parseVatSlot(vref);
      assert(type === 'object', `unprepared to track ${type}`);
      if (virtual) {
        // Representative: send nothing, but perform refcount checking
        doMore = doMore || processDroppedRepresentative(vref);
      } else if (allocatedByVat) {
        // Remotable: send retireExport
        exportsToRetire.push(vref);
      } else {
        // Presence: send dropImport unless reachable by VOM
        // eslint-disable-next-line no-lonely-if, no-use-before-define
        if (!isVrefReachable(vref)) {
          importsToDrop.push(vref);
          // eslint-disable-next-line no-use-before-define
          if (!isVrefRecognizable(vref)) {
            importsToRetire.push(vref);
          }
        }
      }
    }
    deadSet.clear();

    if (importsToDrop.length) {
      importsToDrop.sort();
      syscall.dropImports(importsToDrop);
    }
    if (importsToRetire.length) {
      importsToRetire.sort();
      syscall.retireImports(importsToRetire);
    }
    if (exportsToRetire.length) {
      exportsToRetire.sort();
      syscall.retireExports(exportsToRetire);
    }

    // TODO: doMore=true when we've done something that might free more local
    // objects, which probably won't happen until we sense entire WeakMaps
    // going away or something involving virtual collections
    return doMore;
  }

  /** Remember disavowed Presences which will kill the vat if you try to talk
   * to them */
  const disavowedPresences = new WeakSet();
  const disavowalError = harden(Error(`this Presence has been disavowed`));

  const importedPromisesByPromiseID = new Map(); // vpid -> { resolve, reject }
  let nextExportID = 1;
  let nextPromiseID = 5;

  function makeImportedPresence(slot, iface = `Alleged: presence ${slot}`) {
    // Called by convertSlotToVal for type=object (an `o-NN` reference). We
    // build a Presence for application-level code to receive. This Presence
    // is associated with 'slot' so that all handled messages get sent to
    // that slot: pres~.foo() causes a syscall.send(target=slot, msg=foo).

    lsdebug(`makeImportedPresence(${slot})`);
    const fulfilledHandler = {
      applyMethod(o, prop, args, returnedP) {
        // Support: o~.[prop](...args) remote method invocation
        lsdebug(`makeImportedPresence handler.applyMethod (${slot})`);
        if (disavowedPresences.has(o)) {
          // eslint-disable-next-line no-use-before-define
          exitVatWithFailure(disavowalError);
          throw disavowalError;
        }
        // eslint-disable-next-line no-use-before-define
        return queueMessage(slot, prop, args, returnedP);
      },
    };

    let presence;
    const p = new HandledPromise((_res, _rej, resolveWithPresence) => {
      const remote = resolveWithPresence(fulfilledHandler);
      presence = Remotable(iface, undefined, remote);
      // remote === presence, actually

      // todo: mfig says to swap remote and presence (resolveWithPresence
      // gives us a Presence, Remotable gives us a Remote). I think that
      // implies we have a lot of renaming to do, 'makeRemote' instead of
      // 'makeImportedPresence', etc. I'd like to defer that for a later
      // cleanup/renaming pass.
    }); // no unfulfilledHandler

    // The call to resolveWithPresence performs the forwarding logic
    // immediately, so by the time we reach here, E(presence).foo() will use
    // our fulfilledHandler, and nobody can observe the fact that we failed
    // to provide an unfulfilledHandler.

    // We throw 'p' away, but it is retained by the internal tables of
    // HandledPromise, and will be returned to anyone who calls
    // `HandledPromise.resolve(presence)`. So we must harden it now, for
    // safety, to prevent it from being used as a communication channel
    // between isolated objects that share a reference to the Presence.
    harden(p);

    // Up at the application level, presence~.foo(args) starts by doing
    // HandledPromise.resolve(presence), which retrieves it, and then does
    // p.eventualSend('foo', [args]), which uses the fulfilledHandler.

    // We harden the presence for the same safety reasons.
    return harden(presence);
  }

  function makePipelinablePromise(vpid) {
    // Called by convertSlotToVal(type=promise) for incoming promises (a
    // `p-NN` reference), and by queueMessage() for the result of an outbound
    // message (a `p+NN` reference). We build a Promise for application-level
    // code, to which messages can be pipelined, and we prepare for the
    // kernel to tell us that it has been resolved in various ways.
    insistVatType('promise', vpid);
    lsdebug(`makePipelinablePromise(${vpid})`);

    // The Promise will we associated with a handler that converts p~.foo() into
    // a syscall.send() that targets the vpid. When the Promise is resolved
    // (during receipt of a dispatch.notify), this Promise's handler will be
    // replaced by the handler of the resolution, which might be a Presence or a
    // local object.

    // for safety as we shake out bugs in HandledPromise, we guard against
    // this handler being used after it was supposed to be resolved
    let handlerActive = true;
    const unfulfilledHandler = {
      applyMethod(_o, prop, args, returnedP) {
        // Support: o~.[prop](...args) remote method invocation
        lsdebug(`makePipelinablePromise handler.applyMethod (${vpid})`);
        if (!handlerActive) {
          console.error(`mIPromise handler called after resolution`);
          assert.fail(X`mIPromise handler called after resolution`);
        }
        // eslint-disable-next-line no-use-before-define
        return queueMessage(vpid, prop, args, returnedP);
      },
    };

    let resolve;
    let reject;
    const p = new HandledPromise((res, rej, _resPres) => {
      resolve = res;
      reject = rej;
    }, unfulfilledHandler);

    // Prepare for the kernel to tell us about resolution. Both ensure the
    // old handler should never be called again. TODO: once we're confident
    // about how we interact with HandledPromise, just use harden({ resolve,
    // reject }).
    const pRec = harden({
      resolve(resolution) {
        handlerActive = false;
        resolve(resolution);
      },

      reject(rejection) {
        handlerActive = false;
        reject(rejection);
      },
    });
    importedPromisesByPromiseID.set(vpid, pRec);

    return harden(p);
  }

  function makeDeviceNode(id, iface = `Alleged: device ${id}`) {
    return Remotable(iface);
  }

  // TODO: fix awkward non-orthogonality: allocateExportID() returns a number,
  // allocatePromiseID() returns a slot, exportPromise() uses the slot from
  // allocatePromiseID(), exportPassByPresence() generates a slot itself using
  // the number from allocateExportID().  Both allocateX fns should return a
  // number or return a slot; both exportY fns should either create a slot or
  // use a slot from the corresponding allocateX

  function allocateExportID() {
    const exportID = nextExportID;
    nextExportID += 1;
    return exportID;
  }

  function allocatePromiseID() {
    const promiseID = nextPromiseID;
    nextPromiseID += 1;
    return makeVatSlot('promise', true, promiseID);
  }

  const knownResolutions = new WeakMap();

  function exportPromise(p) {
    const pid = allocatePromiseID();
    lsdebug(`Promise allocation ${forVatID}:${pid} in exportPromise`);
    if (!knownResolutions.has(p)) {
      // eslint-disable-next-line no-use-before-define
      p.then(thenResolve(p, pid), thenReject(p, pid));
    }
    return pid;
  }

  function exportPassByPresence() {
    const exportID = allocateExportID();
    return makeVatSlot('object', true, exportID);
  }

  // eslint-disable-next-line no-use-before-define
  const m = makeMarshal(convertValToSlot, convertSlotToVal, {
    marshalName: `liveSlots:${forVatID}`,
    // TODO Temporary hack.
    // See https://github.com/Agoric/agoric-sdk/issues/2780
    errorIdNum: 70000,
    marshalSaveError: err =>
      // By sending this to `console.info`, under cosmic-swingset this is
      // controlled by the `console` option given to makeLiveSlots.
      console.info('Logging sent error stack', err),
  });

  function getSlotForVal(val) {
    return valToSlot.get(val);
  }

  function getValForSlot(slot) {
    const wr = slotToVal.get(slot);
    return wr && wr.deref();
  }

  const {
    makeVirtualObjectRepresentative,
    makeWeakStore,
    makeKind,
    VirtualObjectAwareWeakMap,
    VirtualObjectAwareWeakSet,
    isVrefReachable,
    isVrefRecognizable,
  } = makeVirtualObjectManager(
    syscall,
    allocateExportID,
    getSlotForVal,
    getValForSlot,
    // eslint-disable-next-line no-use-before-define
    registerValue,
    m,
    cacheSize,
  );

  function convertValToSlot(val) {
    // lsdebug(`serializeToSlot`, val, Object.isFrozen(val));
    // This is either a Presence (in presenceToImportID), a
    // previously-serialized local pass-by-presence object or
    // previously-serialized local Promise (in valToSlot), a new local
    // pass-by-presence object, or a new local Promise.

    // If we've already assigned it an importID or exportID, it might be in
    // slots/slotMap for this particular act of serialization. If it's new,
    // it certainly will not be in slotMap. If we've already serialized it in
    // this particular act, it will definitely be in slotMap.

    if (!valToSlot.has(val)) {
      let slot;
      // must be a new export
      // lsdebug('must be a new export', JSON.stringify(val));
      if (isPromise(val)) {
        slot = exportPromise(val);
        pendingPromises.add(val); // keep it alive until resolved
      } else {
        if (disavowedPresences.has(val)) {
          // eslint-disable-next-line no-use-before-define
          exitVatWithFailure(disavowalError);
          throw disavowalError; // cannot reference a disavowed object
        }
        assert.equal(passStyleOf(val), 'remotable');
        slot = exportPassByPresence();
      }
      const { type } = parseVatSlot(slot); // also used as assertion
      valToSlot.set(val, slot);
      slotToVal.set(slot, new WeakRef(val));
      if (type === 'object') {
        deadSet.delete(slot);
        droppedRegistry.register(val, slot, val);
      }
    }
    return valToSlot.get(val);
  }

  let importedPromises = null;
  function beginCollectingPromiseImports() {
    importedPromises = new Set();
  }
  function finishCollectingPromiseImports() {
    const result = importedPromises;
    importedPromises = null;
    return result;
  }

  function registerValue(slot, val) {
    const { type } = parseVatSlot(slot);
    slotToVal.set(slot, new WeakRef(val));
    valToSlot.set(val, slot);
    // we don't dropImports on promises, to avoid interaction with retire
    if (type === 'object') {
      deadSet.delete(slot); // might have been FINALIZED before, no longer
      droppedRegistry.register(val, slot, val);
    }
  }

  function convertSlotToVal(slot, iface = undefined) {
    const { type, allocatedByVat, virtual } = parseVatSlot(slot);
    const wr = slotToVal.get(slot);
    let val = wr && wr.deref();
    if (val) {
      if (virtual) {
        // If it's a virtual object for which we already have a representative,
        // we are going to use that existing representative to preserve ===
        // equality and WeakMap key usability, BUT we are going to ask the user
        // code to make a new representative anyway (which we'll discard) so
        // that as far as the user code is concerned we are making a new
        // representative with each act of deserialization.  This way they can't
        // detect reanimation by playing games inside their instanceKitMaker to
        // try to observe when new representatives are created (e.g., by
        // counting calls or squirreling things away in hidden WeakMaps).
        makeVirtualObjectRepresentative(slot, true); // N.b.: throwing away the result
      }
      return val;
    }
    if (virtual) {
      // Virtual objects should never be put in the slotToVal table, as their
      // entire raison d'etre is to be absent from memory when they're not being
      // used.  They *do* get put in the valToSlot table, which is OK because
      // it's a WeakMap, but they don't get put there here.  Instead, they are
      // put there by makeVirtualObjectRepresentative, who already has to do
      // this anyway in the cases of creating virtual objects in the first place
      // and swapping them in from disk.
      assert.equal(type, 'object');
      val = makeVirtualObjectRepresentative(slot, false);
    } else {
      assert(!allocatedByVat, X`I don't remember allocating ${slot}`);
      if (type === 'object') {
        // this is a new import value
        val = makeImportedPresence(slot, iface);
      } else if (type === 'promise') {
        assert(
          !parseVatSlot(slot).allocatedByVat,
          X`kernel is being presumptuous: vat got unrecognized vatSlot ${slot}`,
        );
        val = makePipelinablePromise(slot);
        // ideally we'd wait until .then is called on p before subscribing,
        // but the current Promise API doesn't give us a way to discover
        // this, so we must subscribe right away. If we were using Vows or
        // some other then-able, we could just hook then() to notify us.
        if (importedPromises) {
          importedPromises.add(slot);
        } else {
          syscall.subscribe(slot);
        }
        // keep the imported promise alive until it resolves
        pendingPromises.add(val);
      } else if (type === 'device') {
        val = makeDeviceNode(slot, iface);
        importedDevices.add(val);
      } else {
        assert.fail(X`unrecognized slot type '${type}'`);
      }
    }
    registerValue(slot, val);
    return val;
  }

  function resolutionCollector() {
    const resolutions = [];
    const doneResolutions = new Set();

    function scanSlots(slots) {
      for (const slot of slots) {
        const { type } = parseVatSlot(slot);
        if (type === 'promise') {
          const wr = slotToVal.get(slot);
          const p = wr && wr.deref();
          assert(p, X`should have a value for ${slot} but didn't`);
          const priorResolution = knownResolutions.get(p);
          if (priorResolution && !doneResolutions.has(slot)) {
            const [priorRejected, priorRes] = priorResolution;
            // eslint-disable-next-line no-use-before-define
            collect(slot, priorRejected, priorRes);
          }
        }
      }
    }

    function collect(promiseID, rejected, value) {
      doneResolutions.add(promiseID);
      const valueSer = m.serialize(value);
      valueSer.slots.map(retainExportedRemotable);
      resolutions.push([promiseID, rejected, valueSer]);
      scanSlots(valueSer.slots);
    }

    function forPromise(promiseID, rejected, value) {
      collect(promiseID, rejected, value);
      return resolutions;
    }

    function forSlots(slots) {
      scanSlots(slots);
      return resolutions;
    }

    return {
      forPromise,
      forSlots,
    };
  }

  function queueMessage(targetSlot, prop, args, returnedP) {
    if (typeof prop === 'symbol') {
      if (prop === Symbol.asyncIterator) {
        // special-case this Symbol for now, will be replaced in #2481
        prop = 'Symbol.asyncIterator';
      } else {
        throw Error(`arbitrary Symbols cannot be used as method names`);
      }
    }

    const serArgs = m.serialize(harden(args));
    serArgs.slots.map(retainExportedRemotable);
    const resultVPID = allocatePromiseID();
    lsdebug(`Promise allocation ${forVatID}:${resultVPID} in queueMessage`);
    // create a Promise which callers follow for the result, give it a
    // handler so we can pipeline messages to it, and prepare for the kernel
    // to notify us of its resolution
    const p = makePipelinablePromise(resultVPID);

    lsdebug(
      `ls.qm send(${JSON.stringify(targetSlot)}, ${String(
        prop,
      )}) -> ${resultVPID}`,
    );
    syscall.send(targetSlot, prop, serArgs, resultVPID);
    const resolutions = resolutionCollector().forSlots(serArgs.slots);
    if (resolutions.length > 0) {
      syscall.resolve(resolutions);
    }

    // ideally we'd wait until .then is called on p before subscribing, but
    // the current Promise API doesn't give us a way to discover this, so we
    // must subscribe right away. If we were using Vows or some other
    // then-able, we could just hook then() to notify us.
    syscall.subscribe(resultVPID);

    // We return 'p' to the handler, and the eventual resolution of 'p' will
    // be used to resolve the caller's Promise, but the caller never sees 'p'
    // itself. The caller got back their Promise before the handler ever got
    // invoked, and thus before queueMessage was called.. If that caller
    // passes the Promise they received as argument or return value, we want
    // it to serialize as resultVPID. And if someone passes resultVPID to
    // them, we want the user-level code to get back that Promise, not 'p'.
    // As a result, we do not retain or track 'p'. Only 'returnedP' is
    // registered and retained by pendingPromises.

    valToSlot.set(returnedP, resultVPID);
    slotToVal.set(resultVPID, new WeakRef(returnedP));
    pendingPromises.add(returnedP);
    // we do not use droppedRegistry for promises, even result promises

    return p;
  }

  function forbidPromises(serArgs) {
    for (const slot of serArgs.slots) {
      assert(
        parseVatSlot(slot).type !== 'promise',
        X`D() arguments cannot include a Promise`,
      );
    }
  }

  function DeviceHandler(slot) {
    return {
      get(target, prop) {
        if (typeof prop !== 'string' && typeof prop !== 'symbol') {
          return undefined;
        }
        return (...args) => {
          const serArgs = m.serialize(harden(args));
          serArgs.slots.map(retainExportedRemotable);
          forbidPromises(serArgs);
          const ret = syscall.callNow(slot, prop, serArgs);
          insistCapData(ret);
          const retval = m.unserialize(ret);
          return retval;
        };
      },
    };
  }

  function D(x) {
    // results = D(devicenode).name(args)
    if (outstandingProxies.has(x)) {
      throw new Error('D(D(x)) is invalid');
    }
    const slot = valToSlot.get(x);
    if (!slot || parseVatSlot(slot).type !== 'device') {
      throw new Error('D() must be given a device node');
    }
    const handler = DeviceHandler(slot);
    const pr = harden(new Proxy({}, handler));
    outstandingProxies.add(pr);
    return pr;
  }

  function deliver(target, method, argsdata, result) {
    assert(didRoot);
    insistCapData(argsdata);
    lsdebug(
      `ls[${forVatID}].dispatch.deliver ${target}.${method} -> ${result}`,
    );
    const t = convertSlotToVal(target);
    assert(t, X`no target ${target}`);
    // TODO: if we acquire new decision-making authority over a promise that
    // we already knew about ('result' is already in slotToVal), we should no
    // longer accept dispatch.notify from the kernel. We currently use
    // importedPromisesByPromiseID to track a combination of "we care about
    // when this promise resolves" and "we are listening for the kernel to
    // resolve it". We should split that into two tables or something. And we
    // should error-check cases that the kernel shouldn't do, like getting
    // the same vpid as a result= twice, or getting a result= for an exported
    // promise (for which we were already the decider).

    if (method === 'Symbol.asyncIterator') {
      method = Symbol.asyncIterator;
    }

    const args = m.unserialize(argsdata);

    // If the method is missing, or is not a Function, or the method throws a
    // synchronous exception, we notify the caller (by rejecting the result
    // promise, if any). If the method returns an eventually-rejected
    // Promise, we notify them when it resolves.

    // If the method returns a synchronous value, we notify the caller right
    // away. If it returns an eventually-fulfilled Promise, we notify the
    // caller when it resolves.

    // Both situations are the business of this vat and the calling vat, not
    // the kernel. deliver() does not report such exceptions to the kernel.

    // We have a presence, so forward to it.
    let res;
    if (args) {
      // It has arguments, must be a method application.
      res = HandledPromise.applyMethod(t, method, args);
    } else {
      // Just a getter.
      // TODO: untested, but in principle sound.
      res = HandledPromise.get(t, method);
    }
    let notifySuccess = () => undefined;
    let notifyFailure = () => undefined;
    if (result) {
      insistVatType('promise', result);
      // eslint-disable-next-line no-use-before-define
      notifySuccess = thenResolve(res, result);
      // eslint-disable-next-line no-use-before-define
      notifyFailure = thenReject(res, result);
    }
    res.then(notifySuccess, notifyFailure);
  }

  function retirePromiseID(promiseID) {
    lsdebug(`Retiring ${forVatID}:${promiseID}`);
    importedPromisesByPromiseID.delete(promiseID);
    const wr = slotToVal.get(promiseID);
    const p = wr && wr.deref();
    if (p) {
      valToSlot.delete(p);
      pendingPromises.delete(p);
    }
    slotToVal.delete(promiseID);
  }

  function thenHandler(p, promiseID, rejected) {
    insistVatType('promise', promiseID);
    return value => {
      knownResolutions.set(p, harden([rejected, value]));
      harden(value);
      lsdebug(`ls.thenHandler fired`, value);
      const resolutions = resolutionCollector().forPromise(
        promiseID,
        rejected,
        value,
      );

      syscall.resolve(resolutions);

      const pRec = importedPromisesByPromiseID.get(promiseID);
      if (pRec) {
        if (rejected) {
          pRec.reject(value);
        } else {
          pRec.resolve(value);
        }
      }
      retirePromiseID(promiseID);
    };
  }

  function thenResolve(p, promiseID) {
    return thenHandler(p, promiseID, false);
  }

  function thenReject(p, promiseID) {
    return thenHandler(p, promiseID, true);
  }

  function notifyOnePromise(promiseID, rejected, data) {
    insistCapData(data);
    lsdebug(
      `ls.dispatch.notify(${promiseID}, ${rejected}, ${data.body}, [${data.slots}])`,
    );
    insistVatType('promise', promiseID);
    // TODO: insist that we do not have decider authority for promiseID
    assert(
      importedPromisesByPromiseID.has(promiseID),
      X`unknown promiseID '${promiseID}'`,
    );
    const pRec = importedPromisesByPromiseID.get(promiseID);
    const val = m.unserialize(data);
    if (rejected) {
      pRec.reject(val);
    } else {
      pRec.resolve(val);
    }
  }

  function notify(resolutions) {
    assert(didRoot);
    beginCollectingPromiseImports();
    for (const resolution of resolutions) {
      const [vpid, rejected, data] = resolution;
      notifyOnePromise(vpid, rejected, data);
    }
    for (const resolution of resolutions) {
      const [vpid] = resolution;
      retirePromiseID(vpid);
    }
    const imports = finishCollectingPromiseImports();
    for (const slot of imports) {
      if (slotToVal.get(slot)) {
        syscall.subscribe(slot);
      }
    }
  }

  function dropExports(vrefs) {
    assert(Array.isArray(vrefs));
    vrefs.map(vref => insistVatType('object', vref));
    vrefs.map(vref => assert(parseVatSlot(vref).allocatedByVat));
    // console.log(`-- liveslots acting upon dropExports ${vrefs.join(',')}`);
    for (const vref of vrefs) {
      const wr = slotToVal.get(vref);
      const o = wr && wr.deref();
      if (o) {
        exportedRemotables.delete(o);
      }
    }
  }

  function retireOneExport(vref) {
    insistVatType('object', vref);
    const { virtual, allocatedByVat, type } = parseVatSlot(vref);
    assert(allocatedByVat);
    assert.equal(type, 'object');
    if (virtual) {
      // virtual object: ignore for now, but TODO we must still not make
      // syscall.retireExport for vrefs that were already retired by the
      // kernel
      // console.log(`-- liveslots ignoring retireExports ${vref}`);
    } else {
      // Remotable
      // console.log(`-- liveslots acting on retireExports ${vref}`);
      const wr = slotToVal.get(vref);
      if (wr) {
        const val = wr.deref();
        if (val) {
          // it's fine to still have a value, that just means the kernel
          // (and other vats) have completely forgotten about this, but we
          // still know about it

          if (exportedRemotables.has(val)) {
            // however this is weird: we still think the Remotable is
            // reachable, otherwise we would have removed it from
            // exportedRemotables. The kernel was supposed to send
            // dispatch.dropExports first.
            console.log(`err: kernel retired undropped ${vref}`);
            // TODO: find a way to make this more severe, it's cause for
            // panicing the kernel, except that vats don't have that
            // authority. It's *not* cause for terminating the vat, since
            // it wasn't necessarily our fault.
            return;
          }
          valToSlot.delete(val);
          droppedRegistry.unregister(val);
        }
        slotToVal.delete(vref);
      }
    }
  }

  function retireExports(vrefs) {
    assert(Array.isArray(vrefs));
    vrefs.forEach(retireOneExport);
  }

  function retireImports(vrefs) {
    assert(Array.isArray(vrefs));
    vrefs.map(vref => insistVatType('object', vref));
    vrefs.map(vref => assert(!parseVatSlot(vref).allocatedByVat));
    // console.log(`-- liveslots ignoring retireImports ${vrefs.join(',')}`);
  }

  // TODO: when we add notifyForward, guard against cycles

  function exitVat(completion) {
    const args = m.serialize(harden(completion));
    args.slots.map(retainExportedRemotable);
    syscall.exit(false, args);
  }

  function exitVatWithFailure(reason) {
    const args = m.serialize(harden(reason));
    args.slots.map(retainExportedRemotable);
    syscall.exit(true, args);
  }

  function disavow(presence) {
    if (!valToSlot.has(presence)) {
      assert.fail(X`attempt to disavow unknown ${presence}`);
    }
    const slot = valToSlot.get(presence);
    const { type, allocatedByVat } = parseVatSlot(slot);
    assert.equal(type, 'object', X`attempt to disavow non-object ${presence}`);
    // disavow() is only for imports: we'll use a different API to revoke
    // exports, one which accepts an Error object
    assert.equal(allocatedByVat, false, X`attempt to disavow an export`);
    valToSlot.delete(presence);
    slotToVal.delete(slot);
    disavowedPresences.add(presence);

    syscall.dropImports([slot]);
  }

  const vatGlobals = harden({
    makeWeakStore,
    makeKind,
  });

  const inescapableGlobalProperties = harden({
    WeakMap: VirtualObjectAwareWeakMap,
    WeakSet: VirtualObjectAwareWeakSet,
  });

  function setBuildRootObject(buildRootObject) {
    assert(!didRoot);
    didRoot = true;

    // vats which use D are: (bootstrap, bridge, vat-http), swingset
    const vpow = {
      D,
      exitVat,
      exitVatWithFailure,
      ...vatPowers,
    };
    if (enableDisavow) {
      vpow.disavow = disavow;
    }
    if (enableVatstore) {
      vpow.vatstore = harden({
        get: key => {
          assert.typeof(key, 'string');
          return syscall.vatstoreGet(`vvs.${key}`);
        },
        set: (key, value) => {
          assert.typeof(key, 'string');
          assert.typeof(value, 'string');
          syscall.vatstoreSet(`vvs.${key}`, value);
        },
        delete: key => {
          assert.typeof(key, 'string');
          syscall.vatstoreDelete(`vvs.${key}`);
        },
      });
    }

    // here we finally invoke the vat code, and get back the root object
    const rootObject = buildRootObject(harden(vpow), harden(vatParameters));
    assert.equal(
      passStyleOf(rootObject),
      'remotable',
      `buildRootObject() (${buildRootObject}) returned ${rootObject}, which is not Far`,
    );

    const rootSlot = makeVatSlot('object', true, BigInt(0));
    valToSlot.set(rootObject, rootSlot);
    slotToVal.set(rootSlot, new WeakRef(rootObject));
    retainExportedRemotable(rootSlot);
    // we do not use droppedRegistry for exports
  }

  /**
   * @param { VatDeliveryObject } delivery
   * @returns { void }
   */
  function dispatchToUserspace(delivery) {
    const [type, ...args] = delivery;
    switch (type) {
      case 'message': {
        const [targetSlot, msg] = args;
        insistMessage(msg);
        deliver(targetSlot, msg.method, msg.args, msg.result);
        break;
      }
      case 'notify': {
        const [resolutions] = args;
        notify(resolutions);
        break;
      }
      case 'dropExports': {
        const [vrefs] = args;
        dropExports(vrefs);
        break;
      }
      case 'retireExports': {
        const [vrefs] = args;
        retireExports(vrefs);
        break;
      }
      case 'retireImports': {
        const [vrefs] = args;
        retireImports(vrefs);
        break;
      }
      default:
        assert.fail(X`unknown delivery type ${type}`);
    }
  }

  const { waitUntilQuiescent, gcAndFinalize } = gcTools;

  /**
   * This low-level liveslots code is responsible for deciding when userspace
   * is done with a crank. Userspace code can use Promises, so it can add as
   * much as it wants to the ready promise queue. But since userspace never
   * gets direct access to the timer or IO queues (i.e. setImmediate,
   * setInterval, setTimeout), then once the promise queue is empty, the vat
   * has lost "agency" (the ability to initiate further execution).
   *
   * @param { VatDeliveryObject } delivery
   * @returns { Promise<void> }
   */
  async function dispatch(delivery) {
    // Start user code running, record any internal liveslots errors. We do
    // *not* directly wait for the userspace function to complete, nor for
    // any promise it returns to fire.
    Promise.resolve(delivery)
      .then(dispatchToUserspace)
      .catch(err =>
        console.log(`liveslots error ${err} during delivery ${delivery}`),
      );

    // Instead, we wait for userspace to become idle by draining the promise
    // queue.
    await waitUntilQuiescent();
    // Userspace will not get control again within this crank.

    // Now that userspace is idle, we can drive GC until we think we've
    // stopped.
    async function finish() {
      await gcAndFinalize();
      const doMore = processDeadSet();
      if (doMore) {
        return finish();
      }
      return undefined;
    }
    return finish();
  }
  harden(dispatch);

  // we return 'deadSet' for unit tests
  return harden({
    vatGlobals,
    inescapableGlobalProperties,
    setBuildRootObject,
    dispatch,
    m,
    deadSet,
  });
}

/**
 * Instantiate the liveslots layer for a new vat and then populate the vat with
 * a new root object and its initial associated object graph, if any.
 *
 * @param {*} syscall  Kernel syscall interface that the vat will have access to
 * @param {*} forVatID  Vat ID label, for use in debug diagostics
 * @param {*} vatPowers
 * @param {*} vatParameters
 * @param {number} cacheSize  Upper bound on virtual object cache size
 * @param {boolean} enableDisavow
 * @param {boolean} enableVatstore
 * @param {*} gcTools { WeakRef, FinalizationRegistry, waitUntilQuiescent }
 * @param {Console} [liveSlotsConsole]
 * @returns {*} { vatGlobals, inescapableGlobalProperties, dispatch, setBuildRootObject }
 *
 * setBuildRootObject should be called, once, with a function that will
 * create a root object for the new vat The caller provided buildRootObject
 * function produces and returns the new vat's root object:
 *
 * buildRootObject(vatPowers, vatParameters)
 *
 * Within the vat, `import { E } from '@agoric/eventual-send'` will
 * provide the E wrapper. For any object x, E(x) returns a proxy object
 * that converts any method invocation into a corresponding eventual send
 * to x. That is, E(x).foo(arg1, arg2) is equivalent to x~.foo(arg1,
 * arg2)
 *
 * If x is the presence in this vat of a remote object (that is, an object
 * outside the vat), this will result in a message send out of the vat via
 * the kernel syscall interface.
 *
 * In the same vein, if x is the presence in this vat of a kernel device,
 * vatPowers.D(x) returns a proxy such that a method invocation on it is
 * translated into the corresponding immediate invocation of the device
 * (using, once again, the kernel syscall interface). D(x).foo(args) will
 * perform an immediate syscall.callNow on the device node.
 */
export function makeLiveSlots(
  syscall,
  forVatID = 'unknown',
  vatPowers = harden({}),
  vatParameters = harden({}),
  cacheSize = DEFAULT_VIRTUAL_OBJECT_CACHE_SIZE,
  enableDisavow = false,
  enableVatstore = false,
  gcTools,
  liveSlotsConsole = console,
) {
  const allVatPowers = {
    ...vatPowers,
    makeMarshal,
  };
  const r = build(
    syscall,
    forVatID,
    cacheSize,
    enableDisavow,
    enableVatstore,
    allVatPowers,
    vatParameters,
    gcTools,
    liveSlotsConsole,
  );
  const {
    vatGlobals,
    inescapableGlobalProperties,
    dispatch,
    setBuildRootObject,
    deadSet,
  } = r; // omit 'm'
  return harden({
    vatGlobals,
    inescapableGlobalProperties,
    dispatch,
    setBuildRootObject,
    deadSet,
  });
}

// for tests
export function makeMarshaller(syscall, gcTools) {
  const { m } = build(
    syscall,
    'forVatID',
    DEFAULT_VIRTUAL_OBJECT_CACHE_SIZE,
    false,
    false,
    {},
    {},
    gcTools,
    console,
  );
  return { m };
}
