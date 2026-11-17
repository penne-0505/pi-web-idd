// React binding for the ported `Component` logic: the state machine and the keyboard shortcuts, both of which the
// dc runtime gave the original class for free. It also owns the engine's reads: one stream of the engine's state on
// every screen (the rail's badge is one value, so the Inbox must not stop at the screen's edge, and the Work picture
// rides the same frames) and the conversation screen's own store. The Inbox's judgement is the same path the current GUI uses
// (`keymap` → `requests` → `useDecide`), so a card means the same thing in both screens. The conversation is the
// engine's: `ChatStore` holds what the doors returned, and the screen follows one more conversation for the BTW
// branch and one for the open card's consultation.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildModel, initialState, type AppearanceView, type Props, type State } from './model'
import { hashOfScreen } from '../screenHash'
import { WorkStore, type WorkStoreState } from '../work/store'
import { InboxStore, type StoreState } from '../inbox/useDecide'
import { applyDrafts, batchDraftOf, emptyDrafts, goReasonOf, setBatchLane, setGoName, setGoReason, setOutboundField, setOutboundReply, setShipField, setStuckPick, stuckPicksOf, type DraftState } from '../inbox/drafts'
import { isTextEntry } from '../inbox/focus'
import { approvalIntentOf, goHeldReason, intentForScreen, type Intent, type KeyContext } from '../inbox/keymap'
import { buildBatchApproval, buildOutboundApproval, buildShipApproval, outboundDraftFor, shipDraftFor, type OutboundDraft, type OutboundReplyDraft, type ShipDraft } from '../inbox/approval'
import { cardNamed, deck, itemKey } from '../inbox/deck'
import { shipCardKey, type InboxItem } from '../engine/contract'
import type { InboxHandlers, InboxUi } from '../inbox/viewmodel'
import { recommendedSelection } from '../inbox/viewmodel'
import type { FindingAction } from '../inbox/stuck-findings'
import { installScreenKeys } from './screenKeys'
import { ChatStore, draftAfterSend, type FetchLike } from '../chat/store'
import type { ConversationSettingsHandlers } from '../chat/settings'
import { SettingsStore, type SettingsStoreState } from '../settings/store'
import { applyAppearance, arrowKeysAllowed, readAppearance, saveAppearance, setAppearance as mergeAppearance, type Appearance } from '../settings/appearance'
import { passkeysShown } from '../settings/passkeys'
import type { SpaceDraft, SpaceField, SettingsHandlers, SettingsUi } from '../settings/viewmodel'
import { editorPinnedTo, spaceSaveTargetOf } from '../settings/viewmodel'
import type { MemoryHandling, Space } from '../engine/contract'
import { browserEventStream } from '../chat/stream'
import { StateStream, browserStateStream } from '../engine/state-stream'
import { SideChat, openBranchAt, openConsult, type SideState } from '../chat/side'
import { EMPTY_LIST_UI, consultKey, consultVals, listAction, markAction, type ChatHandlers, type ChatListUi, type ChatUi } from '../chat/viewmodel'
import { ChatSearch, titleRows } from '../search/store'
import type { SearchHandlers } from '../search/view'
import { isSearchOpenPress, searchKeyAction } from '../search/keys'

const browserFetch = (path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) =>
  fetch(path, init)

/** the conversation doors take the audio itself at the transcription door, so their fetch may carry a Blob */
const chatFetch: FetchLike = (path, init) => fetch(path, init)

/** a second conversation the screen follows beside the main one; both a BTW branch and a card's consult use one */
const openStream = browserEventStream

/** a space's definition in the editor's own fields: the references are one path to a line */
const emptySpaceDraft = (): SpaceDraft => ({ id: '', name: '', memory: 'none', references: '', instruction: '' })

const spaceDraftFrom = (space: Space): SpaceDraft => ({
  id: space.id,
  name: space.name ?? '',
  memory: space.memory,
  references: space.references.join('\n'),
  instruction: space.instruction,
})

/** the sheet's space editor with nothing open: the same clear whether the Close press or a save's answer closes it */
const spaceEditorClosed = (ui: SettingsUi): SettingsUi => ({ ...ui, spaceOpen: null, spaceDraft: null, spaceTouched: [], spaceMode: null, newOpen: false, newDraft: emptySpaceDraft(), newTouched: [] })

