/**
 * Roblox API helpers + value lookup + command queue.
 * Queue payload `type` strings are the bridge contract — DO NOT rename.
 */
const { EmbedBuilder } = require('discord.js');
const catalogs = require('../catalogs');
const demand = require('../demand');
const rapStatic = require('../rap-static');
let icons = {};
try { icons = require('../icons'); } catch { icons = {}; }
const { getDb, save } = require('./db');

function norm(s) { return String(s || '').toLowerCase().trim(); }

// ---------- Roblox REST ----------
async function robloxUserId(username) {
  const r = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  const j = await r.json();
  if (j.data && j.data[0]) return { id: j.data[0].id, name: j.data[0].name, displayName: j.data[0].displayName };
  return null;
}

async function robloxThumb(userId) {
  try {
    const r = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
    const j = await r.json();
    return j.data?.[0]?.imageUrl || null;
  } catch { return null; }
}

async function robloxNameFromId(userId) {
  try {
    const r = await fetch('https://users.roblox.com/v1/users/' + userId);
    const j = await r.json();
    if (j && j.name) return { rUsername: j.name, rId: Number(userId) };
  } catch {}
  return null;
}

async function resolveRobloxTarget(token) {
  if (!token) return null;
  const t = String(token).replace('@', '').trim();
  if (/^\d+$/.test(t)) {
    const hit = await robloxNameFromId(t);
    if (hit) return hit;
    return { rUsername: t, rId: Number(t) };
  }
  const r = await robloxUserId(t);
  if (r) return { rUsername: r.name, rId: r.id };
  return null;
}

// ---------- command queue (bridge contract) ----------
function queueCommand(cmd) {
  if (!cmd || typeof cmd !== 'object' || !cmd.type) throw new Error('refusing to queue empty command');
  const db = getDb();
  cmd.id = 'cmd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  cmd.createdAt = Date.now();
  db.commands.push(cmd);
  if (db.commands.length > 200) db.commands = db.commands.slice(-200);
  save();
  return cmd.id;
}

function takeCommandsForRoblox() {
  const db = getDb();
  const now = Date.now();
  db.commands = db.commands.filter((c) => (c.broadcast ? now - c.createdAt < 180000 : now - c.createdAt < 600000));
  return db.commands;
}

function ackCommand(id) {
  const db = getDb();
  db.commands = db.commands.filter((c) => c.id !== id);
  save();
}

// ---------- values ----------
function lookupValue(type, name) {
  const db = getDb();
  const key = `${type}/${name}`.toLowerCase();
  const keys = Object.keys(db.valuesCache.byKey || {});
  const found = keys.find((k) => k.toLowerCase() === key);
  if (found) return db.valuesCache.byKey[found];
  const rap = (rapStatic[type] || {})[name];
  if (typeof rap === 'number') {
    return { type, name, key: `${type}/${name}`, rap, demand: demand.getTier(rap, 0), change: 0, live: false, icon: (icons[type] || {})[name] || null };
  }
  const sKeys = Object.keys(rapStatic[type] || {});
  const sFound = sKeys.find((k) => k.toLowerCase() === String(name).toLowerCase());
  if (sFound) {
    const r2 = rapStatic[type][sFound];
    return { type, name: sFound, key: `${type}/${sFound}`, rap: r2, demand: demand.getTier(r2, 0), change: 0, live: false, icon: (icons[type] || {})[sFound] || null };
  }
  return { type, name, key: `${type}/${name}`, rap: null, demand: 'STABLE', change: 0, live: false, icon: (icons[type] || {})[name] || null };
}

function valueLine(v) {
  const e = demand.EMOJI[v.demand] || '';
  const rapTxt = v.rap == null ? '?' : demand.formatRap(v.rap);
  return `${e} **${v.name}** — RAP **${rapTxt}** • ${v.demand} (${demand.fmtPct(v.change || 0)})${v.live ? '' : ' _(seed)_'}`;
}

