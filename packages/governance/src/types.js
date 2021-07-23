// @ts-check

/**
 * @typedef { 'amount' | 'brand' | 'installation' | 'instance' | 'nat' | 'ratio' | 'string' | 'unknown' } ParamType
 */

/**
 * @typedef { Amount | Brand | Installation | Instance | bigint | Ratio | string | unknown } ParamValue
 */

/**
 * @typedef { 'choose_n' | 'order' | 'weight' } ChoiceMethod
 *  CHOOSE_N: voter indicates up to N they find acceptable (N might be 1).
 *  ORDER: voter lists their choices from most to least favorite.
 *  WEIGHT: voter lists their choices, each with a numerical weight. High
 *    numbers are most preferred.
 */

/**
 * @typedef { 'param_change' | 'election' | 'survey' } ElectionType
 * param_change is very specific. Survey means multiple answers are possible,
 * Election means some candidates are going to "win". It's not clear these are
 * orthogonal. The important distinction is that param_change has a structured
 * question, while the others have a question presented as a string.
 */

/**
 * @typedef { 'half' | 'all' | 'none' } QuorumRule
 */

/**
 * @typedef {Object} ParamDescription
 * @property {string} name
 * @property {ParamValue} value
 * @property {ParamType} type
 */

/**
 * @typedef {Object} ParamManagerBase
 * @property {() => Record<Keyword,ParamDescription>} getParams
 * @property {(name: string) => ParamDescription} getParam
 */

/**
 * @typedef {{ [updater: string]: (arg: ParamValue) => void }} ParamManagerUpdaters
 * @typedef {ParamManagerBase & ParamManagerUpdaters} ParamManagerFull
 */

/**
 * @typedef {Array<ParamDescription>} ParamDescriptions
 */

/**
 * @typedef {Record<string, string[]>} ParameterNameList
 */

/**
 * @callback BuildParamManager
 * @param {ParamDescriptions} paramDesc
 * @returns {ParamManagerFull}
 */

/**
 * @typedef {Object} SimpleQuestion
 * @property {string} question
 */

/**
 * @typedef {Object} ParamChangeQuestion
 * @property {string} param
 * @property {Instance} contract
 * @property {ParamValue} proposedValue
 */

/**
 * @typedef { SimpleQuestion | ParamChangeQuestion } Question
 */

/**
 * @typedef {Object} QuestionTerms - BallotSpec plus the Registrar Instance
 * @property {Question} question
 * @property {string[]} positions
 * @property {ChoiceMethod} method
 * @property {number} maxChoices
 * @property {ClosingRule} closingRule
 * @property {Instance} registrar
 */

/**
 * @typedef {Object} textPosition
 * @property {string} text
 */

/**
 * @typedef {Object} changeParamPosition
 * @property {string} changeParam
 * @property {ParamValue} proposedValue
 */

/**
 * @typedef {Object} noChangeParamPosition
 * @property {string} noChange
 */

/**
 * @typedef { textPosition | changeParamPosition | noChangeParamPosition } Position
 */

/**
 * @typedef {Object} BallotSpec
 *   Specification when requesting a Ballot
 * @property {ChoiceMethod} method
 * @property {Question} question
 * @property {Position[]} positions
 * @property {ElectionType} electionType
 * @property {number} maxChoices
 * @property {ClosingRule} closingRule
 * @property {QuorumRule} quorumRule
 * @property {Position} tieOutcome
 */

/**
 * @typedef {Object} BallotDetails
 *    complete ballot details: ballotSpec plus counter and handle
 * @property {ChoiceMethod} method
 * @property {Question} question
 * @property {Position[]} positions
 * @property {ElectionType} electionType
 * @property {number} maxChoices
 * @property {ClosingRule} closingRule
 * @property {QuorumRule} quorumRule
 * @property {Position} tieOutcome
 * @property {Instance} counterInstance - instance of the BallotCounter
 * @property {Handle<'Ballot'>} handle
 */

