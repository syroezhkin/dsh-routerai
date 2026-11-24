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
 * - Billed roubles: this package's own host route, which sums RouterAI's
 *   `total_cost` per generation. The session id travels as a query parameter so
 *   the host answers for the right session; no key and no catalogue ever cross
 *   to the browser.
 *
 * THE FIGURE IS A BILL, NOT AN ESTIMATE
 * The host prices nothing: it adds up what RouterAI charged. So the pill shows
 * the sum without a `≈`, and it falls back to plain token counts while no
 * generation has been priced yet (a fresh session, or one that started before
 * the plugin). It never mixes the two: a rouble figure on screen always means
 * "this is what the provider billed".
 *
 * REFRESH IS DRIVEN BY THE CONVERSATION
 * A price exists only after a generation settles, so the route's answer trails
 * the last request by a moment. The store therefore re-reads when the token
 * projection moves (throttled) and on a slow timer, keeping the last snapshot
 * on screen in between — a refresh never blanks the pill.
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
		/** Roubles with kopecks: the figure is a bill, so two decimals are real. */
		const RUB = new Intl.NumberFormat("ru-RU", {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		});
		/** Clock time for "с 23:04", the start of the priced window. */
		const CLOCK = new Intl.DateTimeFormat("ru-RU", {
			hour: "2-digit",
			minute: "2-digit",
		});

		/**
		 * Format a rouble amount, or null when the value is unusable. Tiny
		 * positive bills read as "<0,01 ₽" rather than a misleading "0,00".
		 */
		function fmtRub(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return null;
			if (value > 0 && value < 0.005) return "<0,01 \u20bd";
			return RUB.format(value) + " \u20bd";
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
		 * Minimum gap between two reads of the same session. A generation is
		 * priced asynchronously, so the poll has to trail it by a moment without
		 * hammering the route on every re-render.
		 */
		const FRESH_MS = 2500;
		/** Slow timer for the key figures, which move independently of tokens. */
		const POLL_MS = 15000;

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
		 * and the old snapshot keeps rendering until the new one lands.
		 * @param sessionId - the session whose bill should be read.
		 */
		function loadFigures(sessionId) {
			if (sessionId === null || sessionId === undefined) return;
			const entry = entryFor(sessionId);
			if (entry.promise !== null) return;
			if (entry.snapshot !== null && Date.now() - entry.at < FRESH_MS) return;
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
							costRub: null,
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
		 * The pill: the session's billed total in roubles, opening a breakdown
		 * panel. Falls back to token counts while no generation is priced yet.
		 * @param props - slot props; `useProjection` reads the session projection
		 *   and `sessionId` names the session whose bill is being read.
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

			// Token movement is the cheapest signal that a generation just settled,
			// so it also drives the figure refresh; the store's window coalesces it.
			react.useEffect(() => {
				loadFigures(sessionId);
			}, [sessionId, totalTokens]);

			// Key spend and balance move on their own schedule.
			react.useEffect(() => {
				const timer = setInterval(() => loadFigures(sessionId), POLL_MS);
				return () => clearInterval(timer);
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

			const costRub = figures && typeof figures.costRub === "number" ? figures.costRub : null;
			const costText = fmtRub(costRub);
			const headline = costText === null ? fmtTokens(totalTokens) + " tok" : costText;

			const rows = [];
			const push = (key, label, value) => {
				rows.push(react.createElement("span", { className: "dsh-cost-k", key: "k" + key }, label));
				rows.push(react.createElement("span", { className: "dsh-cost-v", key: "v" + key }, value));
			};

			if (figures) {
				push("cost", "\u0421\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c \u0441\u0435\u0441\u0441\u0438\u0438", costText || "\u2014");
				if (figures.tracked) {
					const total = typeof figures.totalCalls === "number" ? figures.totalCalls : 0;
					const priced = typeof figures.pricedCalls === "number" ? figures.pricedCalls : 0;
					push("calls", "\u0412\u044b\u0437\u043e\u0432\u044b", priced + " \u0438\u0437 " + total);
				}
				if (figures.model) push("model", "\u041c\u043e\u0434\u0435\u043b\u044c", figures.model);
				if (figures.provider) push("provider", "\u041f\u0440\u043e\u0432\u0430\u0439\u0434\u0435\u0440", figures.provider);
			}

			push("tokens", "\u0422\u043e\u043a\u0435\u043d\u044b", fmtTokens(totalTokens));
			push("in", "\u0412\u0445\u043e\u0434 (\u0431\u0435\u0437 \u043a\u044d\u0448\u0430)", fmtTokens(uncached));
			push("cr", "\u0427\u0442\u0435\u043d\u0438\u0435 \u043a\u044d\u0448\u0430", fmtTokens(cacheRead));
			push("out", "\u0412\u044b\u0445\u043e\u0434", fmtTokens(output));

			if (figures) {
				push("key", "\u0420\u0430\u0441\u0445\u043e\u0434 \u043a\u043b\u044e\u0447\u0430", fmtRub(figures.keyUsageRub) || "\u2014");
				push("bal", "\u0411\u0430\u043b\u0430\u043d\u0441", fmtRub(figures.creditsRub) || "\u2014");
				if (!figures.ok) {
					rows.push(react.createElement("span", { className: "dsh-cost-note", key: "n" },
						"\u041d\u0435\u0442 \u0434\u0430\u043d\u043d\u044b\u0445: " + String(figures.reason || "\u043d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u043e")));
				} else if (costRub !== null) {
					const since = typeof figures.since === "number" && figures.since > 0
						? CLOCK.format(new Date(figures.since))
						: null;
					rows.push(react.createElement("span", { className: "dsh-cost-note", key: "note" },
						"\u0421\u0443\u043c\u043c\u0430 \u0441\u043f\u0438\u0441\u0430\u043d\u0438\u0439 RouterAI"
						+ (since === null ? "" : " \u0441 " + since)
						+ "; \u0432\u0435\u0431-\u043f\u043e\u0438\u0441\u043a \u043d\u0435 \u0443\u0447\u0442\u0451\u043d."));
				} else if (figures.tracked && figures.totalCalls > 0) {
					rows.push(react.createElement("span", { className: "dsh-cost-note", key: "note" },
						"\u0426\u0435\u043d\u0430 \u0435\u0449\u0451 \u043d\u0435 \u043f\u043e\u043b\u0443\u0447\u0435\u043d\u0430: \u0432\u044b\u0437\u043e\u0432\u044b \u043e\u0431\u0440\u0430\u0431\u0430\u0442\u044b\u0432\u0430\u044e\u0442\u0441\u044f."));
				}
				if (figures.failedCalls > 0) {
					rows.push(react.createElement("span", { className: "dsh-cost-note", key: "failed" },
						String(figures.failedCalls) + " \u0432\u044b\u0437\u043e\u0432(\u043e\u0432) \u0431\u0435\u0437 \u0446\u0435\u043d\u044b."));
				}
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
