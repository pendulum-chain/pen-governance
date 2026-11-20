import { formatUnits, parseUnits, isAddress, getAddress, encodeFunctionData, isHex, zeroAddress, parseEventLogs } from 'viem';
import { CONFIG, LABELS } from './config.js';
import { governorAbi, tokenAbi, proposalCreatedEvent } from './abi.js';
import {
  client, STATES, loadKnown, saveKnown, scanNewProposals, readAll, proposalArgs, proposalId,
  splitDescription, describeAction, fromLog,
} from './chain.js';
import { wallet, discoverWallets, listWallets, connect, reconnect, forget, onBase, switchToBase, send, explainError } from './wallet.js';

/* ================= Formatting ================= */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEC = (1.5).toLocaleString().charAt(1);
function amount(v, decimals = 18, maxFrac = 2) {
  if (v === undefined || v === null) return '–';
  const [i, f = ''] = formatUnits(v, decimals).split('.');
  const int = BigInt(i).toLocaleString();
  const frac = f.slice(0, maxFrac).replace(/0+$/, '');
  if (v > 0n && int === '0' && !frac) return `<0${DEC}${'0'.repeat(maxFrac - 1)}1`;
  return int + (frac ? DEC + frac : '');
}
const pen = (v) => `${amount(v)} PEN`;
const eth = (v) => `${amount(v, 18, 6)} ETH`;
const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const compact = (v) => (v === undefined ? '–' : compactFmt.format(Number(formatUnits(v, 18))));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const when = (ts) => dateFmt.format(new Date(Number(ts) * 1000));
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
function rel(ts) {
  const s = Math.round(Number(ts) - Date.now() / 1000);
  const a = Math.abs(s);
  const d = Math.floor(a / 86400), h = Math.floor((a % 86400) / 3600), m = Math.floor((a % 3600) / 60);
  const txt = d ? `${d} d${h ? ` ${h} h` : ''}` : h ? `${h} h${m ? ` ${m} min` : ''}` : `${Math.max(m, 1)} min`;
  return s >= 0 ? `in ${txt}` : `${txt} ago`;
}
function dur(sec) {
  const s = Number(sec);
  if (s >= 86400 && s % 86400 === 0) return `${s / 86400} day${s === 86400 ? '' : 's'}`;
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? '' : 's'}`;
  return `${Math.round(s / 60)} minutes`;
}
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const link = (path, text) => `<a href="${CONFIG.explorer}/${path}" target="_blank" rel="noopener noreferrer">${text}</a>`;

function addr(a) {
  const label = LABELS[a.toLowerCase()] || (same(a, wallet.account) ? 'You' : '');
  const inner = label ? `${esc(label)} <span class="mono dim">${short(a)}</span>` : `<span class="mono">${short(a)}</span>`;
  return `<a class="addr" href="${CONFIG.explorer}/address/${esc(a)}" target="_blank" rel="noopener noreferrer" title="${esc(a)}">${inner}</a>`;
}
const seg = (p) => (typeof p === 'string' ? esc(p)
  : p.addr ? addr(p.addr)
  : p.pen !== undefined ? `<b>${pen(p.pen)}</b>`
  : p.eth !== undefined ? `<b>${eth(p.eth)}</b>`
  : p.dur !== undefined ? `<b>${dur(p.dur)}</b>` : '');

function btn(act, label, { id = '', cls = '', data = {}, disabled = false } = {}) {
  const attrs = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  const busy = S.busy && S.busy.key === `${act}:${id}`;
  const text = busy ? { check: 'Checking…', wallet: 'Confirm in wallet…', chain: 'Waiting for Base…' }[S.busy.phase] : label;
  return `<button type="button" class="btn ${cls}" id="act-${act}-${esc(id)}" data-act="${act}" data-id="${esc(id)}"${attrs}${disabled || S.busy ? ' disabled' : ''}>${esc(text)}</button>`;
}

/* ================= State ================= */

let checkpoint = null;
try { checkpoint = JSON.parse(document.getElementById('checkpoint').textContent); } catch { checkpoint = null; }

const DRAFT = 'pen-gov:draft';
const emptyDraft = () => ({ title: '', body: '', actions: [{ type: 'pen', to: '', amount: '', data: '' }] });
let draft = emptyDraft();
try { draft = { ...emptyDraft(), ...JSON.parse(localStorage.getItem(DRAFT) || 'null') }; } catch { /* fresh draft */ }

const S = {
  known: loadKnown(checkpoint),
  globals: null, live: new Map(), me: null, loadError: null,
  scan: { running: false },
  open: null, composing: false, draft,
  reasons: new Map(), rawOpen: new Set(),
  delegateOpen: false, delegateTo: '',
  busy: null, toast: null, picker: false,
};

const sorted = () => [...S.known.proposals.values()].sort((a, b) => Number(BigInt(b.voteStart) - BigInt(a.voteStart)));
const saveDraft = () => { try { localStorage.setItem(DRAFT, JSON.stringify(S.draft)); } catch { /* not saved */ } };

/* ================= Rendering ================= */

const $ = (id) => document.getElementById(id);

// Re-renders a region only when its markup changed, and keeps focus and caret in place.
function setHTML(el, html) {
  if (el._html === html) return;
  const a = document.activeElement;
  const id = a && el.contains(a) ? a.id : null;
  const sel = id && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
  el.innerHTML = html;
  el._html = html;
  if (id) {
    const n = document.getElementById(id);
    if (n) { n.focus({ preventScroll: true }); if (sel) try { n.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } }
  }
}

function render() {
  renderWallet(); renderMe(); renderComposer(); renderScan(); renderProposals(); renderParams(); renderToast(); renderPicker();
}

function renderWallet() {
  let html;
  if (!wallet.account) html = btn('connect', 'Connect wallet', { cls: 'primary' });
  else {
    html = `<span class="acct" title="${esc(wallet.account)}"><span class="dot${onBase() ? '' : ' bad'}"></span><span class="mono">${short(wallet.account)}</span></span>`
      + (onBase() ? '' : btn('switch', 'Switch to Base', { cls: 'warn small' }))
      + btn('disconnect', 'Disconnect', { cls: 'ghost small' });
  }
  setHTML($('wallet'), html);
}

function renderMe() {
  const g = S.globals;
  let body;
  if (!wallet.account) {
    body = `<p>Connect a wallet to see your PEN, delegate your votes and vote.</p>
      <p class="muted small">PEN on Base only counts in votes once it's delegated, either to yourself or to someone you trust.</p>
      <div class="row">${btn('connect', 'Connect wallet', { cls: 'primary', id: 'me' })}</div>`;
  } else if (!S.me) {
    body = '<p class="muted">Reading your balance from Base…</p>';
  } else {
    const { balance, votes, delegate } = S.me;
    const none = !delegate || delegate === zeroAddress;
    const self = same(delegate, wallet.account);
    const who = none ? 'Nobody yet' : self ? 'Yourself' : addr(delegate);
    const notes = [];
    if (none && balance > 0n) {
      notes.push(`<div class="note warn"><p><strong>Your PEN doesn't count in votes yet.</strong> Delegate it to yourself to turn on your voting power. It's one transaction, and PEN you receive later counts automatically.</p>
        <div class="row">${btn('delegate-self', 'Delegate to myself', { cls: 'primary' })}${S.delegateOpen ? '' : btn('delegate-other', 'Delegate to someone else')}</div></div>`);
    } else if (balance === 0n && votes === 0n) {
      notes.push(`<div class="note info"><p>This address holds no PEN on Base. Migrate PEN from Pendulum to take part: <a href="https://portal.pendulumchain.org/pendulum/migration" target="_blank" rel="noopener noreferrer">Pendulum portal ↗</a></p></div>`);
    } else if (!none && !self) {
      notes.push(`<div class="note info"><p>Your PEN votes through ${addr(delegate)}, so you can't vote with it yourself.</p>
        <div class="row">${btn('delegate-self', 'Delegate to myself')}${S.delegateOpen ? '' : btn('delegate-other', 'Change delegate')}</div></div>`);
    }
    if (self && votes > balance) notes.push(`<p class="small muted">Your voting power includes ${pen(votes - balance)} that others delegated to you.</p>`);
    if (self && !S.delegateOpen) notes.push(`<div class="row">${btn('delegate-other', 'Delegate to someone else', { cls: 'small ghost' })}</div>`);
    if (S.delegateOpen) {
      notes.push(`<div class="inline-form">
        <label for="delegate-to">Delegate your votes to<input id="delegate-to" class="mono" data-bind="delegate-to" placeholder="0x…" autocomplete="off" spellcheck="false" value="${esc(S.delegateTo)}"></label>
        ${btn('delegate-submit', 'Delegate', { cls: 'primary' })}${btn('delegate-close', 'Cancel', { cls: 'ghost' })}</div>`);
    }
    if (g?.threshold !== undefined) {
      notes.push(votes >= g.threshold
        ? `<p class="small muted">You can create proposals (needs ${pen(g.threshold)} of voting power).</p>`
        : `<p class="small muted">Creating a proposal needs ${pen(g.threshold)} of voting power.</p>`);
    }
    body = `<dl class="stats">
        <div><dt>PEN on Base</dt><dd>${amount(balance)}</dd></div>
        <div><dt>Voting power</dt><dd>${amount(votes)}</dd></div>
        <div><dt>Votes delegated to</dt><dd class="who">${who}</dd></div>
      </dl>${notes.join('')}`;
  }
  setHTML($('me'), `<div class="sec-head"><h2 id="me-h">Your voting power</h2></div><div class="card">${body}</div>`);
}

function renderScan() {
  const s = S.scan;
  let html = '';
  if (s.running) html = `<span class="spin" aria-hidden="true"></span>Checking new blocks${s.total > 1 ? ` · ${Math.round((s.done / s.total) * 100)}%` : ''}`;
  else if (s.failed) html = `Some blocks couldn't be checked. ${btn('rescan', 'Retry', { cls: 'small' })}`;
  else if (S.known.scannedTo) html = `<span title="Searched up to block ${S.known.scannedTo.toLocaleString()}">Up to date</span>`;
  setHTML($('scan'), html);
}

