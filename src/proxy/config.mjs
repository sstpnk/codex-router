// Mini-config for the thin proxy: a deliberately small TOML subset parser plus
// validation. The config lives at ~/.codex/codex-router/router.toml and has the
// shape:
//
//   [primary]
//   base_url = "https://llm.stpnk.tech/v1"
//   api_key_env = "TINYLLM_API_KEY"
//   model = "tinyllm-main"         # slug Codex picks and sees everywhere
//   model_upstream = "prod-slug"   # optional; slug actually sent upstream
//   images = "native"              # native | bridge | chatgpt | off
//
//   [vision]                     # optional, required when images = "bridge"
//   base_url = "http://127.0.0.1:11434/v1"
//   api_key_env = ""             # empty/omitted => keyless (local engines)
//   model = "qwen2.5vl"

import fs from "node:fs";
import { ROUTER_CONFIG_PATH } from "./paths.mjs";

export const IMAGE_MODES = ["native", "bridge", "chatgpt", "off"];

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function unquote(raw, context) {
  const value = raw.trim();
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    throw new ConfigError(`${context}: expected a double-quoted string, got ${raw}`);
  }
  const inner = value.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    i += 1;
    const esc = inner[i];
    switch (esc) {
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      default:
        throw new ConfigError(`${context}: unsupported escape \\${esc ?? "<eof>"}`);
    }
  }
  return out;
}

// Parses just what the mini-config needs: [section] headers, key = "value"
// lines, # comments and blank lines. Anything else is a hard error so typos
// never pass silently.
export function parseMiniToml(text) {
  const result = {};
  let section = "";
  text.split(/\r?\n/).forEach((line, index) => {
    const where = `${ROUTER_CONFIG_PATH}:${index + 1}`;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const header = trimmed.match(/^\[([A-Za-z0-9_-]+)\]$/);
    if (header) {
      section = header[1];
      if (!result[section]) result[section] = {};
      return;
    }
    const pair = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!pair) throw new ConfigError(`${where}: cannot parse line: ${trimmed}`);
    if (!section) throw new ConfigError(`${where}: key outside of a [section]`);
    result[section][pair[1]] = unquote(pair[2], where);
  });
  return result;
}

function requireString(section, key) {
  const value = section[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigError(`[missing] ${key} is required`);
  }
  return value.trim();
}

export function validateConfig(raw) {
  const primary = raw.primary;
  if (!primary || typeof primary !== "object") {
    throw new ConfigError("missing [primary] section");
  }

  const baseUrl = requireString(primary, "base_url");
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new ConfigError("[primary] base_url must start with http:// or https://");
  }
  const model = requireString(primary, "model");

  // Optional display/upstream split: Codex picks `model` and sees it in the
  // catalog, while requests carry `model_upstream` when the endpoint routes
  // under a different slug. Absent or empty means "same as model".
  const modelUpstreamRaw =
    typeof primary.model_upstream === "string" ? primary.model_upstream.trim() : "";
  const upstreamModel = modelUpstreamRaw || model;

  const images = (primary.images || "native").trim();
  if (!IMAGE_MODES.includes(images)) {
    throw new ConfigError(
      `[primary] images must be one of ${IMAGE_MODES.join(", ")}, got "${images}"`,
    );
  }

  const config = {
    primary: {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKeyEnv: typeof primary.api_key_env === "string" ? primary.api_key_env.trim() : "",
      model,
      upstreamModel,
      images,
    },
    vision: null,
  };

  if (images === "bridge") {
    const vision = raw.vision;
    if (!vision || typeof vision !== "object") {
      throw new ConfigError('[vision] section is required when images = "bridge"');
    }
    const visionBase = requireString(vision, "base_url");
    if (!/^https?:\/\//i.test(visionBase)) {
      throw new ConfigError("[vision] base_url must start with http:// or https://");
    }
    config.vision = {
      baseUrl: visionBase.replace(/\/+$/, ""),
      apiKeyEnv: typeof vision.api_key_env === "string" ? vision.api_key_env.trim() : "",
      model: requireString(vision, "model"),
    };
  }

  return config;
}

// Resolves an env-var *name* from the config into a live credential value.
// Empty/absent names mean "no key" which is legitimate for local engines.
export function resolveKey(apiKeyEnv) {
  if (!apiKeyEnv) return undefined;
  const value = process.env[apiKeyEnv];
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigError(
      `environment variable ${apiKeyEnv} is not set (referenced by router.toml)`,
    );
  }
  return value.trim();
}

export function loadRouterConfig(configPath = ROUTER_CONFIG_PATH) {
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new ConfigError(`router config not found at ${configPath}`);
    }
    throw error;
  }
  return validateConfig(parseMiniToml(text));
}
