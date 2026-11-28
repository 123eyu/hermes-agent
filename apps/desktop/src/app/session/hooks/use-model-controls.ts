import type { ModelOptionsResult } from '@hermes/shared'
import { type QueryClient } from '@tanstack/react-query'
import { useCallback, useRef } from 'react'

import type { ModelSelection } from '@/app/shell/model-menu-panel'
import { getGlobalModelInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { isBusySessionModelSwitch } from '@/lib/gateway-rpc'
import { surfaceModelSwitchConfirm } from '@/lib/guarded-model-switch'
import {
  customDefaultSupersedesPick,
  moaPickRemoved,
  modelOptionsQueryKey,
  requestModelOptions
} from '@/lib/model-options'
import { isTimeoutError } from '@/lib/with-timeout'
import { noteQueuedLaunchPick } from '@/store/composer-queued-pick'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import {
  $activeSessionId,
  $currentModel,
  $currentProvider,
  $currentReasoningEffortWire,
  getComposerModelSelection,
  getComposerSelectionGeneration,
  getComposerSelectionScope,
  getCurrentModelSource,
  markComposerSelectionManual,
  releaseComposerModelSelection,
  setCurrentFastMode,
  setCurrentModel,
  setCurrentModelSource,
  setCurrentModelTransient,
  setCurrentProvider,
  setCurrentProviderTransient,
  setCurrentReasoningEffort,
  setCurrentReasoningEffortWire,
  setCurrentServiceTier
} from '@/store/session'
import { $sessionStates, sessionTileDelegate } from '@/store/session-states'

import {
  type AuthoritativeModelState,
  type AuthoritativePolicySnapshot,
  beginModelPick,
  bumpModelPickEpoch,
  clearReconciledPickRoute,
  isPickSuperseded,
  modelPickKey,
  type ModelPickSnapshot,
  noteReconciledPickRoute,
  retireModelPickEpoch,
  settleModelPick
} from './model-pick-ledger'
import { monotonicRevision } from './use-message-stream/utils'

interface ModelControlsOptions {
  cacheOwnerConnectionId?: string
  cacheProfile?: string
  queryClient: QueryClient
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
}

interface ModelSwitchResponse {
  confirm_message?: string
  confirm_required?: boolean
  deferred?: boolean
  model?: string
  provider?: string
  revision?: number
}

function readLiveAuthoritative(liveSessionId: null | string): AuthoritativeModelState | undefined {
  const liveState = liveSessionId ? $sessionStates.get()[liveSessionId] : undefined

  if (!liveState || typeof liveState.modelRevision !== 'number') {
    return undefined
  }

  return {
    model: liveState.model,
    provider: liveState.provider,
    reasoningEffortWire: liveState.reasoningEffortWire,
    revision: liveState.modelRevision
  }
}

function isRpcTimeoutError(err: unknown): boolean {
  if (isTimeoutError(err)) {
    return true
  }

  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''

  return /timed?\s*out/i.test(message)
}

function livePolicyMatches(
  state: { fast: boolean; reasoningEffort: string; serviceTier?: string },
  policy: AuthoritativePolicySnapshot | undefined
): boolean {
  if (!policy) {
    return true
  }

  return (
    (policy.fast === undefined || policy.fast === state.fast) &&
    (policy.reasoningEffort === undefined || policy.reasoningEffort === state.reasoningEffort) &&
    (policy.serviceTier === undefined || policy.serviceTier === state.serviceTier)
  )
}

function livePolicyPatch(policy: AuthoritativePolicySnapshot | undefined) {
  if (!policy) {
    return {}
  }

  return {
    ...(policy.fast !== undefined ? { fast: policy.fast } : {}),
    ...(policy.reasoningEffort !== undefined
      ? { reasoningEffort: policy.reasoningEffort, reasoningEffortPending: false }
      : {}),
    ...(policy.serviceTier !== undefined ? { serviceTier: policy.serviceTier } : {})
  }
}

function paintLiveSessionState(
  liveSessionId: null | string,
  next: {
    model: string
    policy?: AuthoritativePolicySnapshot
    provider: string
    reasoningEffortWire?: string
    revision?: number
  }
): void {
  if (!liveSessionId) {
    return
  }

  sessionTileDelegate()?.updateSession(liveSessionId, state => {
    const routeChanged = state.model !== next.model || state.provider !== next.provider

    const wire =
      next.policy?.reasoningEffortWire ?? next.reasoningEffortWire ?? (routeChanged ? '' : state.reasoningEffortWire)

    const revision = monotonicRevision(state.revision, next.revision)
    const modelRevision = monotonicRevision(state.modelRevision, next.revision)

    if (
      !routeChanged &&
      state.reasoningEffortWire === wire &&
      state.revision === revision &&
      state.modelRevision === modelRevision &&
      livePolicyMatches(state, next.policy)
    ) {
      return state
    }

    return {
      ...state,
      model: next.model,
      provider: next.provider,
      reasoningEffortWire: wire,
      ...livePolicyPatch(next.policy),
      ...(revision !== undefined ? { revision } : {}),
      ...(modelRevision !== undefined ? { modelRevision } : {})
    }
  })
}

function isConfirmedRouteTimeout(confirmedSameRoute: boolean, err: unknown): boolean {
  return confirmedSameRoute && isRpcTimeoutError(err)
}

function applyRollbackPolicyGlobals(policy: AuthoritativePolicySnapshot | undefined): void {
  if (!policy) {
    return
  }

  if (policy.reasoningEffort !== undefined) {
    setCurrentReasoningEffort(policy.reasoningEffort)
  }

  if (policy.reasoningEffortWire !== undefined) {
    setCurrentReasoningEffortWire(policy.reasoningEffortWire)
  }

  if (policy.fast !== undefined) {
    setCurrentFastMode(policy.fast)
  }

  if (policy.serviceTier !== undefined) {
    setCurrentServiceTier(policy.serviceTier)
  }
}

function receiptFromSwitchResult(selection: ModelSelection, result: ModelSwitchResponse | undefined) {
  if (!result) {
    return undefined
  }

  return {
    model: result.model || selection.model,
    provider: result.provider || selection.provider,
    ...(!result.deferred && typeof result.revision === 'number' ? { revision: result.revision } : {})
  }
}

export function useModelControls({
  cacheOwnerConnectionId,
  cacheProfile,
  queryClient,
  requestGateway
}: ModelControlsOptions) {
  const { t } = useI18n()
  const copy = t.desktop
  const profileRefreshEpochRef = useRef(0)

  // All callbacks here read reactive session state from the store (.get())
  // rather than capturing it as a prop. The actions bag in wiring.tsx mutates
  // in place to keep a stable identity, so memoized surfaces capture these
  // callbacks once and never re-evaluate — a captured prop would be stale
  // forever. The store read is always current.
  const updateModelOptionsCache = useCallback(
    (
      sessionId: null | string,
      provider: string,
      model: string,
      includeGlobal: boolean,
      profile = cacheProfile || $activeGatewayProfile.get(),
      ownerConnectionId = cacheOwnerConnectionId
    ) => {
      const patch = (prev: ModelOptionsResult | undefined) => {
        // Selection state can update before the catalog query has resolved.
        // Keep that optimistic cache structurally complete; the composer
        // interprets a response without `providers` as an empty catalog.
        const providers = prev?.providers?.length
          ? prev.providers
          : provider && model
            ? [{ models: [model], name: provider, slug: provider }]
            : []

        return { ...prev, provider, model, providers }
      }

      queryClient.setQueryData<ModelOptionsResult>(modelOptionsQueryKey(profile, sessionId, ownerConnectionId), patch)

      if (includeGlobal) {
        queryClient.setQueryData<ModelOptionsResult>(modelOptionsQueryKey(profile, null, ownerConnectionId), patch)
      }
    },
    [cacheOwnerConnectionId, cacheProfile, queryClient]
  )

  // Settings → Model writes the profile default, which the backend applies to
  // new sessions only. Keep a live session's renderer state and session-scoped
  // model-options cache authoritative instead of briefly painting the saved
  // default as if the active agent had switched. Marking the composer as
  // default-derived still lets the next fresh draft reseed from profile config.
  const applySavedMainModel = useCallback(
    (provider: string, model: string) => {
      const liveSessionId = $activeSessionId.get()

      setCurrentModelSource('default')

      if (!liveSessionId) {
        setCurrentProvider(provider)
        setCurrentModel(model)
      }

      // A null session id is the profile-global model-options key. Never patch
      // the live session key here: only config.set --session may change it.
      updateModelOptionsCache(null, provider, model, false)
    },
    [updateModelOptionsCache]
  )

  // Seed the composer's model state from the profile default. `force` reseeds
  // for a profile swap (the new profile has its own default); otherwise this
  // only fills an EMPTY selection so a user's pick (plain UI state in
  // $currentModel) survives the lifecycle refreshes that fire on boot / fresh
  // draft / session events. A live session owns the footer, so skip entirely.
  // Two provably-stale manual picks are the exception and reseed from the
  // profile default: the virtual `moa` provider (#90244) and a bare provider
  // slug the default has migrated to its `custom:<key>` form (#81922).
  const refreshCurrentModel = useCallback(
    async (force = false) => {
      // A forced profile swap opens a new intent epoch; an older in-flight
      // response for a previous profile must stand down when it resolves.
      if (force) {
        profileRefreshEpochRef.current += 1
      }

      const profileRefreshEpoch = profileRefreshEpochRef.current
      const profile = $activeGatewayProfile.get()

      try {
        if ($activeSessionId.get()) {
          return
        }

        // A manual pick is sticky. It is never diffed against the catalog: rows
        // are hints, and a custom slug the row lacks is still the user's choice
        // (the gateway validates it on switch). ONE exception, narrower than a
        // catalog diff: a pick pointing at the virtual `moa` provider, whose row
        // the catalog omits entirely once no preset is enabled — that absence is
        // authoritative, and without the exception the pill reads
        // `Model · moa: default` forever (#90244).
        const manualPick = () => Boolean($currentModel.get()) && getCurrentModelSource() === 'manual'

        const pickProvider = () => ($currentProvider.get() || '').trim()

        const staleMoaPick = () => !force && manualPick() && pickProvider().toLowerCase() === 'moa'

        // A SECOND exception: a bare provider slug can be a stale spelling of a
        // `custom:<key>` profile default (#87035 aliases the two spellings for
        // one endpoint). Shipping the bare form resolves the NATIVE provider and
        // silently drops the entry's `extra_body` (#81922), so the pick must
        // reseed. Only a bare slug qualifies — a pick that already names a
        // provider class is a distinct choice and stays sticky — and the profile
        // default is a backend fact, so this needs the same `getGlobalModelInfo`
        // fetch the empty / default-sourced path already makes.
        const maybeSupersededPick = () =>
          !force && manualPick() && pickProvider() !== '' && !pickProvider().includes(':')

        if (manualPick() && !force && !staleMoaPick() && !maybeSupersededPick()) {
          return
        }

        // Snapshot the selection generation before awaiting so a picker click
        // that lands while getGlobalModelInfo is in flight wins over this older
        // default — value comparisons alone miss re-selecting the same row.
        const selectionGeneration = getComposerSelectionGeneration()

        // Judge the moa pick against the catalog: peek the picker's own cache
        // first and only fetch (deduped with the in-flight UI query) when it is
        // empty, so the pill reseeds even before the chat view mounts its query.
        // A catalog that fails to load keeps the pick — absence of data is not
        // absence of the preset.
        let reseedStaleMoa = false

        if (staleMoaPick()) {
          const catalogProfile = cacheProfile || profile
          const catalogKey = modelOptionsQueryKey(catalogProfile, null, cacheOwnerConnectionId)

          const catalog =
            queryClient.getQueryData<ModelOptionsResult>(catalogKey) ??
            (await queryClient.fetchQuery({
              queryKey: catalogKey,
              queryFn: (): Promise<ModelOptionsResult> =>
                requestModelOptions({ profile: catalogProfile, request: requestGateway })
            }))

          reseedStaleMoa = moaPickRemoved(catalog, 'moa', $currentModel.get())

          if (!reseedStaleMoa) {
            return
          }
        }

        const result = await getGlobalModelInfo(profile)

        if (
          profileRefreshEpochRef.current !== profileRefreshEpoch ||
          $activeSessionId.get() ||
          getComposerSelectionGeneration() !== selectionGeneration ||
          (manualPick() &&
            !force &&
            !reseedStaleMoa &&
            !customDefaultSupersedesPick($currentProvider.get(), result.provider ?? ''))
        ) {
          return
        }

        if (typeof result.model === 'string') {
          setCurrentModel(result.model)
        }

        if (typeof result.provider === 'string') {
          setCurrentProvider(result.provider)
        }

        if (typeof result.model === 'string' || typeof result.provider === 'string') {
          setCurrentModelSource('default')
        }
      } catch {
        // The delayed session.info event still updates this once the agent is ready.
      }
    },
    [cacheOwnerConnectionId, cacheProfile, queryClient, requestGateway]
  )

  // Drop a sticky composer pick so new chats follow Settings → Model again,
  // without making the user re-apply the default they already have (#107410).
  const followDefaultModel = useCallback(() => {
    setCurrentModelSource('default')
    void refreshCurrentModel()
  }, [refreshCurrentModel])

  // Returns whether the switch was applied so callers can await it before
  // applying follow-up changes. `true` means applied (or deferred/busy-queued
  // for the next turn). `false` means NOT applied — either pending
  // confirmation (warning with Confirm action already shown, pill rolled back)
  // or a real failure (error toast). Callers must NOT treat `false` as a
  // generic failure: for `pending` the gateway intentionally returned
  // `confirm_required` and no error should be surfaced.
  // The composer model is plain UI state: with no live session it's just
  // stored (and shipped on the next session.create); with one it's scoped to
  // that session via config.set. It NEVER writes the profile default — that
  // lives in Settings → Model — so picking a model here can't silently mutate
  // global config.
  //
  // `selection.sessionId` targets a specific surface (tile). When omitted, the
  // primary `$activeSessionId` is used (overlay / legacy callers). A tile
  // switch must not touch the primary globals — and must not be blocked by a
  // busy primary turn.
  const selectModel = useCallback(
    async (selection: ModelSelection): Promise<boolean> => {
      const primaryRuntimeId = $activeSessionId.get()
      const liveSessionId = 'sessionId' in selection ? (selection.sessionId ?? null) : primaryRuntimeId
      const touchesPrimary = !liveSessionId || liveSessionId === primaryRuntimeId

      const readSnapshot = (): ModelPickSnapshot => {
        // The slice is the rollback baseline, not the composer globals: the pill
        // renders `view.$model`, which is slice-first for a live session, so a
        // snapshot taken from the globals would paint a model the gateway never
        // accepted back into the pill when a switch is rejected. The globals stay
        // as the fallback for a session that has no slice yet (cold resume);
        // `composerSelection` pins the persisted pick separately.
        const liveState = liveSessionId ? $sessionStates.get()[liveSessionId] : undefined

        return {
          composerSelection: getComposerModelSelection(),
          model: liveState ? liveState.model : touchesPrimary ? $currentModel.get() : '',
          provider: liveState ? liveState.provider : touchesPrimary ? $currentProvider.get() : '',
          reasoningEffortWire: liveState
            ? (liveState.reasoningEffortWire ?? '')
            : touchesPrimary
              ? $currentReasoningEffortWire.get()
              : ''
        }
      }

      const before = readSnapshot()
      const baseRevision = liveSessionId ? $sessionStates.get()[liveSessionId]?.revision : undefined
      const composerScope = getComposerSelectionScope()
      const liveGatewayProfile = cacheProfile || $activeGatewayProfile.get()

      const paintSelection = () => {
        if (touchesPrimary) {
          setCurrentModel(selection.model)
          setCurrentProvider(selection.provider)
          markComposerSelectionManual()
        }

        // Optimistic — session.info confirms; a failed pick rolls back. The wire stamp belongs to
        // the old route, so it is withdrawn until session.info re-stamps it.
        paintLiveSessionState(liveSessionId, {
          model: selection.model,
          provider: selection.provider,
          reasoningEffortWire: ''
        })
      }

      const cacheSelection = (provider: string, model: string) => {
        updateModelOptionsCache(liveSessionId, provider, model, touchesPrimary && !liveSessionId, liveGatewayProfile)
      }

      const restoreSnapshot = (
        snapshot: ModelPickSnapshot,
        repaintUi = true,
        revision?: number,
        policy?: AuthoritativePolicySnapshot
      ) => {
        // The composer globals are what the UI currently shows, so they are
        // only repainted while the user is still looking at this session.
        if (touchesPrimary && repaintUi) {
          setCurrentModel(snapshot.composerSelection.model)
          setCurrentProvider(snapshot.composerSelection.provider)
          setCurrentModelSource(snapshot.composerSelection.source)
          // Restore runtime paint/stamp separately; neither is sticky launch intent.
          setCurrentModelTransient(snapshot.model)
          setCurrentProviderTransient(snapshot.provider)
          setCurrentReasoningEffortWire(snapshot.reasoningEffortWire)
          applyRollbackPolicyGlobals(policy)
        }

        // The session's own slice and model-options cache describe that session,
        // so both must roll back even after the user navigated elsewhere.
        paintLiveSessionState(liveSessionId, {
          model: snapshot.model,
          policy,
          provider: snapshot.provider,
          reasoningEffortWire: snapshot.reasoningEffortWire,
          revision
        })
        cacheSelection(snapshot.provider, snapshot.model)
      }

      paintSelection()
      cacheSelection(selection.provider, selection.model)

      // No live session yet: session.create snapshots the persisted composer pick
      // (not the runtime display) and applies it as that session's override.
      if (!liveSessionId) {
        bumpModelPickEpoch(modelPickKey('draft', cacheOwnerConnectionId, liveGatewayProfile))

        return true
      }

      // Per owner: another owner can hold a session with the same id (imports).
      const pickKey = modelPickKey(liveSessionId, cacheOwnerConnectionId, liveGatewayProfile)
      const pickToken = beginModelPick(pickKey, before, readSnapshot(), baseRevision)

      const handleApplied = (token: number, result?: ModelSwitchResponse) => {
        const receipt = receiptFromSwitchResult(selection, result)

        const settlement = settleModelPick(pickKey, token, true, {
          liveAuthoritative: readLiveAuthoritative(liveSessionId),
          receipt
        })

        if (settlement.kind !== 'reconcile') {
          if (settlement.kind === 'keep' && settlement.superseded === false) {
            noteReconciledPickRoute(
              pickKey,
              token,
              { model: selection.model, provider: selection.provider },
              { model: receipt?.model || selection.model, provider: receipt?.provider || selection.provider },
              receipt?.revision
            )

            return
          }

          retireModelPickEpoch(pickKey, token)
          clearReconciledPickRoute(pickKey, token)

          return
        }

        noteReconciledPickRoute(
          pickKey,
          token,
          { model: selection.model, provider: selection.provider },
          { model: settlement.model, provider: settlement.provider },
          settlement.revision
        )

        paintLiveSessionState(liveSessionId, {
          model: settlement.model,
          provider: settlement.provider,
          revision: settlement.revision
        })

        if (touchesPrimary && $activeSessionId.get() === liveSessionId) {
          if ($currentModel.get() !== settlement.model) {
            setCurrentModelTransient(settlement.model)
          }

          if ($currentProvider.get() !== settlement.provider) {
            setCurrentProviderTransient(settlement.provider)
          }
        }

        cacheSelection(settlement.provider, settlement.model)
      }

      // Settle an unapplied pick: leave newer server state intact on `overtaken`,
      // or return the rollback snapshot + whether this session is still on screen.
      const handleUnapplied = (token: number) => {
        const settlement = settleModelPick(pickKey, token, false, {
          liveAuthoritative: readLiveAuthoritative(liveSessionId)
        })

        if (settlement.kind === 'overtaken') {
          const auth = settlement.authoritative
          const liveState = $sessionStates.get()[liveSessionId]
          const confirmedSameRoute = auth.model === selection.model && auth.provider === selection.provider

          cacheSelection(auth.provider || liveState?.provider || '', auth.model || liveState?.model || '')

          if (touchesPrimary && !confirmedSameRoute) {
            releaseComposerModelSelection(selection, composerScope)
          }

          return {
            confirmedSameRoute,
            restored: null as null | {
              policy?: AuthoritativePolicySnapshot
              repaintUi: boolean
              revision?: number
              snapshot: ModelPickSnapshot
            }
          }
        }

        if (settlement.kind !== 'rollback') {
          return { confirmedSameRoute: false, restored: null }
        }

        clearReconciledPickRoute(pickKey, token)

        const movedAway = touchesPrimary && $activeSessionId.get() !== liveSessionId

        if (movedAway) {
          releaseComposerModelSelection(selection, composerScope)
        }

        return {
          confirmedSameRoute: false,
          restored: {
            policy: settlement.policy,
            repaintUi: !movedAway,
            revision: settlement.revision,
            snapshot: settlement.snapshot
          }
        }
      }

      // The PRIMARY profile's main agent lets the gateway decide persistence
      // (resolve_persist_behavior): session-only by default, persisted when
      // model.persist_switch_by_default is true or when no default has ever
      // been configured (the first-ever pick, so resolve_provider never falls
      // through to a leftover OPENAI_API_KEY env var — #86414). A plain pick
      // no longer silently rewrites config.yaml (#90235); Settings → Model
      // remains the explicit "set as default" door.
      //
      // Two things stay --session, deliberately:
      //  - a SECONDARY chat tile: picking a model there must not rewrite the
      //    profile default (the cross-session-contamination guard).
      //  - MoA (mixture-of-agents) presets: a transient orchestration choice
      //    that must never become the persisted global gateway default.
      const isSessionOnlyPreset = (selection.provider || '').toLowerCase() === 'moa'
      const scope = touchesPrimary && !isSessionOnlyPreset ? '' : ' --session'

      const requestSwitch = (confirmExpensiveModel = false) =>
        requestGateway<ModelSwitchResponse>('config.set', {
          session_id: liveSessionId,
          key: 'model',
          value: `${selection.model} --provider ${selection.provider}${scope}`,
          ...(confirmExpensiveModel ? { confirm_expensive_model: true } : {})
        })

      const finishSwitch = (result: ModelSwitchResponse | undefined, token: number) => {
        noteQueuedLaunchPick(liveSessionId, touchesPrimary && result?.deferred ? selection : null, composerScope, token)

        // A pick made DURING a turn is queued by the gateway and applied at the
        // next turn start (`deferred`). Re-fetching now would answer with the
        // model still running and repaint the old name over the user's choice —
        // the switch publishes session.info when it lands, and that is what
        // re-syncs every surface.
        if (!result?.deferred) {
          void queryClient.invalidateQueries({
            queryKey: modelOptionsQueryKey(liveGatewayProfile, liveSessionId, cacheOwnerConnectionId)
          })
        } else {
          notify({
            id: `model-pick-deferred-${liveSessionId}`,
            kind: 'info',
            message: t.shell.modelMenu.pickDeferred(selection.model)
          })
        }
      }

      try {
        const result = await requestSwitch()

        if (result?.confirm_required) {
          // A newer pick already owns the pill; asking to confirm this one
          // would only offer to undo it.
          const { restored } = handleUnapplied(pickToken)

          if (!restored) {
            return false
          }

          restoreSnapshot(restored.snapshot, restored.repaintUi, restored.revision, restored.policy)

          // The user moved on to another session: its own slice is restored
          // above, but a dialog for a pick they abandoned would only offer to
          // undo the one they are making now.
          if (!restored.repaintUi) {
            return false
          }

          let retryToken: null | number = null
          // ONE shared applier for guarded switches (#95293): the same
          // confirm flow the Bots editor routes through — never fork this
          // logic per surface.
          // Not awaited: `selectModel` answers "was the switch applied NOW",
          // and that answer only exists once the user answers the dialog.
          void surfaceModelSwitchConfirm({
            confirmMessage: result.confirm_message,
            failureMessage: copy.modelSwitchFailed,
            // Staleness guard — the session or model can move on while the
            // dialog is open. Answering it must not clobber the newer choice:
            // bail (with a notice) if the live state no longer matches the
            // snapshot this prompt was created for.
            isStale: () =>
              touchesPrimary
                ? $activeSessionId.get() !== liveSessionId ||
                  ($sessionStates.get()[liveSessionId]?.model ?? $currentModel.get()) !== restored.snapshot.model ||
                  ($sessionStates.get()[liveSessionId]?.provider ?? $currentProvider.get()) !==
                    restored.snapshot.provider
                : !liveSessionId ||
                  $sessionStates.get()[liveSessionId]?.model !== restored.snapshot.model ||
                  $sessionStates.get()[liveSessionId]?.provider !== restored.snapshot.provider,
            model: selection.model,
            // The confirmed retry is a fresh pick in the ledger: it joins whatever is still in
            // flight, becomes the confirmed selection when it applies, and settles like any pick
            // when it fails — so an older pick failing later cannot restore what it replaced.
            repaint: () => {
              const retryBefore = readSnapshot()
              const retryBaseRevision = $sessionStates.get()[liveSessionId]?.revision
              paintSelection()
              cacheSelection(selection.provider, selection.model)
              retryToken = beginModelPick(pickKey, retryBefore, readSnapshot(), retryBaseRevision)
            },
            requestConfirmed: () => requestSwitch(true),
            finish: confirmedResult => {
              if (retryToken !== null) {
                handleApplied(retryToken, confirmedResult)
              }

              finishSwitch(confirmedResult, retryToken ?? pickToken)
            },
            rollback: err => {
              if (retryToken === null) {
                return
              }

              const { confirmedSameRoute, restored: retryRestored } = handleUnapplied(retryToken)

              if (retryRestored) {
                restoreSnapshot(
                  retryRestored.snapshot,
                  retryRestored.repaintUi,
                  retryRestored.revision,
                  retryRestored.policy
                )
              }

              if (isConfirmedRouteTimeout(confirmedSameRoute, err)) {
                return 'confirmed'
              }
            }
          })

          return false
        }

        handleApplied(pickToken, result)
        finishSwitch(result, pickToken)

        return true
      } catch (err) {
        // An OLDER gateway refuses a mid-turn switch outright (4009) instead of
        // deferring it. Don't punish the user for a backend they haven't
        // updated: keep the pick painted as the composer's selection, which is
        // what the NEXT turn runs anyway. Current gateways never take this
        // path — they answer `deferred`.
        if (isBusySessionModelSwitch(err)) {
          handleApplied(pickToken)

          return true
        }

        // An abandoned pick (a newer one was made, or the user left the chat)
        // is not the user's current choice; its failure is not worth a toast.
        const abandoned =
          isPickSuperseded(pickKey, pickToken) || (touchesPrimary && $activeSessionId.get() !== liveSessionId)

        const { confirmedSameRoute, restored } = handleUnapplied(pickToken)

        if (restored) {
          restoreSnapshot(restored.snapshot, restored.repaintUi, restored.revision, restored.policy)
        }

        if (!abandoned && !isConfirmedRouteTimeout(confirmedSameRoute, err)) {
          notifyError(err, copy.modelSwitchFailed)
        }

        return false
      }
    },
    [cacheOwnerConnectionId, cacheProfile, copy, queryClient, requestGateway, t, updateModelOptionsCache]
  )

  return { applySavedMainModel, followDefaultModel, refreshCurrentModel, selectModel }
}
