'use strict';

// Site design: colors, fonts, shapes and logo. The default theme reproduces the original design
// exactly, in which case no extra stylesheet is added to the page.

const FONTS = {
  heading: {
    georgia: { label: 'Georgia (classic serif)', stack: 'Georgia, "Times New Roman", serif', weight: 700 },
    playfair: { label: 'Playfair Display (elegant)', stack: '"Playfair Display", Georgia, serif', weight: 700, file: 'playfair-display', variable: true },
    'dm-serif': { label: 'DM Serif Display (bold, modern)', stack: '"DM Serif Display", Georgia, serif', weight: 400, file: 'dm-serif-display' },
    lora: { label: 'Lora (warm, friendly)', stack: 'Lora, Georgia, serif', weight: 700, file: 'lora', variable: true },
    pacifico: { label: 'Pacifico (playful script)', stack: 'Pacifico, "Brush Script MT", cursive', weight: 400, file: 'pacifico' },
  },
  body: {
    system: { label: 'System default (clean)', stack: '"Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif' },
    nunito: { label: 'Nunito (rounded, soft)', stack: 'Nunito, "Segoe UI", system-ui, sans-serif', file: 'nunito', variable: true },
    'open-sans': { label: 'Open Sans (very readable)', stack: '"Open Sans", "Segoe UI", system-ui, sans-serif', file: 'open-sans', variable: true },
    'source-sans': { label: 'Source Sans 3 (crisp)', stack: '"Source Sans 3", "Segoe UI", system-ui, sans-serif', file: 'source-sans-3', variable: true },
  },
};
const FONT_FAMILIES = { playfair: 'Playfair Display', 'dm-serif': 'DM Serif Display', lora: 'Lora', pacifico: 'Pacifico', nunito: 'Nunito', 'open-sans': 'Open Sans', 'source-sans': 'Source Sans 3' };

const CORNERS = { subtle: '8px', soft: '16px', round: '24px', square: '3px' };
const BUTTONS = { pill: '999px', rounded: '12px', square: '4px' };
const COLOR_KEYS = ['background', 'surface', 'tint', 'accentSoft', 'primary', 'primaryDark', 'text', 'textSoft'];
const COLOR_LABELS = {
  background: 'Page background', surface: 'Cards and form', tint: 'Tinted sections', accentSoft: 'Soft accent (card edges, footer links)',
  primary: 'Buttons', primaryDark: 'Accent text (small headings, links, prices)', text: 'Main text (also the footer)', textSoft: 'Secondary text',
};

const PRESETS = {
  strawberry: { label: 'Strawberry (original)', colors: { background: '#fff8f2', surface: '#ffffff', tint: '#fdeef1', accentSoft: '#f7c6d0', primary: '#d94f6b', primaryDark: '#b83a55', text: '#4a2c2a', textSoft: '#6e5450' } },
  'strawberry-strong': { label: 'Strawberry, stronger buttons (easier to read)', colors: { background: '#fff8f2', surface: '#ffffff', tint: '#fdeef1', accentSoft: '#f7c6d0', primary: '#c8435f', primaryDark: '#9e2f48', text: '#4a2c2a', textSoft: '#6e5450' } },
  lavender: { label: 'Lavender', colors: { background: '#faf7fd', surface: '#ffffff', tint: '#f1eafa', accentSoft: '#d9c8f0', primary: '#7b4fb3', primaryDark: '#5e3a8c', text: '#2f2440', textSoft: '#5a4e6b' } },
  mint: { label: 'Mint', colors: { background: '#f6fbf8', surface: '#ffffff', tint: '#e6f4ec', accentSoft: '#b9e0c9', primary: '#2a7d55', primaryDark: '#1d5a3d', text: '#1f3a2e', textSoft: '#4a6357' } },
  chocolate: { label: 'Chocolate', colors: { background: '#fbf6f1', surface: '#ffffff', tint: '#f3e7dc', accentSoft: '#e2c9b0', primary: '#8a5a3c', primaryDark: '#6b4229', text: '#3b2418', textSoft: '#6b5244' } },
  lemon: { label: 'Lemon', colors: { background: '#fffdf3', surface: '#ffffff', tint: '#fff6cc', accentSoft: '#f6e27a', primary: '#9a6c00', primaryDark: '#7a5500', text: '#3d3418', textSoft: '#665c3a' } },
};

const DEFAULT_THEME = Object.freeze({
  colors: { ...PRESETS.strawberry.colors },
  headingFont: 'georgia',
  bodyFont: 'system',
  corners: 'soft',
  buttons: 'pill',
  logo: '',
});

// ---------- Contrast (WCAG 2.x) ----------

const HEX = /^#[0-9a-f]{6}$/;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
// Text on buttons is white or the main text color, whichever reads better.
const onPrimary = (colors) => (contrast('#ffffff', colors.primary) >= contrast(colors.text, colors.primary) ? '#ffffff' : colors.text);

