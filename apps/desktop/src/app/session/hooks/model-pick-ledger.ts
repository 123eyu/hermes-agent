import { activeGatewayConnectionId } from '@/store/gateway'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { type ComposerModelSelection, composerScopeForOwner, getComposerSelectionScope } from '@/store/session'

export interface ModelPickSnapshot {
  composerSelection: ComposerModelSelection
  model: string
  provider: string
  reasoningEffortWire: string
}

export interface AuthoritativeModelState {
  explicitModelMutation?: boolean
  model: string
  provider: string
  reasoningEffortWire?: string
  revision: number
}

export interface AuthoritativePolicySnapshot {
  fast?: boolean
  reasoningEffort?: string
  reasoningEffortWire?: string
  serviceTier?: string
}

export type ModelPickSettlement =
  | { authoritative: AuthoritativeModelState; kind: 'overtaken' }
  | { kind: 'keep'; superseded?: boolean }
  | { kind: 'reconcile'; model: string; provider: string; revision?: number }
  | { kind: 'rollback'; policy?: AuthoritativePolicySnapshot; revision?: number; snapshot: ModelPickSnapshot }

export interface SettleModelPickOptions {
  liveAuthoritative?: AuthoritativeModelState
  receipt?: { model: string; provider: string; revision?: number }
}

interface PendingPick {
  baseRevision?: number
  painted: ModelPickSnapshot
  token: number
}

interface SessionPicks {
  authoritative?: AuthoritativeModelState
  confirmed: ModelPickSnapshot
  confirmedPolicy?: AuthoritativePolicySnapshot
  confirmedPolicyRevision?: number
  confirmedRevision?: number
  confirmedToken: number
  explicitModelRevision?: number
  pending: PendingPick[]
  shown: ModelPickSnapshot
}

interface ReconciledPickRoute {
  requested: { model: string; provider: string }
  resolved: { model: string; provider: string }
  revision?: number
  token: number
}

let nextPickToken = 0
const picksBySession = new Map<string, SessionPicks>()
const latestPickBySession = new Map<string, number>()
const pickEpochBySession = new Map<string, number>()
const reconciledRouteBySession = new Map<string, ReconciledPickRoute>()

export function currentModelPickEpoch(pickKey: string): number {
  return pickEpochBySession.get(pickKey) ?? 0
}

export function bumpModelPickEpoch(pickKey: string): number {
  const next = ++nextPickToken
  pickEpochBySession.set(pickKey, next)

  return next
}

export function retireModelPickEpoch(pickKey: string, token: number): void {
  if (pickEpochBySession.get(pickKey) === token) {
    bumpModelPickEpoch(pickKey)
  }
}

export function noteReconciledPickRoute(
  pickKey: string,
  token: number,
  requested: { model: string; provider: string },
  resolved: { model: string; provider: string },
  revision?: number
): void {
  const existing = reconciledRouteBySession.get(pickKey)

  if (existing && token < existing.token) {
    return
  }

  reconciledRouteBySession.set(pickKey, { requested, resolved, revision, token })
}

export function clearReconciledPickRoute(pickKey: string, token?: number): void {
  const existing = reconciledRouteBySession.get(pickKey)

  if (!existing || (token !== undefined && existing.token !== token)) {
    return
  }

  reconciledRouteBySession.delete(pickKey)
}

export function readReconciledPickRoute(
  pickKey: string,
  row: { model: string; provider: string }
): { model: string; provider: string } | undefined {
  const entry = reconciledRouteBySession.get(pickKey)

  if (
    !entry ||
    entry.requested.provider !== row.provider ||
    entry.requested.model.replace(/-fast$/, '') !== row.model.replace(/-fast$/, '')
  ) {
    return undefined
  }

  return entry.resolved
}

export function modelPickKey(
  sessionId: string,
  connectionId: null | string | undefined,
  profile: null | string | undefined,
  isActiveSource?: boolean
): string {
  const activeConn = activeGatewayConnectionId()
  const activeProfile = $activeGatewayProfile.get()

  const active =
    isActiveSource ??
    ((!connectionId || connectionId === activeConn) &&
      (!profile || normalizeProfileKey(profile) === normalizeProfileKey(activeProfile)))

  const owner = active
    ? getComposerSelectionScope()
    : composerScopeForOwner(connectionId || activeConn || 'local', profile || activeProfile)

  return `${owner}\n${sessionId}`
}

