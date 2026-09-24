require('dotenv').config();
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = require('path');
const catalogs = require('./catalogs');
const demand = require('./demand');
const rapStatic = require('./rap-static');
let icons = {};
try { icons = require('./icons'); } catch { icons = {}; }
const applications = require('./applications');
const QUESTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per application question
const ticketTimeouts = new Map(); // channelId -> timeout (in-memory; transcripts persist in db)

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const API_KEY = process.env.BOT_API_KEY || 'change_me';
const PORT = process.env.PORT || 3000;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN / CLIENT_ID / GUILD_ID in .env');
  process.exit(1);
}

// ---------- tiny JSON db (deep-merged so new fields survive restarts) ----------
const DB_PATH = path.join(__dirname, 'data.json');
let db = {
  links: {}, robloxToDiscord: {}, linkCodes: {},
  settings: { rulesText: '', welcomeChannel: '', leaveChannel: '', reportsChannel: '', linkLogChannel: '', verifiedRoleId: '', levelChannelId: '', levelsEnabled: true, ticketCategoryId: '', ticketReviewChannelId: '', ticketReviewerRoleId: '' },
  commands: [], playerCache: {}, bans: {},
  valuesCache: { at: 0, byKey: {} },
  inventories: {}, servers: {}, levels: {}, iconCache: {}, tickets: {}, reactionRoles: {}, shortcuts: { prefix: ',', map: {} },
  // --- Discord-suite (Carl / Greed / Mimu style) — auto-created, survives restarts ---
  economy: {}, warns: {}, tags: {},
  suggestions: { channelId: '', nextId: 1, items: {} },
  modlog: { channelId: '' },
  autoroles: [],
  giveaways: {},
  reminders: []
};
try {
  if (fs.existsSync(DB_PATH)) {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    db = Object.assign(db, raw);
    db.settings = Object.assign({ rulesText: '', welcomeChannel: '', leaveChannel: '', reportsChannel: '', linkLogChannel: '', verifiedRoleId: '', levelChannelId: '', levelsEnabled: true, ticketCategoryId: '', ticketReviewChannelId: '', ticketReviewerRoleId: '' }, raw.settings || {});
    db.valuesCache = raw.valuesCache || { at: 0, byKey: {} };
    db.inventories = raw.inventories || {};
    db.servers = raw.servers || {};
    db.levels = raw.levels || {};
    db.iconCache = raw.iconCache || {};
    db.tickets = raw.tickets || {};
    db.reactionRoles = raw.reactionRoles || {};
    db.shortcuts = (raw.shortcuts && typeof raw.shortcuts === 'object') ? raw.shortcuts : { prefix: ',', map: {} };
    if (!db.shortcuts.map || typeof db.shortcuts.map !== 'object') db.shortcuts.map = {};
    if (typeof db.shortcuts.prefix !== 'string' || !db.shortcuts.prefix) db.shortcuts.prefix = ',';
    // discord-suite merges
    db.economy = raw.economy || {};
    db.warns = raw.warns || {};
    db.tags = raw.tags || {};
    db.suggestions = raw.suggestions && typeof raw.suggestions === 'object' ? raw.suggestions : { channelId: '', nextId: 1, items: {} };
    if (!db.suggestions.items) db.suggestions.items = {};
    if (!db.suggestions.nextId) db.suggestions.nextId = 1;
    db.modlog = raw.modlog || { channelId: '' };
    db.autoroles = Array.isArray(raw.autoroles) ? raw.autoroles : [];
    db.giveaways = raw.giveaways || {};
    db.reminders = Array.isArray(raw.reminders) ? raw.reminders : [];
  }
} catch (e) { console.error('DB load failed, using fresh:', e.message); }
function save() { try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch (e) { console.error('DB save failed:', e.message); } }

// ---------- values ----------
function lookupValue(type, name) {
  const key = `${type}/${name}`.toLowerCase();
  const keys = Object.keys(db.valuesCache.byKey || {});
  const found = keys.find(k => k.toLowerCase() === key);
  if (found) return db.valuesCache.byKey[found];
  const rap = (rapStatic[type] || {})[name];
  if (typeof rap === 'number') {
    const liveIcon = (icons[type] || {})[name] || null;
    return { type, name, key: `${type}/${name}`, rap, demand: demand.getTier(rap, 0), change: 0, live: false, icon: liveIcon };
  }
  // try case-insensitive static lookup
  const sKeys = Object.keys(rapStatic[type] || {});
  const sFound = sKeys.find(k => k.toLowerCase() === String(name).toLowerCase());
  if (sFound) {
    const r2 = rapStatic[type][sFound];
    return { type, name: sFound, key: `${type}/${sFound}`, rap: r2, demand: demand.getTier(r2, 0), change: 0, live: false, icon: (icons[type] || {})[sFound] || null };
  }
  return { type, name, key: `${type}/${name}`, rap: null, demand: 'STABLE', change: 0, live: false, icon: (icons[type] || {})[name] || null };
}
function valueLine(v) {
  const e = demand.EMOJI[v.demand] || '';
  const rapTxt = v.rap == null ? '?' : demand.formatRap(v.rap);
  const pct = demand.fmtPct(v.change || 0);
  return `${e} **${v.name}** — RAP **${rapTxt}** • ${v.demand} (${pct})${v.live ? '' : ' _(seed)_'}`;
}

