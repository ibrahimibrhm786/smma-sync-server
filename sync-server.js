/**
 * SMMA Tracker — Sync Server v3
 * Fixed GHL API v2 endpoint: GET /calendars/events
 * Calendar IDs: 090ze4f7QMT41hIqOLMf, aWRLojJqN8SeshiBnqTF
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const CALENDAR_IDS = ['090ze4f7QMT41hIqOLMf', 'aWRLojJqN8SeshiBnqTF'];

function getRanges() {
  const now   = new Date();
  const y     = now.getFullYear();
  const m     = now.getMonth();
  const d     = now.getDate();
  const day   = now.getDay();

  const dayStart   = new Date(y, m, d, 0, 0, 0);
  const dayEnd     = new Date(y, m, d, 23, 59, 59);
  const diffToMon  = day === 0 ? 6 : day - 1;
  const weekStart  = new Date(y, m, d - diffToMon, 0, 0, 0);
  const monthStart = new Date(y, m, 1, 0, 0, 0);

  const iso = dt => dt.toISOString();
  const ymd = dt => dt.toISOString().split('T')[0];

  return {
    daily:   { since: ymd(dayStart),   until: ymd(dayEnd),   startIso: iso(dayStart),   endIso: iso(dayEnd),   label: 'Today' },
    weekly:  { since: ymd(weekStart),  until: ymd(dayEnd),   startIso: iso(weekStart),  endIso: iso(dayEnd),   label: 'This week' },
    monthly: { since: ymd(monthStart), until: ymd(dayEnd),   startIso: iso(monthStart), endIso: iso(dayEnd),   label: 'This month' },
  };
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'smma-sync-server-v3', calendars: CALENDAR_IDS });
});

app.post('/sync', async (req, res) => {
  const { metaToken, metaAccount, ghlToken, ghlLocation } = req.body;
  if (!metaToken && !ghlToken) return res.status(400).json({ error: 'No tokens provided' });

  const ranges  = getRanges();
  const results = {};
  const errors  = [];

  for (const [period, range] of Object.entries(ranges)) {
    let metaData = {};
    let ghlData  = { booked: 0, appointments: [] };

    // ── META ──
    if (metaToken && metaAccount) {
      try {
        const tr     = encodeURIComponent(JSON.stringify({ since: range.since, until: range.until }));
        const fields = 'spend,impressions,clicks,actions';

        // Total account
        const totalR = await fetch(`https://graph.facebook.com/v19.0/${metaAccount}/insights?fields=${fields}&time_range=${tr}&access_token=${metaToken}`);
        const totalJ = await totalR.json();
        if (totalJ.error) throw new Error(totalJ.error.message);
        const d0      = totalJ.data?.[0] || {};
        const acts    = d0.actions || [];
        const totalLeads = parseInt(acts.find(a => a.action_type === 'lead')?.value || 0);

        // Ad-level for cabinet breakdown
        const adR = await fetch(`https://graph.facebook.com/v19.0/${metaAccount}/insights?fields=spend,actions,ad_name,adset_name,campaign_name&time_range=${tr}&level=ad&limit=100&access_token=${metaToken}`);
        const adJ = await adR.json();
        let cabLeads = 0, cabSpend = 0;
        if (!adJ.error && adJ.data) {
          adJ.data.forEach(ad => {
            const name = (ad.ad_name || ad.adset_name || ad.campaign_name || '').toUpperCase();
            if (name.includes('CABINET')) {
              const adActs = ad.actions || [];
              cabLeads += parseInt(adActs.find(a => a.action_type === 'lead')?.value || 0);
              cabSpend += parseFloat(ad.spend || 0);
            }
          });
        }

        metaData = {
          spend:        parseFloat(d0.spend || 0),
          impressions:  parseInt(d0.impressions || 0),
          clicks:       parseInt(d0.clicks || 0),
          leads:        totalLeads,
          cabinetLeads: cabLeads,
          cabinetSpend: Math.round(cabSpend * 100) / 100,
        };
        console.log(`[Meta ${period}] spend=$${metaData.spend} leads=${metaData.leads} cabLeads=${cabLeads}`);
      } catch (e) {
        errors.push(`Meta ${period}: ${e.message}`);
        console.error(`[Meta ${period}]`, e.message);
      }
    }

    // ── GHL v2 ──
    if (ghlToken && ghlLocation) {
      let allAppts = [];

      for (const calId of CALENDAR_IDS) {
        try {
          // Correct GHL v2 endpoint with epoch ms timestamps
          const startMs = new Date(range.startIso).getTime();
          const endMs   = new Date(range.endIso).getTime();

          const url = `https://services.leadconnectorhq.com/calendars/events?locationId=${ghlLocation}&calendarId=${calId}&startTime=${startMs}&endTime=${endMs}`;
          console.log(`[GHL ${period}] Fetching: ${url}`);

          const r = await fetch(url, {
            headers: {
              'Authorization': `Bearer ${ghlToken}`,
              'Content-Type':  'application/json',
              'Version':       '2023-02-21',
            }
          });

          const text = await r.text();
          console.log(`[GHL ${period}] cal=${calId} status=${r.status} body=${text.slice(0, 300)}`);

          let json;
          try { json = JSON.parse(text); } catch(e) { throw new Error('Invalid JSON: ' + text.slice(0,100)); }

          if (!r.ok) throw new Error(json.message || json.error || `HTTP ${r.status}`);

          const events = json.events || json.appointments || json.data || [];
          allAppts = allAppts.concat(events);
        } catch (e) {
          errors.push(`GHL ${period} cal=${calId}: ${e.message}`);
          console.error(`[GHL ${period}] cal=${calId}`, e.message);
        }
      }

      // Deduplicate
      const seen = new Set();
      allAppts = allAppts.filter(a => {
        const id = a.id || a._id;
        if (!id || seen.has(id)) return false;
        seen.add(id); return true;
      });

      ghlData = {
        booked: allAppts.length,
        appointments: allAppts.map(a => ({
          id:         a.id || a._id,
          title:      a.title || '',
          contact:    a.contactName || a.contact?.name || a.title || 'Unknown',
          email:      a.email || a.contact?.email || '',
          phone:      a.phone || a.contact?.phone || '',
          startTime:  a.startTime || a.start_time || a.scheduledAt || '',
          calendarId: a.calendarId || a.calendar_id || '',
          status:     a.appointmentStatus || a.status || 'booked',
        }))
      };

      console.log(`[GHL ${period}] total=${ghlData.booked} appts`);
    }

    results[period] = {
      label:        range.label,
      since:        range.since,
      until:        range.until,
      spend:        metaData.spend        || 0,
      impressions:  metaData.impressions  || 0,
      clicks:       metaData.clicks       || 0,
      leads:        metaData.leads        || 0,
      cabinetLeads: metaData.cabinetLeads || 0,
      cabinetSpend: metaData.cabinetSpend || 0,
      booked:       ghlData.booked,
      appointments: ghlData.appointments,
    };
  }

  res.json({ ok: true, results, errors: errors.length ? errors : undefined });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`SMMA Sync Server v3 on port ${PORT}`));
