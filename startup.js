const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

// Discord requires required slash-command options to come before optional ones.
const optionalFirst = ".addChannelOption(o => o.setName('channel').setDescription('Channel to post in (default: here)'))\n     .addStringOption(o => o.setName('setup').setDescription('One per line: Label | emoji | @role (max 10)').setRequired(true))";
const requiredFirst = ".addStringOption(o => o.setName('setup').setDescription('One per line: Label | emoji | @role (max 10)').setRequired(true))\n     .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (default: here)'))";

if (source.includes(optionalFirst)) {
  fs.writeFileSync(indexPath, source.replace(optionalFirst, requiredFirst));
  console.log('[startup] Fixed /selfroles option order before loading bot.');
} else if (source.includes(requiredFirst)) {
  console.log('[startup] /selfroles option order already correct.');
} else {
  console.warn('[startup] Could not find the /selfroles option block; no source patch applied.');
}

require('./index.js');
