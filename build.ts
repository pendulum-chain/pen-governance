// Builds dist/index.html: one self-contained file with the app, viem and a checkpoint of known proposals.
// 1. Syncs checkpoint.json with ProposalCreated events up to the latest block, so the page only scans newer blocks.
// 2. Bundles src/app.ts with esbuild and inlines it into index.html, next to the self-hosted brand fonts.
// Usage: node build.ts            (sync + build)
//        node build.ts --no-sync  (build from the existing checkpoint, offline)
// Node 22.18+ runs TypeScript directly by stripping the types; `npm run build` type-checks first.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { CONFIG } from './src/config.ts';
import { client, getProposalLogs, type Checkpoint, type StoredProposal } from './src/chain.ts';

const CHECKPOINT = new URL('./checkpoint.json', import.meta.url);
const OUT_DIR = new URL('./dist/', import.meta.url);

async function syncCheckpoint(): Promise<Checkpoint> {
  const cp: Checkpoint = existsSync(CHECKPOINT)
    ? JSON.parse(await readFile(CHECKPOINT, 'utf8'))
    : { governor: CONFIG.governor, scannedTo: (CONFIG.governorDeployBlock - 1n).toString(), proposals: [] };
  if (process.argv.includes('--no-sync')) return cp;
  try {
    return await scanInto(cp);
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    console.warn(`Checkpoint sync failed, building from the existing checkpoint: ${err.shortMessage || err.message}`);
    return cp;
  }
}

async function scanInto(cp: Checkpoint): Promise<Checkpoint> {
  const latest = (await client.getBlockNumber()) - 10n; // stay a few blocks behind the head
  const from = BigInt(cp.scannedTo) + 1n;
  const ranges: [bigint, bigint][] = [];
  for (let f = from; f <= latest; f += CONFIG.logRange) {
    const t = f + CONFIG.logRange - 1n;
    ranges.push([f, t > latest ? latest : t]);
  }
  const byId = new Map<string, StoredProposal>(cp.proposals.map((p) => [p.id, p]));
  for (let i = 0; i < ranges.length; i += 6) {
    const batch = await Promise.all(ranges.slice(i, i + 6).map(([f, t]) => getProposalLogs(f, t)));
    batch.flat().forEach((p) => byId.set(p.id, p));
    process.stdout.write(`\rScanning blocks ${from} → ${latest}: ${Math.min(i + 6, ranges.length)}/${ranges.length} ranges`);
  }
  if (ranges.length) process.stdout.write('\n');
  const next: Checkpoint = {
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
  entryPoints: [fileURLToPath(new URL('./src/app.ts', import.meta.url))],
  bundle: true, minify: true, format: 'iife', target: 'es2020', platform: 'browser',
  write: false, legalComments: 'none', logLevel: 'warning',
});
const output = bundle.outputFiles?.[0];
if (!output) throw new Error('esbuild produced no output');
const js = output.text.replace(/<\/script/gi, '<\\/script');

// Runs only the bundled app script (pinned by its hash, so injected inline code can't execute) and talks only to the
// configured RPCs. Wallet extensions are unaffected: they answer through the injected provider, not page requests.
// Styles stay inline (the vote bars set widths); images are data: URIs (favicon, EIP-6963 wallet icons).
const scriptHash = createHash('sha256').update(js, 'utf8').digest('base64');
const rpcOrigins = [...new Set(CONFIG.rpcs.map((url) => new URL(url).origin))];
const csp = [
  "default-src 'self'", `script-src 'sha256-${scriptHash}'`, "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", `connect-src ${rpcOrigins.join(' ')}`, "object-src 'none'", "base-uri 'none'", "form-action 'none'",
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

// Brand fonts (Outfit, Nunito Sans), served from this site so no font CDN sees the visitors. OFL-licensed.
const FONTS = new URL('./fonts/', OUT_DIR);
await mkdir(FONTS, { recursive: true });
for (const [pkg, files] of [['outfit', ['outfit-latin-500-normal', 'outfit-latin-600-normal']],
  ['nunito-sans', ['nunito-sans-latin-400-normal', 'nunito-sans-latin-700-normal']]] as const) {
  const dir = new URL(`./node_modules/@fontsource/${pkg}/`, import.meta.url);
  for (const f of files) await copyFile(new URL(`./files/${f}.woff2`, dir), new URL(`./${f}.woff2`, FONTS));
  await copyFile(new URL('./LICENSE', dir), new URL(`./${pkg}-LICENSE.txt`, FONTS));
}

await mkdir(OUT_DIR, { recursive: true });
await copyFile(new URL('./assets/og-image.png', import.meta.url), new URL('./og-image.png', OUT_DIR)); // link preview, see assets/og-image.html
await writeFile(new URL('./index.html', OUT_DIR), html);
await writeFile(new URL('./_headers', OUT_DIR), headers);
console.log(`Built dist/index.html (${(html.length / 1024).toFixed(0)} KB)`);
