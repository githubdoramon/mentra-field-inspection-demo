import { expect, test } from "bun:test";
import { InspectionController } from "../src/shared/controller";
import { definition, testSnapshot } from "./fixtures";

function inspection() {
  const spoken: string[] = [];
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let nextResult = "pass";
  let failEvaluation = false;
  let sequence = 0;
  const controller = new InspectionController({
    load: async () => null,
    save: async () => {},
    snapshot: () => {},
    toast: () => {},
    speak: async (text) => {
      spoken.push(text);
    },
    capture: async () => ({ photoUrl: "data:image/jpeg;base64,demo", mimeType: "image/jpeg" }),
  });
  controller.state = testSnapshot();
  controller.state.status = "recording";
  controller.request = async <T>(path: string, value?: unknown): Promise<T> => {
    const body = (value || {}) as Record<string, unknown>;
    requests.push({ path, body });
    if (path === "/api/evidence")
      return { ...body, id: `photo-${++sequence}`, archived: true } as T;
    if (path === "/api/evaluate") {
      if (failEvaluation) throw new Error("AI unavailable");
      return {
        ...body,
        status: nextResult,
        finding: `Finding for ${body.stepId}`,
        recommendedAction: `Action for ${body.stepId}`,
        procedureReference: "demo",
      } as T;
    }
    if (path === "/api/ask")
      return { answer: `Guidance for ${body.stepId}`, procedureReference: "demo" } as T;
    if (path === "/api/escalations")
      return { id: `escalation-${++sequence}`, url: "http://example.test/escalation" } as T;
    if (path === "/api/reports") return { id: "report", url: "http://example.test/report" } as T;
    if (path === "/api/workflows") return { workflows: [{ ...definition, version: 99 }] } as T;
    throw new Error(path);
  };
  return {
    controller,
    requests,
    spoken,
    result: (value: string) => {
      nextResult = value;
    },
    outage: (value: boolean) => {
      failEvaluation = value;
    },
  };
}

test("out-of-order passes wrap to deferred steps and complete only after all pass", async () => {
  const { controller, requests, spoken } = inspection();
  await controller.skipStep();
  expect(controller.state.currentStepId).toBe("lubrication");
  await controller.selectStep("build-plate");
  await controller.capture("initial");
  expect(controller.state.currentStepId).toBe("purge-limiter");
  expect(controller.state.steps[2].state).toBe("passed");
  await controller.capture("initial");
  expect(controller.state.currentStepId).toBe("lubrication");
  await controller.capture("initial");
  expect(controller.state.steps.every((step) => step.state === "passed")).toBe(true);
  expect(controller.state.status).toBe("passed");
  expect(requests.filter((r) => r.path === "/api/evaluate").map((r) => r.body.stepId)).toEqual([
    "build-plate",
    "purge-limiter",
    "lubrication",
  ]);
  expect(spoken.some((text) => text.startsWith("Build plate condition check passed."))).toBe(true);
  await controller.finish();
  expect(controller.state.status).toBe("report");
  expect(controller.state.termination).toBeUndefined();
});

test("escalation advances but stays unresolved, and its package remains attached to the original step", async () => {
  const { controller } = inspection();
  await controller.escalate();
  expect(controller.state.currentStepId).toBe("lubrication");
  expect(controller.state.steps[0].state).toBe("pending");
  expect(controller.state.steps[0].escalation?.id).toBeDefined();
  expect(controller.state.escalation).toBeUndefined();
  await controller.selectStep("purge-limiter");
  expect(controller.state.escalation?.id).toBe(controller.state.steps[0].escalation?.id);
  await controller.finish();
  expect(controller.state.status).not.toBe("report");
});

