import os from "node:os";
import path from "node:path";

// Slim path constants for the thin proxy. The upstream src/paths.mjs was not
// reused deliberately: importing it transitively pulls in tray-install.mjs and
// the whole macOS tray machinery, which this proxy must never load.

export const CODEX_HOME =
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

export const STATE_DIR =
  process.env.MODEL_ROUTER_STATE_DIR || path.join(CODEX_HOME, "codex-router");

export const ROUTER_CONFIG_PATH = path.join(STATE_DIR, "router.toml");
export const CALLER_KEY_PATH = path.join(STATE_DIR, "caller-key");
export const CONFIG_SNIPPET_PATH = path.join(STATE_DIR, "codex-config-snippet.toml");

export const ROUTER_PORT = Number(process.env.CODEX_ROUTER_PORT || 4102);
export const HOST = process.env.CODEX_ROUTER_HOST || "127.0.0.1";

// Native Codex backend, used only by the `chatgpt` vision mode, which forwards
// a vision request with the caller's own live session headers.
export const NATIVE_BASE =
  process.env.CODEX_NATIVE_BASE_URL || "https://chatgpt.com/backend-api/codex";

export const QUIET = ["1", "true", "yes"].includes(
  String(process.env.CODEX_ROUTER_QUIET || "").toLowerCase(),
);
