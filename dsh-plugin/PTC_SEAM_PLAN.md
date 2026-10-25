# PTC binding-provider seam (plan A, deferred)

Status: **not implemented**. The plugin currently provides the plugin-local
plan-B runner (`hprof_ptc`, `ptc.mjs` + `ptc-runner.mjs`). This document records
the DSH-core design so plan A can be picked up without redoing the analysis.

## Why A

DSH's `run_code` builds one sandbox namespace from the calling Agent's visible
tools:

```text
tools.<toolName>(args) -> dispatch(toolName, args)
```

That is enough to compose calls, but it is not a typed domain API. A program
that wants to walk a heap must write `tools.hprof_api({ op: "...", params: ... })`
and rediscover operation names and parameter shapes at runtime.

Plan A adds a generic **PTC binding-provider** seam. Plugins contribute their
own namespace; `run_code` injects those namespaces beside `tools`:

```js
const stats = await hprof.analyze.classStats({ class_id })
const paths = await hprof.paths.class({ class_id, page: 0, size: 10 })
const task = await hprof.entity.fields({ id: holderId })
return { total: stats.totalObjects, groups: paths.groups.length }
```

This is not hprof-specific: any plugin can contribute a typed, documented
namespace with the same lifecycle, scope, and limits as tools.

## Current gap

- `packages/core/tools/src/ptc.ts` unconditionally builds
  `bindings: [{ global: 'tools', functions }]`.
- `PtcRuntime.run` already accepts arbitrary `PtcBindingNamespace[]`
  (`packages/ptc-runtime/ptc-runtime/src/types.ts`); the missing piece is a
  policy-owning registry and the `run_code` merge.
- There is no public way for a plugin to contribute a namespace.
- A plugin-local runner (plan B) works, but duplicates the runtime: timeout,
  output limits, error classes, logging, and future sandbox changes would
  diverge from `run_code`.

## Target design

### Service Definition

A new small service, separate from `PtcRuntime` so consumers do not depend on
one backend:

```ts
export interface PtcBindingProvider {
  /** Namespaces this provider contributes for one Agent. */
  namespaces(agent: Agent): readonly PtcBindingNamespace[]
}

export interface PtcBindingRegistry {
  /** Register a provider; returns an idempotent disposer. */
  register(provider: PtcBindingProvider): () => void
}
```

The registry is a Cordis service (for example `ctx.ptcBindings`), provided by
the tools/PTC side. Providers are registered with `ctx.effect(...)` so HMR
disposal removes them.

### Consumer merge

`run_code` obtains the registry through optional injection, collects
namespaces for `exec.agent`, and merges them with `tools`:

- `tools` remains reserved and always wins its global.
- Reject reserved binding globals (`RESERVED_BINDING_GLOBALS`), duplicate
  globals, invalid identifiers, and duplicate function names with a loud,
  actionable error.
- A provider failure must fail the run, not silently omit a namespace.
- Merge is per run, so a provider registered mid-session applies to the next
  run and disposal applies immediately.
- The composition remains one `PtcRuntime.run` call, so all existing timeout,
  output, error, and logging guarantees still apply.

### Scope and authority

- The provider receives the resolved `Agent`; a provider may return an empty list
  when the capability is unavailable to that agent.
- Namespace functions close over the Agent/session they were built for; they
  must not accept an ambient "current agent" lookup.
- No provider may shadow `tools` or another provider.
- Read-only hprof bindings are safe; providers that expose mutation need their
  own authority check at call time, not only at registration time.

### hprof provider

The hprof plugin would register one provider:

```js
ctx.effect(() => ctx.ptcBindings.register({
  namespaces(agent) {
    if (!agentCanUseHprof(agent)) return []
    return [{
      global: 'hprof',
      functions: buildHprofNamespace(service, agent),
    }]
  },
}))
```

`buildHprofNamespace` maps service operations to the same nested shape used by
plan B (`hprof.query.instances`, `hprof.entity.fields`, `hprof.paths.class`,
`hprof.analyze.classStats`, ...) and returns only JSON values.

### Tests

- Registry: registration/disposal, duplicate global rejection, reserved global
  rejection, per-agent filtering.
- `run_code`: a contributed namespace is callable from a program; `tools` still
  works; a disengaged provider is absent on the next run.
- Error classes: provider failures carry the contributing global/function.
- REAL composition: boot a test `cordis.yml`, register a provider, run
  `run_code`, and assert the model-visible result.
- HMR: dispose the provider fiber and observe the namespace disappear.

### Documentation and rollout

- Document the seam as a public extension point; include a minimal provider
  example.
- Add a package README limitation note until a second provider exists.
- Gates: `pnpm run typecheck`, focused tests, `pnpm run build`, and the
  real-composition test required for product-visible plugin behavior.
- No session-format change.

## Migration from B

- Keep `hprof_ptc` while A is not available.
- Once A lands, register the hprof provider and make `hprof_ptc` a thin
  compatibility wrapper or remove it after a deprecation window.
- The hprof service and namespace builder stay unchanged; only the execution
  host moves from the plugin runner to `run_code`.

## Non-goals

- Do not make the registry a general RPC bus; it only contributes sandbox
  namespaces.
- Do not let providers mutate the sandbox or bypass `PtcRuntime` limits.
- Do not expose Host objects across the sandbox boundary; values are JSON.
