/**
 * Sidecar storage for governance metadata.
 *
 * One JSON document per scope, committed with an expected-revision check so two
 * writers can never silently clobber each other. A missing or unreadable file is
 * never an error: it degrades to "no governance data", which callers must treat
 * as "every Markdown record is active".
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  importanceClassOf,
  type GovernanceClaim,
  type GovernanceClaimInput,
  type GovernanceCommit,
  type GovernanceCommitResult,
  type GovernanceDocument,
  type Lifecycle,
} from './memory-governance-types.ts'

/** Raised when a commit targets a revision that is no longer current. */
export class GovernanceConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GovernanceConflictError'
  }
}

const GOVERNANCE_DIRECTORY = 'governance'
const WORKSPACES_SUBDIRECTORY = 'workspaces'
const FORMAT = 1

/** Read and commit per-scope governance documents. */
export class MemoryGovernanceStore {
  constructor(readonly root: string) {}

  /** Directory holding every governance artifact for this memory root. */
  get directory(): string {
    return join(this.root, GOVERNANCE_DIRECTORY)
  }

  /** Read one scope, degrading to an empty document when unreadable. */
  read(scopeKey: string): GovernanceDocument {
    const path = this.pathFor(scopeKey)
    if (!existsSync(path)) return emptyDocument(scopeKey)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return { ...emptyDocument(scopeKey), degraded: true }
    }
    return parseDocument(parsed, scopeKey)
  }

  /**
   * Apply one commit under a revision check.
   *
   * Synchronous by design: the sidecar is tiny, and a synchronous critical
   * section removes the interleaving window that an await would open between
   * the revision check and the write.
   */
  commit(commit: GovernanceCommit): GovernanceCommitResult {
    const current = this.read(commit.scopeKey)
    if (current.revision !== commit.expectedRevision) {
      throw new GovernanceConflictError(
        `governance for "${commit.scopeKey}" changed since it was read`,
      )
    }
    const byName = new Map(current.claims.map(claim => [claim.name, claim]))
    for (const name of commit.removals) byName.delete(name)
    for (const input of commit.upserts) {
      // Preserve lifecycle and provenance across re-upserts: a claim that was
      // cooled must not silently become active again just because it was seen
      // in another Session.
      const previous = byName.get(input.name)
      byName.set(input.name, mergeClaim(input, previous))
    }
    const claims = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name, 'en'))
    const revision = revisionOf(commit.scopeKey, claims)
    const document: GovernanceDocument = {
      format: FORMAT,
      scopeKey: commit.scopeKey,
      revision,
      claims,
      degraded: false,
    }
    this.write(commit.scopeKey, document)
    return { revision, claims }
  }

  /** Overwrite one scope with an explicit document, bypassing revision checks. */
  replace(document: GovernanceDocument): void {
    this.write(document.scopeKey, document)
  }

  private pathFor(scopeKey: string): string {
    return join(this.directory, WORKSPACES_SUBDIRECTORY, `${safeScopeFile(scopeKey)}.json`)
  }

  private write(scopeKey: string, document: GovernanceDocument): void {
    const path = this.pathFor(scopeKey)
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  }
}

/** Keep scope keys from escaping the workspaces directory. */
function safeScopeFile(scopeKey: string): string {
  const cleaned = scopeKey.replace(/[^a-zA-Z0-9._-]/gu, '_')
  if (cleaned === scopeKey && cleaned !== '' && !cleaned.startsWith('.')) return cleaned
  // Anything that had to be rewritten gets a hash so two distinct scopes cannot
  // collapse onto the same filename.
  const digest = createHash('sha256').update(scopeKey).digest('hex').slice(0, 16)
  return `${cleaned.slice(0, 40)}-${digest}`
}

function emptyDocument(scopeKey: string): GovernanceDocument {
  return {
    format: FORMAT,
    scopeKey,
    revision: revisionOf(scopeKey, []),
    claims: [],
    degraded: false,
  }
}

