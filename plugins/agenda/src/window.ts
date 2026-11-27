/** Window the agenda loaders read — the current week plus margin so
 * the view can page one week either way without a refetch. Shared with
 * the view (T-259): ranges outside it are fetched through `list`. */
export const AGENDA_WINDOW = { pastDays: 14, aheadDays: 21 } as const;

/** Widest range one `list` call may ask for — a 6-week month grid. */
export const MAX_LIST_RANGE_DAYS = 62;
