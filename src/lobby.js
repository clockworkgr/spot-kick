// The lobby: wallet connection, the realm's games, and creating, joining,
// topping up, cancelling and forfeiting them. Playing a joined game is
// main.js's job; it is handed the game and session through onPlay.
import * as C from './chain.js?v=20';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const wallet = { address: '', balance: 0 };

const view = {
  tab: 'open',
  games: [],
  sessions: new Map(), // game id -> its latest session (for playing games and yours)
  height: 0,
  online: false,
  busy: false,
};
let hooks = { onPlay: () => {}, onPractice: () => {} };
let refreshTimer = null;

// ------------------------------------------------------------------ toast

let toastTimer = null;
export function toast(msg, kind = 'info', ms = 5000) {
  const el = $('toast');
  el.className = `show ${kind}`;
  el.innerHTML = msg;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.className = ''), ms);
}

// Progress of a transaction, for chain.call's onStatus.
export const txStatus = (what) => (s) => {
  if (s === 'sign') toast(`<span class="spin"></span>${what}: confirm in your wallet…`, 'info', 0);
  else if (s === 'block') toast(`<span class="spin"></span>${what}: waiting for the block…`, 'info', 0);
};

// ------------------------------------------------------------------ wallet

async function connectWallet() {
  try {
    wallet.address = await C.connect();
    await refreshBalance();
    toast(`Connected ${C.short(wallet.address)}`, 'good', 2500);
  } catch (e) {
    toast(esc(e.message), 'bad', 7000);
  }
  renderWallet();
  render();
}

export async function refreshBalance() {
  if (!wallet.address) return;
  try {
    wallet.balance = await C.balanceOf(wallet.address);
  } catch {}
  renderWallet();
}

function renderWallet() {
  const b = $('wallet-btn');
  if (wallet.address) {
    b.className = 'wallet on';
    b.innerHTML = `<span class="dot"></span><span class="addr">${C.short(wallet.address)} ·</span><b>${C.gnot(wallet.balance)}</b>`;
    b.title = `${wallet.address} (click to refresh)`;
  } else {
    b.className = 'wallet primary';
    b.textContent = C.hasWallet() ? 'Connect wallet' : 'Get Adena wallet';
    b.title = 'Connect the Adena wallet';
  }
}

// ------------------------------------------------------------------ data

async function refresh() {
  try {
    const st = await C.status();
    view.height = st.height;
    view.online = st.chainId === C.net.chainId;
    $('net-pill').className = view.online ? 'net on' : 'net bad';
    $('net-name').textContent = view.online ? `${C.net.name} · ${st.chainId}` : `wrong chain: ${st.chainId}`;
    $('net-height').textContent = st.height.toLocaleString();
    view.games = await C.listGames('', 0, 100);
    // The live session of every game in play, and the latest of games you
    // created, to know whose turn it is and who may be forfeited.
    const want = view.games.filter((g) => g.sessions > 0 && (g.status === 'playing' || g.creator === wallet.address));
    await Promise.all(want.map(async (g) => {
      const s = await C.getSession(g.id, g.sessions).catch(() => null);
      if (s) view.sessions.set(g.id, s);
    }));
  } catch (e) {
    view.online = false;
    $('net-pill').className = 'net bad';
    $('net-name').textContent = `${C.net.name} unreachable`;
    $('net-height').textContent = '–';
  }
  render();
}

const mySession = (g) => {
  const s = view.sessions.get(g.id);
  return s && s.player === wallet.address && s.status === 'playing' && g.status === 'playing' ? s : null;
};
const idleBlocks = (g) => {
  const s = view.sessions.get(g.id);
  return s ? view.height - s.lastActionHeight : 0;
};
const canForfeit = (g) => g.status === 'playing' && wallet.address &&
  (mySession(g) || idleBlocks(g) > g.timeoutBlocks);

// ------------------------------------------------------------------ render

