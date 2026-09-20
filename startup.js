const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');

// Discord requires required slash-command options to come before optional ones.
const selfrolesStart = source.indexOf("new SlashCommandBuilder().setName('selfroles')");
if (selfrolesStart !== -1) {
  const nextCommand = source.indexOf("new SlashCommandBuilder()", selfrolesStart + 10);
  const end = nextCommand === -1 ? source.length : nextCommand;
  const block = source.slice(selfrolesStart, end);
  const setup = block.match(/\.addStringOption\(o\s*=>\s*o\.setName\(['"]setup['"]\)[\s\S]*?\.setRequired\(true\)\)?/);
  const channel = block.match(/\.addChannelOption\(o\s*=>\s*o\.setName\(['"]channel['"]\)[\s\S]*?\)\)?/);
  if (setup && channel && block.indexOf(setup[0]) > block.indexOf(channel[0])) {
    const reordered = block
      .replace(setup[0], '')
      .replace(channel[0], '')
      .replace(/(\.setDMPermission\(false\)|\.setDefaultMemberPermissions\([^)]*\))/, `$1\n     ${setup[0]}\n     ${channel[0]}`);
    source = source.slice(0, selfrolesStart) + reordered + source.slice(end);
    console.log('[startup] Fixed /selfroles option order before loading bot.');
  } else {
    console.log('[startup] /selfroles option order already correct.');
  }
}

// Add /create-roles if it is not already present.
if (!source.includes("setName('create-roles')")) {
  const anchor = "  new SlashCommandBuilder().setName('sync-levels').setDescription('[STAFF] Grant level milestone roles to everyone from current levels'),";
  const command = "  new SlashCommandBuilder().setName('create-roles').setDescription('[STAFF] Create colored roles')\n" +
    "    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)\n" +
    "    .addStringOption(o => o.setName('setup').setDescription('One per line: Name | #hex-color').setRequired(true)),\n";
  if (source.includes(anchor)) source = source.replace(anchor, command + anchor);
}

// Add autorole and role-all slash commands exactly once.
if (!source.includes("setName('setup-autorole')")) {
  const anchor = "  new SlashCommandBuilder().setName('sync-levels').setDescription('[STAFF] Grant level milestone roles to everyone from current levels'),";
  const command = "  new SlashCommandBuilder().setName('setup-autorole').setDescription('[STAFF] Set the role automatically given to new members')\n" +
    "    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)\n" +
    "    .addRoleOption(o => o.setName('role').setDescription('Role to give new members').setRequired(true)),\n" +
    "  new SlashCommandBuilder().setName('role-all').setDescription('[STAFF] Give a role to every current member')\n" +
    "    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)\n" +
    "    .addRoleOption(o => o.setName('role').setDescription('Role to give to everyone').setRequired(true)),\n";
  if (source.includes(anchor)) source = source.replace(anchor, command + anchor);
}

// Add /create-roles handler if needed.
if (!source.includes("if (cmd === 'create-roles')")) {
  const anchor = "    if (cmd === 'selfroles') {";
  const handler = "    if (cmd === 'create-roles') {\n" +
    "      const staff = await requireStaff(interaction);\n" +
    "      if (!staff) return;\n" +
    "      const lines = interaction.options.getString('setup', true).split('\\n').map(s => s.trim()).filter(Boolean).slice(0, 20);\n" +
    "      const created = [], existing = [], errors = [];\n" +
    "      const me = await interaction.guild.members.fetchMe();\n" +
    "      for (const line of lines) {\n" +
    "        const parts = line.split('|').map(s => s.trim());\n" +
    "        const name = String(parts[0] || '').slice(0, 100);\n" +
    "        const color = /^#[0-9a-fA-F]{6}$/.test(parts[1] || '') ? parts[1] : '#5865F2';\n" +
    "        if (!name) { errors.push('Missing role name'); continue; }\n" +
    "        const old = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === name.toLowerCase());\n" +
    "        if (old) { existing.push(old); continue; }\n" +
    "        try { created.push(await interaction.guild.roles.create({ name, color, mentionable: true, reason: 'create-roles command' })); }\n" +
    "        catch (e) { errors.push(name + ': ' + String(e.message || e).slice(0, 120)); }\n" +
    "      }\n" +
    "      return interaction.reply({ content: '✅ Created: ' + (created.map(r => '<@&' + r.id + '>').join(', ') || '—') + (existing.length ? '\\nAlready existed: ' + existing.map(r => '<@&' + r.id + '>').join(', ') : '') + (errors.length ? '\\n⚠️ ' + errors.join(' | ') : ''), ephemeral: true });\n" +
    "    }\n";
  if (source.includes(anchor)) source = source.replace(anchor, handler + anchor);
}

// Add autorole setup and role-all handlers before /selfroles.
if (!source.includes("if (cmd === 'setup-autorole')")) {
  const anchor = "    if (cmd === 'selfroles') {";
  const handlers = "    if (cmd === 'setup-autorole') {\n" +
    "      const staff = await requireStaff(interaction);\n" +
    "      if (!staff) return;\n" +
    "      const role = interaction.options.getRole('role', true);\n" +
    "      const me = await interaction.guild.members.fetchMe();\n" +
    "      if (!role.editable || role.position >= me.roles.highest.position) return interaction.reply({ content: '❌ I cannot manage that role. Move it below my bot role.', ephemeral: true });\n" +
    "      db.settings.autoroleId = role.id; save();\n" +
    "      return interaction.reply({ content: '✅ Auto-role enabled: new members receive <@&' + role.id + '>.', ephemeral: true });\n" +
    "    }\n" +
    "    if (cmd === 'role-all') {\n" +
    "      const staff = await requireStaff(interaction);\n" +
    "      if (!staff) return;\n" +
    "      const role = interaction.options.getRole('role', true);\n" +
    "      const me = await interaction.guild.members.fetchMe();\n" +
    "      if (!role.editable || role.position >= me.roles.highest.position || role.managed) return interaction.reply({ content: '❌ I cannot assign that role. Move it below my bot role and choose a normal role.', ephemeral: true });\n" +
    "      await interaction.deferReply({ ephemeral: true });\n" +
    "      const members = await interaction.guild.members.fetch();\n" +
    "      let added = 0, skipped = 0, failed = 0;\n" +
    "      for (const [, member] of members) {\n" +
    "        if (member.user.bot || member.roles.cache.has(role.id)) { skipped++; continue; }\n" +
    "        try { await member.roles.add(role, 'role-all command'); added++; } catch { failed++; }\n" +
    "      }\n" +
    "      return interaction.editReply('✅ Role-all complete for <@&' + role.id + '>. Added: **' + added + '** | Skipped: **' + skipped + '** | Failed: **' + failed + '**');\n" +
    "    }\n";
  if (source.includes(anchor)) source = source.replace(anchor, handlers + anchor);
}

// Make new-member autorole run alongside the existing welcome event.
const memberAdd = "client.on('guildMemberAdd', async (member) => { await sendWelcome(member); });";
const memberAddWithRole = "client.on('guildMemberAdd', async (member) => {\n  await sendWelcome(member);\n  const roleId = db.settings.autoroleId;\n  if (roleId) await member.roles.add(roleId, 'autorole').catch(() => {});\n});";
if (source.includes(memberAdd) && !source.includes("'autorole'")) source = source.replace(memberAdd, memberAddWithRole);

fs.writeFileSync(indexPath, source);
require('./index.js');
