// OpenTelemetry spans and span-correlated logging for Effect programs.
//
// The rest of the server traces through telemetry.ts withSpan, which keeps
// the active span in AsyncLocalStorage. An Effect fiber does not run inside
// one async call chain, so here the OpenTelemetry context travels with the
// fiber instead, as a Context.Reference: `traced` starts a span under the
// fiber's current context and runs its body with the context moved onto
// that span; `logged` runs a logger call with that context active, so the
// line carries the span's ids exactly as it does under withSpan.
//
// The bridge (runtime.ts run) seeds the reference with whatever span is
// active where a Promise function was called, so a store span still nests
// under the sync tick's or a request's span.

import { context as otelContext, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Attributes, Context as OtelContext, Span } from "@opentelemetry/api";
import { Cause, Context, Effect, Exit } from "effect";
import { tracer } from "../telemetry";
import type { Throwable } from "./bridge";

/** The OpenTelemetry context the running fiber's spans and log lines belong to. */
export const SpanContext = Context.Reference<OtelContext>("specdriven/effect/SpanContext", {
  defaultValue: () => otelContext.active(),
});

/**
 * Run `body` inside a span, as telemetry.ts withSpan does for a Promise: a
 * failure is recorded on the span and marks it errored, and the span ends
 * however the body ends.
 */
export const traced = <A, E, R>(
  name: string,
  attributes: Attributes,
  body: (span: Span) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.service(SpanContext), (parent) => {
    const span = tracer().startSpan(name, { attributes }, parent);
    return body(span).pipe(
      Effect.provideService(SpanContext, trace.setSpan(parent, span)),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit)) {
            // The error a Promise caller would see — the errno exception, not its wrapper.
            const squashed = Cause.squash(exit.cause) as Partial<Throwable> | null;
            const error = typeof squashed?.toThrowable === "function" ? squashed.toThrowable() : squashed;
            span.recordException(error as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          span.end();
        }),
      ),
    );
  });

/** Run a logger call with the fiber's span active, so the line is correlated to it. */
export const logged = (write: () => void): Effect.Effect<void> =>
  Effect.flatMap(Effect.service(SpanContext), (current) =>
    Effect.sync(() => otelContext.with(current, write)),
  );
