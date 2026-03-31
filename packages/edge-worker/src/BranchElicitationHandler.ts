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
 * Branch targets are extracted from BRANCHING_RULES.md using an LLM
 * (Haiku) to handle free-form markdown reliably. Falls back to hardcoded
 * defaults when the API key is missing or the call fails.
 *
 * Follows the same "elicit and wait" pattern as AskUserQuestionHandler
 * and RepositoryRouter.elicitUserRepositorySelection.
 */

import { execFileSync } from "node:child_process";
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

// ── Types ───────────────────────────────────────────────────────────

export interface BranchElicitationChoice {
	/** Whether the user chose hotfix */
	readonly isHotfix: boolean;
	/** Resolved base branch */
	readonly baseBranch: string;
	/** Resolved branch prefix */
	readonly prefix: string;
}

/** A single branch option extracted from BRANCHING_RULES.md by the LLM. */
export interface ParsedBranchOption {
	/** Short user-facing label (e.g. "Hotfix — urgent, deploy immediately") */
	readonly label: string;
	/** One-line description of what this option does (e.g. "Branch from `master` with `hotfix/` prefix") */
	readonly description: string;
	/** Git base branch to branch from */
	readonly baseBranch: string;
	/** Branch name prefix (without trailing /) */
	readonly prefix: string;
}

/** The full elicitation prompt extracted from BRANCHING_RULES.md. */
export interface ParsedElicitation {
	/** Question to ask the user (e.g. "Is this issue urgent?") */
	readonly question: string;
	/** Exactly two options: [0] = hotfix/urgent, [1] = normal/default */
	readonly options: readonly [ParsedBranchOption, ParsedBranchOption];
}

/**
 * Stored context for a pending elicitation, used to resume session
 * creation after the user responds.
 */