function card(g) {
  const s = view.sessions.get(g.id);
  const mine = g.creator === wallet.address;
  const custom = !C.isDefaultConfig(g.config);
  const you = mySession(g);
  const actions = [];
  if (you) actions.push(`<button class="primary" data-act="resume" data-id="${g.id}">Continue your shootout</button>`);
  else if (g.status === 'open') actions.push(`<button class="primary" data-act="join" data-id="${g.id}">Play · ${C.gnot(g.entryFee)}</button>`);
  if (g.status === 'open' || g.status === 'playing') actions.push(`<button data-act="topup" data-id="${g.id}">Top up</button>`);
  if (mine && g.status === 'open' && g.sessions === 0) actions.push(`<button data-act="cancel" data-id="${g.id}">Cancel &amp; refund</button>`);
  if (canForfeit(g)) actions.push(`<button data-act="forfeit" data-id="${g.id}">${you ? 'Resign' : 'Claim timeout'}</button>`);
  actions.push(`<button data-act="details" data-id="${g.id}">Details</button>`);

  let live = '';
  if (g.status === 'playing' && s) {
    const sc = s.score;
    live = `<div class="live">${you ? 'You are' : `${C.short(s.player)} is`} playing · ${sc.playerGoals}–${sc.chainGoals} after ${sc.playerKicks + sc.chainKicks} kicks · idle ${idleBlocks(g)}/${g.timeoutBlocks} blocks</div>`;
  } else if (g.status === 'won') {
    live = `<div class="live">Won by ${g.winner === wallet.address ? 'you' : C.short(g.winner)} at block ${g.closedHeight}</div>`;
  }
  return `<article class="game ${g.status}${you ? ' yours' : ''}">
    <header><b>#${g.id}</b><span class="status ${g.status}">${g.status}</span>${custom ? '<span class="badge" title="Played with non-default constants; the 3-D replay uses the default ones">custom constants</span>' : ''}${mine ? '<span class="badge mine">yours</span>' : ''}</header>
    <div class="pot"><small>${g.status === 'won' ? 'Prize' : 'Pot'}</small>${g.status === 'won' && !g.pot ? 'paid out' : C.gnot(g.pot)}</div>
    <div class="meta">Entry <b>${C.gnot(g.entryFee)}</b> · ${g.sessions} challenger${g.sessions === 1 ? '' : 's'} · timeout ${g.timeoutBlocks} blocks · by ${C.short(g.creator)}</div>
    ${live}
    <div class="actions">${actions.join('')}</div>
  </article>`;
}

