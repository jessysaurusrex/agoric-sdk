// @ts-check

import { Far } from '@agoric/marshal';
import { assert, details as X } from '@agoric/assert';
import { sameStructure } from '@agoric/same-structure';

import { buildParamManager, ParamType } from '../../../src/paramManager';

const MALLEABLE_NUMBER = 'MalleableNumber';

/** @type {ParameterNameList} */
const governedParameterTerms = {
  contractParams: [MALLEABLE_NUMBER],
};

/** @type {ParamDescriptions} */
const governedParameterInitialValues = [
  {
    name: MALLEABLE_NUMBER,
    value: 602214090000000000000000n,
    type: ParamType.NAT,
  },
];
harden(governedParameterTerms);

/** @type {ContractStartFn} */
const start = async zcf => {
  const {
    /** @type {Instance} */ electionManager,
    /** @type {ParameterNameList} */ governedParams,
  } = zcf.getTerms();
  /** @type {ERef<GovernorPublic>} */

  assert(
    sameStructure(governedParams, governedParameterTerms),
    X`Terms must include ${MALLEABLE_NUMBER}`,
  );
  const paramManager = buildParamManager(governedParameterInitialValues);

  // There's only one paramManager, so just return it.
  const getParamMgrAccessor = () =>
    Far('paramManagerAccessor', {
      get: () => paramManager,
    });

  const publicFacet = Far('public face of governed contract', {
    getState: () => paramManager.getParams().MalleableNumber,
    getContractGovernor: () => electionManager,
  });

  const creatorFacet = Far('creator facet of governed contract', {
    getContractGovernor: () => electionManager,
    getParamMgrAccessor,
  });
  return { publicFacet, creatorFacet };
};
harden(start);
harden(MALLEABLE_NUMBER);
harden(governedParameterTerms);

export { start, governedParameterTerms, MALLEABLE_NUMBER };
