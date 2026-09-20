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

// Add the create-roles command exactly once.
if (!source.includes("setName('create-roles')")) {
  const insertAfter = "  new SlashCommandBuilder().setName('sync-levels').setDescription('[STAFF] Grant level milestone roles to everyone from current levels'),";
  const createRolesCommand = `  new SlashCommandBuilder().setName('create-roles').setDescription('[STAFF] Create one or more colored roles')
    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)
    .addStringOption(o => o.setName('setup').setDescription('One per line: Name | #hex-color').setRequired(true)),\n`;
  if (source.includes(insertAfter)) {
    source = source.replace(insertAfter, createRolesCommand + insertAfter);
    console.log('[startup] Added /create-roles command.');
  } else {
    console.warn('[startup] Could not insert /create-roles command.');
  }
}

// Add the create-roles command handler once.
if (!source.includes("if (cmd === 'create-roles')")) {
  const handlerAnchor = "    if (cmd === 'selfroles') {";
  const createRolesHandler = `    if (cmd === 'create-roles') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const setup = interaction.options.getString('setup', true);
      const lines = setup.split('\\n').map(s => s.trim()).filter(Boolean).slice(0, 20);
      const created = [], existing = [], errors = [];
      const me = await interaction.guild.members.fetchMe();
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles))
        return interaction.reply({ content: '❌ I need Manage Roles permission.', ephemeral: true });
      for (const line of lines) {
        const parts = line.split('|').map(s => s.trim());
        const name = String(parts[0] || '').slice(0, 100);
        const color = /^#[0-9a-fA-F]{6}$/.test(parts[1] || '') ? parts[1] : '#5865F2';
        if (!name) { errors.push('Missing role name.'); continue; }
        const old = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === name.toLowerCase());
        if (old) { existing.push(old); continue; }
        try {
          const role = await interaction.guild.roles.create({ name, color, hoist: false, mentionable: true, reason: 'create-roles command' });
          created.push(role);
        } catch (e) { errors.push(name + ': ' + String(e.message || e).slice(0, 120)); }
      }
      const linesToPaste = created.length || existing.length ? '\\n\\nUse this next:\\n\\`\\`\\`text\\n/selfroles setup:\\n' + [...created, ...existing].map((r, i) => `${['👦','👧','🏳️‍🌈','🔞','🟡','🟠','🔴','🟢','⭐','🎮'][i] || '✨'} ${r.name} | @${r.name}`).join('\\n') + '\\n\\`\\`\\`' : '';
      return interaction.reply({
        content: '✅ Created: ' + (created.map(r => '<@&' + r.id + '>').join(', ') || '—') +
          (existing.length ? '\\nAlready existed: ' + existing.map(r => '<@&' + r.id + '>').join(', ') : '') +
          (errors.length ? '\\n⚠️ ' + errors.join(' | ') : '') +
          linesToPaste,
        ephemeral: true
      });
    }
`;
  if (source.includes(handlerAnchor)) {
    source = source.replace(handlerAnchor, createRolesHandler + handlerAnchor);
    console.log('[startup] Added /create-roles handler.');
  } else {
    console.warn('[startup] Could not insert /create-roles handler.');
  }
}

fs.writeFileSync(indexPath, source);
require('./index.js');
