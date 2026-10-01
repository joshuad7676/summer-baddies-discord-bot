const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');

// NOTE: option-order is fixed directly in index.js (required options first:
// selfroles 'setup' before 'channel', add-emoji 'emoji' before username/userid).
// The old regex reorder block lived here and corrupted the selfroles line on
// every boot — it is intentionally removed. Do NOT re-add runtime patching
// of the selfroles command block.

// Add a friendly security explainer command.
if (!source.includes("setName('link-safety')")) {
  const anchor = "  new SlashCommandBuilder().setName('link').setDescription('Link your Roblox account (type your Roblox username)')";
  const command = "  new SlashCommandBuilder().setName('link-safety').setDescription('Learn how safe Roblox linking works'),\n";
  if (source.includes(anchor)) source = source.replace(anchor, command + anchor);
}

// Replace the /link entry point with a reassuring, password-free version.
const oldLink = "    if (cmd === 'link') {";
if (!source.includes("SAFE_LINK_FLOW_INSTALLED") && source.includes(oldLink)) {
  const safeLink = "    // SAFE_LINK_FLOW_INSTALLED\n" +
    "    if (cmd === 'link') {\n" +
    "      const username = interaction.options.getString('username', true).replace('@', '').trim();\n" +
    "      await interaction.deferReply({ ephemeral: true });\n" +
    "      const r = await robloxUserId(username);\n" +
    "      if (!r) return interaction.editReply('❌ I could not find that Roblox username. No account information was changed.');\n" +
    "      if (db.robloxToDiscord[r.id] && db.robloxToDiscord[r.id] !== interaction.user.id)\n" +
    "        return interaction.editReply('❌ That Roblox account is already linked. Nothing was changed—please contact staff if this is your account.');\n" +
    "      for (const [code, rec] of Object.entries(db.linkCodes)) if (rec.discordId === interaction.user.id) delete db.linkCodes[code];\n" +
    "      const code = String(Math.floor(100000 + Math.random() * 900000));\n" +
    "      db.linkCodes[code] = { discordId: interaction.user.id, robloxUsername: r.name, robloxId: r.id, expires: Date.now() + 10 * 60 * 1000 };\n" +
    "      save();\n" +
    "      const e = embedBase('🌸 Safe account link',\n" +
    "        'You are linking **Discord** to **Roblox**—not giving anyone access to your account.\\n\\n' +\n" +
    "        '🔒 **We will never ask for your Roblox password, cookie, email, or two-step code.**\\n' +\n" +
    "        '✅ Username found: **' + r.name + '**\\n\\n' +\n" +
    "        '### Finish in Roblox\\n' +\n" +
    "        'Join the Summer Baddies Roblox game and type this in chat:\\n\\n' +\n" +
    "        '`!verify ' + code + '`\\n\\n' +\n" +
    "        'This one-time code expires in **10 minutes**. Never share it with anyone. If you did not request this, ignore it—nothing happens.', 0xff8fc7)\n" +
    "        .setFooter({ text: 'Password-free • one-time code • expires in 10 minutes' });\n" +
    "      const thumb = await robloxThumb(r.id);\n" +
    "      if (thumb) e.setThumbnail(thumb);\n" +
    "      return interaction.editReply({ embeds: [e] });\n" +
    "    }\n";
  source = source.replace(oldLink, safeLink + oldLink);
}

// Handle /link-safety before the normal public command handlers.
if (!source.includes("LINK_SAFETY_HANDLER_INSTALLED")) {
  const anchor = "    // ----- PUBLIC -----";
  const handler = "    // LINK_SAFETY_HANDLER_INSTALLED\n" +
    "    if (cmd === 'link-safety') {\n" +
    "      return interaction.reply({ embeds: [embedBase('🛡️ Your Roblox link is safe',\n" +
    "        '**What we use:** your Roblox username and a temporary six-digit code.\\n\\n' +\n    "        '**What we never use:** your password, email, browser cookie, backup codes, or 2FA code.\\n\\n' +\n    "        '**How it works:** /link finds your public username, then you type a one-time `!verify CODE` message inside the Roblox game. The code expires after 10 minutes and is deleted after use.\\n\\n' +\n    "        'If anyone asks for your password or cookie, do not send it—staff and this bot will never need it.', 0x57d9a3)] });\n" +
    "    }\n";
  if (source.includes(anchor)) source = source.replace(anchor, handler + anchor);
}

