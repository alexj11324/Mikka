import { globalSingleton, once } from '@workflow/utils';
import { WorkflowSuspension } from './global.js';
import { runtimeLogger } from './logger.js';
import * as Attr from './telemetry/semantic-conventions.js';
/**
 * Unrecognized `WORKFLOW_TRACE_MODE` values we already warned about. On
 * `globalThis` (see `globalSingleton`) so the warning stays once per process
 * rather than once per bundler layer.
 */
const traceModeWarnings = globalSingleton('@workflow/core//traceModeWarnings', 1, () => ({ unrecognized: new Set() }));
/**
 * Resolves the active trace mode from the `WORKFLOW_TRACE_MODE` env var.
 * Defaults to `'linked'`; any value other than `'continuous'` selects it.
 * Unrecognized non-empty values (e.g. typos like `continous`) emit a
 * one-time warning so silent fallback to `linked` is at least visible.
 */
export function getWorkflowTraceMode() {
    const value = process.env.WORKFLOW_TRACE_MODE;
    if (value === 'continuous')
        return 'continuous';
    if (value &&
        value !== 'linked' &&
        !traceModeWarnings.unrecognized.has(value)) {
        traceModeWarnings.unrecognized.add(value);
        runtimeLogger.warn(`Unrecognized WORKFLOW_TRACE_MODE value "${value}"; expected "linked" or "continuous". Falling back to "linked".`);
    }
    return 'linked';
}
/**
 * Returns whether a serialized trace carrier is usable, i.e. present and
 * non-empty. `serializeTraceCarrier()` returns `{}` when no OTEL SDK is
 * registered or no span is active, and `start()` always attaches the
 * carrier to the first queue message, so an empty carrier must be treated
 * the same as an absent one wherever the trace-mode logic branches.
 */
export function isUsableTraceCarrier(carrier) {
    return carrier !== undefined && Object.keys(carrier).length > 0;
}
/**
 * Returns the trace carrier to attach to messages the current invocation
 * enqueues. In `linked` mode the ORIGINAL run-origin carrier is forwarded
 * unchanged (when usable) so every future invocation links back to the same
 * origin; otherwise (`continuous` mode, or no usable incoming carrier)
 * the current (active) context is serialized, so the trace keeps chaining
 * (continuous) or the first instrumented invocation becomes the de-facto
 * origin (linked).
 */
export function getNextTraceCarrier(traceMode, incomingCarrier) {
    return traceMode === 'linked' && isUsableTraceCarrier(incomingCarrier)
        ? Promise.resolve(incomingCarrier)
        : serializeTraceCarrier();
}
/**
 * Builds the span links for a queue-delivered invocation span
 * (`workflow.execute` / `step.execute`):
 *
 * - In `linked` mode the invocation span is a CHILD of the local delivery
 *   (flow-route) context, so the only link is to the run-origin context
 *   from the message's trace carrier, connecting this bounded per-invocation
 *   trace back to where the run was started. The run-origin context is a
 *   link, never a parent, and re-enqueues forward the original carrier
 *   unchanged, so the whole run is never stitched into one giant trace.
 *   The link is skipped when the carrier is absent, empty, or invalid.
 * - In `continuous` mode the run-origin context is restored as the parent
 *   instead, and the link points at the incoming delivery context.
 */
export async function buildInvocationSpanLinks(traceMode, incomingCarrier) {
    if (traceMode !== 'linked')
        return linkToCurrentContext();
    const originLink = await linkToTraceCarrier(isUsableTraceCarrier(incomingCarrier) ? incomingCarrier : undefined);
    return originLink ? [originLink] : undefined;
}
/**
 * Serializes the current trace context into a format that can be passed through queues
 * @returns A record of strings representing the trace context
 */
export async function serializeTraceCarrier() {
    const otel = await OtelApi.value;
    if (!otel)
        return {};
    const carrier = {};
    // Inject the current context into the carrier
    otel.propagation.inject(otel.context.active(), carrier);
    return carrier;
}
/**
 * Deserializes trace context and returns a context that can be used to continue the trace
 * @param traceCarrier The serialized trace context
 * @returns OpenTelemetry context with the restored trace
 */
export async function deserializeTraceCarrier(traceCarrier) {
    const otel = await OtelApi.value;
    if (!otel)
        return;
    // Extract the context from the carrier
    return otel.propagation.extract(otel.context.active(), traceCarrier);
}
/**
 * Runs a function within the context of a deserialized trace
 * @param traceCarrier The serialized trace carrier (optional)
 * @param fn The function to run within the trace context
 * @returns The result of the function
 */
export async function withTraceContext(traceCarrier, fn) {
    if (!traceCarrier) {
        return fn();
    }
    const otel = await OtelApi.value;
    if (!otel)
        return fn();
    const extractedContext = await deserializeTraceCarrier(traceCarrier);
    if (!extractedContext) {
        return fn();
    }
    return otel.context.with(extractedContext, async () => await fn());
}
const OtelApi = once(async () => {
    // `@opentelemetry/api` is an optional peer dependency. The static specifier
    // is intentional: esbuild-bundled targets (the CLI's
    // `vercel-build-output-api` build, Nitro, Astro) ship a self-contained
    // bundle with no node_modules, so the package must be *inlined* at build
    // time for spans to work at runtime; a runtime-built specifier is opaque to
    // esbuild and would silently disable tracing there. Bundlers that reject an
    // unresolvable static `import()` when the peer isn't installed (Rollup/Vite,
    // e.g. SvelteKit) instead externalize `@opentelemetry/api` in the workflow
    // framework integration, which keeps the build green and still loads real
    // OTel when the peer is present. Runtime semantics: present → loaded, absent
    // → caught and tracing disabled.
    try {
        return await import('@opentelemetry/api');
    }
    catch {
        runtimeLogger.info('OpenTelemetry not available, tracing will be disabled');
        return null;
    }
});
const Tracer = once(async () => {
    const api = await OtelApi.value;
    if (!api)
        return null;
    const tracer = api.trace.getTracer('workflow');
    logOtelDiagnosticOnce(api, tracer);
    return tracer;
});
const StepExecutionDurationHistogram = once(async () => {
    const otel = await OtelApi.value;
    if (!otel)
        return null;
    // service.name is a resource attribute, applied by the configured provider.
    return otel.metrics
        .getMeter('workflow')
        .createHistogram('workflow.step.execute.duration', {
        description: 'Duration of user step execution',
        unit: 'ms',
    });
});
/**
 * One-shot runtime diagnostic (DEBUG=workflow:* only), same shape as the one
 * world-vercel emits tagged `world-vercel`: prints how this module instance
 * of `@opentelemetry/api` sees the global registration, so a deployment's
 * logs show the two packages' views side by side.
 */
// per-copy-ok: this diagnostic reports how THIS module instance sees the global
// OTel registration, which is the whole point of the log. With several copies
// in a process, each one's view is what is worth seeing.
let otelDiagLogged = false;
function describeThrownValue(value) {
    try {
        if (typeof value === 'object' &&
            value !== null &&
            'message' in value &&
            typeof value.message === 'string') {
            return value.message;
        }
        return String(value);
    }
    catch {
        return 'Unknown error';
    }
}
function logOtelDiagnosticOnce(otel, tracer) {
    const debugEnabled = typeof process !== 'undefined' &&
        typeof process.env.DEBUG === 'string' &&
        (process.env.DEBUG.includes('workflow:') || process.env.DEBUG === '*');
    if (otelDiagLogged || !debugEnabled)
        return;
    otelDiagLogged = true;
    try {
        const g = globalThis[Symbol.for('opentelemetry.js.api.1')];
        const provider = otel.trace.getTracerProvider();
        const delegate = provider.getDelegate?.() ?? provider;
        const probe = tracer.startSpan('workflow.otel.probe.core');
        console.warn('[workflow:otel-diag] core', JSON.stringify({
            globalRegistrationVersion: g?.version ?? null,
            providerCtor: provider?.constructor?.name ?? null,
            delegateCtor: delegate?.constructor?.name ?? null,
            tracerCtor: tracer?.constructor?.name ?? null,
            probeCtor: probe?.constructor?.name ?? null,
            probeRecording: probe.isRecording(),
        }));
        probe.end();
    }
    catch (error) {
        console.warn('[workflow:otel-diag] core failed:', error instanceof Error ? error.message : error);
    }
}
export async function trace(spanName, ...args) {
    const [tracer, otel] = await Promise.all([Tracer.value, OtelApi.value]);
    const { fn, opts } = typeof args[0] === 'function'
        ? { fn: args[0], opts: {} }
        : { fn: args[1], opts: args[0] };
    if (!fn)
        throw new Error('Function to trace must be provided');
    if (!tracer || !otel) {
        return await fn();
    }
    return tracer.startActiveSpan(spanName, opts, async (span) => {
        try {
            const result = await fn(span);
            span.setStatus({ code: otel.SpanStatusCode.OK });
            return result;
        }
        catch (e) {
            if (WorkflowSuspension.is(e)) {
                span.setStatus({ code: otel.SpanStatusCode.OK });
                applyWorkflowSuspensionToSpan(e, span);
            }
            else {
                span.setStatus({
                    code: otel.SpanStatusCode.ERROR,
                    message: describeThrownValue(e),
                });
            }
            throw e;
        }
        finally {
            span.end();
        }
    });
}
/** Starts a child span without installing it as the active context. */
export async function startTraceSpan(spanName) {
    const [tracer, otel] = await Promise.all([Tracer.value, OtelApi.value]);
    if (!tracer || !otel)
        return { end() { }, fail() { } };
    const span = tracer.startSpan(spanName);
    let ended = false;
    const finish = (status) => {
        if (ended)
            return;
        ended = true;
        span.setStatus(status);
        span.end();
    };
    return {
        end: () => finish({ code: otel.SpanStatusCode.OK }),
        fail: (error) => finish({
            code: otel.SpanStatusCode.ERROR,
            message: describeThrownValue(error),
        }),
    };
}
/** Bind work to the currently active span even when it starts from a child. */
export async function bindActiveTraceContext(fn) {
    const otel = await OtelApi.value;
    return otel ? otel.context.bind(otel.context.active(), fn) : fn;
}
/** Keeps a parked workflow's ambient trace context aligned with each resume. */
export async function createRefreshableTraceContext() {
    const otel = await OtelApi.value;
    if (!otel) {
        return { refresh() { }, run: (fn) => fn() };
    }
    let current = otel.context.active();
    const context = {
        getValue: (key) => current.getValue(key),
        setValue: (key, value) => current.setValue(key, value),
        deleteValue: (key) => current.deleteValue(key),
    };
    return {
        refresh: () => {
            current = otel.context.active();
        },
        run: (fn) => otel.context.with(context, fn),
    };
}
/**
 * Emit a span whose start is back-dated to `startEpochMs` and whose end is now,
 * so its duration reflects an interval only measurable at its end (e.g.
 * time-to-first-chunk, known when the first chunk arrives). Unlike `trace()`,
 * this records an already-elapsed span in one shot rather than wrapping a
 * callback. No-op when OpenTelemetry is not available.
 */
