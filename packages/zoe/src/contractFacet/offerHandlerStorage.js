// @ts-check

import { makeWeakStore as makeNonVOWeakStore } from '@agoric/store';
import { Far } from '@agoric/marshal';

import { makeHandle } from '../makeHandle';

const { isFrozen } = Object;

export const makeOfferHandlerStorage = () => {
  /** @type {WeakStore<InvitationHandle, OfferHandler>} */
  const invitationHandleToHandler = makeNonVOWeakStore('invitationHandle');

  /** @type {(offerHandler: OfferHandler) => InvitationHandle} */
  const storeOfferHandler = offerHandler => {
    if (!isFrozen(offerHandler)) {
      Far('offerHandler', offerHandler);
    }
    const invitationHandle = makeHandle('Invitation');
    invitationHandleToHandler.init(invitationHandle, offerHandler);
    return invitationHandle;
  };

  /** @type {(invitationHandle: InvitationHandle) => OfferHandler} */
  const takeOfferHandler = invitationHandle => {
    const offerHandler = invitationHandleToHandler.get(invitationHandle);
    invitationHandleToHandler.delete(invitationHandle);
    return offerHandler;
  };

  return harden({
    storeOfferHandler,
    takeOfferHandler,
  });
};
