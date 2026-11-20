// Everything chain-specific lives here. Change these and rebuild to point the UI elsewhere.
export const CONFIG = {
  chainId: 8453, // Base mainnet
  token: '0x0FC4A6FF1cDae34E1A481e4Da38D402dE0733955', // PEN (ERC20Votes, timestamp clock)
  governor: '0xaa94c95C0A957F0Df291caA848cB4361E6B7b06E', // PENGovernor (OpenZeppelin Governor v5)
  timelock: '0x74F00d5ff15f0d2526792E5939e3bC45D445Ce04', // Treasury (TimelockController)
  governorDeployBlock: 56958144n, // first block to search for ProposalCreated events
  // Read-only RPCs, tried in order. The first one must allow eth_getLogs over `logRange` blocks.
  rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  logRange: 50000n, // publicnode's eth_getLogs block-range limit on Base
  explorer: 'https://basescan.org',
  tokenSymbol: 'PEN',
  tokenDecimals: 18,
};

export const LABELS = {
  [CONFIG.token.toLowerCase()]: 'PEN token',
  [CONFIG.governor.toLowerCase()]: 'Governor',
  [CONFIG.timelock.toLowerCase()]: 'Treasury',
};
