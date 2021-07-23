// @ts-check

import { E } from '@agoric/eventual-send';
import { assert, details as X } from '@agoric/assert';

const assertContractGovernance = async (
  zoe,
  allegedGoverned,
  allegedGovernor,
) => {
  const allegedGovernorPF = E(zoe).getPublicFacet(allegedGovernor);
  const allegedGovernedTermsP = E(zoe).getTerms(allegedGoverned);
  const realGovernedP = E(allegedGovernorPF).getGovernedContract();
  const [{ electionManager: realGovernor }, realGoverned] = await Promise.all([
    allegedGovernedTermsP,
    realGovernedP,
  ]);
  assert(
    allegedGovernor === realGovernor,
    X`The alleged governor did not match the governor retrieved from the governed contract`,
  );

  assert(
    allegedGoverned === realGoverned,
    X`The alleged governed did not match the governed contract retrieved from the governor`,
  );
};
export { assertContractGovernance };
