const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');

// Discord requires required slash-command options to come before optional ones.
// Patch the complete /selfroles builder without depending on exact whitespace.
const selfrolesStart = source.indexOf("new SlashCommandBuilder().setName('selfroles')");
if (selfrolesStart !== -1) {
  const nextCommand = source.indexOf("new SlashCommandBuilder()", selfrolesStart + 10);
  const end = nextCommand === -1 ? source.length : nextCommand;
  const block = source.slice(selfrolesStart, end);
  const setup = block.match(/\.addStringOption\(o\s*=>\s*o\.setName\(['"]setup['"]\)[\s\S]*?\.setRequired\(true\)\)?/);
  const channel = block.match(/\.addChannelOption\(o\s*=>\s*o\.setName\(['"]channel['"]\)[\s\S]*?\)\)?/);

  if (setup && channel) {
    const setupText = setup[0];
    const channelText = channel[0];
    const setupIndex = block.indexOf(setupText);
    const channelIndex = block.indexOf(channelText);
    if (setupIndex > channelIndex) {
      const reordered = block
        .replace(setupText, '')
        .replace(channelText, '')
        .replace(/(\.setDMPermission\(false\)|\.setDefaultMemberPermissions\([^)]*\))/, `$1\n     ${setupText}\n     ${channelText}`);
      source = source.slice(0, selfrolesStart) + reordered + source.slice(end);
      fs.writeFileSync(indexPath, source);
      console.log('[startup] Fixed /selfroles option order before loading bot.');
    } else {
      console.log('[startup] /selfroles option order already correct.');
    }
  } else {
    console.warn('[startup] Found /selfroles but could not identify setup/channel options.');
  }
} else {
  console.warn('[startup] Could not find the /selfroles command.');
}

// Inject /create-roles into the runtime command list and handler.
if (!source.includes("setName('create-roles')")) {
  const insertAfter = "  new SlashCommandBuilder().setName('sync-levels').setDescription('[STAFF] Grant level milestone roles to everyone from current levels'),";
  const commandText = "  new SlashCommandBuilder().setName('create-roles').setDescription('[STAFF] Create one or more colored roles')\n" +
    "    .setDefaultMemberPermissions(ADMIN_PERMS).setDMPermission(false)\n" +
    "    .addStringOption(o => o.setName('setup').setDescription('One per line: Name | #hex-color').setRequired(true)),\n";
  if (source.includes(insertAfter)) {
    source = source.replace(insertAfter, commandText + insertAfter);
    console.log('[startup] Added /create-roles command.');
  } else {
    console.warn('[startup] Could not insert /create-roles command.');
  }
}

if (!source.includes("if (cmd === 'create-roles')")) {
  const handlerAnchor = "    if (cmd === 'selfroles') {";
  const handlerText = "    if (cmd === 'create-roles') {\n" +
    "      const staff = await requireStaff(interaction);\n" +
    "      if (!staff) return;\n" +
    "      const setup = interaction.options.getString('setup', true);\n" +
    "      const lines = setup.split('\\n').map(s => s.trim()).filter(Boolean).slice(0, 20);\n" +
    "      const created = [], existing = [], errors = [];\n" +
    "      const me = await interaction.guild.members.fetchMe();\n" +
    "      if (!me.permissions.has(PermissionFlagsBits.ManageRoles))\n" +
    "        return interaction.reply({ content: '❌ I need Manage Roles permission.', ephemeral: true });\n" +
    "      for (const line of lines) {\n" +
    "        const parts = line.split('|').map(s => s.trim());\n" +
    "        const name = String(parts[0] || '').slice(0, 100);\n" +
    "        const color = /^#[0-9a-fA-F]{6}$/.test(parts[1] || '') ? parts[1] : '#5865F2';\n" +
    "        if (!name) { errors.push('Missing role name.'); continue; }\n" +
    "        const old = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === name.toLowerCase());\n" +
    "        if (old) { existing.push(old); continue; }\n" +
    "        try {\n" +
    "          const role = await interaction.guild.roles.create({ name, color, hoist: false, mentionable: true, reason: 'create-roles command' });\n" +
    "          created.push(role);\n" +
    "        } catch (e) {\n" +
    "          errors.push(name + ': ' + String(e.message || e).slice(0, 120));\n" +
    "        }\n" +
    "      }\n" +
    "      const roleRows = [...created, ...existing].map(function (r, i) {\n" +
    "        const emojis = ['👦', '👧', '🏳️‍🌈', '🔞', '🟡', '🟠', '🔴', '🟢', '⭐', '🎮'];\n" +
    "        return (emojis[i] || '✨') + ' | @' + r.name;\n" +
    "      }).join('\\n');\n" +
    "      const linesToPaste = created.length || existing.length\n" +
    "        ? '\\n\\nUse this next:\\n```text\\n/selfroles setup:\\n' + roleRows + '\\n```'\n" +
    "        : '';\n" +
    "      return interaction.reply({\n" +
    "        content: '✅ Created: ' + (created.map(function (r) { return '<@&' + r.id + '>'; }).join(', ') || '—') +\n" +
    "          (existing.length ? '\\nAlready existed: ' + existing.map(function (r) { return '<@&' + r.id + '>'; }).join(', ') : '') +\n" +
    "          (errors.length ? '\\n⚠️ ' + errors.join(' | ') : '') + linesToPaste,\n" +
    "        ephemeral: true\n" +
    "      });\n" +
    "    }\n";
  if (source.includes(handlerAnchor)) {
    source = source.replace(handlerAnchor, handlerText + handlerAnchor);
    console.log('[startup] Added /create-roles handler.');
  } else {
    console.warn('[startup] Could not insert /create-roles handler.');
  }
}

fs.writeFileSync(indexPath, source);
require('./index.js');
