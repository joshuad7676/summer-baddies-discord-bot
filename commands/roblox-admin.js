/** Staff game moderation: kick/ban/unban/announce/restart/luck/abuse. All queue bridge commands. */
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embedBase, themeColorInt } = require('../src/embeds');
const { queueCommand, resolveRobloxTarget } = require('../src/roblox');
const { isStaffHigherThanBot } = require('../src/bridge');
const { getDb, save } = require('../src/db');

const ADMIN = '0';

async function needStaff(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (member && await isStaffHigherThanBot(member)) return member;
  await interaction.reply({ content: '❌ You need a role **higher than the bot** to use this.', ephemeral: true });
  return null;
}

async function needTarget(interaction, optName = 'username') {
  const token = interaction.options.getString(optName, true);
  const t = await resolveRobloxTarget(token);
  if (!t) {
    await interaction.reply({ content: `❌ Roblox user \`${token}\` not found.`, ephemeral: true });
    return null;
  }
  return t;
}

function queuedEmbed(type, target, extra = '') {
  return embedBase('✅ Queued for game', `\`${type}\` → **${target}**${extra}\n_Game picks it up in ~5s via /roblox/commands._`, 0x57d9a3);
}

module.exports = [
  {
    data: new SlashCommandBuilder().setName('game-kick').setDescription('[STAFF] Kick player in game')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason')),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const t = await needTarget(interaction); if (!t) return;
      const reason = interaction.options.getString('reason') || 'Kicked by staff';
      queueCommand({ type: 'kick', robloxUsername: t.rUsername, robloxId: t.rId, reason, by: interaction.user.tag });
      return interaction.reply({ embeds: [queuedEmbed('kick', t.rUsername, `\nReason: ${reason}`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('game-ban').setDescription('[STAFF] Ban player in game (+ Discord if linked)')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason'))
      .addBooleanOption((o) => o.setName('syncdiscord').setDescription('Also ban linked Discord user? (default true)')),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const t = await needTarget(interaction); if (!t) return;
      const reason = interaction.options.getString('reason') || 'Banned by staff';
      const sync = interaction.options.getBoolean('syncdiscord') ?? true;
      queueCommand({ type: 'ban', robloxUsername: t.rUsername, robloxId: t.rId, reason, by: interaction.user.tag });
      const db = getDb();
      db.bans[String(t.rId)] = { reason, by: interaction.user.tag, at: Date.now() };
      save();
      if (sync) {
        const discordId = db.robloxToDiscord[String(t.rId)];
        if (discordId) await interaction.guild.members.ban(discordId, { reason: `Game ban sync: ${reason}`.slice(0, 450) }).catch(() => {});
      }
      return interaction.reply({ embeds: [queuedEmbed('ban', t.rUsername, `\nReason: ${reason}\nDiscord sync: **${sync ? 'yes' : 'no'}**`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('game-unban').setDescription('[STAFF] Unban player in game (+ Discord)')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const t = await needTarget(interaction); if (!t) return;
      queueCommand({ type: 'unban', robloxUsername: t.rUsername, robloxId: t.rId, by: interaction.user.tag });
      const db = getDb();
      delete db.bans[String(t.rId)];
      save();
      return interaction.reply({ embeds: [queuedEmbed('unban', t.rUsername)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('game-announce').setDescription('[STAFF] Announce to all game servers')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('message').setDescription('Message (max 200 chars)').setRequired(true)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const msg = interaction.options.getString('message', true).slice(0, 200);
      queueCommand({ type: 'announce', message: msg, by: interaction.user.tag, broadcast: true });
      return interaction.reply({ embeds: [queuedEmbed('announce', 'all servers', `\n> ${msg}`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('game-restart').setDescription('[STAFF] Restart all game servers')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addIntegerOption((o) => o.setName('delay').setDescription('Countdown seconds 5-120 (default 30)').setMinValue(5).setMaxValue(120))
      .addStringOption((o) => o.setName('reason').setDescription('Reason shown to players')),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const delay = interaction.options.getInteger('delay') ?? 30;
      const reason = (interaction.options.getString('reason') || 'Restarting...').slice(0, 200);
      queueCommand({ type: 'restart', delay, reason, by: interaction.user.tag, broadcast: true });
      return interaction.reply({ embeds: [queuedEmbed('restart', 'all servers', `\nIn **${delay}s** — ${reason}`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('game-luck').setDescription('[STAFF] Boost server luck on all game servers')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addIntegerOption((o) => o.setName('mult').setDescription('Luck multiplier 1-10 (1 = reset)').setRequired(true).setMinValue(1).setMaxValue(10))
      .addIntegerOption((o) => o.setName('minutes').setDescription('Duration 1-60 min (default 10)').setMinValue(1).setMaxValue(60)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const mult = interaction.options.getInteger('mult', true);
      const minutes = interaction.options.getInteger('minutes') ?? 10;
      queueCommand({ type: 'luck', mult, minutes, by: interaction.user.tag, broadcast: true });
      return interaction.reply({ embeds: [queuedEmbed('luck', 'all servers', `\n**${mult}x** for **${minutes}m**`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('admin-abuse').setDescription('[STAFF] Fire a server-wide admin event')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('event').setDescription('Which event?').setRequired(true).addChoices(
        { name: 'Money Rain (+$2,500 everyone)', value: 'money-rain' },
        { name: 'Spin Party (+2 wheel spins everyone)', value: 'spin-party' },
        { name: 'Heal All', value: 'heal-all' },
        { name: 'Midnight (2 min)', value: 'midnight' },
        { name: 'Daybreak', value: 'daybreak' },
        { name: 'Disco Party (+10 spins, $50M, snake dance)', value: 'disco' },
        { name: 'EVERYTHING (all events at once)', value: 'all' }))
      .addIntegerOption((o) => o.setName('duration').setDescription('Disco dance seconds 60-3600 (default 60)').setMinValue(60).setMaxValue(3600)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const ev = interaction.options.getString('event', true);
      const duration = interaction.options.getInteger('duration') ?? 60;
      queueCommand({ type: 'abuse', event: ev, duration, by: interaction.user.tag, broadcast: true });
      return interaction.reply({ embeds: [queuedEmbed('abuse', 'all servers', `\nEvent: **${ev}**`)] });
    },
  },
];
