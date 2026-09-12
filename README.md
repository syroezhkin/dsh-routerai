# dsh-routerai

Two independent plugins for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
that connect it to [RouterAI](https://routerai.ru) and price what it spends.

| Package | What it does | Install |
|---|---|---|
| [`dsh-web-search-routerai`](packages/web-search-routerai) | Web search through RouterAI's server-side retrieval | `dsh plugin --profile web add dsh-web-search-routerai` |
| [`dsh-session-cost-routerai`](packages/session-cost-routerai) | Session cost in roubles, beside the composer | `dsh plugin --profile web add dsh-session-cost-routerai` |

They share a vendor, not a dependency: install either one alone.

## Why these exist

DSH ships a DeepSeek web-search provider that speaks the Anthropic-compatible Messages API and requires
`web_search_tool_result` blocks in the response. RouterAI does not execute native search on `/messages` —
it hands the tool call back to the caller. It *does* run server-side retrieval on `/chat/completions`
under `plugins:[{id:"web"}]`, returning structured `url_citation` annotations, and that is the route the
provider here uses.

Nothing in DSH reports a session's cost. The meter prices the session's own token counts against
RouterAI's published tariff, and shows the key's real spend alongside it.

## Install

Both packages are bundles: `dsh plugin` forwards to pnpm in the profile directory and then registers the
package as a profile layer, because each manifest declares `dsh.bundle`. Restart DSH and reload the page.

```sh
dsh plugin --profile web add dsh-web-search-routerai dsh-session-cost-routerai
```

Before the packages are on the registry, install a workspace member straight from git. The `#path:`
selector is required: the repository root is a private workspace manifest that declares no `dsh.bundle`,
so installing it bare would register nothing.

```sh
dsh plugin --profile web add "github:syroezhkin/dsh-routerai#path:packages/web-search-routerai"
dsh plugin --profile web add "github:syroezhkin/dsh-routerai#path:packages/session-cost-routerai"
```

## Configure

Each package patches its own row. Put overrides in the profile's `cordis.patch.yml` (or the home-level
one, which takes precedence):

```yaml
- id: web-search-routerai
  config:
    baseURL: https://routerai.ru/api/v1
    maxResults: 5      # first billing tier; see the package README
    engine: exa

- id: session-cost
  config:
    baseURL: https://routerai.ru/api/v1
```

Both read their credential through the credentials service, so setting the key once on the Web **Models**
page configures both.

## Cost, briefly

Search bills in tiers: `2.2 RUB × ceil(max_results / 5)` per query, charged on the *requested* count. The
provider clamps every caller to `maxResults` (default 5) to stay in the cheapest tier.

The session meter is an estimate — RouterAI tariffs some routes by time of day — and the key's own spend
is shown beside it as the authoritative figure. See each package README for detail.

## Development

A pnpm workspace. Each package is plain JavaScript, hand-written in the shapes DSH loads; there is no
build step.

```sh
pnpm install
node --check packages/*/index.js packages/*/client.js
```

## License

MIT
