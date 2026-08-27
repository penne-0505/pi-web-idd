// intent: 文字は rem (画面密度や OS 設定に追従させる)、レイアウトは px (階段を保つ)。
// html の font-size は 16px なので 1rem = 16px。WQHD で小さすぎたため基準ごと上げている。

export const FS = {
  /** 補助の補助 (envelope の生値など) */
  xxs: "0.75rem",   // = 12px
  /** 参照 chip / ID / 時刻 */
  xs: "0.8125rem",  // = 13px
  /** section 見出し / 表の項目名 */
  sm: "0.875rem",   // = 14px
  /** 本文 (選択肢・条件・DEC) */
  md: "1rem",       // = 16px
  /** card の主題 / ボタン */
  lg: "1.125rem",   // = 18px
  /** 画面の見出し */
  xl: "1.375rem",   // = 22px
  /** lane detail の title */
  xxl: "1.625rem",  // = 26px
} as const;

/** 行の高さ。タップの下限は 44px を維持する。 */
export const SIZE = {
  tap: 48,
  tapQuiet: 44,
  iconButton: 42,
  laneRow: 68,
  /** 判断面の幅の上限。広い画面でも行長を伸ばさず中央に置く。 */
  readWidth: 1040,
} as const;
