import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

export default function EndInspectionDialog({
  saving,
  initialReason,
  onClose,
  onSubmit,
}: {
  saving: boolean;
  initialReason?: string;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState(initialReason ?? "");
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
  return (
    <dialog
      ref={dialog}
      className="end-inspection-dialog"
      aria-labelledby="end-inspection-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id="end-inspection-title">End inspection early?</h2>
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
      <p className="end-explanation">
        Your progress and evidence will be saved. Describe the issue so the next person knows what
        needs attention.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim() && !saving) onSubmit(reason.trim());
        }}
      >
        <label
          className="field-label"
          htmlFor="end-reason"
        >
          Why does this inspection need to end?
        </label>
        <textarea
          id="end-reason"
          autoFocus
          required
          maxLength={2000}
          rows={4}
          disabled={saving}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Describe what is preventing you from continuing…"
        />
        <div className="modal-actions">
          <button
            type="button"
            className="button quiet"
            disabled={saving}
            onClick={onClose}
          >
            Continue inspection
          </button>
          <button
            type="submit"
            className="button end-confirm"
            disabled={saving || !reason.trim()}
          >
            {saving ? "Saving…" : "End & save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
