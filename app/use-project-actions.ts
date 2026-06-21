import { useCallback, useEffect, useState } from 'react'
import { SvgPlanExporter } from '../core'
import { commitProject, createEditorSession, guardDestructive, type EditorSession } from '../bridge'
import {
  DirectoryHandleStore,
  FileSystemFolderProjectStore,
  exportProjectBundle,
  bundleFilename,
  downloadBytes,
  downloadText,
  orderRecentProjects,
  pngPlanFilename,
  pdfPlanFilename,
  rasterizeSvgToPng,
  recentEntryFor,
  svgPlanFilename,
  svgPlanToPdf,
  DEFAULT_RASTER_MAX_EDGE,
  PRINT_RASTER_MAX_EDGE,
  type AssetCache,
  type ProjectBackend,
  type ProjectStore,
  type RecentProjectStore,
  type StorageCapabilities,
} from '../storage'
import { humanMessage, type NotificationApi } from '../editor/design-system'
import { createInitialProject } from './create-initial-project'
import { useOpenFileAction, type ImportStatus } from './use-open-file-action'
import type { SnapshotsPort } from './app'

export type { ImportStatus }

export interface RecentEntry {
  id: string
  name: string
  backend: ProjectBackend
}

export interface Recovery {
  onRestore: () => void
  onDiscard: () => void
}

/**
 * Map the resolved default store to a recent-list backend. The recent-list
 * `ProjectBackend` union has no `'indexeddb'` member, so only the OPFS default
 * earns a recent entry; the IndexedDB default stays the implicit current project
 * and records nothing on boot. The clean mapping is finalized when the create-time
 * backend chooser lands (see the plan's Open questions on backend memory).
 */
export function defaultStoreBackend(capabilities: StorageCapabilities): ProjectBackend | null {
  return capabilities.opfs ? 'opfs' : null
}

/** Record an opened-or-saved project under the given backend, ignoring failures. */
export function recordRecent(
  recentProjects: RecentProjectStore,
  input: { id: string; name: string; backend: ProjectBackend },
): void {
  void recentProjects.record(
    recentEntryFor({
      id: input.id,
      name: input.name,
      backend: input.backend,
      openedAt: Date.now(),
    }),
  )
}

export interface ProjectActionsContext {
  session: EditorSession
  store: ProjectStore
  assets: AssetCache
  projectId: string
  snapshots: SnapshotsPort | undefined
  recentProjects: RecentProjectStore
  capabilities: StorageCapabilities
  recentEntries: RecentEntry[]
  onSession: (session: EditorSession) => void
  notifications: NotificationApi

  /** Whether the live session has unsaved changes since the last save/load.
   *  Source: the dirty tracker (bridge/session/create-dirty-tracker.ts) via
   *  the app-layer useDirtyState hook. Treated as clean (false) when omitted. */
  isDirty?: boolean

  /** Prompt the user to discard unsaved work before a destructive swap.
   *  Resolves true to proceed, false/falsy to cancel. Sync or async, matching
   *  GuardDestructiveOptions.confirm exactly. Only consulted when isDirty is
   *  true (per needsDiscardConfirmation). */
  confirmDiscard?: () => boolean | Promise<boolean>

  /** Clears the dirty baseline after an explicit save commits, returning the
   *  dirty tracker to clean. Source: useDirtyTracker.
   *  Optional so hook-level tests that build the context without it stay valid. */
  markSaved?: () => void
}

// Runs an async file operation and, on failure, raises an error toast whose
// Retry re-invokes the same operation through this helper (so Retry retries).
function runWithErrorToast(notifications: NotificationApi, op: () => Promise<void>): void {
  void op().catch((error: unknown) => {
    notifications.error(humanMessage(error), {
      actions: [{ label: 'Retry', onAction: () => runWithErrorToast(notifications, op) }],
    })
  })
}

// Wrap an async export in a promise toast: an indeterminate pending toast while it runs, a success
// toast naming the file, or an error toast whose Retry re-runs the export.
function runExportWithToast(
  notifications: NotificationApi,
  name: string,
  run: () => Promise<unknown>,
): void {
  const attempt = (): void => {
    void notifications.promise(run(), {
      pending: `Exporting ${name}...`,
      success: () => `Exported ${name}`,
      error: (error) => ({
        message: `Export failed: ${humanMessage(error)}`,
        actions: [{ label: 'Retry', onAction: attempt }],
      }),
    })
  }
  attempt()
}

