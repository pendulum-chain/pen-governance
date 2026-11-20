# PEN Governance

A one-page governance UI for PEN on Base, live at https://governance.pendulumchain.org. It replaces the Basescan "Write Contract" steps with buttons:

- **Delegate** to yourself or to another address, so your PEN counts in votes
- **Propose**: send PEN or ETH from the treasury, or any custom contract call, with a title and description
- **Vote** For, Against or Abstain, with an optional on-chain reason
- **Queue** and **execute** passed proposals; **cancel** your own proposal while it's pending

Every transaction is simulated against Base first, so a call that would fail shows a plain-language reason before the wallet asks you to sign.

## Contracts (Base mainnet)

| Contract | Address |
| --- | --- |
| PEN token | `0x0FC4A6FF1cDae34E1A481e4Da38D402dE0733955` |
| Governor | `0xaa94c95C0A957F0Df291caA848cB4361E6B7b06E` |
| Treasury (timelock) | `0x74F00d5ff15f0d2526792E5939e3bC45D445Ce04` |

Settings are read live from the contracts. They currently are: voting delay 1 day, voting period 5 days, timelock 2 days, proposal threshold 50,000 PEN, quorum 500,000 PEN (For + Abstain).

## Build and run

Needs Node 22.18 or later (24 recommended, see `.nvmrc`), which runs the TypeScript build scripts directly.

```bash
npm install
npm run build    # type-checks, syncs checkpoint.json with the chain, then writes dist/index.html
npm run serve    # http://localhost:5173
```

`npm run typecheck` only runs the type checker. `npm run build:offline` rebuilds from the existing checkpoint without network access.

## Hosting

Netlify builds and deploys `main` on every push (see `netlify.toml`); `dist/_headers` sets the security headers there.

`dist/index.html` is a single self-contained file (app, viem and proposal checkpoint inlined; no CDN or font requests), so any static host works as well, such as Cloudflare Pages, GitHub Pages or IPFS. Wallet extensions only connect on `http(s)://` pages, not `file://`.

## How proposals are found

The governor has no on-chain proposal list, so the page reads `ProposalCreated` events. Base makes about 430,000 blocks a day and the free RPC (publicnode) allows 50,000 blocks per log query.

- `npm run build` stores every proposal so far, and the block it searched up to, in `checkpoint.json`, which is inlined into the page.
- In the browser, the page only searches blocks after that checkpoint, newest first, and remembers what it found in `localStorage`.

Each day between builds adds about 9 log requests to a first visit. Rebuild and redeploy from time to time (a weekly CI job is enough) to keep first loads fast.

## Configuration

Addresses, RPC endpoints and the log range are in `src/config.ts`. Change them and rebuild.

## Limits

- Browser-extension wallets (MetaMask, Rabby, Coinbase Wallet) and mobile wallets' in-app browsers. No WalletConnect QR login.
- Shows vote totals, not a list of voters (use the governor's Events tab on Basescan for that).
- Recognized proposal actions: PEN transfer, approve and delegate from the treasury, ETH sends, governor settings, timelock delay and roles. Anything else is shown as an unrecognized call with its raw data and a warning to check it on Basescan.

## Files

- `index.html`: page shell and styles
- `src/app.ts`: rendering and interactions
- `src/chain.ts`: reads, proposal discovery, action decoding
- `src/wallet.ts`: wallet discovery (EIP-6963), network switching, simulate-then-send, error messages
- `src/abi.ts`, `src/config.ts`: contract interfaces and addresses
- `build.ts`, `serve.ts`: build and local server
