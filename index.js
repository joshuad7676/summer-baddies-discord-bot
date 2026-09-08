require('dotenv').config();
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, PermissionFlagsBits, DefaultMemberPermissionsBitField } = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = require('path');
const catalogs = require('./catalogs');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const API_KEY = process.env.BOT_API_KEY || 'change_me';
const PORT = process.env.PORT || 3000;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN / CLIENT_ID / GUILD_ID in .env');
  process.exit(1);
}

// ---------- tiny JSON db ----------
const DB_PATH = path.join(__dirname, 'data.json');
let db = { links: {}, robloxToDiscord: {}, linkCodes: {}, settings: { rulesText: '' }, commands: [], playerCache: {}, bans: {} };
try { if (fs.existsSync(DB_PATH)) db = Object.assign(db, JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))); } catch {}
function save() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function queueCommand(cmd) {
  cmd.id = 'cmd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  cmd.createdAt = Date.now();
  db.commands.push(cmd);
  // keep last 200, expire broadcast after 120s in poll handler
  if (db.commands.length > 200) db.commands = db.commands.slice(-200);
  save();
  return cmd.id;
}
function takeCommandsForRoblox() {
  const now = Date.now();
  // drop expired broadcast (>180s) and old targeted (>10min)
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

// ---------- permission: role higher than bot ----------
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

// ---------- Discord client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages],
  partials: [Partials.GuildMember]
});

