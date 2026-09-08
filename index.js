require('dotenv').config();
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = require('path');
const catalogs = require('./catalogs');
const demand = require('./demand');
const rapStatic = require('./rap-static');
let icons = {};
try { icons = require('./icons'); } catch { icons = {}; }

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
  settings: { rulesText: '', welcomeChannel: '', leaveChannel: '', reportsChannel: '', linkLogChannel: '', verifiedRoleId: '', levelChannelId: '', levelsEnabled: true },
  commands: [], playerCache: {}, bans: {},
  valuesCache: { at: 0, byKey: {} },
  inventories: {}, servers: {}, levels: {}, iconCache: {}
};
try {
  if (fs.existsSync(DB_PATH)) {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    db = Object.assign(db, raw);
    db.settings = Object.assign({ rulesText: '', welcomeChannel: '', leaveChannel: '', reportsChannel: '', linkLogChannel: '', verifiedRoleId: '', levelChannelId: '', levelsEnabled: true }, raw.settings || {});
    db.valuesCache = raw.valuesCache || { at: 0, byKey: {} };
    db.inventories = raw.inventories || {};
    db.servers = raw.servers || {};
    db.levels = raw.levels || {};
    db.iconCache = raw.iconCache || {};
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
function getLevelRec(discordId) {
  if (!db.levels[discordId]) db.levels[discordId] = { xp: 0, level: 0, msgs: 0, lastXp: 0 };
  return db.levels[discordId];
}

// ---------- Discord client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages],
  partials: [Partials.GuildMember]
});

// ---------- slash commands ----------
const ADMIN_PERMS = '0';
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
  new SlashCommandBuilder().setName('game-money').setDescription('[STAFF] Give/Remove/Set Dinero')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('action').setDescription('Give/Remove/Set').setRequired(true).addChoices({ name: 'Give', value: 'Give' }, { name: 'Remove', value: 'Remove' }, { name: 'Set', value: 'Set' }))
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true)),
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
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('Slash commands registered to guild ' + GUILD_ID);
}

// ---------- helpers ----------
function embedBase(title, desc, color = 0xff5da2) {
  return new EmbedBuilder().setTitle(title).setDescription(desc || '').setColor(color).setTimestamp();
}
async function requireStaff(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (await isStaffHigherThanBot(member)) return member;
  await interaction.reply({ content: '❌ You need a role **higher than the bot** to use this.', ephemeral: true });
  return null;
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
  return embedBase('🌸 Welcome, ' + member.user.username + '!', `Welcome to **${member.guild.name}**!\n\n` +
    `• Link your Roblox: use \`/link <RobloxUsername>\` then type \`!verify CODE\` in Summer Baddies\n` +
    `• Check \`/verify-status\` after linking to get the Verified role\n` +
    `• Read the rules with \`/rules\`\n• Have fun, baddie 💅`, 0xff5da2)
    .setThumbnail(member.user.displayAvatarURL())
    .setFooter({ text: `Member #${member.guild.memberCount}` });
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
    await ch.send({ embeds: [embedBase('👋 ' + (member.user?.username || 'Someone') + ' left', `We'll miss you! **${member.guild.name}** now has ${member.guild.memberCount} members.`, 0x808080)] });
    return { ok: true };
  } catch (e) { console.error('[leave] send failed:', e.message); return { ok: false, err: e.message }; }
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
  // prune stale servers/inventories every 5 min
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

