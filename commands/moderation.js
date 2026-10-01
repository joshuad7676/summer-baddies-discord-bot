/** Basic Discord moderation with game sync when the target is linked. */
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getDb, save } = require('../src/db');
const { embedBase } = require('../src/embeds');
const { queueCommand } = require('../src/roblox');
const { isStaffHigherThanBot } = require('../src/bridge');

const ADMIN = '0';

async function needStaff(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (member && await isStaffHigherThanBot(member)) return member;
  await interaction.reply({ content: '❌ You need a role **higher than the bot** to use this.', ephemeral: true });
  return null;
}

module.exports = [
  {
    data: new SlashCommandBuilder().setName('kick').setDescription('[STAFF] Kick a Discord member (+ game if linked)')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason')),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const target = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') || 'Kicked by staff';
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: 'Member not found.', ephemeral: true });
      if (!member.kickable) return interaction.reply({ content: '❌ I cannot kick that member (role hierarchy).', ephemeral: true });
      await member.kick(reason).catch(() => {});
      const link = getDb().links[target.id];
      if (link) queueCommand({ type: 'kick', robloxUsername: link.robloxUsername, robloxId: link.robloxId, reason, by: interaction.user.tag });
      return interaction.reply({ embeds: [embedBase('✅ Kicked', `${target.tag}\n${reason}${link ? '\n+ game kick queued (linked).' : ''}`, 0x57d9a3)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('ban').setDescription('[STAFF] Ban a Discord member (+ game if linked)')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason')),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const target = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') || 'Banned by staff';
      const db = getDb();
      await interaction.guild.members.ban(target.id, { reason }).catch(() => {});
      const link = db.links[target.id];
      if (link) {
        queueCommand({ type: 'ban', robloxUsername: link.robloxUsername, robloxId: link.robloxId, reason, by: interaction.user.tag });
        db.bans[String(link.robloxId)] = { reason, by: interaction.user.tag, at: Date.now() };
        save();
      }
      return interaction.reply({ embeds: [embedBase('✅ Banned', `${target.tag}\n${reason}${link ? '\n+ game ban queued (linked).' : ''}`, 0x57d9a3)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('unban').setDescription('[STAFF] Unban a Discord user (+ game)')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('userid').setDescription('Discord user ID').setRequired(true)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const id = interaction.options.getString('userid', true);
      await interaction.guild.bans.remove(id).catch(() => {});
      return interaction.reply({ embeds: [embedBase('✅ Unbanned', `\`${id}\``, 0x57d9a3)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('timeout').setDescription('[STAFF] Timeout a member (+ game note)')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addIntegerOption((o) => o.setName('minutes').setDescription('Minutes (1-40320)').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason')),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const target = interaction.options.getUser('user', true);
      const mins = Math.min(Math.max(interaction.options.getInteger('minutes', true), 1), 40320);
      const reason = interaction.options.getString('reason') || 'Timed out by staff';
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member || !member.moderatable) return interaction.reply({ content: '❌ I cannot timeout that member.', ephemeral: true });
      await member.timeout(mins * 60000, reason).catch(() => {});
      const link = getDb().links[target.id];
      if (link) queueCommand({ type: 'timeout_note', robloxUsername: link.robloxUsername, robloxId: link.robloxId, reason, minutes: mins, by: interaction.user.tag, broadcast: true });
      return interaction.reply({ embeds: [embedBase('✅ Timed out', `${target.tag} for ${mins}m\n${reason}`, 0x57d9a3)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('untimeout').setDescription('[STAFF] Remove timeout')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
    async execute(interaction) {
      if (!await needStaff(interaction)) return;
      const target = interaction.options.getUser('user', true);
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (member) await member.timeout(null).catch(() => {});
      return interaction.reply({ embeds: [embedBase('✅ Unmuted', `${target.tag}`, 0x57d9a3)] });
    },
  },
];
