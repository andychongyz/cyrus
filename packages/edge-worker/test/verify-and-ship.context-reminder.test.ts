/**
 * TDD tests for verify-and-ship PreToolUse context reminder injection.
 *
 * When Claude invokes the `Skill` tool with `{ skill: "verify-and-ship" }`,
 * a PreToolUse hook must inject a fresh `<context_reminder>` block so the
 * correct base branch is visible even after context compression.
 */

import type { HookCallbackMatcher } from "cyrus-claude-runner";
import { beforeEach, describe, expect, it } from "vitest";
import type { IssueRunnerConfigInput } from "../src/RunnerConfigBuilder.js";
import { RunnerConfigBuilder } from "../src/RunnerConfigBuilder.js";

// ─── Minimal mock services ────────────────────────────────────────────────────

const mockChatToolResolver = {
	buildChatAllowedTools: () => [] as string[],
};

const mockMcpConfigProvider = {
	buildMcpConfig: () => ({}) as Record<string, any>,
	buildMergedMcpConfigPath: () => undefined as undefined,
};

const mockRunnerSelector = {
	determineRunnerSelection: () => ({ runnerType: "claude" as const }),
	getDefaultModelForRunner: (_: string) => "claude-sonnet-4-6",
	getDefaultFallbackModelForRunner: (_: string) => undefined as undefined,
};

// ─── Factory helpers ──────────────────────────────────────────────────────────

function makeInput(overrides?: {
	resolvedBaseBranches?: Record<string, { branch: string; source: string }>;
	repoId?: string;
	repoBaseBranch?: string;
}): IssueRunnerConfigInput {
	const repoId = overrides?.repoId ?? "repo-123";
	const repo = {
		id: repoId,
		name: "Test Repo",
		repositoryPath: "/test/repo",
		baseBranch: overrides?.repoBaseBranch ?? "main",
		linearWorkspaceId: "workspace-1",
		labelPrompts: {},
	};
	const session = {
		id: "test-session-id",
		type: "CommentThread",
		status: "active",
		context: "CommentThread",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		repositories: [],
		workspace: {
			path: "/test/workspace",
			isGitWorktree: false,
			resolvedBaseBranches: overrides?.resolvedBaseBranches,
		},
	};

	return {
		session: session as any,
		repository: repo as any,
		sessionId: "session-1",
		systemPrompt: undefined,
		allowedTools: [],
		allowedDirectories: ["/test/workspace"],
		disallowedTools: [],
		cyrusHome: "/test/.cyrus",
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		} as any,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "workspace-1",
	};
}

/**
 * Invoke the first matching PreToolUse hook and return its result.
 * Returns `{ continue: true }` if no hook matches.
 */
