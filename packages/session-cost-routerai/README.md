# dsh-session-cost-routerai

A session cost meter for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH),
priced from what [RouterAI](https://routerai.ru) actually billed. A compact pill sits beside the composer's
context ring and shows what the current session has cost in roubles; clicking it opens a breakdown.

## Install

```sh
dsh plugin --profile web add dsh-session-cost-routerai
```

`dsh plugin` forwards to pnpm in the profile directory and then registers the package as a profile layer
automatically, because the manifest declares `dsh.bundle`. Restart DSH afterwards, then reload the page.

The companion package [`dsh-web-search-routerai`](../web-search-routerai) is independent — install either
one alone.

## What it shows

| Row | Meaning |
|---|---|
| `N ₽` | What RouterAI charged for this session's model calls, summed from per-generation `total_cost` |
| Вызовы | Priced generations out of observed ones |
| Модель | The route the session bills against, as the host resolved it |
| Провайдер | The endpoint that served the last priced generation |
| Токены | Total tokens the session has been charged for |
| Вход (без кэша) | Prompt tokens not served from cache |
| Чтение кэша | Prompt tokens served from cache |
| Выход | Generated tokens |
| Расход ключа | The key's own spend, across **all** sessions — authoritative |
| Баланс | Remaining account balance |

Kopecks are shown because the figure is a bill, not an estimate: `0,03 ₽` is a real charge. Values below
one kopeck read as `<0,01 ₽`.

## How the price is derived

The meter does not reconstruct a price from a price list. The first version did exactly that — multiplied
DSH's token counts by the tariff in RouterAI's `GET /models` — and it was wrong by 1.1×–4.8× depending on
the route, because that tariff belongs to one representative provider while RouterAI bills the endpoint
that actually served the request.

This version adds up what was billed:

- every model request carries an `X-Generation-Id` response header;
- `GET /api/v1/generation?id=…` answers with `total_cost` in roubles for that generation;
- the plugin sums those per session and serves the total to the pill.

The id is read by wrapping the process's global `fetch` once. The wrapper is pure observation: it awaits
the original response and hands that same `Response` back untouched — no body is read or tee'd, so
streaming and retries behave exactly as without the plugin. Requests are attributed to a session through
`x-deepseek-harness-session-id`, which DSH already sets on every model call, so title and compaction calls
land in the right session too.

### What the figure covers

- **It trails the conversation by a request.** A generation is priced when it settles, so the last answer
  may be missing for a couple of seconds. The panel shows `Вызовы` so the gap is visible.
- **It starts when the plugin starts.** Generations from before the install (or the last restart) have no
  recorded ids, so they cannot be priced; the panel says «с HH:MM» instead of pretending otherwise.
  Totals survive restarts through the state file.
- **Web search is not included.** `dsh-web-search-routerai` calls `/chat/completions` directly, outside the
  harness adapter, so its per-search charge (2,2 ₽ at the default tier) is invisible to the meter.
  `Расход ключа` still includes it, which is why the two figures can differ noticeably in a searching
  session.
- **Subagent sessions are separate.** A child session has its own id and its own total; the parent pill
  does not aggregate children.

### Why not `usage.cost`

RouterAI returns `usage.cost` on `/chat/completions`, but DSH speaks the Anthropic-compatible Messages API,
where the usage object carries tokens only. The authoritative per-request price is therefore the generation
record, which is what this meter reads.

## Configuration

```yaml
- id: session-cost
  config:
    baseURL: https://routerai.ru/api/v1   # must match llm-deepseek.baseURL
    apiKeyEnv: DEEPSEEK_API_KEY
    statePath: ~/.dsh/storages/session-cost-routerai.json   # null = memory only
    trackCost: true                        # false = tokens and key figures only
```

`baseURL` matters: the observer only recognises model requests under this root. If it differs from the
adapter's `llm-deepseek.baseURL`, the pill stays on token counts.

## Credentials

The per-generation lookup and the key figures need the API key, and both are read host-side — the key
never reaches the browser. Resolution order: a literal `apiKey` in the row config, then the credentials
store (the Web **Models** page writes it), then the environment named by `apiKeyEnv`.

```yaml
- id: session-cost
  config:
    apiKeyEnv: DEEPSEEK_API_KEY   # or set apiKey: sk-... (less safe)
```

## Where the numbers come from

The host serves one JSON document at `/api/session-cost`, registered through `connection.fetch` so the
Host/Origin fence and browser authentication apply. It carries the per-session bill, the counters behind
it, the resolved model, and the key figures. RouterAI's ~1 MB catalogue is never fetched, let alone sent to
the browser.

Without `Расход ключа` and `Баланс` the pill still works: those two rows simply show a dash.

## Notes

- The state file holds only session totals and counters; the API key is never written to it.
- The pill is a client plugin, so a page reload is needed after the first install.
- It occupies the `conversation.input.right` seat, beside the model selector and the context ring, and
  registers under its own id so it does not displace them.

## License

MIT
