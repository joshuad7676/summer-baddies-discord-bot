require('dotenv').config();
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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
const ticketTimeouts = new Map(); // channelId -> timeout

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const API_KEY = process.env.BOT_API_KEY || 'change_me';
const PORT = process.env.PORT || 3000;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN / CLIENT_ID / GUILD_ID in .env');
  process.exit(1);
}

// ---------- Database Setup ----------
const DB_PATH = path.join(__dirname, 'data.json');
let db = {
  links: {}, robloxToDiscord: {}, linkCodes: {},
  settings: { rulesText: '', welcomeChannel: '', leaveChannel: '', reportsChannel: '', linkLogChannel: '', verifiedRoleId: '', levelChannelId: '', levelsEnabled: true, ticketCategoryId: '', ticketReviewChannelId: '', ticketReviewerRoleId: '' },
  commands: [], playerCache: {}, bans: {},
  valuesCache: { at: 0, byKey: {} },
  inventories: {}, servers: {}, levels: {}, iconCache: {}, tickets: {}, reactionRoles: {}, shortcuts: { prefix: ',', map: {} },
  afk: {}
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
    db.afk = raw.afk || {};
    db.shortcuts = (raw.shortcuts && typeof raw.shortcuts === 'object') ? raw.shortcuts : { prefix: ',', map: {} };
    if (!db.shortcuts.map || typeof db.shortcuts.map !== 'object') db.shortcuts.map = {};
    if (typeof db.shortcuts.prefix !== 'string' || !db.shortcuts.prefix) db.shortcuts.prefix = ',';
  }
} catch (e) { console.error('DB load failed, using fresh:', e.message); }

function save() { try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch (e) { console.error('DB save failed:', e.message); } }

// ---------- Roblox RAP & Demand Helpers ----------
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
  const sKeys = Object.keys(rapStatic[type] || {});
  const sFound = sKeys.find(k => k.toLowerCase() === String(name).toLowerCase());
  if (sFound) {
    const r2 = rapStatic[type][sFound];
    return { type, name: sFound, key: `${type}/${sFound}`, rap: r2, demand: demand.getTier(r2, 0), change: 0, live: false, icon: (icons[type] || {})[sFound] || null };
  }
  return { type, name: `${type}/${name}`, rap: null, demand: 'STABLE', change: 0, live: false, icon: (icons[type] || {})[name] || null };
}

async function resolveIcon(icon) {
  if (!icon) return null;
  if (typeof icon === 'string' && icon.startsWith('http')) return icon;
  const m = String(icon).match(/(\d{6,})/);
  if (!m) return null;
  const id = m[1];
  const cached = db.iconCache[id];
  if (cached && cached.url && Date.now() - cached.at < 7 * 24 * 3600 * 1000) return cached.url;
  try {
    const r = await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${id}&size=420x420&format=Png&isCircular=false`);     const j = await r.json();     const url = j.data && j.data[0] && j.data[0].imageUrl;     if (url) { db.iconCache[id] = { url, at: Date.now() }; save(); return url; }   } catch {}   return null; }  function norm(s) { return String(s \vert{}\vert{} '').toLowerCase().trim(); } function getOwners(type, name, limit = 10) {   const out = [];   const want = norm(name);   for (const [rid, inv] of Object.entries(db.inventories \vert{}\vert{} {})) {     let list = [];     if (type === 'Weapon') list = inv.weapons \vert{}\vert{} [];     else if (type === 'WeaponSkin') list = inv.skins \vert{}\vert{} [];     else list = inv.finishers \vert{}\vert{} [];     const has = list.some(x => norm(typeof x === 'string' ? x : x.name) === want \vert{}\vert{} (norm(typeof x === 'string' ? x : x.name).includes(want) && want.length > 3));     if (!has) continue;     out.push({       robloxId: rid, robloxUsername: inv.robloxUsername \vert{}\vert{} '?',       discordId: db.robloxToDiscord[rid] \vert{}\vert{} db.robloxToDiscord[String(rid)] \vert{}\vert{} null,       placeId: inv.placeId, jobId: inv.jobId, at: inv.at \vert{}\vert{} 0     });     if (out.length >= limit) break;   }   out.sort((a, b) => {     const aOn = a.jobId && db.servers[a.jobId] ? 0 : 1;     const bOn = b.jobId && db.servers[b.jobId] ? 0 : 1;     return aOn - bOn \vert{}\vert{} (b.at - a.at);   });   return out; }  function teleportLink(placeId, jobId) {   if (!placeId \vert{}\vert{} !jobId) return null;   return `https://www.roblox.com/games/start?placeId=${placeId}&gameInstanceId=${jobId}`; }  function ownerLine(o) {   const disc = o.discordId ? `<@${o.discordId}> ☕` : '`not linked`';
  const online = o.jobId && db.servers[o.jobId];
  const tp = (o.placeId && o.jobId) ? ` — [Join server](${teleportLink(o.placeId, o.jobId)})${online ? ' 🟢' : ' (last seen)'}` : '';   const seen = o.at ? ` <t:${Math.floor(o.at / 1000)}:R>` : '';
  return `• **${o.robloxUsername}** (\`${o.robloxId}\`) → Discord: ${disc}${tp}${seen}`; }  async function buildItemEmbed(type, name) {   const v = lookupValue(type, name);   const e = demand.EMOJI[v.demand] \vert{}\vert{} '';   const rapTxt = v.rap == null ? '?' : demand.formatRap(v.rap);   const pct = demand.fmtPct(v.change \vert{}\vert{} 0);   const color = demand.COLORS[v.demand] \vert{}\vert{} 0xff5da2;   const liveAge = db.valuesCache.at ? `<t:${Math.floor(db.valuesCache.at / 1000)}:R>` : 'seeds (offline)';
  const emb = new EmbedBuilder()
    .setTitle(`${e}${v.name} — Spill the Tea ☕`)
    .setColor(color)
    .setTimestamp()
    .setDescription(
      `💅 **Type:** \`${v.type}\`\n` +
      `📈 **RAP:** **${rapTxt}**${v.rap != null ? ` (\`${v.rap}\`)` : ''}\n` +
      `🔥 **Demand:** **${v.demand}** (${pct})\n` +
      `✨ **Status:** ${v.live ? '🟢 Live' : '🟡 Seed'} — updated ${liveAge}`
    );
  const iconUrl = await resolveIcon(v.icon);
  if (iconUrl) emb.setThumbnail(iconUrl);
  const owners = getOwners(v.type, v.name, 5);
  if (!owners.length) {
    emb.addFields({ name: `Owners (0 tracked)`, value: '_Nobody in the tea room has this yet, bestie._' });
  } else {
    emb.addFields({ name: `Owners (${owners.length}${owners.length >= 5 ? '+' : ''} tracked)`, value: owners.map(ownerLine).join('\n').slice(0, 1000) });
    const withTp = owners.find(o => o.placeId && o.jobId);
    if (withTp) emb.addFields({ name: 'Teleport', value: `[Join ${withTp.robloxUsername}'s server](${teleportLink(withTp.placeId, withTp.jobId)})\n\`roblox://placeId=${withTp.placeId}&gameInstanceId=${withTp.jobId}\`` });
  }
  emb.setFooter({ text: `${v.type} • ${v.live ? 'Live RAP' : 'Seed RAP'}` });
  return emb;
}

// ---------- Command Queue & Roblox API ----------
function queueCommand(cmd) {
  if (!cmd || typeof cmd !== 'object' || !cmd.type) throw new Error('refusing to queue empty command');
  cmd.id = 'cmd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  cmd.createdAt = Date.now();
  db.commands.push(cmd);
  if (db.commands.length > 200) db.commands = db.commands.slice(-200);
  save();
  return cmd.id;
}

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
  if (!keys.length) return `\n\n💅 **Text Shortcuts**\nNo shortcuts created yet, honey! Staff use /shortcut-add`;
  return `\n\n💅 **Text Shortcuts** (Prefix \`${p}\`)\n` + keys.map(k => `\`${(map[k].prefix || p)}${k}\` → /${map[k].command}`).join('\n');
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

// ---------- Permissions ----------
async function isStaffHigherThanBot(member) {
  if (!member || !member.guild) return false;
  if (member.id === member.guild.ownerId) return true;
  const me = await member.guild.members.fetchMe();
  const botTop = me.roles.highest.position;
  const userTop = member.roles.highest.position;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return userTop > botTop || member.id === member.guild.ownerId;
  return userTop > botTop;
}

function xpNeeded(level) { return 100 + level * 50; }

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

// ---------- Discord Client Initialization ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.GuildMember, Partials.Message, Partials.Channel, Partials.Reaction]
});