// Resolve rbxassetid://123 -> https thumbnail via Roblox API (cached 7d). https passthrough.
async function resolveIcon(icon) {
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
function norm(s) { return String(s || '').toLowerCase().trim(); }
function getOwners(type, name, limit = 10) {
  const out = [];
  const want = norm(name);
  for (const [rid, inv] of Object.entries(db.inventories || {})) {
    let list = [];
    if (type === 'Weapon') list = inv.weapons || [];
    else if (type === 'WeaponSkin') list = inv.skins || [];
    else list = inv.finishers || [];
    const has = list.some(x => norm(typeof x === 'string' ? x : x.name) === want || norm(typeof x === 'string' ? x : x.name).includes(want) && want.length > 3 && norm(typeof x === 'string' ? x : x.name) === want);
    // exact match preferred; fallback to exact only to avoid false positives
    if (!has) continue;
    out.push({
      robloxId: rid, robloxUsername: inv.robloxUsername || '?',
      discordId: db.robloxToDiscord[rid] || db.robloxToDiscord[String(rid)] || null,
      placeId: inv.placeId, jobId: inv.jobId, at: inv.at || 0
    });
    if (out.length >= limit) break;
  }
  // online first
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
  const disc = o.discordId ? `<@${o.discordId}> ✅` : '`not linked`';
  const online = o.jobId && db.servers[o.jobId];
  const tp = (o.placeId && o.jobId) ? ` — [Join server](${teleportLink(o.placeId, o.jobId)})${online ? ' 🟢' : ' (last seen)'}` : '';
  const seen = o.at ? ` <t:${Math.floor(o.at / 1000)}:R>` : '';
  return `• **${o.robloxUsername}** (\`${o.robloxId}\`) → Discord: ${disc}${tp}${seen}`;
}
async function buildItemEmbed(type, name) {
  const v = lookupValue(type, name);
  const e = demand.EMOJI[v.demand] || '';
  const rapTxt = v.rap == null ? '?' : demand.formatRap(v.rap);
  const pct = demand.fmtPct(v.change || 0);
  const color = demand.COLORS[v.demand] || 0xff5da2;
  const liveAge = db.valuesCache.at ? `<t:${Math.floor(db.valuesCache.at / 1000)}:R>` : 'seeds (game offline — push live via bridge)';
  const emb = new EmbedBuilder()
    .setTitle(`${e} ${v.name}`)
    .setColor(color)
    .setTimestamp()
    .setDescription(
      `Type: \`${v.type}\`\n` +
      `RAP: **${rapTxt}**${v.rap != null ? ` (\`${v.rap}\`)` : ''}\n` +
      `Demand: **${v.demand}** (${pct})\n` +
      `Values: ${v.live ? '🟢 live' : '🟡 seed'} — updated ${liveAge}`
    );
  const iconUrl = await resolveIcon(v.icon);
  if (iconUrl) emb.setThumbnail(iconUrl);
  const owners = getOwners(v.type, v.name, 5);
  if (!owners.length) {
    emb.addFields({ name: `Owners (0 tracked)`, value: '_No tracked owner yet — game pushes inventories every 60s once the new bridge is installed. Use /online to see live servers._' });
  } else {
    emb.addFields({ name: `Owners (${owners.length}${owners.length >= 5 ? '+' : ''} tracked)`, value: owners.map(ownerLine).join('\n').slice(0, 1000) });
    const withTp = owners.find(o => o.placeId && o.jobId);
    if (withTp) emb.addFields({ name: 'Teleport', value: `[Join ${withTp.robloxUsername}'s server](${teleportLink(withTp.placeId, withTp.jobId)})\n\`roblox://placeId=${withTp.placeId}&gameInstanceId=${withTp.jobId}\`` });
  }
  emb.setFooter({ text: `${v.type} • ${v.live ? 'live RAP' : 'seed RAP — install bridge pushValues for live'}` });
  return emb;
}

// ---------- command queue for Roblox ----------
function queueCommand(cmd) {
  if (!cmd || typeof cmd !== 'object' || !cmd.type) throw new Error('refusing to queue empty command (bug: payload was null)');
  cmd.id = 'cmd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  cmd.createdAt = Date.now();
  db.commands.push(cmd);
  if (db.commands.length > 200) db.commands = db.commands.slice(-200);
  save();
  return cmd.id;
}
function takeCommandsForRoblox() {
  const now = Date.now();
  db.commands = db.commands.filter(c => (c.broadcast ? now - c.createdAt < 180000 : now - c.createdAt < 600000));
  return db.commands;
}
function ackCommand(id) { db.commands = db.commands.filter(c => c.id !== id); save(); }

// ---------- Roblox API helpers ----------
async function robloxUserId(username) {
  const r = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
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
const SHORTCUT_COMMANDS = ['game-kick', 'game-ban', 'game-unban', 'game-announce', 'game-restart', 'game-luck', 'admin-abuse', 'game-money', 'give-tokens', 'give-spins', 'give-weapon', 'give-finisher', 'player-data', 'add-emoji', 'remove-emoji', 'force-pvp', 'unforce-pvp', 'force-show-emoji', 'unforce-show-emoji'];

function shortcutsHelp() {
  const map = (db.shortcuts && db.shortcuts.map) || {};
  const keys = Object.keys(map).sort();
  const p = (db.shortcuts && db.shortcuts.prefix) || ',';
  if (!keys.length) return `\n**Text shortcuts**\nNone yet — staff: /shortcut-add (default prefix \`${p}\`)`;
  return `\n**Text shortcuts** (default prefix \`${p}\`)\n` + keys.map(k => `\`${(map[k].prefix || p)}${k}\` → /${map[k].command}`).join('\n');
}

async function resolveShortcutTarget(token) {
  if (!token) return null;
  if (/^\d+$/.test(token)) {
    const id = Number(token);
    try {
      const rr = await fetch('https://users.roblox.com/v1/users/' + id);
      const jj = await rr.json();
      if (jj && jj.name) return { rUsername: jj.name, rId: id };
    } catch {}
    return { rUsername: String(id), rId: id };
  }
  try {
    const r = await robloxUserId(token);
    if (r) return { rUsername: r.name, rId: r.id };
  } catch {}
  return null;
}

function fuzzy(list, q, limit = 8) {
  q = (q || '').toLowerCase();
  if (!q) return list.slice(0, limit);
  const scored = list.map(n => {
    const l = n.toLowerCase();
    let s = -1;
    if (l === q) s = 100; else if (l.startsWith(q)) s = 50; else if (l.includes(q)) s = 20;
    return { n, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
  return scored.map(x => x.n);
}

// ---------- permissions ----------
async function isStaffHigherThanBot(member) {
  if (!member || !member.guild) return false;
  if (member.id === member.guild.ownerId) return true;
  const me = await member.guild.members.fetchMe();
  const botTop = me.roles.highest.position;
  const userTop = member.roles.highest.position;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return userTop > botTop || member.id === member.guild.ownerId;
  return userTop > botTop;
}
async function staffHigherThanBotList(guild) {
  const me = await guild.members.fetchMe();
  const botTop = me.roles.highest.position;
  const members = await guild.members.fetch();
  return members.filter(m => !m.user.bot && m.roles.highest.position > botTop);
}

// ---------- levels ----------
function xpNeeded(level) { return 100 + level * 50; }

// ---------- level milestone roles (1-50, named every 5) ----------
const LEVEL_MILESTONES = [
  [1, 'Unknown', 0x95a5a6], [5, 'Baddies', 0xff5da2], [10, 'Hot Girl', 0xff3d7f],
  [15, 'It Girl', 0xc026d3], [20, 'Showstopper', 0x8b5cf6], [25, 'Icon', 0x3b82f6],
  [30, 'Legend', 0xf59e0b], [35, 'Royalty', 0xa855f7], [40, 'Mogul', 0x10b981],
  [45, 'Empire', 0xf97316], [50, 'Supreme', 0xffd700],
];
function levelRoleName(level) {
  let hit = null;
  for (const [lv, nm] of LEVEL_MILESTONES) { if (lv <= level) hit = [lv, nm]; }
  return hit ? `Level ${hit[0]} (${hit[1]})` : null;
}
function levelRoleColor(level) {
  let color = 0x95a5a6;
  for (const [lv, , c] of LEVEL_MILESTONES) { if (lv <= level) color = c; }
  return color;
}
async function syncLevelRole(member, level) {
  try {
    const guild = member.guild;
    const want = levelRoleName(level);
    if (!want) return false;
    const milestoneNames = new Set(LEVEL_MILESTONES.map(([lv, nm]) => `Level ${lv} (${nm})`));
    for (const [, role] of member.roles.cache) {
      if (milestoneNames.has(role.name) && role.name !== want) {
        await member.roles.remove(role).catch(() => {});
      }
    }
    let role = guild.roles.cache.find(r => r.name === want);
    if (!role) {
      role = await guild.roles.create({ name: want, color: levelRoleColor(level), mentionable: false, reason: 'Level milestone role' }).catch(() => null);
      if (!role) return false;
    }
    if (!member.roles.cache.has(role.id)) await member.roles.add(role).catch(() => {});
    return true;
  } catch { return false; }
}
function getLevelRec(discordId) {
  if (!db.levels[discordId]) db.levels[discordId] = { xp: 0, level: 0, msgs: 0, lastXp: 0 };
  return db.levels[discordId];
}

// ---------- Discord client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.GuildMember, Partials.Message, Partials.Channel, Partials.Reaction]
});

// ---------- slash commands ----------
const ADMIN_PERMS = '0';

// ---------- role ladder + server layout (setup-roles / setup-layout / reset-layout) ----------
const P = PermissionFlagsBits;
const BASE_CHAT_VOICE = [
  P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory,
  P.AddReactions, P.Connect, P.Speak, P.Stream, P.UseVAD, P.UseApplicationCommands, P.ChangeNickname,
];
// Exact ladder top-to-bottom. Hoist: 1-10 true, 11-14 false (spec left 11-12 ambiguous).
// Never grants ManageGuild/ManageRoles/ManageChannels below Co-Owner.
const ROLE_LADDER = [
  { name: '♛ Owner',             color: '#FF3131', hoist: true,  perms: ['Administrator'] },
  { name: '♕ Co-Owner',          color: '#FF8C1A', hoist: true,  perms: ['Administrator'] },
  { name: '★ Director',          color: '#FFD700', hoist: true,  perms: ['BanMembers', 'KickMembers', 'ModerateMembers', 'ManageMessages'] },
  { name: '✦ Community Manager', color: '#9D4EDD', hoist: true,  perms: ['BanMembers', 'KickMembers', 'ModerateMembers', 'ManageMessages'] },
  { name: '❖ Head Admin',        color: '#FF4D8D', hoist: true,  perms: ['BanMembers', 'KickMembers', 'ModerateMembers', 'ManageMessages'] },
  { name: '♠ Admin',             color: '#FF85A2', hoist: true,  perms: ['KickMembers', 'ModerateMembers', 'ManageMessages'] },
  { name: '♣ Head Moderator',    color: '#00C2A8', hoist: true,  perms: ['KickMembers', 'ModerateMembers', 'ManageMessages'] },
  { name: '♧ Moderator',         color: '#5BC0EB', hoist: true,  perms: ['ModerateMembers', 'ManageMessages'] },
  { name: '♥ Trial Moderator',   color: '#808080', hoist: true,  perms: ['ModerateMembers', 'ManageMessages'] },
  { name: '♦ Helper',            color: '#7BED9F', hoist: true,  perms: ['ModerateMembers'] },
  { name: '</> Developer',       color: '#5865F2', hoist: false, perms: [] },
  { name: '♪ Event Team',        color: '#FF9FF3', hoist: false, perms: [] },
  { name: '☾ VIP',               color: '#F47FFF', hoist: false, perms: [] },
  { name: '♡ Member',            color: '#B0BEC5', hoist: false, perms: [] },
];
function ladderPerms(def) {
  if (def.perms.includes('Administrator')) return [P.Administrator];
  const out = [...BASE_CHAT_VOICE];
  for (const k of def.perms) { if (P[k]) out.push(P[k]); }
  return out;
}
function isGuildOwner(interaction) {
  return !!(interaction.guild && interaction.user && interaction.guild.ownerId === interaction.user.id);
}
async function requireOwner(interaction) {
  if (isGuildOwner(interaction)) return true;
  try { await interaction.reply({ content: '❌ Owner only — only the server owner can use this.', ephemeral: true }); } catch {}
  return false;
}
function sanitizeTextChannelName(n) {
  let s = String(n || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  return s.slice(0, 100) || 'channel';
}
// DSL: "Category: Name" / "#channel (optional topic)" / "Voice: Name". Bullets (-,*,>) + // comments tolerated.
function parseLayoutDescription(text) {
  const layout = [];
  const warnings = [];
  const ensureCategory = (name) => {
    const clean = String(name || '').trim().slice(0, 90) || 'General';
    let c = layout.find(x => x.category.toLowerCase() === clean.toLowerCase());
    if (!c) { c = { category: clean, channels: [] }; layout.push(c); }
    return c;
  };
  for (const raw of String(text || '').split('\n')) {
    let line = String(raw || '').trim().replace(/^[-*•>]+\s*/, '').trim();
    if (!line || line.startsWith('//')) continue;
    let m;
    if ((m = line.match(/^category\s*:\s*(.+)$/i))) { ensureCategory(m[1]); continue; }
    if ((m = line.match(/^voice\s*:\s*(.+?)(?:\s*\(([^)]*)\))?$/i))) {
      const cur = ensureCategory(currentName() || 'Voice Lounges');
      cur.channels.push({ name: String(m[1]).trim().slice(0, 100) || 'Lounge', type: 'voice', topic: '' });
      continue;
    }
    if ((m = line.match(/^#([a-z0-9\-_ ]+?)(?:\s*\(([^)]*)\))?$/i))) {
      const cur = ensureCategory(currentName() || 'General');
      cur.channels.push({ name: sanitizeTextChannelName(m[1]), type: 'text', topic: String(m[2] || '').slice(0, 1024) });
      continue;
    }
    warnings.push(`Skipped: "${String(raw).trim().slice(0, 80)}" (use "Category: Name", "#channel (topic)", "Voice: Name")`);
  }
  function currentName() { return layout.length ? layout[layout.length - 1].category : null; }
  // NOTE: Voice:/text lines before any Category: fall into a default bucket via currentName() fallback above.
  return { layout, warnings };
}
function getBaddiesPreset() {
  return [
    { category: '🌸・INFO', channels: [
      { name: 'welcome', type: 'text', topic: 'Welcome baddies! Link with /link and read the rules' },
      { name: 'rules', type: 'text', topic: 'Server rules — read before chatting' },
      { name: 'announcements', type: 'text', topic: 'Official news only (staff posts)' },
    ]},
    { category: '💬・GENERAL', channels: [
      { name: 'general', type: 'text', topic: 'Main chat — be kind' },
      { name: 'introductions', type: 'text', topic: 'Say hi, baddie!' },
      { name: 'bot-commands', type: 'text', topic: 'Bot spam here: /value /rank /search-skins …' },
      { name: 'suggestions', type: 'text', topic: 'Suggest ideas for the game + server' },
    ]},
    { category: '💰・TRADING', channels: [
      { name: 'trade-list', type: 'text', topic: 'Post your trades (item + demand)' },
      { name: 'trade-history', type: 'text', topic: 'Completed trades — proof + vouches' },
      { name: 'value-discussion', type: 'text', topic: 'Talk RAP, demand and trends' },
    ]},
    { category: '👯・CREWS', channels: [
      { name: 'crew-recruitment', type: 'text', topic: 'Recruit members for your crew' },
      { name: 'crew-showcase', type: 'text', topic: 'Show off your crew' },
      { name: 'looking-for-crew', type: 'text', topic: 'Find a crew to join' },
    ]},
    { category: '🎉・EVENTS', channels: [
      { name: 'events', type: 'text', topic: 'Upcoming events (staff posts)' },
      { name: 'giveaways', type: 'text', topic: 'Giveaways — follow the rules on each post' },
      { name: 'event-winners', type: 'text', topic: 'Winners get posted here' },
    ]},
    { category: '🎟️・TICKETS & SUPPORT', channels: [
      { name: 'support', type: 'text', topic: 'Ask staff for help' },
      { name: 'apply-here', type: 'text', topic: 'How to apply: use /apply (Admin, Tester, …)' },
    ]},
    { category: '📸・MEDIA', channels: [
      { name: 'media', type: 'text', topic: 'Screenshots + clips' },
      { name: 'clips', type: 'text', topic: 'Best gameplay clips' },
      { name: 'fan-art', type: 'text', topic: 'Share your art' },
    ]},
    { category: '🔊・VOICE LOUNGES', channels: [
      { name: 'General Lounge', type: 'voice', topic: '' },
      { name: 'Trading Lounge', type: 'voice', topic: '' },
      { name: 'Event Stage', type: 'voice', topic: '' },
      { name: 'Music Vibes', type: 'voice', topic: '' },
    ]},
  ];
}
const READONLY_CHANNELS = new Set(['welcome', 'rules', 'announcements', 'events', 'giveaways', 'event-winners']);
function ladderRoleMap(guild) {
  const map = new Map();
  for (const def of ROLE_LADDER) {
    const r = guild.roles.cache.find(x => x.name === def.name);
    if (r) map.set(def.name, r);
  }
  return map;
}
async function setupRoleLadder(guild) {
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(P.ManageRoles)) throw new Error('I need the **Manage Roles** permission.');
  const botTop = me.roles.highest.position;
  await guild.roles.fetch();
  const created = [], skipped = [], failed = [];
  for (const def of [...ROLE_LADDER].reverse()) { // bottom-up so top ends highest
    const existing = guild.roles.cache.find(r => r.name === def.name);
    if (existing) { skipped.push(def.name); continue; }
    try {
      await guild.roles.create({ name: def.name, color: def.color, hoist: def.hoist, mentionable: false, permissions: ladderPerms(def), reason: 'setup-roles ladder' });
      created.push(def.name);
    } catch (e) { failed.push(`${def.name}: ${String(e.message || e).slice(0, 120)}`); }
  }
  let orderWarning = '';
  try {
    await guild.roles.fetch();
    const targets = [];
    ROLE_LADDER.forEach((def, i) => {
      const r = guild.roles.cache.find(x => x.name === def.name);
      if (!r || !r.editable) return;
      const pos = botTop - 1 - i; // Owner just below bot
      if (pos >= 1) targets.push({ role: r.id, position: pos });
    });
    if (targets.length) await guild.roles.setPositions(targets);
    if (botTop <= ROLE_LADDER.length) orderWarning = `Bot role is very low (position ${botTop}) — drag the bot role above the ladder in Server Settings → Roles, then re-run /setup-roles to fix ordering.`;
  } catch (e) { orderWarning = 'Could not enforce ordering (missing perms or hierarchy): ' + String(e.message || e).slice(0, 150); }
  return { created, skipped, failed, orderWarning, botTop };
}
async function applyLayout(guild, layout) {
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(P.ManageChannels)) throw new Error('I need the **Manage Channels** permission.');
  await guild.roles.fetch().catch(() => {});
  await guild.channels.fetch().catch(() => {});
  const everyone = guild.roles.everyone;
  const byName = ladderRoleMap(guild);
  const senior = ['♛ Owner', '♕ Co-Owner', '★ Director', '✦ Community Manager'].map(n => byName.get(n)).filter(Boolean);
  const createdCats = [], skippedCats = [], createdChs = [], skippedChs = [], failed = [];
  for (const block of layout) {
    const catName = String(block.category || '').trim().slice(0, 90) || 'General';
    let cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === catName.toLowerCase()) || null;
    if (cat) skippedCats.push(catName);
    else {
      try {
        cat = await guild.channels.create({ name: catName, type: ChannelType.GuildCategory, reason: 'setup-layout' });
        createdCats.push(catName);
      } catch (e) { failed.push(`${catName}: ${String(e.message || e).slice(0, 120)}`); continue; }
    }
    for (const ch of (block.channels || [])) {
      const isVoice = ch.type === 'voice';
      const wantName = isVoice ? String(ch.name || '').trim().slice(0, 100) : sanitizeTextChannelName(ch.name);
      const wantType = isVoice ? ChannelType.GuildVoice : ChannelType.GuildText;
      const dupe = guild.channels.cache.find(c => c.type === wantType && c.name.toLowerCase() === wantName.toLowerCase() && (!c.parentId || (cat && c.parentId === cat.id)));
      if (dupe) { skippedChs.push('#' + wantName); continue; }
      try {
        const overwrites = [];
        if (!isVoice && READONLY_CHANNELS.has(wantName)) {
          overwrites.push({ id: everyone.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] });
          for (const sr of senior) overwrites.push({ id: sr.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] });
        } else if (!isVoice) {
          overwrites.push({ id: everyone.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] });
        } else {
          overwrites.push({ id: everyone.id, allow: [P.ViewChannel, P.Connect, P.Speak] });
        }
        const opts = { name: wantName, type: wantType, parent: cat ? cat.id : null, permissionOverwrites: overwrites, reason: 'setup-layout' };
        if (!isVoice && ch.topic) opts.topic = String(ch.topic).slice(0, 1024);
        await guild.channels.create(opts);
        createdChs.push((isVoice ? '🔊 ' : '#') + wantName);
      } catch (e) { failed.push(`${wantName}: ${String(e.message || e).slice(0, 120)}`); }
    }
  }
  // auto-wire common settings when empty
  const wired = [];
  try {
    const findText = (n) => guild.channels.cache.find(c => (c.type === ChannelType.GuildText) && c.name.toLowerCase() === n);
    const welcome = findText('welcome');
    if (welcome && !db.settings.welcomeChannel) { db.settings.welcomeChannel = welcome.id; wired.push('welcome → #welcome'); }
    const support = findText('support');
    if (support && !db.settings.reportsChannel) { db.settings.reportsChannel = support.id; wired.push('reports → #support'); }
    const ticketCat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && /ticket|support/i.test(c.name || ''));
    if (ticketCat && !db.settings.ticketCategoryId) { db.settings.ticketCategoryId = ticketCat.id; wired.push('ticket category → ' + ticketCat.name); }
    if (wired.length) save();
  } catch {}
  return { createdCats, skippedCats, createdChs, skippedChs, failed, wired };
}
async function resetGuildLayout(guild) {
  const me = await guild.members.fetchMe();
  const botTop = me.roles.highest.position;
  const delCh = [], failCh = [], delRoles = [], keptRoles = [];
  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});
  const chans = [...guild.channels.cache.values()];
  // delete leaf channels first, categories last (so children don't get orphaned mid-loop)
  chans.sort((a, b) => (a.type === ChannelType.GuildCategory ? 1 : 0) - (b.type === ChannelType.GuildCategory ? 1 : 0));
  for (const ch of chans) {
    if (!ch.deletable) { failCh.push(`${ch.name} (no perm/hierarchy)`); continue; }
    try { await ch.delete('reset-layout wipe'); delCh.push(ch.name); } catch (e) { failCh.push(`${ch.name}: ${String(e.message || e).slice(0, 100)}`); }
    await new Promise(r => setTimeout(r, 250));
  }
  const roles = [...guild.roles.cache.values()].sort((a, b) => a.position - b.position);
  for (const role of roles) {
    if (role.id === guild.roles.everyone.id) { keptRoles.push('@everyone'); continue; }
    if (role.managed) { keptRoles.push(`${role.name} (managed/bot)`); continue; }
    if (role.position >= botTop) { keptRoles.push(`${role.name} (at/above bot)`); continue; }
    if (!role.editable) { keptRoles.push(`${role.name} (not editable)`); continue; }
    try { await role.delete('reset-layout wipe'); delRoles.push(role.name); } catch (e) { keptRoles.push(`${role.name} (delete failed)`); }
    await new Promise(r => setTimeout(r, 250));
  }
  return { delCh, failCh, delRoles, keptRoles };
}
const commands = [
  new SlashCommandBuilder().setName('link').setDescription('Link your Roblox account (type your Roblox username)')
    .addStringOption(o => o.setName('username').setDescription('Your Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('unlink').setDescription('Unlink your Roblox account'),
  new SlashCommandBuilder().setName('verify-status').setDescription('Check if you (or someone) is verified/linked')
    .addUserOption(o => o.setName('user').setDescription('Discord user (default: you)')),
  new SlashCommandBuilder().setName('profile').setDescription('Show linked Roblox profile + game data')
    .addUserOption(o => o.setName('user').setDescription('Discord user (default: you)')),
  new SlashCommandBuilder().setName('help').setDescription('Show all bot commands'),
  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
  new SlashCommandBuilder().setName('server-info').setDescription('Show Discord server info + link stats'),
  new SlashCommandBuilder().setName('avatar').setDescription('Show avatar')
    .addUserOption(o => o.setName('user').setDescription('User (default: you)')),
  new SlashCommandBuilder().setName('rank').setDescription('Show your (or someone) level rank')
    .addUserOption(o => o.setName('user').setDescription('User (default: you)')),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top chatters by level'),
  new SlashCommandBuilder().setName('value').setDescription('Look up RAP + demand for any item')
    .addStringOption(o => o.setName('type').setDescription('weapon, skin or finisher').setRequired(true).addChoices({ name: 'weapon', value: 'Weapon' }, { name: 'skin', value: 'WeaponSkin' }, { name: 'finisher', value: 'Finisher' }))
    .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('item').setDescription('Full item detail: icon, RAP, demand, owners, teleport, linked Discord')
    .addStringOption(o => o.setName('type').setDescription('weapon, skin or finisher').setRequired(true).addChoices({ name: 'weapon', value: 'Weapon' }, { name: 'skin', value: 'WeaponSkin' }, { name: 'finisher', value: 'Finisher' }))
    .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('owners').setDescription('Who owns this item + teleport + linked Discord')
    .addStringOption(o => o.setName('type').setDescription('weapon, skin or finisher').setRequired(true).addChoices({ name: 'weapon', value: 'Weapon' }, { name: 'skin', value: 'WeaponSkin' }, { name: 'finisher', value: 'Finisher' }))
    .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('online').setDescription('Show live game servers + online tracked players'),
  new SlashCommandBuilder().setName('teleport').setDescription('Get a join link for an online player')
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('search-skins').setDescription('Search skins (RAP + demand, use /item for owners/teleport)')
    .addStringOption(o => o.setName('query').setDescription('skin name').setRequired(true)),
  new SlashCommandBuilder().setName('search-weapons').setDescription('Search weapons (RAP + demand, use /item for owners/teleport)')
    .addStringOption(o => o.setName('query').setDescription('weapon name').setRequired(true)),
  new SlashCommandBuilder().setName('search-finishers').setDescription('Search finishers (RAP + demand, use /item for owners/teleport)')
    .addStringOption(o => o.setName('query').setDescription('finisher name').setRequired(true)),
  new SlashCommandBuilder().setName('search-player').setDescription('Search for player data (Roblox + cached game data)')
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('rules').setDescription('Show server rules (custom or Discord TOS)')
    .addStringOption(o => o.setName('mode').setDescription('custom or tos').addChoices({ name: 'custom', value: 'custom' }, { name: 'tos', value: 'tos' })),
  new SlashCommandBuilder().setName('apply').setDescription('Apply for a role (opens a private ticket with questions)')
    .addStringOption(o => o.setName('role').setDescription('Which role?').setRequired(true).addChoices(
      { name: 'Admin', value: 'admin' },
      { name: 'Content Creator', value: 'contentcreator' },
      { name: 'Tester', value: 'tester' },
      { name: 'Community Manager', value: 'communitymanager' },
      { name: 'Director', value: 'director' },
      { name: 'Creative Director', value: 'creativedirector' })),
  new SlashCommandBuilder().setName('ticket-close').setDescription('Close your open application ticket'),
  // staff
  new SlashCommandBuilder().setName('give-weapon').setDescription('[STAFF] Give a weapon in game')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addStringOption(o => o.setName('weapon').setDescription('Weapon name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('give-skin').setDescription('[STAFF] Give a skin in game')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addStringOption(o => o.setName('weapontype').setDescription('Base weapon type, e.g. RPG').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('skin').setDescription('Skin name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('give-finisher').setDescription('[STAFF] Give a finisher in game')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addStringOption(o => o.setName('finisher').setDescription('Finisher name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('player-data').setDescription('[STAFF] Full player data')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('game-kick').setDescription('[STAFF] Kick player in game')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('game-ban').setDescription('[STAFF] Ban player in game (+ Discord if linked)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .addBooleanOption(o => o.setName('syncdiscord').setDescription('Also ban linked Discord user? (default true)')),
  new SlashCommandBuilder().setName('game-unban').setDescription('[STAFF] Unban player in game (+ Discord)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('game-announce').setDescription('[STAFF] Announce to all game servers')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('message').setDescription('Message (max 200 chars)').setRequired(true)),
  new SlashCommandBuilder().setName('game-restart').setDescription('[STAFF] Restart all game servers (countdown then kick to rejoin)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addIntegerOption(o => o.setName('delay').setDescription('Countdown seconds 5-120 (default 30)').setMinValue(5).setMaxValue(120))
    .addStringOption(o => o.setName('reason').setDescription('Reason shown to players')),
  new SlashCommandBuilder().setName('game-luck').setDescription('[STAFF] Boost server luck on all game servers')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addIntegerOption(o => o.setName('mult').setDescription('Luck multiplier 1-10 (1 = reset to normal)').setRequired(true).setMinValue(1).setMaxValue(10))
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration 1-60 min (default 10)').setMinValue(1).setMaxValue(60)),
  new SlashCommandBuilder().setName('admin-abuse').setDescription('[STAFF] Fire a server-wide admin event')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('event').setDescription('Which event?').setRequired(true).addChoices(
      { name: 'Money Rain (+$2,500 everyone)', value: 'money-rain' },
      { name: 'Spin Party (+2 wheel spins everyone)', value: 'spin-party' },
      { name: 'Heal All', value: 'heal-all' },
      { name: 'Midnight (2 min)', value: 'midnight' },
      { name: 'Daybreak', value: 'daybreak' },
      { name: 'Disco Party (+10 spins, $50M, snake dance)', value: 'disco' },
      { name: 'EVERYTHING (all events at once)', value: 'all' }))
    .addIntegerOption(o => o.setName('duration').setDescription('Disco dance seconds 60-3600 (default 60)').setMinValue(60).setMaxValue(3600)),
  new SlashCommandBuilder().setName('game-money').setDescription('[STAFF] Give/Remove/Set Dinero')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('action').setDescription('Give/Remove/Set').setRequired(true).addChoices({ name: 'Give', value: 'Give' }, { name: 'Remove', value: 'Remove' }, { name: 'Set', value: 'Set' }))
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true)),
  new SlashCommandBuilder().setName('give-tokens').setDescription('[STAFF] Give/Remove/Set Tokens')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('action').setDescription('Give/Remove/Set').setRequired(true).addChoices({ name: 'Give', value: 'Give' }, { name: 'Remove', value: 'Remove' }, { name: 'Set', value: 'Set' }))
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('give-spins').setDescription('[STAFF] Give/Remove/Set Hourly or Wheel spins')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('type').setDescription('Hourly or Wheel spins').setRequired(true).addChoices({ name: 'Hourly', value: 'hourly' }, { name: 'Wheel', value: 'wheel' }))
    .addStringOption(o => o.setName('action').setDescription('Give/Remove/Set').setRequired(true).addChoices({ name: 'Give', value: 'Give' }, { name: 'Remove', value: 'Remove' }, { name: 'Set', value: 'Set' }))
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('give-all-weapon').setDescription('[STAFF] Give a weapon to EVERYONE online in game')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('weapon').setDescription('Weapon name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('give-all-skin').setDescription('[STAFF] Give a skin to EVERYONE online in game')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('weapontype').setDescription('Base weapon type, e.g. RPG').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('skin').setDescription('Skin name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('give-all-finisher').setDescription('[STAFF] Give a finisher to EVERYONE online in game')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('finisher').setDescription('Finisher name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('give-all-tokens').setDescription('[STAFF] Give Tokens to EVERYONE online in game')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addIntegerOption(o => o.setName('amount').setDescription('Token amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('give-all-spins').setDescription('[STAFF] Give spins to EVERYONE online in game')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('type').setDescription('Hourly or Wheel spins').setRequired(true).addChoices({ name: 'Hourly', value: 'hourly' }, { name: 'Wheel', value: 'wheel' }))
    .addIntegerOption(o => o.setName('amount').setDescription('Number of spins').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('add-emoji').setDescription('[STAFF] Give an emoji overhead to a Roblox user (persists)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('emoji').setDescription('Emoji, e.g. crown').setRequired(true))
    .addStringOption(o => o.setName('username').setDescription('Roblox username (username OR userid required)'))
    .addIntegerOption(o => o.setName('userid').setDescription('Roblox user ID (username OR userid required)')),
  new SlashCommandBuilder().setName('remove-emoji').setDescription('[STAFF] Remove an emoji overhead from a Roblox user (persists)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username (username OR userid required)'))
    .addIntegerOption(o => o.setName('userid').setDescription('Roblox user ID (username OR userid required)')),
  new SlashCommandBuilder().setName('force-pvp').setDescription('[STAFF] Force PvP ON for a player (locks toggle)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username (username OR userid required)'))
    .addIntegerOption(o => o.setName('userid').setDescription('Roblox user ID (username OR userid required)')),
  new SlashCommandBuilder().setName('unforce-pvp').setDescription('[STAFF] Release a forced PvP lock')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username (username OR userid required)'))
    .addIntegerOption(o => o.setName('userid').setDescription('Roblox user ID (username OR userid required)')),
  new SlashCommandBuilder().setName('force-show-emoji').setDescription('[STAFF] Force-show emoji (blocks ,hide)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username (username OR userid required)'))
    .addIntegerOption(o => o.setName('userid').setDescription('Roblox user ID (username OR userid required)')),
  new SlashCommandBuilder().setName('unforce-show-emoji').setDescription('[STAFF] Release a forced emoji lock')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username (username OR userid required)'))
    .addIntegerOption(o => o.setName('userid').setDescription('Roblox user ID (username OR userid required)')),
  new SlashCommandBuilder().setName('selfroles').setDescription('[STAFF] Post a reaction self-role message (up to 10 roles)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('setup').setDescription('Label | emoji | @role; separate lines with ; or new line (max 10)').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (default: here)')),
  new SlashCommandBuilder().setName('shortcut-add').setDescription('[STAFF] Map prefix+letters to a game command')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('command').setDescription('Which game command').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('letters').setDescription('Letters, e.g. gb for ,gb').setRequired(true))
    .addStringOption(o => o.setName('prefix').setDescription('Custom prefix (default: global)')),
  new SlashCommandBuilder().setName('shortcut-remove').setDescription('[STAFF] Delete a text shortcut')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('alias').setDescription('Alias with prefix, e.g. ,gb').setRequired(true)),
  new SlashCommandBuilder().setName('shortcut-list').setDescription('[STAFF] Show all text shortcuts')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false),
  new SlashCommandBuilder().setName('shortcut-prefix').setDescription('[STAFF] Set the default shortcut prefix')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('prefix').setDescription('Single symbol, e.g. ,').setRequired(true)),
  new SlashCommandBuilder().setName('sync-levels').setDescription('[STAFF] Grant level milestone roles to everyone from current levels'),
  new SlashCommandBuilder().setName('give-everything').setDescription('[STAFF] Give a player ALL weapons, skins and finishers')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addStringOption(o => o.setName('category').setDescription('What to grant (default: everything)')
      .addChoices(
        { name: 'Everything', value: 'everything' },
        { name: 'Weapons only', value: 'weapons' },
        { name: 'Skins only', value: 'skins' },
        { name: 'Finishers only', value: 'finishers' })),
  new SlashCommandBuilder().setName('kick').setDescription('[STAFF] Kick a Discord member (+ game if linked)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('ban').setDescription('[STAFF] Ban a Discord member (+ game if linked)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('unban').setDescription('[STAFF] Unban a Discord user (+ game)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('userid').setDescription('Discord user ID').setRequired(true)),
  new SlashCommandBuilder().setName('timeout').setDescription('[STAFF] Timeout a member (+ game note)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Minutes (1-40320)').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('untimeout').setDescription('[STAFF] Remove timeout')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)),
  new SlashCommandBuilder().setName('setup-welcome').setDescription('[STAFF] Set welcome channel with embeds')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addChannelOption(o => o.setName('channel').setDescription('Welcome channel').setRequired(true)),
  new SlashCommandBuilder().setName('setup-leave').setDescription('[STAFF] Set leave channel')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addChannelOption(o => o.setName('channel').setDescription('Leave channel').setRequired(true)),
  new SlashCommandBuilder().setName('setup-reports').setDescription('[STAFF] Set in-game reports channel')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addChannelOption(o => o.setName('channel').setDescription('Reports channel').setRequired(true)),
  new SlashCommandBuilder().setName('setup-verified').setDescription('[STAFF] Set role given when linked/verified')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addRoleOption(o => o.setName('role').setDescription('Verified role').setRequired(true)),
  new SlashCommandBuilder().setName('setup-levels').setDescription('[STAFF] Levels: set announcement channel / on-off')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addChannelOption(o => o.setName('channel').setDescription('Level-up channel (empty = same channel)'))
    .addBooleanOption(o => o.setName('enabled').setDescription('Enable levels?')),
  new SlashCommandBuilder().setName('test-welcome').setDescription('[STAFF] Send a test welcome here (debug welcome)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Pretend this user joined (default: you)')),
  new SlashCommandBuilder().setName('test-leave').setDescription('[STAFF] Send a test leave here (debug leave)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Pretend this user left (default: you)')),
  new SlashCommandBuilder().setName('linked-list').setDescription('[STAFF] Show recent linked accounts')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false),
  new SlashCommandBuilder().setName('set-rules').setDescription('[STAFF] Set custom server rules text')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('text').setDescription('Rules text (use \\n for new lines)').setRequired(true)),
  new SlashCommandBuilder().setName('send-tos').setDescription('[STAFF] Send Discord TOS embed here')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false),
  new SlashCommandBuilder().setName('setup-applications').setDescription('[STAFF] Setup application tickets (category + review channel + reviewer role)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addChannelOption(o => o.setName('category').setDescription('Category for ticket channels').setRequired(true).addChannelTypes(ChannelType.GuildCategory))
    .addChannelOption(o => o.setName('review').setDescription('Channel for applications + transcripts').setRequired(true))
    .addRoleOption(o => o.setName('reviewer').setDescription('Role that can VIEW ticket channels').setRequired(true)),
  new SlashCommandBuilder().setName('tickets').setDescription('[STAFF] List open application tickets')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false),
  new SlashCommandBuilder().setName('setup-roles').setDescription('[OWNER] Create the 14-role staff ladder (skips existing)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false),
  new SlashCommandBuilder().setName('setup-layout').setDescription('[STAFF] Build server channels from DSL description or baddies preset')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('preset').setDescription('Built-in preset (default: baddies when no description)').addChoices({ name: 'baddies', value: 'baddies' }))
    .addStringOption(o => o.setName('description').setDescription('DSL lines: "Category: X", "#channel (topic)", "Voice: Y"')),
  new SlashCommandBuilder().setName('reset-layout').setDescription('[OWNER] DANGER: wipe channels + below-bot roles, then apply layout')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('confirm').setDescription('Type CONFIRM exactly to proceed').setRequired(true))
    .addStringOption(o => o.setName('preset').setDescription('Preset to apply after wipe (default: baddies)').addChoices({ name: 'baddies', value: 'baddies' }))
    .addStringOption(o => o.setName('description').setDescription('Optional DSL layout to apply after wipe')),
  // ============ DISCORD SUITE (Carl-bot / Greed / Mimu style — grouped to stay under the 100-command cap) ============
  new SlashCommandBuilder().setName('mod').setDescription('🛡️ Moderation tools (Carl-style)')
    .addSubcommand(s => s.setName('purge').setDescription('[STAFF] Bulk delete messages (1-100)')
      .addIntegerOption(o => o.setName('amount').setDescription('How many? 1-100').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption(o => o.setName('user').setDescription('Only delete from this user')))
    .addSubcommand(s => s.setName('lock').setDescription('[STAFF] Lock this channel (@everyone cannot send)')
      .addChannelOption(o => o.setName('channel').setDescription('Channel (default: here)')))
    .addSubcommand(s => s.setName('unlock').setDescription('[STAFF] Unlock this channel')
      .addChannelOption(o => o.setName('channel').setDescription('Channel (default: here)')))
    .addSubcommand(s => s.setName('slowmode').setDescription('[STAFF] Set slowmode 0-21600s (0 = off)')
      .addIntegerOption(o => o.setName('seconds').setDescription('Seconds').setRequired(true).setMinValue(0).setMaxValue(21600))
      .addChannelOption(o => o.setName('channel').setDescription('Channel (default: here)')))
    .addSubcommand(s => s.setName('nick').setDescription('[STAFF] Change a member nickname')
      .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption(o => o.setName('nickname').setDescription('New nickname (empty = reset)').setRequired(true)))
    .addSubcommand(s => s.setName('warn').setDescription('[STAFF] Warn a member (logged + DMd)')
      .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(s => s.setName('warnings').setDescription('Show warnings for a member')
      .addUserOption(o => o.setName('user').setDescription('Member (default: you)')))
    .addSubcommand(s => s.setName('clearwarns').setDescription('[STAFF] Clear all warnings for a member')
      .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
    .addSubcommand(s => s.setName('mute').setDescription('[STAFF] Mute via timeout (e.g. 10m, 1h, 1d)')
      .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption(o => o.setName('duration').setDescription('10m / 1h / 1d (max 28d)').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason')))
    .addSubcommand(s => s.setName('unmute').setDescription('[STAFF] Remove timeout')
      .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))),
  new SlashCommandBuilder().setName('who').setDescription('🔍 Info cards — user, server, role, channel, bot')
    .addSubcommand(s => s.setName('user').setDescription('Pretty user card (join dates, roles, perms)')
      .addUserOption(o => o.setName('user').setDescription('User (default: you)')))
    .addSubcommand(s => s.setName('server').setDescription('Pretty server card (counts, boosts, channels)'))
    .addSubcommand(s => s.setName('role').setDescription('Role info card')
      .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(s => s.setName('channel').setDescription('Channel info card')
      .addChannelOption(o => o.setName('channel').setDescription('Channel (default: here)')))
    .addSubcommand(s => s.setName('bot').setDescription('Bot stats (uptime, ping, commands, guilds)'))
    .addSubcommand(s => s.setName('banner').setDescription('Show a user banner')
      .addUserOption(o => o.setName('user').setDescription('User (default: you)'))),
  new SlashCommandBuilder().setName('fun').setDescription('💅 Social + fun (Mimu-style)')
    .addSubcommand(s => s.setName('hug').setDescription('Hug someone').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('pat').setDescription('Pat someone').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('slap').setDescription('Slap someone').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('kiss').setDescription('Kiss someone').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('cuddle').setDescription('Cuddle someone').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('cry').setDescription('Cryyy'))
    .addSubcommand(s => s.setName('dance').setDescription('Hit the dance floor'))
    .addSubcommand(s => s.setName('bonk').setDescription('Bonk someone').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('ship').setDescription('Ship two users 💘')
      .addUserOption(o => o.setName('user1').setDescription('First cutie').setRequired(true))
      .addUserOption(o => o.setName('user2').setDescription('Second cutie')))
    .addSubcommand(s => s.setName('8ball').setDescription('Ask the magic 8-ball')
      .addStringOption(o => o.setName('question').setDescription('Your question').setRequired(true)))
    .addSubcommand(s => s.setName('truth').setDescription('Random truth'))
    .addSubcommand(s => s.setName('dare').setDescription('Random dare'))
    .addSubcommand(s => s.setName('roast').setDescription('Lightly roast someone')
      .addUserOption(o => o.setName('user').setDescription('Victim')))
    .addSubcommand(s => s.setName('compliment').setDescription('Hype someone up')
      .addUserOption(o => o.setName('user').setDescription('Cutie')))
    .addSubcommand(s => s.setName('rps').setDescription('Rock paper scissors')
      .addStringOption(o => o.setName('choice').setDescription('Your move').setRequired(true).addChoices({ name: 'rock', value: 'rock' }, { name: 'paper', value: 'paper' }, { name: 'scissors', value: 'scissors' })))
    .addSubcommand(s => s.setName('coinflip').setDescription('Flip a coin'))
    .addSubcommand(s => s.setName('dice').setDescription('Roll a d6')),
  new SlashCommandBuilder().setName('coins').setDescription('💰 Baddie coins economy (Greed/Mimu-style)')
    .addSubcommand(s => s.setName('balance').setDescription('Wallet + bank balance')
      .addUserOption(o => o.setName('user').setDescription('User (default: you)')))
    .addSubcommand(s => s.setName('daily').setDescription('Claim 500 daily coins (24h cooldown)'))
    .addSubcommand(s => s.setName('weekly').setDescription('Claim 2500 weekly coins (7d cooldown)'))
    .addSubcommand(s => s.setName('work').setDescription('Work for 150-400 coins (1h cooldown)'))
    .addSubcommand(s => s.setName('beg').setDescription('Beg for 10-100 coins (45s cooldown)'))
    .addSubcommand(s => s.setName('crime').setDescription('Risky crime: win 300-800 or get fined (10m cooldown)'))
    .addSubcommand(s => s.setName('rob').setDescription('Rob someone (needs 200+, 1h cooldown)')
      .addUserOption(o => o.setName('user').setDescription('Victim').setRequired(true)))
    .addSubcommand(s => s.setName('pay').setDescription('Pay coins to someone')
      .addUserOption(o => o.setName('user').setDescription('Cutie').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('deposit').setDescription('Wallet → bank (safe from rob)')
      .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('withdraw').setDescription('Bank → wallet')
      .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('slots').setDescription('Bet coins on slots (3x win)')
      .addIntegerOption(o => o.setName('bet').setDescription('Bet 10-5000').setRequired(true).setMinValue(10).setMaxValue(5000)))
    .addSubcommand(s => s.setName('top').setDescription('Richest baddies leaderboard')),
  new SlashCommandBuilder().setName('tag').setDescription('🏷️ Custom commands (Carl-style tags)')
    .addSubcommand(s => s.setName('add').setDescription('[STAFF] Create a tag')
      .addStringOption(o => o.setName('name').setDescription('lowercase, no spaces').setRequired(true))
      .addStringOption(o => o.setName('content').setDescription('Reply text (max 1500)').setRequired(true)))
    .addSubcommand(s => s.setName('use').setDescription('Use a tag')
      .addStringOption(o => o.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('list').setDescription('List all tags'))
    .addSubcommand(s => s.setName('remove').setDescription('[STAFF] Delete a tag')
      .addStringOption(o => o.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true))),
  new SlashCommandBuilder().setName('giveaway').setDescription('🎉 Giveaways (Carl-style)')
    .addSubcommand(s => s.setName('start').setDescription('[STAFF] Start a giveaway')
      .addStringOption(o => o.setName('prize').setDescription('What is the prize?').setRequired(true))
      .addIntegerOption(o => o.setName('winners').setDescription('Winners 1-10 (default 1)').setMinValue(1).setMaxValue(10))
      .addStringOption(o => o.setName('duration').setDescription('e.g. 10m, 1h, 1d').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Channel (default: here)')))
    .addSubcommand(s => s.setName('end').setDescription('[STAFF] End a giveaway now')
      .addStringOption(o => o.setName('messageid').setDescription('Giveaway message ID').setRequired(true)))
    .addSubcommand(s => s.setName('reroll').setDescription('[STAFF] Re-pick winners')
      .addStringOption(o => o.setName('messageid').setDescription('Giveaway message ID').setRequired(true))),
  new SlashCommandBuilder().setName('suggest').setDescription('💡 Send a suggestion')
    .addStringOption(o => o.setName('text').setDescription('Your idea (max 500)').setRequired(true)),
  new SlashCommandBuilder().setName('suggestions').setDescription('💡 Suggestion queue (Carl-style)')
    .addSubcommand(s => s.setName('setup').setDescription('[STAFF] Set suggestion channel')
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s => s.setName('accept').setDescription('[STAFF] Accept a suggestion')
      .addIntegerOption(o => o.setName('id').setDescription('Suggestion #').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Optional note')))
    .addSubcommand(s => s.setName('deny').setDescription('[STAFF] Deny a suggestion')
      .addIntegerOption(o => o.setName('id').setDescription('Suggestion #').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Optional note')))
    .addSubcommand(s => s.setName('list').setDescription('[STAFF] List pending suggestions')),
  new SlashCommandBuilder().setName('poll').setDescription('📊 Strawpoll (reactions, up to 4 options)')
    .addStringOption(o => o.setName('question').setDescription('Question').setRequired(true))
    .addStringOption(o => o.setName('option1').setDescription('Option 1').setRequired(true))
    .addStringOption(o => o.setName('option2').setDescription('Option 2').setRequired(true))
    .addStringOption(o => o.setName('option3').setDescription('Option 3'))
    .addStringOption(o => o.setName('option4').setDescription('Option 4')),
  new SlashCommandBuilder().setName('send').setDescription('📣 Staff send tools')
    .addSubcommand(s => s.setName('say').setDescription('[STAFF] Say something as the bot')
      .addStringOption(o => o.setName('text').setDescription('Message (max 1500)').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Channel (default: here)')))
    .addSubcommand(s => s.setName('embed').setDescription('[STAFF] Send a pretty embed')
      .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Body (\\n = new line)').setRequired(true))
      .addStringOption(o => o.setName('color').setDescription('pink, gold, mint, purple, blue, red'))
      .addStringOption(o => o.setName('image').setDescription('Image URL (optional)'))
      .addChannelOption(o => o.setName('channel').setDescription('Channel (default: here)'))),
  new SlashCommandBuilder().setName('remind').setDescription('⏰ Remind yourself (e.g. 10m drink water)')
    .addStringOption(o => o.setName('when').setDescription('10s / 5m / 2h / 1d').setRequired(true))
    .addStringOption(o => o.setName('text').setDescription('What to remind?').setRequired(true)),
  new SlashCommandBuilder().setName('config').setDescription('⚙️ Server config (logs, autoroles, suggestions)')
    .addSubcommand(s => s.setName('set-logs').setDescription('[STAFF] Mod-log channel (deletes, edits, warns, mutes)')
      .addChannelOption(o => o.setName('channel').setDescription('Channel (empty = disable)')))
    .addSubcommand(s => s.setName('autorole-add').setDescription('[STAFF] Auto-give role on join')
      .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(s => s.setName('autorole-remove').setDescription('[STAFF] Remove an autorole')
      .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(s => s.setName('autorole-list').setDescription('List join autoroles'))
    .addSubcommand(s => s.setName('set-suggestions').setDescription('[STAFF] Alias for suggestions channel')
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true))),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('Slash commands registered to guild ' + GUILD_ID);
}

// ---------- helpers ----------
// 🌸 BADDIE THEME — Greed / Carl-bot / Mimu style polish (one place to restyle everything)
const THEME = {
  PINK: 0xff5da2, HOT: 0xff3d7f, PURPLE: 0xc026d3, VIOLET: 0x8b5cf6,
  MINT: 0x57f287, GOLD: 0xffd700, BLUE: 0x5aaaff, RED: 0xed4245,
  DARK: 0x2b2d31, BLURPLE: 0x5865f2,
  FOOTER: '🌸 Summer Baddies',
  DIV: '─────────────────────',
};
function embedBase(title, desc, color = THEME.PINK) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc || '')
    .setColor(color)
    .setTimestamp()
    .setFooter({ text: THEME.FOOTER });
}
function baddieEmbed(title, desc, color = THEME.PINK) { return embedBase(title, desc, color); }
function okEmbed(title, desc) { return embedBase('✅ ' + title, desc, THEME.MINT); }
function errEmbed(desc) { return embedBase('❌ Something went wrong', desc, THEME.RED); }
function econEmbed(title, desc) { return embedBase('💰 ' + title, desc, THEME.GOLD); }
function fmtCoins(n) {
  n = Math.floor(Number(n) || 0);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
function getEcon(id) {
  if (!db.economy[id]) db.economy[id] = { wallet: 0, bank: 0, lastDaily: 0, lastWeekly: 0, lastWork: 0, lastCrime: 0, lastBeg: 0 };
  return db.economy[id];
}
function msToDur(ms) {
  if (ms <= 0) return 'now';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function parseDuration(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
  const ms = n * mult;
  if (ms < 10000 || ms > 30 * 86400000) return null;
  return ms;
}
async function modlogSend(guild, embed) {
  try {
    const id = db.modlog && db.modlog.channelId;
    if (!id) return;
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (ch && ch.isTextBased()) await ch.send({ embeds: [embed] }).catch(() => {});
  } catch {}
}
async function requireStaff(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (await isStaffHigherThanBot(member)) return member;
  await interaction.reply({ content: '❌ You need a role **higher than the bot** to use this.', ephemeral: true });
  return null;
}
// ---------- pretty help (Carl/Mimu style categories + select menu) ----------
function helpMenuRow(current) {
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('help_cat').setPlaceholder('Pick a category…').addOptions(
      { label: 'Home', value: 'home', emoji: '🌸', default: current === 'home' },
      { label: 'Roblox + Trading', value: 'roblox', emoji: '🎮', default: current === 'roblox' },
      { label: 'Moderation', value: 'mod', emoji: '🛡️', default: current === 'mod' },
      { label: 'Info + Utility', value: 'info', emoji: '🔍', default: current === 'info' },
      { label: 'Coins + Economy', value: 'coins', emoji: '💰', default: current === 'coins' },
      { label: 'Fun + Social', value: 'fun', emoji: '💅', default: current === 'fun' },
      { label: 'Tags, Polls, Giveaways', value: 'extra', emoji: '🎉', default: current === 'extra' },
      { label: 'Staff Setup', value: 'staff', emoji: '⚙️', default: current === 'staff' },
    )
  )];
}
function buildHelpEmbed(cat = 'home') {
  const D = THEME.DIV;
  if (cat === 'roblox') return baddieEmbed('🎮 Roblox + Trading',
    `Link once, then everything syncs both ways.\n${D}\n` +
    `🔗 \`/link\` \`/unlink\` \`/verify-status\` \`/profile\`\n` +
    `💎 \`/value\` \`/item\` \`/owners\` — RAP + demand + owners + teleport + Discord\n` +
    `🟢 \`/online\` \`/teleport\` — live servers + join links\n` +
    `🔎 \`/search-weapons\` \`/search-skins\` \`/search-finishers\` \`/search-player\`\n` +
    `${D}\nStaff game panel: \`/give-weapon\` \`/give-skin\` \`/give-finisher\` \`/give-everything\` \`/game-kick\` \`/game-ban\` \`/game-money\` \`/give-tokens\` \`/give-spins\` \`/game-announce\` \`/game-restart\` \`/game-luck\` \`/admin-abuse\``);
  if (cat === 'mod') return embedBase('🛡️ Moderation', `All log to \`/config set-logs\` when set.\n${D}\n` +
    `🧹 \`/mod purge\` — bulk delete 1-100 (+ optional user filter)\n` +
    `🔒 \`/mod lock\` \`/mod unlock\` — channel lockdown\n` +
    `🐢 \`/mod slowmode\` — 0-21600s\n` +
    `✏️ \`/mod nick\` — change nickname\n` +
    `⚠️ \`/mod warn\` \`/mod warnings\` \`/mod clearwarns\` — warn system\n` +
    `🔇 \`/mod mute\` \`/mod unmute\` — timeouts (10m, 1h, 1d)\n` +
    `+ classic \`/kick\` \`/ban\` \`/unban\` \`/timeout\` \`/untimeout\` (game-sync when linked)`, THEME.RED);
  if (cat === 'info') return embedBase('🔍 Info + Utility', `${D}\n` +
    `👤 \`/who user\` — join dates, roles, perms, boost\n` +
    `🏠 \`/who server\` — counts, boosts, channels, linked stats\n` +
    `🎭 \`/who role\` \`channel\` \`bot\` \`banner\`\n` +
    `⏰ \`/remind\` — 10s / 5m / 2h / 1d reminders via DM\n` +
    `📣 \`/send say\` \`/send embed\` — staff pretty announcements\n` +
    `🏷️ \`/tag add|use|list|remove\` — Carl-style custom commands`, THEME.BLUE);
  if (cat === 'coins') return econEmbed('Baddie Coins — Greed/Mimu style',
    `Wallet is spendable • bank is safe from rob.\n${D}\n` +
    `👛 \`/coins balance\` \`top\`\n` +
    `🎁 \`/coins daily\` (500/24h) \`/weekly\` (2500/7d)\n` +
    `💼 \`/coins work\` (1h) 🙏 \`/beg\` (45s) 🎲 \`/crime\` (10m)\n` +
    `🥷 \`/coins rob\` — steal wallet cash (1h, fails = fine)\n` +
    `🤝 \`/coins pay\` 🏦 \`deposit\` \`withdraw\`\n` +
    `🎰 \`/coins slots\` — bet 10-5000, 3x on triple`);
  if (cat === 'fun') return embedBase('💅 Fun + Social — Mimu style', `${D}\n` +
    `🤗 \`/fun hug|pat|cuddle|kiss|slap|bonk|cry|dance\` — cute gifs with mentions\n` +
    `💘 \`/fun ship\` — love % + bar\n` +
    `🔮 \`/fun 8ball\` ❓ \`truth\` 🔥 \`dare\` 😈 \`roast\` 💖 \`compliment\`\n` +
    `✂️ \`/fun rps\` 🪙 \`coinflip\` 🎲 \`dice\`\n` +
    `🏆 \`/rank\` \`/leaderboard\` — chat levels (XP every 60s)`, THEME.PURPLE);
  if (cat === 'extra') return embedBase('🎉 Tags • Polls • Giveaways • Suggestions', `${D}\n` +
    `🏷️ \`/tag\` — reusable answers (rules, links, FAQ)\n` +
    `📊 \`/poll\` — 2-4 options, auto reactions\n` +
    `🎉 \`/giveaway start|end|reroll\` — timed joins with Enter button\n` +
    `💡 \`/suggest\` → votes 👍👎 → \`/suggestions accept|deny|list\`\n` +
    `🎭 \`/selfroles\` — reaction roles (10 per message)`, THEME.GOLD);
  if (cat === 'staff') return embedBase('⚙️ Staff Setup', `${D}\n` +
    `👋 \`/setup-welcome\` \`/setup-leave\` \`/test-welcome\` \`/test-leave\`\n` +
    `🚨 \`/setup-reports\` ✅ \`/setup-verified\` 📈 \`/setup-levels\` \`/sync-levels\`\n` +
    `🎟️ \`/setup-applications\` \`/tickets\` \`/apply\`\n` +
    `📜 \`/set-rules\` \`/rules\` \`/send-tos\`\n` +
    `🧱 \`/setup-roles\` (owner ladder) 🏗️ \`/setup-layout\` 💥 \`/reset-layout\` (owner)\n` +
    `📝 \`/config set-logs\` 👥 \`autorole-*\` 💡 \`set-suggestions\`\n` +
    `⌨️ \`/shortcut-add|remove|list|prefix\` (game text shortcuts)` + shortcutsHelp(), THEME.DARK);
  return baddieEmbed('🌸 Summer Baddies — pick a category below',
    `Roblox + Discord in one cute bot — trading values, levels, tickets, **plus** Carl-style mod, Greed-style coins & Mimu-style fun.\n${D}\n` +
    `🎮 **Roblox + Trading** — link, values, owners, teleport\n` +
    `🛡️ **Moderation** — purge, lock, warns, mutes + logs\n` +
    `🔍 **Info + Utility** — who-cards, remind, send, tags\n` +
    `💰 **Coins** — daily, work, crime, rob, slots\n` +
    `💅 **Fun** — hugs, ship, 8ball, truth/dare\n` +
    `🎉 **Extras** — polls, giveaways, suggestions, selfroles\n` +
    `${D}\nUse the menu below 👇 • \`/profile\` \`/value\` \`/coins balance\` to start!`);
}
// ---------- fun helpers (Mimu-style gifs) ----------
async function waifuGif(action) {
  try {
    const r = await fetch('https://api.waifu.pics/sfw/' + action);
    const j = await r.json();
    if (j && j.url) return j.url;
  } catch {}
  return null;
}
const EIGHTBALL = ['It is certain 💅', 'Without a doubt ✨', 'Yes baddie! 💖', 'Most likely 🔥', 'Ask again later 👀', 'Cannot predict now 🌙', 'Do not count on it 💔', 'Very doubtful 🙅‍♀️', 'Signs point to yes 🌸', 'Nah girl 😭'];
const TRUTHS = ['What is your biggest crush rn? 👀', 'What is the most embarrassing thing in your camera roll? 📸', 'Who is the last person you stalked? 🕵️', 'What lie have you told to get out of plans? 😭', 'What is your toxic trait? 💅'];
const DARES = ['Send your last emoji + no context 🌚', 'Compliment the person above you 💖', 'Change your nickname to Baddie for 10 min 💅', 'Post your lockscreen in media 📸', 'Talk in all caps for 5 messages 📣'];
const ROASTS = ['ur vibe is buffering... 🛜😭', 'babe ur the loading screen, not the main character 💅', 'u bring NPC energy to a baddie server ✨', 'ur comebacks need a software update 📲'];
const COMPS = ['ur literally THAT girl 💅✨', 'main character energy only 🌸', 'u ate and left no crumbs 😍', 'ur vibe makes the server better 💖'];
// ---------- giveaway helpers ----------
function pickWinners(g, n) {
  const pool = [...(g.entrants || [])];
  const out = [];
  while (pool.length && out.length < n) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}
function giveawayEmbed(g) {
  const secs = Math.max(0, Math.floor((g.endsAt - Date.now()) / 1000));
  return embedBase('🎉 ' + g.prize, `Hosted by <@${g.by}>\nWinners: **${g.winners}** • Ends <t:${Math.floor(g.endsAt / 1000)}:R>\nEntries: **${(g.entrants || []).length}**\n\nHit **Enter** below! 💅`, THEME.GOLD)
    .setFooter({ text: `🌸 Ends in ${msToDur(secs * 1000)} • ID ${g.messageId || ''}` });
}
async function endGiveaway(guild, messageId, reroll = false) {
  const g = db.giveaways[messageId];
  if (!g) return null;
  if (g.ended && !reroll) return g;
  const winners = pickWinners(g, g.winners || 1);
  g.ended = true; g.winnerIds = winners; save();
  try {
    const ch = await guild.channels.fetch(g.channelId).catch(() => null);
    if (ch && ch.isTextBased()) {
      const msg = await ch.messages.fetch(messageId).catch(() => null);
      const end = embedBase(`🎉 ${g.prize} — ENDED`, winners.length ? `Congrats ${winners.map(id => `<@${id}>`).join(', ')}! 🎊\nHosted by <@${g.by}> • ${(g.entrants || []).length} entries` : `No entries 😭\nHosted by <@${g.by}>`, THEME.GOLD);
      if (msg) await msg.edit({ embeds: [end], components: [] }).catch(() => {});
      if (!reroll) await ch.send({ content: winners.length ? `🎉 Congrats ${winners.map(id => `<@${id}>`).join(', ')}! You won **${g.prize}**!` : `Giveaway **${g.prize}** ended with no entries.` }).catch(() => {});
      else if (winners.length) await ch.send({ content: `🔁 Re-rolled **${g.prize}**: congrats ${winners.map(id => `<@${id}>`).join(', ')}!` }).catch(() => {});
    }
  } catch {}
  return g;
}

// FIXED welcome/leave: use fetch (not cache), validate perms, log errors.
async function resolveSendChannel(channelId) {
  if (!channelId) return { ch: null, err: 'No channel configured. Staff: use /setup-welcome or /setup-leave.' };
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) return { ch: null, err: `Channel <#${channelId}> is not a text channel.` };
    return { ch, err: null };
  } catch (e) {
    return { ch: null, err: `Cannot see channel <#${channelId}>: ${e.message}. Check bot has View Channel + Send Messages + Embed Links there.` };
  }
}
function welcomeEmbed(member) {
  const e = baddieEmbed('🌸 Welcome, ' + member.user.username + '!',
    `Hey baddie, welcome to **${member.guild.name}**! 💅\n${THEME.DIV}\n` +
    `🔗 Link Roblox: \`/link <RobloxUsername>\` → type \`!verify CODE\` in Summer Baddies\n` +
    `✅ Then \`/verify-status\` to grab the Verified role\n` +
    `📜 Read \`/rules\` • 💰 Try \`/coins daily\` • 🎮 Check \`/value\`\n` +
    `${THEME.DIV}\nHave fun cutie! 🌸`)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }));
  e.data.footer = { text: `🌸 Summer Baddies • Member #${member.guild.memberCount}` };
  return e;
}
async function sendWelcome(member) {
  const chId = db.settings.welcomeChannel || process.env.WELCOME_CHANNEL_ID;
  const { ch, err } = await resolveSendChannel(chId);
  if (!ch) { console.warn('[welcome] skip:', err); return { ok: false, err }; }
  try { await ch.send({ embeds: [welcomeEmbed(member)] }); return { ok: true }; }
  catch (e) { console.error('[welcome] send failed:', e.message); return { ok: false, err: e.message }; }
}
async function sendLeave(member) {
  const chId = db.settings.leaveChannel || process.env.LEAVE_CHANNEL_ID;
  const { ch, err } = await resolveSendChannel(chId);
  if (!ch) { console.warn('[leave] skip:', err); return { ok: false, err }; }
  try {
    await ch.send({ embeds: [embedBase('👋 ' + (member.user?.username || 'Someone') + ' left', `We'll miss you baddie! 💔\n**${member.guild.name}** now has **${member.guild.memberCount}** members.`, 0x808080)] });
    return { ok: true };
  } catch (e) { console.error('[leave] send failed:', e.message); return { ok: false, err: e.message }; }
}

// ---------- application tickets ----------
function appQuestionEmbed(roleKey, idx) {
  const role = applications[roleKey];
  const q = role.questions[idx];
  const total = role.questions.length;
  let desc = `**Question ${idx + 1}/${total}:**\n${q.q}`;
  if (q.type === 'text') desc += `\n\n_✍️ Type your answer in this channel (${q.min || 1}-${q.max || 1000} characters)._`;
  if (q.type === 'yesno') desc += `\n\n_Click **Yes** or **No** below._`;
  if (q.type === 'choice') desc += `\n\n_Click one option below._`;
  desc += `\n\n_You have 10 minutes per question._`;
  return new EmbedBuilder().setTitle(`📝 ${role.label} Application`).setDescription(desc)
    .setColor(role.color || 0xff5da2).setFooter({ text: `Question ${idx + 1} of ${total}` }).setTimestamp();
}
function appQuestionComponents(q) {
  if (q.type === 'yesno') {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('app_yes').setLabel('Yes').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('app_no').setLabel('No').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('app_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary))];
  }
  if (q.type === 'choice') {
    const row = new ActionRowBuilder();
    (q.options || []).slice(0, 4).forEach((opt, i) => row.addComponents(
      new ButtonBuilder().setCustomId('app_opt_' + i).setLabel(String(opt).slice(0, 80)).setStyle(ButtonStyle.Primary)));
    return [row, new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('app_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary))];
  }
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('app_cancel').setLabel('Cancel application').setStyle(ButtonStyle.Secondary))];
}
function armTicketTimeout(channelId) {
  if (ticketTimeouts.has(channelId)) clearTimeout(ticketTimeouts.get(channelId));
  ticketTimeouts.set(channelId, setTimeout(() => closeTicket(channelId, 'Timed out — 10 minutes passed with no answer.', { log: true }), QUESTION_TIMEOUT_MS));
}
async function askTicketQuestion(channelId) {
  const t = db.tickets[channelId];
  if (!t || t.status !== 'open') return;
  const role = applications[t.role];
  if (!role) return;
  if (t.qIndex >= role.questions.length) return completeTicket(channelId);
  const q = role.questions[t.qIndex];
  let channel = null;
  try { channel = await client.channels.fetch(channelId); } catch {}
  if (!channel || !channel.isTextBased()) return closeTicket(channelId, 'Ticket channel was deleted.', { silent: true, log: false });
  await channel.send({ content: `<@${t.discordId}>`, embeds: [appQuestionEmbed(t.role, t.qIndex)], components: appQuestionComponents(q) }).catch(() => {});
  armTicketTimeout(channelId);
}
async function answerTicket(channelId, userId, answer) {
  const t = db.tickets[channelId];
  if (!t || t.status !== 'open' || t.discordId !== userId) return false;
  const role = applications[t.role];
  const q = role && role.questions[t.qIndex];
  if (!q) return false;
  t.answers.push({ q: q.q, a: String(answer).slice(0, 1000) });
  t.qIndex++;
  t.lastActivity = Date.now();
  save();
  if (t.qIndex >= role.questions.length) return completeTicket(channelId);
  return askTicketQuestion(channelId);
}
function ticketTranscriptEmbed(t, title, color) {
  const emb = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp()
    .setDescription(`Applicant: <@${t.discordId}> (${t.tag || '?'})\nRole: **${t.roleLabel}**\nTicket: <#${t.channelId}>`);
  const fields = (t.answers || []).map((x, i) => ({ name: `${i + 1}. ${x.q}`.slice(0, 256), value: (String(x.a).slice(0, 1024) || '—') }));
  if (fields.length) emb.addFields(fields);
  else emb.setDescription((emb.data.description || '') + '\n_No answers given._');
  return emb;
}
async function completeTicket(channelId) {
  const t = db.tickets[channelId];
  if (!t) return;
  t.status = 'answered';
  save();
  if (ticketTimeouts.has(channelId)) { clearTimeout(ticketTimeouts.get(channelId)); ticketTimeouts.delete(channelId); }
  let channel = null;
  try { channel = await client.channels.fetch(channelId); } catch {}
  if (channel && channel.isTextBased()) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('app_accept').setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('app_deny').setLabel('Deny').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('app_close').setLabel('Close').setStyle(ButtonStyle.Secondary));
    await channel.send({ embeds: [embedBase('✅ Application submitted!', `Thanks <@${t.discordId}>! Staff will review your **${t.roleLabel}** application here soon.\nPlease be patient and do not ping staff.`, 0x57f287)], components: [row] }).catch(() => {});
  }
  const reviewId = db.settings.ticketReviewChannelId;
  if (reviewId) {
    try {
      const rc = await client.channels.fetch(reviewId);
      if (rc && rc.isTextBased()) await rc.send({ content: `<@&${db.settings.ticketReviewerRoleId}> new application`, embeds: [ticketTranscriptEmbed(t, `📥 ${t.roleLabel} application — ${t.tag}`, (applications[t.role] || {}).color || 0xff5da2)] });
    } catch {}
  }
}
async function closeTicket(channelId, reason, opts = {}) {
  const t = db.tickets[channelId];
  if (ticketTimeouts.has(channelId)) { clearTimeout(ticketTimeouts.get(channelId)); ticketTimeouts.delete(channelId); }
  if (t) { t.status = 'closed'; t.closeReason = reason; save(); }
  let channel = null;
  try { channel = await client.channels.fetch(channelId); } catch {}
  if (!channel || !channel.isTextBased()) { if (db.tickets[channelId]) { delete db.tickets[channelId]; save(); } return; }
  if (!opts.silent) await channel.send({ embeds: [embedBase('🔒 Ticket closed', reason || 'Closed.', 0x808080)] }).catch(() => {});
  if (t && t.answers && t.answers.length && opts.log !== false && db.settings.ticketReviewChannelId) {
    try {
      const rc = await client.channels.fetch(db.settings.ticketReviewChannelId);
      if (rc && rc.isTextBased()) await rc.send({ embeds: [ticketTranscriptEmbed(t, `🔒 Ticket closed — ${t.roleLabel} — ${t.tag}`, 0x808080)] });
    } catch {}
  }
  setTimeout(async () => {
    try { const ch = await client.channels.fetch(channelId); if (ch) await ch.delete('Ticket closed: ' + String(reason || '').slice(0, 100)); } catch {}
    if (db.tickets[channelId]) { delete db.tickets[channelId]; save(); }
  }, 8000);
}
async function startTicket(interaction, roleKey) {
  const role = applications[roleKey];
  if (!role) return interaction.reply({ content: 'Unknown role.', ephemeral: true });
  if (!db.settings.ticketCategoryId || !db.settings.ticketReviewerRoleId)
    return interaction.reply({ content: '❌ Applications are not set up yet. Staff: use `/setup-applications` first.', ephemeral: true });
  const open = Object.values(db.tickets).find(t => t.discordId === interaction.user.id && t.status === 'open');
  if (open) return interaction.reply({ content: `❌ You already have an open ticket: <#${open.channelId}>. Finish or cancel it first.`, ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  let channel = null;
  try {
    channel = await interaction.guild.channels.create({
      name: ('apply-' + interaction.user.username).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90) || 'apply',
      type: ChannelType.GuildText,
      parent: db.settings.ticketCategoryId,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: db.settings.ticketReviewerRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ],
      topic: `${role.label} application • ${interaction.user.tag}`,
    });
  } catch (e) {
    return interaction.editReply('❌ Could not create your ticket channel: ' + String(e.message || e).slice(0, 200) + '\nCheck I have Manage Channels + the category still exists.');
  }
  db.tickets[channel.id] = { channelId: channel.id, discordId: interaction.user.id, tag: interaction.user.tag, role: roleKey, roleLabel: role.label, qIndex: 0, answers: [], status: 'open', createdAt: Date.now(), lastActivity: Date.now() };
  save();
  await channel.send({ embeds: [embedBase(`📝 ${role.label} Application`, `Hey <@${interaction.user.id}>! ${role.intro}\n\nAnswer each question below — **10 minutes per question**. Good luck! 💅`, role.color || 0xff5da2)] }).catch(() => {});
  await interaction.editReply(`✅ Ticket opened: <#${channel.id}>\nAnswer each question there — **10 minutes per question**.`);
  await askTicketQuestion(channel.id);
}

// ---------- bot events ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const w = db.settings.welcomeChannel || process.env.WELCOME_CHANNEL_ID;
  const l = db.settings.leaveChannel || process.env.LEAVE_CHANNEL_ID;
  const r = db.settings.reportsChannel || process.env.REPORTS_CHANNEL_ID;
  for (const [label, id] of [['welcome', w], ['leave', l], ['reports', r]]) {
    if (!id) { console.warn(`[${label}] no channel configured`); continue; }
    try {
      const ch = await client.channels.fetch(id);
      if (!ch?.isTextBased()) console.warn(`[${label}] <#${id}> is not text-based`);
      else console.log(`[${label}] OK -> #${ch.name} (${id})`);
    } catch (e) { console.warn(`[${label}] cannot fetch <#${id}>: ${e.message} — fix perms / ID`); }
  }
  if (db.settings.ticketCategoryId) {
    try { const c = await client.channels.fetch(db.settings.ticketCategoryId); console.log(`[tickets] category OK -> ${c.name}`); }
    catch (e) { console.warn('[tickets] bad category: ' + e.message); }
  } else console.warn('[tickets] not configured — staff: use /setup-applications');
  // prune stale servers/inventories every 5 min
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [jid, s] of Object.entries(db.servers)) {
      if (now - (s.at || 0) > 5 * 60 * 1000) { delete db.servers[jid]; changed = true; }
    }
    if (changed) save();
  }, 5 * 60 * 1000);
  // giveaway auto-end every 30s (Carl-style)
  setInterval(async () => {
    try {
      const now = Date.now();
      for (const [mid, g] of Object.entries(db.giveaways || {})) {
        if (!g.ended && now >= g.endsAt) {
          try {
            const guild = client.guilds.cache.get(g.guildId) || await client.guilds.fetch(g.guildId).catch(() => null);
            if (guild) await endGiveaway(guild, mid, false);
            else { g.ended = true; save(); }
          } catch {}
        }
      }
    } catch {}
  }, 30 * 1000);
  // restore pending reminders after restart
  try {
    for (const rem of (db.reminders || [])) {
      const ms = rem.at - Date.now();
      if (ms <= 0) {
        client.users.fetch(rem.userId).then(u => u.send(`⏰ Reminder: **${rem.text}**`).catch(() => {})).catch(() => {});
        db.reminders = db.reminders.filter(r => r !== rem);
      } else if (ms < 30 * 86400000) {
        setTimeout(async () => {
          try {
            const u = await client.users.fetch(rem.userId).catch(() => null);
            if (u) await u.send(`⏰ Reminder: **${rem.text}**`).catch(() => {});
          } catch {}
          db.reminders = (db.reminders || []).filter(r => !(r.userId === rem.userId && r.at === rem.at));
          save();
        }, ms);
      }
    }
    save();
  } catch {}
});
client.on('guildMemberAdd', async (member) => {
  await sendWelcome(member);
  // join autoroles (Carl-style)
  try {
    if (db.autoroles && db.autoroles.length) {
      for (const rid of db.autoroles) {
        const role = member.guild.roles.cache.get(rid);
        if (role) await member.roles.add(role).catch(() => {});
      }
    }
  } catch {}
  try { await modlogSend(member.guild, embedBase('📥 Member joined', `${member.user.tag} (<@${member.id}>)\nAccount: <t:${Math.floor(member.user.createdTimestamp / 1000)}:D>\nTotal: **${member.guild.memberCount}**`, THEME.MINT)); } catch {}
});
client.on('guildMemberRemove', async (member) => {
  await sendLeave(member);
  try { await modlogSend(member.guild, embedBase('📤 Member left', `${member.user?.tag || '?'} (<@${member.id}>)\nTotal: **${member.guild.memberCount}**`, 0x808080)); } catch {}
});
// --- mod-log: deletes + edits (Carl-style) ---
client.on('messageDelete', async (msg) => {
  try {
    if (!msg.guild || msg.author?.bot) return;
    if (!db.modlog?.channelId) return;
    const e = embedBase('🗑️ Message deleted', `In <#${msg.channelId}> by **${msg.author?.tag || '?'}** (<@${msg.author?.id}>)\n${THEME.DIV}\n${String(msg.content || '_no text (embed/attachment)_').slice(0, 800)}`, THEME.RED);
    await modlogSend(msg.guild, e);
  } catch {}
});
client.on('messageUpdate', async (oldM, newM) => {
  try {
    if (!oldM.guild || oldM.author?.bot) return;
    if (!db.modlog?.channelId) return;
    if (String(oldM.content) === String(newM.content)) return;
    const e = embedBase('✏️ Message edited', `In <#${oldM.channelId}> by **${oldM.author?.tag}** — [jump](https://discord.com/channels/${oldM.guildId}/${oldM.channelId}/${oldM.id})\n${THEME.DIV}\n**Before:**\n${String(oldM.content || '').slice(0, 400)}\n\n**After:**\n${String(newM.content || '').slice(0, 400)}`, THEME.GOLD);
    await modlogSend(oldM.guild, e);
  } catch {}
});

