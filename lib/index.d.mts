import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
//#region src/protocol.d.ts
/** Browser/Host wire values for the dedicated loopback Memory RPC channel. */
/** Opaque content revision used for compare-and-swap writes. */
type MemoryRevision = string & {
  readonly __memoryRevision: unique symbol;
};
/** Browser-safe identifier resolved against the Host Workspace catalog. */
type WorkspaceId = string & {
  readonly __workspaceId: unique symbol;
};
/** Summary displayed at the top of the Memory settings section. */
interface MemoryStatus {
  enabled: true;
  root: string;
  globalBytes: number;
  workspaceCount: number;
}
/** Complete global memory document and its current revision. */
interface GlobalMemoryView {
  content: string;
  revision: MemoryRevision;
}
/** Browser-safe summary of one discovered Workspace. */
interface WorkspaceSummary {
  workspaceId: WorkspaceId;
  displayName: string;
  revision: MemoryRevision;
  recordCount: number;
}
/** Closed record projection returned by the Workspace read endpoint. */
interface WorkspaceRecordView {
  name: string;
  description: string;
  type: 'feedback' | 'project' | 'reference';
  content: string;
}
/** Complete read-only Workspace projection returned to the Browser. */
interface WorkspaceReadResponse extends WorkspaceSummary {
  index: string;
  records: WorkspaceRecordView[];
}
/** Ordered catalog returned by the Workspace list endpoint. */
interface WorkspaceListResponse {
  workspaces: WorkspaceSummary[];
}
/** Deterministic reason why a persisted Session cannot be consolidated. */
type SessionIneligibleReason = 'live' | 'missing-cwd' | 'workspace-unavailable' | 'unstable';
type SessionReceiptState = 'committing' | 'committed' | 'no-change' | 'cancelled' | 'source-changed' | 'target-conflict' | 'invalid-proposal' | 'provider-failed' | 'evidence-too-large' | 'internal-error';
/** Browser-safe receipt status without model route, Workspace key, or revisions. */
interface SessionReceiptSummary {
  reviewId: string;
  state: SessionReceiptState;
  attempt: number;
  current: boolean;
  completedAt: string | null;
}
/** Browser-safe projection of one persisted Session snapshot. */
type SessionSummary = {
  sessionId: string;
  title: string | null;
  createdAt: number;
  workspaceId: WorkspaceId | null;
  workspaceName: string | null;
  latestReceipt: SessionReceiptSummary | null;
} & ({
  eligible: true;
  reason: null;
} | {
  eligible: false;
  reason: SessionIneligibleReason;
});
/** Session candidate capability and ordered persisted Session list. */
interface SessionListResponse {
  available: boolean;
  sessions: SessionSummary[];
}
interface SessionConsolidatePayload {
  sessionId: string;
}
interface SessionConsolidateResponse {
  status: Exclude<SessionReceiptState, 'committing'>;
  recovered: boolean;
  reviewId: string;
  attempt: number;
  changeCount: number;
  debugLoggingEnabled: boolean;
}
/** Memory-specific model route chosen from DSH's active model catalog. */
interface ConsolidationModelSelection {
  provider: string;
  model: string;
}
interface ConsolidationModelView {
  id: string;
  name: string;
  description?: string;
}
interface ConsolidationModelProviderView {
  id: string;
  name: string;
  models: ConsolidationModelView[];
}
interface ConsolidationModelCatalogResponse {
  available: boolean;
  selection: ConsolidationModelSelection;
  debugEnabled: boolean;
  revision: MemoryRevision;
  providers: ConsolidationModelProviderView[];
  failures: Array<{
    provider: string;
    message: string;
  }>;
}
interface ConsolidationModelSelectPayload extends ConsolidationModelSelection {
  expectedRevision: MemoryRevision;
  debugEnabled: boolean;
}
type ConsolidationModelSelectResponse = {
  status: 'committed';
  revision: MemoryRevision;
} | {
  status: 'conflict';
  currentRevision: MemoryRevision;
};
/** One Browser-proposed change in a canonical delete-then-put batch. */
type WorkspaceCommitChange = {
  action: 'delete';
  name: string;
} | {
  action: 'put';
  record: WorkspaceRecordView;
};
/** Revision-checked Workspace batch submitted through the loopback RPC. */
interface WorkspaceCommitPayload {
  workspaceId: WorkspaceId;
  expectedRevision: MemoryRevision;
  changes: WorkspaceCommitChange[];
}
/** Result of one Workspace batch commit through the Web API. */
type WorkspaceCommitResponse = {
  status: 'committed';
  revision: MemoryRevision;
} | {
  status: 'conflict';
  currentRevision: MemoryRevision;
};
/** Result of replacing the global document through the Web API. */
type GlobalReplaceResponse = {
  status: 'committed';
  revision: MemoryRevision;
} | {
  status: 'conflict';
  currentRevision: MemoryRevision;
};
/** Minimal RPC error vocabulary accepted by the Connection envelope. */
interface MemoryRpcError {
  code: 'bad-request' | 'cancelled' | 'internal';
  message: string;
  details: Record<string, unknown>;
}
/** Connection-compatible result returned by one Memory RPC call. */
type MemoryRpcResult<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  error: MemoryRpcError;
};
//#endregion
//#region src/memory-store.d.ts
/** Allowed Workspace record categories. */
type WorkspaceMemoryType = 'feedback' | 'project' | 'reference';
/** Host-authoritative current Workspace identity. */
interface WorkspaceScope {
  readonly cwd: string;
  readonly key: string;
  readonly directory: string;
}
/** Host-only Workspace location that does not require retaining or exposing cwd. */
interface WorkspaceTarget {
  readonly key: string;
  readonly directory: string;
}
/** Parsed Workspace memory record. */
interface WorkspaceMemory {
  readonly name: string;
  readonly description: string;
  readonly type: WorkspaceMemoryType;
  readonly content: string;
}
/** Complete Workspace view and its derived index. */
interface WorkspaceMemoryView {
  readonly records: readonly WorkspaceMemory[];
  readonly index: string;
  readonly revision: MemoryRevision;
}
/** Deterministic result of applying a Workspace batch without publishing it. */
interface WorkspaceMemoryPreview extends WorkspaceMemoryView {
  readonly changed: boolean;
}
interface GlobalMemoryView$1 {
  readonly content: string;
  readonly revision: MemoryRevision;
}
interface GlobalMemoryPreview extends GlobalMemoryView$1 {
  readonly changed: boolean;
}
/** Model-visible prompt text paired with Host-only generations observed while rendering it. */
interface MemoryContextSnapshot {
  readonly text: string;
  readonly globalRevision: MemoryRevision;
  readonly workspace?: {
    readonly key: string;
    readonly revision: MemoryRevision;
  };
}
/** One atomic Workspace mutation. */
type WorkspaceMemoryChange = {
  readonly action: 'put';
  readonly record: WorkspaceMemory;
} | {
  readonly action: 'delete';
  readonly name: string;
};
/** Successful commit information returned to Consumers. */
interface MemoryCommitResult {
  readonly operation: 'create' | 'update' | 'delete';
  readonly revision: MemoryRevision;
}
/**
 * Markdown implementation of the Host MemoryStore service.
 *
 * Global commits publish one renamed file. Workspace commits build a complete
 * sibling directory and swap it under a per-scope lock, so readers never
 * observe a generated index from a different record set through this service.
 */
