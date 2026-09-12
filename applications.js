// Staff application questionnaires for the ticket system.
// Types: 'text' (type your answer), 'yesno' (Yes / No buttons), 'choice' (button options).
// min/max = min/max characters for text answers.
module.exports = {
  admin: {
    label: 'Admin',
    color: 0xed4245,
    intro: 'Answer honestly. Admins enforce rules, handle reports and keep the game fun and safe.',
    questions: [
      { type: 'text', q: 'What is your Roblox username?', min: 3, max: 30 },
      { type: 'yesno', q: 'Are you 16 or older?' },
      { type: 'yesno', q: 'Have you been staff (mod/admin) in another Roblox game or Discord before?' },
      { type: 'text', q: 'What timezone are you in, and how many hours per week can you moderate?', min: 5, max: 300 },
      { type: 'text', q: 'Scenario: you catch someone exploiting in a public server. Step by step, what do you do?', min: 20, max: 1000 },
      { type: 'text', q: 'Scenario: two popular players are arguing and both sides are spamming chat. How do you handle it?', min: 20, max: 1000 },
      { type: 'text', q: 'Why should we pick YOU as Admin? (strengths, what makes you different)', min: 20, max: 1000 },
    ],
  },
  contentcreator: {
    label: 'Content Creator',
    color: 0xc85aff,
    intro: 'Creators make videos, shorts, streams and edits that grow the community.',
    questions: [
      { type: 'text', q: 'What is your Roblox username?', min: 3, max: 30 },
      { type: 'text', q: 'Drop your main social handle or channel link (TikTok / YouTube / Twitch).', min: 3, max: 200 },
      { type: 'yesno', q: 'Do you have 1,000+ followers/subscribers on at least one platform?' },
      { type: 'choice', q: 'How often do you post?', options: ['Daily', 'Few times a week', 'Weekly', 'Monthly'] },
      { type: 'choice', q: 'What kind of content do you mainly make?', options: ['Videos', 'Shorts / TikToks', 'Streams', 'Edits'] },
      { type: 'yesno', q: 'Can you post about our game at least twice a month?' },
      { type: 'text', q: 'Link your BEST video/post so we can review it.', min: 5, max: 200 },
    ],
  },
  tester: {
    label: 'Tester',
    color: 0x5aaaff,
    intro: 'Testers join test sessions, find bugs and keep unreleased content secret.',
    questions: [
      { type: 'text', q: 'What is your Roblox username?', min: 3, max: 30 },
      { type: 'yesno', q: 'Can you join test sessions at least once a week?' },
      { type: 'choice', q: 'What device do you mainly play on?', options: ['PC', 'Mobile', 'Console'] },
      { type: 'yesno', q: 'Have you ever found and reported a bug in a game before?' },
      { type: 'text', q: 'You find a glitch that gives free items. Walk us through exactly how you would report it.', min: 20, max: 1000 },
      { type: 'yesno', q: 'Do you agree to NEVER leak unreleased content (instant blacklist if you do)?' },
    ],
  },
  communitymanager: {
    label: 'Community Manager',
    color: 0x57f287,
    intro: 'Community Managers run events, keep chat active and make members feel welcome.',
    questions: [
      { type: 'text', q: 'What is your Roblox username?', min: 3, max: 30 },
      { type: 'yesno', q: 'Are you 16 or older?' },
      { type: 'yesno', q: 'Are you active in Discord almost every day?' },
      { type: 'text', q: 'Pitch one event idea you would run for the community.', min: 20, max: 1000 },
      { type: 'text', q: 'A heated argument breaks out between members. How do you calm it down?', min: 20, max: 1000 },
      { type: 'yesno', q: 'Have you moderated or managed a community before?' },
    ],
  },
  director: {
    label: 'Director',
    color: 0xffaa00,
    intro: 'Directors lead staff teams and shape how the community is run. High responsibility role.',
    questions: [
      { type: 'text', q: 'What is your Roblox username?', min: 3, max: 30 },
      { type: 'yesno', q: 'Are you 18 or older?' },
      { type: 'yesno', q: 'Have you led or managed a staff team before?' },
      { type: 'choice', q: 'Biggest team you have managed?', options: ['Never led', 'Small (under 10)', 'Medium (10-30)', 'Large (30+)'] },
      { type: 'text', q: 'What is your vision for this community? Where should it be in 6 months?', min: 30, max: 1000 },
      { type: 'text', q: 'You get a report that one of YOUR staff members is abusing powers. What do you do?', min: 20, max: 1000 },
      { type: 'choice', q: 'How much time per week can you dedicate?', options: ['Under 5h', '5-10 hours', '10+ hours'] },
    ],
  },
  creativedirector: {
    label: 'Creative Director',
    color: 0xff5da2,
    intro: 'Creative Directors guide the look and feel: clothing, maps, UI and update concepts.',
    questions: [
      { type: 'text', q: 'What is your Roblox username?', min: 3, max: 30 },
      { type: 'text', q: 'Link your portfolio (Roblox creations, art, builds, anything visual).', min: 5, max: 200 },
      { type: 'yesno', q: 'Do you have real experience designing (clothing, building, UI, art)?' },
      { type: 'choice', q: 'What is your specialty?', options: ['Clothing', 'Maps / Builds', 'UI / Graphics', 'Concepts / Ideas'] },
      { type: 'text', q: 'Pitch ONE summer update idea (theme, 2-3 items, one event).', min: 30, max: 1000 },
      { type: 'yesno', q: 'Can you take feedback and rework your ideas with the team without taking it personally?' },
    ],
  },
};
