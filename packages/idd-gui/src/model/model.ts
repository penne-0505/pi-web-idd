// The ported `Component`'s state machine and the parts of its flat view model that are not Work. The Work half
// is written from the engine's doors in `src/work/viewmodel.ts`, the Inbox's in `src/inbox/viewmodel.ts` and the
// conversation's in `src/chat/viewmodel.ts`; the settings sheet and the card transition keep the ported shapes.
// `buildModel` assembles them into the one flat object the ported components read.
import { type CardKind, type View } from './data'
import { workVals, type WorkSource } from '../work/viewmodel'
import { inboxVals, type InboxHandlers, type InboxUi } from '../inbox/viewmodel'
import type { StoreState } from '../inbox/useDecide'
import type { Intent } from '../inbox/keymap'
import { chatVals, type ChatHandlers, type ChatScreenView, type ChatUi, type ConsultView } from '../chat/viewmodel'
import { conversationSettingsVals, type ConversationSettingsHandlers } from '../chat/settings'
import type { SideState } from '../chat/side'
import type { ChatStoreState } from '../chat/store'
import { searchVals, type SearchHandlers, type SearchView } from '../search/view'
import type { ChatSearchState } from '../search/store'
import { settingsVals, type SettingsHandlers, type SettingsUi } from '../settings/viewmodel'
import type { SettingsStoreState } from '../settings/store'

export interface Props {
  startView?: View
  /** the id of the Inbox card the URL named, to bring to the front once the engine's state has it */
  inboxCard?: string
  /** `stream` keeps answering inline, `branch` saves the answer as a thread. */
  keepAsk?: 'stream' | 'branch'
  /** the lane the URL named when the screen opened */
  startLane?: string | null
  /** whether the URL said the full band was open */
  startAll?: boolean
}

export interface State {
  view: View
  tab: string
  open: Record<string, boolean>
  left: boolean
  right: boolean
  card: 'idle' | 'out' | 'in'
  cardDir: 'l' | 'r' | 'd'
  k?: CardKind
  wsel?: string | null
  wproj?: string
  wdone?: boolean
  wopen?: boolean
  wtab?: string
  settings?: boolean
  closing?: boolean
  sec?: string
}

export const initialState = (props: Props): State => ({
  view: props.startView ?? 'inbox',
  tab: 'plan',
  open: { '138': true },
  left: true,
  right: true,
  card: 'idle',
  cardDir: 'r',
  wsel: props.startLane ?? undefined,
  wopen: props.startAll ?? false,
})

export interface ModelApi {
  setState: (update: Partial<State> | ((s: State) => Partial<State>)) => void
  closeS: () => void
}

export interface BuildSource {
  work: WorkSource
  inbox: { ui: InboxUi; source: StoreState; handlers: InboxHandlers & { dispatch: (intent: Intent) => void } }
  /** the conversation screen: the answer to draw, the side conversation it follows (a BTW branch), and its presses */
  chat: { state: ChatStoreState; btw: SideState; btwDraft: string; ui: ChatUi; handlers: ChatHandlers }
  /** the conversation settings switch's presses; its values ride in `chat.state` */
  chatSettings: ConversationSettingsHandlers
  /** the find field over every screen: the search store's answer and the presses it hands out */
  search: { state: ChatSearchState; on: SearchHandlers }
  /** the open card's consultation, as the Inbox panel draws it */
  consult: ConsultView
  /** the settings sheet: the engine's answers, the inputs' own state, and the appearance kept in this browser */
  settings: {
    state: SettingsStoreState
    ui: SettingsUi
    handlers: SettingsHandlers
    appearance: AppearanceView
  }
}

/** the three rows of Appearance that are wired, as the component reads them (C-171-6) */
export interface AppearanceView {
  fontPx: number
  setFont: (fontPx: number) => void
  reduceMotion: boolean
  toggleMotion: () => void
  arrowKeys: boolean
  toggleArrowKeys: () => void
}

/**
 * Whether the right panel is on screen: the Work screen keeps its own two columns, and the toggle closes it
 * everywhere. The conversation screen draws its BTW frame from this, so the panel cannot be drawn while the
 * toggle says it is closed.
 */
export function rightPanelShown(view: View, right: boolean): boolean {
  return right && view !== 'work'
}

