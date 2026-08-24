#!/usr/bin/env node
// Entry point for the thin codex-router proxy.
//
//  1. Loads (or generates) the caller capability secret.
//  2. Loads router.toml ([primary] + optional [vision]).
//  3. Starts the Responses-API proxy on loopback.
//  4. Writes a ready-to-paste marked block for ~/.codex/config.toml.

import fs from "node:fs";
import crypto from "node:crypto";

import {
  authenticatedRoute,
  validCallerSecret,
} from "./caller-auth.mjs";

import {
  CALLER_KEY_PATH,
  CONFIG_SNIPPET_PATH,
  HOST,
  ROUTER_CONFIG_PATH,
  ROUTER_PORT,
  STATE_DIR,
} from "./paths.mjs";
import { loadRouterConfig } from "./config.mjs";
import { createProxyServer } from "./server.mjs";

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadOrCreateCallerKey() {
  let existing;
  try {
    existing = fs.readFileSync(CALLER_KEY_PATH, "utf8").trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing && validCallerSecret(existing)) return { key: existing, generated: false };

  const key = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(CALLER_KEY_PATH, `${key}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(CALLER_KEY_PATH, 0o600);
  } catch {
    // Windows ACLs differ; the default profile directory permissions apply.
  }
  return { key, generated: true };
}

function writeConfigSnippet(config, callerKey) {
  const capabilityBase = `http://${HOST}:${ROUTER_PORT}${authenticatedRoute(callerKey)}`;
  const snippet = `# >>> codex-router-proxy >>>
# Paste this block into ~/.codex/config.toml (outside any other table).
# Remove the matching marked block to uninstall.
model_provider = "codex-router-proxy"
model = "${config.primary.model}"

[model_providers.codex-router-proxy]
name = "codex-router-proxy (${config.primary.baseUrl})"
base_url = "${capabilityBase}"
wire_api = "responses"
# <<< codex-router-proxy <<<
`;
  fs.writeFileSync(CONFIG_SNIPPET_PATH, snippet);
}

function main() {
  ensureStateDir();
  const config = loadRouterConfig(ROUTER_CONFIG_PATH);
  const { key, generated } = loadOrCreateCallerKey();
  // Sanity check: the same path parser must accept the key we are about to serve.
  if (!authenticatedRoute(`/_codex-router/${key}/v1`, key)) {
    throw new Error("generated caller key failed self-check");
  }
  writeConfigSnippet(config, key);

  const server = createProxyServer({ config, callerKey: key });
  server.listen(ROUTER_PORT, HOST, () => {
    console.log(`codex-router-proxy listening on http://${HOST}:${ROUTER_PORT}`);
    console.log(`  endpoint : ${config.primary.baseUrl}`);
    console.log(`  model    : ${config.primary.model}`);
    console.log(`  images   : ${config.primary.images}${config.vision ? ` -> ${config.vision.model}` : ""}`);
    if (generated) {
      console.log("  new capability secret generated");
    }
    console.log(`  codex config snippet: ${CONFIG_SNIPPET_PATH} (contains the full secret)`);
    console.log("  health   : GET /health");
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