async function resolveIcon(icon) {
  const db = getDb();
  if (!icon) return null;
  if (typeof icon === 'string' && icon.startsWith('http')) return icon;
  const m = String(icon).match(/(\d{6,})/);
  if (!m) return null;
  const id = m[1];
  const cached = db.iconCache[id];
  if (cached && cached.url && Date.now() - cached.at < 7 * 24 * 3600 * 1000) return cached.url;
  try {
    const r = await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${id}&size=420x420&format=Png&isCircular=false`);
    const j = await r.json();
    const url = j.data && j.data[0] && j.data[0].imageUrl;
    if (url) { db.iconCache[id] = { url, at: Date.now() }; save(); return url; }
  } catch {}
  return null;
}

// ---------- owners / teleport ----------
function getOwners(type, name, limit = 10) {
  const db = getDb();
  const out = [];
  const want = norm(name);
  for (const [rid, inv] of Object.entries(db.inventories || {})) {
    let list = [];
    if (type === 'Weapon') list = inv.weapons || [];
    else if (type === 'WeaponSkin') list = inv.skins || [];
    else list = inv.finishers || [];
    const has = list.some((x) => norm(typeof x === 'string' ? x : x.name) === want);
    if (!has) continue;
    out.push({
      robloxId: rid,
      robloxUsername: inv.robloxUsername || '?',
      discordId: db.robloxToDiscord[rid] || db.robloxToDiscord[String(rid)] || null,
      placeId: inv.placeId, jobId: inv.jobId, at: inv.at || 0,
    });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => {
    const aOn = a.jobId && db.servers[a.jobId] ? 0 : 1;
    const bOn = b.jobId && db.servers[b.jobId] ? 0 : 1;
    return aOn - bOn || (b.at - a.at);
  });
  return out;
}

function teleportLink(placeId, jobId) {
  if (!placeId || !jobId) return null;
  return `https://www.roblox.com/games/start?placeId=${placeId}&gameInstanceId=${jobId}`;
}

function ownerLine(o) {
  const db = getDb();
  const disc = o.discordId ? `<@${o.discordId}> ✅` : '`not linked`';
  const online = o.jobId && db.servers[o.jobId];
  const tp = (o.placeId && o.jobId) ? ` — [Join server](${teleportLink(o.placeId, o.jobId)})${online ? ' 🟢' : ' (last seen)'}` : '';
  const seen = o.at ? ` <t:${Math.floor(o.at / 1000)}:R>` : '';
  return `• **${o.robloxUsername}** (\`${o.robloxId}\`) → Discord: ${disc}${tp}${seen}`;
}

async function buildItemEmbed(type, name, themeColor) {
  const db = getDb();
  const v = lookupValue(type, name);
  const e = demand.EMOJI[v.demand] || '';
  const rapTxt = v.rap == null ? '?' : demand.formatRap(v.rap);
  const liveAge = db.valuesCache.at ? `<t:${Math.floor(db.valuesCache.at / 1000)}:R>` : 'seeds (game offline — push live via bridge)';
  const emb = new EmbedBuilder()
    .setTitle(`${e} ${v.name}`)
    .setColor(themeColor)
    .setTimestamp()
    .setDescription(
      `Type: \`${v.type}\`\nRAP: **${rapTxt}**${v.rap != null ? ` (\`${v.rap}\`)` : ''}\n` +
      `Demand: **${v.demand}** (${demand.fmtPct(v.change || 0)})\n` +
      `Values: ${v.live ? '🟢 live' : '🟡 seed'} — updated ${liveAge}`,
    );
  const iconUrl = await resolveIcon(v.icon);
  if (iconUrl) emb.setThumbnail(iconUrl);
  const owners = getOwners(v.type, v.name, 5);
  if (!owners.length) {
    emb.addFields({ name: 'Owners (0 tracked)', value: '_No tracked owner yet — game pushes inventories every 60s. Use /online to see live servers._' });
  } else {
    emb.addFields({ name: `Owners (${owners.length}${owners.length >= 5 ? '+' : ''} tracked)`, value: owners.map(ownerLine).join('\n').slice(0, 1000) });
    const withTp = owners.find((o) => o.placeId && o.jobId);
    if (withTp) emb.addFields({ name: 'Teleport', value: `[Join ${withTp.robloxUsername}'s server](${teleportLink(withTp.placeId, withTp.jobId)})\n\`roblox://placeId=${withTp.placeId}&gameInstanceId=${withTp.jobId}\`` });
  }
  emb.setFooter({ text: `🌸 Summer Baddies • ${v.type} • ${v.live ? 'live RAP' : 'seed RAP'}` });
  return emb;
}

function fuzzy(list, q, limit = 8) {
  q = (q || '').toLowerCase();
  if (!q) return list.slice(0, limit);
  return list
    .map((n) => {
      const l = n.toLowerCase();
      let s = -1;
      if (l === q) s = 100; else if (l.startsWith(q)) s = 50; else if (l.includes(q)) s = 20;
      return { n, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.n);
}

function allItemNames(type) {
  const db = getDb();
  const live = Object.values(db.valuesCache.byKey || {}).filter((v) => v.type === type).map((v) => v.name);
  const seeded = Object.keys(rapStatic[type] || {});
  let base = [];
  if (type === 'Weapon') base = catalogs.weapons || [];
  else if (type === 'WeaponSkin') base = [...(catalogs.skinTypes || []), ...seeded];
  else base = catalogs.finishers || [];
  return [...new Set([...live, ...base])];
}

module.exports = {
  robloxUserId,
  robloxThumb,
  resolveRobloxTarget,
  queueCommand,
  takeCommandsForRoblox,
  ackCommand,
  lookupValue,
  valueLine,
  resolveIcon,
  getOwners,
  teleportLink,
  ownerLine,
  buildItemEmbed,
  fuzzy,
  allItemNames,
};
