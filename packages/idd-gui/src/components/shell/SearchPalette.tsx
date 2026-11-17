// 上部の探す欄: ⌘K で開き、語で会話を探す。題で当たればその会話を、題で 0 件なら ↵ で本文まで探し、
// それでも無ければ A4 の空の状態（本文まで探す・この言葉で New chat）を出す。見た目と語は prototype の
// A4 と収束版の上部の欄に従い、値は engine の口の応答だけから取る（C-154-4, C-173-1）。
import type { Model } from '../../model/model'
import type { SearchView } from '../../search/view'

const ROW = (active: boolean) => ({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '6px 8px',
  borderRadius: '6px',
  font: '400 12px var(--font-sans)',
  cursor: 'pointer',
  background: active ? 'var(--bg-hover)' : 'transparent',
  whiteSpace: 'nowrap' as const,
  overflow: 'hidden',
  textOverflow: 'ellipsis' as const,
})

/** the body stage's one conversation: its title and, under it, each entry that held the word */
function HitRow({ row }: { row: SearchView['hits'][number] }) {
  return (
    <div data-part="search-hit" data-search-hit={row.id} onClick={row.select} style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '7px 8px', borderRadius: '6px', cursor: 'pointer', background: row.active ? 'var(--bg-hover)' : 'transparent' }}>
      <span style={{ font: '500 12px var(--font-sans)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.title}</span>
      {row.hits.map((hit, index) => (
        <span key={index} style={{ font: '400 11px/1.5 var(--font-sans)', color: 'var(--ink-2)' }}>
          <span style={{ font: '500 9.5px var(--font-sans)', color: 'var(--ink-3)', marginRight: '6px' }}>{hit.role}</span>
          {hit.excerpt}
        </span>
      ))}
    </div>
  )
}

/** the prototype A4's empty state: the two buttons its drawing holds */
function NotFound({ search }: { search: SearchView }) {
  const { labels } = search
  return (
    <div data-part="search-not-found" style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '22px 16px 18px', alignItems: 'center', textAlign: 'center' }}>
      <span style={{ font: '600 12.5px var(--font-sans)' }}>{labels.notFoundHeading}</span>
      <span style={{ font: '400 11px var(--font-sans)', color: 'var(--ink-2)' }}>{labels.titleOnly}</span>
      <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
        <span data-part="search-body-button" onClick={search.searchBody} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '7px', background: 'var(--ink)', color: 'var(--surface)', font: '600 11.5px var(--font-sans)', cursor: 'pointer' }}>
          {labels.bodySearch}
          <span style={{ padding: '0 4px', border: '1px solid var(--line-strong)', borderBottomWidth: '2px', borderRadius: '3px', font: '500 9.5px/14px var(--font-mono)', color: 'var(--ink-2)' }}>↵</span>
        </span>
        <span data-part="search-new-chat" onClick={search.newChat} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '7px', background: 'var(--surface)', border: '1px solid var(--line-strong)', font: '500 11.5px var(--font-sans)', cursor: 'pointer' }}>
          {labels.newChat}
        </span>
      </div>
    </div>
  )
}

function Body({ search }: { search: SearchView }) {
  const { labels } = search
  if (search.bodyBusy) {
    return <div data-part="search-busy" style={{ padding: '22px 16px', textAlign: 'center', font: '400 11.5px var(--font-sans)', color: 'var(--ink-2)' }}>{labels.loading}</div>
  }
  if (search.bodyError) {
    return <div data-part="search-error" style={{ padding: '22px 16px', textAlign: 'center', font: '400 11.5px/1.6 var(--font-sans)', color: 'var(--attention-text)' }}>{search.bodyError}</div>
  }
  if (search.bodyShown) {
    if (search.bodyEmpty) {
      return <div data-part="search-body-empty" style={{ padding: '22px 16px', textAlign: 'center', font: '400 11.5px var(--font-sans)', color: 'var(--ink-2)' }}>{labels.bodyEmpty}</div>
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
        {search.hits.map((row) => <HitRow key={row.id} row={row} />)}
        {search.bodyTruncated ? <div data-part="search-truncated" style={{ padding: '8px', font: '400 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>{labels.bodyTruncated}</div> : null}
      </div>
    )
  }
  if (search.notFound) return <NotFound search={search} />
  if (search.rows.length) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
        {search.rows.map((row) => (
          <div key={row.id} data-part="search-row" data-search-row={row.id} onClick={row.select} style={ROW(row.active)}>{row.name}</div>
        ))}
      </div>
    )
  }
  if (search.candidatesBusy) {
    return <div data-part="search-busy" style={{ padding: '22px 16px', textAlign: 'center', font: '400 11.5px var(--font-sans)', color: 'var(--ink-2)' }}>{labels.loading}</div>
  }
  if (search.candidatesDown) {
    return <div data-part="search-error" style={{ padding: '22px 16px', textAlign: 'center', font: '400 11.5px var(--font-sans)', color: 'var(--attention-text)' }}>{labels.listDown}</div>
  }
  return null
}

export function SearchPalette({ m }: { m: Model }) {
  const search = m.search
  if (!search.shown) return null
  return (
    <div data-part="search-scrim" onMouseDown={search.close} style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'var(--scrim)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
      <div data-part="search-panel" onMouseDown={(event) => event.stopPropagation()} style={{ width: '400px', marginTop: '40px', background: 'var(--surface)', borderRadius: '10px', boxShadow: 'var(--shadow-pop)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '40px', padding: '0 14px', borderBottom: '1px solid var(--line-soft)' }}>
          <span style={{ position: 'relative', width: '10px', height: '10px', flex: 'none' }}>
            <span style={{ position: 'absolute', inset: 0, border: '1.5px solid var(--ink-2)', borderRadius: '50%', boxSizing: 'border-box' }} />
            <span style={{ position: 'absolute', left: '9px', top: '9px', width: '5px', height: '1.5px', background: 'var(--ink-2)', transform: 'rotate(45deg)', transformOrigin: 'left center' }} />
          </span>
          <input
            data-part="search-input"
            autoFocus
            value={search.query}
            placeholder={search.labels.placeholder}
            onChange={(event) => search.setQuery(event.target.value)}
            style={{ flex: '1', minWidth: '0', border: 'none', outline: 'none', background: 'transparent', font: '400 12.5px var(--font-sans)', color: 'var(--ink)' }}
          />
        </div>
        <div data-part="search-body" style={{ padding: '8px', maxHeight: '440px', overflow: 'auto' }}>
          <Body search={search} />
        </div>
      </div>
    </div>
  )
}
