window.__ModuleLoader__.load({
	id: "@hr98w/dsh-memory",
	factory: (require) => {
		var exports = { exports: {} }.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/memory-dream-approval.ts
		/** Why a user declined an action. */
		const REJECT_REASONS = [
			"wrong-merge",
			"disagree",
			"not-important",
			"already-known"
		];
		//#endregion
		//#region src/client/MemorySection.tsx
		/** Settings section for Global Memory, Workspace Memory, Session Consolidation, and preferences. */
		/** Format a Session timestamp as a compact local date and minute. */
		function formatSessionCreatedAt(createdAt) {
			const date = new Date(createdAt);
			const pad = (value) => String(value).padStart(2, "0");
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}
		/** Whether the current stable Session revision already has a successful terminal review. */
		function sessionIsConsolidated(session) {
			if (!session.eligible || session.latestReceipt?.current !== true) return false;
			return session.latestReceipt.state === "committed" || session.latestReceipt.state === "no-change";
		}
		const UNASSIGNED_SESSION_WORKSPACE = "unassigned";
		let workspaceDraftSequence = 0;
		/** Button wrapper that keeps hover/press feedback in inline styles. */
		function MemoryButton({ variant = "default", style, disabled, onPointerEnter, onPointerLeave, onPointerDown, onPointerUp, onPointerCancel, onBlur, ...props }) {
			const [hovered, setHovered] = (0, react.useState)(false);
			const [pressed, setPressed] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				...props,
				disabled,
				style: {
					...memorySectionStyles.button,
					...variant === "primary" ? memorySectionStyles.primaryButton : {},
					...variant === "danger" ? memorySectionStyles.dangerButton : {},
					...style,
					...hovered && !disabled ? memoryButtonHoverStyles[variant] : {},
					...pressed && !disabled ? memoryButtonPressedStyle : {},
					...disabled ? memoryButtonDisabledStyle : {}
				},
				onPointerEnter: (event) => {
					setHovered(true);
					onPointerEnter?.(event);
				},
				onPointerLeave: (event) => {
					setHovered(false);
					setPressed(false);
					onPointerLeave?.(event);
				},
				onPointerDown: (event) => {
					setPressed(true);
					onPointerDown?.(event);
				},
				onPointerUp: (event) => {
					setPressed(false);
					onPointerUp?.(event);
				},
				onPointerCancel: (event) => {
					setPressed(false);
					onPointerCancel?.(event);
				},
				onBlur: (event) => {
					setHovered(false);
					setPressed(false);
					onBlur?.(event);
				}
			});
		}
		function draftsFrom(records) {
			return records.map((record) => ({
				...record,
				draftId: `existing:${record.name}`,
				originalName: record.name
			}));
		}
		/** Build one deterministic delete-then-put batch from the editable Workspace draft. */
		function buildWorkspaceChanges(original, drafts) {
			const originalByName = new Map(original.map((record) => [record.name, record]));
			const retainedNames = new Set(drafts.filter((draft) => draft.originalName !== void 0 && draft.originalName === draft.name).map((draft) => draft.originalName));
			const deletes = original.filter((record) => !retainedNames.has(record.name)).map((record) => ({
				action: "delete",
				name: record.name
			})).sort((left, right) => left.action === "delete" && right.action === "delete" ? left.name.localeCompare(right.name, "en") : 0);
			const puts = drafts.filter((draft) => {
				const previous = draft.originalName === void 0 ? void 0 : originalByName.get(draft.originalName);
				return previous === void 0 || previous.name !== draft.name || previous.description !== draft.description || previous.type !== draft.type || previous.content !== draft.content;
			}).map(({ name, description, type, content }) => ({
				action: "put",
				record: {
					name,
					description,
					type,
					content
				}
			})).sort((left, right) => left.action === "put" && right.action === "put" ? left.record.name.localeCompare(right.record.name, "en") : 0);
			return [...deletes, ...puts];
		}
		/** Return the first client-side issue that prevents a valid Workspace batch. */
		function workspaceDraftIssue(drafts) {
			const names = /* @__PURE__ */ new Set();
			for (const draft of drafts) {
				if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(draft.name) || draft.name.toLowerCase() === "memory") return "name";
				if (names.has(draft.name)) return "duplicate-name";
				names.add(draft.name);
				if (draft.description.trim() === "" || /[\r\n]/u.test(draft.description)) return "description";
				if (draft.content.trim() === "") return "content";
			}
		}
		/** Group newest-first Session summaries by opaque Workspace identity, preserving an unassigned bucket. */
		function groupSessionsByWorkspace(sessions) {
			const groups = /* @__PURE__ */ new Map();
			for (const session of sessions) {
				const key = session.workspaceId ?? UNASSIGNED_SESSION_WORKSPACE;
				const current = groups.get(key);
				if (current === void 0) groups.set(key, {
					key,
					workspaceId: session.workspaceId,
					workspaceName: session.workspaceName,
					sessions: [session]
				});
				else current.sessions.push(session);
			}
			return [...groups.values()].sort((left, right) => {
				if (left.workspaceId === null) return right.workspaceId === null ? 0 : 1;
				if (right.workspaceId === null) return -1;
				const byName = left.workspaceName.localeCompare(right.workspaceName, "en");
				return byName === 0 ? left.workspaceId.localeCompare(right.workspaceId, "en") : byName;
			});
		}
		/**
		* Disclosure caret rotation. Kept as a single CSS rule so opening a Session row
		* never triggers a React re-render; the inline styles cannot express `[open]`.
		*/
		const DISCLOSURE_CSS = `details[data-memory-session] > summary > span[data-memory-caret] {
  display: inline-block;
}
details[data-memory-session][open] > summary > span[data-memory-caret] {
  transform: rotate(90deg);
}
details[data-memory-session] > summary::-webkit-details-marker {
  display: none;
}`;
		/** Inject the disclosure stylesheet once per document, idempotently. */
		function useDisclosureStyles() {
			(0, react.useEffect)(() => {
				const id = "dsh-memory-disclosure";
				if (document.getElementById(id) !== null) return;
				const element = document.createElement("style");
				element.id = id;
				element.textContent = DISCLOSURE_CSS;
				document.head.appendChild(element);
			}, []);
		}
		/**
		* One Session as a native disclosure.
		*
		* Collapsed state carries only what a user scans: title, creation time, and the
		* eligibility/consolidated badge. The full Session id, receipt state, run
		* result, and the consolidate action live in the body so a long list stays
		* compact and every row keeps the same height.
		*
		* Using `<details>` instead of React state keeps toggling free of re-renders:
		* the caret rotation is driven by a CSS attribute selector.
		*/
		function SessionRow(props) {
			const { session, t, consolidating, busy, result, onConsolidate } = props;
			const consolidated = sessionIsConsolidated(session);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
				"data-memory-session": "",
				style: memorySectionStyles.sessionCard,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
					style: memorySectionStyles.sessionSummary,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: memorySectionStyles.sessionIdentity,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
								style: memorySectionStyles.sessionTitle,
								children: session.title ?? t("sessionUntitled")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
								style: {
									...memorySectionStyles.sessionId,
									...memorySectionStyles.muted
								},
								children: t("sessionCreatedAt", { value: formatSessionCreatedAt(session.createdAt) })
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: memorySectionStyles.sessionBadges,
							children: [session.archived ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: memorySectionStyles.ineligibleBadge,
								children: t("sessionArchived")
							}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: consolidated ? memorySectionStyles.consolidatedBadge : session.eligible ? memorySectionStyles.eligibleBadge : memorySectionStyles.ineligibleBadge,
								children: consolidated ? t("sessionConsolidated") : session.eligible ? t("sessionEligible") : t(sessionReasonKey(session.reason))
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": "true",
							"data-memory-caret": "",
							style: memorySectionStyles.sessionCaret,
							children: "▸"
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: memorySectionStyles.sessionBody,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
							style: {
								...memorySectionStyles.sessionId,
								...memorySectionStyles.muted
							},
							children: session.sessionId
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: session.latestReceipt === null ? t("sessionNoReceipt") : t(session.latestReceipt.current ? "sessionReceiptCurrent" : "sessionReceiptOlder", { state: t(sessionReceiptStateKey(session.latestReceipt.state)) }) }),
						result === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: memorySectionStyles.sessionResult,
							children: result.recovered ? t("sessionConsolidationRecovered", { state: t(sessionReceiptStateKey(result.status)) }) : result.status === "committed" ? t("sessionConsolidationCommitted", { count: result.changeCount }) : result.status === "no-change" ? t("sessionConsolidationNoChange") : t("sessionConsolidationResult", { state: t(sessionReceiptStateKey(result.status)) })
						}), result.debugLoggingEnabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
							style: memorySectionStyles.debugPath,
							children: t("sessionDebugLog", {
								reviewId: result.reviewId,
								attempt: result.attempt
							})
						}) : null] }),
						session.eligible ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: memorySectionStyles.actions,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryButton, {
								variant: "primary",
								style: memorySectionStyles.primaryButton,
								disabled: busy || consolidated,
								onClick: () => {
									onConsolidate(session.sessionId);
								},
								children: consolidating ? t("sessionConsolidating") : t("sessionConsolidate")
							})
						}) : null
					]
				})]
			});
		}
		/**
		* A single collapsed row listing Sessions that cannot yield memory.
		*
		* These are Kept, not deleted: the disclosure keeps them reachable for auditing
		* while removing them from the review workflow. No consolidate action appears
		* here on purpose — a Session that produced no output has nothing to extract.
		*/
		function SuppressedSessions(props) {
			const { suppressed, t } = props;
			const total = suppressed.failedZeroOutput + suppressed.trivialAutomation;
			if (total === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
				"data-memory-suppressed": "",
				style: memorySectionStyles.sessionCard,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
					style: memorySectionStyles.sessionSummary,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: memorySectionStyles.sessionIdentity,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
							style: memorySectionStyles.sessionTitle,
							children: t("sessionSuppressedTitle", { count: total })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
							style: {
								...memorySectionStyles.sessionId,
								...memorySectionStyles.muted
							},
							children: t("sessionSuppressedHelp")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": "true",
						"data-memory-caret": "",
						style: memorySectionStyles.sessionCaret,
						children: "▸"
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: memorySectionStyles.sessionBody,
					children: suppressed.groups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-memory-suppressed-group": "",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("sessionSuppressedGroup", {
								count: group.count,
								title: group.title ?? t("sessionUntitled")
							}) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
								style: {
									...memorySectionStyles.sessionId,
									...memorySectionStyles.muted
								},
								children: t("sessionSuppressedRange", {
									first: formatSessionCreatedAt(group.firstCreatedAt),
									last: formatSessionCreatedAt(group.lastCreatedAt)
								})
							}),
							group.errorCode === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
								style: memorySectionStyles.debugPath,
								children: t("sessionSuppressedError", { code: group.errorCode })
							})
						]
					}, group.fingerprint))
				})]
			});
		}
		const REASON_KEY = {
			"wrong-merge": "dreamReason_wrong_merge",
			disagree: "dreamReason_disagree",
			"not-important": "dreamReason_not_important",
			"already-known": "dreamReason_already_known"
		};
		/**
		* Dream's staging area.
		*
		* Approval is per action, so each proposed change has its own checkbox and the
		* buttons act on what is ticked. An all-or-nothing yes would force the user to
		* accept one bad action to get the good ones, and people respond to that by
		* approving without reading.
		*
		* Nothing here applies a plan silently, and nothing deletes.
		*/
		function DreamView(props) {
			const { mode, pending, runs, onApprove, onDiscard, onRun, busy = false, t } = props;
			const [ticked, setTicked] = (0, react.useState)({});
			const [reason, setReason] = (0, react.useState)(REJECT_REASONS[0]);
			const fingerprintOf = (action) => `${action.action}\u0000${action.target}\u0000${[...action.sources ?? []].sort().join(",")}`;
			const toggle = (runId, fingerprint) => {
				setTicked((current) => {
					const held = current[runId] ?? [];
					return {
						...current,
						[runId]: held.includes(fingerprint) ? held.filter((entry) => entry !== fingerprint) : [...held, fingerprint]
					};
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				"data-memory-dream": "",
				style: memorySectionStyles.sessionCard,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("header", {
						style: memorySectionStyles.workspaceHeading,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								style: memorySectionStyles.workspaceTitle,
								children: t("dreamTitle")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: memorySectionStyles.subtitle,
								children: t("dreamHelp")
							}),
							onRun === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryButton, {
								type: "button",
								variant: "primary",
								disabled: busy,
								onClick: onRun,
								children: t("dreamRun")
							}) }),
							mode === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								style: memorySectionStyles.subtitle,
								children: [
									t("dreamMode"),
									": ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: mode }),
									mode === "manual" ? ` — ${t("dreamModeManualHelp")}` : null,
									mode === "off" ? ` — ${t("dreamModeOffHelp")}` : null
								]
							})
						] })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
						style: memorySectionStyles.workspaceTitle,
						children: t("dreamPendingTitle")
					}),
					pending.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: memorySectionStyles.subtitle,
						children: t("dreamNoPending")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						style: memorySectionStyles.list,
						children: pending.map((entry) => {
							const declined = new Set(entry.declined ?? []);
							const selected = ticked[entry.runId] ?? [];
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								"data-dream-pending": entry.runId,
								style: memorySectionStyles.sessionCard,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: memorySectionStyles.sessionSummary,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: entry.runId }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: memorySectionStyles.badge,
												children: entry.risk === "content-change" ? t("dreamRiskContent") : t("dreamRiskMetadata")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: memorySectionStyles.badge,
												children: [
													t("dreamActionsCount"),
													" ",
													entry.actions.length
												]
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
										style: memorySectionStyles.list,
										children: entry.actions.map((action, index) => {
											const fingerprint = fingerprintOf(action);
											const alreadyDeclined = declined.has(fingerprint);
											return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
												"data-dream-action": fingerprint,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														type: "checkbox",
														checked: selected.includes(fingerprint),
														disabled: busy || alreadyDeclined,
														onChange: () => {
															toggle(entry.runId, fingerprint);
														}
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: action.action }),
													" → ",
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: action.target }),
													action.sources === void 0 ? null : ` (${action.sources.join(", ")})`,
													action.rationale === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("em", { children: [" — ", action.rationale] }),
													alreadyDeclined ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														style: memorySectionStyles.badge,
														children: t("dreamAlreadyDeclined")
													}) : null
												] })
											}, `${entry.runId}-${index}`);
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryButton, {
											type: "button",
											variant: "primary",
											disabled: busy || selected.length === 0,
											onClick: () => {
												onApprove?.(entry.runId, selected);
											},
											children: t("dreamApprove")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
											value: reason,
											disabled: busy,
											onChange: (event) => {
												setReason(event.target.value);
											},
											"aria-label": t("dreamRejectReason"),
											children: REJECT_REASONS.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: entry,
												children: t(REASON_KEY[entry] ?? "dreamRejectReason")
											}, entry))
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryButton, {
											type: "button",
											disabled: busy,
											onClick: () => {
												onDiscard?.(entry.runId, reason);
											},
											children: t("dreamDiscard")
										})
									] })
								]
							}, entry.runId);
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
						style: memorySectionStyles.workspaceTitle,
						children: t("dreamHistoryTitle")
					}),
					runs.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: memorySectionStyles.subtitle,
						children: t("dreamNoRuns")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						style: memorySectionStyles.list,
						children: runs.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							"data-dream-run": entry.runId,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: entry.runId }),
								" — ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: entry.state }),
								" · ",
								entry.risk === "content-change" ? t("dreamRiskContent") : t("dreamRiskMetadata"),
								" · ",
								t("dreamActionsCount"),
								" ",
								entry.changes.length,
								entry.error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: memorySectionStyles.validation,
									children: entry.error
								})
							]
						}, entry.runId))
					})
				]
			});
		}
		/**
		* What forgetting would do, shown before it does anything.
		*
		* The report is descriptive only. There is deliberately no action here that
		* removes a record: hiding is reversible and shown as such, while physical
		* deletion is a separate act requiring the user to ask for it in so many words.
		*/
		function ForgettingReportView(props) {
			const { report, t } = props;
			const shadow = report.mode === "shadow";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				"data-memory-forgetting": "",
				style: memorySectionStyles.sessionCard,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						style: memorySectionStyles.workspaceHeading,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("forgettingTitle") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: memorySectionStyles.subtitle,
							children: t("forgettingHelp")
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: memorySectionStyles.muted,
							children: t("forgettingMode", { mode: report.mode })
						})]
					}),
					shadow ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: memorySectionStyles.muted,
						children: t("forgettingShadowNote")
					}) : null,
					report.protectedCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: {
							...memorySectionStyles.muted,
							...memorySectionStyles.sessionId
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("forgettingProtected", { count: report.protectedCount }) }),
							" — ",
							t("forgettingProtectedHelp")
						]
					}) : null,
					report.changes.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: memorySectionStyles.muted,
						children: t("forgettingEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: memorySectionStyles.sessionList,
						children: report.changes.map((change) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							"data-memory-forgetting-change": "",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("forgettingChange", {
								name: change.name,
								from: change.from,
								to: change.to
							}) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
								style: {
									...memorySectionStyles.sessionId,
									...memorySectionStyles.muted
								},
								children: t("forgettingReason", { reason: change.reason })
							})]
						}, change.name))
					})
				]
			});
		}
		/** Render status plus Global, Workspaces, and Sessions tabs. */
		function MemorySection(props) {
			const { t } = props;
			const [tab, setTab] = (0, react.useState)("global");
			const [status, setStatus] = (0, react.useState)();
			const [global, setGlobal] = (0, react.useState)();
			const [draft, setDraft] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [workspaceBusy, setWorkspaceBusy] = (0, react.useState)(false);
			const [workspaces, setWorkspaces] = (0, react.useState)([]);
			const [selectedWorkspaceId, setSelectedWorkspaceId] = (0, react.useState)();
			const [workspace, setWorkspace] = (0, react.useState)();
			const [workspaceDrafts, setWorkspaceDrafts] = (0, react.useState)([]);
			const [sessionBusy, setSessionBusy] = (0, react.useState)(false);
			const [sessions, setSessions] = (0, react.useState)();
			const [forgetting, setForgetting] = (0, react.useState)();
			const [forgettingBusy, setForgettingBusy] = (0, react.useState)(false);
			const [dream, setDream] = (0, react.useState)();
			const [dreamBusy, setDreamBusy] = (0, react.useState)(false);
			const [selectedSessionWorkspaceKey, setSelectedSessionWorkspaceKey] = (0, react.useState)();
			const [consolidatingSessionId, setConsolidatingSessionId] = (0, react.useState)();
			const [consolidationResult, setConsolidationResult] = (0, react.useState)();
			const [modelBusy, setModelBusy] = (0, react.useState)(false);
			const [modelCatalog, setModelCatalog] = (0, react.useState)();
			const [modelProvider, setModelProvider] = (0, react.useState)("");
			const [modelName, setModelName] = (0, react.useState)("");
			const [debugEnabled, setDebugEnabled] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)();
			const workspaceChanges = workspace === void 0 ? [] : buildWorkspaceChanges(workspace.records, workspaceDrafts);
			const workspaceDirty = workspaceChanges.length > 0;
			const globalDirty = global !== void 0 && draft !== global.content;
			const draftIssue = workspaceDraftIssue(workspaceDrafts);
			useDisclosureStyles();
			const sessionWorkspaceGroups = groupSessionsByWorkspace(sessions?.sessions ?? []);
			const selectedSessionWorkspace = sessionWorkspaceGroups.find((group) => group.key === selectedSessionWorkspaceKey) ?? sessionWorkspaceGroups[0];
			const selectedModelProvider = modelCatalog?.providers.find((provider) => provider.id === modelProvider);
			const settingsDirty = modelCatalog !== void 0 && (modelProvider !== modelCatalog.selection.provider || modelName !== modelCatalog.selection.model || debugEnabled !== modelCatalog.debugEnabled);
			const tabRefreshController = (0, react.useRef)(void 0);
			const refresh = (0, react.useCallback)(async (signal) => {
				if (!props.loopback) return;
				setBusy(true);
				setError(void 0);
				try {
					const [nextStatus, nextGlobal] = await Promise.all([props.api.status(signal), props.api.readGlobal(signal)]);
					setStatus(nextStatus);
					setGlobal(nextGlobal);
					setDraft(nextGlobal.content);
				} catch (cause) {
					if (!signal?.aborted) setError({
						kind: "message",
						value: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					if (!signal?.aborted) setBusy(false);
				}
			}, [props.api, props.loopback]);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				refresh(controller.signal);
				return () => {
					controller.abort();
					tabRefreshController.current?.abort();
				};
			}, [refresh]);
			const save = async () => {
				if (global === void 0) return;
				setBusy(true);
				setError(void 0);
				try {
					if ((await props.api.replaceGlobal({
						expectedRevision: global.revision,
						content: draft
					})).status === "conflict") {
						setError({ kind: "global-conflict" });
						return;
					}
					await refresh();
				} catch (cause) {
					setError({
						kind: "message",
						value: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					setBusy(false);
				}
			};
			const readWorkspace = async (workspaceId, signal) => {
				setSelectedWorkspaceId(workspaceId);
				setWorkspace(void 0);
				setWorkspaceBusy(true);
				setError(void 0);
				try {
					const next = await props.api.readWorkspace(workspaceId, signal);
					setWorkspace(next);
					setWorkspaceDrafts(draftsFrom(next.records));
				} catch (cause) {
					if (!signal?.aborted) setError({
						kind: "message",
						value: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					if (!signal?.aborted) setWorkspaceBusy(false);
				}
			};
			const refreshWorkspaces = async (signal) => {
				setWorkspaceBusy(true);
				setError(void 0);
				try {
					const result = await props.api.listWorkspaces(signal);
					setWorkspaces(result.workspaces);
					const target = result.workspaces.find((entry) => entry.workspaceId === selectedWorkspaceId) ?? result.workspaces[0];
					if (target === void 0) {
						setSelectedWorkspaceId(void 0);
						setWorkspace(void 0);
						setWorkspaceDrafts([]);
					} else {
						setSelectedWorkspaceId(target.workspaceId);
						setWorkspace(void 0);
						setWorkspaceDrafts([]);
						const next = await props.api.readWorkspace(target.workspaceId, signal);
						setWorkspace(next);
						setWorkspaceDrafts(draftsFrom(next.records));
					}
				} catch (cause) {
					if (!signal?.aborted) setError({
						kind: "message",
						value: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					if (!signal?.aborted) setWorkspaceBusy(false);
				}
			};
			const refreshSessions = async (signal) => {
				setSessionBusy(true);
				setError(void 0);
				try {
					const next = await props.api.listSessions(signal);
					const groups = groupSessionsByWorkspace(next.sessions);
					setSessions(next);
					setSelectedSessionWorkspaceKey((current) => groups.some((group) => group.key === current) ? current : groups[0]?.key);
				} catch (cause) {
					if (!signal?.aborted) setError({
						kind: "message",
						value: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					if (!signal?.aborted) setSessionBusy(false);
				}
			};
			const refreshForgetting = async (signal) => {
				setForgettingBusy(true);
				setError(void 0);
				try {
					setForgetting(await props.api.forgettingReport(signal));
				} catch (cause) {
					if (!signal?.aborted) setError({
						kind: "message",
						value: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					if (!signal?.aborted) setForgettingBusy(false);
				}
			};
			const refreshDream = async (signal) => {
				setDreamBusy(true);
				setError(void 0);
				try {
					setDream(await props.api.dreamReport(signal));
				} catch (cause) {
					if (!signal?.aborted) setError({
						kind: "message",
						value: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					if (!signal?.aborted) setDreamBusy(false);
				}
			};
			/**
			* Send the ticked actions for one run.
			*
			* An empty selection is a full rejection and writes nothing, which is why it
			* needs a reason: the reason is what stops the next run from re-proposing it.
			*/
			/**
			* Run one planning pass.
			*
			* It writes nothing: the plan is staged and appears in the pending list for a
			* per-action decision. A failure surfaces in the error banner rather than
			* being reported as a successful no-op.
			*/
			const runDream = async () => {
				setDreamBusy(true);
				setError(void 0);
				try {
					await props.api.dreamRun();
					setDream(await props.api.dreamReport());
				} catch (cause) {
					setError({
						kind: "message",
						value: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					setDreamBusy(false);
				}
			};
			const decideDream = async (runId, approved, reason) => {
				setDreamBusy(true);
				setError(void 0);
				try {
					if (approved.length === 0) await props.api.dreamReject(runId, reason);
					else await props.api.dreamApprove(runId, approved);
					setDream(await props.api.dreamReport());
				} catch (cause) {
					setError({
						kind: "message",
						value: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					setDreamBusy(false);
				}
			};
			const consolidateSession = async (sessionId) => {
				setConsolidatingSessionId(sessionId);
				setConsolidationResult(void 0);
				setError(void 0);
				try {
					const result = await props.api.consolidateSession(sessionId);
					setConsolidationResult({
						sessionId,
						result
					});
					await refreshSessions();
				} catch (cause) {
					setError({
						kind: "message",
						value: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					setConsolidatingSessionId(void 0);
				}
			};
			const refreshModels = async (signal) => {
				setModelBusy(true);
				setError(void 0);
				try {
					const catalog = await props.api.readModels(signal);
					setModelCatalog(catalog);
					setModelProvider(catalog.selection.provider);
					setModelName(catalog.selection.model);
					setDebugEnabled(catalog.debugEnabled);
				} catch (cause) {
					if (!signal?.aborted) setError({
						kind: "message",
						value: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					if (!signal?.aborted) setModelBusy(false);
				}
			};
			const saveSettings = async () => {
				if (modelCatalog === void 0 || modelProvider === "" || modelName === "") return;
				setModelBusy(true);
				setError(void 0);
				try {
					if ((await props.api.selectModel({
						expectedRevision: modelCatalog.revision,
						provider: modelProvider,
						model: modelName,
						debugEnabled
					})).status === "conflict") {
						setError({ kind: "settings-conflict" });
						return;
					}
					await refreshModels();
				} catch (cause) {
					setError({
						kind: "message",
						value: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					setModelBusy(false);
				}
			};
			const changeTab = (next) => {
				setTab(next);
				setError(void 0);
				tabRefreshController.current?.abort();
				const controller = new AbortController();
				tabRefreshController.current = controller;
				const signal = controller.signal;
				if (next === "workspaces" && workspaces.length === 0) refreshWorkspaces(signal);
				if (next === "sessions" && sessions === void 0) refreshSessions(signal);
				if (next === "forgetting" && forgetting === void 0) refreshForgetting(signal);
				if (next === "dream" && dream === void 0) refreshDream(signal);
				if (next === "settings" && modelCatalog === void 0) refreshModels(signal);
			};
			const refreshVisible = async () => {
				await refresh();
				if (tab === "workspaces") await refreshWorkspaces();
				if (tab === "sessions") await refreshSessions();
				if (tab === "forgetting") await refreshForgetting();
				if (tab === "dream") await refreshDream();
				if (tab === "settings") await refreshModels();
			};
			const updateWorkspaceDraft = (draftId, update) => {
				setWorkspaceDrafts((current) => current.map((record) => record.draftId === draftId ? {
					...record,
					...update
				} : record));
			};
			const addWorkspaceRecord = () => {
				const names = new Set(workspaceDrafts.map((record) => record.name));
				let suffix = 1;
				let name = "new-memory";
				while (names.has(name)) {
					suffix += 1;
					name = `new-memory-${suffix}`;
				}
				workspaceDraftSequence += 1;
				setWorkspaceDrafts((current) => [...current, {
					draftId: `new:${workspaceDraftSequence}`,
					name,
					description: "",
					type: "project",
					content: ""
				}]);
			};
			const discardWorkspaceChanges = () => {
				if (workspace === void 0) return;
				setWorkspaceDrafts(draftsFrom(workspace.records));
				setError(void 0);
			};
			const saveWorkspace = async () => {
				if (workspace === void 0 || workspaceChanges.length === 0 || draftIssue !== void 0) return;
				setWorkspaceBusy(true);
				setError(void 0);
				try {
					if ((await props.api.commitWorkspace({
						workspaceId: workspace.workspaceId,
						expectedRevision: workspace.revision,
						changes: workspaceChanges
					})).status === "conflict") {
						setError({ kind: "workspace-conflict" });
						return;
					}
					await refreshWorkspaces();
				} catch (cause) {
					setError({
						kind: "message",
						value: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					setWorkspaceBusy(false);
				}
			};
			if (!props.loopback) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: memorySectionStyles.page,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: t("title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("loopbackOnly") })]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: memorySectionStyles.page,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						style: memorySectionStyles.header,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: memorySectionStyles.heading,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								style: memorySectionStyles.title,
								children: t("title")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: memorySectionStyles.subtitle,
								children: t("subtitle")
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryButton, {
							type: "button",
							style: memorySectionStyles.button,
							disabled: busy || workspaceBusy || sessionBusy || modelBusy || tab === "workspaces" && workspaceDirty || tab === "global" && globalDirty,
							onClick: () => {
								refreshVisible();
							},
							children: t("refresh")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: memorySectionStyles.status,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("status") }),
								" ",
								status === void 0 ? t("loading") : t("enabled")
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("global") }),
								" ",
								t("bytes", { count: status?.globalBytes ?? 0 })
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("workspaces") }),
								" ",
								status?.workspaceCount ?? 0
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: memorySectionStyles.path,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("root") }),
									" ",
									status?.root ?? "—"
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("nav", {
						style: memorySectionStyles.tabs,
						"aria-label": t("sections"),
						children: [
							"global",
							"workspaces",
							"sessions",
							"forgetting",
							"dream",
							"settings"
						].map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryButton, {
							type: "button",
							variant: "tab",
							style: {
								...memorySectionStyles.tab,
								...tab === id ? memorySectionStyles.activeTab : {}
							},
							onClick: () => {
								changeTab(id);
							},
							children: t(`${id}Tab`)
						}, id))
					}),
					error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						style: memorySectionStyles.error,
						children: error.kind === "global-conflict" ? t("conflict") : error.kind === "workspace-conflict" ? t("workspaceConflict") : error.kind === "settings-conflict" ? t("settingsConflict") : error.value
					}),
					tab === "global" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: memorySectionStyles.panel,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: memorySectionStyles.subtitle,
								children: t("globalHelp")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								htmlFor: "dsh-memory-global",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "GLOBAL.md" })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								id: "dsh-memory-global",
								style: memorySectionStyles.editor,
								spellCheck: false,
								value: draft,
								onChange: (event) => {
									setDraft(event.target.value);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: memorySectionStyles.actions,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryButton, {
									variant: "primary",
									type: "button",
									style: memorySectionStyles.primaryButton,
									disabled: busy || global === void 0,
									onClick: () => {
										save();
									},
									children: t("saveGlobal")
								})
							})
						]
					}) : tab === "workspaces" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: memorySectionStyles.panel,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: memorySectionStyles.subtitle,
							children: t("workspaceHelp")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: memorySectionStyles.workspaceLayout,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
								style: memorySectionStyles.workspaceList,
								"aria-label": t("workspaceList"),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("workspaceList") }),
									workspaceBusy && workspaces.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("loading") }) : null,
									!workspaceBusy && workspaces.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										style: memorySectionStyles.muted,
										children: t("workspaceEmpty")
									}) : null,
									workspaces.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(MemoryButton, {
										type: "button",
										variant: "workspace",
										style: {
											...memorySectionStyles.workspaceButton,
											...selectedWorkspaceId === entry.workspaceId ? memorySectionStyles.activeWorkspaceButton : {}
										},
										disabled: workspaceBusy || workspaceDirty,
										onClick: () => {
											readWorkspace(entry.workspaceId);
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: entry.displayName }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
											style: memorySectionStyles.muted,
											children: t("recordCount", { count: entry.recordCount })
										})]
									}, entry.workspaceId))
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: memorySectionStyles.workspaceDetail,
								children: workspace === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
										style: memorySectionStyles.workspaceHeading,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
											style: memorySectionStyles.workspaceTitle,
											children: workspace.displayName
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: memorySectionStyles.muted,
											children: t("recordCount", { count: workspaceDrafts.length })
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("workspaceIndex") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
										style: memorySectionStyles.workspaceIndex,
										children: workspace.index
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
											style: memorySectionStyles.recordSectionHeading,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
												style: memorySectionStyles.recordSectionTitle,
												children: t("workspaceRecords")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryButton, {
												type: "button",
												style: memorySectionStyles.button,
												disabled: workspaceBusy,
												onClick: addWorkspaceRecord,
												children: t("addRecord")
											})]
										}),
										draftIssue === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											role: "alert",
											style: memorySectionStyles.validation,
											children: t(draftIssue === "name" ? "workspaceInvalidName" : draftIssue === "duplicate-name" ? "workspaceDuplicateName" : draftIssue === "description" ? "workspaceInvalidDescription" : "workspaceInvalidContent")
										}),
										workspaceDrafts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: memorySectionStyles.muted,
											children: t("workspaceNoRecords")
										}) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: memorySectionStyles.recordList,
											children: workspaceDrafts.map((record) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
												style: memorySectionStyles.recordCard,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
														style: memorySectionStyles.recordHeading,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: record.name || t("newRecord") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryButton, {
															type: "button",
															variant: "danger",
															style: memorySectionStyles.dangerButton,
															disabled: workspaceBusy,
															onClick: () => {
																setWorkspaceDrafts((current) => current.filter((candidate) => candidate.draftId !== record.draftId));
															},
															children: t("deleteRecord")
														})]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														style: memorySectionStyles.recordFields,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
															style: memorySectionStyles.field,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("recordName") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																style: memorySectionStyles.input,
																value: record.name,
																disabled: workspaceBusy,
																onChange: (event) => {
																	updateWorkspaceDraft(record.draftId, { name: event.target.value });
																}
															})]
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
															style: memorySectionStyles.field,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("recordType") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
																style: memorySectionStyles.input,
																value: record.type,
																disabled: workspaceBusy,
																onChange: (event) => {
																	updateWorkspaceDraft(record.draftId, { type: event.target.value });
																},
																children: [
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
																		value: "feedback",
																		children: "feedback"
																	}),
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
																		value: "project",
																		children: "project"
																	}),
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
																		value: "reference",
																		children: "reference"
																	})
																]
															})]
														})]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
														style: memorySectionStyles.field,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("recordDescription") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															style: memorySectionStyles.input,
															value: record.description,
															disabled: workspaceBusy,
															onChange: (event) => {
																updateWorkspaceDraft(record.draftId, { description: event.target.value });
															}
														})]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
														style: memorySectionStyles.field,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("recordContent") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
															style: memorySectionStyles.recordEditor,
															value: record.content,
															disabled: workspaceBusy,
															spellCheck: false,
															onChange: (event) => {
																updateWorkspaceDraft(record.draftId, { content: event.target.value });
															}
														})]
													})
												]
											}, record.draftId))
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												...memorySectionStyles.actions,
												...memorySectionStyles.workspaceActions
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryButton, {
												type: "button",
												style: memorySectionStyles.button,
												disabled: workspaceBusy || !workspaceDirty,
												onClick: discardWorkspaceChanges,
												children: t("discardChanges")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryButton, {
												type: "button",
												variant: "primary",
												style: memorySectionStyles.primaryButton,
												disabled: workspaceBusy || !workspaceDirty || draftIssue !== void 0,
												onClick: () => {
													saveWorkspace();
												},
												children: t("saveWorkspace")
											})]
										})
									] })
								] })
							})]
						})]
					}) : tab === "dream" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: memorySectionStyles.panel,
						children: [dreamBusy && dream === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("loading") }) : null, dream === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DreamView, {
							mode: dream.mode,
							pending: dream.pending,
							runs: dream.runs,
							busy: dreamBusy,
							onApprove: (runId, approved) => {
								decideDream(runId, approved, "disagree");
							},
							onDiscard: (runId, reason) => {
								decideDream(runId, [], reason);
							},
							onRun: () => {
								runDream();
							},
							t
						})]
					}) : tab === "forgetting" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: memorySectionStyles.panel,
						children: [forgettingBusy && forgetting === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("loading") }) : null, forgetting === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ForgettingReportView, {
							report: forgetting,
							t
						})]
					}) : tab === "sessions" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: memorySectionStyles.sessionPanel,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
								style: memorySectionStyles.workspaceHeading,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									style: memorySectionStyles.workspaceTitle,
									children: t("sessionCandidates")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: memorySectionStyles.subtitle,
									children: t("sessionCandidateHelp")
								})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: memorySectionStyles.muted,
									children: t("sessionCount", { count: sessions?.sessions.length ?? 0 })
								})]
							}),
							sessionBusy && sessions === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("loading") }) : null,
							sessions?.available === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: memorySectionStyles.validation,
								children: t("sessionUnavailable")
							}) : null,
							sessions?.available === true && sessions.sessions.length === 0 && sessions.suppressed.failedZeroOutput + sessions.suppressed.trivialAutomation === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: memorySectionStyles.muted,
								children: t("sessionEmpty")
							}) : null,
							sessions?.available === true && sessions.sessions.length === 0 && sessions.suppressed.failedZeroOutput + sessions.suppressed.trivialAutomation > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: memorySectionStyles.sessionList,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SuppressedSessions, {
									suppressed: sessions.suppressed,
									t
								})
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: memorySectionStyles.workspaceLayout,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
									style: memorySectionStyles.workspaceList,
									"aria-label": t("sessionWorkspaceList"),
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("sessionWorkspaceList") }), sessionWorkspaceGroups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(MemoryButton, {
										type: "button",
										variant: "workspace",
										style: {
											...memorySectionStyles.workspaceButton,
											...selectedSessionWorkspace?.key === group.key ? memorySectionStyles.activeWorkspaceButton : {}
										},
										disabled: sessionBusy,
										onClick: () => {
											setSelectedSessionWorkspaceKey(group.key);
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: group.workspaceName ?? t("sessionWorkspaceUnassigned") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
											style: memorySectionStyles.muted,
											children: t("sessionCount", { count: group.sessions.length })
										})]
									}, group.key))]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: memorySectionStyles.workspaceDetail,
									children: selectedSessionWorkspace === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
										style: memorySectionStyles.workspaceHeading,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
											style: memorySectionStyles.workspaceTitle,
											children: selectedSessionWorkspace.workspaceName ?? t("sessionWorkspaceUnassigned")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: memorySectionStyles.muted,
											children: t("sessionCount", { count: selectedSessionWorkspace.sessions.length })
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: memorySectionStyles.sessionList,
										children: [sessions === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SuppressedSessions, {
											suppressed: sessions.suppressed,
											t
										}), selectedSessionWorkspace.sessions.map((session) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionRow, {
											session,
											t,
											consolidating: consolidatingSessionId === session.sessionId,
											busy: consolidatingSessionId !== void 0,
											result: consolidationResult?.sessionId === session.sessionId ? consolidationResult.result : void 0,
											onConsolidate: (sid) => {
												consolidateSession(sid);
											}
										}, session.sessionId))]
									})] })
								})]
							})
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: memorySectionStyles.modelPanel,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								style: memorySectionStyles.workspaceTitle,
								children: t("settingsTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: memorySectionStyles.subtitle,
								children: t("settingsHelp")
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								style: memorySectionStyles.settingsGroup,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									style: memorySectionStyles.workspaceTitle,
									children: t("modelSettingsTitle")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: memorySectionStyles.subtitle,
									children: t("modelSettingsHelp")
								})]
							}),
							modelBusy && modelCatalog === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("loading") }) : null,
							modelCatalog?.available === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: memorySectionStyles.validation,
								children: t("modelCatalogUnavailable")
							}) : null,
							modelCatalog?.available === true && modelCatalog.providers.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: memorySectionStyles.validation,
								children: t("modelCatalogEmpty")
							}) : null,
							modelCatalog?.failures.map((failure) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: memorySectionStyles.validation,
								children: t("modelCatalogFailure", {
									provider: failure.provider,
									message: failure.message
								})
							}, failure.provider)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: memorySectionStyles.modelFields,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: memorySectionStyles.field,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelProvider") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										style: memorySectionStyles.input,
										value: modelProvider,
										disabled: modelBusy || modelCatalog?.available !== true,
										onChange: (event) => {
											const provider = event.target.value;
											setModelProvider(provider);
											setModelName(modelCatalog?.providers.find((entry) => entry.id === provider)?.models[0]?.id ?? "");
										},
										children: [!modelCatalog?.providers.some((provider) => provider.id === modelProvider) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: modelProvider,
											children: modelProvider || "—"
										}) : null, modelCatalog?.providers.map((provider) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
											value: provider.id,
											children: [
												provider.name,
												" (",
												provider.id,
												")"
											]
										}, provider.id))]
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: memorySectionStyles.field,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelName") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										style: memorySectionStyles.input,
										value: modelName,
										disabled: modelBusy || modelCatalog?.available !== true,
										onChange: (event) => {
											setModelName(event.target.value);
										},
										children: [!selectedModelProvider?.models.some((model) => model.id === modelName) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: modelName,
											children: modelName || "—"
										}) : null, selectedModelProvider?.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
											value: model.id,
											children: [
												model.name,
												" (",
												model.id,
												")"
											]
										}, model.id))]
									})]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: memorySectionStyles.muted,
								children: t("modelCurrent", {
									provider: modelCatalog?.selection.provider ?? "—",
									model: modelCatalog?.selection.model ?? "—"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								style: memorySectionStyles.settingsGroup,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: memorySectionStyles.toggleRow,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: debugEnabled,
										disabled: modelBusy || modelCatalog === void 0,
										onChange: (event) => {
											setDebugEnabled(event.target.checked);
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("debugEnabled") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
										style: memorySectionStyles.settingHelp,
										children: t("debugHelp")
									})] })]
								}), debugEnabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: memorySectionStyles.muted,
									children: t("debugLocation")
								}) : null]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: memorySectionStyles.actions,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryButton, {
									variant: "primary",
									style: memorySectionStyles.primaryButton,
									disabled: modelBusy || !settingsDirty || modelProvider === "" || modelName === "",
									onClick: () => {
										saveSettings();
									},
									children: t("saveSettings")
								})
							})
						]
					})
				]
			});
		}
		const memorySectionStyles = {
			page: {
				display: "grid",
				gap: 16,
				padding: 24,
				color: "inherit",
				boxSizing: "border-box",
				width: "100%",
				maxWidth: "100%",
				minWidth: 0
			},
			header: {
				display: "flex",
				flexWrap: "wrap",
				justifyContent: "space-between",
				gap: 16,
				alignItems: "center",
				minWidth: 0
			},
			heading: {
				flex: "1 1 240px",
				minWidth: 0
			},
			title: {
				margin: 0,
				fontSize: 24
			},
			subtitle: {
				margin: "4px 0 0",
				opacity: .72
			},
			button: {
				padding: "8px 12px",
				borderRadius: 8,
				border: "1px solid currentColor",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				transition: "background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease"
			},
			primaryButton: {
				padding: "9px 14px",
				borderRadius: 8,
				border: 0,
				background: "#5b5bd6",
				color: "#fff",
				fontWeight: 600,
				cursor: "pointer",
				transition: "background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease"
			},
			status: {
				display: "flex",
				flexWrap: "wrap",
				gap: "8px 20px",
				padding: 14,
				borderRadius: 10,
				background: "rgba(127,127,127,0.12)",
				boxSizing: "border-box",
				width: "100%",
				maxWidth: "100%",
				minWidth: 0
			},
			path: {
				flexBasis: "100%",
				minWidth: 0,
				overflowWrap: "anywhere",
				wordBreak: "break-word"
			},
			tabs: {
				display: "flex",
				flexWrap: "wrap",
				gap: 8,
				borderBottom: "1px solid rgba(127,127,127,0.3)",
				maxWidth: "100%",
				minWidth: 0
			},
			tab: {
				padding: "9px 12px",
				border: 0,
				borderBottom: "2px solid transparent",
				borderRadius: "8px 8px 0 0",
				background: "transparent",
				color: "inherit",
				opacity: .7,
				cursor: "pointer",
				transition: "background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease"
			},
			activeTab: {
				borderBottom: "2px solid #5b5bd6",
				opacity: 1,
				fontWeight: 600
			},
			panel: {
				display: "grid",
				gap: 10,
				width: "100%",
				maxWidth: "100%",
				minWidth: 0
			},
			editor: {
				display: "block",
				minHeight: 320,
				width: "100%",
				maxWidth: "100%",
				minWidth: 0,
				boxSizing: "border-box",
				resize: "vertical",
				borderRadius: 10,
				padding: 14,
				border: "1px solid rgba(127,127,127,0.4)",
				background: "rgba(127,127,127,0.06)",
				color: "inherit",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				lineHeight: 1.5
			},
			actions: {
				display: "flex",
				flexWrap: "wrap",
				justifyContent: "flex-end",
				gap: 12,
				alignItems: "center",
				minWidth: 0
			},
			workspaceActions: { marginTop: 16 },
			error: {
				margin: 0,
				padding: 12,
				borderRadius: 8,
				background: "rgba(200,40,40,0.15)",
				color: "#d44",
				overflowWrap: "anywhere"
			},
			sessionPanel: {
				display: "grid",
				gap: 14,
				width: "100%",
				maxWidth: "100%",
				minWidth: 0
			},
			sessionList: {
				display: "grid",
				gap: 10,
				minWidth: 0
			},
			sessionCard: {
				minWidth: 0,
				border: "1px solid rgba(127,127,127,0.3)",
				borderRadius: 10
			},
			sessionSummary: {
				display: "flex",
				flexWrap: "wrap",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 8,
				padding: 14,
				minWidth: 0,
				cursor: "pointer",
				listStyle: "none"
			},
			sessionCaret: {
				flex: "0 0 auto",
				width: 18,
				textAlign: "center",
				opacity: .55,
				fontSize: 12,
				transition: "transform 140ms ease"
			},
			sessionBadges: {
				display: "flex",
				flexWrap: "wrap",
				gap: 6,
				minWidth: 0
			},
			sessionBody: {
				display: "grid",
				gap: 10,
				padding: "0 14px 14px",
				minWidth: 0
			},
			sessionIdentity: {
				display: "grid",
				gap: 3,
				minWidth: 0
			},
			sessionTitle: {
				minWidth: 0,
				overflowWrap: "anywhere"
			},
			sessionId: {
				minWidth: 0,
				overflowWrap: "anywhere"
			},
			sessionMeta: {
				display: "flex",
				flexWrap: "wrap",
				gap: "6px 18px",
				minWidth: 0,
				opacity: .72,
				fontSize: 13
			},
			eligibleBadge: {
				width: "fit-content",
				alignSelf: "flex-start",
				whiteSpace: "nowrap",
				padding: "2px 6px",
				borderRadius: 999,
				background: "rgba(91,91,214,0.14)",
				color: "#6868e8",
				lineHeight: 1.4,
				fontSize: 12,
				fontWeight: 600
			},
			consolidatedBadge: {
				width: "fit-content",
				alignSelf: "flex-start",
				whiteSpace: "nowrap",
				padding: "2px 6px",
				borderRadius: 999,
				background: "rgba(45,160,90,0.16)",
				color: "#2a9d58",
				lineHeight: 1.4,
				fontSize: 12,
				fontWeight: 600
			},
			ineligibleBadge: {
				width: "fit-content",
				alignSelf: "flex-start",
				whiteSpace: "nowrap",
				padding: "2px 6px",
				borderRadius: 999,
				background: "rgba(127,127,127,0.13)",
				color: "inherit",
				opacity: .76,
				lineHeight: 1.4,
				fontSize: 12
			},
			sessionResult: {
				margin: 0,
				padding: 10,
				borderRadius: 8,
				background: "rgba(45,160,90,0.12)",
				overflowWrap: "anywhere"
			},
			debugPath: {
				minWidth: 0,
				overflowWrap: "anywhere",
				wordBreak: "break-word"
			},
			modelPanel: {
				display: "grid",
				gap: 16,
				width: "100%",
				maxWidth: 720,
				minWidth: 0
			},
			modelFields: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))",
				gap: 12,
				minWidth: 0
			},
			settingsGroup: {
				display: "grid",
				gap: 8,
				paddingTop: 4,
				minWidth: 0
			},
			toggleRow: {
				display: "flex",
				gap: 10,
				alignItems: "flex-start",
				padding: 12,
				border: "1px solid rgba(127,127,127,0.3)",
				borderRadius: 10,
				cursor: "pointer"
			},
			settingHelp: {
				display: "block",
				marginTop: 4,
				opacity: .68,
				lineHeight: 1.45
			},
			workspaceLayout: {
				display: "flex",
				flexWrap: "wrap",
				gap: 16,
				width: "100%",
				maxWidth: "100%",
				minWidth: 0,
				alignItems: "flex-start"
			},
			workspaceList: {
				display: "grid",
				gap: 8,
				flex: "1 1 180px",
				maxWidth: "100%",
				minWidth: 0
			},
			workspaceButton: {
				display: "grid",
				gap: 4,
				width: "100%",
				minWidth: 0,
				padding: 12,
				textAlign: "left",
				border: "1px solid rgba(127,127,127,0.3)",
				borderRadius: 8,
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				transition: "background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease"
			},
			activeWorkspaceButton: {
				background: "rgba(91,91,214,0.16)",
				border: "1px solid #5b5bd6"
			},
			workspaceDetail: {
				display: "grid",
				gap: 16,
				flex: "3 1 360px",
				maxWidth: "100%",
				minWidth: 0
			},
			workspaceHeading: {
				display: "flex",
				flexWrap: "wrap",
				justifyContent: "space-between",
				alignItems: "baseline",
				gap: 8,
				minWidth: 0
			},
			workspaceTitle: {
				margin: 0,
				overflowWrap: "anywhere"
			},
			workspaceIndex: {
				margin: 0,
				padding: 12,
				maxWidth: "100%",
				minWidth: 0,
				overflowX: "auto",
				boxSizing: "border-box",
				borderRadius: 8,
				background: "rgba(127,127,127,0.08)",
				whiteSpace: "pre-wrap",
				overflowWrap: "anywhere"
			},
			recordList: {
				display: "grid",
				gap: 12,
				minWidth: 0
			},
			recordSectionHeading: {
				display: "flex",
				flexWrap: "wrap",
				justifyContent: "space-between",
				alignItems: "center",
				gap: 8,
				marginBottom: 12
			},
			recordSectionTitle: { margin: 0 },
			recordCard: {
				display: "grid",
				gap: 12,
				padding: 14,
				minWidth: 0,
				border: "1px solid rgba(127,127,127,0.3)",
				borderRadius: 10
			},
			recordHeading: {
				display: "flex",
				flexWrap: "wrap",
				justifyContent: "space-between",
				gap: 8,
				minWidth: 0
			},
			recordFields: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))",
				gap: 12,
				minWidth: 0
			},
			field: {
				display: "grid",
				gap: 6,
				minWidth: 0
			},
			input: {
				width: "100%",
				maxWidth: "100%",
				minWidth: 0,
				boxSizing: "border-box",
				padding: "8px 10px",
				border: "1px solid rgba(127,127,127,0.4)",
				borderRadius: 8,
				background: "rgba(127,127,127,0.06)",
				color: "inherit"
			},
			recordEditor: {
				display: "block",
				minHeight: 150,
				width: "100%",
				maxWidth: "100%",
				minWidth: 0,
				boxSizing: "border-box",
				resize: "vertical",
				padding: 10,
				border: "1px solid rgba(127,127,127,0.4)",
				borderRadius: 8,
				background: "rgba(127,127,127,0.06)",
				color: "inherit",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				lineHeight: 1.5
			},
			dangerButton: {
				padding: "6px 10px",
				borderRadius: 8,
				border: "1px solid #c44",
				background: "transparent",
				color: "#c44",
				cursor: "pointer",
				transition: "background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease"
			},
			validation: {
				margin: "0 0 12px",
				padding: 10,
				borderRadius: 8,
				background: "rgba(200,140,40,0.15)",
				color: "inherit"
			},
			muted: { opacity: .68 }
		};
		const memoryButtonHoverStyles = {
			default: {
				background: "rgba(127,127,127,0.13)",
				transform: "translateY(-1px)",
				boxShadow: "0 3px 10px rgba(0,0,0,0.12)"
			},
			primary: {
				filter: "brightness(1.1)",
				transform: "translateY(-1px)",
				boxShadow: "0 4px 12px rgba(91,91,214,0.3)"
			},
			danger: {
				background: "rgba(204,68,68,0.12)",
				transform: "translateY(-1px)",
				boxShadow: "0 3px 10px rgba(204,68,68,0.14)"
			},
			tab: { background: "rgba(127,127,127,0.1)" },
			workspace: {
				background: "rgba(91,91,214,0.1)",
				transform: "translateY(-1px)",
				boxShadow: "0 3px 10px rgba(0,0,0,0.1)"
			}
		};
		const memoryButtonPressedStyle = {
			transform: "translateY(0) scale(0.98)",
			boxShadow: "none"
		};
		const memoryButtonDisabledStyle = {
			cursor: "not-allowed",
			opacity: .48,
			filter: "none",
			transform: "none",
			boxShadow: "none"
		};
		function sessionReasonKey(reason) {
			switch (reason) {
				case "live": return "sessionReasonLive";
				case "missing-cwd": return "sessionReasonMissingCwd";
				case "workspace-unavailable": return "sessionReasonWorkspaceUnavailable";
				case "unstable": return "sessionReasonUnstable";
				case "subagent": return "sessionReasonSubagent";
				case "empty": return "sessionReasonEmpty";
				case "failed-zero-output": return "sessionReasonFailedZeroOutput";
			}
		}
		function sessionReceiptStateKey(state) {
			switch (state) {
				case "committing": return "sessionStateCommitting";
				case "committed": return "sessionStateCommitted";
				case "no-change": return "sessionStateNoChange";
				case "cancelled": return "sessionStateCancelled";
				case "source-changed": return "sessionStateSourceChanged";
				case "target-conflict": return "sessionStateTargetConflict";
				case "invalid-proposal": return "sessionStateInvalidProposal";
				case "output-truncated": return "sessionStateOutputTruncated";
				case "provider-failed": return "sessionStateProviderFailed";
				case "evidence-too-large": return "sessionStateEvidenceTooLarge";
				case "internal-error": return "sessionStateInternalError";
			}
		}
		//#endregion
		//#region src/consolidation-identity.ts
		/** Stable identities shared by consolidation storage, RPC, workers, and catalogs. */
		const REVIEW_ID_PATTERN = /^review-[a-f0-9]{64}$/u;
		function isConsolidationReviewId(value) {
			return typeof value === "string" && REVIEW_ID_PATTERN.test(value);
		}
		//#endregion
		//#region src/protocol.ts
		/** Browser/Host wire values for the dedicated loopback Memory RPC channel. */
		var DreamProtocolError = class extends Error {
			constructor(message) {
				super(message);
				this.name = "DreamProtocolError";
			}
		};
		/** The states a stored Dream run may report. */
		const DREAM_RUN_STATES = [
			"committed",
			"no-change",
			"rejected",
			"stale-scope",
			"output-truncated",
			"provider-failed",
			"internal-error"
		];
		const DREAM_RISKS = ["metadata-only", "content-change"];
		const DREAM_RUN_MODES = [
			"off",
			"shadow",
			"manual"
		];
		function dreamRecord(value, label) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DreamProtocolError(`${label} must be an object`);
			return value;
		}
		function dreamExactKeys(record, required, label, optional = []) {
			const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
			for (const key of required) if (!(key in record)) throw new DreamProtocolError(`${label} is missing: ${key}`);
			for (const key of Object.keys(record)) if (!allowed.has(key)) throw new DreamProtocolError(`${label} has unknown field: ${key}`);
		}
		function dreamText(value, label) {
			if (typeof value !== "string" || value === "") throw new DreamProtocolError(`${label} must be a non-empty string`);
			return value;
		}
		/**
		* A string that may be empty.
		*
		* A run that never produced a proposal has no hash, so `""` is the honest value
		* rather than a placeholder. Requiring a non-empty hash made the panel refuse to
		* render the receipts a user most needs to read — the failed ones.
		*/
		function dreamOptionalText(value, label) {
			if (typeof value !== "string") throw new DreamProtocolError(`${label} must be a string`);
			return value;
		}
		function dreamTime(value, label) {
			if (typeof value !== "number" || !Number.isFinite(value)) throw new DreamProtocolError(`${label} must be a number`);
			return value;
		}
		function parseDreamActions(value, label) {
			if (!Array.isArray(value)) throw new DreamProtocolError(`${label} must be an array`);
			return value.map((entry, index) => {
				const record = dreamRecord(entry, `${label}[${index}]`);
				dreamExactKeys(record, ["action", "target"], `${label}[${index}]`, ["sources", "rationale"]);
				const sources = record.sources;
				if (sources !== void 0 && (!Array.isArray(sources) || sources.some((item) => typeof item !== "string"))) throw new DreamProtocolError(`${label}[${index}].sources must be a list of record names`);
				return {
					action: dreamText(record.action, `${label}[${index}].action`),
					target: dreamText(record.target, `${label}[${index}].target`),
					...sources === void 0 ? {} : { sources },
					...record.rationale === void 0 ? {} : { rationale: dreamText(record.rationale, `${label}[${index}].rationale`) }
				};
			});
		}
		/** Parse a plan awaiting approval. */
		function parseDreamPlanResponse(value) {
			const record = dreamRecord(value, "dream plan");
			dreamExactKeys(record, [
				"runId",
				"scopeKey",
				"state",
				"risk",
				"proposalHash",
				"actions",
				"createdAt"
			], "dream plan", ["declined"]);
			if (record.state !== "planned") throw new DreamProtocolError("dream plan.state must be \"planned\"");
			if (!DREAM_RISKS.includes(record.risk)) throw new DreamProtocolError(`dream plan.risk must be one of: ${DREAM_RISKS.join(", ")}`);
			return {
				runId: dreamText(record.runId, "dream plan.runId"),
				scopeKey: dreamText(record.scopeKey, "dream plan.scopeKey"),
				state: "planned",
				risk: record.risk,
				proposalHash: dreamText(record.proposalHash, "dream plan.proposalHash"),
				actions: parseDreamActions(record.actions, "dream plan.actions"),
				createdAt: dreamTime(record.createdAt, "dream plan.createdAt"),
				...record.declined === void 0 ? {} : { declined: parseDeclinedFingerprints(record.declined, "dream plan.declined") }
			};
		}
		/** Fingerprints are opaque strings; anything else is a producer bug. */
		function parseDeclinedFingerprints(value, label) {
			if (!Array.isArray(value)) throw new DreamProtocolError(`${label} must be an array`);
			return value.map((entry, index) => dreamText(entry, `${label}[${index}]`));
		}
		/**
		* Parse the Dream panel payload: staged plans plus recent runs.
		*
		* Each element is validated through the single-plan and single-run parsers, so
		* a malformed entry is rejected rather than rendered half-populated.
		*/
		function parseDreamPanelResponse(value) {
			const record = dreamRecord(value, "dream panel");
			dreamExactKeys(record, [
				"mode",
				"pending",
				"runs"
			], "dream panel");
			if (!DREAM_RUN_MODES.includes(record.mode)) throw new DreamProtocolError(`dream panel.mode must be one of: ${DREAM_RUN_MODES.join(", ")}`);
			if (!Array.isArray(record.pending)) throw new DreamProtocolError("dream panel.pending must be an array");
			if (!Array.isArray(record.runs)) throw new DreamProtocolError("dream panel.runs must be an array");
			return {
				mode: record.mode,
				pending: record.pending.map((entry, index) => parseDreamPlanResponse(entry)),
				runs: record.runs.map((entry, index) => parseDreamRunResponse(entry))
			};
		}
		/** Parse a finished run. */
		function parseDreamRunResponse(value) {
			const record = dreamRecord(value, "dream run");
			dreamExactKeys(record, [
				"runId",
				"scopeKey",
				"state",
				"risk",
				"proposalHash",
				"beforeRevision",
				"afterRevision",
				"changes",
				"createdAt"
			], "dream run", ["error"]);
			if (!DREAM_RUN_STATES.includes(record.state)) throw new DreamProtocolError(`dream run.state must be one of: ${DREAM_RUN_STATES.join(", ")}`);
			if (!DREAM_RISKS.includes(record.risk)) throw new DreamProtocolError(`dream run.risk must be one of: ${DREAM_RISKS.join(", ")}`);
			return {
				runId: dreamText(record.runId, "dream run.runId"),
				scopeKey: dreamText(record.scopeKey, "dream run.scopeKey"),
				state: record.state,
				risk: record.risk,
				proposalHash: record.state === "committed" ? dreamText(record.proposalHash, "dream run.proposalHash") : dreamOptionalText(record.proposalHash, "dream run.proposalHash"),
				beforeRevision: dreamText(record.beforeRevision, "dream run.beforeRevision"),
				afterRevision: dreamText(record.afterRevision, "dream run.afterRevision"),
				changes: parseDreamActions(record.changes, "dream run.changes"),
				createdAt: dreamTime(record.createdAt, "dream run.createdAt"),
				...record.error === void 0 ? {} : { error: dreamText(record.error, "dream run.error") }
			};
		}
		/** Parse a Host status response before the Browser renders it. */
		function parseMemoryStatus(value) {
			const record = requireRecord(value, "status response");
			requireExactKeys(record, [
				"enabled",
				"root",
				"globalBytes",
				"workspaceCount"
			], "status response");
			if (record.enabled !== true) throw new TypeError("status response.enabled must be true");
			if (typeof record.root !== "string") throw new TypeError("status response.root must be a string");
			if (!isNonNegativeInteger(record.globalBytes)) throw new TypeError("status response.globalBytes must be a non-negative integer");
			if (!isNonNegativeInteger(record.workspaceCount)) throw new TypeError("status response.workspaceCount must be a non-negative integer");
			return {
				enabled: true,
				root: record.root,
				globalBytes: record.globalBytes,
				workspaceCount: record.workspaceCount
			};
		}
		/** Parse a global document response before the Browser edits it. */
		function parseGlobalMemoryView(value) {
			const record = requireRecord(value, "global response");
			requireExactKeys(record, ["content", "revision"], "global response");
			if (typeof record.content !== "string") throw new TypeError("global response.content must be a string");
			if (typeof record.revision !== "string" || !record.revision.startsWith("sha256:")) throw new TypeError("global response.revision must be a sha256 revision");
			return {
				content: record.content,
				revision: record.revision
			};
		}
		/** Parse a global replacement response before the Browser updates its revision. */
		function parseGlobalReplaceResponse(value) {
			const record = requireRecord(value, "replace response");
			if (record.status === "committed") {
				requireExactKeys(record, ["status", "revision"], "replace response");
				return {
					status: "committed",
					revision: requireRevision(record.revision, "replace response.revision")
				};
			}
			if (record.status === "conflict") {
				requireExactKeys(record, ["status", "currentRevision"], "replace response");
				return {
					status: "conflict",
					currentRevision: requireRevision(record.currentRevision, "replace response.currentRevision")
				};
			}
			throw new TypeError("replace response.status must be committed or conflict");
		}
		/** Parse the closed Workspace catalog on both sides of the Host/Browser wire. */
		function parseWorkspaceListResponse(value) {
			const record = requireRecord(value, "workspace list response");
			requireExactKeys(record, ["workspaces"], "workspace list response");
			if (!Array.isArray(record.workspaces)) throw new TypeError("workspace list response.workspaces must be an array");
			return { workspaces: record.workspaces.map((entry, index) => parseWorkspaceSummary(entry, `workspace list response.workspaces[${index}]`)) };
		}
		/** Parse one complete read-only Workspace projection on both sides of the wire. */
		function parseWorkspaceReadResponse(value) {
			const record = requireRecord(value, "workspace read response");
			requireExactKeys(record, [
				"workspaceId",
				"displayName",
				"revision",
				"recordCount",
				"index",
				"records"
			], "workspace read response");
			const summary = parseWorkspaceSummaryFields(record, "workspace read response");
			if (typeof record.index !== "string") throw new TypeError("workspace read response.index must be a string");
			if (!Array.isArray(record.records)) throw new TypeError("workspace read response.records must be an array");
			const records = record.records.map((entry, index) => parseWorkspaceRecord(entry, `workspace read response.records[${index}]`, true));
			if (records.length !== summary.recordCount) throw new TypeError("workspace read response.recordCount must match records length");
			return {
				...summary,
				index: record.index,
				records
			};
		}
		/** Parse a Workspace commit result before either side trusts its revision. */
		function parseWorkspaceCommitResponse(value) {
			const record = requireRecord(value, "workspace commit response");
			if (record.status === "committed") {
				requireExactKeys(record, ["status", "revision"], "workspace commit response");
				return {
					status: "committed",
					revision: requireRevision(record.revision, "workspace commit response.revision")
				};
			}
			if (record.status === "conflict") {
				requireExactKeys(record, ["status", "currentRevision"], "workspace commit response");
				return {
					status: "conflict",
					currentRevision: requireRevision(record.currentRevision, "workspace commit response.currentRevision")
				};
			}
			throw new TypeError("workspace commit response.status must be committed or conflict");
		}
		/** Parse the Session candidate projection on both sides of the Host/Browser wire. */
		function parseSessionListResponse(value) {
			const record = requireRecord(value, "session list response");
			requireExactKeys(record, [
				"available",
				"sessions",
				"suppressed"
			], "session list response");
			if (typeof record.available !== "boolean") throw new TypeError("session list response.available must be a boolean");
			if (!Array.isArray(record.sessions)) throw new TypeError("session list response.sessions must be an array");
			if (!record.available && record.sessions.length !== 0) throw new TypeError("session list response.sessions must be empty when unavailable");
			return {
				available: record.available,
				sessions: record.sessions.map((entry, index) => parseSessionSummary(entry, `session list response.sessions[${index}]`)),
				suppressed: parseSuppressedSummary(record.suppressed, "session list response.suppressed")
			};
		}
		/** Parse the suppressed-Session summary carried alongside the candidate list. */
		function parseSuppressedSummary(value, label) {
			const record = requireRecord(value, label);
			requireExactKeys(record, [
				"failedZeroOutput",
				"trivialAutomation",
				"groups"
			], label);
			const failedZeroOutput = nonNegativeInteger(record.failedZeroOutput, `${label}.failedZeroOutput`);
			const trivialAutomation = nonNegativeInteger(record.trivialAutomation, `${label}.trivialAutomation`);
			if (!Array.isArray(record.groups)) throw new TypeError(`${label}.groups must be an array`);
			return {
				failedZeroOutput,
				trivialAutomation,
				groups: record.groups.map((entry, index) => parseSuppressedGroup(entry, `${label}.groups[${index}]`))
			};
		}
		function parseSuppressedGroup(value, label) {
			const record = requireRecord(value, label);
			const keys = [
				"count",
				"fingerprint",
				"firstCreatedAt",
				"lastCreatedAt",
				"reason",
				"title"
			];
			const hasErrorCode = record.errorCode !== void 0;
			requireExactKeys(record, hasErrorCode ? [...keys, "errorCode"] : keys, label);
			if (typeof record.fingerprint !== "string" || !/^[a-f0-9]{16}$/u.test(record.fingerprint)) throw new TypeError(`${label}.fingerprint must be 16 lowercase hex characters`);
			if (record.title !== null && typeof record.title !== "string") throw new TypeError(`${label}.title must be a string or null`);
			const count = positiveInteger(record.count, `${label}.count`);
			const firstCreatedAt = nonNegativeInteger(record.firstCreatedAt, `${label}.firstCreatedAt`);
			const lastCreatedAt = nonNegativeInteger(record.lastCreatedAt, `${label}.lastCreatedAt`);
			if (record.reason !== "failed-zero-output" && record.reason !== "trivial-automation") throw new TypeError(`${label}.reason must be a suppressed Session reason`);
			if (hasErrorCode && typeof record.errorCode !== "string") throw new TypeError(`${label}.errorCode must be a string when present`);
			return {
				fingerprint: record.fingerprint,
				title: record.title,
				count,
				firstCreatedAt,
				lastCreatedAt,
				reason: record.reason,
				...hasErrorCode ? { errorCode: record.errorCode } : {}
			};
		}
		/** Narrow one parsed field to a non-negative safe integer. */
		function nonNegativeInteger(value, label) {
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
			return value;
		}
		/** Narrow one parsed field to a strictly positive safe integer. */
		function positiveInteger(value, label) {
			const parsed = nonNegativeInteger(value, label);
			if (parsed < 1) throw new TypeError(`${label} must be a positive safe integer`);
			return parsed;
		}
		/** Parse one terminal manual consolidation result on both sides of the wire. */
		function parseSessionConsolidateResponse(value) {
			const record = requireRecord(value, "session consolidate response");
			requireExactKeys(record, [
				"status",
				"recovered",
				"reviewId",
				"attempt",
				"changeCount",
				"debugLoggingEnabled"
			], "session consolidate response");
			if (!isTerminalReceiptState(record.status)) throw new TypeError("session consolidate response.status must be terminal");
			if (typeof record.recovered !== "boolean") throw new TypeError("session consolidate response.recovered must be a boolean");
			if (!isConsolidationReviewId(record.reviewId)) throw new TypeError("session consolidate response.reviewId must be a review id");
			if (!isNonNegativeInteger(record.attempt)) throw new TypeError("session consolidate response.attempt must be a non-negative integer");
			if (!isNonNegativeInteger(record.changeCount)) throw new TypeError("session consolidate response.changeCount must be a non-negative integer");
			if (typeof record.debugLoggingEnabled !== "boolean") throw new TypeError("session consolidate response.debugLoggingEnabled must be a boolean");
			return {
				status: record.status,
				recovered: record.recovered,
				reviewId: record.reviewId,
				attempt: record.attempt,
				changeCount: record.changeCount,
				debugLoggingEnabled: record.debugLoggingEnabled
			};
		}
		function parseConsolidationModelCatalogResponse(value) {
			const record = requireRecord(value, "model catalog response");
			requireExactKeys(record, [
				"available",
				"selection",
				"debugEnabled",
				"revision",
				"providers",
				"failures"
			], "model catalog response");
			if (typeof record.available !== "boolean") throw new TypeError("model catalog response.available must be a boolean");
			const selection = parseModelSelection(record.selection, "model catalog response.selection");
			const debugEnabled = requireBoolean(record.debugEnabled, "model catalog response.debugEnabled");
			const revision = requireRevision(record.revision, "model catalog response.revision");
			if (!Array.isArray(record.providers)) throw new TypeError("model catalog response.providers must be an array");
			if (!Array.isArray(record.failures)) throw new TypeError("model catalog response.failures must be an array");
			const providers = record.providers.map((value, index) => parseModelProvider(value, `model catalog response.providers[${index}]`));
			const failures = record.failures.map((value, index) => {
				const label = `model catalog response.failures[${index}]`;
				const failure = requireRecord(value, label);
				requireExactKeys(failure, ["provider", "message"], label);
				return {
					provider: requireNonEmptySingleLine(failure.provider, `${label}.provider`),
					message: requireNonEmptySingleLine(failure.message, `${label}.message`)
				};
			});
			if (!record.available && (providers.length !== 0 || failures.length !== 0)) throw new TypeError("unavailable model catalog must not contain providers or failures");
			return {
				available: record.available,
				selection,
				debugEnabled,
				revision,
				providers,
				failures
			};
		}
		function parseConsolidationModelSelectResponse(value) {
			const record = requireRecord(value, "model select response");
			if (record.status === "committed") {
				requireExactKeys(record, ["status", "revision"], "model select response");
				return {
					status: "committed",
					revision: requireRevision(record.revision, "model select response.revision")
				};
			}
			if (record.status === "conflict") {
				requireExactKeys(record, ["status", "currentRevision"], "model select response");
				return {
					status: "conflict",
					currentRevision: requireRevision(record.currentRevision, "model select response.currentRevision")
				};
			}
			throw new TypeError("model select response.status must be committed or conflict");
		}
		function parseSessionSummary(value, label) {
			const raw = requireRecord(value, label);
			const record = {
				...raw,
				archived: raw.archived ?? false
			};
			requireExactKeys(record, [
				"sessionId",
				"title",
				"createdAt",
				"workspaceId",
				"workspaceName",
				"eligible",
				"reason",
				"latestReceipt",
				"archived"
			], label);
			const sessionId = requireNonEmptySingleLine(record.sessionId, `${label}.sessionId`);
			const title = record.title === null ? null : requireNonEmptySingleLine(record.title, `${label}.title`);
			if (!isNonNegativeInteger(record.createdAt)) throw new TypeError(`${label}.createdAt must be a non-negative integer`);
			const workspaceId = record.workspaceId === null ? null : requireWorkspaceId(record.workspaceId, `${label}.workspaceId`);
			const workspaceName = record.workspaceName === null ? null : requireNonEmptySingleLine(record.workspaceName, `${label}.workspaceName`);
			if (workspaceId === null !== (workspaceName === null)) throw new TypeError(`${label}.workspaceId and workspaceName must both be null or both be present`);
			const latestReceipt = record.latestReceipt === null ? null : parseSessionReceiptSummary(record.latestReceipt, `${label}.latestReceipt`);
			if (typeof record.archived !== "boolean") throw new TypeError(`${label}.archived must be a boolean`);
			const base = {
				sessionId,
				title,
				createdAt: record.createdAt,
				workspaceId,
				workspaceName,
				latestReceipt,
				archived: record.archived
			};
			if (record.eligible === true) {
				if (record.reason !== null) throw new TypeError(`${label}.reason must be null when eligible`);
				return {
					...base,
					eligible: true,
					reason: null
				};
			}
			if (record.eligible !== false || !isSessionIneligibleReason(record.reason)) throw new TypeError(`${label}.reason must explain an ineligible Session`);
			return {
				...base,
				eligible: false,
				reason: record.reason
			};
		}
		function parseSessionReceiptSummary(value, label) {
			const record = requireRecord(value, label);
			requireExactKeys(record, [
				"reviewId",
				"state",
				"attempt",
				"current",
				"completedAt"
			], label);
			if (!isConsolidationReviewId(record.reviewId)) throw new TypeError(`${label}.reviewId must be a review id`);
			if (!isSessionReceiptState(record.state)) throw new TypeError(`${label}.state must be a receipt state`);
			if (!isNonNegativeInteger(record.attempt)) throw new TypeError(`${label}.attempt must be a non-negative integer`);
			if (typeof record.current !== "boolean") throw new TypeError(`${label}.current must be a boolean`);
			if (record.completedAt !== null && (typeof record.completedAt !== "string" || Number.isNaN(Date.parse(record.completedAt)))) throw new TypeError(`${label}.completedAt must be null or an ISO timestamp`);
			return {
				reviewId: record.reviewId,
				state: record.state,
				attempt: record.attempt,
				current: record.current,
				completedAt: record.completedAt
			};
		}
		function parseModelSelection(value, label) {
			const record = requireRecord(value, label);
			requireExactKeys(record, ["provider", "model"], label);
			return {
				provider: requireNonEmptySingleLine(record.provider, `${label}.provider`),
				model: requireNonEmptySingleLine(record.model, `${label}.model`)
			};
		}
		function parseModelProvider(value, label) {
			const record = requireRecord(value, label);
			requireExactKeys(record, [
				"id",
				"name",
				"models"
			], label);
			if (!Array.isArray(record.models)) throw new TypeError(`${label}.models must be an array`);
			return {
				id: requireNonEmptySingleLine(record.id, `${label}.id`),
				name: requireNonEmptySingleLine(record.name, `${label}.name`),
				models: record.models.map((entry, index) => {
					const modelLabel = `${label}.models[${index}]`;
					const model = requireRecord(entry, modelLabel);
					requireExactKeys(model, model.description === void 0 ? ["id", "name"] : [
						"id",
						"name",
						"description"
					], modelLabel);
					return {
						id: requireNonEmptySingleLine(model.id, `${modelLabel}.id`),
						name: requireNonEmptySingleLine(model.name, `${modelLabel}.name`),
						...model.description === void 0 ? {} : { description: requireNonEmptyString(model.description, `${modelLabel}.description`) }
					};
				})
			};
		}
		function parseWorkspaceSummary(value, label) {
			const record = requireRecord(value, label);
			requireExactKeys(record, [
				"workspaceId",
				"displayName",
				"revision",
				"recordCount"
			], label);
			return parseWorkspaceSummaryFields(record, label);
		}
		function parseWorkspaceSummaryFields(record, label) {
			const displayName = requireNonEmptySingleLine(record.displayName, `${label}.displayName`);
			if (!isNonNegativeInteger(record.recordCount)) throw new TypeError(`${label}.recordCount must be a non-negative integer`);
			return {
				workspaceId: requireWorkspaceId(record.workspaceId, `${label}.workspaceId`),
				displayName,
				revision: requireRevision(record.revision, `${label}.revision`),
				recordCount: record.recordCount
			};
		}
		function parseWorkspaceRecord(value, label, allowLastEvidenceTime = false) {
			const record = requireRecord(value, label);
			requireExactKeys(record, allowLastEvidenceTime && record.lastEvidenceTime !== void 0 ? [
				"name",
				"description",
				"type",
				"content",
				"lastEvidenceTime"
			] : [
				"name",
				"description",
				"type",
				"content"
			], label);
			const name = requireWorkspaceMemoryName(record.name, `${label}.name`);
			const description = requireNonEmptySingleLine(record.description, `${label}.description`);
			if (record.type !== "feedback" && record.type !== "project" && record.type !== "reference") throw new TypeError(`${label}.type must be feedback, project, or reference`);
			if (typeof record.content !== "string" || record.content.trim() === "") throw new TypeError(`${label}.content must be a non-empty string`);
			const stamp = record.lastEvidenceTime;
			return {
				name,
				description,
				type: record.type,
				content: record.content,
				...allowLastEvidenceTime && typeof stamp === "number" && Number.isFinite(stamp) ? { lastEvidenceTime: stamp } : {}
			};
		}
		function requireRecord(value, label) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
			return value;
		}
		function requireExactKeys(record, expected, label) {
			const actual = Object.keys(record).sort();
			const wanted = [...expected].sort();
			if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new TypeError(`${label} must contain exactly: ${wanted.join(", ") || "(no fields)"}`);
		}
		function requireRevision(value, label) {
			if (typeof value !== "string" || !value.startsWith("sha256:")) throw new TypeError(`${label} must be a sha256 revision`);
			return value;
		}
		function requireBoolean(value, label) {
			if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
			return value;
		}
		function requireWorkspaceId(value, label) {
			if (typeof value !== "string" || !/^workspace:[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be an opaque Workspace id`);
			return value;
		}
		function requireNonEmptySingleLine(value, label) {
			if (typeof value !== "string" || value.trim() === "" || /[\r\n]/u.test(value)) throw new TypeError(`${label} must be a non-empty single line`);
			return value;
		}
		function requireNonEmptyString(value, label) {
			if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
			return value;
		}
		const RESERVED_WORKSPACE_MEMORY_NAME = "memory";
		function requireWorkspaceMemoryName(value, label) {
			if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) throw new TypeError(`${label} must be a kebab-case Workspace memory name`);
			if (value.toLowerCase() === RESERVED_WORKSPACE_MEMORY_NAME) throw new TypeError(`${label} cannot use the reserved name "${RESERVED_WORKSPACE_MEMORY_NAME}"`);
			return value;
		}
		/** Parse the shadow forgetting report on both sides of the wire. */
		function parseForgettingReportResponse(value) {
			const record = requireRecord(value, "forgetting report response");
			requireExactKeys(record, [
				"mode",
				"changes",
				"counts",
				"protectedCount"
			], "forgetting report response");
			if (typeof record.mode !== "string") throw new TypeError("forgetting report response.mode must be a string");
			if (!Array.isArray(record.changes)) throw new TypeError("forgetting report response.changes must be an array");
			const counts = requireRecord(record.counts, "forgetting report response.counts");
			requireExactKeys(counts, [
				"cooled",
				"archived",
				"restored"
			], "forgetting report response.counts");
			return {
				mode: record.mode,
				changes: record.changes.map((entry, index) => parseForgettingChange(entry, `forgetting report response.changes[${index}]`)),
				counts: {
					cooled: nonNegativeInteger(counts.cooled, "forgetting report response.counts.cooled"),
					archived: nonNegativeInteger(counts.archived, "forgetting report response.counts.archived"),
					restored: nonNegativeInteger(counts.restored, "forgetting report response.counts.restored")
				},
				protectedCount: nonNegativeInteger(record.protectedCount, "forgetting report response.protectedCount")
			};
		}
		function parseForgettingChange(value, label) {
			const record = requireRecord(value, label);
			requireExactKeys(record, [
				"name",
				"from",
				"to",
				"importanceScore",
				"importanceClass",
				"reason"
			], label);
			for (const key of [
				"name",
				"from",
				"to",
				"importanceClass",
				"reason"
			]) if (typeof record[key] !== "string") throw new TypeError(`${label}.${key} must be a string`);
			return {
				name: record.name,
				from: record.from,
				to: record.to,
				importanceScore: nonNegativeInteger(record.importanceScore, `${label}.importanceScore`),
				importanceClass: record.importanceClass,
				reason: record.reason
			};
		}
		function isSessionIneligibleReason(value) {
			return value === "live" || value === "missing-cwd" || value === "workspace-unavailable" || value === "unstable" || value === "subagent" || value === "empty" || value === "failed-zero-output";
		}
		function isSessionReceiptState(value) {
			return value === "committing" || isTerminalReceiptState(value);
		}
		function isTerminalReceiptState(value) {
			return value === "committed" || value === "no-change" || value === "cancelled" || value === "source-changed" || value === "target-conflict" || value === "invalid-proposal" || value === "output-truncated" || value === "provider-failed" || value === "evidence-too-large" || value === "internal-error";
		}
		function isNonNegativeInteger(value) {
			return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
		}
		//#endregion
		//#region src/client/locales.ts
		/** User-facing copy for the Memory settings section. */
		const en = {
			nav: "Memory",
			title: "Memory",
			subtitle: "Local Markdown memory managed by the Host.",
			refresh: "Refresh",
			status: "Status:",
			loading: "Loading…",
			enabled: "Enabled",
			global: "Global:",
			bytes: "{count} bytes",
			workspaces: "Workspaces:",
			root: "Root:",
			sections: "Memory sections",
			globalTab: "Global Memory",
			workspacesTab: "Workspace Memory",
			sessionsTab: "Session Consolidation",
			forgettingTab: "Forgetting Review",
			dreamTab: "Dream",
			dreamTitle: "Dream",
			dreamHelp: "Dream only reorganises records that already exist: merging, superseding, marking contested, adjusting priority. It never invents facts and never deletes anything. Every change needs your approval.",
			dreamNoPending: "No proposals are waiting for approval.",
			dreamPendingTitle: "Waiting for approval",
			dreamHistoryTitle: "History",
			dreamApprove: "Approve",
			dreamDiscard: "Discard",
			dreamRiskMetadata: "Metadata only",
			dreamRiskContent: "Rewrites content",
			dreamNoRuns: "No runs yet.",
			dreamState: "State",
			dreamActionsCount: "Actions",
			settingsTab: "Settings",
			dreamAlreadyDeclined: "Declined",
			dreamRejectReason: "Reason for declining",
			dreamReason_wrong_merge: "Wrong merge",
			dreamReason_disagree: "Disagree",
			dreamReason_not_important: "Not important",
			dreamReason_already_known: "Already known",
			dreamMode: "Mode",
			dreamRun: "Run one planning pass",
			dreamModeManualHelp: "metadata-only actions may be applied directly; content changes still need approval.",
			dreamModeOffHelp: "Dream is disabled. Turn it on in Settings.",
			globalHelp: "Shared preferences and durable guidance that apply across Workspaces. This document is automatically provided to the Agent.",
			workspaceHelp: "Project-specific knowledge is stored separately for each Workspace. Select a Workspace to review or edit its memory records.",
			saveGlobal: "Save Global Memory",
			workspaceList: "Workspaces",
			workspaceEmpty: "No Workspace memory has been created yet.",
			workspaceIndex: "Generated index",
			workspaceRecords: "Memory records",
			workspaceNoRecords: "This Workspace has no memory records.",
			recordCount: "{count} records",
			addRecord: "Add record",
			newRecord: "New record",
			deleteRecord: "Delete",
			recordName: "Name",
			recordType: "Type",
			recordDescription: "Description",
			recordContent: "Markdown content",
			discardChanges: "Discard changes",
			saveWorkspace: "Save Workspace",
			workspaceConflict: "This Workspace changed since it was loaded. Your draft is preserved; discard or copy it before refreshing.",
			workspaceInvalidName: "Every name must use lowercase kebab-case.",
			workspaceDuplicateName: "Every memory record must have a unique name.",
			workspaceInvalidDescription: "Every description must be a non-empty single line.",
			workspaceInvalidContent: "Every memory record must have non-empty Markdown content.",
			sessionCandidates: "Sessions available for consolidation",
			sessionCandidateHelp: "Extract reusable knowledge from completed conversations into Global and matching Workspace memory. Running or changing Sessions cannot be consolidated.",
			sessionWorkspaceList: "Session Workspaces",
			sessionWorkspaceUnassigned: "Unassigned",
			sessionUntitled: "Untitled Session",
			sessionCount: "{count} sessions",
			sessionUnavailable: "Session persistence or the live Agent registry is unavailable in this Host profile.",
			sessionEmpty: "No persisted Sessions were found.",
			sessionEligible: "Eligible",
			sessionConsolidated: "Consolidated",
			sessionArchived: "Archived",
			sessionReasonLive: "Currently running",
			sessionReasonMissingCwd: "No Workspace cwd",
			sessionReasonWorkspaceUnavailable: "Workspace unavailable",
			sessionReasonUnstable: "Session changed during refresh",
			sessionReasonSubagent: "Subagent Session",
			sessionReasonEmpty: "Empty Session",
			sessionReasonFailedZeroOutput: "Failed with no output",
			sessionSuppressedTitle: "Omitted {count} Sessions that produced no output",
			sessionSuppressedHelp: "These Sessions ended in an error without any reply, output, or successful tool call, so there is nothing to consolidate. They stay on disk and can be reviewed here.",
			sessionSuppressedGroup: "{count} × {title}",
			sessionSuppressedRange: "{first} → {last}",
			sessionSuppressedError: "Error: {code}",
			forgettingTitle: "Forgetting review",
			forgettingHelp: "What the lifecycle policy would do to records that stopped being useful. Nothing is deleted: cooling lowers a record in the index, archiving keeps it on disk and restorable.",
			forgettingShadowNote: "Shadow mode: this report changes nothing.",
			forgettingMode: "Mode: {mode}",
			forgettingEmpty: "No records would change right now.",
			forgettingProtected: "{count} protected",
			forgettingProtectedHelp: "Records you stated yourself are never aged out automatically.",
			forgettingChange: "{name}: {from} → {to}",
			forgettingReason: "reason: {reason}",
			sessionCreatedAt: "Created {value}",
			sessionNoReceipt: "Not consolidated yet",
			sessionConsolidate: "Consolidate",
			sessionConsolidating: "Consolidating…",
			sessionReceiptCurrent: "Last consolidation: {state}",
			sessionReceiptOlder: "New messages can be consolidated (last result: {state})",
			sessionConsolidationCommitted: "Consolidation complete: applied {count} memory changes",
			sessionConsolidationNoChange: "Consolidation complete: no new long-term memory found",
			sessionConsolidationRecovered: "No need to consolidate again: {state}",
			sessionConsolidationResult: "Consolidation ended: {state}",
			sessionStateCommitting: "recovering commit",
			sessionStateCommitted: "memory updated",
			sessionStateNoChange: "no new long-term memory found",
			sessionStateCancelled: "cancelled",
			sessionStateSourceChanged: "Session changed",
			sessionStateTargetConflict: "Workspace changed",
			sessionStateInvalidProposal: "invalid proposal",
			sessionStateOutputTruncated: "output truncated by token limit",
			sessionStateProviderFailed: "model failed",
			sessionStateEvidenceTooLarge: "filtered evidence is too large",
			sessionStateInternalError: "internal error",
			sessionDebugLog: "Debug: $DSH_HOME/memory/debug/{reviewId}/attempt-{attempt}.jsonl",
			modelSettingsTitle: "Consolidation model",
			modelSettingsHelp: "Choose from the active models configured in DSH. API keys remain managed by the DSH Models page.",
			settingsTitle: "Memory settings",
			settingsHelp: "Configure how Session consolidation runs. Changes apply to new consolidation attempts.",
			modelCatalogUnavailable: "The DSH model catalog is unavailable in this Host profile.",
			modelCatalogEmpty: "No active text-capable models are available. Configure a provider on the DSH Models page first.",
			modelCatalogFailure: "Could not read {provider}: {message}",
			modelProvider: "Provider",
			modelName: "Model",
			modelCurrent: "Current selection: {provider} / {model}",
			saveSettings: "Save settings",
			settingsConflict: "Memory settings changed after this page loaded. Refresh before saving again.",
			debugEnabled: "Write detailed debug logs",
			debugHelp: "Off by default. Enable only while troubleshooting; logs contain operational details and error stacks, but not conversation or memory content.",
			debugLocation: "While enabled, detailed attempt logs are stored locally under $DSH_HOME/memory/debug/<review-id>/.",
			loopbackOnly: "This page is available only from the loopback Web host.",
			conflict: "GLOBAL.md changed since this page loaded. Refresh before saving again."
		};
		const zh = {
			nav: "记忆",
			title: "记忆",
			subtitle: "由 Host 管理的本地 Markdown 长期记忆。",
			refresh: "刷新",
			status: "状态：",
			loading: "加载中…",
			enabled: "已启用",
			global: "全局记忆：",
			bytes: "{count} 字节",
			workspaces: "工作区：",
			root: "根目录：",
			sections: "记忆分区",
			globalTab: "全局记忆",
			workspacesTab: "工作区记忆",
			sessionsTab: "会话整理",
			forgettingTab: "遗忘复核",
			dreamTab: "梦境整理",
			dreamTitle: "梦境整理",
			dreamHelp: "Dream 只整理已存在的记录：合并、取代、标记存疑、调整优先级。它不会发明事实，也不会删除任何内容。所有改动都需要你批准。",
			dreamNoPending: "当前没有待批准的提案。",
			dreamPendingTitle: "待批准",
			dreamHistoryTitle: "历史记录",
			dreamApprove: "批准",
			dreamDiscard: "放弃",
			dreamRiskMetadata: "仅改元数据",
			dreamRiskContent: "会改正文",
			dreamNoRuns: "还没有运行过。",
			dreamState: "状态",
			dreamActionsCount: "动作",
			settingsTab: "设置",
			dreamAlreadyDeclined: "已拒绝",
			dreamRejectReason: "拒绝原因",
			dreamReason_wrong_merge: "合并不当",
			dreamReason_disagree: "不同意",
			dreamReason_not_important: "不重要",
			dreamReason_already_known: "已知",
			dreamMode: "运行模式",
			dreamRun: "运行一次",
			dreamModeManualHelp: "仅改元数据的动作可直接应用；改正文的仍然需要你批准。",
			dreamModeOffHelp: "Dream 已停用，可在设置中开启。",
			globalHelp: "保存适用于所有工作区的长期偏好与通用规则，这份内容会自动提供给 Agent。",
			workspaceHelp: "每个项目的知识单独保存。选择一个工作区即可查看或编辑其中的记忆记录。",
			saveGlobal: "保存全局记忆",
			workspaceList: "工作区列表",
			workspaceEmpty: "还没有创建任何工作区记忆。",
			workspaceIndex: "派生索引",
			workspaceRecords: "记忆记录",
			workspaceNoRecords: "这个工作区还没有记忆记录。",
			recordCount: "{count} 条记录",
			addRecord: "新增记录",
			newRecord: "新记录",
			deleteRecord: "删除",
			recordName: "名称",
			recordType: "类型",
			recordDescription: "描述",
			recordContent: "Markdown 内容",
			discardChanges: "放弃修改",
			saveWorkspace: "保存工作区",
			workspaceConflict: "工作区在加载后已发生变化。当前草稿已保留；请先放弃或复制草稿，再刷新页面。",
			workspaceInvalidName: "每个名称必须使用小写 kebab-case。",
			workspaceDuplicateName: "每条记忆记录必须使用唯一名称。",
			workspaceInvalidDescription: "每条描述必须是非空单行文本。",
			workspaceInvalidContent: "每条记忆记录必须包含非空 Markdown 内容。",
			sessionCandidates: "可整理的会话",
			sessionCandidateHelp: "从已结束的对话中提取可复用信息，更新全局记忆和对应的工作区记忆。正在运行或仍在变化的会话不能整理。",
			sessionWorkspaceList: "会话工作区",
			sessionWorkspaceUnassigned: "未归属",
			sessionUntitled: "未命名会话",
			sessionCount: "{count} 个会话",
			sessionUnavailable: "当前 Host profile 未提供 Session 持久化或 live Agent registry。",
			sessionEmpty: "没有发现已持久化的会话。",
			sessionEligible: "可以整理",
			sessionConsolidated: "已整理",
			sessionArchived: "已归档",
			sessionReasonLive: "正在运行",
			sessionReasonMissingCwd: "没有工作区 cwd",
			sessionReasonWorkspaceUnavailable: "工作区不可解析",
			sessionReasonUnstable: "刷新期间会话发生变化",
			sessionReasonSubagent: "子代理会话",
			sessionReasonEmpty: "空会话",
			sessionReasonFailedZeroOutput: "调用失败且没有输出",
			sessionSuppressedTitle: "已省略 {count} 个零产出失败任务",
			sessionSuppressedHelp: "这些会话以错误结束，没有回复、没有输出、也没有成功的工具调用，因此没有可整理的内容。文件仍保留在磁盘上，可在此展开查看。",
			sessionSuppressedGroup: "{count} × {title}",
			sessionSuppressedRange: "{first} → {last}",
			sessionSuppressedError: "错误：{code}",
			forgettingTitle: "遗忘复核",
			forgettingHelp: "以下是被判定为“不再有用”的记录将要发生的变化。不会删除任何内容：冷却只是降低它在索引中的位置，归档仍然保留在磁盘上并可以恢复。",
			forgettingShadowNote: "影子模式：这份报告不会改变任何东西。",
			forgettingMode: "模式：{mode}",
			forgettingEmpty: "当前没有记录会发生变化。",
			forgettingProtected: "{count} 条受保护",
			forgettingProtectedHelp: "你自己明确说过的记录永远不会被自动淘汰。",
			forgettingChange: "{name}：{from} → {to}",
			forgettingReason: "原因：{reason}",
			sessionCreatedAt: "创建于 {value}",
			sessionNoReceipt: "尚未整理",
			sessionConsolidate: "整理会话",
			sessionConsolidating: "正在整理…",
			sessionReceiptCurrent: "上次整理：{state}",
			sessionReceiptOlder: "有新对话，可再次整理（上次：{state}）",
			sessionConsolidationCommitted: "整理完成：应用了 {count} 项记忆变更",
			sessionConsolidationNoChange: "整理完成：没有发现新的长期记忆",
			sessionConsolidationRecovered: "无需重复整理：{state}",
			sessionConsolidationResult: "整理结束：{state}",
			sessionStateCommitting: "正在恢复提交",
			sessionStateCommitted: "已更新记忆",
			sessionStateNoChange: "没有发现新的长期记忆",
			sessionStateCancelled: "已取消",
			sessionStateSourceChanged: "会话已变化",
			sessionStateTargetConflict: "工作区已变化",
			sessionStateInvalidProposal: "模型提案无效",
			sessionStateOutputTruncated: "输出被 token 上限截断",
			sessionStateProviderFailed: "模型调用失败",
			sessionStateEvidenceTooLarge: "筛选后的证据仍然过长",
			sessionStateInternalError: "内部错误",
			sessionDebugLog: "调试日志：$DSH_HOME/memory/debug/{reviewId}/attempt-{attempt}.jsonl",
			modelSettingsTitle: "记忆模型",
			modelSettingsHelp: "从 DSH 已配置并激活的模型中选择；API key 仍由 DSH 的“模型”页面管理。",
			settingsTitle: "记忆设置",
			settingsHelp: "配置会话整理的执行方式；修改会在下一次整理时生效。",
			modelCatalogUnavailable: "当前 Host profile 没有提供 DSH 模型目录。",
			modelCatalogEmpty: "没有可用的文本模型，请先到 DSH 的“模型”页面配置 Provider。",
			modelCatalogFailure: "无法读取 {provider}：{message}",
			modelProvider: "Provider",
			modelName: "模型",
			modelCurrent: "当前选择：{provider} / {model}",
			saveSettings: "保存设置",
			settingsConflict: "此页面加载后，记忆设置已发生变化，请刷新后再保存。",
			debugEnabled: "记录详细调试日志",
			debugHelp: "默认关闭，仅在排查问题时开启。日志包含运行阶段和错误堆栈，不包含会话正文或记忆正文。",
			debugLocation: "开启后，详细日志会保存在本机 $DSH_HOME/memory/debug/<review-id>/ 下。",
			loopbackOnly: "此页面只能从本机回环 Web Host 访问。",
			conflict: "此页面加载后 GLOBAL.md 已发生变化，请刷新后再保存。"
		};
		//#endregion
		//#region src/client/index.ts
		/** dsh-memory Browser Cordis entry. */
		const LOCALE_NAMESPACE = "settings.memory";
		/** Browser services required by the Settings contribution. */
		const inject = [
			"slots",
			"locale",
			"connection"
		];
		/** Register the independent Memory settings section. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, {
				zh,
				en
			}), "dsh-memory: settings dictionaries");
			const t = ctx.locale.bind(LOCALE_NAMESPACE);
			const api = createMemoryApi(ctx.connection);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "memory",
				order: 30,
				label: () => t("nav"),
				locale: LOCALE_NAMESPACE,
				inject: () => ({
					api,
					loopback: ctx.connection.isLoopback
				})
			}, MemorySection));
		}
		function createMemoryApi(connection) {
			const call = async (endpoint, payload, signal) => {
				const result = await connection.rpc.call("/memory", endpoint, payload, signal);
				if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
				return result.value;
			};
			return {
				status: async (signal) => parseMemoryStatus(await call("status", {}, signal)),
				readGlobal: async (signal) => parseGlobalMemoryView(await call("global/read", {}, signal)),
				replaceGlobal: async (input, signal) => parseGlobalReplaceResponse(await call("global/replace", input, signal)),
				listWorkspaces: async (signal) => parseWorkspaceListResponse(await call("workspaces/list", {}, signal)),
				readWorkspace: async (workspaceId, signal) => parseWorkspaceReadResponse(await call("workspace/read", { workspaceId }, signal)),
				commitWorkspace: async (input, signal) => parseWorkspaceCommitResponse(await call("workspace/commit", input, signal)),
				listSessions: async (signal) => parseSessionListResponse(await call("sessions/list", {}, signal)),
				forgettingReport: async (signal) => parseForgettingReportResponse(await call("governance/forgetting", {}, signal)),
				dreamReport: async (signal) => parseDreamPanelResponse(await call("dream/status", {}, signal)),
				dreamApprove: async (runId, approved, signal) => call("dream/proposal/approve", {
					runId,
					approved
				}, signal),
				dreamReject: async (runId, reason, signal) => call("dream/proposal/reject", {
					runId,
					reason
				}, signal),
				dreamRun: async (signal) => call("dream/run", {}, signal),
				consolidateSession: async (sessionId, signal) => parseSessionConsolidateResponse(await call("sessions/consolidate", { sessionId }, signal)),
				readModels: async (signal) => parseConsolidationModelCatalogResponse(await call("models/read", {}, signal)),
				selectModel: async (input, signal) => parseConsolidationModelSelectResponse(await call("models/select", input, signal))
			};
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return exports;
	}
});
