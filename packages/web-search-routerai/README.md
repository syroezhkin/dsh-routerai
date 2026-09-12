# dsh-web-search-routerai

Web search for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) through
[RouterAI](https://routerai.ru). Registers a `ctx.web` search provider and points the shared `web` row
at it, so the model's `web_search` tool answers from RouterAI's server-side retrieval.

## Why this exists

The provider DSH ships (`@deepseek-ai/dsh-web-search-deepseek`) speaks the Anthropic-compatible Messages
API and requires the response to carry `web_search_tool_result` blocks. RouterAI does not execute native
search on `/messages` — it returns the tool call back to the caller, or plain text under
`plugins:[{id:"web"}]`. Its official counterpart at `api.deepseek.com` does return those blocks, but a
RouterAI key is rejected there with HTTP 401.

RouterAI *does* run server-side retrieval on `/chat/completions` when the request carries
`plugins:[{id:"web"}]`, returning structured `url_citation` annotations. This package calls that route and
maps the citations onto DSH's portable `sources[]` shape.

## Install

```sh
dsh plugin --profile web add dsh-web-search-routerai
```

`dsh plugin` forwards to pnpm in the profile directory and then registers the package as a profile layer
automatically, because the manifest declares `dsh.bundle`. Restart DSH afterwards.

## Configure

The row is `web-search-routerai` in the profile's `cordis.patch.yml`, or the home-level file:

```yaml
- id: web-search-routerai
  config:
    apiKeyEnv: DEEPSEEK_API_KEY          # credential reference (see below)
    baseURL: https://routerai.ru/api/v1  # another compatible gateway
    model: "~deepseek/deepseek-v4-flash-latest"  # model for the search request
    maxResults: 5                        # billing tier ceiling
    engine: exa                          # native | exa
```

### Credentials

The key is read from the credentials service first (the store the Web **Models** page writes), then from
the environment named by `apiKeyEnv`. To bypass both, set a literal:

```yaml
- id: web-search-routerai
  config:
    apiKey: sk-...
```

Prefer the credentials store: a literal key in a config file tends to end up in version control.

## Cost

RouterAI bills search in tiers of five results:

```
cost = 2.2 RUB × ceil(max_results / 5)
```

Measured at `max_results` 5 / 6 / 10 / 11 / 15 → 2.20 / 4.39 / 4.41 / 6.60 RUB. Billing follows the
**requested** count, not the returned one: a query with no hits at `max_results=8` still charged 4.4 RUB.

DSH's `tool-web` asks for 8 results by default, which would land in the second tier. This provider clamps
every request down to `maxResults`, so `5` keeps each search in the cheapest tier. Raising it to 6 or more
doubles the per-query cost; each further five results adds another 2.2 RUB.

## Engine

`engine: native` returned **zero citations** in every live run against this route (empty body,
`finish_reason: "length"`), while `exa` and the unset default returned citations every time. The default
is therefore `exa`, pinned explicitly rather than left to the server.

## Do not use `:online`

The `:online` model suffix is documented sugar for exactly `plugins:[{id:"web"}]` and measured
byte-identical to it — but it accepts no parameters, so it cannot express `max_results` or `engine`.
Switching to it buys nothing and loses the cost ceiling.

## Notes

- This package declares no browser half. The provider is host-side only.
- Search and the companion package `dsh-session-cost-routerai` are independent; either can be installed
  alone.
- Selecting the provider lives here, in this package's patch, not in the cost package — otherwise the two
  could not be installed separately.

## License

MIT