// ---------- slash commands ----------
const ADMIN_PERMS = '0'; // hidden by default; we additionally enforce "higher than bot" at runtime
const commands = [
  // public
  new SlashCommandBuilder().setName('link').setDescription('Link your Roblox account (type your Roblox username)')
    .addStringOption(o => o.setName('username').setDescription('Your Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('unlink').setDescription('Unlink your Roblox account'),
  new SlashCommandBuilder().setName('profile').setDescription('Show linked Roblox profile + game data')
    .addUserOption(o => o.setName('user').setDescription('Discord user (default: you)')),
  new SlashCommandBuilder().setName('search-skins').setDescription('Search skins in game')
    .addStringOption(o => o.setName('query').setDescription('skin name').setRequired(true)),
  new SlashCommandBuilder().setName('search-weapons').setDescription('Search weapons in game')
    .addStringOption(o => o.setName('query').setDescription('weapon name').setRequired(true)),
  new SlashCommandBuilder().setName('search-finishers').setDescription('Search finishers in game')
    .addStringOption(o => o.setName('query').setDescription('finisher name').setRequired(true)),
  new SlashCommandBuilder().setName('search-player').setDescription('Search for player data (Roblox + cached game data)')
    .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('rules').setDescription('Show server rules (custom or Discord TOS)')
    .addStringOption(o => o.setName('mode').setDescription('custom or tos').addChoices({ name: 'custom', value: 'custom' }, { name: 'tos', value: 'tos' })),
  // admin (hidden, hierarchy-checked)
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

// ---------- bot events ----------
client.on('guildMemberAdd', async (member) => {
  const chId = db.settings.welcomeChannel || process.env.WELCOME_CHANNEL_ID;
  if (!chId) return;
  const ch = member.guild.channels.cache.get(chId);
  if (!ch || !ch.isTextBased()) return;
  const e = embedBase('🌸 Welcome, ' + member.user.username + '!', `Welcome to **${member.guild.name}**!\n\n` +
    `• Link your Roblox: use \`/link <RobloxUsername>\` then type \`!verify CODE\` in Summer Baddies\n` +
    `• Read the rules with \`/rules\`\n• Have fun, baddie 💅`, 0xff5da2)
    .setThumbnail(member.user.displayAvatarURL()).setFooter({ text: `Member #${member.guild.memberCount}` });
  ch.send({ embeds: [e] }).catch(() => {});
});
client.on('guildMemberRemove', async (member) => {
  const chId = db.settings.leaveChannel || process.env.LEAVE_CHANNEL_ID;
  if (!chId) return;
  const ch = member.guild.channels.cache.get(chId);
  if (!ch || !ch.isTextBased()) return;
  ch.send({ embeds: [embedBase('👋 ' + member.user.username + ' left', `We'll miss you! **${member.guild.name}** now has ${member.guild.memberCount} members.`, 0x808080)] }).catch(() => {});
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const name = interaction.commandName;
      const focused = interaction.options.getFocused().toLowerCase();
      let list = [];
      if (name === 'give-weapon') list = catalogs.weapons;
      if (name === 'give-finisher') list = catalogs.finishers;
      if (name === 'give-skin' && interaction.options.getFocused(true).name === 'skin') list = catalogs.skinTypes;
      if (name === 'give-skin' && interaction.options.getFocused(true).name === 'weapontype') list = catalogs.skinTypes;
      await interaction.respond(fuzzy(list, focused, 10).map(v => ({ name: v.slice(0, 100), value: v })).slice(0, 25));
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;

    // ----- PUBLIC -----
    if (cmd === 'link') {
      const username = interaction.options.getString('username', true).replace('@', '');
      await interaction.deferReply({ ephemeral: true });
      const r = await robloxUserId(username);
      if (!r) return interaction.editReply('❌ Roblox user not found. Check spelling.');
      if (db.robloxToDiscord[r.id] && db.robloxToDiscord[r.id] !== interaction.user.id)
        return interaction.editReply('❌ That Roblox account is already linked to someone else. Ask staff for help.');
      const code = String(Math.floor(100000 + Math.random() * 900000));
      db.linkCodes[code] = { discordId: interaction.user.id, robloxUsername: r.name, robloxId: r.id, expires: Date.now() + 10 * 60 * 1000 };
      save();
      const thumb = await robloxThumb(r.id);
      const e = embedBase('🔗 Link your account', `Found **${r.name}** (${r.displayName})\n\n**Step 2:** join Summer Baddies and chat:\n\`!verify ${code}\`\n\nCode expires in 10 minutes. Punishments sync both ways once linked.`, 0x57f287);
      if (thumb) e.setThumbnail(thumb);
      return interaction.editReply({ embeds: [e] });
    }
    if (cmd === 'unlink') {
      const l = db.links[interaction.user.id];
      if (!l) return interaction.reply({ content: 'You are not linked.', ephemeral: true });
      delete db.robloxToDiscord[l.robloxId]; delete db.links[interaction.user.id]; save();
      return interaction.reply({ content: `🔓 Unlinked **${l.robloxUsername}**.`, ephemeral: true });
    }
    if (cmd === 'profile') {
      const u = interaction.options.getUser('user') || interaction.user;
      const l = db.links[u.id];
      if (!l) return interaction.reply({ content: `${u.username} has not linked a Roblox account. Use /link.`, ephemeral: true });
      const cached = db.playerCache[l.robloxId];
      const thumb = await robloxThumb(l.robloxId);
      const e = embedBase('👤 ' + l.robloxUsername, `Discord: <@${u.id}>\nRoblox ID: \`${l.robloxId}\`\nProfile: https://www.roblox.com/users/${l.robloxId}/profile` +
        (cached ? `\n\n💰 Dinero: **${cached.money ?? '?'}**\n⚔️ Slays: **${cached.slays ?? '?'}**\n🎒 Weapons: ${cached.weapons ?? '?'} • Skins: ${cached.skins ?? '?'} • Finishers: ${cached.finishers ?? '?'}\n🟢 Last seen: <t:${Math.floor((cached.at || Date.now()) / 1000)}:R>` : '\n\n_No cached game data yet — join the game once._'), 0xff5da2);
      if (thumb) e.setThumbnail(thumb);
      return interaction.reply({ embeds: [e] });
    }
    if (cmd === 'search-skins' || cmd === 'search-weapons' || cmd === 'search-finishers') {
      const q = interaction.options.getString('query', true);
      const list = cmd === 'search-skins' ? catalogs.skinTypes : cmd === 'search-weapons' ? catalogs.weapons : catalogs.finishers;
      const hits = fuzzy(list, q, 8);
      if (!hits.length) return interaction.reply({ content: `No matches for "${q}". Try a shorter term.`, ephemeral: true });
      return interaction.reply({ embeds: [embedBase(`🔎 ${cmd.replace('search-', '')} — "${q}"`, hits.map((h, i) => `**${i + 1}.** ${h}`).join('\n'))] });
    }
    if (cmd === 'search-player') {
      const username = interaction.options.getString('username', true);
      await interaction.deferReply();
      const r = await robloxUserId(username);
      if (!r) return interaction.editReply('❌ Roblox user not found.');
      const thumb = await robloxThumb(r.id);
      const cached = db.playerCache[r.id];
      const discordId = db.robloxToDiscord[r.id];
      const e = embedBase('🔎 ' + r.name, `Display: ${r.displayName}\nID: \`${r.id}\`\nProfile: https://www.roblox.com/users/${r.id}/profile\nDiscord: ${discordId ? `<@${discordId}> (linked ✅)` : '_not linked_'}` +
        (cached ? `\n\n💰 Dinero: **${cached.money}** | ⚔️ Slays: **${cached.slays}**\n🎒 W:${cached.weapons} S:${cached.skins} F:${cached.finishers}\n🟢 <t:${Math.floor(cached.at / 1000)}:R>` : '\n\n_No cached in-game data (offline or never joined since bridge installed)._'));
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
    const staffOnly = ['give-weapon', 'give-skin', 'give-finisher', 'player-data', 'game-kick', 'game-ban', 'game-unban', 'game-announce', 'game-money', 'kick', 'ban', 'unban', 'timeout', 'untimeout', 'setup-welcome', 'setup-leave', 'setup-reports', 'set-rules', 'send-tos'];
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
      const thumb = await robloxThumb(r.id);
      const e = embedBase('📊 ' + r.name, cached ? `💰 Dinero: **${cached.money}**\n⚔️ Slays: **${cached.slays}**\n🎒 Weapons(${cached.weapons}) Skins(${cached.skins}) Finishers(${cached.finishers})\n🟢 Updated: <t:${Math.floor(cached.at / 1000)}:R>\nDiscord: ${db.robloxToDiscord[r.id] ? `<@${db.robloxToDiscord[r.id]}>` : 'not linked'}` : 'No cached data — player offline or bridge not yet reporting. Use /search-player for Roblox profile.');
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
      // reflect to game if linked
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
      if (cmd === 'setup-welcome') db.settings.welcomeChannel = ch.id;
      if (cmd === 'setup-leave') db.settings.leaveChannel = ch.id;
      if (cmd === 'setup-reports') db.settings.reportsChannel = ch.id;
      save();
      return interaction.reply({ content: `✅ ${cmd} → <#${ch.id}>`, ephemeral: true });
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

// Reports from game -> Discord staff DMs + reports channel
app.post('/roblox/report', auth, async (req, res) => {
  try {
    const { reporter, reporterId, reported, reportedId, reason, details, placeId, jobId } = req.body;
    const guild = client.guilds.cache.get(GUILD_ID);
    const e = new EmbedBuilder().setTitle('🚨 New in-game report').setColor(0xed4245).setTimestamp()
      .addFields(
        { name: 'Reporter', value: `${reporter} (\`${reporterId}\`)`, inline: true },
        { name: 'Reported', value: `${reported} (\`${reportedId}\`)`, inline: true },
        { name: 'Reason', value: String(reason || 'Other').slice(0, 200) },
        { name: 'Details', value: String(details || '—').slice(0, 1000) },
        { name: 'Server', value: `https://www.roblox.com/games/${placeId || ''} — JobId \`${String(jobId || '').slice(0, 20)}\`` }
      );
    const chId = db.settings.reportsChannel || process.env.REPORTS_CHANNEL_ID;
    if (guild && chId) { const ch = guild.channels.cache.get(chId); if (ch && ch.isTextBased()) ch.send({ embeds: [e] }).catch(() => {}); }
    // DM everyone with role higher than bot
    if (guild) {
      const staff = await staffHigherThanBotList(guild);
      let dmCount = 0;
      for (const [, m] of staff) {
        try { await m.send({ embeds: [e.setFooter({ text: `Reported in Summer Baddies • ${new Date().toLocaleString()}` })] }); dmCount++; } catch {}
        if (dmCount >= 20) break; // safety cap
      }
      console.log(`Report ${reporter} -> ${reported} DM'd to ${dmCount} staff`);
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ ok: false }); }
});

// Player data pushes from game (for /profile /player-data /search-player)
app.post('/roblox/player-data', auth, (req, res) => {
  const { robloxId, robloxUsername, money, slays, weapons, skins, finishers } = req.body;
  if (robloxId) { db.playerCache[robloxId] = { robloxUsername, money, slays, weapons, skins, finishers, at: Date.now() }; save(); }
  res.json({ ok: true });
});

// Link verification from game (!verify CODE chatted in game)
app.post('/roblox/verify', auth, (req, res) => {
  const { code, robloxUsername, robloxId } = req.body;
  const rec = db.linkCodes[String(code)];
  if (!rec) return res.json({ ok: false, error: 'Invalid code. Do /link in Discord first.' });
  if (Date.now() > rec.expires) { delete db.linkCodes[String(code)]; save(); return res.json({ ok: false, error: 'Code expired. Do /link again.' }); }
  if (Number(robloxId) !== Number(rec.robloxId)) return res.json({ ok: false, error: `That code is for ${rec.robloxUsername}, but you are ${robloxUsername}.` });
  db.links[rec.discordId] = { robloxUsername: rec.robloxUsername, robloxId: rec.robloxId, at: Date.now() };
  db.robloxToDiscord[rec.robloxId] = rec.discordId;
  delete db.linkCodes[String(code)]; save();
  // notify in Discord
  (async () => {
    try {
      const guild = client.guilds.cache.get(GUILD_ID);
      const m = guild ? await guild.members.fetch(rec.discordId).catch(() => null) : null;
      if (m) m.send(`✅ Linked! Discord <@${rec.discordId}> ↔ Roblox **${rec.robloxUsername}**. Punishments now sync both ways.`).catch(() => {});
      const logId = db.settings.linkLogChannel || process.env.LINK_LOG_CHANNEL_ID;
      if (guild && logId) { const ch = guild.channels.cache.get(logId); if (ch && ch.isTextBased()) ch.send(`🔗 <@${rec.discordId}> linked to **${rec.robloxUsername}** (\`${rec.robloxId}\`)`); }
    } catch {}
  })();
  res.json({ ok: true, discordId: rec.discordId, robloxUsername: rec.robloxUsername });
});

// Punishment synced FROM game (game ban/kick -> Discord)
app.post('/roblox/punishment', auth, async (req, res) => {
  const { action, robloxUsername, robloxId, reason, by } = req.body; // action: ban/kick/timeout_note
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

// Let game check Discord ban state (for join-time enforcement both ways)
app.get('/roblox/bans', auth, (req, res) => res.json({ ok: true, bans: db.bans }));
app.get('/roblox/links', auth, (req, res) => res.json({ ok: true, links: db.robloxToDiscord }));

(async () => {
  await registerCommands().catch(e => console.error('register failed', e));
  app.listen(PORT, () => console.log('Bridge HTTP on :' + PORT));
  client.login(TOKEN);
})();
