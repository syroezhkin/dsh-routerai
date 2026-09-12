/**
 * Session cost in roubles — host half.
 *
 * WHAT IT SERVES
 * One small JSON document at a stable path, so the browser never hauls the
 * ~830 KB RouterAI catalogue and never sees the API key:
 *
 *   { model, rates: { "<model id>": { input, output, cacheRead } },
 *     keyUsageRub, creditsRub, fetchedAt }
 *
 * `rates` carries only the route this session actually bills against, resolved
 * from the session's own `request/context`. That is the difference between a
 * meter that works for whoever installs it and one that only works on the
 * author's model choice: a deployment pricing a different route gets that
 * route's tariff instead of a blank.
 *
 * WHEN THE ROUTE CANNOT BE RESOLVED, NO PRICE IS SHOWN
 * The payload reports `model: null` and an empty `rates`, and the client falls
 * back to token counts. Substituting an arbitrary catalogue entry would print a
 * confident figure priced at some other model's rate — worse than showing none,
 * because it looks true.
 *
 * WHY THE TOP-LEVEL `apply` IS DEPENDENCY-FREE
 * `assertEntriesActivated` fails the whole boot when any top-level row does not
 * activate, so a row with a static `inject` that never resolves is a boot
 * hazard rather than a graceful degradation. This `apply` touches nothing and
 * therefore always activates; everything service-bound sits under the nested
 * `ctx.inject(...)`, which parks only that inner plugin. `llm-deepseek` uses the
 * same shape for its optional `settings`.
 *
 * THE ROUTE IS REGISTERED ON `connection.fetch`, NOT ON `webServer`
 * `/api` is owned by a PREFIX route that applies the Host/Origin fence plus
 * browser authentication, and `webServer.match` consults the exact table first.
 * A direct exact registration on an `/api/...` path therefore shadows the fence
 * and serves the payload to any caller — verified by spoofing a foreign Host
 * and a cross-site marker. This registry lives inside the fenced handler, so
 * the checks run before this body does.
 *
 * RATES ARE PUBLIC; THE KEY IS NOT
 * `/models` needs no credential. `/key` and `/credits` do, so those two figures
 * are read host-side and only their numbers cross to the browser.
 *
 * @module dsh-session-cost-routerai
 */

/** Catalogue cache lifetime; RouterAI rates change, but not second by second. */
const RATES_TTL_MS = 10 * 60 * 1000
/** Key/credits cache lifetime — a shorter window keeps the figures live. */
const KEY_TTL_MS = 60 * 1000

const DEFAULT_BASE = 'https://routerai.ru/api/v1'
const DEFAULT_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Route path; unique among the composed routes (checked against /api/file, /plugins). */
export const ROUTE_PATH = '/api/session-cost'

/** Coerce one catalogue number, treating anything unusable as zero. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Read the public catalogue and reduce it to a id -> tariff table. Every entry
 * carrying a `pricing` object is kept, so any route a session might bill
 * against is resolvable rather than only a hardcoded pair.
 * @param baseURL - RouterAI API root.
 * @param signal - abort signal from the request.
 * @returns the rate table, or undefined when the catalogue is unusable.
 */
async function fetchRates(baseURL, signal) {
  const response = await fetch(`${baseURL}/models`, { signal })
  if (!response.ok) throw new Error(`catalogue HTTP ${String(response.status)}`)
  const body = await response.json()
  const list = body === null || typeof body !== 'object' ? undefined : body.data
  if (!Array.isArray(list)) throw new Error('catalogue payload had no data array')
  const table = {}
  for (const model of list) {
    if (model === null || typeof model !== 'object') continue
    if (typeof model.id !== 'string' || model.id.length === 0) continue
    const pricing = model.pricing
    if (pricing === null || typeof pricing !== 'object') continue
    const rate = {
      input: num(pricing.prompt),
      output: num(pricing.completion),
      cacheRead: num(pricing.input_cache_read),
    }
    // A tariff with no input and no output price is not a usable route.
    if (rate.input === 0 && rate.output === 0) continue
    table[model.id] = rate
  }
  return table
}

