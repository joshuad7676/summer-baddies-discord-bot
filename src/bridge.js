/**
 * Express bridge — Roblox <-> Discord.
 * Contract preserved from the old bot so the in-game DiscordBridge keeps working.
 */
const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const { getDb, save, saveSoon } = require('./db');
const { takeCommandsForRoblox, ackCommand } = require('./roblox');
const { embedBase } = require('./embeds');

function startBridge(client, { port, apiKey }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_req, res) => res.send('Summer Baddies bridge online 🌸'));

  const auth = (req, res, next) => {
    if (req.headers['x-api-key'] !== apiKey) return res.status(401).json({ ok: false, error: 'bad api key' });
    next();
  };

  app.get('/roblox/commands', auth, (_req, res) => res.json({ ok: true, commands: takeCommandsForRoblox() }));
  app.post('/roblox/ack', auth, (req, res) => { if (req.body?.id) ackCommand(req.body.id); res.json({ ok: true }); });

  app.post('/roblox/report', auth, async (req, res) => {
    const b = req.body || {};
    res.json({ ok: true });
    try {
      const db = getDb();
      const chId = db.settings.reportsChannel || process.env.REPORTS_CHANNEL_ID;
      if (!chId) return;
      const ch = await client.channels.fetch(chId).catch(() => null);
      if (!ch || !ch.isTextBased()) return;
      const tp = b.placeId && b.jobId ? `\n[Join server](https://www.roblox.com/games/start?placeId=${b.placeId}&gameInstanceId=${b.jobId})` : '';
      await ch.send({
        embeds: [embedBase('🚨 In-game report',
          `**Reporter:** ${b.reporter || '?'} (\`${b.reporterId || '?'}\`)\n**Reported:** ${b.reported || '?'} (\`${b.reportedId || '?'}\`)\n**Reason:** ${b.reason || '?'}\n**Details:** ${(b.details || '—').slice(0, 800)}${tp}`)],
      }).catch(() => {});
    } catch (e) { console.error('[report]', e.message); }
  });

  app.post('/roblox/player-data', auth, (req, res) => {
    const b = req.body || {};
    if (!b.robloxId) return res.json({ ok: true });
    const db = getDb();
    const rid = String(b.robloxId);
    db.playerCache[rid] = { ...b, at: Date.now() };
    db.inventories[rid] = {
      robloxUsername: b.robloxUsername || db.inventories[rid]?.robloxUsername || '?',
      weapons: (b.weapons || b.weaponNames || []).slice(0, 200),
      skins: (b.skins || b.skinNames || []).slice(0, 200),
      finishers: (b.finishers || b.finisherNames || []).slice(0, 200),
      placeId: b.placeId, jobId: b.jobId, at: Date.now(),
    };
    if (b.jobId) {
      const s = db.servers[b.jobId] || { placeId: b.placeId, jobId: b.jobId, players: [], at: Date.now() };
      if (!s.players.some((p) => String(p.robloxId) === rid)) {
        s.players.push({ robloxId: rid, robloxUsername: b.robloxUsername });
        s.players = s.players.slice(0, 60);
      }
      s.at = Date.now(); s.placeId = b.placeId || s.placeId;
      db.servers[b.jobId] = s;
    }
    saveSoon();
    res.json({ ok: true });
  });

  app.post('/roblox/inventory', auth, (req, res) => {
    const players = req.body?.players || [];
    const db = getDb();
    for (const p of players) {
      if (!p.robloxId) continue;
      const rid = String(p.robloxId);
      db.inventories[rid] = {
        robloxUsername: p.robloxUsername || '?',
        weapons: (p.weapons || p.weaponNames || []).slice(0, 200),
        skins: (p.skins || p.skinNames || []).slice(0, 200),
        finishers: (p.finishers || p.finisherNames || []).slice(0, 200),
        placeId: p.placeId, jobId: p.jobId, at: Date.now(),
      };
    }
    saveSoon();
    res.json({ ok: true, tracked: players.length });
  });

  app.post('/roblox/servers', auth, (req, res) => {
    const b = req.body || {};
    if (!b.jobId) return res.json({ ok: true });
    const db = getDb();
    db.servers[b.jobId] = { placeId: b.placeId, jobId: b.jobId, players: (b.players || []).slice(0, 60), at: Date.now() };
    for (const p of b.players || []) {
      const rid = String(p.robloxId);
      if (db.inventories[rid]) { db.inventories[rid].placeId = b.placeId; db.inventories[rid].jobId = b.jobId; }
    }
    saveSoon();
    res.json({ ok: true });
  });

  app.post('/roblox/verify', auth, async (req, res) => {
    const { code, robloxUsername, robloxId } = req.body || {};
    const db = getDb();
    const rec = db.linkCodes[String(code)];
    if (!rec) return res.json({ ok: false, error: 'bad code' });
    if (Date.now() > rec.expires) { delete db.linkCodes[String(code)]; save(); return res.json({ ok: false, error: 'expired' }); }
    if (Number(robloxId) !== Number(rec.robloxId)) return res.json({ ok: false, error: 'wrong account' });
    delete db.linkCodes[String(code)];
    db.links[rec.discordId] = { robloxUsername: rec.robloxUsername || robloxUsername, robloxId: Number(rec.robloxId), at: Date.now() };
    db.robloxToDiscord[String(rec.robloxId)] = rec.discordId;
    save();
    res.json({ ok: true, discordId: rec.discordId, robloxUsername: rec.robloxUsername });
    try {
      const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
      if (guild) {
        const member = await guild.members.fetch(rec.discordId).catch(() => null);
        if (member) {
          try { await member.send(`✅ Verified! Discord linked to Roblox **${rec.robloxUsername}**.`); } catch {}
          if (db.settings.verifiedRoleId) await member.roles.add(db.settings.verifiedRoleId).catch(() => {});
        }
        if (db.settings.linkLogChannel) {
          const ch = await guild.channels.fetch(db.settings.linkLogChannel).catch(() => null);
          if (ch?.isTextBased()) ch.send({ embeds: [embedBase('🔗 Account linked', `<@${rec.discordId}> → **${rec.robloxUsername}** (\`${rec.robloxId}\`)`)] }).catch(() => {});
        }
      }
    } catch (e) { console.error('[verify]', e.message); }
  });

  app.post('/roblox/punishment', auth, async (req, res) => {
    const { action, robloxUsername, robloxId, reason, minutes } = req.body || {};
    const db = getDb();
    if (action === 'ban' && robloxId) db.bans[String(robloxId)] = { reason: reason || '', by: req.body.by || 'game', at: Date.now() };
    save();
    res.json({ ok: true });
    try {
      const discordId = db.robloxToDiscord[String(robloxId)];
      if (!discordId) return;
      const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
      if (!guild) return;
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (!member) return;
      if (action === 'ban') await guild.members.ban(discordId, { reason: `Game ban: ${robloxUsername} — ${reason || ''}`.slice(0, 450) }).catch(() => {});
      else if (action === 'kick') await member.kick(`Game kick: ${reason || ''}`.slice(0, 450)).catch(() => {});
      else if (action === 'timeout_note') {
        const mins = Math.min(Math.max(Number(minutes) || 10, 1), 40320);
        await member.timeout(mins * 60000, `Game note: ${reason || ''}`.slice(0, 450)).catch(() => {});
      }
    } catch (e) { console.error('[punishment]', e.message); }
  });

  app.post('/roblox/values', auth, (req, res) => {
    const items = req.body?.items || [];
    const db = getDb();
    const { getTier } = require('../demand');
    for (const it of items) {
      if (!it.key || typeof it.rap !== 'number') continue;
      db.valuesCache.byKey[it.key] = {
        type: it.type, name: it.name, key: it.key,
        rap: Math.floor(it.rap), demand: it.demand || getTier(it.rap, it.change || 0),
        change: it.change || 0, live: true, icon: it.icon || null,
      };
    }
    db.valuesCache.at = Date.now();
    saveSoon();
    res.json({ ok: true, count: items.length });
  });

  app.get('/roblox/bans', auth, (_req, res) => res.json({ ok: true, bans: getDb().bans }));
  app.get('/roblox/links', auth, (_req, res) => res.json({ ok: true, links: getDb().robloxToDiscord }));

  app.listen(port, () => console.log(`[bridge] listening on :${port}`));
  return app;
}

async function isStaffHigherThanBot(member) {
  if (!member?.guild) return false;
  if (member.id === member.guild.ownerId) return true;
  const me = await member.guild.members.fetchMe();
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return member.roles.highest.position > me.roles.highest.position;
  return member.roles.highest.position > me.roles.highest.position;
}

module.exports = { startBridge, isStaffHigherThanBot };
