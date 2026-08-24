# codex-router-proxy

Use **any OpenAI-compatible model endpoint** inside the Codex App and CLI.

`codex-router-proxy` is a small local proxy that speaks the **Responses API**
to Codex and translates every turn into plain **Chat Completions** calls against
an upstream you choose — your own self-hosted LLM, a company gateway, or any
provider that exposes `/v1/chat/completions`. One tiny Node.js process, zero
npm dependencies, no Python, no background service machinery.

It grew out of a need the upstream project answers with heavy machinery:
*"I just want my Codex to talk to my own endpoint."* If you want the full
multi-provider router — curated catalogs, OAuth routes, tray apps, quota cards —
use [duolahypercho/codex-router](https://github.com/duolahypercho/codex-router).
This repository is the distilled single-endpoint core of that idea.

> This is an independent community project. It is not affiliated with or
> endorsed by OpenAI, Anthropic, Moonshot AI, or any model provider.

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Images: the four vision modes](#images-the-four-vision-modes)
- [Request lifecycle](#request-lifecycle)
- [What the proxy guarantees](#what-the-proxy-guarantees)
- [Security model](#security-model)
- [Environment variables](#environment-variables)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)

---

## How it works

Codex always talks to what it believes is an OpenAI Responses API. The proxy
listens on loopback, accepts that traffic behind a secret capability path,
translates it to Chat Completions for your upstream, and translates the
response — including the full SSE token stream — back into Responses events
Codex understands.

```
┌─────────┐   Responses API    ┌──────────────────────────────────────┐
│         │ ─────────────────► │  capability check (timing-safe)      │
│  Codex  │                    │  vision policy (native|bridge|       │
│         │ ◄───────────────── │    chatgpt|off)                      │
└─────────┘   Responses SSE    │  translateRequest (Responses → Chat) │
                               │  fetchWithRetry ──► your endpoint    │
                               │  translate back (Chat → Responses)   │
                               │  usage patch (zero prompt tokens)    │
                               └──────────────────────────────────────┘
                                        │
                                        ▼
                        any OpenAI-compatible /chat/completions
```

The installer step is deliberately manual and transparent: the proxy writes a
small marked TOML block (`codex-config-snippet.toml`) that you paste into your
own `~/.codex/config.toml`. Your existing profiles, MCP servers, and settings
are never touched.

```toml
# >>> codex-router-proxy >>>
model_provider = "codex-router-proxy"
model = "your-model"

[model_providers.codex-router-proxy]
name = "codex-router-proxy"
base_url = "http://127.0.0.1:4102/_codex-router/<generated-capability>/v1"
wire_api = "responses"
# <<< codex-router-proxy <<<
```

The generated `<generated-capability>` path segment **is** the caller
authentication. Treat it like a password: do not paste complete URLs into
issues, chats, or screenshots.

---

## Requirements

**Runtime:** Node.js ≥ 22.19 (Node 24 LTS recommended). Nothing else — there
are no npm dependencies, no Python, no build steps.

**Your upstream endpoint must:**

| Requirement | Why |
| --- | --- |
| Expose OpenAI-compatible `POST /v1/chat/completions` | The only upstream surface the proxy calls. |
| Support **function/tool calling** | Codex drives every turn through tool calls; a model without tool calling cannot operate Codex at all. |
| Support **SSE streaming** (`stream: true`) | Codex streams every completion. Non-streaming requests are supported but rarely used. |
| Provide a context window ≥ ~24–32K tokens | Codex's own system prompt consumes roughly 20K tokens before your task begins. |
| Report non-zero `usage.prompt_tokens` *(recommended)* | If the endpoint reports explicit zeros, the proxy substitutes a conservative byte-based estimate so Codex compaction keeps working — but honest numbers are better. |

---

## Quick start

### 1. Create the configuration

`~/.codex/codex-router/router.toml`:

```toml
[primary]
base_url = "https://llm.example.com/v1"
api_key_env = "MY_ENDPOINT_API_KEY"   # optional; omit for keyless endpoints
model = "your-model"
images = "bridge"                     # native | bridge | chatgpt | off

[vision]                              # required iff images = "bridge"
base_url = "https://llm.example.com/v1"
api_key_env = "MY_ENDPOINT_API_KEY"   # optional; keyless local engines OK
model = "qwen2.5vl"
```

### 2. Start the proxy

Windows (PowerShell):

```powershell
.\start.ps1
```

macOS / Linux:

```sh
./start.sh
```

On first start the proxy creates its state directory, generates a capability
secret, and writes `~/.codex/codex-router/codex-config-snippet.toml`.

### 3. Wire up Codex

Paste the generated snippet into `~/.codex/config.toml`, fully quit Codex,
reopen it, and pick `your-model`. Every turn now flows through the proxy.

---

## Configuration

All configuration lives in one file: `~/.codex/codex-router/router.toml`
(override the directory with `MODEL_ROUTER_STATE_DIR`). The parser accepts a
deliberate subset of TOML: sections, string values, comments. Anything else is
a hard startup error rather than a silent misconfiguration.

### `[primary]` — required

| Key | Type | Description |
| --- | --- | --- |
| `base_url` | string | Root of the OpenAI-compatible endpoint. The proxy appends `/chat/completions`. |
| `api_key_env` | string | **Name** of an environment variable holding the API key. The value itself is never read from disk or stored by the proxy. Omit for keyless endpoints. |
| `model` | string | Model slug advertised to Codex via `/v1/models`, written into the config snippet, and echoed back in responses. |
| `model_upstream` | string | Optional. Slug actually sent to the endpoint when it routes under a different name. Defaults to `model`. |
| `images` | string | Vision policy: `native`, `bridge`, `chatgpt`, or `off`. Default `native`. |

### `[vision]` — required iff `images = "bridge"`

| Key | Type | Description |
| --- | --- | --- |
| `base_url` | string | Endpoint used exclusively for image reading. May equal `[primary].base_url`. A loopback address (Ollama, LM Studio, llama.cpp) works and needs no key. |
| `api_key_env` | string | Optional. Keyless vision engines are allowed. |
| `model` | string | Vision-capable model slug (e.g. `qwen2.5vl`). |

Swapping providers means editing two strings and restarting. That is the whole
migration story.

---

## Images: the four vision modes

Codex users paste screenshots and use the `view_image` tool. What happens to
those image parts depends on `images`:

| Mode | Behavior |
| --- | --- |
| `native` | Image parts pass through untranslated (`input_image` → `image_url`). Use when the primary model is genuinely multimodal. No second model is ever called. |
| `bridge` | Every image is sent to the `[vision]` model, which returns a structured text transcript; the transcript replaces the image in the turn. For primary models that cannot see. |
| `chatgpt` | Like `bridge`, but the reader is the native Codex backend reached with the caller's own live session headers. Fail-closed: without a signed-in session the proxy degrades to stripping images rather than erroring the turn. |
| `off` | Image parts are stripped and replaced with a short note. The turn continues. |

The bridge is engineered to *help*, never to fail a turn:

- Transcripts follow a fixed contract (Summary / Identification / Text /
  Layout / Data / Uncertain) and target the user's actual question.
- Evidence cache keyed by `sha256(image)` + question: identical screenshots are
  read once (TTL 1h, max 128 entries / 8 MB).
- Bounded concurrency (4 parallel reads), transient-failure retries
  (250 ms, 1 s), 120 s timeout per attempt, transcripts capped at 24K chars.
- An unreadable image degrades to an explicit "unreadable" note — the turn
  proceeds.

---

## Request lifecycle

For every `POST /v1/responses`:

1. **Capability auth.** The URL path contains a per-installation secret;
   matched timing-safes. Wrong path ⇒ `404`.
2. **Vision policy** (see above) rewrites image parts in place.
3. **Translation.** Responses body → Chat body: `instructions` becomes a
   system message; `function_call` history items become assistant
   `tool_calls`; `function_call_output` becomes a `tool` message;
   `reasoning` items are dropped; tools are re-wrapped into Chat's nested
   format; `max_output_tokens` becomes `max_tokens`;
   `stream_options.include_usage` is injected.
4. **Upstream call** with bounded retry: retried **only before the first byte
   is relayed**, only for 502/503/504/520–524 and transport errors — maximum
   2 retries inside a 5-second budget. Once streaming starts, a broken stream
   fails honestly instead of being silently replayed.
5. **Back-translation.**
   - Streaming: Chat SSE is transformed event-by-event into Responses events
     (`response.created`, `output_item.added`, `output_text.delta`,
     `function_call_arguments.delta`, …, `response.completed`) with usage
     patched in-flight.
   - Non-streaming: the JSON choice is mapped back to Responses output items
     with usage normalization.
6. **Usage patch.** Only *explicitly zero* prompt-token counts are replaced
   with an estimate (`ceil(bytes / 3.3)`, floor 1000 tokens) so Codex's
   auto-compaction trigger keeps working with endpoints that misreport usage.
   Honest non-zero numbers are never touched.

`GET /v1/models` serves a single-model catalog built from the config.
`GET /health` is unauthenticated for local monitoring.

---

## What the proxy guarantees

These are engineering invariants, documented so they survive refactoring
(they are enforced in [`AGENTS.md`](AGENTS.md)):

1. Retries happen only before the first relayed byte, with small bounds.
2. Only explicitly-zero prompt token counts are ever substituted.
3. The capability secret never appears in logs; errors never leak upstream
   bodies, keys, or Authorization headers.
4. The vision bridge never fails a turn; worst case is a stripped image with
   a note.
5. `src/proxy/` is self-contained: only `node:*` imports, no npm runtime
   dependencies, ever.

Non-2xx upstream responses are relayed verbatim to Codex — status and body —
so provider-side error messages stay visible where you can act on them.

---

## Security model

- **Capability path = authentication.** The proxy binds to `127.0.0.1`; the
  secret path segment is the only thing authorizing callers. It lives in
  `caller-key` (mode `600`) and in your `config.toml` snippet — nowhere else.
- **Keys pass through, never rest.** The config stores environment variable
  *names*; values are resolved at request time and held in memory only.
- **Logs are safe by construction.** URLs are redacted, payloads are never
  logged, upstream error bodies are relayed but not written anywhere.

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_ROUTER_PORT` | `4102` | Proxy listen port. |
| `CODEX_ROUTER_HOST` | `127.0.0.1` | Bind address. Keep it loopback unless you know why. |
| `CODEX_HOME` | `~/.codex` | Codex home used to derive the state directory. |
| `MODEL_ROUTER_STATE_DIR` | `~/.codex/codex-router` | State directory (config, caller key, snippet). |
| `CODEX_NATIVE_BASE_URL` | `https://chatgpt.com/backend-api/codex` | Backend used by the `chatgpt` vision mode. |
| `CODEX_ROUTER_VISION_CHATGPT_MODEL` | `gpt-5` | Model slug requested from the backend in `chatgpt` mode. |
| `CODEX_ROUTER_QUIET` | unset | Set to silence routine logging. |

---

## Project structure

```
src/proxy/
├── main.mjs            # entry point: state dir, secret, config, listen
├── paths.mjs           # slim constants (state dir, ports, native base)
├── config.mjs          # mini-TOML parser + validation
├── server.mjs          # HTTP server: auth, vision policy, routing
├── translate.mjs       # Responses ↔ Chat mapping + SSE transform
├── http.mjs            # request/response plumbing helpers
├── caller-auth.mjs     # capability-path authentication
├── upstream-retry.mjs  # bounded pre-stream retry logic
├── response-usage.mjs  # usage normalization + zero-token patching
└── vision-bridge.mjs   # image → structured text evidence engine
```

Ten modules. ~119 KB of source. Zero dependencies.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Proxy exits immediately: `router config not found` | Create `router.toml` in the state directory (see Quick start). |
| Codex shows connection errors | Is the proxy running? Does the snippet in `config.toml` match the current secret (regenerated if `caller-key` was deleted)? Fully restart Codex after pasting. |
| Model responds but can't use tools | Your endpoint doesn't support OpenAI function calling — this is disqualifying, see Requirements. |
| Requests fail with images, work without | Primary model is text-only. Set `images = "bridge"` and configure `[vision]`, or `"off"` to ignore images. |
| Compaction triggers constantly | Endpoint reports zero prompt tokens. The proxy patches this automatically; verify you're on a recent version. |
| `401/403` from upstream | Check the env variable named by `api_key_env` is set in the shell starting the proxy. |

---

## Credits

This project would not exist without
**[duolahypercho/codex-router](https://github.com/duolahypercho/codex-router)** —
a remarkable piece of engineering that proved Codex can be routed to external
models locally without giving up credential isolation or catalog integration.

The core ideas here are inherited from that codebase and adapted for a
single-endpoint world: the capability-path caller authentication, the
discipline of retrying only before the first relayed byte, the surgical
zero-prompt-usage substitution that keeps compaction alive, and the entire
vision evidence bridge — image reads as structured, cached, question-targeted
text transcripts that degrade gracefully instead of failing turns.

If this proxy is useful to you, the upstream project deserves your star,
attention, and support far more than this repository does. Go read its README;
it is a masterclass in documenting a complex system honestly.

---

## License

Attribution notices in [`NOTICE.md`](NOTICE.md).

---

# README на русском

# codex-router-proxy

Используйте **любой OpenAI-совместимый эндпоинт моделей** внутри Codex App и CLI.

`codex-router-proxy` — компактный локальный прокси, который говорит с Codex на
**Responses API**, а каждый ход переводит в обычные вызовы **Chat Completions**
к выбранному вами апстриму — собственному self-hosted LLM, корпоративному
шлюзу или любому провайдеру с `/v1/chat/completions`. Один крошечный процесс
Node.js, ноль npm-зависимостей, ни Python, ни сервисной обвязки.

Проект вырос из потребности, которую апстрим-проект закрывает тяжёлой
машинерией: *«я просто хочу, чтобы мой Codex ходил в мой собственный
эндпоинт»*. Если вам нужен полный мультипровайдерный роутер — курируемые
каталоги, OAuth-маршруты, трей-приложения, карточки квот — используйте
[duolahypercho/codex-router](https://github.com/duolahypercho/codex-router).
Этот репозиторий — дистиллированное одноэндпоинтное ядро той идеи.

> Это независимый community-проект. Он не связан с OpenAI, Anthropic,
> Moonshot AI или любым поставщиком моделей и не одобрен ими.

---

## Содержание

- [Как это работает](#как-это-работает)
- [Требования](#требования)
- [Быстрый старт](#быстрый-старт)
- [Конфигурация](#конфигурация)
- [Картинки: четыре vision-режима](#картинки-четыре-vision-режима)
- [Жизненный цикл запроса](#жизненный-цикл-запроса)
- [Гарантии прокси](#гарантии-прокси)
- [Модель безопасности](#модель-безопасности)
- [Переменные окружения](#переменные-окружения)
- [Структура проекта](#структура-проекта)
- [Устранение неполадок](#устранение-неполадок)
- [Благодарности](#благодарности)

---

## Как это работает

Codex всегда общается с тем, что считает OpenAI Responses API. Прокси слушает
на loopback, принимает этот трафик за секретным capability-путём, транслирует
его в Chat Completions для вашего апстрима и переводит ответ — включая полный
SSE-поток токенов — обратно в события Responses, которые понимает Codex.

```
┌─────────┐   Responses API    ┌──────────────────────────────────────┐
│         │ ─────────────────► │  capability-проверка (timing-safe)   │
│  Codex  │                    │  vision-политика (native|bridge|     │
│         │ ◄───────────────── │    chatgpt|off)                      │
└─────────┘   Responses SSE    │  translateRequest (Responses → Chat) │
                               │  fetchWithRetry ──► ваш эндпоинт     │
                               │  обратная трансляция (Chat → Resp.)  │
                               │  usage-патч (нулевые prompt-токены)  │
                               └──────────────────────────────────────┘
                                        │
                                        ▼
                     любой OpenAI-совместимый /chat/completions
```

Шаг установки намеренно ручной и прозрачный: прокси пишет небольшой помеченный
TOML-блок (`codex-config-snippet.toml`), который вы сами вставляете в свой
`~/.codex/config.toml`. Существующие профили, MCP-серверы и настройки никогда
не затрагиваются.

```toml
# >>> codex-router-proxy >>>
model_provider = "codex-router-proxy"
model = "ваша-модель"

[model_providers.codex-router-proxy]
name = "codex-router-proxy"
base_url = "http://127.0.0.1:4102/_codex-router/<сгенерированный-секрет>/v1"
wire_api = "responses"
# <<< codex-router-proxy <<<
```

Сгенерированный сегмент `<сгенерированный-секрет>` — это и есть аутентификация
вызывающего. Относитесь к нему как к паролю: не вставляйте полные URL в issue,
чаты и скриншоты.

---

## Требования

**Рантайм:** Node.js ≥ 22.19 (рекомендуется Node 24 LTS). Больше ничего — нет
ни npm-зависимостей, ни Python, ни шагов сборки.

**Ваш эндпоинт должен:**

| Требование | Зачем |
| --- | --- |
| Отдавать OpenAI-совместимый `POST /v1/chat/completions` | Единственная поверхность апстрима, которую вызывает прокси. |
| Поддерживать **function/tool calling** | Codex ведёт каждый ход через вызовы инструментов; модель без tool calling в Codex работать не может вовсе. |
| Поддерживать **SSE-стриминг** (`stream: true`) | Codex стримит каждое завершение. Не-стриминговые запросы поддерживаются, но используются редко. |
| Иметь контекст ≥ ~24–32K токенов | Собственный системный промпт Codex съедает порядка 20K токенов ещё до начала вашей задачи. |
| Отдавать ненулевые `usage.prompt_tokens` *(желательно)* | Если эндпоинт отдаёт явные нули, прокси подставляет консервативную оценку по байтам, чтобы компакция Codex продолжала работать, — но честные числа лучше. |

---

## Быстрый старт

### 1. Создайте конфигурацию

`~/.codex/codex-router/router.toml`:

```toml
[primary]
base_url = "https://llm.example.com/v1"
api_key_env = "MY_ENDPOINT_API_KEY"   # опционально; без ключа — опустить
model = "ваша-модель"
images = "bridge"                     # native | bridge | chatgpt | off

[vision]                              # обязателен при images = "bridge"
base_url = "https://llm.example.com/v1"
api_key_env = "MY_ENDPOINT_API_KEY"   # опционально; локальные движки без ключа — ОК
model = "qwen2.5vl"
```

### 2. Запустите прокси

Windows (PowerShell):

```powershell
.\start.ps1
```

macOS / Linux:

```sh
./start.sh
```

При первом старте прокси создаёт каталог состояния, генерирует
capability-секрет и пишет `~/.codex/codex-router/codex-config-snippet.toml`.

### 3. Подключите Codex

Вставьте сгенерированный сниппет в `~/.codex/config.toml`, полностью закройте
Codex, откройте снова и выберите вашу модель. Теперь каждый ход идёт через
прокси.

---

## Конфигурация

Вся конфигурация живёт в одном файле: `~/.codex/codex-router/router.toml`
(каталог переопределяется `MODEL_ROUTER_STATE_DIR`). Парсер принимает
намеренное подмножество TOML: секции, строковые значения, комментарии. Всё
остальное — жёсткая ошибка запуска, а не тихая неверная конфигурация.

### `[primary]` — обязателен

| Ключ | Тип | Описание |
| --- | --- | --- |
| `base_url` | строка | Корень OpenAI-совместимого эндпоинта. Прокси добавляет `/chat/completions`. |
| `api_key_env` | строка | **Имя** переменной окружения с API-ключом. Само значение прокси никогда не читает с диска и не хранит. Для эндпоинтов без ключа — опустить. |
| `model` | строка | Слаг модели, который выбирает Codex: объявляется через `/v1/models`, попадает в сниппет и возвращается в ответах. |
| `model_upstream` | строка | Опционален. Слаг, реально отправляемый эндпоинту, если тот маршрутизирует под другим именем. По умолчанию равен `model`. |
| `images` | строка | Vision-политика: `native`, `bridge`, `chatgpt` или `off`. По умолчанию `native`. |

### `[vision]` — обязателен при `images = "bridge"`

| Ключ | Тип | Описание |
| --- | --- | --- |
| `base_url` | строка | Эндпоинт исключительно для чтения картинок. Может совпадать с `[primary].base_url`. Loopback-адрес (Ollama, LM Studio, llama.cpp) работает и ключа не требует. |
| `api_key_env` | строка | Опционален. Vision-движки без ключа разрешены. |
| `model` | строка | Слаг vision-модели (например, `qwen2.5vl`). |

Смена провайдера — это правка двух строк и рестарт. Вот и вся история миграции.

---

## Картинки: четыре vision-режима

Пользователи Codex вставляют скриншоты и используют тулзу `view_image`. Что
происходит с этими частями изображения, определяется параметром `images`:

| Режим | Поведение |
| --- | --- |
| `native` | Части изображений проходят без преобразований (`input_image` → `image_url`). Когда основная модель действительно мультимодальная. Вторая модель не вызывается никогда. |
| `bridge` | Каждая картинка отправляется модели из `[vision]`, она возвращает структурированный текстовый транскрипт; он заменяет картинку в ходе. Для основных моделей, которые не видят. |
| `chatgpt` | Как `bridge`, но читатель — нативный бэкенд Codex, к которому идут живые заголовки сессии вызывающего. Fail-closed: без залогиненной сессии прокси деградирует до вырезания картинок, а не роняет ход. |
| `off` | Части изображений вырезаются и заменяются короткой пометкой. Ход продолжается. |

Bridge спроектирован помогать и никогда не ронять ход:

- Транскрипты следуют фиксированному контракту (Summary / Identification /
  Text / Layout / Data / Uncertain) и целятся в реальный вопрос пользователя.
- Кэш выжимок по ключу `sha256(картинка)` + вопрос: одинаковые скриншоты
  читаются один раз (TTL 1ч, максимум 128 записей / 8 МБ).
- Ограниченный параллелизм (4 одновременных чтения), ретраи транзиентных
  сбоев (250 мс, 1 с), таймаут 120 с на попытку, транскрипты обрезаются на
  24K символов.
- Нечитаемая картинка деградирует до явной пометки «нечитаемо» — ход
  продолжается.

---

## Жизненный цикл запроса

Для каждого `POST /v1/responses`:

1. **Capability-аутентификация.** Путь URL содержит секрет этой инсталляции;
   сверяется timing-safe. Неверный путь ⇒ `404`.
2. **Vision-политика** (см. выше) переписывает части изображений на месте.
3. **Трансляция.** Тело Responses → тело Chat: `instructions` становится
   системным сообщением; элементы истории `function_call` превращаются в
   assistant `tool_calls`; `function_call_output` — в сообщение роли `tool`;
   элементы `reasoning` отбрасываются; инструменты переоборачиваются во
   вложенный формат Chat; `max_output_tokens` становится `max_tokens`;
   инжектируется `stream_options.include_usage`.
4. **Вызов апстрима** с ограниченным ретраем: повторяется **только до первого
   переданного клиенту байта**, только для 502/503/504/520–524 и транспортных
   ошибок — максимум 2 повтора в бюджете 5 секунд. Раз стриминг начался,
   разорванный поток честно фейлится, а не тихо переигрывается.
5. **Обратная трансляция.**
   - Стриминг: Chat SSE преобразуется событие-за-событием в события Responses
     (`response.created`, `output_item.added`, `output_text.delta`,
     `function_call_arguments.delta`, …, `response.completed`) с патчем usage
     на лету.
   - Не-стриминг: JSON-choice отображается обратно в выходные элементы
     Responses с нормализацией usage.
6. **Usage-патч.** Заменяются только *явно нулевые* счётчики prompt-токенов —
   оценкой (`ceil(bytes / 3.3)`, минимум 1000 токенов), чтобы триггер
   авто-компакции Codex работал с эндпоинтами, неправильно отдающими usage.
   Честные ненулевые числа никогда не затрагиваются.

`GET /v1/models` отдаёт однокомпонентный каталог из конфига. `GET /health`
не требует аутентификации и нужен локальному мониторингу.

---

## Гарантии прокси

Это инженерные инварианты, задокументированные, чтобы пережить рефакторинг
(они закреплены в [`AGENTS.md`](AGENTS.md)):

1. Ретраи происходят только до первого переданного байта, с малыми границами.
2. Подменяются только явно нулевые счётчики prompt-токенов.
3. Capability-секрет никогда не появляется в логах; ошибки никогда не утекают
   телами апстрима, ключами или заголовками Authorization.
4. Vision bridge никогда не роняет ход; худший случай — вырезанная картинка
   с пометкой.
5. `src/proxy/` самодостаточен: только импорты `node:*`, никаких npm-зависимостей
   рантайма — всегда.

Не-2xx ответы апстрима передаются Codex дословно — статус и тело, — чтобы
ошибки провайдера оставались видимыми там, где с ними можно что-то сделать.

---

## Модель безопасности

- **Capability-путь = аутентификация.** Прокси привязан к `127.0.0.1`; секретный
  сегмент пути — единственное, что авторизует вызывающих. Он живёт в
  `caller-key` (mode `600`) и в вашем сниппете для `config.toml` — больше нигде.
- **Ключи проходят насквозь, но не хранятся.** В конфиге хранятся *имена*
  переменных окружения; значения разрешаются в момент запроса и живут только
  в памяти.
- **Логи безопасны по построению.** URL красактируются, полезные нагрузки
  никогда не логируются, тела ошибок апстрима передаются дальше, но нигде
  не записываются.

---

## Переменные окружения

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `CODEX_ROUTER_PORT` | `4102` | Порт прослушивания прокси. |
| `CODEX_ROUTER_HOST` | `127.0.0.1` | Адрес привязки. Держите loopback, если не знаете, зачем иначе. |
| `CODEX_HOME` | `~/.codex` | Домашний каталог Codex для вычисления каталога состояния. |
| `MODEL_ROUTER_STATE_DIR` | `~/.codex/codex-router` | Каталог состояния (конфиг, ключ, сниппет). |
| `CODEX_NATIVE_BASE_URL` | `https://chatgpt.com/backend-api/codex` | Бэкенд для vision-режима `chatgpt`. |
| `CODEX_ROUTER_VISION_CHATGPT_MODEL` | `gpt-5` | Слаг модели, запрашиваемый у бэкенда в режиме `chatgpt`. |
| `CODEX_ROUTER_QUIET` | не задана | Установите, чтобы заглушить рутинное логирование. |

---

## Структура проекта

```
src/proxy/
├── main.mjs            # точка входа: каталог состояния, секрет, конфиг, listen
├── paths.mjs           # slim-константы (каталог состояния, порты, native base)
├── config.mjs          # мини-TOML парсер + валидация
├── server.mjs          # HTTP-сервер: аутентификация, vision-политика, роутинг
├── translate.mjs       # маппинг Responses ↔ Chat + SSE-трансформ
├── http.mjs            # помощники передачи запросов/ответов
├── caller-auth.mjs     # аутентификация по capability-пути
├── upstream-retry.mjs  # ограниченные ретраи до начала стрима
├── response-usage.mjs  # нормализация usage + патч нулевых токенов
└── vision-bridge.mjs   # движок «картинка → структурированный текст»
```

Десять модулей. ~119 KB исходников. Ноль зависимостей.

---

## Устранение неполадок

| Симптом | Вероятная причина / решение |
| --- | --- |
| Прокси сразу завершается: `router config not found` | Создайте `router.toml` в каталоге состояния (см. Быстрый старт). |
| Codex показывает ошибки соединения | Прокси запущен? Сниппет в `config.toml` соответствует текущему секрету (перегенерируется при удалении `caller-key`)? Полностью перезапустите Codex после вставки. |
| Модель отвечает, но не умеет тулзы | Эндпоинт не поддерживает OpenAI function calling — это дисквалифицирует, см. Требования. |
| Запросы падают с картинками, работают без них | Основная модель текстовая. Поставьте `images = "bridge"` и настройте `[vision]`, либо `"off"`, чтобы игнорировать картинки. |
| Компакция срабатывает постоянно | Эндпоинт отдаёт нулевые prompt-токены. Прокси латит это автоматически; проверьте, что у вас свежая версия. |
| `401/403` от апстрима | Проверьте, что переменная из `api_key_env` выставлена в оболочке, запускающей прокси. |

---

## Благодарности

Этот проект не существовал бы без
**[duolahypercho/codex-router](https://github.com/duolahypercho/codex-router)** —
выдающейся инженерной работы, доказавшей, что Codex можно локально направить к
внешним моделям без отказа от изоляции учётных данных и интеграции с каталогом.

Ключевые идеи здесь унаследованы из той кодовой базы и адаптированы для мира
одного эндпоинта: capability-аутентификация по пути, дисциплина ретраев строго
до первого переданного байта, хирургическая подстановка нулевых prompt-токенов,
удерживающая компакцию на плаву, и весь vision evidence bridge — чтение
картинок как структурированных, кэшированных, целенных на вопрос текстовых
выжимок, которые деградируют мягко вместо того, чтобы ронять ходы.

Если этот прокси вам полезен, апстрим-проект заслуживает вашу звезду, внимание
и поддержку куда больше, чем этот репозиторий. Прочитайте его README — это
мастер-класс честного документирования сложной системы.

---

## Лицензия

Уведомления об атрибуции — в [`NOTICE.md`](NOTICE.md).
