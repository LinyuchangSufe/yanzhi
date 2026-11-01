"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { markdownLabel } from "../../lib/editor/paper-completion";

const maximum = 10 * 1024 * 1024;
const acceptedTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const imageFile = (file: File) =>
  file.type.startsWith("image/") ||
  /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name);
interface Upload {
  id: number;
  file: File;
  at: number;
  status: "pending" | "failed";
  error: string;
  controller?: AbortController;
  promise?: Promise<void>;
}
interface UploadStatus {
  pending: number;
  failures: { id: number; filename: string; error: string }[];
}

export function useNoteImages(options: {
  noteId: string;
  getView: () => EditorView | undefined;
  onStart: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(true);
  const uploads = useRef(new Map<number, Upload>());
  const serial = useRef<Promise<void>>(Promise.resolve());
  const sequence = useRef(0);
  const [state, setState] = useState<UploadStatus>({
    pending: 0,
    failures: [],
  });
  const publish = useCallback(() => {
    if (!mounted.current) return;
    const values = [...uploads.current.values()];
    setState({
      pending: values.filter((upload) => upload.status === "pending").length,
      failures: values
        .filter((upload) => upload.status === "failed")
        .map((upload) => ({
          id: upload.id,
          filename: upload.file.name,
          error: upload.error,
        })),
    });
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const upload of uploads.current.values()) upload.controller?.abort();
    };
  }, []);
  const start = useCallback(
    (upload: Upload) => {
      upload.status = "pending";
      upload.error = "";
      const noteId = latest.current.noteId;
      const run = async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          if (!acceptedTypes.has(upload.file.type))
            throw new Error("只支持 PNG、JPEG、WebP、GIF 图片，暂不支持 SVG。");
          if (upload.file.size > maximum)
            throw new Error("单张图片不能超过 10 MiB。");
          if (!upload.file.size)
            throw new Error("这是一张空图片，请重新选择。");
          if (!mounted.current || latest.current.noteId !== noteId) return;
          upload.controller = new AbortController();
          timeout = setTimeout(() => {
            timedOut = true;
            upload.controller?.abort();
          }, 45_000);
          const form = new FormData();
          form.set("noteId", noteId);
          form.set("file", upload.file);
          const response = await fetch("/api/kb/image", {
            method: "POST",
            body: form,
            signal: upload.controller.signal,
          });
          const json: unknown = await response.json();
          const payload = json as {
            error?: unknown;
            result?: { id?: unknown };
          };
          if (!response.ok)
            throw new Error(
              typeof payload.error === "string"
                ? payload.error
                : "图片上传失败，请重试。",
            );
          if (
            typeof payload.result?.id !== "string" ||
            !/^[a-z\d-]{36}$/i.test(payload.result.id)
          )
            throw new Error("图片服务未返回有效结果，请重试。");
          const view = latest.current.getView();
          if (!mounted.current || latest.current.noteId !== noteId || !view)
            throw new Error("编辑器已关闭，请重新打开这篇笔记后再插入图片。");
          const at = Math.min(upload.at, view.state.doc.length);
          const alt = markdownLabel(
            upload.file.name.replace(/\.[^.]+$/, "") || "图片",
          );
          const prefix =
            at > 0 && view.state.doc.sliceString(at - 1, at) !== "\n"
              ? "\n\n"
              : "";
          const text = `${prefix}![${alt}](/api/kb/image?id=${payload.result.id})\n\n`;
          view.dispatch({
            changes: { from: at, insert: text },
            userEvent: "input.paste",
          });
          uploads.current.delete(upload.id);
        } catch (error) {
          if (!mounted.current) return;
          upload.status = "failed";
          upload.error = timedOut
            ? "图片保存超时，请重试。"
            : error instanceof Error
              ? error.message
              : "图片上传失败，请重试。";
        } finally {
          if (timeout) clearTimeout(timeout);
          publish();
        }
      };
      upload.promise = serial.current.catch(() => {}).then(run);
      serial.current = upload.promise;
      publish();
    },
    [publish],
  );
  const add = useCallback(
    (files: readonly File[], at?: number) => {
      const view = latest.current.getView();
      if (!view || view.state.readOnly || !files.length) return;
      latest.current.onStart();
      for (const file of files) {
        const upload: Upload = {
          id: ++sequence.current,
          file,
          at: at ?? view.state.selection.main.to,
          status: "pending",
          error: "",
        };
        uploads.current.set(upload.id, upload);
        start(upload);
      }
    },
    [start],
  );
  const update = useCallback((view: ViewUpdate) => {
    if (!view.docChanged) return;
    for (const upload of uploads.current.values())
      upload.at = view.changes.mapPos(upload.at, 1);
  }, []);
  const extension = useRef(
    EditorView.domEventHandlers({
      paste(event, view) {
        const files = [...(event.clipboardData?.files ?? [])].filter(imageFile);
        if (!files.length) return false;
        event.preventDefault();
        add(files, view.state.selection.main.to);
        return true;
      },
      drop(event, view) {
        const files = [...(event.dataTransfer?.files ?? [])].filter(imageFile);
        if (!files.length) return false;
        event.preventDefault();
        add(
          files,
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
            view.state.selection.main.to,
        );
        return true;
      },
      dragover(event) {
        if (
          [...(event.dataTransfer?.items ?? [])].some(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          )
        ) {
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          return true;
        }
        return false;
      },
    }),
  ).current;
  const wait = useCallback(async () => {
    while (
      [...uploads.current.values()].some(
        (upload) => upload.status === "pending",
      )
    ) {
      await Promise.all(
        [...uploads.current.values()]
          .filter((upload) => upload.status === "pending")
          .map((upload) => upload.promise),
      );
    }
    if (
      [...uploads.current.values()].some((upload) => upload.status === "failed")
    )
      throw new Error(
        "有图片尚未上传成功，请先重试，或移除失败的上传。笔记原文仍保留。",
      );
  }, []);
  const hasUnsaved = useCallback(() => uploads.current.size > 0, []);
  const retry = useCallback(
    (id: number) => {
      const upload = uploads.current.get(id);
      if (upload?.status === "failed") start(upload);
    },
    [start],
  );
  const dismiss = useCallback(
    (id: number) => {
      uploads.current.delete(id);
      publish();
    },
    [publish],
  );
  return { ...state, add, update, extension, wait, hasUnsaved, retry, dismiss };
}
