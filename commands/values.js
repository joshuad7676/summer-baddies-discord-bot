/** Trading values: /value /item /owners + search-* */
const { SlashCommandBuilder } = require('discord.js');
const { getDb } = require('../src/db');
const { embedBase, themeColorInt } = require('../src/embeds');
const { lookupValue, valueLine, buildItemEmbed, getOwners, ownerLine, fuzzy, allItemNames } = require('../src/roblox');
const { getTier } = require('../demand');

const TYPES = [
  { name: 'weapon', value: 'Weapon' },
  { name: 'skin', value: 'WeaponSkin' },
  { name: 'finisher', value: 'Finisher' },
];

async function autocompleteTypeName(interaction) {
  try {
    const type = interaction.options.getString('type');
    const focused = interaction.options.getFocused();
    if (!type) return interaction.respond([]);
    const names = allItemNames(type);
    return interaction.respond(fuzzy(names, focused, 8).map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) })));
  } catch { try { await interaction.respond([]); } catch {} }
}

function searchBlock(type, q) {
  const db = getDb();
  const live = Object.values(db.valuesCache.byKey || {}).filter((v) => v.type === type);
  const names = allItemNames(type);
  const hits = fuzzy(names, q, 8);
  if (!hits.length) return 'No matches. Try a shorter name or check spelling.';
  return hits.map((n) => {
    const v = live.find((x) => x.name.toLowerCase() === n.toLowerCase()) || lookupValue(type, n);
    return valueLine(v);
  }).join('\n');
}

module.exports = [
  {
    data: new SlashCommandBuilder().setName('value').setDescription('Look up RAP + demand for any item')
      .addStringOption((o) => o.setName('type').setDescription('weapon, skin or finisher').setRequired(true).addChoices(...TYPES))
      .addStringOption((o) => o.setName('name').setDescription('Item name').setRequired(true).setAutocomplete(true)),
    autocomplete: autocompleteTypeName,
    async execute(interaction) {
      const type = interaction.options.getString('type', true);
      const name = interaction.options.getString('name', true);
      const v = lookupValue(type, name);
      return interaction.reply({ embeds: [embedBase(`${require('../demand').EMOJI[v.demand] || ''} ${v.name}`, `${valueLine(v)}\n\nValues updated ${getDb().valuesCache.at ? `<t:${Math.floor(getDb().valuesCache.at / 1000)}:R>` : 'from seeds'}`, themeColorInt())] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('item').setDescription('Full item detail: icon, RAP, demand, owners, teleport')
      .addStringOption((o) => o.setName('type').setDescription('weapon, skin or finisher').setRequired(true).addChoices(...TYPES))
      .addStringOption((o) => o.setName('name').setDescription('Item name').setRequired(true).setAutocomplete(true)),
    autocomplete: autocompleteTypeName,
    async execute(interaction) {
      await interaction.deferReply();
      const emb = await buildItemEmbed(interaction.options.getString('type', true), interaction.options.getString('name', true), themeColorInt());
      return interaction.editReply({ embeds: [emb] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('owners').setDescription('Who owns this item + teleport + linked Discord')
      .addStringOption((o) => o.setName('type').setDescription('weapon, skin or finisher').setRequired(true).addChoices(...TYPES))
      .addStringOption((o) => o.setName('name').setDescription('Item name').setRequired(true).setAutocomplete(true)),
    autocomplete: autocompleteTypeName,
    async execute(interaction) {
      const type = interaction.options.getString('type', true);
      const name = interaction.options.getString('name', true);
      const owners = getOwners(lookupValue(type, name).name, type, 10);
      // note: lookup canonical name first so case-insensitive queries still match owners
      const canon = lookupValue(type, name).name;
      const list = getOwners(type, canon, 10);
      if (!list.length) return interaction.reply({ embeds: [embedBase(`👥 Owners — ${canon}`, '_No tracked owner yet._', themeColorInt())] });
      return interaction.reply({ embeds: [embedBase(`👥 Owners — ${canon}`, list.map(ownerLine).join('\n').slice(0, 3900), themeColorInt())] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('search-weapons').setDescription('Search weapons (RAP + demand)')
      .addStringOption((o) => o.setName('query').setDescription('weapon name').setRequired(true)),
    async execute(interaction) {
      return interaction.reply({ embeds: [embedBase(`🔎 weapons — "${interaction.options.getString('query', true)}"`, searchBlock('Weapon', interaction.options.getString('query', true)).slice(0, 3900), themeColorInt())] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('search-skins').setDescription('Search skins (RAP + demand)')
      .addStringOption((o) => o.setName('query').setDescription('skin name').setRequired(true)),
    async execute(interaction) {
      return interaction.reply({ embeds: [embedBase(`🔎 skins — "${interaction.options.getString('query', true)}"`, searchBlock('WeaponSkin', interaction.options.getString('query', true)).slice(0, 3900), themeColorInt())] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('search-finishers').setDescription('Search finishers (RAP + demand)')
      .addStringOption((o) => o.setName('query').setDescription('finisher name').setRequired(true)),
    async execute(interaction) {
      return interaction.reply({ embeds: [embedBase(`🔎 finishers — "${interaction.options.getString('query', true)}"`, searchBlock('Finisher', interaction.options.getString('query', true)).slice(0, 3900), themeColorInt())] });
    },
  },
];