export async function recordElapsedSpan(spanName, startEpochMs, opts) {
    const tracer = await Tracer.value;
    if (!tracer)
        return;
    tracer.startSpan(spanName, { ...opts, startTime: startEpochMs }).end();
}
/**
 * Records the same user-code interval as the inner `step.execute` span. The
 * configured OpenTelemetry meter provider attaches resource dimensions such as
 * service.name, so this avoids accepting a caller-controlled service tag.
 */
export async function recordStepExecutionDuration(durationMs, status) {
    const histogram = await StepExecutionDurationHistogram.value;
    histogram?.record(durationMs, { 'workflow.step.status': status });
}
/**
 * Applies the workflow suspension algebraic effect to an active span.
 */
export function applyWorkflowSuspensionToSpan(error, span) {
    span.setAttributes({
        ...Attr.WorkflowSuspensionState('suspended'),
        ...Attr.WorkflowSuspensionStepCount(error.stepCount),
        ...Attr.WorkflowSuspensionHookCount(error.hookCount),
        ...Attr.WorkflowSuspensionWaitCount(error.waitCount),
    });
}
export async function getSpanContextForTraceCarrier(carrier) {
    const [deserialized, otel] = await Promise.all([
        deserializeTraceCarrier(carrier),
        OtelApi.value,
    ]);
    if (!deserialized || !otel)
        return;
    return otel.trace.getSpanContext(deserialized);
}
export async function getActiveSpan() {
    return await withOtel((otel) => otel.trace.getActiveSpan());
}
/**
 * Wraps all methods of an object with tracing spans.
 * @param prefix - Prefix for span names (e.g., "WORLD.runs")
 * @param o - Object with methods to instrument
 * @returns Instrumented object with same interface
 */
export function instrumentObject(prefix, o) {
    const handlers = {};
    for (const key of Object.keys(o)) {
        if (typeof o[key] !== 'function') {
            handlers[key] = o[key];
        }
        else {
            const f = o[key];
            // @ts-expect-error
            handlers[key] = async (...args) => trace(`${prefix}.${String(key)}`, {}, () => f(...args));
        }
    }
    return handlers;
}
export async function getSpanKind(field) {
    return withOtel((x) => x.SpanKind[field]);
}
export async function withOtel(fn) {
    const otel = await OtelApi.value;
    if (!otel)
        return undefined;
    return await fn(otel);
}
export function linkToCurrentContext() {
    return withOtel((otel) => {
        const context = otel.trace.getActiveSpan()?.spanContext();
        if (!context)
            return;
        return [{ context }];
    });
}
/**
 * Builds a span link pointing at the span context embedded in a serialized
 * trace carrier (e.g. the run-origin context flowing through queue
 * messages). Returns `undefined` when OTEL is unavailable, the carrier is
 * absent, or it does not contain a valid span context.
 */
export async function linkToTraceCarrier(carrier) {
    if (!carrier)
        return;
    const [context, otel] = await Promise.all([
        getSpanContextForTraceCarrier(carrier),
        OtelApi.value,
    ]);
    if (!context || !otel)
        return;
    if (!otel.trace.isSpanContextValid(context))
        return;
    return { context };
}
/**
 * Sets workflow context as OTEL baggage for automatic propagation.
 * Baggage is propagated across service boundaries via HTTP headers.
 * @param context - Workflow context to set as baggage
 * @returns A function to run within the baggage context
 */
export async function withWorkflowBaggage(context, fn) {
    const otel = await OtelApi.value;
    if (!otel)
        return fn();
    // Create baggage with workflow context
    const baggage = otel.propagation.createBaggage({
        'workflow.run_id': { value: context.workflowRunId },
        'workflow.name': { value: context.workflowName },
    });
    // Set baggage in context and run function
    const contextWithBaggage = otel.propagation.setBaggage(otel.context.active(), baggage);
    return otel.context.with(contextWithBaggage, () => fn());
}
/**
 * Retrieves workflow context from OTEL baggage.
 * @returns Workflow context if present in baggage, undefined otherwise
 */
