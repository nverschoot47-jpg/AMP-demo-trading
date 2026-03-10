/**
 * TradingView → AMP Futures (Tradovate API) Bridge
 * Deploy on Railway — receives Pine Script alerts, places bracketed orders
 *
 * Alert format expected from Pine (already in your script):
 *   symbol=MNQ1!,side=BUY,entry=21045.5,sl=21040.25,tp=21062.75,rr=1.7,bias=+22.4,qty=1
 */

const express  = require('express');
const axios    = require('axios');
const app      = express();
app.use(express.text({ type: '*/*' }));   // TradingView sends plain text
app.use(express.json());

// ─── Config (set these as Railway env vars) ────────────────────────────────
const PORT        = process.env.PORT || 3000;
const TV_SECRET   = process.env.TV_SECRET    || '';        // optional webhook secret
const TV_USERNAME = process.env.TV_USERNAME;               // Tradovate / AMP username
const TV_PASSWORD = process.env.TV_PASSWORD;               // Tradovate / AMP password
const TV_APP_ID   = process.env.TV_APP_ID   || 'Sample App';
const TV_APP_VER  = process.env.TV_APP_VER  || '1.0';
const TV_CID      = process.env.TV_CID      || '';         // Client ID from Tradovate API key page
const TV_SEC      = process.env.TV_SEC      || '';         // Client secret
const DEMO        = process.env.DEMO !== 'false';          // 'false' → live; anything else → demo
const DEFAULT_QTY = parseInt(process.env.DEFAULT_QTY || '1', 10);

const BASE = DEMO
  ? 'https://demo.tradovateapi.com/v1'
  : 'https://live.tradovateapi.com/v1';

// ─── Token cache ──────────────────────────────────────────────────────────
let cachedToken    = null;
let tokenExpiresAt = 0;
let cachedAccountId   = null;
let cachedAccountSpec = null;

// ─── Futures symbol map (TV ticker → Tradovate contract root) ─────────────
// Tradovate resolves front-month automatically via /contract/find?name=MNQ
const SYMBOL_MAP = {
  'MNQ1!': 'MNQ',
  'MES1!': 'MES',
  'MYM1!': 'MYM',
  'M2K1!': 'M2K',
  'MGC1!': 'MGC',
  'MCL1!': 'MCL',
  'MBT1!': 'MBT',
  'M6E1!': 'M6E',
  'SIL1!': 'SIL',
  'HG1!':  'HG',
  // add more as needed
};

// ─── Helpers ──────────────────────────────────────────────────────────────
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function parseAlert(raw) {
  // Handles both plain-text "key=val,..." and JSON {"key":"val",...}
  if (typeof raw === 'object') return raw;
  const out = {};
  raw.trim().split(',').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx !== -1) {
      out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  });
  return out;
}

// ─── Auth ─────────────────────────────────────────────────────────────────
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  log('Authenticating with Tradovate API…');
  const body = {
    name:       TV_USERNAME,
    password:   TV_PASSWORD,
    appId:      TV_APP_ID,
    appVersion: TV_APP_VER,
    deviceId:   'railway-bridge-001',
  };
  if (TV_CID) body.cid = parseInt(TV_CID, 10);
  if (TV_SEC) body.sec = TV_SEC;

  const { data } = await axios.post(`${BASE}/auth/accesstokenrequest`, body);

  if (!data.accessToken) {
    throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  }

  cachedToken    = data.accessToken;
  // Tradovate tokens last 80 min; expire our cache at 75 min
  tokenExpiresAt = Date.now() + 75 * 60 * 1000;
  log('Token obtained, expires ~75 min from now');
  return cachedToken;
}

// ─── Account ──────────────────────────────────────────────────────────────
async function getAccount(token) {
  if (cachedAccountId) return { id: cachedAccountId, spec: cachedAccountSpec };

  const { data } = await axios.get(`${BASE}/account/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!data || data.length === 0) throw new Error('No accounts found');

  // Pick first active account
  const acct = data[0];
  cachedAccountId   = acct.id;
  cachedAccountSpec = acct.name;
  log(`Using account: ${cachedAccountSpec} (id=${cachedAccountId})`);
  return { id: cachedAccountId, spec: cachedAccountSpec };
}

// ─── Contract resolve ─────────────────────────────────────────────────────
async function resolveContract(token, root) {
  const { data } = await axios.get(`${BASE}/contract/find`, {
    params: { name: root },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!data || !data.id) throw new Error(`Contract not found for root: ${root}`);
  return data.name; // e.g. "MNQM5"
}

// ─── Place bracketed OSO order ────────────────────────────────────────────
async function placeOSO(token, accountSpec, accountId, contractName, side, qty, entry, sl, tp) {
  const isBuy    = side.toUpperCase() === 'BUY';
  const action   = isBuy ? 'Buy' : 'Sell';
  const oppAct   = isBuy ? 'Sell' : 'Buy';

  // Entry order: Market (we're entering on bar close, price already moved)
  const body = {
    accountSpec,
    accountId,
    action,
    symbol:      contractName,
    orderQty:    qty,
    orderType:   'Market',
    isAutomated: true,
    bracket1: {
      action:    oppAct,
      orderType: 'Limit',
      price:     tp,
    },
    bracket2: {
      action:    oppAct,
      orderType: 'Stop',
      stopPrice: sl,
    },
  };

  log(`Placing ${action} ${qty} ${contractName}  SL=${sl}  TP=${tp}`);
  const { data } = await axios.post(`${BASE}/order/placeOSO`, body, {
    headers: { Authorization: `Bearer ${token}` },
  });
  log('Order response:', JSON.stringify(data));
  return data;
}

// ─── Webhook endpoint ─────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    // Optional secret check
    if (TV_SECRET && req.query.secret !== TV_SECRET) {
      log('Rejected: bad secret');
      return res.status(403).json({ error: 'Forbidden' });
    }

    const raw    = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const alert  = parseAlert(req.body ?? raw);
    log('Alert received:', alert);

    const { symbol, side, sl, tp, qty } = alert;

    if (!symbol || !side || !sl || !tp) {
      return res.status(400).json({ error: 'Missing required fields: symbol, side, sl, tp' });
    }

    // Resolve root ticker
    const root = SYMBOL_MAP[symbol] || symbol.replace(/\d+!$/, '');
    const contracts = parseInt(qty || DEFAULT_QTY, 10);

    // Auth + account + contract
    const token        = await getToken();
    const { id, spec } = await getAccount(token);
    const contractName = await resolveContract(token, root);

    // Place the order
    const result = await placeOSO(
      token, spec, id,
      contractName,
      side,
      contracts,
      parseFloat(alert.entry || 0),
      parseFloat(sl),
      parseFloat(tp),
    );

    return res.json({ ok: true, orderId: result.orderId, oso1: result.oso1Id, oso2: result.oso2Id });

  } catch (err) {
    log('ERROR:', err.response?.data || err.message);
    return res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'TradingView → AMP Bridge',
    mode:    DEMO ? 'DEMO' : 'LIVE',
    status:  'running',
    account: cachedAccountSpec || 'not loaded yet',
  });
});

// ─── Test auth endpoint ───────────────────────────────────────────────────
app.get('/test-auth', async (req, res) => {
  try {
    const token        = await getToken();
    const { id, spec } = await getAccount(token);
    res.json({ ok: true, accountSpec: spec, accountId: id, mode: DEMO ? 'DEMO' : 'LIVE' });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

app.listen(PORT, () => log(`Bridge running on port ${PORT} — mode: ${DEMO ? 'DEMO' : 'LIVE'}`));