// Levels: XP on chat (no MessageContent intent needed — we only count messages)
async function handleTextShortcut(msg) {
  try {
    if (!msg.guild || !msg.author || msg.author.bot) return false;
    const content = (msg.content || '').trim();
    if (!content) return false;
    const map = (db.shortcuts && db.shortcuts.map) || {};
    const keys = Object.keys(map);
    if (!keys.length) return false;
    let spec = null, rest = '';
    for (const k of keys) {
      const e = map[k] || {};
      const pfx = e.prefix || ',';
      if (content.toLowerCase().startsWith((pfx + k).toLowerCase())) {
        const after = content.slice((pfx + k).length);
        if (after === '' || /^\s/.test(after)) { spec = e; rest = after.trim(); break; }
      }
    }
    if (!spec || !spec.command) return false;
    const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
    if (!await isStaffHigherThanBot(member)) return false;
    const by = msg.author.tag + ' (shortcut)';
    const say = async (text) => { try { await msg.reply(text); } catch {} };
    const cmd = spec.command;
    if (cmd === 'game-announce') {
      if (!rest) return (await say('Usage: `<alias> <message>`'), true);
      queueCommand({ type: 'announce', message: rest.slice(0, 200), by, broadcast: true });
      await say(`📢 Announced: ${rest.slice(0, 200)}`);
      return true;
    }
    if (cmd === 'game-restart') {
      let delay = 30, reason = rest;
      const m = rest.match(/^(\d+)\s+([\s\S]+)$/);
      if (m) { delay = Math.min(120, Math.max(5, parseInt(m[1], 10) || 30)); reason = m[2]; }
      if (!reason) return (await say('Usage: `<alias> [delay 5-120] <reason>`'), true);
      queueCommand({ type: 'restart', delay, reason: reason.slice(0, 200), by, broadcast: true });
      await say(`🔁 Restart queued in ${delay}s.`);
      return true;
    }
    if (cmd === 'game-luck') {
      const parts = rest.split(/\s+/).filter(Boolean);
      const mult = Math.min(10, Math.max(1, parseInt(parts[0], 10) || 0));
      if (!mult) return (await say('Usage: `<alias> <mult 1-10> [minutes 1-60]`'), true);
      const minutes = Math.min(60, Math.max(1, parseInt(parts[1], 10) || 10));
      queueCommand({ type: 'luck', mult, minutes, by, broadcast: true });
      await say(`🍀 Luck x${mult} for ${minutes}m queued.`);
      return true;
    }
    if (cmd === 'admin-abuse') {
      const parts = rest.split(/\s+/).filter(Boolean);
      const ev = (parts[0] || '').toLowerCase();
      const valid = ['money-rain', 'spin-party', 'heal-all', 'midnight', 'daybreak', 'disco', 'all'];
      if (!valid.includes(ev)) return (await say('Usage: `<alias> <' + valid.join('|') + '> [disco seconds]`'), true);
      queueCommand({ type: 'abuse', event: ev, duration: parseInt(parts[1], 10) || 60, by, broadcast: true });
      await say(`🎉 Admin event \`${ev}\` queued.`);
      return true;
    }
    if (cmd === 'player-data') {
      const t = await resolveShortcutTarget(rest.split(/\s+/)[0]);
      if (!t) return (await say('Usage: `<alias> <username-or-id>`'), true);
      const cached = db.playerCache[t.rId];
      const inv = db.inventories[t.rId];
      const txt2 = cached ? `💰 **${cached.money}** ⚔️ **${cached.slays}** 🎒 W:${cached.weapons} S:${cached.skins} F:${cached.finishers}` : '_No cached game data (offline)._';
      const tp = inv && inv.placeId && inv.jobId ? `\n🚀 [Join server](${teleportLink(inv.placeId, inv.jobId)})` : '';
      await say({ embeds: [embedBase('📊 ' + t.rUsername, txt2 + tp)] });
      return true;
    }
    if (cmd === 'game-money' || cmd === 'give-tokens') {
      const action = (tok[0] || '').toLowerCase();
      const who = await resolveShortcutTarget(tok[1]);
      const amt = Math.floor(Number(tok[2]));
      if (!['give', 'remove', 'set'].includes(action) || !who || !(amt >= 0)) return (await say('Usage: `<alias> <Give|Remove|Set> <username-or-id> <amount>`'), true);
      const A = action[0].toUpperCase() + action.slice(1);
      if (cmd === 'game-money') queueCommand({ type: 'money', action: A, robloxUsername: who.rUsername, robloxId: who.rId, amount: amt, by });
      else queueCommand({ type: 'give_tokens', action: A, robloxUsername: who.rUsername, robloxId: who.rId, amount: Math.max(1, amt), by });
      await say(`✅ \`${cmd}\` ${A} ${amt} → **${who.rUsername}**.`);
      return true;
    }
    if (cmd === 'give-spins') {
      const kind = (tok[0] || '').toLowerCase();
      const action = (tok[1] || '').toLowerCase();
      const who = await resolveShortcutTarget(tok[2]);
      const amt = Math.floor(Number(tok[3]));
      if (!['hourly', 'wheel'].includes(kind) || !['give', 'remove', 'set'].includes(action) || !who || !(amt >= 1)) return (await say('Usage: `<alias> <hourly|wheel> <Give|Remove|Set> <username-or-id> <amount>`'), true);
      queueCommand({ type: 'give_spins', kind, action: action[0].toUpperCase() + action.slice(1), robloxUsername: who.rUsername, robloxId: who.rId, amount: amt, by });
      await say(`✅ Spins queued for **${who.rUsername}**.`);
      return true;
    }
    // commands shaped: <target> + tail
    const tok = rest.split(/\s+/).filter(Boolean);
    const t = await resolveShortcutTarget(tok[0]);
    if (!t) return (await say('Usage: `<alias> <username-or-id> [...]` — Roblox user not found.'), true);
    const tail = tok.slice(1).join(' ');
    if (cmd === 'game-kick' || cmd === 'game-ban' || cmd === 'game-unban') {
      const reason = tail || (cmd === 'game-kick' ? 'Kicked by staff' : cmd === 'game-ban' ? 'Banned by staff' : '');
      if (cmd === 'game-ban') {
        db.bans[t.rId] = { reason, by, at: Date.now() }; save();
        const did = db.robloxToDiscord[t.rId];
        if (did) { try { const m = await msg.guild.members.fetch(did); await m.ban({ reason: '[Game ban sync] ' + reason }); } catch {} }
        queueCommand({ type: 'ban', robloxUsername: t.rUsername, robloxId: t.rId, reason, by });
      } else if (cmd === 'game-kick') {
        queueCommand({ type: 'kick', robloxUsername: t.rUsername, robloxId: t.rId, reason, by });
      } else {
        delete db.bans[t.rId]; save();
        queueCommand({ type: 'unban', robloxUsername: t.rUsername, robloxId: t.rId, by });
      }
      await say(`✅ \`${cmd}\` queued for **${t.rUsername}**.`);
      return true;
    }
    if (cmd === 'give-weapon' || cmd === 'give-finisher') {
      const list = cmd === 'give-weapon' ? catalogs.weapons : catalogs.finishers;
      const want = tail.toLowerCase();
      const found = list.find(x => x.toLowerCase() === want);
      if (!found) return (await say(`Item not found — use the exact name (no autocomplete in text mode).`), true);
      if (cmd === 'give-weapon') queueCommand({ type: 'give_weapon', robloxUsername: t.rUsername, robloxId: t.rId, weapon: found, by });
      else queueCommand({ type: 'give_finisher', robloxUsername: t.rUsername, robloxId: t.rId, finisher: found, by });
      await say(`✅ \`${found}\` queued for **${t.rUsername}**.`);
      return true;
    }
    if (cmd === 'add-emoji') {
      const emoji = tail.slice(0, 16);
      if (!emoji) return (await say('Usage: `<alias> <username-or-id> <emoji>`'), true);
      queueCommand({ type: 'add_emoji', robloxUsername: t.rUsername, robloxId: t.rId, emoji, by, broadcast: true });
      await say(`✅ Emoji \`${emoji}\` queued for **${t.rUsername}**.`);
      return true;
    }
    if (cmd === 'remove-emoji' || cmd === 'force-pvp' || cmd === 'unforce-pvp' || cmd === 'force-show-emoji' || cmd === 'unforce-show-emoji') {
      const qtype = cmd.replace(/-/g, '_');
      queueCommand({ type: qtype, robloxUsername: t.rUsername, robloxId: t.rId, by, broadcast: true });
      await say(`✅ \`${cmd}\` queued for **${t.rUsername}**.`);
      return true;
    }
    return false;
  } catch { return false; }
}

