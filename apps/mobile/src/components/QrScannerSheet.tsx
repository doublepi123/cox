import { useEffect, useRef, useState, type FormEvent } from "react";
import { normalizeRemoteOrigin, RemoteAdmissionError } from "@t3tools/shared/remoteServerAdmission";
import { formatConnectionError, type Translator } from "../i18n";
import { Sheet } from "./Sheet";

interface DetectedBarcode {
  readonly rawValue: string;
}

interface Detector {
  detect(source: HTMLVideoElement): Promise<readonly DetectedBarcode[]>;
}

interface DetectorConstructor {
  new (options: { readonly formats: readonly string[] }): Detector;
}

declare global {
  interface Window {
    BarcodeDetector?: DetectorConstructor;
  }
}

interface QrScannerSheetProps {
  readonly onDetect: (origin: string) => void;
  readonly onClose: () => void;
  readonly t: Translator;
}

export function QrScannerSheet(props: QrScannerSheetProps) {
  const [value, setValue] = useState("");
  const [cameraState, setCameraState] = useState<"idle" | "active" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastValueRef = useRef<string | null>(null);
  const t = props.t;
  const detectorAvailable =
    typeof window.BarcodeDetector === "function" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";

  const stopCamera = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    },
    [],
  );

  const acceptValue = (input: string): boolean => {
    try {
      const origin = normalizeRemoteOrigin(input, { allowInsecureHttp: true });
      setError(null);
      stopCamera();
      props.onDetect(origin);
      return true;
    } catch (caught) {
      if (caught instanceof RemoteAdmissionError) {
        setError(formatConnectionError(caught, t));
        return false;
      }
      throw caught;
    }
  };

  const startCamera = async () => {
    const Constructor = window.BarcodeDetector;
    if (!Constructor || !detectorAvailable || cameraState === "active") return;
    setError(null);
    try {
      const detector = new Constructor({ formats: ["qr_code"] });
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      setCameraState("active");

      const scan = async () => {
        const activeVideo = videoRef.current;
        if (!streamRef.current || !activeVideo) return;
        try {
          const barcodes = await detector.detect(activeVideo);
          const rawValue = barcodes[0]?.rawValue;
          if (rawValue && rawValue !== lastValueRef.current) {
            lastValueRef.current = rawValue;
            if (acceptValue(rawValue)) return;
          }
        } catch (caught) {
          setCameraState("failed");
          setError(caught instanceof Error ? t("cameraFailed") : t("unknownError"));
          stopCamera();
          return;
        }
        frameRef.current = requestAnimationFrame(() => void scan());
      };
      frameRef.current = requestAnimationFrame(() => void scan());
    } catch (caught) {
      stopCamera();
      setCameraState("failed");
      setError(caught instanceof Error ? t("cameraFailed") : t("unknownError"));
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    acceptValue(value);
  };

  return (
    <Sheet
      title={t("qrTitle")}
      description={t("qrDescription")}
      closeLabel={t("close")}
      onClose={props.onClose}
      className="qr-sheet"
    >
      <div className="qr-scanner">
        <video
          ref={videoRef}
          className="camera-preview"
          hidden={cameraState !== "active"}
          muted
          playsInline
          aria-label={t("cameraActive")}
        />
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void startCamera()}
          disabled={!detectorAvailable || cameraState === "active"}
        >
          {t("startCamera")}
        </button>
        <p className="field-help">
          {cameraState === "active"
            ? t("cameraActive")
            : detectorAvailable
              ? t("qrDescription")
              : t("cameraUnavailable")}
        </p>
        <form className="manual-qr" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="qr-origin">{t("qrInputLabel")}</label>
            <input
              id="qr-origin"
              type="url"
              inputMode="url"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={t("qrInputPlaceholder")}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </div>
          <button type="submit" className="button button-primary submit-button">
            {t("useOrigin")}
          </button>
        </form>
        {error ? (
          <p className="form-error" role="alert" data-testid="qr-error">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
