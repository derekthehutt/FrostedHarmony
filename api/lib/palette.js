'use strict';

// Color math shared by the server (api/lib/theme.js) and the admin portal's Design editor, which
// loads this same file from /api/admin/palette.js. Keeping one copy means the live checks in the
// editor always match what the server enforces when saving.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FHPalette = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const COLOR_KEYS = ['background', 'surface', 'tint', 'accentSoft', 'primary', 'primaryDark', 'text', 'textSoft'];
  const HEX = /^#[0-9a-f]{6}$/;

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const toHex = (values) => `#${values.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

  // ---------- Contrast (WCAG 2.x) ----------

  function luminance(hex) {
    const [r, g, b] = rgb(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  // Text on buttons: white, or the most contrasting page color (main text in light mode, the page
  // background in dark mode), whichever reads better.
  function onPrimary(colors, dark = false) {
    const other = dark ? colors.background : colors.text;
    return contrast('#ffffff', colors.primary) >= contrast(other, colors.primary) ? '#ffffff' : other;
  }

  // ---------- HSL ----------

  function toHsl(hex) {
    const [r, g, b] = rgb(hex).map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }

  function fromHsl(h, s, l) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return toHex([f(0), f(8), f(4)].map((v) => v * 255));
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Raises the lightness until the color reaches the contrast target against every background.
  function lightEnough(h, s, l, backgrounds, target) {
    let lightness = l;
    let color = fromHsl(h, s, lightness);
    while (lightness < 0.98 && backgrounds.some((bg) => contrast(color, bg) < target)) {
      lightness += 0.01;
      color = fromHsl(h, s, lightness);
    }
    return color;
  }

  // A dark version of a light palette: near-black backgrounds tinted with the button color, and
  // lighter versions of the accent colors so they stay readable on them.
  function deriveDark(colors) {
    const [h, s] = toHsl(colors.primary);
    // A gray button color gets plain gray backgrounds rather than an arbitrary tint.
    const gray = s < 0.05;
    const bgSat = gray ? 0 : clamp(s * 0.35, 0.05, 0.22);
    const background = fromHsl(h, bgSat, 0.09);
    const surface = fromHsl(h, bgSat, 0.135);
    const tint = fromHsl(h, bgSat, 0.115);
    const accentSat = gray ? 0 : clamp(s, 0.3, 0.75);
    return {
      background,
      surface,
      tint,
      accentSoft: fromHsl(h, gray ? 0 : clamp(s * 0.5, 0.1, 0.4), 0.3),
      primary: lightEnough(h, accentSat, 0.62, [background], 4.5),
      primaryDark: lightEnough(h, accentSat, 0.76, [background, surface, tint], 4.5),
      text: lightEnough(h, gray ? 0 : 0.2, 0.92, [background, surface, tint], 7),
      textSoft: lightEnough(h, gray ? 0 : 0.12, 0.72, [background, surface, tint], 4.5),
    };
  }

  // The footer sits on a slightly darker strip than the page in dark mode.
  function footerBackground(dark) {
    const [h, s, l] = toHsl(dark.background);
    return fromHsl(h, s, l * 0.65);
  }

  // Body text needs 4.5:1 (WCAG AA). Buttons are bold controls: 3:1 is the minimum, under 4.5 earns a warning.
  function contrastChecks(colors, dark = false) {
    const btn = onPrimary(colors, dark);
    const footer = dark
      ? [['Footer text', colors.text, footerBackground(colors)], ['Footer links', colors.primaryDark, footerBackground(colors)]]
      : [['Footer text', colors.background, colors.text], ['Footer links', colors.accentSoft, colors.text]];
    const text = [
      ['Main text on the page background', colors.text, colors.background],
      ['Main text on cards', colors.text, colors.surface],
      ['Secondary text on the page background', colors.textSoft, colors.background],
      ['Secondary text on cards', colors.textSoft, colors.surface],
      ['Secondary text on tinted sections', colors.textSoft, colors.tint],
      ['Accent text on the page background', colors.primaryDark, colors.background],
      ['Accent text on tinted sections', colors.primaryDark, colors.tint],
      ['Accent text on cards', colors.primaryDark, colors.surface],
      ...footer,
    ].map(([label, fg, bg]) => ({ label, ratio: contrast(fg, bg), min: 4.5, kind: 'text' }));
    const buttons = [
      ['Button text', btn, colors.primary],
      ['Button text when hovered', btn, colors.primaryDark],
      ['Outline button on the page background', colors.primary, colors.background],
    ].map(([label, fg, bg]) => ({ label, ratio: contrast(fg, bg), min: 3, recommended: 4.5, kind: 'button' }));
    return [...text, ...buttons].map((c) => ({ ...c, ratio: Math.round(c.ratio * 100) / 100, ok: c.ratio >= c.min }));
  }

  function rgba(hex, alpha) {
    return `rgba(${rgb(hex).join(', ')}, ${alpha})`;
  }

  return { COLOR_KEYS, HEX, luminance, contrast, onPrimary, deriveDark, footerBackground, contrastChecks, rgba };
}));
