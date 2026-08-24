// Responses API <-> Chat Completions translation for the thin proxy.
//
// Request direction (Codex -> upstream): maps a /v1/responses payload onto an
// OpenAI-compatible /v1/chat/completions payload. Stateless: previous_response_id
// and reasoning items are dropped because chat endpoints have no server state.
//
// Response direction (upstream -> Codex): either a one-shot JSON mapping or a
// streaming transform that converts Chat Completions SSE chunks into the
// Responses event stream Codex expects (created / output_item.* /
// output_text.delta / function_call_arguments.delta / completed|failed).

import crypto from "node:crypto";
import { Transform } from "node:stream";

const DROPPED_REQUEST_FIELDS = [
  "store",
  "previous_response_id",
  "reasoning",
  "metadata",
  "truncation",
  "text",
  "include",
  "prompt_cache_key",
];

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

function contentToParts(content) {
  // Chat-side content arrives as a string or an array of typed parts; both are
  // normalized into Responses-style {type,text} / image parts so callers can be
  // uniform.
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (typeof part === "string") return [{ type: "text", text: part }];
    if (!part || typeof part !== "object") return [];
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      return [{ type: "text", text: String(part.text ?? "") }];
    }
    if (part.type === "image_url" || part.type === "input_image") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      return url ? [{ type: "image_url", image_url: { url } }] : [];
    }
    return [];
  });
}

function responsesContentToChat(parts) {
  // Responses-style content parts -> Chat Completions parts (text/image_url).
  if (!Array.isArray(parts)) {
    if (typeof parts === "string") return [{ type: "text", text: parts }];
    return [];
  }
  const out = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    switch (part.type) {
      case "input_text":
      case "output_text":
      case "text":
        out.push({ type: "text", text: String(part.text ?? "") });
        break;
      case "input_image":
      case "image_url": {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        if (url) out.push({ type: "image_url", image_url: { url } });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function translateRequest(responsesBody, targetModel) {
  const messages = [];

  if (typeof responsesBody.instructions === "string" && responsesBody.instructions.trim()) {
    messages.push({ role: "system", content: responsesBody.instructions });
  }

  const input = Array.isArray(responsesBody.input)
    ? responsesBody.input
    : typeof responsesBody.input === "string"
      ? [{ type: "message", role: "user", content: [{ type: "input_text", text: responsesBody.input }] }]
      : [];

  const warnings = [];

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    switch (item.type) {
      case "message": {
        const role = item.role === "assistant" || item.role === "system" ? item.role : "user";
        messages.push({ role, content: responsesContentToChat(item.content) });
        break;
      }
      case "function_call": {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: item.call_id || item.id,
              type: "function",
              function: { name: item.name, arguments: item.arguments ?? "{}" },
            },
          ],
        });
        break;
      }
      case "function_call_output": {
        let output = item.output;
        if (typeof output !== "string") {
          try {
            output = JSON.stringify(output);
          } catch {
            output = String(output);
          }
        }
        messages.push({
          role: "tool",
          tool_call_id: item.call_id || item.id,
          content: output ?? "",
        });
        break;
      }
      case "local_shell_call":
      case "custom_tool_call":
        warnings.push(`dropped unsupported call item type "${item.type}"`);
        break;
      case "custom_tool_call_output":
      case "local_shell_call_output":
      case "computer_call_output": {
        let output = item.output;
        if (typeof output !== "string") {
          try {
            output = JSON.stringify(output);
          } catch {
            output = String(output);
          }
        }
        messages.push({
          role: "tool",
          tool_call_id: item.call_id || item.id,
          content: output ?? "",
        });
        break;
      }
      case "reasoning":
      case "item_reference":
        // No server-side state on chat endpoints; these carry no user content.
        break;
      default:
        warnings.push(`dropped unknown input item type "${item.type}"`);
        break;
    }
  }

  const body = {
    model: targetModel,
    messages,
    stream: Boolean(responsesBody.stream),
  };

  if (body.stream) {
    // Ask every compliant endpoint to report token usage in the final chunk.
    body.stream_options = { include_usage: true };
  }

  if (Number.isFinite(responsesBody.max_output_tokens)) {
    body.max_tokens = responsesBody.max_output_tokens;
  }
  if (Number.isFinite(responsesBody.temperature)) body.temperature = responsesBody.temperature;
  if (Number.isFinite(responsesBody.top_p)) body.top_p = responsesBody.top_p;

  if (Array.isArray(responsesBody.tools) && responsesBody.tools.length > 0) {
    const tools = [];
    for (const tool of responsesBody.tools) {
      if (tool && tool.type === "function" && tool.name) {
        // Responses-style flat function tool.
        tools.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description ?? "",
            parameters: tool.parameters ?? { type: "object", properties: {} },
            ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
          },
        });
      } else if (tool && tool.type === "function" && tool.function) {
        // Already Chat-shaped.
        tools.push(tool);
      } else {
        warnings.push(`dropped unsupported tool type "${tool?.type}"`);
      }
    }
    if (tools.length > 0) body.tools = tools;
  }

  const choice = responsesBody.tool_choice;
  if (choice === "auto" || choice === "none" || choice === "required") {
    body.tool_choice = choice;
  } else if (choice && choice.type === "function" && choice.name) {
    body.tool_choice = { type: "function", function: { name: choice.name } };
  }

  if (responsesBody.parallel_tool_calls !== undefined) {
    body.parallel_tool_calls = Boolean(responsesBody.parallel_tool_calls);
  }

  for (const field of DROPPED_REQUEST_FIELDS) delete body[field];

  return { body, warnings };
}

