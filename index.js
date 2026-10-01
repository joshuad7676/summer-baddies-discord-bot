/**
 * Summer Baddies Discord Bot — professional rewrite (discord.js v14)
 *
 * - Clean modular commands in ./commands/*.js
 * - JSON database in ./data.json (src/db.js)
 * - Consistent theme embeds (src/embeds.js)
 * - Roblox bridge in src/bridge.js (poll contract preserved)
 * - No runtime patching. startup.js just requires this file.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, REST, Routes, PermissionFlagsBits } = require('discord.js');
const { getDb, save } = require('./src/db');
const { embedBase, themeColorInt } = require('./src/embeds');
const { startBridge, isStaffHigherThanBot } = require('./src/bridge');
const { queueCommand, resolveRobloxTarget } = require('./src/roblox');
const { checkRaid } = require('./src/raid');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const API_KEY = process.env.BOT_API_KEY || 'change_me';
const PORT = Number(process.env.PORT) || 3000;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('[boot] Missing DISCORD_TOKEN / CLIENT_ID / GUILD_ID in .env — copy .env.example to .env first.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.GuildMember, Partials.Message, Partials.Channel, Partials.Reaction],
});

// ---------- modular command loader ----------
const commands = new Map(); // name -> { data, execute, autocomplete }
function loadCommands() {
  const dir = path.join(__dirname, 'commands');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const defs = require(path.join(dir, file));
    const list = Array.isArray(defs) ? defs : [defs];
    for (const def of list) {
      if (!def?.data?.name || typeof def.execute !== 'function') {
        console.warn(`[commands] skip invalid export in ${file}`);
        continue;
      }
      if (commands.has(def.data.name)) console.warn(`[commands] duplicate /${def.data.name} in ${file} — overwriting`);
      commands.set(def.data.name, def);
    }
  }
  console.log(`[commands] loaded ${commands.size} slash commands from ${files.length} files`);
}
loadCommands();

async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = [...commands.values()].map((c) => c.data.toJSON());
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
  console.log(`[deploy] registered ${body.length} guild slash commands`);
}

// ---------- natural-language chat controls (mention the bot) ----------
// Full implementation lives in src/natural.js so it stays testable.
const { handleNatural } = require('./src/natural');

// ---------- custom text prefixes: "<prefix><command> args" ----------
async function handleCustomPrefix(message) {
  const db = getDb();
  const map = db.settings.commandPrefixes || {};
  const names = Object.keys(map);
  if (!names.length) return false;
  const content = message.content.trim();
  for (const cmd of names) {
    const prefix = map[cmd];
    if (!prefix) continue;
    if (!content.toLowerCase().startsWith((prefix + cmd).toLowerCase())) continue;
    const rest = content.slice((prefix + cmd).length).trim();
    const member = message.member;
    if (!member || !(await isStaffHigherThanBot(member).catch(() => false))) {
      await message.reply('❌ You need a role **higher than the bot** to use game commands.').catch(() => {});
      return true;
    }
    try {
      await runTextGameCommand(message, cmd, rest);
    } catch (e) {
      await message.reply(`❌ ${String(e.message || e).slice(0, 200)}`).catch(() => {});
    }
    return true;
  }
  return false;
}

async function runTextGameCommand(message, cmd, rest) {
  const parts = rest.split(/\s+/).filter(Boolean);
  const by = message.author.tag;
  const needUser = async (token) => {
    const t = await resolveRobloxTarget(token);
    if (!t) throw new Error(`Roblox user \`${token}\` not found.`);
    return t;
  };
  const replyQueued = (type, target, extra = '') =>
    message.reply({ embeds: [embedBase('✅ Queued for game', `\`${type}\` → **${target}**${extra}`, 0x57d9a3)] }).catch(() => {});

  switch (cmd) {
    case 'game-kick': {
      const t = await needUser(parts[0]);
      const reason = parts.slice(1).join(' ') || 'Kicked by staff';
      queueCommand({ type: 'kick', robloxUsername: t.rUsername, robloxId: t.rId, reason, by });
      return replyQueued('kick', t.rUsername, `\n${reason}`);
    }
    case 'game-ban': {
      const t = await needUser(parts[0]);
      const reason = parts.slice(1).join(' ') || 'Banned by staff';
      queueCommand({ type: 'ban', robloxUsername: t.rUsername, robloxId: t.rId, reason, by });
      getDb().bans[String(t.rId)] = { reason, by, at: Date.now() }; save();
      return replyQueued('ban', t.rUsername, `\n${reason}`);
    }
    case 'game-unban': {
      const t = await needUser(parts[0]);
      queueCommand({ type: 'unban', robloxUsername: t.rUsername, robloxId: t.rId, by });
      return replyQueued('unban', t.rUsername);
    }
    case 'game-announce': {
      if (!rest) throw new Error(`Usage: \`${getDb().settings.commandPrefixes[cmd]}${cmd} <message>\``);
      queueCommand({ type: 'announce', message: rest.slice(0, 200), by, broadcast: true });
      return replyQueued('announce', 'all servers', `\n> ${rest.slice(0, 200)}`);
    }
    case 'game-restart': {
      const delay = Math.min(Math.max(parseInt(parts[0], 10) || 30, 5), 120);
      const reason = (isNaN(parseInt(parts[0], 10)) ? rest : parts.slice(1).join(' ')).slice(0, 200) || 'Restarting...';
      queueCommand({ type: 'restart', delay, reason, by, broadcast: true });
      return replyQueued('restart', 'all servers', `\nIn **${delay}s** — ${reason}`);
    }
    case 'game-luck': {
      const mult = Math.min(Math.max(parseInt(parts[0], 10) || 2, 1), 10);
      const minutes = Math.min(Math.max(parseInt(parts[1], 10) || 10, 1), 60);
      queueCommand({ type: 'luck', mult, minutes, by, broadcast: true });
      return replyQueued('luck', 'all servers', `\n**${mult}x** for **${minutes}m**`);
    }
    case 'admin-abuse': {
      const ev = (parts[0] || '').toLowerCase();
      const valid = ['money-rain', 'spin-party', 'heal-all', 'midnight', 'daybreak', 'disco', 'all'];
      if (!valid.includes(ev)) throw new Error(`Usage: \`${getDb().settings.commandPrefixes[cmd]}${cmd} <${valid.join('|')}>\``);
      queueCommand({ type: 'abuse', event: ev, duration: 60, by, broadcast: true });
      return replyQueued('abuse', 'all servers', `\nEvent: **${ev}**`);
    }
    case 'player-data': {
      const t = await needUser(parts[0]);
      const cached = getDb().playerCache[String(t.rId)];
      return message.reply({ embeds: [embedBase(`🎮 ${t.rUsername}`, cached ? `💰 **${cached.money ?? '?'}** • ⚔️ **${cached.slays ?? '?'}**` : '_No cached data._', themeColorInt())] }).catch(() => {});
    }
    case 'game-money':
    case 'give-tokens': {
      const action = parts[0]; const userTok = parts[1]; const amt = parseInt(parts[2], 10);
      if (!['Give', 'Remove', 'Set'].includes(action) || !userTok || !Number.isFinite(amt)) throw new Error(`Usage: \`${getDb().settings.commandPrefixes[cmd]}${cmd} <Give|Remove|Set> <user> <amount>\``);
      const t = await needUser(userTok);
      queueCommand(cmd === 'game-money'
        ? { type: 'money', action, robloxUsername: t.rUsername, robloxId: t.rId, amount: amt, by }
        : { type: 'give_tokens', action, robloxUsername: t.rUsername, robloxId: t.rId, amount: amt, by });
      return replyQueued(cmd, t.rUsername, `\n${action} **${amt}**`);
    }
    case 'give-spins': {
      const kind = (parts[0] || '').toLowerCase(); const action = parts[1]; const userTok = parts[2]; const amt = parseInt(parts[3], 10);
      if (!['hourly', 'wheel'].includes(kind) || !['Give', 'Remove', 'Set'].includes(action) || !userTok || !Number.isFinite(amt)) throw new Error(`Usage: \`${getDb().settings.commandPrefixes[cmd]}${cmd} <hourly|wheel> <Give|Remove|Set> <user> <amount>\``);
      const t = await needUser(userTok);
      queueCommand({ type: 'give_spins', kind: kind[0].toUpperCase() + kind.slice(1), action, robloxUsername: t.rUsername, robloxId: t.rId, amount: amt, by });
      return replyQueued('give_spins', t.rUsername);
    }
    case 'give-weapon': {
      const t = await needUser(parts[0]);
      const item = parts.slice(1).join(' ');
      if (!item) throw new Error('Usage: `<prefix>give-weapon <user> <weapon>`');
      queueCommand({ type: 'give_weapon', robloxUsername: t.rUsername, robloxId: t.rId, weapon: item, by });
      return replyQueued('give_weapon', t.rUsername, `\nWeapon: **${item}**`);
    }
    case 'give-finisher': {
      const t = await needUser(parts[0]);
      const item = parts.slice(1).join(' ');
      if (!item) throw new Error('Usage: `<prefix>give-finisher <user> <finisher>`');
      queueCommand({ type: 'give_finisher', robloxUsername: t.rUsername, robloxId: t.rId, finisher: item, by });
      return replyQueued('give_finisher', t.rUsername, `\nFinisher: **${item}**`);
    }
    case 'give-skin': {
      const t = await needUser(parts[0]);
      const wt = parts[1]; const sk = parts.slice(2).join(' ');
      if (!wt || !sk) throw new Error('Usage: `<prefix>give-skin <user> <weaponType> <skin>`');
      queueCommand({ type: 'give_skin', robloxUsername: t.rUsername, robloxId: t.rId, weaponType: wt, skin: sk, by });
      return replyQueued('give_skin', t.rUsername, `\n${wt} / **${sk}**`);
    }
    case 'give-all-weapon': {
      if (!rest) throw new Error('Usage: `<prefix>give-all-weapon <weapon>`');
      queueCommand({ type: 'give_all_weapon', weapon: rest, by, broadcast: true });
      return replyQueued('give_all_weapon', 'EVERYONE online', `\nWeapon: **${rest}**`);
    }
    case 'give-all-skin': {
      const wt = parts[0]; const sk = parts.slice(1).join(' ');
      if (!wt || !sk) throw new Error('Usage: `<prefix>give-all-skin <weaponType> <skin>`');
      queueCommand({ type: 'give_all_skin', weaponType: wt, skin: sk, by, broadcast: true });
      return replyQueued('give_all_skin', 'EVERYONE online');
    }
    case 'give-all-finisher': {
      if (!rest) throw new Error('Usage: `<prefix>give-all-finisher <finisher>`');
      queueCommand({ type: 'give_all_finisher', finisher: rest, by, broadcast: true });
      return replyQueued('give_all_finisher', 'EVERYONE online');
    }
    case 'give-all-tokens': {
      const amt = parseInt(parts[0], 10);
      if (!Number.isFinite(amt) || amt < 1) throw new Error('Usage: `<prefix>give-all-tokens <amount>`');
      queueCommand({ type: 'give_all_tokens', amount: amt, by, broadcast: true });
      return replyQueued('give_all_tokens', 'EVERYONE online', `\n**${amt}** tokens`);
    }
    case 'give-all-spins': {
      const kind = (parts[0] || '').toLowerCase(); const amt = parseInt(parts[1], 10);
      if (!['hourly', 'wheel'].includes(kind) || !Number.isFinite(amt)) throw new Error('Usage: `<prefix>give-all-spins <hourly|wheel> <amount>`');
      queueCommand({ type: 'give_all_spins', kind, amount: amt, by, broadcast: true });
      return replyQueued('give_all_spins', 'EVERYONE online');
    }
    default:
      throw new Error(`Text trigger for \`/${cmd}\` is set, but parsing isn't implemented — use \`/${cmd}\` directly.`);
  }
}

// ---------- events ----------
client.once('ready', async () => {
  console.log(`[ready] ${client.user.tag} in ${client.guilds.cache.size} guild(s)`);
  try { await deployCommands(); } catch (e) { console.error('[deploy] failed:', e.message); }
  startBridge(client, { port: PORT, apiKey: API_KEY });
  setInterval(() => {
    const db = getDb();
    let changed = false;
    for (const [jobId, s] of Object.entries(db.servers || {})) {
      if (Date.now() - (s.at || 0) > 5 * 60 * 1000) { delete db.servers[jobId]; changed = true; }
    }
    if (changed) save();
  }, 5 * 60 * 1000).unref?.();
});

client.on('guildMemberAdd', async (member) => {
  try {
    const db = getDb();
    const chId = db.settings.welcomeChannel || process.env.WELCOME_CHANNEL_ID;
    if (!chId) return;
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch?.isTextBased()) return;
    const { welcomeEmbed } = require('./src/embeds');
    await ch.send({ embeds: [welcomeEmbed(member)] }).catch(() => {});
  } catch (e) { console.error('[welcome]', e.message); }
});

client.on('guildMemberRemove', async (member) => {
  try {
    const db = getDb();
    const chId = db.settings.leaveChannel || process.env.LEAVE_CHANNEL_ID;
    if (!chId) return;
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch?.isTextBased()) return;
    const { leaveEmbed } = require('./src/embeds');
    await ch.send({ embeds: [leaveEmbed(member)] }).catch(() => {});
  } catch (e) { console.error('[leave]', e.message); }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  // 0) raid protection (links + 3+ spam) — staff bypass, runs on every message
  try {
    if (await checkRaid(message)) return;
  } catch (e) { console.error('[raid]', e.message); }
  // 1) bot mention -> natural-language controls (channel/category/role/lock/ban/kick/timeout) OR hello
  if (message.mentions.has(client.user)) {
    const handled = await handleNatural(message).catch((e) => { console.error('[natural]', e.message); return false; });
    if (handled) return;
    await message.reply('Hello! How May I Assist You? 🌸\nTry `/help` for commands or `/see-rcommands` for Roblox commands.').catch(() => {});
    return;
  }
  // 2) custom text prefixes (staff game commands)
  await handleCustomPrefix(message).catch((e) => console.error('[prefix]', e.message));
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const cmd = commands.get(interaction.commandName);
      if (cmd?.autocomplete) return cmd.autocomplete(interaction);
      // route give-skin / give-all-skin focused option manually
      if (interaction.commandName === 'give-skin' || interaction.commandName === 'give-all-skin') {
        const focused = interaction.options.getFocused(true);
        const { fuzzy } = require('./src/roblox');
        const catalogs = require('./catalogs');
        const { allItemNames } = require('./src/roblox');
        let names = focused.name === 'weapontype' ? (catalogs.skinTypes || []) : allItemNames('WeaponSkin');
        return interaction.respond(fuzzy(names, focused.value, 8).map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) }))).catch(() => {});
      }
      return interaction.respond([]).catch(() => {});
    }
    if (!interaction.isChatInputCommand()) return;
    const cmd = commands.get(interaction.commandName);
    if (!cmd) return interaction.reply({ content: `❌ Unknown command \`/${interaction.commandName}\`. Try \`/help\`.`, ephemeral: true });
    await cmd.execute(interaction, { client });
  } catch (e) {
    console.error(`[command/${interaction.commandName}]`, e);
    const msg = `❌ ${String(e.message || e).slice(0, 300)}`;
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
    else await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
});

process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));

client.login(TOKEN);