client.on('messageCreate', async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;
    if (await handleTextShortcut(msg)) return;
    if (msg.guild.id !== GUILD_ID) return;
    // Ticket text answers (needs MessageContent intent enabled in the dev portal)
    const tick = db.tickets[msg.channelId];
    if (tick && tick.status === 'open' && msg.author.id === tick.discordId) {
      const trole = applications[tick.role];
      const tq = trole && trole.questions[tick.qIndex];
      if (tq) {
        if (tq.type === 'text') {
          const ans = (msg.content || '').trim();
          const min = tq.min || 1, max = tq.max || 1000;
          if (ans.length < min) { await msg.reply(`Too short — please write at least ${min} characters.`).catch(() => {}); return; }
          if (ans.length > 2000) { await msg.reply('Too long — please keep it under 2000 characters.').catch(() => {}); return; }
          try { await msg.delete().catch(() => {}); } catch {}
          await answerTicket(msg.channelId, msg.author.id, ans.slice(0, max));
          return;
        } else {
          await msg.reply('👆 Please answer using the buttons above (or Cancel to stop).').catch(() => {});
          return;
        }
      }
    }
    if (db.settings.levelsEnabled === false) return;
    const id = msg.author.id;
    const rec = getLevelRec(id);
    const now = Date.now();
    if (now - (rec.lastXp || 0) < 60000) return; // 60s cooldown
    rec.lastXp = now;
    rec.msgs = (rec.msgs || 0) + 1;
    rec.xp += 15 + Math.floor(Math.random() * 11); // 15-25
    let need = xpNeeded(rec.level || 0);
    let leveled = false;
    while (rec.xp >= need) { rec.xp -= need; rec.level = (rec.level || 0) + 1; need = xpNeeded(rec.level); leveled = true; }
    save();
    if (leveled) {
      const milestone = levelRoleName(rec.level);
      const emb = embedBase('🎉 Level Up!',
        `<@${id}> reached **Level ${rec.level}**!` +
        (milestone ? `\n🏅 Milestone role: **${milestone}**` : '') +
        `\nKeep chatting, baddie 💅`);
      const chId = db.settings.levelChannelId;
      try {
        if (chId) {
          const ch = await client.channels.fetch(chId).catch(() => null);
          if (ch && ch.isTextBased()) await ch.send({ embeds: [emb] });
          else await msg.channel.send({ embeds: [emb] });
        } else {
          await msg.channel.send({ embeds: [emb] });
        }
      } catch {}
      try {
        const member = msg.member || await msg.guild?.members.fetch(id).catch(() => null);
        if (member) await syncLevelRole(member, rec.level);
      } catch {}
    }
  } catch (e) { console.error('levels error', e.message); }
});

