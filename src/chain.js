import {
  createPublicClient, http, fallback, keccak256, toBytes, encodeAbiParameters, parseAbiParameters,
  hexToBigInt, decodeFunctionData, getAddress, formatUnits, stringToHex,
} from 'viem';
import { base } from 'viem/chains';
import { CONFIG } from './config.js';
import { governorAbi, tokenAbi, timelockAbi, multicallAbi, MULTICALL3, proposalCreatedEvent } from './abi.js';

export const client = createPublicClient({
  chain: base,
  transport: fallback(CONFIG.rpcs.map((url) => http(url, { retryCount: 1 }))),
});
const logClient = createPublicClient({ chain: base, transport: http(CONFIG.rpcs[0], { retryCount: 3, retryDelay: 600 }) });

const gov = { address: CONFIG.governor, abi: governorAbi };
const tok = { address: CONFIG.token, abi: tokenAbi };

export const STATES = ['Pending', 'Active', 'Canceled', 'Defeated', 'Succeeded', 'Queued', 'Expired', 'Executed'];

/* ---------- Proposal discovery ---------- */

// Proposals are stored as plain JSON (bigints as strings) so they fit the build checkpoint and localStorage.
export function fromLog(log) {
  const a = log.args;
  return {
    id: a.proposalId.toString(),
    proposer: getAddress(a.proposer),
    targets: a.targets.map((t) => getAddress(t)),
    values: a.values.map(String),
    calldatas: a.calldatas,
    voteStart: a.voteStart.toString(),
    voteEnd: a.voteEnd.toString(),
    description: a.description,
    block: log.blockNumber.toString(),
    tx: log.transactionHash,
  };
}

const CACHE_KEY = `pen-gov:v1:${CONFIG.governor.toLowerCase()}`;

export function loadKnown(checkpoint) {
  let cache = null;
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { cache = null; }
  const proposals = new Map();
  for (const p of [...(checkpoint?.proposals || []), ...(cache?.proposals || [])]) proposals.set(p.id, p);
  const fromCheckpoint = BigInt(checkpoint?.scannedTo ?? CONFIG.governorDeployBlock - 1n);
  const fromCache = BigInt(cache?.scannedTo ?? 0);
  return { proposals, scannedTo: fromCache > fromCheckpoint ? fromCache : fromCheckpoint };
}

export function saveKnown(known) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ scannedTo: known.scannedTo.toString(), proposals: [...known.proposals.values()] }));
  } catch { /* storage unavailable: the next visit scans again */ }
}

export async function getProposalLogs(fromBlock, toBlock, c = logClient) {
  const logs = await c.getLogs({ address: CONFIG.governor, event: proposalCreatedEvent, fromBlock, toBlock });
  return logs.map(fromLog);
}

