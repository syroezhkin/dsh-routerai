# dsh-session-cost-routerai

A session cost meter for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH),
priced from live [RouterAI](https://routerai.ru) rates. A compact pill sits beside the composer's context
ring and shows what the current session has cost in roubles; clicking it opens a breakdown.

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
| `≈ N ₽` | Estimated cost of this session's tokens at the session's own route tariff |
| Модель | The route the session bills against, as the host resolved it |
| Токены | Total tokens the session has been charged for |
| Вход (без кэша) | Prompt tokens not served from cache |
| Чтение кэша | Prompt tokens served from cache, billed at the cache-read rate |
| Выход | Generated tokens |
| Расход ключа | The key's own spend, across **all** sessions — authoritative |
| Баланс | Remaining account balance |

Roubles are rounded to whole units. Kopecks imply a precision the estimate does not have.

## How the price is derived

Token counts come from DSH's own `tokenUsage` session projection — the meter does not measure anything
itself. The tariff comes from RouterAI's public `/models` catalogue and is applied as:

```
cost = uncached_input × input_rate + cache_read × cache_read_rate + output × output_rate
```

Rates are per token and republished by the provider, so they are fetched live (cached ten minutes) rather
than baked in.

### Which model is priced

The host resolves the route from the session's own `request/context` event — the last one in the log for a
cold session. Configure `model` only to override that when the session has no recorded route:

```yaml
- id: session-cost
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://routerai.ru/api/v1
    model: null   # null = ask the session (the default)
```

If no route can be resolved, the pill shows **token counts without a rouble figure** rather than a number
priced at some other model's rate.

### Why `≈`

RouterAI tariffs some routes by time of day, and routes to whichever provider is cheapest at that moment.
For popular routes the estimate matches the provider's own charge closely; for others it can drift by a
tenth or so. The authoritative figure is **Расход ключа**, which is what the provider actually billed.

## Credentials

Rates are public and need no key. The key's spend and balance do, and they are read host-side — the key
never reaches the browser. Resolution order: a literal `apiKey` in the row config, then the credentials
store (the Web **Models** page writes it), then the environment named by `apiKeyEnv`.

```yaml
- id: session-cost
  config:
    apiKeyEnv: DEEPSEEK_API_KEY   # or set apiKey: sk-... (less safe)
```

## Where the numbers come from

The host serves one JSON document at `/api/session-cost`, registered through `connection.fetch` so the
Host/Origin fence and browser authentication apply. It carries the resolved model, that model's tariff,
and the key figures. The ~830 KB catalogue never crosses to the browser.

Without `Расход ключа` and `Баланс` the pill still works: those two rows simply show a dash.

## Notes

- No configuration is written to disk; all state is in-memory cache with a short TTL.
- The pill is a client plugin, so a page reload is needed after the first install.
- It occupies the `conversation.input.right` seat, beside the model selector and the context ring, and
  registers under its own id so it does not displace them.

## License

MIT