// ---------------------------------------------------------------------------
// Non-streaming response translation
// ---------------------------------------------------------------------------

function toolCallsToItems(toolCalls, startIndex) {
  const items = [];
  (toolCalls ?? []).forEach((call, offset) => {
    if (!call || call.type !== "function") return;
    items.push({
      type: "function_call",
      id: newId("fc"),
      call_id: call.id || newId("call"),
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "",
      status: "completed",
      output_index: startIndex + offset,
    });
  });
  return items;
}

export function translateChatResponse(chatPayload, { responseId = newId("resp") } = {}) {
  const choice = chatPayload.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const output = [];
  let outputIndex = 0;

  const text =
    (Array.isArray(message.content)
      ? message.content.map((p) => p?.text ?? "").join("")
      : message.content) ?? "";
  const refusal = message.refusal;

  if (text || refusal) {
    output.push({
      type: "message",
      id: newId("msg"),
      role: "assistant",
      status: "completed",
      content: [
        ...(text ? [{ type: "output_text", text, annotations: [] }] : []),
        ...(refusal ? [{ type: "refusal", refusal }] : []),
      ],
      output_index: outputIndex,
    });
    outputIndex += 1;
  }

  const callItems = toolCallsToItems(message.tool_calls, outputIndex);
  output.push(...callItems);

  const usageRaw = chatPayload.usage ?? {};
  const usage = {
    input_tokens: Number(usageRaw.prompt_tokens ?? usageRaw.input_tokens ?? 0),
    output_tokens: Number(usageRaw.completion_tokens ?? usageRaw.output_tokens ?? 0),
  };
  usage.total_tokens = Number(usageRaw.total_tokens ?? usage.input_tokens + usage.output_tokens);

  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Number(chatPayload.created ?? Date.now() / 1000)),
    status: "completed",
    model: chatPayload.model ?? "",
    output,
    usage,
    error: null,
    incomplete_details: choice.finish_reason === "length" ? { reason: "max_output_tokens" } : null,
  };
}

// ---------------------------------------------------------------------------
// Streaming translation: Chat Completions SSE -> Responses SSE
// ---------------------------------------------------------------------------

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function baseResponse(id, model, status) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: [],
    error: null,
    incomplete_details: null,
  };
}

/**
 * Transform that consumes an upstream Chat Completions SSE byte stream and
 * emits Responses-API SSE frames. Byte-preserving on the wire is impossible by
 * design here; what matters is emitting a coherent, ordered event sequence.
 */
export class ChatToResponsesStream extends Transform {
  constructor({ model }) {
    super();
    this.targetModel = model;
    this.responseId = newId("resp");
    this.createdAtSent = false;
    this.messageItem = null; // {id, outputIndex, started}
    this.textBuffer = "";
    this.toolCalls = new Map(); // index -> {id, name, args, outputIndex, started}
    this.nextOutputIndex = 0;
    this.usage = undefined;
    this.finishReason = null;
    this.sawDone = false;
    this.buffer = "";
  }

  _emit(event, data) {
    this.push(frame(event, data));
  }

  _ensureCreated(modelFromChunk) {
    if (this.createdAtSent) return;
    this.createdAtSent = true;
    // The display model wins: when an upstream alias is configured, chunks echo
    // the upstream slug and the client must never see it.
    this._emit("response.created", {
      type: "response.created",
      response: baseResponse(this.responseId, this.targetModel || modelFromChunk, "in_progress"),
    });
  }

  _ensureMessageItem() {
    if (this.messageItem) return this.messageItem;
    const item = {
      id: newId("msg"),
      outputIndex: this.nextOutputIndex,
      started: false,
    };
    this.nextOutputIndex += 1;
    this.messageItem = item;
    return item;
  }