function newestAuthoritative(
  fromLedger: AuthoritativeModelState | undefined,
  fromSlice: AuthoritativeModelState | undefined
): AuthoritativeModelState | undefined {
  if (!fromLedger) {
    return fromSlice
  }

  if (!fromSlice) {
    return fromLedger
  }

  return fromSlice.revision > fromLedger.revision ? fromSlice : fromLedger
}

/** Register an optimistically painted pick on a live session. When picks overlap,
 *  the ledger keeps the last confirmed selection so an earlier pick failing later
 *  cannot roll back over a newer pick, and records the pre-pick revision so stale
 *  server frames cannot erase the paint or cause a rollback over a newer switch. */
export function beginModelPick(
  pickKey: string,
  before: ModelPickSnapshot,
  painted: ModelPickSnapshot,
  baseRevision?: number
): number {
  const token = ++nextPickToken
  let picks = picksBySession.get(pickKey)

  if (!picks) {
    picks = { confirmed: before, confirmedRevision: baseRevision, confirmedToken: 0, pending: [], shown: painted }
    picksBySession.set(pickKey, picks)
  } else {
    if (
      picks.authoritative &&
      baseRevision !== undefined &&
      baseRevision >= picks.authoritative.revision &&
      (picks.confirmedRevision === undefined || picks.authoritative.revision > picks.confirmedRevision)
    ) {
      picks.confirmed = before
      picks.confirmedPolicy = undefined
      picks.confirmedPolicyRevision = undefined
      picks.confirmedRevision = baseRevision
    }

    picks.shown = painted
  }

  picks.pending.push({ baseRevision, painted, token })
  latestPickBySession.set(pickKey, token)
  pickEpochBySession.set(pickKey, token)

  return token
}

export function isPickSuperseded(pickKey: string, token: number): boolean {
  const latest = latestPickBySession.get(pickKey)

  return latest !== undefined && latest !== token
}

function latestAuthoritativeBaseline(picks: SessionPicks): { model: string; provider: string } {
  return picks.authoritative &&
    (picks.confirmedRevision === undefined || picks.authoritative.revision > picks.confirmedRevision)
    ? picks.authoritative
    : picks.confirmed
}

function isOverwrittenByAuthoritative(
  picks: SessionPicks,
  latest: PendingPick,
  incomingRevision: number | undefined
): boolean {
  return (
    picks.authoritative !== undefined &&
    (latest.baseRevision === undefined || picks.authoritative.revision > latest.baseRevision) &&
    (incomingRevision === undefined || incomingRevision >= picks.authoritative.revision)
  )
}

/** Hold back an incoming model/provider frame that is at or behind the active
 *  in-flight pick's pre-pick revision, or is a `session.info` echo of the
 *  latest authoritative route after a non-model revision bump (e.g. rename/turn). */
export function shouldHoldBackSessionInfoModel(
  pickKey: string,
  incoming: { explicitModelMutation?: boolean; model?: string; provider?: string; revision?: number }
): boolean {
  const picks = picksBySession.get(pickKey)
  const latest = picks?.pending.at(-1)

  if (!picks || !latest) {
    return false
  }

  if (isOverwrittenByAuthoritative(picks, latest, incoming.revision)) {
    return false
  }

  if (typeof incoming.revision === 'number') {
    if (typeof latest.baseRevision === 'number' && incoming.revision <= latest.baseRevision) {
      return true
    }

    if (picks.confirmedRevision === incoming.revision && latest.token > picks.confirmedToken) {
      return true
    }

    if (incoming.explicitModelMutation) {
      return false
    }
  }

  const baseline = latestAuthoritativeBaseline(picks)
  const hasIncomingRoute = incoming.model !== undefined || incoming.provider !== undefined

  const echoesBaseline =
    hasIncomingRoute &&
    (incoming.model === undefined || incoming.model === baseline.model) &&
    (incoming.provider === undefined || incoming.provider === baseline.provider)

  const differsFromLatest =
    (incoming.model !== undefined && incoming.model !== latest.painted.model) ||
    (incoming.provider !== undefined && incoming.provider !== latest.painted.provider)

  return echoesBaseline && differsFromLatest
}

