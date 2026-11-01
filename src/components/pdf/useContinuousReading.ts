"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReadingPosition } from "../../lib/types";
import type { PdfLocation } from "./types";
import type { PdfPageDescriptor } from "./usePdfDocument";
import {
  captureAnchor,
  layoutPages,
  mostVisiblePage,
  restoreAnchor,
  type PageLayout,
  type ScrollAnchor,
} from "./continuous";
import { clampPageIndex, normalizedToViewportRect } from "./geometry";

interface Options {
  paperId: string;
  attachmentId: string;
  pages: PdfPageDescriptor[];
  scale: number | "page-width";
  rotation: number;
  width: number;
  navigation: PdfLocation;
  onPositionChange?: (position: ReadingPosition) => void | Promise<void>;
  /** Local observation happens before the persistence debounce starts. */
  onPositionObserved?: (position: ReadingPosition) => void;
}

const keyOf = (position: ReadingPosition) =>
  `${position.attachmentId}:${position.pageIndex}:${position.scale}:${position.rotation}`;

export function useContinuousReading(options: Options) {
  const { pages, scale, width, rotation, attachmentId, navigation } = options;
  const stageRef = useRef<HTMLDivElement>(null);
  const latest = useRef(options);
  latest.current = options;
  const layouts = useMemo(
    () => layoutPages(pages, scale, width, rotation),
    [pages, scale, width, rotation],
  );
  const previousLayouts = useRef<PageLayout[]>([]);
  const previousAttachment = useRef("");
  const previousNavigation = useRef<PdfLocation | null>(null);
  const readyAttachment = useRef("");
  const heldAnchor = useRef<ScrollAnchor | null>(null);
  const suppressUntil = useRef(0);
  const currentIndex = useRef(navigation.pageIndex);
  const [pageIndex, setPageIndex] = useState(navigation.pageIndex);
  const [positionError, setPositionError] = useState("");
  const pendingPosition = useRef<ReadingPosition | null>(null);
  const lastSent = useRef("");
  const dirty = useRef(false);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const flushPosition = useCallback(() => {
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = undefined;
    const value = pendingPosition.current;
    if (!value || !dirty.current || !latest.current.onPositionChange) return;
    dirty.current = false;
    const key = keyOf(value);
    lastSent.current = key;
    void Promise.resolve(latest.current.onPositionChange(value))
      .then(() => setPositionError(""))
      .catch(() => {
        if (lastSent.current === key) {
          lastSent.current = "";
          dirty.current = true;
        }
        setPositionError(
          "阅读位置保存失败；请检查本地服务。当前阅读位置仍保留在本次会话中。",
        );
      });
  }, []);

  const rememberPosition = useCallback(
    (index: number) => {
      const value = latest.current;
      if (!value.pages.length || readyAttachment.current !== value.attachmentId)
        return;
      currentIndex.current = clampPageIndex(index, value.pages.length);
      setPageIndex(currentIndex.current);
      const position: ReadingPosition = {
        paperId: value.paperId,
        attachmentId: value.attachmentId,
        pageIndex: currentIndex.current,
        scale: value.scale,
        rotation: value.rotation,
        updatedAt: new Date().toISOString(),
      };
      pendingPosition.current = position;
      value.onPositionObserved?.(position);
      if (keyOf(position) === lastSent.current) return;
      dirty.current = true;
      if (writeTimer.current) clearTimeout(writeTimer.current);
      writeTimer.current = setTimeout(flushPosition, 450);
    },
    [flushPosition],
  );

  const holdScrollAnchor = useCallback(() => {
    const stage = stageRef.current;
    if (stage && previousLayouts.current.length)
      heldAnchor.current = captureAnchor(
        previousLayouts.current,
        stage.scrollTop,
        stage.scrollLeft,
        stage.clientWidth,
      );
  }, []);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !layouts.length) {
      readyAttachment.current = "";
      previousLayouts.current = [];
      return;
    }
    const newDocument =
      previousAttachment.current !== attachmentId ||
      previousLayouts.current.length === 0;
    const newNavigation = previousNavigation.current !== navigation;
    let index = currentIndex.current;
    let destination: { top: number; left: number } | null = null;
    if (
      (newDocument || newNavigation) &&
      navigation.attachmentId === attachmentId
    ) {
      index = clampPageIndex(navigation.pageIndex, pages.length);
      const page = layouts[index];
      destination = { top: page.top, left: stage.scrollLeft };
      if (navigation.rects?.length && navigation.pageIndex < pages.length) {
        const descriptor = pages[index];
        const viewport = descriptor.page.getViewport({
          scale: page.scale,
          rotation: (descriptor.rotation + rotation + 360) % 360,
        });
        const rect = normalizedToViewportRect(
          navigation.rects[0],
          viewport,
          descriptor.page.view,
        );
        const contentWidth = Math.max(
          width,
          ...layouts.map((item) => item.width),
        );
        destination = {
          top: Math.max(
            0,
            page.top + rect.y + rect.height / 2 - stage.clientHeight / 2,
          ),
          left: Math.max(
            0,
            16 +
              (contentWidth - page.width) / 2 +
              rect.x -
              stage.clientWidth * 0.2,
          ),
        };
      }
      heldAnchor.current = null;
    } else if (heldAnchor.current) {
      destination = restoreAnchor(
        layouts,
        heldAnchor.current,
        stage.clientWidth,
      );
      heldAnchor.current = null;
      index = mostVisiblePage(layouts, destination.top, stage.clientHeight);
    }
    previousAttachment.current = attachmentId;
    previousNavigation.current = navigation;
    previousLayouts.current = layouts;
    readyAttachment.current = attachmentId;
    if (destination) {
      suppressUntil.current = performance.now() + 120;
      stage.scrollTo({ ...destination, behavior: "auto" });
    }
    rememberPosition(index);
  }, [
    layouts,
    attachmentId,
    navigation,
    pages,
    rotation,
    width,
    rememberPosition,
  ]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let frame = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      frame = 0;
      if (
        !previousLayouts.current.length ||
        readyAttachment.current !== latest.current.attachmentId
      )
        return;
      const remaining = suppressUntil.current - performance.now();
      if (remaining > 0) {
        if (settle) clearTimeout(settle);
        settle = setTimeout(update, remaining + 5);
        return;
      }
      rememberPosition(
        mostVisiblePage(
          previousLayouts.current,
          stage.scrollTop,
          stage.clientHeight,
        ),
      );
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    stage.addEventListener("scroll", onScroll, { passive: true });
    const resize = new ResizeObserver(onScroll);
    resize.observe(stage);
    return () => {
      stage.removeEventListener("scroll", onScroll);
      resize.disconnect();
      cancelAnimationFrame(frame);
      if (settle) clearTimeout(settle);
    };
  }, [rememberPosition]);

  useEffect(() => {
    window.addEventListener("pagehide", flushPosition);
    return () => {
      window.removeEventListener("pagehide", flushPosition);
      flushPosition();
    };
  }, [flushPosition]);
  return {
    stageRef,
    layouts,
    pageIndex,
    positionError,
    holdScrollAnchor,
    flushPosition,
  };
}
