// Serves dist/index.html on http://localhost:5173 for local testing. Wallet extensions need http(s), not file://.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT) || 5173;
createServer(async (req, res) => {
  const url = req.url ?? '/';
  if (url !== '/' && !url.startsWith('/?') && !url.startsWith('/index.html')) { res.writeHead(404).end('Not found'); return; }
  const html = await readFile(new URL('./dist/index.html', import.meta.url));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
}).listen(port, () => console.log(`PEN Governance on http://localhost:${port}`));