// Body text needs 4.5:1 (WCAG AA). Buttons are bold controls: 3:1 is the minimum, under 4.5 earns a warning.
function contrastChecks(colors) {
  const btn = onPrimary(colors);
  const text = [
    ['Main text on the page background', colors.text, colors.background],
    ['Main text on cards', colors.text, colors.surface],
    ['Secondary text on the page background', colors.textSoft, colors.background],
    ['Secondary text on cards', colors.textSoft, colors.surface],
    ['Secondary text on tinted sections', colors.textSoft, colors.tint],
    ['Accent text on the page background', colors.primaryDark, colors.background],
    ['Accent text on tinted sections', colors.primaryDark, colors.tint],
    ['Accent text on cards', colors.primaryDark, colors.surface],
    ['Footer text', colors.background, colors.text],
    ['Footer links', colors.accentSoft, colors.text],
  ].map(([label, fg, bg]) => ({ label, ratio: contrast(fg, bg), min: 4.5, kind: 'text' }));
  const buttons = [
    ['Button text', btn, colors.primary],
    ['Button text when hovered', btn === '#ffffff' ? '#ffffff' : colors.text, colors.primaryDark],
    ['Outline button on the page background', colors.primary, colors.background],
  ].map(([label, fg, bg]) => ({ label, ratio: contrast(fg, bg), min: 3, recommended: 4.5, kind: 'button' }));
  return [...text, ...buttons].map((c) => ({ ...c, ratio: Math.round(c.ratio * 100) / 100, ok: c.ratio >= c.min }));
}

// ---------- Validation ----------

// Returns { theme, errors }. photoRef validates the logo like any other photo reference.
function normalizeTheme(raw, photoRef) {
  const errors = [];
  const input = raw && typeof raw === 'object' ? raw : {};
  const theme = JSON.parse(JSON.stringify(DEFAULT_THEME));
  const colors = input.colors && typeof input.colors === 'object' ? input.colors : {};
  for (const key of COLOR_KEYS) {
    if (colors[key] === undefined) continue;
    const value = String(colors[key]).trim().toLowerCase();
    if (!HEX.test(value)) errors.push(`${COLOR_LABELS[key]}: choose a color.`);
    else theme.colors[key] = value;
  }
  const pick = (value, allowed, fallback, label) => {
    if (value === undefined) return fallback;
    if (Object.prototype.hasOwnProperty.call(allowed, value)) return value;
    errors.push(`${label}: unknown choice.`);
    return fallback;
  };
  theme.headingFont = pick(input.headingFont, FONTS.heading, DEFAULT_THEME.headingFont, 'Heading font');
  theme.bodyFont = pick(input.bodyFont, FONTS.body, DEFAULT_THEME.bodyFont, 'Text font');
  theme.corners = pick(input.corners, CORNERS, DEFAULT_THEME.corners, 'Corners');
  theme.buttons = pick(input.buttons, BUTTONS, DEFAULT_THEME.buttons, 'Button shape');
  theme.logo = photoRef ? photoRef(input.logo, 'Logo') : '';
  if (!errors.length) {
    for (const check of contrastChecks(theme.colors)) {
      if (!check.ok) errors.push(`Colors are hard to read: ${check.label.toLowerCase()} has a contrast of ${check.ratio}:1 (needs at least ${check.min}:1).`);
    }
  }
  return { theme, errors };
}

const isDefaultLook = (theme) => JSON.stringify({ ...theme, logo: '' }) === JSON.stringify({ ...DEFAULT_THEME, logo: '' });

// ---------- Stylesheet ----------

function rgba(hex, alpha) {
  return `rgba(${rgb(hex).join(', ')}, ${alpha})`;
}

// A stylesheet that overrides the CSS variables in site/styles.css. Only built from validated values.
function themeCss(theme) {
  if (isDefaultLook(theme)) return null;
  const c = theme.colors;
  const heading = FONTS.heading[theme.headingFont];
  const body = FONTS.body[theme.bodyFont];
  const faces = [];
  for (const key of [theme.headingFont, theme.bodyFont]) {
    const font = FONTS.heading[key] || FONTS.body[key];
    if (!font.file || faces.some((f) => f.includes(`/fonts/${font.file}.woff2`))) continue;
    faces.push(`@font-face {
  font-family: "${FONT_FAMILIES[key]}";
  src: url("/fonts/${font.file}.woff2") format("woff2");
  font-weight: ${font.variable ? '300 900' : '400'};
  font-style: normal;
  font-display: swap;
}`);
  }
  return `/* Generated by the admin portal. */
${faces.join('\n')}
:root {
  --cream: ${c.background};
  --white: ${c.surface};
  --tint: ${c.tint};
  --hero-end: ${c.tint};
  --pink: ${c.accentSoft};
  --pink-strong: ${c.primary};
  --pink-dark: ${c.primaryDark};
  --cocoa: ${c.text};
  --cocoa-soft: ${c.textSoft};
  --on-primary: ${onPrimary(c)};
  --footer-text: ${c.background};
  --line: ${rgba(c.text, 0.08)};
  --header-bg: ${rgba(c.background, 0.95)};
  --input-border: ${rgba(c.text, 0.18)};
  --focus-ring: ${rgba(c.primary, 0.18)};
  --shadow: 0 10px 30px ${rgba(c.text, 0.08)};
  --radius: ${CORNERS[theme.corners]};
  --button-radius: ${BUTTONS[theme.buttons]};
  --serif: ${heading.stack};
  --heading-weight: ${heading.weight};
  --sans: ${body.stack};
}
`;
}

module.exports = {
  FONTS, CORNERS, BUTTONS, COLOR_KEYS, COLOR_LABELS, PRESETS, DEFAULT_THEME,
  contrast, contrastChecks, onPrimary, normalizeTheme, themeCss, isDefaultLook,
};
