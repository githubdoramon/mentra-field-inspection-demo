import { useEffect, useRef } from "react";
import { RotateCcw, X } from "lucide-react";

export default function ResetInspectionDialog({
  saving,
  onClose,
  onConfirm,
}: {
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="end-inspection-dialog reset-inspection-dialog"
      aria-labelledby="reset-inspection-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <div className="modal-heading">
        <div>
          <p className="eyebrow">START OVER</p>
          <h2 id="reset-inspection-title">Reset inspection?</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          disabled={saving}
          onClick={onClose}
          aria-label="Close"
        >
          <X size={20} />
        </button>
      </div>
      <div className="reset-inspection-copy">
        <span className="reset-inspection-icon">
          <RotateCcw size={20} />
        </span>
        <p>
          Clear the current progress, photos, and findings from this device and begin at the first
          step. Saved server evidence and recordings will remain available for review.
        </p>
      </div>
      <div className="modal-actions">
        <button
          type="button"
          className="button quiet"
          disabled={saving}
          onClick={onClose}
        >
          Keep inspection
        </button>
        <button
          type="button"
          className="button reset-confirm"
          disabled={saving}
          onClick={onConfirm}
        >
          {saving ? "Resetting…" : "Reset inspection"}
        </button>
      </div>
    </dialog>
  );
}
