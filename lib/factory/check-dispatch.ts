import { isDeepStrictEqual } from "node:util";
import { FactoryError } from "./contract";
import { factoryBinding, factoryDispatchSchema, type createFactoryDispatch } from "./dispatch";
import { factoryEventId } from "./event-id";
import type { createFactoryStore } from "./store";

/** Record a missing check prerequisite after atomic dispatch has rolled back.
 * This observes host capability, not failure semantics or a recovery choice.
 * Caller-owned transactions (including question continuations) retain #192's
 * all-or-nothing contract and are not committed or reinterpreted here. */
export function observeFactoryCheckDispatch(
  store: ReturnType<typeof createFactoryStore>,
  dispatch: ReturnType<typeof createFactoryDispatch>,
): ReturnType<typeof createFactoryDispatch> {
  return async (userId, input, existing) => {
    try {
      return await dispatch(userId, input, existing);
    } catch (error) {
      if (
        existing ||
        !(error instanceof FactoryError) ||
        ![
          "factoryCheckHarnessUnavailable",
          "factoryCheckCommandRequired",
        ].includes(error.code)
      )
        throw error;

      // Use the same canonical UUIDs as dispatch, including direct callers
      // that supplied uppercase UUID spelling before its parser normalized it.
      const parsed = factoryDispatchSchema.safeParse(input);
      if (!parsed.success) throw error;
      const observed = parsed.data;
      const current = await store.read(userId, observed.binding.taskId);
      if (
        ["review", "verify"].includes(current.task.stage) &&
        current.task.status === "pending" &&
        isDeepStrictEqual(factoryBinding(current.task), observed.binding)
      ) {
        // apply reauthorizes under its task lock and performs the original
        // binding CAS. A concurrent cancel/access loss cannot be overwritten.
        await store.apply(
          userId,
          observed.binding,
          factoryEventId("check-dispatch-unavailable", observed.binding.attemptId),
          {
            action: "finish",
            status: "blocked",
            reason: `Independent check prerequisite unavailable: ${error.code}`,
            evidence: [],
            output: {
              dispatch: {
                code: error.code,
                agentId: observed.agentId,
                deviceRepoId: observed.deviceRepoId,
              },
            },
          },
        );
      }
      // Preserve the actual dispatch failure; a blocked observation is never
      // a successful dispatch receipt or authorization to retry/repair.
      throw error;
    }
  };
}