/**
 * Read the key's own spend and the account balance. Both need the bearer token,
 * so neither value can be fetched from the browser.
 * @param baseURL - RouterAI API root.
 * @param apiKey - resolved bearer token.
 * @param signal - abort signal from the request.
 * @returns whatever could be read; missing fields stay null.
 */
async function fetchKeyFigures(baseURL, apiKey, signal) {
  const headers = { authorization: `Bearer ${apiKey}` }
  const result = { keyUsageRub: null, creditsRub: null }
  try {
    const response = await fetch(`${baseURL}/key`, { headers, signal })
    if (response.ok) {
      const body = await response.json()
      const usage = body?.data?.usage
      if (typeof usage === 'number' && Number.isFinite(usage)) result.keyUsageRub = usage
    }
  } catch {
    // Key spend stays unknown; the client renders a dash.
  }
  try {
    const response = await fetch(`${baseURL}/credits`, { headers, signal })
    if (response.ok) {
      const body = await response.json()
      const credits = body?.data?.credits
      if (typeof credits === 'number' && Number.isFinite(credits)) result.creditsRub = credits
    }
  } catch {
    // Balance stays unknown; the client renders a dash.
  }
  return result
}

/**
 * Pull the routed model id out of a `request/context` event, if that is what
 * it is. Kept narrow on purpose: these events are live-ish session data, and
 * only two scalar leaves are read.
 * @param event - one session event.
 * @returns the model id, or undefined.
 */
function modelOfContextEvent(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.type !== 'request/context') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  return typeof data.model === 'string' && data.model.length > 0 ? data.model : undefined
}

/**
 * Resolve the model one session bills against.
 *
 * A live session answers from its folded context. A cold session has to be read
 * back through `sessionQuery`, whose snapshot exposes the raw log — the last
 * `request/context` in it is the model in force. Everything here is best-effort:
 * an unresolvable model is reported as null so the client can show tokens
 * without inventing a rouble figure.
 *
 * @param ctx - host context.
 * @param sessionId - the session to inspect, when the caller named one.
 * @param configured - the row's `model` override, or null.
 * @returns the model id, or null when it cannot be determined.
 */
async function resolveModel(ctx, sessionId, configured) {
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const sessions = ctx.get('sessions')
    if (sessions !== undefined) {
      try {
        const live = sessions.get(sessionId)
        if (live !== undefined) {
          const context = live.requestContext()
          if (context !== null && typeof context === 'object' && typeof context.model === 'string') {
            return context.model
          }
        }
      } catch {
        // Fall through to the other readers.
      }
    }

    const query = ctx.get('sessionQuery')
    if (query !== undefined) {
      try {
        const snapshot = await query.load(sessionId)
        const events = snapshot === null || typeof snapshot !== 'object' ? undefined : snapshot.events
        if (Array.isArray(events)) {
          for (let index = events.length - 1; index >= 0; index -= 1) {
            const model = modelOfContextEvent(events[index])
            if (model !== undefined) return model
          }
        }
      } catch {
        // The session may be gone; the override or catalogue takes over.
      }
    }
  }
  // The configured override wins only once the session itself cannot answer:
  // the session's own route is the truth about what is being billed.
  if (typeof configured === 'string' && configured.length > 0) return configured
  return null
}

/**
 * Build one JSON Fetch response.
 * @param status - HTTP status.
 * @param value - JSON-serialisable body.
 * @returns the response handed back to the connection bridge.
 */
function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Host plugin body. Deliberately dependency-free so this row always activates;
 * the carrier-bound work is nested.
 * @param ctx - host context.
 * @param config - the composition row's config.
 */