function chip(state) {
  return state === undefined ? '<span class="chip">…</span>' : `<span class="chip s${state}">${STATES[state]}</span>`;
}

function timing(p, L) {
  const st = L.state;
  if (st === 0) return `Voting opens ${rel(p.voteStart)}`;
  if (st === 1) return `Voting closes ${rel(p.voteEnd)}`;
  if (st === 4) return 'Passed · ready to queue';
  if (st === 5) return L.eta > nowSec() ? `Executable ${rel(L.eta)}` : 'Ready to execute';
  if (st === 2) return 'Canceled by the proposer';
  if (st === 3 || st === 6 || st === 7) return `Voting closed ${when(p.voteEnd)}`;
  return '';
}

function voteBar(L) {
  const f = L.for ?? 0n, a = L.against ?? 0n, ab = L.abstain ?? 0n, q = L.quorum ?? 0n;
  const total = f + a + ab;
  const scale = total > q ? total : q;
  const pct = (x) => (scale ? Number((x * 10000n) / scale) / 100 : 0);
  const label = `For ${pen(f)}, Abstain ${pen(ab)}, Against ${pen(a)}. Quorum ${pen(q)} of For plus Abstain.`;
  return `<span class="bar" role="img" aria-label="${esc(label)}">`
    + `<span class="seg for" style="width:${pct(f)}%"></span><span class="seg abstain" style="width:${pct(ab)}%"></span><span class="seg against" style="width:${pct(a)}%"></span>`
    + (q ? `<span class="tick" style="left:${pct(q)}%"></span>` : '') + '</span>';
}

