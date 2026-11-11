import { memo, Suspense, use, useCallback, useState, type ReactNode } from "react";

import {
  createComposerImageThumbnail,
  readComposerImageThumbnail,
  isHeicImageFile,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
} from "../../lib/imageCompression";
import { cn } from "~/lib/utils";

export const ComposerImageThumbnail = memo(function ComposerImageThumbnail(props: {
  file: File;
  alt: string;
  className: string;
  fallback: ReactNode;
}) {
  return (
    <Suspense fallback={props.fallback}>
      <ThumbnailImage {...props} />
    </Suspense>
  );
});

function ThumbnailImage({
  file,
  alt,
  className,
  fallback,
}: {
  file: File;
  alt: string;
  className: string;
  fallback: ReactNode;
}) {
  // A settled thumbnail paints synchronously instead of suspending for a tick.
  const settled = readComposerImageThumbnail(file);
  const src = settled === undefined ? use(createComposerImageThumbnail(file)) : settled;
  return src || (!isHeicImageFile(file) && file.size <= MAX_COMPRESSIBLE_SOURCE_BYTES) ? (
    <DecodedThumbnail file={file} src={src} alt={alt} className={className} fallback={fallback} />
  ) : (
    fallback
  );
}

function DecodedThumbnail({
  file,
  src,
  alt,
  className,
  fallback,
}: {
  file: File;
  src: string | null;
  alt: string;
  className: string;
  fallback: ReactNode;
}) {
  const [loaded, setLoaded] = useState<{ file: File; src: string | null } | null>(null);
  const [failed, setFailed] = useState<{ file: File; src: string | null } | null>(null);
  const ready = loaded?.file === file && loaded.src === src;
  const unavailable = failed?.file === file && failed.src === src;
  const attach = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image || src) return;
      const localUrl = URL.createObjectURL(file);
      image.src = localUrl;
      return () => URL.revokeObjectURL(localUrl);
    },
    [file, src],
  );
  if (unavailable) return fallback;
  return (
    <span className="relative block size-full">
      {!ready && fallback}
      <img
        ref={attach}
        src={src ?? undefined}
        alt={alt}
        onLoad={() => setLoaded({ file, src })}
        onError={() => setFailed({ file, src })}
        className={cn(className, !ready && "invisible absolute inset-0")}
      />
    </span>
  );
}
