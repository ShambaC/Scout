# Provider policy

Date checked: 2026-10-28. Re-check before every release that ships or changes a CLI bridge.

## Sources

Read in full or in relevant part:
- https://code.claude.com/docs/en/legal-and-compliance ("Authentication and credential use"; "Can customers offer Claude Code in their products?")
- https://code.claude.com/docs/en/agent-sdk/overview (note on third-party claude.ai login and rate limits)
- https://code.claude.com/docs/en/authentication (precedence; `claude setup-token`)
- https://learn.chatgpt.com/docs/auth (redirected from developers.openai.com/codex/auth)
- https://learn.chatgpt.com/docs/non-interactive-mode (redirected from developers.openai.com/codex/noninteractive)

Not reachable:
- https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan returned HTTP 403. Not read.

Not read, so not relied on: Anthropic Consumer and Commercial Terms, OpenAI Terms of Use and Usage Policies, and the early-2026 change notices cited in PLAN.md. A web search about OpenAI's "Sign in with ChatGPT" partner program returned only secondary blog and news snippets; they are not used for any rule below.

The pages read show no effective dates. "Current" here means the text as served on 2026-10-28.

## Anthropic (Claude Code, Agent SDK)

- OAuth sign-in (Free, Pro, Max, Team, Enterprise) is for the purchaser's own use of Claude Code and native Anthropic apps.
- Developers building products, including Agent SDK apps, should use API keys. Unless previously approved, third parties may not offer claude.ai login or rate limits in their products.
- Third parties may not route requests through a user's plan credentials, and may not collect, store or intermediate claude.ai credentials or session tokens.
- An end user may sign in to the unmodified Claude Code binary with their own subscription. The binary must not be modified.
- Gray area: nothing read addresses an app that spawns the user's own `claude -p` in headless mode. Not confirmed as permitted.
- `claude setup-token` mints a one-year subscription token. The app must not create, store or use it.

## OpenAI (Codex CLI)

- Two sign-in modes: ChatGPT ("subscription access", the CLI default) and API key ("usage-based").
- The docs recommend API keys for programmatic and CI use: "API keys are the right default for automation."
- `codex exec` reuses saved CLI auth by default and is documented for scripts. It also accepts `CODEX_API_KEY` per run.
- `~/.codex/auth.json` "contains access tokens" and should be treated like a password. Access tokens are documented only for trusted scripts, and only where an admin enables them.
- The pages read do not say whether a third-party app may drive `codex exec` on a user's ChatGPT sign-in. Not confirmed as permitted.

## Stance for Scout

1. Supported path: API keys (Anthropic, OpenAI, OpenAI-compatible endpoints) and local models via llama-server. Billed per token. Keys live in the OS keychain.
2. CLI bridges (`claude -p`, `codex exec`) are experimental and off by default, behind a feature flag and a warning that the terms are unsettled. They use only the user's own installed, signed-in CLI.
3. The app never reads, copies, stores, proxies or refreshes OAuth tokens or `auth.json`. It never runs `setup-token` and never sets `CLAUDE_CODE_OAUTH_TOKEN`.
4. No direct Claude subscription OAuth. No "Sign in with Claude" flow.
5. Each bridge is removable without touching core code. The router sees only the provider interface.