function policyMatchesConfirmedRoute(
  picks: SessionPicks,
  route: { model?: string; provider?: string } | undefined
): boolean {
  if (
    picks.authoritative &&
    (picks.confirmedRevision === undefined || picks.authoritative.revision > picks.confirmedRevision) &&
    (picks.authoritative.model !== picks.confirmed.model || picks.authoritative.provider !== picks.confirmed.provider)
  ) {
    return false
  }

  return (
    (route?.model === undefined || route.model === picks.confirmed.model) &&
    (route?.provider === undefined || route.provider === picks.confirmed.provider)
  )
}

/** Preserve newer authoritative policy changes on the pre-pick route while a
 *  different pick is pending so a rollback restores the latest policy without
 *  painting it onto the pending pick. */
export function noteHeldConfirmedPolicy(
  pickKey: string,
  revision: number,
  policy: AuthoritativePolicySnapshot,
  route?: { model?: string; provider?: string }
): void {
  const picks = picksBySession.get(pickKey)

  if (!picks || (picks.confirmedRevision !== undefined && revision <= picks.confirmedRevision)) {
    return
  }

  if (
    (picks.confirmedPolicyRevision !== undefined && revision < picks.confirmedPolicyRevision) ||
    !policyMatchesConfirmedRoute(picks, route)
  ) {
    return
  }

  const nextWire =
    policy.reasoningEffortWire !== undefined
      ? policy.reasoningEffortWire
      : policy.reasoningEffort !== undefined
        ? ''
        : undefined

  const hasFields =
    policy.fast !== undefined ||
    policy.reasoningEffort !== undefined ||
    nextWire !== undefined ||
    policy.serviceTier !== undefined

  if (!hasFields) {
    return
  }

  picks.confirmedPolicy = {
    ...(picks.confirmedPolicy ?? {}),
    ...(policy.fast !== undefined ? { fast: policy.fast } : {}),
    ...(policy.reasoningEffort !== undefined ? { reasoningEffort: policy.reasoningEffort } : {}),
    ...(nextWire !== undefined ? { reasoningEffortWire: nextWire } : {}),
    ...(policy.serviceTier !== undefined ? { serviceTier: policy.serviceTier } : {})
  }
  picks.confirmedPolicyRevision = revision
}

/** Record an authoritative model/provider revision that was applied to the slice
 *  while a pick is in flight, so a failed or timed-out pick fences its rollback. */
export function noteAuthoritativeModel(pickKey: string, authoritative: AuthoritativeModelState): void {
  const existingReconciled = reconciledRouteBySession.get(pickKey)

  if (existingReconciled) {
    const routeChanged =
      existingReconciled.resolved.model !== authoritative.model ||
      existingReconciled.resolved.provider !== authoritative.provider

    const explicitSupersede =
      Boolean(authoritative.explicitModelMutation) &&
      existingReconciled.revision !== undefined &&
      authoritative.revision > existingReconciled.revision

    if (routeChanged || explicitSupersede) {
      retireModelPickEpoch(pickKey, existingReconciled.token)
    }

    if (routeChanged) {
      reconciledRouteBySession.delete(pickKey)
    }
  }

  const picks = picksBySession.get(pickKey)

  if (!picks) {
    return
  }

  if (authoritative.explicitModelMutation) {
    picks.explicitModelRevision = Math.max(picks.explicitModelRevision ?? -1, authoritative.revision)
  }

  if (!picks.authoritative || authoritative.revision >= picks.authoritative.revision) {
    picks.authoritative =
      picks.authoritative?.revision === authoritative.revision
        ? {
            ...picks.authoritative,
            ...authoritative,
            reasoningEffortWire: authoritative.reasoningEffortWire ?? picks.authoritative.reasoningEffortWire
          }
        : authoritative
  }
}

function isReceiptBehindAuthoritative(
  settled: PendingPick,
  picks: SessionPicks,
  auth: AuthoritativeModelState | undefined,
  revision: number | undefined
): boolean {
  if (revision !== undefined) {
    const newerAuthRevision = Math.max(picks.confirmedRevision ?? -1, auth?.revision ?? -1)

    return newerAuthRevision > revision
  }

  return auth !== undefined && (settled.baseRevision === undefined || auth.revision > settled.baseRevision)
}