export interface ProjectActions {
  onSave: () => void
  onOpenRecent: (id: string) => void
  onNewProject: () => void | Promise<void>
  onExportBundle: () => void
  onExportPlan: () => void
  onExportImage: () => void
  onExportPdf: () => void
  onOpenFolder?: () => void
  onImportDroppedFile?: (file: File) => void | Promise<void>
  onOpenFile?: () => void
  importStatus?: ImportStatus | null
  dismissImportStatus?: () => void
}

export function useProjectActions(context: ProjectActionsContext): ProjectActions {
  return {
    onSave: useSaveAction(context),
    onOpenRecent: useOpenRecentAction(context),
    onNewProject: useNewProjectAction(context),
    onExportBundle: useExportBundleAction(context),
    onExportPlan: useExportPlanAction(context),
    onExportImage: useExportImageAction(context),
    onExportPdf: useExportPdfAction(context),
    ...useOpenFolderAction(context),
    ...useOpenFileAction(context),
  }
}

function useSaveAction(context: ProjectActionsContext): () => void {
  const {
    session,
    store,
    projectId,
    snapshots,
    recentProjects,
    capabilities,
    markSaved,
    notifications,
  } = context
  const backend = defaultStoreBackend(capabilities)
  return useCallback(() => {
    runWithErrorToast(notifications, async () => {
      const project = session.getProject()
      await commitProject({ store, projectId, project, ...(snapshots ? { snapshots } : {}) })
      if (backend !== null) {
        recordRecent(recentProjects, { id: projectId, name: project.meta.name, backend })
      }
      // A successful explicit save is the clean baseline: clear the dirty tracker
      // so the beforeunload guard disarms.
      markSaved?.()
    })
  }, [session, store, projectId, snapshots, recentProjects, backend, markSaved, notifications])
}

function useExportBundleAction(context: ProjectActionsContext): () => void {
  const { session, projectId, assets, notifications } = context
  return useCallback(() => {
    const project = session.getProject()
    const name = bundleFilename(project.meta.name)
    runExportWithToast(notifications, name, () =>
      exportProjectBundle(projectId, project, assets).then((bytes) => downloadBytes(bytes, name)),
    )
  }, [session, projectId, assets, notifications])
}

function useExportPlanAction(context: ProjectActionsContext): () => void {
  const { session, notifications } = context
  return useCallback(() => {
    const project = session.getProject()
    const name = svgPlanFilename(project.meta.name)
    try {
      const { content } = new SvgPlanExporter().export(project)
      downloadText(content, name, 'image/svg+xml')
      notifications.success(`Exported ${name}`)
    } catch (error) {
      notifications.error(`Export failed: ${humanMessage(error)}`)
    }
  }, [session, notifications])
}

function useExportImageAction(context: ProjectActionsContext): () => void {
  const { session, notifications } = context
  return useCallback(() => {
    const project = session.getProject()
    const name = pngPlanFilename(project.meta.name)
    const { content } = new SvgPlanExporter().export(project)
    runExportWithToast(notifications, name, () =>
      rasterizeSvgToPng(content, DEFAULT_RASTER_MAX_EDGE).then((png) => downloadBytes(png, name)),
    )
  }, [session, notifications])
}

function useExportPdfAction(context: ProjectActionsContext): () => void {
  const { session, notifications } = context
  return useCallback(() => {
    const project = session.getProject()
    const name = pdfPlanFilename(project.meta.name)
    const { content } = new SvgPlanExporter().export(project)
    runExportWithToast(notifications, name, () =>
      svgPlanToPdf(content, { units: project.meta.units, maxEdge: PRINT_RASTER_MAX_EDGE }).then(
        (pdf) => downloadBytes(pdf, name),
      ),
    )
  }, [session, notifications])
}

function useNewProjectAction(context: ProjectActionsContext): () => void | Promise<void> {
  const { onSession, isDirty, confirmDiscard } = context
  return useCallback(
    () =>
      guardDestructive({
        isDirty: isDirty ?? false,
        confirm: confirmDiscard ?? (() => true),
        run: () => onSession(createEditorSession(createInitialProject())),
      }),
    [onSession, isDirty, confirmDiscard],
  )
}

