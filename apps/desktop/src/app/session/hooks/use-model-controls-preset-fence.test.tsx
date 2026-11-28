import type { GatewayEvent } from '@hermes/shared'
import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PRIMARY_SESSION_VIEW } from '@/app/chat/session-view'
import { getModelPreset, setModelPreset } from '@/store/model-presets'
import { $currentReasoningEffort, setCurrentReasoningEffort } from '@/store/session'

import {
  B,
  C,
  cleanupRevisionFenceState,
  mountLiveEnvironment,
  resetRevisionFenceState
} from './model-controls-revision-fence-harness'

vi.mock('@/store/notifications', () => ({ dismissNotification: vi.fn(), notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/store/confirm', () => ({ confirm: vi.fn() }))

beforeEach(resetRevisionFenceState)
afterEach(cleanupRevisionFenceState)

describe('model pick preset ownership across overlapping picks', () => {
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

  it('applies the surviving pick preset when a newer pick is rejected first and the older pick then succeeds', async () => {
    setModelPreset(B.provider, B.model, { effort: 'low' })
    setModelPreset(C.provider, C.model, { effort: 'medium' })
    const h = mountLiveEnvironment(5)

    let pickB!: Promise<boolean | void>
    let pickC!: Promise<boolean | void>

    act(() => {
      pickB = h.selectWithPreset(B)
    })

    act(() => {
      pickC = h.selectWithPreset(C)
    })

    await act(async () => {
      h.pendingModelReplies[1].reply.reject(new Error('revision_conflict'))
      await expect(pickC).resolves.toBe(false)
    })

    // C's rollback lands on B, the pick still in flight, so B owns the surface again.
    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe(B.model)

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

    await waitFor(() => expect(h.owner.effort).toBe('low'))
    expect(PRIMARY_SESSION_VIEW.$reasoningEffort.get()).toBe('low')
    expect(h.mutations.filter(m => m.operation === 'reasoning').map(m => m.payload)).toEqual([{ effort: 'low' }])

    h.queryClient.clear()
  })
})