// Levels: XP on chat (no MessageContent intent needed — we only count messages)
client.on('messageCreate', async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;
    if (msg.guild.id !== GUILD_ID) return;
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
      const text = `🎉 <@${id}> leveled up to **Level ${rec.level}**! Keep chatting, baddie 💅`;
      const chId = db.settings.levelChannelId;
      try {
        if (chId) {
          const ch = await client.channels.fetch(chId).catch(() => null);
          if (ch && ch.isTextBased()) await ch.send(text);
          else await msg.channel.send(text);
        } else {
          await msg.channel.send(text);
        }
      } catch {}
    }
  } catch (e) { console.error('levels error', e.message); }
});

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
      if (name === 'give-finisher') list = catalogs.finishers;
      if (name === 'give-skin' && focusedOpt.name === 'skin') list = catalogs.skinTypes;
      if (name === 'give-skin' && focusedOpt.name === 'weapontype') list = catalogs.skinTypes;
      if (!list.length) {
        // fallback for value/item/owners when type missing
        if (['value', 'item', 'owners'].includes(name)) list = [...catalogs.weapons, ...catalogs.finishers, ...catalogs.skinTypes];
      }
      await interaction.respond(fuzzy(list, q, 10).map(v => ({ name: v.slice(0, 100), value: v })).slice(0, 25));
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;

    // ----- PUBLIC -----
    if (cmd === 'help') {
      return interaction.reply({
        embeds: [embedBase('🌸 Summer Baddies Bot — Help',
          `**Link / Verify**\n/link, /unlink, /verify-status, /profile\n\n` +
          `**Values + Trading**\n/value, /item (icon+RAP+demand+owners+teleport+Discord), /owners, /online, /teleport, /search-weapons, /search-skins, /search-finishers, /search-player\n\n` +
          `**Levels + Fun**\n/rank, /leaderboard, /ping, /avatar, /server-info\n\n` +
          `**Rules**\n/rules\n\n` +
          `**Staff (role higher than bot)**\n/give-weapon, /give-skin, /give-finisher, /player-data, /game-kick, /game-ban, /game-unban, /game-announce, /game-money, /kick, /ban, /unban, /timeout, /untimeout, /setup-welcome, /setup-leave, /setup-reports, /setup-verified, /setup-levels, /test-welcome, /test-leave, /linked-list, /set-rules, /send-tos`,
          0xff5da2)], ephemeral: true
      });
    }
    if (cmd === 'ping') {
      const sent = await interaction.reply({ content: 'Pinging…', fetchReply: true });
      const ms = sent.createdTimestamp - interaction.createdTimestamp;
      return interaction.editReply(`🏓 Pong! Roundtrip **${ms}ms** • WS **${Math.round(client.ws.ping)}ms**`);
    }
    if (cmd === 'server-info') {
      const g = interaction.guild;
      await g.members.fetch().catch(() => {});
      const linked = Object.keys(db.links).length;
      const onlineServers = Object.keys(db.servers).length;
      const onlinePlayers = Object.values(db.servers).reduce((a, s) => a + (s.players || []).length, 0);
      return interaction.reply({
        embeds: [embedBase(`🏠 ${g.name}`,
          `Members: **${g.memberCount}** • Linked Roblox: **${linked}**\n` +
          `Live game servers tracked: **${onlineServers}** (players: **${onlinePlayers}**)\n` +
          `Values: ${db.valuesCache.at ? `live <t:${Math.floor(db.valuesCache.at / 1000)}:R> (${Object.keys(db.valuesCache.byKey).length} items)` : 'seeds only'}\n` +
          `Created: <t:${Math.floor(g.createdTimestamp / 1000)}:D> • Boosts: **${g.premiumSubscriptionCount || 0}**`)
          .setThumbnail(g.iconURL())]
      });
    }
    if (cmd === 'avatar') {
      const u = interaction.options.getUser('user') || interaction.user;
      const e = embedBase(`🖼️ ${u.username}`, `[PNG](${u.displayAvatarURL({ size: 1024 })}) • [JPG](${u.displayAvatarURL({ size: 1024, extension: 'jpg' })})`).setImage(u.displayAvatarURL({ size: 1024 }));
      return interaction.reply({ embeds: [e] });
    }
    if (cmd === 'rank') {
      const u = interaction.options.getUser('user') || interaction.user;
      const rec = getLevelRec(u.id);
      const need = xpNeeded(rec.level || 0);
      const sorted = Object.entries(db.levels).sort((a, b) => (b[1].level * 10000 + b[1].xp) - (a[1].level * 10000 + a[1].xp));
      const pos = sorted.findIndex(([id]) => id === u.id) + 1;
      return interaction.reply({ embeds: [embedBase(`🏆 ${u.username} — Level ${rec.level || 0}`, `XP: **${rec.xp}** / ${need}\nMessages: **${rec.msgs || 0}**\nRank: **#${pos || '—'}** of ${sorted.length}`)] });
    }
    if (cmd === 'leaderboard') {
      const sorted = Object.entries(db.levels).sort((a, b) => (b[1].level * 10000 + b[1].xp) - (a[1].level * 10000 + a[1].xp)).slice(0, 10);
      if (!sorted.length) return interaction.reply({ content: 'No XP yet — chat to earn levels!', ephemeral: true });
      const lines = sorted.map(([id, r], i) => `**${i + 1}.** <@${id}> — Level **${r.level}** (${r.xp} XP)`);
      return interaction.reply({ embeds: [embedBase('🏆 Levels Leaderboard', lines.join('\n'))] });
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
      const e = embedBase('👤 ' + l.robloxUsername, `Discord: <@${u.id}>\nRoblox ID: \`${l.robloxId}\`\nProfile: https://www.roblox.com/users/${l.robloxId}/profile` +
        (cached ? `\n\n💰 Dinero: **${cached.money ?? '?'}**\n⚔️ Slays: **${cached.slays ?? '?'}**\n🎒 Weapons: ${cached.weapons ?? '?'} • Skins: ${cached.skins ?? '?'} • Finishers: ${cached.finishers ?? '?'}\n🟢 Last seen: <t:${Math.floor((cached.at || Date.now()) / 1000)}:R>` : '\n\n_No cached game data yet — join the game once._') +
        (inv && inv.jobId && inv.placeId ? `\n\n🚀 [Join their server](${teleportLink(inv.placeId, inv.jobId)})` : ''), 0xff5da2);
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

    // ----- STAFF -----
    const staffOnly = ['give-weapon', 'give-skin', 'give-finisher', 'player-data', 'game-kick', 'game-ban', 'game-unban', 'game-announce', 'game-money', 'kick', 'ban', 'unban', 'timeout', 'untimeout', 'setup-welcome', 'setup-leave', 'setup-reports', 'setup-verified', 'setup-levels', 'test-welcome', 'test-leave', 'linked-list', 'set-rules', 'send-tos'];
    if (staffOnly.includes(cmd)) {
      const staff = await requireStaff(interaction);
      if (!staff) return;
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
    if (cmd === 'game-kick' || cmd === 'game-ban' || cmd === 'game-unban' || cmd === 'game-announce' || cmd === 'game-money') {
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
      if (cmd === 'game-money') { const u = await robloxUserId(interaction.options.getString('username', true)); if (!u) return interaction.reply({ content: '❌ Not found.', ephemeral: true }); payload = { type: 'money', action: interaction.options.getString('action', true), robloxUsername: u.name, robloxId: u.id, amount: interaction.options.getInteger('amount', true), by: interaction.user.tag }; }
      queueCommand(payload);
      return interaction.reply({ embeds: [embedBase('✅ Sent to game', `\`${payload.type}\` queued. Online servers pick it up in ~5s.`, 0x57f287)], ephemeral: true });
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
