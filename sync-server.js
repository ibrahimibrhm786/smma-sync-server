/**
 * SMMA Tracker — Sync Server
 * Pulls Meta Ads + GoHighLevel data and returns it to the tracker.
 *
 * SETUP:
 *   npm install express node-fetch cors
 *   node sync-server.js
 *
 * DEPLOY FREE:
 *   Railway → https://railway.app  (drag & drop this folder)
 *   Render  → https://render.com   (connect GitHub repo)
 */

const express  = require('express');
const cors     = require('cors');

// node-fetch v2 is CommonJS-compatible; v3+ is ESM only
// npm install node-fetch@2
const fetch    = require('node-fetch');

const app = express();
app.use(cors());           // allow requests from your GHL page / tracker
app.use(express.json());

// ──────────────────────────────────────────
// Health check
// ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'smma-sync-server' });
});

// ──────────────────────────────────────────
// POST /sync  — main endpoint called by the tracker
// Body: { metaToken, metaAccount, ghlToken, ghlLocation }
// ──────────────────────────────────────────
app.post('/sync', async (req, res) => {
  const { metaToken, metaAccount, ghlToken, ghlLocation } = req.body;

  if (!metaToken && !ghlToken) {
    return res.status(400).json({ error: 'No tokens provided' });
  }

  const now     = new Date();
  const year    = now.getFullYear();
  const month   = now.getMonth() + 1;
  const since   = `${year}-${String(month).padStart(2,'0')}-01`;
  const until   = now.toISOString().split('T')[0];
  const period  = now.toLocaleString('default', { month: 'long', year: 'numeric' });

  let metaData = {};
  let ghlData  = {};
  const errors = [];

  // ── 1. META ADS ──────────────────────────────────
  if (metaToken && metaAccount) {
    try {
      const fields = 'spend,impressions,clicks,reach,actions,cost_per_action_type';
      const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
      const url = `https://graph.facebook.com/v19.0/${metaAccount}/insights?fields=${fields}&time_range=${timeRange}&access_token=${metaToken}`;

      const r    = await fetch(url);
      const json = await r.json();

      if (json.error) throw new Error(json.error.message);

      const d = json.data?.[0] || {};
      const actions = d.actions || [];
      const leads   = actions.find(a => a.action_type === 'lead')?.value || 0;
      const msgs    = actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value || 0;

      metaData = {
        spend:       parseFloat(d.spend || 0),
        impressions: parseInt(d.impressions || 0),
        clicks:      parseInt(d.clicks || 0),
        leads:       parseInt(leads),
        messages:    parseInt(msgs),
      };

      console.log(`[Meta] Synced: spend=$${metaData.spend}, leads=${metaData.leads}`);
    } catch (e) {
      errors.push(`Meta: ${e.message}`);
      console.error('[Meta] Error:', e.message);
    }
  }

  // ── 2. GOHIGHLEVEL ───────────────────────────────
  if (ghlToken && ghlLocation) {
    try {
      // Get appointments for this month
      const startTs = new Date(`${since}T00:00:00.000Z`).getTime();
      const endTs   = new Date(`${until}T23:59:59.999Z`).getTime();

      const apptUrl = `https://rest.gohighlevel.com/v1/appointments/?locationId=${ghlLocation}&startDate=${startTs}&endDate=${endTs}`;
      const r = await fetch(apptUrl, {
        headers: {
          'Authorization': `Bearer ${ghlToken}`,
          'Content-Type':  'application/json'
        }
      });
      const json = await r.json();

      if (json.statusCode && json.statusCode !== 200) throw new Error(json.message || 'GHL API error');

      const appts   = json.appointments || [];
      const booked  = appts.length;
      const shown   = appts.filter(a => a.appointmentStatus === 'showed').length;
      const noshow  = appts.filter(a => a.appointmentStatus === 'noshow').length;
      const cancelled = appts.filter(a => a.appointmentStatus === 'cancelled').length;

      ghlData = { booked, shown, noshow, cancelled };
      console.log(`[GHL] Synced: booked=${booked}, shown=${shown}, noshow=${noshow}`);

    } catch (e) {
      errors.push(`GHL: ${e.message}`);
      console.error('[GHL] Error:', e.message);
    }
  }

  // ── 3. BUILD ENTRY ───────────────────────────────
  const entry = {
    period,
    client: '',           // tracker will associate by client if needed
    spend:  metaData.spend  || 0,
    imp:    metaData.impressions || 0,
    clicks: metaData.clicks || 0,
    leads:  metaData.leads  || 0,
    booked: ghlData.booked  || 0,
    shown:  ghlData.shown   || 0,
    noshow: ghlData.noshow  || 0,
    closed: 0,            // manual — you close clients in your CRM
    rev:    0,            // manual — revenue recognition is manual
    source: 'api-sync',
    ts:     Date.now(),
  };

  return res.json({
    ok:      true,
    period,
    entries: [entry],
    raw:     { meta: metaData, ghl: ghlData },
    errors:  errors.length ? errors : undefined,
  });
});

// ──────────────────────────────────────────
// GET /meta-accounts  — helper: list ad accounts for a token
// ──────────────────────────────────────────
app.get('/meta-accounts', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const r    = await fetch(`https://graph.facebook.com/v19.0/me/adaccounts?fields=name,account_id&access_token=${token}`);
    const json = await r.json();
    res.json(json);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────
// Start
// ──────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`SMMA Sync Server running on port ${PORT}`);
  console.log(`Test it: curl http://localhost:${PORT}/`);
});
