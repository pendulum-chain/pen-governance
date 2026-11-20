import {
  createWalletClient, custom, getAddress, BaseError, ContractFunctionRevertedError,
  type Abi, type Address, type EIP1193Provider, type Hash, type TransactionReceipt,
} from 'viem';
import { base } from 'viem/chains';
import { CONFIG } from './config.ts';
import { client, STATES } from './chain.ts';

const BASE_HEX = '0x2105';
const SAVED = 'pen-gov:wallet';

/** EIP-6963 provider info. */
export interface WalletInfo {
  uuid?: string;
  name?: string;
  icon?: string;
  rdns: string;
}

export interface WalletEntry {
  info: WalletInfo;
  provider: EIP1193Provider;
}

declare global {
  interface Window { ethereum?: EIP1193Provider }
  interface WindowEventMap { 'eip6963:announceProvider': CustomEvent<Partial<WalletEntry> | undefined> }
}

/* ---------- Discovery (EIP-6963, with window.ethereum as fallback) ---------- */

const found = new Map<string, WalletEntry>();
export function discoverWallets(onChange?: () => void): void {
  window.addEventListener('eip6963:announceProvider', (e) => {
    const { info, provider } = e.detail || {};
    if (!info || !provider || typeof provider.request !== 'function') return;
    found.set(info.rdns || info.uuid || '', { info, provider });
    onChange?.();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export function listWallets(): WalletEntry[] {
  const list = [...found.values()];
  if (!list.length && window.ethereum?.request) list.push({ info: { name: 'Browser wallet', rdns: 'injected' }, provider: window.ethereum });
  return list;
}

/* ---------- Connection ---------- */

export const wallet: { provider: EIP1193Provider | null; info: WalletInfo | null; account: Address | null; chainId: number | null } = {
  provider: null, info: null, account: null, chainId: null,
};
let listeners: { accounts: (accs: Address[]) => void; chain: (id: string) => void } | null = null;

function detach() {
  if (listeners && wallet.provider?.removeListener) {
    wallet.provider.removeListener('accountsChanged', listeners.accounts);
    wallet.provider.removeListener('chainChanged', listeners.chain);
  }
  listeners = null;
}

function attach(entry: WalletEntry, onChange: () => void) {
  detach();
  wallet.provider = entry.provider;
  wallet.info = entry.info;
  listeners = {
    accounts: (accs) => { wallet.account = accs?.[0] ? getAddress(accs[0]) : null; if (!wallet.account) forget(); onChange(); },
    chain: (id) => { wallet.chainId = Number(id); onChange(); },
  };
  entry.provider.on?.('accountsChanged', listeners.accounts);
  entry.provider.on?.('chainChanged', listeners.chain);
}

export async function connect(entry: WalletEntry, onChange: () => void): Promise<void> {
  const accs = await entry.provider.request({ method: 'eth_requestAccounts' });
  attach(entry, onChange);
  wallet.account = getAddress(accs[0]!);
  wallet.chainId = Number(await entry.provider.request({ method: 'eth_chainId' }));
  try { localStorage.setItem(SAVED, entry.info.rdns); } catch { /* not remembered */ }
}

// Reconnects without a wallet prompt if this site was connected before.
export async function reconnect(onChange: () => void): Promise<void> {
  let rdns: string | null = null;
  try { rdns = localStorage.getItem(SAVED); } catch { return; }
  if (!rdns) return;
  const entry = listWallets().find((w) => w.info.rdns === rdns);
  if (!entry) return;
  const accs = await entry.provider.request({ method: 'eth_accounts' }).catch((): Address[] => []);
  if (!accs?.[0]) return;
  attach(entry, onChange);
  wallet.account = getAddress(accs[0]);
  wallet.chainId = Number(await entry.provider.request({ method: 'eth_chainId' }));
}

// Wallets can't be disconnected from the page side; this forgets the connection here.
export function forget(): void {
  detach();
  Object.assign(wallet, { provider: null, info: null, account: null, chainId: null });
  try { localStorage.removeItem(SAVED); } catch { /* nothing stored */ }
}

export const onBase = (): boolean => wallet.chainId === CONFIG.chainId;

const errorCode = (err: unknown): unknown => {
  const e = err as { code?: unknown; data?: { originalError?: { code?: unknown } } } | null;
  return e?.code ?? e?.data?.originalError?.code;
};

export async function switchToBase(): Promise<void> {
  const provider = wallet.provider;
  if (!provider) throw new Error('Connect a wallet first.');
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_HEX }] });
  } catch (err) {
    if (errorCode(err) !== 4902) throw err;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: BASE_HEX, chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: [CONFIG.explorer],
      }],
    });
  }
  wallet.chainId = Number(await provider.request({ method: 'eth_chainId' }));
}