test("revisiting a step restores its finding and retries its own archived evidence", async () => {
  const { controller, requests, outage, result } = inspection();
  outage(true);
  await controller.capture("initial");
  const pending = controller.state.attempts[0];
  await controller.skipStep();
  result("adjustment_required");
  outage(false);
  await controller.capture("initial");
  const lubricationFinding = controller.state.latestFinding;
  await controller.selectStep("purge-limiter");
  expect(controller.state.status).toBe("error");
  expect(controller.state.latestFinding).toBeUndefined();
  await controller.retryCheck();
  expect(requests.at(-1)?.body.evidenceId).toBe(pending.evidenceId);
  await controller.selectStep("lubrication");
  expect(controller.state.latestFinding).toEqual(lubricationFinding);
  await controller.ask();
  const ask = requests.at(-1)?.body;
  expect(ask?.stepId).toBe("lubrication");
  expect(ask?.evidenceId).toBe(controller.state.evidence[1].id);
});

test("workflow refresh does not change the pinned active version; switching active workflows is ignored", async () => {
  const { controller } = inspection();
  await controller.refreshWorkflows();
  expect(controller.state.procedureVersion).toBe(definition.version);
  expect(controller.state.workflow?.version).toBe(definition.version);
  await controller.selectWorkflow(definition.id);
  expect(controller.state.procedureVersion).toBe(definition.version);
});

test("an upload read for a different step cannot be attached after navigation", async () => {
  const { controller, requests } = inspection();
  await controller.selectStep("build-plate");
  await controller.capture(
    "initial",
    { photoUrl: "data:image/jpeg;base64,demo", mimeType: "image/jpeg" },
    "purge-limiter",
  );
  expect(requests).toHaveLength(0);
});

test("an unstarted selected workflow picks up a refreshed version", async () => {
  const { controller } = inspection();
  controller.state.status = "ready";
  await controller.refreshWorkflows();
  expect(controller.state.procedureVersion).toBe(99);
  expect(controller.state.workflow?.version).toBe(99);
});

test("starting a workflow card selects its definition and cannot replace an active inspection", async () => {
  const { controller } = inspection();
  const other = {
    ...definition,
    id: "other-workflow",
    title: "Other workflow",
    steps: [
      {
        stepId: "tools",
        title: "Check tools",
        instruction: "Show a screwdriver.",
        visualCriteria: ["A screwdriver is visible."],
      },
    ],
  };
  controller.state.workflows = [definition, other];
  controller.state.status = "ready";
  await controller.begin(other.id);
  expect(controller.state.procedureId).toBe(other.id);
  expect(controller.state.currentStepId).toBe("tools");
  await controller.begin(definition.id);
  expect(controller.state.procedureId).toBe(other.id);
});

test("skip and escalation do not wait for narration; old completion cannot clear newer speech", async () => {
  const completions: Array<() => void> = [];
  let stops = 0;
  const controller = new InspectionController({
    load: async () => null,
    save: async () => {},
    snapshot: () => {},
    toast: () => {},
    capture: async () => {
      throw new Error("unused");
    },
    speak: () =>
      new Promise<void>((resolve) => {
        completions.push(resolve);
      }),
    stopSpeech: () => {
      stops++;
    },
  });
  controller.state = testSnapshot();
  controller.request = async <T>(): Promise<T> =>
    ({ id: "escalation", url: "http://example.test/package" }) as T;
  await controller.begin();
  expect(controller.speaking).toBe(true);
  expect(controller.busy).toBe(false);
  expect(controller.state.operation).toBeUndefined();
  await controller.skipStep();
  expect(controller.state.currentStepId).toBe("lubrication");
  expect(stops).toBe(1);
  expect(controller.busy).toBe(false);
  completions[0]();
  await Promise.resolve();
  expect(controller.speaking).toBe(true);
  await controller.transcript("escalate");
  expect(controller.state.currentStepId).toBe("build-plate");
  expect(controller.state.steps[1].state).toBe("pending");
  expect(stops).toBe(2);
  expect(controller.busy).toBe(false);
  await controller.transcript("skip step");
  expect(controller.state.currentStepId).toBe("purge-limiter");
  for (const complete of completions) complete();
}, 1000);
