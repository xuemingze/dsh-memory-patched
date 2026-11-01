/** Stable-input preparation for one Session consolidation review. */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  MemoryAgentRegistry,
  MemorySessionInspection,
  MemorySessionPersistence,
  MemorySessionSnapshot,
} from './host-contracts.ts'
import type {
  MarkdownMemoryStore,
  WorkspaceMemory,
  WorkspaceScope,
} from './memory-store.ts'
import {
  parseConsolidationProposal,
  type ConsolidationProposalPlan,
} from './consolidation-proposal.ts'
import {
  projectConsolidationEvidence,
  type ConsolidationEvidenceTurn,
} from './consolidation-evidence.ts'
import type { MemoryRevision } from './protocol.ts'

/** Versioned semantics included in every deterministic review identity. */
export const CONSOLIDATOR_VERSION = 'm3-multistep-global-v5'

export type SessionConsolidationErrorCode =
  | 'not-found'
  | 'ambiguous'
  | 'live'
  | 'archived'
  | 'missing-cwd'
  | 'workspace-unavailable'
  | 'unstable'
  | 'inspection-mismatch'

/** Closed preparation failure vocabulary used by Host orchestration and receipts. */
export class SessionConsolidationError extends Error {
  constructor(readonly code: SessionConsolidationErrorCode, message: string) {
    super(message)
    this.name = 'SessionConsolidationError'
  }
}

/** Frozen source and target facts passed to the worker proposal producer. */
export interface SessionConsolidationInput {
  readonly reviewId: string
  readonly consolidatorVersion: string
  readonly source: {
    readonly sessionId: string
    readonly revision: string
    readonly createdAt: number
    readonly events: readonly unknown[]
    readonly evidence: readonly ConsolidationEvidenceTurn[]
  }
  readonly global: {
    readonly revision: MemoryRevision
    readonly content: string
  }
  readonly workspace: {
    readonly scope: WorkspaceScope
    readonly revision: MemoryRevision
    readonly index: string
    readonly records: readonly WorkspaceMemory[]
  }
}

/** Prepares a replayable consolidation input without invoking a model or mutating memory. */
export class SessionConsolidator {
  constructor(
    private readonly store: MarkdownMemoryStore,
    private readonly persistence: MemorySessionPersistence,
    private readonly agents: MemoryAgentRegistry,
    private readonly version = CONSOLIDATOR_VERSION,
    private readonly excludeCwd: (cwd: string) => boolean = () => false,
    private readonly isArchived: (sessionId: string) => boolean = () => false,
  ) {}

  /** Observe, inspect, and re-observe one Session before exposing its complete logical events. */
  async prepare(sessionId: string, signal?: AbortSignal): Promise<SessionConsolidationInput> {
    if (sessionId.trim() === '') throw new TypeError('Session id must not be empty')
    signal?.throwIfAborted()

    const first = exactSnapshot(await this.persistence.listSnapshots(signal), sessionId)
    this.assertNotArchived(sessionId)
    assertNotLive(this.agents, sessionId)
    const cwd = first.header.cwd
    if (cwd === undefined) {
      throw new SessionConsolidationError('missing-cwd', `Session "${sessionId}" has no Workspace cwd`)
    }
    if (this.excludeCwd(cwd)) {
      throw new SessionConsolidationError(
        'workspace-unavailable',
        `Session "${sessionId}" belongs to the internal consolidation Workspace`,
      )
    }

    let scope: WorkspaceScope
    try {
      scope = this.store.scopeForCwd(cwd)
    } catch (cause: unknown) {
      throw new SessionConsolidationError(
        'workspace-unavailable',
        `Session "${sessionId}" does not resolve to a supported Workspace: ${errorMessage(cause)}`,
      )
    }

    const inspection = await this.persistence.inspect(sessionId, signal)
    signal?.throwIfAborted()
    assertInspectionMatches(first, inspection)
    const [global, workspace] = await Promise.all([
      this.store.readGlobal(),
      this.store.readWorkspace(scope),
    ])
    signal?.throwIfAborted()
    const second = stableReobservation(await this.persistence.listSnapshots(signal), sessionId)
    signal?.throwIfAborted()
    this.assertNotArchived(sessionId)
    assertNotLive(this.agents, sessionId)
    if (!sameSnapshot(first, second)) {
      throw new SessionConsolidationError('unstable', `Session "${sessionId}" changed while preparing consolidation`)
    }

    return {
      reviewId: reviewIdOf(this.version, first, scope.key),
      consolidatorVersion: this.version,
      source: {
        sessionId,
        revision: first.revision,
        createdAt: first.header.createdAt,
        events: structuredClone(inspection.events),
        evidence: projectConsolidationEvidence(inspection.events),
      },
      global,
      workspace: {
        scope: { ...scope },
        revision: workspace.revision,
        index: workspace.index,
        records: workspace.records.map(record => ({ ...record })),
      },
    }
  }

