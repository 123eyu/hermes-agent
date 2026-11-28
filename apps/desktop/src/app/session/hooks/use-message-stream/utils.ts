import { type ChatMessage, chatMessageText, type GatewayEventPayload, textPart } from '@/lib/chat-messages'
import { normalizePersonalityValue } from '@/lib/chat-runtime'
import type { ErrorSurface } from '@/lib/error-surface'
import { isTodoToolName } from '@/lib/todos'

import type { ClientSessionState } from '../../../types'
import { noteAuthoritativeModel, noteHeldConfirmedPolicy, shouldHoldBackSessionInfoModel } from '../model-pick-ledger'

export type SessionRuntimeStatePatch = Partial<
  Pick<
    ClientSessionState,
    | 'branch'
    | 'cwd'
    | 'fast'
    | 'model'
    | 'modelRevision'
    | 'personality'
    | 'provider'
    | 'reasoningEffort'
    | 'reasoningEffortPending'
    | 'reasoningEffortWire'
    | 'revision'
    | 'serviceTier'
    | 'yolo'
  >
>

export function monotonicRevision(current: number | undefined, next: number | undefined): number | undefined {
  if (typeof next !== 'number') {
    return current
  }

  return current === undefined || next > current ? next : current
}

/** Model, policy and revision fields a frame older than the cached revision must not write. */
export const STALE_REVISION_PATCH_KEYS: readonly (keyof SessionRuntimeStatePatch)[] = [
  'model',
  'provider',
  'modelRevision',
  'revision',
  'reasoningEffort',
  'reasoningEffortPending',
  'reasoningEffortWire',
  'fast',
  'serviceTier'
]

/** Model and policy fields held back while an in-flight pick owns the slice; the revision still advances. */
export const HELD_MODEL_PATCH_KEYS: readonly (keyof SessionRuntimeStatePatch)[] = STALE_REVISION_PATCH_KEYS.filter(
  key => key !== 'revision'
)

export function stripPatchKeys(
  patch: SessionRuntimeStatePatch,
  keys: readonly (keyof SessionRuntimeStatePatch)[]
): void {
  for (const key of keys) {
    delete patch[key]
  }
}

/** Fence a runtime snapshot (`session.activate` / `session.resume` info) the way `session.info` is fenced:
 *  one older than the cached revision keeps out of the model, policy and revision fields, so a late
 *  snapshot can neither restore an older route nor lower the fence; one an in-flight pick holds back
 *  leaves that pick's paint alone but keeps its policy for the pick's rollback; an accepted route is
 *  recorded so a failed pick cannot roll back over it. */
export function fenceRuntimeSnapshotPatch(
  patch: SessionRuntimeStatePatch,
  known: Pick<ClientSessionState, 'model' | 'provider' | 'revision'> | undefined,
  pickKey: string
): void {
  const { model, provider, revision } = patch

  if (revision !== undefined && known?.revision !== undefined && revision < known.revision) {
    stripPatchKeys(patch, STALE_REVISION_PATCH_KEYS)
  } else if (shouldHoldBackSessionInfoModel(pickKey, { model, provider, revision })) {
    if (revision !== undefined) {
      const { fast, reasoningEffort, reasoningEffortWire, serviceTier } = patch
      noteHeldConfirmedPolicy(pickKey, revision, { fast, reasoningEffort, reasoningEffortWire, serviceTier }, patch)
    }

    stripPatchKeys(patch, HELD_MODEL_PATCH_KEYS)
  } else if (revision !== undefined && (model !== undefined || provider !== undefined)) {
    noteAuthoritativeModel(pickKey, {
      model: model ?? known?.model ?? '',
      provider: provider ?? known?.provider ?? '',
      reasoningEffortWire: patch.reasoningEffortWire,
      revision
    })
  }
}

