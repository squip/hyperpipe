import {
  getJoinFlowPhaseLabel,
  getJoinFlowProgressValue,
  getJoinFlowTitle,
  type JoinFlowUiPhase
} from '@/lib/join-flow-ui'
import WorkflowProgress from '@/components/WorkflowProgress'

type HyperpipeJoinFlowProgressProps = {
  phase?: JoinFlowUiPhase
  className?: string
}

export default function HyperpipeJoinFlowProgress({
  phase,
  className
}: HyperpipeJoinFlowProgressProps) {
  const title = getJoinFlowTitle(phase)
  const detail = getJoinFlowPhaseLabel(phase)
  const value = getJoinFlowProgressValue(phase)

  return <WorkflowProgress title={title} detail={detail} value={value} className={className} />
}
