/**
 * Server customization requested in redesign:
 * /set-welcome-message /set-leave-message /preview-welcome /preview-leave
 * /set-bot-theme /setcommand-prefix /see-rcommands + channel/role setup
 */
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { getDb, save } = require('../src/db');
const { embedBase, okEmbed, themeColorInt, themeColorHex, formatTemplate, welcomeEmbed, leaveEmbed, DIV } = require('../src/embeds');
const { isStaffHigherThanBot } = require('../src/bridge');

const ADMIN = '0';
const VARS = '`{user}` `{username}` `{mention}` `{server}` `{membercount}`';

async function needStaff(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (member && await isStaffHigherThanBot(member)) return member;
  await interaction.reply({ content: '❌ You need a role **higher than the bot** to use this.', ephemeral: true });
  return null;
}

function validHex(input) {
  return /^#?[0-9a-fA-F]{6}$/.test(String(input || '').trim());
}

const RCOMMANDS = [
  ['server-info', 'Discord server info + link stats'],
  ['link', 'Link Roblox account (username → !verify CODE)'],
  ['link-safety', 'How linking stays safe (no passwords)'],
  ['profile', 'Linked Roblox profile + game data'],
  ['verify-status', 'Check linked / verified status'],
  ['value', 'RAP + demand for any item'],
  ['item', 'Full item detail + owners + teleport'],
  ['owners', 'Who owns an item + join link'],
  ['online', 'Live game servers + players'],
  ['search-weapons', 'Search weapons'],
  ['search-skins', 'Search skins'],
  ['search-finishers', 'Search finishers'],
  ['admin-abuse', 'Server-wide admin event'],
  ['game-kick', 'Kick player in game'],
  ['game-ban', 'Ban player in game (+ Discord sync)'],
  ['game-unban', 'Unban player in game'],
  ['game-announce', 'Announce to all servers'],
  ['game-restart', 'Restart all servers'],
  ['game-luck', 'Boost server luck'],
  ['give-all-weapon', 'Weapon → EVERYONE online'],
  ['give-all-skin', 'Skin → EVERYONE online'],
  ['give-all-finisher', 'Finisher → EVERYONE online'],
  ['give-all-tokens', 'Tokens → EVERYONE online'],
  ['give-all-spins', 'Spins → EVERYONE online'],
];

const PREFIXABLE = ['game-kick', 'game-ban', 'game-unban', 'game-announce', 'game-restart', 'game-luck', 'admin-abuse', 'give-weapon', 'give-skin', 'give-finisher', 'give-all-weapon', 'give-all-skin', 'give-all-finisher', 'give-all-tokens', 'give-all-spins', 'game-money', 'give-tokens', 'give-spins', 'player-data'];