// ---------- Role Ladder & Layout Systems ----------
const P = PermissionFlagsBits;
const BASE_CHAT_VOICE = [
  P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory,
  P.AddReactions, P.Connect, P.Speak, P.Stream, P.UseVAD, P.UseApplicationCommands, P.ChangeNickname,
];

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

function sanitizeTextChannelName(n) {
  let s = String(n || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  return s.slice(0, 100) || 'channel';
}

function getBaddiesPreset() {
  return [
    { category: '🌸・INFO', channels: [
      { name: 'welcome', type: 'text', topic: 'Welcome besties! Link using /link and read the rules 💅' },
      { name: 'rules', type: 'text', topic: 'Server tea & rules — read before chatting' },
      { name: 'announcements', type: 'text', topic: 'Official updates only ☕' },
    ]},
    { category: '💬・GENERAL', channels: [
      { name: 'general', type: 'text', topic: 'Main chat — keep it serving 💅' },
      { name: 'introductions', type: 'text', topic: 'Introduce yourself baddie!' },
      { name: 'bot-commands', type: 'text', topic: 'Bot command room: /value /rank /profile' },
      { name: 'suggestions', type: 'text', topic: 'Spill ideas for the game & server' },
    ]},
    { category: '💰・TRADING', channels: [
      { name: 'trade-list', type: 'text', topic: 'Post your trades here honey' },
      { name: 'trade-history', type: 'text', topic: 'Completed trades & vouches' },
      { name: 'value-discussion', type: 'text', topic: 'Talk RAP, demand, and economic trends' },
    ]},
    { category: '🎟️・SUPPORT & APPLY', channels: [
      { name: 'support', type: 'text', topic: 'Need help? Get in touch with staff' },
      { name: 'apply-here', type: 'text', topic: 'Apply for roles using /apply!' },
    ]},
    { category: '🔊・VOICE LOUNGES', channels: [
      { name: 'Tea Lounge', type: 'voice', topic: '' },
      { name: 'Trading Voice', type: 'voice', topic: '' },
      { name: 'Vibe Stage', type: 'voice', topic: '' },
    ]}
  ];
}

// ---------- Slash Commands Registration Array ----------
const ADMIN_PERMS = '0';

const commands = [
  new SlashCommandBuilder().setName('link').setDescription('Link your Roblox account with discord 💅')
    .addStringOption(o => o.setName('username').setDescription('Your Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('unlink').setDescription('Unlink your Roblox account'),
  new SlashCommandBuilder().setName('verify-status').setDescription('Check if a baddie is verified')
    .addUserOption(o => o.setName('user').setDescription('Target user (default: you)')),
  new SlashCommandBuilder().setName('profile').setDescription('Display linked Roblox profile & stats')
    .addUserOption(o => o.setName('user').setDescription('Target user (default: you)')),
  new SlashCommandBuilder().setName('afk').setDescription('Set your AFK status so others know you are stepping away ☕')
    .addStringOption(o => o.setName('reason').setDescription('Why are you stepping away, baddie?')),
  new SlashCommandBuilder().setName('send-message').setDescription('[STAFF] Send a custom message or embed to any channel ✨')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addChannelOption(o => o.setName('channel').setDescription('Channel to target').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Message text content').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('Optional embed title'))
    .addStringOption(o => o.setName('color').setDescription('Hex color code e.g. #FF5DA2')),
  new SlashCommandBuilder().setName('help').setDescription('Show all bot commands'),
  new SlashCommandBuilder().setName('ping').setDescription('Check bot network latency'),
  new SlashCommandBuilder().setName('server-info').setDescription('Show server stats & Roblox status'),
  new SlashCommandBuilder().setName('avatar').setDescription('Display user avatar')
    .addUserOption(o => o.setName('user').setDescription('User (default: you)')),
  new SlashCommandBuilder().setName('rank').setDescription('Check chat XP level rank')
    .addUserOption(o => o.setName('user').setDescription('User (default: you)')),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top chatters by level'),
  new SlashCommandBuilder().setName('value').setDescription('Look up RAP & demand for items')
    .addStringOption(o => o.setName('type').setDescription('Item category').setRequired(true).addChoices({ name: 'weapon', value: 'Weapon' }, { name: 'skin', value: 'WeaponSkin' }, { name: 'finisher', value: 'Finisher' }))
    .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('item').setDescription('Full item analysis: RAP, owners, teleport')
    .addStringOption(o => o.setName('type').setDescription('Item category').setRequired(true).addChoices({ name: 'weapon', value: 'Weapon' }, { name: 'skin', value: 'WeaponSkin' }, { name: 'finisher', value: 'Finisher' }))
    .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('owners').setDescription('Search who owns an item')
    .addStringOption(o => o.setName('type').setDescription('Item category').setRequired(true).addChoices({ name: 'weapon', value: 'Weapon' }, { name: 'skin', value: 'WeaponSkin' }, { name: 'finisher', value: 'Finisher' }))
    .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('online').setDescription('Show live game servers & active players'),
  new SlashCommandBuilder().setName('teleport').setDescription('Get a direct join link for an online Roblox user')
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('search-skins').setDescription('Search skin market values')
    .addStringOption(o => o.setName('query').setDescription('Skin name').setRequired(true)),
  new SlashCommandBuilder().setName('search-weapons').setDescription('Search weapon market values')
    .addStringOption(o => o.setName('query').setDescription('Weapon name').setRequired(true)),
  new SlashCommandBuilder().setName('search-finishers').setDescription('Search finisher market values')
    .addStringOption(o => o.setName('query').setDescription('Finisher name').setRequired(true)),
  new SlashCommandBuilder().setName('search-player').setDescription('Search cached Roblox player inventory')
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('rules').setDescription('Display server rules')
    .addStringOption(o => o.setName('mode').setDescription('Mode').addChoices({ name: 'custom', value: 'custom' }, { name: 'tos', value: 'tos' })),
  new SlashCommandBuilder().setName('apply').setDescription('Apply for server/game staff roles')
    .addStringOption(o => o.setName('role').setDescription('Role').setRequired(true).addChoices(
      { name: 'Admin', value: 'admin' },
      { name: 'Content Creator', value: 'contentcreator' },
      { name: 'Tester', value: 'tester' },
      { name: 'Community Manager', value: 'communitymanager' },
      { name: 'Director', value: 'director' },
      { name: 'Creative Director', value: 'creativedirector' })),
  new SlashCommandBuilder().setName('ticket-close').setDescription('Close your open application ticket'),
  new SlashCommandBuilder().setName('give-weapon').setDescription('[STAFF] Give weapon in game')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addStringOption(o => o.setName('weapon').setDescription('Weapon name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('give-skin').setDescription('[STAFF] Give skin in game')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addStringOption(o => o.setName('weapontype').setDescription('Base weapon').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('skin').setDescription('Skin name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('give-finisher').setDescription('[STAFF] Give finisher in game')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addStringOption(o => o.setName('finisher').setDescription('Finisher name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('player-data').setDescription('[STAFF] Inspect live game player data')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('game-kick').setDescription('[STAFF] Kick player from game server')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('game-ban').setDescription('[STAFF] Ban player from game server (+ Discord sync)')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .addBooleanOption(o => o.setName('syncdiscord').setDescription('Ban linked Discord user too?')),
  new SlashCommandBuilder().setName('game-unban').setDescription('[STAFF] Unban player from game server')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('game-announce').setDescription('[STAFF] Broadcast message across all game servers')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('message').setDescription('Message').setRequired(true)),
  new SlashCommandBuilder().setName('game-restart').setDescription('[STAFF] Queue restart across game servers')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addIntegerOption(o => o.setName('delay').setDescription('Countdown seconds (5-120)').setMinValue(5).setMaxValue(120))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('game-luck').setDescription('[STAFF] Set global server luck multiplier')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addIntegerOption(o => o.setName('mult').setDescription('Multiplier 1-10').setRequired(true).setMinValue(1).setMaxValue(10))
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setMinValue(1).setMaxValue(60)),
  new SlashCommandBuilder().setName('admin-abuse').setDescription('[STAFF] Trigger server-wide fun events')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('event').setDescription('Event choice').setRequired(true).addChoices(
      { name: 'Money Rain', value: 'money-rain' },
      { name: 'Spin Party', value: 'spin-party' },
      { name: 'Heal All', value: 'heal-all' },
      { name: 'Midnight', value: 'midnight' },
      { name: 'Daybreak', value: 'daybreak' },
      { name: 'Disco Party', value: 'disco' },
      { name: 'EVERYTHING', value: 'all' }))
    .addIntegerOption(o => o.setName('duration').setDescription('Seconds for disco (60-3600)')),
  new SlashCommandBuilder().setName('game-money').setDescription('[STAFF] Manage player Dinero balance')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'Give', value: 'Give' }, { name: 'Remove', value: 'Remove' }, { name: 'Set', value: 'Set' }))
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true)),
  new SlashCommandBuilder().setName('give-tokens').setDescription('[STAFF] Manage player tokens')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'Give', value: 'Give' }, { name: 'Remove', value: 'Remove' }, { name: 'Set', value: 'Set' }))
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('give-spins').setDescription('[STAFF] Manage player spins')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('type').setDescription('Type').setRequired(true).addChoices({ name: 'Hourly', value: 'hourly' }, { name: 'Wheel', value: 'wheel' }))
    .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'Give', value: 'Give' }, { name: 'Remove', value: 'Remove' }, { name: 'Set', value: 'Set' }))
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('give-all-weapon').setDescription('[STAFF] Give weapon to ALL online players')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('weapon').setDescription('Weapon name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('give-all-skin').setDescription('[STAFF] Give skin to ALL online players')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('weapontype').setDescription('Base weapon').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('skin').setDescription('Skin name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('give-all-finisher').setDescription('[STAFF] Give finisher to ALL online players')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('finisher').setDescription('Finisher name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('give-all-tokens').setDescription('[STAFF] Give tokens to ALL online players')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('give-all-spins').setDescription('[STAFF] Give spins to ALL online players')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('type').setDescription('Type').setRequired(true).addChoices({ name: 'Hourly', value: 'hourly' }, { name: 'Wheel', value: 'wheel' }))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('add-emoji').setDescription('[STAFF] Give custom overhead emoji to player')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('emoji').setDescription('Emoji string').setRequired(true))
    .addStringOption(o => o.setName('username').setDescription('Roblox username')),
  new SlashCommandBuilder().setName('remove-emoji').setDescription('[STAFF] Remove custom overhead emoji')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username')),
  new SlashCommandBuilder().setName('force-pvp').setDescription('[STAFF] Force lock PvP mode ON')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username')),
  new SlashCommandBuilder().setName('unforce-pvp').setDescription('[STAFF] Release forced PvP lock')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username')),
  new SlashCommandBuilder().setName('force-show-emoji').setDescription('[STAFF] Lock overhead emoji display ON')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username')),
  new SlashCommandBuilder().setName('unforce-show-emoji').setDescription('[STAFF] Unlock overhead emoji lock')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username')),
  new SlashCommandBuilder().setName('selfroles').setDescription('[STAFF] Send self-role reaction menu')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('setup').setDescription('Format: Label | emoji | @role').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Target channel')),
  new SlashCommandBuilder().setName('shortcut-add').setDescription('[STAFF] Map text prefix shortcut to command')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('command').setDescription('Target command').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('letters').setDescription('Shortcut key').setRequired(true))
    .addStringOption(o => o.setName('prefix').setDescription('Custom prefix')),
  new SlashCommandBuilder().setName('shortcut-remove').setDescription('[STAFF] Remove text shortcut')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('alias').setDescription('Alias e.g. ,gb').setRequired(true)),
  new SlashCommandBuilder().setName('shortcut-list').setDescription('[STAFF] List active text shortcuts')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false),
  new SlashCommandBuilder().setName('shortcut-prefix').setDescription('[STAFF] Set global shortcut prefix')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('prefix').setDescription('Prefix symbol').setRequired(true)),
  new SlashCommandBuilder().setName('sync-levels').setDescription('[STAFF] Bulk sync level milestone roles'),
  new SlashCommandBuilder().setName('give-everything').setDescription('[STAFF] Give player all cosmetics/items')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addStringOption(o => o.setName('category').setDescription('Category').addChoices(
      { name: 'Everything', value: 'everything' },
      { name: 'Weapons only', value: 'weapons' },
      { name: 'Skins only', value: 'skins' },
      { name: 'Finishers only', value: 'finishers' })),
  new SlashCommandBuilder().setName('kick').setDescription('[STAFF] Kick member from Discord server')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Target member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('ban').setDescription('[STAFF] Ban member from Discord server')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Target member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('unban').setDescription('[STAFF] Unban user from Discord server')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('userid').setDescription('Discord User ID').setRequired(true)),
  new SlashCommandBuilder().setName('timeout').setDescription('[STAFF] Timeout member')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Target member').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Minutes').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('untimeout').setDescription('[STAFF] Remove member timeout')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Target member').setRequired(true)),
  new SlashCommandBuilder().setName('setup-welcome').setDescription('[STAFF] Set channel for welcome messages')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
  new SlashCommandBuilder().setName('setup-leave').setDescription('[STAFF] Set channel for exit messages')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
  new SlashCommandBuilder().setName('setup-reports').setDescription('[STAFF] Set channel for in-game reports')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
  new SlashCommandBuilder().setName('setup-verified').setDescription('[STAFF] Set role assigned on verification')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addRoleOption(o => o.setName('role').setDescription('Verified Role').setRequired(true)),
  new SlashCommandBuilder().setName('setup-levels').setDescription('[STAFF] Configure leveling settings')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addChannelOption(o => o.setName('channel').setDescription('Level-up announcement channel'))
    .addBooleanOption(o => o.setName('enabled').setDescription('Enable levels')),
  new SlashCommandBuilder().setName('test-welcome').setDescription('[STAFF] Test welcome embed dispatch')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Simulated user')),
  new SlashCommandBuilder().setName('test-leave').setDescription('[STAFF] Test leave embed dispatch')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Simulated user')),
  new SlashCommandBuilder().setName('linked-list').setDescription('[STAFF] Display linked accounts list')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false),
  new SlashCommandBuilder().setName('set-rules').setDescription('[STAFF] Set custom server rules text')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('text').setDescription('Rules text').setRequired(true)),
  new SlashCommandBuilder().setName('send-tos').setDescription('[STAFF] Send Discord TOS embed')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false),
  new SlashCommandBuilder().setName('setup-applications').setDescription('[STAFF] Configure application ticket parameters')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addChannelOption(o => o.setName('category').setDescription('Category').setRequired(true).addChannelTypes(ChannelType.GuildCategory))
    .addChannelOption(o => o.setName('review').setDescription('Review channel').setRequired(true))
    .addRoleOption(o => o.setName('reviewer').setDescription('Reviewer role').setRequired(true)),
  new SlashCommandBuilder().setName('tickets').setDescription('[STAFF] List active application tickets')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false),
  new SlashCommandBuilder().setName('setup-roles').setDescription('[OWNER] Create hierarchy role structure')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false),
  new SlashCommandBuilder().setName('setup-layout').setDescription('[STAFF] Build server layout')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('preset').setDescription('Preset').addChoices({ name: 'baddies', value: 'baddies' }))
    .addStringOption(o => o.setName('description').setDescription('DSL definition')),
  new SlashCommandBuilder().setName('reset-layout').setDescription('[OWNER] DANGER: Wipe & rebuild channels')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('confirm').setDescription('Type CONFIRM').setRequired(true))
    .addStringOption(o => o.setName('preset').setDescription('Preset').addChoices({ name: 'baddies', value: 'baddies' }))
    .addStringOption(o => o.setName('description').setDescription('DSL definition')),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✨ Slash commands successfully registered to guild ' + GUILD_ID);
}

