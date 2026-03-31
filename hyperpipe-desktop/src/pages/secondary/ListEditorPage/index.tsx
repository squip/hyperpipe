import { useSecondaryPage } from '@/providers/SecondaryPageProvider'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { buildGroupRelayTargets, dedupeRelayUrlsByIdentity, type GroupRelayTarget } from '@/lib/relay-targets'
import { useGroups } from '@/providers/GroupsProvider'
import { useLists } from '@/providers/ListsProvider'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { forwardRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import ListEditorForm from '@/components/ListEditorForm'

const ListEditorPage = forwardRef(
  ({ listId, index }: { listId?: string; index?: number }, ref) => {
    const { t } = useTranslation()
    const { pop } = useSecondaryPage()
    const { fetchLists } = useLists()
    const { myGroupList, discoveryGroups, getProvisionalGroupMetadata, resolveRelayUrl } = useGroups()
    const { refreshRelaySubscriptions } = useWorkerBridge()
    const isEditing = !!listId

    const groupRelayTargets = useMemo<GroupRelayTarget[]>(
      () =>
        buildGroupRelayTargets({
          myGroupList,
          resolveRelayUrl,
          getProvisionalGroupMetadata,
          discoveryGroups
        }),
      [discoveryGroups, getProvisionalGroupMetadata, myGroupList, resolveRelayUrl]
    )

    const resolveReadyGroupRelayUrls = useCallback(async () => {
      const readyGroupRelays = await Promise.all(
        groupRelayTargets.map(async (target) => {
          try {
            const refreshResult = await refreshRelaySubscriptions({
              publicIdentifier: target.groupId,
              reason: 'list-editor-save-refresh',
              timeoutMs: 12_000
            })
            const status = String(refreshResult?.status || '')
            const reason = String(refreshResult?.reason || '')
            if (status !== 'ok' && reason !== 'throttled') return null
            return resolveRelayUrl(target.relayUrl) || target.relayUrl
          } catch (_error) {
            return null
          }
        })
      )

      return dedupeRelayUrlsByIdentity(
        readyGroupRelays.filter((relayUrl): relayUrl is string => !!relayUrl)
      )
    }, [groupRelayTargets, refreshRelaySubscriptions, resolveRelayUrl])

    return (
      <SecondaryPageLayout
        ref={ref}
        index={index}
        title={isEditing ? t('Edit List') : t('New List')}
        displayScrollToTopButton
      >
        <div className="p-4">
          <ListEditorForm
            listId={listId}
            onSaved={() => {
              pop()
              void (async () => {
                try {
                  const listFetchRelayUrls = await resolveReadyGroupRelayUrls()
                  await fetchLists(listFetchRelayUrls)
                } catch (error) {
                  console.warn('Failed to refresh lists after save:', error)
                }
              })()
            }}
            onCancel={() => pop()}
          />
        </div>
      </SecondaryPageLayout>
    )
  }
)

ListEditorPage.displayName = 'ListEditorPage'

export default ListEditorPage