function card(p) {
  const L = S.live.get(p.id) || {};
  const { title, body } = splitDescription(p.description);
  const open = S.open === p.id;
  return `<article class="prop${open ? ' open' : ''}" id="p-${p.id}">
    <button type="button" class="prop-head" id="act-toggle-${p.id}" data-act="toggle" data-id="${p.id}" aria-expanded="${open}">
      <span class="prop-top">${chip(L.state)}<span class="prop-time">${esc(timing(p, L))}</span></span>
      <span class="prop-title">${esc(title)}</span>
      ${voteBar(L)}
      <span class="prop-meta">
        <span class="k for">For <b>${compact(L.for)}</b></span><span class="k against">Against <b>${compact(L.against)}</b></span><span class="k abstain">Abstain <b>${compact(L.abstain)}</b></span><span class="k q">Quorum ${compact(L.quorum)}</span>
      </span>
    </button>
    ${open ? `<div class="prop-body">${detail(p, L, body)}</div>` : ''}
  </article>`;
}

function actionItem(p, i) {
  const d = describeAction(p.targets[i], p.values[i], p.calldatas[i]);
  const key = `${p.id}:${i}`;
  return `<li><p>${d.parts.map(seg).join('')}</p>
    ${d.known ? '' : '<p class="note bad small">This page can\'t read this call. Check the target contract and the data on Basescan before you vote.</p>'}
    ${d.warn ? '<p class="note warn small">This changes who controls the treasury or the governor. Read it closely.</p>' : ''}
    <details class="raw" data-key="${key}"${S.rawOpen.has(key) ? ' open' : ''}><summary>Raw call</summary>
      <dl><dt>Target</dt><dd>${esc(p.targets[i])}</dd><dt>Value</dt><dd>${esc(p.values[i])} wei</dd><dt>Data</dt><dd>${esc(p.calldatas[i])}</dd></dl>
    </details></li>`;
}

function results(p, L) {
  const f = L.for ?? 0n, a = L.against ?? 0n, ab = L.abstain ?? 0n, q = L.quorum;
  const total = f + a + ab;
  const share = (x) => (total ? `${(Number((x * 1000n) / total) / 10).toLocaleString()}%` : '0%');
  const width = (x) => (total ? Number((x * 10000n) / total) / 100 : 0);
  const row = (name, cls, x) => `<div class="res-row"><span>${name}</span><span class="track"><span class="fill" style="width:${width(x)}%;background:var(--${cls})"></span></span><span class="num">${amount(x)}<span>${share(x)}</span></span></div>`;
  const counted = f + ab;
  let quorumLine = '';
  if (q !== undefined) {
    const met = counted >= q;
    const tail = met ? 'reached' : `${pen(q - counted)} more needed`;
    quorumLine = `<p class="small"><b>Quorum:</b> For + Abstain ${pen(counted)} of ${pen(q)} · ${tail}${L.state === 0 ? '<br><span class="muted">The final quorum is fixed when voting opens.</span>' : ''}</p>`;
  }
  let verdict = '';
  if (L.state === 1 && q !== undefined) {
    verdict = counted < q ? 'Not passing yet: quorum not reached.'
      : f > a ? 'Passing if voting ended now.' : 'Not passing: Against has at least as many votes as For.';
  } else if (L.state === 3 && q !== undefined) {
    verdict = counted < q ? 'Defeated: quorum was not reached.' : 'Defeated: Against had at least as many votes as For.';
  }
  return `<div class="res">${row('For', 'for', f)}${row('Against', 'against', a)}${row('Abstain', 'abstain', ab)}</div>${quorumLine}${verdict ? `<p class="verdict">${verdict}</p>` : ''}`;
}

