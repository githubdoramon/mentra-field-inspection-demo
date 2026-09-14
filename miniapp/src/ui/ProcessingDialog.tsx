import { useEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";

export type ProcessingStage = "capturing" | "archiving" | "evaluating";

type PhotoSource = {
  photoUrl: string;
  previewDataUrl?: string;
};

type ProcessingDialogProps = {
  stage: ProcessingStage;
  pendingPhoto?: PhotoSource;
  latestEvidence?: PhotoSource;
};

function diagnosticUrl(value: string): string {
  if (value.startsWith("data:")) return "[inline image]";
  try {
    const url = new URL(value, window.location.href);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[invalid photo URL]";
  }
}

export function PhotoPreview({
  src,
  alt,
  className = "",
  unavailable = "Photo preview unavailable",
}: {
  src: string;
  alt: string;
  className?: string;
  unavailable?: string;
}) {
  const [failed, setFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset failure state whenever the intentionally watched image source changes.
  useEffect(() => setFailed(false), [src]);
  if (failed || !src) {
    return (
      <div
        className={`photo-fallback ${className}`}
        role="img"
        aria-label={unavailable}
      >
        <ImageOff
          size={22}
          aria-hidden="true"
        />
        <span>{unavailable}</span>
      </div>
    );
  }
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      onError={() => {
        setFailed(true);
        console.warn("[inspection]", {
          event: "ui.photo-preview-failure",
          url: diagnosticUrl(src),
        });
      }}
    />
  );
}

const STAGE_COPY: Record<ProcessingStage, { title: string; description: string }> = {
  capturing: {
    title: "Taking your photo…",
    description: "Frame the purge limiter and hold still for a moment.",
  },
  archiving: {
    title: "Preparing your photo…",
    description: "Your photo is ready. We’re getting it ready for the inspection.",
  },
  evaluating: {
    title: "Checking the purge limiter…",
    description: "Checking the photo against the inspection criteria.",
  },
};

export default function ProcessingDialog({
  stage,
  pendingPhoto,
  latestEvidence,
}: ProcessingDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const copy = STAGE_COPY[stage];
  const src = pendingPhoto?.photoUrl || latestEvidence?.previewDataUrl || latestEvidence?.photoUrl;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    heading.current?.focus();
    return () => {
      if (element.open) element.close();
      document.body.style.overflow = overflow;
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="processing-dialog"
      aria-labelledby="processing-title"
      aria-describedby="processing-description"
      onCancel={(event) => event.preventDefault()}
    >
      <div className="processing-dialog-inner">
        <div className="processing-dialog-heading">
          <span className="processing-kicker">FIELD INSPECTION</span>
          <span
            className="processing-spinner"
            role="status"
            aria-label="Processing"
          />
        </div>
        <h2
          id="processing-title"
          ref={heading}
          tabIndex={-1}
        >
          {copy.title}
        </h2>
        <p id="processing-description">{copy.description}</p>
        <div className={`processing-photo ${src ? "has-photo" : ""}`}>
          {src ? (
            <PhotoPreview
              src={src}
              alt="Current inspection photo"
              unavailable="Photo preview unavailable"
            />
          ) : (
            <div className="processing-photo-empty">
              <img
                className="processing-capture-illustration"
                src="./assets/capture-waiting.webp"
                alt=""
                width={960}
                height={640}
              />
              <span>Waiting for the photo</span>
            </div>
          )}
        </div>
        <p className="processing-note">We’ll show the result here when it’s ready.</p>
      </div>
    </dialog>
  );
}
