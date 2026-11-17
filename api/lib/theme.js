'use strict';

// Site design: colors, fonts, shapes and logo. The default theme reproduces the original design
// exactly, in which case no extra stylesheet is added to the page.

const palette = require('./palette');

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
const COLOR_KEYS = palette.COLOR_KEYS;
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
  darkMode: 'auto',
  // null: made automatically from the light colors.
  darkColors: null,
});

// ---------- Contrast (WCAG 2.x) and dark colors: shared with the admin portal ----------

const { HEX, contrast, onPrimary, contrastChecks, deriveDark, footerBackground, rgba } = palette;

// "auto": dark when the visitor's device is set to dark, with a switch button on the page.
const DARK_MODES = { auto: 'On (follows each visitor\'s device, with a switch button)', off: 'Off (always light)' };

// The dark palette in use: the admin's own colors, or one made from the light colors.
const darkPalette = (theme) => theme.darkColors || deriveDark(theme.colors);

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
  theme.darkMode = pick(input.darkMode, DARK_MODES, DEFAULT_THEME.darkMode, 'Dark mode');
  if (input.darkColors && typeof input.darkColors === 'object') {
    // Any color left out is taken from the automatic dark palette.
    const dark = deriveDark(theme.colors);
    for (const key of COLOR_KEYS) {
      if (input.darkColors[key] === undefined) continue;
      const value = String(input.darkColors[key]).trim().toLowerCase();
      if (!HEX.test(value)) errors.push(`Dark mode, ${COLOR_LABELS[key].toLowerCase()}: choose a color.`);
      else dark[key] = value;
    }
    theme.darkColors = dark;
  } else if (input.darkColors !== undefined && input.darkColors !== null) {
    errors.push('Dark mode colors: invalid value.');
  }
  if (!errors.length) {
    for (const check of contrastChecks(theme.colors)) {
      if (!check.ok) errors.push(`Colors are hard to read: ${check.label.toLowerCase()} has a contrast of ${check.ratio}:1 (needs at least ${check.min}:1).`);
    }
    // Only colors chosen by hand are checked: the automatic dark palette is built to pass.
    if (theme.darkColors && theme.darkMode !== 'off') {
      for (const check of contrastChecks(theme.darkColors, true)) {
        if (!check.ok) errors.push(`Dark mode colors are hard to read: ${check.label.toLowerCase()} has a contrast of ${check.ratio}:1 (needs at least ${check.min}:1).`);
      }
    }
  }
  return { theme, errors };
}

// The logo and the dark-mode switch need no stylesheet: they are part of the page itself.
const isDefaultLook = (theme) => JSON.stringify({ ...theme, logo: '', darkMode: 'auto' }) === JSON.stringify({ ...DEFAULT_THEME, logo: '', darkMode: 'auto' });

// ---------- Stylesheet ----------

// Dark mode applies when the visitor's device is dark (before the page script has run, or without
// it), or when the switch button chose dark. data-dark="off" on <html> turns it off completely.
const DARK_AUTO = ':root:not([data-color-mode]):not([data-dark="off"])';
const DARK_ON = ':root[data-color-mode="dark"]:not([data-dark="off"])';

function darkVariables(d, indent) {
  return [
    'color-scheme: dark;',
    `--cream: ${d.background};`,
    `--white: ${d.surface};`,
    `--tint: ${d.tint};`,
    `--hero-end: ${d.tint};`,
    `--pink: ${d.accentSoft};`,
    `--pink-strong: ${d.primary};`,
    `--pink-dark: ${d.primaryDark};`,
    `--cocoa: ${d.text};`,
    `--cocoa-soft: ${d.textSoft};`,
    `--on-primary: ${onPrimary(d, true)};`,
    `--footer-bg: ${footerBackground(d)};`,
    `--footer-text: ${d.text};`,
    `--footer-link: ${d.primaryDark};`,
    `--line: ${rgba(d.text, 0.12)};`,
    `--header-bg: ${rgba(d.background, 0.92)};`,
    `--input-border: ${rgba(d.text, 0.22)};`,
    `--focus-ring: ${rgba(d.primary, 0.3)};`,
    '--shadow: 0 10px 30px rgba(0, 0, 0, 0.35);',
    '--success: #7fd6a0;',
  ].map((line) => indent + line).join('\n');
}

// The dark-mode rules for a palette. site/styles.css contains this block for the default design.
function darkCss(dark) {
  return `@media (prefers-color-scheme: dark) {
  ${DARK_AUTO} {
${darkVariables(dark, '    ')}
  }
}
${DARK_ON} {
${darkVariables(dark, '  ')}
}
`;
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
${darkCss(darkPalette(theme))}`;
}

module.exports = {
  FONTS, CORNERS, BUTTONS, COLOR_KEYS, COLOR_LABELS, PRESETS, DEFAULT_THEME, DARK_MODES,
  contrast, contrastChecks, onPrimary, deriveDark, darkPalette, darkCss, normalizeTheme, themeCss, isDefaultLook,
};
