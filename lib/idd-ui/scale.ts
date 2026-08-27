// intent: DEC-602 — 文字は rem (画面に追従)、レイアウトは px (余白の階段を保つ)

export const FS = {
  xxs: "0.75rem",
  xs: "0.8125rem",
  sm: "0.875rem",
  md: "1rem",
  lg: "1.125rem",
  xl: "1.375rem",
  xxl: "1.625rem",
} as const;

export const SIZE = {
  tap: 48,
  tapQuiet: 44,
  iconButton: 42,
  laneRow: 68,
  readWidth: 1040,
} as const;