/**
 * @typedef {Object} Ballot
 * @property {() => Instance} getBallotCounter
 * @property {(positions: Position[]) => CompletedBallot} choose
 * @property {() => BallotDetails} getDetails
 */

/**
 * @typedef {Object} PositionCount
 * @property {string} position
 * @property {number} tally
 */

/**
 * @typedef {Object} VoteStatistics
 * @property {number} spoiled
 * @property {number} votes
 * @property {PositionCount[]} results
 */

/**
 * @typedef {Object} QuorumCounter
 * @property {(VoteStatistics) => boolean} check
 */

/**
 * @callback BuildBallot
 * @param {BallotSpec} ballotSpec
 * @param {Instance} instance - ballotCounter instance
 * @returns {Ballot}
 */

/**
 * @typedef {Object} BallotCounterCreatorFacet
 * @property {() => boolean} isOpen
 * @property {() => Ballot} getBallotTemplate
 * @property {() => VoterFacet} getVoterFacet
 */

/**
 * @typedef {Object} BallotCounterPublicFacet
 * @property {() => boolean} isOpen
 * @property {() => Ballot} getBallotTemplate
 * @property {() => Promise<Position>} getOutcome
 * @property {() => BallotDetails} getDetails
 * @property {() => Promise<VoteStatistics>} getStats
 */

/**
 * @typedef {Object} BallotCounterCloseFacet
 *   TEST ONLY: Should not be allowed to escape from contracts
 * @property {() => void} closeVoting
 */

/**
 * @typedef {Object} CompleteEqualWeightBallot
 * @property {Question} question
 * @property {Handle<'Ballot'>} handle
 * @property {string[]} chosen - a list of equal-weight preferred positions
 */

/**
 * @typedef {Object} CompleteWeightedBallot
 * @property {Question} question
 * @property {Handle<'Ballot'>} handle
 * @property {Record<string,bigint>[]} weighted - list of positions with weights.
 *   BallotCounter may limit weights to a range or require uniqueness.
 */

/**
 * @typedef {Object} BallotCounterFacets
 * @property {BallotCounterPublicFacet} publicFacet
 * @property {BallotCounterCreatorFacet} creatorFacet
 * @property {BallotCounterCloseFacet} closeFacet
 */

/**
 * @callback BuildBallotCounter
 * @param {BallotSpec} ballotSpec
 * @param {bigint} threshold - ballotSpec includes quorumRule; the registrar
 *    converts that to a number that the counter can enforce.
 * @param {Instance} instance
 * @returns {BallotCounterFacets}
 */

/**
 * @typedef {Object} CompleteOrderedBallot
 * @property {Question} question
 * @property {Handle<'Ballot'>} handle
 * @property {string[]} ordered - ordered list of position from most preferred to
 *   least preferred
 */

/**
 * @typedef { CompleteEqualWeightBallot | CompleteOrderedBallot | CompleteWeightedBallot } CompletedBallot
 */

/**
 * @callback SubmitVote
 * @param {Handle<'Voter'>} seat
 * @param {ERef<CompletedBallot>} filledBallot
 * @param {bigint=} weight
 */

/**
 * @typedef {Object} VoterFacet
 * @property {SubmitVote} submitVote
 */

/**
 * @typedef {Object} ClosingRule
 * @property {Timer} timer
 * @property {Timestamp} deadline
 */

/**
 * @callback CloseVoting
 * @param {ClosingRule} closingRule
 * @param {() => void} closeVoting
 */

/**
 * @typedef {Object} AddQuestionReturn
 * @property {BallotCounterPublicFacet} publicFacet
 * @property {BallotCounterCreatorFacet} creatorFacet
 * @property {Instance} instance
 */

/**
 * @callback AddQuestion
 * @param {Installation} voteCounter
 * @param {BallotSpec} ballotSpec
 * @returns {Promise<AddQuestionReturn>}
 */

/**
 * @typedef QuestionCreator
 * @property {AddQuestion} addQuestion
 */

