// `<img>` for a core byte-serving route (`/files/preview`, diff/PR blobs).
// The route needs the `Authorization` header an `<img src>` can't send, so
// the bytes are fetched by `useAuthedObjectUrl` and shown through a `blob:`
// URL (master-token plan, D13/P9). While loading — and for any non-ok status —
// no `<img>` is rendered (a src-less image would paint the browser's broken
// glyph); the optional `placeholder` fills the space instead and the parent
// learns the outcome through `onStatus`, which is how `MdImage` walks its
// candidate list and `BinaryFilePreview` picks its empty-state copy.
import { useEffect, useRef } from "react";
import { useAuthedObjectUrl, type AuthedBlobStatus } from "@/lib/authed-blob";

export type AuthedImgProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  /** The token-less core URL (`api.filePreviewUrl(…)` and friends). */
  url: string;
  /** Called once per settled outcome for `url` (`ok` / `missing` /
   *  `too-large` / `error`) — never for `loading`. A decode failure of the
   *  fetched bytes reports `error`. */
  onStatus?: (status: Exclude<AuthedBlobStatus, "loading">) => void;
  /** Rendered in place of the image until it is `ok` (default: nothing). */
  placeholder?: React.ReactNode;
};

export function AuthedImg({ url, onStatus, placeholder = null, onError, ...imgProps }: AuthedImgProps) {
  const { src, status } = useAuthedObjectUrl(url);

  // Latest callback without re-firing the effect when only its identity changes.
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  useEffect(() => {
    if (status !== "loading") onStatusRef.current?.(status);
  }, [url, status]);

  if (status !== "ok" || src === null) return <>{placeholder}</>;
  return (
    // eslint-disable-next-line jsx-a11y/alt-text -- alt arrives through imgProps
    <img
      {...imgProps}
      src={src}
      data-src-url={url}
      onError={(e) => {
        onError?.(e);
        onStatusRef.current?.("error");
      }}
    />
  );
}
