import GatewaySettingsPanel from '@/components/Settings/GatewaySettingsPanel'
import PublicGatewayPanel from '@/components/Settings/PublicGatewayPanel'
import WorkerControlPanel from '@/components/Settings/WorkerControlPanel'

export default function LocalPeerNodeSettingsContent() {
  return (
    <div className="space-y-4 px-4 py-3">
      <WorkerControlPanel />
      <GatewaySettingsPanel />
      <PublicGatewayPanel />
    </div>
  )
}
