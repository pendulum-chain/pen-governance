import { parseAbi, parseAbiItem } from 'viem';

// Custom errors from OpenZeppelin v5 Governor, TimelockController, ERC20Votes and Address,
// so failed simulations come back with a name instead of raw revert data.
const ERRORS = [
  'error GovernorInsufficientProposerVotes(address proposer, uint256 votes, uint256 threshold)',
  'error GovernorUnexpectedProposalState(uint256 proposalId, uint8 current, bytes32 expectedStates)',
  'error GovernorNonexistentProposal(uint256 proposalId)',
  'error GovernorAlreadyCastVote(address voter)',
  'error GovernorAlreadyQueuedProposal(uint256 proposalId)',
  'error GovernorNotQueuedProposal(uint256 proposalId)',
  'error GovernorOnlyProposer(address account)',
  'error GovernorUnableToCancel(uint256 proposalId, address account)',
  'error GovernorRestrictedProposer(address proposer)',
  'error GovernorInvalidProposalLength(uint256 targets, uint256 calldatas, uint256 values)',
  'error GovernorInvalidVoteType()',
  'error GovernorDisabledDeposit()',
  'error GovernorOnlyExecutor(address account)',
  'error TimelockUnexpectedOperationState(bytes32 operationId, bytes32 expectedStates)',
  'error TimelockUnexecutedPredecessor(bytes32 predecessorId)',
  'error TimelockInsufficientDelay(uint256 delay, uint256 minDelay)',
  'error TimelockUnauthorizedCaller(address caller)',
  'error FailedInnerCall()',
  'error FailedCall()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC5805FutureLookup(uint256 timepoint, uint48 clock)',
  'error VotesExpiredSignature(uint256 expiry)',
] as const;

export const governorAbi = parseAbi([
  'function votingDelay() view returns (uint256)',
  'function votingPeriod() view returns (uint256)',
  'function proposalThreshold() view returns (uint256)',
  'function quorum(uint256 timepoint) view returns (uint256)',
  'function clock() view returns (uint48)',
  'function state(uint256 proposalId) view returns (uint8)',
  'function proposalVotes(uint256 proposalId) view returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)',
  'function proposalEta(uint256 proposalId) view returns (uint256)',
  'function hasVoted(uint256 proposalId, address account) view returns (bool)',
  'function hashProposal(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) pure returns (uint256)',
  'function propose(address[] targets, uint256[] values, bytes[] calldatas, string description) returns (uint256)',
  'function castVote(uint256 proposalId, uint8 support) returns (uint256)',
  'function castVoteWithReason(uint256 proposalId, uint8 support, string reason) returns (uint256)',
  'function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) returns (uint256)',
  'function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) payable returns (uint256)',
  'function cancel(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) returns (uint256)',
  // Settings calls a proposal can make on the governor itself (decoded for display only).
  'function setVotingDelay(uint48 newVotingDelay)',
  'function setVotingPeriod(uint32 newVotingPeriod)',
  'function setProposalThreshold(uint256 newProposalThreshold)',
  'function updateQuorumNumerator(uint256 newQuorumNumerator)',
  'function updateTimelock(address newTimelock)',
  ...ERRORS,
]);

export const tokenAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function getVotes(address account) view returns (uint256)',
  'function getPastVotes(address account, uint256 timepoint) view returns (uint256)',
  'function delegates(address account) view returns (address)',
  'function delegate(address delegatee)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
  ...ERRORS,
]);

export const timelockAbi = parseAbi([
  'function getMinDelay() view returns (uint256)',
  'function updateDelay(uint256 newDelay)',
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  ...ERRORS,
]);

export const multicallAbi = parseAbi(['function getEthBalance(address addr) view returns (uint256 balance)']);
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export const proposalCreatedEvent = parseAbiItem(
  'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)'
);
