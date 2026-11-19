import {
	cloneElement,
	isValidElement,
	useState,
	type MouseEvent,
	type ReactElement,
	type ReactNode,
} from "react";

import { ConfirmDialog } from "@ktbhealth/ui/components/confirm-dialog";

/**
 * Trigger element contract for {@link ConfirmAction}.
 *
 * Preferred form is a render function receiving `open`:
 *
 * ```tsx
 * <ConfirmAction trigger={(open) => <Button onClick={open}>Delete</Button>} … />
 * ```
 *
 * A plain React element also works — an `onClick` that opens the dialog
 * is injected via `cloneElement`, chaining any `onClick` the element
 * already has. Non-element nodes (strings, fragments) are rendered
 * as-is and cannot open the dialog.
 */
export type ConfirmActionTrigger = ReactNode | ((open: () => void) => ReactNode);

export interface ConfirmActionProps {
	/** See {@link ConfirmActionTrigger}. */
	trigger: ConfirmActionTrigger;
	title: ReactNode;
	description?: ReactNode;
	confirmLabel: ReactNode;
	/** Defaults to "Cancel" (ConfirmDialog default). */
	cancelLabel?: ReactNode;
	variant?: "default" | "destructive";
	/**
	 * Runs when the user confirms. The dialog shows a busy state while
	 * the returned promise is pending and closes once it settles —
	 * resolve or reject. Handle failures inside `onConfirm` (toast,
	 * inline error); a rejection still closes the dialog.
	 */
	onConfirm: () => unknown;
}

/**
 * "Trigger → ConfirmDialog → async action" triple for admin tables:
 * wraps `@ktbhealth/ui`'s ConfirmDialog with internal open/pending
 * state so callers only supply labels and the action.
 */
export function ConfirmAction({
	trigger,
	title,
	description,
	confirmLabel,
	cancelLabel,
	variant,
	onConfirm,
}: ConfirmActionProps) {
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);

	const runConfirm = async () => {
		setPending(true);
		try {
			await onConfirm();
		} finally {
			setPending(false);
			// Close on settle regardless of outcome — ConfirmDialog
			// itself only closes on success, and keeps the dialog open
			// on rejection for retry. Our contract closes either way.
			setOpen(false);
		}
	};

	const openDialog = () => setOpen(true);

	let triggerNode: ReactNode;
	if (typeof trigger === "function") {
		triggerNode = trigger(openDialog);
	} else if (isValidElement<{ onClick?: (event: MouseEvent<HTMLElement>) => void }>(trigger)) {
		const element = trigger as ReactElement<{
			onClick?: (event: MouseEvent<HTMLElement>) => void;
		}>;
		triggerNode = cloneElement(element, {
			onClick: (event: MouseEvent<HTMLElement>) => {
				element.props.onClick?.(event);
				openDialog();
			},
		});
	} else {
		triggerNode = trigger;
	}

	return (
		<>
			{triggerNode}
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title={title}
				description={description}
				confirmLabel={confirmLabel}
				cancelLabel={cancelLabel}
				variant={variant}
				loading={pending}
				onConfirm={runConfirm}
			/>
		</>
	);
}
