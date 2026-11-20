import {
  createPublicClient, http, fallback, keccak256, toBytes, encodeAbiParameters, parseAbiParameters,
  hexToBigInt, decodeFunctionData, getAddress, stringToHex,
  type Address, type ContractFunctionParameters, type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { CONFIG } from './config.ts';
import { governorAbi, tokenAbi, timelockAbi, multicallAbi, MULTICALL3, proposalCreatedEvent } from './abi.ts';

export const client = createPublicClient({
  chain: base,
  transport: fallback(CONFIG.rpcs.map((url) => http(url, { retryCount: 1 }))),
});
const logClient = createPublicClient({ chain: base, transport: http(CONFIG.rpcs[0], { retryCount: 3, retryDelay: 600 }) });

const gov = { address: CONFIG.governor, abi: governorAbi } as const;
const tok = { address: CONFIG.token, abi: tokenAbi } as const;

export const STATES = ['Pending', 'Active', 'Canceled', 'Defeated', 'Succeeded', 'Queued', 'Expired', 'Executed'];

/** A proposal as plain JSON (bigints as strings), so it fits the build checkpoint and localStorage. */
export interface StoredProposal {
  id: string;
  proposer: Address;
  targets: Address[];
  values: string[];
  calldatas: Hex[];
  voteStart: string;
  voteEnd: string;
  description: string;
  block: string;
  tx: Hex;
}

/** checkpoint.json: every proposal up to block `scannedTo`, inlined into the page at build time. */
export interface Checkpoint {
  governor: string;
  scannedTo: string;
  proposals: StoredProposal[];
}

export interface Known {
  proposals: Map<string, StoredProposal>;
  scannedTo: bigint;
}

export interface Globals {
  votingDelay?: bigint;
  votingPeriod?: bigint;
  threshold?: bigint;
  clock: bigint;
  timelockDelay?: bigint;
  quorumNow?: bigint;
  treasuryPen?: bigint;
  treasuryEth?: bigint;
}

export interface LiveProposal {
  state?: number;
  against: bigint;
  for: bigint;
  abstain: bigint;
  eta: bigint;
  quorum?: bigint;
  hasVoted?: boolean;
  /** False: `weight` is today's voting power, not the snapshot's. */
  weightFinal: boolean;
  weight?: bigint;
}

export interface Me {
  balance: bigint;
  votes: bigint;
  delegate?: Address;
}

/* ---------- Proposal discovery ---------- */

interface ProposalCreatedLog {
  args: {
    proposalId: bigint;
    proposer: Address;
    targets: readonly Address[];
    values: readonly bigint[];
    calldatas: readonly Hex[];
    voteStart: bigint;
    voteEnd: bigint;
    description: string;
  };
  blockNumber: bigint;
  transactionHash: Hex;
}

export function fromLog(log: ProposalCreatedLog): StoredProposal {
  const a = log.args;
  return {
    id: a.proposalId.toString(),
    proposer: getAddress(a.proposer),
    targets: a.targets.map((t) => getAddress(t)),
    values: a.values.map(String),
    calldatas: [...a.calldatas],
    voteStart: a.voteStart.toString(),
    voteEnd: a.voteEnd.toString(),
    description: a.description,
    block: log.blockNumber.toString(),
    tx: log.transactionHash,
  };
}

const CACHE_KEY = `pen-gov:v1:${CONFIG.governor.toLowerCase()}`;

export function loadKnown(checkpoint: Checkpoint | null): Known {
  let cache: Partial<Checkpoint> | null = null;
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { cache = null; }
  const proposals = new Map<string, StoredProposal>();
  for (const p of [...(checkpoint?.proposals || []), ...(cache?.proposals || [])]) proposals.set(p.id, p);
  const fromCheckpoint = BigInt(checkpoint?.scannedTo ?? CONFIG.governorDeployBlock - 1n);
  const fromCache = BigInt(cache?.scannedTo ?? 0);
  return { proposals, scannedTo: fromCache > fromCheckpoint ? fromCache : fromCheckpoint };
}

export function saveKnown(known: Known): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ scannedTo: known.scannedTo.toString(), proposals: [...known.proposals.values()] }));
  } catch { /* storage unavailable: the next visit scans again */ }
}