export function sessionInfoStatePatch(payload: GatewayEventPayload | undefined): SessionRuntimeStatePatch {
  const patch: SessionRuntimeStatePatch = {}

  if (typeof payload?.model === 'string') {
    patch.model = payload.model || ''
  }

  if (typeof payload?.provider === 'string') {
    patch.provider = payload.provider || ''
  }

  if (typeof payload?.revision === 'number') {
    patch.revision = payload.revision

    if (typeof payload?.model === 'string' || typeof payload?.provider === 'string') {
      patch.modelRevision = payload.revision
    }
  }

  if (typeof payload?.cwd === 'string') {
    patch.cwd = payload.cwd
  }

  if (typeof payload?.branch === 'string') {
    patch.branch = payload.branch
  }

  if (typeof payload?.personality === 'string') {
    patch.personality = normalizePersonalityValue(payload.personality)
  }

  if (typeof payload?.reasoning_effort === 'string') {
    patch.reasoningEffort = payload.reasoning_effort
    patch.reasoningEffortPending = false
  }

  if (typeof payload?.reasoning_effort_wire === 'string') {
    patch.reasoningEffortWire = payload.reasoning_effort_wire
  }

  if (typeof payload?.service_tier === 'string') {
    patch.serviceTier = payload.service_tier
  }

  if (typeof payload?.fast === 'boolean') {
    patch.fast = payload.fast
  }

  if (typeof payload?.yolo === 'boolean') {
    patch.yolo = payload.yolo
  }

  return patch
}

export function hasSessionInfoStatePatch(patch: SessionRuntimeStatePatch): boolean {
  return Object.keys(patch).length > 0
}

const SESSION_INFO_PATCH_KEYS = [
  'branch',
  'cwd',
  'fast',
  'model',
  'personality',
  'provider',
  'reasoningEffort',
  'reasoningEffortWire',
  'serviceTier',
  'yolo'
] as const

function sessionInfoFieldsUnchanged(state: ClientSessionState, patch: SessionRuntimeStatePatch): boolean {
  for (const key of SESSION_INFO_PATCH_KEYS) {
    if (patch[key] !== undefined && patch[key] !== state[key]) {
      return false
    }
  }

  return (
    patch.reasoningEffortPending === undefined || patch.reasoningEffortPending === Boolean(state.reasoningEffortPending)
  )
}

/** Keep the runtime-state object when a heartbeat only restates cached fields.
 *  `$sessionStates` feeds every mounted session surface, so an equivalent spread
 *  re-renders them all at the heartbeat cadence. */
export function applySessionInfoStatePatch(
  state: ClientSessionState,
  patch: SessionRuntimeStatePatch
): ClientSessionState {
  const revision = monotonicRevision(state.revision, patch.revision)
  const modelRevision = monotonicRevision(state.modelRevision, patch.modelRevision)

  if (
    revision === state.revision &&
    modelRevision === state.modelRevision &&
    sessionInfoFieldsUnchanged(state, patch)
  ) {
    return state
  }

  return {
    ...state,
    ...patch,
    ...(revision !== undefined ? { revision } : {}),
    ...(modelRevision !== undefined ? { modelRevision } : {})
  }
}

// Minimum gap between two assistant-text flushes during a stream. Was 16ms
// (rAF only), which at typical LLM token rates of ~30-80 tok/sec meant every
// token got its own React commit + Streamdown markdown re-parse, scaling
// linearly with the growing last-block length. 33ms let ~2 tokens batch into
// one commit at 60 tok/sec. Raised again to 40ms (~25 visible text updates per
// second): a matched native reply in a 71-turn transcript measured ~20% less
// renderer scripting and ~12% less renderer task work at 40ms than at 33ms,
// with no overlap in the scripting ranges. Text growth stays smoother than the
// adaptive floor's worst case (4/s) and is visually indistinguishable from
// 30 fps at word-level token rates. See `scripts/profile-typing-lag.md` for the
// measurement work behind the original bump.
export const STREAM_DELTA_FLUSH_MS = 40