async function invokePreToolUseHook(
	matchers: HookCallbackMatcher[],
	toolName: string,
	toolInput: unknown,
): Promise<Record<string, unknown>> {
	const hookInput = {
		hook_event_name: "PreToolUse" as const,
		tool_name: toolName,
		tool_input: toolInput,
		tool_use_id: "tool-use-1",
	};
	for (const { matcher, hooks } of matchers) {
		if (matcher && !new RegExp(matcher).test(toolName)) continue;
		for (const hook of hooks) {
			const result = await hook(hookInput as any, "tool-use-1", {
				signal: new AbortController().signal,
			});
			return result as Record<string, unknown>;
		}
	}
	return { continue: true };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("verify-and-ship PreToolUse context reminder hook", () => {
	let builder: RunnerConfigBuilder;

	beforeEach(() => {
		builder = new RunnerConfigBuilder(
			mockChatToolResolver as any,
			mockMcpConfigProvider as any,
			mockRunnerSelector as any,
		);
	});

	it("buildIssueConfig produces a PreToolUse hook when resolvedBaseBranches is set", () => {
		const input = makeInput({
			resolvedBaseBranches: {
				"repo-123": { branch: "main", source: "default" },
			},
		});
		const { config } = builder.buildIssueConfig(input);
		expect(config.hooks?.PreToolUse).toBeDefined();
		expect(config.hooks!.PreToolUse!.length).toBeGreaterThan(0);
	});

	it("injects context_reminder for verify-and-ship (normal branch)", async () => {
		const input = makeInput({
			resolvedBaseBranches: {
				"repo-123": { branch: "main", source: "default" },
			},
		});
		const { config } = builder.buildIssueConfig(input);

		const result = await invokePreToolUseHook(
			config.hooks!.PreToolUse!,
			"Skill",
			{ skill: "verify-and-ship" },
		);

		expect(result).toMatchObject({
			continue: true,
			additionalContext: `<context_reminder>
  <base_branch>main</base_branch>
</context_reminder>`,
		});
	});

	it("injects resolvedBaseBranches branch, not the repo default", async () => {
		const input = makeInput({
			resolvedBaseBranches: {
				"repo-123": { branch: "release/1.2", source: "commit-ish" },
			},
			repoBaseBranch: "main",
		});
		const { config } = builder.buildIssueConfig(input);

		const result = await invokePreToolUseHook(
			config.hooks!.PreToolUse!,
			"Skill",
			{ skill: "verify-and-ship" },
		);

		expect(result.additionalContext).toBe(`<context_reminder>
  <base_branch>release/1.2</base_branch>
</context_reminder>`);
	});

	it("falls back to repo.baseBranch when repo is absent from resolvedBaseBranches", async () => {
		const input = makeInput({
			resolvedBaseBranches: {
				"some-other-repo": { branch: "master", source: "default" },
			},
			repoId: "repo-123",
			repoBaseBranch: "develop",
		});
		const { config } = builder.buildIssueConfig(input);

		const result = await invokePreToolUseHook(
			config.hooks!.PreToolUse!,
			"Skill",
			{ skill: "verify-and-ship" },
		);

		expect(result.additionalContext).toBe(`<context_reminder>
  <base_branch>develop</base_branch>
</context_reminder>`);
	});

	it("injects hotfix reminder when source is hotfix-elicitation", async () => {
		const input = makeInput({
			resolvedBaseBranches: {
				"repo-123": { branch: "master", source: "hotfix-elicitation" },
			},
		});
		const { config } = builder.buildIssueConfig(input);

		const result = await invokePreToolUseHook(
			config.hooks!.PreToolUse!,
			"Skill",
			{ skill: "verify-and-ship" },
		);

		expect(result.additionalContext).toBe(`<context_reminder>
  <base_branch>master</base_branch>
  <branch_type>hotfix</branch_type>
  <branch_note>This is a hotfix. PRs MUST target "master".</branch_note>
</context_reminder>`);
	});

	it("does NOT inject hotfix reminder for non-hotfix sources", async () => {
		const input = makeInput({
			resolvedBaseBranches: {
				"repo-123": { branch: "master", source: "commit-ish" },
			},
		});
		const { config } = builder.buildIssueConfig(input);

		const result = await invokePreToolUseHook(
			config.hooks!.PreToolUse!,
			"Skill",
			{ skill: "verify-and-ship" },
		);

		expect(result.additionalContext).toBe(`<context_reminder>
  <base_branch>master</base_branch>
</context_reminder>`);
	});

	it("does NOT inject additionalContext for other skills (e.g., coding-activity)", async () => {
		const input = makeInput({
			resolvedBaseBranches: {
				"repo-123": { branch: "main", source: "default" },
			},
		});
		const { config } = builder.buildIssueConfig(input);

		const result = await invokePreToolUseHook(
			config.hooks!.PreToolUse!,
			"Skill",
			{ skill: "coding-activity" },
		);

		expect(result.additionalContext).toBeUndefined();
	});

	it("does NOT inject additionalContext for non-Skill tool names", async () => {
		const input = makeInput({
			resolvedBaseBranches: {
				"repo-123": { branch: "main", source: "default" },
			},
		});
		const { config } = builder.buildIssueConfig(input);

		const result = await invokePreToolUseHook(
			config.hooks!.PreToolUse!,
			"Bash",
			{ command: "git status" },
		);

		expect(result.additionalContext).toBeUndefined();
	});

	it("allows the tool to continue in all cases", async () => {
		const input = makeInput({
			resolvedBaseBranches: {
				"repo-123": { branch: "main", source: "default" },
			},
		});
		const { config } = builder.buildIssueConfig(input);

		for (const [toolName, toolInput] of [
			["Skill", { skill: "verify-and-ship" }],
			["Skill", { skill: "coding-activity" }],
			["Bash", { command: "git status" }],
		] as const) {
			const result = await invokePreToolUseHook(
				config.hooks!.PreToolUse!,
				toolName as string,
				toolInput,
			);
			expect(result.continue).toBe(true);
		}
	});
});
