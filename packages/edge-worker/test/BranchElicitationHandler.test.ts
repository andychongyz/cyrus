import { existsSync } from "node:fs";
import type { IIssueTrackerService } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BranchElicitationHandler,
	type BranchElicitationResumeContext,
} from "../src/BranchElicitationHandler.js";

// Mock fs to control BRANCHING_RULES.md existence
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: vi.fn().mockReturnValue(true), // Default: file exists
		readFileSync: vi.fn().mockReturnValue(`# Branching Rules
- If issue has "hotfix" label: base: master, prefix: hotfix
- Default (everything else): base: develop, prefix: feature
`),
	};
});

/**
 * Unit tests for BranchElicitationHandler.
 *
 * Tests verify the handler correctly:
 * - Detects hotfix labels to skip elicitation
 * - Posts select signal to Linear for branch choice
 * - Resolves hotfix/normal based on user response
 * - Parses BRANCHING_RULES.md for branch targets
 * - Handles cancellation and error scenarios
 */
describe("BranchElicitationHandler", () => {
	let handler: BranchElicitationHandler;
	let mockIssueTracker: IIssueTrackerService;
	let mockGetIssueTracker: (orgId: string) => IIssueTrackerService | null;
	let mockCreateAgentActivity: ReturnType<typeof vi.fn>;

	const makeResumeContext = (
		overrides?: Partial<BranchElicitationResumeContext>,
	): BranchElicitationResumeContext => ({
		agentSession: { id: "session-123", issue: { id: "issue-1" } } as any,
		repositories: [{ id: "repo-1", name: "test-repo" }] as any,
		linearWorkspaceId: "ws-123",
		...overrides,
	});

	beforeEach(() => {
		mockCreateAgentActivity = vi.fn().mockResolvedValue({ success: true });
		mockIssueTracker = {
			createAgentActivity: mockCreateAgentActivity,
		} as unknown as IIssueTrackerService;

		mockGetIssueTracker = vi.fn().mockReturnValue(mockIssueTracker);

		handler = new BranchElicitationHandler({
			getIssueTracker: mockGetIssueTracker,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("shouldElicit", () => {
		it("should return true when no hotfix-related labels present and rules file exists", () => {
			expect(handler.shouldElicit(["feature", "enhancement"], "repo-1")).toBe(
				true,
			);
			expect(handler.shouldElicit([], "repo-1")).toBe(true);
			expect(handler.shouldElicit(["bug", "p1"], "repo-1")).toBe(true);
		});

		it("should return false when no BRANCHING_RULES.md file exists", () => {
			vi.mocked(existsSync).mockReturnValueOnce(false);
			expect(handler.shouldElicit(["feature"], "no-rules-repo")).toBe(false);
		});

		it('should return false when "hotfix" label is present', () => {
			expect(handler.shouldElicit(["hotfix"], "repo-1")).toBe(false);
			expect(handler.shouldElicit(["feature", "hotfix"], "repo-1")).toBe(false);
		});

		it('should return false when "urgent" label is present', () => {
			expect(handler.shouldElicit(["urgent"], "repo-1")).toBe(false);
		});

		it('should return false when "critical" label is present', () => {
			expect(handler.shouldElicit(["critical"], "repo-1")).toBe(false);
		});

		it('should return false when "production" label is present', () => {
			expect(handler.shouldElicit(["production"], "repo-1")).toBe(false);
		});
	});

	describe("hasHotfixLabel", () => {
		it("should return true for hotfix-related labels", () => {
			expect(handler.hasHotfixLabel(["hotfix"])).toBe(true);
			expect(handler.hasHotfixLabel(["urgent"])).toBe(true);
			expect(handler.hasHotfixLabel(["critical"])).toBe(true);
			expect(handler.hasHotfixLabel(["production"])).toBe(true);
		});

		it("should return false for non-hotfix labels", () => {
			expect(handler.hasHotfixLabel(["feature", "enhancement"])).toBe(false);
			expect(handler.hasHotfixLabel([])).toBe(false);
		});
	});

	describe("resolveAutoHotfix", () => {
		it("should return hotfix branch config with defaults when no rules file", () => {
			const choice = handler.resolveAutoHotfix("non-existent-repo");
			expect(choice).toEqual({
				isHotfix: true,
				baseBranch: "master",
				prefix: "hotfix",
			});
		});
	});

	describe("parseRulesContent", () => {
		it("should parse hotfix and default rules", () => {
			const content = `# Branching Rules

- If issue has "hotfix" label: base: main, prefix: hotfix
- Default (everything else): base: develop, prefix: feature
`;
			const targets = handler.parseRulesContent(content);
			expect(targets).toEqual({
				hotfixBase: "main",
				hotfixPrefix: "hotfix",
				normalBase: "develop",
				normalPrefix: "feature",
			});
		});

		it("should parse rules with different branch names", () => {
			const content = `# Rules

- hotfix/urgent/critical: base: master, prefix: fix
- Default: base: staging, prefix: feat
`;
			const targets = handler.parseRulesContent(content);
			expect(targets).toEqual({
				hotfixBase: "master",
				hotfixPrefix: "fix",
				normalBase: "staging",
				normalPrefix: "feat",
			});
		});

		it("should use defaults when content is empty", () => {
			const targets = handler.parseRulesContent("");
			expect(targets).toEqual({
				hotfixBase: "master",
				hotfixPrefix: "hotfix",
				normalBase: "develop",
				normalPrefix: "feature",
			});
		});

		it("should use defaults when content has no matching patterns", () => {
			const targets = handler.parseRulesContent(
				"This is a branching rules file with no parseable patterns.",
			);
			expect(targets).toEqual({
				hotfixBase: "master",
				hotfixPrefix: "hotfix",
				normalBase: "develop",
				normalPrefix: "feature",
			});
		});

		it("should handle rules with trailing commas and semicolons", () => {
			const content = `- hotfix: base: production;, prefix: hotfix;
- everything else: base: develop, prefix: feature;`;
			const targets = handler.parseRulesContent(content);
			expect(targets.hotfixBase).toBe("production");
			expect(targets.normalBase).toBe("develop");
		});
	});

	describe("elicitBranchChoice", () => {
		it("should post select signal to Linear", async () => {
			const resumeContext = makeResumeContext();

			// Start elicitation (don't await — it waits for response)
			const choicePromise = handler.elicitBranchChoice(
				"session-123",
				"ws-123",
				"repo-1",
				resumeContext,
			);

			// Give it time to post the activity
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify the elicitation was posted
			expect(mockCreateAgentActivity).toHaveBeenCalledWith({
				agentSessionId: "session-123",
				content: {
					type: "elicitation",
					body: expect.stringContaining("Is this issue urgent"),
				},
				signal: "select",
				signalMetadata: {
					options: [
						{ value: expect.stringContaining("Hotfix") },
						{ value: expect.stringContaining("Normal") },
					],
				},
			});

			// Clean up
			handler.handleUserResponse(
				"session-123",
				"Normal — include in next release",
			);
			await choicePromise;
		});

		it("should return normal defaults when issue tracker unavailable", async () => {
			const noTrackerHandler = new BranchElicitationHandler({
				getIssueTracker: () => null,
			});

			const choice = await noTrackerHandler.elicitBranchChoice(
				"session-123",
				"ws-123",
				"repo-1",
				makeResumeContext(),
			);

			expect(choice).toEqual({
				isHotfix: false,
				baseBranch: "develop",
				prefix: "feature",
			});
		});

		it("should return normal defaults when createAgentActivity fails", async () => {
			mockCreateAgentActivity.mockRejectedValue(new Error("API Error"));

			const choice = await handler.elicitBranchChoice(
				"session-123",
				"ws-123",
				"repo-1",
				makeResumeContext(),
			);

			expect(choice).toEqual({
				isHotfix: false,
				baseBranch: "develop",
				prefix: "feature",
			});
		});

		it("should track pending elicitation", async () => {
			const resumeContext = makeResumeContext();

			expect(handler.hasPendingElicitation("session-123")).toBe(false);

			const choicePromise = handler.elicitBranchChoice(
				"session-123",
				"ws-123",
				"repo-1",
				resumeContext,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(handler.hasPendingElicitation("session-123")).toBe(true);
			expect(handler.pendingCount).toBe(1);

			// Clean up
			handler.handleUserResponse(
				"session-123",
				"Normal — include in next release",
			);
			await choicePromise;

			expect(handler.hasPendingElicitation("session-123")).toBe(false);
			expect(handler.pendingCount).toBe(0);
		});
	});

	describe("handleUserResponse", () => {
		it("should resolve hotfix when user selects hotfix option", async () => {
			const resumeContext = makeResumeContext();

			const choicePromise = handler.elicitBranchChoice(
				"session-123",
				"ws-123",
				"repo-1",
				resumeContext,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			const result = handler.handleUserResponse(
				"session-123",
				"Hotfix — urgent, deploy to production immediately",
			);

			expect(result).toBeDefined();
			expect(result!.choice.isHotfix).toBe(true);
			expect(result!.choice.baseBranch).toBe("master");
			expect(result!.choice.prefix).toBe("hotfix");
			expect(result!.resumeContext).toBe(resumeContext);

			const choice = await choicePromise;
			expect(choice.isHotfix).toBe(true);
		});

		it("should resolve normal when user selects normal option", async () => {
			const resumeContext = makeResumeContext();

			const choicePromise = handler.elicitBranchChoice(
				"session-123",
				"ws-123",
				"repo-1",
				resumeContext,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			const result = handler.handleUserResponse(
				"session-123",
				"Normal — include in next release",
			);

			expect(result).toBeDefined();
			expect(result!.choice.isHotfix).toBe(false);
			expect(result!.choice.baseBranch).toBe("develop");
			expect(result!.choice.prefix).toBe("feature");

			const choice = await choicePromise;
			expect(choice.isHotfix).toBe(false);
		});

		it("should resolve hotfix when user types free-form text with hotfix keywords", async () => {
			const resumeContext = makeResumeContext();

			const choicePromise = handler.elicitBranchChoice(
				"session-123",
				"ws-123",
				"repo-1",
				resumeContext,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			const result = handler.handleUserResponse(
				"session-123",
				"This is urgent, needs to go to production ASAP",
			);

			expect(result).toBeDefined();
			expect(result!.choice.isHotfix).toBe(true);

			await choicePromise;
		});

		it("should resolve normal for unrecognized free-form text", async () => {
			const resumeContext = makeResumeContext();

			const choicePromise = handler.elicitBranchChoice(
				"session-123",
				"ws-123",
				"repo-1",
				resumeContext,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			const result = handler.handleUserResponse(
				"session-123",
				"This can wait until next sprint",
			);

			expect(result).toBeDefined();
			expect(result!.choice.isHotfix).toBe(false);

			await choicePromise;
		});

		it("should return undefined for unknown session", () => {
			const result = handler.handleUserResponse("unknown-session", "Hotfix");
			expect(result).toBeUndefined();
		});
	});

	describe("cancelPendingElicitation", () => {
		it("should resolve with normal defaults on cancellation", async () => {
			const resumeContext = makeResumeContext();

			const choicePromise = handler.elicitBranchChoice(
				"session-123",
				"ws-123",
				"repo-1",
				resumeContext,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			handler.cancelPendingElicitation("session-123", "Session ended");

			const choice = await choicePromise;
			expect(choice.isHotfix).toBe(false);
			expect(choice.baseBranch).toBe("develop");
			expect(choice.prefix).toBe("feature");

			expect(handler.hasPendingElicitation("session-123")).toBe(false);
		});

		it("should be a no-op for unknown session", () => {
			// Should not throw
			handler.cancelPendingElicitation("unknown-session", "test");
		});
	});

	describe("replacing pending elicitation", () => {
		it("should cancel existing elicitation when new one is requested", async () => {
			const resumeContext1 = makeResumeContext();
			const resumeContext2 = makeResumeContext({
				routingMethod: "replaced",
			});

			// Start first elicitation
			const choicePromise1 = handler.elicitBranchChoice(
				"session-123",
				"ws-123",
				"repo-1",
				resumeContext1,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Start second elicitation for same session
			const choicePromise2 = handler.elicitBranchChoice(
				"session-123",
				"ws-123",
				"repo-1",
				resumeContext2,
			);

			// First should resolve with normal defaults (cancelled)
			const choice1 = await choicePromise1;
			expect(choice1.isHotfix).toBe(false);

			// Second should be pending
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(handler.hasPendingElicitation("session-123")).toBe(true);

			// Clean up
			handler.handleUserResponse("session-123", "Hotfix");
			const choice2 = await choicePromise2;
			expect(choice2.isHotfix).toBe(true);
		});
	});
});
