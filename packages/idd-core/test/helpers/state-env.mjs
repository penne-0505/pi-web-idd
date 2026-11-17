import { afterEach, beforeEach } from "node:test";

/**
 * Put IDD_STATE_DIR and IDD_REPOS_FILE back after each test of the file that calls this, so a test that points them
 * at its scratch repo leaves nothing behind for the next one.
 */
export function restoreStateEnv() {
  let saved;
  beforeEach(() => { saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE }; });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
