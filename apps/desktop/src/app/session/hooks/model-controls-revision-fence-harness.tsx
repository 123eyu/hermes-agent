// Shared live-session harness for the model-pick revision-fence tests: receipt and
// revision fencing, rollback fencing, and preset ownership across overlapping picks.
import type { GatewayEvent, ModelOptionsResult } from '@hermes/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { vi } from 'vitest'

import { CanonicalDesktopProtocol } from '@/api/canonical-protocol'
import { useModelMenuController } from '@/app/shell/use-model-menu-controller'
import { modelOptionsQueryKey } from '@/lib/model-options'
import { confirm } from '@/store/confirm'
import { $modelPresets } from '@/store/model-presets'
import { notifyError } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import {
  $activeSessionId,
  $defaultReasoningEffort,
  clearComposerSelectionOwner,
  setAwaitingResponse,
  setBusy,
  setConnection,
  setCurrentFastMode,
  setCurrentModel,
  setCurrentModelSource,
  setCurrentProvider,
  setCurrentReasoningEffort,
  setCurrentReasoningEffortWire,
  setCurrentServiceTier,
  setMessages
} from '@/store/session'
import { $sessionStates, type SessionTileDelegate, setSessionTileDelegate } from '@/store/session-states'

import { deferred } from '../../../test/deferred'

import { useMessageStream } from './use-message-stream'
import { useModelControls } from './use-model-controls'
import { useSessionStateCache } from './use-session-state-cache'

let sessionSeq = 0
export const A = { model: 'model-a', provider: 'provider-a' }
export const B = { model: 'model-b', provider: 'provider-b' }
export const C = { model: 'model-c', provider: 'provider-c' }
export const X = { model: 'model-x', provider: 'provider-x' }

const catalogFor = (row: typeof A): ModelOptionsResult => ({
  ...row,
  providers: [A, B, C, X].map(item => ({ models: [item.model], name: item.provider, slug: item.provider }))
})

interface PendingMutation {
  method: string
  prepared: Record<string, unknown>
  reply: ReturnType<typeof deferred<Record<string, unknown>>>
}

