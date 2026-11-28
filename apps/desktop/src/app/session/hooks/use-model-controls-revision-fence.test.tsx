import type { GatewayEvent, ModelOptionsResult } from '@hermes/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CanonicalDesktopProtocol } from '@/api/canonical-protocol'
import { PRIMARY_SESSION_VIEW } from '@/app/chat/session-view'
import { useModelMenuController } from '@/app/shell/use-model-menu-controller'
import { modelOptionsQueryKey } from '@/lib/model-options'
import { confirm } from '@/store/confirm'
import { $modelPresets, getModelPreset, setModelPreset } from '@/store/model-presets'
import { notifyError } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import {
  $activeSessionId,
  $currentFastMode,
  $currentModel,
  $currentProvider,
  $currentReasoningEffort,
  $currentReasoningEffortWire,
  $currentServiceTier,
  $defaultReasoningEffort,
  clearComposerSelectionOwner,
  getComposerModelSelection,
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

vi.mock('@/store/notifications', () => ({ dismissNotification: vi.fn(), notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/store/confirm', () => ({ confirm: vi.fn() }))

let sessionSeq = 0
const A = { model: 'model-a', provider: 'provider-a' }
const B = { model: 'model-b', provider: 'provider-b' }
const C = { model: 'model-c', provider: 'provider-c' }
const X = { model: 'model-x', provider: 'provider-x' }

const catalogFor = (row: typeof A): ModelOptionsResult => ({
  ...row,
  providers: [A, B, C, X].map(item => ({ models: [item.model], name: item.provider, slug: item.provider }))
})

interface PendingMutation {
  method: string
  prepared: Record<string, unknown>
  reply: ReturnType<typeof deferred<Record<string, unknown>>>
}

function mountLiveEnvironment(initialRevision = 5) {
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

beforeEach(() => {
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
})

afterEach(() => {
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
})

describe('model pick revision fencing and receipt reconciliation', () => {
  it('keeps optimistic paint across a stale old-model session.info and applies preset from the receipt before confirming info', async () => {
    setModelPreset(B.provider, B.model, { effort: 'medium' })
    const h = mountLiveEnvironment(5)
    const invalidate = vi.spyOn(h.queryClient, 'invalidateQueries')

    let pick!: Promise<boolean | void>

    act(() => {
      pick = h.selectWithPreset(B)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(B.provider)

    h.emitEvent({
      payload: {
        execution_generation: 2,
        model: A.model,
        provider: A.provider,
        reasoning_effort: 'ultra',
        reasoning_effort_wire: 'ultra',
        revision: 5,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(B.provider)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffortWire.get()).toBe('')
    expect(invalidate).not.toHaveBeenCalled()

    h.owner.model = B.model
    h.owner.provider = B.provider
    h.owner.revision = 6
    h.owner.generation = 3

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        execution_generation: 3,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 6,
        session_id: h.sid
      })
      await expect(pick).resolves.toBe(true)
    })

    await waitFor(() => expect(h.owner.effort).toBe('medium'))
    expect(h.mutations.filter(m => m.operation === 'reasoning')).toEqual([
      {
        expected_generation: 3,
        expected_revision: 6,
        operation: 'reasoning',
        payload: { effort: 'medium' }
      }
    ])

    h.emitEvent({
      payload: {
        execution_generation: 2,
        model: A.model,
        provider: A.provider,
        reasoning_effort: 'ultra',
        reasoning_effort_wire: 'ultra',
        revision: 5,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(B.provider)

    h.queryClient.clear()
  })

  it('reconciles the slice from the success receipt even if an intermediate newer-revision external switch painted first', async () => {
    setModelPreset(B.provider, B.model, { effort: 'low' })
    const h = mountLiveEnvironment(5)

    let pick!: Promise<boolean | void>

    act(() => {
      pick = h.selectWithPreset(B)
    })

    h.emitEvent({
      payload: {
        execution_generation: 2,
        model: X.model,
        provider: X.provider,
        revision: 6,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(X.model)

    h.owner.model = B.model
    h.owner.provider = B.provider
    h.owner.revision = 7
    h.owner.generation = 3

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        execution_generation: 3,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 7,
        session_id: h.sid
      })
      await expect(pick).resolves.toBe(true)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(B.provider)
    await waitFor(() => expect(h.owner.effort).toBe('low'))

    h.queryClient.clear()
  })

  it('does not roll back slice, runtime globals, or model.options cache over another surface switch when a pick fails', async () => {
    const h = mountLiveEnvironment(5)

    let pick!: Promise<boolean>

    act(() => {
      pick = h.result.current.controls.selectModel(B)
    })

    h.owner.model = X.model
    h.owner.provider = X.provider
    h.owner.revision = 6
    h.owner.generation = 3

    h.emitEvent({
      payload: {
        execution_generation: 3,
        model: X.model,
        provider: X.provider,
        reasoning_effort: 'low',
        reasoning_effort_wire: 'low',
        revision: 6,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    await act(async () => {
      h.pendingModelReplies[0].reply.reject(
        Object.assign(new Error('revision_conflict'), {
          data: { execution_generation: 3, reason: 'revision_conflict', revision: 6 }
        })
      )
      await expect(pick).resolves.toBe(false)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(X.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(X.provider)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffortWire.get()).toBe('low')
    expect($currentModel.get()).toBe(X.model)
    expect($currentProvider.get()).toBe(X.provider)
    expect($currentReasoningEffortWire.get()).toBe('low')
    expect(h.queryClient.getQueryData<ModelOptionsResult>(modelOptionsQueryKey('default', h.sid))).toMatchObject(X)
    expect(getComposerModelSelection().source).toBe('default')

    h.queryClient.clear()
  })

  it('fences tile rollback when another surface switches via session.updated before session.info arrives', async () => {
    const h = mountLiveEnvironment(5)
    h.seedSession(h.tileSid, A, 5, 'high')
    h.emitEvent({
      payload: {
        execution_generation: 2,
        model: A.model,
        provider: A.provider,
        reasoning_effort_wire: 'high',
        revision: 5,
        running: false
      },
      session_id: h.tileSid,
      type: 'session.info'
    })

    let tilePick!: Promise<boolean>

    act(() => {
      tilePick = h.result.current.controls.selectModel({ ...B, sessionId: h.tileSid })
    })

    h.emitEvent({
      payload: {
        execution_generation: 3,
        model: X.model,
        operation: 'model',
        provider: X.provider,
        revision: 6,
        session_id: h.tileSid
      },
      session_id: h.tileSid,
      type: 'session.updated' as GatewayEvent['type']
    })

    await act(async () => {
      h.pendingModelReplies[0].reply.reject(
        Object.assign(new Error('revision_conflict'), {
          data: { execution_generation: 3, reason: 'revision_conflict', revision: 6 }
        })
      )
      await expect(tilePick).resolves.toBe(false)
    })

    expect($sessionStates.get()[h.tileSid]).toMatchObject({ model: X.model, provider: X.provider })
    expect(h.queryClient.getQueryData<ModelOptionsResult>(modelOptionsQueryKey('default', h.tileSid))).toMatchObject(X)
    expect($currentModel.get()).toBe(A.model)
    expect($currentProvider.get()).toBe(A.provider)

    h.queryClient.clear()
  })

  it('does not roll back a pick whose RPC timed out after the owner already committed it', async () => {
    const h = mountLiveEnvironment(5)

    let pick!: Promise<boolean>

    act(() => {
      pick = h.result.current.controls.selectModel(B)
    })

    h.emitEvent({
      payload: {
        execution_generation: 3,
        model: B.model,
        provider: B.provider,
        reasoning_effort_wire: 'medium',
        revision: 6,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    await act(async () => {
      h.pendingModelReplies[0].reply.reject(new Error('request timed out after 30s: session.mutate'))
      await expect(pick).resolves.toBe(false)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(B.provider)
    expect($currentModel.get()).toBe(B.model)
    expect($currentProvider.get()).toBe(B.provider)
    expect(h.queryClient.getQueryData<ModelOptionsResult>(modelOptionsQueryKey('default', h.sid))).toMatchObject(B)
    expect(getComposerModelSelection()).toMatchObject({ model: B.model, provider: B.provider, source: 'manual' })
    expect(notifyError).not.toHaveBeenCalled()

    h.queryClient.clear()
  })

  it('rolls back a newer failed pick to an intervening external switch rather than the pre-switch model while an older pick is still in flight', async () => {
    const h = mountLiveEnvironment(5)

    let olderPick!: Promise<boolean>

    act(() => {
      olderPick = h.result.current.controls.selectModel(B)
    })

    h.owner.model = X.model
    h.owner.provider = X.provider
    h.owner.revision = 6
    h.owner.generation = 3

    h.emitEvent({
      payload: {
        execution_generation: 3,
        model: X.model,
        provider: X.provider,
        reasoning_effort_wire: 'low',
        revision: 6,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    let newerPick!: Promise<boolean>

    act(() => {
      newerPick = h.result.current.controls.selectModel(C)
    })

    await act(async () => {
      h.pendingModelReplies[1].reply.reject(new Error('provider rejected'))
      await expect(newerPick).resolves.toBe(false)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(X.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(X.provider)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffortWire.get()).toBe('low')
    expect($currentModel.get()).toBe(X.model)
    expect($currentProvider.get()).toBe(X.provider)

    await act(async () => {
      h.pendingModelReplies[0].reply.reject(new Error('revision_conflict'))
      await expect(olderPick).resolves.toBe(false)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(X.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(X.provider)

    h.queryClient.clear()
  })

  it('still rolls back a failed pick when only a non-model revision update arrived mid-flight', async () => {
    const h = mountLiveEnvironment(5)

    let pick!: Promise<boolean>

    act(() => {
      pick = h.result.current.controls.selectModel(B)
    })

    h.emitEvent({
      payload: { operation: 'rename', revision: 6, session_id: h.sid, title: 'Renamed' },
      session_id: h.sid,
      type: 'session.updated' as GatewayEvent['type']
    })
    h.emitEvent({
      payload: {
        execution_generation: 2,
        model: A.model,
        pending: [],
        provider: A.provider,
        reasoning_effort: 'ultra',
        reasoning_effort_wire: 'ultra',
        revision: 6,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)
    expect($sessionStates.get()[h.sid]?.revision).toBe(6)

    await act(async () => {
      h.pendingModelReplies[0].reply.reject(new Error('model_resolution_failed'))
      await expect(pick).resolves.toBe(false)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(A.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(A.provider)
    expect($currentModel.get()).toBe(A.model)
    expect($currentProvider.get()).toBe(A.provider)
    expect(h.queryClient.getQueryData<ModelOptionsResult>(modelOptionsQueryKey('default', h.sid))).toMatchObject(A)

    h.queryClient.clear()
  })

  it('restores the abandoned session model.options cache when a moved-away pick fails', async () => {
    const h = mountLiveEnvironment(5)
    h.seedSession(h.otherSid, C, 1, 'low')

    let pick!: Promise<boolean>

    act(() => {
      pick = h.result.current.controls.selectModel(B)
    })

    expect(h.queryClient.getQueryData<ModelOptionsResult>(modelOptionsQueryKey('default', h.sid))).toMatchObject(B)

    act(() => {
      $activeSessionId.set(h.otherSid)
    })
    h.rerender()

    await act(async () => {
      h.pendingModelReplies[0].reply.reject(new Error('no such model'))
      await expect(pick).resolves.toBe(false)
    })

    expect($sessionStates.get()[h.sid]).toMatchObject(A)
    expect(h.queryClient.getQueryData<ModelOptionsResult>(modelOptionsQueryKey('default', h.sid))).toMatchObject(A)
    expect(getComposerModelSelection().source).toBe('default')

    h.queryClient.clear()
  })

  it('releases the saved new-chat pick and restores session cache when a confirmed retry fails after navigation', async () => {
    const h = mountLiveEnvironment(5)
    h.seedSession(h.otherSid, C, 1, 'low')
    vi.mocked(confirm).mockResolvedValueOnce(true)

    let firstPick!: Promise<boolean>

    act(() => {
      firstPick = h.result.current.controls.selectModel(B)
    })

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        confirm: 'tok-1',
        confirm_message: 'Expensive model',
        operation: 'model',
        session_id: h.sid,
        status: 'confirmation_required'
      })
      await expect(firstPick).resolves.toBe(false)
    })

    await waitFor(() => expect(h.pendingModelReplies).toHaveLength(2))
    expect(getComposerModelSelection()).toMatchObject({ model: B.model, provider: B.provider, source: 'manual' })
    expect(h.queryClient.getQueryData<ModelOptionsResult>(modelOptionsQueryKey('default', h.sid))).toMatchObject(B)

    act(() => {
      $activeSessionId.set(h.otherSid)
    })
    h.rerender()

    await act(async () => {
      h.pendingModelReplies[1].reply.reject(new Error('provider rejected'))
    })

    await waitFor(() => expect($sessionStates.get()[h.sid]).toMatchObject(A))
    expect(h.queryClient.getQueryData<ModelOptionsResult>(modelOptionsQueryKey('default', h.sid))).toMatchObject(A)
    expect(getComposerModelSelection().source).toBe('default')

    h.queryClient.clear()
  })

  it('does not paint an older pick preset onto a newer pick slice when the older pick settles second', async () => {
    setModelPreset(B.provider, B.model, { effort: 'low' })
    setModelPreset(C.provider, C.model, { effort: 'high' })
    const h = mountLiveEnvironment(5)

    let older!: Promise<boolean | void>
    let newer!: Promise<boolean | void>

    act(() => {
      older = h.selectWithPreset(B)
    })

    act(() => {
      newer = h.selectWithPreset(C)
    })

    h.owner.model = C.model
    h.owner.provider = C.provider
    h.owner.revision = 6
    h.owner.generation = 3

    await act(async () => {
      h.pendingModelReplies[1].reply.resolve({
        execution_generation: 3,
        model: C.model,
        operation: 'model',
        provider: C.provider,
        revision: 6,
        session_id: h.sid
      })
      await expect(newer).resolves.toBe(true)
    })

    await waitFor(() => expect(h.owner.effort).toBe('high'))
    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('high')
    expect($currentReasoningEffort.get()).toBe('high')

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        execution_generation: 3,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 5,
        session_id: h.sid
      })
      await expect(older).resolves.toBe(true)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(C.model)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('high')
    expect($currentReasoningEffort.get()).toBe('high')
    expect(h.mutations.filter(m => m.operation === 'reasoning').map(m => m.payload)).toEqual([{ effort: 'high' }])

    h.queryClient.clear()
  })

  it('rejects a late B@6 receipt as rollback baseline when a pick started from newer external switch X@7 fails', async () => {
    const h = mountLiveEnvironment(5)

    let pickB!: Promise<boolean>

    act(() => {
      pickB = h.result.current.controls.selectModel(B)
    })

    h.owner.model = X.model
    h.owner.provider = X.provider
    h.owner.revision = 7
    h.owner.generation = 4

    h.emitEvent({
      payload: {
        execution_generation: 4,
        model: X.model,
        provider: X.provider,
        reasoning_effort_wire: 'low',
        revision: 7,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    let pickC!: Promise<boolean>

    act(() => {
      pickC = h.result.current.controls.selectModel(C)
    })

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        execution_generation: 3,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 6,
        session_id: h.sid
      })
      await expect(pickB).resolves.toBe(true)
    })

    await act(async () => {
      h.pendingModelReplies[1].reply.reject(new Error('provider rejected'))
      await expect(pickC).resolves.toBe(false)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(X.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(X.provider)
    expect($sessionStates.get()[h.sid]).toMatchObject({
      model: X.model,
      modelRevision: 7,
      provider: X.provider,
      revision: 7
    })
    expect($currentModel.get()).toBe(X.model)
    expect($currentProvider.get()).toBe(X.provider)
    expect(h.queryClient.getQueryData<ModelOptionsResult>(modelOptionsQueryKey('default', h.sid))).toMatchObject(X)

    h.queryClient.clear()
  })

  it('keeps pending paint and still opens confirmation dialog after a full canonical session.info echoes A on a non-model revision bump', async () => {
    const h = mountLiveEnvironment(5)
    vi.mocked(confirm).mockResolvedValueOnce(false)

    let pick!: Promise<boolean>

    act(() => {
      pick = h.result.current.controls.selectModel(B)
    })

    h.emitEvent({
      payload: {
        execution_generation: 2,
        model: A.model,
        provider: A.provider,
        reasoning_effort: 'ultra',
        reasoning_effort_wire: 'ultra',
        revision: 6,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)
    expect($sessionStates.get()[h.sid]?.revision).toBe(6)

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        confirm: 'tok-rename',
        confirm_message: 'Expensive model',
        operation: 'model',
        session_id: h.sid,
        status: 'confirmation_required'
      })
      await expect(pick).resolves.toBe(false)
    })

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(A.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(A.provider)

    h.queryClient.clear()
  })

  it('drops an older B pick preset in B -> C -> B when the first B resolves after the second B', async () => {
    setModelPreset(B.provider, B.model, { effort: 'low' })
    setModelPreset(C.provider, C.model, { effort: 'medium' })
    const h = mountLiveEnvironment(5)

    let firstB!: Promise<boolean | void>
    let pickC!: Promise<boolean | void>
    let secondB!: Promise<boolean | void>

    act(() => {
      firstB = h.selectWithPreset(B)
    })

    act(() => {
      pickC = h.selectWithPreset(C)
    })

    act(() => {
      setModelPreset(B.provider, B.model, { effort: 'high' })
    })

    act(() => {
      secondB = h.selectWithPreset(B)
    })

    h.owner.model = B.model
    h.owner.provider = B.provider
    h.owner.revision = 6
    h.owner.generation = 3

    await act(async () => {
      h.pendingModelReplies[2].reply.resolve({
        execution_generation: 3,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 6,
        session_id: h.sid
      })
      await expect(secondB).resolves.toBe(true)
    })

    await waitFor(() => expect(h.owner.effort).toBe('high'))

    await act(async () => {
      h.pendingModelReplies[1].reply.reject(new Error('revision_conflict'))
      await expect(pickC).resolves.toBe(false)
    })

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        execution_generation: 3,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 5,
        session_id: h.sid
      })
      await expect(firstB).resolves.toBe(true)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('high')
    expect($currentReasoningEffort.get()).toBe('high')
    expect(h.mutations.filter(m => m.operation === 'reasoning').map(m => m.payload)).toEqual([{ effort: 'high' }])

    h.queryClient.clear()
  })

  it('applies the model preset under the catalog row key when the receipt reconciles provider slug or model alias', async () => {
    const catalogRow = { model: 'sonnet-alias', provider: 'my-custom' }
    const resolvedRow = { model: 'claude-sonnet-4-6', provider: 'custom:my-custom' }
    setModelPreset(catalogRow.provider, catalogRow.model, { effort: 'high' })
    const h = mountLiveEnvironment(5)

    let pick!: Promise<boolean | void>

    act(() => {
      pick = h.selectWithPreset(catalogRow)
    })

    h.owner.model = resolvedRow.model
    h.owner.provider = resolvedRow.provider
    h.owner.revision = 6
    h.owner.generation = 3

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        execution_generation: 3,
        model: resolvedRow.model,
        operation: 'model',
        provider: resolvedRow.provider,
        revision: 6,
        session_id: h.sid
      })
      await expect(pick).resolves.toBe(true)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(resolvedRow.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(resolvedRow.provider)
    await waitFor(() => expect(h.owner.effort).toBe('high'))
    expect(getModelPreset(catalogRow.provider, catalogRow.model)).toMatchObject({ effort: 'high' })

    h.queryClient.clear()
  })

  it('suppresses the failure toast when a confirmed retry times out after the owner already committed it', async () => {
    const h = mountLiveEnvironment(5)
    vi.mocked(confirm).mockResolvedValueOnce(true)

    let firstPick!: Promise<boolean>

    act(() => {
      firstPick = h.result.current.controls.selectModel(B)
    })

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        confirm: 'tok-timeout',
        confirm_message: 'Expensive model',
        operation: 'model',
        session_id: h.sid,
        status: 'confirmation_required'
      })
      await expect(firstPick).resolves.toBe(false)
    })

    await waitFor(() => expect(h.pendingModelReplies).toHaveLength(2))

    h.owner.model = B.model
    h.owner.provider = B.provider
    h.owner.revision = 6
    h.owner.generation = 3

    h.emitEvent({
      payload: {
        execution_generation: 3,
        model: B.model,
        provider: B.provider,
        reasoning_effort_wire: 'medium',
        revision: 6,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    await act(async () => {
      h.pendingModelReplies[1].reply.reject(new Error('request timed out after 30s: session.mutate'))
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(B.provider)
    expect($currentModel.get()).toBe(B.model)
    expect($currentProvider.get()).toBe(B.provider)
    expect(getComposerModelSelection()).toMatchObject({ model: B.model, provider: B.provider, source: 'manual' })
    expect(notifyError).not.toHaveBeenCalled()

    h.queryClient.clear()
  })

  it('holds back model-dependent policy fields on a same-revision pre-pick session.info', async () => {
    const h = mountLiveEnvironment(5)

    act(() => {
      void h.result.current.controls.selectModel(B)
      setCurrentReasoningEffort('low')
      setCurrentFastMode(false)
      setCurrentServiceTier('normal')
      h.result.current.cache.updateSessionState(h.sid, state => ({
        ...state,
        fast: false,
        reasoningEffort: 'low',
        serviceTier: 'normal'
      }))
    })

    h.emitEvent({
      payload: {
        execution_generation: 2,
        fast: true,
        model: A.model,
        provider: A.provider,
        reasoning_effort: 'ultra',
        reasoning_effort_wire: 'ultra',
        revision: 5,
        running: false,
        service_tier: 'priority'
      },
      session_id: h.sid,
      type: 'session.info'
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('low')
    expect(PRIMARY_SESSION_VIEW.$fast.get()).toBe(false)
    expect(PRIMARY_SESSION_VIEW.$serviceTier?.get()).toBe('normal')
    expect($currentReasoningEffort.get()).toBe('low')
    expect($currentFastMode.get()).toBe(false)
    expect($currentServiceTier.get()).toBe('normal')

    h.owner.model = B.model
    h.owner.provider = B.provider
    h.owner.revision = 6

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        execution_generation: 3,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 6,
        session_id: h.sid
      })
    })

    h.queryClient.clear()
  })

  it('accepts an external A -> X -> A switch while B is pending instead of treating the final A as an echo', async () => {
    const h = mountLiveEnvironment(5)

    let pickB!: Promise<boolean>

    act(() => {
      pickB = h.result.current.controls.selectModel(B)
    })

    h.emitEvent({
      payload: {
        execution_generation: 3,
        model: X.model,
        provider: X.provider,
        reasoning_effort_wire: 'low',
        revision: 6,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(X.model)

    h.owner.model = A.model
    h.owner.provider = A.provider
    h.owner.revision = 7
    h.owner.generation = 4

    h.emitEvent({
      payload: {
        execution_generation: 4,
        model: A.model,
        provider: A.provider,
        reasoning_effort_wire: 'medium',
        revision: 7,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(A.model)
    expect($sessionStates.get()[h.sid]).toMatchObject({ model: A.model, modelRevision: 7, revision: 7 })

    await act(async () => {
      h.pendingModelReplies[0].reply.reject(new Error('revision_conflict'))
      await expect(pickB).resolves.toBe(false)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(A.model)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffortWire.get()).toBe('medium')

    h.queryClient.clear()
  })

  it('drops a late menu B preset when C and a second B were selected directly through useModelControls (overlay path)', async () => {
    setModelPreset(B.provider, B.model, { effort: 'low' })
    const h = mountLiveEnvironment(5)

    let firstMenuB!: Promise<boolean | void>
    let overlayC!: Promise<boolean>
    let overlayB!: Promise<boolean>

    act(() => {
      firstMenuB = h.selectWithPreset(B)
    })

    act(() => {
      overlayC = h.result.current.controls.selectModel(C)
    })

    act(() => {
      overlayB = h.result.current.controls.selectModel(B)
    })

    h.owner.model = B.model
    h.owner.provider = B.provider
    h.owner.revision = 6
    h.owner.generation = 3

    await act(async () => {
      h.pendingModelReplies[2].reply.resolve({
        execution_generation: 3,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 6,
        session_id: h.sid
      })
      await expect(overlayB).resolves.toBe(true)
    })

    act(() => {
      setCurrentReasoningEffort('high')
      h.result.current.cache.updateSessionState(h.sid, state => ({ ...state, reasoningEffort: 'high' }))
    })

    await act(async () => {
      h.pendingModelReplies[1].reply.reject(new Error('revision_conflict'))
      await expect(overlayC).resolves.toBe(false)
    })

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        execution_generation: 3,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 5,
        session_id: h.sid
      })
      await expect(firstMenuB).resolves.toBe(true)
    })

    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('high')
    expect($currentReasoningEffort.get()).toBe('high')
    expect(h.mutations.filter(m => m.operation === 'reasoning')).toEqual([])

    h.queryClient.clear()
  })

  it('keeps a newer reconciled alias mapping when an older pick settles as keep so subsequent option edits reach the session', async () => {
    const catalogRow = { model: 'sonnet-alias', provider: 'my-custom' }
    const resolvedRow = { model: 'claude-sonnet-4-6', provider: 'custom:my-custom' }
    const h = mountLiveEnvironment(5)

    let olderPick!: Promise<boolean>
    let aliasPick!: Promise<boolean>

    act(() => {
      olderPick = h.result.current.controls.selectModel(B)
    })

    act(() => {
      aliasPick = h.result.current.controls.selectModel(catalogRow)
    })

    h.owner.model = resolvedRow.model
    h.owner.provider = resolvedRow.provider
    h.owner.revision = 6
    h.owner.generation = 3

    await act(async () => {
      h.pendingModelReplies[1].reply.resolve({
        execution_generation: 3,
        model: resolvedRow.model,
        operation: 'model',
        provider: resolvedRow.provider,
        revision: 6,
        session_id: h.sid
      })
      await expect(aliasPick).resolves.toBe(true)
    })

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        execution_generation: 2,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 5,
        session_id: h.sid
      })
      await expect(olderPick).resolves.toBe(true)
    })

    act(() => {
      h.result.current.menu.controller.setOptions({ effort: 'high' }, { isActive: true, ...catalogRow })
    })

    await waitFor(() => expect(h.owner.effort).toBe('high'))
    expect(h.mutations.filter(m => m.operation === 'reasoning').map(m => m.payload)).toEqual([{ effort: 'high' }])

    h.queryClient.clear()
  })

  it('still surfaces a failure toast when a confirmed retry gets a definitive rejection even if another surface already selected the same route', async () => {
    const h = mountLiveEnvironment(5)
    vi.mocked(confirm).mockResolvedValueOnce(true)

    let firstPick!: Promise<boolean>

    act(() => {
      firstPick = h.result.current.controls.selectModel(B)
    })

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        confirm: 'tok-definitive',
        confirm_message: 'Expensive model',
        operation: 'model',
        session_id: h.sid,
        status: 'confirmation_required'
      })
      await expect(firstPick).resolves.toBe(false)
    })

    await waitFor(() => expect(h.pendingModelReplies).toHaveLength(2))

    h.owner.model = B.model
    h.owner.provider = B.provider
    h.owner.revision = 6
    h.owner.generation = 3

    h.emitEvent({
      payload: {
        execution_generation: 3,
        model: B.model,
        provider: B.provider,
        reasoning_effort_wire: 'medium',
        revision: 6,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    await act(async () => {
      h.pendingModelReplies[1].reply.reject(new Error('revision_conflict'))
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe(B.provider)
    expect(notifyError).toHaveBeenCalledTimes(1)

    h.queryClient.clear()
  })

  it('preserves a newer authoritative policy change on A for rollback without painting it onto pending B', async () => {
    const h = mountLiveEnvironment(5)

    let pickB!: Promise<boolean>

    act(() => {
      pickB = h.result.current.controls.selectModel(B)
    })

    h.emitEvent({
      payload: {
        execution_generation: 2,
        fast: true,
        model: A.model,
        provider: A.provider,
        reasoning_effort: 'low',
        reasoning_effort_wire: 'low',
        revision: 6,
        running: false,
        service_tier: 'priority'
      },
      session_id: h.sid,
      type: 'session.info'
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('ultra')
    expect(PRIMARY_SESSION_VIEW.$fast.get()).toBe(false)

    await act(async () => {
      h.pendingModelReplies[0].reply.reject(new Error('model_resolution_failed'))
      await expect(pickB).resolves.toBe(false)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(A.model)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('low')
    expect(PRIMARY_SESSION_VIEW.$reasoningEffortWire.get()).toBe('low')
    expect(PRIMARY_SESSION_VIEW.$fast.get()).toBe(true)
    expect(PRIMARY_SESSION_VIEW.$serviceTier?.get()).toBe('priority')
    expect($currentReasoningEffort.get()).toBe('low')
    expect($currentReasoningEffortWire.get()).toBe('low')
    expect($currentFastMode.get()).toBe(true)
    expect($currentServiceTier.get()).toBe('priority')

    h.queryClient.clear()
  })

  it('picks echo baseline by revision so C@8 rename does not erase pending D after X@6 event and C@7 receipt', async () => {
    const D = { model: 'model-d', provider: 'provider-d' }
    const h = mountLiveEnvironment(5)

    let pickB!: Promise<boolean>

    act(() => {
      pickB = h.result.current.controls.selectModel(B)
    })

    h.emitEvent({
      payload: {
        execution_generation: 3,
        model: X.model,
        provider: X.provider,
        revision: 6,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    let pickC!: Promise<boolean>
    let pickD!: Promise<boolean>

    act(() => {
      pickC = h.result.current.controls.selectModel(C)
    })

    act(() => {
      pickD = h.result.current.controls.selectModel(D)
    })

    await act(async () => {
      h.pendingModelReplies[1].reply.resolve({
        execution_generation: 4,
        model: C.model,
        operation: 'model',
        provider: C.provider,
        revision: 7,
        session_id: h.sid
      })
      await expect(pickC).resolves.toBe(true)
    })

    h.emitEvent({
      payload: {
        execution_generation: 4,
        model: C.model,
        provider: C.provider,
        revision: 8,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(D.model)
    expect($sessionStates.get()[h.sid]?.revision).toBe(8)

    await act(async () => {
      h.pendingModelReplies[0].reply.reject(new Error('revision_conflict'))
      await expect(pickB).resolves.toBe(false)
      h.pendingModelReplies[2].reply.resolve({
        execution_generation: 5,
        model: D.model,
        operation: 'model',
        provider: D.provider,
        revision: 9,
        session_id: h.sid
      })
      await expect(pickD).resolves.toBe(true)
    })

    h.queryClient.clear()
  })

  it('drops a menu B preset when a newer external commit of B already superseded the settling receipt', async () => {
    setModelPreset(B.provider, B.model, { effort: 'low' })
    const h = mountLiveEnvironment(5)

    let localB!: Promise<boolean | void>

    act(() => {
      localB = h.selectWithPreset(B)
    })

    h.owner.model = B.model
    h.owner.provider = B.provider
    h.owner.effort = 'high'
    h.owner.revision = 7
    h.owner.generation = 4

    h.emitEvent({
      payload: {
        execution_generation: 4,
        model: B.model,
        provider: B.provider,
        reasoning_effort: 'high',
        reasoning_effort_wire: 'high',
        revision: 7,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    h.emitEvent({
      payload: {
        effort: 'high',
        execution_generation: 4,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 7,
        session_id: h.sid
      },
      session_id: h.sid,
      type: 'session.updated' as GatewayEvent['type']
    })

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        execution_generation: 3,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 6,
        session_id: h.sid
      })
      await expect(localB).resolves.toBe(true)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('high')
    expect($currentReasoningEffort.get()).toBe('high')
    expect(h.mutations.filter(m => m.operation === 'reasoning')).toEqual([])

    h.queryClient.clear()
  })

  it('discards held policy from A when the rollback baseline rebases onto newer external switch X', async () => {
    const h = mountLiveEnvironment(5)

    let pickB!: Promise<boolean>

    act(() => {
      pickB = h.result.current.controls.selectModel(B)
    })

    h.emitEvent({
      payload: {
        execution_generation: 2,
        fast: true,
        model: A.model,
        provider: A.provider,
        reasoning_effort: 'low',
        reasoning_effort_wire: 'low',
        revision: 6,
        running: false,
        service_tier: 'priority'
      },
      session_id: h.sid,
      type: 'session.info'
    })

    h.owner.model = X.model
    h.owner.provider = X.provider
    h.owner.revision = 7
    h.owner.generation = 3

    h.emitEvent({
      payload: {
        execution_generation: 3,
        fast: false,
        model: X.model,
        provider: X.provider,
        reasoning_effort: 'high',
        reasoning_effort_wire: 'high',
        revision: 7,
        running: false,
        service_tier: 'normal'
      },
      session_id: h.sid,
      type: 'session.info'
    })

    let pickC!: Promise<boolean>

    act(() => {
      pickC = h.result.current.controls.selectModel(C)
    })

    await act(async () => {
      h.pendingModelReplies[1].reply.reject(new Error('provider rejected'))
      await expect(pickC).resolves.toBe(false)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(X.model)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('high')
    expect(PRIMARY_SESSION_VIEW.$reasoningEffortWire.get()).toBe('high')
    expect(PRIMARY_SESSION_VIEW.$fast.get()).toBe(false)
    expect(PRIMARY_SESSION_VIEW.$serviceTier?.get()).toBe('normal')

    await act(async () => {
      h.pendingModelReplies[0].reply.reject(new Error('revision_conflict'))
      await expect(pickB).resolves.toBe(false)
    })

    h.queryClient.clear()
  })

  it('clears the previous wire stamp on rollback when a newer reasoning receipt arrived without a wire value', async () => {
    const h = mountLiveEnvironment(5)

    let pickB!: Promise<boolean>

    act(() => {
      pickB = h.result.current.controls.selectModel(B)
    })

    h.emitEvent({
      payload: {
        effort: 'low',
        operation: 'reasoning',
        revision: 6,
        session_id: h.sid
      },
      session_id: h.sid,
      type: 'session.updated' as GatewayEvent['type']
    })

    await act(async () => {
      h.pendingModelReplies[0].reply.reject(new Error('model_resolution_failed'))
      await expect(pickB).resolves.toBe(false)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(A.model)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('low')
    expect(PRIMARY_SESSION_VIEW.$reasoningEffortWire.get()).toBe('')
    expect($currentReasoningEffort.get()).toBe('low')
    expect($currentReasoningEffortWire.get()).toBe('')

    h.queryClient.clear()
  })

  it('applies X@7 reasoning updates once X@6 has already replaced pending B instead of holding them as stale', async () => {
    const h = mountLiveEnvironment(5)

    let pickB!: Promise<boolean>

    act(() => {
      pickB = h.result.current.controls.selectModel(B)
    })

    h.owner.model = X.model
    h.owner.provider = X.provider
    h.owner.revision = 6
    h.owner.generation = 3

    h.emitEvent({
      payload: {
        execution_generation: 3,
        model: X.model,
        provider: X.provider,
        reasoning_effort: 'low',
        reasoning_effort_wire: 'low',
        revision: 6,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(X.model)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('low')

    h.owner.revision = 7

    h.emitEvent({
      payload: {
        execution_generation: 3,
        model: X.model,
        provider: X.provider,
        reasoning_effort: 'high',
        reasoning_effort_wire: 'high',
        revision: 7,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('high')
    expect($currentReasoningEffort.get()).toBe('high')

    await act(async () => {
      h.pendingModelReplies[0].reply.reject(new Error('revision_conflict'))
      await expect(pickB).resolves.toBe(false)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(X.model)
    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('high')
    expect($currentReasoningEffort.get()).toBe('high')

    h.queryClient.clear()
  })

  it('keeps B@6 preset ownership when a rename or turn emits an unchanged B@7 snapshot before the receipt arrives', async () => {
    setModelPreset(B.provider, B.model, { effort: 'medium' })
    const h = mountLiveEnvironment(5)

    let pickB!: Promise<boolean | void>

    act(() => {
      pickB = h.selectWithPreset(B)
    })

    h.owner.model = B.model
    h.owner.provider = B.provider
    h.owner.revision = 7
    h.owner.generation = 3

    h.emitEvent({
      payload: {
        execution_generation: 3,
        model: B.model,
        provider: B.provider,
        reasoning_effort: 'ultra',
        reasoning_effort_wire: 'ultra',
        revision: 7,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        execution_generation: 3,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 6,
        session_id: h.sid
      })
      await expect(pickB).resolves.toBe(true)
    })

    await waitFor(() => expect(h.owner.effort).toBe('medium'))
    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('medium')

    h.queryClient.clear()
  })

  it('does not cancel a queued preset write after B@6 receipt when a rename or turn emits an unchanged B@7 snapshot', async () => {
    setModelPreset(B.provider, B.model, { effort: 'low' })
    const h = mountLiveEnvironment(5)
    const { controller } = h.result.current.menu
    const token = controller.beginSelect?.()

    let pickB!: Promise<boolean | void> | void

    act(() => {
      pickB = controller.select(B.model, B.provider, token)
    })

    h.owner.model = B.model
    h.owner.provider = B.provider
    h.owner.revision = 6
    h.owner.generation = 3

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        execution_generation: 3,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 6,
        session_id: h.sid
      })
      await expect(pickB).resolves.toBe(true)
    })

    h.owner.revision = 7

    h.emitEvent({
      payload: {
        execution_generation: 3,
        model: B.model,
        provider: B.provider,
        reasoning_effort: 'ultra',
        reasoning_effort_wire: 'ultra',
        revision: 7,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    act(() => {
      h.result.current.menu.controller.applyPreset({ effort: 'low' }, B, token)
    })

    await waitFor(() => expect(h.owner.effort).toBe('low'))
    expect(h.mutations.filter(m => m.operation === 'reasoning').map(m => m.payload)).toEqual([{ effort: 'low' }])

    h.queryClient.clear()
  })

  it('cancels a queued preset write after B@6 receipt when an external B@7 commit publishes session.info before session.updated', async () => {
    setModelPreset(B.provider, B.model, { effort: 'low' })
    const h = mountLiveEnvironment(5)
    const { controller } = h.result.current.menu
    const token = controller.beginSelect?.()

    let pickB!: Promise<boolean | void> | void

    act(() => {
      pickB = controller.select(B.model, B.provider, token)
    })

    h.owner.model = B.model
    h.owner.provider = B.provider
    h.owner.revision = 6
    h.owner.generation = 3

    await act(async () => {
      h.pendingModelReplies[0].reply.resolve({
        execution_generation: 3,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 6,
        session_id: h.sid
      })
      await expect(pickB).resolves.toBe(true)
    })

    h.owner.effort = 'high'
    h.owner.revision = 7
    h.owner.generation = 4

    h.emitEvent({
      payload: {
        execution_generation: 4,
        model: B.model,
        provider: B.provider,
        reasoning_effort: 'high',
        reasoning_effort_wire: 'high',
        revision: 7,
        running: false
      },
      session_id: h.sid,
      type: 'session.info'
    })

    h.emitEvent({
      payload: {
        effort: 'high',
        execution_generation: 4,
        model: B.model,
        operation: 'model',
        provider: B.provider,
        revision: 7,
        session_id: h.sid
      },
      session_id: h.sid,
      type: 'session.updated' as GatewayEvent['type']
    })

    act(() => {
      h.result.current.menu.controller.applyPreset({ effort: 'low' }, B, token)
    })

    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('high')
    expect($currentReasoningEffort.get()).toBe('high')
    expect(h.mutations.filter(m => m.operation === 'reasoning')).toEqual([])

    h.queryClient.clear()
  })
})
