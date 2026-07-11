// PROTOTYPE — pure state model for the pi-fff orchestration probe.

export const scopes = ["user", "project"];

export function initialState() {
	return {
		question: "Can one filtered pi-fff install supply execution while tidy owns presentation?",
		status: "idle",
		lastAction: "none",
		scopes: Object.fromEntries(scopes.map((scope) => [scope, { status: "not run", result: null }])),
	};
}

export function reduce(state, action) {
	switch (action.type) {
		case "run_started":
			return {
				...state,
				status: "running",
				lastAction: `run ${action.scope}`,
				scopes: { ...state.scopes, [action.scope]: { status: "running", result: null } },
			};
		case "run_finished": {
			const scopesState = {
				...state.scopes,
				[action.scope]: { status: action.result.ok ? "pass" : "fail", result: action.result },
			};
			const statuses = Object.values(scopesState).map((entry) => entry.status);
			const status = statuses.includes("running")
				? "running"
				: statuses.includes("fail")
					? "failed"
					: statuses.every((scopeStatus) => scopeStatus === "pass")
						? "proved"
						: "partial — run the remaining scope";
			return {
				...state,
				status,
				lastAction: `${action.scope} ${action.result.ok ? "passed" : "failed"}`,
				scopes: scopesState,
			};
		}
		case "reset":
			return initialState();
		default:
			return state;
	}
}
