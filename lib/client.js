window.__ModuleLoader__.load({
	id: "@hr98w/dsh-memory",
	factory: (require) => {
		var exports = { exports: {} }.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
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
				if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(draft.name)) return "name";
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
				if (next === "settings" && modelCatalog === void 0) refreshModels(signal);
			};
			const refreshVisible = async () => {
				await refresh();
				if (tab === "workspaces") await refreshWorkspaces();
				if (tab === "sessions") await refreshSessions();
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
							sessions?.available === true && sessions.sessions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: memorySectionStyles.muted,
								children: t("sessionEmpty")
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
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: memorySectionStyles.sessionList,
										children: selectedSessionWorkspace.sessions.map((session) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
											style: memorySectionStyles.sessionCard,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
													style: memorySectionStyles.recordHeading,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														style: memorySectionStyles.sessionIdentity,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
															style: memorySectionStyles.sessionTitle,
															children: session.title ?? t("sessionUntitled")
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
															style: {
																...memorySectionStyles.sessionId,
																...memorySectionStyles.muted
															},
															children: session.sessionId
														})]
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														style: sessionIsConsolidated(session) ? memorySectionStyles.consolidatedBadge : session.eligible ? memorySectionStyles.eligibleBadge : memorySectionStyles.ineligibleBadge,
														children: sessionIsConsolidated(session) ? t("sessionConsolidated") : session.eligible ? t("sessionEligible") : t(sessionReasonKey(session.reason))
													})]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: memorySectionStyles.sessionMeta,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("sessionCreatedAt", { value: formatSessionCreatedAt(session.createdAt) }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: session.latestReceipt === null ? t("sessionNoReceipt") : t(session.latestReceipt.current ? "sessionReceiptCurrent" : "sessionReceiptOlder", { state: t(sessionReceiptStateKey(session.latestReceipt.state)) }) })]
												}),
												consolidationResult?.sessionId === session.sessionId ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
													style: memorySectionStyles.sessionResult,
													children: consolidationResult.result.recovered ? t("sessionConsolidationRecovered", { state: t(sessionReceiptStateKey(consolidationResult.result.status)) }) : consolidationResult.result.status === "committed" ? t("sessionConsolidationCommitted", { count: consolidationResult.result.changeCount }) : consolidationResult.result.status === "no-change" ? t("sessionConsolidationNoChange") : t("sessionConsolidationResult", { state: t(sessionReceiptStateKey(consolidationResult.result.status)) })
												}), consolidationResult.result.debugLoggingEnabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
													style: memorySectionStyles.debugPath,
													children: t("sessionDebugLog", {
														reviewId: consolidationResult.result.reviewId,
														attempt: consolidationResult.result.attempt
													})
												}) : null] }) : null,
												session.eligible ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													style: memorySectionStyles.actions,
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryButton, {
														variant: "primary",
														style: memorySectionStyles.primaryButton,
														disabled: consolidatingSessionId !== void 0 || sessionIsConsolidated(session),
														onClick: () => {
															consolidateSession(session.sessionId);
														},
														children: consolidatingSessionId === session.sessionId ? t("sessionConsolidating") : t("sessionConsolidate")
													})
												}) : null
											]
										}, session.sessionId))
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
				display: "grid",
				gap: 10,
				padding: 14,
				minWidth: 0,
				border: "1px solid rgba(127,127,127,0.3)",
				borderRadius: 10
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
			const records = record.records.map((entry, index) => parseWorkspaceRecord(entry, `workspace read response.records[${index}]`));
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
			requireExactKeys(record, ["available", "sessions"], "session list response");
			if (typeof record.available !== "boolean") throw new TypeError("session list response.available must be a boolean");
			if (!Array.isArray(record.sessions)) throw new TypeError("session list response.sessions must be an array");
			if (!record.available && record.sessions.length !== 0) throw new TypeError("session list response.sessions must be empty when unavailable");
			return {
				available: record.available,
				sessions: record.sessions.map((entry, index) => parseSessionSummary(entry, `session list response.sessions[${index}]`))
			};
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
			const record = requireRecord(value, label);
			requireExactKeys(record, [
				"sessionId",
				"title",
				"createdAt",
				"workspaceId",
				"workspaceName",
				"eligible",
				"reason",
				"latestReceipt"
			], label);
			const sessionId = requireNonEmptySingleLine(record.sessionId, `${label}.sessionId`);
			const title = record.title === null ? null : requireNonEmptySingleLine(record.title, `${label}.title`);
			if (!isNonNegativeInteger(record.createdAt)) throw new TypeError(`${label}.createdAt must be a non-negative integer`);
			const workspaceId = record.workspaceId === null ? null : requireWorkspaceId(record.workspaceId, `${label}.workspaceId`);
			const workspaceName = record.workspaceName === null ? null : requireNonEmptySingleLine(record.workspaceName, `${label}.workspaceName`);
			if (workspaceId === null !== (workspaceName === null)) throw new TypeError(`${label}.workspaceId and workspaceName must both be null or both be present`);
			const latestReceipt = record.latestReceipt === null ? null : parseSessionReceiptSummary(record.latestReceipt, `${label}.latestReceipt`);
			const base = {
				sessionId,
				title,
				createdAt: record.createdAt,
				workspaceId,
				workspaceName,
				latestReceipt
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
		function parseWorkspaceRecord(value, label) {
			const record = requireRecord(value, label);
			requireExactKeys(record, [
				"name",
				"description",
				"type",
				"content"
			], label);
			const name = requireWorkspaceMemoryName(record.name, `${label}.name`);
			const description = requireNonEmptySingleLine(record.description, `${label}.description`);
			if (record.type !== "feedback" && record.type !== "project" && record.type !== "reference") throw new TypeError(`${label}.type must be feedback, project, or reference`);
			if (typeof record.content !== "string" || record.content.trim() === "") throw new TypeError(`${label}.content must be a non-empty string`);
			return {
				name,
				description,
				type: record.type,
				content: record.content
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
		function requireWorkspaceMemoryName(value, label) {
			if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) throw new TypeError(`${label} must be a kebab-case Workspace memory name`);
			return value;
		}
		function isSessionIneligibleReason(value) {
			return value === "live" || value === "missing-cwd" || value === "workspace-unavailable" || value === "unstable";
		}
		function isSessionReceiptState(value) {
			return value === "committing" || isTerminalReceiptState(value);
		}
		function isTerminalReceiptState(value) {
			return value === "committed" || value === "no-change" || value === "cancelled" || value === "source-changed" || value === "target-conflict" || value === "invalid-proposal" || value === "provider-failed" || value === "evidence-too-large" || value === "internal-error";
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
			settingsTab: "Settings",
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
			sessionReasonLive: "Currently running",
			sessionReasonMissingCwd: "No Workspace cwd",
			sessionReasonWorkspaceUnavailable: "Workspace unavailable",
			sessionReasonUnstable: "Session changed during refresh",
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
			settingsTab: "设置",
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
			sessionReasonLive: "正在运行",
			sessionReasonMissingCwd: "没有工作区 cwd",
			sessionReasonWorkspaceUnavailable: "工作区不可解析",
			sessionReasonUnstable: "刷新期间会话发生变化",
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