// ---------- Helper Functions & Message Embed Templates ----------
function embedBase(title, desc, color = 0xff5da2) {
  return new EmbedBuilder().setTitle(title).setDescription(desc || '').setColor(color).setTimestamp();
}

async function requireStaff(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (await isStaffHigherThanBot(member)) return member;
  await interaction.reply({ content: '💅 Hold up bestie! You need a role higher than the bot to perform staff actions.', ephemeral: true });
  return null;
}

async function resolveSendChannel(channelId) {
  if (!channelId) return { ch: null, err: 'No channel configured.' };
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) return { ch: null, err: `Channel <#${channelId}> is not text-based.` };
    return { ch, err: null };
  } catch (e) {
    return { ch: null, err: `Cannot access <#${channelId}>: ${e.message}` };
  }
}

function welcomeEmbed(member) {
  return embedBase('🌸 Welcome Baddie, ' + member.user.username + '! ✨',
    `Welcome to **${member.guild.name}**!\n\n` +
    `• Link your Roblox: \`/link <RobloxUsername>\` then say \`!verify CODE\` in-game!\n` +
    `• Check status: \`/verify-status\` to claim your Verified status\n` +
    `• Read the tea: \`/rules\`\n\n` +
    `Enjoy your stay bestie 💅☕`, 0xff5da2)
    .setThumbnail(member.user.displayAvatarURL())
    .setFooter({ text: `Baddie #${member.guild.memberCount}` });
}