declare class MarkdownMemoryStore extends Service {
  readonly root: string;
  private readonly locks;
  constructor(ctx: Context, root?: string);
  /** Create the stable root and default global document if absent. */
  initialize(): void;
  /** Resolve one absolute cwd into the v0.1 lexical Workspace identity. */
  scopeForCwd(cwd: string): WorkspaceScope;
  /** Return the Browser-safe display label for a resolvable Workspace cwd. */
  workspaceDisplayNameForCwd(cwd: string): string;
  /** Return the opaque Browser identity and display label for one resolvable Workspace cwd. */
  workspaceReferenceForCwd(cwd: string): {
    workspaceId: WorkspaceId;
    displayName: string;
  };
  /** Resolve one receipt-owned Workspace key without accepting an arbitrary path. */
  workspaceTargetForKey(key: string): WorkspaceTarget;
  /** Read the authoritative global document. */
  readGlobal(): Promise<{
    content: string;
    revision: MemoryRevision;
  }>;
  /** Synchronous prompt-assembly view of the authoritative global document. */
  readGlobalSync(): {
    content: string;
    revision: MemoryRevision;
  };
  /** Replace GLOBAL.md when the caller still holds its latest revision. */
  commitGlobal(input: {
    expectedRevision: MemoryRevision;
    content: string;
  }): Promise<MemoryCommitResult>;
  /** Read and validate all records in one Workspace. */
  readWorkspace(scope: Pick<WorkspaceTarget, 'directory'>): Promise<WorkspaceMemoryView>;
  /** Synchronous Workspace view used during prompt assembly. */
  readWorkspaceSync(scope: Pick<WorkspaceTarget, 'directory'>): WorkspaceMemoryView;
  /** Enumerate Browser-safe summaries for every valid Workspace directory. */
  listWorkspaces(): WorkspaceListResponse;
  /** Resolve and read one Workspace only through its opaque Browser id. */
  readWorkspaceById(workspaceId: WorkspaceId): WorkspaceReadResponse | undefined;
  private discoverWorkspaces;
  /** Apply a revision-checked record batch and publish one new Workspace generation. */
  commitWorkspace(input: {
    scope: WorkspaceTarget;
    expectedRevision: MemoryRevision;
    changes: readonly WorkspaceMemoryChange[];
  }): Promise<MemoryCommitResult>;
  /** Resolve and commit one Browser batch only through its opaque Workspace id. */
  commitWorkspaceById(input: {
    workspaceId: WorkspaceId;
    expectedRevision: MemoryRevision;
    changes: readonly WorkspaceMemoryChange[];
  }): Promise<MemoryCommitResult | undefined>;
  private commitWorkspaceAt;
  /** Render the complete runtime-context snapshot for one optional cwd. */
  renderContext(cwd?: string): string;
  /** Render model-visible memory and retain its exact generations for Host-owned CAS. */
  renderContextSnapshot(cwd?: string): MemoryContextSnapshot;
  /** Collect observational store totals for the Settings status banner. */
  status(): MemoryStatus;
  private withLock;
}
//#endregion
//#region src/consolidation-evidence.d.ts
interface ConsolidationEvidenceTool {
  readonly name: string;
  readonly status: 'succeeded' | 'failed';
}
/** One compact turn whose range remains anchored to the authoritative source log. */
interface ConsolidationEvidenceTurn {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly user: readonly string[];
  readonly summaries: readonly string[];
  readonly assistantFinal: string | null;
  readonly tools: readonly ConsolidationEvidenceTool[];
}
//#endregion
//#region src/consolidation-proposal.d.ts
/** Inclusive source Session evidence interval. */
interface ConsolidationEvidenceRange {
  readonly fromSeq: number;
  readonly toSeq: number;
}
/** One validated model-proposed Workspace change with source evidence. */
type ConsolidationProposalChange = {
  readonly action: 'replace-global';
  readonly content: string;
  readonly evidence: readonly ConsolidationEvidenceRange[];
} | {
  readonly action: 'put';
  readonly record: WorkspaceMemory;
  readonly evidence: readonly ConsolidationEvidenceRange[];
} | {
  readonly action: 'delete';
  readonly name: string;
  readonly evidence: readonly ConsolidationEvidenceRange[];
};
/** Closed semantic result accepted from the consolidation worker. */
type ConsolidationProposal = {
  readonly outcome: 'no-change';
  readonly changes: readonly [];
} | {
  readonly outcome: 'changes';
  readonly changes: readonly ConsolidationProposalChange[];
};
/** Canonical proposal plus the exact Workspace generation it would produce. */
interface ConsolidationProposalPlan {
  readonly proposal: ConsolidationProposal;
  readonly globalBefore: GlobalMemoryView$1;
  readonly globalPreview: GlobalMemoryPreview;
  readonly preview: WorkspaceMemoryPreview;
}
//#endregion
//#region src/consolidation-debug.d.ts
/** Local append-only diagnostics for manual consolidation attempts. */
interface ConsolidationDebugIdentity {
  readonly reviewId: string;
  readonly attempt: number;
}
/** JSONL diagnostics exclude evidence and memory bodies but retain error chains and stacks. */
declare class ConsolidationDebugStore {
  readonly directory: string;
  private readonly now;
  private readonly warn;
  private readonly enabled;
  constructor(directory: string, now?: () => Date, warn?: (message: string) => void, enabled?: () => boolean);
  record(identity: ConsolidationDebugIdentity, stage: string, details?: Readonly<Record<string, unknown>>): void;
  failure(identity: ConsolidationDebugIdentity, stage: string, error: unknown): void;
  pathFor(identity: ConsolidationDebugIdentity): string;
}
//#endregion
//#region src/consolidation-settings.d.ts
interface MemoryLlmCatalog {
  listProviders(): Array<{
    id: string;
    name: string;
  }>;
  listModels(provider: string): Promise<Array<{
    provider: string;
    id: string;
    name: string;
    description?: string;
    inputModalities?: readonly string[];
  }>>;
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    defaultMaxTokens?: number;
  }>;
}
interface ConsolidationSettingsView {
  readonly selection: ConsolidationModelSelection;
  readonly debugEnabled: boolean;
  readonly revision: MemoryRevision;
}
/** Plugin-owned settings file; memory Markdown remains the only authoritative memory data. */
declare class ConsolidationSettingsStore {
  private readonly defaults;
  readonly path: string;
  constructor(root: string, defaults: Pick<ConsolidationWorkerConfig, 'provider' | 'model'>);
  read(): ConsolidationSettingsView;
  commit(input: {
    expectedRevision: MemoryRevision;
    selection: ConsolidationModelSelection;
    debugEnabled: boolean;
  }): {
    status: 'committed';
    revision: MemoryRevision;
  } | {
    status: 'conflict';
    currentRevision: MemoryRevision;
  };
}
/** Read active adapters and their text-capable model catalogs from DSH. */
declare function readConsolidationModelCatalog(llm: MemoryLlmCatalog, settings: ConsolidationSettingsStore): Promise<ConsolidationModelCatalogResponse>;
declare function selectionIsAvailable(catalog: ConsolidationModelCatalogResponse, selection: ConsolidationModelSelection): boolean;
/** Respect the selected model's adapter-owned output cap while retaining a plugin cost ceiling. */
declare function resolveConsolidationOutputTokens(llm: MemoryLlmCatalog, selection: ConsolidationModelSelection, ceiling: number, signal?: AbortSignal): Promise<number>;
//#endregion
//#region src/consolidation-workspace.d.ts
declare const CONSOLIDATION_WORKSPACE_TITLE = "Memory Consolidation";
declare const CONSOLIDATION_WORKSPACE_DIRECTORY = "consolidator-workspace";
/** Match only the plugin-owned operational cwd without resolving arbitrary Session paths. */
declare function isConsolidationWorkspaceCwd(cwd: string | undefined, directory: string): boolean;
interface MemoryWorkspace {
  readonly path: string;
  attachSession(sessionId: SessionId): Promise<void>;
}
interface MemoryWorkspaceCreator {
  create(path: string, title?: string): Promise<MemoryWorkspace>;
}
/** DSH registry capabilities shared by worker placement and Session archive filtering. */
interface MemoryWorkspaceRegistry extends MemoryWorkspaceCreator {
  readonly archivedSessionIds: readonly string[];
}
interface PreparedConsolidationWorkspace {
  readonly cwd: string;
  attachSession(sessionId: SessionId): Promise<void>;
}
interface ConsolidationWorkspacePlacement {
  prepare(): Promise<PreparedConsolidationWorkspace>;
}
/** Keep worker logs physically separate and attach them to a native DSH Workspace when available. */
declare class DedicatedConsolidationWorkspace implements ConsolidationWorkspacePlacement {
  readonly directory: string;
  private readonly getRegistry;
  constructor(directory: string, getRegistry?: () => MemoryWorkspaceCreator | undefined);
  prepare(): Promise<PreparedConsolidationWorkspace>;
}
//#endregion
//#region src/host-contracts.d.ts
/** Current Agent identity made available to prompt and tool execution. */
interface MemoryAgent {
  readonly session: {
    readonly header: {
      readonly cwd?: string;
    };
  };
}
/** Prompt assembly context extended by dsh-agent. */
interface MemoryAssembleContext {
  readonly agent?: MemoryAgent;
}
/** Dynamic prompt registry used by dsh-memory. */
interface MemorySystemPrompt {
  section(input: {
    name: string;
    order: number;
    text: string;
  }): () => void;
  context(input: {
    name: string;
    order: number;
    text: (context: MemoryAssembleContext) => string;
  }): () => void;
}
/** Tool registry used by the model-facing mutation Consumer. */
interface MemoryToolRegistry {
  register(definition: unknown): () => void;
}
/** Dedicated logical RPC registrar provided by dsh-client-connection. */
interface MemoryHostConnection {
  readonly rpc: {
    handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<MemoryRpcResult<unknown>>, options: {
      authority: 'loopback';
    }): () => Promise<void>;
  };
}
/** Lightweight persistence metadata used to discover consolidation candidates. */
interface MemorySessionSnapshot {
  readonly header: {
    readonly id: string;
    readonly createdAt: number;
    readonly cwd?: string;
  };
  readonly revision: string;
}
/** Backend-neutral SessionPersistence face used by the candidate catalog. */
interface MemorySessionSnapshotPersistence {
  listSnapshots(signal?: AbortSignal): Promise<MemorySessionSnapshot[]>;
}
/** Client-visible Session projection cut used for zero-log-read list decoration. */
interface MemorySessionProjectionSnapshot {
  readonly values: Readonly<Record<string, unknown>>;
}
/** Live Session projection registry face used by the candidate catalog. */
interface MemorySessionProjections {
  snapshot(session: unknown): MemorySessionProjectionSnapshot;
}
/** Durable cold Session projection cache face used by the candidate catalog. */
interface MemorySessionProjectionCache {
  cachedSnapshot(header: MemorySessionSnapshot['header']): MemorySessionProjectionSnapshot | undefined;
}
/** Immutable logical Session view returned by the persistence service. */
interface MemorySessionInspection {
  readonly meta: MemorySessionSnapshot['header'];
  readonly events: readonly unknown[];
}
/** Backend-neutral persistence face required by Session consolidation. */
interface MemorySessionPersistence extends MemorySessionSnapshotPersistence {
  inspect(id: string, signal?: AbortSignal): Promise<MemorySessionInspection>;
}
/** Handle-based SessionPersistence face exposed by newer DSH Hosts. */
interface MemoryHandleSessionPersistence {
  list(options?: {
    signal?: AbortSignal;
  }): Promise<readonly MemorySessionSnapshot[]>;
  open(id: string, access: 'read', options?: {
    signal?: AbortSignal;
  }): Promise<{
    readonly header: MemorySessionSnapshot['header'];
    read(offset?: number, length?: number, options?: {
      signal?: AbortSignal;
    }): Promise<{
      readonly events: readonly unknown[];
    }>;
    close(): Promise<void>;
  }>;
}
/** Live Agent lookup used to exclude sessions that are still running. */
interface MemoryAgentRegistry {
  get(id: string): {
    readonly session?: unknown;
  } | undefined;
}
/** Agent registry face shared by candidate discovery and the consolidation worker. */
type MemoryConsolidationAgents = MemoryAgentRegistry & ConsolidationWorkerAgents;
declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryStore: MarkdownMemoryStore;
    systemPrompt: MemorySystemPrompt;
    tools: MemoryToolRegistry;
    connection: MemoryHostConnection;
    sessionPersistence: MemorySessionPersistence | MemoryHandleSessionPersistence;
    agents: MemoryConsolidationAgents;
    sessions: ConsolidationWorkerSessions;
    llm: MemoryLlmCatalog;
    sessionProjections: MemorySessionProjections;
    sessionProjectionCache: MemorySessionProjectionCache;
    workspaceRegistry: MemoryWorkspaceRegistry;
  }
}
//#endregion
//#region src/session-consolidator.d.ts
/** Versioned semantics included in every deterministic review identity. */
declare const CONSOLIDATOR_VERSION = "m3-multistep-global-v5";
type SessionConsolidationErrorCode = 'not-found' | 'ambiguous' | 'live' | 'archived' | 'missing-cwd' | 'workspace-unavailable' | 'unstable' | 'inspection-mismatch';
/** Closed preparation failure vocabulary used by Host orchestration and receipts. */
declare class SessionConsolidationError extends Error {
  readonly code: SessionConsolidationErrorCode;
  constructor(code: SessionConsolidationErrorCode, message: string);
}
/** Frozen source and target facts passed to the worker proposal producer. */
interface SessionConsolidationInput {
  readonly reviewId: string;
  readonly consolidatorVersion: string;
  readonly source: {
    readonly sessionId: string;
    readonly revision: string;
    readonly createdAt: number;
    readonly events: readonly unknown[];
    readonly evidence: readonly ConsolidationEvidenceTurn[];
  };
  readonly global: {
    readonly revision: MemoryRevision;
    readonly content: string;
  };
  readonly workspace: {
    readonly scope: WorkspaceScope;
    readonly revision: MemoryRevision;
    readonly index: string;
    readonly records: readonly WorkspaceMemory[];
  };
}
/** Prepares a replayable consolidation input without invoking a model or mutating memory. */
declare class SessionConsolidator {
  private readonly store;
  private readonly persistence;
  private readonly agents;
  private readonly version;
  private readonly excludeCwd;
  private readonly isArchived;
  constructor(store: MarkdownMemoryStore, persistence: MemorySessionPersistence, agents: MemoryAgentRegistry, version?: string, excludeCwd?: (cwd: string) => boolean, isArchived?: (sessionId: string) => boolean);
  /** Observe, inspect, and re-observe one Session before exposing its complete logical events. */
  prepare(sessionId: string, signal?: AbortSignal): Promise<SessionConsolidationInput>;
  /** Validate one untrusted worker result against its frozen source and target generations. */
  planProposal(input: SessionConsolidationInput, value: unknown): ConsolidationProposalPlan;
  /** Recheck the frozen source generation immediately before entering the commit barrier. */
  assertSourceStable(input: SessionConsolidationInput, signal?: AbortSignal): Promise<void>;
  private assertNotArchived;
}
//#endregion
//#region src/consolidation-worker.d.ts
/** Bundle bootstrap route and operational ceilings; saved Settings override provider/model. */
interface ConsolidationWorkerConfig {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
}
/** Minimal Agent-scoped Host capabilities used during unpublished setup. */
type ConsolidationPreStepListener = (payload: {
  readonly step: number;
}, next: () => Promise<{
  kind: 'reject';
} | {
  kind: 'enter';
  messages: unknown[];
}>) => Promise<{
  kind: 'reject';
} | {
  kind: 'enter';
  messages: unknown[];
}>;
type ConsolidationAgentErrorListener = (payload: {
  readonly error: unknown;
}) => void;
interface ConsolidationWorkerScope {
  readonly systemPrompt: {
    section(input: {
      name: string;
      order: number;
      text: string;
      complete?: true;
    }): () => void;
    suppressRuntimeContext(): () => void;
  };
  readonly tools: {
    restrict(input: {
      allow: readonly string[];
    }): () => void;
    register(definition: unknown): () => void;
  };
  on(event: 'agent/pre-step', listener: ConsolidationPreStepListener): () => void;
  on(event: 'agent/error', listener: ConsolidationAgentErrorListener): () => void;
}
/** Minimal live worker Agent surface needed by the multi-step driver. */
interface ConsolidationWorkerAgent {
  readonly session: {
    readonly id: SessionId;
    readonly events: readonly unknown[];
  };
  inject(message: unknown): void;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
  cancel(cause: {
    kind: 'user';
  }): void;
}
interface ConsolidationWorkerHandle {
  readonly agent: ConsolidationWorkerAgent;
  dispose(): Promise<void>;
}
/** AgentRegistry creation face used without depending on its concrete loop implementation. */
interface ConsolidationWorkerAgents {
  create(options: {
    readonly sessionId: SessionId;
    readonly meta: {
      readonly cwd: string;
    };
    readonly agentOptions: {
      provider: string;
      model: string;
      maxTokens: number;
    };
    readonly signal?: AbortSignal;
    readonly setup: (context: ConsolidationWorkerScope) => void;
  }): Promise<ConsolidationWorkerHandle>;
}
/** SessionStore durability barrier required before disposing the live worker. */
interface ConsolidationWorkerSessions {
  flush(session: ConsolidationWorkerAgent['session']): Promise<boolean>;
}
interface ConsolidationWorkerResult {
  readonly workerSessionId: string;
  readonly plan: ConsolidationProposalPlan;
}
//#endregion
//#region src/consolidation-receipt.d.ts
type ConsolidationReceiptState = 'committing' | 'committed' | 'no-change' | 'cancelled' | 'source-changed' | 'target-conflict' | 'invalid-proposal' | 'provider-failed' | 'evidence-too-large' | 'internal-error';
interface ConsolidationReceiptAttempt {
  readonly attempt: number;
  readonly workerSessionId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly status: 'proposed' | Exclude<ConsolidationReceiptState, 'committing'>;
}
interface ConsolidationReceiptChange {
  readonly action: 'replace-global' | 'put' | 'delete';
  readonly name: string;
  readonly type?: 'feedback' | 'project' | 'reference';
  readonly evidence: readonly ConsolidationEvidenceRange[];
  readonly contentHash?: string;
}
/** Minimal Host audit record. It deliberately excludes proposal and memory bodies. */
interface ConsolidationReceipt {
  readonly format: 1;
  readonly reviewId: string;
  readonly consolidatorVersion: string;
  readonly sourceSessionId: string;
  readonly sourceRevision: string;
  readonly coveredSeq: {
    readonly from: number;
    readonly to: number;
  } | null;
  readonly workspaceKey: string;
  readonly beforeRevision: MemoryRevision;
  readonly plannedAfterRevision: MemoryRevision;
  readonly state: ConsolidationReceiptState;
  readonly attempts: readonly ConsolidationReceiptAttempt[];
  readonly proposalHash: string;
  readonly changes: readonly ConsolidationReceiptChange[];
  readonly createdAt: string;
  readonly completedAt?: string;
}
interface ConsolidationCommitInput {
  readonly input: SessionConsolidationInput;
  readonly plan: ConsolidationProposalPlan;
  readonly attempt: number;
  readonly workerSessionId: string | null;
  readonly workerConfig: Pick<ConsolidationWorkerConfig, 'provider' | 'model'>;
  readonly signal?: AbortSignal;
}
interface ConsolidationCommitResult {
  readonly outcome: 'committed' | 'no-change' | 'target-conflict';
  readonly recovered: boolean;
  readonly receipt: ConsolidationReceipt;
}
declare class ConsolidationReceiptError extends Error {
  constructor(message: string, options?: ErrorOptions);
}
/** Markdown receipt storage with one in-process lock per deterministic review id. */
declare class ConsolidationReceiptStore {
  readonly directory: string;
  private readonly now;
  private readonly locks;
  constructor(directory: string, now?: () => Date);
  read(reviewId: string): ConsolidationReceipt | undefined;
  /** Discover durable commit intents for one source Session without reading Session storage. */
  listCommittingBySourceSession(sourceSessionId: string): ConsolidationReceipt[];
  /** Return the newest receipt for a source Session, preferring the current source revision. */
  latestBySourceSession(sourceSessionId: string, sourceRevision: string): ConsolidationReceipt | undefined;
  /** Scan receipts once for a complete Session catalog refresh. */
  latestBySourceSessions(sourceRevisions: ReadonlyMap<string, string>): Map<string, ConsolidationReceipt>;
  write(receipt: ConsolidationReceipt): void;
  timestamp(): string;
  withReviewLock<T>(reviewId: string, body: () => Promise<T>): Promise<T>;
  private pathFor;
  private listAll;
}
/** Own the pre-commit recheck, durable intent, CAS commit, and crash convergence. */
declare class ConsolidationCommitCoordinator {
  private readonly memory;
  private readonly consolidator;
  private readonly receipts;
  constructor(memory: MarkdownMemoryStore, consolidator: SessionConsolidator, receipts: ConsolidationReceiptStore);
  commit(request: ConsolidationCommitInput): Promise<ConsolidationCommitResult>;
  /** Commit when the caller already owns the review lock across the model attempt. */
  commitWithinReviewLock(request: ConsolidationCommitInput): Promise<ConsolidationCommitResult>;
  /** Recover one already locked durable intent, optionally without loading a plan when already committed/conflicted. */
  recoverReceiptWithinReviewLock(receipt: ConsolidationReceipt, target: WorkspaceTarget, plan?: ConsolidationProposalPlan): Promise<ConsolidationCommitResult>;
  private publish;
  private finishConflict;
}
declare function proposalHash(plan: ConsolidationProposalPlan): string;
//#endregion
//#region src/consolidation-replay.d.ts
interface ConsolidationPlanReplay {
  loadPlan(workerSessionId: string, input: SessionConsolidationInput, signal?: AbortSignal): Promise<ConsolidationProposalPlan>;
  loadRecoveryPlan(workerSessionId: string, receipt: ConsolidationReceipt, workspace: WorkspaceMemoryView, signal?: AbortSignal): Promise<ConsolidationProposalPlan>;
}
declare class ConsolidationReplayError extends Error {
  constructor(message: string, options?: ErrorOptions);
}
/** Use SessionPersistence logical events rather than assuming one storage backend. */
declare class WorkerSessionPlanReplay implements ConsolidationPlanReplay {
  private readonly persistence;
  private readonly consolidator;
  constructor(persistence: MemorySessionPersistence, consolidator: SessionConsolidator);
  loadPlan(workerSessionId: string, input: SessionConsolidationInput, signal?: AbortSignal): Promise<ConsolidationProposalPlan>;
  loadRecoveryPlan(workerSessionId: string, receipt: ConsolidationReceipt, workspace: WorkspaceMemoryView, signal?: AbortSignal): Promise<ConsolidationProposalPlan>;
}
//#endregion
//#region src/consolidation-runner.d.ts
type ConsolidationRunOutcome = ConsolidationCommitResult['outcome'] | 'cancelled' | 'source-changed' | 'invalid-proposal' | 'provider-failed' | 'evidence-too-large' | 'internal-error';
interface ConsolidationRunResult {
  readonly outcome: ConsolidationRunOutcome;
  readonly recovered: boolean;
  readonly receipt: ConsolidationReceipt;
}
interface ConsolidationWorkerDriver {
  readonly config: ConsolidationWorkerConfig;
  run(input: Parameters<SessionConsolidator['planProposal']>[0], attempt: number, signal?: AbortSignal): Promise<ConsolidationWorkerResult>;
}
/** Keep the review lock across the worker run and final commit barrier. */
declare class SessionConsolidationRunner {
  private readonly consolidator;
  private readonly worker;
  private readonly receipts;
  private readonly commits;
  private readonly replay;
  private readonly memory;
  private readonly debug?;
  constructor(consolidator: SessionConsolidator, worker: ConsolidationWorkerDriver, receipts: ConsolidationReceiptStore, commits: ConsolidationCommitCoordinator, replay: ConsolidationPlanReplay, memory: MarkdownMemoryStore, debug?: ConsolidationDebugStore | undefined);
  run(sessionId: string, signal?: AbortSignal): Promise<ConsolidationRunResult>;
  private recoverPending;
}
type SessionConsolidationRunErrorCode = 'pending-recovery' | 'worker-mismatch' | 'commit-failed';
declare class SessionConsolidationRunError extends Error {
  readonly code: SessionConsolidationRunErrorCode;
  constructor(code: SessionConsolidationRunErrorCode, message: string);
}
//#endregion
//#region src/index.d.ts
/** Loader-visible Cordis plugin name. */
declare const name = "dsh-memory";
/** All DSH capabilities are optional and mounted through child inject fibers. */
declare const inject: string[];
/** Bundle bootstrap route and operational ceilings for the consolidation worker. */
interface Config {
  readonly consolidator?: Partial<ConsolidationWorkerConfig>;
}
declare const Config: any;
/** Mount the local Markdown provider and every optional Consumer. */
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { CONSOLIDATION_WORKSPACE_DIRECTORY, CONSOLIDATION_WORKSPACE_TITLE, CONSOLIDATOR_VERSION, Config, ConsolidationCommitCoordinator, type ConsolidationCommitInput, type ConsolidationCommitResult, ConsolidationDebugStore, type ConsolidationModelCatalogResponse, type ConsolidationModelProviderView, type ConsolidationModelSelectPayload, type ConsolidationModelSelectResponse, type ConsolidationModelSelection, type ConsolidationModelView, type ConsolidationPlanReplay, type ConsolidationReceipt, type ConsolidationReceiptAttempt, type ConsolidationReceiptChange, ConsolidationReceiptError, type ConsolidationReceiptState, ConsolidationReceiptStore, ConsolidationReplayError, type ConsolidationRunOutcome, type ConsolidationRunResult, ConsolidationSettingsStore, type ConsolidationWorkerDriver, type ConsolidationWorkspacePlacement, DedicatedConsolidationWorkspace, type GlobalMemoryView, type GlobalReplaceResponse, MarkdownMemoryStore, type MemoryCommitResult, type MemoryRevision, type MemoryStatus, type MemoryWorkspace, type MemoryWorkspaceRegistry, type PreparedConsolidationWorkspace, type SessionConsolidatePayload, type SessionConsolidateResponse, SessionConsolidationError, type SessionConsolidationErrorCode, type SessionConsolidationInput, SessionConsolidationRunError, type SessionConsolidationRunErrorCode, SessionConsolidationRunner, SessionConsolidator, type SessionIneligibleReason, type SessionListResponse, type SessionReceiptState, type SessionReceiptSummary, type SessionSummary, WorkerSessionPlanReplay, type WorkspaceCommitChange, type WorkspaceCommitPayload, type WorkspaceCommitResponse, type WorkspaceId, type WorkspaceListResponse, type WorkspaceMemory, type WorkspaceMemoryChange, type WorkspaceMemoryType, type WorkspaceMemoryView, type WorkspaceReadResponse, type WorkspaceRecordView, type WorkspaceScope, type WorkspaceSummary, type WorkspaceTarget, apply, inject, isConsolidationWorkspaceCwd, name, proposalHash, readConsolidationModelCatalog, resolveConsolidationOutputTokens, selectionIsAvailable };