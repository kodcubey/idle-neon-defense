type NoRngInstall = {
  restore: () => void
  getCalls: () => number
}

export function installDeterministicNoRng(): NoRngInstall {
  const mathObj = globalThis.Math as unknown as Record<string, unknown>
  const original = mathObj['random'] as () => number
  let calls = 0

  // Deterministic constant: eliminates entropy while allowing libraries that
  // unconditionally call JS randomness APIs during init (e.g., default seed).
  mathObj['random'] = (() => {
    calls++
    return 0
  }) satisfies () => number

  return {
    restore: () => {
      mathObj['random'] = original
    },
    getCalls: () => calls,
  }
}