/** Content-addressed revision over the claim set. */
function revisionOf(scopeKey: string, claims: readonly GovernanceClaim[]): string {
  const canonical = JSON.stringify([scopeKey, claims.map(claim => [
    claim.name,
    claim.kind,
    claim.volatility,
    claim.lifecycle,
    claim.importanceScore,
    claim.text,
    claim.environmentFingerprint,
    claim.evidenceCount,
    claim.lastEvidenceAt,
    claim.lastVerifiedAt,
    claim.lastUsedAt,
    claim.supersedes,
    claim.sourcePlugins,
  ])])
  return `gov1:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
}

/** Merge one caller input with the stored claim, keeping derived fields stable. */
function mergeClaim(input: GovernanceClaimInput, previous: GovernanceClaim | undefined): GovernanceClaim {
  const score = previous?.importanceScore ?? 50
  const lifecycle: Lifecycle = previous?.lifecycle ?? 'active'
  return {
    name: input.name,
    scopeKey: input.scopeKey,
    kind: input.kind,
    volatility: input.volatility,
    lifecycle,
    importanceScore: score,
    importanceClass: importanceClassOf(score),
    text: input.text,
    environmentFingerprint: input.environmentFingerprint ?? previous?.environmentFingerprint ?? '',
    evidenceCount: input.evidenceCount ?? previous?.evidenceCount ?? 0,
    lastEvidenceAt: input.lastEvidenceAt ?? previous?.lastEvidenceAt ?? 0,
    lastVerifiedAt: previous?.lastVerifiedAt ?? null,
    lastUsedAt: previous?.lastUsedAt ?? null,
    supersedes: input.supersedes ?? previous?.supersedes ?? [],
    sourcePlugins: input.sourcePlugins ?? previous?.sourcePlugins ?? [],
  }
}

function parseDocument(value: unknown, scopeKey: string): GovernanceDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ...emptyDocument(scopeKey), degraded: true }
  }
  const record = value as Record<string, unknown>
  if (record.format !== FORMAT) return { ...emptyDocument(scopeKey), degraded: true }
  if (record.scopeKey !== scopeKey) return { ...emptyDocument(scopeKey), degraded: true }
  if (!Array.isArray(record.claims)) return { ...emptyDocument(scopeKey), degraded: true }
  const claims: GovernanceClaim[] = []
  for (const entry of record.claims) {
    const claim = parseClaim(entry)
    if (claim === undefined) return { ...emptyDocument(scopeKey), degraded: true }
    claims.push(claim)
  }
  return {
    format: FORMAT,
    scopeKey,
    revision: typeof record.revision === 'string' ? record.revision : revisionOf(scopeKey, claims),
    claims,
    degraded: false,
  }
}

function parseClaim(value: unknown): GovernanceClaim | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name === '') return undefined
  if (typeof record.scopeKey !== 'string') return undefined
  if (!isKind(record.kind) || !isVolatility(record.volatility) || !isLifecycle(record.lifecycle)) return undefined
  if (typeof record.text !== 'string') return undefined
  const score = typeof record.importanceScore === 'number' && Number.isFinite(record.importanceScore)
    ? record.importanceScore
    : 50
  return {
    name: record.name,
    scopeKey: record.scopeKey,
    kind: record.kind,
    volatility: record.volatility,
    lifecycle: record.lifecycle,
    importanceScore: score,
    importanceClass: importanceClassOf(score),
    text: record.text,
    environmentFingerprint: typeof record.environmentFingerprint === 'string' ? record.environmentFingerprint : '',
    evidenceCount: numberOr(record.evidenceCount, 0),
    lastEvidenceAt: numberOr(record.lastEvidenceAt, 0),
    lastVerifiedAt: typeof record.lastVerifiedAt === 'number' ? record.lastVerifiedAt : null,
    lastUsedAt: typeof record.lastUsedAt === 'number' ? record.lastUsedAt : null,
    supersedes: stringList(record.supersedes),
    sourcePlugins: stringList(record.sourcePlugins),
  }
}

function isKind(value: unknown): value is GovernanceClaim['kind'] {
  return value === 'identity' || value === 'preference' || value === 'decision' || value === 'capability'
    || value === 'configuration' || value === 'incident' || value === 'availability'
    || value === 'procedure' || value === 'diagnostic'
}

function isVolatility(value: unknown): value is GovernanceClaim['volatility'] {
  return value === 'stable' || value === 'versioned' || value === 'environmental'
    || value === 'intermittent' || value === 'transient'
}

function isLifecycle(value: unknown): value is Lifecycle {
  return value === 'active' || value === 'contested' || value === 'cooled'
    || value === 'superseded' || value === 'archived'
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}
