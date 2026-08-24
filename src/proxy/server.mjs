// The thin proxy server. Codex talks Responses API to the capability path;
// this module authenticates the caller, applies the vision policy from
// router.toml, translates to Chat Completions, and translates the reply back.

import http from "node:http";

import {
  authenticatedRoute,
  redactCallerUrl,
  validCallerSecret,
} from "./caller-auth.mjs";
import { fetchWithRetry } from "./upstream-retry.mjs";
import {
  estimateInputTokens,
  ResponseUsageTransform,
  substituteZeroInputUsage,
} from "./response-usage.mjs";

import {
  QUIET,
} from "./paths.mjs";
import { resolveKey } from "./config.mjs";
import {
  endStreamedResponse,
  httpErrorStatus,
  pipeResponse,
  readRequestBody,
  writeJson,
} from "./http.mjs";
import {
  ChatToResponsesStream,
  sseErrorResponse,
  translateChatResponse,
  translateRequest,
} from "./translate.mjs";
import {
  inputHasImage,
  substituteImages,
  stripImages,
} from "./vision-bridge.mjs";

// Native-mode vision engine model (used only when images = "chatgpt").
const NATIVE_VISION_MODEL =
  process.env.CODEX_ROUTER_VISION_CHATGPT_MODEL || "gpt-5";

// Headers copied from the incoming request for native vision calls. Mirrors
// the upstream FORWARD_HEADERS allowlist: session identity travels, nothing else.
const NATIVE_FORWARD_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-subagent",
];

function log(...parts) {
  if (!QUIET) console.log(new Date().toISOString(), ...parts);
}

function nativeHeaders(request) {
  const headers = {
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
    Accept: "text/event-stream",
  };
  for (const name of NATIVE_FORWARD_HEADERS) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  return headers;
}

