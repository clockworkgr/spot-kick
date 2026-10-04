// The gno.land side of the web game: reading the Spot Kick realm over the
// node's RPC, and sending moves through the Adena browser wallet.
//
// Reads use ABCI queries (vm/qeval), which need no wallet. Writes go through
// window.adena.DoContract, which only broadcasts (it returns a hash, not a
// result), so every write then polls the node's /tx endpoint until the
// transaction is in a block and returns the realm function's return value.

// The public deployment (tools/deploy.sh). For a local gnodev
// (tools/devchain.sh) use the lobby's network settings or the URL:
// ?rpc=http://127.0.0.1:26657&chainId=dev&realm=gno.land/r/clockwork/shots&web=http://127.0.0.1:8888&name=Local%20gnodev
const DEFAULTS = {
  rpc: 'https://rpc.onyx.testnets.gno.land',
  chainId: 'onyx-1',
  realm: 'gno.land/r/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/shots',
  name: 'Gno.land Onyx testnet',
  web: 'https://onyx.testnets.gno.land', // gnoweb, for links to the realm's pages
};
const STORE_KEY = 'spotkick.network';

export const DENOM = 'ugnot';
// Gas limits. A kick runs the whole physics engine on chain: typically
// 30-70M gas, ~0.36B at worst (a ball scrambling near the keeper, out of
// pouncing range, for most of the 2.5 s cap), so kicks ask for 0.7B. The
// chain charges the limit times its gas price in full, used or not, so it is
// not padded further.
export const GAS = { wanted: 60_000_000, kick: 700_000_000 };

// Network settings: URL parameters, then saved settings, then the defaults.
export function loadNetwork() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch {}
  const p = new URLSearchParams(globalThis.location?.search ?? '');
  const from = (k) => p.get(k) || saved[k] || DEFAULTS[k];
  return {
    rpc: from('rpc').replace(/\/$/, ''), chainId: from('chainId'), realm: from('realm'), name: from('name'),
    web: from('web').replace(/\/$/, ''),
  };
}
export function saveNetwork(net) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(net));
  } catch {}
}

export const net = loadNetwork();

// ------------------------------------------------------------------ reading

