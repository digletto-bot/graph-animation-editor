/**
 * Splitting a colour into the two halves the inspector edits separately.
 *
 * `<input type="color">` has no notion of alpha — it only ever reads and writes
 * `#rrggbb` — so a translucent background is stored as an 8-digit hex string
 * and edited as a swatch plus an opacity slider. Canvas takes `#rrggbbaa`
 * directly, so nothing downstream has to know this happened.
 */

export interface SplitColor {
  /** Always `#rrggbb`, the form a colour input can display. */
  hex: string;
  /** 0..1. Anything the parser cannot read is treated as fully opaque. */
  alpha: number;
}

const HEX = /^#([0-9a-f]{3,8})$/i;

/**
 * Reads a stored colour into a swatch value and an opacity.
 *
 * Only hex is understood, because that is what the editor writes. A file
 * hand-edited to `rgba(...)` or a named colour still renders — the renderer
 * passes the string straight to canvas — it simply reports as opaque here, and
 * the first swatch edit rewrites it into hex.
 */
export function splitColor(value: string, fallback = '#000000'): SplitColor {
  const match = HEX.exec(value.trim());
  if (!match) return { hex: fallback, alpha: 1 };

  const digits = match[1]!;
  // #rgb and #rgba are shorthand: each digit stands for a doubled pair.
  const expand = (source: string) =>
    source.length <= 4
      ? source
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : source;
  const full = expand(digits);
  if (full.length !== 6 && full.length !== 8) return { hex: fallback, alpha: 1 };

  const hex = `#${full.slice(0, 6).toLowerCase()}`;
  const alpha = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1;
  return { hex, alpha };
}

/**
 * Puts the two halves back together.
 *
 * A fully opaque colour keeps the plain 6-digit form, so a project that never
 * touches transparency serialises exactly as it did before.
 */
export function joinColor(hex: string, alpha: number): string {
  const clamped = Math.min(1, Math.max(0, alpha));
  if (clamped >= 1) return hex;
  const byte = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${byte}`;
}
