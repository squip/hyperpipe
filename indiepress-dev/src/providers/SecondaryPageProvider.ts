import { createContext, useContext } from 'react'

export type TSecondaryPageContext = {
  push: (url: string) => void
  pop: () => void
  currentIndex: number
}

export const SecondaryPageContext = createContext<TSecondaryPageContext | undefined>(undefined)

export function useSecondaryPage() {
  const context = useContext(SecondaryPageContext)
  if (!context) {
    throw new Error('useSecondaryPage must be used within a SecondaryPageContext.Provider')
  }
  return context
}