export function mountLiveEnvironment(initialRevision = 5) {
  const sid = `rev-fence-session-${++sessionSeq}`
  const otherSid = `rev-fence-other-${sessionSeq}`
  const tileSid = `rev-fence-tile-${sessionSeq}`
  $activeSessionId.set(sid)

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } }
  })

  const protocol = new CanonicalDesktopProtocol()
  const owner = { effort: 'ultra', generation: 2, model: A.model, provider: A.provider, revision: initialRevision }

  const mutations: Array<{
    expected_generation: unknown
    expected_revision: unknown
    operation: unknown
    payload: unknown
  }> = []

  const pendingModelReplies: PendingMutation[] = []

  const seedSession = (sessionId: string, row: typeof A, rev = initialRevision, wire = 'ultra') => {
    protocol.result(
      'session.resume',
      { session_id: sessionId },
      {
        execution_generation: owner.generation,
        info: { model: row.model, provider: row.provider, reasoning_effort: 'ultra', reasoning_effort_wire: wire },
        messages: [],
        prompts: [],
        revision: rev,
        running: false,
        session_id: sessionId
      }
    )
    queryClient.setQueryData(modelOptionsQueryKey('default', sessionId), catalogFor(row))
  }

  seedSession(sid, A, initialRevision, 'ultra')

  const requestGateway = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    if (method === 'model.options') {
      return catalogFor({ model: owner.model, provider: owner.provider }) as T
    }

    const prepared = protocol.prepare(method, params ?? {}) as Record<string, unknown>

    if (prepared.operation === 'model' || prepared.operation === 'reasoning') {
      mutations.push({
        expected_generation: prepared.expected_generation,
        expected_revision: prepared.expected_revision,
        operation: prepared.operation,
        payload: prepared.payload
      })

      if (prepared.operation === 'model') {
        const reply = deferred<Record<string, unknown>>()
        pendingModelReplies.push({ method, prepared, reply })

        try {
          const wire = await reply.promise

          return protocol.result(method, prepared, wire) as T
        } catch (err) {
          protocol.failure(prepared, err)
          throw err
        }
      }

      if (prepared.expected_revision !== owner.revision) {
        throw new Error('revision_conflict')
      }

      if (prepared.expected_generation !== owner.generation) {
        throw new Error('stale_generation')
      }

      const payload = prepared.payload as { effort: string }
      owner.effort = payload.effort
      owner.revision += 1
      owner.generation += 1

      return protocol.result(method, prepared, {
        effort: owner.effort,
        execution_generation: owner.generation,
        operation: 'reasoning',
        revision: owner.revision,
        session_id: prepared.session_id
      }) as T
    }

    throw new Error(`Unexpected RPC: ${method} ${JSON.stringify(params)}`)
  }

  const hook = renderHook(
    () => {
      const cache = useSessionStateCache({
        activeSessionId: $activeSessionId.get(),
        busyRef: useRef(false),
        selectedStoredSessionId: $activeSessionId.get(),
        setAwaitingResponse,
        setBusy,
        setMessages
      })

      const stream = useMessageStream({
        activeGatewayProfile: 'default',
        activeSessionIdRef: cache.activeSessionIdRef,
        hydrateFromStoredSession: vi.fn(async () => undefined),
        queryClient,
        refreshHermesConfig: vi.fn(async () => undefined),
        refreshSessions: vi.fn(async () => undefined),
        sessionStateByRuntimeIdRef: cache.sessionStateByRuntimeIdRef,
        updateSessionState: cache.updateSessionState
      })

      const controls = useModelControls({ queryClient, requestGateway })
      const menu = useModelMenuController({ onSelectModel: controls.selectModel, requestGateway })

      return { cache, controls, menu, stream }
    },
    { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> }
  )

  setSessionTileDelegate({ updateSession: hook.result.current.cache.updateSessionState } as SessionTileDelegate)

  const emitEvent = (event: GatewayEvent) => {
    protocol.event(event as Parameters<CanonicalDesktopProtocol['event']>[0])
    act(() => {
      hook.result.current.stream.handleGatewayEvent(event)
    })
  }

  emitEvent({
    payload: {
      execution_generation: owner.generation,
      model: A.model,
      provider: A.provider,
      reasoning_effort: 'ultra',
      reasoning_effort_wire: 'ultra',
      revision: initialRevision,
      running: false
    },
    session_id: sid,
    type: 'session.info'
  })

  const selectWithPreset = async (row: typeof B) => {
    const { controller, defaultEffort } = hook.result.current.menu
    const preset = controller.presetFor(row.provider, row.model)
    const pickToken = controller.beginSelect?.()
    const applied = await controller.select(row.model, row.provider, pickToken)

    if (applied !== false) {
      controller.applyPreset({ effort: preset.effort ?? defaultEffort }, row, pickToken)
    }

    return applied
  }

  return {
    ...hook,
    emitEvent,
    mutations,
    otherSid,
    owner,
    pendingModelReplies,
    protocol,
    queryClient,
    seedSession,
    selectWithPreset,
    sid,
    tileSid
  }
}

export function resetRevisionFenceState(): void {
  window.localStorage.clear()
  setConnection({ baseUrl: '', mode: 'local' } as never)
  $activeGatewayProfile.set('default')
  $activeSessionId.set(null)
  $defaultReasoningEffort.set('medium')
  $modelPresets.set({})
  $sessionStates.set({})
  setCurrentModel(A.model)
  setCurrentProvider(A.provider)
  setCurrentModelSource('default')
  setCurrentReasoningEffort('ultra')
  setCurrentReasoningEffortWire('ultra')
  setCurrentFastMode(false)
  setCurrentServiceTier('normal')
  vi.mocked(confirm).mockReset()
  vi.mocked(notifyError).mockReset()
}

export function cleanupRevisionFenceState(): void {
  cleanup()
  setSessionTileDelegate(null as unknown as SessionTileDelegate)
  clearComposerSelectionOwner()
  $activeSessionId.set(null)
  $sessionStates.set({})
  $modelPresets.set({})
  $defaultReasoningEffort.set('')
  setCurrentModel('')
  setCurrentProvider('')
  setCurrentModelSource('')
  setCurrentReasoningEffort('')
  setCurrentReasoningEffortWire('')
  setCurrentFastMode(false)
  setCurrentServiceTier('')
  setConnection(null)
  window.localStorage.clear()
}
