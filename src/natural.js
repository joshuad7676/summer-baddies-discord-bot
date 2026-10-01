/**
 * Natural-language chat controls (triggered by @mentioning the bot).
 * Examples:
 *  @bot make a channel called clips
 *  @bot make a voice channel called Lounge
 *  @bot make a channel called media in category MEDIA
 *  @bot make a category called Events
 *  @bot make a role called Hello and make it pink
 *  @bot ban @user spamming
 *  @bot kick @user being rude
 *  @bot timeout @user 10m spamming
 */
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { embedBase } = require('./embeds');
const { isStaffHigherThanBot } = require('./bridge');
const { sendModLog } = require('./modlog');
const { getDb, save } = require('./db');
const { queueCommand } = require('./roblox');

const COLOR_WORDS = {
  pink: '#FF5DA2', hotpink: '#FF3D7F', red: '#ED4245', orange: '#F97316', yellow: '#FEE75C',
  gold: '#FFD700', green: '#57F287', mint: '#57F287', teal: '#00C2A8', blue: '#5AAAFf',
  purple: '#C85AFF', violet: '#8B5CF6', white: '#FFFFFF', black: '#000000',
  gray: '#808080', grey: '#808080', blurple: '#5865F2',
};

function parseColorWord(input) {
  if (!input) return null;
  const s = String(input).trim();
  const hex = s.match(/^#?([0-9a-fA-F]{6})$/);
  if (hex) return '#' + hex[1].toUpperCase();
  const key = s.toLowerCase().replace(/[\s_-]/g, '');
  return COLOR_WORDS[key] || null;
}

function stripMention(text) {
  return String(text || '').replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeChannelName(n) {
  const s = String(n || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  return s.slice(0, 100) || 'channel';
}

// ---------- parsers (pure, testable) ----------
function parseRoleRequest(text) {
  const t = String(text || '');
  if (!/(make|create).{0,20}role/i.test(t)) return null;
  const m = t.match(/role\s+(?:called|named)\s+["']?([^"'.,!?]+?)["']?\s*(?:and make it\s+([a-zA-Z#0-9\s_-]+))?\s*$/i)
    || t.match(/role\s+["']([^"']+)["']\s*(?:.*?(pink|red|blue|green|purple|orange|yellow|gold|mint|teal|white|black|gr[ae]y|blurple|#[0-9a-fA-F]{6}))?/i);
  if (!m) return null;
  const name = (m[1] || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  const colorWord = (m[2] || '').trim();
  if (!name) return null;
  return { name, colorHex: parseColorWord(colorWord) || '#FF5DA2', colorWord: colorWord || 'pink (default)' };
}

function parseChannelRequest(text) {
  const t = String(text || '');
  if (!/(make|create|add).{0,30}channel/i.test(t)) return null;
  const m = t.match(/(voice|text)?\s*channel\s+(?:called|named)\s+["']?([^"'.,!?]+?)["']?(?:\s+as\s+(text|voice))?(?:\s+in\s+(?:category\s+)?["']?([^"'.,!?]+?)["']?)?\s*$/i);
  if (!m) return null;
  const hinted = (m[1] || m[3] || '').toLowerCase();
  const name = (m[2] || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  const category = (m[4] || '').trim().slice(0, 100);
  if (!name) return null;
  // guard: "channel called X" where X is actually "role/category" keyword confusion
  if (/^(role|category)$/i.test(name)) return null;
  return { name, kind: hinted === 'voice' ? 'voice' : 'text', category: category || null };
}

function parseCategoryRequest(text) {
  const t = String(text || '');
  if (!/(make|create|add).{0,30}categor/i.test(t)) return null;
  const m = t.match(/categor\w*\s+(?:called|named)\s+["']?([^"'.,!?]+?)["']?\s*$/i);
  if (!m) return null;
  const name = (m[1] || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  if (!name) return null;
  return { name };
}

function parseLockRequest(text) {
  const t = String(text || '');
  const m = t.match(/\b(lock|unlock|lockdown)\b(?:.*\bchannel\b)?/i);
  if (!m) return null;
  // avoid clashing with "unlock timeout/unmute" etc.
  if (/\b(timeout|unmute|untimeout)\b/i.test(t)) return null;
  const action = /unlock/i.test(m[1]) ? 'unlock' : 'lock';
  return { action };
}

function parseModRequest(text) {  const t = stripMention(text);
  let m = t.match(/\b(ban|kick|timeout|mute|unmute|untimeout)\b\s*(.*)$/i);
  if (!m) return null;
  const action = m[1].toLowerCase();
  let rest = (m[2] || '').trim();
  // timeout duration: "10m", "1h", "30s", "2d"
  let durationMin = 10;
  if (action === 'timeout' || action === 'mute') {
    const d = rest.match(/^(\d+)\s*([smhd])\b/i);
    if (d) {
      const n = parseInt(d[1], 10);
      const mult = { s: 1 / 60, m: 1, h: 60, d: 1440 }[d[2].toLowerCase()];
      durationMin = Math.min(Math.max(Math.round(n * mult), 1), 40320);
      rest = rest.slice(d[0].length).trim();
    }
  }
  // reason = remaining text (strip leading username-ish token if no mention was used)
  return { action, reason: rest.slice(0, 450) || 'No reason given', durationMin };
}

function resolveMentionTarget(message) {
  const mentioned = message.mentions.members?.first?.() || message.mentions.users?.first?.();
  if (mentioned) {
    const member = message.mentions.members?.first?.() || null;
    return { member, user: mentioned.user || mentioned, via: 'mention' };
  }
  return null;
}

// ---------- handlers ----------
async function handleRoleNL(message) {
  const parsed = parseRoleRequest(message.content);
  if (!parsed) return false;
  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    await message.reply('❌ You need **Manage Roles** to create roles.').catch(() => {});
    return true;
  }
  const me = await message.guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await message.reply('❌ I need **Manage Roles**.').catch(() => {});
    return true;
  }
  try {
    const role = await message.guild.roles.create({
      name: parsed.name, color: parsed.colorHex, mentionable: false,
      reason: `NL request by ${message.author.tag}`,
    });
    await message.reply({ embeds: [embedBase('🎭 Role created', `Created <@&${role.id}> (**${role.name}**) • **${parsed.colorHex}** (${parsed.colorWord}).`, parseInt(parsed.colorHex.slice(1), 16))] }).catch(() => {});
  } catch (e) {
    await message.reply(`❌ Could not create role: ${String(e.message || e).slice(0, 200)}`).catch(() => {});
  }
  return true;
}

async function handleChannelNL(message) {
  const parsed = parseChannelRequest(message.content);
  if (!parsed) return false;
  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    await message.reply('❌ You need **Manage Channels** to create channels.').catch(() => {});
    return true;
  }
  const me = await message.guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await message.reply('❌ I need **Manage Channels**.').catch(() => {});
    return true;
  }
  try {
    let parent = null;
    if (parsed.category) {
      parent = message.guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === parsed.category.toLowerCase()) || null;
      if (!parent) {
        parent = await message.guild.channels.create({ name: parsed.category.slice(0, 100), type: ChannelType.GuildCategory, reason: `NL request by ${message.author.tag}` });
      }
    }
    const isVoice = parsed.kind === 'voice';
    const ch = await message.guild.channels.create({
      name: isVoice ? parsed.name.slice(0, 100) : sanitizeChannelName(parsed.name),
      type: isVoice ? ChannelType.GuildVoice : ChannelType.GuildText,
      parent: parent?.id || null,
      reason: `NL request by ${message.author.tag}`,
    });
    await message.reply({ embeds: [embedBase(isVoice ? '🔊 Voice channel created' : '📝 Channel created', `Created ${isVoice ? '' : '<#'}${ch.id}${isVoice ? '' : '>'}` + ` (**${ch.name}**)` + (parent ? ` in **${parent.name}**` : ''), 0x57f287)] }).catch(() => {});
  } catch (e) {
    await message.reply(`❌ Could not create channel: ${String(e.message || e).slice(0, 200)}`).catch(() => {});
  }
  return true;
}

async function handleCategoryNL(message) {
  const parsed = parseCategoryRequest(message.content);
  if (!parsed) return false;
  // avoid double-handling "make a channel ... in category X" (channel handler owns those)
  if (/channel/i.test(message.content)) return false;
  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    await message.reply('❌ You need **Manage Channels** to create categories.').catch(() => {});
    return true;
  }
  const me = await message.guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await message.reply('❌ I need **Manage Channels**.').catch(() => {});
    return true;
  }
  try {
    const cat = await message.guild.channels.create({ name: parsed.name.slice(0, 100), type: ChannelType.GuildCategory, reason: `NL request by ${message.author.tag}` });
    await message.reply({ embeds: [embedBase('📁 Category created', `Created **${cat.name}**`, 0x57f287)] }).catch(() => {});
  } catch (e) {
    await message.reply(`❌ Could not create category: ${String(e.message || e).slice(0, 200)}`).catch(() => {});
  }
  return true;
}

async function handleLockNL(message) {
  const parsed = parseLockRequest(message.content);
  if (!parsed) return false;
  // only when they mean the channel ("lock channel", "lock this", "lockdown", "lock here")
  if (!/\b(channel|this|here|lockdown|chat)\b/i.test(String(message.content))) return false;
  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    await message.reply('❌ You need **Manage Channels** to lock channels.').catch(() => {});
    return true;
  }
  const me = await message.guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await message.reply('❌ I need **Manage Channels**.').catch(() => {});
    return true;
  }
  const target = message.mentions.channels?.first?.() || message.channel;
  try {
    const everyone = message.guild.roles.everyone;
    if (target.type === ChannelType.GuildVoice) {
      await target.permissionOverwrites.edit(everyone, { Connect: parsed.action === 'lock' ? false : null }).catch((e) => { throw e; });
    } else {
      await target.permissionOverwrites.edit(everyone, { SendMessages: parsed.action === 'lock' ? false : null }).catch((e) => { throw e; });
    }
    await message.reply({ embeds: [embedBase(parsed.action === 'lock' ? '🔒 Channel locked' : '🔓 Channel unlocked', `<#${target.id}> ${parsed.action === 'lock' ? 'is now read-only for @everyone.' : 'is open again.'}`, parsed.action === 'lock' ? 0xf97316 : 0x57f287)] }).catch(() => {});
    await sendModLog(message.guild, embedBase('Channel lock (chat)', `<#${target.id}> by ${message.author.tag} (${parsed.action}).`, parsed.action === 'lock' ? 0xf97316 : 0x57d9a3));
  } catch (e) {
    await message.reply(`❌ Could not ${parsed.action} channel: ${String(e.message || e).slice(0, 200)}`).catch(() => {});
  }
  return true;
}

async function handleModNL(message) {
  const parsed = parseModRequest(message.content);
  if (!parsed) return false;
  const target = resolveMentionTarget(message);
  if (!target) {
    await message.reply('❌ Mention someone: `@bot ' + parsed.action + ' @user reason`.').catch(() => {});
    return true;
  }
  const staff = await isStaffHigherThanBot(message.member).catch(() => false);
  if (!staff) {
    await message.reply('❌ You need a role **higher than the bot** to mod people.').catch(() => {});
    return true;
  }
  const { action, reason, durationMin } = parsed;
  const user = target.user;
  const member = target.member || await message.guild.members.fetch(user.id).catch(() => null);
  const me = await message.guild.members.fetchMe().catch(() => null);

  try {
    if (action === 'ban') {
      if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) return void await message.reply('❌ You need **Ban Members**.').catch(() => {});
      if (!me?.permissions.has(PermissionFlagsBits.BanMembers)) return void await message.reply('❌ I need **Ban Members**.').catch(() => {});
      if (member && !member.bannable) return void await message.reply('❌ I cannot ban them (role hierarchy).').catch(() => {});
      await message.guild.members.ban(user.id, { reason: `${reason} (by ${message.author.tag})`.slice(0, 450) }).catch((e) => { throw e; });
      const link = getDb().links[user.id];
      if (link) {
        queueCommand({ type: 'ban', robloxUsername: link.robloxUsername, robloxId: link.robloxId, reason, by: message.author.tag });
        getDb().bans[String(link.robloxId)] = { reason, by: message.author.tag, at: Date.now() }; save();
      }
      await message.reply({ embeds: [embedBase('🔨 Banned', `${user.tag}\n${reason}${getDb().links[user.id] ? '\n+ game ban queued (linked).' : ''}`, 0xed4245)] }).catch(() => {});
      await sendModLog(message.guild, embedBase('Banned (chat)', `${user.tag} (<@${user.id}>) by ${message.author.tag}\n${reason}`, 0xed4245));
      return true;
    }
    if (action === 'kick') {
      if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) return void await message.reply('❌ You need **Kick Members**.').catch(() => {});
      if (!me?.permissions.has(PermissionFlagsBits.KickMembers)) return void await message.reply('❌ I need **Kick Members**.').catch(() => {});
      if (!member) return void await message.reply('❌ Member not in server (try `/ban` instead).').catch(() => {});
      if (!member.kickable) return void await message.reply('❌ I cannot kick them (role hierarchy).').catch(() => {});
      await member.kick(`${reason} (by ${message.author.tag})`.slice(0, 450)).catch((e) => { throw e; });
      const link = getDb().links[user.id];
      if (link) queueCommand({ type: 'kick', robloxUsername: link.robloxUsername, robloxId: link.robloxId, reason, by: message.author.tag });
      await message.reply({ embeds: [embedBase('👢 Kicked', `${user.tag}\n${reason}`, 0xf97316)] }).catch(() => {});
      await sendModLog(message.guild, embedBase('Kicked (chat)', `${user.tag} (<@${user.id}>) by ${message.author.tag}\n${reason}`, 0xf97316));
      return true;
    }
    if (action === 'timeout' || action === 'mute') {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return void await message.reply('❌ You need **Timeout Members**.').catch(() => {});
      if (!me?.permissions.has(PermissionFlagsBits.ModerateMembers)) return void await message.reply('❌ I need **Timeout Members**.').catch(() => {});
      if (!member) return void await message.reply('❌ Member not in server.').catch(() => {});
      if (!member.moderatable) return void await message.reply('❌ I cannot timeout them (role hierarchy).').catch(() => {});
      await member.timeout(durationMin * 60000, `${reason} (by ${message.author.tag})`.slice(0, 450)).catch((e) => { throw e; });
      const link = getDb().links[user.id];
      if (link) queueCommand({ type: 'timeout_note', robloxUsername: link.robloxUsername, robloxId: link.robloxId, reason, minutes: durationMin, by: message.author.tag, broadcast: true });
      await message.reply({ embeds: [embedBase('⏱️ Timed out', `${user.tag} for **${durationMin}m**\n${reason}`, 0x5aaaff)] }).catch(() => {});
      await sendModLog(message.guild, embedBase('Timed out (chat)', `${user.tag} (<@${user.id}>) by ${message.author.tag} for **${durationMin}m**\n${reason}`, 0x5aaaff));
      return true;
    }
    if (action === 'unmute' || action === 'untimeout') {
      if (!member) return void await message.reply('❌ Member not in server.').catch(() => {});
      await member.timeout(null).catch((e) => { throw e; });
      await message.reply({ embeds: [embedBase('✅ Unmuted', `${user.tag}`, 0x57f287)] }).catch(() => {});
      return true;
    }
  } catch (e) {
    await message.reply(`❌ Mod failed: ${String(e.message || e).slice(0, 200)}`).catch(() => {});
  }
  return true;
}

/** Try all NL handlers in order. Returns true if any claimed the message. */
async function handleNatural(message) {
  if (await handleModNL(message)) return true;
  if (await handleLockNL(message)) return true;
  if (await handleChannelNL(message)) return true;
  if (await handleCategoryNL(message)) return true;
  if (await handleRoleNL(message)) return true;
  return false;
}

module.exports = {
  COLOR_WORDS, parseColorWord, parseRoleRequest, parseChannelRequest, parseCategoryRequest, parseModRequest, parseLockRequest,
  handleNatural, handleRoleNL, handleChannelNL, handleCategoryNL, handleModNL, handleLockNL,
};
