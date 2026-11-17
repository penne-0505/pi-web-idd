// 設定: 今の画面に重なるシート（Esc で閉じる）。左に節の一覧、右に中身。
import type { Model } from '../model/model'
import { SettingsBody } from './settings/SettingsBody'
import { SettingsNav } from './settings/SettingsNav'

export function SettingsSheet({ m }: { m: Model }) {
  const { closeSettings, scrimAnim, sheetAnim } = m
  return (
    <>
      <div
        onClick={closeSettings}
        style={{
          position: 'absolute',
          inset: '0',
          background: 'var(--scrim)',
          zIndex: '5',
          animation: scrimAnim,
        }}
      />
      <div
        style={{
          zIndex: '6',
          animation: sheetAnim,
          position: 'absolute',
          left: '120px',
          right: '120px',
          top: '70px',
          bottom: '50px',
          display: 'flex',
          background: 'var(--surface)',
          borderRadius: '14px',
          boxShadow: 'var(--shadow-sheet)',
          overflow: 'hidden',
        }}
      >
        <SettingsNav m={m} />
        <SettingsBody m={m} />
      </div>
    </>
  )
}
