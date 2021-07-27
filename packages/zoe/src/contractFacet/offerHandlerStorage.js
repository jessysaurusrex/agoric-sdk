// @ts-check

import { makeWeakStore as makeNonVOWeakStore } from '@agoric/store';
import { Far } from '@agoric/marshal';

import { makeHandle } from '../makeHandle';

export const makeOfferHandlerStorage = () => {
  /** @type {WeakStore<InvitationHandle, OfferHandler>} */
  const invitationHandleToHandler = makeNonVOWeakStore('invitationHandle');

  /** @type {(offerHandler: OfferHandler) => InvitationHandle} */
  const storeOfferHandler = offerHandler => {
    const farOfferHandler = Far('offerHandler', seat => offerHandler(seat));
    const invitationHandle = makeHandle('Invitation');
    invitationHandleToHandler.init(invitationHandle, farOfferHandler);
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