export async function getProposalLogs(fromBlock: bigint, toBlock: bigint, c = logClient): Promise<StoredProposal[]> {
  const logs = await c.getLogs({ address: CONFIG.governor, event: proposalCreatedEvent, fromBlock, toBlock, strict: true });
  return logs.map(fromLog);
}

interface ScanOptions {
  onProgress?: (done: number, total: number) => void;
  onFound?: (p: StoredProposal) => void;
  concurrency?: number;
}

// Scans blocks after `known.scannedTo`, newest range first, so live proposals show up before old ones.
export async function scanNewProposals(known: Known, latest: bigint, { onProgress, onFound, concurrency = 4 }: ScanOptions = {}) {
  const from = known.scannedTo + 1n;
  const ranges: [bigint, bigint][] = [];
  for (let to = latest; to >= from; to -= CONFIG.logRange) {
    const f = to - CONFIG.logRange + 1n;
    ranges.push([f < from ? from : f, to]);
  }
  let next = 0, done = 0, failed = 0;
  onProgress?.(0, ranges.length);
  const worker = async () => {
    while (next < ranges.length) {
      const [f, t] = ranges[next++]!;
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

type CallResult<T> = { status: 'success'; result: T } | { status: 'failure'; result?: undefined };
const ok = <T>(r: CallResult<T> | undefined): T | undefined => (r && r.status === 'success' ? r.result : undefined);

// One multicall for governance settings and the clock, then one for everything that depends on them.
export async function readAll(proposals: StoredProposal[], account: Address | null) {
  const [delay, period, threshold, clock, tlDelay, treasuryPen, treasuryEth] = await client.multicall({
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
  });
  const clockValue = ok(clock);
  if (clockValue === undefined) throw new Error('Could not reach Base. Check your connection and reload.');
  const now = BigInt(clockValue);

  const calls: ContractFunctionParameters[] = [{ ...gov, functionName: 'quorum', args: [now - 1n] }];
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
  // The calls are mixed, so their results come back untyped; each is cast to its function's return type below.
  const res: unknown[] = (await client.multicall({ allowFailure: true, contracts: calls })).map((r) => ok(r as CallResult<unknown>));
  const big = (i: number) => res[i] as bigint | undefined;

  const live = new Map<string, LiveProposal>();
  proposals.forEach((p, i) => {
    const o = 1 + i * perProposal;
    const votes = res[o + 1] as readonly [bigint, bigint, bigint] | undefined;
    live.set(p.id, {
      state: res[o] as number | undefined,
      against: votes?.[0] ?? 0n, for: votes?.[1] ?? 0n, abstain: votes?.[2] ?? 0n,
      eta: big(o + 2) ?? 0n,
      quorum: big(o + 3),
      hasVoted: account ? (res[o + 4] as boolean | undefined) : undefined,
      weightFinal: BigInt(p.voteStart) < now,
    });
  });

  let me: Me | null = null;
  if (account) {
    const o = 1 + proposals.length * perProposal;
    me = { balance: big(o) ?? 0n, votes: big(o + 1) ?? 0n, delegate: res[o + 2] as Address | undefined };
    proposals.forEach((p, i) => { live.get(p.id)!.weight = big(o + 3 + i) ?? 0n; });
  }

  const globals: Globals = {
    votingDelay: ok(delay), votingPeriod: ok(period), threshold: ok(threshold), clock: now, timelockDelay: ok(tlDelay),
    quorumNow: big(0), treasuryPen: ok(treasuryPen), treasuryEth: ok(treasuryEth),
  };
  return { globals, live, me };
}

/* ---------- Proposal helpers ---------- */

export const descriptionHash = (description: string): Hex => keccak256(toBytes(description));

export function proposalId(targets: readonly Address[], values: readonly bigint[], calldatas: readonly Hex[], description: string): bigint {
  return hexToBigInt(keccak256(encodeAbiParameters(
    parseAbiParameters('address[], uint256[], bytes[], bytes32'),
    [targets, values, calldatas, descriptionHash(description)],
  )));
}

export function proposalArgs(p: StoredProposal): readonly [Address[], bigint[], Hex[], Hex] {
  return [p.targets, p.values.map(BigInt), p.calldatas, descriptionHash(p.description)];
}

export function splitDescription(description: string) {
  const lines = description.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return { title: 'Untitled proposal', body: '' };
  return {
    title: lines[first]!.replace(/^#+\s*/, '').trim() || 'Untitled proposal',
    body: lines.slice(first + 1).join('\n').trim(),
  };
}

const ROLES: Record<string, string> = Object.fromEntries(
  ['PROPOSER_ROLE', 'EXECUTOR_ROLE', 'CANCELLER_ROLE', 'DEFAULT_ADMIN_ROLE'].map((r) => [
    r === 'DEFAULT_ADMIN_ROLE' ? '0x'.padEnd(66, '0') : keccak256(stringToHex(r)), r.replace('_ROLE', '').toLowerCase().replace('default_admin', 'admin'),
  ]),
);

/** A display segment: plain text, an address, a PEN or ETH amount, or a duration in seconds. */
export type Part = string | { addr: string } | { pen: bigint } | { eth: bigint } | { dur: bigint | number };

export interface ActionDescription {
  /** False: a call this UI can't explain, so voters check the raw data. */
  known: boolean;
  warn?: boolean;
  parts: Part[];
}

// Turns one proposal action into display segments.
export function describeAction(target: string, value: string | bigint, data: Hex): ActionDescription {
  const t = target.toLowerCase();
  const v = BigInt(value);
  const withEth = (parts: Part[]): Part[] => (v > 0n ? [...parts, ', and sends ', { eth: v }] : parts);

  if (!data || data === '0x') {
    return { known: true, parts: ['Send ', { eth: v }, ' from the treasury to ', { addr: target }] };
  }
  if (t === CONFIG.token.toLowerCase()) {
    const d = tryDecode(() => decodeFunctionData({ abi: tokenAbi, data }));
    if (d?.functionName === 'transfer') return { known: true, parts: withEth(['Send ', { pen: d.args[1] }, ' from the treasury to ', { addr: d.args[0] }]) };
    if (d?.functionName === 'approve') return { known: true, parts: withEth(['Allow ', { addr: d.args[0] }, ' to spend up to ', { pen: d.args[1] }, ' of the treasury\'s PEN']) };
    if (d?.functionName === 'delegate') return { known: true, parts: withEth(['Delegate the treasury\'s PEN votes to ', { addr: d.args[0] }]) };
  }
  if (t === CONFIG.governor.toLowerCase()) {
    const d = tryDecode(() => decodeFunctionData({ abi: governorAbi, data }));
    if (d?.functionName === 'setVotingDelay') return { known: true, parts: ['Set the voting delay to ', { dur: d.args[0] }] };
    if (d?.functionName === 'setVotingPeriod') return { known: true, parts: ['Set the voting period to ', { dur: d.args[0] }] };
    if (d?.functionName === 'setProposalThreshold') return { known: true, parts: ['Set the proposal threshold to ', { pen: d.args[0] }] };
    if (d?.functionName === 'updateQuorumNumerator') return { known: true, parts: [`Set the quorum fraction numerator to ${d.args[0]}`] };
    if (d?.functionName === 'updateTimelock') return { known: true, warn: true, parts: ['Move control of the governor to a new timelock at ', { addr: d.args[0] }] };
  }
  if (t === CONFIG.timelock.toLowerCase()) {
    const d = tryDecode(() => decodeFunctionData({ abi: timelockAbi, data }));
    if (d?.functionName === 'updateDelay') return { known: true, parts: ['Set the timelock delay to ', { dur: d.args[0] }] };
    if (d?.functionName === 'grantRole' || d?.functionName === 'revokeRole') {
      const role = ROLES[d.args[0]] || `${d.args[0].slice(0, 10)}…`;
      return { known: true, warn: true, parts: [d.functionName === 'grantRole' ? `Give the ${role} role on the treasury to ` : `Remove the ${role} role on the treasury from `, { addr: d.args[1] }] };
    }
  }
  return {
    known: false,
    parts: withEth(['Call ', { addr: target }, ` with function ${data.slice(0, 10)}`]),
  };
}

function tryDecode<T>(decode: () => T): T | null {
  try { return decode(); } catch { return null; }
}
