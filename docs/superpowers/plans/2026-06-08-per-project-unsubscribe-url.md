# Per-Project Custom Unsubscribe URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each Plunk project to use a different base URL for unsubscribe/subscribe/manage links in emails, configured via environment variables (no DB schema or frontend changes).

**Architecture:** Add two env vars — `UNSUBSCRIBE_URI` (global fallback) and `CUSTOM_UNSUBSCRIBE_URLS` (per-project JSON map). URL replacement happens at two points: (1) `EmailService.compile()` does a post-processing string replace on the final HTML, catching both template-variable URLs and the auto-generated footer, and (2) `SESService.sendRawEmail()` extracts the full unsubscribe URL from the HTML for the `List-Unsubscribe` header instead of rebuilding it from `DASHBOARD_URI`. This approach avoids touching the 6 URL construction sites in the email pipeline, minimizing merge conflicts with upstream.

**Tech Stack:** Express.js, TypeScript (ESM)

**Files changed:** 2

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `apps/api/src/app/constants.ts` | Parse env vars, export resolver function |
| Modify | `apps/api/src/services/EmailService.ts` | Post-process URLs in `compile()` |
| Modify | `apps/api/src/services/SESService.ts` | Extract full URL from HTML for `List-Unsubscribe` header |

---

## How it works

All email paths (transactional, campaign, workflow) construct unsubscribe URLs using `DASHBOARD_URI` as before — **we don't touch those lines**. Instead:

1. `EmailService.compile()` is the last stop before the HTML is handed to SES. It already receives the `project` object. We add a post-processing step that replaces `DASHBOARD_URI`-based unsubscribe/subscribe/manage URLs with the project's custom URL.

2. `SESService.sendRawEmail()` currently reconstructs the unsubscribe URL from scratch using `DASHBOARD_URI`. We change it to extract the full URL from the HTML (which already has the correct URL after compile's replacement).

```
Email pipeline:
  format() → {{unsubscribeUrl}} replaced with DASHBOARD_URI-based URL
  compile() → footer added with DASHBOARD_URI-based URL
            → NEW: post-process replaces DASHBOARD_URI → custom URL  ← only change
  sendRawEmail() → List-Unsubscribe header
                 → NEW: extract full URL from HTML instead of rebuilding  ← only change
```

---

## Configuration

```yaml
# docker-compose.yml
environment:
  # Optional: global fallback for all projects (defaults to DASHBOARD_URI if not set)
  UNSUBSCRIBE_URI: "https://mail.mojoapp.ai"

  # Optional: per-project overrides (JSON object, project ID → base URL)
  CUSTOM_UNSUBSCRIBE_URLS: >
    {
      "proj-uuid-1": "https://mail.brand-a.com",
      "proj-uuid-2": "https://mail.brand-b.com",
      "proj-uuid-3": "https://news.brand-c.com"
    }
```

Resolution order: `CUSTOM_UNSUBSCRIBE_URLS[projectId]` → `UNSUBSCRIBE_URI` → `DASHBOARD_URI`

---

### Task 1: Add env vars and resolver function to constants.ts

**Files:**
- Modify: `apps/api/src/app/constants.ts:30`

- [ ] **Step 1: Add env var parsing and resolver**

In `apps/api/src/app/constants.ts`, add after line 30 (`export const DASHBOARD_URI = ...`):

```typescript
// Per-project unsubscribe URL overrides (env-driven, no DB change needed)
export const UNSUBSCRIBE_URI = validateEnv('UNSUBSCRIBE_URI', '');
const CUSTOM_UNSUBSCRIBE_URLS: Record<string, string> = (() => {
  const raw = validateEnv('CUSTOM_UNSUBSCRIBE_URLS', '{}');
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
})();

export function getUnsubscribeBaseUrl(projectId: string): string {
  const url = CUSTOM_UNSUBSCRIBE_URLS[projectId] || UNSUBSCRIBE_URI || DASHBOARD_URI;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/app/constants.ts
git commit -m "$(cat <<'EOF'
feat(api): add per-project unsubscribe URL env vars

UNSUBSCRIBE_URI as global fallback, CUSTOM_UNSUBSCRIBE_URLS as
per-project JSON map. Resolution: per-project → global → DASHBOARD_URI.
EOF
)"
```

---

### Task 2: Post-process URLs in EmailService.compile()

**Files:**
- Modify: `apps/api/src/services/EmailService.ts:6,1127-1129`

- [ ] **Step 1: Add import**

In `apps/api/src/services/EmailService.ts` line 6, add `getUnsubscribeBaseUrl` to the existing import:

```typescript
import {DASHBOARD_URI, LANDING_URI, STRIPE_ENABLED, getUnsubscribeBaseUrl} from '../app/constants.js';
```

- [ ] **Step 2: Add URL replacement at the end of compile()**

In `EmailService.compile()`, insert the replacement logic just before the final `return html;` (line 1129). The code goes after the `</body>` insertion block (after line 1127) and before `return html;`:

```typescript
    // Replace unsubscribe/subscribe/manage URLs with project-specific base URL
    const customBase = getUnsubscribeBaseUrl(project.id);
    if (customBase !== DASHBOARD_URI) {
      html = html.replaceAll(`${DASHBOARD_URI}/unsubscribe/`, `${customBase}/unsubscribe/`);
      html = html.replaceAll(`${DASHBOARD_URI}/subscribe/`, `${customBase}/subscribe/`);
      html = html.replaceAll(`${DASHBOARD_URI}/manage/`, `${customBase}/manage/`);
    }

    return html;
```

This catches:
- Template variable URLs (`{{unsubscribeUrl}}` etc.) — already replaced by `format()` before `compile()` is called
- The footer URL that `compile()` itself generates (line 1076)

The `customBase !== DASHBOARD_URI` guard skips the work entirely when there's no override (the common case).

- [ ] **Step 3: Verify compile() is called for all email paths**

Confirm that all email sending paths go through `compile()`:

```bash
grep -rn 'EmailService\.compile\|this\.compile' apps/api/src/ --include="*.ts"
```

Expected: hits in `EmailService.sendEmail()` and `email-processor.ts` — these are the two paths that send HTML to SES. Both call `compile()` with the project object.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/EmailService.ts
git commit -m "$(cat <<'EOF'
feat(api): replace unsubscribe URLs with project-specific base in compile()

Post-processes the final HTML to swap DASHBOARD_URI-based unsubscribe,
subscribe, and manage URLs with the project's custom base URL (from
env vars). Catches both template variable URLs and the auto-footer.
EOF
)"
```

---

### Task 3: Extract full URL in SESService for List-Unsubscribe header

**Files:**
- Modify: `apps/api/src/services/SESService.ts:96-104`

- [ ] **Step 1: Change regex to extract the full URL from HTML**

Replace lines 96-104:

```typescript
  // Check if the body contains an unsubscribe link
  const regex = /unsubscribe\/([a-f\d-]+)"/;
  const containsUnsubscribeLink = regex.exec(content.html);

  let unsubscribeHeader = '';
  if (containsUnsubscribeLink?.[1]) {
    const unsubscribeId = containsUnsubscribeLink[1];
    unsubscribeHeader = `List-Unsubscribe: <${DASHBOARD_URI}/unsubscribe/${unsubscribeId}>`;
  }