async function sendWelcome(member) {
  const chId = db.settings.welcomeChannel || process.env.WELCOME_CHANNEL_ID;
  const { ch, err } = await resolveSendChannel(chId);
  if (!ch) return { ok: false, err };
  try { await ch.send({ embeds: [welcomeEmbed(member)] }); return { ok: true }; }
  catch (e) { return { ok: false, err: e.message }; }
}

async function sendLeave(member) {
  const chId = db.settings.leaveChannel || process.env.LEAVE_CHANNEL_ID;
  const { ch, err } = await resolveSendChannel(chId);
  if (!ch) return { ok: false, err };
  try {
    await ch.send({ embeds: [embedBase('💅 ' + (member.user?.username || 'A baddie') + ' left the server', `We will miss you bestie! **${member.guild.name}** now has ${member.guild.memberCount} members.`, 0x808080)] });
    return { ok: true };
  } catch (e) { return { ok: false, err: e.message }; }
}

// ---------- Application Ticket Management ----------
function appQuestionEmbed(roleKey, idx) {
  const role = applications[roleKey];
  const q = role.questions[idx];
  const total = role.questions.length;
  let desc = `**Question ${idx + 1}/${total}:**\n${q.q}`;
  if (q.type === 'text') desc += `\n\n_✍️ Send your answer in this channel (${q.min || 1}-${q.max || 1000} chars)._`;
  if (q.type === 'yesno') desc += `\n\n_Click **Yes** or **No** below bestie._`;
  if (q.type === 'choice') desc += `\n\n_Choose an option below._`;
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
    new ButtonBuilder().setCustomId('app_cancel').setLabel('Cancel Application').setStyle(ButtonStyle.Secondary))];
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
  if (!channel || !channel.isTextBased()) return closeTicket(channelId, 'Channel deleted.', { silent: true, log: false });
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
  else emb.setDescription((emb.data.description || '') + '\n_No answers supplied._');
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
    await channel.send({ embeds: [embedBase('✨ Application Submitted!', `Thanks <@${t.discordId}>! Staff will review your **${t.roleLabel}** application shortly.\nSit tight and don't ping staff bestie! ☕`, 0x57f287)], components: [row] }).catch(() => {});
  }
  const reviewId = db.settings.ticketReviewChannelId;
  if (reviewId) {
    try {
      const rc = await client.channels.fetch(reviewId);
      if (rc && rc.isTextBased()) await rc.send({ content: `<@&${db.settings.ticketReviewerRoleId}> New application arrived!`, embeds: [ticketTranscriptEmbed(t, `📥 ${t.roleLabel} Application — ${t.tag}`, (applications[t.role] || {}).color || 0xff5da2)] });
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
  if (!opts.silent) await channel.send({ embeds: [embedBase('🔒 Ticket Closed', reason || 'Closed.', 0x808080)] }).catch(() => {});
  if (t && t.answers && t.answers.length && opts.log !== false && db.settings.ticketReviewChannelId) {
    try {
      const rc = await client.channels.fetch(db.settings.ticketReviewChannelId);
      if (rc && rc.isTextBased()) await rc.send({ embeds: [ticketTranscriptEmbed(t, `🔒 Ticket Closed — ${t.roleLabel} — ${t.tag}`, 0x808080)] });
    } catch {}
  }
  setTimeout(async () => {
    try { const ch = await client.channels.fetch(channelId); if (ch) await ch.delete('Ticket closed'); } catch {}
    if (db.tickets[channelId]) { delete db.tickets[channelId]; save(); }
  }, 8000);
}

async function startTicket(interaction, roleKey) {
  const role = applications[roleKey];
  if (!role) return interaction.reply({ content: 'Unknown role choice.', ephemeral: true });
  if (!db.settings.ticketCategoryId || !db.settings.ticketReviewerRoleId)
    return interaction.reply({ content: '💅 Applications are not configured yet bestie! Staff must use `/setup-applications`.', ephemeral: true });
  const open = Object.values(db.tickets).find(t => t.discordId === interaction.user.id && t.status === 'open');
  if (open) return interaction.reply({ content: `💅 You already have an open ticket in <#${open.channelId}> bestie! Finish or close it first.`, ephemeral: true });
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
      topic: `${role.label} Application • ${interaction.user.tag}`,
    });
  } catch (e) {
    return interaction.editReply('❌ Could not create application channel: ' + String(e.message || e).slice(0, 200));
  }
  db.tickets[channel.id] = { channelId: channel.id, discordId: interaction.user.id, tag: interaction.user.tag, role: roleKey, roleLabel: role.label, qIndex: 0, answers: [], status: 'open', createdAt: Date.now(), lastActivity: Date.now() };
  save();
  await channel.send({ embeds: [embedBase(`📝 ${role.label} Application`, `Hey <@${interaction.user.id}>! ${role.intro}\n\nAnswer each question below — **10 minutes per question**. Good luck bestie! 💅`, role.color || 0xff5da2)] }).catch(() => {});
  await interaction.editReply(`✨ Ticket channel created: <#${channel.id}>\nHead over and answer the questions — **10 minutes per question**.`);
  await askTicketQuestion(channel.id);
}