async function rpc(method, params) {
  const url = new URL(`${net.rpc}/${method}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const js = await res.json();
  if (js.error) throw new Error(`${method}: ${js.error.message || JSON.stringify(js.error)}`);
  return js.result;
}

const hexOf = (s) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
const fromB64 = (s) => (s ? new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))) : '');

// A gno value as printed by qeval or a call's return data: `("..." string)`
// or `(12 uint64)`. Strings come back unquoted, numbers as numbers.
export function parseGnoValue(text) {
  const t = text.trim();
  const str = t.match(/^\("((?:[^"\\]|\\.)*)" string\)/s);
  if (str) return JSON.parse(`"${str[1].replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')}"`);
  const num = t.match(/^\((-?\d+) u?int\d*\)/);
  if (num) return Number(num[1]);
  const bool = t.match(/^\((true|false) bool\)/);
  if (bool) return bool[1] === 'true';
  return t;
}

// Evaluates an expression in the realm, e.g. `ListGames("open",0,50)`.
export async function qeval(expr) {
  const r = await rpc('abci_query', { path: '"vm/qeval"', data: `0x${hexOf(`${net.realm}.${expr}`)}` });
  const base = r.response.ResponseBase;
  if (base.Error) throw new Error(errorOf(base));
  return parseGnoValue(fromB64(base.Data));
}

const gs = (s) => JSON.stringify(String(s)); // a Go string literal for qeval

export async function status() {
  const r = await rpc('status');
  return { chainId: r.node_info.network, height: Number(r.sync_info.latest_block_height) };
}
export const listGames = async (statusFilter = '', offset = 0, limit = 100) =>
  JSON.parse(await qeval(`ListGames(${gs(statusFilter)},${offset},${limit})`));
export async function getGame(id) {
  const js = await qeval(`GameJSON(${id})`);
  return js ? JSON.parse(js) : null;
}
export async function getSession(id, no) {
  const js = await qeval(`SessionJSON(${id},${no})`);
  return js ? JSON.parse(js) : null;
}
export const describeEngine = async () => {
  try {
    return await qeval('LivePath()');
  } catch {
    return '';
  }
};

// ugnot balance of an address, from the bank module.
export async function balanceOf(addr) {
  const r = await rpc('abci_query', { path: `"bank/balances/${addr}"` });
  const raw = fromB64(r.response.ResponseBase.Data).replace(/"/g, '');
  const m = raw.match(/(\d+)ugnot/);
  return m ? Number(m[1]) : 0;
}

// The realm's default constants, as Config.String prints them (for "custom
// constants" badges): the browser engine only models these.
export const DEFAULT_CONFIG = 'goalWidth=6555,goalHeight=2424,keeperScale=1176,reactionMin=20,reactionMax=120,' +
  'starShare=60,readShare=240,diveMin=2600,diveMax=5200,jumpMin=-1400,jumpMax=4000,ballMinSpeed=10000,' +
  'ballMaxSpeed=34000,fuzzBase=30,fuzzPower=100,maxContact=500';
export const CONFIG_BOUNDS = {
  goalWidth: [5000, 7320, 'mm'], goalHeight: [1800, 2440, 'mm'], keeperScale: [900, 1300, '‰'],
  reactionMin: [0, 300, 'ms'], reactionMax: [0, 400, 'ms'], starShare: [0, 300, '‰'], readShare: [0, 700, '‰'],
  diveMin: [1500, 7000, 'mm/s'], diveMax: [1500, 7000, 'mm/s'], jumpMin: [-2500, 0, 'mm/s'], jumpMax: [0, 5000, 'mm/s'],
  ballMinSpeed: [5000, 40000, 'mm/s'], ballMaxSpeed: [5000, 40000, 'mm/s'], fuzzBase: [0, 150, 'mR'],
  fuzzPower: [0, 300, 'mR'], maxContact: [200, 800, 'mR'],
};
export const parseConfig = (s) => Object.fromEntries(s.split(',').filter(Boolean).map((kv) => {
  const [k, v] = kv.split('=');
  return [k.trim(), Number(v)];
}));
export const isDefaultConfig = (s) => s === DEFAULT_CONFIG;

// ------------------------------------------------------------------ wallet

const adena = () => window.adena;
export const hasWallet = () => !!adena();

function check(res, what) {
  if (!res || res.status !== 'success') {
    const err = new Error(res?.message || `${what} failed`);
    err.type = res?.type;
    throw err;
  }
  return res.data;
}

// Connects Adena, adding and switching to this network if needed. Returns
// the account address.
// Runs a wallet call; if Adena refuses it because it is locked, asks Adena to
// connect, which opens its popup and its unlock prompt, then tries once more.
// (Adena only prompts for the unlock from its popup; reads such as GetAccount
// just refuse while it is locked.)
async function unlocked(fn) {
  const res = await fn();
  if (res?.type !== 'WALLET_LOCKED') return res;
  const est = await adena().AddEstablish('Spot Kick');
  if (est.status !== 'success' && est.type !== 'ALREADY_CONNECTED') return est;
  return fn();
}

export async function connect() {
  if (!hasWallet()) throw new Error('Adena wallet not found. Install it from adena.app and reload.');
  const est = await adena().AddEstablish('Spot Kick');
  if (est.status !== 'success' && est.type !== 'ALREADY_CONNECTED') check(est, 'Connecting the wallet');
  await ensureNetwork();
  return (await account()).address;
}

// The connected account. With prompt false (the silent reconnect when the
// page loads) a locked wallet is left locked.
export async function account({ prompt = true } = {}) {
  const get = () => adena().GetAccount();
  return check(await (prompt ? unlocked(get) : get()), 'Reading the account');
}

async function ensureNetwork() {
  const cur = await unlocked(() => adena().GetNetwork()).catch(() => null);
  if (cur?.data?.chainId === net.chainId) return;
  let sw = await unlocked(() => adena().SwitchNetwork(net.chainId));
  if (sw.type === 'UNADDED_NETWORK') {
    check(await unlocked(() => adena().AddNetwork({ chainId: net.chainId, chainName: net.name, rpcUrl: net.rpc })), 'Adding the network');
    sw = await unlocked(() => adena().SwitchNetwork(net.chainId));
  }
  if (sw.status !== 'success' && sw.type !== 'REDUNDANT_CHANGE_REQUEST') check(sw, 'Switching network');
}

export function onWalletChange(cb) {
  if (!hasWallet()) return;
  adena().On('changedAccount', () => cb('account'));
  adena().On('changedNetwork', () => cb('network'));
}

// ------------------------------------------------------------- transactions

// A transaction hash as hex, from whatever a wallet hands back: hex (with or
// without 0x), base64 or base64url. null if it is none of those.
function hashToHex(h) {
  if (typeof h !== 'string' || !h) return null;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(h)) return h.replace(/^0x/, '').toLowerCase();
  try {
    const raw = atob(h.replace(/-/g, '+').replace(/_/g, '/'));
    if (raw.length === 32) return Array.from(raw, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {}
  return null;
}

// The message of a failed query or transaction result.
const errorOf = (base) => {
  const msg = base.Error?.value || cleanError(base.Log || JSON.stringify(base.Error));
  const line = String(msg).split('\n')[0];
  return line.length > 220 ? `${line.slice(0, 220)}…` : line;
};

// The panic message out of a failed call's log.
export function cleanError(log) {
  const m = String(log).match(/(?:panic|Data|Error):\s*([^\n]+)/);
  const msg = (m ? m[1] : String(log)).replace(/^"|"$/g, '').trim();
  return msg.length > 220 ? `${msg.slice(0, 220)}…` : msg;
}

// Waits for a broadcast transaction: by its hash on the node's /tx endpoint,
// and, if a `landed` check is given, by the state it changes (in case the
// wallet's hash does not match the node's). landed() resolves to the
// call's result value, or null while it has not happened.
async function waitForTx(hash, onStatus, landed = null, timeoutMs = 90000) {
  const hex = hashToHex(hash);
  if (!hex) console.warn('Spot Kick: unrecognised transaction hash from the wallet:', hash);
  const t0 = Date.now();
  for (;;) {
    if (hex) {
      try {
        const r = await rpc('tx', { hash: `0x${hex}` });
        const base = r.tx_result.ResponseBase;
        if (base.Error) throw Object.assign(new Error(errorOf(base)), { final: true });
        return { height: Number(r.height), value: parseGnoValue(fromB64(base.Data)), events: base.Events || [] };
      } catch (e) {
        if (e.final) throw e;
      }
    }
    if (landed) {
      try {
        const v = await landed();
        if (v != null) return { height: 0, value: v, events: [] };
      } catch {}
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('The transaction was not seen in a block in time.');
    onStatus?.('block');
    await new Promise((r) => setTimeout(r, 800));
  }
}

// The chain's gas price as { amount ugnot, gas } (1 ugnot per 1000 gas on
// gnodev), and the fee for a gas limit, rounded up.
let price = null;
async function gasPrice() {
  if (price) return price;
  try {
    const r = await rpc('abci_query', { path: '"auth/gasprice"' });
    const p = JSON.parse(fromB64(r.response.ResponseBase.Data));
    price = { amount: Number(String(p.price).replace(/\D+$/, '')), gas: Number(p.gas) };
  } catch {
    price = { amount: 1, gas: 1000 };
  }
  return price;
}
export async function feeFor(wanted) {
  const p = await gasPrice();
  return Math.ceil((wanted * p.amount) / p.gas);
}

// Calls a realm function from the connected account and waits for its block.
// send is in ugnot. onStatus('sign' | 'block') reports progress.
export async function call(func, args, { send = 0, onStatus, gas = GAS.wanted, landed = null } = {}) {
  await ensureNetwork();
  const { address } = await account();
  onStatus?.('sign');
  const gasFee = await feeFor(gas);
  const res = await unlocked(() => adena().DoContract({
    messages: [{
      type: '/vm.m_call',
      value: {
        caller: address,
        send: send ? `${send}${DENOM}` : '',
        max_deposit: '',
        pkg_path: net.realm,
        func,
        args: args.map(String),
      },
    }],
    gasFee,
    gasWanted: gas,
    memo: '',
  }));
  if (res.status !== 'success') {
    const hashed = res.data?.hash;
    if (!hashed) {
      const err = new Error(res.type === 'TRANSACTION_REJECTED' ? 'You rejected the transaction.'
        : cleanError(res.data?.error?.message || res.message || 'The wallet refused the transaction.'));
      err.type = res.type;
      throw err;
    }
  }
  console.info('Spot Kick: wallet response for', func, res);
  const data = res.data || {};
  if (data.error && typeof data.error === 'object' && Object.keys(data.error).length) {
    throw new Error(cleanError(data.Log || JSON.stringify(data.error)));
  }
  const hash = data.hash || data.txHash || data.data?.hash || data.result?.hash || res.hash;
  onStatus?.('block');
  return waitForTx(hash, onStatus, landed);
}

// ------------------------------------------------------------------ moves

export const createGame = (entryFee, timeoutBlocks, config, deposit, onStatus) =>
  call('CreateGame', [entryFee, timeoutBlocks, config], { send: deposit, onStatus });
export const joinGame = (id, fee, onStatus) => call('JoinGame', [id], { send: fee, onStatus });
export const topUp = (id, amount, onStatus) => call('TopUp', [id], { send: amount, onStatus });
export const cancelGame = (id, onStatus) => call('CancelGame', [id], { onStatus });
export const forfeit = (id, onStatus) => call('Forfeit', [id], { onStatus });

// A kick lands when the session has one more kick than before: its JSON,
// as the realm's own return value would have been.
const kickLanded = (id, no, before) => async () => {
  const s = await getSession(id, no);
  return s && s.kicks.length > before ? JSON.stringify(s.kicks[s.kicks.length - 1]) : null;
};

// The kick as the realm returns it (see kickJSON in the realm's views.gno).
// at = { no, kicks }: the session and its number of kicks before this move.
export async function takeShot(id, s, onStatus, at) {
  const r = await call('TakeShot', [id, s.aimX, s.aimY, s.contactX, s.contactY, s.power],
    { onStatus, gas: GAS.kick, landed: at && kickLanded(id, at.no, at.kicks) });
  return { ...JSON.parse(r.value), txHeight: r.height };
}
export async function submitKeeperPlan(id, raw, onStatus, at) {
  const r = await call('SubmitKeeperPlan', [id, ...raw],
    { onStatus, gas: GAS.kick, landed: at && kickLanded(id, at.no, at.kicks) });
  return { ...JSON.parse(r.value), txHeight: r.height };
}

// ------------------------------------------------------------------ format

export const gnot = (ugnot) => {
  const g = ugnot / 1e6;
  return `${g.toLocaleString(undefined, { maximumFractionDigits: g < 10 ? 3 : 2 })} GNOT`;
};
export const short = (addr) => (addr ? `${addr.slice(0, 7)}…${addr.slice(-4)}` : '');
// gnoweb page of the realm (path like "game/3/1").
export const webLink = (path = '') => `${net.web}/${net.realm.replace(/^gno\.land\//, '')}${path ? `:${path}` : ''}`;
export const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
