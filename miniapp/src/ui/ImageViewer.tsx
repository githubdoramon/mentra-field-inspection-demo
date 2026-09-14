import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { Minus, Plus, RotateCcw, X } from "lucide-react";

type Point = { x: number; y: number };
type Transform = Point & { scale: number };
const INITIAL: Transform = { x: 0, y: 0, scale: 1 };

export default function ImageViewer({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const previous = useRef<{ center: Point; distance: number } | null>(null);
  const transform = useRef(INITIAL);
  const [view, setView] = useState(INITIAL);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    return () => {
      element.close();
      document.body.style.overflow = overflow;
    };
  }, []);

  const apply = (next: Transform) => {
    const element = stage.current;
    const photo = image.current;
    if (!element || !photo) return;
    const rect = element.getBoundingClientRect();
    const fit = photo.naturalWidth
      ? Math.min(rect.width / photo.naturalWidth, rect.height / photo.naturalHeight)
      : 1;
    const maxX = Math.max(0, (photo.naturalWidth * fit * next.scale - rect.width) / 2);
    const maxY = Math.max(0, (photo.naturalHeight * fit * next.scale - rect.height) / 2);
    transform.current = {
      ...next,
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
    setView(transform.current);
  };
  const position = (clientX: number, clientY: number): Point => {
    const element = stage.current;
    if (!element) return { x: clientX, y: clientY };
    const rect = element.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };
  const gesture = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a) return null;
    return {
      center: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a,
      distance: b ? Math.hypot(b.x - a.x, b.y - a.y) : 0,
    };
  };
  const zoom = (scale: number, anchor: Point = { x: 0, y: 0 }) => {
    const current = transform.current;
    const clamped = Math.max(1, Math.min(6, scale));
    const ratio = clamped / current.scale;
    apply({
      scale: clamped,
      x: anchor.x - (anchor.x - current.x) * ratio,
      y: anchor.y - (anchor.y - current.y) * ratio,
    });
  };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, position(event.clientX, event.clientY));
    previous.current = gesture();
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, position(event.clientX, event.clientY));
    const next = gesture();
    if (!next) return;
    const before = previous.current;
    if (before) {
      const current = transform.current;
      const scale =
        before.distance && next.distance
          ? Math.max(1, Math.min(6, (current.scale * next.distance) / before.distance))
          : current.scale;
      const ratio = scale / current.scale;
      apply({
        scale,
        x: next.center.x - (before.center.x - current.x) * ratio,
        y: next.center.y - (before.center.y - current.y) * ratio,
      });
    }
    previous.current = next;
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    previous.current = gesture();
  };

  return (
    <dialog
      ref={dialog}
      className="image-viewer"
      aria-labelledby="image-viewer-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="image-viewer-header">
        <div>
          <h2 id="image-viewer-title">Correct fit</h2>
          <p>Pinch to zoom · Drag to explore</p>
        </div>
        <button
          type="button"
          className="viewer-button"
          onClick={onClose}
          aria-label="Close photo"
        >
          <X size={22} />
        </button>
      </header>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Supplementary pointer gestures inside the viewer; named zoom and reset buttons remain keyboard accessible. */}
      <div
        ref={stage}
        className={`image-viewer-stage ${view.scale > 1 ? "zoomed" : ""}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={up}
        onDoubleClick={(event) =>
          zoom(transform.current.scale > 1 ? 1 : 3, position(event.clientX, event.clientY))
        }
      >
        <img
          ref={image}
          src={src}
          alt={alt}
          draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      </div>
      <footer className="image-viewer-controls">
        <button
          type="button"
          className="viewer-button"
          disabled={view.scale <= 1}
          onClick={() => zoom(view.scale / 1.5)}
          aria-label="Zoom out"
        >
          <Minus size={20} />
        </button>
        <span aria-live="polite">{Math.round(view.scale * 100)}%</span>
        <button
          type="button"
          className="viewer-button"
          disabled={view.scale >= 6}
          onClick={() => zoom(view.scale * 1.5)}
          aria-label="Zoom in"
        >
          <Plus size={20} />
        </button>
        <button
          type="button"
          className="viewer-button"
          onClick={() => apply(INITIAL)}
          aria-label="Reset zoom"
        >
          <RotateCcw size={19} />
        </button>
      </footer>
    </dialog>
  );
}