function timeline(p, L) {
  const g = S.globals;
  const now = nowSec();
  const start = BigInt(p.voteStart), end = BigInt(p.voteEnd);
  const created = g?.votingDelay !== undefined ? start - g.votingDelay : null;
  const st = L.state;
  const item = (label, t, state) => `<li class="${state}"><span>${label}</span>${t ? `<span class="t">${t}</span>` : ''}</li>`;
  const items = [];
  if (created !== null) items.push(item('Proposed', when(created), 'done'));
  items.push(item('Voting opens', `${when(start)} · ${rel(start)}`, now >= start ? 'done' : st === 0 ? 'now' : ''));
  if (st === 2) { items.push(item('Canceled', '', 'done')); return `<ol class="tl">${items.join('')}</ol>`; }
  items.push(item('Voting closes', `${when(end)} · ${rel(end)}`, now > end ? 'done' : st === 1 ? 'now' : ''));
  if (st === 3) { items.push(item('Defeated', '', 'done')); return `<ol class="tl">${items.join('')}</ol>`; }
  const delay = g?.timelockDelay !== undefined ? dur(g.timelockDelay) : 'the timelock delay';
  items.push(item('Queued', st >= 5 ? 'Done' : `Anyone can queue it once it passes`, st >= 5 ? 'done' : st === 4 ? 'now' : ''));
  const etaText = L.eta ? `From ${when(L.eta)} · ${rel(L.eta)}` : `${delay} after queuing`;
  items.push(item(st === 7 ? 'Executed' : 'Executable', st === 7 ? 'Done' : etaText, st === 7 ? 'done' : st === 5 ? 'now' : ''));
  return `<ol class="tl">${items.join('')}</ol>`;
}

function yourPart(p, L) {
  const st = L.state;
  const id = p.id;
  const isProposer = same(p.proposer, wallet.account);
  if (st === 0) {
    return `<h3>Before voting opens</h3>
      <p class="small">Voting opens ${esc(when(p.voteStart))} (${esc(rel(p.voteStart))}). Your voting power is counted at that moment, so delegate before then.</p>
      ${wallet.account && L.weight !== undefined ? `<p class="small">Your voting power right now: <b>${pen(L.weight)}</b></p>` : ''}
      ${isProposer ? `<div class="row">${btn('cancel', 'Cancel proposal', { id, cls: 'small' })}</div><p class="small muted">As the proposer you can cancel until voting opens.</p>` : ''}`;
  }
  if (st === 1) {
    if (!wallet.account) return `<h3>Vote</h3><p class="small">Connect a wallet to vote.</p><div class="row">${btn('connect', 'Connect wallet', { cls: 'primary', id: `v${id}` })}</div>`;
    if (L.hasVoted) return '<h3>Vote</h3><p class="small">You have voted on this proposal. Each address votes once.</p>';
    if (!L.weight) {
      return `<h3>Vote</h3><p class="small">You had no voting power when voting opened (${esc(when(p.voteStart))}), so this address can't vote on this proposal. Delegate now to vote on future ones.</p>`;
    }
    const reason = S.reasons.get(id) || '';
    return `<h3>Vote</h3>
      <p class="small">Your vote counts with <b>${pen(L.weight)}</b>, your voting power when voting opened.</p>
      <label for="reason-${id}">Reason <span class="muted">optional, stored on-chain with your vote</span>
        <input id="reason-${id}" data-bind="reason" data-id="${id}" maxlength="500" value="${esc(reason)}" autocomplete="off"></label>
      <div class="row">${btn('vote', 'Vote For', { id: `${id}-1`, cls: 'vote-for', data: { pid: id, support: 1 } })}${btn('vote', 'Vote Against', { id: `${id}-0`, cls: 'vote-against', data: { pid: id, support: 0 } })}${btn('vote', 'Abstain', { id: `${id}-2`, cls: 'vote-abstain', data: { pid: id, support: 2 } })}</div>`;
  }
  if (st === 4) {
    return `<h3>Queue for execution</h3><p class="small">The proposal passed. Any address can queue it, which starts the timelock delay${S.globals ? ` of ${esc(dur(S.globals.timelockDelay))}` : ''}. After that, anyone can execute it.</p>
      <div class="row">${wallet.account ? btn('queue', 'Queue proposal', { id, cls: 'primary' }) : btn('connect', 'Connect wallet to queue', { cls: 'primary', id: `q${id}` })}</div>`;
  }
  if (st === 5) {
    const ready = L.eta && L.eta <= nowSec();
    return `<h3>Execute</h3><p class="small">${ready ? 'The timelock delay is over. Any address can execute the proposal now.' : `Queued. Executable from ${esc(when(L.eta))} (${esc(rel(L.eta))}).`}</p>
      <div class="row">${wallet.account ? btn('execute', 'Execute proposal', { id, cls: 'primary', disabled: !ready }) : btn('connect', 'Connect wallet to execute', { cls: 'primary', id: `e${id}` })}</div>`;
  }
  if (st === 7) return '<h3>Executed</h3><p class="small">The treasury carried out this proposal.</p>';
  if (st === 3) return '<h3>Closed</h3><p class="small">This proposal didn\'t pass. Its actions can\'t run.</p>';
  if (st === 2) return '<h3>Canceled</h3><p class="small">The proposer canceled this proposal before voting opened.</p>';
  if (st === 6) return '<h3>Expired</h3><p class="small">This proposal wasn\'t executed in time.</p>';
  return '<p class="small muted">Reading the proposal from Base…</p>';
}

function detail(p, L, body) {
  const n = p.targets.length;
  return `<div class="col">
      <div class="blk"><h3>If it passes, the treasury will</h3><ol class="actions">${p.targets.map((_, i) => actionItem(p, i)).join('')}</ol>
        ${n > 1 ? '<p class="small muted">The actions run in this order, in one transaction. If one fails, none happen.</p>' : ''}</div>
      ${body ? `<div class="blk"><h3>Description</h3><div class="desc">${esc(body)}</div></div>` : ''}
    </div>
    <div class="col">
      <div class="blk"><h3>Votes</h3>${results(p, L)}</div>
      <div class="you">${yourPart(p, L)}</div>
      <div class="blk"><h3>Timeline</h3>${timeline(p, L)}</div>
    </div>
    <p class="d-foot"><span>Proposal ID <code title="${p.id}">${p.id.slice(0, 8)}…${p.id.slice(-6)}</code></span>${btn('copy', 'Copy ID', { id: `id-${p.id}`, cls: 'small', data: { copy: p.id } })}
      <span>Proposed by ${addr(p.proposer)}</span><span>${link(`tx/${esc(p.tx)}`, 'Creation transaction ↗')}</span></p>`;
}

