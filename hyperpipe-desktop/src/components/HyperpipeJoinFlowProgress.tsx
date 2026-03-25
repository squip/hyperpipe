import { getJoinFlowPhaseLabel, getJoinFlowProgressValue, getJoinFlowTitle, type JoinFlowUiPhase } from '@/lib/join-flow-ui'
import { cn } from '@/lib/utils'

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

  if (!detail || value <= 0) return null

  return (
    <div className={cn('space-y-2', className)} role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-medium text-foreground">{title}</div>
        <div className="text-[11px] text-muted-foreground">{detail}</div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted/60">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out animate-pulse"
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  )
}
