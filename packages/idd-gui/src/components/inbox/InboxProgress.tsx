// The Inbox's progress row: the engine's own today counts (`progress.done` / `progress.open`), drawn as the
// prototype's five bars. No sample count is printed: a door that returned nothing leaves the row empty.
import type { ProgressView } from '../../inbox/viewmodel'

const FILL: Record<ProgressView['segments'][number], string> = {
  ink: 'var(--ink)',
  attn: 'var(--attention)',
  line: 'var(--line-strong)',
}

export function InboxProgress({ progress }: { progress: ProgressView }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      {progress.segments.map((s, i) => (
        <span key={i} style={{ width: '28px', height: '4px', borderRadius: '2px', background: FILL[s] }} />
      ))}
      <span style={{ marginLeft: '10px', font: '500 11.5px var(--font-mono)', color: 'var(--ink-2)' }}>{progress.label}</span>
    </div>
  )
}
