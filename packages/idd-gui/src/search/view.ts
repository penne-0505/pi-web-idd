/**
 * The find field's values, built from the search store's answer alone. The parts are the prototype's own shapes:
 * the open field with the word in it, the row per matching conversation, and — when the title stage found
 * nothing — the A4 empty state with the body search and the New chat (C-154-4). Nothing here invents a value:
 * the names come from the list door and the excerpts from the search door.
 */

import type { SearchResult } from "../engine/contract";
import { WORDS } from "../strings";
import { activeIdOf, bodyShown, notFound, titleRows, type ChatSearchState } from "./store";

export interface SearchHandlers {
  open: () => void;
  close: () => void;
  setQuery: (text: string) => void;
  /** Enter or the button: ask the search door once for the word */
  searchBody: () => void;
  /** open a conversation, whether the title stage or the body stage offered it */
  select: (id: string) => void;
  /** the A4 empty state's second button: make a conversation with the word left in its box */
  newChat: () => void;
}

/** one matching conversation of the title stage */
export interface SearchRowView {
  id: string;
  name: string;
  mode: string;
  active: boolean;
  select: () => void;
}

/** one conversation the body stage found, with the entries that held the word */
export interface SearchHitRowView {
  id: string;
  /** the conversation's own name; an unnamed one is drawn as the screen's 無題, as the list does */
  title: string;
  hits: { role: string; excerpt: string }[];
  select: () => void;
  active: boolean;
}

export interface SearchView {
  /** the field is up over the screen */
  shown: boolean;
  /** the word in the box */
  query: string;
  /** open the field from a control (`data-part="search-trigger"` or the list's magnifier) */
  open: () => void;
  setQuery: (text: string) => void;
  close: () => void;
  /** the title stage's rows; an empty word offers every candidate */
  rows: SearchRowView[];
  /** the body stage's rows, empty until the search door answers */
  hits: SearchHitRowView[];
  /** the search door's answer is on screen */
  bodyShown: boolean;
  bodyBusy: boolean;
  bodyError: string | null;
  /** the answer held more conversations than the engine returned */
  bodyTruncated: boolean;
  /** the body stage answered with nothing */
  bodyEmpty: boolean;
  /** the prototype A4's empty state: the title stage found nothing and the body was not asked */
  notFound: boolean;
  candidatesBusy: boolean;
  candidatesDown: boolean;
  /** Enter or the button */
  searchBody: () => void;
  /** the A4 empty state's second button */
  newChat: () => void;
  labels: {
    placeholder: string;
    key: string;
    notFoundHeading: string;
    titleOnly: string;
    bodySearch: string;
    bodyEmpty: string;
    bodyTruncated: string;
    newChat: string;
    loading: string;
    listDown: string;
  };
}

function roleLabel(role: string): string {
  if (role === "user") return WORDS.search.roles.user;
  if (role === "assistant") return WORDS.search.roles.assistant;
  return WORDS.search.roles.session;
}

function hitRows(results: SearchResult[], selected: string | null, on: SearchHandlers): SearchHitRowView[] {
  return results.map((result) => ({
    id: result.sessionId,
    title: result.name || WORDS.chat.untitled,
    hits: (result.hits ?? []).map((hit) => ({ role: roleLabel(hit.role), excerpt: hit.excerpt })),
    select: () => on.select(result.sessionId),
    active: result.sessionId === selected,
  }));
}

export function searchVals(state: ChatSearchState, on: SearchHandlers): SearchView {
  const body = bodyShown(state);
  const activeId = activeIdOf(state);
  const title = titleRows(state);
  return {
    shown: state.open,
    query: state.query,
    open: on.open,
    setQuery: on.setQuery,
    close: on.close,
    rows: title.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      mode: candidate.mode,
      active: candidate.id === activeId,
      select: () => on.select(candidate.id),
    })),
    hits: body ? hitRows(body.results, activeId, on) : [],
    bodyShown: body !== null,
    bodyBusy: state.bodyBusy,
    bodyError: state.bodyError,
    bodyTruncated: body?.truncated === true,
    bodyEmpty: body !== null && body.results.length === 0,
    notFound: notFound(state),
    candidatesBusy: state.candidatesBusy,
    candidatesDown: state.candidatesDown,
    searchBody: on.searchBody,
    newChat: on.newChat,
    labels: {
      placeholder: WORDS.search.placeholder,
      key: WORDS.search.key,
      notFoundHeading: WORDS.search.notFoundHeading,
      titleOnly: WORDS.search.titleOnly,
      bodySearch: WORDS.search.bodySearch,
      bodyEmpty: WORDS.search.bodyEmpty,
      bodyTruncated: WORDS.search.bodyTruncated,
      newChat: WORDS.search.newChat,
      loading: WORDS.search.loading,
      listDown: WORDS.search.listDown,
    },
  };
}
