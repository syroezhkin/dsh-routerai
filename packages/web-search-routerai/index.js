/**
 * RouterAI-backed web search provider for the DeepSeek Harness `ctx.web` seam.
 *
 * WHY THIS PACKAGE EXISTS
 * The shipped `@deepseek-ai/dsh-web-search-deepseek` provider speaks the
 * Anthropic-compatible Messages API and requires the response to carry
 * `web_search_tool_result` blocks. RouterAI (`routerai.ru`) does NOT execute
 * native search on `/messages`: it returns `tool_use` (the tool handed back to
 * the caller) or, with `plugins:[{id:"web"}]`, `thinking` + `text` blocks —
 * never `web_search_tool_result`. Its official-API counterpart at
 * `api.deepseek.com` does return those blocks, but a RouterAI key is rejected
 * there with HTTP 401.
 *
 * RouterAI DOES perform server-side retrieval on `/chat/completions` when the
 * request carries `plugins:[{id:"web"}]`, returning structured citations in
 * `choices[0].message.annotations[]` as
 * `{ type: "url_citation", url_citation: { url, title, content } }`.
 * This provider calls that route and maps the citations onto the seam's
 * portable `WebSearchResult.sources[]` shape.
 *
 * COST MODEL (measured, 15 samples against the live endpoint)
 * RouterAI bills search in tiers of five results:
 *     cost = 2.2 RUB * ceil(max_results / 5)
 * Verified at max_results 5/6/10/11/15 -> 2.20/4.39/4.41/6.60 RUB. Billing
 * follows the REQUESTED count, not the returned one: a query with no hits at
 * `max_results=8` still charged 4.4 RUB. `dsh-tool-web` sends its own
 * `searchMaxResults` (default 10 in DSH 0.2.x) as `request.maxResults`, which
 * would land in the second tier, so this provider clamps to `maxResults` below
 * rather than leaving it to preset config.
 *
 * ENGINE
 * `engine: "native"` returned ZERO citations in 6 of 6 live runs (empty body,
 * `finish_reason: "length"`), while `exa` and the unset default returned
 * citations in 6 of 6. The engine is therefore pinned explicitly rather than
 * left to the server-side default.
 *
 * NOTE: `:online` (the model-id suffix) is documented sugar for exactly
 * `plugins:[{id:"web"}]` and measured byte-identical to it, but takes no
 * parameters — so it cannot express `max_results` or `engine`. Do not switch.
 *
 * @module dsh-web-search-routerai
 */
import { WebError } from '@deepseek-ai/dsh-web'

/**
 * Hard dependency on the web seam: without `ctx.web` this row has nothing to
 * register into, and Cordis should park it rather than run a no-op that leaves
 * the provider silently missing.
 *
 * This MUST be exported (not only declared inside `apply`) — the loader reads
 * the plugin's `inject` from its module exports, exactly as the shipped
 * `dsh-web-search-deepseek` does.
 */
export const inject = ['web']

/** Registry key this provider registers under; referenced by the `web` row. */
export const ROUTERAI_SEARCH_PROVIDER_ID = 'routerai-web'

const DEFAULT_BASE_URL = 'https://routerai.ru/api/v1'
const DEFAULT_MODEL = '~deepseek/deepseek-v4-flash-latest'
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEFAULT_MAX_TOKENS = 2048
/**
 * Default requested-result cap, in RouterAI's first billing tier (<=5 = 2.2
 * RUB). A larger caller value is clamped down to this; a smaller one is kept.
 */
const DEFAULT_MAX_RESULTS = 5
/** Search engine; `native` is broken on this route (see the module header). */
const DEFAULT_ENGINE = 'exa'
/** Endpoint override, deliberately distinct from the chat adapter's variable. */
const BASE_URL_ENV = 'ROUTERAI_SEARCH_BASE_URL'

/**
 * Project the live config onto fully-defaulted request options.
 * @param config - the composition row's config.
 * @returns detached options for one search.
 */
function resolveOptions(config) {
  const explicitKey =
    typeof config.apiKey === 'string' && config.apiKey.length > 0 ? config.apiKey : undefined
  const envBaseURL = process.env[BASE_URL_ENV]
  return {
    explicitKey,
    apiKeyEnv: typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0
      ? config.apiKeyEnv
      : DEFAULT_API_KEY_ENV,
    baseURL: typeof config.baseURL === 'string' && config.baseURL.length > 0
      ? config.baseURL
      : typeof envBaseURL === 'string' && envBaseURL.length > 0
        ? envBaseURL
        : DEFAULT_BASE_URL,
    model: typeof config.model === 'string' && config.model.length > 0 ? config.model : DEFAULT_MODEL,
    maxTokens: Number.isSafeInteger(config.maxTokens) && config.maxTokens > 0
      ? config.maxTokens
      : DEFAULT_MAX_TOKENS,
    // The billing-tier ceiling applied to every caller, including `tool-web`.
    maxResults: Number.isSafeInteger(config.maxResults) && config.maxResults > 0
      ? config.maxResults
      : DEFAULT_MAX_RESULTS,
    engine: typeof config.engine === 'string' && config.engine.length > 0
      ? config.engine
      : DEFAULT_ENGINE,
  }
}

/**
 * Resolve the bearer token: explicit literal, then the credentials service,
 * then the launching environment.
 * @param ctx - plugin context, used only if it carries a credentials service.
 * @param options - resolved options naming the credential reference.
 * @returns the usable key.
 * @throws WebError when no key is available.
 */
