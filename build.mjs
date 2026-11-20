// Builds dist/index.html: one self-contained file with the app, viem and a checkpoint of known proposals.
// 1. Syncs checkpoint.json with ProposalCreated events up to the latest block, so the page only scans newer blocks.
// 2. Bundles src/app.js with esbuild and inlines it into index.html.
// Usage: node build.mjs            (sync + build)
//        node build.mjs --no-sync  (build from the existing checkpoint, offline)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { CONFIG } from './src/config.js';
import { client, getProposalLogs } from './src/chain.js';

const CHECKPOINT = new URL('./checkpoint.json', import.meta.url);
const OUT_DIR = new URL('./dist/', import.meta.url);

async function syncCheckpoint() {
  const cp = existsSync(CHECKPOINT)
    ? JSON.parse(await readFile(CHECKPOINT, 'utf8'))
    : { governor: CONFIG.governor, scannedTo: (CONFIG.governorDeployBlock - 1n).toString(), proposals: [] };
  if (process.argv.includes('--no-sync')) return cp;
  try {
    return await scanInto(cp);
  } catch (e) {
    console.warn(`Checkpoint sync failed, building from the existing checkpoint: ${e.shortMessage || e.message}`);
    return cp;
  }
}

async function scanInto(cp) {
  const latest = (await client.getBlockNumber()) - 10n; // stay a few blocks behind the head
  const from = BigInt(cp.scannedTo) + 1n;
  const ranges = [];
  for (let f = from; f <= latest; f += CONFIG.logRange) {
    const t = f + CONFIG.logRange - 1n;
    ranges.push([f, t > latest ? latest : t]);
  }
  const byId = new Map(cp.proposals.map((p) => [p.id, p]));
  for (let i = 0; i < ranges.length; i += 6) {
    const batch = await Promise.all(ranges.slice(i, i + 6).map(([f, t]) => getProposalLogs(f, t)));
    batch.flat().forEach((p) => byId.set(p.id, p));
    process.stdout.write(`\rScanning blocks ${from} → ${latest}: ${Math.min(i + 6, ranges.length)}/${ranges.length} ranges`);
  }
  if (ranges.length) process.stdout.write('\n');
  const next = {
    governor: CONFIG.governor,
    scannedTo: (ranges.length ? latest : BigInt(cp.scannedTo)).toString(),
    proposals: [...byId.values()].sort((a, b) => Number(BigInt(a.block) - BigInt(b.block))),
  };
  await writeFile(CHECKPOINT, JSON.stringify(next, null, 2) + '\n');
  console.log(`Checkpoint: ${next.proposals.length} proposal(s), scanned to block ${next.scannedTo}`);
  return next;
}

const checkpoint = await syncCheckpoint();

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./src/app.js', import.meta.url))],
  bundle: true, minify: true, format: 'iife', target: 'es2020', platform: 'browser',
  write: false, legalComments: 'none', logLevel: 'warning',
});
const js = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

// Allows https RPC and wallet connections and inline code only; blocks external scripts, plugins, <base> and form posts.
const csp = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:", "connect-src 'self' https: wss:", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

const template = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const html = template
  .replace('%CSP%', () => csp)
  .replace('%CHECKPOINT%', () => JSON.stringify(checkpoint).replace(/</g, '\\u003c'))
  .replace('%APP%', () => js);

// Netlify reads _headers. frame-ancestors can only be set as a header: it stops other sites
// from framing the page and tricking people into clicking its transaction buttons.
const headers = `/*
  Content-Security-Policy: frame-ancestors 'none'
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
`;

await mkdir(OUT_DIR, { recursive: true });
await writeFile(new URL('./index.html', OUT_DIR), html);
await writeFile(new URL('./_headers', OUT_DIR), headers);
console.log(`Built dist/index.html (${(html.length / 1024).toFixed(0)} KB)`);
