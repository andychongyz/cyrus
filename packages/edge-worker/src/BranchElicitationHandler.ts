/**
 * Handler for interactive branch elicitation via Linear's select signal.
 *
 * When an issue is assigned to Cyrus and does NOT have a "hotfix" label,
 * this handler asks the issue creator whether the fix is urgent (hotfix)
 * or can wait for the next release (normal). The user's response determines
 * the base branch and prefix used for the worktree.
 *
 * If the issue already has a "hotfix" label, the question is skipped and
 * the hotfix branch config is used automatically.
 *
 * Follows the same "elicit and wait" pattern as AskUserQuestionHandler
 * and RepositoryRouter.elicitUserRepositorySelection.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
	AgentSessionCreatedWebhook,
	IIssueTrackerService,
	ILogger,
	RepositoryConfig,
} from "cyrus-core";
import { AgentActivitySignal, createLogger } from "cyrus-core";

// BranchRule type from BranchRulesResolver is not needed here — we parse rules independently

// ── Types ───────────────────────────────────────────────────────────

export interface BranchElicitationChoice {
	/** Whether the user chose hotfix */
	readonly isHotfix: boolean;
	/** Resolved base branch */
	readonly baseBranch: string;
	/** Resolved branch prefix */
	readonly prefix: string;
}

export interface ParsedBranchTargets {
	/** Base branch for hotfix (e.g. "master") */
	readonly hotfixBase: string;
	/** Prefix for hotfix branches (e.g. "hotfix") */
	readonly hotfixPrefix: string;
	/** Base branch for normal work (e.g. "develop") */
	readonly normalBase: string;
	/** Prefix for normal branches (e.g. "feature") */
	readonly normalPrefix: string;
}

/**
 * Stored context for a pending elicitation, used to resume session
 * creation after the user responds.
 */
export interface PendingBranchElicitation {
	/** Promise resolver called when the user responds */
	readonly resolve: (choice: BranchElicitationChoice) => void;
	/** Parsed branch targets from BRANCHING_RULES.md */
	readonly targets: ParsedBranchTargets;
	/** All context needed to resume initializeAgentRunner */
	readonly resumeContext: BranchElicitationResumeContext;
}

export interface BranchElicitationResumeContext {
	readonly agentSession: AgentSessionCreatedWebhook["agentSession"];
	readonly repositories: readonly RepositoryConfig[];
	readonly linearWorkspaceId: string;
	readonly guidance?: AgentSessionCreatedWebhook["guidance"];
	readonly commentBody?: string | null;
	readonly baseBranchOverrides?: Map<string, string>;
	readonly routingMethod?: string;
}

export interface BranchElicitationHandlerDeps {
	getIssueTracker: (organizationId: string) => IIssueTrackerService | null;
}

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_HOTFIX_BASE = "master";
const DEFAULT_HOTFIX_PREFIX = "hotfix";
const DEFAULT_NORMAL_BASE = "develop";
const DEFAULT_NORMAL_PREFIX = "feature";

const HOTFIX_LABELS = ["hotfix", "urgent", "critical", "production"];

const HOTFIX_OPTION = "Hotfix — urgent, deploy to production immediately";
const NORMAL_OPTION = "Normal — include in next release";

// ── Handler ─────────────────────────────────────────────────────────

export class BranchElicitationHandler {
	private readonly deps: BranchElicitationHandlerDeps;
	private readonly logger: ILogger;
	private readonly pendingElicitations = new Map<
		string,
		PendingBranchElicitation
	>();

	constructor(deps: BranchElicitationHandlerDeps, logger?: ILogger) {
		this.deps = deps;
		this.logger =
			logger ?? createLogger({ component: "BranchElicitationHandler" });
	}

	// ── Public API ────────────────────────────────────────────────────

	/**
	 * Check whether branch elicitation should be triggered.
	 *
	 * Returns `true` only when:
	 * 1. A BRANCHING_RULES.md file exists for the repo (opt-in gate)
	 * 2. No hotfix-related label is present on the issue
	 */
	shouldElicit(lowercaseLabels: readonly string[], repoId: string): boolean {
		// Only elicit when the repo has branching rules configured
		const filePath = join(
			homedir(),
			".cyrus",
			"branching_rules",
			repoId,
			"BRANCHING_RULES.md",
		);
		if (!existsSync(filePath)) {
			return false;
		}

		return !lowercaseLabels.some((label) => HOTFIX_LABELS.includes(label));
	}