```

with:

```typescript
  // Extract the full unsubscribe URL from the HTML href attribute.
  // The URL may have been rewritten by compile() to use a custom base,
  // so we extract it as-is instead of rebuilding from DASHBOARD_URI.
  const unsubscribeMatch = /href="(https?:\/\/[^"]*\/unsubscribe\/[a-f\d-]+)"/.exec(content.html);

  let unsubscribeHeader = '';
  if (unsubscribeMatch?.[1]) {
    unsubscribeHeader = `List-Unsubscribe: <${unsubscribeMatch[1]}>`;
  }
```

This extracts the complete URL from the `href` attribute (e.g. `https://mail.brand-a.com/unsubscribe/xxx`) instead of only extracting the contact ID and rebuilding with `DASHBOARD_URI`.

- [ ] **Step 2: Remove unused DASHBOARD_URI import if applicable**

Check the imports at the top of `SESService.ts`. If `DASHBOARD_URI` is no longer used anywhere else in the file, remove it from the import:

```bash
grep -n 'DASHBOARD_URI' apps/api/src/services/SESService.ts
```

If only the import line remains, remove `DASHBOARD_URI` from the import statement.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/SESService.ts
git commit -m "$(cat <<'EOF'
feat(api): extract full unsubscribe URL from HTML for List-Unsubscribe header

Instead of rebuilding the URL from DASHBOARD_URI, extract it from
the href attribute in the compiled HTML. This picks up any custom
base URL that compile() may have substituted.
EOF
)"
```

---

### Task 4: Verify — build, lint, grep

- [ ] **Step 1: Run full build**

```bash
cd /Users/Hana/Agents/nana/repos/plunk-fork
yarn build
```

Expected: All packages and apps build successfully.

- [ ] **Step 2: Run lint**

```bash
yarn lint
```

Expected: No new lint errors.

- [ ] **Step 3: Verify DASHBOARD_URI is no longer used to construct unsubscribe URLs (except as input to compile)**

```bash
grep -rn 'DASHBOARD_URI' apps/api/src/services/SESService.ts
```

Expected: Zero results (or only the import line if it's used for other purposes in SESService).

- [ ] **Step 4: Commit any lint fixes**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: fix lint after per-project unsubscribe URL feature
EOF
)"
```

---

## Files NOT touched (merge-conflict-free)

These files contain hardcoded `DASHBOARD_URI` unsubscribe URLs but are deliberately left unchanged — `compile()` rewrites them post-hoc:

- `apps/api/src/services/CampaignService.ts`
- `apps/api/src/services/WorkflowExecutionService.ts`
- `apps/api/src/controllers/Actions.ts`
- `apps/api/src/jobs/email-processor.ts`
- `packages/db/prisma/schema.prisma`
- `packages/shared/src/schemas/index.ts`
- `apps/web/src/pages/settings/index.tsx`

## Deployment checklist

- [ ] Add `UNSUBSCRIBE_URI` and/or `CUSTOM_UNSUBSCRIBE_URLS` to `docker-compose.yml` on EC2
- [ ] Set up Caddy entries for each custom domain → reverse proxy to Plunk dashboard
- [ ] Set up DNS A records for each custom domain → EC2 IP
- [ ] Send a test email and verify the unsubscribe link points to the custom URL
- [ ] Verify the `List-Unsubscribe` email header also uses the custom URL
