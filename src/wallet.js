import { createWalletClient, custom, getAddress, BaseError, ContractFunctionRevertedError } from 'viem';
import { base } from 'viem/chains';
import { CONFIG } from './config.js';
import { client, STATES } from './chain.js';

const BASE_HEX = '0x2105';
const SAVED = 'pen-gov:wallet';

/* ---------- Discovery (EIP-6963, with window.ethereum as fallback) ---------- */

const found = new Map();
export function discoverWallets(onChange) {
  window.addEventListener('eip6963:announceProvider', (e) => {
    const { info, provider } = e.detail || {};
    if (!info || !provider || typeof provider.request !== 'function') return;
    found.set(info.rdns || info.uuid, { info, provider });
    onChange?.();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export function listWallets() {
  const list = [...found.values()];
  if (!list.length && window.ethereum?.request) list.push({ info: { name: 'Browser wallet', rdns: 'injected' }, provider: window.ethereum });
  return list;
}

/* ---------- Connection ---------- */

export const wallet = { provider: null, info: null, account: null, chainId: null };
let listeners = null;

function detach() {
  if (listeners && wallet.provider?.removeListener) {
    wallet.provider.removeListener('accountsChanged', listeners.accounts);
    wallet.provider.removeListener('chainChanged', listeners.chain);
  }
  listeners = null;
}

function attach(entry, onChange) {
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

export async function connect(entry, onChange) {
  const accs = await entry.provider.request({ method: 'eth_requestAccounts' });
  attach(entry, onChange);
  wallet.account = getAddress(accs[0]);
  wallet.chainId = Number(await entry.provider.request({ method: 'eth_chainId' }));
  try { localStorage.setItem(SAVED, entry.info.rdns); } catch { /* not remembered */ }
}

// Reconnects without a wallet prompt if this site was connected before.
export async function reconnect(onChange) {
  let rdns = null;
  try { rdns = localStorage.getItem(SAVED); } catch { return; }
  if (!rdns) return;
  const entry = listWallets().find((w) => w.info.rdns === rdns);
  if (!entry) return;
  const accs = await entry.provider.request({ method: 'eth_accounts' }).catch(() => []);
  if (!accs?.[0]) return;
  attach(entry, onChange);
  wallet.account = getAddress(accs[0]);
  wallet.chainId = Number(await entry.provider.request({ method: 'eth_chainId' }));
}

// Wallets can't be disconnected from the page side; this forgets the connection here.
export function forget() {
  detach();
  Object.assign(wallet, { provider: null, info: null, account: null, chainId: null });
  try { localStorage.removeItem(SAVED); } catch { /* nothing stored */ }
}

export const onBase = () => wallet.chainId === CONFIG.chainId;

export async function switchToBase() {
  try {
    await wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_HEX }] });
  } catch (err) {
    const code = err?.code ?? err?.data?.originalError?.code;
    if (code !== 4902) throw err;
    await wallet.provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: BASE_HEX, chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: [CONFIG.explorer],
      }],
    });
  }
  wallet.chainId = Number(await wallet.provider.request({ method: 'eth_chainId' }));
}

/* ---------- Transactions: simulate first, then ask the wallet to sign ---------- */

export async function send(call, { onSimulated, onSigned } = {}) {
  if (!wallet.account) throw new Error('Connect a wallet first.');
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

export function explainError(err, fmtPen, fn) {
  const rejected = err?.code === 4001 || (err instanceof BaseError && err.walk((e) => e?.code === 4001 || e?.name === 'UserRejectedRequestError'));
  if (rejected) return 'You cancelled the request in your wallet.';
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    const name = revert?.data?.errorName;
    const a = revert?.data?.args || [];
    const msg = {
      GovernorInsufficientProposerVotes: () => `Creating a proposal needs ${fmtPen(a[2])} of voting power, counted one second before you propose. You had ${fmtPen(a[1])}. Delegate to yourself, wait a few seconds, then try again.`,
      GovernorUnexpectedProposalState: () => (fn === 'propose'
        ? 'A proposal with exactly these actions and description already exists. Change the description to propose again.'
        : `Not possible while the proposal is ${STATES[a[1]]?.toLowerCase() ?? 'in this state'}.`),
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
    }[name];
    if (msg) return msg();
    if (name) return `The contract refused the transaction (${name}).`;
    if (revert) return 'The contract refused the transaction.';
    return err.shortMessage || err.message;
  }
  return err?.message || String(err);
}
