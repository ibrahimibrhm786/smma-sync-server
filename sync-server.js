/**
 * SMMA Tracker — Sync Server v2
 * GHL API v2 + Meta Ads with form breakdown + daily/weekly/monthly ranges
 *
 * Calendar IDs: 090ze4f7QMT41hIqOLMf, aWRLojJqN8SeshiBnqTF
 * Meta Form:    PPSA ADS1 - CABINETS
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ── Your calendar IDs (hardcoded) ──
const CALENDAR_IDS = [
  '090ze4f7QMT41hIqOLMf',
  'aWRLojJqN8SeshiBnqTF'
];

// ── Date range helpers ──
function getRanges() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth();
  const date  = now.getDate();
  const day   = now.getDay(); // 0=Sun

  // Daily: today
  const dayStart = new Date(year, month, date, 0, 0, 0);
  const dayEnd   = new Date(year, month, date, 23, 59, 59);

  // Weekly: Mon–today
  const diffToMon = (day === 0 ? 6 : day - 1);
  const weekStart = new Date(year, month, date - diffToMon, 0, 0, 0);
  const weekEnd   = dayEnd;

  // Monthly: 1st–today
  const monthStart = new Date(year, month, 1, 0, 0, 0);
  const monthEnd   = dayEnd;

  const fmt = d => d.toISOString().split('T')[0];

  return {
    daily:   { since: fmt(dayStart),   until: fmt(dayEnd),   label: 'Today' },
    weekly:  { since: fmt(weekStart),  until: fmt(weekEnd),  label: 'This week' },
    monthly: { since: fmt(monthStart), until: fmt(monthEnd), label: 'This month' },
  };
}

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'smma-sync-server-v2', calendars: CALENDAR_IDS });
});

// ── POST /sync ──
app.post('/sync', async (req, res) => {
  const { metaToken, metaAccount, ghlToken, ghlLocation } = req.body;

  if (!metaToken && !ghlToken) {
    return res.status(400).json({ error: 'No tokens provided' });
  }

  const ranges = getRanges();
  const results = {};
  const errors  = [];

  for (const [period, range] of Object.entries(ranges)) {
    let metaData = {};
    let ghlData  = {};

    // ── META ADS ──
    if (metaToken && metaAccount) {
      try {
        const timeRange = encodeURIComponent(JSON.stringify({ since: range.since, until: range.until }));
        const fields    = 'spend,impressions,clicks,actions';

        // 1. Total account spend/leads
        const totalUrl  = `https://graph.facebook.com/v19.0/${metaAccount}/insights?fields=${fields}&time_range=${timeRange}&access_token=${metaToken}`;
        const totalRes  = await fetch(totalUrl);
        const totalJson = await totalRes.json();
        if (totalJson.error) throw new Error(totalJson.error.message);

        const d       = totalJson.data?.[0] || {};
        const actions = d.actions || [];
        const totalLeads = parseInt(actions.find(a => a.action_type === 'lead')?.value || 0);

        // 2. Per-form breakdown — PPSA ADS1 - CABINETS
        const formUrl  = `https://graph.facebook.com/v19.0/${metaAccount}/insights?fields=${fields},action_values&time_range=${timeRange}&breakdowns=action_type&action_breakdowns=action_type&access_token=${metaToken}`;

        // Simpler: get ad-level breakdown for cabinet form leads
        const adLevelUrl = `https://graph.facebook.com/v19.0/${metaAccount}/insights?fields=spend,impressions,clicks,actions,ad_name&time_range=${timeRange}&level=ad&access_token=${metaToken}&limit=50`;
        const adRes      = await fetch(adLevelUrl);
        const adJson     = await adRes.json();

        let cabinetLeads = 0;
        let cabinetSpend = 0;
        if (!adJson.error && adJson.data) {
          // Filter ads using CABINETS form (ad name contains CABINET)
          const cabinetAds = adJson.data.filter(ad =>
            (ad.ad_name || '').toUpperCase().includes('CABINET') ||
            (ad.ad_name || '').toUpperCase().includes('A1') ||
            (ad.ad_name || '').toUpperCase().includes('A2') ||
            (ad.ad_name || '').toUpperCase().includes('A3') ||
            (ad.ad_name || '').toUpperCase().includes('A4')
          );
          cabinetAds.forEach(ad => {
            const adActions = ad.actions || [];
            cabinetLeads += parseInt(adActions.find(a => a.action_type === 'lead')?.value || 0);
            cabinetSpend += parseFloat(ad.spend || 0);
          });
        }

        metaData = {
          spend:        parseFloat(d.spend || 0),
          impressions:  parseInt(d.impressions || 0),
          clicks:       parseInt(d.clicks || 0),
          leads:        totalLeads,
          cabinetLeads: cabinetLeads,
          cabinetSpend: Math.round(cabinetSpend * 100) / 100,
        };

        console.log(`[Meta ${period}] spend=$${metaData.spend} leads=${metaData.leads} cabinetLeads=${metaData.cabinetLeads}`);
      } catch (e) {
        errors.push(`Meta ${period}: ${e.message}`);
        console.error(`[Meta ${period}] Error:`, e.message);
      }
    }

    // ── GHL API v2 ──
    if (ghlToken && ghlLocation) {
      try {
        const startIso = new Date(range.since + 'T00:00:00.000Z').toISOString();
        const endIso   = new Date(range.until + 'T23:59:59.999Z').toISOString();

        let allAppts = [];

        // Fetch appointments for each calendar
        for (const calId of CALENDAR_IDS) {
          const url = `https://services.leadconnectorhq.com/calendars/events?locationId=${ghlLocation}&calendarId=${calId}&startTime=${encodeURIComponent(startIso)}&endTime=${encodeURIComponent(endIso)}&includeAll=true`;

          const r = await fetch(url, {
            headers: {
              'Authorization': `Bearer ${ghlToken}`,
              'Content-Type':  'application/json',
              'Version':       '2021-04-15'
            }
          });
          const json = await r.json();

          if (json.events) {
            allAppts = allAppts.concat(json.events);
          } else if (json.appointments) {
            allAppts = allAppts.concat(json.appointments);
          }

          console.log(`[GHL ${period}] calId=${calId} found=${json.events?.length || json.appointments?.length || 0}`);
        }

        // Deduplicate by id
        const seen = new Set();
        allAppts = allAppts.filter(a => {
          if (seen.has(a.id)) return false;
          seen.add(a.id); return true;
        });

        const booked = allAppts.length;

        ghlData = {
          booked,
          appointments: allAppts.map(a => ({
            id:        a.id,
            title:     a.title || a.contactName || 'Appointment',
            contact:   a.contactName || a.contact?.name || '',
            email:     a.email || a.contact?.email || '',
            phone:     a.phone || a.contact?.phone || '',
            startTime: a.startTime || a.start_time || a.scheduledAt,
            calendarId:a.calendarId || a.calendar_id,
            status:    a.appointmentStatus || a.status || 'booked',
          }))
        };

        console.log(`[GHL ${period}] total booked=${booked}`);
      } catch (e) {
        errors.push(`GHL ${period}: ${e.message}`);
        console.error(`[GHL ${period}] Error:`, e.message);
      }
    }

    results[period] = {
      label:        ranges[period].label,
      since:        range.since,
      until:        range.until,
      spend:        metaData.spend        || 0,
      impressions:  metaData.impressions  || 0,
      clicks:       metaData.clicks       || 0,
      leads:        metaData.leads        || 0,
      cabinetLeads: metaData.cabinetLeads || 0,
      cabinetSpend: metaData.cabinetSpend || 0,
      booked:       ghlData.booked        || 0,
      appointments: ghlData.appointments  || [],
    };
  }

  return res.json({ ok: true, results, errors: errors.length ? errors : undefined });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`SMMA Sync Server v2 running on port ${PORT}`);
});
