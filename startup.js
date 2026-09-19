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
  const setup = block.match(/\.addStringOption\(o\s*=>\s*o\.setName\(['"]setup['"]\)[\s\S]*?\)\.setRequired\(true\)\)?/);
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

require('./index.js');
