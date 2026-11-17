/**
 * What a record commit's `beforeCommit` answers: hold this while committing, or do not commit (and whether to try
 * again later). The harness's own commits of a lane's records (the plan's archive, the lane's record directories)
 * take the overlay lock and the proposal's invalidation through it.
 */
export type CommitGate = { release: () => void } | { refuse: string; later: boolean };
