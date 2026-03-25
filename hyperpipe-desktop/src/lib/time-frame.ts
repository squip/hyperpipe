export type TTimeFrame = {
  value: number
  unit: 'hours' | 'days'
  label: string
}

export type TStoredTimeFrame = {
  value: number
  unit: 'hours' | 'days'
}

export const createTimeFrameOptions = (t: (key: string) => string): TTimeFrame[] => [
  ...Array.from({ length: 24 }, (_, i) => ({
    value: i + 1,
    unit: 'hours' as const,
    label: `${i + 1} ${t('GroupedNotesHours')}`
  })),
  ...Array.from({ length: 29 }, (_, i) => ({
    value: i + 2,
    unit: 'days' as const,
    label: `${i + 2} ${t('GroupedNotesDays')}`
  }))
]

export function resolveStoredTimeFrame(
  storedTimeFrame: TStoredTimeFrame | null | undefined,
  timeFrameOptions: TTimeFrame[]
) {
  if (!storedTimeFrame) {
    return timeFrameOptions[23]
  }

  return (
    timeFrameOptions.find(
      (option) =>
        option.value === storedTimeFrame.value && option.unit === storedTimeFrame.unit
    ) || timeFrameOptions[23]
  )
}

export function getTimeFrameInMs(timeFrame: TTimeFrame): number {
  const multiplier = timeFrame.unit === 'hours' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  return timeFrame.value * multiplier
}
