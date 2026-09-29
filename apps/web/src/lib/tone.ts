/**
 * Semantic tones shared by status pills, KPI accents, charts and donuts.
 *
 * Two representations of the same six tones: literal hex for SVG (Recharts and
 * the donut render fills that do not resolve `var(--…)` reliably), and CSS
 * variable references for text and borders. Both are kept in step with the
 * token file by hand, and the hex values are exactly those the tokens define.
 */
export type Tone = 'neutral' | 'primary' | 'info' | 'success' | 'warning' | 'danger';

export const TONE_HEX: Record<Tone, string> = {
  neutral: '#8c98ad',
  primary: '#2563eb',
  info: '#06b6d4',
  success: '#059669',
  warning: '#ea580c',
  danger: '#dc2626',
};

/** Text colour for a tone, as a CSS variable reference. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'var(--color-text-strong)',
  primary: 'var(--color-primary-700)',
  info: 'var(--color-info-600)',
  success: 'var(--color-success-700)',
  warning: 'var(--color-warning-700)',
  danger: 'var(--color-danger-700)',
};
