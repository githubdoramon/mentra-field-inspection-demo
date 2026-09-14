import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  FileCheck2,
  Gauge,
  ImagePlus,
  MessageCircle,
  MoreHorizontal,
  Play,
  RotateCcw,
  Save,
  Settings2,
  ShieldAlert,
  X,
} from "lucide-react";
import { MiniappHeader, useSafeArea } from "@mentra/miniapp/ui";
import type { CSSProperties } from "react";
import ImageViewer from "./ImageViewer";
import EndInspectionDialog from "./EndInspectionDialog";
import ResetInspectionDialog from "./ResetInspectionDialog";
import ProcessingDialog, { PhotoPreview } from "./ProcessingDialog";
import { createSnapshot } from "../shared/workflow";
import type { InspectionSnapshot, ProcedureStep } from "../shared/types";

export const DEFAULT = createSnapshot();
type Toast = { kind: "info" | "success" | "warning" | "error"; text: string };

export default function App({ browserMode = false }: { browserMode?: boolean }) {
  const shell = useRef<HTMLElement>(null);
  const resumeRequested = useRef(false);
  const { insets, capsuleMenu } = useSafeArea();
  const hostTop = browserMode
    ? 0
    : Math.max(
        insets.top,
        capsuleMenu ? capsuleMenu.top + capsuleMenu.height + 12 : insets.top + 72,
      );
  const hostBottom = browserMode ? 0 : insets.bottom;
  const headerStickTop = browserMode ? 0 : (capsuleMenu?.top ?? insets.top);
  const [snapshot, setSnapshot] = useState<InspectionSnapshot>(DEFAULT);
  const [toast, setToast] = useState<Toast | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState(DEFAULT.serverUrl);
  const [question, setQuestion] = useState("");
  const [health, setHealth] = useState<string | null>(null);
  const [view, setView] = useState<"queue" | "inspection" | "report">("queue");
  const [endReasonRequested, setEndReasonRequested] = useState(false);
  const [headerScrolled, setHeaderScrolled] = useState(false);

  useEffect(() => {
    const updateHeader = () => setHeaderScrolled(window.scrollY > 8);
    updateHeader();
    window.addEventListener("scroll", updateHeader, { passive: true });
    return () => window.removeEventListener("scroll", updateHeader);
  }, []);

  useEffect(() => {
    const offSnapshot = mentra.on("inspection:snapshot", (next) => {
      setSnapshot(next);
      setServerUrl(next.serverUrl);
      if (next.status === "report")
        setView((previous) => (previous === "inspection" ? "report" : previous));
    });
    const offToast = mentra.on("inspection:toast", setToast);
    const offEnd = mentra.on("inspection:request-end-reason", () => {
      setView("inspection");
      setEndReasonRequested(true);
    });
    const offShowInspection = mentra.on("inspection:show-inspection", () => {
      setView("inspection");
    });
    mentra.send("inspection:request-snapshot", {});
    return () => {
      offSnapshot();
      offToast();
      offEnd();
      offShowInspection();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const passed =
    snapshot.steps.length > 0 && snapshot.steps.every((step) => step.state === "passed");
  const current =
    snapshot.steps.find((step) => step.id === snapshot.currentStepId) ?? snapshot.steps.at(-1);
  const latestAttempt = snapshot.attempts.at(-1);
  const latestEvidence = latestAttempt?.evidenceId
    ? snapshot.evidence.find((item) => item.id === latestAttempt.evidenceId)
    : undefined;
  const processingStage =
    snapshot.status === "evaluating"
      ? "evaluating"
      : snapshot.operation === "capture" && snapshot.status === "capturing"
        ? snapshot.pendingPhoto
          ? "archiving"
          : "capturing"
        : null;
  const goInspection = () => {
    resumeRequested.current = true;
    setView("inspection");
    mentra.send("inspection:start", {});
  };
  const start = goInspection;
  const startWorkflow = (workflowId: string) => {
    resumeRequested.current = true;
    setView("inspection");
    mentra.send("inspection:start", { workflowId });
  };
  const leaveInspection = () => {
    resumeRequested.current = false;
    if (view === "inspection") mentra.send("inspection:pause", {});
    setView("queue");
  };
  useEffect(() => {
    const pauseWhenHidden = () => {
      if (view === "inspection") {
        resumeRequested.current = !document.hidden;
        mentra.send(document.hidden ? "inspection:pause" : "inspection:start", {});
      }
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, [view]);
  useEffect(() => {
    if (!snapshot.pausedAt) {
      resumeRequested.current = false;
      return;
    }
    if (
      resumeRequested.current &&
      view === "inspection" &&
      !snapshot.operation &&
      !document.hidden
    ) {
      resumeRequested.current = false;
      mentra.send("inspection:start", {});
    }
  }, [snapshot.pausedAt, snapshot.operation, view]);
  const ask = () =>
    mentra.send("inspection:ask", { question: question.trim() || "What should I do next?" });
  const checkHealth = async () => {
    setHealth("Checking…");
    const result = await mentra.request("inspection:health", {});
    setHealth(result.ok ? "Connected" : (result.message ?? "Unavailable"));
  };

  // Rebind when the rendered escalation action is replaced by a view or URL change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The DOM target changes with these render inputs.
  useEffect(() => {
    const button = shell.current?.querySelector<HTMLElement>(".escalate-button");
    if (!button) return;
    const measure = () =>
      shell.current?.style.setProperty(
        "--escalation-height",
        `${button.getBoundingClientRect().height}px`,
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(button);
    return () => observer.disconnect();
  }, [view, snapshot.escalation?.url]);
  useEffect(() => {
    if (!browserMode)
      console.info(
        "[inspection]",
        JSON.stringify({ event: "ui.hostLayout", insets, capsuleMenu, contentTop: hostTop }),
      );
  }, [browserMode, hostTop, insets, capsuleMenu]);
  return (
    <main
      ref={shell}
      className={`shell ${view === "inspection" ? "inspecting" : ""}`}
      style={
        {
          "--host-top": `${hostTop}px`,
          "--host-bottom": `${hostBottom}px`,
          "--safe-top": `${browserMode ? 0 : insets.top}px`,
          "--header-stick-top": `${headerStickTop}px`,
        } as CSSProperties
      }
    >
      <MiniappHeader
        className={`topbar ${headerScrolled ? "topbar-scrolled" : ""}`}
        style={{
          top: headerStickTop,
          height: (capsuleMenu?.height ?? 42) + (headerScrolled ? 10 : 0),
          paddingBottom: headerScrolled ? 10 : 0,
        }}
        left={
          <button
            type="button"
            className="brand"
            onClick={leaveInspection}
            aria-label="Return to work queue"
          >
            <span className="brand-mark">
              <img
                width={36}
                height={36}
                src="../../public/app_logo.png"
                alt="Field inspection"
              />
            </span>
            <span className="brand-name">Field inspection</span>
          </button>
        }
        right={
          <button
            type="button"
            className="icon-button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open connection settings"
          >
            <Settings2
              size={20}
              style={{ marginTop: 2, marginRight: 4 }}
              strokeWidth={1.8}
            />
          </button>
        }
        bottomSpacer={false}
        leftPadding={Math.max(20, browserMode ? 20 : insets.left)}
        rightGap={14}
        fallbackHeight={42}
        fallbackMarginTop={10}
      />
      {settingsOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          tabIndex={-1}
          onClick={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setSettingsOpen(false);
          }}
        >
          <section className="settings-modal">
            <div className="modal-heading">
              <div>
                <p className="eyebrow">CONNECTION</p>
                <h2 id="settings-title">Device connection</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close settings"
              >
                <X size={18} />
              </button>
            </div>
            <label
              className="field-label"
              htmlFor="server-url"
            >
              Inspection server address
            </label>
            <input
              id="server-url"
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="http://192.168.1.42:8787"
            />
            <p className="field-help">Use your laptop’s address on the same Wi-Fi network.</p>
            <div className="modal-actions">
              <button
                type="button"
                className="button quiet"
                onClick={checkHealth}
              >
                Test connection
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  mentra.send("inspection:set-server", { url: serverUrl });
                  setSettingsOpen(false);
                }}
              >
                Save
              </button>
            </div>
            {health && (
              <p className="health-line">
                <span className={`tiny-dot ${health === "Connected" ? "ok" : ""}`} />
                {health}
              </p>
            )}
          </section>
        </div>
      )}
      {view === "queue" && (
        <Queue
          snapshot={snapshot}
          onStart={startWorkflow}
          onResume={goInspection}
          onReport={() => setView("report")}
        />
      )}
      {view === "inspection" && (
        <Inspection
          snapshot={snapshot}
          browserMode={browserMode}
          current={current}
          passed={passed}
          pendingPhoto={snapshot.pendingPhoto}
          question={question}
          setQuestion={setQuestion}
          onAsk={ask}
          onFinish={(reason) => mentra.send("inspection:finish", { reason })}
          onSelect={(id) => mentra.send("inspection:select-step", { id })}
          onBack={leaveInspection}
          requestEndReason={endReasonRequested}
          onEndPromptHandled={() => setEndReasonRequested(false)}
        />
      )}
      {view === "report" && (
        <Report
          snapshot={snapshot}
          onNew={start}
          onBack={() => setView("queue")}
        />
      )}
      {processingStage && (
        <ProcessingDialog
          stage={processingStage}
          pendingPhoto={snapshot.pendingPhoto}
          latestEvidence={latestEvidence}
        />
      )}
      {toast && (
        <div
          className={`toast ${toast.kind}`}
          role="status"
        >
          {toast.text}
        </div>
      )}
    </main>
  );
}

function Queue({
  snapshot,
  onStart,
  onResume,
  onReport,
}: {
  snapshot: InspectionSnapshot;
  onStart: (id: string) => void;
  onResume: () => void;
  onReport: () => void;
}) {
  const active = snapshot.status !== "ready" && snapshot.status !== "report";
  const saved = snapshot.status === "report" || Boolean(snapshot.report);
  const workflows = [...(snapshot.workflows || [])];
  if (snapshot.workflow && !workflows.some((workflow) => workflow.id === snapshot.procedureId))
    workflows.unshift(snapshot.workflow);
  return (
    <section className="queue-page">
      <div className="queue-intro">
        <div>
          <p className="eyebrow">WORK QUEUE</p>
          <h1>Ready when you are.</h1>
          <p className="lede">Choose an inspection to begin.</p>
        </div>
      </div>
      <div className="workflow-cards">
        {workflows.map((workflow) => {
          const current = workflow.id === snapshot.procedureId;
          const inProgress = current && active;
          const reported = current && saved;
          return (
            <article
              className="task-card panel"
              key={workflow.id}
            >
              <div className="task-card-main">
                <div className="task-topline">
                  <span className="task-kind">
                    <Gauge size={15} />
                    Inspection
                  </span>
                  <span
                    className={`task-state ${inProgress ? "active" : reported ? "saved" : "ready"}`}
                  >
                    {inProgress ? "In progress" : reported ? "Saved" : "Ready"}
                  </span>
                </div>
                <h2>{workflow.title}</h2>
                <p className="task-meta">
                  {workflow.asset.name}
                  <span>•</span>
                  {workflow.asset.id}
                </p>
                <p className="task-meta">
                  {workflow.workOrder.id}
                  <span>•</span>
                  {workflow.workOrder.location}
                </p>
                <div className="task-divider" />
                <div className="task-detail">
                  <div>
                    <strong>{workflow.asset.name}</strong>
                    <small>{workflow.steps.map((step) => step.title).join(" · ")}</small>
                  </div>
                  <span className="task-number">{workflow.steps.length} steps</span>
                </div>
              </div>
              <div className="task-actions">
                <button
                  type="button"
                  className="button primary large"
                  disabled={Boolean(snapshot.operation) || (active && !current)}
                  onClick={() =>
                    inProgress ? onResume() : reported ? onReport() : onStart(workflow.id)
                  }
                >
                  {inProgress
                    ? "Resume inspection"
                    : reported
                      ? "View saved report"
                      : "Start inspection"}
                  {inProgress ? (
                    <ArrowRight size={15} />
                  ) : reported ? (
                    <FileCheck2 size={15} />
                  ) : (
                    <Play
                      size={14}
                      fill="currentColor"
                    />
                  )}
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {!workflows.length && (
        <p className="queue-note">
          No workflows loaded. Connect to the companion server and refresh.
        </p>
      )}
      {active && (
        <p className="queue-note">
          Your progress is saved as you work. Resume the active inspection before starting another.
        </p>
      )}
    </section>
  );
}

function Inspection({
  snapshot,
  browserMode,
  current,
  passed,
  pendingPhoto,
  question,
  setQuestion,
  onAsk,
  onFinish,
  onSelect,
  onBack,
  requestEndReason,
  onEndPromptHandled,
}: {
  snapshot: InspectionSnapshot;
  browserMode: boolean;
  current?: ProcedureStep;
  passed: boolean;
  pendingPhoto?: NonNullable<InspectionSnapshot["pendingPhoto"]>;
  question: string;
  setQuestion: (value: string) => void;
  onAsk: () => void;
  onFinish: (reason?: string) => void;
  onSelect: (id: string) => void;
  onBack: () => void;
  requestEndReason: boolean;
  onEndPromptHandled: () => void;
}) {
  const [exampleOpen, setExampleOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  useEffect(() => {
    if (requestEndReason) {
      setEndOpen(true);
      onEndPromptHandled();
    }
  }, [requestEndReason, onEndPromptHandled]);
  const [selectedReference, setSelectedReference] = useState<{
    url: string;
    caption: string;
  } | null>(null);
  const referenceUrl = selectedReference
    ? snapshot.serverUrl.replace(/\/$/, "") + selectedReference.url
    : undefined;
  const activeCheck = Boolean(current) && current?.state !== "passed";
  const busy =
    Boolean(snapshot.operation) || ["ready", "capturing", "evaluating"].includes(snapshot.status);
  const initial = snapshot.evidence.find(
    (item) => item.stepId === current?.id && item.kind === "initial",
  );
  const verification = [...snapshot.evidence]
    .reverse()
    .find((item) => item.stepId === current?.id && item.kind === "verification");
  const captureTitle =
    snapshot.status === "evaluating"
      ? "Checking your photo…"
      : snapshot.status === "capturing"
        ? "Preparing your photo…"
        : "Press the button on your glasses";
  const captureDescription =
    current?.captureInstruction ||
    "Frame the inspection subject clearly and press once to capture.";
  const usefulMessage =
    snapshot.message &&
    snapshot.message !== current?.instruction &&
    snapshot.message !== snapshot.latestFinding?.recommendedAction &&
    !snapshot.message.startsWith("Check passed.");
  return (
    <section className="inspection-page">
      {endOpen && (
        <EndInspectionDialog
          saving={Boolean(snapshot.operation)}
          initialReason={snapshot.termination?.reason}
          onClose={() => setEndOpen(false)}
          onSubmit={onFinish}
        />
      )}
      {resetOpen && (
        <ResetInspectionDialog
          saving={snapshot.operation === "reset"}
          onClose={() => setResetOpen(false)}
          onConfirm={() => {
            setResetOpen(false);
            mentra.send("inspection:reset", {});
          }}
        />
      )}
      {exampleOpen && referenceUrl && (
        <ImageViewer
          src={referenceUrl}
          alt={selectedReference?.caption || "Inspection reference"}
          onClose={() => setExampleOpen(false)}
        />
      )}
      <div className="inspection-heading">
        <div className="inspection-navigation">
          <button
            type="button"
            className="back-link"
            onClick={onBack}
          >
            <ArrowLeft size={15} />
            My inspections
          </button>
          <details className="inspection-overflow">
            <summary
              className="icon-button"
              aria-label="More inspection actions"
            >
              <MoreHorizontal size={22} />
            </summary>
            <button
              type="button"
              disabled={busy}
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                setEndOpen(true);
              }}
            >
              End inspection…
            </button>
            <button
              type="button"
              disabled={
                Boolean(snapshot.operation) || ["capturing", "evaluating"].includes(snapshot.status)
              }
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                setResetOpen(true);
              }}
            >
              <RotateCcw size={15} />
              Reset inspection…
            </button>
          </details>
        </div>
        <div className="inspection-title">
          <div>
            <p className="eyebrow">{snapshot.workOrder}</p>
            <h1>{snapshot.asset.model}</h1>
            <p className="subheading">
              {snapshot.asset.id}
              <span>•</span>
              {snapshot.asset.location}
            </p>
          </div>
          <span className="status-pill">
            {snapshot.steps.filter((step) => step.state === "passed").length} of{" "}
            {snapshot.steps.length} complete
          </span>
        </div>
      </div>
      <div className="inspection-layout">
        <aside className="step-rail panel">
          <div className="rail-heading">
            <span>INSPECTION STEPS</span>
            <span>
              {snapshot.steps.filter((step) => step.state === "passed").length}/
              {snapshot.steps.length}
            </span>
          </div>
          <div className="step-list">
            {snapshot.steps.map((step) => (
              <button
                type="button"
                className={`step-row ${step.id === current?.id ? "selected" : ""}`}
                key={step.id}
                disabled={busy}
                onClick={() => onSelect(step.id)}
                aria-current={step.id === current?.id ? "step" : undefined}
              >
                <span className={`step-number ${step.state}`}>
                  {step.state === "passed" ? (
                    <Check size={14} />
                  ) : (
                    String(step.number).padStart(2, "0")
                  )}
                </span>
                <span className="step-copy">
                  <strong>{step.title}</strong>
                  <small>
                    {step.state === "passed"
                      ? "Complete"
                      : step.id === current?.id
                        ? "Current step"
                        : "Pending"}
                  </small>
                </span>
                {step.id === current?.id && <ChevronRight size={16} />}
              </button>
            ))}
          </div>
        </aside>
        <div className="inspection-main">
          <article className="focus-card panel">
            <div className="focus-heading">
              <div>
                <p className="eyebrow">
                  STEP {String(current?.number ?? 1).padStart(2, "0")} OF {snapshot.steps.length}
                </p>
                <h2>{current?.title}</h2>
              </div>
            </div>
            <div className="instruction-block">
              <span className="instruction-icon">
                <ArrowRight size={19} />
              </span>
              <div>
                <p className="eyebrow">WHAT TO DO</p>
                <p>{current?.instruction}</p>
              </div>
            </div>
            {current && (
              <>
                <div className="criteria">
                  <p className="eyebrow">ACCEPTANCE CRITERIA</p>
                  <div>
                    {current.visualCriteria?.map((criterion) => (
                      <span key={criterion}>
                        <Check size={14} />
                        {criterion}
                      </span>
                    ))}
                  </div>
                </div>
                {current.limitations?.map((limitation) => (
                  <p
                    className="reference-limitation"
                    key={limitation}
                  >
                    {limitation}
                  </p>
                ))}
                {current.references?.map((reference) => (
                  <button
                    type="button"
                    key={reference.url}
                    className="reference-thumbnail"
                    onClick={() => {
                      setSelectedReference(reference);
                      setExampleOpen(true);
                    }}
                    aria-label={`Enlarge ${reference.role} example: ${reference.caption}`}
                  >
                    <img
                      src={snapshot.serverUrl.replace(/\/$/, "") + reference.url}
                      alt={reference.caption}
                    />
                    <span>
                      <strong>{reference.role === "good" ? "Good example" : "Bad example"}</strong>
                      <small>{reference.caption}</small>
                    </span>
                  </button>
                ))}
                <div className="evidence-grid">
                  {initial && (
                    <EvidenceCard
                      evidence={initial}
                      label="Initial inspection"
                    />
                  )}
                  {verification && (
                    <EvidenceCard
                      evidence={verification}
                      label="Latest verification"
                    />
                  )}
                  {pendingPhoto && <PendingPhotoCard photo={pendingPhoto} />}{" "}
                  {!initial && !pendingPhoto && (
                    <div
                      className="empty-evidence"
                      role="status"
                    >
                      <ImagePlus size={27} />
                      <strong>{captureTitle}</strong>
                      <small>{captureDescription}</small>
                    </div>
                  )}
                  {initial && activeCheck && (
                    <div
                      className="capture-prompt"
                      role="status"
                    >
                      <Camera size={20} />
                      <span>
                        <strong>{captureTitle}</strong>
                        <small>{captureDescription}</small>
                      </span>
                    </div>
                  )}
                </div>
                {snapshot.latestFinding && <Finding finding={snapshot.latestFinding} />}
                {usefulMessage && (
                  <p
                    className={`message-line ${snapshot.status === "error" ? "error-message" : ""}`}
                    role="status"
                  >
                    {snapshot.message}
                  </p>
                )}
              </>
            )}
            <div className="focus-actions">
              {browserMode && activeCheck && (
                <label className={`button quiet large image-upload ${busy ? "disabled" : ""}`}>
                  Upload inspection photo
                  <input
                    type="file"
                    accept="image/*"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file) return;
                      const stepId = current?.id;
                      const reader = new FileReader();
                      reader.onload = () => {
                        if (typeof reader.result === "string" && snapshot.currentStepId === stepId)
                          mentra.send("inspection:upload", {
                            stepId: stepId || "",
                            kind: initial ? "verification" : "initial",
                            photo: { photoUrl: reader.result, mimeType: file.type || "image/jpeg" },
                          });
                      };
                      reader.readAsDataURL(file);
                    }}
                  />
                </label>
              )}

              {activeCheck &&
                snapshot.status === "error" &&
                [...snapshot.attempts].reverse().find((attempt) => attempt.stepId === current?.id)
                  ?.status === "pending" && (
                  <button
                    type="button"
                    className="button quiet large"
                    disabled={busy}
                    onClick={() => mentra.send("inspection:retry-check", {})}
                  >
                    Retry check
                    <ArrowRight size={16} />
                  </button>
                )}
              {activeCheck && (
                <button
                  type="button"
                  className="button quiet large"
                  disabled={busy}
                  onClick={() => mentra.send("inspection:skip-step", {})}
                >
                  Skip for now
                  <ArrowRight size={16} />
                </button>
              )}
              {passed && (
                <button
                  type="button"
                  className="button primary large"
                  disabled={busy}
                  onClick={() => onFinish()}
                >
                  <Save size={16} />
                  {snapshot.operation === "finish" ? "Saving…" : "Save inspection"}
                </button>
              )}
              {current && (
                <div className="ask-row">
                  <input
                    value={question}
                    disabled={busy}
                    onChange={(event) => setQuestion(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !busy) onAsk();
                    }}
                    placeholder="Need help with this step?"
                    aria-label={`Question about ${current?.title || "this step"}`}
                  />
                  <button
                    type="button"
                    className="ask-button"
                    disabled={busy}
                    onClick={onAsk}
                    aria-label="Get guidance"
                  >
                    <MessageCircle size={18} />
                  </button>
                </div>
              )}
            </div>
          </article>
          {current?.escalation?.url && (
            <a
              className="button quiet escalation-package"
              href={current.escalation.url}
              target="_blank"
              rel="noreferrer"
            >
              <ShieldAlert size={20} />
              <span>
                <strong>Escalation ready for review</strong>
                <small>View this step’s saved package</small>
              </span>
              <ChevronRight size={20} />
            </a>
          )}
          {activeCheck && (
            <button
              type="button"
              className="escalate-button"
              disabled={busy}
              onClick={() => mentra.send("inspection:escalate", {})}
            >
              <ShieldAlert size={20} />
              <span>
                <strong>
                  {snapshot.operation === "escalate"
                    ? "Saving escalation…"
                    : "Escalate to an expert"}
                </strong>
                <small>Save evidence for review and continue to the next step</small>
              </span>
              <ChevronRight size={20} />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function EvidenceCard({
  evidence,
  label,
}: {
  evidence: InspectionSnapshot["evidence"][number];
  label: string;
}) {
  return (
    <figure className="evidence">
      <PhotoPreview
        src={evidence.previewDataUrl || evidence.photoUrl}
        alt={`${label} evidence`}
        unavailable="Photo preview unavailable"
      />
      <figcaption>
        <strong>{label}</strong>
        <small>{evidence.archived ? "Saved" : "Saving"}</small>
      </figcaption>
    </figure>
  );
}
function PendingPhotoCard({ photo }: { photo: NonNullable<InspectionSnapshot["pendingPhoto"]> }) {
  return (
    <figure className="evidence pending-evidence">
      <PhotoPreview
        src={photo.photoUrl}
        alt="Pending inspection photo"
        unavailable="Photo preview unavailable"
      />
      <figcaption>
        <strong>Photo ready</strong>
        <small>Preparing to save</small>
      </figcaption>
    </figure>
  );
}
function Finding({ finding }: { finding: NonNullable<InspectionSnapshot["latestFinding"]> }) {
  const pass = finding.status === "pass";
  const unclear = finding.status === "evidence_unclear";
  return (
    <div className={`finding ${pass ? "pass" : unclear ? "unclear" : "adjustment"}`}>
      <span className="finding-icon">
        {pass ? (
          <Check size={17} />
        ) : unclear ? (
          <CircleHelp size={17} />
        ) : (
          <CircleAlert size={17} />
        )}
      </span>
      <div>
        <strong>
          {pass ? "Looks good" : unclear ? "Let’s get a clearer view" : "Adjustment needed"}
        </strong>
        <p>{finding.finding}</p>
        <small>{finding.recommendedAction}</small>
      </div>
    </div>
  );
}
function Report({
  snapshot,
  onNew,
  onBack,
}: {
  snapshot: InspectionSnapshot;
  onNew: () => void;
  onBack: () => void;
}) {
  const passed = snapshot.steps.filter((step) => step.state === "passed").length;
  return (
    <section className="report-page">
      <button
        type="button"
        className="back-link"
        onClick={onBack}
      >
        <ArrowLeft size={15} />
        Work queue
      </button>
      <div className="report-heading">
        <div>
          <p className="eyebrow">SAVED INSPECTION · {snapshot.workOrder}</p>
          <h1>{passed === snapshot.steps.length ? "Inspection complete" : "Inspection saved"}</h1>
          <p className="lede">{snapshot.message}</p>
        </div>
        <div className={`report-seal ${passed === snapshot.steps.length ? "pass" : "review"}`}>
          {passed === snapshot.steps.length ? <Check size={28} /> : <CircleAlert size={27} />}
          <small>{passed === snapshot.steps.length ? "PASS" : "SAVED"}</small>
        </div>
      </div>
      {snapshot.termination && (
        <section className="termination-summary">
          <strong>Ended early</strong>
          <p>{snapshot.termination.reason}</p>
        </section>
      )}
      <div className="report-grid">
        <section className="panel report-card">
          <div className="report-card-heading">
            <span>PROGRESS</span>
            <strong>
              {passed}
              <small> / {snapshot.steps.length}</small>
            </strong>
          </div>
          {snapshot.steps.map((step) => (
            <div
              className="report-step"
              key={step.id}
            >
              <span className={step.state}>
                {step.state === "passed" ? <Check size={13} /> : "—"}
              </span>
              <strong>{step.title}</strong>
              <small>{step.state === "passed" ? "Complete" : "Pending"}</small>
              {step.escalation?.url && (
                <a
                  href={step.escalation.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Escalation package
                </a>
              )}
            </div>
          ))}
        </section>
        <section className="panel report-card">
          <div className="report-card-heading">
            <span>EVIDENCE</span>
            <strong>
              {snapshot.evidence.length}
              <small> photos</small>
            </strong>
          </div>
          {snapshot.latestFinding && <Finding finding={snapshot.latestFinding} />}
          <div className="report-evidence">
            {snapshot.evidence.map((item) => (
              <EvidenceCard
                key={item.id}
                evidence={item}
                label={`${snapshot.steps.find((step) => step.id === item.stepId)?.title || item.stepId} · ${item.kind === "verification" ? "Verification" : "Initial"}`}
              />
            ))}
          </div>
          {snapshot.escalation && (
            <div className="escalated">
              <ShieldAlert size={15} />
              {snapshot.escalation.url ? (
                <a
                  href={snapshot.escalation.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Escalation ready for review
                </a>
              ) : (
                "Escalation ready for review"
              )}
            </div>
          )}
        </section>
      </div>
      <div className="report-actions">
        <button
          type="button"
          className="button primary large"
          onClick={onNew}
        >
          Start new inspection
          <ArrowRight size={15} />
        </button>
        {snapshot.report?.url && (
          <a
            className="button quiet large"
            href={snapshot.report.url}
            target="_blank"
            rel="noreferrer"
          >
            Open saved report
          </a>
        )}
      </div>
    </section>
  );
}
