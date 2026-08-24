# AGENTS.md — codex-router-proxy

Repository rules (inherited from upstream codex-router, reduced to what applies
to the thin proxy).

## Invariants

1. **Retries** happen only before the first byte is relayed to the client;
   small bounds only (2 attempts, 250 ms backoff, 5 s budget). Never retry
   once streaming has started.
2. **Usage patch** substitutes ONLY explicitly-zero prompt/input token counts
   (estimate `ceil(bytes / 3.3)`, minimum 1000). Never touch non-zero values.
3. **Capability secret** (`/_codex-router/<secret>/v1`) is sensitive: log only
   `redactCallerUrl`; the secret is written exclusively to `caller-key`
   (mode 600) and the config snippet.
4. **Logs**: never write upstream error bodies, keys, or Authorization values.
5. **Vision bridge** must never fail a turn: any image-read error degrades to
   a text note.

## Architecture

`src/proxy/` is fully self-contained: only `node:*` imports. Do not add npm
dependencies and do not import modules from outside `src/proxy/`.

Request flow: Codex -> capability auth -> vision policy (native/bridge/
chatgpt/off) -> translateRequest (Responses->Chat) -> fetchWithRetry ->
streaming [ChatToResponsesStream + ResponseUsageTransform] or JSON
(translateChatResponse + substituteZeroInputUsage).

## Starters

Platform launchers live at the repo root (`start.ps1`, `start.sh`). They check
for Node and exec `src/proxy/main.mjs`, passing arguments through. Keep them
dependency-free one-liners at heart.

`start-codex-tinyllm.ps1` launches the Windows Codex desktop app against a
separate `CODEX_HOME` (`~/.codex-tinyllm`) via `Invoke-CommandInDesktopPackage`
(package identity bypasses MSIX ACLs; the broker drops the caller environment,
so a generated temp `.cmd` sets `CODEX_HOME` itself).

## Tests

The proxy smoke tests live outside this repository in a temp folder; after any
change to translate/server/vision, rerun them against a mock Chat Completions
server.