/* ---------- Transactions: simulate first, then ask the wallet to sign ---------- */

/** A contract write: one function of `abi` on `address`. */
export interface SendCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

interface SendHooks {
  onSimulated?: () => void;
  onSigned?: (hash: Hash) => void;
}

export async function send(call: SendCall, { onSimulated, onSigned }: SendHooks = {}): Promise<{ hash: Hash; receipt: TransactionReceipt }> {
  if (!wallet.account || !wallet.provider) throw new Error('Connect a wallet first.');
  if (!onBase()) await switchToBase();
  const { request } = await client.simulateContract({ ...call, account: wallet.account });
  onSimulated?.();
  const wc = createWalletClient({ account: wallet.account, chain: base, transport: custom(wallet.provider) });
  const hash = await wc.writeContract(request);
  onSigned?.(hash);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') throw Object.assign(new Error('The transaction was included but reverted.'), { hash });
  return { hash, receipt };
}

/* ---------- Errors people can act on ---------- */

export function explainError(err: unknown, fmtPen: (v: bigint) => string, fn?: string): string {
  const isRejection = (e: unknown) => errorCode(e) === 4001 || (e as { name?: unknown } | null)?.name === 'UserRejectedRequestError';
  if (isRejection(err) || (err instanceof BaseError && err.walk(isRejection))) return 'You cancelled the request in your wallet.';
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName;
    const a = revert?.data?.args || [];
    const messages: Record<string, () => string> = {
      GovernorInsufficientProposerVotes: () => `Creating a proposal needs ${fmtPen(a[2] as bigint)} of voting power, counted one second before you propose. You had ${fmtPen(a[1] as bigint)}. Delegate to yourself, wait a few seconds, then try again.`,
      GovernorUnexpectedProposalState: () => (fn === 'propose'
        ? 'A proposal with exactly these actions and description already exists. Change the description to propose again.'
        : `Not possible while the proposal is ${STATES[Number(a[1])]?.toLowerCase() ?? 'in this state'}.`),
      GovernorNonexistentProposal: () => 'The governor has no proposal with these exact actions and description.',
      GovernorAlreadyCastVote: () => 'This address has already voted on this proposal.',
      GovernorOnlyProposer: () => 'Only the proposer can cancel a proposal.',
      GovernorUnableToCancel: () => 'Only the proposer can cancel, and only before voting opens.',
      GovernorRestrictedProposer: () => 'The description reserves this proposal for another proposer address.',
      GovernorInvalidProposalLength: () => 'A proposal needs at least one action.',
      TimelockUnexpectedOperationState: () => 'The timelock delay hasn\'t passed yet. Try again after the time shown.',
      ERC20InsufficientBalance: () => 'The treasury doesn\'t hold enough PEN for this transfer.',
      FailedInnerCall: () => 'One of the proposal\'s actions failed when the treasury ran it.',
      FailedCall: () => 'One of the proposal\'s actions failed when the treasury ran it.',
    };
    const msg = name ? messages[name] : undefined;
    if (msg) return msg();
    if (name) return `The contract refused the transaction (${name}).`;
    if (revert) return 'The contract refused the transaction.';
    return err.shortMessage || err.message;
  }
  return (err as { message?: string } | null)?.message || String(err);
}