// Scans blocks after `known.scannedTo`, newest range first, so live proposals show up before old ones.
export async function scanNewProposals(known, latest, { onProgress, onFound, concurrency = 4 } = {}) {
  const from = known.scannedTo + 1n;
  const ranges = [];
  for (let to = latest; to >= from; to -= CONFIG.logRange) {
    const f = to - CONFIG.logRange + 1n;
    ranges.push([f < from ? from : f, to]);
  }
  let next = 0, done = 0, failed = 0;
  onProgress?.(0, ranges.length);
  const worker = async () => {
    while (next < ranges.length) {
      const [f, t] = ranges[next++];
      try {
        for (const p of await getProposalLogs(f, t)) { known.proposals.set(p.id, p); onFound?.(p); }
      } catch { failed++; }
      onProgress?.(++done, ranges.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, worker));
  if (!failed) known.scannedTo = latest;
  saveKnown(known);
  return { failed, total: ranges.length };
}

/* ---------- Live reads ---------- */

const ok = (r) => (r && r.status === 'success' ? r.result : undefined);

// One multicall for governance settings and the clock, then one for everything that depends on them.
export async function readAll(proposals, account) {
  const [delay, period, threshold, clock, tlDelay, treasuryPen, treasuryEth] = (await client.multicall({
    allowFailure: true,
    contracts: [
      { ...gov, functionName: 'votingDelay' },
      { ...gov, functionName: 'votingPeriod' },
      { ...gov, functionName: 'proposalThreshold' },
      { ...gov, functionName: 'clock' },
      { address: CONFIG.timelock, abi: timelockAbi, functionName: 'getMinDelay' },
      { ...tok, functionName: 'balanceOf', args: [CONFIG.timelock] },
      { address: MULTICALL3, abi: multicallAbi, functionName: 'getEthBalance', args: [CONFIG.timelock] },
    ],
  })).map(ok);
  if (clock === undefined) throw new Error('Could not reach Base. Check your connection and reload.');
  const now = BigInt(clock);

  const calls = [{ ...gov, functionName: 'quorum', args: [now - 1n] }];
  const perProposal = 5;
  for (const p of proposals) {
    const id = BigInt(p.id);
    const start = BigInt(p.voteStart);
    const tp = start < now ? start : now - 1n; // quorum and votes can only be read for past timepoints
    calls.push(
      { ...gov, functionName: 'state', args: [id] },
      { ...gov, functionName: 'proposalVotes', args: [id] },
      { ...gov, functionName: 'proposalEta', args: [id] },
      { ...gov, functionName: 'quorum', args: [tp] },
      account ? { ...gov, functionName: 'hasVoted', args: [id, account] } : { ...gov, functionName: 'clock' },
    );
  }
  if (account) {
    calls.push(
      { ...tok, functionName: 'balanceOf', args: [account] },
      { ...tok, functionName: 'getVotes', args: [account] },
      { ...tok, functionName: 'delegates', args: [account] },
    );
    for (const p of proposals) {
      const start = BigInt(p.voteStart);
      calls.push(start < now
        ? { ...tok, functionName: 'getPastVotes', args: [account, start] }
        : { ...tok, functionName: 'getVotes', args: [account] });
    }
  }
  const res = (await client.multicall({ allowFailure: true, contracts: calls })).map(ok);

  const live = new Map();
  proposals.forEach((p, i) => {
    const o = 1 + i * perProposal;
    const votes = res[o + 1];
    live.set(p.id, {
      state: res[o],
      against: votes?.[0] ?? 0n, for: votes?.[1] ?? 0n, abstain: votes?.[2] ?? 0n,
      eta: res[o + 2] ?? 0n,
      quorum: res[o + 3],
      hasVoted: account ? res[o + 4] : undefined,
      weightFinal: BigInt(p.voteStart) < now, // false: weight shown is today's, not the snapshot's
    });
  });

  let me = null;
  if (account) {
    const o = 1 + proposals.length * perProposal;
    me = { balance: res[o] ?? 0n, votes: res[o + 1] ?? 0n, delegate: res[o + 2] };
    proposals.forEach((p, i) => { live.get(p.id).weight = res[o + 3 + i] ?? 0n; });
  }

  return {
    globals: {
      votingDelay: delay, votingPeriod: period, threshold, clock: now, timelockDelay: tlDelay,
      quorumNow: res[0], treasuryPen, treasuryEth,
    },
    live, me,
  };
}

/* ---------- Proposal helpers ---------- */

export const descriptionHash = (description) => keccak256(toBytes(description));

export function proposalId(targets, values, calldatas, description) {
  return hexToBigInt(keccak256(encodeAbiParameters(
    parseAbiParameters('address[], uint256[], bytes[], bytes32'),
    [targets, values, calldatas, descriptionHash(description)],
  )));
}

export function proposalArgs(p) {
  return [p.targets, p.values.map(BigInt), p.calldatas, descriptionHash(p.description)];
}

export function splitDescription(description) {
  const lines = description.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return { title: 'Untitled proposal', body: '' };
  return {
    title: lines[first].replace(/^#+\s*/, '').trim() || 'Untitled proposal',
    body: lines.slice(first + 1).join('\n').trim(),
  };
}

const ROLES = Object.fromEntries(
  ['PROPOSER_ROLE', 'EXECUTOR_ROLE', 'CANCELLER_ROLE', 'DEFAULT_ADMIN_ROLE'].map((r) => [
    r === 'DEFAULT_ADMIN_ROLE' ? '0x'.padEnd(66, '0') : keccak256(stringToHex(r)), r.replace('_ROLE', '').toLowerCase().replace('default_admin', 'admin'),
  ]),
);

// Turns one proposal action into display segments: strings, {addr}, {pen}, {eth}, {dur}.
// `known: false` marks a call this UI can't explain, so voters check the raw data.
export function describeAction(target, value, data) {
  const t = target.toLowerCase();
  const v = BigInt(value);
  const withEth = (parts) => (v > 0n ? [...parts, ', and sends ', { eth: v }] : parts);
  const decode = (abi) => { try { return decodeFunctionData({ abi, data }); } catch { return null; } };

  if (!data || data === '0x') {
    return { known: true, parts: ['Send ', { eth: v }, ' from the treasury to ', { addr: target }] };
  }
  if (t === CONFIG.token.toLowerCase()) {
    const d = decode(tokenAbi);
    if (d?.functionName === 'transfer') return { known: true, parts: withEth(['Send ', { pen: d.args[1] }, ' from the treasury to ', { addr: d.args[0] }]) };
    if (d?.functionName === 'approve') return { known: true, parts: withEth(['Allow ', { addr: d.args[0] }, ' to spend up to ', { pen: d.args[1] }, ' of the treasury\'s PEN']) };
    if (d?.functionName === 'delegate') return { known: true, parts: withEth(['Delegate the treasury\'s PEN votes to ', { addr: d.args[0] }]) };
  }
  if (t === CONFIG.governor.toLowerCase()) {
    const d = decode(governorAbi);
    const n = d?.functionName;
    if (n === 'setVotingDelay') return { known: true, parts: ['Set the voting delay to ', { dur: d.args[0] }] };
    if (n === 'setVotingPeriod') return { known: true, parts: ['Set the voting period to ', { dur: d.args[0] }] };
    if (n === 'setProposalThreshold') return { known: true, parts: ['Set the proposal threshold to ', { pen: d.args[0] }] };
    if (n === 'updateQuorumNumerator') return { known: true, parts: [`Set the quorum fraction numerator to ${d.args[0]}`] };
    if (n === 'updateTimelock') return { known: true, warn: true, parts: ['Move control of the governor to a new timelock at ', { addr: d.args[0] }] };
  }
  if (t === CONFIG.timelock.toLowerCase()) {
    const d = decode(timelockAbi);
    const n = d?.functionName;
    if (n === 'updateDelay') return { known: true, parts: ['Set the timelock delay to ', { dur: d.args[0] }] };
    if (n === 'grantRole' || n === 'revokeRole') {
      const role = ROLES[d.args[0]] || `${d.args[0].slice(0, 10)}…`;
      return { known: true, warn: true, parts: [n === 'grantRole' ? `Give the ${role} role on the treasury to ` : `Remove the ${role} role on the treasury from `, { addr: d.args[1] }] };
    }
  }
  return {
    known: false,
    parts: withEth(['Call ', { addr: target }, ` with function ${data.slice(0, 10)}`]),
  };
}

export const tokenUnits = (v) => formatUnits(v, CONFIG.tokenDecimals);