function render() {
  document.querySelectorAll('#lobby [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === view.tab));
  const yours = view.games.filter((g) => mySession(g));
  $('resume').innerHTML = yours.map((g) =>
    `<button class="resume" data-act="resume" data-id="${g.id}"><b>Your shootout in game #${g.id} is waiting</b><span>Pot ${C.gnot(g.pot)} · continue ▸</span></button>`).join('');
  const pick = {
    open: (g) => g.status === 'open',
    playing: (g) => g.status === 'playing',
    closed: (g) => g.status === 'won' || g.status === 'cancelled',
    mine: (g) => g.creator === wallet.address || g.winner === wallet.address || mySession(g),
  }[view.tab];
  const list = view.games.filter(pick);
  let empty = '';
  if (!view.online) empty = `Can't reach <code>${esc(C.net.rpc)}</code>. Start a local chain with <code>tools/devchain.sh</code> or change the network (⚙).`;
  else if (!list.length) {
    empty = view.tab === 'open' ? 'No open games. Create one and seed its pot.'
      : view.tab === 'mine' ? (wallet.address ? 'Nothing of yours yet.' : 'Connect your wallet to see your games.')
        : 'Nothing here yet.';
  }
  $('games').innerHTML = empty ? `<p class="empty">${empty}</p>` : list.map(card).join('');
  $('create-btn').disabled = !view.online;
}

// ------------------------------------------------------------------ actions

function needWallet() {
  if (wallet.address) return true;
  connectWallet();
  return false;
}

async function act(name, id) {
  const g = view.games.find((x) => x.id === id);
  if (!g) return;
  if (name === 'details') return showDetails(g);
  if (!needWallet() || view.busy) return;
  view.busy = true;
  try {
    if (name === 'resume') {
      const s = mySession(g) || await C.getSession(g.id, g.sessions);
      return hooks.onPlay(g, s);
    }
    if (name === 'join') {
      if (wallet.balance && wallet.balance < g.entryFee + await C.feeFor(C.GAS.wanted)) throw new Error('Not enough GNOT for the entry fee and gas.');
      const r = await C.joinGame(g.id, g.entryFee, txStatus(`Joining game #${g.id}`));
      toast(`Joined game #${g.id}. Good luck!`, 'good', 2500);
      // As of the join's block: a node behind the others would still show
      // the game without this session (and its previous challenger's).
      const at = r.height ? { height: r.height } : undefined;
      const fresh = await C.getGame(g.id, at);
      const s = await C.getSession(g.id, fresh.sessions, at);
      await refreshBalance();
      return hooks.onPlay(fresh, s);
    }
    if (name === 'topup') {
      const v = prompt(`Add how many GNOT to game #${g.id}'s pot?`, '1');
      const amount = Math.round(Number(v) * 1e6);
      if (!v || !(amount > 0)) return;
      await C.topUp(g.id, amount, txStatus(`Topping up game #${g.id}`));
      toast(`Added ${C.gnot(amount)} to game #${g.id}.`, 'good');
    }
    if (name === 'cancel') {
      if (!confirm(`Cancel game #${g.id} and refund its ${C.gnot(g.pot)} pot to you?`)) return;
      await C.cancelGame(g.id, txStatus(`Cancelling game #${g.id}`));
      toast(`Game #${g.id} cancelled; ${C.gnot(g.pot)} refunded.`, 'good');
    }
    if (name === 'forfeit') {
      const you = mySession(g);
      const q = you ? `Resign your shootout in game #${g.id}? Your entry fee stays in the pot.`
        : `The challenger in game #${g.id} has been idle past the timeout. End their shootout as a loss?`;
      if (!confirm(q)) return;
      await C.forfeit(g.id, txStatus(you ? 'Resigning' : 'Claiming the timeout'));
      toast(you ? 'You resigned.' : `Game #${g.id} is open again.`, 'good');
    }
    await refreshBalance();
  } catch (e) {
    toast(esc(e.message), 'bad', 8000);
  } finally {
    view.busy = false;
    refresh();
  }
}

// ------------------------------------------------------------------ dialogs

async function showDetails(g) {
  const d = $('game-dialog');
  const st = C.settingsOf(g.config);
  const fmt = (s, v) => (s.unit === 'm' ? `${v.toFixed(2)} m` : `${v}%`);
  const rows = st.rows.map((s) =>
    `<tr class="${s.changed ? 'diff' : ''}"><td>${s.name}</td><td>${fmt(s, s.value)}</td><td>${s.changed ? `standard ${fmt(s, s.standard)}` : ''}</td></tr>`).join('') +
    (st.other.length ? `<tr class="diff"><td>Other</td><td colspan="2">${esc(st.other.join(', '))}</td></tr>` : '');
  d.querySelector('.body').innerHTML = `
    <h2>Game #${g.id} <span class="status ${g.status}">${g.status}</span></h2>
    <p>${g.status === 'won' ? (g.pot ? `Prize <b>${C.gnot(g.pot)}</b>` : 'Prize paid out') : `Pot <b>${C.gnot(g.pot)}</b>`} · entry ${C.gnot(g.entryFee)} · timeout ${g.timeoutBlocks} blocks · created at block ${g.createdHeight} by <code>${g.creator}</code></p>
    <p><a href="${C.webLink(`game/${g.id}`)}" target="_blank" rel="noopener">Open on gnoweb ↗</a></p>
    <h3>Challengers</h3><div id="sessions-list">${g.sessions ? '<p class="muted">Loading…</p>' : '<p class="muted">Nobody has played yet.</p>'}</div>
    <p class="muted">Win the shootout by two goals or more to take the pot: ${100 - C.CREATOR_PERCENT}% to the winner, ${C.CREATOR_PERCENT}% to the game's creator.</p>
    <h3>Settings</h3><table class="cfg">${rows}</table>`;
  d.showModal();
  if (!g.sessions) return;
  const nos = Array.from({ length: Math.min(g.sessions, 20) }, (_, i) => g.sessions - i);
  const list = await Promise.all(nos.map((no) => C.getSession(g.id, no).catch(() => null)));
  const el = d.querySelector('#sessions-list');
  if (!el) return;
  el.innerHTML = `<table class="sessions"><tr><th>#</th><th>Player</th><th>Status</th><th>Score</th><th>Kicks</th></tr>${list.filter(Boolean).map((s) => {
    // An ended shootout keeps only its score (impl/v2); its kicks stay in
    // the transactions that played them.
    const dots = !s.kicks.length && s.status !== 'playing'
      ? `<span class="muted" title="Settled: only the score is kept on chain; each kick is in the transaction that played it">settled</span>`
      : s.kicks.map((k) => `<i class="${k.kicker} ${k.result.outcome === 'woodwork' ? 'post' : k.result.outcome}" title="round ${k.round}, ${k.kicker === 'player' ? 'shot' : 'kept'}: ${k.result.outcome}"></i>`).join('');
    return `<tr><td><a href="${C.webLink(`game/${g.id}/${s.no}`)}" target="_blank" rel="noopener">${s.no}</a></td><td>${s.player === wallet.address ? 'you' : C.short(s.player)}</td><td>${s.status}</td><td>${s.score.playerGoals}–${s.score.chainGoals}</td><td class="kdots">${dots}</td></tr>`;
  }).join('')}</table>`;
}

function openCreate() {
  if (!needWallet()) return;
  const d = $('create-dialog');
  const box = d.querySelector('#cfg-fields');
  if (!box.childElementCount) {
    box.innerHTML = C.SETTINGS.map((s) =>
      `<label>${s.name}<input type="number" name="set-${s.key}" min="${s.min}" max="${s.max}" step="${s.unit === 'm' ? 'any' : s.step}" value="${s.standard}"><small>${s.min}–${s.max} ${s.unit}, ${s.help}</small></label>`).join('');
  }
  d.showModal();
}

async function submitCreate(e) {
  e.preventDefault();
  const f = e.target;
  const pot = Math.round(Number(f.pot.value) * 1e6);
  const fee = Math.round(Number(f.fee.value) * 1e6);
  const timeout = Math.round(Number(f.timeout.value));
  const values = {};
  const err = f.querySelector('.err');
  err.textContent = '';
  for (const s of C.SETTINGS) {
    const v = Number(f[`set-${s.key}`].value);
    if (!(v >= s.min - 1e-9 && v <= s.max + 1e-9)) return (err.textContent = `${s.name} must be ${s.min}–${s.max} ${s.unit}.`);
    values[s.key] = s.unit === 'm' ? v : Math.round(v);
  }
  if (!(pot >= 1e6)) return (err.textContent = 'The pot must be at least 1 GNOT.');
  if (!(fee >= 1e5)) return (err.textContent = 'The entry fee must be at least 0.1 GNOT.');
  if (!(timeout >= 30 && timeout <= 200000)) return (err.textContent = 'Timeout must be 30 … 200000 blocks.');
  // A pot only grows if challengers pay in a fair share of it; below ~15% the
  // creator usually loses the seed before the 20% comes back (see README).
  if (fee < 0.15 * pot && !confirm(`An entry fee under 15% of the pot (here ${C.gnot(Math.ceil(0.15 * pot))}) usually costs the creator money: the pot is won before it has grown enough for the ${C.CREATOR_PERCENT}% share to pay back the seed. Create it anyway?`)) return;
  $('create-dialog').close();
  try {
    const r = await C.createGame(fee, timeout, C.configFromSettings(values), pot, txStatus('Creating the game'));
    toast(`Game #${r.value} created with a ${C.gnot(pot)} pot.`, 'good');
    view.tab = 'open';
    await refreshBalance();
  } catch (e2) {
    toast(esc(e2.message), 'bad', 8000);
  }
  refresh();
}

function openSettings() {
  const d = $('settings-dialog');
  const f = d.querySelector('form');
  for (const k of ['name', 'rpc', 'chainId', 'realm', 'web']) f[k].value = C.net[k];
  d.showModal();
}

// ------------------------------------------------------------------ setup

export function initLobby(h) {
  hooks = { ...hooks, ...h };
  $('wallet-btn').addEventListener('click', () => {
    if (!C.hasWallet()) return void window.open('https://adena.app', '_blank', 'noopener');
    if (wallet.address) refreshBalance();
    else connectWallet();
  });
  $('create-btn').addEventListener('click', openCreate);
  $('practice-btn').addEventListener('click', () => hooks.onPractice());
  $('net-settings').addEventListener('click', openSettings);
  $('create-form').addEventListener('submit', submitCreate);
  $('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    C.saveNetwork(Object.fromEntries(['name', 'rpc', 'chainId', 'realm', 'web'].map((k) => [k, f[k].value.trim()])));
    location.reload();
  });
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('#lobby [data-tab]').forEach((b) => b.addEventListener('click', () => {
    view.tab = b.dataset.tab;
    render();
  }));
  $('lobby').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) act(b.dataset.act, Number(b.dataset.id));
  });
  C.onWalletChange(async () => {
    wallet.address = '';
    try {
      wallet.address = (await C.account({ prompt: false })).address;
    } catch {}
    await refreshBalance();
    renderWallet();
    refresh();
  });
  renderWallet();
  // Reconnect silently if this site was approved before.
  if (C.hasWallet()) {
    C.account({ prompt: false }).then((a) => {
      wallet.address = a.address;
      refreshBalance();
      refresh();
    }).catch(() => {});
  }
}

export function showLobby() {
  $('lobby').hidden = false;
  document.body.classList.add('in-lobby');
  refresh();
  refreshBalance();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, 4000);
}

export function hideLobby() {
  document.activeElement?.blur?.(); // keys belong to the game now
  $('lobby').hidden = true;
  document.body.classList.remove('in-lobby');
  clearInterval(refreshTimer);
}
