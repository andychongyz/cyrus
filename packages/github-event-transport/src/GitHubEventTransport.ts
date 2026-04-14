import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import type { TranslationContext } from "cyrus-core";
import { createLogger, type ILogger, ipMatchesAllowlist } from "cyrus-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { GitHubMessageTranslator } from "./GitHubMessageTranslator.js";
import type {
	GitHubEventTransportConfig,
	GitHubEventTransportEvents,
	GitHubEventType,
	GitHubIssueCommentPayload,
	GitHubPullRequestReviewCommentPayload,
	GitHubPullRequestReviewPayload,
	GitHubVerificationMode,
	GitHubWebhookEvent,
} from "./types.js";

export declare interface GitHubEventTransport {
	on<K extends keyof GitHubEventTransportEvents>(
		event: K,
		listener: GitHubEventTransportEvents[K],
	): this;
	emit<K extends keyof GitHubEventTransportEvents>(
		event: K,
		...args: Parameters<GitHubEventTransportEvents[K]>
	): boolean;
}

/**
 * GitHubEventTransport - Handles forwarded GitHub webhook event delivery
 *
 * This class provides a typed EventEmitter-based transport
 * for handling GitHub webhooks forwarded from CYHOST.
 *
 * It registers a POST /github-webhook endpoint with a Fastify server
 * and verifies incoming webhooks using either:
 * 1. "proxy" mode: Verifies Bearer token authentication (self-hosted)
 * 2. "signature" mode: Verifies GitHub's HMAC-SHA256 signature (cloud)
 *
 * Supported GitHub event types:
 * - issue_comment: Comments on PR issues (top-level PR comments)
 * - pull_request_review_comment: Inline review comments on PR diffs
 * - pull_request_review: PR review submissions (e.g., changes_requested)
 */
export class GitHubEventTransport extends EventEmitter {
	private config: GitHubEventTransportConfig;
	private logger: ILogger;
	private messageTranslator: GitHubMessageTranslator;
	private translationContext: TranslationContext;
	private installationTokenCache: Map<
		number,
		{ token: string; expiresAt: number }
	> = new Map();

	constructor(
		config: GitHubEventTransportConfig,
		logger?: ILogger,
		translationContext?: TranslationContext,
	) {
		super();
		this.config = config;
		this.logger = logger ?? createLogger({ component: "GitHubEventTransport" });
		this.messageTranslator = new GitHubMessageTranslator();
		this.translationContext = translationContext ?? {};
	}

	/**
	 * Set the translation context for message translation.
	 */
	setTranslationContext(context: TranslationContext): void {
		this.translationContext = { ...this.translationContext, ...context };
	}

	/**
	 * Resolve the effective verification mode and secret at request time.
	 * When started in proxy mode, checks if GITHUB_WEBHOOK_SECRET and
	 * CYRUS_HOST_EXTERNAL have been added to the environment since startup,
	 * enabling a runtime switch to signature verification.
	 *
	 * Encapsulates all mode-switch detection and logging so callers only
	 * need to dispatch on the returned mode (SRP).
	 */
	private resolveVerification(): {
		mode: GitHubVerificationMode;
		secret: string;
	} {
		// If already configured for signature mode at startup, keep using it
		if (this.config.verificationMode === "signature") {
			return { mode: "signature", secret: this.config.secret };
		}

		// Check if signature mode env vars have been added at runtime
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const githubSecret = process.env.GITHUB_WEBHOOK_SECRET;
		const hasGithubSecret = githubSecret != null && githubSecret !== "";

		if (isExternalHost && hasGithubSecret) {
			this.logger.info(
				"Runtime switch: GITHUB_WEBHOOK_SECRET detected, using GitHub signature verification",
			);
			return { mode: "signature", secret: githubSecret };
		}

		// Fall back to proxy mode with original config secret
		return { mode: "proxy", secret: this.config.secret };
	}