export async function getWorkflowBaggage() {
    const otel = await OtelApi.value;
    if (!otel)
        return undefined;
    const baggage = otel.propagation.getBaggage(otel.context.active());
    if (!baggage)
        return undefined;
    const runId = baggage.getEntry('workflow.run_id')?.value;
    const name = baggage.getEntry('workflow.name')?.value;
    if (!runId || !name)
        return undefined;
    return {
        workflowRunId: runId,
        workflowName: name,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVsZW1ldHJ5LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3RlbGVtZXRyeS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFQSxPQUFPLEVBQUUsZUFBZSxFQUFFLElBQUksRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBQ3hELE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLGFBQWEsQ0FBQztBQUNqRCxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBQzVDLE9BQU8sS0FBSyxJQUFJLE1BQU0scUNBQXFDLENBQUM7QUFvQjVEOzs7O0dBSUc7QUFDSCxNQUFNLGlCQUFpQixHQUFHLGVBQWUsQ0FDdkMsbUNBQW1DLEVBQ25DLENBQUMsRUFDRCxHQUFHLEVBQUUsQ0FBQyxDQUFDLEVBQUUsWUFBWSxFQUFFLElBQUksR0FBRyxFQUFVLEVBQUUsQ0FBQyxDQUM1QyxDQUFDO0FBRUY7Ozs7O0dBS0c7QUFDSCxNQUFNLFVBQVUsb0JBQW9CO0lBQ2xDLE1BQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CLENBQUM7SUFDOUMsSUFBSSxLQUFLLEtBQUssWUFBWTtRQUFFLE9BQU8sWUFBWSxDQUFDO0lBQ2hELElBQ0UsS0FBSztRQUNMLEtBQUssS0FBSyxRQUFRO1FBQ2xCLENBQUMsaUJBQWlCLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFDMUMsQ0FBQztRQUNELGlCQUFpQixDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDMUMsYUFBYSxDQUFDLElBQUksQ0FDaEIsMkNBQTJDLEtBQUssaUVBQWlFLENBQ2xILENBQUM7SUFDSixDQUFDO0lBQ0QsT0FBTyxRQUFRLENBQUM7QUFDbEIsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILE1BQU0sVUFBVSxvQkFBb0IsQ0FDbEMsT0FBMkM7SUFFM0MsT0FBTyxPQUFPLEtBQUssU0FBUyxJQUFJLE1BQU0sQ0FBQyxJ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USxDQUFDLGVBQWUsQ0FBQyxFQUFFLEtBQUssQ0FBQztJQUV0RCxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSTtRQUFFLE9BQU8sU0FBUyxDQUFDO0lBRXRDLE9BQU87UUFDTCxhQUFhLEVBQUUsS0FBSztRQUNwQixZQUFZLEVBQUUsSUFBSTtLQUNuQixDQUFDO0FBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlICogYXMgYXBpIGZyb20gJ0BvcGVudGVsZW1ldHJ5L2FwaSc7XG5pbXBvcnQgdHlwZSB7IFNwYW4sIFNwYW5LaW5kLCBTcGFuT3B0aW9ucyB9IGZyb20gJ0BvcGVudGVsZW1ldHJ5L2FwaSc7XG5pbXBvcnQgeyBnbG9iYWxTaW5nbGV0b24sIG9uY2UgfSBmcm9tICdAd29ya2Zsb3cvdXRpbHMnO1xuaW1wb3J0IHsgV29ya2Zsb3dTdXNwZW5zaW9uIH0gZnJvbSAnLi9nbG9iYWwuanMnO1xuaW1wb3J0IHsgcnVudGltZUxvZ2dlciB9IGZyb20gJy4vbG9nZ2VyLmpzJztcbmltcG9ydCAqIGFzIEF0dHIgZnJvbSAnLi90ZWxlbWV0cnkvc2VtYW50aWMtY29udmVudGlvbnMuanMnO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFRyYWNlIENvbnRleHQgUHJvcGFnYXRpb24gVXRpbGl0aWVzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBDb250cm9scyBob3cgd29ya2Zsb3cvc3RlcCBxdWV1ZS1oYW5kbGVyIHNwYW5zIHJlbGF0ZSB0byB0aGUgcnVuLW9yaWdpblxuICogdHJhY2UgY29udGV4dCBjYXJyaWVkIGluIHF1ZXVlIG1lc3NhZ2VzOlxuICpcbiAqIC0gYCdsaW5rZWQnYCAoZGVmYXVsdCk6IGVhY2ggaW52b2NhdGlvbiBzdGFydHMgYSBORVcgcm9vdCB0cmFjZTsgdGhlXG4gKiAgIHJ1bi1vcmlnaW4gY29udGV4dCAoYW5kIHRoZSBpbmNvbWluZyBkZWxpdmVyeSBjb250ZXh0KSBhcmUgYXR0YWNoZWQgYXNcbiAqICAgc3BhbiBsaW5rcy4gVGhpcyBrZWVwcyB0cmFjZXMgYm91bmRlZCBwZXIgaW52b2NhdGlvbiBpbnN0ZWFkIG9mXG4gKiAgIHN0aXRjaGluZyBhIGxvbmctbGl2ZWQgcnVuIGludG8gb25lIGdpYW50IHRyYWNlLlxuICogLSBgJ2NvbnRpbnVvdXMnYDogdGhlIHJlc3RvcmVkIHJ1bi1vcmlnaW4gY29udGV4dCBiZWNvbWVzIHRoZSBwYXJlbnQgb2ZcbiAqICAgdGhlIGludm9jYXRpb24gc3BhbiAobGVnYWN5IGJlaGF2aW9yKSwgcHJvZHVjaW5nIGEgc2luZ2xlIHRyYWNlIHRoYXRcbiAqICAgc3BhbnMgdGhlIGVudGlyZSBydW4uXG4gKi9cbmV4cG9ydCB0eXBlIFdvcmtmbG93VHJhY2VNb2RlID0gJ2xpbmtlZCcgfCAnY29udGludW91cyc7XG5cbi8qKlxuICogVW5yZWNvZ25pemVkIGBXT1JLRkxPV19UUkFDRV9NT0RFYCB2YWx1ZXMgd2UgYWxyZWFkeSB3YXJuZWQgYWJvdXQuIE9uXG4gKiBgZ2xvYmFsVGhpc2AgKHNlZSBgZ2xvYmFsU2luZ2xldG9uYCkgc28gdGhlIHdhcm5pbmcgc3RheXMgb25jZSBwZXIgcHJvY2Vzc1xuICogcmF0aGVyIHRoYW4gb25jZSBwZXIgYnVuZGxlciBsYXllci5cbiAqL1xuY29uc3QgdHJhY2VNb2RlV2FybmluZ3MgPSBnbG9iYWxTaW5nbGV0b24oXG4gICdAd29ya2Zsb3cvY29yZS8vdHJhY2VNb2RlV2FybmluZ3MnLFxuICAxLFxuICAoKSA9PiAoeyB1bnJlY29nbml6ZWQ6IG5ldyBTZXQ8c3RyaW5nPigpIH0pXG4pO1xuXG4vKipcbiAqIFJlc29sdmVzIHRoZSBhY3RpdmUgdHJhY2UgbW9kZSBmcm9tIHRoZSBgV09SS0ZMT1dfVFJBQ0VfTU9ERWAgZW52IHZhci5cbiAqIERlZmF1bHRzIHRvIGAnbGlua2VkJ2A7IGFueSB2YWx1ZSBvdGhlciB0aGFuIGAnY29udGludW91cydgIHNlbGVjdHMgaXQuXG4gKiBVbnJlY29nbml6ZWQgbm9uLWVtcHR5IHZhbHVlcyAoZS5nLiB0eXBvcyBsaWtlIGBjb250aW5vdXNgKSBlbWl0IGFcbiAqIG9uZS10aW1lIHdhcm5pbmcgc28gc2lsZW50IGZhbGxiYWNrIHRvIGBsaW5rZWRgIGlzIGF0IGxlYXN0IHZpc2libGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRXb3JrZmxvd1RyYWNlTW9kZSgpOiBXb3JrZmxvd1RyYWNlTW9kZSB7XG4gIGNvbnN0IHZhbHVlID0gcHJvY2Vzcy5lbnYuV09SS0ZMT1dfVFJBQ0VfTU9ERTtcbiAgaWYgKHZhbHVlID09PSAnY29udGludW91cycpIHJldHVybiAnY29udGludW91cyc7XG4gIGlmIChcbiAgICB2YWx1ZSAmJlxuICAgIHZhbHVlICE9PSAnbGlua2VkJyAmJlxuICAgICF0cmFjZU1vZGVXYXJuaW5ncy51bnJlY29nbml6ZWQuaGFzKHZhbHVlKVxuICApIHtcbiAgICB0cmFjZU1vZGVXYXJuaW5ncy51bnJlY29nbml6ZWQuYWRkKHZhbHVlKTtcbiAgICBydW50aW1lTG9nZ2VyLndhcm4oXG4gICAgICBgVW5yZWNvZ25pemVkIFdPUktGTE9XX1RSQUNFX01PREUgdmFsdWUgXCIke3ZhbHVlfVwiOyBleHBlY3RlZCBcImxpbmtlZFwiIG9yIFwiY29udGludW91c1wiLiBGYWxsaW5nIGJhY2sgdG8gXCJsaW5rZWRcIi5gXG4gICAgKTtcbiAgfVxuICByZXR1cm4gJ2xpbmtlZCc7XG59XG5cbi8qKlxuICogUmV0dXJucyB3aGV0aGVyIGEgc2VyaWFsaXplZCB0cmFjZSBjYXJyaWVyIGlzIHVzYWJsZSwgaS5lLiBwcmVzZW50IGFuZFxuICogbm9uLWVtcHR5LiBgc2VyaWFsaXplVHJhY2VDYXJyaWVyKClgIHJldHVybnMgYHt9YCB3aGVuIG5vIE9URUwgU0RLIGlzXG4gKiByZWdpc3RlcmVkIG9yIG5vIHNwYW4gaXMgYWN0aXZlLCBhbmQgYHN0YXJ0KClgIGFsd2F5cyBhdHRhY2hlcyB0aGVcbiAqIGNhcnJpZXIgdG8gdGhlIGZpcnN0IHF1ZXVlIG1lc3NhZ2UsIHNvIGFuIGVtcHR5IGNhcnJpZXIgbXVzdCBiZSB0cmVhdGVkXG4gKiB0aGUgc2FtZSBhcyBhbiBhYnNlbnQgb25lIHdoZXJldmVyIHRoZSB0cmFjZS1tb2RlIGxvZ2ljIGJyYW5jaGVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNVc2FibGVUcmFjZUNhcnJpZXIoXG4gIGNhcnJpZXI6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWRcbik6IGNhcnJpZXIgaXMgUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gIHJldHVybiBjYXJyaWVyICE9PSB1bmRlZmluZWQgJiYgT2JqZWN0LmtleXMoY2FycmllcikubGVuZ3RoID4gMDtcbn1cblxuLyoqXG4gKiBSZXR1cm5zIHRoZSB0cmFjZSBjYXJyaWVyIHRvIGF0dGFjaCB0byBtZXNzYWdlcyB0aGUgY3VycmVudCBpbnZvY2F0aW9uXG4gKiBlbnF1ZXVlcy4gSW4gYGxpbmtlZGAgbW9kZSB0aGUgT1JJR0lOQUwgcnVuLW9yaWdpbiBjYXJyaWVyIGlzIGZvcndhcmRlZFxuICogdW5jaGFuZ2VkICh3aGVuIHVzYWJsZSkgc28gZXZlcnkgZnV0dXJlIGludm9jYXRpb24gbGlua3MgYmFjayB0byB0aGUgc2FtZVxuICogb3JpZ2luOyBvdGhlcndpc2UgKGBjb250aW51b3VzYCBtb2RlLCBvciBubyB1c2FibGUgaW5jb21pbmcgY2FycmllcilcbiAqIHRoZSBjdXJyZW50IChhY3RpdmUpIGNvbnRleHQgaXMgc2VyaWFsaXplZCwgc28gdGhlIHRyYWNlIGtlZXBzIGNoYWluaW5nXG4gKiAoY29udGludW91cykgb3IgdGhlIGZpcnN0IGluc3RydW1lbnRlZCBpbnZvY2F0aW9uIGJlY29tZXMgdGhlIGRlLWZhY3RvXG4gKiBvcmlnaW4gKGxpbmtlZCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXROZXh0VHJhY2VDYXJyaWVyKFxuICB0cmFjZU1vZGU6IFdvcmtmbG93VHJhY2VNb2RlLFxuICBpbmNvbWluZ0NhcnJpZXI6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWRcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4ge1xuICByZXR1cm4gdHJhY2VNb2RlID09PSAnbGlua2VkJyAmJiBpc1VzYWJsZVRyYWNlQ2FycmllcihpbmNvbWluZ0NhcnJpZXIpXG4gICAgPyBQcm9taXNlLnJlc29sdmUoaW5jb21pbmdDYXJyaWVyKVxuICAgIDogc2VyaWFsaXplVHJhY2VDYXJyaWVyKCk7XG59XG5cbi8qKlxuICogQnVpbGRzIHRoZSBzcGFuIGxpbmtzIGZvciBhIHF1ZXVlLWRlbGl2ZXJlZCBpbnZvY2F0aW9uIHNwYW5cbiAqIChgd29ya2Zsb3cuZXhlY3V0ZWAgLyBgc3RlcC5leGVjdXRlYCk6XG4gKlxuICogLSBJbiBgbGlua2VkYCBtb2RlIHRoZSBpbnZvY2F0aW9uIHNwYW4gaXMgYSBDSElMRCBvZiB0aGUgbG9jYWwgZGVsaXZlcnlcbiAqICAgKGZsb3ctcm91dGUpIGNvbnRleHQsIHNvIHRoZSBvbmx5IGxpbmsgaXMgdG8gdGhlIHJ1bi1vcmlnaW4gY29udGV4dFxuICogICBmcm9tIHRoZSBtZXNzYWdlJ3MgdHJhY2UgY2FycmllciwgY29ubmVjdGluZyB0aGlzIGJvdW5kZWQgcGVyLWludm9jYXRpb25cbiAqICAgdHJhY2UgYmFjayB0byB3aGVyZSB0aGUgcnVuIHdhcyBzdGFydGVkLiBUaGUgcnVuLW9yaWdpbiBjb250ZXh0IGlzIGFcbiAqICAgbGluaywgbmV2ZXIgYSBwYXJlbnQsIGFuZCByZS1lbnF1ZXVlcyBmb3J3YXJkIHRoZSBvcmlnaW5hbCBjYXJyaWVyXG4gKiAgIHVuY2hhbmdlZCwgc28gdGhlIHdob2xlIHJ1biBpcyBuZXZlciBzdGl0Y2hlZCBpbnRvIG9uZSBnaWFudCB0cmFjZS5cbiAqICAgVGhlIGxpbmsgaXMgc2tpcHBlZCB3aGVuIHRoZSBjYXJyaWVyIGlzIGFic2VudCwgZW1wdHksIG9yIGludmFsaWQuXG4gKiAtIEluIGBjb250aW51b3VzYCBtb2RlIHRoZSBydW4tb3JpZ2luIGNvbnRleHQgaXMgcmVzdG9yZWQgYXMgdGhlIHBhcmVudFxuICogICBpbnN0ZWFkLCBhbmQgdGhlIGxpbmsgcG9pbnRzIGF0IHRoZSBpbmNvbWluZyBkZWxpdmVyeSBjb250ZXh0LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGRJbnZvY2F0aW9uU3BhbkxpbmtzKFxuICB0cmFjZU1vZGU6IFdvcmtmbG93VHJhY2VNb2RlLFxuICBpbmNvbWluZ0NhcnJpZXI6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWRcbik6IFByb21pc2U8YXBpLkxpbmtbXSB8IHVuZGVmaW5lZD4ge1xuICBpZiAodHJhY2VNb2RlICE9PSAnbGlua2VkJykgcmV0dXJuIGxpbmtUb0N1cnJlbnRDb250ZXh0KCk7XG4gIGNvbnN0IG9yaWdpbkxpbmsgPSBhd2FpdCBsaW5rVG9UcmFjZUNhcnJpZXIoXG4gICAgaXNVc2FibGVUcmFjZUNhcnJpZXIoaW5jb21pbmdDYXJyaWVyKSA/IGluY29taW5nQ2FycmllciA6IHVuZGVmaW5lZFxuICApO1xuICByZXR1cm4gb3JpZ2luTGluayA/IFtvcmlnaW5MaW5rXSA6IHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBTZXJpYWxpemVzIHRoZSBjdXJyZW50IHRyYWNlIGNvbnRleHQgaW50byBhIGZvcm1hdCB0aGF0IGNhbiBiZSBwYXNzZWQgdGhyb3VnaCBxdWV1ZXNcbiAqIEByZXR1cm5zIEEgcmVjb3JkIG9mIHN0cmluZ3MgcmVwcmVzZW50aW5nIHRoZSB0cmFjZSBjb250ZXh0XG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZXJpYWxpemVUcmFjZUNhcnJpZXIoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiB7XG4gIGNvbnN0IG90ZWwgPSBhd2FpdCBPdGVsQXBpLnZhbHVlO1xuICBpZiAoIW90ZWwpIHJldHVybiB7fTtcbiAgY29uc3QgY2FycmllcjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAvLyBJbmplY3QgdGhlIGN1cnJlbnQgY29udGV4dCBpbnRvIHRoZSBjYXJyaWVyXG4gIG90ZWwucHJvcGFnYXRpb24uaW5qZWN0KG90ZWwuY29udGV4dC5hY3RpdmUoKSwgY2Fycmllcik7XG4gIHJldHVybiBjYXJyaWVyO1xufVxuXG4vKipcbiAqIERlc2VyaWFsaXplcyB0cmFjZSBjb250ZXh0IGFuZCByZXR1cm5zIGEgY29udGV4dCB0aGF0IGNhbiBiZSB1c2VkIHRvIGNvbnRpbnVlIHRoZSB0cmFjZVxuICogQHBhcmFtIHRyYWNlQ2FycmllciBUaGUgc2VyaWFsaXplZCB0cmFjZSBjb250ZXh0XG4gKiBAcmV0dXJucyBPcGVuVGVsZW1ldHJ5IGNvbnRleHQgd2l0aCB0aGUgcmVzdG9yZWQgdHJhY2VcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRlc2VyaWFsaXplVHJhY2VDYXJyaWVyKFxuICB0cmFjZUNhcnJpZXI6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbikge1xuICBjb25zdCBvdGVsID0gYXdhaXQgT3RlbEFwaS52YWx1ZTtcbiAgaWYgKCFvdGVsKSByZXR1cm47XG4gIC8vIEV4dHJhY3QgdGhlIGNvbnRleHQgZnJvbSB0aGUgY2FycmllclxuICByZXR1cm4gb3RlbC5wcm9wYWdhdGlvbi5leHRyYWN0KG90ZWwuY29udGV4dC5hY3RpdmUoKSwgdHJhY2VDYXJyaWVyKTtcbn1cblxuLyoqXG4gKiBSdW5zIGEgZnVuY3Rpb24gd2l0aGluIHRoZSBjb250ZXh0IG9mIGEgZGVzZXJpYWxpemVkIHRyYWNlXG4gKiBAcGFyYW0gdHJhY2VDYXJyaWVyIFRoZSBzZXJpYWxpemVkIHRyYWNlIGNhcnJpZXIgKG9wdGlvbmFsKVxuICogQHBhcmFtIGZuIFRoZSBmdW5jdGlvbiB0byBydW4gd2l0aGluIHRoZSB0cmFjZSBjb250ZXh0XG4gKiBAcmV0dXJucyBUaGUgcmVzdWx0IG9mIHRoZSBmdW5jdGlvblxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd2l0aFRyYWNlQ29udGV4dDxUPihcbiAgdHJhY2VDYXJyaWVyOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHwgdW5kZWZpbmVkLFxuICBmbjogKCkgPT4gUHJvbWlzZTxUPlxuKTogUHJvbWlzZTxUPiB7XG4gIGlmICghdHJhY2VDYXJyaWVyKSB7XG4gICAgcmV0dXJuIGZuKCk7XG4gIH1cblxuICBjb25zdCBvdGVsID0gYXdhaXQgT3RlbEFwaS52YWx1ZTtcbiAgaWYgKCFvdGVsKSByZXR1cm4gZm4oKTtcblxuICBjb25zdCBleHRyYWN0ZWRDb250ZXh0ID0gYXdhaXQgZGVzZXJpYWxpemVUcmFjZUNhcnJpZXIodHJhY2VDYXJyaWVyKTtcbiAgaWYgKCFleHRyYWN0ZWRDb250ZXh0KSB7XG4gICAgcmV0dXJuIGZuKCk7XG4gIH1cblxuICByZXR1cm4gb3RlbC5jb250ZXh0LndpdGgoZXh0cmFjdGVkQ29udGV4dCwgYXN5bmMgKCkgPT4gYXdhaXQgZm4oKSk7XG59XG5cbmNvbnN0IE90ZWxBcGkgPSBvbmNlKGFzeW5jICgpID0+IHtcbiAgLy8gYEBvcGVudGVsZW1ldHJ5L2FwaWAgaXMgYW4gb3B0aW9uYWwgcGVlciBkZXBlbmRlbmN5LiBUaGUgc3RhdGljIHNwZWNpZmllclxuICAvLyBpcyBpbnRlbnRpb25hbDogZXNidWlsZC1idW5kbGVkIHRhcmdldHMgKHRoZSBDTEknc1xuICAvLyBgdmVyY2VsLWJ1aWxkLW91dHB1dC1hcGlgIGJ1aWxkLCBOaXRybywgQXN0cm8pIHNoaXAgYSBzZWxmLWNvbnRhaW5lZFxuICAvLyBidW5kbGUgd2l0aCBubyBub2RlX21vZHVsZXMsIHNvIHRoZSBwYWNrYWdlIG11c3QgYmUgKmlubGluZWQqIGF0IGJ1aWxkXG4gIC8vIHRpbWUgZm9yIHNwYW5zIHRvIHdvcmsgYXQgcnVudGltZTsgYSBydW50aW1lLWJ1aWx0IHNwZWNpZmllciBpcyBvcGFxdWUgdG9cbiAgLy8gZXNidWlsZCBhbmQgd291bGQgc2lsZW50bHkgZGlzYWJsZSB0cmFjaW5nIHRoZXJlLiBCdW5kbGVycyB0aGF0IHJlamVjdCBhblxuICAvLyB1bnJlc29sdmFibGUgc3RhdGljIGBpbXBvcnQoKWAgd2hlbiB0aGUgcGVlciBpc24ndCBpbnN0YWxsZWQgKFJvbGx1cC9WaXRlLFxuICAvLyBlLmcuIFN2ZWx0ZUtpdCkgaW5zdGVhZCBleHRlcm5hbGl6ZSBgQG9wZW50ZWxlbWV0cnkvYXBpYCBpbiB0aGUgd29ya2Zsb3dcbiAgLy8gZnJhbWV3b3JrIGludGVncmF0aW9uLCB3aGljaCBrZWVwcyB0aGUgYnVpbGQgZ3JlZW4gYW5kIHN0aWxsIGxvYWRzIHJlYWxcbiAgLy8gT1RlbCB3aGVuIHRoZSBwZWVyIGlzIHByZXNlbnQuIFJ1bnRpbWUgc2VtYW50aWNzOiBwcmVzZW50IOKGkiBsb2FkZWQsIGFic2VudFxuICAvLyDihpIgY2F1Z2h0IGFuZCB0cmFjaW5nIGRpc2FibGVkLlxuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBpbXBvcnQoJ0BvcGVudGVsZW1ldHJ5L2FwaScpO1xuICB9IGNhdGNoIHtcbiAgICBydW50aW1lTG9nZ2VyLmluZm8oJ09wZW5UZWxlbWV0cnkgbm90IGF2YWlsYWJsZSwgdHJhY2luZyB3aWxsIGJlIGRpc2FibGVkJyk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn0pO1xuXG5jb25zdCBUcmFjZXIgPSBvbmNlKGFzeW5jICgpID0+IHtcbiAgY29uc3QgYXBpID0gYXdhaXQgT3RlbEFwaS52YWx1ZTtcbiAgaWYgKCFhcGkpIHJldHVybiBudWxsO1xuICBjb25zdCB0cmFjZXIgPSBhcGkudHJhY2UuZ2V0VHJhY2VyKCd3b3JrZmxvdycpO1xuICBsb2dPdGVsRGlhZ25vc3RpY09uY2UoYXBpLCB0cmFjZXIpO1xuICByZXR1cm4gdHJhY2VyO1xufSk7XG5cbmNvbnN0IFN0ZXBFeGVjdXRpb25EdXJhdGlvbkhpc3RvZ3JhbSA9IG9uY2UoYXN5bmMgKCkgPT4ge1xuICBjb25zdCBvdGVsID0gYXdhaXQgT3RlbEFwaS52YWx1ZTtcbiAgaWYgKCFvdGVsKSByZXR1cm4gbnVsbDtcbiAgLy8gc2VydmljZS5uYW1lIGlzIGEgcmVzb3VyY2UgYXR0cmlidXRlLCBhcHBsaWVkIGJ5IHRoZSBjb25maWd1cmVkIHByb3ZpZGVyLlxuICByZXR1cm4gb3RlbC5tZXRyaWNzXG4gICAgLmdldE1ldGVyKCd3b3JrZmxvdycpXG4gICAgLmNyZWF0ZUhpc3RvZ3JhbSgnd29ya2Zsb3cuc3RlcC5leGVjdXRlLmR1cmF0aW9uJywge1xuICAgICAgZGVzY3JpcHRpb246ICdEdXJhdGlvbiBvZiB1c2VyIHN0ZXAgZXhlY3V0aW9uJyxcbiAgICAgIHVuaXQ6ICdtcycsXG4gICAgfSk7XG59KTtcblxuLyoqXG4gKiBPbmUtc2hvdCBydW50aW1lIGRpYWdub3N0aWMgKERFQlVHPXdvcmtmbG93Oiogb25seSksIHNhbWUgc2hhcGUgYXMgdGhlIG9uZVxuICogd29ybGQtdmVyY2VsIGVtaXRzIHRhZ2dlZCBgd29ybGQtdmVyY2VsYDogcHJpbnRzIGhvdyB0aGlzIG1vZHVsZSBpbnN0YW5jZVxuICogb2YgYEBvcGVudGVsZW1ldHJ5L2FwaWAgc2VlcyB0aGUgZ2xvYmFsIHJlZ2lzdHJhdGlvbiwgc28gYSBkZXBsb3ltZW50J3NcbiAqIGxvZ3Mgc2hvdyB0aGUgdHdvIHBhY2thZ2VzJyB2aWV3cyBzaWRlIGJ5IHNpZGUuXG4gKi9cbi8vIHBlci1jb3B5LW9rOiB0aGlzIGRpYWdub3N0aWMgcmVwb3J0cyBob3cgVEhJUyBtb2R1bGUgaW5zdGFuY2Ugc2VlcyB0aGUgZ2xvYmFsXG4vLyBPVGVsIHJlZ2lzdHJhdGlvbiwgd2hpY2ggaXMgdGhlIHdob2xlIHBvaW50IG9mIHRoZSBsb2cuIFdpdGggc2V2ZXJhbCBjb3BpZXNcbi8vIGluIGEgcHJvY2VzcywgZWFjaCBvbmUncyB2aWV3IGlzIHdoYXQgaXMgd29ydGggc2VlaW5nLlxubGV0IG90ZWxEaWFnTG9nZ2VkID0gZmFsc2U7XG5cbmZ1bmN0aW9uIGRlc2NyaWJlVGhyb3duVmFsdWUodmFsdWU6IHVua25vd24pOiBzdHJpbmcge1xuICB0cnkge1xuICAgIGlmIChcbiAgICAgIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiZcbiAgICAgIHZhbHVlICE9PSBudWxsICYmXG4gICAgICAnbWVzc2FnZScgaW4gdmFsdWUgJiZcbiAgICAgIHR5cGVvZiB2YWx1ZS5tZXNzYWdlID09PSAnc3RyaW5nJ1xuICAgICkge1xuICAgICAgcmV0dXJuIHZhbHVlLm1lc3NhZ2U7XG4gICAgfVxuICAgIHJldHVybiBTdHJpbmcodmFsdWUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gJ1Vua25vd24gZXJyb3InO1xuICB9XG59XG5cbmZ1bmN0aW9uIGxvZ090ZWxEaWFnbm9zdGljT25jZShvdGVsOiB0eXBlb2YgYXBpLCB0cmFjZXI6IGFwaS5UcmFjZXIpOiB2b2lkIHtcbiAgY29uc3QgZGVidWdFbmFibGVkID1cbiAgICB0eXBlb2YgcHJvY2VzcyAhPT0gJ3VuZGVmaW5lZCcgJiZcbiAgICB0eXBlb2YgcHJvY2Vzcy5lbnYuREVCVUcgPT09ICdzdHJpbmcnICYmXG4gICAgKHByb2Nlc3MuZW52LkRFQlVHLmluY2x1ZGVzKCd3b3JrZmxvdzonKSB8fCBwcm9jZXNzLmVudi5ERUJVRyA9PT0gJyonKTtcbiAgaWYgKG90ZWxEaWFnTG9nZ2VkIHx8ICFkZWJ1Z0VuYWJsZWQpIHJldHVybjtcbiAgb3RlbERpYWdMb2dnZWQgPSB0cnVlO1xuICB0cnkge1xuICAgIGNvbnN0IGcgPSAoZ2xvYmFsVGhpcyBhcyBSZWNvcmQ8c3ltYm9sLCB1bmtub3duPilbXG4gICAgICBTeW1ib2wuZm9yKCdvcGVudGVsZW1ldHJ5LmpzLmFwaS4xJylcbiAgICBdIGFzIHsgdmVyc2lvbj86IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IHByb3ZpZGVyID0gb3RlbC50cmFjZS5nZXRUcmFjZXJQcm92aWRlcigpO1xuICAgIGNvbnN0IGRlbGVnYXRlID1cbiAgICAgIChwcm92aWRlciBhcyB7IGdldERlbGVnYXRlPzogKCkgPT4gdW5rbm93biB9KS5nZXREZWxlZ2F0ZT8uKCkgPz8gcHJvdmlkZXI7XG4gICAgY29uc3QgcHJvYmUgPSB0cmFjZXIuc3RhcnRTcGFuKCd3b3JrZmxvdy5vdGVsLnByb2JlLmNvcmUnKTtcbiAgICBjb25zb2xlLndhcm4oXG4gICAgICAnW3dvcmtmbG93Om90ZWwtZGlhZ10gY29yZScsXG4gICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGdsb2JhbFJlZ2lzdHJhdGlvblZlcnNpb246IGc/LnZlcnNpb24gPz8gbnVsbCxcbiAgICAgICAgcHJvdmlkZXJDdG9yOiBwcm92aWRlcj8uY29uc3RydWN0b3I/Lm5hbWUgPz8gbnVsbCxcbiAgICAgICAgZGVsZWdhdGVDdG9yOiAoZGVsZWdhdGUgYXMgb2JqZWN0IHwgbnVsbCk/LmNvbnN0cnVjdG9yPy5uYW1lID8/IG51bGwsXG4gICAgICAgIHRyYWNlckN0b3I6IHRyYWNlcj8uY29uc3RydWN0b3I/Lm5hbWUgPz8gbnVsbCxcbiAgICAgICAgcHJvYmVDdG9yOiBwcm9iZT8uY29uc3RydWN0b3I/Lm5hbWUgPz8gbnVsbCxcbiAgICAgICAgcHJvYmVSZWNvcmRpbmc6IHByb2JlLmlzUmVjb3JkaW5nKCksXG4gICAgICB9KVxuICAgICk7XG4gICAgcHJvYmUuZW5kKCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS53YXJuKFxuICAgICAgJ1t3b3JrZmxvdzpvdGVsLWRpYWddIGNvcmUgZmFpbGVkOicsXG4gICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IGVycm9yXG4gICAgKTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdHJhY2U8VD4oXG4gIHNwYW5OYW1lOiBzdHJpbmcsXG4gIC4uLmFyZ3M6XG4gICAgfCBbZm46IChzcGFuPzogU3BhbikgPT4gUHJvbWlzZTxUPl1cbiAgICB8IFtvcHRzOiBTcGFuT3B0aW9ucywgZm46IChzcGFuPzogU3BhbikgPT4gUHJvbWlzZTxUPl1cbik6IFByb21pc2U8VD4ge1xuICBjb25zdCBbdHJhY2VyLCBvdGVsXSA9IGF3YWl0IFByb21pc2UuYWxsKFtUcmFjZXIudmFsdWUsIE90ZWxBcGkudmFsdWVdKTtcbiAgY29uc3QgeyBmbiwgb3B0cyB9ID1cbiAgICB0eXBlb2YgYXJnc1swXSA9PT0gJ2Z1bmN0aW9uJ1xuICAgICAgPyB7IGZuOiBhcmdzWzBdLCBvcHRzOiB7fSB9XG4gICAgICA6IHsgZm46IGFyZ3NbMV0sIG9wdHM6IGFyZ3NbMF0gfTtcbiAgaWYgKCFmbikgdGhyb3cgbmV3IEVycm9yKCdGdW5jdGlvbiB0byB0cmFjZSBtdXN0IGJlIHByb3ZpZGVkJyk7XG5cbiAgaWYgKCF0cmFjZXIgfHwgIW90ZWwpIHtcbiAgICByZXR1cm4gYXdhaXQgZm4oKTtcbiAgfVxuXG4gIHJldHVybiB0cmFjZXIuc3RhcnRBY3RpdmVTcGFuKHNwYW5OYW1lLCBvcHRzLCBhc3luYyAoc3BhbikgPT4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBmbihzcGFuKTtcbiAgICAgIHNwYW4uc2V0U3RhdHVzKHsgY29kZTogb3RlbC5TcGFuU3RhdHVzQ29kZS5PSyB9KTtcbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKFdvcmtmbG93U3VzcGVuc2lvbi5pcyhlKSkge1xuICAgICAgICBzcGFuLnNldFN0YXR1cyh7IGNvZGU6IG90ZWwuU3BhblN0YXR1c0NvZGUuT0sgfSk7XG4gICAgICAgIGFwcGx5V29ya2Zsb3dTdXNwZW5zaW9uVG9TcGFuKGUsIHNwYW4pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc3Bhbi5zZXRTdGF0dXMoe1xuICAgICAgICAgIGNvZGU6IG90ZWwuU3BhblN0YXR1c0NvZGUuRVJST1IsXG4gICAgICAgICAgbWVzc2FnZTogZGVzY3JpYmVUaHJvd25WYWx1ZShlKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICB0aHJvdyBlO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBzcGFuLmVuZCgpO1xuICAgIH1cbiAgfSk7XG59XG5cbi8qKiBTdGFydHMgYSBjaGlsZCBzcGFuIHdpdGhvdXQgaW5zdGFsbGluZyBpdCBhcyB0aGUgYWN0aXZlIGNvbnRleHQuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRUcmFjZVNwYW4oc3Bhbk5hbWU6IHN0cmluZykge1xuICBjb25zdCBbdHJhY2VyLCBvdGVsXSA9IGF3YWl0IFByb21pc2UuYWxsKFtUcmFjZXIudmFsdWUsIE90ZWxBcGkudmFsdWVdKTtcbiAgaWYgKCF0cmFjZXIgfHwgIW90ZWwpIHJldHVybiB7IGVuZCgpIHt9LCBmYWlsKCkge30gfTtcblxuICBjb25zdCBzcGFuID0gdHJhY2VyLnN0YXJ0U3BhbihzcGFuTmFtZSk7XG4gIGxldCBlbmRlZCA9IGZhbHNlO1xuICBjb25zdCBmaW5pc2ggPSAoc3RhdHVzOiBhcGkuU3BhblN0YXR1cykgPT4ge1xuICAgIGlmIChlbmRlZCkgcmV0dXJuO1xuICAgIGVuZGVkID0gdHJ1ZTtcbiAgICBzcGFuLnNldFN0YXR1cyhzdGF0dXMpO1xuICAgIHNwYW4uZW5kKCk7XG4gIH07XG5cbiAgcmV0dXJuIHtcbiAgICBlbmQ6ICgpID0+IGZpbmlzaCh7IGNvZGU6IG90ZWwuU3BhblN0YXR1c0NvZGUuT0sgfSksXG4gICAgZmFpbDogKGVycm9yOiB1bmtub3duKSA9PlxuICAgICAgZmluaXNoKHtcbiAgICAgICAgY29kZTogb3RlbC5TcGFuU3RhdHVzQ29kZS5FUlJPUixcbiAgICAgICAgbWVzc2FnZTogZGVzY3JpYmVUaHJvd25WYWx1ZShlcnJvciksXG4gICAgICB9KSxcbiAgfTtcbn1cblxuLyoqIEJpbmQgd29yayB0byB0aGUgY3VycmVudGx5IGFjdGl2ZSBzcGFuIGV2ZW4gd2hlbiBpdCBzdGFydHMgZnJvbSBhIGNoaWxkLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJpbmRBY3RpdmVUcmFjZUNvbnRleHQ8QXJncyBleHRlbmRzIHVua25vd25bXSwgUmVzdWx0PihcbiAgZm46ICguLi5hcmdzOiBBcmdzKSA9PiBSZXN1bHRcbik6IFByb21pc2U8KC4uLmFyZ3M6IEFyZ3MpID0+IFJlc3VsdD4ge1xuICBjb25zdCBvdGVsID0gYXdhaXQgT3RlbEFwaS52YWx1ZTtcbiAgcmV0dXJuIG90ZWwgPyBvdGVsLmNvbnRleHQuYmluZChvdGVsLmNvbnRleHQuYWN0aXZlKCksIGZuKSA6IGZuO1xufVxuXG4vKiogS2VlcHMgYSBwYXJrZWQgd29ya2Zsb3cncyBhbWJpZW50IHRyYWNlIGNvbnRleHQgYWxpZ25lZCB3aXRoIGVhY2ggcmVzdW1lLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNyZWF0ZVJlZnJlc2hhYmxlVHJhY2VDb250ZXh0KCkge1xuICBjb25zdCBvdGVsID0gYXdhaXQgT3RlbEFwaS52YWx1ZTtcbiAgaWYgKCFvdGVsKSB7XG4gICAgcmV0dXJuIHsgcmVmcmVzaCgpIHt9LCBydW46IDxUPihmbjogKCkgPT4gVCk6IFQgPT4gZm4oKSB9O1xuICB9XG5cbiAgbGV0IGN1cnJlbnQgPSBvdGVsLmNvbnRleHQuYWN0aXZlKCk7XG4gIGNvbnN0IGNvbnRleHQ6IGFwaS5Db250ZXh0ID0ge1xuICAgIGdldFZhbHVlOiAoa2V5KSA9PiBjdXJyZW50LmdldFZhbHVlKGtleSksXG4gICAgc2V0VmFsdWU6IChrZXksIHZhbHVlKSA9PiBjdXJyZW50LnNldFZhbHVlKGtleSwgdmFsdWUpLFxuICAgIGRlbGV0ZVZhbHVlOiAoa2V5KSA9PiBjdXJyZW50LmRlbGV0ZVZhbHVlKGtleSksXG4gIH07XG5cbiAgcmV0dXJuIHtcbiAgICByZWZyZXNoOiAoKSA9PiB7XG4gICAgICBjdXJyZW50ID0gb3RlbC5jb250ZXh0LmFjdGl2ZSgpO1xuICAgIH0sXG4gICAgcnVuOiA8VD4oZm46ICgpID0+IFQpOiBUID0+IG90ZWwuY29udGV4dC53aXRoKGNvbnRleHQsIGZuKSxcbiAgfTtcbn1cblxuLyoqXG4gKiBFbWl0IGEgc3BhbiB3aG9zZSBzdGFydCBpcyBiYWNrLWRhdGVkIHRvIGBzdGFydEVwb2NoTXNgIGFuZCB3aG9zZSBlbmQgaXMgbm93LFxuICogc28gaXRzIGR1cmF0aW9uIHJlZmxlY3RzIGFuIGludGVydmFsIG9ubHkgbWVhc3VyYWJsZSBhdCBpdHMgZW5kIChlLmcuXG4gKiB0aW1lLXRvLWZpcnN0LWNodW5rLCBrbm93biB3aGVuIHRoZSBmaXJzdCBjaHVuayBhcnJpdmVzKS4gVW5saWtlIGB0cmFjZSgpYCxcbiAqIHRoaXMgcmVjb3JkcyBhbiBhbHJlYWR5LWVsYXBzZWQgc3BhbiBpbiBvbmUgc2hvdCByYXRoZXIgdGhhbiB3cmFwcGluZyBhXG4gKiBjYWxsYmFjay4gTm8tb3Agd2hlbiBPcGVuVGVsZW1ldHJ5IGlzIG5vdCBhdmFpbGFibGUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWNvcmRFbGFwc2VkU3BhbihcbiAgc3Bhbk5hbWU6IHN0cmluZyxcbiAgc3RhcnRFcG9jaE1zOiBudW1iZXIsXG4gIG9wdHM/OiBTcGFuT3B0aW9uc1xuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRyYWNlciA9IGF3YWl0IFRyYWNlci52YWx1ZTtcbiAgaWYgKCF0cmFjZXIpIHJldHVybjtcbiAgdHJhY2VyLnN0YXJ0U3BhbihzcGFuTmFtZSwgeyAuLi5vcHRzLCBzdGFydFRpbWU6IHN0YXJ0RXBvY2hNcyB9KS5lbmQoKTtcbn1cblxuLyoqXG4gKiBSZWNvcmRzIHRoZSBzYW1lIHVzZXItY29kZSBpbnRlcnZhbCBhcyB0aGUgaW5uZXIgYHN0ZXAuZXhlY3V0ZWAgc3Bhbi4gVGhlXG4gKiBjb25maWd1cmVkIE9wZW5UZWxlbWV0cnkgbWV0ZXIgcHJvdmlkZXIgYXR0YWNoZXMgcmVzb3VyY2UgZGltZW5zaW9ucyBzdWNoIGFzXG4gKiBzZXJ2aWNlLm5hbWUsIHNvIHRoaXMgYXZvaWRzIGFjY2VwdGluZyBhIGNhbGxlci1jb250cm9sbGVkIHNlcnZpY2UgdGFnLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVjb3JkU3RlcEV4ZWN1dGlvbkR1cmF0aW9uKFxuICBkdXJhdGlvbk1zOiBudW1iZXIsXG4gIHN0YXR1czogJ29rJyB8ICdlcnJvcidcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBoaXN0b2dyYW0gPSBhd2FpdCBTdGVwRXhlY3V0aW9uRHVyYXRpb25IaXN0b2dyYW0udmFsdWU7XG4gIGhpc3RvZ3JhbT8ucmVjb3JkKGR1cmF0aW9uTXMsIHsgJ3dvcmtmbG93LnN0ZXAuc3RhdHVzJzogc3RhdHVzIH0pO1xufVxuXG4vKipcbiAqIEFwcGxpZXMgdGhlIHdvcmtmbG93IHN1c3BlbnNpb24gYWxnZWJyYWljIGVmZmVjdCB0byBhbiBhY3RpdmUgc3Bhbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5V29ya2Zsb3dTdXNwZW5zaW9uVG9TcGFuKFxuICBlcnJvcjogV29ya2Zsb3dTdXNwZW5zaW9uLFxuICBzcGFuOiBhcGkuU3BhblxuKTogdm9pZCB7XG4gIHNwYW4uc2V0QXR0cmlidXRlcyh7XG4gICAgLi4uQXR0ci5Xb3JrZmxvd1N1c3BlbnNpb25TdGF0ZSgnc3VzcGVuZGVkJyksXG4gICAgLi4uQXR0ci5Xb3JrZmxvd1N1c3BlbnNpb25TdGVwQ291bnQoZXJyb3Iuc3RlcENvdW50KSxcbiAgICAuLi5BdHRyLldvcmtmbG93U3VzcGVuc2lvbkhvb2tDb3VudChlcnJvci5ob29rQ291bnQpLFxuICAgIC4uLkF0dHIuV29ya2Zsb3dTdXNwZW5zaW9uV2FpdENvdW50KGVycm9yLndhaXRDb3VudCksXG4gIH0pO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0U3BhbkNvbnRleHRGb3JUcmFjZUNhcnJpZXIoXG4gIGNhcnJpZXI6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbikge1xuICBjb25zdCBbZGVzZXJpYWxpemVkLCBvdGVsXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICBkZXNlcmlhbGl6ZVRyYWNlQ2FycmllcihjYXJyaWVyKSxcbiAgICBPdGVsQXBpLnZhbHVlLFxuICBdKTtcbiAgaWYgKCFkZXNlcmlhbGl6ZWQgfHwgIW90ZWwpIHJldHVybjtcbiAgcmV0dXJuIG90ZWwudHJhY2UuZ2V0U3BhbkNvbnRleHQoZGVzZXJpYWxpemVkKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEFjdGl2ZVNwYW4oKSB7XG4gIHJldHVybiBhd2FpdCB3aXRoT3RlbCgob3RlbCkgPT4gb3RlbC50cmFjZS5nZXRBY3RpdmVTcGFuKCkpO1xufVxuXG4vKipcbiAqIFdyYXBzIGFsbCBtZXRob2RzIG9mIGFuIG9iamVjdCB3aXRoIHRyYWNpbmcgc3BhbnMuXG4gKiBAcGFyYW0gcHJlZml4IC0gUHJlZml4IGZvciBzcGFuIG5hbWVzIChlLmcuLCBcIldPUkxELnJ1bnNcIilcbiAqIEBwYXJhbSBvIC0gT2JqZWN0IHdpdGggbWV0aG9kcyB0byBpbnN0cnVtZW50XG4gKiBAcmV0dXJucyBJbnN0cnVtZW50ZWQgb2JqZWN0IHdpdGggc2FtZSBpbnRlcmZhY2VcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGluc3RydW1lbnRPYmplY3Q8VCBleHRlbmRzIG9iamVjdD4ocHJlZml4OiBzdHJpbmcsIG86IFQpOiBUIHtcbiAgY29uc3QgaGFuZGxlcnMgPSB7fSBhcyBUO1xuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhvKSBhcyAoa2V5b2YgVClbXSkge1xuICAgIGlmICh0eXBlb2Ygb1trZXldICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICBoYW5kbGVyc1trZXldID0gb1trZXldO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBmID0gb1trZXldO1xuICAgICAgLy8gQHRzLWV4cGVjdC1lcnJvclxuICAgICAgaGFuZGxlcnNba2V5XSA9IGFzeW5jICguLi5hcmdzOiBhbnlbXSkgPT5cbiAgICAgICAgdHJhY2UoYCR7cHJlZml4fS4ke1N0cmluZyhrZXkpfWAsIHt9LCAoKSA9PiBmKC4uLmFyZ3MpKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGhhbmRsZXJzO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0U3BhbktpbmQoZmllbGQ6IGtleW9mIHR5cGVvZiBTcGFuS2luZCkge1xuICByZXR1cm4gd2l0aE90ZWwoKHgpID0+IHguU3BhbktpbmRbZmllbGRdKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdpdGhPdGVsPFQ+KFxuICBmbjogKG90ZWw6IHR5cGVvZiBhcGkpID0+IFRcbik6IFByb21pc2U8QXdhaXRlZDxUPiB8IHVuZGVmaW5lZD4ge1xuICBjb25zdCBvdGVsID0gYXdhaXQgT3RlbEFwaS52YWx1ZTtcbiAgaWYgKCFvdGVsKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gYXdhaXQgZm4ob3RlbCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsaW5rVG9DdXJyZW50Q29udGV4dCgpOiBQcm9taXNlPFthcGkuTGlua10gfCB1bmRlZmluZWQ+IHtcbiAgcmV0dXJuIHdpdGhPdGVsKChvdGVsKTogW2FwaS5MaW5rXSB8IHVuZGVmaW5lZCA9PiB7XG4gICAgY29uc3QgY29udGV4dCA9IG90ZWwudHJhY2UuZ2V0QWN0aXZlU3BhbigpPy5zcGFuQ29udGV4dCgpO1xuICAgIGlmICghY29udGV4dCkgcmV0dXJuO1xuICAgIHJldHVybiBbeyBjb250ZXh0IH1dO1xuICB9KTtcbn1cblxuLyoqXG4gKiBCdWlsZHMgYSBzcGFuIGxpbmsgcG9pbnRpbmcgYXQgdGhlIHNwYW4gY29udGV4dCBlbWJlZGRlZCBpbiBhIHNlcmlhbGl6ZWRcbiAqIHRyYWNlIGNhcnJpZXIgKGUuZy4gdGhlIHJ1bi1vcmlnaW4gY29udGV4dCBmbG93aW5nIHRocm91Z2ggcXVldWVcbiAqIG1lc3NhZ2VzKS4gUmV0dXJucyBgdW5kZWZpbmVkYCB3aGVuIE9URUwgaXMgdW5hdmFpbGFibGUsIHRoZSBjYXJyaWVyIGlzXG4gKiBhYnNlbnQsIG9yIGl0IGRvZXMgbm90IGNvbnRhaW4gYSB2YWxpZCBzcGFuIGNvbnRleHQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsaW5rVG9UcmFjZUNhcnJpZXIoXG4gIGNhcnJpZXI6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWRcbik6IFByb21pc2U8YXBpLkxpbmsgfCB1bmRlZmluZWQ+IHtcbiAgaWYgKCFjYXJyaWVyKSByZXR1cm47XG4gIGNvbnN0IFtjb250ZXh0LCBvdGVsXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICBnZXRTcGFuQ29udGV4dEZvclRyYWNlQ2FycmllcihjYXJyaWVyKSxcbiAgICBPdGVsQXBpLnZhbHVlLFxuICBdKTtcbiAgaWYgKCFjb250ZXh0IHx8ICFvdGVsKSByZXR1cm47XG4gIGlmICghb3RlbC50cmFjZS5pc1NwYW5Db250ZXh0VmFsaWQoY29udGV4dCkpIHJldHVybjtcbiAgcmV0dXJuIHsgY29udGV4dCB9O1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEJhZ2dhZ2UgUHJvcGFnYXRpb24gVXRpbGl0aWVzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBXb3JrZmxvdyBjb250ZXh0IHRvIHByb3BhZ2F0ZSB2aWEgYmFnZ2FnZVxuICovXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtmbG93QmFnZ2FnZUNvbnRleHQge1xuICB3b3JrZmxvd1J1bklkOiBzdHJpbmc7XG4gIHdvcmtmbG93TmFtZTogc3RyaW5nO1xufVxuXG4vKipcbiAqIFNldHMgd29ya2Zsb3cgY29udGV4dCBhcyBPVEVMIGJhZ2dhZ2UgZm9yIGF1dG9tYXRpYyBwcm9wYWdhdGlvbi5cbiAqIEJhZ2dhZ2UgaXMgcHJvcGFnYXRlZCBhY3Jvc3Mgc2VydmljZSBib3VuZGFyaWVzIHZpYSBIVFRQIGhlYWRlcnMuXG4gKiBAcGFyYW0gY29udGV4dCAtIFdvcmtmbG93IGNvbnRleHQgdG8gc2V0IGFzIGJhZ2dhZ2VcbiAqIEByZXR1cm5zIEEgZnVuY3Rpb24gdG8gcnVuIHdpdGhpbiB0aGUgYmFnZ2FnZSBjb250ZXh0XG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB3aXRoV29ya2Zsb3dCYWdnYWdlPFQ+KFxuICBjb250ZXh0OiBXb3JrZmxvd0JhZ2dhZ2VDb250ZXh0LFxuICBmbjogKCkgPT4gUHJvbWlzZTxUPlxuKTogUHJvbWlzZTxUPiB7XG4gIGNvbnN0IG90ZWwgPSBhd2FpdCBPdGVsQXBpLnZhbHVlO1xuICBpZiAoIW90ZWwpIHJldHVybiBmbigpO1xuXG4gIC8vIENyZWF0ZSBiYWdnYWdlIHdpdGggd29ya2Zsb3cgY29udGV4dFxuICBjb25zdCBiYWdnYWdlID0gb3RlbC5wcm9wYWdhdGlvbi5jcmVhdGVCYWdnYWdlKHtcbiAgICAnd29ya2Zsb3cucnVuX2lkJzogeyB2YWx1ZTogY29udGV4dC53b3JrZmxvd1J1bklkIH0sXG4gICAgJ3dvcmtmbG93Lm5hbWUnOiB7IHZhbHVlOiBjb250ZXh0LndvcmtmbG93TmFtZSB9LFxuICB9KTtcblxuICAvLyBTZXQgYmFnZ2FnZSBpbiBjb250ZXh0IGFuZCBydW4gZnVuY3Rpb25cbiAgY29uc3QgY29udGV4dFdpdGhCYWdnYWdlID0gb3RlbC5wcm9wYWdhdGlvbi5zZXRCYWdnYWdlKFxuICAgIG90ZWwuY29udGV4dC5hY3RpdmUoKSxcbiAgICBiYWdnYWdlXG4gICk7XG5cbiAgcmV0dXJuIG90ZWwuY29udGV4dC53aXRoKGNvbnRleHRXaXRoQmFnZ2FnZSwgKCkgPT4gZm4oKSk7XG59XG5cbi8qKlxuICogUmV0cmlldmVzIHdvcmtmbG93IGNvbnRleHQgZnJvbSBPVEVMIGJhZ2dhZ2UuXG4gKiBAcmV0dXJucyBXb3JrZmxvdyBjb250ZXh0IGlmIHByZXNlbnQgaW4gYmFnZ2FnZSwgdW5kZWZpbmVkIG90aGVyd2lzZVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0V29ya2Zsb3dCYWdnYWdlKCk6IFByb21pc2U8XG4gIFdvcmtmbG93QmFnZ2FnZUNvbnRleHQgfCB1bmRlZmluZWRcbj4ge1xuICBjb25zdCBvdGVsID0gYXdhaXQgT3RlbEFwaS52YWx1ZTtcbiAgaWYgKCFvdGVsKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IGJhZ2dhZ2UgPSBvdGVsLnByb3BhZ2F0aW9uLmdldEJhZ2dhZ2Uob3RlbC5jb250ZXh0LmFjdGl2ZSgpKTtcbiAgaWYgKCFiYWdnYWdlKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IHJ1bklkID0gYmFnZ2FnZS5nZXRFbnRyeSgnd29ya2Zsb3cucnVuX2lkJyk/LnZhbHVlO1xuICBjb25zdCBuYW1lID0gYmFnZ2FnZS5nZXRFbnRyeSgnd29ya2Zsb3cubmFtZScpPy52YWx1ZTtcblxuICBpZiAoIXJ1bklkIHx8ICFuYW1lKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIHJldHVybiB7XG4gICAgd29ya2Zsb3dSdW5JZDogcnVuSWQsXG4gICAgd29ya2Zsb3dOYW1lOiBuYW1lLFxuICB9O1xufVxuIl19