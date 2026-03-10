# TradingView → AMP Futures Bridge

Receives Pine Script webhooks from TradingView and places **bracketed OSO orders**
(entry + TP + SL) on your **AMP Futures demo** account via the Tradovate REST API.

---

## What happens per alert

```
TradingView fires alert
       ↓
POST /webhook  (Railway)
       ↓
1. Auth → Tradovate token
2. Resolve front-month contract (e.g. MNQ → MNQM5)
3. POST /order/placeOSO
   ├─ Entry:  Market order
   ├─ TP:     Limit bracket (bracket1)
   └─ SL:     Stop bracket  (bracket2)
```

---

## 1 — Deploy on Railway

### A. Push to GitHub first

```bash
git init
git add .
git commit -m "AMP bridge v2"
git remote add origin https://github.com/YOU/amp-bridge.git
git push -u origin main
```

### B. Create Railway service

1. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
2. Select your repo
3. Railway auto-detects Node.js and runs `npm start`

---

## 2 — Environment Variables (Railway → Variables tab)

| Variable | Value | Notes |
|---|---|---|
| `TV_USERNAME` | your AMP/Tradovate username | Required |
| `TV_PASSWORD` | your AMP/Tradovate password | Required |
| `TV_CID`      | client ID from Tradovate API key page | Leave blank if you don't have one yet |
| `TV_SEC`      | client secret | Leave blank if no API key |
| `TV_APP_ID`   | `Sample App` | Keep as-is for demo |
| `TV_APP_VER`  | `1.0` | Keep as-is |
| `DEMO`        | `true` | **`false`** to switch to live |
| `TV_SECRET`   | any random string e.g. `abc123` | Optional webhook guard |
| `DEFAULT_QTY` | `1` | Contracts if not sent in alert |

> **Where to get CID / SEC?**  
> Tradovate → Account → API Access → create a new key.  
> For demo testing you can leave them blank — password-only auth works in demo mode.

---

## 3 — Get your Railway webhook URL

After deploy, Railway gives you a public URL like:
```
https://amp-bridge-production.up.railway.app
```

Your TradingView webhook URL is:
```
https://amp-bridge-production.up.railway.app/webhook?secret=abc123
```
(omit `?secret=...` if you didn't set `TV_SECRET`)

---

## 4 — TradingView Alert Setup

Your Pine script already fires the correct alert format:
```
symbol=MNQ1!,side=BUY,entry=21045.5,sl=21040.25,tp=21062.75,rr=1.7,bias=+22.4,qty=1
```

In TradingView → Alert → **Notifications** tab:
- ✅ **Webhook URL**: paste your Railway URL above
- ✅ **Message**: leave the default (Pine's `alert()` call sends the text)

---

## 5 — Test the connection

Open a browser or use curl:

```bash
# Health check
curl https://YOUR-RAILWAY-URL/

# Test auth + account lookup
curl https://YOUR-RAILWAY-URL/test-auth
```

Expected response from `/test-auth`:
```json
{
  "ok": true,
  "accountSpec": "F123456",
  "accountId": 987654,
  "mode": "DEMO"
}
```

---

## 6 — Manual webhook test

```bash
curl -X POST https://YOUR-RAILWAY-URL/webhook?secret=abc123 \
  -H "Content-Type: text/plain" \
  -d "symbol=MNQ1!,side=BUY,entry=21045.5,sl=21040.25,tp=21062.75,rr=1.7,bias=+22.4,qty=1"
```

Expected:
```json
{
  "ok": true,
  "orderId": 3696709628,
  "oso1": 3696709629,
  "oso2": 3696709630
}
```

Then check your AMP demo account / Tradovate platform to see the bracket.

---

## Supported Symbols

| TradingView | Tradovate root |
|---|---|
| MNQ1! | MNQ |
| MES1! | MES |
| MYM1! | MYM |
| M2K1! | M2K |
| MGC1! | MGC |
| MCL1! | MCL |
| MBT1! | MBT |
| M6E1! | M6E |
| SIL1! | SIL |
| HG1!  | HG  |

To add more, edit the `SYMBOL_MAP` in `server.js`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Auth failed` | Check username/password in Railway env vars |
| `Contract not found` | Add symbol to `SYMBOL_MAP` in server.js |
| `Access is denied` (200) | Your Tradovate account needs API add-on enabled |
| Orders not filling | Make sure you're looking at the right account in AMP demo |
| `403 Forbidden` | Your `?secret=` in the URL doesn't match `TV_SECRET` |

---

## How it differs from Tradovate (your old bridge)

The old bridge was likely targeting `live.tradovateapi.com`.  
This bridge targets `demo.tradovateapi.com` by default (`DEMO=true`).  
Flip `DEMO=false` when you're ready to go live — no code changes needed.
