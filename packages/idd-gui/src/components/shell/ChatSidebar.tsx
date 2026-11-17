// The conversation list: New chat, the engine's own groups and rows, and the row's own menu. Every heading,
// every name and every mark comes from the list door (DEC-116-1); the delete waits for a second press on the
// same row and only then calls the door (DEC-116-7). The search control opens the find field over the screen
// (the field's own store reads the engine; this row sends nothing by itself).
import { Fragment } from 'react'
import type { Model } from '../../model/model'
import { WORDS } from '../../strings'
import type { ChatRowView } from '../../chat/viewmodel'

function Row({ row }: { row: ChatRowView }) {
  const icon = row.idea
    ? <span style={{ width: '10px', height: '10px', flex: 'none', border: '1.4px solid var(--sign)', transform: 'rotate(45deg) scale(.85)', boxSizing: 'border-box' }} />
    : <span style={{ width: '12px', height: '10px', flex: 'none', border: `1.4px solid ${row.active ? 'var(--ink)' : 'var(--ink-3)'}`, borderRadius: '3px 3px 3px 0', boxSizing: 'border-box' }} />
  return (
    <>
      <div
        onClick={row.select}
        data-row={row.id}
        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '8px', minHeight: '30px', padding: '0 4px 0 8px', borderRadius: '5px', background: row.active && !row.confirming ? 'var(--bg-hover)' : 'transparent', fontWeight: row.active ? '500' : '400' }}
        className={row.active ? undefined : 'hv2'}
      >
        {icon}
        <span style={{ flex: '1', minWidth: '0', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{row.title}</span>
        {row.bookmarked ? (
          <span title={WORDS.chat.row.bookmark} style={{ width: '10px', height: '10px', flex: 'none', border: '1.4px solid var(--ink-3)', borderRadius: '2px 2px 2px 0', boxSizing: 'border-box' }} />
        ) : null}
        {row.pinned ? <span title={WORDS.chat.row.pin} style={{ width: '7px', height: '7px', flex: 'none', borderRadius: '50%', background: 'var(--ink-3)' }} /> : null}
        {row.running ? <span title={WORDS.chat.row.running} style={{ width: '6px', height: '6px', flex: 'none', borderRadius: '50%', background: 'var(--ok)', animation: 'pulse 1.6s infinite' }} /> : null}
        <span
          data-row-menu={row.id}
          title={WORDS.chat.row.menu}
          onClick={(event) => { event.stopPropagation(); row.toggleMenu() }}
          style={{ width: '20px', height: '22px', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '5px', font: '500 13px var(--font-sans)', color: 'var(--ink-3)', cursor: 'pointer' }}
          className="hv7"
        >
          ⋯
        </span>
      </div>
      {row.confirming ? (
        <div data-row-confirm={row.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 8px 5px 30px', font: '400 10.5px var(--font-sans)', color: 'var(--attention-text)' }}>
          {WORDS.chat.row.deleteConfirm}
        </div>
      ) : null}
      {row.menuOpen ? (
        <div data-row-open-menu={row.id} style={{ display: 'flex', flexDirection: 'column', margin: '2px 0 4px 22px', padding: '3px', borderRadius: '7px', background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-pop)' }}>
          <span onClick={(event) => { event.stopPropagation(); row.mark('pin') }} style={{ padding: '4px 8px', borderRadius: '5px', fontSize: '11px', cursor: 'pointer' }} className="hv2">{row.pinned ? WORDS.chat.row.unpin : WORDS.chat.row.pin}</span>
          <span onClick={(event) => { event.stopPropagation(); row.mark('archive') }} style={{ padding: '4px 8px', borderRadius: '5px', fontSize: '11px', cursor: 'pointer' }} className="hv2">{row.archived ? WORDS.chat.row.unarchive : WORDS.chat.row.archive}</span>
          <span onClick={(event) => { event.stopPropagation(); row.mark('bookmark') }} style={{ padding: '4px 8px', borderRadius: '5px', fontSize: '11px', cursor: 'pointer' }} className="hv2">{WORDS.chat.row.bookmark}</span>
          <span data-row-delete={row.id} onClick={(event) => { event.stopPropagation(); row.remove() }} style={{ padding: '4px 8px', borderRadius: '5px', fontSize: '11px', color: 'var(--attention-text)', cursor: 'pointer' }} className="hv10">{WORDS.chat.row.delete}</span>
        </div>
      ) : null}
      {row.error ? <div data-row-error={row.id} style={{ padding: '2px 8px 6px 30px', font: '400 10.5px var(--font-sans)', color: 'var(--attention-text)' }}>{row.error}</div> : null}
    </>
  )
}

export function ChatSidebar({ m }: { m: Model }) {
  const list = m.chat.list
  return (
    <div style={{ flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column', padding: '10px 8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '0 2px 8px' }}>
        <div onClick={list.newChat} data-part="new-chat" style={{ flex: '1', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '0 10px', background: 'var(--ink)', color: 'var(--surface)', borderRadius: '999px', font: '600 12px var(--font-sans)', boxSizing: 'border-box', cursor: 'pointer' }} className="hv3">
          <span style={{ position: 'relative', width: '10px', height: '10px' }}>
            <span style={{ position: 'absolute', left: '0', top: '4.25px', width: '10px', height: '1.5px', background: 'var(--surface)' }} />
            <span style={{ position: 'absolute', left: '4.25px', top: '0', width: '1.5px', height: '10px', background: 'var(--surface)' }} />
          </span>
          {WORDS.chat.newChat}
        </div>
        <span title={WORDS.chat.search} onClick={m.search.open} data-part="chat-search" style={{ position: 'relative', width: '30px', height: '30px', flex: 'none', borderRadius: '7px', boxSizing: 'border-box', cursor: 'pointer' }} className="hv2">
          <span style={{ position: 'absolute', left: '8px', top: '7px', width: '11px', height: '11px', border: '1.6px solid var(--ink-2)', borderRadius: '50%', boxSizing: 'border-box' }} />
          <span style={{ position: 'absolute', left: '18px', top: '17px', width: '6px', height: '1.6px', background: 'var(--ink-2)', transform: 'rotate(45deg)', transformOrigin: 'left center' }} />
        </span>
      </div>
      {list.down ? (
        <div data-part="chat-connection" style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '0 2px 6px', padding: '5px 8px', borderRadius: '7px', background: 'var(--attention-bg)', font: '400 10.5px var(--font-sans)', color: 'var(--attention-text)' }}>
          {WORDS.connection.down}
          <span style={{ flex: '1' }} />
          <span onClick={list.retry} style={{ cursor: 'pointer', textDecoration: 'underline' }}>{WORDS.connection.retryNow}</span>
        </div>
      ) : null}
      {list.receipt ? (
        <div data-part="chat-receipt" style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: '0 2px 6px', font: '400 10.5px var(--font-sans)', color: 'var(--ink-2)' }}>
          <span style={{ flex: '1' }}>{list.receipt}</span>
          <span onClick={list.clearReceipt} style={{ cursor: 'pointer', color: 'var(--ink-3)' }}>×</span>
        </div>
      ) : null}
      <div style={{ flex: '1', minHeight: '0', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '1px', font: '400 12px var(--font-sans)' }}>
        {list.groups.map((group) => (
          <Fragment key={group.key}>
            <div style={{ padding: '8px 8px 4px', font: '500 10px var(--font-sans)', color: 'var(--ink-3)' }}>{group.label}</div>
            {group.rows.map((row) => <Row key={row.id} row={row} />)}
          </Fragment>
        ))}
        {list.empty ? (
          <div data-part="chat-list-empty" style={{ padding: '14px 8px', font: '400 11px/1.6 var(--font-sans)', color: 'var(--ink-2)' }}>
            <div style={{ fontWeight: '600' }}>{WORDS.chat.emptyTitle}</div>
            <div>{WORDS.chat.emptyReason}</div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
