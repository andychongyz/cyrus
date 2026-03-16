import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ILogger } from "cyrus-core";
import { createLogger } from "cyrus-core";

export interface BranchRule {
	base?: string;
	prefix?: string;
}

/**
 * Resolves branch base and prefix for a Linear issue by reading
 * ~/.cyrus/branching_rules/{repoId}/BRANCHING_RULES.md and asking an LLM.
 *
 * Falls back gracefully (returns undefined) on any error or missing file.
 * Results are cached per repoId+issueTitle to avoid redundant API calls.
 */
export class BranchRulesResolver {
	private logger: ILogger;
	private cache = new Map<string, BranchRule | undefined>();

	constructor(logger?: ILogger) {
		this.logger = logger ?? createLogger({ component: "BranchRulesResolver" });
	}

	private rulesPath(repoId: string): string {
		return join(
			homedir(),
			".cyrus",
			"branching_rules",
			repoId,
			"BRANCHING_RULES.md",
		);
	}

	async resolve(opts: {
		repoId: string;
		issueTitle: string;
		issueDescription?: string | null;
		issueLabels: string[];
	}): Promise<BranchRule | undefined> {
		const cacheKey = `${opts.repoId}:${opts.issueTitle}`;
		if (this.cache.has(cacheKey)) {
			return this.cache.get(cacheKey);
		}

		const filePath = this.rulesPath(opts.repoId);

		if (!existsSync(filePath)) {
			return undefined;
		}

		let rulesContent: string;
		try {
			rulesContent = readFileSync(filePath, "utf-8");
		} catch (err) {
			this.logger.warn(
				`Could not read branching rules file at ${filePath}: ${err}`,
			);
			return undefined;
		}

		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) {
			this.logger.warn(
				"ANTHROPIC_API_KEY not set, skipping LLM branch resolution",
			);
			return undefined;
		}

		const prompt = [
			`Title: ${opts.issueTitle}`,
			`Description: ${opts.issueDescription ?? "(none)"}`,
			`Labels: ${opts.issueLabels.length ? opts.issueLabels.join(", ") : "(none)"}`,
			"",
			"Branching rules:",
			rulesContent,
		].join("\n");

		try {
			const response = await fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: {
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "claude-haiku-4-5-20251001",
					max_tokens: 64,
					system: `You are a branch rule resolver. Given a Linear issue and branching rules, respond with ONLY valid JSON in this exact format: {"base":"<branch>","prefix":"<prefix>"}. Use empty string if not applicable. No explanation, no markdown, just the JSON object.`,
					messages: [{ role: "user", content: prompt }],
				}),
			});

			if (!response.ok) {
				this.logger.warn(
					`LLM branch resolution request failed: ${response.status}`,
				);
				return undefined;
			}

			const data = (await response.json()) as {
				content: Array<{ type: string; text: string }>;
			};
			let text = data.content?.find((b) => b.type === "text")?.text?.trim();
			if (!text) return undefined;

			// Strip markdown code fences that LLMs sometimes include despite instructions
			text = text
				.replace(/^```(?:json)?\s*\n?/i, "")
				.replace(/\n?```\s*$/i, "")
				.trim();

			const parsed = JSON.parse(text);
			const result: BranchRule = {
				base:
					typeof parsed.base === "string"
						? parsed.base || undefined
						: undefined,
				prefix:
					typeof parsed.prefix === "string"
						? parsed.prefix || undefined
						: undefined,
			};
			this.cache.set(cacheKey, result);
			return result;
		} catch (err) {
			this.logger.warn(`LLM branch resolution failed: ${err}`);
			return undefined;
		}
	}
}