// Ceiling for the ADAPTIVE flush gap (see scheduleDeltaFlush). Under heavy
// multi-stream load the gap stretches to 3x the measured flush cost so the
// main thread stays responsive to input; this cap guarantees streaming text
// still visibly updates at least ~4x per second no matter the load.
export const MAX_STREAM_FLUSH_GAP_MS = 250

/**
 * Minimum gap before the next assistant-text flush.
 *
 * Visible: 30->25 fps text growth, stretched to 3x the measured flush cost so a
 * heavy commit never saturates the thread.
 *
 * Hidden and no voice consumer: nothing can paint, and the assistant-ui store
 * update + React commit still run on every flush. A hidden 300-word reply
 * measured ~2.3 s of renderer script with only layouts removed; batching at the
 * 4/s ceiling cuts the commits ~6x. Voice output (read-aloud, hands-free
 * conversation, dictation) deliberately keeps the responsive floor — its
 * consumers read the transcript on a timer, not from the screen.
 */
export function streamFlushFloor(measuredCostMs: number, hidden: boolean, voiceBusy: boolean): number {
  if (hidden && !voiceBusy) {
    return MAX_STREAM_FLUSH_GAP_MS
  }

  return Math.min(Math.max(STREAM_DELTA_FLUSH_MS, measuredCostMs * 3), MAX_STREAM_FLUSH_GAP_MS)
}

// How long an optimistically armed turn (busy/awaitingResponse set at submit /
// restore / edit, before the backend confirms it live) may hold off a
// session.info running=false heartbeat. Within this window a running=false is
// treated as a PRE-START report — the submit round trip hasn't finished, so
// settling on it would drop the spinner and reopen the send guard mid-flight.
// Past it, the gateway's running=false is authoritative: the turn never went
// live (rewind refused after the arm, gateway bounce, dropped submit response,
// missed terminal error event) and holding busy any longer latches the
// composer shut until app restart (#86795 — every send gets queued behind a
// turn that does not exist, and the queue drain waits on busy→false forever).
// Generous vs. the real pre-start gap: the busy-retry deadline is 6s and the
// backend flips running=true on accept, so heartbeats stop carrying false
// within a couple seconds of a healthy submit.
export const PRE_TURN_LIVE_SETTLE_GRACE_MS = 15_000

// Gateway/provider failures sometimes arrive as message.complete text instead
// of an explicit error event. Treat matches as inline assistant errors so they
// persist like real error events and don't get erased by hydrate fallback.
const COMPLETION_ERROR_PATTERNS = [
  /^API call failed after \d+ retries:/i,
  /^HTTP\s+\d{3}\b/i,
  /^(Provider|Gateway)\s+error:/i
]

// The text heuristic is for frames without a status: a turn the gateway
// reports complete is an answer, even one that starts "HTTP 200 OK".
export function completionErrorText(finalText: string, status?: string): string | null {
  const text = finalText.trim()

  return text && status !== 'complete' && COMPLETION_ERROR_PATTERNS.some(re => re.test(text)) ? text : null
}

// A provider safety-filter refusal (agent/error_classifier.py
// FailoverReason.content_policy_blocked). The gateway stamps it on the terminal
// message.complete frame as `failure_reason` and/or the error_surface `code`.
export const CONTENT_POLICY_REFUSAL_CODE = 'content_policy_blocked'

export function isContentPolicyRefusal(
  failure: { surface?: ErrorSurface | null } | undefined,
  failureReason: string | undefined
): boolean {
  return failureReason === CONTENT_POLICY_REFUSAL_CODE || failure?.surface?.code === CONTENT_POLICY_REFUSAL_CODE
}

/**
 * Replace a live safety-refused turn with the SAME greyed display row stored
 * hydration builds (toChatMessages for a `content_refused` row): the user's own
 * prompt — plus any assistant/tool rows it produced — collapse into ONE
 * non-interactive `system` row that carries the user's text and the
 * `contentRefused` marker. So an active chat shows the greyed block the instant
 * the refusal lands, not only after a reload. The live frame carries no notice
 * text, so the marker is left empty and the renderer fills the i18n fallback —
 * exactly what a stored row from an older backend does.
 */