export function usePropterModel(props: Props) {
  const [state, set] = useState<State>(() => initialState(props))

  // handlers read the current state through a ref, like `this.state` did
  const stateRef = useRef(state)
  stateRef.current = state

  const setState = useCallback((update: Partial<State> | ((s: State) => Partial<State>)) => {
    set((s) => ({ ...s, ...(typeof update === 'function' ? update(s) : update) }))
  }, [])

  /** Settings sheet: fade out, then unmount. */
  const closeS = useCallback(() => {
    const s = stateRef.current
    if (!s.settings || s.closing) return
    setState({ closing: true })
    setTimeout(() => setState({ settings: false, closing: false }), 120)
  }, [setState])

  // ---- the engine's own values for the Work screen
  const workStore = useMemo(() => new WorkStore(browserFetch), [])
  const [workSource, setWorkSource] = useState<WorkStoreState>(() => workStore.state)
  useEffect(() => workStore.subscribe(() => setWorkSource(workStore.state)), [workStore])

  // the selected row's own views: a finished Issue lane is read like a running one, a hold row and a review
  // lane keep only the Work column. The store guards the re-read, so an unchanged row or picture reads nothing again.
  const { snapshot: workSnapshot } = workSource
  useEffect(() => {
    workStore.followSelection(workSnapshot, state.wsel ?? null)
  }, [workStore, workSnapshot, state.wsel])

  // ---- the engine's own values for the Inbox
  const store = useMemo(() => new InboxStore(browserFetch), [])
  const [inboxState, setInboxState] = useState<StoreState>(() => store.state)
  useEffect(() => store.subscribe(() => setInboxState(store.state)), [store])

  const [noteOpen, setNoteOpen] = useState(false)
  // the operation that opened the one line, so the Enter that ends it sends that one (a card can have two that take a line)
  const [noteOp, setNoteOp] = useState<string | null>(null)
  const [reasonOpen, setReasonOpen] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [note, setNote] = useState('')
  const [selection, setSelection] = useState<number | null | undefined>(undefined)
  const [question, setQuestion] = useState(0)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [tab, setTab] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<DraftState>(() => emptyDrafts())

  // The engine's state arrives on one stream, on every screen: the Inbox's picture is what the rail's badge shows, and
  // the Work picture rides the same frames. Nothing here reads on a clock — a frame is what moves either of them, and
  // the Work doors are read only when the engine says the Work picture's own content moved.
  const stateStream = useMemo(() => new StateStream(browserStateStream), [])
  useEffect(() => {
    const stop = stateStream.start(({ frame, resync }) => {
      store.apply(frame, { resync })
      workStore.followPicture(frame.workSeq)
    })
    // coming back does not read anything: a stream that is still open missed nothing (the engine keeps it open in the
    // background), and one that was cut is tried again now rather than at the retry's own hour
    const onVisible = () => {
      if (!document.hidden) stateStream.reconnectIfGone()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onVisible)
      stop()
    }
  }, [stateStream, store, workStore])

  // ---- the engine's own values for the conversation screen
  const chatStore = useMemo(() => new ChatStore(chatFetch, openStream), [])
  const btwChat = useMemo(() => new SideChat(chatFetch, openStream), [])
  const consultChat = useMemo(() => new SideChat(chatFetch, openStream), [])
  const [chatSource, setChatSource] = useState(() => chatStore.state)
  const [btwSource, setBtwSource] = useState<SideState>(() => btwChat.state)
  const [consultSource, setConsultSource] = useState<SideState>(() => consultChat.state)
  useEffect(() => chatStore.subscribe(() => setChatSource(chatStore.state)), [chatStore])
  useEffect(() => btwChat.subscribe(() => setBtwSource(btwChat.state)), [btwChat])
  useEffect(() => consultChat.subscribe(() => setConsultSource(consultChat.state)), [consultChat])

  // ---- the settings sheet's engine reads, its inputs' own state, and the appearance this browser keeps
  const settingsStore = useMemo(() => new SettingsStore(browserFetch), [])
  const [settingsSource, setSettingsSource] = useState<SettingsStoreState>(() => settingsStore.state)
  useEffect(() => settingsStore.subscribe(() => setSettingsSource(settingsStore.state)), [settingsStore])

  const [appearance, setAppearance] = useState<Appearance>(() => readAppearance(typeof window === 'undefined' ? null : window.localStorage))
  useEffect(() => {
    saveAppearance(window.localStorage, appearance)
    const frame = document.getElementById('root') ?? document.documentElement
    applyAppearance(frame, appearance)
  }, [appearance])

  const [settingsUi, setSettingsUi] = useState<SettingsUi>(() => ({
    spaceOpen: null,
    spaceDraft: null,
    spaceTouched: [],
    spaceMode: null,
    newOpen: false,
    newDraft: emptySpaceDraft(),
    newTouched: [],
  }))

  // the sheet's sections read their doors when it opens: the conversation settings and the workspaces are both
  // small, and reading them here keeps the first paint of a section from being empty
  useEffect(() => {
    if (!state.settings) return
    if (!settingsStore.state.conversation) void settingsStore.readSettings()
    if (!settingsStore.state.workspaces.length) void settingsStore.readWorkspaces()
  }, [settingsStore, state.settings])

  // The keys and the PIN the Inbox offers as ways to sign a card are not part of the state picture: they are read
  // when the screen opens, and again whenever the sheet's passkeys section got the engine to accept a change. A key
  // registered, a pending key approved, or a PIN set or cleared therefore reaches the Inbox's note and confirm stage
  // without a reload (AC-006, F-189-1, F-189-9, F-189-16).
  useEffect(() => {
    void store.readPasskeys()
    void store.readPin()
  }, [store, settingsSource.passkeysRevision])

  // the storage door runs the whole judgement and can take minutes on its first read, so it runs only while its
  // section shows: the sheet shows that it is measuring rather than a number it made up (C-171-3)
  useEffect(() => {
    if (state.sec !== 'conv') return
    if (settingsStore.state.storage || settingsStore.state.storageMeasuring) return
    void settingsStore.readStorage()
  }, [settingsStore, state.sec])

  // the passkeys section reads both lists whenever it shows: the keys are the engine's and the pending list changes
  // while the sheet is shut too (a tailnet page adds a key), so opening the sheet on the same section asks again
  // (C-172-1, C-172-2)
  const passkeysVisible = passkeysShown(state.settings, state.sec)
  useEffect(() => {
    if (!passkeysVisible) return
    void settingsStore.readPasskeys()
    void settingsStore.readPin()
  }, [settingsStore, passkeysVisible])

  const [chatList, setChatList] = useState<ChatListUi>({ menu: null, confirming: null })
  // the presses read the list's own state through a ref, so a press that must call the door does it once, outside
  // the state updater (React may run an updater twice, and the delete door cannot be called twice)
  const chatListRef = useRef(chatList)
  chatListRef.current = chatList
  const [queueEdit, setQueueEdit] = useState<{ id: string; text: string } | null>(null)
  const [modelQuery, setModelQuery] = useState('')
  const [btwDraft, setBtwDraft] = useState('')
  const [consultDraft, setConsultDraft] = useState('')

  // ---- the find field: it sits over every screen, so its store is here and not inside the conversation screen's
  const searchStore = useMemo(() => new ChatSearch(chatFetch), [])
  const [searchSource, setSearchSource] = useState(() => searchStore.state)
  useEffect(() => searchStore.subscribe(() => setSearchSource(searchStore.state)), [searchStore])

  const searchHandlers: SearchHandlers = useMemo(
    () => ({
      open: () => {
        // New chat needs a workspace and the field can be the first touch of the conversation store
        void chatStore.readWorkspaces()
        searchStore.open()
      },
      close: () => searchStore.close(),
      setQuery: (text: string) => searchStore.setQuery(text),
      searchBody: () => {
        void searchStore.searchBody()
      },
      select: (id: string) => {
        // the field's own name goes with the id: the open door does not carry one (C-173-4)
        const name = searchStore.nameFor(id)
        searchStore.close()
        setState({ view: 'chat' })
        void chatStore.select(id, name ?? undefined)
      },
      newChat: () => {
        // the word is left in the new conversation's box and never sent (C-173-3)
        const text = searchStore.state.query.trim()
        searchStore.close()
        setState({ view: 'chat' })
        void chatStore.newChat(text)
      },
    }),
    [chatStore, searchStore, setState],
  )

  /** ⌘K / Ctrl+K opens the field from any screen; the settings sheet covers it, so it opens nothing there */
  const openSearch = useCallback(
    (event: KeyboardEvent) => {
      if (stateRef.current.settings) return
      const press = { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat, isComposing: event.isComposing }
      if (!isSearchOpenPress(press)) return
      event.preventDefault()
      searchHandlers.open()
    },
    [searchHandlers],
  )
  useEffect(() => {
    window.addEventListener('keydown', openSearch)
    return () => window.removeEventListener('keydown', openSearch)
  }, [openSearch])

  /**
   * The field's own keys. Only these are installed while it is open, so a press that is not the field's can never
   * become a card's decision: the Inbox's own listener is not installed at all behind the field.
   */
  const onSearchKey = useCallback(
    (event: KeyboardEvent) => {
      const state = searchStore.state
      const body = state.body !== null && state.body.query === state.query.trim()
      const action = searchKeyAction(
        { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat, isComposing: event.isComposing },
        { body, rows: titleRows(state).length },
      )
      if (!action) return
      event.preventDefault()
      if (action === 'close') { searchStore.close(); return }
      if (action === 'body') { void searchStore.searchBody(); return }
      if (action === 'next') { searchStore.moveActive(1); return }
      if (action === 'prev') { searchStore.moveActive(-1); return }
      const id = searchStore.activeId()
      if (id) searchHandlers.select(id)
    },
    [searchStore, searchHandlers],
  )

  // follow the conversation screen's stores while it shows; the list polls, and the streams stop when it is left
  useEffect(() => {
    if (state.view !== 'chat') return
    const id = chatStore.state.selectedId
    if (id) void chatStore.select(id)
    else void chatStore.readWorkspaces()
    void chatStore.readModes()
    chatStore.startPolling()
    const onVisible = () => {
      if (!document.hidden) void chatStore.readList()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onVisible)
      chatStore.stopPolling()
      chatStore.detach()
    }
  }, [chatStore, state.view])

  const items = useMemo(() => inboxState.snapshot?.items ?? [], [inboxState.snapshot])
  // every read of the engine's state replaces only the fields penne has not touched
  useEffect(() => {
    setDrafts((current) => applyDrafts(current, items))
  }, [items])

  const view = useMemo(() => deck(items, inboxState.now, inboxState.hidden, inboxState.focused), [items, inboxState.now, inboxState.hidden, inboxState.focused])
  const front = view.front[0] ?? null
  const frontKey = front ? itemKey(front) : null

  // the card the URL named (`?card=<id>`, from a CLI answer) comes to the front once, when the engine's state is first
  // read: later reads and the person's own moves are not pulled back to it. A card that is not in the front then
  // (decided, put off) leaves the Inbox as the engine ordered it.
  const urlCard = useRef(props.inboxCard ?? null)
  useEffect(() => {
    if (urlCard.current === null || inboxState.snapshot === null) return
    const id = urlCard.current
    urlCard.current = null
    const named = cardNamed(deck(items, inboxState.now, inboxState.hidden).front, id)
    if (named) store.focus(named)
  }, [store, items, inboxState.snapshot, inboxState.now, inboxState.hidden])

  // a new card at the front starts with a clean input and no open confirm, and this card's consultation is not
  // the last card's: the panel never shows one card's talk under the next card's name
  useEffect(() => {
    setNoteOpen(false)
    setNoteOp(null)
    setReasonOpen(false)
    setAskOpen(false)
    setNote('')
    // undefined lets the new card's question open with its one recommendation chosen (C-154-2)
    setSelection(undefined)
    setQuestion(0)
    setConfirm(null)
    setTab(null)
    setConsultDraft('')
    consultChat.clear()
  }, [frontKey, consultChat])

  // the same card can become one whose GO the engine holds (a dependency, an empty contract): its reason line closes
  // then (the words written stay in the drafts), because there is no GO to send them with
  const frontGoHeld = front ? goHeldReason(front) !== null : false
  useEffect(() => {
    if (frontGoHeld) setReasonOpen(false)
  }, [frontGoHeld])

  // the conversation the BTW branch was cut off has changed: the frame is about the open conversation alone
  useEffect(() => {
    btwChat.clear()
    setBtwDraft('')
  }, [chatSource.selectedId, btwChat])

  // A side conversation's flow is followed only while the screen that draws it shows: leaving stops the stream and
  // its reconnect loop, and returning reads the same branch / consult again so the record covers the time away.
  // The selection and the box survive, so moving between screens never costs the branch or what was written.
  useEffect(() => {
    if (state.view !== 'chat') { btwChat.detach(); return }
    btwChat.resume()
    return () => btwChat.detach()
  }, [state.view, btwChat])

  useEffect(() => {
    if (state.view !== 'inbox') { consultChat.detach(); return }
    consultChat.resume()
    return () => consultChat.detach()
  }, [state.view, consultChat])

  const consultTarget = useMemo(
    () => (front && front.kind === 'question' ? { kind: front.kind, iddId: front.iddId, batchId: front.batchId } : null),
    [front],
  )

  /** the key that closes the confirm when any of the signed content changes (DEC-9503) */
  const confirmKeyOf = useCallback(
    (item: InboxItem | null): string | null => {
      if (!item) return null
      if (item.kind === 'ship') return buildShipApproval(item, drafts.ship[shipCardKey(item)]?.draft ?? shipDraftFor(item)).confirmKey
      if (item.kind === 'land-batch') return buildBatchApproval(item, batchDraftOf(drafts, item)).confirmKey
      if (item.kind === 'outbound') return buildOutboundApproval(item, drafts.outbound[itemKey(item)]?.draft ?? outboundDraftFor(item)).confirmKey
      return null
    },
    [drafts],
  )
  const confirmKey = confirmKeyOf(front)
  useEffect(() => {
    // a confirm of an operation drawn from the engine's answer (`op:` keys) is held against that answer by its key, in the keymap
    if (confirm !== null && !confirm.startsWith('op:') && confirmKey !== confirm) setConfirm(null)
  }, [confirm, confirmKey])

  const dispatch = useCallback(
    (intent: Intent) => {
      if (store.state.deciding) return
      if (!front) return
      if (intent.kind === 'select') {
        // pressing the chosen option again takes the choice off, so the one line becomes the free answer
        const current = selection === undefined ? recommendedSelection(front, question) : selection
        setSelection(current === intent.index ? null : intent.index)
        return
      }
      if (intent.kind === 'question_prev') {
        // the previous question opens with its own recommendation, or with none (C-154-2)
        setSelection(undefined)
        setQuestion((q) => Math.max(0, q - 1))
        return
      }
      if (intent.kind === 'note_open') {
        setAskOpen(false)
        setReasonOpen(false)
        setNoteOpen(true)
        setNoteOp(intent.op ?? null)
        return
      }
      // the GO's reason line and the revise's never stay open together: the open one is the one Enter sends. What was
      // written as the reason is kept in the card's draft, and what was written as the revise stays in the note, so
      // switching between the two lines never costs either
      if (intent.kind === 'reason_open') {
        setAskOpen(false)
        setNoteOpen(false)
        setReasonOpen(true)
        return
      }
      if (intent.kind === 'reason_close') {
        setReasonOpen(false)
        return
      }
      // 聞く opens the consultation: the one-line input becomes the consultation's, and the answer's own words
      // stay where they are, so opening the consultation never costs what was written for the answer (C-143-3)
      if (intent.kind === 'ask_open') {
        setAskOpen(true)
        setNoteOpen(true)
        // the talk lives in the right panel, so 聞く opens it: a send from the card would have nowhere to read (C-154-3)
        setState({ right: true })
        const key = consultKey(front)
        if (key && front && front.kind === 'question') {
          const target = { kind: front.kind, iddId: front.iddId, batchId: front.batchId }
          void consultChat.ensure(key, () => openConsult(chatFetch, target))
        }
        return
      }
      if (intent.kind === 'note_close') {
        // closing the box clears the words of whichever input it was: closing the consultation never costs the
        // answer that was written before 聞く opened it (F-143-55)
        if (askOpen) setConsultDraft('')
        else setNote('')
        setAskOpen(false)
        setNoteOpen(false)
        setNoteOp(null)
        // the line a confirm was opened over is gone, so that confirm goes with it
        if (confirm !== null && confirm.startsWith('op:')) setConfirm(null)
        return
      }
      if (intent.kind === 'confirm_open') {
        setConfirm(intent.confirmKey)
        return
      }
      if (intent.kind === 'confirm_close') {
        setConfirm(null)
        return
      }
      if (intent.kind === 'read') {
        setState({ right: true })
        return
      }
      setNoteOpen(false)
      setNoteOp(null)
      setReasonOpen(false)
      setAskOpen(false)
      setNote('')
      // a decision lets the next question or card open with its own recommendation again (C-154-2)
      setSelection(undefined)
      setConfirm(null)
      // whether it is signed is the engine's answer on the card; the store reads it from the request
      void store.decide(intent, front)
    },
    [front, store, consultChat, askOpen, setState, selection, question, confirm],
  )

  /** the open card's consultation, read at the moment a key sends into it (its own value lives below) */
  const consultRef = useRef<{ ask: () => void } | null>(null)

  const handlers: InboxHandlers & { dispatch: (intent: Intent) => void } = useMemo(
    () => ({
      dispatch,
      note: (value: string) => {
        // the same box is the answer's and, once 聞く opened it, the consultation's: the words never cross over
        if (askOpen) setConsultDraft(value)
        else setNote(value)
        setReasonOpen(false)
        setNoteOpen(true)
      },
      // the line that takes focus is the only one open, so the Enter that follows has one place to go
      openNote: () => {
        setReasonOpen(false)
        setNoteOpen(true)
      },
      reason: (value: string) => {
        if (front?.kind === 'go') setDrafts((d) => setGoReason(d, front.iddId, value))
        setNoteOpen(false)
        setReasonOpen(true)
      },
      openReason: () => {
        setNoteOpen(false)
        setReasonOpen(true)
      },
      closeReason: () => setReasonOpen(false),
      closeNote: () => {
        setNoteOpen(false)
        setNote('')
      },
      // the card's choice row takes the same press as the digit key, so both can take a choice off again
      select: (index: number) => dispatch({ kind: 'select', index }),
      // the new question opens with its own recommendation, or with none (C-154-2)
      ask: () => consultRef.current?.ask(),
      setQuestion: (index: number) => {
        setSelection(undefined)
        setQuestion(index)
      },
      shipField: (field: keyof ShipDraft, value: string) => {
        if (front?.kind === 'ship') setDrafts((d) => setShipField(d, front, field, value))
      },
      batchLane: (iddId: string, off: boolean) => {
        if (front?.kind === 'land-batch') setDrafts((d) => setBatchLane(d, front, iddId, off))
      },
      pickFinding: (ref: string, action: FindingAction) => {
        if (front?.kind === 'stuck') setDrafts((d) => setStuckPick(d, front.iddId, ref, action))
      },
      outboundField: (patch: Partial<OutboundDraft>) => {
        if (front?.kind === 'outbound') setDrafts((d) => setOutboundField(d, front, patch))
      },
      outboundReply: (ref: string, patch: Partial<OutboundReplyDraft>) => {
        if (front?.kind === 'outbound') setDrafts((d) => setOutboundReply(d, front, ref, patch))
      },
      goName: (proposalId: string, value: string) => {
        if (front?.kind === 'go') setDrafts((d) => setGoName(d, front.iddId, proposalId, value))
      },
      // a judgment on one proposed Purpose leaves the card where it is, so the card's own inputs are not reset
      purposeRestate: (id: string, statement: string) => {
        if (front?.kind === 'go') void store.decide({ kind: 'purpose_restate', id, statement }, front)
      },
      purposeWithdraw: (id: string, grounds: string) => {
        if (front?.kind === 'go') void store.decide({ kind: 'purpose_withdraw', id, grounds }, front)
      },
      wake: (item: InboxItem) => void store.wake(item),
      focus: (item: InboxItem) => store.focus(item),
      unignore: (ref: string) => void store.unignore(ref),
      retry: () => void store.read(),
      clearReceipt: () => store.clearReceipt(),
      // the unregistered note opens the sheet where a key is added, never the current GUI (C-172-1)
      openSettingsKey: () => setState({ settings: true, closing: false, sec: 'key' }),
      // the PIN typed in the confirm stage signs this one card's frozen approval, and nothing else (C-182-6)
      approvePin: (pin: string) => {
        if (!front) return
        const intent = front.kind === 'ship'
          ? approvalIntentOf(buildShipApproval(front, drafts.ship[shipCardKey(front)]?.draft ?? shipDraftFor(front)), 'ship_approve')
          : front.kind === 'land-batch'
            ? approvalIntentOf(buildBatchApproval(front, batchDraftOf(drafts, front)), 'ship_approve')
            : front.kind === 'outbound'
            ? approvalIntentOf(buildOutboundApproval(front, drafts.outbound[itemKey(front)]?.draft ?? outboundDraftFor(front)), 'outbound_approve')
            : null
        if (!intent) return
        // the confirm closes with the press: the next card opens its own stage, and the PIN field goes with this one
        setConfirm(null)
        void store.approveWithPin(intent, front, pin)
      },
      setTab,
    }),
    [dispatch, front, store, askOpen, setState, drafts],
  )

  // the card's keys belong to the Inbox: with another screen up they mean nothing, so no key can send a decision
  // for a card that is not in front of the user. The focus is read at the moment of the press.
  const onInboxKey = useCallback(
    (event: KeyboardEvent) => {
      // Arrow keys switched off means no arrow press becomes a card's judgement (C-171-6)
      if (!arrowKeysAllowed(appearance, event.key)) return
      if (store.state.deciding) return
      const active = document.activeElement as (HTMLElement & { closest?: (selector: string) => Element | null }) | null
      const typing = isTextEntry(active)
      const inNoteBox = Boolean(typing && active?.closest?.('[data-note-input]'))
      // a question opens with its one recommendation chosen; the key path reads that same choice (C-154-2)
      const shownSelection = selection === undefined ? recommendedSelection(front, question) : selection
      const base: KeyContext = { noteOpen, noteOp: noteOpen ? noteOp : null, confirm, askOpen, note, selection: shownSelection, question, focusInInput: typing && inNoteBox, focusInEditor: typing && !inNoteBox, confirmOpen: (confirm !== null && confirm === confirmKey) || Boolean(confirm?.startsWith('op:')), keyCount: inboxState.sign.count }
      const pressCtx: KeyContext = front && front.kind === 'ship'
        ? { ...base, ship: drafts.ship[shipCardKey(front)]?.draft ?? shipDraftFor(front) }
        : front && front.kind === 'land-batch'
          ? { ...base, batch: batchDraftOf(drafts, front) }
          : front && front.kind === 'outbound'
            ? { ...base, outbound: drafts.outbound[itemKey(front)]?.draft ?? outboundDraftFor(front) }
            : front && front.kind === 'go'
              ? { ...base, reasonOpen, reason: goReasonOf(drafts, front.iddId) }
              : front && front.kind === 'stuck'
                ? { ...base, picks: stuckPicksOf(drafts, front.iddId) }
                : base
      // alt / ctrl / meta are the browser's own shortcuts: the keymap reads them and answers nothing, so alt+←
      // (back) and cmd+→ (forward) never become a card's decision. The browser's composition signal is handed over
      // too, so the Enter that confirms an IME conversion stays the input's own keypress
      const intent = intentForScreen(state.view, front, { key: event.key, shift: event.shiftKey, repeat: event.repeat, alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, isComposing: event.isComposing, keyCode: event.keyCode }, pressCtx)
      if (!intent) return
      event.preventDefault()
      dispatch(intent)
    },
    [state.view, store, appearance, noteOpen, noteOp, reasonOpen, askOpen, note, selection, question, confirm, confirmKey, inboxState.sign.count, front, drafts, dispatch],
  )

  // the one key listener this screen installs; installing answers nothing, so an open band (`#work/all`) never drops
  useEffect(
    () =>
      installScreenKeys(window, {
        view: state.view,
        settings: Boolean(state.settings),
        wopen: Boolean(state.wopen),
        closeSettings: closeS,
        closeBand: () => setState({ wopen: false }),
        onInboxKey,
        searchOpen: searchSource.open,
        onSearchKey,
        // Esc on the conversation screen drops the row's confirm and menu: a slipped menu press is undone
        onChatKey: (event: KeyboardEvent) => {
          if (event.key === 'Escape') setChatList(EMPTY_LIST_UI)
        },
      }),
    [state.view, state.settings, state.wopen, closeS, setState, onInboxKey, searchSource.open, onSearchKey],
  )

  // the URL carries the screen and the Work selection, so a reload and a screen change keep them
  const { wsel, wopen } = state
  useEffect(() => {
    const next = hashOfScreen({ view: state.view, lane: wsel ?? null, all: wopen ?? false, chat: null })
    if (location.hash !== next) history.replaceState(null, '', next)
  }, [state.view, wsel, wopen])

  // ---- the conversation screen's operations: every one goes to its own door, and none to the command door
  const chatHandlers: ChatHandlers = useMemo(
    () => ({
      listSelect: (id: string) => {
        setChatList({ menu: null, confirming: null })
        void chatStore.select(id)
      },
      listMenu: (id: string) => setChatList(listAction(chatListRef.current, { kind: 'menu', id }).ui),
      listMark: (id: string, kind: 'pin' | 'archive' | 'bookmark') => {
        setChatList({ menu: null, confirming: null })
        const summary = chatStore.summaryFor(id)
        if (!summary) return
        // a bookmark needs one of the workspace's own kinds: with none the row says why and no door is called
        const toggle = markAction(summary, kind, chatStore.state.bookmarks)
        if (!toggle) { chatStore.refuseBookmarkMark(id); return }
        void chatStore.setMark(toggle.id, toggle.patch)
      },
      // one press only opens the confirm; only the second press on the same row carries the id to the door
      listDelete: (id: string) => {
        const decision = listAction(chatListRef.current, { kind: 'delete', id })
        setChatList(decision.ui)
        if (decision.remove) void chatStore.remove(decision.remove)
      },
      listRetry: () => void chatStore.readList(),
      listClearReceipt: () => chatStore.clearReceipt(),
      newChat: () => void chatStore.newChat(),
      send: () => {
        const id = chatStore.state.selectedId
        if (!id) return
        void chatStore.send(chatStore.draftFor(id))
      },
      stop: () => void chatStore.stop(),
      setDraft: (text: string) => {
        const id = chatStore.state.selectedId
        if (id) chatStore.setDraft(id, text)
      },
      queueEdit: (id: string | null, text?: string) => setQueueEdit(id === null ? null : { id, text: text ?? '' }),
      queueConfirm: (id: string, text: string) => void chatStore.editQueue(id, text),
      queueCancel: (id: string) => void chatStore.cancelQueue(id),
      queueSteer: (id: string) => void chatStore.steerQueue(id),
      pickModel: (model: string) => void chatStore.setModel(model),
      pickEffort: (effort: string) => void chatStore.setEffort(effort),
      pickType: (type: string) => void chatStore.setType(type),
      modelQuery: (query: string) => setModelQuery(query),
      readQuota: () => void chatStore.readQuota(),
      attach: (images) => {
        for (const image of images) chatStore.attachImage(image)
      },
      removeAttachment: (index: number) => chatStore.removeAttachment(index),
      mentionOpen: () => chatStore.openMentions(),
      mentionClose: () => chatStore.closeMentions(),
      mentionQuery: (query) => chatStore.setMentionQuery(query),
      mentionToggle: (key) => chatStore.toggleMention(key),
      mentionRemove: (key) => chatStore.removeMention(key),
      // the BTW frame: the first send is what cuts the branch off the open conversation, at its head
      btwDraft: (text: string) => setBtwDraft(text),
      btwSend: () => {
        const parent = chatStore.state.selectedId
        const text = btwDraft
        if (!parent || !text.trim()) return
        const at = chatStore.state.open?.leafId ?? null
        // the send flow opens the branch if it must and says whether the engine took the words: the box drops only
        // the words this send carried (a line typed while it was under way stays), and a refusal stays in the box
        // with its reason on the frame
        void btwChat.ask(parent, () => openBranchAt(chatFetch, parent, at), text).then((result) => {
          if (result.ok) setBtwDraft((current) => draftAfterSend(current, text))
        })
      },
      btwStop: () => void btwChat.stop(),
      btwPromote: () => {
        void btwChat.promote().then((ok) => {
          // the list is what says the branch is now one of the mode's own conversations (DEC-1846)
          if (ok) void chatStore.readList()
        })
      },
      btwClose: () => {
        btwChat.clear()
        setBtwDraft('')
      },
    }),
    [btwChat, btwDraft, chatStore],
  )

  // the open card's consultation: the one-line input is the consultation's while 聞く has it open (C-143-3)
  const consultActive = askOpen && consultTarget !== null
  const consult = useMemo(
    () =>
      consultVals(consultSource, consultActive, {
        openAsk: () => {
          setAskOpen(true)
          setNoteOpen(true)
          const key = front ? consultKey(front) : null
          if (key && consultTarget) void consultChat.ensure(key, () => openConsult(chatFetch, consultTarget))
        },
        backToAnswer: () => setAskOpen(false),
        ask: () => {
          const text = consultDraft
          const key = front ? consultKey(front) : null
          if (!text.trim() || !key || !consultTarget) return
          // as with the BTW frame, the box drops only the words the engine took, not a line typed meanwhile (C-158-1)
          void consultChat.ask(key, () => openConsult(chatFetch, consultTarget), text).then((result) => {
            if (result.ok) setConsultDraft((current) => draftAfterSend(current, text))
          })
        },
        keep: () => void consultChat.promote(),
      }),
    [consultActive, consultChat, consultDraft, consultSource, consultTarget, front],
  )
  // the card's one line sends into this consultation through the handler above, read at the press (C-154-3)
  consultRef.current = consult

  const api = useMemo(() => ({ setState, closeS }), [setState, closeS])

  // the conversation settings' presses: values, the open pi's features and the candidates all ride in the store
  const chatSettingsHandlers: ConversationSettingsHandlers = useMemo(
    () => ({
      setSkill: (path: string, on: boolean) => void chatStore.setSkill(path, on),
      setFeature: (key: 'webSearch' | 'mcp', on: boolean) => void chatStore.setFeature(key, on),
    }),
    [chatStore],
  )

  // ---- the settings sheet's presses: the editors seed themselves from the definition the engine returned
  const openSpaceEditor = useCallback(
    (id: string) => {
      const space = settingsStore.state.spaces.find((entry) => entry.id === id)
      if (!space) return
      setSettingsUi({ spaceOpen: id, spaceDraft: spaceDraftFrom(space), spaceTouched: [], spaceMode: settingsStore.state.mode, newOpen: false, newDraft: emptySpaceDraft(), newTouched: [] })
    },
    [settingsStore],
  )

  const openNewEditor = useCallback(() => {
    setSettingsUi((ui) => ({ ...ui, newOpen: !ui.newOpen, newDraft: emptySpaceDraft(), newTouched: [], spaceMode: settingsStore.state.mode, spaceOpen: null, spaceDraft: null, spaceTouched: [] }))
  }, [settingsStore])

  const closeEditor = useCallback(() => {
    setSettingsUi(spaceEditorClosed)
  }, [])

  // which field the person touched is remembered, so a save sends only those fields (C-171-4)
  const setSpaceField = useCallback((field: SpaceField, value: string) => {
    setSettingsUi((ui) => {
      const creating = ui.newOpen && ui.spaceOpen === null
      const draft = creating ? ui.newDraft : ui.spaceDraft
      if (!draft) return ui
      const next: SpaceDraft = field === 'memory' ? { ...draft, memory: value as MemoryHandling } : { ...draft, [field]: value }
      const touched = creating ? ui.newTouched : ui.spaceTouched
      const nextTouched = touched.includes(field) ? touched : [...touched, field]
      if (creating) return { ...ui, newDraft: next, newTouched: nextTouched }
      return { ...ui, spaceDraft: next, spaceTouched: nextTouched }
    })
  }, [])

  const settingsHandlers: SettingsHandlers = useMemo(() => {
    const saveSpace = () => {
      // a save goes to the workspace the editor was opened in, or nowhere: switching workspaces mid-edit never
      // carries this draft onto another workspace's space of the same id (F-171-1)
      const target = spaceSaveTargetOf(settingsUi, settingsStore.state)
      if (!target) return
      const sent = target.id === null
        ? settingsStore.createSpace(target.mode, target.input)
        : settingsStore.updateSpace(target.mode, target.id, target.input)
      // a save's answer closes only the editor it was sent from: one that lands after a workspace switch must not
      // close the editor the sheet has since opened for another workspace (F-1)
      void sent.then((ok) => {
        if (!ok) return
        setSettingsUi((ui) => (editorPinnedTo(ui, target.mode) ? spaceEditorClosed(ui) : ui))
      })
    }
    return {
      toggleSkill: (path) => settingsStore.toggleSkill(path),
      setWebSearch: (value) => settingsStore.setWebSearch(value),
      setMcp: (value) => settingsStore.setMcp(value),
      chooseMode: (mode) => { void settingsStore.selectMode(mode) },
      openSpace: openSpaceEditor,
      openNewSpace: openNewEditor,
      closeSpace: closeEditor,
      setSpaceField,
      saveSpace,
      readStorage: () => { void settingsStore.readStorage() },
      registerPasskey: () => { void settingsStore.registerPasskey() },
      approvePending: (id) => { void settingsStore.approvePending(id) },
      // the PIN is set and cleared on a registered key's signature (C-182-1)
      setPin: (pin) => { void settingsStore.setPin(pin) },
      disablePin: () => { void settingsStore.disablePin() },
    }
  }, [settingsStore, settingsUi, openSpaceEditor, openNewEditor, closeEditor, setSpaceField])

  // the appearance rows take effect at once and are kept in this browser (C-171-5)
  const ap: AppearanceView = useMemo(
    () => ({
      fontPx: appearance.fontPx,
      setFont: (fontPx: number) => setAppearance((current) => mergeAppearance(current, { fontPx })),
      reduceMotion: appearance.reduceMotion,
      toggleMotion: () => setAppearance((current) => mergeAppearance(current, { reduceMotion: !current.reduceMotion })),
      arrowKeys: appearance.arrowKeys,
      toggleArrowKeys: () => setAppearance((current) => mergeAppearance(current, { arrowKeys: !current.arrowKeys })),
    }),
    [appearance],
  )

  const chatUi: ChatUi = useMemo(() => ({ list: chatList, queueEdit, modelQuery }), [chatList, queueEdit, modelQuery])

  const inboxUi: InboxUi = useMemo(
    // while the consultation has the box, the box shows the consultation's own words
    () => ({ noteOpen, noteOp, reasonOpen, askOpen, note: askOpen ? consultDraft : note, selection, question, confirm, drafts, tab }),
    [noteOpen, noteOp, reasonOpen, askOpen, note, consultDraft, selection, question, confirm, drafts, tab],
  )

  return useMemo(
    () =>
      buildModel(state, props, api, {
        work: { snapshot: workSource.snapshot, forecast: workSource.forecast, consumption: workSource.consumption, detail: workSource.detail },
        inbox: { ui: inboxUi, source: inboxState, handlers },
        chat: { state: chatSource, btw: btwSource, btwDraft, ui: chatUi, handlers: chatHandlers },
        chatSettings: chatSettingsHandlers,
        search: { state: searchSource, on: searchHandlers },
        consult,
        settings: { state: settingsSource, ui: settingsUi, handlers: settingsHandlers, appearance: ap },
      }),
    [state, props, api, workSource, inboxUi, inboxState, handlers, chatSource, btwSource, btwDraft, chatUi, chatHandlers, chatSettingsHandlers, searchSource, searchHandlers, consult, settingsSource, settingsUi, settingsHandlers, ap],
  )
}
