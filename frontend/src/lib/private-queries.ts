import { useMemo } from 'react'
import {
  useQuery, useInfiniteQuery, useMutation, useQueryClient,
  type QueryClient, type QueryKey, type UseQueryOptions, type UseQueryResult,
  type MutateOptions, type UseMutationResult,
  type InfiniteData, type UseInfiniteQueryOptions,
} from '@tanstack/react-query'
import { useAuth } from './use-auth'
import { assertIdentity, privateKey, type PrivateIdentity } from './private-identity'
import * as api from './api'

/** All application transports capture the verified identity at render time. */
export function usePrivateApi() {
  const { identity } = useAuth()
  return {
    apiFetch: <T,>(path: string, init?: RequestInit) => {
      assertIdentity(identity)
      return api.apiFetch<T>(path, init, identity)
    },
    apiUpload: <T,>(path: string, form: FormData) => {
      assertIdentity(identity)
      return api.apiUpload<T>(path, form, identity)
    },
    downloadJson: <T,>(path: string, nameFor: (body: T) => string) => {
      assertIdentity(identity)
      return api.downloadJson<T>(path, nameFor, identity)
    },
    downloadText: (path: string, filename: string, contentType?: string) => {
      assertIdentity(identity)
      return api.downloadText(path, filename, contentType, identity)
    },
  }
}

export function usePrivateQuery<T>(
  options: Omit<UseQueryOptions<T, Error, T, QueryKey>, 'queryFn' | 'enabled'> & {
    queryFn: (context: { signal: AbortSignal }) => Promise<T>
    enabled?: boolean
  },
): UseQueryResult<T> {
  const { identity } = useAuth()
  return useQuery({
    ...options,
    queryKey: privateKey(identity, options.queryKey),
    enabled: Boolean(identity) && options.enabled !== false,
    queryFn: async context => {
      assertIdentity(identity)
      const result = await options.queryFn(context)
      assertIdentity(identity)
      return result
    },
  })
}

export function usePrivateInfiniteQuery<T>(options: Omit<UseInfiniteQueryOptions<T, Error, InfiniteData<T>, QueryKey, number>, 'queryFn'> & {
  queryFn: (context: { signal: AbortSignal; pageParam: number }) => Promise<T>
}) {
  const { identity } = useAuth()
  return useInfiniteQuery({
    ...options,
    queryKey: privateKey(identity, options.queryKey),
    enabled: Boolean(identity) && options.enabled !== false,
    queryFn: async context => {
      assertIdentity(identity)
      const result = await options.queryFn(context)
      assertIdentity(identity)
      return result
    },
  })
}

/** Invalidation stays in the scope that initiated the operation. */
export function usePrivateQueryClient(): Pick<QueryClient, 'invalidateQueries'> {
  const client = useQueryClient()
  const { identity } = useAuth()
  return useMemo(() => ({
    invalidateQueries: (filters, options) => {
      if (!identity?.isCurrent()) return Promise.resolve()
      return client.invalidateQueries({
        ...filters,
        queryKey: privateKey(identity, filters?.queryKey ?? []),
      }, options)
    },
  }), [client, identity])
}

type PrivateMutationOptions<T, V> = {
  mutationFn: (variables: V) => Promise<T>
  onSuccess?: (data: T, variables: V) => unknown
  onSettled?: (data: T | undefined, error: Error | null, variables: V) => unknown
}
type Invocation<V> = { identity: PrivateIdentity; variables: V }

/** Capture auth when mutate is called, including mutations paused offline. */
export function usePrivateMutation<T, V = void>(
  options: PrivateMutationOptions<T, V>,
): UseMutationResult<T, Error, V> {
  const { identity } = useAuth()
  const mutation = useMutation<T, Error, Invocation<V>>({
    mutationKey: privateKey(identity, ['mutation']),
    retry: false,
    mutationFn: async invocation => {
      assertIdentity(invocation.identity)
      if (invocation.identity !== identity) throw new Error('The account changed before the request started.')
      const result = await options.mutationFn(invocation.variables)
      assertIdentity(invocation.identity)
      return result
    },
    onSuccess: (data, invocation) => {
      if (invocation.identity.isCurrent()) return options.onSuccess?.(data, invocation.variables)
    },
    onSettled: (data, error, invocation) => {
      if (invocation.identity.isCurrent()) return options.onSettled?.(data, error, invocation.variables)
    },
  })
  const mutateAsync = async (variables: V, callbacks?: MutateOptions<T, Error, V>) => {
    assertIdentity(identity)
    const result = await mutation.mutateAsync({ identity, variables }, {
      onSuccess: (data, invocation, context, meta) => {
        if (identity.isCurrent()) callbacks?.onSuccess?.(data, invocation.variables, context, meta)
      },
      onError: (error, invocation, context, meta) => {
        if (identity.isCurrent()) callbacks?.onError?.(error, invocation.variables, context, meta)
      },
      onSettled: (data, error, invocation, context, meta) => {
        if (identity.isCurrent()) callbacks?.onSettled?.(data, error, invocation.variables, context, meta)
      },
    })
    assertIdentity(identity)
    return result
  }
  return {
    ...mutation,
    variables: mutation.variables?.variables,
    mutateAsync,
    mutate: (variables, callbacks) => { void mutateAsync(variables as V, callbacks).catch(() => {}) },
  } as UseMutationResult<T, Error, V>
}
