import { memo, useCallback, useState, type ReactNode } from "react";

import {
  createComposerImageThumbnail,
  readComposerImageThumbnail,
  isHeicImageFile,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
} from "../../lib/imageCompression";
import { cn } from "~/lib/utils";

export const ComposerImageThumbnail = memo(function ComposerImageThumbnail({
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
  const [loadedFile, setLoadedFile] = useState<File | null>(null);
  const attach = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image) return;
      const cached = readComposerImageThumbnail(file);
      const localUrl =
        !cached && !isHeicImageFile(file) && file.size <= MAX_COMPRESSIBLE_SOURCE_BYTES
          ? URL.createObjectURL(file)
          : undefined;
      const src = cached ?? localUrl;
      if (src) image.src = src;
      let disposed = false;
      if (cached === undefined) {
        void createComposerImageThumbnail(file).then(async (thumbnail) => {
          if (!thumbnail || disposed) return;
          const decoded = new Image();
          decoded.src = thumbnail;
          try {
            await decoded.decode();
          } catch {
            return;
          }
          if (!disposed) image.src = thumbnail;
        });
      }
      return () => {
        disposed = true;
        if (localUrl) URL.revokeObjectURL(localUrl);
      };
    },
    [file],
  );
  const ready = loadedFile === file;
  return (
    <span className="relative block size-full">
      {!ready && fallback}
      <img
        ref={attach}
        alt={alt}
        onLoad={() => setLoadedFile(file)}
        onError={() => setLoadedFile(null)}
        className={cn(className, !ready && "invisible absolute inset-0")}
      />
    </span>
  );
});
