/** Staff granting + utility bridge commands (all queue exact bridge `type` strings). */
const { SlashCommandBuilder } = require('discord.js');
const { getDb } = require('../src/db');
const { embedBase, themeColorInt } = require('../src/embeds');
const { queueCommand, resolveRobloxTarget, fuzzy, allItemNames } = require('../src/roblox');
const { isStaffHigherThanBot } = require('../src/bridge');
const catalogs = require('../catalogs');

const ADMIN = '0';

async function needStaff(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (member && await isStaffHigherThanBot(member)) return member;
  await interaction.reply({ content: '❌ You need a role **higher than the bot** to use this.', ephemeral: true });
  return null;
}

async function needTarget(interaction) {
  const token = interaction.options.getString('username', true);
  const t = await resolveRobloxTarget(token);
  if (!t) await interaction.reply({ content: `❌ Roblox user \`${token}\` not found.`, ephemeral: true });
  return t;
}

function queued(type, target, extra = '') {
  return embedBase('✅ Queued for game', `\`${type}\` → **${target}**${extra}\n_Game picks it up in ~5s._`, 0x57d9a3);
}

async function autoWeapon(interaction) {
  const names = [...new Set([...(catalogs.weapons || []), ...allItemNames('Weapon')])];
  const f = interaction.options.getFocused();
  await interaction.respond(fuzzy(names, f, 8).map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) }))).catch(() => {});
}
async function autoFinisher(interaction) {
  const names = [...new Set([...(catalogs.finishers || []), ...allItemNames('Finisher')])];
  const f = interaction.options.getFocused();
  await interaction.respond(fuzzy(names, f, 8).map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) }))).catch(() => {});
}
async function autoSkinType(interaction) {
  const f = interaction.options.getFocused();
  await interaction.respond(fuzzy(catalogs.skinTypes || [], f, 8).map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) }))).catch(() => {});
}
async function autoSkin(interaction) {
  const names = allItemNames('WeaponSkin');
  const f = interaction.options.getFocused();
  await interaction.respond(fuzzy(names, f, 8).map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) }))).catch(() => {});
}

