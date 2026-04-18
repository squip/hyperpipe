import ScrollToTopButton from '@/components/ScrollToTopButton'
import { Titlebar } from '@/components/Titlebar'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useSecondaryPage } from '@/PageManager'
import { DeepBrowsingProvider } from '@/providers/DeepBrowsingProvider'
import { useUserPreferences } from '@/providers/UserPreferencesProvider'
import { ChevronLeft } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useTranslation } from 'react-i18next'

const SecondaryPageLayout = forwardRef(
  (
    {
      children,
      index,
      title,
      controls,
      hideBackButton = false,
      hideTitlebarBottomBorder = false,
      displayScrollToTopButton = false,
      titlebar,
      onScrollContextChange,
      skipInitialScrollToTop = false,
      disableOuterScroll = false
    }: {
      children?: React.ReactNode
      index?: number
      title?: React.ReactNode
      controls?: React.ReactNode
      hideBackButton?: boolean
      hideTitlebarBottomBorder?: boolean
      displayScrollToTopButton?: boolean
      titlebar?: React.ReactNode
      onScrollContextChange?: (useDocumentScroll: boolean) => void
      skipInitialScrollToTop?: boolean
      disableOuterScroll?: boolean
    },
    ref
  ) => {
    const scrollAreaRef = useRef<HTMLDivElement>(null)
    const { enableSingleColumnLayout } = useUserPreferences()
    const { currentIndex } = useSecondaryPage()

    useImperativeHandle(
      ref,
      () => ({
        scrollToTop: (behavior: ScrollBehavior = 'smooth') => {
          setTimeout(() => {
            if (scrollAreaRef.current) {
              return scrollAreaRef.current.scrollTo({ top: 0, behavior })
            }
            window.scrollTo({ top: 0, behavior })
          }, 10)
        }
      }),
      []
    )

    useEffect(() => {
      onScrollContextChange?.(enableSingleColumnLayout)
    }, [enableSingleColumnLayout, onScrollContextChange])

    useEffect(() => {
      if (enableSingleColumnLayout && !skipInitialScrollToTop) {
        setTimeout(() => window.scrollTo({ top: 0 }), 10)
        return
      }
    }, [enableSingleColumnLayout, skipInitialScrollToTop])

    if (enableSingleColumnLayout) {
      return (
        <DeepBrowsingProvider active={currentIndex === index}>
          <div
            style={{
              paddingBottom: 'calc(env(safe-area-inset-bottom) + 3rem)'
            }}
          >
            <SecondaryPageTitlebar
              title={title}
              controls={controls}
              hideBackButton={hideBackButton}
              hideBottomBorder={hideTitlebarBottomBorder}
              titlebar={titlebar}
            />
            {children}
          </div>
          {displayScrollToTopButton && <ScrollToTopButton />}
        </DeepBrowsingProvider>
      )
    }

    if (disableOuterScroll) {
      return (
        <DeepBrowsingProvider active={currentIndex === index}>
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <SecondaryPageTitlebar
              title={title}
              controls={controls}
              hideBackButton={hideBackButton}
              hideBottomBorder={hideTitlebarBottomBorder}
              titlebar={titlebar}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              {children}
            </div>
          </div>
        </DeepBrowsingProvider>
      )
    }

    return (
      <DeepBrowsingProvider active={currentIndex === index} scrollAreaRef={scrollAreaRef}>
        <ScrollArea
          className="h-full overflow-auto"
          scrollBarClassName="z-50 pt-12"
          ref={scrollAreaRef}
        >
          <SecondaryPageTitlebar
            title={title}
            controls={controls}
            hideBackButton={hideBackButton}
            hideBottomBorder={hideTitlebarBottomBorder}
            titlebar={titlebar}
          />
          {children}
          <div className="h-4" />
        </ScrollArea>
        {displayScrollToTopButton && <ScrollToTopButton scrollAreaRef={scrollAreaRef} />}
      </DeepBrowsingProvider>
    )
  }
)
SecondaryPageLayout.displayName = 'SecondaryPageLayout'
export default SecondaryPageLayout

export function SecondaryPageTitlebar({
  title,
  controls,
  hideBackButton = false,
  hideBottomBorder = false,
  titlebar
}: {
  title?: React.ReactNode
  controls?: React.ReactNode
  hideBackButton?: boolean
  hideBottomBorder?: boolean
  titlebar?: React.ReactNode
}): JSX.Element {
  if (titlebar) {
    return (
      <Titlebar className="p-1" hideBottomBorder={hideBottomBorder}>
        {titlebar}
      </Titlebar>
    )
  }
  return (
    <Titlebar
      className="flex gap-1 p-1 items-center justify-between font-semibold"
      hideBottomBorder={hideBottomBorder}
    >
      <div className="flex min-w-0 w-full items-center justify-between gap-2">
        {hideBackButton ? (
          <div className="flex min-w-0 items-center gap-2 pl-3 text-lg font-semibold">
            <div className="truncate">{title}</div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center">
            <BackButton>{title}</BackButton>
          </div>
        )}
        {controls ? <div className="shrink-0">{controls}</div> : null}
      </div>
    </Titlebar>
  )
}

function BackButton({ children }: { children?: React.ReactNode }) {
  const { t } = useTranslation()
  const { pop } = useSecondaryPage()

  return (
    <Button
      className="inline-flex max-w-full min-w-0 items-center justify-start gap-1 pl-2 pr-3"
      variant="ghost"
      size="titlebar-icon"
      title={t('back')}
      onClick={() => pop()}
    >
      <ChevronLeft />
      <div className="truncate text-lg font-semibold">{children}</div>
    </Button>
  )
}
