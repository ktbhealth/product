import type { ReactNode } from "react";

import { Button } from "@ktbhealth/ui/components/button";

/**
 * Presentational prev/next pager for `TablePage.Footer` — the shared
 * replacement for the hand-rolled footer pagination in admin list
 * pages (document-store, manager). Page numbers/windowing are left to
 * the consumer; this only renders the info slot and the two nav
 * buttons.
 *
 * ```tsx
 * <TablePage.Footer>
 *   <TablePagination
 *     page={pageIndex}
 *     pageCount={pageCount}
 *     onPrev={() => void fetchPage(pageIndex - 1)}
 *     onNext={() => void fetchPage(pageIndex + 1)}
 *     prevLabel={t.prevPage}
 *     nextLabel={t.nextPage}
 *     info={<span className="text-sm text-muted-foreground">{t.pageInfo(pageIndex + 1, pageCount)}</span>}
 *   />
 * </TablePage.Footer>
 * ```
 */

export interface TablePaginationProps {
	/** Zero-based current page index (repo convention — matches
	 * `pageIndex`/`safePage` usage in document-store and manager). */
	readonly page: number;
	/** Total page count; the next button disables at `pageCount - 1`. */
	readonly pageCount: number;
	readonly onPrev: () => void;
	readonly onNext: () => void;
	readonly prevLabel: ReactNode;
	readonly nextLabel: ReactNode;
	/** Optional status/info node rendered before the buttons (e.g. a
	 * "Page X of Y" line). */
	readonly info?: ReactNode;
	/** Forces both buttons disabled regardless of page position. */
	readonly disabled?: boolean;
}

export function TablePagination({
	page,
	pageCount,
	onPrev,
	onNext,
	prevLabel,
	nextLabel,
	info,
	disabled = false,
}: TablePaginationProps) {
	return (
		<div className="flex items-center gap-2">
			{info}
			<Button
				type="button"
				size="sm"
				variant="outline"
				disabled={disabled || page <= 0}
				onClick={onPrev}
			>
				{prevLabel}
			</Button>
			<Button
				type="button"
				size="sm"
				variant="outline"
				disabled={disabled || page >= pageCount - 1}
				onClick={onNext}
			>
				{nextLabel}
			</Button>
		</div>
	);
}
