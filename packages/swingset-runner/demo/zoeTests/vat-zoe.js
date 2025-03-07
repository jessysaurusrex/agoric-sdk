// noinspection ES6PreferShortImport
import { makeZoe } from '@agoric/zoe';
import { Far } from '@agoric/marshal';

export function buildRootObject(_vatPowers, vatParameters) {
  return Far('root', {
    buildZoe: vatAdminSvc => makeZoe(vatAdminSvc, vatParameters.zcfBundleName),
  });
}