export function createProxyServer({ config, callerKey }) {
  if (!validCallerSecret(callerKey)) {
    throw new Error("caller key is missing or malformed");
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(async (error) => {
      log("handler error:", error?.message || error);
      if (!response.headersSent) {
        writeJson(response, httpErrorStatus(error), {
          error: { type: "proxy_error", message: "Internal proxy error." },
        });
      } else {
        endStreamedResponse(response);
      }
    });
  });

  async function handle(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      writeJson(response, 200, { ok: true });
      return;
    }

    // Everything below lives behind the capability path.
    let remainder;
    try {
      remainder = authenticatedRoute(url.pathname, callerKey);
    } catch {
      remainder = undefined;
    }    if (remainder === undefined || !remainder.startsWith("/v1/")) {
      log("rejected request to", redactCallerUrl(url.pathname));
      writeJson(response, 404, {
        error: { type: "not_found", message: "Unknown route." },
      });
      return;
    }

    switch (`${request.method} ${remainder.slice(3)}`) {
      case "GET /models":
        handleModels(response);
        return;
      case "POST /responses":
        await handleResponses(request, response);
        return;
      default:
        writeJson(response, 404, {
          error: { type: "not_found", message: `Unsupported route ${redactCallerUrl(remainder)}.` },
        });
    }
  }

  function handleModels(response) {
    writeJson(response, 200, {
      object: "list",
      data: [
        {
          id: config.primary.model,
          object: "model",
          created: 0,
          owned_by: "codex-router-proxy",
        },
      ],
    });
  }

  function visionEngineFor(mode, request) {
    if (mode === "bridge") {
      const apiKey = resolveKey(config.vision.apiKeyEnv);
      return {
        slug: "configured-vision-engine",
        displayName: config.vision.model,
        gatewayModel: config.vision.model,
        local: true,
        protocol: "openai-chat",
        baseUrl: config.vision.baseUrl,
        ...(apiKey ? { apiKey } : {}),
      };
    }
    if (mode === "chatgpt") {
      const headers = nativeHeaders(request);
      if (!headers.authorization) return undefined; // fail closed: no session, no engine
      return {
        slug: "native-vision-engine",
        displayName: NATIVE_VISION_MODEL,
        gatewayModel: NATIVE_VISION_MODEL,
        native: true,
        inputModalities: ["image"],
      };
    }
    return undefined;
  }

  async function applyVisionPolicy(body, request) {
    const mode = config.primary.images;
    if (mode === "native" || !inputHasImage(body.input)) {
      return body;
    }

    if (mode === "off") {
      const { input } = stripImages(
        body.input,
        "image input is disabled in router.toml (images = \"off\")",
        { textPartType: "input_text" },
      );
      return { ...body, input };
    }

    const engine = visionEngineFor(mode, request);
    if (!engine) {
      // chatgpt mode without a live session degrades instead of failing.
      const { input } = stripImages(
        body.input,
        "no signed-in ChatGPT session is available to read images",
        { textPartType: "input_text" },
      );
      return { ...body, input };
    }

    const nativeCall =
      mode === "chatgpt" ? { baseUrl: NATIVE_BASE, headers: nativeHeaders(request) } : undefined;

    const describe = async (imageUrl, _ordinal, question) => {
      // Imported lazily; the transcript is capped and retried inside
      // describeImage, while evidenceCache buys a read only once per
      // (image, question) pair across turns.
      const { describeImage, evidenceCache } = await import("./vision-bridge.mjs");
      const cached = evidenceCache.get(imageUrl, question);
      if (cached !== undefined) {
        return { text: cached, engineName: engine.displayName };
      }
      const text = await describeImage({
        engine,
        imageUrl,
        nativeCall,
        signal: undefined,
        question,
      });
      return { text: evidenceCache.set(imageUrl, question, text), engineName: engine.displayName };
    };

    const result = await substituteImages(body.input, describe);
    log(`vision: ${result.described}/${result.images} image(s) read via ${mode}`);
    return { ...body, input: result.input };
  }

  async function handleResponses(request, response) {
    const rawBody = await readRequestBody(request);
    let responsesBody;
    try {
      responsesBody = JSON.parse(rawBody.toString("utf8"));
    } catch {
      writeJson(response, 400, {
        error: { type: "invalid_request_error", message: "Request body is not JSON." },
      });
      return;
    }

    try {
      responsesBody = await applyVisionPolicy(responsesBody, request);
    } catch (error) {
      log("vision bridge error:", error?.message || error);
      // A bridge failure must not fail the turn: degrade to stated omissions.
      const { input } = stripImages(
        responsesBody.input ?? [],
        `images could not be read (${error?.message || "unknown vision error"})`,
        { textPartType: "input_text" },
      );
      responsesBody = { ...responsesBody, input };
    }

    const streaming = Boolean(responsesBody.stream);
    const { body: chatBody, warnings } = translateRequest(
      responsesBody,
      config.primary.upstreamModel,
    );
    for (const warning of warnings) log("translate warning:", warning);

    const payload = Buffer.from(JSON.stringify(chatBody), "utf8");
    const apiKey = resolveKey(config.primary.apiKeyEnv);
    const target = `${config.primary.baseUrl}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
      Accept: streaming ? "text/event-stream" : "application/json",
      "Accept-Encoding": "identity",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };

    let upstream;
    try {
      ({ response: upstream } = await fetchWithRetry(target, {
        method: "POST",
        headers,
        body: payload,
      }, {}));
    } catch (error) {
      log("upstream connect failed:", error?.cause?.code || error?.name || "error");
      if (streaming && !response.headersSent) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(sseErrorResponse("The proxy could not reach the configured endpoint."));
      } else {
        writeJson(response, httpErrorStatus(error), {
          error: { type: "upstream_error", message: "The proxy could not reach the configured endpoint." },
        });
      }
      return;
    }

    if (!upstream.ok) {
      // Relay status only; the body is forwarded untouched but never logged.
      const relayHeaders = {};
      const contentType = upstream.headers.get("content-type");
      if (contentType) relayHeaders["Content-Type"] = contentType;
      const bytes = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, relayHeaders);
      response.end(bytes);
      log("upstream answered HTTP", upstream.status);
      return;
    }

    // Measured against the exact bytes that went upstream, per house rules.
    const estimatedInputTokens = estimateInputTokens(payload);

    if (!streaming) {
      const bytes = Buffer.from(await upstream.arrayBuffer());
      let payloadOut;
      try {
        payloadOut = translateChatResponse(JSON.parse(bytes.toString("utf8")));
      } catch {
        writeJson(response, 502, {
          error: { type: "upstream_error", message: "The endpoint returned an unreadable response." },
        });
        return;
      }
      // Returns a patched copy only when the payload qualifies.
      payloadOut = substituteZeroInputUsage(payloadOut, estimatedInputTokens) ?? payloadOut;
      // Codex believes it talks to `model`; never leak the upstream slug here.
      payloadOut.model = config.primary.model;
      writeJson(response, 200, payloadOut);
      return;
    }

    // No manual writeHead here: pipeResponse stages status and headers itself,
    // and header mutation after writeHead is a hard error.
    const translator = new ChatToResponsesStream({ model: config.primary.model });
    const usagePatch = new ResponseUsageTransform("text/event-stream", { estimatedInputTokens });
    usagePatch.on("error", () => {}); // patching is best-effort; never kill the stream

    try {
      await pipeResponse(upstream, response, undefined, [translator, usagePatch]);
    } catch (error) {
      log("stream failed:", error?.name === "AbortError" ? "client abort" : error?.message || "error");
      endStreamedResponse(response);
    }
  }

  return server;
}
