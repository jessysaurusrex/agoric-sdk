// @ts-check

import { E } from '@agoric/eventual-send';
import { Far } from '@agoric/marshal';
import { sameStructure } from '@agoric/same-structure';
import { makePromiseKit } from '@agoric/promise-kit';

import {
  ChoiceMethod,
  QuorumRule,
  ElectionType,
  makeBallotSpec,
} from './ballotBuilder';
import { assertType } from './paramManager';

const paramChangePositions = (paramName, proposedValue) => {
  const positive = harden({ changeParam: paramName, proposedValue });
  const negative = harden({ noChange: paramName });
  return { positive, negative };
};

/** @type {SetupGovernance} */
const setupGovernance = async (
  paramManagerAccessor,
  poserFacet,
  contractInstance,
  timer,
) => {
  /** @type {VoteOnParamChange} */
  const voteOnParamChange = async (
    paramSpec,
    proposedValue,
    ballotCounterInstallation,
    deadline,
  ) => {
    const paramMgr = E(paramManagerAccessor).get(paramSpec);
    const paramName = paramSpec.parameterName;
    const param = await E(paramMgr).getParam(paramName);
    assertType(param.type, proposedValue, paramName);
    const outcomeOfUpdateP = makePromiseKit();

    const { positive, negative } = paramChangePositions(
      paramName,
      proposedValue,
    );
    const ballotSpec = makeBallotSpec(
      ChoiceMethod.CHOOSE_N,
      {
        param: paramName,
        contract: contractInstance,
        proposedValue,
      },
      [positive, negative],
      ElectionType.PARAM_CHANGE,
      1,
      { timer, deadline },
      QuorumRule.HALF,
      negative,
    );

    const {
      publicFacet: counterPublicFacet,
      instance: ballotCounter,
    } = await E(poserFacet).addQuestion(ballotCounterInstallation, ballotSpec);

    E(counterPublicFacet)
      .getOutcome()
      .then(outcome => {
        if (sameStructure(positive, outcome)) {
          E(paramMgr)
            [`update${paramName}`](proposedValue)
            .then(newValue => outcomeOfUpdateP.resolve(newValue))
            .catch(e => {
              outcomeOfUpdateP.reject(e);
            });
        }
      })
      .catch(e => {
        outcomeOfUpdateP.reject(e);
      });

    const details = await E(counterPublicFacet).getDetails();

    return {
      outcomeOfUpdate: outcomeOfUpdateP.promise,
      instance: ballotCounter,
      details,
    };
  };

  return Far('paramGovernor', { voteOnParamChange });
};

harden(setupGovernance);
harden(paramChangePositions);
export { setupGovernance, paramChangePositions };
