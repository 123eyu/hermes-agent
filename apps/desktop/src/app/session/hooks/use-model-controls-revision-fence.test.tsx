import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PRIMARY_SESSION_VIEW } from '@/app/chat/session-view'
import { confirm } from '@/store/confirm'
import { setModelPreset } from '@/store/model-presets'
import {
  $currentFastMode,
  $currentReasoningEffort,
  $currentServiceTier,
  setCurrentFastMode,
  setCurrentReasoningEffort,
  setCurrentServiceTier
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
})
