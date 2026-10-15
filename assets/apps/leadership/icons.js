// Archetype marks: a route color and a simple 24x24 line icon each. The same path data is
// drawn as SVG on the page and through Path2D on the share poster.

const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

export const ARCHETYPE_MARKS = {
  commander: { color: '#EE352E', ink: '#FFFFFF', d: 'M6 12.5 12 7l6 5.5M6 18l6-5.5 6 5.5' },
  visionary: { color: '#B933AD', ink: '#FFFFFF', d: `M2.8 12S6.2 6 12 6s9.2 6 9.2 6-3.4 6-9.2 6-9.2-6-9.2-6Z${circle(12, 12, 2.6)}` },
  connector: { color: '#FF6319', ink: '#FFFFFF', d: `${circle(12, 6, 2.2)}${circle(5.5, 17, 2.2)}${circle(18.5, 17, 2.2)}M10.9 7.9 6.6 15.1M13.1 7.9l4.3 7.2M7.7 17h8.6` },
  anchor: { color: '#0039A6', ink: '#FFFFFF', d: `${circle(12, 5.5, 2)}M12 7.5V20M8 11h8M4.5 13.5c.5 4 3.6 6.5 7.5 6.5s7-2.5 7.5-6.5` },
  catalyst: { color: '#FCCC0A', ink: '#111111', d: 'M13.2 3 5.5 13.4h6l-1 7.6 7.8-10.4h-6.1l1-7.6Z' },
  strategist: { color: '#00933C', ink: '#FFFFFF', d: `${circle(6, 18, 1.8)}${circle(18, 6, 1.8)}M7.6 16.8c2.6-1.8 1.4-5.4 4.4-6.6 2.6-1 3.6-1.3 4.6-2.6M4 6.5l3 3M7 6.5l-3 3M16.5 15.5l3 3M19.5 15.5l-3 3` },
  coach: { color: '#6CBE45', ink: '#FFFFFF', d: 'M12 20.5V11M12 13.5c0-4 2.7-6.6 7-6.6 0 4.1-2.8 6.6-7 6.6ZM12 15.5c0-3.3-2.4-5.5-6.2-5.5 0 3.3 2.4 5.5 6.2 5.5Z' },
  maverick: { color: '#996633', ink: '#FFFFFF', d: 'M3.5 17.5h5c2.8 0 4.4-1.9 5.6-4.6L17.6 6M13.9 5.6l3.9.2.3 3.9M12.5 17.5h1.6M17.4 17.5h1.6' },
  allrounder: { color: '#808183', ink: '#FFFFFF', d: `M12 3.5l2.2 6.3 6.3 2.2-6.3 2.2L12 20.5l-2.2-6.3L3.5 12l6.3-2.2Z${circle(12, 12, 1.4)}` },
};

export function archetypeMark(id) {
  return ARCHETYPE_MARKS[id] || ARCHETYPE_MARKS.allrounder;
}

export function archetypeIconSvg(id, cls = 'lq-mark') {
  const m = archetypeMark(id);
  return `<span class="${cls}" style="--mark:${m.color};--mark-ink:${m.ink}" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="${m.d}"/></svg></span>`;
}