// ---------- Client Event Handlers ----------
client.once('ready', async () => {
  console.log(`✨ Logged in as ${client.user.tag} — Ready to serve tea! ☕`);
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [jid, s] of Object.entries(db.servers)) {
      if (now - (s.at || 0) > 5 * 60 * 1000) { delete db.servers[jid]; changed = true; }
    }
    if (changed) save();
  }, 5 * 60 * 1000);
});

client.on('guildMemberAdd', async (member) => { await sendWelcome(member); });
client.on('guildMemberRemove', async (member) => { await sendLeave(member); });

// ---------- AFK Check & Message Management Listener ----------
client.on('messageCreate', async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;

    // Remove AFK if user sends a message
    if (db.afk[msg.author.id]) {
      delete db.afk[msg.author.id];
      save();
      await msg.reply({ embeds: [embedBase('✨ Welcome Back Bestie!', `I've removed your AFK status. Hope you had a good break 💅`)] }).then(m => setTimeout(() => m.delete().catch(() => {}), 6000)).catch(() => {});
    }

    // Check mentions for AFK status
    if (msg.mentions.users.size > 0) {
      for (const [id, user] of msg.mentions.users) {
        if (db.afk[id]) {
          const afkData = db.afk[id];
          await msg.reply({ embeds: [embedBase('☕ User is AFK', `<@${id}> is currently AFK!\n\n**Reason:** ${afkData.reason}\n**Since:** <t:${Math.floor(afkData.at / 1000)}:R>`, 0xff3d7f)] });
          break;
        }
      }
    }

    if (await handleTextShortcut(msg)) return;
    if (msg.guild.id !== GUILD_ID) return;

    // Application Question Answer via Chat
    const tick = db.tickets[msg.channelId];
    if (tick && tick.status === 'open' && msg.author.id === tick.discordId) {
      const trole = applications[tick.role];
      const tq = trole && trole.questions[tick.qIndex];
      if (tq && tq.type === 'text') {
        const ans = (msg.content || '').trim();
        const min = tq.min || 1, max = tq.max || 1000;
        if (ans.length < min) { await msg.reply(`💅 Too short bestie! Please write at least ${min} characters.`).catch(() => {}); return; }
        if (ans.length > 2000) { await msg.reply('💅 Too long bestie! Keep it under 2000 characters.').catch(() => {}); return; }
        try { await msg.delete().catch(() => {}); } catch {}
        await answerTicket(msg.channelId, msg.author.id, ans.slice(0, max));
        return;
      }
    }

    // Level XP Management
    if (db.settings.levelsEnabled === false) return;
    const id = msg.author.id;
    const rec = getLevelRec(id);
    const now = Date.now();
    if (now - (rec.lastXp || 0) < 60000) return;
    rec.lastXp = now;
    rec.msgs = (rec.msgs || 0) + 1;
    rec.xp += 15 + Math.floor(Math.random() * 11);
    let need = xpNeeded(rec.level || 0);
    let leveled = false;
    while (rec.xp >= need) { rec.xp -= need; rec.level = (rec.level || 0) + 1; need = xpNeeded(rec.level); leveled = true; }
    save();
    if (leveled) {
      const milestone = levelRoleName(rec.level);
      const emb = embedBase('🎉 Level Up Bestie!',
        `<@${id}> reached **Level ${rec.level}**!` +
        (milestone ? `\n🏅 Milestone Role: **${milestone}**` : '') +
        `\nKeep serving quality chat 💅✨`);
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
  } catch (e) { console.error('Error handling message:', e.message); }
});