// Phase 1: custom command prefixes + RCommands private list
if (!source.includes("setName('setcommand-prefix')")) {
  const anchor = "  new SlashCommandBuilder().setName('help').setDescription('Show all bot commands'),";
  const insert = "  new SlashCommandBuilder().setName('setcommand-prefix').setDescription('[STAFF] Assign a custom prefix for a command').setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)\n" +
    "    .addStringOption(o => o.setName('command').setDescription('Command name without /').setRequired(true))\n" +
    "    .addStringOption(o => o.setName('prefix').setDescription('New prefix, e.g. ,s or !aa').setRequired(true)),\n" +
    "  new SlashCommandBuilder().setName('see-rcommands').setDescription('View all Roblox commands, examples and prefixes'),\n";
  if (source.includes(anchor)) source = source.replace(anchor, insert + anchor);
}

if (!source.includes("if (cmd === 'setcommand-prefix')")) {
  const anchor = "    if (cmd === 'help') {";
  const insert = "    if (cmd === 'setcommand-prefix') {\n" +
    "      const staff = await requireStaff(interaction);\n" +
    "      if (!staff) return;\n" +
    "      const commandName = interaction.options.getString('command', true).replace(/^\\//, '').trim().toLowerCase();\n" +
    "      const customPrefix = interaction.options.getString('prefix', true).trim();\n" +
    "      if (!customPrefix || customPrefix.length > 3) return interaction.reply({ content: '❌ Prefix should be 1–3 characters like `,`, `!`, `.`, `?`, or `,s`.', ephemeral: true });\n" +
    "      db.settings.commandPrefixes = db.settings.commandPrefixes || {};\n" +
    "      db.settings.commandPrefixes[commandName] = customPrefix;\n" +
    "      save();\n" +
    "      return interaction.reply({ content: '✅ Prefix updated: `/' + commandName + '` can now be used with `' + customPrefix + '`. Example: `' + customPrefix + commandName + '`', ephemeral: true });\n" +
    "    }\n" +
    "    if (cmd === 'see-rcommands') {\n" +
    "      const list = [\n" +
    "        'server-info', 'link', 'link-safety', 'profile', 'verify-status', 'value', 'item', 'owners', 'online', 'search-weapons', 'search-skins', 'search-finishers', 'admin-abuse', 'game-kick', 'game-ban', 'game-unban', 'game-announce', 'game-restart', 'game-luck', 'give-all-weapon', 'give-all-skin', 'give-all-finisher', 'give-all-tokens', 'give-all-spins'\n" +
    "      ];\n" +
    "      const lines = list.map(name => {\n" +
    "        const pref = (db.settings.commandPrefixes && db.settings.commandPrefixes[name]) || ',';\n" +
    "        return `**/${name}** — try \`${pref + name}\`, \`!${name}\`, \`.${name}\` or \`?${name}\``;\n" +
    "      });\n" +
    "      const embed = embedBase('🔧 Roblox command list', lines.join('\\n').slice(0, 3000))\n" +
    "        .setFooter({ text: 'Use /setcommand-prefix to set custom aliases' });\n" +
    "      return interaction.reply({ embeds: [embed], ephemeral: true });\n" +
    "    }\n";
  if (source.includes(anchor)) source = source.replace(anchor, insert + anchor);
}

// Mention replies + simple natural-language role creation
if (!source.includes("BOT_MENTION_HANDLER_INSTALLED")) {
  const anchor = "    if (!msg.guild || msg.author.bot) return;\n";
  const insert = "    // BOT_MENTION_HANDLER_INSTALLED\n" +
    "    if (msg.mentions.has(client.user)) {\n" +
    "      const text = msg.content.replace(/<@!?(\\d+)>/g, '').trim();\n" +
    "      const lower = (text || '').toLowerCase();\n" +
    "      if (/make.*role|create.*role|new.*role/i.test(lower)) {\n" +
    "        const match = text.match(/role\\s+(?:called|named)?\\s*['\"]?([a-z0-9 _-]+)['\"]?/i);\n" +
    "        const name = (match && match[1]) ? match[1].trim() : 'Hello';\n" +
    "        const pink = /pink|rose|magenta|hot pink/.test(lower);\n" +
    "        try {\n" +
    "          const role = await msg.guild.roles.create({ name, color: pink ? '#ff5da2' : '#5865F2', hoist: true, mentionable: true, reason: 'Bot mention role request' });\n" +
    "          return msg.reply({ content: `✅ I created the role **${role.name}** for you.`, allowedMentions: { repliedUser: false } });\n" +
    "        } catch {\n" +
    "          return msg.reply({ content: '❌ I could not create that role. Check my permissions and role hierarchy.', allowedMentions: { repliedUser: false } });\n" +
    "        }\n" +
    "      }\n" +
    "      return msg.reply({ content: 'Hello! How May I Assist You?', allowedMentions: { repliedUser: false } });\n" +
    "    }\n";
  if (source.includes(anchor)) source = source.replace(anchor, insert + anchor);
}