function renderProposals() {
  const list = sorted();
  let html;
  if (S.loadError && !S.globals) {
    html = `<div class="card"><p>${esc(S.loadError)}</p><div class="row">${btn('reload', 'Try again')}</div></div>`;
  } else if (!list.length) {
    html = S.scan.running
      ? '<div class="card empty"><p>Looking for proposals on Base…</p></div>'
      : `<div class="card empty"><p><b>No proposals yet.</b></p><p class="small">Anyone with ${S.globals ? pen(S.globals.threshold) : 'enough'} of voting power can create the first one.</p></div>`;
  } else {
    html = list.map(card).join('');
  }
  setHTML($('proposals'), html);
}

function renderParams() {
  const g = S.globals;
  const v = (x, f) => (x === undefined || !g ? '…' : f(x));
  const host = new URL(CONFIG.rpcs[0]).host;
  setHTML($('params'), `<section><h2>How voting works</h2><ul class="rules">
      <li>Creating a proposal needs <b>${v(g?.threshold, pen)}</b> of voting power.</li>
      <li>Voting opens <b>${v(g?.votingDelay, dur)}</b> after a proposal is created and stays open for <b>${v(g?.votingPeriod, dur)}</b>. Voting power is counted at the moment voting opens.</li>
      <li>A proposal passes with more For than Against votes, if For + Abstain reach the quorum, now <b>${v(g?.quorumNow, pen)}</b>.</li>
      <li>Passed proposals wait <b>${v(g?.timelockDelay, dur)}</b> in the treasury's timelock before anyone can execute them.</li>
    </ul></section>
    <section><h2>Contracts on Base</h2><table class="contracts"><tbody>
      <tr><td>PEN token</td><td>${link(`token/${CONFIG.token}`, `<span class="mono break">${CONFIG.token}</span>`)}</td></tr>
      <tr><td>Governor</td><td>${link(`address/${CONFIG.governor}`, `<span class="mono break">${CONFIG.governor}</span>`)}</td></tr>
      <tr><td>Treasury</td><td>${link(`address/${CONFIG.timelock}`, `<span class="mono break">${CONFIG.timelock}</span>`)}<br><span class="muted">Holds ${v(g?.treasuryPen, pen)} and ${v(g?.treasuryEth, eth)}</span></td></tr>
    </tbody></table></section>
    <p class="foot-note">Reads from ${esc(host)}. Every transaction is simulated against Base before your wallet asks you to sign it.</p>`);
}

function renderToast() {
  const el = $('toast');
  const t = S.toast;
  el.hidden = !t;
  if (!t) return;
  el.className = `toast ${t.kind || ''}`;
  setHTML(el, `<p>${esc(t.text)}${t.hash ? ` ${link(`tx/${esc(t.hash)}`, 'View on Basescan ↗')}` : ''}</p><button type="button" class="x" data-act="toast-close" aria-label="Dismiss">×</button>`);
}

function renderPicker() {
  const el = $('picker');
  el.hidden = !S.picker;
  if (!S.picker) return;
  const items = listWallets().map((w, i) => {
    const icon = typeof w.info.icon === 'string' && w.info.icon.startsWith('data:image/') ? `<img src="${esc(w.info.icon)}" alt="">` : '';
    return `<button type="button" class="btn" id="act-pick-${i}" data-act="pick" data-i="${i}">${icon}${esc(w.info.name || 'Wallet')}</button>`;
  }).join('');
  setHTML(el, `<div class="card" role="dialog" aria-modal="true" aria-labelledby="pick-h"><div class="sec-head"><h2 id="pick-h">Choose a wallet</h2>${btn('picker-close', 'Close', { cls: 'ghost small' })}</div><div class="wallets">${items}</div></div>`);
}

/* ---------- Composer ---------- */

function buildDraft() {
  const d = S.draft;
  const errors = [];
  const targets = [], values = [], calldatas = [];
  const title = d.title.trim();
  if (!title) errors.push('Add a title.');
  if (!d.actions.length) errors.push('Add at least one action.');
  const parseAmount = (s, n, allowZero) => {
    const t = s.trim().replace(/[\s_]/g, '');
    if (!/^\d+(\.\d{1,18})?$/.test(t)) { if (t || !allowZero) errors.push(`Action ${n}: enter an amount like 1000 or 0.5, without thousands separators.`); return t || !allowZero ? null : 0n; }
    const v = parseUnits(t, 18);
    if (v === 0n && !allowZero) { errors.push(`Action ${n}: the amount must be more than 0.`); return null; }
    return v;
  };
  d.actions.forEach((a, i) => {
    const n = i + 1;
    const to = a.to.trim();
    if (!isAddress(to, { strict: false })) { errors.push(`Action ${n}: enter a valid ${a.type === 'call' ? 'contract' : 'recipient'} address (0x and 40 hex characters).`); return; }
    const addrTo = getAddress(to);
    if (a.type === 'pen') {
      const amt = parseAmount(a.amount, n, false); if (amt === null) return;
      targets.push(CONFIG.token); values.push(0n); calldatas.push(encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [addrTo, amt] }));
    } else if (a.type === 'eth') {
      const amt = parseAmount(a.amount, n, false); if (amt === null) return;
      targets.push(addrTo); values.push(amt); calldatas.push('0x');
    } else {
      const amt = parseAmount(a.amount, n, true); if (amt === null) return;
      const data = a.data.trim() || '0x';
      if (!isHex(data) || data.length % 2) { errors.push(`Action ${n}: calldata must be hex starting with 0x.`); return; }
      targets.push(addrTo); values.push(amt); calldatas.push(data.toLowerCase());
    }
  });
  const description = d.body.trim() ? `# ${title}\n\n${d.body.trim()}` : `# ${title}`;
  const id = errors.length ? null : proposalId(targets, values, calldatas, description).toString();
  return { errors, targets, values, calldatas, description, id };
}