// ---------- Text Shortcut Processing ----------
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
    const tok = rest.split(/\s+/).filter(Boolean);

    if (cmd === 'game-announce') {
      if (!rest) return (await say('Usage: `<alias> <message>`'), true);
      queueCommand({ type: 'announce', message: rest.slice(0, 200), by, broadcast: true });
      await say(`📢 Broadcast queued: ${rest.slice(0, 200)}`);
      return true;
    }
    if (cmd === 'game-restart') {
      let delay = 30, reason = rest;
      const m = rest.match(/^(\d+)\s+([\s\S]+)$/);
      if (m) { delay = Math.min(120, Math.max(5, parseInt(m[1], 10) || 30)); reason = m[2]; }
      if (!reason) return (await say('Usage: `<alias> [delay 5-120] <reason>`'), true);
      queueCommand({ type: 'restart', delay, reason: reason.slice(0, 200), by, broadcast: true });
      await say(`🔁 Server restart queued (${delay}s).`);
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
      await say(`✨ \`${cmd}\` ${A} ${amt} → **${who.rUsername}**.`);
      return true;
    }
    return false;
  } catch { return false; }
}

// ---------- Reaction Self Roles ----------
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

// ---------- Interaction Listener Handler ----------
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const name = interaction.commandName;
      const focusedOpt = interaction.options.getFocused(true);
      const q = String(focusedOpt.value || '').toLowerCase();
      let list = [];
      if (['value', 'item', 'owners', 'give-weapon', 'give-all-weapon'].includes(name)) list = catalogs.weapons || [];
      if (['give-finisher', 'give-all-finisher'].includes(name)) list = catalogs.finishers || [];
      if (['give-skin', 'give-all-skin'].includes(name)) list = catalogs.skinTypes || [];
      if (name === 'shortcut-add' && focusedOpt.name === 'command') list = SHORTCUT_COMMANDS;
      if (!list.length) list = [...(catalogs.weapons || []), ...(catalogs.finishers || []), ...(catalogs.skinTypes || [])];
      await interaction.respond(fuzzy(list, q, 10).map(v => ({ name: v.slice(0, 100), value: v })).slice(0, 25));
      return;
    }

    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'app_yes' || id === 'app_no' || id.startsWith('app_opt_')) {
        const t = db.tickets[interaction.channelId];
        if (!t || t.status !== 'open') return interaction.reply({ content: '💅 Ticket closed or expired bestie.', ephemeral: true });
        if (interaction.user.id !== t.discordId) return interaction.reply({ content: '💅 Only the applicant can answer.', ephemeral: true });
        const trole = applications[t.role];
        const tq = trole && trole.questions[t.qIndex];
        if (!tq) return interaction.reply({ content: 'No active question.', ephemeral: true });
        let answer = null;
        if ((id === 'app_yes' || id === 'app_no') && tq.type === 'yesno') answer = id === 'app_yes' ? 'Yes' : 'No';
        else if (id.startsWith('app_opt_') && tq.type === 'choice') {
          const i = parseInt(id.split('_')[2], 10);
          if (tq.options && tq.options[i]) answer = tq.options[i];
        }
        if (answer === null) return interaction.reply({ content: 'Use the correct question buttons.', ephemeral: true });
        try { await interaction.deferUpdate(); } catch {}
        try { await interaction.message.edit({ components: [] }); } catch {}
        await answerTicket(interaction.channelId, interaction.user.id, answer);
        return;
      }
      if (id === 'app_cancel') {
        const t = db.tickets[interaction.channelId];
        if (!t || t.status !== 'open') return interaction.reply({ content: 'Nothing to cancel.', ephemeral: true });
        if (interaction.user.id !== t.discordId) return interaction.reply({ content: 'Only the applicant can cancel.', ephemeral: true });
        await interaction.reply({ content: 'Cancelling ticket...' });
        return closeTicket(interaction.channelId, `Cancelled by <@${interaction.user.id}>.`, { log: true });
      }
      if (id === 'app_accept' || id === 'app_deny' || id === 'app_close') {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!await isStaffHigherThanBot(member)) return interaction.reply({ content: '💅 Staff only option bestie!', ephemeral: true });
        const t = db.tickets[interaction.channelId];
        if (id === 'app_close') { await interaction.reply({ content: 'Closing...' }); return closeTicket(interaction.channelId, `Closed by <@${interaction.user.id}>.`, { log: true }); }
        if (!t) return interaction.reply({ content: 'No application data.', ephemeral: true });
        const accepted = id === 'app_accept';
        const verdict = accepted ? 'ACCEPTED ✨' : 'DENIED 💅';
        const color = accepted ? 0x57f287 : 0xed4245;
        await interaction.reply({ embeds: [embedBase(`${verdict} — ${t.tag}`, `Role: **${t.roleLabel}**\nReviewer: <@${interaction.user.id}>`, color)] });
        try {
          const u = await client.users.fetch(t.discordId).catch(() => null);
          if (u) await u.send(`${verdict} Your **${t.roleLabel}** application was evaluated by ${interaction.user.tag}.` + (accepted ? ' Welcome aboard baddie! 🎉' : ' Thanks for applying!')).catch(() => {});
        } catch {}
        return closeTicket(interaction.channelId, `${verdict} by <@${interaction.user.id}>.`, { log: false, silent: false });
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;

    // ----- AFK COMMAND -----
    if (cmd === 'afk') {
      const reason = interaction.options.getString('reason') || 'Stepping away bestie 💅';
      db.afk[interaction.user.id] = { reason, at: Date.now() };
      save();
      return interaction.reply({ embeds: [embedBase('☕ AFK Mode Active', `I set your status to AFK!\n\n**Reason:** ${reason}\nI'll notify anyone who mentions you while you're away. Sending any message will automatically remove your AFK status.`, 0xff5da2)] });
    }

    // ----- SEND-MESSAGE COMMAND -----
    if (cmd === 'send-message') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const ch = interaction.options.getChannel('channel', true);
      const msg = interaction.options.getString('message', true);
      const title = interaction.options.getString('title');
      const hexColor = interaction.options.getString('color') || '#FF5DA2';

      if (!ch.isTextBased()) return interaction.reply({ content: '💅 Channel must be text-based bestie!', ephemeral: true });

      const parsedColor = parseInt(hexColor.replace('#', ''), 16) || 0xff5da2;

      if (title) {
        const emb = embedBase(title, msg, parsedColor);
        await ch.send({ embeds: [emb] });
      } else {
        await ch.send({ content: msg });
      }

      return interaction.reply({ content: `✨ Sent message into <#${ch.id}>!`, ephemeral: true });
    }

    // ----- PUBLIC COMMANDS -----
    if (cmd === 'help') {
      return interaction.reply({
        embeds: [embedBase('🌸 Summer Baddies — Command Menu ☕',
          `**Link / Verification**\n/link, /unlink, /verify-status, /profile\n\n` +
          `**Values & Trading**\n/value, /item, /owners, /online, /teleport, /search-weapons, /search-skins, /search-finishers, /search-player\n\n` +
          `**Levels & Utility**\n/afk, /rank, /leaderboard, /ping, /avatar, /server-info\n\n` +
          `**Applications & Tickets**\n/apply, /ticket-close\n\n` +
          `**Staff & Administration**\n/send-message, /give-weapon, /give-skin, /give-finisher, /player-data, /game-kick, /game-ban, /game-unban, /game-announce, /game-restart, /game-luck, /admin-abuse, /game-money, /give-tokens, /give-spins, /give-all-weapon, /give-all-skin, /give-all-finisher, /give-everything, /kick, /ban, /unban, /timeout, /untimeout, /setup-welcome, /setup-leave, /setup-reports, /setup-verified, /setup-levels, /setup-applications, /tickets, /selfroles, /shortcut-add, /shortcut-remove, /shortcut-list` + shortcutsHelp(),
          0xff5da2)], ephemeral: true
      });
    }

    if (cmd === 'ping') {
      const sent = await interaction.reply({ content: 'Checking latency...', fetchReply: true });
      const ms = sent.createdTimestamp - interaction.createdTimestamp;
      return interaction.editReply(`🏓 Pong bestie! Roundtrip: **${ms}ms** • WS Ping: **${Math.round(client.ws.ping)}ms**`);
    }

    if (cmd === 'server-info') {
      const g = interaction.guild;
      await g.members.fetch().catch(() => {});
      const linked = Object.keys(db.links).length;
      const onlineServers = Object.keys(db.servers).length;
      const onlinePlayers = Object.values(db.servers).reduce((a, s) => a + (s.players || []).length, 0);
      return interaction.reply({
        embeds: [embedBase(`🏠 ${g.name} — Server Tea ☕`,
          `💅 Members: **${g.memberCount}** • Linked Roblox Accounts: **${linked}**\n` +
          `🟢 Active Game Servers: **${onlineServers}** (Players in-game: **${onlinePlayers}**)\n` +
          `✨ Values: ${db.valuesCache.at ? `Live <t:${Math.floor(db.valuesCache.at / 1000)}:R> (${Object.keys(db.valuesCache.byKey).length} items)` : 'Seed data'}\n` +
          `📅 Created: <t:${Math.floor(g.createdTimestamp / 1000)}:D> • Server Boosts: **${g.premiumSubscriptionCount || 0}**`)
          .setThumbnail(g.iconURL())]
      });
    }

    if (cmd === 'avatar') {
      const u = interaction.options.getUser('user') || interaction.user;
      const e = embedBase(`🖼️ ${u.username}'s Avatar`, `[PNG Direct Link](${u.displayAvatarURL({ size: 1024 })})`).setImage(u.displayAvatarURL({ size: 1024 }));
      return interaction.reply({ embeds: [e] });
    }

    if (cmd === 'rank') {
      const u = interaction.options.getUser('user') || interaction.user;
      const rec = getLevelRec(u.id);
      const need = xpNeeded(rec.level || 0);
      const sorted = Object.entries(db.levels).sort((a, b) => (b[1].level * 10000 + b[1].xp) - (a[1].level * 10000 + a[1].xp));
      const pos = sorted.findIndex(([id]) => id === u.id) + 1;
      return interaction.reply({ embeds: [embedBase(`🏆 ${u.username} — Rank Analysis`, `Level: **${rec.level || 0}**\nXP Progress: **${rec.xp}** / ${need}\nMessages Sent: **${rec.msgs || 0}**\nLeaderboard Position: **#${pos || '—'}** of ${sorted.length}`)] });
    }

    if (cmd === 'leaderboard') {
      const sorted = Object.entries(db.levels).sort((a, b) => (b[1].level * 10000 + b[1].xp) - (a[1].level * 10000 + a[1].xp)).slice(0, 10);
      if (!sorted.length) return interaction.reply({ content: '💅 No XP earned yet bestie — start chatting!', ephemeral: true });
      const lines = sorted.map(([id, r], i) => `**${i + 1}.** <@${id}> — Level **${r.level}** (${r.xp} XP)`);
      return interaction.reply({ embeds: [embedBase('🏆 Levels Leaderboard', lines.join('\n'))] });
    }

    if (cmd === 'link') {
      const username = interaction.options.getString('username', true).replace('@', '');
      await interaction.deferReply({ ephemeral: true });
      const r = await robloxUserId(username);
      if (!r) return interaction.editReply('❌ Roblox user not found. Check spelling.');
      if (db.robloxToDiscord[r.id] && db.robloxToDiscord[r.id] !== interaction.user.id)
        return interaction.editReply('💅 That Roblox account is linked to another user bestie.');
      for (const [code, rec] of Object.entries(db.linkCodes)) if (rec.discordId === interaction.user.id) delete db.linkCodes[code];
      const code = String(Math.floor(100000 + Math.random() * 900000));
      db.linkCodes[code] = { discordId: interaction.user.id, robloxUsername: r.name, robloxId: r.id, expires: Date.now() + 10 * 60 * 1000 };
      save();
      const thumb = await robloxThumb(r.id);
      const e = embedBase('🔗 Link Account', `Found **${r.name}** (${r.displayName})\n\n**Step 2:** Join game and type:\n\`!verify ${code}\`\n\nCode expires in 10 minutes 💅`, 0x57f287);
      if (thumb) e.setThumbnail(thumb);
      return interaction.editReply({ embeds: [e] });
    }

    if (cmd === 'unlink') {
      const l = db.links[interaction.user.id];
      if (!l) return interaction.reply({ content: '💅 You are not linked bestie.', ephemeral: true });
      delete db.robloxToDiscord[l.robloxId]; delete db.links[interaction.user.id]; save();
      try {
        const m = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const roleId = db.settings.verifiedRoleId;
        if (m && roleId && m.roles.cache.has(roleId)) await m.roles.remove(roleId).catch(() => {});
      } catch {}
      return interaction.reply({ content: `🔓 Unlinked **${l.robloxUsername}** and updated roles.`, ephemeral: true });
    }

    if (cmd === 'verify-status') {
      const u = interaction.options.getUser('user') || interaction.user;
      const l = db.links[u.id];
      if (!l) return interaction.reply({ content: `💅 ${u.username} is **not verified** yet. Use /link to start!`, ephemeral: true });
      const thumb = await robloxThumb(l.robloxId);
      const e = embedBase('✅ Verified Status', `Discord: <@${u.id}>\nRoblox: **${l.robloxUsername}** (\`${l.robloxId}\`)\nLinked: <t:${Math.floor(l.at / 1000)}:R>\nProfile: https://www.roblox.com/users/${l.robloxId}/profile`, 0x57f287);
      if (thumb) e.setThumbnail(thumb);
      return interaction.reply({ embeds: [e], ephemeral: true });
    }

    if (cmd === 'profile') {
      const u = interaction.options.getUser('user') || interaction.user;
      const l = db.links[u.id];
      if (!l) return interaction.reply({ content: `💅 ${u.username} has not linked their Roblox account yet.`, ephemeral: true });
      const cached = db.playerCache[l.robloxId] || {};
      const inv = db.inventories[l.robloxId] || {};
      const thumb = await robloxThumb(l.robloxId);
      const emb = embedBase(`✨ Profile — ${l.robloxUsername}`,
        `👤 Discord: <@${u.id}>\n` +
        `🆔 Roblox ID: \`${l.robloxId}\`\n\n` +
        `💰 Dinero: **${cached.money || 0}**\n` +
        `⚔️ Slays: **${cached.slays || 0}**\n` +
        `🎒 Inventory: **${(inv.weapons || []).length}** Weapons • **${(inv.skins || []).length}** Skins • **${(inv.finishers || []).length}** Finishers`
      );
      if (thumb) emb.setThumbnail(thumb);
      return interaction.reply({ embeds: [emb] });
    }

    if (cmd === 'value' || cmd === 'item') {
      const type = interaction.options.getString('type', true);
      const name = interaction.options.getString('name', true);
      const emb = await buildItemEmbed(type, name);
      return interaction.reply({ embeds: [emb] });
    }

    if (cmd === 'online') {
      const serverEntries = Object.entries(db.servers);
      if (!serverEntries.length) return interaction.reply({ content: '💅 No game servers are live right now bestie.', ephemeral: true });
      const lines = serverEntries.map(([jid, s]) => `🟢 Server \`${jid.slice(0, 8)}\` — **${(s.players || []).length}** players active`);
      return interaction.reply({ embeds: [embedBase('🟢 Active Game Servers', lines.join('\n'))] });
    }

    // ----- STAFF / MODERATION COMMANDS -----
    if (['kick', 'ban', 'timeout'].includes(cmd)) {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const target = interaction.options.getUser('user', true);
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: '💅 Member not found in server.', ephemeral: true });

      if (member.roles.highest.position >= staff.roles.highest.position)
        return interaction.reply({ content: '💅 You cannot moderate someone equal or higher than you in role hierarchy bestie!', ephemeral: true });

      const reason = interaction.options.getString('reason') || 'No reason specified';

      if (cmd === 'kick') {
        await member.kick(reason);
        return interaction.reply({ embeds: [embedBase('👢 Member Kicked', `Kicked <@${target.id}> | Reason: ${reason}`)] });
      }
      if (cmd === 'ban') {
        await member.ban({ reason });
        return interaction.reply({ embeds: [embedBase('🔨 Member Banned', `Banned <@${target.id}> | Reason: ${reason}`)] });
      }
      if (cmd === 'timeout') {
        const min = interaction.options.getInteger('minutes', true);
        await member.timeout(min * 60 * 1000, reason);
        return interaction.reply({ embeds: [embedBase('⏰ Member Timed Out', `Timed out <@${target.id}> for ${min}m | Reason: ${reason}`)] });
      }
    }

    if (cmd === 'setup-applications') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const cat = interaction.options.getChannel('category', true);
      const rev = interaction.options.getChannel('review', true);
      const role = interaction.options.getRole('reviewer', true);
      db.settings.ticketCategoryId = cat.id;
      db.settings.ticketReviewChannelId = rev.id;
      db.settings.ticketReviewerRoleId = role.id;
      save();
      return interaction.reply({ content: `✨ Applications set up! Category: **${cat.name}**, Reviews: <#${rev.id}>, Reviewer Role: <@&${role.id}>.` });
    }

    if (cmd === 'setup-roles') {
      if (interaction.guild.ownerId !== interaction.user.id)
        return interaction.reply({ content: '💅 Only the server owner can execute layout role builds bestie.', ephemeral: true });
      await interaction.deferReply();
      const res = await setupRoleLadder(interaction.guild);
      return interaction.editReply(`✨ Setup complete! Created ${res.created.length} roles, skipped ${res.skipped.length}.`);
    }

    if (cmd === 'setup-layout') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      await interaction.deferReply();
      const desc = interaction.options.getString('description');
      const layoutData = desc ? parseLayoutDescription(desc).layout : getBaddiesPreset();
      const res = await applyLayout(interaction.guild, layoutData);
      return interaction.editReply(`✨ Server layout build applied! Channels created: ${res.createdChs.length}.`);
    }

  } catch (e) {
    console.error('Interaction processing error:', e);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '💅 Something went wrong executing that command bestie!', ephemeral: true }).catch(() => {});
    }
  }
});

