# GitHub App Setup for Cyrus

This guide covers creating and configuring a GitHub App so Cyrus can receive webhook events, post comments, and create pull requests using a bot identity — rather than your personal account.

---

## Why a GitHub App?

| | Personal Access Token | GitHub App |
|---|---|---|
| Identity | Your user account | Dedicated bot account |
| Access scope | All repos your user can see | Only repos where the App is installed |
| Token expiry | Long-lived (until revoked) | Short-lived (1-hour installation tokens, auto-refreshed) |
| Audit trail | Shows as you | Shows as `your-app[bot]` |
| Org-wide access | Requires admin PAT | Install once per org |

---

## Step 1: Create the GitHub App

1. Go to **GitHub Settings → Developer settings → GitHub Apps**
   - For a personal account: https://github.com/settings/apps
   - For an org: `https://github.com/organizations/<org>/settings/apps`

2. Click **New GitHub App**

3. Fill in the form:

   | Field | Value |
   |-------|-------|
   | **GitHub App name** | e.g. `cyrus-bot` (must be globally unique) |
   | **Homepage URL** | Your Cyrus base URL, e.g. `https://cyrus.yourdomain.com` |
   | **Webhook URL** | `https://cyrus.yourdomain.com/github-webhook` |
   | **Webhook secret** | Generate a random secret and save it (e.g. `openssl rand -hex 32`) |

4. Under **Repository permissions**, set:

   | Permission | Level |
   |------------|-------|
   | Contents | Read & write |
   | Issues | Read & write |
   | Metadata | Read-only (required) |
   | Pull requests | Read & write |

5. Under **Subscribe to events**, check:
   - Issue comment
   - Pull request review
   - Pull request review comment

6. Under **Where can this GitHub App be installed?**, choose:
   - **Only on this account** — if Cyrus will only access your personal repos
   - **Any account** — if you want to install it on org accounts

7. **Do not enable** "Request user authorization (OAuth) during installation" — that is for user-facing OAuth flows and is not needed by Cyrus.

8. Click **Create GitHub App**

---

## Step 2: Generate a Private Key

On the App's settings page, scroll to **Private keys** and click **Generate a private key**. A `.pem` file will download automatically. Keep this file safe — you cannot retrieve it again.

---

## Step 3: Install the App on Your Organization / Repository

1. On the App's settings page, click **Install App** in the left sidebar.
2. Click **Install** next to the account or organization.
3. Choose **All repositories** or select specific repositories where Cyrus should operate.
4. Click **Install**.

Repeat this step for every GitHub organization whose repositories you add to Cyrus.

---

## Step 4: Collect the Required Values

You need four values from the App:

### GITHUB_APP_ID
Found on the App's **About** page (top of the settings page). It's a numeric ID, e.g. `12345678`.

### GITHUB_PRIVATE_KEY
The contents of the `.pem` file you downloaded in Step 2.

When adding it to your env file, either:
- Paste the full multi-line PEM as-is (if your env file supports multi-line values)
- Or replace all newlines with `\n`:
  ```bash
  awk 'NF {printf "%s\\n", $0}' your-app.pem
  ```

### GITHUB_WEBHOOK_SECRET
The random secret you set in the webhook settings in Step 1.

### GITHUB_BOT_USERNAME and GITHUB_BOT_USER_ID
The bot's login and numeric user ID. After installing the App, find these with:

```bash
# Replace 'cyrus-bot' with your App name
gh api /users/cyrus-bot%5Bbot%5D | jq '{login: .login, id: .id}'
```

---

## Step 5: Configure Cyrus

Add the following to your env file (`~/.cyrus/.env`) or via the dashboard under **Global Config → Environment Variables**:

```bash
# Required for direct GitHub webhook delivery (no CYHOST proxy)
CYRUS_HOST_EXTERNAL=true
GITHUB_WEBHOOK_SECRET=your-webhook-secret

# GitHub App credentials
GITHUB_APP_ID=12345678
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"

# Bot identity
GITHUB_BOT_USERNAME=cyrus-bot[bot]
GITHUB_BOT_USER_ID=123456789
```

> **Note:** `CYRUS_HOST_EXTERNAL=true` tells Cyrus to verify incoming webhooks using GitHub's HMAC-SHA256 signature (via `GITHUB_WEBHOOK_SECRET`) instead of expecting a forwarded token from a proxy. It also enables Cyrus to generate its own short-lived installation tokens using `GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY`.

---

## Step 6: Add the Repository in Cyrus

In the dashboard (**Repositories → Add Repository** or edit an existing one), set the **GitHub URL** field to the full repository URL:

```
https://github.com/your-org/your-repo
```

This is how Cyrus matches incoming webhooks to the correct repository configuration.

---

## Step 7: Verify

Restart Cyrus, then comment `@cyrus-bot` on a pull request in one of the installed repositories. Check the logs for:

```
Generated installation token for installation <id>
```

If you see `GITHUB_APP_ID or GITHUB_PRIVATE_KEY not set`, double-check the env values are loaded (run `pm2 restart cyrus-agent --update-env` after editing the env file).

---

## Troubleshooting

### 404 when fetching PR details
The App is not installed on the org that owns the repository. Go to **Install App** in the App settings and install it on the correct org.

### 401 when generating installation token
The private key or App ID is incorrect, or the private key has formatting issues. Re-download the `.pem` and check that newlines are preserved.

### Webhooks not arriving
- Confirm the webhook URL in the App settings matches `CYRUS_BASE_URL/github-webhook` exactly.
- Check that `CYRUS_HOST_EXTERNAL=true` and `GITHUB_WEBHOOK_SECRET` are set.
- Inspect the webhook delivery log in the App settings under **Advanced → Recent Deliveries**.