function composerPreview() {
  const b = buildDraft();
  const g = S.globals;
  const checks = [];
  const add = (cls, icon, text) => checks.push(`<li class="${cls}"><span class="i">${icon}</span><span>${text}</span></li>`);
  b.errors.forEach((e) => add('no', '×', esc(e)));
  if (!wallet.account) add('no', '×', 'Connect a wallet to submit.');
  else if (S.me && g) {
    if (S.me.votes >= g.threshold) add('ok', '✓', `Your voting power, ${pen(S.me.votes)}, meets the ${pen(g.threshold)} needed to propose.`);
    else add('no', '×', `You have ${pen(S.me.votes)} of voting power; proposing needs ${pen(g.threshold)}. Delegate to yourself or ask holders to delegate to you.`);
  }
  if (!b.errors.length) {
    if (S.known.proposals.has(b.id)) add('no', '×', 'A proposal with exactly these actions and description already exists. Change the description to propose again.');
    let penOut = 0n, ethOut = 0n;
    b.targets.forEach((t, i) => {
      ethOut += b.values[i];
      const d = describeAction(t, b.values[i], b.calldatas[i]);
      const p = d.parts.find((x) => x && x.pen !== undefined);
      if (same(t, CONFIG.token) && p && b.calldatas[i].startsWith('0xa9059cbb')) penOut += p.pen;
    });
    if (g && penOut > g.treasuryPen) add('warn', '!', `The treasury holds ${pen(g.treasuryPen)} today; this sends ${pen(penOut)}. It needs enough PEN when the proposal executes, or execution fails.`);
    if (g && ethOut > g.treasuryEth) add('warn', '!', `The treasury holds ${eth(g.treasuryEth)} today; this sends ${eth(ethOut)}. It needs enough ETH when the proposal executes.`);
  }
  const summary = b.errors.length ? '' : `<div class="blk"><h3>Voters will see</h3><ol class="actions">${b.targets.map((t, i) => {
    const d = describeAction(t, b.values[i], b.calldatas[i]);
    return `<li><p>${d.parts.map(seg).join('')}</p>${d.known ? '' : '<p class="small muted">Shown as an unrecognized call. Explain it in the description.</p>'}</li>`;
  }).join('')}</ol></div>`;
  const timing = g && !b.errors.length
    ? `<p class="small muted">If you submit now, voting opens about ${esc(when(nowSec() + g.votingDelay))} and closes about ${esc(when(nowSec() + g.votingDelay + g.votingPeriod))}. Proposal ID <code>${b.id.slice(0, 8)}…${b.id.slice(-6)}</code></p>`
    : '';
  const blocked = checks.some((c) => c.startsWith('<li class="no"'));
  return `<div class="preview">${summary}<ul class="checks">${checks.join('')}</ul>${timing}
    <div class="row">${btn('propose', 'Submit proposal', { cls: 'primary', disabled: blocked })}${btn('compose-close', 'Close', { cls: 'ghost' })}${btn('compose-reset', 'Clear form', { cls: 'ghost small' })}</div></div>`;
}

function renderComposer() {
  const el = $('composer');
  el.hidden = !S.composing;
  $('act-compose').hidden = S.composing;
  if (!S.composing) return;
  const d = S.draft;
  const acts = d.actions.map((a, i) => {
    const typeSel = `<select id="a-type-${i}" data-bind="a-type" data-i="${i}">
      <option value="pen"${a.type === 'pen' ? ' selected' : ''}>Send PEN from the treasury</option>
      <option value="eth"${a.type === 'eth' ? ' selected' : ''}>Send ETH from the treasury</option>
      <option value="call"${a.type === 'call' ? ' selected' : ''}>Custom contract call</option></select>`;
    const toLabel = a.type === 'call' ? 'Contract address' : 'Recipient address';
    const unit = a.type === 'pen' ? 'PEN' : 'ETH';
    const amtLabel = a.type === 'call' ? 'ETH to send with the call' : 'Amount';
    return `<li class="c-action">
      <div class="c-row"><label for="a-type-${i}">Action ${i + 1}${typeSel}</label>${d.actions.length > 1 ? btn('a-remove', 'Remove', { id: `${i}`, cls: 'ghost small', data: { i } }) : ''}</div>
      <div class="c-grid">
        <label for="a-to-${i}">${toLabel}<input id="a-to-${i}" class="mono" data-bind="a-to" data-i="${i}" placeholder="0x…" autocomplete="off" spellcheck="false" value="${esc(a.to)}"></label>
        <label for="a-amt-${i}">${amtLabel}<span class="suffix"><input id="a-amt-${i}" data-bind="a-amt" data-i="${i}" inputmode="decimal" placeholder="${a.type === 'call' ? '0' : '1000'}" autocomplete="off" value="${esc(a.amount)}"><span>${unit}</span></span></label>
      </div>
      ${a.type === 'call' ? `<label for="a-data-${i}">Calldata<textarea id="a-data-${i}" class="mono" rows="3" data-bind="a-data" data-i="${i}" placeholder="0x…" spellcheck="false">${esc(a.data)}</textarea></label>` : ''}
    </li>`;
  }).join('');
  setHTML(el, `<div class="sec-head"><h2 id="c-h">New proposal</h2></div><div class="card composer">
    <label for="c-title">Title<input id="c-title" data-bind="c-title" maxlength="160" placeholder="Fund the Base liquidity program for Q1" value="${esc(d.title)}" autocomplete="off"></label>
    <label for="c-body">Description <span class="muted">what it does, why, and who is responsible</span><textarea id="c-body" data-bind="c-body" rows="5">${esc(d.body)}</textarea></label>
    <div class="blk"><h3>Actions the treasury runs if it passes</h3><ol class="c-actions">${acts}</ol>
      <div class="row">${btn('a-add', 'Add action', { cls: 'small' })}</div></div>
    <div id="c-preview">${composerPreview()}</div></div>`);
}

