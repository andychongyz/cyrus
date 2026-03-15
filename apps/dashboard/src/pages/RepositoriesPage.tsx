import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getConfig, saveConfig } from "@/api/config";

async function fetchBranchingRules(repoId: string): Promise<string> {
	const res = await fetch(`/api/repositories/${repoId}/branching-rules`);
	if (!res.ok) return "";
	const data = await res.json();
	return data.content ?? "";
}

async function saveBranchingRules(
	repoId: string,
	content: string,
): Promise<void> {
	await fetch(`/api/repositories/${repoId}/branching-rules`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content }),
	});
}

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
		<div className="border rounded-md p-2 flex flex-wrap gap-1.5 min-h-[38px] bg-background">
			{value.map((tag) => (
				<span
					key={tag}
					className="inline-flex items-center gap-1 bg-secondary text-secondary-foreground rounded px-2 py-0.5 text-xs"
				>
					{tag}
					<button onClick={() => onChange(value.filter((t) => t !== tag))}>
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
				placeholder="Add…"
				className="flex-1 min-w-20 text-xs outline-none bg-transparent"
			/>
		</div>
	);
}

type Repo = Record<string, unknown>;

function RepoModal({
	repo,
	onClose,
	onSave,
}: {
	repo: Repo | null;
	onClose: () => void;
	onSave: (r: Repo) => void;
}) {
	const isNew = !repo?.id;
	const [form, setForm] = useState<Repo>(
		repo ?? { id: crypto.randomUUID(), isActive: true },
	);
	const set = (key: string, value: unknown) =>
		setForm((f) => ({ ...f, [key]: value }));

	const repoId = form.id as string;
	const [branchingRules, setBranchingRules] = useState<string>("");
	const [rulesLoaded, setRulesLoaded] = useState(false);

	useEffect(() => {
		if (!isNew && repoId) {
			fetchBranchingRules(repoId).then((content) => {
				setBranchingRules(content);
				setRulesLoaded(true);
			});
		} else {
			setRulesLoaded(true);
		}
	}, [isNew, repoId]);

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [onClose]);

	const field = (
		key: string,
		label: string,
		opts?: { placeholder?: string },
	) => (
		<div>
			<label className="block text-xs font-medium mb-1">{label}</label>
			<input
				type="text"
				value={(form[key] as string) ?? ""}
				onChange={(e) => set(key, e.target.value || undefined)}
				placeholder={opts?.placeholder}
				className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
			/>
		</div>
	);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			<div className="absolute inset-0 bg-black/50" onClick={onClose} />
			<div className="relative bg-background rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
				{/* Header */}
				<div className="flex items-center justify-between px-6 py-4 border-b">
					<h2 className="font-semibold text-base">
						{isNew ? "Add Repository" : "Edit Repository"}
					</h2>
					<button
						onClick={onClose}
						className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
					>
						<X size={16} />
					</button>
				</div>

				{/* Scrollable body */}
				<div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">
					{/* Identity */}
					<section>
						<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
							Identity
						</h3>
						<div className="grid grid-cols-2 gap-3">
							{field("name", "Name")}
							{field("id", "ID")}
						</div>
					</section>

					<hr className="border-border" />

					{/* Git */}
					<section>
						<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
							Git
						</h3>
						<div className="space-y-3">
							<div className="grid grid-cols-2 gap-3">
								{field("repositoryPath", "Repository path", {
									placeholder: "/path/to/repo",
								})}
								{field("baseBranch", "Base branch", { placeholder: "main" })}
							</div>
							<div className="grid grid-cols-2 gap-3">
								{field("workspaceBaseDir", "Workspace base dir", {
									placeholder: "/path/to/worktrees",
								})}
								{field("githubUrl", "GitHub URL", {
									placeholder: "https://github.com/org/repo",
								})}
							</div>
						</div>
					</section>

					<hr className="border-border" />

					{/* Linear */}
					<section>
						<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
							Linear
						</h3>
						<div className="space-y-3">
							<div className="grid grid-cols-2 gap-3">
								{field("linearWorkspaceId", "Workspace ID")}
								{field("linearWorkspaceName", "Workspace name")}
							</div>
							<div className="grid grid-cols-3 gap-3">
								<div>
									<label className="block text-xs font-medium mb-1">
										Team keys
									</label>
									<TagInput
										value={form.teamKeys as string[]}
										onChange={(v) => set("teamKeys", v.length ? v : undefined)}
									/>
								</div>
								<div>
									<label className="block text-xs font-medium mb-1">
										Routing labels
									</label>
									<TagInput
										value={form.routingLabels as string[]}
										onChange={(v) =>
											set("routingLabels", v.length ? v : undefined)
										}
									/>
								</div>
								<div>
									<label className="block text-xs font-medium mb-1">
										Project keys
									</label>
									<TagInput
										value={form.projectKeys as string[]}
										onChange={(v) =>
											set("projectKeys", v.length ? v : undefined)
										}
									/>
								</div>
							</div>
						</div>
					</section>

					<hr className="border-border" />

					{/* Runner & Tools */}
					<section>
						<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
							Runner & Tools
						</h3>
						<div className="space-y-3">
							<div className="grid grid-cols-2 gap-3">
								{field("model", "Model override", {
									placeholder: "e.g. claude-opus-4-5",
								})}
								{field("fallbackModel", "Fallback model")}
							</div>
							<div className="grid grid-cols-2 gap-3">
								<div>
									<label className="block text-xs font-medium mb-1">
										Allowed tools
									</label>
									<TagInput
										value={form.allowedTools as string[]}
										onChange={(v) =>
											set("allowedTools", v.length ? v : undefined)
										}
									/>
								</div>
								<div>
									<label className="block text-xs font-medium mb-1">
										Disallowed tools
									</label>
									<TagInput
										value={form.disallowedTools as string[]}
										onChange={(v) =>
											set("disallowedTools", v.length ? v : undefined)
										}
									/>
								</div>
							</div>
						</div>
					</section>

					<hr className="border-border" />

					{/* Branching Rules */}
					<section>
						<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
							Branching Rules
						</h3>
						<p className="text-xs text-muted-foreground mb-3">
							Describe how branches should be named. Cyrus uses these rules to
							decide the base branch and prefix for each issue.
						</p>
						<textarea
							value={rulesLoaded ? branchingRules : "Loading…"}
							onChange={(e) => setBranchingRules(e.target.value)}
							disabled={!rulesLoaded}
							rows={8}
							className="w-full border rounded-md px-3 py-2 text-xs font-mono bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-y"
							placeholder="e.g. - hotfix label or mentions of 'urgent' → base: main, prefix: hotfix/&#10;- default → base: main, prefix: feature/"
						/>
					</section>

					<hr className="border-border" />

					{/* Advanced */}
					<section>
						<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
							Advanced
						</h3>
						<div className="space-y-3">
							<div className="grid grid-cols-2 gap-3">
								{field("mcpConfigPath", "MCP config path(s)", {
									placeholder: "/path/to/mcp.json",
								})}
								{field("promptTemplatePath", "Prompt template path")}
							</div>
							<div>
								<label className="block text-xs font-medium mb-1">
									Append instruction
								</label>
								<textarea
									value={(form.appendInstruction as string) ?? ""}
									onChange={(e) =>
										set("appendInstruction", e.target.value || undefined)
									}
									rows={3}
									className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
								/>
							</div>
							<div className="flex items-center gap-2">
								<input
									type="checkbox"
									id="isActive"
									checked={(form.isActive as boolean) ?? true}
									onChange={(e) => set("isActive", e.target.checked)}
									className="rounded"
								/>
								<label htmlFor="isActive" className="text-sm">
									Active
								</label>
							</div>
						</div>
					</section>
				</div>

				{/* Footer */}
				<div className="px-6 py-4 border-t flex justify-end gap-2">
					<button
						onClick={onClose}
						className="px-4 py-1.5 border rounded-md text-sm hover:bg-muted transition-colors"
					>
						Cancel
					</button>
					<button
						onClick={async () => {
							await saveBranchingRules(repoId, branchingRules);
							onSave(form);
						}}
						className="px-4 py-1.5 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90 transition-colors"
					>
						Save
					</button>
				</div>
			</div>
		</div>
	);
}