// Phase 2: editable welcome/leave messages and better custom bot style
if (!source.includes("PHASE2_WELCOME_CUSTOM")) {
  const oldWelcome = "function welcomeEmbed(member) {\n  const e = baddieEmbed('🌸 Welcome, ' + member.user.username + '!',\n    `Hey baddie, welcome to **${member.guild.name}**! 💅\\n${THEME.DIV}\\n` +\n    `🔗 Link Roblox: \\`/link <RobloxUsername>\\` → type \\`!verify CODE\\` in Summer Baddies\\n` +\n    `✅ Then \\`/verify-status\\` to grab the Verified role\\n` +\n    `📜 Read \\`/rules\\` • 💰 Try \\`/coins daily\\` • 🎮 Check \\`/value\\`\\n` +\n    `${THEME.DIV}\\nHave fun cutie! 🌸`)\n    .setThumbnail(member.user.displayAvatarURL({ size: 256 }));\n  e.data.footer = { text: `🌸 Summer Baddies • Member #${member.guild.memberCount}` };\n  return e;\n}\n";
  const newWelcome = "function formatCustomMessage(template, member) {\n  const fallback = 'Welcome **{user}** to **{server}**! 💅\\n\\nUse **/link** to connect Roblox and jump in with the crew!\\nMember count: **{membercount}**';\n  const text = String(template || fallback)\n    .replace(/\\{user\\}/gi, member.user.username)\n    .replace(/\\{server\\}/gi, member.guild.name)\n    .replace(/\\{membercount\\}/gi, String(member.guild.memberCount))\n    .replace(/\\{mention\\}/gi, `<@${member.user.id}>`);\n  return text;\n}\n\nfunction welcomeEmbed(member) {\n  const msg = formatCustomMessage(db.settings.welcomeMessage || 'Welcome **{user}** to **{server}**! 💅\\n\\nUse **/link** to connect Roblox and jump in with the crew!\\nMember count: **{membercount}**', member);\n  const e = baddieEmbed('🌸 Welcome, ' + member.user.username + '!', msg)\n    .setThumbnail(member.user.displayAvatarURL({ size: 256 }));\n  e.data.footer = { text: `🌸 Summer Baddies • Member #${member.guild.memberCount}` };\n  return e;\n}\n";
  if (source.includes(oldWelcome)) source = source.replace(oldWelcome, newWelcome);
}

if (!source.includes("PHASE2_LEAVE_CUSTOM")) {
  const oldLeave = "async function sendLeave(member) {\n  const chId = db.settings.leaveChannel || process.env.LEAVE_CHANNEL_ID;\n  const { ch, err } = await resolveSendChannel(chId);\n  if (!ch) { console.warn('[leave] skip:', err); return { ok: false, err }; }\n  try {\n    await ch.send({ embeds: [embedBase('👋 ' + (member.user?.username || 'Someone') + ' left', `We'll miss you baddie! 💔\\n**${member.guild.name}** now has **${member.guild.memberCount}** members. Thanks for being here!`, 0x808080)] });\n    return { ok: true };\n  } catch (e) { console.error('[leave] send failed:', e.message); return { ok: false, err: e.message }; }\n}\n";
  const newLeave = "function leaveMessageTemplate(member) {\n  const fallback = '{user} left **{server}**. 💔\\nWe will miss them — thanks for being a part of the crew.';\n  return String(db.settings.leaveMessage || fallback)\n    .replace(/\\{user\\}/gi, member.user?.username || 'Someone')\n    .replace(/\\{server\\}/gi, member.guild.name)\n    .replace(/\\{membercount\\}/gi, String(member.guild.memberCount))\n    .replace(/\\{mention\\}/gi, `<@${member.user.id}>`);\n}\n\nasync function sendLeave(member) {\n  const chId = db.settings.leaveChannel || process.env.LEAVE_CHANNEL_ID;\n  const { ch, err } = await resolveSendChannel(chId);\n  if (!ch) { console.warn('[leave] skip:', err); return { ok: false, err }; }\n  try {\n    await ch.send({ embeds: [embedBase('👋 ' + (member.user?.username || 'Someone') + ' left', leaveMessageTemplate(member), 0x808080)] });\n    return { ok: true };\n  } catch (e) { console.error('[leave] send failed:', e.message); return { ok: false, err: e.message }; }\n}\n";
  if (source.includes(oldLeave)) source = source.replace(oldLeave, newLeave);
}