  _startMessageItem(item) {
    if (item.started) return;
    item.started = true;
    this._emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: item.outputIndex,
      item: { type: "message", id: item.id, role: "assistant", status: "in_progress", content: [] },
    });
  }

  _handleToolCallDelta(delta) {
    const index = Number.isFinite(delta.index) ? delta.index : 0;
    let entry = this.toolCalls.get(index);
    if (!entry) {
      entry = {
        id: delta.id || newId("call"),
        name: "",
        args: "",
        outputIndex: this.nextOutputIndex,
        started: false,
        itemId: newId("fc"),
      };
      this.nextOutputIndex += 1;
      this.toolCalls.set(index, entry);
    }
    if (delta.id) entry.id = delta.id;
    if (delta.function?.name) entry.name += delta.function.name;

    if (!entry.started) {
      // The item cannot be announced before we know the function name.
      if (!entry.name) return;
      entry.started = true;
      this._emit("response.output_item.added", {
        type: "response.output_item.added",
        output_index: entry.outputIndex,
        item: {
          type: "function_call",
          id: entry.itemId,
          call_id: entry.id,
          name: entry.name,
          arguments: "",
          status: "in_progress",
        },
      });
    }

    const argDelta = delta.function?.arguments;
    if (argDelta) {
      entry.args += argDelta;
      this._emit("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: entry.itemId,
        output_index: entry.outputIndex,
        delta: argDelta,
      });
    }
  }

  _finishToolCall(entry) {
    if (!entry.started) return;
    this._emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: entry.outputIndex,
      item: {
        type: "function_call",
        id: entry.itemId,
        call_id: entry.id,
        name: entry.name,
        arguments: entry.args,
        status: "completed",
      },
    });
  }

  _processChunk(chunk) {
    const parsed = chunk.choices?.[0];
    const delta = parsed?.delta ?? {};

    this._ensureCreated(chunk.model);

    if (parsed?.finish_reason) this.finishReason = parsed.finish_reason;
    if (chunk.usage) this.usage = chunk.usage;

    const text = delta.content;
    if (typeof text === "string" && text.length > 0) {
      const item = this._ensureMessageItem();
      this._startMessageItem(item);
      this.textBuffer += text;
      this._emit("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: item.outputIndex,
        content_index: 0,
        delta: text,
      });
    }

    if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
      const item = this._ensureMessageItem();
      this._startMessageItem(item);
      this.textBuffer += delta.refusal;
      this._emit("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: item.outputIndex,
        content_index: 0,
        delta: delta.refusal,
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const callDelta of delta.tool_calls) this._handleToolCallDelta(callDelta);
    }
  }

  _flushEvents() {
    this._ensureCreated();

    if (this.messageItem) {
      const item = this.messageItem;
      this._emit("response.output_text.done", {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: item.outputIndex,
        content_index: 0,
        text: this.textBuffer,
      });
      this._emit("response.output_item.done", {
        type: "response.output_item.done",
        output_index: item.outputIndex,
        item: {
          type: "message",
          id: item.id,
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: this.textBuffer, annotations: [] },
          ],
        },
      });
    }

    const calls = [...this.toolCalls.entries()].sort(([a], [b]) => a - b);
    for (const [, entry] of calls) this._finishToolCall(entry);

    const inputTokens = Number(this.usage?.prompt_tokens ?? 0);
    const outputTokens = Number(this.usage?.completion_tokens ?? 0);
    const response = baseResponse(this.responseId, this.targetModel, "completed");
    response.usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: Number(this.usage?.total_tokens ?? inputTokens + outputTokens),
    };
    if (this.finishReason === "length") {
      response.incomplete_details = { reason: "max_output_tokens" };
    }

    this._emit("response.completed", { type: "response.completed", response });
    this.push("data: [DONE]\n\n");
  }

  _transform(chunk, _encoding, callback) {
    this.buffer += chunk.toString("utf8");
    let separator;
    while ((separator = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, separator).replace(/\r$/, "");
      this.buffer = this.buffer.slice(separator + 1);
      try {
        this._processLine(line);
      } catch (error) {
        callback(error);
        return;
      }
    }
    callback();
  }

  _processLine(line) {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      this.sawDone = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // tolerate keep-alive noise
    }
    if (parsed.error) {
      const err = new Error(parsed.error.message || "upstream returned an error event");
      err.upstreamError = parsed.error;
      throw err;
    }
    this._processChunk(parsed);
  }

  _final(callback) {
    try {
      if (!this.sawDone) {
        // Upstream closed without [DONE]; treat as a broken stream unless we
        // already emitted completion.
        if (this.createdAtSent) {
          const error = new Error("upstream stream ended without a terminal event");
          error.brokenStream = true;
          callback(error);
          return;
        }
      }
      if (!this.completionEmitted) {
        this.completionEmitted = true;
        this._flushEvents();
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  // Marks the stream as failed so _final does not synthesize a fake success.
  fail(error) {
    this.completionEmitted = true;
    this._ensureCreated();
    this._emit("response.failed", {
      type: "response.failed",
      response: {
        ...baseResponse(this.responseId, this.targetModel, "failed"),
        error: { code: "upstream_stream_failed", message: String(error?.message ?? error) },
      },
    });
    this.end();
  }
}

export function sseErrorResponse(message, code = "proxy_error") {
  return (
    frame("response.failed", {
      type: "response.failed",
      response: {
        id: newId("resp"),
        object: "response",
        status: "failed",
        error: { code, message },
      },
    }) + "data: [DONE]\n\n"
  );
}