export interface PendingBranchElicitation {
	/** Promise resolver called when the user responds */
	readonly resolve: (choice: BranchElicitationChoice) => void;
	/** Parsed elicitation from BRANCHING_RULES.md */
	readonly elicitation: ParsedElicitation;
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

const HOTFIX_LABELS = ["hotfix", "urgent", "critical", "production"];

/** Default elicitation used when no BRANCHING_RULES.md exists or LLM parsing fails. */
const DEFAULT_ELICITATION: ParsedElicitation = {
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

const LLM_SYSTEM_PROMPT = `You are a branch-rule parser. Given a BRANCHING_RULES.md file, extract the two branch strategies it describes and return ONLY valid JSON in this exact format (no markdown, no explanation):

{
  "question": "<short question to ask the user, e.g. Is this issue urgent?>",
  "options": [
    {
      "label": "<short label for the urgent/hotfix option>",
      "description": "<one-line description, e.g. Branch from \`master\` with \`hotfix/\` prefix>",
      "baseBranch": "<git branch name>",
      "prefix": "<branch name prefix without trailing slash>"
    },
    {
      "label": "<short label for the normal/default option>",
      "description": "<one-line description, e.g. Branch from \`develop\` with \`feature/\` prefix>",
      "baseBranch": "<git branch name>",
      "prefix": "<branch name prefix without trailing slash>"
    }
  ]
}

Rules:
- The first option must be the urgent/hotfix option
- The second option must be the normal/default option
- Keep labels concise (under 60 characters)
- Include backtick-formatted branch names in descriptions
- prefix must NOT include a trailing slash`;

// ── Handler ─────────────────────────────────────────────────────────

export class BranchElicitationHandler {
	private readonly deps: BranchElicitationHandlerDeps;
	private readonly logger: ILogger;
	private readonly pendingElicitations = new Map<
		string,
		PendingBranchElicitation
	>();
	/** Cache parsed elicitations by repoId to avoid redundant LLM calls. */
	private readonly elicitationCache = new Map<string, ParsedElicitation>();

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
	async resolveAutoHotfix(repoId: string): Promise<BranchElicitationChoice> {
		const elicitation = await this.parseElicitation(repoId);
		const hotfix = elicitation.options[0];
		return {
			isHotfix: true,
			baseBranch: hotfix.baseBranch,
			prefix: hotfix.prefix,
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
			const elicitation = await this.parseElicitation(repoId);
			const normal = elicitation.options[1];
			return {
				isHotfix: false,
				baseBranch: normal.baseBranch,
				prefix: normal.prefix,
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

		const elicitation = await this.parseElicitation(repoId);
		const [hotfixOption, normalOption] = elicitation.options;

		// Post the select signal to Linear
		const options = [
			{ value: hotfixOption.label },
			{ value: normalOption.label },
		];

		const body = [
			`**${elicitation.question}**`,
			"",
			`• **${hotfixOption.label}**: ${hotfixOption.description}`,
			`• **${normalOption.label}**: ${normalOption.description}`,
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
			return {
				isHotfix: false,
				baseBranch: normalOption.baseBranch,
				prefix: normalOption.prefix,
			};
		}

		// Create promise that resolves when user responds
		return new Promise<BranchElicitationChoice>((resolve) => {
			this.pendingElicitations.set(agentSessionId, {
				resolve,
				elicitation,
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

		const [hotfixOption, normalOption] = pending.elicitation.options;

		// Match the selected value against the hotfix option label or common keywords
		const lowerSelected = selectedValue.toLowerCase();
		const isHotfix =
			lowerSelected.includes(hotfixOption.label.toLowerCase()) ||
			lowerSelected.includes("hotfix") ||
			lowerSelected.includes("urgent") ||
			lowerSelected.includes("production");

		const chosen = isHotfix ? hotfixOption : normalOption;
		const choice: BranchElicitationChoice = {
			isHotfix,
			baseBranch: chosen.baseBranch,
			prefix: chosen.prefix,
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
			const normalOption = pending.elicitation.options[1];
			pending.resolve({
				isHotfix: false,
				baseBranch: normalOption.baseBranch,
				prefix: normalOption.prefix,
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
	 * Parse BRANCHING_RULES.md for a repo using `claude -p` (Claude Code CLI
	 * in print mode) to extract the elicitation question and branch options.
	 *
	 * Uses whatever auth is already configured (OAuth, API key, etc.)
	 * so no separate ANTHROPIC_API_KEY is required.
	 *
	 * Falls back to hardcoded defaults if:
	 * - The file doesn't exist or can't be read
	 * - The `claude` CLI is not available
	 * - The LLM returns invalid JSON
	 */
	async parseElicitation(repoId: string): Promise<ParsedElicitation> {
		// Check cache first
		const cached = this.elicitationCache.get(repoId);
		if (cached) return cached;

		const filePath = join(
			homedir(),
			".cyrus",
			"branching_rules",
			repoId,
			"BRANCHING_RULES.md",
		);

		if (!existsSync(filePath)) {
			return DEFAULT_ELICITATION;
		}

		let rulesContent: string;
		try {
			rulesContent = readFileSync(filePath, "utf-8");
		} catch {
			return DEFAULT_ELICITATION;
		}

		try {
			const prompt = `${LLM_SYSTEM_PROMPT}\n\nHere is the BRANCHING_RULES.md content to parse:\n\n${rulesContent}`;

			let text = execFileSync(
				"claude",
				[
					"-p",
					prompt,
					"--no-session-persistence",
					"--output-format",
					"text",
					"--model",
					"haiku",
					"--tools",
					"",
				],
				{
					encoding: "utf-8",
					timeout: 30_000,
					stdio: ["pipe", "pipe", "pipe"],
				},
			).trim();

			if (!text) return DEFAULT_ELICITATION;

			// Strip markdown code fences that LLMs sometimes include
			text = text
				.replace(/^```(?:json)?\s*\n?/i, "")
				.replace(/\n?```\s*$/i, "")
				.trim();

			const parsed = JSON.parse(text);
			const result = this.validateElicitation(parsed);
			if (result) {
				this.elicitationCache.set(repoId, result);
				return result;
			}

			this.logger.warn("LLM returned invalid elicitation structure");
			return DEFAULT_ELICITATION;
		} catch (err) {
			this.logger.warn(`LLM elicitation parsing failed: ${err}`);
			return DEFAULT_ELICITATION;
		}
	}

	/**
	 * Validate and normalize the LLM's JSON response into a ParsedElicitation.
	 * Returns undefined if the structure is invalid.
	 */
	private validateElicitation(parsed: unknown): ParsedElicitation | undefined {
		if (!parsed || typeof parsed !== "object") return undefined;
		const obj = parsed as Record<string, unknown>;

		if (typeof obj.question !== "string" || !obj.question) return undefined;
		if (!Array.isArray(obj.options) || obj.options.length !== 2)
			return undefined;

		const options: ParsedBranchOption[] = [];
		for (const opt of obj.options) {
			if (!opt || typeof opt !== "object") return undefined;
			const o = opt as Record<string, unknown>;
			if (
				typeof o.label !== "string" ||
				!o.label ||
				typeof o.description !== "string" ||
				!o.description ||
				typeof o.baseBranch !== "string" ||
				!o.baseBranch ||
				typeof o.prefix !== "string" ||
				!o.prefix
			) {
				return undefined;
			}
			options.push({
				label: o.label,
				description: o.description,
				baseBranch: o.baseBranch,
				// Normalize: strip trailing slash if LLM includes one
				prefix: o.prefix.replace(/\/$/, ""),
			});
		}

		return {
			question: obj.question,
			options: options as unknown as readonly [
				ParsedBranchOption,
				ParsedBranchOption,
			],
		};
	}
}
