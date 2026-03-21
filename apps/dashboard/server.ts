/**
 * Cyrus Dashboard Backend
 * Thin Express server that reads/writes ~/.cyrus/config.json and ~/.cyrus/.env directly.
 * Proxies session endpoints to the running Cyrus process.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Serve built frontend in production
const distPath = path.join(__dirname, "dist");
if (fs.existsSync(distPath)) {
	app.use(express.static(distPath));
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const CYRUS_HOME = path.join(process.env.HOME ?? "~", ".cyrus");
const CONFIG_PATH = path.join(CYRUS_HOME, "config.json");
const ENV_PATH = path.join(CYRUS_HOME, ".env");
const DASHBOARD_CONFIG_PATH = path.join(CYRUS_HOME, "dashboard.json");
const BRANCHING_RULES_DIR = path.join(CYRUS_HOME, "branching_rules");

const DEFAULT_BRANCHING_RULES = `# Branching Rules

Use these rules to determine the base branch and branch name prefix for each issue.

- If the issue has a "hotfix" label, or the title/description mentions words like
  "urgent", "critical", "production issue", or "outage" → base: main, prefix: hotfix/
- Default for everything else → base: main, prefix: feature/
`;

function branchingRulesPath(repoId: string): string {
	if (!repoId || /[/\\]|\.\./.test(repoId)) {
		throw new Error(`Invalid repository ID: ${repoId}`);
	}
	const resolved = path.resolve(
		path.join(BRANCHING_RULES_DIR, repoId, "BRANCHING_RULES.md"),
	);
	if (!resolved.startsWith(path.resolve(BRANCHING_RULES_DIR) + path.sep)) {
		throw new Error(`Path traversal detected for repoId: ${repoId}`);
	}
	return resolved;
}

function ensureBranchingRulesFile(repoId: string): void {
	const filePath = branchingRulesPath(repoId);
	if (!fs.existsSync(filePath)) {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, DEFAULT_BRANCHING_RULES, "utf-8");
	}
}

// ─── Dashboard connection config ──────────────────────────────────────────────

interface DashboardConfig {
	cyrusUrl: string;
	apiKey: string;
}

function readDashboardConfig(): DashboardConfig | null {
	try {
		if (!fs.existsSync(DASHBOARD_CONFIG_PATH)) return null;
		return JSON.parse(fs.readFileSync(DASHBOARD_CONFIG_PATH, "utf-8"));
	} catch {
		return null;
	}
}

function writeDashboardConfig(config: DashboardConfig): void {
	fs.mkdirSync(CYRUS_HOME, { recursive: true });
	fs.writeFileSync(DASHBOARD_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── Config endpoints ─────────────────────────────────────────────────────────

app.get("/api/config", (_req, res) => {
	try {
		if (!fs.existsSync(CONFIG_PATH)) {
			return res.json({ repositories: [] });
		}
		const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
		return res.json(JSON.parse(raw));
	} catch (err) {
		return res.status(500).json({ error: String(err) });
	}
});

app.post("/api/config", (req, res) => {
	try {
		fs.mkdirSync(CYRUS_HOME, { recursive: true });
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2));
		// Ensure BRANCHING_RULES.md exists for each repository
		const repos: Array<{ id: string }> = req.body.repositories ?? [];
		for (const repo of repos) {
			if (repo.id) ensureBranchingRulesFile(repo.id);
		}
		return res.json({ success: true });
	} catch (err) {
		return res.status(500).json({ error: String(err) });
	}
});

// ─── Repository endpoints ─────────────────────────────────────────────────────

app.put("/api/repositories/:id", (req, res) => {
	try {
		const config = fs.existsSync(CONFIG_PATH)
			? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"))
			: { repositories: [] };

		const repos: unknown[] = config.repositories ?? [];
		const idx = repos.findIndex(
			(r: unknown) => (r as { id: string }).id === req.params.id,
		);
		if (idx >= 0) {
			repos[idx] = req.body;
		} else {
			repos.push(req.body);
			// Auto-create BRANCHING_RULES.md for new repositories
			ensureBranchingRulesFile(req.params.id);
		}
		config.repositories = repos;
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
		return res.json({ success: true });
	} catch (err) {
		return res.status(500).json({ error: String(err) });
	}
});

app.delete("/api/repositories/:id", (req, res) => {
	try {
		if (!fs.existsSync(CONFIG_PATH)) return res.json({ success: true });
		const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
		config.repositories = (config.repositories ?? []).filter(
			(r: unknown) => (r as { id: string }).id !== req.params.id,
		);
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
		return res.json({ success: true });
	} catch (err) {
		return res.status(500).json({ error: String(err) });
	}
});

// ─── Branching rules endpoints ────────────────────────────────────────────────

app.get("/api/repositories/:id/branching-rules", (req, res) => {
	try {
		const filePath = branchingRulesPath(req.params.id);
		if (!fs.existsSync(filePath)) {
			ensureBranchingRulesFile(req.params.id);
		}
		const content = fs.readFileSync(filePath, "utf-8");
		return res.json({ content });
	} catch (err) {
		return res.status(500).json({ error: String(err) });
	}
});

app.put("/api/repositories/:id/branching-rules", (req, res) => {
	try {
		const content = req.body.content;
		if (
			content !== undefined &&
			content !== null &&
			typeof content !== "string"
		) {
			return res.status(400).json({ error: "content must be a string" });
		}
		const filePath = branchingRulesPath(req.params.id);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
			typeof content === "string" ? content : "",
			"utf-8",
		);
		return res.json({ success: true });
	} catch (err) {
		return res.status(500).json({ error: String(err) });
	}
});

// ─── Env endpoints ────────────────────────────────────────────────────────────

const SECRET_KEYS = new Set([
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"GEMINI_API_KEY",
	"LINEAR_CLIENT_SECRET",
	"LINEAR_WEBHOOK_SECRET",
	"CYRUS_API_KEY",
	"CLOUDFLARE_TOKEN",
	"NGROK_AUTH_TOKEN",
	"SLACK_BOT_TOKEN",
	"SLACK_SIGNING_SECRET",
]);

function parseEnvFile(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx < 0) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		const val = trimmed
			.slice(eqIdx + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		result[key] = val;
	}
	return result;
}

function serializeEnvFile(env: Record<string, string>): string {
	return `${Object.entries(env)
		.map(([k, v]) => `${k}=${v}`)
		.join("\n")}\n`;
}

app.get("/api/env", (_req, res) => {
	try {
		const raw = fs.existsSync(ENV_PATH)
			? fs.readFileSync(ENV_PATH, "utf-8")
			: "";
		const parsed = parseEnvFile(raw);
		// Mask secret values
		const masked: Record<string, { value: string; isSecret: boolean }> = {};
		for (const [k, v] of Object.entries(parsed)) {
			masked[k] = {
				value: SECRET_KEYS.has(k) ? "••••••••" : v,
				isSecret: SECRET_KEYS.has(k),
			};
		}
		return res.json({ env: masked });
	} catch (err) {
		return res.status(500).json({ error: String(err) });
	}
});

app.post("/api/env", (req, res) => {
	try {
		// Merge: read existing, apply updates (skip masked placeholders)
		const existing = fs.existsSync(ENV_PATH)
			? parseEnvFile(fs.readFileSync(ENV_PATH, "utf-8"))
			: {};
		const updates: Record<string, string> = req.body.env ?? {};
		for (const [k, v] of Object.entries(updates)) {
			if (v === "••••••••") continue; // Don't overwrite with placeholder
			existing[k] = v;
		}
		fs.mkdirSync(CYRUS_HOME, { recursive: true });
		fs.writeFileSync(ENV_PATH, serializeEnvFile(existing));
		return res.json({ success: true });
	} catch (err) {
		return res.status(500).json({ error: String(err) });
	}
});

// ─── Dashboard connection config endpoint ─────────────────────────────────────

app.get("/api/dashboard-config", (_req, res) => {
	const cfg = readDashboardConfig();
	return res.json(cfg ?? { cyrusUrl: "http://localhost:3456", apiKey: "" });
});

app.post("/api/dashboard-config", (req, res) => {
	try {
		writeDashboardConfig(req.body);
		return res.json({ success: true });
	} catch (err) {
		return res.status(500).json({ error: String(err) });
	}
});

// ─── Fallback to index.html for SPA ──────────────────────────────────────────

app.get("*", (_req, res) => {
	const indexPath = path.join(distPath, "index.html");
	if (fs.existsSync(indexPath)) {
		res.sendFile(indexPath);
	} else {
		res.status(404).send("Dashboard not built. Run `pnpm build` first.");
	}
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.DASHBOARD_PORT ?? 3457);
app.listen(PORT, () => {
	console.log(`Cyrus Dashboard backend running at http://localhost:${PORT}`);
});
