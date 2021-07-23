// @ts-check

import { E } from '@agoric/eventual-send';
import { Far } from '@agoric/marshal';
import { q } from '@agoric/assert';
import { assertContractGovernance } from '../../../src/validators';

const build = async (log, zoe) => {
  return Far('voter', {
    createVoter: async (name, invitation) => {
      const seat = E(zoe).offer(invitation);
      const voteFacet = E(seat).getOfferResult();

      return Far(`Voter ${name}`, {
        castBallotFor: async (handle, choice) => {
          log(`Voter ${name} cast a ballot for ${q(choice)}`);
          return E(voteFacet).castBallotFor(handle, [choice]);
        },
        validate: async (
          counterInstance,
          governedInstance,
          registrarInstance,
          governorInstance,
        ) => {
          // I'd like to validate Installations, but there doesn't seem to be a
          // way to get it from an Instance. I'd verify the Registrar,
          // ballotCounter, and contractGovernor.

          const governedTermsP = E(zoe).getTerms(governedInstance);
          const electionManagerP = E.get(governedTermsP).electionManager;
          const governedParamP = E.get(governedTermsP).governedParams;
          const governorPublicP = E(zoe).getPublicFacet(await electionManagerP);
          const registrarIFromGovernorP = E(governorPublicP).getRegistrar();

          const counterPublicP = E(zoe).getPublicFacet(counterInstance);
          const ballotDetailsP = E(counterPublicP).getDetails();

          const [
            registrarIFromGovernor,
            governedParam,
            ballotDetails,
          ] = await Promise.all([
            registrarIFromGovernorP,
            governedParamP,
            ballotDetailsP,
          ]);

          const contractParam = governedParam.contractParams;
          const included = ballotDetails.question.param === contractParam[0];

          log(
            `"${ballotDetails.question.param}" ${
              included ? 'is' : 'is not'
            } in the question`,
          );

          const registrarsMatch = registrarIFromGovernor === registrarInstance;
          log(
            `registrar from governor ${
              registrarsMatch ? 'matches' : 'does not match'
            }`,
          );

          assertContractGovernance(zoe, governedInstance, governorInstance);
        },
      });
    },
  });
};

export const buildRootObject = vatPowers =>
  Far('root', {
    build: (...args) => build(vatPowers.testLog, ...args),
  });
