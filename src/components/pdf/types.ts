import type {
  Annotation,
  AnnotationRect,
  Attachment,
  ReadingPosition,
} from "../../lib/types";
import type { GuideEvidence } from "../../lib/guide/types";

export interface PdfLocation {
  attachmentId: string;
  /** Zero based physical page index, never the printed page label. */
  pageIndex: number;
  rects?: AnnotationRect[];
  annotationId?: string;
  /** AI source target; geometry is resolved from the immutable PDF text layer. */
  guideMarkId?: string;
}

export type PdfTarget = PdfLocation;

export interface PdfSelection extends PdfLocation {
  paperId: string;
  pageLabel: string;
  rects: AnnotationRect[];
  selectedText: string;
  /** Visual transcription can target a whole page even when its text layer is empty. */
  extractionScope?: "page" | "selection";
}

export type PdfAnnotationDraft = Omit<
  Annotation,
  "id" | "revision" | "createdAt" | "updatedAt"
>;

export interface PdfReaderProps {
  paperId: string;
  attachments: Attachment[];
  annotations: Annotation[];
  initialPosition?: ReadingPosition | null;
  /** Saved positions for every attachment version, not only the latest visit. */
  readingPositions?: ReadingPosition[];
  target?: PdfLocation | null;
  onCreateAnnotation: (draft: PdfAnnotationDraft) => Promise<void>;
  onSelectAnnotation?: (id: string) => void;
  onExplainSelection?: (selection: PdfSelection) => void;
  onTranslateSelection?: (selection: PdfSelection) => void;
  onConvertMarkdown?: (selection: PdfSelection) => void;
  aiBusy?: boolean;
  onOpenAnnotation?: () => void;
  onPositionChange?: (position: ReadingPosition) => void | Promise<void>;
  onRequestAttachment?: () => void;
  focusMode?: boolean;
  guideMarks?: GuideEvidence[];
  activeGuideMarkId?: string;
  showGuideMarks?: boolean;
  onSelectGuideMark?: (id: string) => void;
  /** Reports actual PDF version immediately, independently of saved position. */
  onActiveAttachmentChange?: (attachmentId: string) => void;
  onFindPaper?: (query: string) => void;
}
