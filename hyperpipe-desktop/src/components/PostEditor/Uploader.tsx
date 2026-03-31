import mediaUpload, {
  MediaUploadContext,
  MediaUploadResult,
  UPLOAD_ABORTED_ERROR_MSG
} from '@/services/media-upload.service'
import { useRef } from 'react'
import { toast } from 'sonner'

export default function Uploader({
  children,
  onUploadSuccess,
  onUploadError,
  onUploadStart,
  onUploadEnd,
  onProgress,
  className,
  onPickerOpen,
  accept = 'image/*',
  uploadContext
}: {
  children: React.ReactNode
  onUploadSuccess: (result: MediaUploadResult, file: File) => void
  onUploadError?: (file: File, error: Error) => void
  onUploadStart?: (file: File, cancel: () => void) => void
  onUploadEnd?: (file: File) => void
  onProgress?: (file: File, progress: number) => void
  className?: string
  onPickerOpen?: () => void
  accept?: string
  uploadContext?: MediaUploadContext
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files) return

    const abortControllerMap = new Map<File, AbortController>()

    for (const file of event.target.files) {
      const abortController = new AbortController()
      abortControllerMap.set(file, abortController)
      onUploadStart?.(file, () => abortController.abort())
    }

    for (const file of event.target.files) {
      try {
        const abortController = abortControllerMap.get(file)
        const result = await mediaUpload.upload(
          file,
          {
            onProgress: (p) => onProgress?.(file, p),
            signal: abortController?.signal
          },
          uploadContext
        )
        onUploadSuccess(result, file)
        onUploadEnd?.(file)
      } catch (error) {
        console.error('Error uploading file', error)
        const uploadError = error instanceof Error ? error : new Error(String(error))
        const message = uploadError.message
        if (message !== UPLOAD_ABORTED_ERROR_MSG) {
          toast.error(`Failed to upload file: ${message}`)
          onUploadError?.(file, uploadError)
        }
        if (fileInputRef.current) {
          fileInputRef.current.value = ''
        }
        onUploadEnd?.(file)
      }
    }
  }

  const handleUploadClick = () => {
    onPickerOpen?.()
    if (fileInputRef.current) {
      fileInputRef.current.value = '' // clear the value so that the same file can be uploaded again
      fileInputRef.current.click()
    }
  }

  return (
    <div className={className}>
      <div onClickCapture={handleUploadClick}>
        {children}
      </div>
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={handleFileChange}
        accept={accept}
        multiple
      />
    </div>
  )
}