	/**
	 * Check whether the labels indicate a hotfix (regardless of rules file).
	 */
	hasHotfixLabel(lowercaseLabels: readonly string[]): boolean {
		return lowercaseLabels.some((label) => HOTFIX_LABELS.includes(label));
	}

	/**
	 * Resolve the branch choice for an issue that already has a hotfix label.
	 * Skips the question — returns the hotfix branch config immediately.
	 */
	resolveAutoHotfix(repoId: string): BranchElicitationChoice {
		const targets = this.parseBranchTargets(repoId);
		return {
			isHotfix: true,
			baseBranch: targets.hotfixBase,
			prefix: targets.hotfixPrefix,
		};
	}

	/**
	 * Post a branch choice question to Linear and return a promise that
	 * resolves when the user responds.
	 *
	 * Stores the pending elicitation so `handleUserResponse` can resume.
	 */
	async elicitBranchChoice(
		agentSessionId: string,
		linearWorkspaceId: string,
		repoId: string,
		resumeContext: BranchElicitationResumeContext,
	): Promise<BranchElicitationChoice> {
		const issueTracker = this.deps.getIssueTracker(linearWorkspaceId);
		if (!issueTracker) {
			this.logger.error(
				`No issue tracker found for workspace ${linearWorkspaceId}`,
			);
			// Fall back to normal branch
			const targets = this.parseBranchTargets(repoId);
			return {
				isHotfix: false,
				baseBranch: targets.normalBase,
				prefix: targets.normalPrefix,
			};
		}

		// Cancel any existing elicitation for this session
		if (this.pendingElicitations.has(agentSessionId)) {
			this.logger.warn(
				`Replacing existing pending elicitation for session ${agentSessionId}`,
			);
			this.cancelPendingElicitation(
				agentSessionId,
				"Replaced by new elicitation",
			);
		}

		const targets = this.parseBranchTargets(repoId);

		// Post the select signal to Linear
		const options = [{ value: HOTFIX_OPTION }, { value: NORMAL_OPTION }];

		const body = [
			"**Is this issue urgent?**",
			"",
			`• **${HOTFIX_OPTION}**: Branch from \`${targets.hotfixBase}\` with \`${targets.hotfixPrefix}/\` prefix`,
			`• **${NORMAL_OPTION}**: Branch from \`${targets.normalBase}\` with \`${targets.normalPrefix}/\` prefix`,
		].join("\n");

		try {
			await issueTracker.createAgentActivity({
				agentSessionId,
				content: {
					type: "elicitation",
					body,
				},
				signal: AgentActivitySignal.Select,
				signalMetadata: { options },
			});

			this.logger.debug(
				`Posted branch elicitation for session ${agentSessionId}`,
			);
		} catch (error) {
			const errorMessage = (error as Error).message || String(error);
			this.logger.error(`Failed to post branch elicitation: ${errorMessage}`);
			// Fall back to normal
			return {
				isHotfix: false,
				baseBranch: targets.normalBase,
				prefix: targets.normalPrefix,
			};
		}

		// Create promise that resolves when user responds
		return new Promise<BranchElicitationChoice>((resolve) => {
			this.pendingElicitations.set(agentSessionId, {
				resolve,
				targets,
				resumeContext,
			});
		});
	}

	/**
	 * Handle the user's response from a "prompted" webhook.
	 *
	 * @returns The resume context if a pending elicitation was resolved, or `undefined`.
	 */
	handleUserResponse(
		agentSessionId: string,
		selectedValue: string,
	):
		| {
				choice: BranchElicitationChoice;
				resumeContext: BranchElicitationResumeContext;
		  }
		| undefined {
		const pending = this.pendingElicitations.get(agentSessionId);
		if (!pending) {
			this.logger.debug(
				`No pending branch elicitation for session ${agentSessionId}`,
			);
			return undefined;
		}

		this.logger.debug(
			`User responded to branch elicitation for session ${agentSessionId}: ${selectedValue}`,
		);

		const isHotfix =
			selectedValue.toLowerCase().includes("hotfix") ||
			selectedValue.toLowerCase().includes("urgent") ||
			selectedValue.toLowerCase().includes("production");

		const choice: BranchElicitationChoice = isHotfix
			? {
					isHotfix: true,
					baseBranch: pending.targets.hotfixBase,
					prefix: pending.targets.hotfixPrefix,
				}
			: {
					isHotfix: false,
					baseBranch: pending.targets.normalBase,
					prefix: pending.targets.normalPrefix,
				};

		const { resumeContext } = pending;

		// Resolve the promise and clean up
		pending.resolve(choice);
		this.pendingElicitations.delete(agentSessionId);

		return { choice, resumeContext };
	}