function recordConfirmedPick(
  picks: SessionPicks,
  settled: PendingPick,
  model: string,
  provider: string,
  revision: number | undefined
): void {
  const confirmed =
    model === settled.painted.model && provider === settled.painted.provider
      ? settled.painted
      : { ...settled.painted, model, provider }

  if (picks.shown === settled.painted) {
    picks.shown = confirmed
  }

  picks.confirmed = confirmed
  picks.confirmedPolicy = undefined
  picks.confirmedPolicyRevision = undefined
  picks.confirmedToken = settled.token
  picks.confirmedRevision = revision
}

function isPassiveSameRouteAdvance(
  picks: SessionPicks,
  settled: PendingPick,
  auth: AuthoritativeModelState,
  model: string,
  provider: string,
  revision: number
): boolean {
  const sameRoute = auth.model === model && auth.provider === provider
  const explicitSuperseded = picks.explicitModelRevision !== undefined && picks.explicitModelRevision > revision

  return sameRoute && !explicitSuperseded && settled.token >= picks.confirmedToken
}

function settleAppliedPick(
  picks: SessionPicks,
  settled: PendingPick,
  auth: AuthoritativeModelState | undefined,
  receipt: SettleModelPickOptions['receipt']
): ModelPickSettlement {
  const model = receipt?.model ?? settled.painted.model
  const provider = receipt?.provider ?? settled.painted.provider
  const revision = receipt?.revision

  if (!isReceiptBehindAuthoritative(settled, picks, auth, revision) && settled.token > picks.confirmedToken) {
    recordConfirmedPick(picks, settled, model, provider, revision)
  }

  if (picks.pending.some(entry => entry.token > settled.token)) {
    return { kind: 'keep', superseded: true }
  }

  if (revision !== undefined) {
    if (auth && auth.revision > revision) {
      return {
        kind: 'keep',
        superseded: !isPassiveSameRouteAdvance(picks, settled, auth, model, provider, revision)
      }
    }

    if (settled.token < picks.confirmedToken && !(auth && revision > auth.revision)) {
      return { kind: 'keep', superseded: true }
    }

    return { kind: 'reconcile', model, provider, revision }
  }

  if (
    settled.token < picks.confirmedToken ||
    (auth && (settled.baseRevision === undefined || auth.revision > settled.baseRevision))
  ) {
    return { kind: 'keep', superseded: true }
  }

  return { kind: 'reconcile', model, provider }
}

function settleUnappliedPick(
  pickKey: string,
  picks: SessionPicks,
  settled: PendingPick,
  auth: AuthoritativeModelState | undefined
): ModelPickSettlement {
  const activePending = picks.pending.filter(
    entry =>
      entry.token > picks.confirmedToken &&
      (!auth || (entry.baseRevision !== undefined && entry.baseRevision >= auth.revision))
  )

  if (activePending.length > 0) {
    const survivor = activePending.at(-1)!
    const target = survivor.painted

    if (target === picks.shown) {
      return { kind: 'keep' }
    }

    picks.shown = target
    // The surface is back on the surviving pick, so its trailing preset owns it again.
    pickEpochBySession.set(pickKey, survivor.token)

    return { kind: 'rollback', snapshot: target }
  }

  if (auth && (settled.baseRevision === undefined || auth.revision > settled.baseRevision)) {
    return { authoritative: auth, kind: 'overtaken' }
  }

  if (picks.confirmed === picks.shown) {
    return { kind: 'keep' }
  }

  picks.shown = picks.confirmed

  return {
    kind: 'rollback',
    policy: picks.confirmedPolicy,
    revision: picks.confirmedRevision,
    snapshot: picks.confirmed
  }
}

/** Settle a pick in the ledger and describe what the caller should repaint. */
export function settleModelPick(
  pickKey: string,
  token: number,
  applied: boolean,
  options?: SettleModelPickOptions
): ModelPickSettlement {
  const picks = picksBySession.get(pickKey)
  const index = picks ? picks.pending.findIndex(entry => entry.token === token) : -1

  if (!picks || index < 0) {
    return { kind: 'keep' }
  }

  const [settled] = picks.pending.splice(index, 1)
  const auth = newestAuthoritative(picks.authoritative, options?.liveAuthoritative)

  const outcome = applied
    ? settleAppliedPick(picks, settled, auth, options?.receipt)
    : settleUnappliedPick(pickKey, picks, settled, auth)

  if (picks.pending.length === 0) {
    picksBySession.delete(pickKey)
    latestPickBySession.delete(pickKey)
  }

  return outcome
}
