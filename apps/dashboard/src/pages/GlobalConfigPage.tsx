import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getConfig, getEnv, saveConfig, saveEnv } from "@/api/config";

function TagInput({
	value = [],
	onChange,
}: {
	value?: string[];
	onChange: (v: string[]) => void;
}) {
	const [input, setInput] = useState("");
	const add = () => {
		const t = input.trim();
		if (t && !value.includes(t)) onChange([...value, t]);
		setInput("");
	};
	return (
		<div className="border rounded-md p-2 flex flex-wrap gap-1.5 min-h-[42px] bg-background">
			{value.map((tag) => (
				<span
					key={tag}
					className="inline-flex items-center gap-1 bg-secondary text-secondary-foreground rounded px-2 py-0.5 text-xs"
				>
					{tag}
					<button
						onClick={() => onChange(value.filter((t) => t !== tag))}
						className="hover:text-destructive"
					>
						×
					</button>
				</span>
			))}
			<input
				value={input}
				onChange={(e) => setInput(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === ",") {
						e.preventDefault();
						add();
					}
				}}
				onBlur={add}
				placeholder="Add and press Enter…"
				className="flex-1 min-w-24 text-xs outline-none bg-transparent"
			/>
		</div>
	);
}

const RUNNERS = ["claude", "gemini", "codex", "cursor"] as const;

type WorkspaceEntry = {
	linearToken: string;
	linearRefreshToken?: string;
	linearWorkspaceSlug?: string;
	linearWorkspaceName?: string;
};

