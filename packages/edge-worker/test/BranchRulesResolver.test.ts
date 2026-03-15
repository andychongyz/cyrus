import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = join(tmpdir(), `branch-rules-test-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => TMP };
});

// Import after vi.mock so the mock is in place
const { BranchRulesResolver } = await import("../src/BranchRulesResolver.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeRules(repoId: string, content: string) {
	const dir = join(TMP, ".cyrus", "branching_rules", repoId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "BRANCHING_RULES.md"), content, "utf-8");
}

function mockFetch(response: unknown, ok = true) {
	return vi.fn().mockResolvedValue({
		ok,
		status: ok ? 200 : 500,
		json: async () => response,
	});
}

const BASE_OPTS = {
	repoId: "repo-1",
	issueTitle: "Fix login crash",
	issueDescription: "Users cannot log in on production",
	issueLabels: ["bug"],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BranchRulesResolver", () => {
	let resolver: InstanceType<typeof BranchRulesResolver>;

	beforeEach(() => {
		mkdirSync(TMP, { recursive: true });
		resolver = new BranchRulesResolver();
		process.env.ANTHROPIC_API_KEY = "test-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.ANTHROPIC_API_KEY;
		if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
	});

	it("returns undefined when BRANCHING_RULES.md does not exist", async () => {
		const result = await resolver.resolve(BASE_OPTS);
		expect(result).toBeUndefined();
	});

	it("returns undefined and warns when ANTHROPIC_API_KEY is not set", async () => {
		delete process.env.ANTHROPIC_API_KEY;
		writeRules("repo-1", "- hotfix → base: master, prefix: hotfix/");

		const result = await resolver.resolve(BASE_OPTS);
		expect(result).toBeUndefined();
	});

	it("returns undefined when the API call fails (non-ok response)", async () => {
		writeRules("repo-1", "- hotfix → base: master, prefix: hotfix/");
		vi.stubGlobal("fetch", mockFetch({}, false));

		const result = await resolver.resolve(BASE_OPTS);
		expect(result).toBeUndefined();
	});

	it("returns undefined when LLM returns no text content", async () => {
		writeRules("repo-1", "- default → base: main, prefix: feature/");
		vi.stubGlobal(
			"fetch",
			mockFetch({ content: [{ type: "image", text: "" }] }),
		);

		const result = await resolver.resolve(BASE_OPTS);
		expect(result).toBeUndefined();
	});

	it("returns undefined when LLM returns malformed JSON", async () => {
		writeRules("repo-1", "- default → base: main, prefix: feature/");
		vi.stubGlobal(
			"fetch",
			mockFetch({ content: [{ type: "text", text: "not valid json" }] }),
		);

		const result = await resolver.resolve(BASE_OPTS);
		expect(result).toBeUndefined();
	});

	it("strips markdown fences before parsing JSON", async () => {
		writeRules("repo-1", "- default → base: main, prefix: feature/");
		vi.stubGlobal(
			"fetch",
			mockFetch({
				content: [
					{
						type: "text",
						text: '```json\n{"base":"main","prefix":"feature/"}\n```',
					},
				],
			}),
		);

		const result = await resolver.resolve(BASE_OPTS);
		expect(result).toEqual({ base: "main", prefix: "feature/" });
	});

	it("returns correct base and prefix on success", async () => {
		writeRules("repo-1", "- hotfix → base: master, prefix: hotfix/");
		vi.stubGlobal(
			"fetch",
			mockFetch({
				content: [
					{ type: "text", text: '{"base":"master","prefix":"hotfix/"}' },
				],
			}),
		);

		const result = await resolver.resolve({
			...BASE_OPTS,
			issueTitle: "Fix prod outage",
			issueLabels: ["hotfix"],
		});
		expect(result).toEqual({ base: "master", prefix: "hotfix/" });
	});

	it("omits fields with empty string values", async () => {
		writeRules("repo-1", "- default → base: main");
		vi.stubGlobal(
			"fetch",
			mockFetch({
				content: [{ type: "text", text: '{"base":"main","prefix":""}' }],
			}),
		);

		const result = await resolver.resolve(BASE_OPTS);
		expect(result).toEqual({ base: "main", prefix: undefined });
	});

	it("ignores non-string values in parsed JSON", async () => {
		writeRules("repo-1", "- default → base: main, prefix: feature/");
		vi.stubGlobal(
			"fetch",
			mockFetch({
				content: [{ type: "text", text: '{"base":123,"prefix":["a","b"]}' }],
			}),
		);

		const result = await resolver.resolve(BASE_OPTS);
		expect(result).toEqual({ base: undefined, prefix: undefined });
	});

	it("caches results and does not call the API twice for the same key", async () => {
		writeRules("repo-1", "- default → base: main, prefix: feature/");
		const fetchMock = mockFetch({
			content: [{ type: "text", text: '{"base":"main","prefix":"feature/"}' }],
		});
		vi.stubGlobal("fetch", fetchMock);

		await resolver.resolve(BASE_OPTS);
		await resolver.resolve(BASE_OPTS);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
