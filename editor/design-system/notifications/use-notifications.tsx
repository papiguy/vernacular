import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import {
  DEFAULT_TOAST_DURATION_MS,
  type Notification,
  type NotificationAction,
  type NotificationSeverity,
} from './notification'
import { emptyNotificationState, notificationReducer, type StoreAction } from './notification-store'

export interface ToastOptions {
  id?: string
  actions?: NotificationAction[]
  dismissible?: boolean
  autoDismissMs?: number
}

export interface BannerInput {
  id: string
  severity: NotificationSeverity
  message: string
  actions?: NotificationAction[]
  dismissible?: boolean
}

export interface NotificationApi {
  notifications: Notification[]
  success(message: string, options?: ToastOptions): string
  info(message: string, options?: ToastOptions): string
  warning(message: string, options?: ToastOptions): string
  error(message: string, options?: ToastOptions): string
  banner(input: BannerInput): string
  dismiss(id: string): void
}

const NotificationContext = createContext<NotificationApi | null>(null)

export function NotificationProvider({ children }: { children: ReactNode }) {
  const api = useNotificationApi()
  return <NotificationContext.Provider value={api}>{children}</NotificationContext.Provider>
}

export function useNotifications(): NotificationApi {
  const api = useContext(NotificationContext)
  if (api === null) {
    throw new Error('useNotifications must be used within a NotificationProvider')
  }
  return api
}

// Severity drives the default lifetime: errors are sticky (no timer), others fade.
function defaultDuration(severity: NotificationSeverity): number | undefined {
  return severity === 'error' ? undefined : DEFAULT_TOAST_DURATION_MS
}

// Build a toast notification, omitting optional keys we have no value for so the shape stays
// assignable under exactOptionalPropertyTypes. The caller resolves options.id before calling.
function buildToast(
  severity: NotificationSeverity,
  message: string,
  options: ToastOptions & { id: string },
): Notification {
  const autoDismissMs = options.autoDismissMs ?? defaultDuration(severity)
  return {
    id: options.id,
    tier: 'toast',
    severity,
    message,
    dismissible: options.dismissible ?? true,
    ...(autoDismissMs !== undefined ? { autoDismissMs } : {}),
    ...(options.actions ? { actions: options.actions } : {}),
  }
}

type Dispatch = (action: StoreAction) => void

// Owns the auto-dismiss timers and translates emit/dismiss into reducer dispatches, so the reducer
// stays a pure value store.
function useEmitter(dispatch: Dispatch) {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id)
      dispatch({ type: 'dismiss', id })
    },
    [clearTimer, dispatch],
  )

  const emit = useCallback(
    (notification: Notification) => {
      clearTimer(notification.id)
      dispatch({ type: 'upsert', notification })
      if (notification.autoDismissMs !== undefined) {
        timers.current.set(
          notification.id,
          setTimeout(() => dismiss(notification.id), notification.autoDismissMs),
        )
      }
      return notification.id
    },
    [clearTimer, dispatch, dismiss],
  )

  return { emit, dismiss }
}

function useNotificationApi(): NotificationApi {
  const [state, dispatch] = useReducer(notificationReducer, emptyNotificationState)
  const counter = useRef(0)
  const { emit, dismiss } = useEmitter(dispatch)

  const toast = useCallback(
    (severity: NotificationSeverity, message: string, options: ToastOptions = {}) => {
      counter.current += 1
      const id = options.id ?? `notification-${counter.current}`
      return emit(buildToast(severity, message, { ...options, id }))
    },
    [emit],
  )

  return useMemo<NotificationApi>(
    () => ({
      notifications: state.notifications,
      success: (message, options) => toast('success', message, options),
      info: (message, options) => toast('info', message, options),
      warning: (message, options) => toast('warning', message, options),
      error: (message, options) => toast('error', message, options),
      banner: (input) => emit({ ...input, tier: 'banner', dismissible: input.dismissible ?? true }),
      dismiss,
    }),
    [state.notifications, toast, emit, dismiss],
  )
}
