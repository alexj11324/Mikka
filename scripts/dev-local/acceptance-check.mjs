export function createAcceptanceCheck({ step, isInterrupted, completedItems, failures }) {
  return async (...args) => {
    if (isInterrupted()) throw new Error('Acceptance interrupted')
    try {
      const result = await step(...args)
      if (isInterrupted()) throw new Error('Acceptance interrupted')
      completedItems.push(Number(/^item(\d+)/.exec(args[0])[1]))
      return result
    } catch (error) {
      // Cancellation must escape the sequence before another item can dispatch.
      if (isInterrupted()) throw error
      failures.push(error)
    }
  }
}