// Open folder is gated on the native picker capability; without it the shell
// renders no control, so the handler is omitted rather than rendered inert.
function useOpenFolderAction(context: ProjectActionsContext): { onOpenFolder?: () => void } {
  const { projectId, recentProjects, capabilities, onSession, notifications } = context
  const onOpenFolder = useCallback(() => {
    runWithErrorToast(notifications, async () => {
      const store = await FileSystemFolderProjectStore.open(projectId, new DirectoryHandleStore())
      const project = await store.load(projectId)
      onSession(createEditorSession(project))
      recordRecent(recentProjects, {
        id: projectId,
        name: project.meta.name,
        backend: 'file-system-folder',
      })
    })
  }, [projectId, recentProjects, onSession, notifications])
  return capabilities.fileSystemAccess ? { onOpenFolder } : {}
}

function useOpenRecentAction(context: ProjectActionsContext): (id: string) => void {
  const { store, projectId, recentEntries, onSession, notifications } = context
  return useCallback(
    (id: string) => {
      const entry = recentEntries.find((candidate) => candidate.id === id)
      if (entry?.backend === 'file-system-folder') {
        openFolderRecent({ id, projectId, onSession, fallback: store, notifications })
        return
      }
      // OPFS, zip-bundle, or no recorded backend route through the default store
      // load; per-backend reopen for the others is deferred (plan Open questions).
      runWithErrorToast(notifications, async () => {
        const project = await store.load(id)
        onSession(createEditorSession(project))
      })
    },
    [store, projectId, recentEntries, onSession, notifications],
  )
}

interface OpenFolderRecentContext {
  id: string
  projectId: string
  onSession: (session: EditorSession) => void
  fallback: ProjectStore
  notifications: NotificationApi
}

// Reopen a picked folder, re-requesting permission; falls back to the default
// store load when no stored handle exists or permission is denied (spec 5.7).
function openFolderRecent(context: OpenFolderRecentContext): void {
  const { id, projectId, onSession, fallback, notifications } = context
  runWithErrorToast(notifications, async () => {
    const reopenedStore = await FileSystemFolderProjectStore.reopen(id, new DirectoryHandleStore())
    if (reopenedStore === undefined) {
      const project = await fallback.load(id)
      onSession(createEditorSession(project))
      return
    }
    const project = await reopenedStore.load(projectId)
    onSession(createEditorSession(project))
  })
}

export interface RecentAndRecoveryContext {
  recentProjects: RecentProjectStore
  snapshots: SnapshotsPort | undefined
  onSession: (session: EditorSession) => void
}

export function useRecentProjectsAndRecovery(context: RecentAndRecoveryContext): {
  recentEntries: RecentEntry[]
  recovery: Recovery | null
} {
  const { recentProjects, snapshots, onSession } = context
  const [recentEntries, setRecentEntries] = useState<RecentEntry[]>([])
  const [recovery, setRecovery] = useState<Recovery | null>(null)

  useEffect(() => {
    let cancelled = false
    const isLive = () => !cancelled

    void recentProjects.list().then((entries) => {
      if (isLive()) {
        setRecentEntries(
          orderRecentProjects(entries).map(({ id, name, backend }) => ({ id, name, backend })),
        )
      }
    })

    if (snapshots) {
      void snapshots.isRecoverable().then((recoverable) => {
        if (isLive() && recoverable) {
          setRecovery(buildRecovery({ snapshots, onSession, setRecovery, isLive }))
        }
      })
    }

    return () => {
      cancelled = true
    }
  }, [recentProjects, snapshots, onSession])

  return { recentEntries, recovery }
}

interface RecoveryHandlersContext {
  snapshots: SnapshotsPort
  onSession: (session: EditorSession) => void
  setRecovery: (recovery: Recovery | null) => void
  isLive: () => boolean
}

// Builds the restore/discard handlers, each guarded so they never touch React state
// after the owning effect has been torn down.
function buildRecovery(context: RecoveryHandlersContext): Recovery {
  const { snapshots, onSession, setRecovery, isLive } = context
  return {
    onRestore: () => {
      void snapshots.restore().then((project) => {
        if (!isLive()) {
          return
        }
        if (project) {
          onSession(createEditorSession(project))
        }
        setRecovery(null)
      })
    },
    onDiscard: () => {
      void snapshots.prune().then(() => {
        if (isLive()) {
          setRecovery(null)
        }
      })
    },
  }
}
