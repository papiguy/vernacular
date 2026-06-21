import { useNotifications } from './use-notifications'
import type { Notification } from './notification'
import './toast.css'

export interface ToastProps {
  notification: Notification
  onDismiss: (id: string) => void
}

export function Toast({ notification, onDismiss }: ToastProps) {
  const role = notification.severity === 'error' ? 'alert' : 'status'
  return (
    <div className="ds-toast" data-severity={notification.severity} role={role}>
      {notification.pending ? <span className="ds-toast__spinner" aria-hidden="true" /> : null}
      <span className="ds-toast__message">{notification.message}</span>
      {(notification.actions ?? []).map((action) => (
        <button
          key={action.label}
          type="button"
          className="ds-toast__action"
          onClick={action.onAction}
        >
          {action.label}
        </button>
      ))}
      {notification.dismissible ? (
        <button
          type="button"
          className="ds-toast__dismiss"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(notification.id)}
        >
          ×
        </button>
      ) : null}
    </div>
  )
}

// The anchored toast stack. The container is always mounted with aria-live so toasts inserted into
// it announce; error toasts carry role="alert" for assertive announcement.
export function ToastRegion() {
  const { notifications, dismiss } = useNotifications()
  const toasts = notifications.filter((n) => n.tier === 'toast')
  return (
    <div className="ds-toast-region" aria-live="polite" aria-relevant="additions">
      {toasts.map((notification) => (
        <Toast key={notification.id} notification={notification} onDismiss={dismiss} />
      ))}
    </div>
  )
}
