import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { IIssueTrackerService } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BranchElicitationHandler,
	type BranchElicitationResumeContext,
	type ParsedElicitation,
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

// Mock child_process to control claude CLI output
vi.mock("node:child_process", async () => {
	const actual =
		await vi.importActual<typeof import("node:child_process")>(
			"node:child_process",
		);
	return {
		...actual,
		execFileSync: vi.fn(),
	};
});

/** Standard LLM response matching the mocked BRANCHING_RULES.md content. */
const STANDARD_LLM_ELICITATION: ParsedElicitation = {
	question: "Is this issue urgent?",
	options: [
		{
			label: "Hotfix — urgent, deploy to production immediately",
			description: "Branch from `master` with `hotfix/` prefix",
			baseBranch: "master",
			prefix: "hotfix",
		},
		{
			label: "Normal — include in next release",
			description: "Branch from `develop` with `feature/` prefix",
			baseBranch: "develop",
			prefix: "feature",
		},
	],
};

/**
 * Unit tests for BranchElicitationHandler.
 *
 * Tests verify the handler correctly:
 * - Detects hotfix labels to skip elicitation
 * - Posts select signal to Linear for branch choice
 * - Resolves hotfix/normal based on user response
 * - Parses BRANCHING_RULES.md via LLM for branch targets
 * - Falls back to defaults when LLM is unavailable
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

	/** Configure the mocked execFileSync to return JSON for the given elicitation. */
	function mockClaudeOutput(elicitation: ParsedElicitation): void {
		vi.mocked(execFileSync).mockReturnValue(JSON.stringify(elicitation));
	}

	beforeEach(() => {
		mockCreateAgentActivity = vi.fn().mockResolvedValue({ success: true });
		mockIssueTracker = {
			createAgentActivity: mockCreateAgentActivity,
		} as unknown as IIssueTrackerService;

		mockGetIssueTracker = vi.fn().mockReturnValue(mockIssueTracker);

		handler = new BranchElicitationHandler({
			getIssueTracker: mockGetIssueTracker,
		});

		// Reset fs mocks to default state (file exists, returns standard content)
		vi.mocked(existsSync).mockReturnValue(true);

		// Mock claude CLI to return standard elicitation JSON
		mockClaudeOutput(STANDARD_LLM_ELICITATION);
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
		it("should return hotfix branch config from LLM", async () => {
			const choice = await handler.resolveAutoHotfix("repo-1");
			expect(choice).toEqual({
				isHotfix: true,
				isQuestion: false,
				baseBranch: "master",
				prefix: "hotfix",
			});
		});

		it("should return defaults when no rules file exists", async () => {
			vi.mocked(existsSync).mockReturnValueOnce(false);
			const choice = await handler.resolveAutoHotfix("non-existent-repo");
			expect(choice).toEqual({
				isHotfix: true,
				isQuestion: false,
				baseBranch: "master",
				prefix: "hotfix",
			});
		});
	});

	describe("parseElicitation", () => {
		it("should call claude CLI and return parsed elicitation", async () => {
			const result = await handler.parseElicitation("repo-1");
			expect(result.question).toBe("Is this issue urgent?");
			expect(result.options).toHaveLength(2);
			expect(result.options[0].baseBranch).toBe("master");
			expect(result.options[0].prefix).toBe("hotfix");
			expect(result.options[1].baseBranch).toBe("develop");
			expect(result.options[1].prefix).toBe("feature");

			// Verify claude was called with correct flags
			expect(execFileSync).toHaveBeenCalledWith(
				"claude",
				expect.arrayContaining([
					"-p",
					"--no-session-persistence",
					"--output-format",
					"text",
					"--model",
					"haiku",
					"--tools",
					"",
				]),
				expect.objectContaining({
					encoding: "utf-8",
					timeout: 30_000,
				}),
			);
		});

		it("should cache LLM results by repoId", async () => {
			await handler.parseElicitation("repo-1");
			await handler.parseElicitation("repo-1");
			// Should only call claude once
			expect(execFileSync).toHaveBeenCalledTimes(1);
		});

		it("should return defaults when no BRANCHING_RULES.md exists", async () => {
			vi.mocked(existsSync).mockReturnValueOnce(false);
			const result = await handler.parseElicitation("no-rules-repo");
			expect(result.options[0].baseBranch).toBe("master");
			expect(result.options[1].baseBranch).toBe("develop");
			expect(execFileSync).not.toHaveBeenCalled();
		});

		it("should return defaults when claude CLI returns invalid JSON", async () => {
			vi.mocked(execFileSync).mockReturnValue("not valid json {{{");
			const result = await handler.parseElicitation("repo-1");
			expect(result.options[0].baseBranch).toBe("master");
		});

		it("should return defaults when claude CLI returns incomplete structure", async () => {
			vi.mocked(execFileSync).mockReturnValue(
				JSON.stringify({
					question: "Is this urgent?",
					options: [{ label: "Hotfix" }], // missing fields
				}),
			);
			const result = await handler.parseElicitation("repo-1");
			expect(result.options[0].baseBranch).toBe("master");
		});

		it("should handle LLM response with markdown code fences", async () => {
			const elicitation: ParsedElicitation = {
				question: "Is this a hotfix?",
				options: [
					{
						label: "Yes, hotfix",
						description: "Branch from `main` with `hotfix/` prefix",
						baseBranch: "main",
						prefix: "hotfix",
					},
					{
						label: "No, normal",
						description: "Branch from `develop` with `feat/` prefix",
						baseBranch: "develop",
						prefix: "feat",
					},
				],
			};
			vi.mocked(execFileSync).mockReturnValue(
				`\`\`\`json\n${JSON.stringify(elicitation)}\n\`\`\``,
			);
			const result = await handler.parseElicitation("repo-1");
			expect(result.question).toBe("Is this a hotfix?");
			expect(result.options[0].baseBranch).toBe("main");
			expect(result.options[1].prefix).toBe("feat");
		});

		it("should normalize trailing slash in prefix", async () => {
			const elicitation: ParsedElicitation = {
				question: "Urgent?",
				options: [
					{
						label: "Hotfix",
						description: "desc",
						baseBranch: "master",
						prefix: "hotfix/",
					},
					{
						label: "Normal",
						description: "desc",
						baseBranch: "develop",
						prefix: "feature/",
					},
				],
			};
			mockClaudeOutput(elicitation);
			const result = await handler.parseElicitation("repo-new");
			expect(result.options[0].prefix).toBe("hotfix");
			expect(result.options[1].prefix).toBe("feature");
		});

		it("should parse git-flow style rules correctly", async () => {
			const gitFlowElicitation: ParsedElicitation = {
				question: "Is this issue urgent?",
				options: [
					{
						label: "Hotfix — urgent, deploy to production immediately",
						description: "Branch from `master` with `hotfix/` prefix",
						baseBranch: "master",
						prefix: "hotfix",
					},
					{
						label: "Normal — include in next release",
						description: "Branch from `develop` with `feature/` prefix",
						baseBranch: "develop",
						prefix: "feature",
					},
				],
			};
			mockClaudeOutput(gitFlowElicitation);
			const result = await handler.parseElicitation("git-flow-repo");
			expect(result.options[0].baseBranch).toBe("master");
			expect(result.options[0].prefix).toBe("hotfix");
			expect(result.options[1].baseBranch).toBe("develop");
			expect(result.options[1].prefix).toBe("feature");
		});

		it("should return defaults when claude CLI is not available", async () => {
			vi.mocked(execFileSync).mockImplementation(() => {
				throw new Error("ENOENT: claude not found");
			});
			const result = await handler.parseElicitation("repo-1");
			expect(result.options[0].baseBranch).toBe("master");
		});

		it("should return defaults when claude CLI times out", async () => {
			vi.mocked(execFileSync).mockImplementation(() => {
				throw new Error("ETIMEDOUT");
			});
			const result = await handler.parseElicitation("repo-1");
			expect(result.options[0].baseBranch).toBe("master");
		});
	});

	describe("elicitBranchChoice", () => {
		it("should post select signal to Linear with LLM-generated prompt", async () => {
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

			// Verify the elicitation was posted with LLM-generated content
			expect(mockCreateAgentActivity).toHaveBeenCalledWith({
				agentSessionId: "session-123",
				content: {
					type: "elicitation",
					body: expect.stringContaining("Is this issue urgent"),
				},
				signal: "select",
				signalMetadata: {
					options: [
						{
							value: expect.stringContaining("Hotfix"),
						},
						{
							value: expect.stringContaining("Normal"),
						},
						{
							value: expect.stringContaining("Question"),
						},
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
				isQuestion: false,
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
				isQuestion: false,
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
			expect(result!.choice.isQuestion).toBe(false);
			expect(result!.choice.baseBranch).toBe("master");
			expect(result!.choice.prefix).toBe("hotfix");
			expect(result!.resumeContext).toBe(resumeContext);

			const choice = await choicePromise;
			expect(choice.isHotfix).toBe(true);
			expect(choice.isQuestion).toBe(false);
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
			expect(result!.choice.isQuestion).toBe(false);
			expect(result!.choice.baseBranch).toBe("develop");
			expect(result!.choice.prefix).toBe("feature");

			const choice = await choicePromise;
			expect(choice.isHotfix).toBe(false);
			expect(choice.isQuestion).toBe(false);
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

		it("should resolve question when user selects question option", async () => {
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
				"Question — research the codebase and answer",
			);

			expect(result).toBeDefined();
			expect(result!.choice.isQuestion).toBe(true);
			expect(result!.choice.isHotfix).toBe(false);
			// Question uses normal branch config
			expect(result!.choice.baseBranch).toBe("develop");
			expect(result!.choice.prefix).toBe("feature");

			const choice = await choicePromise;
			expect(choice.isQuestion).toBe(true);
			expect(choice.isHotfix).toBe(false);
		});

		it("should resolve question when user types free-form text with question keywords", async () => {
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
				"This is just a question about the codebase",
			);

			expect(result).toBeDefined();
			expect(result!.choice.isQuestion).toBe(true);
			expect(result!.choice.isHotfix).toBe(false);

			await choicePromise;
		});

		it("should resolve question for 'research' keyword", async () => {
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
				"I need to research how the auth system works",
			);

			expect(result).toBeDefined();
			expect(result!.choice.isQuestion).toBe(true);
			expect(result!.choice.isHotfix).toBe(false);

			await choicePromise;
		});

		it("should resolve question for 'investigate' keyword", async () => {
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
				"Please investigate this issue",
			);

			expect(result).toBeDefined();
			expect(result!.choice.isQuestion).toBe(true);
			expect(result!.choice.isHotfix).toBe(false);

			await choicePromise;
		});

		it("should prioritize question over hotfix when both keywords present", async () => {
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
				"I have a question about the urgent production issue",
			);

			expect(result).toBeDefined();
			// Question takes priority over hotfix keywords
			expect(result!.choice.isQuestion).toBe(true);
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
			expect(choice.isQuestion).toBe(false);
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
