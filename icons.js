// icons.js — the one outline icon family for every surface (redesign-plan §6):
// 24-unit viewBox, stroke 2, round caps, drawn inline because this project has
// no build step. All icons are decorative next to an accessible name, so each
// carries aria-hidden; the button provides the label.

function icon(paths, size = 15) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export const ICONS = {
  theme: icon('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>', 16),
  pin: icon('<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>'),
  pinFilled: `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>`,
  trash: icon('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  chevronLeft: icon('<path d="m15 18-6-6 6-6"/>', 14),
  chevronRight: icon('<path d="m9 18 6-6-6-6"/>', 12),
  chevronUp: icon('<path d="m18 15-6-6-6 6"/>', 13),
  chevronDown: icon('<path d="m6 9 6 6 6-6"/>', 13),
  close: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 14),
  check: icon('<path d="M20 6 9 17l-5-5"/>', 44),
  wrap: icon('<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>', 13),
};
