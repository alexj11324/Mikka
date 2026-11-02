/** Each request gets a fresh scan, after any prior scan has finished. */
export function refreshQueue(scan) {
  let tail = Promise.resolve()
  return () => {
    const result = tail.then(scan)
    tail = result.catch(() => {})
    return result
  }
}
