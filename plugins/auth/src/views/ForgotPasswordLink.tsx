import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * Shared "forgot password" link — every sign-in surface points it at
 * the same recovery flow; only the label copy differs per catalog.
 * Callers gate it on sign-in mode (sign-up forms don't offer it).
 */
export const ForgotPasswordLink = ({ children }: { children: ReactNode }) => (
	<Link
		to="/forgot-password"
		className="text-sm text-muted-foreground transition hover:text-foreground"
	>
		{children}
	</Link>
);
