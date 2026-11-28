import type { GatewayEvent, ModelOptionsResult } from '@hermes/shared'
import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PRIMARY_SESSION_VIEW } from '@/app/chat/session-view'
import { modelOptionsQueryKey } from '@/lib/model-options'
import { confirm } from '@/store/confirm'
import { notifyError } from '@/store/notifications'
import {
  $activeSessionId,
  $currentFastMode,
  $currentModel,
  $currentProvider,
  $currentReasoningEffort,
  $currentReasoningEffortWire,
  $currentServiceTier,
  getComposerModelSelection
} from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import {
  A,
  B,
  C,
  cleanupRevisionFenceState,
  mountLiveEnvironment,
  resetRevisionFenceState,
  X
} from './model-controls-revision-fence-harness'

vi.mock('@/store/notifications', () => ({ dismissNotification: vi.fn(), notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/store/confirm', () => ({ confirm: vi.fn() }))

beforeEach(resetRevisionFenceState)
afterEach(cleanupRevisionFenceState)

describe('model pick rollback fencing across slice, globals, cache and saved choice', () => {
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
})