function renderPreviewOnly() { const el = $('c-preview'); if (el) setHTML(el, composerPreview()); }

/* ================= Data ================= */

let refreshing = null, again = false;
async function refresh() {
  if (refreshing) { again = true; return refreshing; }
  refreshing = (async () => {
    do {
      again = false;
      const account = wallet.account;
      try {
        const r = await readAll(sorted(), account);
        if (account !== wallet.account) { again = true; continue; }
        S.globals = r.globals; S.live = r.live; S.me = r.me; S.loadError = null;
      } catch (e) {
        S.loadError = e?.shortMessage || e?.message || 'Could not read from Base.';
      }
      render();
    } while (again);
  })();
  try { await refreshing; } finally { refreshing = null; }
}

async function scan() {
  if (S.scan.running) return;
  S.scan = { running: true, done: 0, total: 0 };
  renderScan(); renderProposals();
  let failed = 0;
  try {
    const latest = await client.getBlockNumber();
    const before = S.known.proposals.size;
    const res = await scanNewProposals(S.known, latest, {
      onProgress: (done, total) => { S.scan.done = done; S.scan.total = total; renderScan(); },
      onFound: () => refresh(),
    });
    failed = res.failed;
    if (S.known.proposals.size !== before) refresh();
  } catch { failed = 1; }
  S.scan = { running: false, failed };
  render();
}

/* ================= Transactions ================= */

function toast(kind, text, hash) {
  S.toast = { kind, text, hash };
  clearTimeout(toast.t);
  if (kind === 'ok') toast.t = setTimeout(() => { S.toast = null; renderToast(); }, 9000);
  renderToast();
}

async function run(key, label, call, after) {
  if (S.busy) return;
  S.busy = { key, phase: 'check' };
  toast('info', `${label}: checking the transaction against Base…`);
  render();
  try {
    const { hash, receipt } = await send(call, {
      onSimulated: () => { S.busy.phase = 'wallet'; toast('info', `${label}: confirm in your wallet.`); render(); },
      onSigned: (h) => { S.busy.phase = 'chain'; toast('info', `${label}: sent. Waiting for Base to include it.`, h); render(); },
    });
    toast('ok', `${label}: done.`, hash);
    await after?.(receipt);
  } catch (e) {
    toast('bad', explainError(e, pen, call.functionName), e?.hash);
  } finally {
    S.busy = null;
    render();
    refresh();
  }
}

/* ================= Events ================= */

async function doConnect(entry) {
  S.picker = false;
  try {
    await connect(entry, onWalletChange);
    if (!onBase()) await switchToBase().catch(() => {});
  } catch (e) {
    toast('bad', explainError(e, pen));
  }
  S.me = null;
  render();
  refresh();
}

function onWalletChange() { S.me = null; S.delegateOpen = false; render(); refresh(); }

function setOpen(id) {
  S.open = id;
  const url = id ? `#p-${id}` : location.pathname + location.search;
  history.replaceState(null, '', url);
  renderProposals();
}

