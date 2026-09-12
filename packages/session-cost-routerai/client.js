/**
 * Session cost in roubles — browser half.
 *
 * Hand-written in the `window.__ModuleLoader__.load` shape that
 * `dsh-client-modules` serves and the vendored Cordis Loader consumes. The
 * registry key is this package's `name`, which is also the graph row id and the
 * `dsh.client` owner — all three must agree or the bundle is silently never
 * imported.
 *
 * DATA SOURCES
 * - Token counts: the `tokenUsage` session projection, owned by `dsh-token-meter`
 *   and read through the slot's `useProjection` prop. No RPC, no polling.
 * - The route's tariff, plus the key's spend and balance: this package's own host
 *   route. The session id travels as a query parameter so the host can price the
 *   model that session actually bills against. The API key never crosses here.
 *
 * CACHE IS KEYED BY SESSION
 * The tariff follows the session's own route, so two sessions can legitimately
 * show different rates. A single page-wide snapshot would price one of them
 * wrongly. Each session therefore gets its own entry and its own refresh window,
 * while the subscriber set stays shared.
 *
 * STYLES
 * Injected as one `<style data-plugin-css>` element, matching how shipped client
 * bundles carry their CSS: `ctx.styles` exists only inside the dynamic-plugin
 * runtime and is not a service on the client context.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-cost-routerai",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		//#region styles
		/** Hand-off path of this package's host route. */
		const FIGURES_PATH = "/api/session-cost";

		const CSS = [
			// Root stays inline so the pill participates in the composer's trailing
			// flex row, which already supplies align-items:center and gap:12px.
			".dsh-cost-root{position:relative;display:inline-flex;align-items:center}",
			// Trigger matches the neighbouring context ring and model selector:
			// label-secondary at rest, hover shown as a background, and a focus ring
			// drawn by box-shadow rather than the browser's default outline.
			".dsh-cost-bar{align-items:center;justify-content:center;height:28px;padding:0 8px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:999px;outline:none;font:inherit;font-size:12px;line-height:20px;font-weight:500;font-variant-numeric:tabular-nums;display:inline-flex;flex:none}",
			".dsh-cost-bar:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-cost-bar:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}",
			".dsh-cost-bar:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}",
			// Panel mirrors the context-meter popover's metrics so both agree when open.
			".dsh-cost-panel{position:absolute;bottom:calc(100% + 8px);right:0;z-index:100;box-sizing:border-box;display:grid;grid-template-columns:auto 1fr;gap:2px 12px;min-width:220px;max-width:320px;padding:12px;border:0;border-radius:12px;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;font-size:12px;line-height:20px;font-variant-numeric:tabular-nums}",
			".dsh-cost-k{color:var(--dsw-alias-label-secondary)}",
			".dsh-cost-v{text-align:right;color:var(--dsw-alias-label-primary);font-weight:500}",
			".dsh-cost-note{grid-column:1/-1;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.35;overflow-wrap:anywhere}",
		].join("\n");

		const CSS_TAG_ID = "dsh-session-cost-routerai/session-cost.css";

		/** Insert the stylesheet once, tagged so a reload cannot duplicate it. */
		function installStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-cost-routerai";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region formatting
		/**
		 * Format a rouble amount to whole roubles, or null when the value is
		 * unusable. Kopecks are deliberately dropped: the session figure is an
		 * estimate for a route whose tariff can move with the time of day, and the
		 * key/balance figures are sums no one reads to two decimals.
		 */
		function fmtRub(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return null;
			return Math.round(value) + " \u20bd";
		}

		/** Compact token count: 1.2k / 45.7M / 1.05B. */
		function fmtTokens(value) {
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0";
			if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
			if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
			if (value >= 1e3) return (value / 1e3).toFixed(1) + "k";
			return String(Math.round(value));
		}
		//#endregion

		//#region figures store
		/**
		 * How long an entry is reused before a background refresh. Matches the
		 * host's catalogue cache; a refresh never blanks the pill, because the
		 * previous snapshot stays published until the new one arrives.
		 */
		const FIGURES_TTL_MS = 10 * 60 * 1000;

		/** One entry per session id: { snapshot, at, promise }. */
		const entries = new Map();
		/** Stable accessor pairs per session id, so the hook never resubscribes. */
		const accessors = new Map();
		const listeners = new Set();

		/** Fetch or create the cache entry for one session. */
		function entryFor(sessionId) {
			let entry = entries.get(sessionId);
			if (entry === undefined) {
				entry = { snapshot: null, at: 0, promise: null };
				entries.set(sessionId, entry);
			}
			return entry;
		}

		/** Wake every subscriber; each one's getSnapshot bails out if unchanged. */
		function notify() {
			for (const listener of [...listeners]) listener();
		}

		/**
		 * Fetch one session's figures, coalescing concurrent callers onto a single
		 * request. An entry inside its window is left alone; past it a refresh runs
		 * in the background and the old snapshot keeps rendering until it lands.
		 * @param sessionId - the session whose route should be priced.
		 */
		function loadFigures(sessionId) {
			if (sessionId === null || sessionId === undefined) return;
			const entry = entryFor(sessionId);
			if (entry.promise !== null) return;
			if (entry.snapshot !== null && Date.now() - entry.at < FIGURES_TTL_MS) return;
			const url = FIGURES_PATH + "?sessionId=" + encodeURIComponent(String(sessionId));
			entry.promise = fetch(url, { headers: { accept: "application/json" } }).then(
				(response) => (response.ok ? response.json() : Promise.reject(new Error("HTTP " + String(response.status)))),
				(error) => Promise.reject(error),
			).then(
				(value) => {
					entry.promise = null;
					entry.snapshot = value;
					entry.at = Date.now();
					notify();
				},
				(error) => {
					entry.promise = null;
					// Publish the failure only when nothing is on screen yet: a failed
					// background refresh must not replace good figures with an error.
					if (entry.snapshot === null) {
						entry.snapshot = {
							ok: false,
							reason: error instanceof Error ? error.message : String(error),
							model: null,
							rates: {},
						};
						entry.at = Date.now();
						notify();
					}
				},
			);
		}

		/**
		 * Stable `useSyncExternalStore` accessor pair for one session. Memoized so
		 * an unchanged session id keeps the same subscribe/getSnapshot identity and
		 * the hook does not resubscribe on every render.
		 * @param sessionId - the session the pill is rendering for.
		 * @returns the accessor pair.
		 */
		function accessorFor(sessionId) {
			const key = sessionId === null || sessionId === undefined ? "" : String(sessionId);
			let accessor = accessors.get(key);
			if (accessor === undefined) {
				accessor = {
					subscribe: (listener) => {
						listeners.add(listener);
						return () => {
							listeners.delete(listener);
						};
					},
					getSnapshot: () => entryFor(sessionId).snapshot,
				};
				accessors.set(key, accessor);
			}
			return accessor;
		}
		//#endregion

		//#region pill
		/** Label used for both the tooltip and the accessible name. */
		const TITLE = "\u0421\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c \u0441\u0435\u0441\u0441\u0438\u0438 \u0432 \u0440\u0443\u0431\u043b\u044f\u0445";

		/**
		 * The pill: a rouble total over the session's own token counts, opening a
		 * breakdown panel. Renders token counts even before the tariff arrives.
		 * @param props - slot props; `useProjection` reads the session projection
		 *   and `sessionId` names the session whose route is being priced.
		 * @returns the pill element.
		 */
		function SessionCost(props) {
			const sessionId = props.sessionId;
			const usage = typeof props.useProjection === "function" ? props.useProjection("tokenUsage") : undefined;
			// Per-session external store, not component state: a session switch
			// remounts this component, and the figures must survive that.
			const accessor = accessorFor(sessionId);
			const figures = react.useSyncExternalStore(accessor.subscribe, accessor.getSnapshot);
			const [open, setOpen] = react.useState(false);
			const rootRef = react.useRef(null);

			const uncached = usage ? usage.uncachedInputTokens || 0 : 0;
			const cacheRead = usage ? usage.cacheReadTokens || 0 : 0;
			const cacheWrite = usage ? usage.cacheWriteTokens || 0 : 0;
			const output = usage ? usage.outputTokens || 0 : 0;
			const totalTokens = uncached + cacheRead + cacheWrite + output;

			// Idempotent: the per-session promise means one request at a time.
			react.useEffect(() => {
				loadFigures(sessionId);
			}, [sessionId]);

			// Dismiss on outside click or Escape, matching the context ring.
			react.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					if (event.target instanceof Node && rootRef.current !== null && rootRef.current.contains(event.target)) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			// Priced by the route the HOST resolved for this session. Nothing is
			// assumed about which model the deployment runs: an unresolved route
			// shows tokens and no rouble figure rather than a wrong number.
			const model = figures && figures.ok && typeof figures.model === "string" ? figures.model : null;
			const route = model !== null && figures.rates ? figures.rates[model] : undefined;
			let rub = null;
			if (route) {
				rub = uncached * route.input + cacheRead * route.cacheRead + cacheWrite * route.input + output * route.output;
			}

			const headline = rub === null ? fmtTokens(totalTokens) + " tok" : "\u2248 " + fmtRub(rub);
			const rows = [];
			const push = (key, label, value) => {
				rows.push(react.createElement("span", { className: "dsh-cost-k", key: "k" + key }, label));
				rows.push(react.createElement("span", { className: "dsh-cost-v", key: "v" + key }, value));
			};

			push("tokens", "\u0422\u043e\u043a\u0435\u043d\u044b", fmtTokens(totalTokens));
			push("in", "\u0412\u0445\u043e\u0434 (\u0431\u0435\u0437 \u043a\u044d\u0448\u0430)", fmtTokens(uncached));
			push("cr", "\u0427\u0442\u0435\u043d\u0438\u0435 \u043a\u044d\u0448\u0430", fmtTokens(cacheRead));
			push("out", "\u0412\u044b\u0445\u043e\u0434", fmtTokens(output));

			if (figures) {
				if (model !== null) push("model", "\u041c\u043e\u0434\u0435\u043b\u044c", model);
				push("key", "\u0420\u0430\u0441\u0445\u043e\u0434 \u043a\u043b\u044e\u0447\u0430", fmtRub(figures.keyUsageRub) || "\u2014");
				push("bal", "\u0411\u0430\u043b\u0430\u043d\u0441", fmtRub(figures.creditsRub) || "\u2014");
				if (!figures.ok) {
					rows.push(react.createElement("span", { className: "dsh-cost-note", key: "n" },
						"\u041a\u0443\u0440\u0441\u044b \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u044b: " + String(figures.reason || "\u043d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u043e")));
				}
			}
			if (rub !== null) {
				rows.push(react.createElement("span", { className: "dsh-cost-note", key: "note" },
					"\u041e\u0446\u0435\u043d\u043a\u0430 \u043f\u043e \u0442\u0430\u0440\u0438\u0444\u0443 \u043c\u043e\u0434\u0435\u043b\u0438 \u0441\u0435\u0441\u0441\u0438\u0438; \u0444\u0430\u043a\u0442\u0438\u0447\u0435\u0441\u043a\u0438\u0439 \u0440\u0430\u0441\u0445\u043e\u0434 \u2014 \u0432 \u00ab\u0420\u0430\u0441\u0445\u043e\u0434 \u043a\u043b\u044e\u0447\u0430\u00bb"));
			}

			return react.createElement("div", { className: "dsh-cost-root", ref: rootRef }, [
				react.createElement("button", {
					key: "bar",
					type: "button",
					className: "dsh-cost-bar",
					title: TITLE,
					"aria-label": TITLE,
					"aria-expanded": open,
					onClick: () => setOpen(!open),
				}, headline),
				open && react.createElement("div", { key: "panel", className: "dsh-cost-panel", role: "dialog" }, rows),
			]);
		}
		//#endregion

		//#region plugin
		/**
		 * Required client services. `slots` is the seat registry; without it the
		 * pill has nowhere to mount, so this is a true hard dependency.
		 */
		const inject = ["slots"];

		/**
		 * Client plugin body: install styles and occupy the composer's trailing
		 * seat beside the context ring.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			installStyles();
			// `inject` (not a bare register): the slot is declared dynamically by the
			// composer's own bar registration, so it may not exist yet.
			ctx.effect(() => ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "session-cost",
				order: 0,
			}, SessionCost)), "session-cost: composer pill");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
