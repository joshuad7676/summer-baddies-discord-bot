// Demand tiers — JS mirror of ReplicatedStorage.Modules.Trading.DemandData (Lua).
// Keep thresholds in sync! Tiers: POOR, DECREASING, STABLE, INCREASING, POPULAR, EXCELLENT
const EMOJI = { POOR: '🪨', DECREASING: '📉', STABLE: '➖', INCREASING: '📈', POPULAR: '🔥', EXCELLENT: '💎' };
const COLORS = { POOR: 0x82828c, DECREASING: 0xed4245, STABLE: 0xfee75c, INCREASING: 0x57f287, POPULAR: 0x5aaaff, EXCELLENT: 0xc85aff };

function getTier(rap, changePct) {
  rap = Number(rap) || 0; changePct = Number(changePct) || 0;
  if (changePct <= -0.12) return 'POOR';
  if (rap >= 15000 && changePct >= 0.03) return 'EXCELLENT';
  if (rap >= 50000) return 'EXCELLENT';
  if (rap >= 5000 && changePct >= 0) return 'POPULAR';
  if (rap >= 15000) return 'POPULAR';
  if (changePct >= 0.04) return 'INCREASING';
  if (changePct <= -0.04) return rap < 200 ? 'POOR' : 'DECREASING';
  if (rap < 100) return 'POOR';
  if (rap < 200 && changePct <= 0) return 'POOR';
  return 'STABLE';
}
function formatRap(rap) {
  rap = Math.floor(Number(rap) || 0);
  if (rap >= 1000000) return (rap / 1000000).toFixed(1) + 'M';
  if (rap >= 10000) return (rap / 1000).toFixed(1) + 'k';
  if (rap >= 1000) return (rap / 1000).toFixed(2) + 'k';
  return String(rap);
}
function fmtPct(c) { const p = (Number(c) || 0) * 100; return (p >= 0 ? '+' : '') + p.toFixed(1) + '%'; }

module.exports = { EMOJI, COLORS, getTier, formatRap, fmtPct };