	/**
	 * Check if there's a pending elicitation for this session.
	 */
	hasPendingElicitation(agentSessionId: string): boolean {
		return this.pendingElicitations.has(agentSessionId);
	}

	/**
	 * Cancel a pending elicitation, resolving with normal branch defaults.
	 */
	cancelPendingElicitation(agentSessionId: string, reason: string): void {
		const pending = this.pendingElicitations.get(agentSessionId);
		if (pending) {
			this.logger.debug(
				`Cancelling branch elicitation for session ${agentSessionId}: ${reason}`,
			);
			pending.resolve({
				isHotfix: false,
				baseBranch: pending.targets.normalBase,
				prefix: pending.targets.normalPrefix,
			});
			this.pendingElicitations.delete(agentSessionId);
		}
	}

	/**
	 * Get the number of pending elicitations (for debugging/monitoring).
	 */
	get pendingCount(): number {
		return this.pendingElicitations.size;
	}

	// ── Internal ──────────────────────────────────────────────────────

	/**
	 * Parse BRANCHING_RULES.md for a repo to extract hotfix/normal base + prefix.
	 * Falls back to hardcoded defaults if the file doesn't exist or can't be parsed.
	 */
	parseBranchTargets(repoId: string): ParsedBranchTargets {
		const filePath = join(
			homedir(),
			".cyrus",
			"branching_rules",
			repoId,
			"BRANCHING_RULES.md",
		);

		if (!existsSync(filePath)) {
			return {
				hotfixBase: DEFAULT_HOTFIX_BASE,
				hotfixPrefix: DEFAULT_HOTFIX_PREFIX,
				normalBase: DEFAULT_NORMAL_BASE,
				normalPrefix: DEFAULT_NORMAL_PREFIX,
			};
		}

		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			return {
				hotfixBase: DEFAULT_HOTFIX_BASE,
				hotfixPrefix: DEFAULT_HOTFIX_PREFIX,
				normalBase: DEFAULT_NORMAL_BASE,
				normalPrefix: DEFAULT_NORMAL_PREFIX,
			};
		}

		return this.parseRulesContent(content);
	}

	/**
	 * Extract hotfix and normal branch targets from rules content.
	 *
	 * Looks for patterns like:
	 *   "hotfix" ... base: main, prefix: hotfix
	 *   default ... base: develop, prefix: feature
	 *
	 * This is a best-effort heuristic parser. Falls back to defaults
	 * for any field that can't be extracted.
	 */
	parseRulesContent(content: string): ParsedBranchTargets {
		const lines = content.toLowerCase().split("\n");

		let hotfixBase = DEFAULT_HOTFIX_BASE;
		let hotfixPrefix = DEFAULT_HOTFIX_PREFIX;
		let normalBase = DEFAULT_NORMAL_BASE;
		let normalPrefix = DEFAULT_NORMAL_PREFIX;

		for (const line of lines) {
			// Match lines containing base/prefix patterns
			const baseMatch = line.match(/base[:\s]+(\S+)/);
			const prefixMatch = line.match(/prefix[:\s]+(\S+)/);

			const base = baseMatch?.[1]?.replace(/[,;]/g, "");
			const prefix = prefixMatch?.[1]?.replace(/[,;]/g, "");

			if (
				line.includes("hotfix") ||
				line.includes("urgent") ||
				line.includes("critical")
			) {
				if (base) hotfixBase = base;
				if (prefix) hotfixPrefix = prefix;
			} else if (
				line.includes("default") ||
				line.includes("feature") ||
				line.includes("everything else")
			) {
				if (base) normalBase = base;
				if (prefix) normalPrefix = prefix;
			}
		}

		return { hotfixBase, hotfixPrefix, normalBase, normalPrefix };
	}
}