function LinearWorkspacesEditor({
	value,
	onChange,
}: {
	value: Record<string, WorkspaceEntry>;
	onChange: (v: Record<string, WorkspaceEntry>) => void;
}) {
	const [newId, setNewId] = useState("");

	const update = (id: string, field: keyof WorkspaceEntry, val: string) => {
		onChange({
			...value,
			[id]: { ...value[id], [field]: val || undefined },
		});
	};

	const remove = (id: string) => {
		const { [id]: _, ...rest } = value;
		onChange(rest);
	};

	const add = () => {
		const id = newId.trim();
		if (!id || value[id]) return;
		onChange({ ...value, [id]: { linearToken: "" } });
		setNewId("");
	};

	const entries = Object.entries(value);

	return (
		<div className="space-y-3">
			{entries.length === 0 && (
				<p className="text-xs text-muted-foreground italic">
					No workspaces configured. Run{" "}
					<code className="font-mono bg-muted px-1 rounded">
						cyrus self-auth
					</code>{" "}
					to authenticate, or add one below.
				</p>
			)}
			{entries.map(([id, ws]) => (
				<div key={id} className="border rounded-md p-3 space-y-2 text-sm">
					<div className="flex items-center justify-between">
						<span className="font-mono text-xs font-semibold text-muted-foreground">
							{id}
						</span>
						<button
							onClick={() => remove(id)}
							className="text-xs text-destructive hover:underline"
						>
							Remove
						</button>
					</div>
					{(
						[
							["linearWorkspaceName", "Workspace name", "text", "e.g. Acme"],
							["linearWorkspaceSlug", "Workspace slug", "text", "e.g. acme"],
							["linearToken", "OAuth token", "password", "lin_oauth_…"],
							[
								"linearRefreshToken",
								"Refresh token",
								"password",
								"lin_refresh_…",
							],
						] as [keyof WorkspaceEntry, string, string, string][]
					).map(([field, label, type, placeholder]) => (
						<div key={field}>
							<label className="block text-xs font-medium mb-0.5">
								{label}
							</label>
							<input
								type={type}
								value={(ws[field] as string) ?? ""}
								onChange={(e) => update(id, field, e.target.value)}
								placeholder={placeholder}
								className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
							/>
						</div>
					))}
				</div>
			))}
			<div className="flex gap-2">
				<input
					value={newId}
					onChange={(e) => setNewId(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && add()}
					placeholder="Workspace ID (e.g. abc123)"
					className="flex-1 border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
				/>
				<button
					onClick={add}
					disabled={!newId.trim()}
					className="px-3 py-1.5 border rounded-md text-sm hover:bg-muted disabled:opacity-40 transition-colors"
				>
					Add workspace
				</button>
			</div>
		</div>
	);
}
const KNOWN_ENV_KEYS: {
	key: string;
	label: string;
	hint: string;
	multiline?: boolean;
}[] = [
	{
		key: "ANTHROPIC_API_KEY",
		label: "Anthropic API Key",
		hint: "Enables Claude runner",
	},
	{
		key: "CLAUDE_CODE_OAUTH_TOKEN",
		label: "Claude OAuth Token",
		hint: "Alternative to API key",
	},
	{
		key: "GEMINI_API_KEY",
		label: "Gemini API Key",
		hint: "Enables Gemini runner",
	},
	{ key: "LINEAR_CLIENT_ID", label: "Linear Client ID", hint: "" },
	{ key: "LINEAR_CLIENT_SECRET", label: "Linear Client Secret", hint: "" },
	{ key: "LINEAR_WEBHOOK_SECRET", label: "Linear Webhook Secret", hint: "" },
	{
		key: "CYRUS_BASE_URL",
		label: "Cyrus Base URL",
		hint: "Public URL for webhooks",
	},
	{ key: "CYRUS_SERVER_PORT", label: "Server Port", hint: "Default: 3456" },
	{
		key: "CLOUDFLARE_TOKEN",
		label: "Cloudflare Token",
		hint: "Optional tunnel token",
	},
	{ key: "CYRUS_API_KEY", label: "Cyrus API Key", hint: "Dashboard auth key" },
	{
		key: "SLACK_BOT_TOKEN",
		label: "Slack Bot Token",
		hint: "Enables Slack @mention sessions",
	},
	{
		key: "SLACK_SIGNING_SECRET",
		label: "Slack Signing Secret",
		hint: "Required for self-hosted direct webhook verification",
	},
	{
		key: "CYRUS_HOST_EXTERNAL",
		label: "Cyrus Host External",
		hint: 'Set to "true" for self-hosted direct Slack webhooks',
	},
	{
		key: "GITHUB_APP_ID",
		label: "GitHub App ID",
		hint: "Numeric App ID from your GitHub App settings",
	},
	{
		key: "GITHUB_BOT_USERNAME",
		label: "GitHub Bot Username",
		hint: "e.g. anton[bot]",
	},
	{
		key: "GITHUB_WEBHOOK_SECRET",
		label: "GitHub Webhook Secret",
		hint: "GitHub App webhook secret",
	},
	{
		key: "GITHUB_BOT_USER_ID",
		label: "GitHub Bot User ID",
		hint: "Bot user ID (run: gh api /users/anton-code-agent%5Bbot%5D | jq .id)",
	},
	{
		key: "GITHUB_PRIVATE_KEY",
		label: "GitHub Private Key",
		hint: "PEM private key for the GitHub App",
		multiline: true,
	},
];

export function GlobalConfigPage() {
	const qc = useQueryClient();
	const { data: config, isLoading } = useQuery({
		queryKey: ["config"],
		queryFn: getConfig,
	});
	const { data: envData } = useQuery({ queryKey: ["env"], queryFn: getEnv });

	const [localConfig, setLocalConfig] = useState<Record<
		string,
		unknown
	> | null>(null);
	const [envValues, setEnvValues] = useState<Record<string, string>>({});
	const [saved, setSaved] = useState(false);

	const cfg =
		localConfig ?? (config as Record<string, unknown> | undefined) ?? {};

	const set = (key: string, value: unknown) =>
		setLocalConfig({ ...cfg, [key]: value });

	const saveMut = useMutation({
		mutationFn: async () => {
			await saveConfig(cfg);
			if (Object.keys(envValues).length > 0) await saveEnv(envValues);
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["config"] });
			qc.invalidateQueries({ queryKey: ["env"] });
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
		},
	});

	if (isLoading)
		return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

	return (
		<div className="p-6 max-w-2xl">
			<div className="flex items-center justify-between mb-6">
				<h1 className="text-xl font-semibold">Global Config</h1>
				<button
					onClick={() => saveMut.mutate()}
					disabled={saveMut.isPending}
					className="px-4 py-1.5 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
				>
					{saved ? "Saved ✓" : saveMut.isPending ? "Saving…" : "Save"}
				</button>
			</div>

			<div className="space-y-8">
				{/* Runner */}
				<section>
					<h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
						Default Runner
					</h2>
					<div className="flex gap-2 flex-wrap">
						{RUNNERS.map((r) => (
							<button
								key={r}
								onClick={() => set("defaultRunner", r)}
								className={`px-3 py-1.5 rounded-md text-sm border transition-colors capitalize ${cfg.defaultRunner === r ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted"}`}
							>
								{r}
							</button>
						))}
					</div>
					<p className="text-xs text-muted-foreground mt-1.5">
						Fallback when no runner label is set on the issue.
					</p>
				</section>

				{/* Models */}
				<section>
					<h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
						Models
					</h2>
					<div className="grid grid-cols-2 gap-3">
						{[
							{ key: "claudeDefaultModel", label: "Claude model" },
							{ key: "claudeDefaultFallbackModel", label: "Claude fallback" },
							{ key: "geminiDefaultModel", label: "Gemini model" },
							{ key: "codexDefaultModel", label: "Codex model" },
						].map(({ key, label }) => (
							<div key={key}>
								<label className="block text-xs font-medium mb-1">
									{label}
								</label>
								<input
									value={(cfg[key] as string) ?? ""}
									onChange={(e) => set(key, e.target.value || undefined)}
									placeholder="e.g. claude-opus-4-5"
									className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
								/>
							</div>
						))}
					</div>
				</section>

				{/* Tools */}
				<section>
					<h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
						Default Tools
					</h2>
					<div className="space-y-3">
						<div>
							<label className="block text-xs font-medium mb-1">
								Allowed tools
							</label>
							<TagInput
								value={cfg.defaultAllowedTools as string[]}
								onChange={(v) => set("defaultAllowedTools", v)}
							/>
						</div>
						<div>
							<label className="block text-xs font-medium mb-1">
								Disallowed tools
							</label>
							<TagInput
								value={cfg.defaultDisallowedTools as string[]}
								onChange={(v) => set("defaultDisallowedTools", v)}
							/>
						</div>
					</div>
				</section>

				{/* Misc */}
				<section>
					<h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
						Misc
					</h2>
					<div className="space-y-3">
						<div className="flex items-center gap-3">
							<input
								type="checkbox"
								id="issueUpdateTrigger"
								checked={(cfg.issueUpdateTrigger as boolean) ?? true}
								onChange={(e) => set("issueUpdateTrigger", e.target.checked)}
								className="rounded"
							/>
							<label htmlFor="issueUpdateTrigger" className="text-sm">
								Trigger on issue title/description updates
							</label>
						</div>
						<div>
							<label className="block text-xs font-medium mb-1">
								Global setup script
							</label>
							<input
								value={(cfg.global_setup_script as string) ?? ""}
								onChange={(e) =>
									set("global_setup_script", e.target.value || undefined)
								}
								placeholder="/path/to/setup.sh"
								className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
							/>
						</div>
						<div>
							<label className="block text-xs font-medium mb-1">
								Ngrok auth token
							</label>
							<input
								type="password"
								value={(cfg.ngrokAuthToken as string) ?? ""}
								onChange={(e) =>
									set("ngrokAuthToken", e.target.value || undefined)
								}
								className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
							/>
						</div>
					</div>
				</section>

				{/* Linear Workspaces */}
				<section>
					<h2 className="text-sm font-semibold mb-1 text-muted-foreground uppercase tracking-wide">
						Linear Workspaces
					</h2>
					<p className="text-xs text-muted-foreground mb-3">
						OAuth tokens are stored per workspace. Each repository links to a
						workspace via its Workspace ID field.
					</p>
					<LinearWorkspacesEditor
						value={
							(cfg.linearWorkspaces as Record<string, WorkspaceEntry>) ?? {}
						}
						onChange={(v) => set("linearWorkspaces", v)}
					/>
				</section>

				{/* Environment Variables */}
				<section>
					<h2 className="text-sm font-semibold mb-1 text-muted-foreground uppercase tracking-wide">
						Environment Variables
					</h2>
					<p className="text-xs text-muted-foreground mb-3">
						Edits ~/.cyrus/.env directly. Masked fields are only updated when
						changed.
					</p>
					<div className="space-y-2">
						{KNOWN_ENV_KEYS.map(({ key, label, hint, multiline }) => {
							const existing = envData?.env?.[key];
							const isSecret = existing?.isSecret ?? true;
							return (
								<div key={key}>
									<label className="block text-xs font-medium mb-0.5">
										{label}{" "}
										{hint && (
											<span className="text-muted-foreground font-normal">
												— {hint}
											</span>
										)}
									</label>
									{multiline ? (
										<textarea
											defaultValue={
												isSecret
													? ""
													: (existing?.value ?? "").replace(/\\n/g, "\n")
											}
											placeholder={
												isSecret && existing
													? "••••••••  (leave blank to keep)"
													: "Paste PEM key here"
											}
											rows={4}
											onChange={(e) =>
												setEnvValues((prev) => ({
													...prev,
													[key]: e.target.value.replace(/\n/g, "\\n"),
												}))
											}
											className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring font-mono"
										/>
									) : (
										<input
											type={isSecret ? "password" : "text"}
											defaultValue={isSecret ? "" : (existing?.value ?? "")}
											placeholder={
												isSecret && existing
													? "••••••••  (leave blank to keep)"
													: ""
											}
											onChange={(e) =>
												setEnvValues((prev) => ({
													...prev,
													[key]: e.target.value,
												}))
											}
											className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
										/>
									)}
								</div>
							);
						})}
					</div>
				</section>
			</div>
		</div>
	);
}