export function replaceTurnWithContentRefused(messages: ChatMessage[], occurredAt: number): ChatMessage[] {
  const userIndex = messages.findLastIndex(message => message.role === 'user')

  if (userIndex < 0) {
    return messages
  }

  const prompt = messages[userIndex]

  const refused: ChatMessage = {
    id: `content-refused-${occurredAt}-${userIndex}`,
    role: 'system',
    parts: [textPart(chatMessageText(prompt), occurredAt)],
    timestamp: prompt.timestamp ?? occurredAt,
    completedAt: occurredAt,
    contentRefused: {},
    ...(prompt.rowId !== undefined ? { rowId: prompt.rowId } : {})
  }

  return [...messages.slice(0, userIndex), refused]
}

export const SUBAGENT_EVENT_TYPES = new Set([
  'subagent.spawn_requested',
  'subagent.start',
  'subagent.thinking',
  'subagent.tool',
  'subagent.progress',
  'subagent.complete'
])

// Anonymous progress events that carry todos but no name still belong to the
// todo stream; named todo events are obviously routed there too.
export function toTodoPayload(payload: GatewayEventPayload | undefined): GatewayEventPayload | undefined {
  if (!payload) {
    return undefined
  }

  const isTodo = isTodoToolName(payload.name) || (!payload.name && Object.hasOwn(payload, 'todos'))

  return isTodo ? { ...payload, name: 'todo_list', tool_id: payload.tool_id || 'todo-live' } : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function parseMaybeRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value))
    } catch {
      return {}
    }
  }

  return asRecord(value)
}

const firstString = (...candidates: unknown[]): string => {
  for (const v of candidates) {
    if (typeof v === 'string' && v) {
      return v
    }
  }

  return ''
}

export function delegateTaskPayloads(
  payload: GatewayEventPayload | undefined,
  phase: 'running' | 'complete',
  sourceEventType?: string
): Record<string, unknown>[] {
  if (payload?.name !== 'delegate_task') {
    return []
  }

  const args = parseMaybeRecord(payload.args ?? payload.input)
  const result = parseMaybeRecord(payload.result)
  const rawTasks = Array.isArray(args.tasks) ? args.tasks : []
  const tasks = rawTasks.length ? rawTasks.map(parseMaybeRecord) : [args]
  const resultStatus = typeof result.status === 'string' ? result.status.toLowerCase() : ''
  const failedResult = Boolean(payload.error) || ['timeout', 'error', 'failed', 'failure'].includes(resultStatus)
  const status = phase === 'complete' ? (failedResult ? 'failed' : 'completed') : 'running'
  const toolId = payload.tool_id || payload.tool_call_id || payload.id || 'delegate_task'
  const progressText = firstString(payload.preview, payload.message, payload.context)

  const eventType =
    phase === 'complete'
      ? 'subagent.complete'
      : sourceEventType === 'tool.start'
        ? 'subagent.start'
        : 'subagent.progress'

  return tasks.map((task, index) => {
    const goal = firstString(task.goal, args.goal, payload.context) || 'Delegated task'
    const summary = firstString(result.summary, payload.summary, payload.message)

    return {
      depth: 0,
      duration_seconds: payload.duration_s,
      goal,
      status,
      subagent_id: `delegate-tool:${toolId}:${index}`,
      summary: summary || undefined,
      task_count: tasks.length,
      task_index: index,
      text: eventType === 'subagent.progress' ? progressText || goal : undefined,
      tool_name: eventType === 'subagent.start' ? 'delegate_task' : undefined,
      tool_preview: eventType === 'subagent.start' ? progressText : undefined,
      toolsets: Array.isArray(task.toolsets) ? task.toolsets : Array.isArray(args.toolsets) ? args.toolsets : [],
      event_type: eventType,
      output_tail:
        phase === 'complete' && summary
          ? [{ is_error: Boolean(payload.error), preview: summary, tool: 'delegate_task' }]
          : undefined
    }
  })
}