// ------------------------------------------------------------------- assembly
export function buildModel(state: State, props: Props, api: ModelApi, source: BuildSource) {
  const { setState, closeS } = api
  const { view, tab, left, right } = state

  const railFor = (v: View) => ({
    bg: view === v ? 'var(--surface)' : 'transparent',
    sh: view === v ? '0 0 0 1px var(--line-strong)' : 'none',
    c: view === v ? 'var(--ink)' : 'var(--ink-3)',
  })
  const railInbox = railFor('inbox')
  const railLanes = railFor('work')
  const railChat = railFor('chat')

  const go = (v: View) => () => setState({ view: v })

  // ---- settings sheet nav
  const sec = state.sec ?? 'lanes'
  const secItems: [string, string][] = [
    ['prov', 'Providers & Models'],
    ['lanes', 'Lane stages & roles'],
    ['skills', 'Skills · MCP · Search'],
    ['spaces', 'Spaces'],
    ['conv', 'Storage'],
    ['key', 'Passkeys'],
    ['view', 'Appearance'],
    ['voice', 'Voice input'],
  ]

  // ---- inbox card transition
  const cardState = state.card
  const dir = state.cardDir
  const out = dir === 'r' ? 'translateX(56px)' : dir === 'l' ? 'translateX(-56px)' : 'translateY(28px)'
  const cardAnim: { cardTf: string; cardOp: number; cardTr: string } =
    cardState === 'out'
      ? {
          cardTf: out,
          cardOp: 0,
          cardTr: 'transform 170ms var(--ease-in), opacity 100ms var(--ease-pop)',
        }
      : cardState === 'in'
        ? { cardTf: 'translateY(6px) scale(.982)', cardOp: 0.85, cardTr: 'none' }
        : {
            cardTf: 'none',
            cardOp: 1,
            cardTr: 'transform 110ms var(--ease-out), opacity 70ms var(--ease-pop)',
          }

  const work = workVals(state, setState, source.work)
  const inbox = inboxVals(source.inbox.ui, source.inbox.source, source.inbox.handlers)
  // the conversation screen's values: the list, the body, the input and the BTW frame, all from the engine
  const chat: ChatScreenView = chatVals(source.chat.state, source.chat.btw, source.chat.btwDraft, right && view === 'chat', source.chat.ui, source.chat.handlers)
  // the conversation settings: its values and the open pi's features both ride in the same store snapshot
  const chatSettings = conversationSettingsVals(source.chat.state, source.chatSettings)
  // the find field, over every screen; the search store's own answer, never the chat store's
  const search: SearchView = searchVals(source.search.state, source.search.on)
  // the settings sheet's four wired sections, all from the engine's answers (DEC-103-1)
  const set = settingsVals(source.settings.state, source.settings.ui, source.settings.handlers)

  return {
    ...work,
    // rail
    rbInbox: railInbox.bg,
    rsInbox: railInbox.sh,
    rcInbox: railInbox.c,
    rbLanes: railLanes.bg,
    rsLanes: railLanes.sh,
    rcLanes: railLanes.c,
    rbChat: railChat.bg,
    rsChat: railChat.sh,
    rcChat: railChat.c,
    // the Inbox, filled from the engine's state door alone
    inbox,
    // the conversation screen, and the consultation the Inbox panel keeps open for its card
    chat,
    chatSettings,
    // the find field over every screen
    search,
    consult: source.consult,
    settings: !!state.settings,
    // the settings sheet's sections and the appearance rows
    set,
    ap: source.settings.appearance,
    openSettings: () => setState({ settings: true, closing: false }),
    openSettingsProv: () => setState({ settings: true, closing: false, sec: 'prov' }),
    // settings
    secNav: secItems.map(([k, t]) => ({
      t,
      bg: k === sec ? 'var(--line-soft)' : 'transparent',
      fw: k === sec ? 600 : 400,
      go: () => setState({ sec: k }),
    })),
    secTitle: secItems.find((i) => i[0] === sec)![1],
    secLanes: sec === 'lanes',
    secProv: sec === 'prov',
    secSkills: sec === 'skills',
    secSpaces: sec === 'spaces',
    secConv: sec === 'conv',
    secKey: sec === 'key',
    secView: sec === 'view',
    secVoice: sec === 'voice',
    closeSettings: () => closeS(),
    scrimAnim: state.closing ? 'pfadeout 120ms var(--ease-pop) forwards' : 'pfade 150ms var(--ease-pop)',
    sheetAnim: state.closing ? 'psheetout 120ms var(--ease-in) forwards' : 'psheet 180ms var(--ease-out)',
    // card transition
    cardTf: cardAnim.cardTf,
    cardOp: cardAnim.cardOp,
    cardTr: cardAnim.cardTr,
    keepStream: (props.keepAsk ?? 'stream') === 'stream',
    keepBranch: props.keepAsk === 'branch',
    vInbox: view === 'inbox',
    vLanes: view === 'work',
    vChat: view === 'chat',
    nInbox: view !== 'inbox',
    nLanes: view !== 'work',
    nChat: view !== 'chat',
    goInbox: go('inbox'),
    goLanes: go('work'),
    goChat: go('chat'),
    tabPlan: tab === 'plan',
    tabRes: tab === 'res',
    tabAsk: tab === 'ask',
    nPlan: tab !== 'plan',
    nRes: tab !== 'res',
    nAsk: tab !== 'ask',
    setPlan: () => setState({ tab: 'plan' }),
    setRes: () => setState({ tab: 'res' }),
    setAsk: () => setState({ tab: 'ask' }),
    leftOpen: left,
    showRight: rightPanelShown(view, right),
    toggleLeft: () => setState((s) => ({ left: !s.left })),
    toggleRight: () => setState((s) => ({ right: !s.right })),
  }
}

export type Model = ReturnType<typeof buildModel>
