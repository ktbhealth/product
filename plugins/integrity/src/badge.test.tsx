// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { IntegrityBadge } from "./badge.tsx";
import type { IntegrityVerification } from "./index.ts";

const LABELS = {
	verified: "Integrity verified",
	tampered: "Integrity check failed",
	unversioned: "Integrity not recorded",
};

const report = (status: IntegrityVerification["status"]): IntegrityVerification => ({
	status,
	versions: status === "unversioned" ? 0 : 2,
	unverifiableContent: 0,
	signed: 0,
	issues: [],
	head: status === "unversioned" ? null : { version: 2, contentHash: "ab".repeat(32) },
});

afterEach(cleanup);

describe("IntegrityBadge", () => {
	it("renders nothing while the report is loading", () => {
		const { container } = render(<IntegrityBadge report={null} labels={LABELS} />);
		expect(container.innerHTML).toBe("");
	});

	it("shows the verified state", () => {
		render(<IntegrityBadge report={report("verified")} labels={LABELS} />);
		expect(screen.getByText("Integrity verified")).toBeTruthy();
	});

	it("shows the tampered state", () => {
		render(<IntegrityBadge report={report("tampered")} labels={LABELS} />);
		expect(screen.getByText("Integrity check failed")).toBeTruthy();
	});

	it("shows the unversioned state", () => {
		render(<IntegrityBadge report={report("unversioned")} labels={LABELS} />);
		expect(screen.getByText("Integrity not recorded")).toBeTruthy();
	});
});
