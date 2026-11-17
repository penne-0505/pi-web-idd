// Storage: what `/api/idd/storage` measured — the free space, the sizes, the next candidates and what was kept.
// The door walks the same judgment the sweep walks and deletes nothing, so this section only looks: it carries
// no button that removes or sweeps anything (C-171-3). While the door is measuring, it shows that it is
// measuring and no number is made up (AC-003, DEC-103-2). The rows the engine has no door for (Location, the FTS
// index, Retention, BTW, Export, Delete all) are not drawn (C-171-2).
import type { Model } from '../../model/model'
import { WORDS } from '../../strings'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <span style={{ font: '600 11px var(--font-sans)', color: 'var(--ink-2)' }}>{title}</span>
      <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden' }}>{children}</div>
    </div>
  )
}

function Row({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '14px', minHeight: '44px', padding: '8px 14px', borderBottom: last ? undefined : '1px solid var(--bg-sidebar)', boxSizing: 'border-box' }}>
      {children}
    </div>
  )
}

function Main({ title, note }: { title: string; note: string }) {
  return (
    <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }}>
      <span style={{ font: '500 12.5px var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      {note ? <span style={{ font: '400 11px var(--font-sans)', color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note}</span> : null}
    </div>
  )
}

function Value({ children, attention }: { children: React.ReactNode; attention?: boolean }) {
  return <span style={{ flex: 'none', font: '400 11.5px var(--font-mono)', color: attention ? 'var(--attention-text)' : 'var(--ink-2)' }}>{children}</span>
}

export function SettingsStorage({ m }: { m: Model }) {
  const { secConv, set } = m
  const { storage } = set
  return (
    <>
      {secConv ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', animation: 'pfade 120ms both' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              onClick={storage.read}
              data-settings-storage-read
              style={{ padding: '5px 11px', borderRadius: '6px', border: '1px solid var(--line-strong)', background: 'var(--surface)', font: '500 11.5px var(--font-sans)', color: 'var(--ink)', cursor: 'pointer' }}
              className="hv7"
            >
              {storage.loaded ? storage.readLabel : WORDS.settings.storage.read}
            </span>
            {storage.measuring ? <span data-settings-storage-measuring style={{ font: '400 11.5px var(--font-sans)', color: 'var(--ink-2)' }}>{WORDS.settings.storage.measuring}</span> : null}
            {storage.loaded && !storage.measuring ? <span style={{ font: '400 11px var(--font-sans)', color: 'var(--ink-3)' }}>{storage.measuredAt}</span> : null}
          </div>
          {storage.error ? <span data-settings-error style={{ font: '400 11.5px var(--font-sans)', color: 'var(--attention-text)' }}>{storage.error}</span> : null}

          {storage.filesystems.length ? (
            <Section title={WORDS.settings.storage.filesystems}>
              {storage.filesystems.map((fs, index) => (
                <Row key={fs.key} last={index === storage.filesystems.length - 1}>
                  <Main title={fs.label} note={fs.key} />
                  <Value attention={fs.below}>{WORDS.settings.storage.free(fs.free, fs.total)}</Value>
                  <span style={{ flex: 'none', font: '400 11px var(--font-sans)', color: fs.below ? 'var(--attention-text)' : 'var(--ink-3)' }}>{fs.below ? WORDS.settings.storage.below : fs.threshold}</span>
                </Row>
              ))}
            </Section>
          ) : null}

          {storage.places.length ? (
            <Section title={WORDS.settings.storage.places}>
              {storage.places.map((place, index) => (
                <Row key={place.key} last={index === storage.places.length - 1}>
                  <Main title={place.label} note={place.note ?? place.key} />
                  <Value>{place.bytes}</Value>
                  <span style={{ flex: 'none', font: '400 11px var(--font-mono)', color: 'var(--ink-3)' }}>{place.count}</span>
                  {place.cleanup ? <span style={{ flex: 'none', padding: '1px 7px', borderRadius: '4px', background: 'var(--line-soft)', font: '500 10px var(--font-sans)', color: 'var(--ink-2)' }}>{place.cleanup}</span> : null}
                </Row>
              ))}
            </Section>
          ) : null}

          {storage.candidates.length ? (
            <Section title={WORDS.settings.storage.candidates}>
              {storage.candidates.map((candidate, index) => (
                <Row key={candidate.key} last={index === storage.candidates.length - 1}>
                  <Main title={candidate.label} note={candidate.key} />
                  <Value>{candidate.bytes}</Value>
                  <span style={{ flex: 'none', font: '400 11px var(--font-mono)', color: 'var(--ink-3)' }}>{candidate.count}</span>
                </Row>
              ))}
              <Row last>
                <Main title={WORDS.settings.storage.candidates} note="" />
                <Value>{storage.candidatesTotal}</Value>
              </Row>
            </Section>
          ) : null}

          {storage.kept.length ? (
            <Section title={WORDS.settings.storage.kept}>
              {storage.kept.map((kept, index) => (
                <Row key={kept.key} last={index === storage.kept.length - 1 && storage.keptMore === 0}>
                  <Main title={kept.path} note={[kept.label, kept.lane].filter(Boolean).join(' · ')} />
                  <Value>{kept.reason}</Value>
                </Row>
              ))}
              {storage.keptMore > 0 ? (
                <Row last>
                  <Main title={WORDS.settings.storage.keptMore(storage.keptMore)} note="" />
                </Row>
              ) : null}
            </Section>
          ) : null}

          {storage.loaded ? (
            <Section title={WORDS.settings.storage.lastSweep}>
              <Row>
                <Main title={storage.cleanup} note="" />
              </Row>
              <Row last={!storage.held && !storage.archive}>
                <Main title={WORDS.settings.storage.lastSweep} note="" />
                <Value>{storage.lastSweep}</Value>
              </Row>
              {storage.held ? (
                <Row last={!storage.archive}>
                  <Main title={storage.held} note="" />
                </Row>
              ) : null}
              {storage.archive ? (
                <Row last>
                  <Main title={storage.archive} note="" />
                </Row>
              ) : null}
            </Section>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