// ---------- Express API Bridge for Roblox Integration ----------
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const auth = req.headers['x-api-key'] || req.query.key;
  if (auth !== API_KEY) return res.status(401).json({ error: 'Unauthorized key' });
  next();
});

app.get('/api/commands', (req, res) => {
  const cmds = takeCommandsForRoblox();
  res.json({ commands: cmds });
});

app.post('/api/commands/ack', (req, res) => {
  const { id } = req.body;
  if (id) ackCommand(id);
  res.json({ success: true });
});

app.post('/api/verify', (req, res) => {
  const { code, robloxUsername, robloxId } = req.body;
  const rec = db.linkCodes[code];
  if (!rec || Date.now() > rec.expires) return res.status(400).json({ error: 'Invalid or expired code' });
  db.links[rec.discordId] = { discordId: rec.discordId, robloxUsername, robloxId, at: Date.now() };
  db.robloxToDiscord[robloxId] = rec.discordId;
  delete db.linkCodes[code];
  save();
  res.json({ success: true, discordId: rec.discordId });
});

app.listen(PORT, async () => {
  console.log(`🚀 Bridge API active on port ${PORT}`);
  try {
    await registerCommands();
    await client.login(TOKEN);
  } catch (e) {
    console.error('Bot launch failure:', e.message);
  }
});
