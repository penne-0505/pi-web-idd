/**
 * The screen's one key listener, run the way `useModel`'s effect runs it. The tests hand `installScreenKeys` a
 * window stand-in, so the listener can be installed, keys pressed at it, and the calls it makes counted: that is
 * what the effect body does, with no browser.
 *
 * Two regressions are pinned here. A screen that is not the Inbox must keep the Work band it opened with: the
 * effect used to reset `wopen` as soon as it ran, so `#work/all` closed itself and "すべて" never opened. And the
 * settings sheet's own "Close (Esc)" must answer Esc; the effect used to install no listener at all while it was
 * up, so the sheet could not be closed from the keyboard, while the card keys must stay still behind it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { load } from "./helpers.mjs";

const { installScreenKeys } = await load("./src/model/screenKeys.ts");

/** a window that records the keydown listeners a screen installs, and presses a key at the ones it has now */
function keyWindow() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(type, fn) {
      if (type === "keydown") listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === "keydown") listeners.delete(fn);
    },
    press(key, extra = {}) {
      for (const fn of [...listeners]) fn({ key, shiftKey: false, repeat: false, preventDefault() {}, ...extra });
    },
  };
}

/** what a screen's callbacks were asked to do, so the test can read the calls after a key */
function spies() {
  const calls = { closeBand: 0, closeSettings: 0, inbox: [] };
  return {
    calls,
    closeBand: () => calls.closeBand++,
    closeSettings: () => calls.closeSettings++,
    onInboxKey: (event) => calls.inbox.push(event.key),
  };
}

test("F-1: running the screen keys for #work/all keeps the band open, and no card key moves", () => {
  const win = keyWindow();
  const s = spies();
  const remove = installScreenKeys(win, { view: "work", settings: false, wopen: true, ...s });

  // installing answered nothing: the band the URL opened stays open
  assert.deepEqual(s.calls, { closeBand: 0, closeSettings: 0, inbox: [] });
  assert.equal(win.listeners.size, 1, "the band's Esc is answered");

  // a redraw removes the old listener and installs a fresh one, as an effect rerun does; still nothing by itself
  remove();
  const remove2 = installScreenKeys(win, { view: "work", settings: false, wopen: true, ...s });
  assert.equal(s.calls.closeBand, 0, "a redraw never drops the open band");
  assert.equal(s.calls.closeSettings, 0);
  assert.equal(win.listeners.size, 1);

  // the Inbox's card keys are not installed on Work, so an arrow cannot become a decision
  win.press("ArrowRight");
  assert.deepEqual(s.calls.inbox, [], "no card key on a screen that is not the Inbox");

  // Esc is the band's own way out
  win.press("Escape");
  assert.equal(s.calls.closeBand, 1);
  assert.deepEqual(s.calls.inbox, []);

  remove2();
  remove();
  assert.equal(win.listeners.size, 0, "the listener is removed when the screen goes");
});

test("F-1: a non-Inbox screen with no band open installs no listener at all", () => {
  for (const view of ["work", "chat"]) {
    const win = keyWindow();
    const s = spies();
    installScreenKeys(win, { view, settings: false, wopen: false, ...s });
    assert.equal(win.listeners.size, 0);
    win.press("ArrowRight");
    win.press("Escape");
    assert.deepEqual(s.calls, { closeBand: 0, closeSettings: 0, inbox: [] });
  }
});

test("F-2: Esc closes the settings sheet, and the card keys stay still behind it", () => {
  for (const view of ["inbox", "work"]) {
    const win = keyWindow();
    const s = spies();
    installScreenKeys(win, { view, settings: true, wopen: true, ...s });
    assert.equal(win.listeners.size, 1, "the sheet installs one listener");
    assert.deepEqual(s.calls, { closeBand: 0, closeSettings: 0, inbox: [] }, "installing answers nothing");

    win.press("ArrowRight");
    win.press("ArrowLeft");
    assert.deepEqual(s.calls.inbox, [], "no card key reaches behind the sheet");
    assert.equal(s.calls.closeBand, 0, "the band waits for the sheet to close");

    win.press("Escape");
    assert.equal(s.calls.closeSettings, 1, `Esc closes the sheet on ${view}`);
  }
});

test("the Inbox without the sheet installs the card's own keys", () => {
  const win = keyWindow();
  const s = spies();
  const remove = installScreenKeys(win, { view: "inbox", settings: false, wopen: false, ...s });
  assert.equal(win.listeners.size, 1);

  win.press("ArrowRight");
  win.press("Escape");
  assert.deepEqual(s.calls.inbox, ["ArrowRight", "Escape"]);
  assert.equal(s.calls.closeSettings, 0);
  assert.equal(s.calls.closeBand, 0);

  remove();
  assert.equal(win.listeners.size, 0);
});