async function handleSelfRoleReaction(reaction, user, adding) {
  try {
    if (user.bot) return;
    if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
    const mapping = db.reactionRoles && db.reactionRoles[reaction.message.id];
    if (!mapping) return;
    const who = user.partial ? await user.fetch().catch(() => null) : user;
    if (!who || who.bot) return;
    const key = reaction.emoji.id || reaction.emoji.name;
    const entry = (mapping.entries || []).find(e => (e.emojiId || e.emoji) === key);
    if (!entry) return;
    const guild = reaction.message.guild || await client.guilds.fetch(mapping.guildId).catch(() => null);
    if (!guild) return;
    const member = await guild.members.fetch(who.id).catch(() => null);
    if (!member) return;
    if (adding) await member.roles.add(entry.roleId).catch(() => {});
    else await member.roles.remove(entry.roleId).catch(() => {});
  } catch {}
}
client.on('messageReactionAdd', (reaction, user) => { handleSelfRoleReaction(reaction, user, true); });
client.on('messageReactionRemove', (reaction, user) => { handleSelfRoleReaction(reaction, user, false); });

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const name = interaction.commandName;
      const focusedOpt = interaction.options.getFocused(true);
      const q = String(focusedOpt.value || '').toLowerCase();
      let list = [];
      if (name === 'give-weapon' || (name === 'value' && focusedOpt.name === 'name') || (name === 'item' && focusedOpt.name === 'name') || (name === 'owners' && focusedOpt.name === 'name')) {
        // type-aware for value/item/owners
        let t = 'Weapon';
        try { t = interaction.options.getString('type') || 'Weapon'; } catch {}
        if (name === 'give-weapon') list = catalogs.weapons;
        else if (name === 'give-finisher') list = catalogs.finishers;
        else list = t === 'Weapon' ? catalogs.weapons : t === 'Finisher' ? catalogs.finishers : catalogs.skinTypes;
      }
      if (name === 'shortcut-add' && focusedOpt.name === 'command') list = SHORTCUT_COMMANDS;
      if (name === 'give-finisher') list = catalogs.finishers;
      if (name === 'give-all-weapon') list = catalogs.weapons;
      if (name === 'give-all-finisher') list = catalogs.finishers;
      if (name === 'give-skin' && focusedOpt.name === 'skin') list = catalogs.skinTypes;
      if (name === 'give-skin' && focusedOpt.name === 'weapontype') list = catalogs.skinTypes;
      if (name === 'give-all-skin' && focusedOpt.name === 'skin') list = catalogs.skinTypes;
      if (name === 'give-all-skin' && focusedOpt.name === 'weapontype') list = catalogs.skinTypes;
      if (!list.length) {
        // fallback for value/item/owners when type missing
        if (['value', 'item', 'owners'].includes(name)) list = [...catalogs.weapons, ...catalogs.finishers, ...catalogs.skinTypes];
      }
      if (name === 'tag' && (focusedOpt.name === 'name')) {
        const all = Object.keys(db.tags || {});
        await interaction.respond(fuzzy(all, q, 10).map(v => ({ name: v.slice(0, 100), value: v })).slice(0, 25));
        return;
      }
      await interaction.respond(fuzzy(list, q, 10).map(v => ({ name: v.slice(0, 100), value: v })).slice(0, 25));
      return;
    }
    const cmd = interaction.isChatInputCommand() ? interaction.commandName : null;

    // ----- TICKET BUTTONS -----
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'app_yes' || id === 'app_no' || id.startsWith('app_opt_')) {
        const t = db.tickets[interaction.channelId];
        if (!t || t.status !== 'open') return interaction.reply({ content: 'This ticket is not open.', ephemeral: true });
        if (interaction.user.id !== t.discordId) return interaction.reply({ content: 'Only the applicant can answer.', ephemeral: true });
        const trole = applications[t.role];
        const tq = trole && trole.questions[t.qIndex];
        if (!tq) return interaction.reply({ content: 'No active question.', ephemeral: true });
        let answer = null;
        if ((id === 'app_yes' || id === 'app_no') && tq.type === 'yesno') answer = id === 'app_yes' ? 'Yes' : 'No';
        else if (id.startsWith('app_opt_') && tq.type === 'choice') {
          const i = parseInt(id.split('_')[2], 10);
          if (tq.options && tq.options[i]) answer = tq.options[i];
        }
        if (answer === null) return interaction.reply({ content: 'Use the current question’s buttons.', ephemeral: true });
        try { await interaction.deferUpdate(); } catch {}
        try { await interaction.message.edit({ components: [] }); } catch {}
        await answerTicket(interaction.channelId, interaction.user.id, answer);
        return;
      }
      if (id === 'app_cancel') {
        const t = db.tickets[interaction.channelId];
        if (!t || t.status !== 'open') return interaction.reply({ content: 'Nothing to cancel.', ephemeral: true });
        if (interaction.user.id !== t.discordId) return interaction.reply({ content: 'Only the applicant can cancel.', ephemeral: true });
        await interaction.reply({ content: 'Cancelling…' });
        return closeTicket(interaction.channelId, `Cancelled by <@${interaction.user.id}>.`, { log: true });
      }
      if (id === 'app_accept' || id === 'app_deny' || id === 'app_close') {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!await isStaffHigherThanBot(member)) return interaction.reply({ content: '❌ Staff only (role higher than the bot).', ephemeral: true });
        const t = db.tickets[interaction.channelId];
        if (id === 'app_close') { await interaction.reply({ content: 'Closing…' }); return closeTicket(interaction.channelId, `Closed by <@${interaction.user.id}>.`, { log: true }); }
        if (!t) return interaction.reply({ content: 'No application data for this channel.', ephemeral: true });
        const accepted = id === 'app_accept';
        const verdict = accepted ? 'ACCEPTED ✅' : 'DENIED ❌';
        const color = accepted ? 0x57f287 : 0xed4245;
        await interaction.reply({ embeds: [embedBase(`${verdict} — ${t.tag}`, `Role: **${t.roleLabel}**\nDecided by <@${interaction.user.id}>`, color)] });
        try {
          const u = await client.users.fetch(t.discordId).catch(() => null);
          if (u) await u.send(`${verdict} Your **${t.roleLabel}** application was reviewed by ${interaction.user.tag}.` + (accepted ? ' Welcome aboard! 🎉' : ' Thanks for applying — feel free to try again later.')).catch(() => {});
        } catch {}
        if (db.settings.ticketReviewChannelId) {
          try {
            const rc = await client.channels.fetch(db.settings.ticketReviewChannelId);
            if (rc && rc.isTextBased()) await rc.send({ embeds: [embedBase(`${verdict} — ${t.tag} (${t.roleLabel})`, `Applicant: <@${t.discordId}>\nDecided by: <@${interaction.user.id}>`, color)] });
          } catch {}
        }
        return closeTicket(interaction.channelId, `${verdict} by <@${interaction.user.id}>.`, { log: false, silent: false });
      }
      // --- giveaway join ---
      if (id.startsWith('gw_join_')) {
        const mid = id.replace('gw_join_', '');
        const g = db.giveaways[mid];
        if (!g || g.ended) return interaction.reply({ content: 'This giveaway has ended.', ephemeral: true });
        if (Date.now() > g.endsAt) return interaction.reply({ content: 'This giveaway has ended.', ephemeral: true });
        g.entrants = g.entrants || [];
        if (g.entrants.includes(interaction.user.id)) return interaction.reply({ content: 'You are already entered! 💅', ephemeral: true });
        g.entrants.push(interaction.user.id); save();
        return interaction.reply({ content: `✅ Entered **${g.prize}**! Good luck baddie 🌸 (${g.entrants.length} entries)`, ephemeral: true });
      }
      // --- suggestion votes ---
      if (id.startsWith('sug_up_') || id.startsWith('sug_down_')) {
        const sid = Number(id.split('_')[2]);
        const item = db.suggestions.items && db.suggestions.items[sid];
        if (!item) return interaction.reply({ content: 'Suggestion not found.', ephemeral: true });
        item.up = item.up || []; item.down = item.down || [];
        const isUp = id.startsWith('sug_up_');
        const voted = (isUp ? item.up : item.down).includes(interaction.user.id);
        // toggle off if same vote, else switch vote
        item.up = item.up.filter(x => x !== interaction.user.id);
        item.down = item.down.filter(x => x !== interaction.user.id);
        if (!voted) (isUp ? item.up : item.down).push(interaction.user.id);
        save();
        try { await interaction.reply({ content: voted ? 'Removed your vote.' : (isUp ? '👍 Voted yes!' : '👎 Voted no!'), ephemeral: true }); } catch {}
        try {
          const msg = interaction.message;
          if (msg && msg.embeds && msg.embeds[0]) {
            const old = msg.embeds[0];
            const emb = EmbedBuilder.from(old).setFields(
              { name: 'Author', value: `<@${item.authorId}>`, inline: true },
              { name: 'Status', value: item.status || 'pending', inline: true },
              { name: 'Votes', value: `👍 ${(item.up || []).length} • 👎 ${(item.down || []).length}` }
            );
            await msg.edit({ embeds: [emb] }).catch(() => {});
          }
        } catch {}
        return;
      }
      return;
    }
    // ----- HELP SELECT MENU -----
    if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
      if (interaction.customId === 'help_cat') {
        const cat = interaction.values[0];
        try { await interaction.update({ embeds: [buildHelpEmbed(cat)], components: helpMenuRow(cat) }); } catch {}
        return;
      }
    }

    // ----- TICKET COMMANDS -----
    if (cmd === 'apply') {
      return startTicket(interaction, interaction.options.getString('role', true));
    }
    if (cmd === 'ticket-close') {
      const t = db.tickets[interaction.channelId];
      if (!t) return interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true });
      if (interaction.user.id !== t.discordId) {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!await isStaffHigherThanBot(member)) return interaction.reply({ content: 'Only the applicant or staff can close this.', ephemeral: true });
        return closeTicket(interaction.channelId, `Closed by staff <@${interaction.user.id}>.`, { log: true });
      }
      return closeTicket(interaction.channelId, `Closed by <@${interaction.user.id}>.`, { log: true });
    }
    if (cmd === 'setup-applications' || cmd === 'tickets') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      if (cmd === 'setup-applications') {
        const cat = interaction.options.getChannel('category', true);
        const rev = interaction.options.getChannel('review', true);
        const role = interaction.options.getRole('reviewer', true);
        if (cat.type !== ChannelType.GuildCategory) return interaction.reply({ content: '❌ Pick a category for tickets.', ephemeral: true });
        if (!rev.isTextBased()) return interaction.reply({ content: '❌ Pick a text channel for reviews.', ephemeral: true });
        db.settings.ticketCategoryId = cat.id;
        db.settings.ticketReviewChannelId = rev.id;
        db.settings.ticketReviewerRoleId = role.id;
        save();
        return interaction.reply({ content: `✅ Applications → tickets in **${cat.name}**, reviews in <#${rev.id}>, viewers <@&${role.id}>.\nUsers apply with \`/apply\`.`, ephemeral: true });
      }
      const open = Object.values(db.tickets).filter(t => t.status === 'open' || t.status === 'answered');
      if (!open.length) return interaction.reply({ content: 'No open tickets.', ephemeral: true });
      const lines = open.map(t => `<#${t.channelId}> — **${t.roleLabel}** — <@${t.discordId}> (${t.status}, <t:${Math.floor((t.lastActivity || t.createdAt) / 1000)}:R>)`);
      return interaction.reply({ embeds: [embedBase('🎟️ Open tickets', lines.join('\n').slice(0, 3900))], ephemeral: true });
    }

    if (!interaction.isChatInputCommand()) return;

    // ----- PUBLIC -----
    if (cmd === 'help') {
      return interaction.reply({ embeds: [buildHelpEmbed('home')], components: helpMenuRow('home'), ephemeral: true });
    }
    if (cmd === 'ping') {
      const sent = await interaction.reply({ content: 'Pinging…', fetchReply: true });
      const ms = sent.createdTimestamp - interaction.createdTimestamp;
      const ws = Math.round(client.ws.ping);
      const dot = ws < 150 ? '🟢' : ws < 300 ? '🟡' : '🔴';
      return interaction.editReply({ embeds: [baddieEmbed('🏓 Pong!', `${THEME.DIV}\n⏱️ Roundtrip: **${ms}ms**\n${dot} Websocket: **${ws}ms**\n${THEME.DIV}\n🌸 Summer Baddies is awake!`)] });
    }
    if (cmd === 'server-info') {
      const g = interaction.guild;
      await g.members.fetch().catch(() => {});
      const linked = Object.keys(db.links).length;
      const onlineServers = Object.keys(db.servers).length;
      const onlinePlayers = Object.values(db.servers).reduce((a, s) => a + (s.players || []).length, 0);
      const e = baddieEmbed(`🏠 ${g.name}`,
        `${THEME.DIV}\n👥 Members: **${g.memberCount}**\n` +
        `🔗 Linked Roblox: **${linked}**\n` +
        `🟢 Live game servers: **${onlineServers}** (players: **${onlinePlayers}**)\n` +
        `💎 Values: ${db.valuesCache.at ? `live <t:${Math.floor(db.valuesCache.at / 1000)}:R> (${Object.keys(db.valuesCache.byKey).length} items)` : 'seeds only'}\n` +
        `${THEME.DIV}\n📅 Created: <t:${Math.floor(g.createdTimestamp / 1000)}:D> • 💜 Boosts: **${g.premiumSubscriptionCount || 0}**`);
      if (g.iconURL()) e.setThumbnail(g.iconURL({ size: 256 }));
      return interaction.reply({ embeds: [e] });
    }
    if (cmd === 'avatar') {
      const u = interaction.options.getUser('user') || interaction.user;
      const e = baddieEmbed(`🖼️ ${u.username}'s avatar`, `${THEME.DIV}\n[PNG](${u.displayAvatarURL({ size: 1024 })}) • [JPG](${u.displayAvatarURL({ size: 1024, extension: 'jpg' })}) • [WEBP](${u.displayAvatarURL({ size: 1024, extension: 'webp' })})`).setImage(u.displayAvatarURL({ size: 1024 }));
      return interaction.reply({ embeds: [e] });
    }
    if (cmd === 'rank') {
      const u = interaction.options.getUser('user') || interaction.user;
      const rec = getLevelRec(u.id);
      const need = xpNeeded(rec.level || 0);
      const sorted = Object.entries(db.levels).sort((a, b) => (b[1].level * 10000 + b[1].xp) - (a[1].level * 10000 + a[1].xp));
      const pos = sorted.findIndex(([id]) => id === u.id) + 1;
      const pct = Math.min(100, Math.floor(((rec.xp || 0) / need) * 100));
      const bar = '▰'.repeat(Math.floor(pct / 10)) + '▱'.repeat(10 - Math.floor(pct / 10));
      const e = baddieEmbed(`🏆 ${u.username} — Level ${rec.level || 0}`, `${THEME.DIV}\n${bar} **${pct}%** to Lv ${ (rec.level || 0) + 1}\n💫 XP: **${rec.xp}** / ${need}\n💬 Messages: **${rec.msgs || 0}**\n🥇 Rank: **#${pos || '—'}** of ${sorted.length}`);
      e.setThumbnail(u.displayAvatarURL({ size: 128 }));
      return interaction.reply({ embeds: [e] });
    }
    if (cmd === 'leaderboard') {
      const sorted = Object.entries(db.levels).sort((a, b) => (b[1].level * 10000 + b[1].xp) - (a[1].level * 10000 + a[1].xp)).slice(0, 10);
      if (!sorted.length) return interaction.reply({ content: 'No XP yet — chat to earn levels!', ephemeral: true });
      const medals = ['🥇', '🥈', '🥉'];
      const lines = sorted.map(([id, r], i) => `${medals[i] || `**${i + 1}.**`} <@${id}> — Level **${r.level}** (${fmtCoins(r.xp)} XP)`);
      return interaction.reply({ embeds: [baddieEmbed('🏆 Top Baddies — chat levels', THEME.DIV + '\n' + lines.join('\n'))] });
    }
    if (cmd === 'link') {
      const username = interaction.options.getString('username', true).replace('@', '');
      await interaction.deferReply({ ephemeral: true });
      const r = await robloxUserId(username);
      if (!r) return interaction.editReply('❌ Roblox user not found. Check spelling.');
      if (db.robloxToDiscord[r.id] && db.robloxToDiscord[r.id] !== interaction.user.id)
        return interaction.editReply('❌ That Roblox account is already linked to someone else. Ask staff for help.');
      // clear old codes for this user
      for (const [code, rec] of Object.entries(db.linkCodes)) if (rec.discordId === interaction.user.id) delete db.linkCodes[code];
      const code = String(Math.floor(100000 + Math.random() * 900000));
      db.linkCodes[code] = { discordId: interaction.user.id, robloxUsername: r.name, robloxId: r.id, expires: Date.now() + 10 * 60 * 1000 };
      save();
      const thumb = await robloxThumb(r.id);
      const e = embedBase('🔗 Link your account', `Found **${r.name}** (${r.displayName})\n\n**Step 2:** join Summer Baddies and chat:\n\`!verify ${code}\`\n\nCode expires in 10 minutes. Once linked you get the Verified role + punishments sync both ways. Check /verify-status after.`, 0x57f287);
      if (thumb) e.setThumbnail(thumb);
      return interaction.editReply({ embeds: [e] });
    }
    if (cmd === 'unlink') {
      const l = db.links[interaction.user.id];
      if (!l) return interaction.reply({ content: 'You are not linked.', ephemeral: true });
      delete db.robloxToDiscord[l.robloxId]; delete db.links[interaction.user.id]; save();
      try {
        const m = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const roleId = db.settings.verifiedRoleId;
        if (m && roleId && m.roles.cache.has(roleId)) await m.roles.remove(roleId).catch(() => {});
      } catch {}
      return interaction.reply({ content: `🔓 Unlinked **${l.robloxUsername}** and removed Verified role.`, ephemeral: true });
    }
    if (cmd === 'verify-status') {
      const u = interaction.options.getUser('user') || interaction.user;
      const l = db.links[u.id];
      if (!l) return interaction.reply({ content: `${u.username} is ❌ **not verified**. Use /link to start.`, ephemeral: true });
      const thumb = await robloxThumb(l.robloxId);
      const e = embedBase('✅ Verified', `Discord: <@${u.id}>\nRoblox: **${l.robloxUsername}** (\`${l.robloxId}\`)\nLinked: <t:${Math.floor(l.at / 1000)}:R>\nProfile: https://www.roblox.com/users/${l.robloxId}/profile`, 0x57f287);
      if (thumb) e.setThumbnail(thumb);
      return interaction.reply({ embeds: [e], ephemeral: true });
    }
    if (cmd === 'profile') {
      const u = interaction.options.getUser('user') || interaction.user;
      const l = db.links[u.id];
      if (!l) return interaction.reply({ content: `${u.username} has not linked a Roblox account. Use /link.`, ephemeral: true });
      const cached = db.playerCache[l.robloxId];
      const inv = db.inventories[l.robloxId];
      const thumb = await robloxThumb(l.robloxId);
      const lvl = db.levels[u.id];
      const econ = db.economy[u.id];
      const e = baddieEmbed('👤 ' + l.robloxUsername, `Discord: <@${u.id}> • \`${u.id}\`\n🔗 Roblox ID: \`${l.robloxId}\` • [Profile](https://www.roblox.com/users/${l.robloxId}/profile)` +
        `${THEME.DIV}\n` +
        (cached ? `💰 Dinero: **${cached.money ?? '?'}** • ⚔️ Slays: **${cached.slays ?? '?'}**\n🎒 Weapons **${cached.weapons ?? '?'}** • Skins **${cached.skins ?? '?'}** • Finishers **${cached.finishers ?? '?'}**\n🟢 Last seen: <t:${Math.floor((cached.at || Date.now()) / 1000)}:R>` : '_No cached game data yet — join the game once._') +
        (lvl ? `\n🏆 Chat level **${lvl.level || 0}** (${lvl.xp || 0} XP)` : '') +
        (econ ? `\n💰 Coins: 👛 **${fmtCoins(econ.wallet)}** • 🏦 **${fmtCoins(econ.bank)}**` : '') +
        (inv && inv.jobId && inv.placeId ? `\n${THEME.DIV}\n🚀 [Join their server](${teleportLink(inv.placeId, inv.jobId)})` : ''));
      if (thumb) e.setThumbnail(thumb);
      return interaction.reply({ embeds: [e] });
    }
    if (cmd === 'value' || cmd === 'item' || cmd === 'owners') {
      const type = interaction.options.getString('type', true);
      const name = interaction.options.getString('name', true);
      await interaction.deferReply();
      if (cmd === 'value') {
        const v = lookupValue(type, name);
        const iconUrl = await resolveIcon(v.icon);
        const e = embedBase(`${demand.EMOJI[v.demand] || ''} ${v.name}`, `${valueLine(v)}\n\nValues updated: ${db.valuesCache.at ? `<t:${Math.floor(db.valuesCache.at / 1000)}:R>` : 'seeds'} — use /item for owners + teleport.`, demand.COLORS[v.demand] || 0xff5da2);
        if (iconUrl) e.setThumbnail(iconUrl);
        return interaction.editReply({ embeds: [e] });
      }
      if (cmd === 'owners') {
        const v = lookupValue(type, name);
        const owners = getOwners(v.type, v.name, 10);
        if (!owners.length) return interaction.editReply({ content: `No tracked owners for **${v.name}** yet. Game pushes inventories every 60s once the new bridge is installed.`, });
        return interaction.editReply({ embeds: [embedBase(`👥 Owners — ${v.name}`, owners.map(ownerLine).join('\n').slice(0, 3900), 0x5aaaff)] });
      }
      // item = full detail
      const emb = await buildItemEmbed(type, name);
      return interaction.editReply({ embeds: [emb] });
    }
    if (cmd === 'online') {
      const servers = Object.values(db.servers || {}).sort((a, b) => (b.players || []).length - (a.players || []).length).slice(0, 10);
      if (!servers.length) return interaction.reply({ content: 'No live servers tracked right now. Game heartbeats every 30s once the new bridge is installed.', ephemeral: true });
      const lines = servers.map(s => {
        const names = (s.players || []).slice(0, 6).map(p => {
          const d = db.robloxToDiscord[p.robloxId] ? ` (<@${db.robloxToDiscord[p.robloxId]}>)` : '';
          return `**${p.robloxUsername}**${d}`;
        }).join(', ') || '_empty_';
        const tp = teleportLink(s.placeId, s.jobId) ? ` — [Join](${teleportLink(s.placeId, s.jobId)})` : '';
        return `🟢 \`${String(s.jobId).slice(0, 8)}…\` (${(s.players || []).length} players)${tp}\n${names}\n<t:${Math.floor((s.at || Date.now()) / 1000)}:R>`;
      });
      return interaction.reply({ embeds: [embedBase('🟢 Live servers', lines.join('\n\n').slice(0, 3900))] });
    }
    if (cmd === 'teleport') {
      const username = interaction.options.getString('username', true);
      await interaction.deferReply({ ephemeral: true });
      const r = await robloxUserId(username);
      if (!r) return interaction.editReply('❌ Roblox user not found.');
      const inv = db.inventories[r.id];
      const srv = inv && inv.jobId ? db.servers[inv.jobId] : null;
      if (!inv || !inv.placeId || !inv.jobId) return interaction.editReply(`**${r.name}** is not tracked online right now. They may be offline or the bridge heartbeat is not installed yet.`);
      const discord = db.robloxToDiscord[r.id] ? `<@${db.robloxToDiscord[r.id]}>` : 'not linked';
      return interaction.editReply({ embeds: [embedBase(`🚀 Teleport to ${r.name}`, `Discord: ${discord}\nServer: \`${String(inv.jobId).slice(0, 13)}…\` ${srv ? `(${(srv.players || []).length} players)` : '(last seen)'}\n\n[👉 Join server (browser)](${teleportLink(inv.placeId, inv.jobId)})\n\`roblox://placeId=${inv.placeId}&gameInstanceId=${inv.jobId}\`\n\nPaste the second line in Run (Win+R) to open directly in the Roblox app. Updated: <t:${Math.floor((inv.at || Date.now()) / 1000)}:R>`)] });
    }
    if (cmd === 'search-skins' || cmd === 'search-weapons' || cmd === 'search-finishers') {
      const q = interaction.options.getString('query', true);
      const type = cmd === 'search-skins' ? 'WeaponSkin' : cmd === 'search-weapons' ? 'Weapon' : 'Finisher';
      const list = cmd === 'search-skins' ? catalogs.skinTypes : cmd === 'search-weapons' ? catalogs.weapons : catalogs.finishers;
      const hits = fuzzy(list, q, 8);
      if (!hits.length) return interaction.reply({ content: `No matches for "${q}". Try a shorter term.`, ephemeral: true });
      await interaction.deferReply();
      // exact match -> full detail embed with icon/owners/teleport/discord
      if (hits.length === 1 || hits[0].toLowerCase() === q.toLowerCase()) {
        const emb = await buildItemEmbed(type, hits[0]);
        return interaction.editReply({ embeds: [emb] });
      }
      const lines = hits.map(h => valueLine(lookupValue(type, h)));
      const liveAge = db.valuesCache.at ? `<t:${Math.floor(db.valuesCache.at / 1000)}:R>` : 'seeds (game offline)';
      return interaction.editReply({ embeds: [embedBase(`🔎 ${cmd.replace('search-', '')} — "${q}"`, lines.join('\n') + `\n\n_Name • RAP • Demand • Trend_\nValues updated: ${liveAge}\n\nTip: exact match shows icon + owners + teleport + linked Discord. Or use /item.`, 0xff5da2)] });
    }
    if (cmd === 'search-player') {
      const username = interaction.options.getString('username', true);
      await interaction.deferReply();
      const r = await robloxUserId(username);
      if (!r) return interaction.editReply('❌ Roblox user not found.');
      const thumb = await robloxThumb(r.id);
      const cached = db.playerCache[r.id];
      const inv = db.inventories[r.id];
      const discordId = db.robloxToDiscord[r.id];
      const tp = inv && inv.placeId && inv.jobId ? `\n🚀 [Join server](${teleportLink(inv.placeId, inv.jobId)})` : '';
      const e = embedBase('🔎 ' + r.name, `Display: ${r.displayName}\nID: \`${r.id}\`\nProfile: https://www.roblox.com/users/${r.id}/profile\nDiscord: ${discordId ? `<@${discordId}> (linked ✅)` : '_not linked_'}` +
        (cached ? `\n\n💰 Dinero: **${cached.money}** | ⚔️ Slays: **${cached.slays}**\n🎒 W:${cached.weapons} S:${cached.skins} F:${cached.finishers}\n🟢 <t:${Math.floor(cached.at / 1000)}:R>` : '\n\n_No cached in-game data (offline or never joined since bridge installed)._') + tp);
      if (thumb) e.setThumbnail(thumb);
      return interaction.editReply({ embeds: [e] });
    }
    if (cmd === 'rules') {
      const mode = interaction.options.getString('mode') || 'custom';
      if (mode === 'tos') {
        return interaction.reply({ embeds: [embedBase('📜 Discord Terms & Community Guidelines',
          'You must follow **Discord Terms of Service** (https://discord.com/terms) and **Community Guidelines** (https://discord.com/guidelines):\n\n• Must be 13+ (or local minimum age)\n• No harassment, hate speech, threats, or doxxing\n• No NSFW/sexual content involving minors — zero tolerance\n• No spam, scams, phishing, or malware\n• No cheating/exploit distribution\n• Respect moderators — their decisions are final here', 0x5865f2)] });
      }
      const t = db.settings.rulesText || '_No custom rules set yet. Staff: use /set-rules._';
      return interaction.reply({ embeds: [embedBase('📜 Server Rules', t, 0x5865f2)] });
    }

    // ============ DISCORD SUITE (Carl / Greed / Mimu style) ============
    if (cmd === 'mod') {
      const sub = interaction.options.getSubcommand();
      const staffActs = ['purge', 'lock', 'unlock', 'slowmode', 'nick', 'warn', 'clearwarns', 'mute', 'unmute'];
      if (staffActs.includes(sub)) { const st = await requireStaff(interaction); if (!st) return; }
      if (sub === 'purge') {
        const amt = interaction.options.getInteger('amount', true);
        const user = interaction.options.getUser('user');
        await interaction.deferReply({ ephemeral: true });
        try {
          const msgs = await interaction.channel.messages.fetch({ limit: 100 });
          let list = [...msgs.values()].filter(m => Date.now() - m.createdTimestamp < 14 * 24 * 3600 * 1000);
          if (user) list = list.filter(m => m.author.id === user.id);
          list = list.slice(0, amt);
          if (!list.length) return interaction.editReply('❌ Nothing deletable (Discord blocks 14d+ messages).');
          await interaction.channel.bulkDelete(list, true).catch(() => {});
          await modlogSend(interaction.guild, embedBase('🧹 Purge', `By <@${interaction.user.id}> in <#${interaction.channelId}>\nDeleted: **${list.length}**${user ? ` (filter: ${user.tag})` : ''}`, THEME.RED));
          return interaction.editReply({ embeds: [okEmbed('Purged', `Deleted **${list.length}** messages ${user ? `from **${user.tag}** ` : ''}in <#${interaction.channelId}>.`)] });
        } catch (e) { return interaction.editReply('❌ ' + String(e.message || e).slice(0, 200)); }
      }
      if (sub === 'lock' || sub === 'unlock') {
        const ch = interaction.options.getChannel('channel') || interaction.channel;
        try {
          await ch.permissionOverwrites.edit(interaction.guild.roles.everyone.id, sub === 'lock' ? { SendMessages: false } : { SendMessages: null });
          await modlogSend(interaction.guild, embedBase(sub === 'lock' ? '🔒 Locked' : '🔓 Unlocked', `<#${ch.id}> by <@${interaction.user.id}>`, THEME.RED));
          return interaction.reply({ embeds: [okEmbed(sub === 'lock' ? 'Locked' : 'Unlocked', `<#${ch.id}> ${sub === 'lock' ? 'is now read-only 🔒' : 'is open again 🔓'}`)], ephemeral: true });
        } catch (e) { return interaction.reply({ content: '❌ ' + String(e.message || e).slice(0, 200), ephemeral: true }); }
      }
      if (sub === 'slowmode') {
        const secs = interaction.options.getInteger('seconds', true);
        const ch = interaction.options.getChannel('channel') || interaction.channel;
        try { await ch.setRateLimitPerUser(secs); return interaction.reply({ embeds: [okEmbed('Slowmode', `<#${ch.id}> → **${secs}s** ${secs === 0 ? '(off)' : '🐢'}`)], ephemeral: true }); }
        catch (e) { return interaction.reply({ content: '❌ ' + String(e.message || e).slice(0, 200), ephemeral: true }); }
      }
      if (sub === 'nick') {
        const user = interaction.options.getUser('user', true);
        const nick = interaction.options.getString('nickname', true);
        try {
          const m = await interaction.guild.members.fetch(user.id);
          await m.setNickname(nick === 'reset' || nick === '-' ? null : nick.slice(0, 32));
          return interaction.reply({ embeds: [okEmbed('Nickname', `${user.tag} → **${nick}**`)], ephemeral: true });
        } catch (e) { return interaction.reply({ content: '❌ Cannot change nick (hierarchy?): ' + String(e.message || e).slice(0, 150), ephemeral: true }); }
      }
      if (sub === 'warn') {
        const user = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason', true).slice(0, 300);
        if (!db.warns[user.id]) db.warns[user.id] = [];
        db.warns[user.id].push({ reason, by: interaction.user.tag, at: Date.now() }); save();
        try { const u = await client.users.fetch(user.id); await u.send(`⚠️ You were warned in **${interaction.guild.name}**: ${reason}`).catch(() => {}); } catch {}
        await modlogSend(interaction.guild, embedBase('⚠️ Warn', `<@${user.id}> (${user.tag})\nReason: ${reason}\nBy: <@${interaction.user.id}>\nTotal: **${db.warns[user.id].length}**`, THEME.GOLD));
        return interaction.reply({ embeds: [embedBase('⚠️ Warned', `${user.tag} — *${reason}*\nTotal warns: **${db.warns[user.id].length}**`, THEME.GOLD)] });
      }
      if (sub === 'warnings') {
        const user = interaction.options.getUser('user') || interaction.user;
        const list = db.warns[user.id] || [];
        if (!list.length) return interaction.reply({ embeds: [okEmbed('Warnings', `**${user.tag}** is clean ✨ (0 warns)`)], ephemeral: true });
        const lines = list.slice(-10).map((w, i) => `**${i + 1}.** ${w.reason} — *${w.by}* <t:${Math.floor(w.at / 1000)}:R>`);
        return interaction.reply({ embeds: [embedBase(`⚠️ ${user.username} — ${list.length} warn(s)`, lines.join('\n'), THEME.GOLD).setThumbnail(user.displayAvatarURL())], ephemeral: true });
      }
      if (sub === 'clearwarns') {
        const user = interaction.options.getUser('user', true);
        const n = (db.warns[user.id] || []).length;
        db.warns[user.id] = []; save();
        await modlogSend(interaction.guild, embedBase('🧼 Warns cleared', `<@${user.id}> cleared (${n}) by <@${interaction.user.id}>`, THEME.MINT));
        return interaction.reply({ embeds: [okEmbed('Cleared', `Removed **${n}** warns from ${user.tag}`)], ephemeral: true });
      }
      if (sub === 'mute' || sub === 'unmute') {
        const user = interaction.options.getUser('user', true);
        const m = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!m) return interaction.reply({ content: 'Member not found.', ephemeral: true });
        try {
          if (sub === 'unmute') {
            await m.timeout(null);
            await modlogSend(interaction.guild, embedBase('🔊 Unmuted', `<@${user.id}> by <@${interaction.user.id}>`, THEME.MINT));
            return interaction.reply({ embeds: [okEmbed('Unmuted', `${user.tag} can chat again 🔊`)] });
          }
          const durStr = interaction.options.getString('duration', true);
          const reason = interaction.options.getString('reason') || `Muted by ${interaction.user.tag}`;
          const ms = parseDuration(durStr);
          if (!ms) return interaction.reply({ content: 'Use like `10m`, `1h`, `1d` (10s min, 28d max).', ephemeral: true });
          await m.timeout(Math.min(ms, 28 * 86400000), reason);
          await modlogSend(interaction.guild, embedBase('🔇 Muted', `<@${user.id}> for **${durStr}**\n${reason}\nBy <@${interaction.user.id}>`, THEME.RED));
          return interaction.reply({ embeds: [embedBase('🔇 Muted', `${user.tag} for **${durStr}**\n*${reason}*`, THEME.RED)] });
        } catch (e) { return interaction.reply({ content: '❌ ' + String(e.message || e).slice(0, 200), ephemeral: true }); }
      }
    }
    if (cmd === 'who') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'user') {
        const u = interaction.options.getUser('user') || interaction.user;
        const m = await interaction.guild.members.fetch(u.id).catch(() => null);
        const link = db.links[u.id];
        const lvl = db.levels[u.id];
        const e = baddieEmbed(`👤 ${u.username}`, `${THEME.DIV}\n${u} • \`${u.id}\`\nAccount: <t:${Math.floor(u.createdTimestamp / 1000)}:D> (<t:${Math.floor(u.createdTimestamp / 1000)}:R>)` +
          (m ? `\nJoined: <t:${Math.floor(m.joinedTimestamp / 1000)}:D> (<t:${Math.floor(m.joinedTimestamp / 1000)}:R>)` : '') +
          (m ? `\nRoles (${m.roles.cache.size - 1}): ${m.roles.cache.filter(r => r.name !== '@everyone').sort((a, b) => b.position - a.position).first(5).map(r => `<@&${r.id}>`).join(' ') || 'none'}` : '') +
          `\nBoosting: ${m && m.premiumSince ? `✅ since <t:${Math.floor(m.premiumSinceTimestamp / 1000)}:D>` : '—'}` +
          (link ? `\n🔗 Roblox: **${link.robloxUsername}** (\`${link.robloxId}\`)` : `\n🔗 Roblox: _not linked_`) +
          (lvl ? `\n🏆 Level **${lvl.level || 0}** (${lvl.xp || 0} XP, ${lvl.msgs || 0} msgs)` : ''));
        e.setThumbnail(u.displayAvatarURL({ size: 256 }));
        return interaction.reply({ embeds: [e] });
      }
      if (sub === 'server') {
        const g = interaction.guild;
        await g.members.fetch().catch(() => {});
        const linked = Object.keys(db.links).length;
        const chans = g.channels.cache;
        const e = baddieEmbed(`🏠 ${g.name}`, `${THEME.DIV}\n👥 Members: **${g.memberCount}** (humans **${g.members.cache.filter(m => !m.user.bot).size}** • bots **${g.members.cache.filter(m => m.user.bot).size}**)\n` +
          `💬 Channels: **${chans.filter(c => c.type === 0).size}** text • 🔊 **${chans.filter(c => c.type === 2).size}** voice • 📁 **${chans.filter(c => c.type === 4).size}** cats\n` +
          `🎭 Roles: **${g.roles.cache.size}** • 😀 Emojis: **${g.emojis.cache.size}**\n` +
          `💜 Boosts: **${g.premiumSubscriptionCount || 0}** (lvl ${g.premiumTier || 0})\n` +
          `🔗 Linked Roblox: **${linked}** • 👑 Owner: <@${g.ownerId}>\nCreated: <t:${Math.floor(g.createdTimestamp / 1000)}:D>`);
        if (g.iconURL()) e.setThumbnail(g.iconURL({ size: 256 }));
        if (g.bannerURL()) e.setImage(g.bannerURL({ size: 1024 }));
        return interaction.reply({ embeds: [e] });
      }
      if (sub === 'role') {
        const r = interaction.options.getRole('role', true);
        const e = embedBase(`🎭 @${r.name}`, `${THEME.DIV}\nID: \`${r.id}\`\nMembers: **${r.members.size}**\nColor: \`${r.hexColor}\` • Hoist: ${r.hoist ? 'yes' : 'no'} • Mentionable: ${r.mentionable ? 'yes' : 'no'}\nCreated: <t:${Math.floor(r.createdTimestamp / 1000)}:D>\nPosition: **${r.position}**`, r.color || THEME.PINK);
        return interaction.reply({ embeds: [e] });
      }
      if (sub === 'channel') {
        const c = interaction.options.getChannel('channel') || interaction.channel;
        return interaction.reply({ embeds: [embedBase('📺 #' + (c.name || c.id), `${THEME.DIV}\nID: \`${c.id}\`\nType: \`${c.type}\`${c.topic ? `\nTopic: ${c.topic.slice(0, 200)}` : ''}${c.rateLimitPerUser ? `\nSlowmode: **${c.rateLimitPerUser}s**` : ''}${c.parent ? `\nCategory: **${c.parent.name}**` : ''}\nCreated: <t:${Math.floor(c.createdTimestamp / 1000)}:D>`)] });
      }
      if (sub === 'bot') {
        const e = baddieEmbed('🌸 Summer Baddies — bot stats', `${THEME.DIV}\n🏓 WS: **${Math.round(client.ws.ping)}ms**\n⏰ Uptime: <t:${Math.floor((Date.now() - (client.uptime || 0)) / 1000)}:R>\n🌍 Guilds: **${client.guilds.cache.size}** • 👥 Users: **${client.users.cache.size}**\n⌨️ Commands: **${commands.length}** slash\n💎 Values: ${db.valuesCache.at ? `${Object.keys(db.valuesCache.byKey).length} live` : 'seeds'} • 🔗 Links: **${Object.keys(db.links).length}**`);
        if (client.user.displayAvatarURL()) e.setThumbnail(client.user.displayAvatarURL());
        return interaction.reply({ embeds: [e] });
      }
      if (sub === 'banner') {
        const u = interaction.options.getUser('user') || interaction.user;
        try {
          const full = await client.users.fetch(u.id, { force: true });
          const b = full.bannerURL({ size: 1024 });
          if (!b) return interaction.reply({ content: `${u.username} has no banner 💅`, ephemeral: true });
          return interaction.reply({ embeds: [baddieEmbed(`🎨 ${u.username}'s banner`, '').setImage(b)] });
        } catch { return interaction.reply({ content: 'Could not fetch banner.', ephemeral: true }); }
      }
    }
    if (cmd === 'fun') {
      const sub = interaction.options.getSubcommand();
      const gifActs = { hug: 'hug', pat: 'pat', slap: 'slap', kiss: 'kiss', cuddle: 'cuddle', cry: 'cry', dance: 'dance', bonk: 'bonk' };
      if (gifActs[sub]) {
        const target = interaction.options.getUser('user');
        const url = await waifuGif(gifActs[sub]);
        const txt = { hug: 'hugged', pat: 'patted', slap: 'slapped', kiss: 'kissed', cuddle: 'cuddled', cry: '', dance: '', bonk: 'bonked' }[sub];
        const desc = sub === 'cry' ? `<@${interaction.user.id}> is crying 😭 *hug them!*` : sub === 'dance' ? `<@${interaction.user.id}> hit the dance floor 💃🕺` : `<@${interaction.user.id}> ${txt} ${target ? `<@${target.id}>` : 'themselves'} 💅`;
        const e = baddieEmbed(sub === 'cry' ? '😭 cry' : sub === 'dance' ? '💃 dance' : `💖 ${sub}`, desc, THEME.HOT);
        if (url) e.setImage(url);
        return interaction.reply({ embeds: [e] });
      }
      if (sub === 'ship') {
        const a = interaction.options.getUser('user1', true);
        const b = interaction.options.getUser('user2') || interaction.user;
        let h = 0; for (const c of (a.id + b.id)) h = (h * 31 + c.charCodeAt(0)) % 101;
        const pct = a.id === b.id ? 100 : h;
        const bar = '💖'.repeat(Math.round(pct / 20)) + '🤍'.repeat(5 - Math.round(pct / 20));
        const verdict = pct >= 90 ? 'SOULMATES 💍✨' : pct >= 70 ? 'Cute couple 💅💖' : pct >= 50 ? 'Could work 👀' : pct >= 30 ? 'Friendzone 😭' : 'NO chemistry 🙅‍♀️';
        return interaction.reply({ embeds: [embedBase(`💘 ${a.username} × ${b.username}`, `${bar} **${pct}%**\n**${verdict}**`, THEME.HOT)] });
      }
      if (sub === '8ball') {
        const q = interaction.options.getString('question', true);
        return interaction.reply({ embeds: [embedBase('🔮 Magic 8-ball', `> *${q.slice(0, 200)}*\n\n**${EIGHTBALL[Math.floor(Math.random() * EIGHTBALL.length)]}**`, THEME.PURPLE)] });
      }
      if (sub === 'truth') return interaction.reply({ embeds: [embedBase('❓ Truth', TRUTHS[Math.floor(Math.random() * TRUTHS.length)], THEME.BLUE)] });
      if (sub === 'dare') return interaction.reply({ embeds: [embedBase('🔥 Dare', DARES[Math.floor(Math.random() * DARES.length)], THEME.RED)] });
      if (sub === 'roast') {
        const u = interaction.options.getUser('user');
        return interaction.reply({ embeds: [embedBase('😈 Roast', `${u ? `<@${u.id}> ` : ''}${ROASTS[Math.floor(Math.random() * ROASTS.length)]}`, THEME.RED)] });
      }
      if (sub === 'compliment') {
        const u = interaction.options.getUser('user');
        return interaction.reply({ embeds: [embedBase('💖 Compliment', `${u ? `<@${u.id}> ` : ''}${COMPS[Math.floor(Math.random() * COMPS.length)]}`, THEME.MINT)] });
      }
      if (sub === 'rps') {
        const you = interaction.options.getString('choice', true);
        const bot = ['rock', 'paper', 'scissors'][Math.floor(Math.random() * 3)];
        const win = (you === 'rock' && bot === 'scissors') || (you === 'paper' && bot === 'rock') || (you === 'scissors' && bot === 'paper');
        const tie = you === bot;
        const em = { rock: '🪨', paper: '📄', scissors: '✂️' };
        return interaction.reply({ embeds: [embedBase('✂️ Rock Paper Scissors', `${em[you]} you: **${you}** vs ${em[bot]} bot: **${bot}**\n\n${tie ? "It's a tie! 👀" : win ? 'You win! 💅✨' : 'Bot wins 😭'}`, THEME.PURPLE)] });
      }
      if (sub === 'coinflip') {
        const win = Math.random() < 0.5;
        return interaction.reply({ embeds: [embedBase('🪙 Coinflip', win ? '**HEADS** ✨' : '**TAILS** 🌙', THEME.GOLD)] });
      }
      if (sub === 'dice') {
        const n = 1 + Math.floor(Math.random() * 6);
        return interaction.reply({ embeds: [embedBase('🎲 d6', `You rolled **${n}** ${'⚀⚁⚂⚃⚄⚅'[n - 1]}`, THEME.BLUE)] });
      }
    }
    if (cmd === 'coins') {
      const sub = interaction.options.getSubcommand();
      const uid = interaction.user.id;
      const me = getEcon(uid);
      if (sub === 'balance') {
        const u = interaction.options.getUser('user') || interaction.user;
        const e2 = getEcon(u.id);
        const total = (e2.wallet || 0) + (e2.bank || 0);
        return interaction.reply({ embeds: [econEmbed(`${u.username}'s balance`, `${THEME.DIV}\n👛 Wallet: **${fmtCoins(e2.wallet)}** 🪙\n🏦 Bank: **${fmtCoins(e2.bank)}** 🪙\n💎 Total: **${fmtCoins(total)}** 🪙`)] });
      }
      if (sub === 'daily') {
        if (Date.now() - (me.lastDaily || 0) < 86400000) return interaction.reply({ content: `⏳ Daily in **${msToDur(86400000 - (Date.now() - me.lastDaily))}**.`, ephemeral: true });
        me.lastDaily = Date.now(); me.wallet += 500; save();
        return interaction.reply({ embeds: [econEmbed('Daily claimed!', `+**500** 🪙 → wallet **${fmtCoins(me.wallet)}**\nCome back tomorrow baddie 🌸`)] });
      }
      if (sub === 'weekly') {
        if (Date.now() - (me.lastWeekly || 0) < 7 * 86400000) return interaction.reply({ content: `⏳ Weekly in **${msToDur(7 * 86400000 - (Date.now() - me.lastWeekly))}**.`, ephemeral: true });
        me.lastWeekly = Date.now(); me.wallet += 2500; save();
        return interaction.reply({ embeds: [econEmbed('Weekly claimed!', `+**2,500** 🪙 → wallet **${fmtCoins(me.wallet)}** 💅`)] });
      }
      if (sub === 'work') {
        if (Date.now() - (me.lastWork || 0) < 3600000) return interaction.reply({ content: `⏳ Work cooldown **${msToDur(3600000 - (Date.now() - me.lastWork))}**.`, ephemeral: true });
        me.lastWork = Date.now();
        const pay = 150 + Math.floor(Math.random() * 251);
        me.wallet += pay; save();
        const jobs = ['served baddie lattes ☕', 'modeled for the boutique 📸', 'ran the trading plaza 💎', 'DJd the event stage 🎧'];
        return interaction.reply({ embeds: [econEmbed('Work shift done!', `You ${jobs[Math.floor(Math.random() * jobs.length)]} and earned **${pay}** 🪙\nWallet: **${fmtCoins(me.wallet)}**`)] });
      }
      if (sub === 'beg') {
        if (Date.now() - (me.lastBeg || 0) < 45000) return interaction.reply({ content: `⏳ Beg again in **${msToDur(45000 - (Date.now() - me.lastBeg))}**.`, ephemeral: true });
        me.lastBeg = Date.now();
        const amt = 10 + Math.floor(Math.random() * 91);
        me.wallet += amt; save();
        return interaction.reply({ embeds: [econEmbed('Begging...', `Someone felt generous: +**${amt}** 🪙 🥺\nWallet: **${fmtCoins(me.wallet)}**`)] });
      }
      if (sub === 'crime') {
        if (Date.now() - (me.lastCrime || 0) < 600000) return interaction.reply({ content: `⏳ Crime cooldown **${msToDur(600000 - (Date.now() - me.lastCrime))}**.`, ephemeral: true });
        me.lastCrime = Date.now();
        if (Math.random() < 0.55) {
          const win = 300 + Math.floor(Math.random() * 501);
          me.wallet += win; save();
          return interaction.reply({ embeds: [econEmbed('Crime paid off 🥷', `You snatched **${win}** 🪙 and got away clean!\nWallet: **${fmtCoins(me.wallet)}**`)] });
        }
        const fine = Math.min(me.wallet, 150 + Math.floor(Math.random() * 200));
        me.wallet -= fine; save();
        return interaction.reply({ embeds: [embedBase('🚨 Busted!', `Security caught you! Fine: **${fine}** 🪙 😭\nWallet: **${fmtCoins(me.wallet)}**`, THEME.RED)] });
      }
      if (sub === 'rob') {
        const victim = interaction.options.getUser('user', true);
        if (victim.id === uid) return interaction.reply({ content: 'You cannot rob yourself 😭', ephemeral: true });
        if (victim.bot) return interaction.reply({ content: 'Bots have no coins 🤖', ephemeral: true });
        if (Date.now() - (me.lastCrime || 0) < 3600000) return interaction.reply({ content: `⏳ Rob cooldown **${msToDur(3600000 - (Date.now() - me.lastCrime))}**.`, ephemeral: true });
        const v = getEcon(victim.id);
        if ((v.wallet || 0) < 200) return interaction.reply({ content: 'They are too broke (needs 200+ wallet).', ephemeral: true });
        me.lastCrime = Date.now();
        if (Math.random() < 0.5) {
          const steal = Math.min(v.wallet, 100 + Math.floor(Math.random() * Math.min(500, v.wallet)));
          v.wallet -= steal; me.wallet += steal; save();
          return interaction.reply({ embeds: [econEmbed('Robbery success 🥷', `You stole **${steal}** 🪙 from ${victim.username}!\nYour wallet: **${fmtCoins(me.wallet)}**`)] });
        }
        const fine = Math.min(me.wallet, 200);
        me.wallet -= fine; save();
        return interaction.reply({ embeds: [embedBase('🚨 Rob failed!', `You got caught and paid **${fine}** 🪙 😭`, THEME.RED)] });
      }
      if (sub === 'pay') {
        const u = interaction.options.getUser('user', true);
        const amt = interaction.options.getInteger('amount', true);
        if (u.id === uid) return interaction.reply({ content: 'Pay yourself? Cute. No. 💅', ephemeral: true });
        if ((me.wallet || 0) < amt) return interaction.reply({ content: `Broke baddie — wallet **${fmtCoins(me.wallet)}**.`, ephemeral: true });
        me.wallet -= amt; getEcon(u.id).wallet += amt; save();
        return interaction.reply({ embeds: [econEmbed('Payment sent 🤝', `<@${uid}> → <@${u.id}>: **${fmtCoins(amt)}** 🪙`)] });
      }
      if (sub === 'deposit' || sub === 'withdraw') {
        const amt = interaction.options.getInteger('amount', true);
        if (sub === 'deposit') {
          if ((me.wallet || 0) < amt) return interaction.reply({ content: 'Not enough wallet cash.', ephemeral: true });
          me.wallet -= amt; me.bank += amt; save();
          return interaction.reply({ embeds: [econEmbed('Deposited 🏦', `**${fmtCoins(amt)}** 🪙 → bank **${fmtCoins(me.bank)}** (safe from rob)`)] });
        }
        if ((me.bank || 0) < amt) return interaction.reply({ content: 'Not enough bank cash.', ephemeral: true });
        me.bank -= amt; me.wallet += amt; save();
        return interaction.reply({ embeds: [econEmbed('Withdrew 👛', `**${fmtCoins(amt)}** 🪙 → wallet **${fmtCoins(me.wallet)}**`)] });
      }
      if (sub === 'slots') {
        const bet = interaction.options.getInteger('bet', true);
        if ((me.wallet || 0) < bet) return interaction.reply({ content: `Need **${bet}** wallet (you have **${fmtCoins(me.wallet)}**).`, ephemeral: true });
        const sym = ['🍒', '💎', '🌸', '⭐', '💰'];
        const r = [sym[Math.floor(Math.random() * sym.length)], sym[Math.floor(Math.random() * sym.length)], sym[Math.floor(Math.random() * sym.length)]];
        if (r[0] === r[1] && r[1] === r[2]) { me.wallet += bet * 2; save(); return interaction.reply({ embeds: [econEmbed('JACKPOT 🎰', `${r.join(' ')} — you won **${bet * 3}** 🪙 (net +${bet * 2})!`)] }); }
        if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) { me.wallet += Math.floor(bet * 0.5); save(); return interaction.reply({ embeds: [econEmbed('Small win 🎰', `${r.join(' ')} — pair! +**${Math.floor(bet * 0.5)}** 🪙`)] }); }
        me.wallet -= bet; save();
        return interaction.reply({ embeds: [embedBase('🎰 Slots — lost', `${r.join(' ')} — lost **${bet}** 🪙 😭\nWallet: **${fmtCoins(me.wallet)}**`, THEME.RED)] });
      }
      if (sub === 'top') {
        const sorted = Object.entries(db.economy).map(([id, e]) => ({ id, total: (e.wallet || 0) + (e.bank || 0) })).sort((a, b) => b.total - a.total).slice(0, 10);
        if (!sorted.length) return interaction.reply({ content: 'No coins yet — `/coins daily` to start!', ephemeral: true });
        const lines = sorted.map((x, i) => `**${i + 1}.** <@${x.id}> — **${fmtCoins(x.total)}** 🪙`);
        return interaction.reply({ embeds: [econEmbed('Richest baddies 🏆', lines.join('\n'))] });
      }
    }
    if (cmd === 'tag') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'add') {
        const st = await requireStaff(interaction); if (!st) return;
        const name = interaction.options.getString('name', true).toLowerCase().trim().replace(/\s+/g, '-').slice(0, 32);
        if (!/^[a-z0-9-_]{1,32}$/.test(name)) return interaction.reply({ content: 'Tag name: lowercase letters/numbers/dash only.', ephemeral: true });
        const content = interaction.options.getString('content', true).slice(0, 1500);
        db.tags[name] = { content, by: interaction.user.tag, at: Date.now(), uses: 0 }; save();
        return interaction.reply({ embeds: [okEmbed('Tag saved', `Use with \`/tag use:${name}\` 🏷️`)], ephemeral: true });
      }
      if (sub === 'use') {
        const name = interaction.options.getString('name', true).toLowerCase();
        const t = db.tags[name];
        if (!t) return interaction.reply({ content: `No tag \`${name}\`. Try /tag list.`, ephemeral: true });
        t.uses = (t.uses || 0) + 1; save();
        return interaction.reply({ embeds: [baddieEmbed(`🏷️ ${name}`, t.content).setFooter({ text: `🌸 by ${t.by} • used ${t.uses}x` })] });
      }
      if (sub === 'list') {
        const keys = Object.keys(db.tags || {}).sort();
        if (!keys.length) return interaction.reply({ content: 'No tags yet. Staff: /tag add', ephemeral: true });
        return interaction.reply({ embeds: [baddieEmbed('🏷️ Tags', keys.slice(0, 30).map(k => `\`${k}\` — used ${(db.tags[k].uses || 0)}x`).join('\n'))], ephemeral: true });
      }
      if (sub === 'remove') {
        const st = await requireStaff(interaction); if (!st) return;
        const name = interaction.options.getString('name', true).toLowerCase();
        if (!db.tags[name]) return interaction.reply({ content: 'Tag not found.', ephemeral: true });
        delete db.tags[name]; save();
        return interaction.reply({ embeds: [okEmbed('Deleted', `Tag \`${name}\` gone.`)] , ephemeral: true });
      }
    }
    if (cmd === 'giveaway') {
      const sub = interaction.options.getSubcommand();
      const st = await requireStaff(interaction); if (!st) return;
      if (sub === 'start') {
        const prize = interaction.options.getString('prize', true).slice(0, 200);
        const winners = interaction.options.getInteger('winners') || 1;
        const durStr = interaction.options.getString('duration', true);
        const ms = parseDuration(durStr);
        if (!ms) return interaction.reply({ content: 'Duration like `10m`, `1h`, `1d` (10s min).', ephemeral: true });
        const ch = interaction.options.getChannel('channel') || interaction.channel;
        if (!ch.isTextBased()) return interaction.reply({ content: 'Pick a text channel.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const endsAt = Date.now() + ms;
        const msg = await ch.send({ embeds: [embedBase('🎉 ' + prize, `Hosted by <@${interaction.user.id}>\nWinners: **${winners}** • Ends <t:${Math.floor(endsAt / 1000)}:R>\nEntries: **0**\n\nHit **Enter** below! 💅`, THEME.GOLD)] ,
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gw_join_PENDING').setLabel('Enter 🎉').setStyle(ButtonStyle.Success))] });
        db.giveaways[msg.id] = { messageId: msg.id, channelId: ch.id, guildId: interaction.guildId, prize, winners, endsAt, by: interaction.user.id, entrants: [], ended: false };
        save();
        try { await msg.edit({ components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gw_join_' + msg.id).setLabel('Enter 🎉').setStyle(ButtonStyle.Success))] }); } catch {}
        return interaction.editReply(`✅ Giveaway live in <#${ch.id}> — ends in **${durStr}**!`);
      }
      if (sub === 'end' || sub === 'reroll') {
        const mid = interaction.options.getString('messageid', true).trim();
        await interaction.deferReply({ ephemeral: true });
        const g = await endGiveaway(interaction.guild, mid, sub === 'reroll');
        if (!g) return interaction.editReply('❌ Giveaway not found (wrong message ID?).');
        const w = g.winnerIds || [];
        return interaction.editReply(w.length ? `✅ Done — winners: ${w.map(id => `<@${id}>`).join(', ')}` : '✅ Ended with no entries.');
      }
    }
    if (cmd === 'suggest') {
      const text = interaction.options.getString('text', true).slice(0, 500);
      const chId = db.suggestions.channelId;
      if (!chId) return interaction.reply({ content: '❌ Suggestions not set up. Staff: `/suggestions setup`.', ephemeral: true });
      const ch = await interaction.guild.channels.fetch(chId).catch(() => null);
      if (!ch || !ch.isTextBased()) return interaction.reply({ content: '❌ Suggestion channel missing. Staff: re-run `/suggestions setup`.', ephemeral: true });
      const id = db.suggestions.nextId || 1;
      db.suggestions.nextId = id + 1;
      db.suggestions.items[id] = { id, authorId: interaction.user.id, text, status: 'pending', up: [], down: [], at: Date.now() };
      save();
      const msg = await ch.send({ embeds: [baddieEmbed(`💡 Suggestion #${id}`, `${text}\n${THEME.DIV}\nBy <@${interaction.user.id}> • 👍 0 • 👎 0`)],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('sug_up_' + id).setLabel('👍').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('sug_down_' + id).setLabel('👎').setStyle(ButtonStyle.Danger))] });
      db.suggestions.items[id].messageId = msg.id; save();
      return interaction.reply({ embeds: [okEmbed('Suggested!', `Posted as **#${id}** in <#${chId}> 💡`)], ephemeral: true });
    }
    if (cmd === 'suggestions') {
      const sub = interaction.options.getSubcommand();
      const st = await requireStaff(interaction); if (!st) return;
      if (sub === 'setup') {
        const ch = interaction.options.getChannel('channel', true);
        db.suggestions.channelId = ch.id; save();
        return interaction.reply({ embeds: [okEmbed('Suggestions live', `Post with \`/suggest\` → <#${ch.id}> 💡`)], ephemeral: true });
      }
      if (sub === 'list') {
        const pend = Object.values(db.suggestions.items || {}).filter(x => x.status === 'pending').slice(-10).reverse();
        if (!pend.length) return interaction.reply({ content: 'No pending suggestions ✨', ephemeral: true });
        const lines = pend.map(x => `**#${x.id}** by <@${x.authorId}> — 👍${(x.up || []).length} 👎${(x.down || []).length}\n> ${String(x.text).slice(0, 120)}`);
        return interaction.reply({ embeds: [baddieEmbed('💡 Pending suggestions', lines.join('\n\n'))], ephemeral: true });
      }
      if (sub === 'accept' || sub === 'deny') {
        const id = interaction.options.getInteger('id', true);
        const reason = interaction.options.getString('reason') || '';
        const item = db.suggestions.items[id];
        if (!item) return interaction.reply({ content: 'Suggestion # not found.', ephemeral: true });
        item.status = sub === 'accept' ? 'accepted ✅' : 'denied ❌';
        save();
        try {
          const ch = await interaction.guild.channels.fetch(db.suggestions.channelId).catch(() => null);
          if (ch && ch.isTextBased() && item.messageId) {
            const m = await ch.messages.fetch(item.messageId).catch(() => null);
            if (m) await m.edit({ embeds: [embedBase(`💡 Suggestion #${id} — ${item.status}`, `${item.text}\n${THEME.DIV}\nBy <@${item.authorId}>${reason ? `\nStaff: *${reason.slice(0, 200)}*` : ''}`, sub === 'accept' ? THEME.MINT : THEME.RED)], components: [] }).catch(() => {});
          }
        } catch {}
        return interaction.reply({ embeds: [okEmbed(sub === 'accept' ? 'Accepted' : 'Denied', `**#${id}** marked ${item.status}`)], ephemeral: true });
      }
    }
    if (cmd === 'poll') {
      const q = interaction.options.getString('question', true).slice(0, 256);
      const opts = [interaction.options.getString('option1', true), interaction.options.getString('option2', true), interaction.options.getString('option3'), interaction.options.getString('option4')].filter(Boolean);
      const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
      const desc = opts.map((o, i) => `${emojis[i]} ${o}`).join('\n');
      const msg = await interaction.reply({ embeds: [embedBase('📊 ' + q, `${desc}\n${THEME.DIV}\nAsked by <@${interaction.user.id}>`, THEME.BLUE)], fetchReply: true });
      for (let i = 0; i < opts.length; i++) { try { await msg.react(emojis[i]); } catch {} }
      return;
    }
    if (cmd === 'send') {
      const st = await requireStaff(interaction); if (!st) return;
      const sub = interaction.options.getSubcommand();
      const ch = interaction.options.getChannel('channel') || interaction.channel;
      if (!ch.isTextBased()) return interaction.reply({ content: 'Pick a text channel.', ephemeral: true });
      if (sub === 'say') {
        const text = interaction.options.getString('text', true).slice(0, 1500);
        await ch.send(text).catch(() => {});
        return interaction.reply({ content: `✅ Sent in <#${ch.id}>`, ephemeral: true });
      }
      const title = interaction.options.getString('title', true).slice(0, 256);
      const description = interaction.options.getString('description', true).replace(/\\n/g, '\n').slice(0, 3000);
      const colorName = (interaction.options.getString('color') || 'pink').toLowerCase();
      const colorMap = { pink: THEME.PINK, gold: THEME.GOLD, mint: THEME.MINT, purple: THEME.PURPLE, blue: THEME.BLUE, red: THEME.RED };
      const e = embedBase('📣 ' + title, description, colorMap[colorName] || THEME.PINK);
      const img = interaction.options.getString('image');
      if (img && img.startsWith('http')) e.setImage(img);
      await ch.send({ embeds: [e] }).catch(() => {});
      return interaction.reply({ content: `✅ Embed sent in <#${ch.id}>`, ephemeral: true });
    }
    if (cmd === 'remind') {
      const when = interaction.options.getString('when', true);
      const text = interaction.options.getString('text', true).slice(0, 300);
      const ms = parseDuration(when);
      if (!ms) return interaction.reply({ content: 'Use like `10s`, `5m`, `2h`, `1d` (10s min).', ephemeral: true });
      const at = Date.now() + ms;
      db.reminders.push({ userId: interaction.user.id, text, at }); save();
      setTimeout(async () => {
        try {
          const u = await client.users.fetch(interaction.user.id).catch(() => null);
          if (u) await u.send(`⏰ Reminder: **${text}**`).catch(() => {});
        } catch {}
        db.reminders = (db.reminders || []).filter(r => !(r.userId === interaction.user.id && r.text === text && r.at === at));
        save();
      }, ms);
      return interaction.reply({ embeds: [okEmbed('Reminder set', `I'll DM you in **${when}**: *${text}* ⏰`)], ephemeral: true });
    }
    if (cmd === 'config') {
      const sub = interaction.options.getSubcommand();
      const st = await requireStaff(interaction); if (!st) return;
      if (sub === 'set-logs') {
        const ch = interaction.options.getChannel('channel');
        db.modlog.channelId = ch ? ch.id : ''; save();
        return interaction.reply({ embeds: [okEmbed('Mod-log', ch ? `Logs → <#${ch.id}> 📝\n(deletes, edits, warns, mutes, bans)` : 'Mod-log disabled.')], ephemeral: true });
      }
      if (sub === 'autorole-add') {
        const r = interaction.options.getRole('role', true);
        if (!db.autoroles.includes(r.id)) db.autoroles.push(r.id);
        save();
        return interaction.reply({ embeds: [okEmbed('Autorole', `<@&${r.id}> will auto-give on join 👥\n(${db.autoroles.length} total)`)], ephemeral: true });
      }
      if (sub === 'autorole-remove') {
        const r = interaction.options.getRole('role', true);
        db.autoroles = db.autoroles.filter(id => id !== r.id); save();
        return interaction.reply({ embeds: [okEmbed('Removed', `<@&${r.id}> no longer auto-gives.`)], ephemeral: true });
      }
      if (sub === 'autorole-list') {
        if (!db.autoroles.length) return interaction.reply({ content: 'No autoroles. Add with `/config autorole-add`.', ephemeral: true });
        return interaction.reply({ embeds: [baddieEmbed('👥 Autoroles', db.autoroles.map(id => `<@&${id}>`).join('\n'))], ephemeral: true });
      }
      if (sub === 'set-suggestions') {
        const ch = interaction.options.getChannel('channel', true);
        db.suggestions.channelId = ch.id; save();
        return interaction.reply({ embeds: [okEmbed('Suggestions', `Channel → <#${ch.id}> 💡`)], ephemeral: true });
      }
    }

    // ----- STAFF -----
    const staffOnly = ['give-weapon', 'give-skin', 'give-finisher', 'player-data', 'game-kick', 'game-ban', 'game-unban', 'game-announce', 'game-restart', 'game-luck', 'admin-abuse', 'game-money', 'give-tokens', 'give-spins', 'give-all-weapon', 'give-all-skin', 'give-all-finisher', 'give-everything', 'give-all-tokens', 'give-all-spins', 'add-emoji', 'remove-emoji', 'force-pvp', 'unforce-pvp', 'force-show-emoji', 'unforce-show-emoji', 'shortcut-add', 'shortcut-remove', 'shortcut-list', 'shortcut-prefix', 'kick', 'ban', 'unban', 'timeout', 'untimeout', 'setup-welcome', 'setup-leave', 'setup-reports', 'setup-verified', 'setup-levels', 'setup-applications', 'selfroles', 'sync-levels', 'tickets', 'test-welcome', 'test-leave', 'linked-list', 'set-rules', 'send-tos', 'setup-layout'];
    if (staffOnly.includes(cmd)) {
      const staff = await requireStaff(interaction);
      if (!staff) return;
    }
    // ----- OWNER-ONLY: setup-roles / reset-layout (+ setup-layout handler lives below) -----
    if (cmd === 'setup-roles') {
      if (!await requireOwner(interaction)) return;
      await interaction.deferReply({ ephemeral: true });
      try {
        const r = await setupRoleLadder(interaction.guild);
        const lines = [
          `✅ Created (${r.created.length}): ${r.created.join(', ') || '—'}`,
          `⏭️ Skipped existing (${r.skipped.length}): ${r.skipped.join(', ') || '—'}`,
        ];
        if (r.failed.length) lines.push(`❌ Failed: ${r.failed.join(' | ')}`);
        if (r.orderWarning) lines.push(`⚠️ ${r.orderWarning}`);
        lines.push(`\nHoist: top 10 ON, bottom 4 OFF. No Manage Server/Roles below Co-Owner. Bot top position: ${r.botTop}.`);
        return interaction.editReply({ embeds: [embedBase('♛ Role ladder done', lines.join('\n').slice(0, 3900), 0xffd700)] });
      } catch (e) { return interaction.editReply({ content: '❌ ' + String(e.message || e).slice(0, 300) }); }
    }
    if (cmd === 'setup-layout') {
      // staff gate already passed above
      await interaction.deferReply({ ephemeral: true });
      try {
        const preset = interaction.options.getString('preset');
        const desc = interaction.options.getString('description');
        let layout = [];
        const warnings = [];
        if (preset === 'baddies' || (!preset && !desc)) layout.push(...getBaddiesPreset());
        if (desc) {
          const parsed = parseLayoutDescription(desc);
          layout.push(...parsed.layout);
          warnings.push(...parsed.warnings);
          if (!parsed.layout.length) warnings.push('Description parsed to 0 channels — check DSL format.');
        }
        if (!layout.length) return interaction.editReply({ content: '❌ Give me a preset (`baddies`) or a description.\nDSL:\n```\nCategory: Info\n#rules (Server rules)\n#announcements (Official news)\nVoice: Lobby\n```' });
        const res = await applyLayout(interaction.guild, layout);
        const lines = [
          `Categories: +${res.createdCats.length} created, ${res.skippedCats.length} skipped`,
          `Channels: +${res.createdChs.length} created${res.createdChs.length ? ` (${res.createdChs.slice(0, 12).join(', ')})` : ''}, ${res.skippedChs.length} skipped`,
        ];
        if (res.wired.length) lines.push(`🔌 Auto-wired: ${res.wired.join(' • ')}`);
        if (warnings.length) lines.push(`⚠️ DSL: ${warnings.slice(0, 5).join(' | ')}`);
        if (res.failed.length) lines.push(`❌ Failed: ${res.failed.slice(0, 5).join(' | ')}`);
        lines.push('\nRead-only: welcome/rules/announcements/events/giveaways/event-winners (send = Owner→Community Manager). Others open to @everyone.');
        return interaction.editReply({ embeds: [embedBase('🏗️ Layout applied', lines.join('\n').slice(0, 3900), 0x57f287)] });
      } catch (e) { return interaction.editReply({ content: '❌ ' + String(e.message || e).slice(0, 300) }); }
    }
    if (cmd === 'reset-layout') {
      if (!await requireOwner(interaction)) return;
      const confirm = interaction.options.getString('confirm', true);
      if (confirm !== 'CONFIRM') return interaction.reply({ content: '❌ Type `CONFIRM` exactly (all caps) to proceed. Nothing was deleted.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      try {
        const wipe = await resetGuildLayout(interaction.guild);
        const preset = interaction.options.getString('preset');
        const desc = interaction.options.getString('description');
        let layout = [];
        const warnings = [];
        if (desc) {
          const parsed = parseLayoutDescription(desc);
          layout.push(...parsed.layout);
          warnings.push(...parsed.warnings);
        }
        if (preset === 'baddies' || (!preset && !desc)) layout.push(...getBaddiesPreset());
        let applyLines = ['No layout applied (no preset/description given).'];
        if (layout.length) {
          const res = await applyLayout(interaction.guild, layout);
          applyLines = [
            `Rebuilt: +${res.createdCats.length} categories, +${res.createdChs.length} channels, ${res.skippedChs.length} skipped.`,
            ...(res.wired.length ? [`🔌 Auto-wired: ${res.wired.join(' • ')}`] : []),
            ...(res.failed.length ? [`❌ Rebuild failures: ${res.failed.slice(0, 5).join(' | ')}`] : []),
          ];
        }
        const lines = [
          `🗑️ Channels deleted (${wipe.delCh.length}): ${wipe.delCh.slice(0, 10).join(', ') || '—'}`,
          ...(wipe.failCh.length ? [`⚠️ Channels kept: ${wipe.failCh.slice(0, 5).join(' | ')}`] : []),
          `🗑️ Roles deleted (${wipe.delRoles.length}): ${wipe.delRoles.slice(0, 10).join(', ') || '—'}`,
          `🛡️ Roles kept (${wipe.keptRoles.length}): ${wipe.keptRoles.slice(0, 8).join(' | ') || '—'}`,
          ...applyLines,
          ...warnings.slice(0, 3).map(w => `⚠️ ${w}`),
        ];
        return interaction.editReply({ embeds: [embedBase('💥 Reset complete', lines.join('\n').slice(0, 3900), 0xed4245)] });
      } catch (e) { return interaction.editReply({ content: '❌ ' + String(e.message || e).slice(0, 300) }); }
    }
    if (cmd === 'give-weapon' || cmd === 'give-skin' || cmd === 'give-finisher') {
      const username = interaction.options.getString('username', true);
      const r = await robloxUserId(username);
      if (!r) return interaction.reply({ content: '❌ Roblox user not found.', ephemeral: true });
      let payload;
      if (cmd === 'give-weapon') payload = { type: 'give_weapon', robloxUsername: r.name, robloxId: r.id, weapon: interaction.options.getString('weapon', true), by: interaction.user.tag };
      if (cmd === 'give-finisher') payload = { type: 'give_finisher', robloxUsername: r.name, robloxId: r.id, finisher: interaction.options.getString('finisher', true), by: interaction.user.tag };
      if (cmd === 'give-skin') payload = { type: 'give_skin', robloxUsername: r.name, robloxId: r.id, weaponType: interaction.options.getString('weapontype', true), skin: interaction.options.getString('skin', true), by: interaction.user.tag };
      const id = queueCommand(payload);
      return interaction.reply({ embeds: [embedBase('✅ Queued for game', `\`${payload.type}\` → **${r.name}**\nQueue ID: \`${id}\`\nGame servers poll every ~5s and grant it if the player is online. If offline, it stays queued 10 min.`, 0x57f287)] });
    }
    if (cmd === 'give-everything') {
      const username = interaction.options.getString('username', true);
      const r = await robloxUserId(username);
      if (!r) return interaction.reply({ content: '❌ Roblox user not found.', ephemeral: true });
      const category = interaction.options.getString('category') || 'everything';
      const payload = { type: 'give_everything', robloxUsername: r.name, robloxId: r.id, category, by: interaction.user.tag };
      const id = queueCommand(payload);
      return interaction.reply({ embeds: [embedBase('✅ Queued give-everything', `\`${category}\` → **${r.name}**\nQueue ID: \`${id}\`\nThe live server holding them grants all weapons/skins/finishers (skips dupes) and confirms in game chat.`, 0x57f287)] });
    }
    if (cmd === 'player-data') {
      const username = interaction.options.getString('username', true);
      const r = await robloxUserId(username);
      if (!r) return interaction.reply({ content: '❌ Not found.', ephemeral: true });
      const cached = db.playerCache[r.id];
      const inv = db.inventories[r.id];
      const thumb = await robloxThumb(r.id);
      const tp = inv && inv.placeId && inv.jobId ? `\n🚀 [Join server](${teleportLink(inv.placeId, inv.jobId)})` : '';
      const e = embedBase('📊 ' + r.name, cached ? `💰 Dinero: **${cached.money}**\n⚔️ Slays: **${cached.slays}**\n🎒 Weapons(${cached.weapons}) Skins(${cached.skins}) Finishers(${cached.finishers})\n🟢 Updated: <t:${Math.floor(cached.at / 1000)}:R>\nDiscord: ${db.robloxToDiscord[r.id] ? `<@${db.robloxToDiscord[r.id]}>` : 'not linked'}${tp}` +
        (inv ? `\n\nTracked items: W:${(inv.weapons || []).length} S:${(inv.skins || []).length} F:${(inv.finishers || []).length}` : '') : 'No cached data — player offline or bridge not yet reporting. Use /search-player for Roblox profile.');
      if (thumb) e.setThumbnail(thumb);
      return interaction.reply({ embeds: [e], ephemeral: true });
    }
    if (cmd === 'give-all-weapon' || cmd === 'give-all-skin' || cmd === 'give-all-finisher') {
      let payload;
      if (cmd === 'give-all-weapon') payload = { type: 'give_all_weapon', weapon: interaction.options.getString('weapon', true), by: interaction.user.tag, broadcast: true };
      if (cmd === 'give-all-finisher') payload = { type: 'give_all_finisher', finisher: interaction.options.getString('finisher', true), by: interaction.user.tag, broadcast: true };
      if (cmd === 'give-all-skin') payload = { type: 'give_all_skin', weaponType: interaction.options.getString('weapontype', true), skin: interaction.options.getString('skin', true), by: interaction.user.tag, broadcast: true };
      const id = queueCommand(payload);
      return interaction.reply({ embeds: [embedBase('✅ Queued for EVERYONE online', `\`${payload.type}\` → **${payload.weapon || payload.skin || payload.finisher}**\nQueue ID: \`${id}\`\nEvery live server gives it to all its players within ~5s. Broadcast expires after 3 min.`, 0x57f287)] });
    }
    if (cmd === 'give-all-tokens' || cmd === 'give-all-spins') {
      let payload;
      if (cmd === 'give-all-tokens') payload = { type: 'give_all_tokens', amount: interaction.options.getInteger('amount', true), by: interaction.user.tag, broadcast: true };
      if (cmd === 'give-all-spins') payload = { type: 'give_all_spins', kind: interaction.options.getString('type', true), amount: interaction.options.getInteger('amount', true), by: interaction.user.tag, broadcast: true };
      const id = queueCommand(payload);
      return interaction.reply({ embeds: [embedBase('✅ Queued for EVERYONE online', `\`${payload.type}\` × **${interaction.options.getInteger('amount', true)}**\nQueue ID: \`${id}\`\nEvery live server gives it to all its players within ~5s. Broadcast expires after 3 min.`, 0x57f287)] });
    }
    if (cmd === 'game-kick' || cmd === 'game-ban' || cmd === 'game-unban' || cmd === 'game-announce' || cmd === 'game-restart' || cmd === 'game-luck' || cmd === 'admin-abuse' || cmd === 'game-money' || cmd === 'give-tokens' || cmd === 'give-spins') {
      let payload = null;
      if (cmd === 'game-kick') { const u = await robloxUserId(interaction.options.getString('username', true)); if (!u) return interaction.reply({ content: '❌ Not found.', ephemeral: true }); payload = { type: 'kick', robloxUsername: u.name, robloxId: u.id, reason: interaction.options.getString('reason') || 'Kicked by staff', by: interaction.user.tag }; }
      if (cmd === 'game-ban') {
        const u = await robloxUserId(interaction.options.getString('username', true)); if (!u) return interaction.reply({ content: '❌ Not found.', ephemeral: true });
        const reason = interaction.options.getString('reason') || 'Banned by staff';
        payload = { type: 'ban', robloxUsername: u.name, robloxId: u.id, reason, by: interaction.user.tag };
        db.bans[u.id] = { reason, by: interaction.user.tag, at: Date.now() }; save();
        const syncD = interaction.options.getBoolean('syncdiscord');
        if (syncD !== false && db.robloxToDiscord[u.id]) {
          try { const m = await interaction.guild.members.fetch(db.robloxToDiscord[u.id]); await m.ban({ reason: '[Game ban sync] ' + reason }); } catch {}
        }
      }
      if (cmd === 'game-unban') { const u = await robloxUserId(interaction.options.getString('username', true)); if (!u) return interaction.reply({ content: '❌ Not found.', ephemeral: true }); delete db.bans[u.id]; save(); payload = { type: 'unban', robloxUsername: u.name, robloxId: u.id, by: interaction.user.tag }; try { await interaction.guild.bans.remove(String(db.robloxToDiscord[u.id] || '')); } catch {} }
      if (cmd === 'game-announce') payload = { type: 'announce', message: interaction.options.getString('message', true).slice(0, 200), by: interaction.user.tag, broadcast: true };
      if (cmd === 'game-restart') payload = { type: 'restart', delay: interaction.options.getInteger('delay') || 30, reason: interaction.options.getString('reason') || 'Server restarting - please rejoin!', by: interaction.user.tag, broadcast: true };
      if (cmd === 'game-money') { const u = await robloxUserId(interaction.options.getString('username', true)); if (!u) return interaction.reply({ content: '❌ Not found.', ephemeral: true }); payload = { type: 'money', action: interaction.options.getString('action', true), robloxUsername: u.name, robloxId: u.id, amount: interaction.options.getInteger('amount', true), by: interaction.user.tag }; }
      if (cmd === 'give-tokens') { const u = await robloxUserId(interaction.options.getString('username', true)); if (!u) return interaction.reply({ content: '❌ Not found.', ephemeral: true }); payload = { type: 'give_tokens', action: interaction.options.getString('action', true), robloxUsername: u.name, robloxId: u.id, amount: interaction.options.getInteger('amount', true), by: interaction.user.tag }; }
      if (cmd === 'give-spins') { const u = await robloxUserId(interaction.options.getString('username', true)); if (!u) return interaction.reply({ content: '❌ Not found.', ephemeral: true }); payload = { type: 'give_spins', kind: interaction.options.getString('type', true), action: interaction.options.getString('action', true), robloxUsername: u.name, robloxId: u.id, amount: interaction.options.getInteger('amount', true), by: interaction.user.tag }; }
      if (cmd === 'game-luck') payload = { type: 'luck', mult: interaction.options.getInteger('mult', true), minutes: interaction.options.getInteger('minutes') || 10, by: interaction.user.tag, broadcast: true };
      if (cmd === 'admin-abuse') payload = { type: 'abuse', event: interaction.options.getString('event', true), duration: interaction.options.getInteger('duration') || 60, by: interaction.user.tag, broadcast: true };
      if (!payload || !payload.type) return interaction.reply({ content: '❌ Nothing to queue for this command.', ephemeral: true });
      queueCommand(payload);
      return interaction.reply({ embeds: [embedBase('✅ Sent to game', `\`${payload.type}\` queued. Online servers pick it up in ~5s.`, 0x57f287)], ephemeral: true });
    }
    if (cmd === 'add-emoji') {
      const usernameInput = interaction.options.getString('username');
      const useridInput = interaction.options.getInteger('userid');
      const emojiInput = (interaction.options.getString('emoji', true) || '').trim().slice(0, 16);
      if (!usernameInput && !useridInput) return interaction.reply({ content: 'Provide username OR userid (plus emoji).', ephemeral: true });
      if (!emojiInput) return interaction.reply({ content: 'Provide an emoji.', ephemeral: true });
      let rUsername = null, rId = null;
      if (usernameInput) {
        try {
          const r = await robloxUserId(usernameInput);
          if (r) { rUsername = r.name; rId = r.id; }
        } catch {}
      }
      if (useridInput) {
        rId = useridInput;
        if (!rUsername) {
          try {
            const rr = await fetch('https://users.roblox.com/v1/users/' + useridInput);
            const jj = await rr.json();
            if (jj && jj.name) rUsername = jj.name;
          } catch {}
        }
      }
      if (!rUsername && usernameInput) rUsername = usernameInput;
      if (!rId && !rUsername) return interaction.reply({ content: 'Roblox user not found.', ephemeral: true });
      const payload = { type: 'add_emoji', robloxUsername: rUsername, robloxId: rId, emoji: emojiInput, by: interaction.user.tag, broadcast: true };
      const qid = queueCommand(payload);
      return interaction.reply({ embeds: [embedBase('Emoji queued', '`' + emojiInput + '` to **' + (rUsername || rId) + '** (`' + rId + '`)\nQueue ID: `' + qid + '`\nLive servers apply in ~5s and persist via DataStore. In-game: ,hide / ,show.', 0x57f287)] });
    }
    if (cmd === 'remove-emoji') {
      const usernameInput = interaction.options.getString('username');
      const useridInput = interaction.options.getInteger('userid');
      if (!usernameInput && !useridInput) return interaction.reply({ content: 'Provide username OR userid.', ephemeral: true });
      let rUsername = null, rId = null;
      if (usernameInput) {
        try {
          const r = await robloxUserId(usernameInput);
          if (r) { rUsername = r.name; rId = r.id; }
        } catch {}
      }
      if (useridInput) {
        rId = useridInput;
        if (!rUsername) {
          try {
            const rr = await fetch('https://users.roblox.com/v1/users/' + useridInput);
            const jj = await rr.json();
            if (jj && jj.name) rUsername = jj.name;
          } catch {}
        }
      }
      if (!rUsername && usernameInput) rUsername = usernameInput;
      if (!rId && !rUsername) return interaction.reply({ content: 'Roblox user not found.', ephemeral: true });
      const payload = { type: 'remove_emoji', robloxUsername: rUsername, robloxId: rId, by: interaction.user.tag, broadcast: true };
      const qid = queueCommand(payload);
      return interaction.reply({ embeds: [embedBase('Emoji removal queued', 'Removed from **' + (rUsername || rId) + '** (`' + rId + '`)\nQueue ID: `' + qid + '`\nLive servers clear it in ~5s and persist via DataStore.', 0xed4245)] });
    }
    if (cmd === 'force-pvp') {
      const usernameInput = interaction.options.getString('username');
      const useridInput = interaction.options.getInteger('userid');
      if (!usernameInput && !useridInput) return interaction.reply({ content: 'Provide username OR userid.', ephemeral: true });
      let rUsername = null, rId = null;
      if (usernameInput) {
        try {
          const r = await robloxUserId(usernameInput);
          if (r) { rUsername = r.name; rId = r.id; }
        } catch {}
      }
      if (useridInput) {
        rId = useridInput;
        if (!rUsername) {
          try {
            const rr = await fetch('https://users.roblox.com/v1/users/' + useridInput);
            const jj = await rr.json();
            if (jj && jj.name) rUsername = jj.name;
          } catch {}
        }
      }
      if (!rUsername && usernameInput) rUsername = usernameInput;
      if (!rId && !rUsername) return interaction.reply({ content: 'Roblox user not found.', ephemeral: true });
      const payload = { type: 'force_pvp', robloxUsername: rUsername, robloxId: rId, by: interaction.user.tag, broadcast: true };
      const qid = queueCommand(payload);
      return interaction.reply({ embeds: [embedBase('PvP force-enabled', 'Forced PvP ON + locked for **' + (rUsername || rId) + '** (`' + rId + '`)\nQueue ID: `' + qid + '`\nLive servers apply in ~5s.', 0xed4245)] });
    }
    if (cmd === 'unforce-pvp') {
      const usernameInput = interaction.options.getString('username');
      const useridInput = interaction.options.getInteger('userid');
      if (!usernameInput && !useridInput) return interaction.reply({ content: 'Provide username OR userid.', ephemeral: true });
      let rUsername = null, rId = null;
      if (usernameInput) {
        try {
          const r = await robloxUserId(usernameInput);
          if (r) { rUsername = r.name; rId = r.id; }
        } catch {}
      }
      if (useridInput) {
        rId = useridInput;
        if (!rUsername) {
          try {
            const rr = await fetch('https://users.roblox.com/v1/users/' + useridInput);
            const jj = await rr.json();
            if (jj && jj.name) rUsername = jj.name;
          } catch {}
        }
      }
      if (!rUsername && usernameInput) rUsername = usernameInput;
      if (!rId && !rUsername) return interaction.reply({ content: 'Roblox user not found.', ephemeral: true });
      const payload = { type: 'unforce_pvp', robloxUsername: rUsername, robloxId: rId, by: interaction.user.tag, broadcast: true };
      const qid = queueCommand(payload);
      return interaction.reply({ embeds: [embedBase('PvP lock released', 'Released PvP lock for **' + (rUsername || rId) + '** (`' + rId + '`)\nQueue ID: `' + qid + '`\nLive servers apply in ~5s.', 0x57f287)] });
    }
    if (cmd === 'force-show-emoji') {
      const usernameInput = interaction.options.getString('username');
      const useridInput = interaction.options.getInteger('userid');
      if (!usernameInput && !useridInput) return interaction.reply({ content: 'Provide username OR userid.', ephemeral: true });
      let rUsername = null, rId = null;
      if (usernameInput) {
        try {
          const r = await robloxUserId(usernameInput);
          if (r) { rUsername = r.name; rId = r.id; }
        } catch {}
      }
      if (useridInput) {
        rId = useridInput;
        if (!rUsername) {
          try {
            const rr = await fetch('https://users.roblox.com/v1/users/' + useridInput);
            const jj = await rr.json();
            if (jj && jj.name) rUsername = jj.name;
          } catch {}
        }
      }
      if (!rUsername && usernameInput) rUsername = usernameInput;
      if (!rId && !rUsername) return interaction.reply({ content: 'Roblox user not found.', ephemeral: true });
      const payload = { type: 'force_show_emoji', robloxUsername: rUsername, robloxId: rId, by: interaction.user.tag, broadcast: true };
      const qid = queueCommand(payload);
      return interaction.reply({ embeds: [embedBase('Emoji force-shown', 'Force-showed emoji for **' + (rUsername || rId) + '** (`' + rId + '`)\nQueue ID: `' + qid + '`\nLive servers apply in ~5s.', 0x57f287)] });
    }
    if (cmd === 'unforce-show-emoji') {
      const usernameInput = interaction.options.getString('username');
      const useridInput = interaction.options.getInteger('userid');
      if (!usernameInput && !useridInput) return interaction.reply({ content: 'Provide username OR userid.', ephemeral: true });
      let rUsername = null, rId = null;
      if (usernameInput) {
        try {
          const r = await robloxUserId(usernameInput);
          if (r) { rUsername = r.name; rId = r.id; }
        } catch {}
      }
      if (useridInput) {
        rId = useridInput;
        if (!rUsername) {
          try {
            const rr = await fetch('https://users.roblox.com/v1/users/' + useridInput);
            const jj = await rr.json();
            if (jj && jj.name) rUsername = jj.name;
          } catch {}
        }
      }
      if (!rUsername && usernameInput) rUsername = usernameInput;
      if (!rId && !rUsername) return interaction.reply({ content: 'Roblox user not found.', ephemeral: true });
      const payload = { type: 'unforce_show_emoji', robloxUsername: rUsername, robloxId: rId, by: interaction.user.tag, broadcast: true };
      const qid = queueCommand(payload);
      return interaction.reply({ embeds: [embedBase('Emoji lock released', 'Released emoji lock for **' + (rUsername || rId) + '** (`' + rId + '`)\nQueue ID: `' + qid + '`\nLive servers apply in ~5s.', 0x57f287)] });
    }
    if (cmd === 'shortcut-add' || cmd === 'shortcut-remove' || cmd === 'shortcut-list' || cmd === 'shortcut-prefix') {
      if (!db.shortcuts.map) db.shortcuts.map = {};
      if (cmd === 'shortcut-prefix') {
        const pfx = (interaction.options.getString('prefix', true) || '').trim();
        if (pfx.length !== 1 || /[a-zA-Z0-9\s]/.test(pfx)) return interaction.reply({ content: 'Prefix must be ONE symbol (not a letter, number, or space). Try `,` `!` `.` `;`.', ephemeral: true });
        db.shortcuts.prefix = pfx; save();
        return interaction.reply({ embeds: [embedBase('Prefix updated', `Default prefix is now \`${pfx}\` — new shortcuts use it unless given their own. Existing shortcuts keep theirs.`, 0x57f287)], ephemeral: true });
      }
      if (cmd === 'shortcut-list') {
        const map = db.shortcuts.map;
        const keys = Object.keys(map).sort();
        if (!keys.length) return interaction.reply({ content: 'No shortcuts yet. Add one: `/shortcut-add command:game-ban letters:gb` → then type `,gb <user> [reason]`.', ephemeral: true });
        const lines = keys.map(k => `\`${(map[k].prefix || db.shortcuts.prefix || ',')}${k}\` → /${map[k].command} _(by ${map[k].by || 'staff'})_`);
        return interaction.reply({ embeds: [embedBase('⌨️ Text shortcuts', lines.join('\n').slice(0, 3900))], ephemeral: true });
      }
      if (cmd === 'shortcut-remove') {
        let raw = (interaction.options.getString('alias', true) || '').trim().toLowerCase();
        let key = raw;
        if (!(key in db.shortcuts.map) && key.length > 1 && !/[a-z0-9]/.test(key[0])) key = key.slice(1);
        if (!(key in db.shortcuts.map)) return interaction.reply({ content: `No shortcut \`${raw}\` found. See /shortcut-list.`, ephemeral: true });
        const gone = db.shortcuts.map[key];
        delete db.shortcuts.map[key]; save();
        return interaction.reply({ embeds: [embedBase('Shortcut removed', `\`${(gone.prefix || db.shortcuts.prefix || ',')}${key}\` (was /${gone.command}) deleted.`, 0xed4245)], ephemeral: true });
      }
      const which = interaction.options.getString('command', true);
      let letters = (interaction.options.getString('letters', true) || '').trim().toLowerCase();
      if (letters.length > 1 && !/[a-z0-9]/.test(letters[0])) letters = letters.slice(1);
      if (!SHORTCUT_COMMANDS.includes(which)) return interaction.reply({ content: 'Unknown command. Pick from autocomplete. Supported: `' + SHORTCUT_COMMANDS.join('`, `') + '`.', ephemeral: true });
      if (!/^[a-z0-9]{1,6}$/.test(letters)) return interaction.reply({ content: 'Letters must be 1-6 letters/numbers (e.g. `gb`).', ephemeral: true });
      let pfx = interaction.options.getString('prefix');
      if (pfx === null || pfx === undefined || pfx === '') pfx = db.shortcuts.prefix || ',';
      pfx = String(pfx).trim();
      if (pfx.length !== 1 || /[a-zA-Z0-9\s]/.test(pfx)) return interaction.reply({ content: 'Prefix must be ONE symbol (e.g. `,`).', ephemeral: true });
      if (db.shortcuts.map[letters]) {
        const e = db.shortcuts.map[letters];
        return interaction.reply({ content: `\`${pfx}${letters}\` is taken → /${e.command}. Remove it first with /shortcut-remove.`, ephemeral: true });
      }
      db.shortcuts.map[letters] = { command: which, prefix: pfx, by: interaction.user.tag, at: Date.now() };
      save();
      return interaction.reply({ embeds: [embedBase('Shortcut added', `Type \`${pfx}${letters}\` in chat to run **/${which}**.\nExample: \`${pfx}${letters} <args>\`. Full arg shapes: /shortcut-list + /help.`, 0x57f287)], ephemeral: true });
    }
    if (cmd === 'selfroles') {
      await interaction.deferReply({ ephemeral: true });
      const channelOpt = interaction.options.getChannel('channel');
      const channel = channelOpt || interaction.channel;
      if (!channel || !channel.isTextBased || !channel.isTextBased()) {
        return interaction.editReply({ content: 'Pick a text channel for self-roles.' });
      }
      try {
        const perms = channel.permissionsFor(await channel.guild.members.fetchMe());
        if (perms && (!perms.has('ViewChannel') || !perms.has('SendMessages') || !perms.has('EmbedLinks') || !perms.has('AddReactions'))) {
          return interaction.editReply({ content: 'I need View + Send Messages + Embed Links + Add Reactions in that channel.' });
        }
      } catch {}
      const setupRaw = interaction.options.getString('setup', true) || '';
      const normalized = setupRaw.replace(/\\n/g, '\n').replace(/;/g, '\n');
      const lines = normalized.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 10);
      if (!lines.length) return interaction.editReply({ content: '❌ Give me at least 1 line: `Label | emoji | @role`.' });
      const guild = interaction.guild;
      const entries = [];
      const errors = [];
      for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].split('|').map(s => s.trim());
        if (parts.length < 3) { errors.push(`Line ${i + 1}: need \`Label | emoji | @role\``); continue; }
        const label = parts[0], emojiRaw = parts[1], roleRaw = parts.slice(2).join('|').trim();
        let emojiId = null;
        const cm = emojiRaw.match(/^<a?:[^:]+:(\d+)>$/);
        if (cm) emojiId = cm[1];
        let role = null;
        const rm = roleRaw.match(/^<@&(\d+)>$/);
        if (rm) role = await guild.roles.fetch(rm[1]).catch(() => null);
        else if (/^\d+$/.test(roleRaw)) role = await guild.roles.fetch(roleRaw).catch(() => null);
        else role = guild.roles.cache.find(r => r.name.toLowerCase() === roleRaw.toLowerCase()) || null;
        if (!role) { errors.push(`Line ${i + 1}: role not found (${roleRaw})`); continue; }
        try {
          const me = await guild.members.fetchMe();
          if (role.position >= me.roles.highest.position) { errors.push(`Line ${i + 1}: I cannot give ${role.name} (it is at/above my top role)`); continue; }
        } catch {}
        entries.push({ label, emoji: emojiRaw, emojiId, roleId: role.id });
      }
      if (!entries.length) return interaction.editReply({ content: '❌ No valid roles. Errors:\n' + errors.join('\n') });
      const desc = entries.map(e => `${e.emoji} **${e.label}** — <@&${e.roleId}>`).join('\n');
      if (!db.reactionRoles) db.reactionRoles = {};
      for (const [mid, m] of Object.entries(db.reactionRoles)) {
        if (m && m.channelId === channel.id) {
          delete db.reactionRoles[mid];
          try { const old = await channel.messages.fetch(mid).catch(() => null); if (old) await old.delete().catch(() => {}); } catch {}
        }
      }
      let sent = null;
      try {
        sent = await channel.send({ embeds: [embedBase('🎭 Choose your roles', desc + '\n\n_React to grab / remove a role._', 0xff5da2)] });
      } catch (e) { return interaction.editReply({ content: 'Cannot post self-roles there: ' + String((e && e.message) || e).slice(0, 200) }); }
      for (const e of entries) {
        try { await sent.react(e.emoji); }
        catch { errors.push(`Could not react ${e.emoji} (${e.label}) — bad emoji or missing perms`); }
      }
      db.reactionRoles[sent.id] = { guildId: guild.id, channelId: channel.id, entries };
      save();
      return interaction.editReply({ content: `✅ Self-roles live in <#${channel.id}> (${entries.length}/10).` + (errors.length ? `\n⚠️ ${errors.join('\n')}` : '') });
    }
    if (cmd === 'sync-levels') {
      await interaction.deferReply({ ephemeral: true });
      let ok = 0, fail = 0, skipped = 0;
      for (const [discordId, rec] of Object.entries(db.levels || {})) {
        const lv = rec && rec.level ? rec.level : 0;
        if (lv < 1) { skipped++; continue; }
        try {
          const member = await interaction.guild.members.fetch(discordId).catch(() => null);
          if (!member) { fail++; continue; }
          await syncLevelRole(member, lv);
          ok++;
        } catch { fail++; }
        if ((ok + fail) % 10 === 0) await new Promise(r => setTimeout(r, 500));
      }
      save();
      return interaction.editReply({ content: `✅ Level roles synced: **${ok}** updated, ${fail} failed/missing, ${skipped} below level 1.` });
    }
    if (cmd === 'kick' || cmd === 'ban' || cmd === 'timeout' || cmd === 'untimeout') {
      const target = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') || `Action by ${interaction.user.tag}`;
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      const link = db.links[target.id];
      if (cmd === 'kick') { if (!member) return interaction.reply({ content: 'Member not found.', ephemeral: true }); await member.kick(reason); if (link) queueCommand({ type: 'kick', robloxUsername: link.robloxUsername, robloxId: link.robloxId, reason: '[Discord kick] ' + reason, by: interaction.user.tag }); return interaction.reply({ embeds: [embedBase('👢 Kicked', `${target.tag}\n${reason}\n${link ? 'Also queued game kick for **' + link.robloxUsername + '**.' : ''}`, 0xed4245)] }); }
      if (cmd === 'ban') { await interaction.guild.members.ban(target.id, { reason }); if (link) { db.bans[link.robloxId] = { reason: '[Discord ban] ' + reason, by: interaction.user.tag, at: Date.now() }; save(); queueCommand({ type: 'ban', robloxUsername: link.robloxUsername, robloxId: link.robloxId, reason: '[Discord ban] ' + reason, by: interaction.user.tag }); } return interaction.reply({ embeds: [embedBase('🔨 Banned', `${target.tag}\n${reason}\n${link ? 'Also game-banned **' + link.robloxUsername + '**.' : ''}`, 0xed4245)] }); }
      if (cmd === 'timeout') {
        const mins = interaction.options.getInteger('minutes', true);
        if (!member) return interaction.reply({ content: 'Member not found.', ephemeral: true });
        await member.timeout(mins * 60 * 1000, reason);
        if (link) queueCommand({ type: 'timeout_note', robloxUsername: link.robloxUsername, robloxId: link.robloxId, reason, minutes: mins, by: interaction.user.tag, broadcast: true });
        return interaction.reply({ embeds: [embedBase('⏳ Timed out', `${target.tag} for ${mins}m\n${reason}`, 0xfee75c)] });
      }
      if (cmd === 'untimeout') { if (!member) return interaction.reply({ content: 'Member not found.', ephemeral: true }); await member.timeout(null); return interaction.reply({ content: `✅ Removed timeout for ${target.tag}` }); }
    }
    if (cmd === 'unban') {
      await interaction.guild.bans.remove(interaction.options.getString('userid', true));
      return interaction.reply({ content: '✅ Unbanned.' });
    }
    if (cmd === 'setup-welcome' || cmd === 'setup-leave' || cmd === 'setup-reports') {
      const ch = interaction.options.getChannel('channel', true);
      if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) return interaction.reply({ content: '❌ Pick a text channel.', ephemeral: true });
      if (cmd === 'setup-welcome') db.settings.welcomeChannel = ch.id;
      if (cmd === 'setup-leave') db.settings.leaveChannel = ch.id;
      if (cmd === 'setup-reports') db.settings.reportsChannel = ch.id;
      save();
      try { await ch.send({ embeds: [embedBase('✅ Channel linked', `${cmd} → this channel. Test with /test-welcome or /test-leave.`)] }); } catch (e) {
        return interaction.reply({ content: `⚠️ Saved <#${ch.id}> but I cannot send there: ${e.message}. Give me View Channel + Send Messages + Embed Links.`, ephemeral: true });
      }
      return interaction.reply({ content: `✅ ${cmd} → <#${ch.id}> (sent a confirmation there)`, ephemeral: true });
    }
    if (cmd === 'setup-verified') {
      const role = interaction.options.getRole('role', true);
      db.settings.verifiedRoleId = role.id; save();
      return interaction.reply({ content: `✅ Verified role → <@&${role.id}>. It will auto-give on /link verify and remove on /unlink.`, ephemeral: true });
    }
    if (cmd === 'setup-levels') {
      const ch = interaction.options.getChannel('channel');
      const enabled = interaction.options.getBoolean('enabled');
      if (ch) db.settings.levelChannelId = ch.id;
      if (enabled !== null && enabled !== undefined) db.settings.levelsEnabled = enabled;
      save();
      return interaction.reply({ content: `✅ Levels: enabled=${db.settings.levelsEnabled} channel=${db.settings.levelChannelId ? `<#${db.settings.levelChannelId}>` : 'same-as-chat'}`, ephemeral: true });
    }
    if (cmd === 'test-welcome') {
      const u = interaction.options.getUser('user') || interaction.user;
      let member = await interaction.guild.members.fetch(u.id).catch(() => null);
      if (!member) member = { user: u, guild: interaction.guild };
      const e = welcomeEmbed(member);
      await interaction.reply({ content: `Preview below (configured welcome: ${db.settings.welcomeChannel ? `<#${db.settings.welcomeChannel}>` : 'NONE — use /setup-welcome'}):`, embeds: [e] });
      const r = await sendWelcome(member);
      if (!r.ok) await interaction.followUp({ content: `⚠️ Real send failed: ${r.err}`, ephemeral: true });
      return;
    }
    if (cmd === 'test-leave') {
      const u = interaction.options.getUser('user') || interaction.user;
      await interaction.reply({ embeds: [embedBase('👋 ' + u.username + ' left (TEST)', `We'll miss you! Test — real channel: ${db.settings.leaveChannel ? `<#${db.settings.leaveChannel}>` : 'NONE — use /setup-leave'}.`)] });
      const fake = { user: u, guild: interaction.guild };
      const r = await sendLeave(fake);
      if (!r.ok) await interaction.followUp({ content: `⚠️ Real send failed: ${r.err}`, ephemeral: true });
      return;
    }
    if (cmd === 'linked-list') {
      const entries = Object.entries(db.links).slice(-15).reverse();
      if (!entries.length) return interaction.reply({ content: 'No links yet.', ephemeral: true });
      const lines = entries.map(([did, l]) => `<@${did}> ↔ **${l.robloxUsername}** (\`${l.robloxId}\`) <t:${Math.floor(l.at / 1000)}:R>`);
      return interaction.reply({ embeds: [embedBase('🔗 Recent links', lines.join('\n').slice(0, 3900))], ephemeral: true });
    }
    if (cmd === 'set-rules') {
      db.settings.rulesText = interaction.options.getString('text', true).replace(/\\n/g, '\n');
      save();
      return interaction.reply({ embeds: [embedBase('📜 Rules updated', db.settings.rulesText)], ephemeral: true });
    }
    if (cmd === 'send-tos') {
      await interaction.reply({ embeds: [embedBase('📜 Discord Terms & Community Guidelines',
        'You must follow **Discord Terms of Service** (https://discord.com/terms) and **Community Guidelines** (https://discord.com/guidelines):\n\n• Must be 13+ (or local minimum age)\n• No harassment, hate speech, threats, or doxxing\n• No NSFW involving minors — zero tolerance\n• No spam, scams, phishing, or malware\n• No cheating/exploit distribution', 0x5865f2)] });
      return;
    }
  } catch (e) {
    console.error(e);
    try { if (interaction.isRepliable() && !interaction.replied) await interaction.reply({ content: '❌ Error: ' + String(e.message || e).slice(0, 300), ephemeral: true }); } catch {}
  }
});

// ---------- Express bridge for Roblox ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
function auth(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ ok: false, error: 'bad api key' });
  next();
}
app.get('/', (_, res) => res.send('Summer Baddies bridge online 🌸'));

app.get('/roblox/commands', auth, (req, res) => res.json({ ok: true, commands: takeCommandsForRoblox() }));
app.post('/roblox/ack', auth, (req, res) => { if (req.body.id) ackCommand(req.body.id); res.json({ ok: true }); });

app.post('/roblox/report', auth, async (req, res) => {
  try {
    const { reporter, reporterId, reported, reportedId, reason, details, placeId, jobId } = req.body;
    const guild = client.guilds.cache.get(GUILD_ID);
    const tp = placeId && jobId ? `\nJoin: https://www.roblox.com/games/start?placeId=${placeId}&gameInstanceId=${jobId}` : '';
    const e = new EmbedBuilder().setTitle('🚨 New in-game report').setColor(0xed4245).setTimestamp()
      .addFields(
        { name: 'Reporter', value: `${reporter} (\`${reporterId}\`)`, inline: true },
        { name: 'Reported', value: `${reported} (\`${reportedId}\`)`, inline: true },
        { name: 'Reason', value: String(reason || 'Other').slice(0, 200) },
        { name: 'Details', value: String(details || '—').slice(0, 1000) },
        { name: 'Server', value: `https://www.roblox.com/games/${placeId || ''} — JobId \`${String(jobId || '').slice(0, 20)}\`${tp}` }
      );
    const chId = db.settings.reportsChannel || process.env.REPORTS_CHANNEL_ID;
    if (guild && chId) {
      try {
        const ch = await client.channels.fetch(chId);
        if (ch && ch.isTextBased()) await ch.send({ embeds: [e] });
      } catch {}
    }
    if (guild) {
      const staff = await staffHigherThanBotList(guild);
      let dmCount = 0;
      for (const [, m] of staff) {
        try { await m.send({ embeds: [e.setFooter({ text: `Reported in Summer Baddies • ${new Date().toLocaleString()}` })] }); dmCount++; } catch {}
        if (dmCount >= 20) break;
      }
      console.log(`Report ${reporter} -> ${reported} DM'd to ${dmCount} staff`);
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ ok: false }); }
});

// Player data + inventory + server heartbeat (for /profile /item /owners /teleport /online)
app.post('/roblox/player-data', auth, (req, res) => {
  const { robloxId, robloxUsername, money, slays, weapons, skins, finishers, weaponNames, skinNames, finisherNames, placeId, jobId } = req.body;
  if (robloxId) {
    db.playerCache[robloxId] = { robloxUsername, money, slays, weapons, skins, finishers, at: Date.now() };
    db.inventories[robloxId] = {
      robloxUsername: robloxUsername || (db.inventories[robloxId] || {}).robloxUsername || '?',
      weapons: Array.isArray(weaponNames) ? weaponNames.slice(0, 200) : (db.inventories[robloxId] || {}).weapons || [],
      skins: Array.isArray(skinNames) ? skinNames.slice(0, 200) : (db.inventories[robloxId] || {}).skins || [],
      finishers: Array.isArray(finisherNames) ? finisherNames.slice(0, 200) : (db.inventories[robloxId] || {}).finishers || [],
      placeId: placeId || (db.inventories[robloxId] || {}).placeId,
      jobId: jobId || (db.inventories[robloxId] || {}).jobId,
      at: Date.now()
    };
    if (placeId && jobId) {
      if (!db.servers[jobId]) db.servers[jobId] = { placeId, jobId, players: [], at: Date.now() };
      const srv = db.servers[jobId];
      srv.placeId = placeId; srv.at = Date.now();
      srv.players = (srv.players || []).filter(p => String(p.robloxId) !== String(robloxId));
      srv.players.push({ robloxId: String(robloxId), robloxUsername });
      if (srv.players.length > 60) srv.players = srv.players.slice(-60);
    }
    save();
  }
  res.json({ ok: true });
});

// Bulk inventory (optional, same shape per player)
app.post('/roblox/inventory', auth, (req, res) => {
  const players = req.body.players;
  if (Array.isArray(players)) {
    for (const p of players) {
      if (!p || !p.robloxId) continue;
      db.inventories[p.robloxId] = {
        robloxUsername: p.robloxUsername || '?',
        weapons: (p.weapons || p.weaponNames || []).slice(0, 200),
        skins: (p.skins || p.skinNames || []).slice(0, 200),
        finishers: (p.finishers || p.finisherNames || []).slice(0, 200),
        placeId: p.placeId, jobId: p.jobId, at: Date.now()
      };
    }
    save();
  }
  res.json({ ok: true, tracked: Object.keys(db.inventories).length });
});

// Server heartbeat for /online + teleport
app.post('/roblox/servers', auth, (req, res) => {
  const { placeId, jobId, players } = req.body;
  if (jobId) {
    db.servers[jobId] = { placeId, jobId, players: (players || []).slice(0, 60), at: Date.now() };
    for (const p of (players || [])) {
      if (p && p.robloxId && db.inventories[p.robloxId]) {
        db.inventories[p.robloxId].placeId = placeId;
        db.inventories[p.robloxId].jobId = jobId;
        db.inventories[p.robloxId].at = Date.now();
      }
    }
    save();
  }
  res.json({ ok: true });
});

app.post('/roblox/verify', auth, async (req, res) => {
  const { code, robloxUsername, robloxId } = req.body;
  const rec = db.linkCodes[String(code)];
  if (!rec) return res.json({ ok: false, error: 'Invalid code. Do /link in Discord first.' });
  if (Date.now() > rec.expires) { delete db.linkCodes[String(code)]; save(); return res.json({ ok: false, error: 'Code expired. Do /link again.' }); }
  if (Number(robloxId) !== Number(rec.robloxId)) return res.json({ ok: false, error: `That code is for ${rec.robloxUsername}, but you are ${robloxUsername}.` });
  db.links[rec.discordId] = { robloxUsername: rec.robloxUsername, robloxId: rec.robloxId, at: Date.now() };
  db.robloxToDiscord[rec.robloxId] = rec.discordId;
  delete db.linkCodes[String(code)]; save();
  (async () => {
    try {
      const guild = client.guilds.cache.get(GUILD_ID);
      const m = guild ? await guild.members.fetch(rec.discordId).catch(() => null) : null;
      if (m) {
        m.send(`✅ Verified! Discord <@${rec.discordId}> ↔ Roblox **${rec.robloxUsername}**. You now have the Verified role (if set) + punishments sync both ways.`).catch(() => {});
        const roleId = db.settings.verifiedRoleId;
        if (roleId) await m.roles.add(roleId).catch(() => {});
      }
      const logId = db.settings.linkLogChannel || process.env.LINK_LOG_CHANNEL_ID;
      if (guild && logId) {
        try {
          const ch = await client.channels.fetch(logId);
          if (ch && ch.isTextBased()) ch.send(`🔗 <@${rec.discordId}> verified as **${rec.robloxUsername}** (\`${rec.robloxId}\`)`);
        } catch {}
      }
    } catch {}
  })();
  res.json({ ok: true, discordId: rec.discordId, robloxUsername: rec.robloxUsername });
});

app.post('/roblox/punishment', auth, async (req, res) => {
  const { action, robloxUsername, robloxId, reason, by } = req.body;
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    const discordId = db.robloxToDiscord[robloxId];
    if (action === 'ban' && robloxId) { db.bans[robloxId] = { reason, by, at: Date.now() }; save(); }
    if (guild && discordId) {
      const m = await guild.members.fetch(discordId).catch(() => null);
      if (m) {
        if (action === 'ban') await m.ban({ reason: '[Game ban] ' + (reason || '') }).catch(() => {});
        if (action === 'timeout_note') { const mins = Math.min(Number(req.body.minutes) || 10, 40320); await m.timeout(mins * 60 * 1000, '[Game] ' + (reason || '')).catch(() => {}); }
        if (action === 'kick') await m.kick('[Game kick] ' + (reason || '')).catch(() => {});
        m.send(`⚠️ You received **${action}** in Summer Baddies (${reason || 'no reason'}). It was reflected to Discord because your accounts are linked.`).catch(() => {});
      }
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.json({ ok: false }); }
});

// Live RAP+demand+icon snapshot. Body: {items:[{key,type,name,rap,demand,change,icon}]}
app.post('/roblox/values', auth, (req, res) => {
  const items = req.body.items;
  if (Array.isArray(items)) {
    const byKey = {};
    for (const it of items) {
      if (it && it.key && typeof it.rap === 'number')
        byKey[it.key] = { type: it.type, name: it.name, key: it.key, rap: Math.floor(it.rap), demand: it.demand || demand.getTier(it.rap, it.change || 0), change: Number(it.change) || 0, live: true, icon: it.icon || (icons[it.type] || {})[it.name] || null };
    }
    db.valuesCache = { at: Date.now(), byKey };
    try { save(); } catch {}
  }
  res.json({ ok: true, count: Object.keys(db.valuesCache.byKey).length });
});

app.get('/roblox/bans', auth, (req, res) => res.json({ ok: true, bans: db.bans }));
app.get('/roblox/links', auth, (req, res) => res.json({ ok: true, links: db.robloxToDiscord }));

(async () => {
  await registerCommands().catch(e => console.error('register failed', e));
  app.listen(PORT, () => console.log('Bridge HTTP on :' + PORT));
  client.login(TOKEN);
})();