export function apply(ctx, config = {}) {
  const baseURL = typeof config.baseURL === 'string' && config.baseURL.length > 0
    ? config.baseURL.replace(/\/+$/u, '')
    : DEFAULT_BASE
  const keyEnv = typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0
    ? config.apiKeyEnv
    : DEFAULT_KEY_ENV
  const configuredModel = typeof config.model === 'string' && config.model.length > 0
    ? config.model
    : null

  /** Catalogue cache: rates move slowly and the payload is large. */
  let ratesCache = null
  let ratesInflight = null
  /** Key figures cache: cheaper to fetch, so a shorter window. */
  let keyCache = null

  async function loadRates(signal) {
    const now = Date.now()
    if (ratesCache !== null && now - ratesCache.at < RATES_TTL_MS) return ratesCache
    if (ratesInflight === null) {
      ratesInflight = fetchRates(baseURL, signal).then(
        (table) => {
          ratesCache = { at: Date.now(), table }
          ratesInflight = null
          return ratesCache
        },
        (error) => {
          ratesInflight = null
          throw error
        },
      )
    }
    return ratesInflight
  }

  /**
   * Read the figures for one request. Kept separate from the registration so
   * the route body stays a thin wrapper.
   * @param sessionId - the session the caller is displaying, when named.
   * @param signal - abort signal for the whole read.
   * @returns the payload the browser receives.
   */
  async function readFigures(sessionId, signal) {
    let table = null
    let ratesReason = null
    try {
      const cached = await loadRates(signal)
      table = cached.table
    } catch (error) {
      ratesReason = error instanceof Error ? error.message : String(error)
    }

    let model = await resolveModel(ctx, sessionId, configuredModel)

    // No guessing at a route. An unresolved model yields no tariff, and the
    // client then shows token counts without a rouble figure. Substituting an
    // arbitrary catalogue entry here would print a confident number priced at
    // some other model's rate — worse than showing none, because it looks true.
    const rates = {}
    if (model !== null && table !== null && Object.hasOwn(table, model)) {
      rates[model] = table[model]
    }

    let keyFigures = { keyUsageRub: null, creditsRub: null }
    const now = Date.now()
    if (keyCache !== null && now - keyCache.at < KEY_TTL_MS) {
      keyFigures = keyCache.value
    } else {
      let apiKey = typeof config.apiKey === 'string' && config.apiKey.length > 0 ? config.apiKey : undefined
      if (apiKey === undefined) {
        const credentials = ctx.get('credentials')
        if (credentials !== undefined) {
          try {
            const hit = await credentials.resolve(keyEnv)
            if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
              apiKey = hit.value
            }
          } catch {
            // Credentials unavailable: leave both figures null.
          }
        }
      }
      if (apiKey !== undefined) {
        try {
          keyFigures = await fetchKeyFigures(baseURL, apiKey, signal)
          keyCache = { at: Date.now(), value: keyFigures }
        } catch {
          // Leave both figures null rather than caching a transport failure.
        }
      }
    }

    return {
      ok: table !== null,
      reason: ratesReason,
      model,
      rates,
      keyUsageRub: keyFigures.keyUsageRub,
      creditsRub: keyFigures.creditsRub,
      fetchedAt: ratesCache === null ? null : ratesCache.at,
    }
  }

  // Nested: parks only this inner plugin when `connection` is absent, leaving
  // the top-level row active and the boot audit satisfied.
  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(
      () =>
        connCtx.connection.fetch.register({
          path: ROUTE_PATH,
          methods: ['GET', 'HEAD'],
          requestBody: 'buffered',
          fetch: async (request) => {
            // One abort signal for the whole read, so a dropped request stops it.
            const controller = new AbortController()
            const onAbort = () => controller.abort()
            request.signal?.addEventListener('abort', onAbort)
            try {
              const url = new URL(request.url, 'http://localhost')
              const sessionId = url.searchParams.get('sessionId')
              const payload = await readFigures(sessionId, controller.signal)
              if (request.method === 'HEAD') {
                const head = jsonResponse(200, payload)
                await head.body?.cancel()
                return new Response(null, { status: 200, headers: head.headers })
              }
              return jsonResponse(200, payload)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              return jsonResponse(500, { ok: false, reason: message, model: null, rates: {} })
            } finally {
              request.signal?.removeEventListener('abort', onAbort)
            }
          },
        }),
      'session-cost: figures route',
    )
  })
}