const actions = {
  connect() {
    const list = listWallets();
    if (!list.length) return toast('bad', 'No browser wallet found. Install MetaMask, Rabby or Coinbase Wallet, or open this page in your wallet app\'s browser.');
    if (list.length === 1) return doConnect(list[0]);
    S.picker = true; renderPicker();
    document.querySelector('#picker button[data-act="pick"]')?.focus();
  },
  pick(el) { doConnect(listWallets()[Number(el.dataset.i)]); },
  'picker-close'() { S.picker = false; renderPicker(); },
  disconnect() { forget(); S.me = null; S.delegateOpen = false; render(); refresh(); },
  async switch() { try { await switchToBase(); } catch (e) { toast('bad', explainError(e, pen)); } render(); },
  toggle(el) { setOpen(S.open === el.dataset.id ? null : el.dataset.id); },
  'toast-close'() { S.toast = null; renderToast(); },
  reload() { refresh(); scan(); },
  rescan() { scan(); },
  async copy(el) {
    const text = el.dataset.copy;
    try { await navigator.clipboard.writeText(text); el.textContent = 'Copied'; } catch { el.textContent = 'Copy failed'; }
    setTimeout(() => { el.textContent = 'Copy ID'; }, 1400);
  },
  'delegate-self'() {
    run('delegate-self:', 'Delegate to yourself', { address: CONFIG.token, abi: tokenAbi, functionName: 'delegate', args: [wallet.account] });
  },
  'delegate-other'() { S.delegateOpen = true; renderMe(); $('delegate-to')?.focus(); },
  'delegate-close'() { S.delegateOpen = false; renderMe(); },
  'delegate-submit'() {
    const to = S.delegateTo.trim();
    if (!isAddress(to, { strict: false })) return toast('bad', 'Enter the address to delegate to: 0x and 40 hex characters.');
    run('delegate-submit:', 'Delegate', { address: CONFIG.token, abi: tokenAbi, functionName: 'delegate', args: [getAddress(to)] },
      () => { S.delegateOpen = false; S.delegateTo = ''; });
  },
  vote(el) {
    const id = el.dataset.pid;
    const support = Number(el.dataset.support);
    const reason = (S.reasons.get(id) || '').trim();
    const call = reason
      ? { address: CONFIG.governor, abi: governorAbi, functionName: 'castVoteWithReason', args: [BigInt(id), support, reason] }
      : { address: CONFIG.governor, abi: governorAbi, functionName: 'castVote', args: [BigInt(id), support] };
    run(`vote:${el.dataset.id}`, ['Vote Against', 'Vote For', 'Abstain'][support], call, () => S.reasons.delete(id));
  },
  queue(el) { lifecycle(el.dataset.id, 'queue', 'Queue'); },
  execute(el) { lifecycle(el.dataset.id, 'execute', 'Execute'); },
  cancel(el) { lifecycle(el.dataset.id, 'cancel', 'Cancel proposal'); },
  compose() {
    S.composing = true;
    history.replaceState(null, '', '#new');
    renderComposer();
    $('c-title')?.focus();
  },
  'compose-close'() { S.composing = false; history.replaceState(null, '', location.pathname + location.search); renderComposer(); },
  'compose-reset'() { S.draft = emptyDraft(); saveDraft(); renderComposer(); },
  'a-add'() { S.draft.actions.push({ type: 'pen', to: '', amount: '', data: '' }); saveDraft(); renderComposer(); $(`a-to-${S.draft.actions.length - 1}`)?.focus(); },
  'a-remove'(el) { S.draft.actions.splice(Number(el.dataset.i), 1); saveDraft(); renderComposer(); },
  propose() {
    const b = buildDraft();
    if (b.errors.length) return renderPreviewOnly();
    run('propose:', 'Create proposal', { address: CONFIG.governor, abi: governorAbi, functionName: 'propose', args: [b.targets, b.values, b.calldatas, b.description] },
      (receipt) => {
        const [log] = parseEventLogs({ abi: [proposalCreatedEvent], logs: receipt.logs });
        if (log) { const p = fromLog(log); S.known.proposals.set(p.id, p); saveKnown(S.known); S.open = p.id; history.replaceState(null, '', `#p-${p.id}`); }
        S.draft = emptyDraft(); saveDraft(); S.composing = false;
      });
  },
};

function lifecycle(id, fn, label) {
  const p = S.known.proposals.get(id);
  if (!p) return;
  run(`${fn}:${id}`, label, { address: CONFIG.governor, abi: governorAbi, functionName: fn, args: proposalArgs(p) });
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  const b = el.dataset?.bind;
  if (!b) return;
  const i = Number(el.dataset.i);
  if (b === 'reason') { S.reasons.set(el.dataset.id, el.value); return; }
  if (b === 'delegate-to') { S.delegateTo = el.value; return; }
  if (b === 'c-title') S.draft.title = el.value;
  else if (b === 'c-body') S.draft.body = el.value;
  else if (b === 'a-to') S.draft.actions[i].to = el.value;
  else if (b === 'a-amt') S.draft.actions[i].amount = el.value;
  else if (b === 'a-data') S.draft.actions[i].data = el.value;
  else if (b === 'a-type') { S.draft.actions[i].type = el.value; saveDraft(); renderComposer(); return; }
  saveDraft();
  renderPreviewOnly();
});

document.addEventListener('toggle', (e) => {
  const key = e.target?.dataset?.key;
  if (!key) return;
  if (e.target.open) S.rawOpen.add(key); else S.rawOpen.delete(key);
}, true);

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.picker) { S.picker = false; renderPicker(); } });

function readHash() {
  const h = location.hash.slice(1);
  if (h === 'new') S.composing = true;
  else if (h.startsWith('p-')) S.open = h.slice(2);
}
window.addEventListener('hashchange', () => { readHash(); render(); document.getElementById(`p-${S.open}`)?.scrollIntoView({ block: 'start' }); });

/* ================= Start ================= */

async function start() {
  readHash();
  render();
  discoverWallets(() => { if (S.picker) renderPicker(); });
  await new Promise((r) => setTimeout(r, 250)); // let wallets announce themselves
  await reconnect(onWalletChange).catch(() => {});
  render();
  await refresh();
  if (S.open) document.getElementById(`p-${S.open}`)?.scrollIntoView({ block: 'start' });
  await scan();
  setInterval(() => { if (!document.hidden) refresh(); }, 30_000);
  setInterval(() => { if (!document.hidden) scan(); }, 120_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

start();
