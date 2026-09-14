import { createSnapshot } from "./workflow";
import type {
  InspectionSnapshot,
  Attempt,
  Evidence,
  EvaluationResponse,
  ServerHealth,
} from "./types";
export interface Photo {
  photoUrl: string;
  mimeType: string;
}
export interface Ports {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
  snapshot(value: InspectionSnapshot): void;
  toast(kind: "info" | "success" | "warning" | "error", text: string): void;
  requestEndReason?(): void;
  openInspection?(): void;
  capture(): Promise<Photo>;
  speak(text: string): Promise<void>;
  stopSpeech?(): void;
  startRecording?(): Promise<{ recordingId: string }>;
  stopRecording?(id: string, uploadUrl: string): Promise<void>;
}

let requestSequence = 0;

function safePath(path: string): string {
  return path.split(/[?#]/, 1)[0] || "/";
}

function safeTarget(url: string): string {
  const match = url.match(/^(https?):\/\/(?:[^/@]*@)?([^/?#]+)([^?#]*)/i);
  return match ? `${match[1]}://${match[2]}${match[3].replace(/\/$/, "")}` : "[invalid-server-url]";
}

function safeMessage(error: unknown): string {
  const raw = messageOf(error);
  return raw
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/data:[^\s,]+,[^\s]*/gi, "[media]")
    .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /(?:token|authorization|api[-_ ]?key|prompt|question|text)\s*[:=]\s*\S+/gi,
      "[redacted]",
    )
    .slice(0, 240);
}

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  return /^[a-z0-9_.:-]{1,64}$/i.test(code) ? code : undefined;
}

function diagnostic(event: string, fields: Record<string, unknown> = {}) {
  console.info("[inspection]", { event, ...fields });
}

function diagnosticFailure(error: unknown): { error: string; cause?: string } {
  const cause =
    error instanceof Error && error.cause !== undefined ? safeMessage(error.cause) : undefined;
  return { error: safeMessage(error), ...(cause ? { cause } : {}) };
}

export class InspectionController {
  state = createSnapshot();
  busy = false;
  speaking = false;
  private speechId = 0;
  private recordingId?: string;
  private stoppingRecording?: Promise<void>;
  private trackedVideos = new Set<string>();
  private lastCommand = "";
  private lastCommandAt = 0;
  private photoPreviews = new Map<string, string>();
  constructor(private ports: Ports) {}
  async init(serverUrl?: string, overrideSavedServer = false) {
    try {
      const saved = await this.ports.load();
      if (saved) {
        const restored = JSON.parse(saved) as InspectionSnapshot;
        if (restored.version === 1)
          this.state = {
            ...restored,
            operation: undefined,
            pendingPhoto: undefined,
          };
        if (["capturing", "evaluating"].includes(this.state.status)) this.state.status = "error";
        if (["recording", "uploading"].includes(this.state.recording.status))
          this.state.recording.status = "interrupted";
      }
      if (serverUrl && (!saved || overrideSavedServer)) this.state.serverUrl = serverUrl;
    } catch {
      this.ports.toast("warning", "Your previous inspection could not be restored.");
    }
    await this.refreshWorkflows();
    await this.publish();
    for (const clip of [...(this.state.recording.clips || []), this.state.recording])
      if (clip.sessionId && clip.stopConfirmedAt && clip.status !== "uploaded")
        void this.trackVideo(clip.sessionId);
  }
  private identity() {
    return { procedureId: this.state.procedureId, procedureVersion: this.state.procedureVersion };
  }
  private get currentStep() {
    return this.state.steps.find((step) => step.id === this.state.currentStepId);
  }
  private get currentAttempt() {
    return [...this.state.attempts]
      .reverse()
      .find((attempt) => attempt.stepId === this.state.currentStepId);
  }
  async refreshWorkflows(allowBusy = false) {
    if (this.busy && !allowBusy) return;
    try {
      const response = await this.request<{ workflows: import("./types").WorkflowDefinition[] }>(
        "/api/workflows",
      );
      this.state.workflows = response.workflows;
      const selected = response.workflows.find(
        (workflow) => workflow.id === this.state.procedureId,
      );
      const refreshed = !this.state.steps.length
        ? response.workflows[0]
        : this.state.status === "ready" && selected?.version !== this.state.procedureVersion
          ? selected
          : undefined;
      if (refreshed) {
        this.state = {
          ...createSnapshot(this.state.serverUrl, refreshed),
          workflows: response.workflows,
        };
      }
    } catch (error) {
      this.ports.toast("error", `Workflows could not be loaded: ${messageOf(error)}`);
    }
    await this.publish();
  }
  async selectWorkflow(id: string) {
    if (this.busy || !["ready", "report"].includes(this.state.status)) return;
    const workflow = this.state.workflows?.find((w) => w.id === id);
    if (!workflow) return;
    this.state = {
      ...createSnapshot(this.state.serverUrl, workflow),
      workflows: this.state.workflows,
    };
    await this.publish();
  }
  private async activateStep(id: string, announcement = "") {
    const target = this.state.steps.find((step) => step.id === id);
    if (!target) return;
    this.state.currentStepId = id;
    this.state.steps = this.state.steps.map((step) => ({
      ...step,
      state: step.state === "passed" ? "passed" : step.id === id ? "current" : "pending",
    }));
    const latest = this.currentAttempt;
    this.state.latestFinding = latest?.finding;
    this.state.guidance = undefined;
    this.state.escalation = target.escalation;
    this.state.status =
      target.state === "passed"
        ? "passed"
        : latest?.status === "pending" || latest?.status === "capturing"
          ? "error"
          : latest?.status === "adjustment_required" || latest?.status === "evidence_unclear"
            ? latest.status
            : "recording";
    this.state.message =
      this.state.status === "error"
        ? "This step has an unfinished photo check. Retry or capture a new photo."
        : target.instruction;
    await this.publish();
    if (!this.state.pausedAt)
      void this.say(`${announcement ? `${announcement} ` : ""}${target.instruction}`);
  }
  async selectStep(id: string) {
    if (this.busy || ["ready", "report"].includes(this.state.status) || !this.state.procedureId)
      return;
    this.busy = true;
    this.stopSpeech();
    this.state.operation = "navigate";
    try {
      await this.activateStep(id);
    } finally {
      this.busy = false;
      this.state.operation = undefined;
      await this.publish();
    }
  }
  private async advance(announcement = "") {
    const index = this.state.steps.findIndex((step) => step.id === this.state.currentStepId);
    const ordered = [...this.state.steps.slice(index + 1), ...this.state.steps.slice(0, index + 1)];
    const next = ordered.find((step) => step.state !== "passed");
    if (next) await this.activateStep(next.id, announcement);
    else {
      this.state.status = "passed";
      this.state.message =
        "All inspection steps passed. Save inspection to create the final report.";
      await this.publish();
      void this.say(`${announcement ? `${announcement} ` : ""}${this.state.message}`);
    }
  }
  async skipStep() {
    if (this.busy || ["ready", "report"].includes(this.state.status) || !this.state.procedureId)
      return;
    this.busy = true;
    this.stopSpeech();
    this.state.operation = "navigate";
    try {
      await this.advance();
    } finally {
      this.busy = false;
      this.state.operation = undefined;
      await this.publish();
    }
  }
  async publish() {
    this.state.evidence = this.state.evidence.map((item) => this.normalizeEvidence(item));
    this.ports.snapshot({
      ...this.state,
      evidence: this.state.evidence.map((item) => ({
        ...item,
        previewDataUrl: this.photoPreviews.get(item.id),
      })),
    });
    try {
      await this.ports.save(JSON.stringify({ ...this.state, pendingPhoto: undefined }));
    } catch {
      this.ports.toast("warning", "Your latest changes could not be saved on this device.");
    }
  }
  private normalizeEvidence(evidence: Evidence): Evidence {
    const { previewDataUrl, ...record } = evidence;
    if (previewDataUrl?.startsWith("data:image/"))
      this.photoPreviews.set(record.id, previewDataUrl);
    const photoPath =
      record.photoPath ||
      record.photoUrl.match(/^(?:https?:\/\/[^/?#]+)?(\/data\/evidence\/[^?#]+)$/i)?.[1];
    return photoPath?.startsWith("/data/evidence/")
      ? { ...record, photoPath, photoUrl: this.state.serverUrl + photoPath }
      : record;
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const method = body === undefined ? "GET" : "POST";
    const requestId = `inspection-${Date.now().toString(36)}-${(++requestSequence).toString(36)}`;
    const startedAt = Date.now();
    const diagnosticFields = {
      requestId,
      method,
      path: safePath(path),
      target: safeTarget(this.state.serverUrl),
    };
    diagnostic("request:start", diagnosticFields);
    let responseStatus: number | undefined;
    let failureLogged = false;
    try {
      const response = await fetch(this.state.serverUrl + path, {
        method,
        headers: { "Content-Type": "application/json", "X-Inspection-Request-Id": requestId },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      responseStatus = response.status;
      const value = await response.json();
      if (!response.ok) {
        const serverMessage =
          value &&
          typeof value === "object" &&
          "message" in value &&
          typeof value.message === "string"
            ? value.message
            : `Server ${response.status}`;
        const error = new Error(serverMessage);
        const codeValue =
          value && typeof value === "object" && "errorCode" in value
            ? value.errorCode
            : value && typeof value === "object" && "code" in value
              ? value.code
              : value && typeof value === "object" && "error" in value
                ? value.error
                : undefined;
        const errorCode = safeErrorCode(codeValue);
        const serverCause =
          value && typeof value === "object" && "cause" in value && typeof value.cause === "string"
            ? safeMessage(value.cause)
            : undefined;
        diagnostic("request:failure", {
          ...diagnosticFields,
          status: responseStatus,
          ...diagnosticFailure(error),
          ...(serverCause ? { cause: serverCause } : {}),
          ...(errorCode ? { errorCode } : {}),
          elapsed: Date.now() - startedAt,
        });
        failureLogged = true;
        throw error;
      }
      diagnostic("request:response", {
        ...diagnosticFields,
        status: responseStatus,
        elapsed: Date.now() - startedAt,
      });
      return value as T;
    } catch (error) {
      if (!failureLogged)
        diagnostic("request:failure", {
          ...diagnosticFields,
          status: responseStatus ?? null,
          ...diagnosticFailure(error),
          elapsed: Date.now() - startedAt,
        });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async health(): Promise<ServerHealth> {
    try {
      return await this.request("/api/health");
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }
  async begin(workflowId?: string) {
    if (this.busy) return;
    if (workflowId && ["ready", "report"].includes(this.state.status)) {
      const workflow = this.state.workflows?.find((item) => item.id === workflowId);
      if (!workflow) {
        this.ports.toast("warning", "Refresh workflows before starting this inspection.");
        return;
      }
      this.state = {
        ...createSnapshot(this.state.serverUrl, workflow),
        workflows: this.state.workflows,
      };
    }
    if (!this.state.workflow || !this.state.steps.length) {
      this.ports.toast("warning", "Select a discovered workflow before starting.");
      return;
    }
    this.ports.openInspection?.();
    if (!["ready", "report"].includes(this.state.status)) {
      diagnostic("inspection:start", { action: "resumed", status: this.state.status });
      if (this.state.pausedAt) {
        this.busy = true;
        try {
          await this.stopVideo();
          if (this.recordingId) {
            this.ports.toast(
              "warning",
              "The previous recording could not be stopped. Please try resuming again.",
            );
            return;
          }
          this.state.pausedAt = undefined;
          await this.startVideo();
          await this.publish();
        } finally {
          this.busy = false;
        }
      }
      this.ports.toast("info", "Inspection resumed. Continue with the current step.");
      return;
    }
    diagnostic("inspection:start", { action: "started" });
    this.busy = true;
    try {
      this.photoPreviews.clear();
      this.state = {
        ...createSnapshot(this.state.serverUrl, this.state.workflow),
        workflows: this.state.workflows,
        status: "recording",
        operation: "start",
        startedAt: Date.now(),
        recording: { status: "idle", sessionId: `inspection-${Date.now()}` },
      };
      await this.publish();
      await this.startVideo();
      const step = this.state.steps.find((step) => step.id === this.state.currentStepId);
      if (!step) throw new Error("Inspection step was not found");
      this.state.message = step.instruction;
      await this.publish();
      void this.say(this.state.message);
    } catch (error) {
      this.ports.toast("error", messageOf(error));
    } finally {
      this.busy = false;
      this.state.operation = undefined;
      await this.publish();
    }
  }
  async capture(kind: "initial" | "verification", supplied?: Photo, expectedStepId?: string) {
    if (expectedStepId && expectedStepId !== this.state.currentStepId) {
      this.ports.toast(
        "warning",
        "The selected step changed. Upload the photo again for the intended step.",
      );
      return;
    }
    if (
      !this.state.procedureId ||
      !this.currentStep ||
      this.currentStep.state === "passed" ||
      this.busy ||
      this.state.pausedAt ||
      ["ready", "report"].includes(this.state.status)
    )
      return;
    this.busy = true;
    this.state.operation = "capture";
    let attempt: Attempt | undefined;
    let resumeRecording = false;
    const previousStatus = this.state.status;
    try {
      attempt = {
        stepId: this.currentStep.id,
        id: `${kind}-${Date.now()}`,
        kind,
        status: "capturing",
        createdAt: Date.now(),
      };
      this.state.attempts.push(attempt);
      this.state.steps = this.state.steps.map((step) =>
        step.id === this.state.currentStepId ? { ...step, state: "current" } : step,
      );
      this.state.latestFinding = undefined;
      this.state.pendingPhoto = undefined;
      this.state.status = "capturing";
      this.state.message = "Preparing your inspection photo…";
      await this.publish();
      diagnostic("capture:start", { kind, attemptId: attempt.id });
      if (!supplied && this.recordingId) {
        resumeRecording = true;
        await this.stopVideo();
        if (this.recordingId)
          throw new Error("Video recording could not be stopped before taking the photo.");
        if (this.state.pausedAt) {
          this.state.attempts = this.state.attempts.filter((item) => item.id !== attempt?.id);
          this.state.status = previousStatus;
          return;
        }
      }
      const photo = supplied || (await this.ports.capture());
      diagnostic("capture:photo-ready", { kind, mimeType: photo.mimeType });
      this.state.pendingPhoto = { ...photo, attemptId: attempt.id };
      attempt.sourcePhoto = photo;
      attempt.status = "pending";
      await this.publish();
      if (resumeRecording) {
        resumeRecording = false;
        await this.startVideo();
        await this.publish();
      }
      const evidence = this.normalizeEvidence(
        await this.request<Evidence>("/api/evidence", {
          ...photo,
          ...this.identity(),
          attemptId: attempt.id,
          stepId: this.state.currentStepId,
          kind,
        }),
      );
      if (!evidence.archived || !evidence.id)
        throw new Error("Server did not confirm image archival.");
      diagnostic("evidence:archived", { kind, attemptId: attempt.id, evidenceId: evidence.id });
      this.state.evidence.push(evidence);
      this.state.pendingPhoto = undefined;
      attempt.sourcePhoto = undefined;
      attempt.evidenceId = evidence.id;
      attempt.status = "pending";
      await this.publish();
      await this.evaluate(attempt, evidence);
    } catch (error) {
      diagnostic("capture:failure", {
        attemptId: attempt?.id,
        evidenceId: attempt?.evidenceId,
        ...diagnosticFailure(error),
      });
      this.state.status = "error";
      this.state.message = attempt?.evidenceId
        ? "Your photo is saved, but the check could not be completed. Retry when the inspection service is available."
        : photoError(error);
      await this.publish();
      this.ports.toast("error", this.state.message);
    } finally {
      // Capture failures must also resume footage, unless the inspection was
      // paused or the previous recording still owns the camera after a failed stop.
      if (resumeRecording && !this.recordingId) await this.startVideo();
      this.busy = false;
      this.state.operation = undefined;
      await this.publish();
    }
  }
  async retryCheck() {
    if (this.busy || this.state.status !== "error") return;
    const attempt = this.currentAttempt;
    if (attempt?.status !== "pending") return;
    this.busy = true;
    this.state.operation = "capture";
    diagnostic("evaluation:retry", { attemptId: attempt.id, evidenceId: attempt.evidenceId });
    try {
      let evidence = this.state.evidence.find((item) => item.id === attempt.evidenceId);
      if (!evidence && attempt.sourcePhoto) {
        evidence = this.normalizeEvidence(
          await this.request<Evidence>("/api/evidence", {
            ...attempt.sourcePhoto,
            ...this.identity(),
            attemptId: attempt.id,
            stepId: this.state.currentStepId,
            kind: attempt.kind,
          }),
        );
        if (!evidence.archived || !evidence.id)
          throw new Error("Server did not confirm image archival.");
        this.state.evidence.push(evidence);
        this.state.pendingPhoto = undefined;
        attempt.evidenceId = evidence.id;
        attempt.sourcePhoto = undefined;
        await this.publish();
      }
      if (!evidence)
        throw new Error("The saved photo could not be found. Take a new photo with your glasses.");
      await this.evaluate(attempt, evidence);
    } catch (error) {
      diagnostic("evaluation:retry-failure", {
        attemptId: attempt.id,
        ...diagnosticFailure(error),
      });
      this.state.status = "error";
      this.state.message = attempt.evidenceId
        ? "Your photo is saved, but the check could not be completed. Retry the check or take a new photo with your glasses."
        : photoError(error);
      await this.publish();
      this.ports.toast("error", this.state.message);
    } finally {
      this.busy = false;
      this.state.operation = undefined;
      await this.publish();
    }
  }
  private async evaluate(attempt: Attempt, evidence: Evidence) {
    this.state.status = "evaluating";
    this.state.message = `Checking ${this.currentStep?.title || "this step"}…`;
    await this.publish();
    const result = await this.request<EvaluationResponse>("/api/evaluate", {
      evidenceId: evidence.id,
      stepId: evidence.stepId,
      ...this.identity(),
    });
    if (
      result.stepId !== evidence.stepId ||
      result.evidenceId !== evidence.id ||
      !["pass", "adjustment_required", "evidence_unclear"].includes(result.status)
    )
      throw new Error("AI returned an invalid evaluation.");
    diagnostic("evaluation:result", {
      status: result.status,
      attemptId: attempt.id,
      evidenceId: evidence.id,
    });
    attempt.status = result.status;
    attempt.finding = result;
    this.state.latestFinding = result;
    this.state.status = result.status === "pass" ? "passed" : result.status;
    this.state.steps = this.state.steps.map((step) =>
      step.id === this.state.currentStepId
        ? { ...step, state: result.status === "pass" ? "passed" : "current" }
        : step,
    );
    this.state.message =
      result.status === "pass"
        ? `${this.currentStep?.successMessage || "Check passed."} ${result.finding}`
        : result.recommendedAction;
    await this.publish();
    if (result.status === "pass") await this.advance(this.state.message);
    else void this.say(this.state.message);
  }
  async ask(question = "What should I do?") {
    if (this.busy || ["ready", "report"].includes(this.state.status)) return;
    this.busy = true;
    this.state.operation = "ask";
    await this.publish();
    try {
      this.state.message = "Finding guidance for this step…";
      await this.publish();
      const response = await this.request<{ answer: string; procedureReference: string }>(
        "/api/ask",
        {
          question,
          stepId: this.state.currentStepId,
          evidenceId: [...this.state.evidence]
            .reverse()
            .find((e) => e.stepId === this.state.currentStepId)?.id,
          ...this.identity(),
          latestFinding: this.state.latestFinding,
          asset: this.state.asset,
        },
      );
      this.state.message = response.answer;
      this.state.guidance = {
        question,
        answer: response.answer,
        procedureReference: response.procedureReference,
      };
      await this.publish();
      void this.say(response.answer);
    } catch {
      this.state.message = "Guidance is unavailable right now. Try again in a moment.";
      await this.publish();
      this.ports.toast("error", this.state.message);
    } finally {
      this.busy = false;
      this.state.operation = undefined;
      await this.publish();
    }
  }
  async escalate() {
    if (this.busy || ["ready", "report"].includes(this.state.status)) return;
    this.busy = true;
    this.stopSpeech();
    this.state.operation = "escalate";
    await this.publish();
    try {
      const response = await this.request<{ id: string; url: string }>(
        "/api/escalations",
        this.state,
      );
      this.state.escalation = {
        id: response.id,
        url: response.url,
        createdAt: Date.now(),
        status: "ready for expert review",
      };
      if (this.currentStep) this.currentStep.escalation = this.state.escalation;
      await this.publish();
      await this.advance("Escalation saved and ready for expert review.");
      this.ports.toast("success", "Escalation saved. Ready for expert review.");
    } catch {
      this.ports.toast("error", "Escalation could not be saved. Please try again.");
    } finally {
      this.busy = false;
      this.state.operation = undefined;
      await this.publish();
    }
  }
  async finish(reason?: string) {
    if (this.busy || ["ready", "report"].includes(this.state.status)) return;
    const description = reason?.trim() || this.state.termination?.reason;
    const checkPassed =
      this.state.steps.length > 0 && this.state.steps.every((step) => step.state === "passed");
    if ((!checkPassed || reason !== undefined) && !description) {
      this.ports.requestEndReason?.();
      this.ports.toast("warning", "Describe why the inspection needs to end before continuing.");
      return;
    }
    if (description && description.length > 2000) {
      this.ports.toast("warning", "Keep the description under 2,000 characters.");
      return;
    }
    this.busy = true;
    this.state.operation = "finish";
    await this.publish();
    try {
      await this.stopVideo();
      this.state.finishedAt = Date.now();
      this.state.currentStepId = null;
      if (description)
        this.state.termination = { reason: description, endedAt: this.state.finishedAt };
      this.state.message = description
        ? "Inspection ended early. Your reason and evidence have been saved for follow-up."
        : checkPassed
          ? "Inspection complete. All steps passed."
          : "Inspection ended with an unresolved check.";
      const reportId = this.state.report?.id || `report-${this.state.startedAt}`;
      const response = await this.request<{ id: string; url: string }>("/api/reports", {
        ...this.state,
        id: reportId,
        status: "report",
      });
      this.state.report = { id: response.id, url: response.url };
      this.state.status = "report";
      await this.publish();
    } catch {
      this.ports.toast("error", "Your inspection could not be saved. Please try again.");
    } finally {
      this.busy = false;
      this.state.operation = undefined;
      await this.publish();
    }
  }
  async pause() {
    if (["ready", "report"].includes(this.state.status)) return;
    this.state.pausedAt = Date.now();
    diagnostic("inspection:pause", {
      status: this.state.status,
      recordingStatus: this.state.recording.status,
    });
    // Dispatch the native stop before awaiting storage; host teardown offers
    // only a short grace period, while the phone/glasses own the upload.
    const stopping = this.stopVideo();
    await this.publish();
    await stopping;
  }
  async reset() {
    if (this.busy) return;
    this.busy = true;
    this.state.operation = "reset";
    this.state.pausedAt = Date.now();
    await this.publish();
    try {
      await this.stopVideo();
      if (this.recordingId) {
        this.ports.toast(
          "warning",
          "The recording could not be stopped, so the inspection was not reset.",
        );
        return;
      }
      this.photoPreviews.clear();
      this.trackedVideos.clear();
      this.state = {
        ...createSnapshot(this.state.serverUrl, this.state.workflow),
        workflows: this.state.workflows,
      };
      await this.refreshWorkflows(true);
      await this.publish();
      this.ports.toast("success", "Inspection reset. You can start again.");
    } catch {
      this.ports.toast("error", "The inspection could not be reset. Please try again.");
    } finally {
      this.busy = false;
      this.state.operation = undefined;
      await this.publish();
    }
  }
  private async startVideo() {
    if (!this.ports.startRecording || this.state.pausedAt) return;
    const { clips, ...previous } = this.state.recording;
    const history = [
      ...(clips || []),
      ...(previous.sessionId && previous.recordingId ? [previous] : []),
    ];
    this.state.recording = {
      status: "idle",
      inspectionId: `inspection-${this.state.startedAt}`,
      clipIndex: history.length + 1,
      startRequestedAt: Date.now(),
      sessionId: `inspection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      clips: history,
    };
    try {
      const recording = await this.ports.startRecording();
      this.recordingId = recording.recordingId;
      this.state.recording = {
        ...this.state.recording,
        ...recording,
        status: "recording",
        startedAt: Date.now(),
      };
      diagnostic("video:started", {
        recordingId: recording.recordingId,
        sessionId: this.state.recording.sessionId,
      });
      if (this.state.pausedAt) await this.stopVideo();
    } catch (error) {
      this.state.recording.status = "error";
      diagnostic("video:start-failure", diagnosticFailure(error));
      this.ports.toast("warning", "Video recording could not start. You can continue with photos.");
    }
  }
  private stopVideo(): Promise<void> {
    if (this.stoppingRecording) return this.stoppingRecording;
    const id = this.recordingId;
    const sessionId = this.state.recording.sessionId;
    if (!id || !sessionId || !this.ports.stopRecording) return Promise.resolve();
    diagnostic("video:stop-requested", { recordingId: id, sessionId });
    this.state.recording.status = "uploading";
    this.state.recording.stopRequestedAt = Date.now();
    const uploadTiming = {
      inspectionId: this.state.recording.inspectionId,
      clipIndex: this.state.recording.clipIndex,
      startRequestedAt: this.state.recording.startRequestedAt,
      startedAt: this.state.recording.startedAt,
      stopRequestedAt: this.state.recording.stopRequestedAt,
      recordingId: id,
    };
    const timingQuery = Object.entries(uploadTiming)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join("&");
    this.stoppingRecording = this.ports
      .stopRecording(
        id,
        `${this.state.serverUrl}/api/video/upload?sessionId=${encodeURIComponent(sessionId)}&${timingQuery}`,
      )
      .then(async () => {
        this.recordingId = undefined;
        this.state.recording.stopConfirmedAt = Date.now();
        diagnostic("video:stop-confirmed", { recordingId: id, sessionId });
        await this.publish();
        void this.trackVideo(sessionId);
      })
      .catch(async (error) => {
        this.state.recording.status = "error";
        diagnostic("video:stop-failure", { sessionId, ...diagnosticFailure(error) });
        this.ports.toast(
          "warning",
          "Video could not be finalized. Your photos will still be included.",
        );
        await this.publish();
      })
      .finally(() => {
        this.stoppingRecording = undefined;
      });
    return this.stoppingRecording;
  }
  private async trackVideo(sessionId: string) {
    if (this.trackedVideos.has(sessionId)) return;
    this.trackedVideos.add(sessionId);
    try {
      for (let index = 0; index < 45; index++) {
        if (
          this.state.recording.sessionId !== sessionId &&
          !this.state.recording.clips?.some((clip) => clip.sessionId === sessionId)
        )
          return;
        try {
          const result = await this.request<{
            status: string;
            latest?: {
              url: string;
              durationSeconds?: number | null;
              durationStatus?: "available" | "unavailable";
              uploadedAt?: string;
            };
          }>(`/api/video/status?sessionId=${encodeURIComponent(sessionId)}`);
          if (result.status === "uploaded") {
            const clip =
              this.state.recording.sessionId === sessionId
                ? this.state.recording
                : this.state.recording.clips?.find((item) => item.sessionId === sessionId);
            if (clip?.stopConfirmedAt)
              await this.request("/api/video/timing", {
                sessionId,
                stopConfirmedAt: clip.stopConfirmedAt,
              });
            const media = {
              durationSeconds: result.latest?.durationSeconds,
              durationStatus: result.latest?.durationStatus,
              uploadedAt: result.latest?.uploadedAt,
            };
            if (this.state.recording.sessionId === sessionId)
              this.state.recording = {
                ...this.state.recording,
                ...media,
                status: "uploaded",
                uploadUrl: result.latest?.url,
              };
            else
              this.state.recording.clips = this.state.recording.clips?.map((clip) =>
                clip.sessionId === sessionId
                  ? { ...clip, ...media, status: "uploaded", uploadUrl: result.latest?.url }
                  : clip,
              );
            diagnostic("video:uploaded", { sessionId });
            await this.publish();
            if (this.state.report)
              await this.request("/api/reports", { ...this.state, id: this.state.report.id });
            return;
          }
        } catch {
          /* retained clip remains on glasses; poll while upload finishes */
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      diagnostic("video:upload-unconfirmed", { sessionId });
    } finally {
      this.trackedVideos.delete(sessionId);
    }
  }
  async setServer(url: string) {
    if (this.busy) return;
    try {
      if (!/^https?:\/\/[^\s]+$/.test(url.trim()))
        throw new Error("Use an HTTP or HTTPS server URL.");
      this.state.serverUrl = url.trim().replace(/\/$/, "");
      await this.publish();
      await this.refreshWorkflows();
    } catch (error) {
      this.ports.toast("error", messageOf(error));
    }
  }
  private stopSpeech() {
    this.speechId++;
    this.speaking = false;
    this.ports.stopSpeech?.();
  }
  async say(text: string) {
    if (this.state.pausedAt) return;
    const speechId = ++this.speechId;
    this.speaking = true;
    try {
      await this.ports.speak(text);
    } catch {
      if (speechId === this.speechId)
        this.ports.toast(
          "warning",
          "Spoken guidance is unavailable. Follow the instructions on screen.",
        );
    } finally {
      if (speechId === this.speechId) this.speaking = false;
    }
  }
  async transcript(text: string) {
    const command = text
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[.!?,;:]+$/, "")
      .replace(/^(?:please\s+|hey[, ]+)?/, "");
    const knownCommand = [
      "skip",
      "skip step",
      "next step",
      "go back",
      "previous step",
      "start inspection",
      "verify",
      "capture",
      "take a photo",
      "capture evidence",
      "escalate",
      "finish inspection",
    ].includes(command);
    const now = Date.now();
    const interruptCommand = ["skip", "skip step", "next step", "escalate"].includes(command);
    if (
      (this.speaking && !interruptCommand) ||
      (text === this.lastCommand && now - this.lastCommandAt < 2000)
    ) {
      if (knownCommand)
        diagnostic("voice:command", {
          command,
          action: "ignored",
          reason: this.speaking ? "speaking" : "duplicate",
        });
      return;
    }
    if (knownCommand)
      diagnostic("voice:command", {
        command,
        action: this.busy ? "ignored" : "accepted",
        ...(this.busy ? { reason: "busy" } : {}),
      });
    this.lastCommand = text;
    this.lastCommandAt = now;
    this.state.transcript = text;
    await this.publish();
    if (command === "start inspection") await this.begin();
    else if (command === "verify") await this.capture("verification");
    else if (["capture", "take a photo", "capture evidence"].includes(command))
      await this.capture(
        this.state.evidence.some((e) => e.stepId === this.state.currentStepId)
          ? "verification"
          : "initial",
      );
    else if (["skip", "skip step", "next step"].includes(command)) await this.skipStep();
    else if (["go back", "previous step"].includes(command)) {
      const index = this.state.steps.findIndex((s) => s.id === this.state.currentStepId);
      const previous = this.state.steps[index - 1];
      if (previous) await this.selectStep(previous.id);
    } else if (command === "escalate") await this.escalate();
    else if (command === "finish inspection") await this.finish();
    else if (command.startsWith("what ") || command.startsWith("how ")) await this.ask(text);
  }
}
function messageOf(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message;
  return typeof error === "string" ? error : "Unknown error";
}

function photoError(error: unknown): string {
  const detail = messageOf(error);
  if (/recording could not be stopped/i.test(detail))
    return "Video recording could not be stopped. Try taking the photo again.";
  if (/camera permission|camera access|permission denied/i.test(detail))
    return "Connect your glasses and allow camera access, then try again.";
  if (/Photo capture requires|glasses are not connected/i.test(detail))
    return "Connect your glasses in MentraOS to capture inspection photos.";
  return "Your photo could not be saved. Check that your glasses are connected, then try taking another photo.";
}
