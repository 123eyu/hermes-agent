import type { GatewayEvent } from '@hermes/shared'
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { getLatestSessionMessages } from '@/hermes'
import { resetInFlightTurnJournalStateForTests } from '@/lib/inflight-turn-journal'
import { $activeGatewayProfile } from '@/store/profile'
import {
  $currentModel,
  $currentProvider,
  _resetSessionOwnerHintsForTests,
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setMessages,
  setSelectedStoredSessionId,
  setSessions
} from '@/store/session'
import { clearAllSessionStates, type SessionTileDelegate, setSessionTileDelegate } from '@/store/session-states'
import type { SessionResumeResult } from '@/types/hermes'

import { deferred } from '../../../test/deferred'

import { useMessageStream } from './use-message-stream'
import { useModelControls } from './use-model-controls'
import { useSessionActions } from './use-session-actions'
import { useSessionStateCache } from './use-session-state-cache'

vi.mock('@/hermes', async original => ({
  ...(await original<Record<string, unknown>>()),
  getLatestSessionMessages: vi.fn()
}))
vi.mock('@/store/profile', async original => ({
  ...(await original<Record<string, unknown>>()),
  ensureGatewayProfile: vi.fn().mockResolvedValue(undefined)
}))

// A warm switch back to a cached chat publishes it before `session.activate`
// answers. A model switch from another surface can land in that window, so the
// activate snapshot may describe an older revision than the cache already holds.
const storedId = 'warm-fence-stored'
const runtimeId = 'warm-fence-runtime'
const noop = async () => undefined

const A = { model: 'model-a', provider: 'provider-a' }
const X = { model: 'model-x', provider: 'provider-x' }

function mount(activate: Promise<SessionResumeResult>, modelSwitch?: Promise<Record<string, unknown>>) {
  const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'session.activate') {
      return activate
    }

    return modelSwitch && params?.key === 'model' ? modelSwitch : {}
  })

  const hook = renderHook(() => {
    const busyRef = useRef(false)
    const queryClient = useRef(new QueryClient()).current

    const cache = useSessionStateCache({
      activeSessionId: null,
      selectedStoredSessionId: null,
      busyRef,
      setMessages,
      setBusy,
      setAwaitingResponse
    })

    const actions = useSessionActions({
      ...cache,
      activeSessionId: null,
      selectedStoredSessionId: null,
      busyRef,
      creatingSessionRef: useRef(false),
      getRouteToken: () => 'warm',
      getRoutedStoredSessionId: () => storedId,
      navigate: vi.fn(),
      requestGateway: requestGateway as never,
      routedSessionId: null
    })

    const stream = useMessageStream({
      ...cache,
      queryClient,
      hydrateFromStoredSession: noop,
      refreshHermesConfig: noop,
      refreshSessions: noop
    })

    const controls = useModelControls({ queryClient, requestGateway: requestGateway as never })

    return { actions, cache, controls, stream }
  })

  setSessionTileDelegate({ updateSession: hook.result.current.cache.updateSessionState } as SessionTileDelegate)

  act(() => {
    hook.result.current.cache.updateSessionState(
      runtimeId,
      state => ({ ...state, ...A, modelRevision: 5, reasoningEffortWire: 'high', revision: 5 }),
      storedId
    )
  })

  return { hook, requestGateway }
}

const sessionInfo = (row: typeof A, revision: number): GatewayEvent =>
  ({
    payload: { ...row, reasoning_effort: 'high', reasoning_effort_wire: 'high', revision, running: false },
    session_id: runtimeId,
    type: 'session.info'
  }) as GatewayEvent

const activateSnapshot = (row: typeof A, revision: number): SessionResumeResult =>
  ({
    info: { ...row, reasoning_effort: 'high', reasoning_effort_wire: 'high', revision },
    message_count: 0,
    messages: [],
    messages_omitted: true,
    resumed: storedId,
    running: false,
    session_id: runtimeId,
    session_key: storedId
  }) as SessionResumeResult

const cachedState = (hook: ReturnType<typeof mount>['hook']) =>
  hook.result.current.cache.sessionStateByRuntimeIdRef.current.get(runtimeId)!

beforeEach(() => {
  localStorage.clear()
  clearAllSessionStates()
  resetInFlightTurnJournalStateForTests()
  _resetSessionOwnerHintsForTests()
  $activeGatewayProfile.set('default')
  setMessages([])
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  setSessions([
    {
      id: storedId,
      title: storedId,
      source: 'desktop',
      message_count: 0,
      tool_call_count: 0,
      is_active: true,
      started_at: 1,
      last_active: 1,
      ended_at: null,
      model: null,
      preview: null,
      input_tokens: 0,
      output_tokens: 0
    }
  ])
  vi.mocked(getLatestSessionMessages).mockResolvedValue({ session_id: storedId, messages: [] })
})

afterEach(() => {
  cleanup()
  setSessionTileDelegate(null as unknown as SessionTileDelegate)
  clearAllSessionStates()
  resetInFlightTurnJournalStateForTests()
  localStorage.clear()
  setSessions([])
  setMessages([])
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  vi.restoreAllMocks()
})

it('keeps a newer model revision when the warm activate snapshot that lands after it is older', async () => {
  const activate = deferred<SessionResumeResult>()
  const { hook, requestGateway } = mount(activate.promise)

  let pending!: Promise<void>
  await act(async () => {
    pending = hook.result.current.actions.resumeSession(storedId, true)
  })
  await waitFor(() => expect(requestGateway).toHaveBeenCalledWith('session.activate', expect.anything()))

  // Another surface switches the chat to X while activate is in flight.
  act(() => hook.result.current.stream.handleGatewayEvent(sessionInfo(X, 7)))
  expect(cachedState(hook)).toMatchObject({ ...X, modelRevision: 7, revision: 7 })

  await act(async () => {
    activate.resolve(activateSnapshot(A, 5))
    await pending
  })

  expect(cachedState(hook)).toMatchObject({ ...X, modelRevision: 7, revision: 7 })
  expect($currentModel.get()).toBe(X.model)
  expect($currentProvider.get()).toBe(X.provider)

  // The fence still holds afterwards: a revision-6 frame is older than X@7.
  act(() => hook.result.current.stream.handleGatewayEvent(sessionInfo(A, 6)))
  expect(cachedState(hook)).toMatchObject({ ...X, modelRevision: 7, revision: 7 })
})

it('keeps an in-flight pick painted when the warm activate snapshot is from before the pick', async () => {
  const activate = deferred<SessionResumeResult>()
  const modelSwitch = deferred<Record<string, unknown>>()
  const { hook, requestGateway } = mount(activate.promise, modelSwitch.promise)

  let pending!: Promise<void>
  await act(async () => {
    pending = hook.result.current.actions.resumeSession(storedId, true)
  })
  await waitFor(() => expect(requestGateway).toHaveBeenCalledWith('session.activate', expect.anything()))

  let pick!: Promise<boolean>
  act(() => {
    pick = hook.result.current.controls.selectModel({ ...X, sessionId: runtimeId })
  })
  expect(cachedState(hook)).toMatchObject(X)

  // Activate answers with the pre-pick route at the pick's own base revision.
  await act(async () => {
    activate.resolve(activateSnapshot(A, 5))
    await pending
  })

  expect(cachedState(hook)).toMatchObject(X)
  expect($currentModel.get()).toBe(X.model)

  await act(async () => {
    modelSwitch.resolve({ model: X.model, provider: X.provider })
    await expect(pick).resolves.toBe(true)
  })

  expect(cachedState(hook)).toMatchObject(X)
})
