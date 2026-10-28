# Provider policy

Updated 2026-10-28.

## Rules

1. Scout identifies only as itself, with the `Scout/<version>` user agent. It never sends another product's client ID, user agent, `originator`, editor or integration headers.
2. A sign-in is offered only when the vendor lets a third-party app register for it. Logins that work only by reusing another app's OAuth registration are not offered.
3. Tokens stay in the OS keychain. Login, refresh and revocation run in Rust; the webview only ever sees `{{secret:...}}` templates, which the Rust HTTP layer fills in.

## What Scout offers

- API-key providers: the presets in `packages/agent/src/providers/presets.ts`. Keys live in the OS keychain.
- ChatGPT plan: OpenAI's official Sign in with ChatGPT for open-source apps (https://developers.openai.com/siwc/token-sharing-open-source). Scout registers with `client_id=dynamic_agent_client` and `agent_name_hint=Scout`, and keeps the issued `client_id` per install. Inference uses `https://api.openai.com/v1/responses` with `store: false` and `stream: true`.
- CLI bridges (`claude -p`, `codex exec`): experimental and off by default. They spawn the user's own signed-in CLI and never read its tokens.

## Not offered

- **Claude Pro/Max OAuth:** Anthropic does not allow third-party apps to use claude.ai login. Use the `claude` CLI bridge.
- **Gemini CLI and Antigravity OAuth:** Google prohibits third-party use of these logins. Use the Gemini API-key preset.
- **GitHub Copilot:** a self-registered GitHub OAuth App can sign users in, but GitHub does not document Copilot inference for such tokens without another product's headers.
- **xAI (SuperGrok), Kimi Code and Meta Muse Code:** no public client registration for third-party apps.