  /** Validate one untrusted worker result against its frozen source and target generations. */
  planProposal(input: SessionConsolidationInput, value: unknown): ConsolidationProposalPlan {
    return parseConsolidationProposal(value, {
      sourceEvidence: input.source.evidence,
      global: input.global,
      workspace: input.workspace,
    })
  }

  /** Recheck the frozen source generation immediately before entering the commit barrier. */
  async assertSourceStable(input: SessionConsolidationInput, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const snapshot = stableReobservation(
      await this.persistence.listSnapshots(signal),
      input.source.sessionId,
    )
    signal?.throwIfAborted()
    this.assertNotArchived(input.source.sessionId)
    assertNotLive(this.agents, input.source.sessionId)
    if (snapshot.revision !== input.source.revision
      || snapshot.header.createdAt !== input.source.createdAt
      || !sameResolvedPath(snapshot.header.cwd, input.workspace.scope.cwd)) {
      throw new SessionConsolidationError(
        'unstable',
        `Session "${input.source.sessionId}" changed before consolidation commit`,
      )
    }
  }

  private assertNotArchived(sessionId: string): void {
    if (this.isArchived(sessionId)) {
      throw new SessionConsolidationError('archived', `Session "${sessionId}" is archived`)
    }
  }
}

function exactSnapshot(snapshots: readonly MemorySessionSnapshot[], sessionId: string): MemorySessionSnapshot {
  const matches = snapshots.filter(snapshot => snapshot.header.id === sessionId)
  if (matches.length === 0) {
    throw new SessionConsolidationError('not-found', `Session "${sessionId}" is not persisted`)
  }
  if (matches.length !== 1) {
    throw new SessionConsolidationError('ambiguous', `Session "${sessionId}" has multiple persistence snapshots`)
  }
  return matches[0]!
}

function stableReobservation(
  snapshots: readonly MemorySessionSnapshot[],
  sessionId: string,
): MemorySessionSnapshot {
  const matches = snapshots.filter(snapshot => snapshot.header.id === sessionId)
  if (matches.length !== 1) {
    throw new SessionConsolidationError('unstable', `Session "${sessionId}" changed while preparing consolidation`)
  }
  return matches[0]!
}

function assertNotLive(agents: MemoryAgentRegistry, sessionId: string): void {
  if (agents.get(sessionId) !== undefined) {
    throw new SessionConsolidationError('live', `Session "${sessionId}" is currently live`)
  }
}

/**
 * Compare a raw persisted cwd with an already-resolved Workspace cwd.
 * `resolve` rewrites lexical spellings (forward slashes, trailing separators,
 * drive-letter-less absolute paths on Windows) into the canonical form the
 * Workspace scope carries, so only a real cwd change counts as unstable.
 */
function sameResolvedPath(raw: string | undefined, resolved: string): boolean {
  return raw !== undefined && resolve(raw) === resolved
}

function assertInspectionMatches(snapshot: MemorySessionSnapshot, inspection: MemorySessionInspection): void {
  if (inspection.meta.id !== snapshot.header.id
    || inspection.meta.createdAt !== snapshot.header.createdAt
    || inspection.meta.cwd !== snapshot.header.cwd) {
    throw new SessionConsolidationError(
      'inspection-mismatch',
      `Session "${snapshot.header.id}" inspection metadata does not match its persistence snapshot`,
    )
  }
}

function sameSnapshot(left: MemorySessionSnapshot, right: MemorySessionSnapshot): boolean {
  return left.revision === right.revision
    && left.header.id === right.header.id
    && left.header.createdAt === right.header.createdAt
    && left.header.cwd === right.header.cwd
}

function reviewIdOf(version: string, snapshot: MemorySessionSnapshot, workspaceKey: string): string {
  const hash = createHash('sha256')
  for (const value of [version, snapshot.header.id, snapshot.revision, workspaceKey]) {
    const bytes = Buffer.from(value, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(bytes.length)
    hash.update(length).update(bytes)
  }
  return `review-${hash.digest('hex')}`
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