export function RepositoriesPage() {
	const qc = useQueryClient();
	const { data: config, isLoading } = useQuery({
		queryKey: ["config"],
		queryFn: getConfig,
	});
	const [editingRepo, setEditingRepo] = useState<Repo | null | "new">(null);

	const repos: Repo[] =
		((config as Record<string, unknown>)?.repositories as Repo[]) ?? [];

	const saveMut = useMutation({
		mutationFn: async (repo: Repo) => {
			const current = (config as Record<string, unknown>) ?? {
				repositories: [],
			};
			const list: Repo[] = (current.repositories as Repo[]) ?? [];
			const idx = list.findIndex((r) => r.id === repo.id);
			const updated =
				idx >= 0
					? list.map((r) => (r.id === repo.id ? repo : r))
					: [...list, repo];
			await saveConfig({ ...current, repositories: updated });
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["config"] });
			setEditingRepo(null);
		},
	});

	const deleteMut = useMutation({
		mutationFn: async (id: string) => {
			const current = (config as Record<string, unknown>) ?? {
				repositories: [],
			};
			const updated = ((current.repositories as Repo[]) ?? []).filter(
				(r) => r.id !== id,
			);
			await saveConfig({ ...current, repositories: updated });
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
	});

	if (isLoading)
		return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

	return (
		<div className="p-6">
			<div className="flex items-center justify-between mb-6">
				<div>
					<h1 className="text-xl font-semibold">Repositories</h1>
					<p className="text-sm text-muted-foreground">
						{repos.length} configured
					</p>
				</div>
				<button
					onClick={() => setEditingRepo("new")}
					className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 transition-colors"
				>
					<Plus size={14} /> Add Repository
				</button>
			</div>

			{repos.length === 0 ? (
				<div className="text-center py-16 text-muted-foreground text-sm">
					No repositories configured. Add one to get started.
				</div>
			) : (
				<div className="space-y-2">
					{repos.map((repo) => (
						<div
							key={repo.id as string}
							className="flex items-center gap-4 border rounded-lg px-4 py-3 bg-card hover:bg-muted/20 transition-colors"
						>
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2">
									<span className="font-medium text-sm">
										{repo.name as string}
									</span>
									{!(repo.isActive ?? true) && (
										<span className="text-xs text-muted-foreground">
											(inactive)
										</span>
									)}
								</div>
								<p className="text-xs text-muted-foreground truncate">
									{repo.repositoryPath as string}
								</p>
							</div>
							<div className="text-xs text-muted-foreground shrink-0">
								{repo.baseBranch as string}
							</div>
							<div className="text-xs text-muted-foreground shrink-0">
								{repo.linearWorkspaceName as string}
							</div>
							<div className="flex items-center gap-1">
								<button
									onClick={() => setEditingRepo(repo)}
									className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
								>
									<Pencil size={13} />
								</button>
								<button
									onClick={() => {
										if (confirm("Delete this repository?"))
											deleteMut.mutate(repo.id as string);
									}}
									className="p-1.5 rounded hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive"
								>
									<Trash2 size={13} />
								</button>
							</div>
						</div>
					))}
				</div>
			)}

			{editingRepo !== null && (
				<RepoModal
					repo={editingRepo === "new" ? null : editingRepo}
					onClose={() => setEditingRepo(null)}
					onSave={(r) => saveMut.mutate(r)}
				/>
			)}
		</div>
	);
}