	/**
	 * Register the /github-webhook endpoint with the Fastify server
	 */
	register(): void {
		this.config.fastifyServer.post(
			"/github-webhook",
			{
				config: {
					rawBody: true,
				},
			},
			async (request: FastifyRequest, reply: FastifyReply) => {
				try {
					const { mode, secret } = this.resolveVerification();

					if (mode === "signature") {
						await this.handleSignatureWebhook(request, reply, secret);
					} else {
						await this.handleProxyWebhook(request, reply, secret);
					}
				} catch (error) {
					const err = new Error("Webhook error");
					if (error instanceof Error) {
						err.cause = error;
					}
					this.logger.error("Webhook error", err);
					this.emit("error", err);
					reply.code(500).send({ error: "Internal server error" });
				}
			},
		);

		this.logger.info(
			`Registered POST /github-webhook endpoint (${this.config.verificationMode} mode)`,
		);
	}

	/**
	 * Handle webhook using GitHub's HMAC-SHA256 signature verification
	 */
	private async handleSignatureWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
		secret: string,
	): Promise<void> {
		// Validate source IP against GitHub's known webhook IPs
		if (
			this.config.ipAllowlist &&
			this.config.ipAllowlist.length > 0 &&
			!ipMatchesAllowlist(request.ip, this.config.ipAllowlist)
		) {
			this.logger.warn(
				`Rejected GitHub webhook from unauthorized IP: ${request.ip}`,
			);
			reply.code(403).send({ error: "Forbidden: unauthorized source IP" });
			return;
		}

		const signature = request.headers["x-hub-signature-256"] as string;
		if (!signature) {
			reply.code(401).send({ error: "Missing x-hub-signature-256 header" });
			return;
		}

		try {
			const body = (request as FastifyRequest & { rawBody: string }).rawBody;
			const isValid = this.verifyGitHubSignature(body, signature, secret);

			if (!isValid) {
				reply.code(401).send({ error: "Invalid webhook signature" });
				return;
			}

			await this.processAndEmitEvent(request, reply);
		} catch (error) {
			const err = new Error("Signature verification failed");
			if (error instanceof Error) {
				err.cause = error;
			}
			this.logger.error("Signature verification failed", err);
			reply.code(401).send({ error: "Invalid webhook signature" });
		}
	}

	/**
	 * Handle webhook using Bearer token authentication (forwarded from CYHOST)
	 */
	private async handleProxyWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
		secret: string,
	): Promise<void> {
		const authHeader = request.headers.authorization;
		if (!authHeader) {
			reply.code(401).send({ error: "Missing Authorization header" });
			return;
		}

		const expectedAuth = `Bearer ${secret}`;
		if (authHeader !== expectedAuth) {
			reply.code(401).send({ error: "Invalid authorization token" });
			return;
		}

		try {
			await this.processAndEmitEvent(request, reply);
		} catch (error) {
			const err = new Error("Proxy webhook processing failed");
			if (error instanceof Error) {
				err.cause = error;
			}
			this.logger.error("Proxy webhook processing failed", err);
			reply.code(500).send({ error: "Failed to process webhook" });
		}
	}

	/**
	 * Process the webhook request and emit the appropriate event
	 */
	private async processAndEmitEvent(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		const eventType = request.headers["x-github-event"] as string;
		const deliveryId =
			(request.headers["x-github-delivery"] as string) || "unknown";
		let installationToken = request.headers["x-github-installation-token"] as
			| string
			| undefined;

		if (!eventType) {
			reply.code(400).send({ error: "Missing x-github-event header" });
			return;
		}

		if (
			eventType !== "issue_comment" &&
			eventType !== "pull_request_review_comment" &&
			eventType !== "pull_request_review"
		) {
			this.logger.debug(`Ignoring unsupported event type: ${eventType}`);
			reply.code(200).send({ success: true, ignored: true });
			return;
		}

		const payload = request.body as
			| GitHubIssueCommentPayload
			| GitHubPullRequestReviewCommentPayload
			| GitHubPullRequestReviewPayload;

		// For pull_request_review, handle 'submitted' action (not 'created')
		if (eventType === "pull_request_review") {
			if (payload.action !== "submitted") {
				this.logger.debug(
					`Ignoring ${eventType} with action: ${payload.action}`,
				);
				reply.code(200).send({ success: true, ignored: true });
				return;
			}
		} else if (payload.action !== "created") {
			// For issue_comment and pull_request_review_comment, only handle 'created'
			this.logger.debug(`Ignoring ${eventType} with action: ${payload.action}`);
			reply.code(200).send({ success: true, ignored: true });
			return;
		}

		// If no token was forwarded by a proxy, try to generate one from App credentials
		if (!installationToken && payload.installation?.id) {
			installationToken =
				(await this.fetchInstallationToken(payload.installation.id)) ??
				undefined;
		}

		const webhookEvent: GitHubWebhookEvent = {
			eventType: eventType as GitHubEventType,
			deliveryId,
			payload,
			installationToken,
		};

		this.logger.info(`Received ${eventType} webhook (delivery: ${deliveryId})`);

		// Emit "event" for legacy compatibility
		this.emit("event", webhookEvent);

		// Emit "message" with translated internal message
		this.emitMessage(webhookEvent);

		reply.code(200).send({ success: true });
	}

	/**
	 * Translate and emit an internal message from a webhook event.
	 * Only emits if translation succeeds; logs debug message on failure.
	 */
	private emitMessage(event: GitHubWebhookEvent): void {
		const result = this.messageTranslator.translate(
			event,
			this.translationContext,
		);

		if (result.success) {
			this.emit("message", result.message);
		} else {
			this.logger.debug(`Message translation skipped: ${result.reason}`);
		}
	}

	/**
	 * Generate a short-lived GitHub App JWT for API authentication.
	 * The JWT is valid for 10 minutes (GitHub's maximum is 10 minutes).
	 */
	private generateAppJWT(appId: string, privateKey: string): string {
		const now = Math.floor(Date.now() / 1000);
		const header = Buffer.from(
			JSON.stringify({ alg: "RS256", typ: "JWT" }),
		).toString("base64url");
		const jwtPayload = Buffer.from(
			JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
		).toString("base64url");
		const sign = createSign("SHA256");
		sign.write(`${header}.${jwtPayload}`);
		sign.end();
		const signature = sign.sign(privateKey, "base64url");
		return `${header}.${jwtPayload}.${signature}`;
	}

	/**
	 * Fetch a short-lived installation access token from GitHub using App credentials.
	 * Tokens are cached per installation ID until 5 minutes before expiry.
	 */
	private async fetchInstallationToken(
		installationId: number,
	): Promise<string | null> {
		const cached = this.installationTokenCache.get(installationId);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.token;
		}

		const appId = process.env.GITHUB_APP_ID;
		const privateKey = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n");
		if (!appId || !privateKey) {
			this.logger.debug(
				"GITHUB_APP_ID or GITHUB_PRIVATE_KEY not set; skipping installation token generation",
			);
			return null;
		}

		try {
			const jwt = this.generateAppJWT(appId, privateKey);
			const response = await fetch(
				`https://api.github.com/app/installations/${installationId}/access_tokens`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${jwt}`,
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
					},
				},
			);

			if (!response.ok) {
				this.logger.warn(
					`Failed to generate installation token for installation ${installationId}: ${response.status}`,
				);
				return null;
			}

			const data = (await response.json()) as {
				token: string;
				expires_at: string;
			};
			// Cache until 5 minutes before expiry
			const expiresAt = new Date(data.expires_at).getTime() - 5 * 60 * 1000;
			this.installationTokenCache.set(installationId, {
				token: data.token,
				expiresAt,
			});
			this.logger.debug(
				`Generated installation token for installation ${installationId}`,
			);
			return data.token;
		} catch (err) {
			this.logger.warn(
				`Error generating installation token: ${err instanceof Error ? err.message : err}`,
			);
			return null;
		}
	}

	/**
	 * Verify GitHub webhook signature using HMAC-SHA256
	 */
	private verifyGitHubSignature(
		body: string,
		signature: string,
		secret: string,
	): boolean {
		const expectedSignature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

		if (signature.length !== expectedSignature.length) {
			return false;
		}

		return timingSafeEqual(
			Buffer.from(signature),
			Buffer.from(expectedSignature),
		);
	}
}