if (!source.includes("set-welcome-message")) {
  const anchor = "    new SlashCommandBuilder().setName('test-welcome').setDescription('[STAFF] Send a test welcome here (debug welcome)')";
  const insert = "    new SlashCommandBuilder().setName('set-welcome-message').setDescription('[STAFF] Set the welcome message for new members').setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)\n" +
    "      .addStringOption(o => o.setName('message').setDescription('Use {user}, {server}, {membercount}, {mention}').setRequired(true)),\n" +
    "    new SlashCommandBuilder().setName('set-leave-message').setDescription('[STAFF] Set the leave message for departed members').setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)\n" +
    "      .addStringOption(o => o.setName('message').setDescription('Use {user}, {server}, {membercount}, {mention}').setRequired(true)),\n" +
    "    new SlashCommandBuilder().setName('preview-welcome').setDescription('[STAFF] Preview the welcome message').setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)\n" +
    "      .addUserOption(o => o.setName('user').setDescription('User (default: you)')),\n" +
    "    new SlashCommandBuilder().setName('preview-leave').setDescription('[STAFF] Preview the leave message').setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)\n" +
    "      .addUserOption(o => o.setName('user').setDescription('User (default: you)')),\n";
  if (source.includes(anchor)) source = source.replace(anchor, insert + anchor);
}

if (!source.includes("if (cmd === 'set-welcome-message')")) {
  const anchor = "    if (cmd === 'test-welcome') {";
  const insert = "    if (cmd === 'set-welcome-message') {\n" +
    "      const staff = await requireStaff(interaction);\n" +
    "      if (!staff) return;\n" +
    "      db.settings.welcomeMessage = interaction.options.getString('message', true);\n" +
    "      save();\n" +
    "      return interaction.reply({ content: '✅ Welcome message updated. Use `{user}`, `{server}`, `{membercount}`, `{mention}` in the text.', ephemeral: true });\n" +
    "    }\n" +
    "    if (cmd === 'set-leave-message') {\n" +
    "      const staff = await requireStaff(interaction);\n" +
    "      if (!staff) return;\n" +
    "      db.settings.leaveMessage = interaction.options.getString('message', true);\n" +
    "      save();\n" +
    "      return interaction.reply({ content: '✅ Leave message updated. Use `{user}`, `{server}`, `{membercount}`, `{mention}` in the text.', ephemeral: true });\n" +
    "    }\n" +
    "    if (cmd === 'preview-welcome') {\n" +
    "      const user = interaction.options.getUser('user') || interaction.user;\n" +
    "      const member = interaction.guild.members.cache.get(user.id) || { user, guild: interaction.guild };\n" +
    "      return interaction.reply({ embeds: [welcomeEmbed(member)] });\n" +
    "    }\n" +
    "    if (cmd === 'preview-leave') {\n" +
    "      const user = interaction.options.getUser('user') || interaction.user;\n" +
    "      const member = interaction.guild.members.cache.get(user.id) || { user, guild: interaction.guild };\n" +
    "      return interaction.reply({ embeds: [embedBase('👋 ' + user.username + ' left', leaveMessageTemplate(member), 0x808080)] });\n" +
    "    }\n";
  if (source.includes(anchor)) source = source.replace(anchor, insert + anchor);
}

fs.writeFileSync(indexPath, source);
require('./index.js');