module.exports = [
  {
    data: new SlashCommandBuilder().setName('set-welcome-message').setDescription('[STAFF] Set custom welcome message')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('message').setDescription(`Use ${VARS}`).setRequired(true).setMaxLength(1000)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const msg = interaction.options.getString('message', true);
      const db = getDb();
      db.settings.welcomeMessage = msg;
      save();
      return interaction.reply({ embeds: [okEmbed('Welcome message saved', `> ${msg.slice(0, 900)}\n${DIV}\nVariables: ${VARS}\nPreview with \`/preview-welcome\`.`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('set-leave-message').setDescription('[STAFF] Set custom leave message')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('message').setDescription(`Use ${VARS}`).setRequired(true).setMaxLength(1000)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const msg = interaction.options.getString('message', true);
      getDb().settings.leaveMessage = msg;
      save();
      return interaction.reply({ embeds: [okEmbed('Leave message saved', `> ${msg.slice(0, 900)}\n${DIV}\nVariables: ${VARS}\nPreview with \`/preview-leave\`.`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('preview-welcome').setDescription('[STAFF] Preview the welcome message as the bot would send it')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addUserOption((o) => o.setName('user').setDescription('Preview as this user (default: you)')),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const user = interaction.options.getUser('user') || interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null) || interaction.member;
      return interaction.reply({ content: '👀 **Welcome preview** (only you see the header — the embed below is exactly what members get):', embeds: [welcomeEmbed(member)], ephemeral: true });
    },
  },
  {
    data: new SlashCommandBuilder().setName('preview-leave').setDescription('[STAFF] Preview the leave message as the bot would send it')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addUserOption((o) => o.setName('user').setDescription('Preview as this user (default: you)')),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const user = interaction.options.getUser('user') || interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null) || interaction.member;
      return interaction.reply({ content: '👀 **Leave preview**:', embeds: [leaveEmbed(member)], ephemeral: true });
    },
  },
  {
    data: new SlashCommandBuilder().setName('set-bot-theme').setDescription('[STAFF] Set the bot embed theme color')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('hex-color').setDescription('Hex color, e.g. #FF5DA2').setRequired(true)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const raw = interaction.options.getString('hex-color', true).trim();
      if (!validHex(raw)) return interaction.reply({ content: '❌ Invalid color. Use a 6-digit hex like `#FF5DA2`.', ephemeral: true });
      const hex = raw.startsWith('#') ? raw.toUpperCase() : ('#' + raw).toUpperCase();
      getDb().settings.themeColor = hex;
      save();
      const int = parseInt(hex.slice(1), 16);
      return interaction.reply({ embeds: [embedBase('🎨 Theme updated', `All embeds now use **${hex}**.`, int)] });
    },
  },
  {
    // Exact name requested: /setcommand-prefix [command] [prefix]
    data: new SlashCommandBuilder().setName('setcommand-prefix').setDescription('[STAFF] Set a text prefix for a Roblox command (e.g. !game-ban)')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('command').setDescription('Which Roblox command').setRequired(true)
        .addChoices(...PREFIXABLE.map((c) => ({ name: c, value: c }))))
      .addStringOption((o) => o.setName('prefix').setDescription('1-3 char prefix, e.g. ! or ? (empty "none" clears)').setRequired(true).setMaxLength(3)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const cmd = interaction.options.getString('command', true);
      let prefix = interaction.options.getString('prefix', true).trim();
      const db = getDb();
      if (prefix.toLowerCase() === 'none' || prefix === '') {
        delete db.settings.commandPrefixes[cmd];
        save();
        return interaction.reply({ embeds: [okEmbed('Prefix cleared', `\`/${cmd}\` no longer has a text trigger.`)] });
      }
      if (!/^[!?,.$#%&+~^;:=@-]{1,3}$/.test(prefix)) {
        return interaction.reply({ content: '❌ Prefix must be 1-3 symbols like `!`, `?`, `,`, `!!`. Use `none` to clear.', ephemeral: true });
      }
      db.settings.commandPrefixes[cmd] = prefix;
      save();
      return interaction.reply({ embeds: [okEmbed('Prefix saved', `Type \`${prefix}${cmd} <args>\` in chat to run \`/${cmd}\`.\nExample: \`${prefix}${cmd} SomeUser reason\``)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('see-rcommands').setDescription('Show all Roblox game commands'),
    async execute(interaction) {
      const db = getDb();
      const prefixes = db.settings.commandPrefixes || {};
      const lines = RCOMMANDS.map(([n, d]) => {
        const p = prefixes[n] ? ` • text: \`${prefixes[n]}${n}\`` : '';
        return `• \`/${n}\` — ${d}${p}`;
      });
      return interaction.reply({ embeds: [embedBase('🎮 Roblox commands', lines.join('\n').slice(0, 3900) + `\n${DIV}\nTheme: **${themeColorHex()}** • Prefixes via \`/setcommand-prefix\``, themeColorInt())] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('setup-welcome').setDescription('[STAFF] Set welcome channel')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addChannelOption((o) => o.setName('channel').setDescription('Welcome channel').setRequired(true).addChannelTypes(ChannelType.GuildText)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const ch = interaction.options.getChannel('channel', true);
      getDb().settings.welcomeChannel = ch.id;
      save();
      return interaction.reply({ embeds: [okEmbed('Welcome channel linked', `<#${ch.id}> will receive join messages.\nCustomize text with \`/set-welcome-message\`, test with \`/preview-welcome\`.`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('setup-leave').setDescription('[STAFF] Set leave channel')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addChannelOption((o) => o.setName('channel').setDescription('Leave channel').setRequired(true).addChannelTypes(ChannelType.GuildText)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const ch = interaction.options.getChannel('channel', true);
      getDb().settings.leaveChannel = ch.id;
      save();
      return interaction.reply({ embeds: [okEmbed('Leave channel linked', `<#${ch.id}> will receive leave messages.\nCustomize text with \`/set-leave-message\`, test with \`/preview-leave\`.`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('setup-reports').setDescription('[STAFF] Set in-game reports channel')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addChannelOption((o) => o.setName('channel').setDescription('Reports channel').setRequired(true).addChannelTypes(ChannelType.GuildText)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const ch = interaction.options.getChannel('channel', true);
      getDb().settings.reportsChannel = ch.id;
      save();
      return interaction.reply({ embeds: [okEmbed('Reports channel linked', `<#${ch.id}> will receive in-game reports.`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('setup-verified').setDescription('[STAFF] Set role given when linked/verified')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addRoleOption((o) => o.setName('role').setDescription('Verified role').setRequired(true)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const role = interaction.options.getRole('role', true);
      getDb().settings.verifiedRoleId = role.id;
      save();
      return interaction.reply({ embeds: [okEmbed('Verified role set', `<@&${role.id}> will be granted on link verify.`)] });
    },
  },
];