async function resolveApiKey(ctx, options) {
  if (options.explicitKey !== undefined) return options.explicitKey
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(options.apiKeyEnv)
    if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
  }
  const ambient = process.env[options.apiKeyEnv]
  if (typeof ambient === 'string' && ambient.length > 0) return ambient
  throw new WebError(
    `dsh-web-search-routerai: no API key for "${options.apiKeyEnv}"; store it through the credentials service (the web Models page writes it), export it in the launching environment, or set a literal "apiKey" in the row config`,
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

/**
 * Map a RouterAI chat-completions body onto the seam's search result.
 * Defensive: unknown shapes yield no sources rather than throwing.
 * @param body - the decoded JSON response.
 * @returns the portable sources plus optional answer text.
 */
function mapResponse(body) {
  const message = body?.choices?.[0]?.message ?? {}
  const annotations = Array.isArray(message.annotations) ? message.annotations : []
  const seen = new Set()
  const sources = []
  for (const entry of annotations) {
    if (entry === null || typeof entry !== 'object') continue
    const citation = entry.url_citation
    if (citation === null || typeof citation !== 'object') continue
    const url = citation.url
    if (typeof url !== 'string' || url.length === 0 || seen.has(url)) continue
    seen.add(url)
    const source = { url }
    if (typeof citation.title === 'string' && citation.title.length > 0) source.title = citation.title
    if (typeof citation.content === 'string' && citation.content.length > 0) {
      source.snippet = citation.content
    }
    sources.push(source)
  }
  const answer =
    typeof message.content === 'string' && message.content.length > 0 ? message.content : undefined
  // `truncated` is part of the seam contract; the seam re-flags it if it caps us.
  return { sources, truncated: false, ...(answer === undefined ? {} : { content: answer }) }
}

/**
 * Host plugin body: register the RouterAI search provider with `ctx.web`.
 *
 * The `inject: ['web']` requirement is declared on the exported plugin, not
 * here, because the loader reads it from the module exports.
 * @param ctx - plugin context carrying the `web` registry.
 * @param config - the composition row's config.
 */
export function apply(ctx, config = {}) {
  const options = () => resolveOptions(config)

  const provider = {
    id: ROUTERAI_SEARCH_PROVIDER_ID,
    // Provider-picker metadata: without these the Web settings list shows the
    // bare registry id, which tells a user nothing about where the search goes
    // or what it costs.
    title: 'RouterAI',
    description: {
      en: 'Web search through RouterAI (Exa engine). Billed per query (~2.2 RUB); results are capped to keep the cheapest tier.',
      ru: 'Веб-поиск через RouterAI (движок Exa). Оплата за запрос (~2,2 ₽); число результатов ограничено, чтобы держать дешёвый тариф.',
    },

    /**
     * Cheap, network-free usability check. Mirrors the shipped provider: a key
     * is *resolvable* (service present, env named, or literal configured), not
     * necessarily present.
     */
    available() {
      const resolved = options()
      return URL.canParse(resolved.baseURL) && resolved.apiKeyEnv.length > 0
    },

    async search(request, signal) {
      const resolved = options()
      const apiKey = await resolveApiKey(ctx, resolved)
      if (signal?.aborted) throw new WebError('search aborted', 'WEB_PROVIDER_ERROR')

      const endpoint = `${resolved.baseURL.replace(/\/+$/u, '')}/chat/completions`
      // Clamp to the configured ceiling: a larger caller value (`tool-web`
      // defaults to 8) would cross into the next billing tier, and a 5-result
      // tier costs the same as 1, so a smaller request passes through
      // unchanged rather than being padded up.
      const requested = Number.isSafeInteger(request.maxResults) && request.maxResults > 0
        ? request.maxResults
        : resolved.maxResults
      const effectiveMaxResults = Math.min(requested, resolved.maxResults)
      const plugin = { id: 'web', engine: resolved.engine, max_results: effectiveMaxResults }
      const body = {
        model: resolved.model,
        max_tokens: resolved.maxTokens,
        messages: [
          {
            role: 'user',
            content: `Perform a web search for the query: ${request.query}`,
          },
        ],
        plugins: [plugin],
        stream: false,
      }

      let response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        })
      } catch (error) {
        if (signal?.aborted) throw error
        throw new WebError(
          `RouterAI search request to ${endpoint} failed: ${String(error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }

      if (!response.ok) {
        let detail = ''
        try {
          detail = (await response.text()).slice(0, 300)
        } catch {}
        throw new WebError(
          `RouterAI search failed (HTTP ${String(response.status)}) at ${endpoint}${detail.length > 0 ? `: ${detail}` : ''}`,
          'WEB_PROVIDER_ERROR',
        )
      }

      let decoded
      try {
        decoded = await response.json()
      } catch (error) {
        throw new WebError(
          `RouterAI search returned an unprocessable body: ${String(error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }

      const mapped = mapResponse(decoded)
      if (mapped.sources.length === 0 && mapped.content === undefined) {
        throw new WebError(
          'RouterAI returned no citations and no answer; the request may not have triggered server-side search',
          'WEB_PROVIDER_ERROR',
        )
      }
      return mapped
    },
  }

  ctx.web.registerSearchProvider(provider)
}
