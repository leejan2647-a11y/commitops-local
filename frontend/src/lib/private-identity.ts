/** A verified scope and the lifetime of the request that owns it. */
export class IdentityChangedError extends Error {
  constructor() {
    super('Your account changed. Please try again.')
    this.name = 'IdentityChangedError'
  }
}

export interface PrivateIdentity {
  userId: string
  tenantId: string
  token: string
  generation: number
  signal: AbortSignal
  isCurrent: () => boolean
}

export function assertIdentity(identity: PrivateIdentity | null): asserts identity is PrivateIdentity {
  if (!identity || !identity.isCurrent() || identity.signal.aborted) throw new IdentityChangedError()
}

export function privateKey(identity: PrivateIdentity | null, key: readonly unknown[]) {
  return ['private', identity?.userId ?? null, identity?.tenantId ?? null, ...key] as const
}
