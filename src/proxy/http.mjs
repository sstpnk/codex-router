// Slim subset of src/http-utils.mjs for the thin proxy. Copied rather than
// imported because http-utils pulls paths.mjs, which transitively drags in
// tray-install.mjs and the macOS tray machinery this proxy must never load.
// Behavior is kept identical where reused.

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_BODY_BYTES = Number(
  process.env.MODEL_ROUTER_MAX_BODY_BYTES || 64 * 1024 * 1024,
);

export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export async function readRequestBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function writeJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

export function httpErrorStatus(error, fallback = 502) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : fallback;
}

export function copyResponseHeaders(upstream, response, denylist = HOP_BY_HOP_HEADERS) {
  for (const [name, value] of upstream.headers.entries()) {
    if (!denylist.has(name.toLowerCase())) response.setHeader(name, value);
  }
}

function isEventStream(response) {
  return String(response.getHeader("content-type") || "")
    .toLowerCase()
    .includes("text/event-stream");
}

function finishResponse(response) {
  return new Promise((resolve) => {
    if (response.writableFinished || response.destroyed) {
      resolve();
      return;
    }
    response.once("finish", resolve);
    response.once("close", resolve);
    if (!response.writableEnded) response.end();
  });
}

// Terminate a response whose body is already streaming. On SSE, emit a terminal
// error event first so the failure is visible instead of looking like a short
// successful turn. The leading blank line guards against mid-line corruption.
// Carries a fixed router-side message only - never upstream error text.
export function endStreamedResponse(response) {
  if (!response || response.writableEnded || response.destroyed) return;
  if (isEventStream(response)) {
    try {
      const data = {
        type: "error",
        code: "local_router_stream_failed",
        message: "The local proxy lost the upstream response stream.",
        param: null,
      };
      response.write(`\n\nevent: error\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // The socket may already be gone; ending below is still correct.
    }
  }
  response.end();
}

export async function pipeResponse(upstream, response, denylist, transform) {
  const transforms = transform === undefined
    ? []
    : Array.isArray(transform)
      ? transform
      : [transform];
  response.statusCode = upstream.status;
  copyResponseHeaders(upstream, response, denylist);
  if (!upstream.body) {
    response.end();
    return;
  }
  const source = Readable.fromWeb(upstream.body);
  try {
    // `end:false` keeps the response out of pipeline teardown so the caller can
    // end the body cleanly instead of resetting the socket.
    await pipeline(source, ...transforms, response, { end: false });
  } catch (error) {
    if (response.destroyed && !response.writableFinished) return;
    throw error;
  }
  await finishResponse(response);
}
