// `<img>` for a core byte-serving route (`/files/preview`, diff/PR blobs).
// The route needs the `Authorization` header an `<img src>` can't send, so
// the bytes are fetched by `useAuthedObjectUrl` and shown through a `blob:`
// URL (master-token plan, D13/P9). While loading — and for any non-ok status —
// no `<img>` is rendered (a src-less image would paint the browser's broken
// glyph); the optional `placeholder` fills the space instead and the parent
// learns the outcome through `onStatus`, which is how `MdImage` walks its
// candidate list and `BinaryFilePreview` picks its empty-state copy.
//
// Lazy loading (what `<img loading="lazy">` gave for free before the fetch
// moved into script): the fetch only starts once the element is within
// `LAZY_ROOT_MARGIN` of its scroll root, an image that stays out of view
// releases its cache subscription (so the blob is revoked after the grace
// period and the bytes are re-fetched on return), and the box it occupied is
// held at its last measured size — while released and while re-fetching on
// return (`heldBoxFor`) — so neither step shifts the scroll position.
// `loading="eager"` — or a runtime without IntersectionObserver —
// fetches immediately and never releases. The pure pieces (observer registry,
// release timers, fetch queue) live in `lib/authed-blob.ts`.
import { useEffect, useRef, useState } from "react";
import {
  createLazyGate,
  findScrollRoot,
  getSharedViewportRegistry,
  heldBoxFor,
  LAZY_ROOT_MARGIN,
  useAuthedObjectUrl,
  type AuthedBlobStatus,
  type HeldBox,
  type LazyGate,
} from "@/lib/authed-blob";

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

// Gives IntersectionObserver something to watch while there is no image (a
// consumer's placeholder carries no ref). It must stay IN FLOW: an absolutely
// positioned sentinel's containing block skips a non-positioned scroll
// container, so it neither scrolls with the transcript nor has that container
// in its containing-block chain — IntersectionObserver then never reports it
// as intersecting the root and the image stays deferred forever. A 0×0
// inline-block takes no space and still intersects (the spec counts an
// edge-adjacent, zero-area target as intersecting).
const SENTINEL_STYLE: React.CSSProperties = {
  display: "inline-block",
  width: 0,
  height: 0,
  overflow: "hidden",
  verticalAlign: "top",
  pointerEvents: "none",
};

export function AuthedImg({
  url,
  onStatus,
  placeholder = null,
  onError,
  loading,
  ...imgProps
}: AuthedImgProps) {
  const registry = loading === "eager" ? null : getSharedViewportRegistry();
  const lazy = registry !== null;
  const [active, setActive] = useState(!lazy);
  const [heldSize, setHeldSize] = useState<HeldBox | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const gateRef = useRef<LazyGate | null>(null);
  // The gate's callback is created once; it reads the current url from here.
  const urlRef = useRef(url);
  urlRef.current = url;

  const { src, status } = useAuthedObjectUrl(active ? url : null);
  const showingImg = status === "ok" && src !== null;

  // The gate turns "near the viewport" into "hold a cache subscription".
  useEffect(() => {
    if (!lazy) {
      setActive(true);
      return;
    }
    const gate = createLazyGate({
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (h) => window.clearTimeout(h as number),
      onActiveChange: (next) => {
        if (!next) {
          // Releasing: keep the box the image occupied so the layout holds.
          const rect = imgRef.current?.getBoundingClientRect();
          if (rect && rect.width > 0 && rect.height > 0) {
            setHeldSize({ url: urlRef.current, width: rect.width, height: rect.height });
          }
        }
        setActive(next);
      },
    });
    gateRef.current = gate;
    return () => {
      gate.dispose();
      gateRef.current = null;
    };
  }, [lazy]);

  useEffect(() => {
    gateRef.current?.setLoading(status === "loading");
  }, [status]);

  // Watch the image itself once shown (a tall image can have its top corner
  // off-screen while most of it is visible), the sentinel otherwise.
  useEffect(() => {
    if (!registry) return;
    const el = showingImg ? imgRef.current : sentinelRef.current;
    if (!el) return;
    return registry.observe(el, { root: findScrollRoot(el), rootMargin: LAZY_ROOT_MARGIN }, (near) => {
      gateRef.current?.setNear(near);
    });
  }, [registry, showingImg]);

  // Latest callback without re-firing the effect when only its identity changes.
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  useEffect(() => {
    if (status !== "loading") onStatusRef.current?.(status);
  }, [url, status]);

  if (!showingImg) {
    const held = heldBoxFor(heldSize, url, active, status);
    return (
      <>
        {lazy && (
          <span
            ref={sentinelRef}
            aria-hidden
            data-testid="authed-img-sentinel"
            data-src-url={url}
            data-state={active ? "loading" : "deferred"}
            style={SENTINEL_STYLE}
          />
        )}
        {held ? (
          <span aria-hidden style={{ display: "inline-block", width: held.width, height: held.height }} />
        ) : (
          placeholder
        )}
      </>
    );
  }
  return (
    // eslint-disable-next-line jsx-a11y/alt-text -- alt arrives through imgProps
    <img
      {...imgProps}
      ref={imgRef}
      src={src}
      data-src-url={url}
      onError={(e) => {
        onError?.(e);
        onStatusRef.current?.("error");
      }}
    />
  );
}