/**
 * @callback CreateQuestion
 *
 * @param {string} name - The name of the parameter to change
 * @param {ParamValue} proposedValue - the proposed value for the named
 *   parameter
 * @param {Installation} ballotCounterInstallation - the ballotCounter to
 *   instantiate to count votes. Expected to be a binaryBallotCounter. Other
 *   ballotCounters might be added here, or might require separate governors.
 *   under management so users can trace it back and see that it would use
 *   this electionManager to manage parameters
 * @param {Instance} contractInstance - include the instance of the contract
 * @param {ClosingRule} closingRule - deadline and timer for closing voting
 * @returns {Promise<BallotDetails>}
 */

/**
 * @typedef {Object} Governor
 * @property {CreateQuestion} createQuestion
 */

/**
 * @callback GovernContract
 *
 * @param {Instance} governedInstance
 * @param {ParamManagerFull} mgr - a ParamManager
 * @param {string} name
 * @returns {Governor}
 */

/**
 * @typedef {Object} GovernorPublic
 * @property {GovernContract} governContract
 * @property {() => Instance} getRegistrar
 * @property {(i: Instance) => boolean} governsContract
 */

/**
 * @typedef {Object} ParamSpecification
 * @property {string} parameterName
 */

/**
 * @typedef {Object} ParamChangeVoteResult
 * @property {Instance} instance - instance of the BallotCounter
 * @property {Details} details
 * @property {Promise<ParamValue>} outcomeOfUpdate
 */

/**
 * @typedef {Object} GovernedContract
 * @property {VoteOnParamChange} voteOnParamChange
 * @property {() => any} getCreatorFacet - creator facet of the governed
 *   contract, without the tightly held abiilty to change param values.
 * @property {() => any} getPublicFacet - public facet of the governed contract
 * @property {() => ERef<Instance>} getInstance - instance of the governed contract
 */

/**
 * @callback StartGovernedContract
 * @param {RegistrarCreator} registrarCreatorFacet
 * @param {Installation} governedContractInstallation
 * @param {IssuerKeywordRecord} issuerKeywordRecord
 * @param {Terms} customTerms
 * @returns {GovernedContract}
 */

/**
 * @callback VoteOnParamChange
 * @param {ParamSpecification} paramSpec
 * @param {ParamValue} proposedValue
 * @param {Installation} ballotCounterInstallation
 * @param {bigint} deadline
 * @returns {ParamChangeVoteResult}
 */

/**
 * @typedef {Object} ParamManagerAccessor
 * @property {(paramSpec: ParamSpecification) => ParamManagerFull} get
 */

/**
 * @typedef {Object} ParamGovernor
 * @property {VoteOnParamChange} voteOnParamChange
 */

/**
 * @typedef {Object} RegistrarPublic
 * @property {() => Notifier<BallotDetails>} getQuestionNotifier
 * @property {() => ERef<Handle<'Ballot'>[]>} getOpenQuestions,
 * @property {() => string} getName
 * @property {() => Instance} getInstance
 * @property {(h: Handle<'Ballot'>) => ERef<Ballot>} getBallot
 */

/**
 * @typedef {Object} PoserFacet
 * @property {AddQuestion} addQuestion
 */

/**
 * @typedef {Object} RegistrarCreator
 *  addQuestion() can be used directly when the creator doesn't need any
 *  reassurance. When someone needs to connect addQuestion to the Registrar
 *  instance, getPoserInvitation() lets them get addQuestion with assurance.
 * @property {() => Invitation} getPoserInvitation
 * @property {AddQuestion} addQuestion
 * @property {() => Invitation[]} getVoterInvitations
 * @property {() => Notifier<BallotDetails>} getQuestionNotifier
 * @property {() => RegistrarPublic} getPublicFacet
 */

/**
 * @callback SetupGovernance
 * @param {ERef<ParamManagerAccessor>} accessor
 * @param {PoserFacet} poserFacet
 * @param {ERef<Instance>} contractInstance
 * @param {Timer} timer
 * @returns {ParamGovernor}
 */