module.exports = [
  {
    data: new SlashCommandBuilder().setName('give-weapon').setDescription('[STAFF] Give a weapon in game')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true))
      .addStringOption((o) => o.setName('weapon').setDescription('Weapon name').setRequired(true).setAutocomplete(true)),
    autocomplete: autoWeapon,
    async execute(i) {
      if (!await needStaff(i)) return;
      const t = await needTarget(i); if (!t) return;
      const w = i.options.getString('weapon', true);
      queueCommand({ type: 'give_weapon', robloxUsername: t.rUsername, robloxId: t.rId, weapon: w, by: i.user.tag });
      return i.reply({ embeds: [queued('give_weapon', t.rUsername, `\nWeapon: **${w}**`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('give-skin').setDescription('[STAFF] Give a skin in game')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true))
      .addStringOption((o) => o.setName('weapontype').setDescription('Base weapon type, e.g. RPG').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('skin').setDescription('Skin name').setRequired(true).setAutocomplete(true)),
    async execute(i) {
      if (!await needStaff(i)) return;
      const t = await needTarget(i); if (!t) return;
      const wt = i.options.getString('weapontype', true);
      const sk = i.options.getString('skin', true);
      // autocomplete routing: Discord sends focused option name; route manually
      return i.reply({ embeds: [queued('give_skin', t.rUsername, `\n${wt} / **${sk}**`)] }).then(() => {
        queueCommand({ type: 'give_skin', robloxUsername: t.rUsername, robloxId: t.rId, weaponType: wt, skin: sk, by: i.user.tag });
      });
    },
  },
  {
    data: new SlashCommandBuilder().setName('give-finisher').setDescription('[STAFF] Give a finisher in game')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true))
      .addStringOption((o) => o.setName('finisher').setDescription('Finisher name').setRequired(true).setAutocomplete(true)),
    autocomplete: autoFinisher,
    async execute(i) {
      if (!await needStaff(i)) return;
      const t = await needTarget(i); if (!t) return;
      const f = i.options.getString('finisher', true);
      queueCommand({ type: 'give_finisher', robloxUsername: t.rUsername, robloxId: t.rId, finisher: f, by: i.user.tag });
      return i.reply({ embeds: [queued('give_finisher', t.rUsername, `\nFinisher: **${f}**`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('player-data').setDescription('[STAFF] Full player data')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true)),
    async execute(i) {
      if (!await needStaff(i)) return;
      const t = await needTarget(i); if (!t) return;
      const db = getDb();
      const cached = db.playerCache[String(t.rId)];
      const e = embedBase(`🎮 ${t.rUsername}`,
        cached ? `💰 Dinero: **${cached.money ?? '?'}**\n⚔️ Slays: **${cached.slays ?? '?'}**\n🎒 Weapons: **${(cached.weapons || cached.weaponNames || []).length}**` : '_No cached game data yet — data arrives when the player is in a live server._',
        themeColorInt());
      return i.reply({ embeds: [e] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('game-money').setDescription('[STAFF] Give/Remove/Set Dinero')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('action').setDescription('Give/Remove/Set').setRequired(true).addChoices({ name: 'Give', value: 'Give' }, { name: 'Remove', value: 'Remove' }, { name: 'Set', value: 'Set' }))
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('Amount').setRequired(true)),
    async execute(i) {
      if (!await needStaff(i)) return;
      const t = await needTarget(i); if (!t) return;
      const a = i.options.getString('action', true);
      const amt = i.options.getInteger('amount', true);
      queueCommand({ type: 'money', action: a, robloxUsername: t.rUsername, robloxId: t.rId, amount: amt, by: i.user.tag });
      return i.reply({ embeds: [queued('money', t.rUsername, `\n${a} **${amt}** Dinero`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('give-tokens').setDescription('[STAFF] Give/Remove/Set Tokens')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('action').setDescription('Give/Remove/Set').setRequired(true).addChoices({ name: 'Give', value: 'Give' }, { name: 'Remove', value: 'Remove' }, { name: 'Set', value: 'Set' }))
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
    async execute(i) {
      if (!await needStaff(i)) return;
      const t = await needTarget(i); if (!t) return;
      queueCommand({ type: 'give_tokens', action: i.options.getString('action', true), robloxUsername: t.rUsername, robloxId: t.rId, amount: i.options.getInteger('amount', true), by: i.user.tag });
      return i.reply({ embeds: [queued('give_tokens', t.rUsername)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('give-spins').setDescription('[STAFF] Give/Remove/Set Hourly or Wheel spins')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('type').setDescription('Hourly or Wheel spins').setRequired(true).addChoices({ name: 'Hourly', value: 'hourly' }, { name: 'Wheel', value: 'wheel' }))
      .addStringOption((o) => o.setName('action').setDescription('Give/Remove/Set').setRequired(true).addChoices({ name: 'Give', value: 'Give' }, { name: 'Remove', value: 'Remove' }, { name: 'Set', value: 'Set' }))
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
    async execute(i) {
      if (!await needStaff(i)) return;
      const t = await needTarget(i); if (!t) return;
      const kind = i.options.getString('type', true);
      queueCommand({ type: 'give_spins', kind: kind[0].toUpperCase() + kind.slice(1), action: i.options.getString('action', true), robloxUsername: t.rUsername, robloxId: t.rId, amount: i.options.getInteger('amount', true), by: i.user.tag });
      return i.reply({ embeds: [queued('give_spins', t.rUsername, `\n${kind} spins`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('give-everything').setDescription('[STAFF] Give a player ALL weapons, skins and finishers')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true))
      .addStringOption((o) => o.setName('category').setDescription('What to grant (default: everything)')
        .addChoices({ name: 'Everything', value: 'everything' }, { name: 'Weapons only', value: 'weapons' }, { name: 'Skins only', value: 'skins' }, { name: 'Finishers only', value: 'finishers' })),
    async execute(i) {
      if (!await needStaff(i)) return;
      const t = await needTarget(i); if (!t) return;
      const cat = i.options.getString('category') || 'everything';
      queueCommand({ type: 'give_everything', robloxUsername: t.rUsername, robloxId: t.rId, category: cat, by: i.user.tag });
      return i.reply({ embeds: [queued('give_everything', t.rUsername, `\nCategory: **${cat}**`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('give-all-weapon').setDescription('[STAFF] Give a weapon to EVERYONE online in game')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('weapon').setDescription('Weapon name').setRequired(true).setAutocomplete(true)),
    autocomplete: autoWeapon,
    async execute(i) {
      if (!await needStaff(i)) return;
      const w = i.options.getString('weapon', true);
      queueCommand({ type: 'give_all_weapon', weapon: w, by: i.user.tag, broadcast: true });
      return i.reply({ embeds: [queued('give_all_weapon', 'EVERYONE online', `\nWeapon: **${w}**`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('give-all-skin').setDescription('[STAFF] Give a skin to EVERYONE online in game')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('weapontype').setDescription('Base weapon type, e.g. RPG').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('skin').setDescription('Skin name').setRequired(true).setAutocomplete(true)),
    async execute(i) {
      if (!await needStaff(i)) return;
      const wt = i.options.getString('weapontype', true);
      const sk = i.options.getString('skin', true);
      queueCommand({ type: 'give_all_skin', weaponType: wt, skin: sk, by: i.user.tag, broadcast: true });
      return i.reply({ embeds: [queued('give_all_skin', 'EVERYONE online', `\n${wt} / **${sk}**`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('give-all-finisher').setDescription('[STAFF] Give a finisher to EVERYONE online in game')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('finisher').setDescription('Finisher name').setRequired(true).setAutocomplete(true)),
    autocomplete: autoFinisher,
    async execute(i) {
      if (!await needStaff(i)) return;
      const f = i.options.getString('finisher', true);
      queueCommand({ type: 'give_all_finisher', finisher: f, by: i.user.tag, broadcast: true });
      return i.reply({ embeds: [queued('give_all_finisher', 'EVERYONE online', `\nFinisher: **${f}**`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('give-all-tokens').setDescription('[STAFF] Give Tokens to EVERYONE online in game')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addIntegerOption((o) => o.setName('amount').setDescription('Token amount').setRequired(true).setMinValue(1)),
    async execute(i) {
      if (!await needStaff(i)) return;
      const amt = i.options.getInteger('amount', true);
      queueCommand({ type: 'give_all_tokens', amount: amt, by: i.user.tag, broadcast: true });
      return i.reply({ embeds: [queued('give_all_tokens', 'EVERYONE online', `\n**${amt}** tokens`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('give-all-spins').setDescription('[STAFF] Give spins to EVERYONE online in game')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('type').setDescription('Hourly or Wheel spins').setRequired(true).addChoices({ name: 'Hourly', value: 'hourly' }, { name: 'Wheel', value: 'wheel' }))
      .addIntegerOption((o) => o.setName('amount').setDescription('Number of spins').setRequired(true).setMinValue(1)),
    async execute(i) {
      if (!await needStaff(i)) return;
      queueCommand({ type: 'give_all_spins', kind: i.options.getString('type', true), amount: i.options.getInteger('amount', true), by: i.user.tag, broadcast: true });
      return i.reply({ embeds: [queued('give_all_spins', 'EVERYONE online')] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('add-emoji').setDescription('[STAFF] Give an emoji overhead to a Roblox user')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('emoji').setDescription('Emoji, e.g. crown').setRequired(true))
      .addStringOption((o) => o.setName('username').setDescription('Roblox username'))
      .addIntegerOption((o) => o.setName('userid').setDescription('Roblox user ID')),
    async execute(i) {
      if (!await needStaff(i)) return;
      const token = i.options.getString('username') || String(i.options.getInteger('userid') || '');
      const t = await resolveRobloxTarget(token);
      if (!t) return i.reply({ content: '❌ Provide a valid `username` or `userid`.', ephemeral: true });
      const emoji = i.options.getString('emoji', true).slice(0, 16);
      queueCommand({ type: 'add_emoji', robloxUsername: t.rUsername, robloxId: t.rId, emoji, by: i.user.tag, broadcast: true });
      return i.reply({ embeds: [queued('add_emoji', t.rUsername, `\nEmoji: \`${emoji}\``)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('remove-emoji').setDescription('[STAFF] Remove an emoji overhead from a Roblox user')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username'))
      .addIntegerOption((o) => o.setName('userid').setDescription('Roblox user ID')),
    async execute(i) {
      if (!await needStaff(i)) return;
      const token = i.options.getString('username') || String(i.options.getInteger('userid') || '');
      const t = await resolveRobloxTarget(token);
      if (!t) return i.reply({ content: '❌ Provide a valid `username` or `userid`.', ephemeral: true });
      queueCommand({ type: 'remove_emoji', robloxUsername: t.rUsername, robloxId: t.rId, by: i.user.tag, broadcast: true });
      return i.reply({ embeds: [queued('remove_emoji', t.rUsername)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('force-pvp').setDescription('[STAFF] Force PvP ON for a player')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username'))
      .addIntegerOption((o) => o.setName('userid').setDescription('Roblox user ID')),
    async execute(i) {
      if (!await needStaff(i)) return;
      const token = i.options.getString('username') || String(i.options.getInteger('userid') || '');
      const t = await resolveRobloxTarget(token);
      if (!t) return i.reply({ content: '❌ Provide a valid `username` or `userid`.', ephemeral: true });
      queueCommand({ type: 'force_pvp', robloxUsername: t.rUsername, robloxId: t.rId, by: i.user.tag, broadcast: true });
      return i.reply({ embeds: [queued('force_pvp', t.rUsername)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('unforce-pvp').setDescription('[STAFF] Release a forced PvP lock')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username'))
      .addIntegerOption((o) => o.setName('userid').setDescription('Roblox user ID')),
    async execute(i) {
      if (!await needStaff(i)) return;
      const token = i.options.getString('username') || String(i.options.getInteger('userid') || '');
      const t = await resolveRobloxTarget(token);
      if (!t) return i.reply({ content: '❌ Provide a valid `username` or `userid`.', ephemeral: true });
      queueCommand({ type: 'unforce_pvp', robloxUsername: t.rUsername, robloxId: t.rId, by: i.user.tag, broadcast: true });
      return i.reply({ embeds: [queued('unforce_pvp', t.rUsername)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('force-show-emoji').setDescription('[STAFF] Force-show emoji')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username'))
      .addIntegerOption((o) => o.setName('userid').setDescription('Roblox user ID')),
    async execute(i) {
      if (!await needStaff(i)) return;
      const token = i.options.getString('username') || String(i.options.getInteger('userid') || '');
      const t = await resolveRobloxTarget(token);
      if (!t) return i.reply({ content: '❌ Provide a valid `username` or `userid`.', ephemeral: true });
      queueCommand({ type: 'force_show_emoji', robloxUsername: t.rUsername, robloxId: t.rId, by: i.user.tag, broadcast: true });
      return i.reply({ embeds: [queued('force_show_emoji', t.rUsername)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('unforce-show-emoji').setDescription('[STAFF] Release a forced emoji lock')
      .setDefaultMemberPermissions(ADMIN).setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username'))
      .addIntegerOption((o) => o.setName('userid').setDescription('Roblox user ID')),
    async execute(i) {
      if (!await needStaff(i)) return;
      const token = i.options.getString('username') || String(i.options.getInteger('userid') || '');
      const t = await resolveRobloxTarget(token);
      if (!t) return i.reply({ content: '❌ Provide a valid `username` or `userid`.', ephemeral: true });
      queueCommand({ type: 'unforce_show_emoji', robloxUsername: t.rUsername, robloxId: t.rId, by: i.user.tag, broadcast: true });
      return i.reply({ embeds: [queued('unforce_show_emoji', t.rUsername)] });
    },
  },
];
