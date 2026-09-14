import workflow from "../../workflows/a1-mini.json";
import { createSnapshot } from "../src/shared/workflow";
import type { WorkflowDefinition } from "../src/shared/types";
export const STEP_ID = workflow.steps[0].stepId;
export const definition: WorkflowDefinition = {
  id: workflow.procedureId,
  version: workflow.version,
  title: workflow.title,
  asset: workflow.asset,
  workOrder: workflow.workOrder,
  steps: workflow.steps.map(({ references, ...step }) => ({
    ...step,
    references: references.map((r, index) => ({
      role: r.role as "good" | "bad",
      caption: r.caption,
      url: `/api/reference?procedureId=${workflow.procedureId}&procedureVersion=${workflow.version}&stepId=${step.stepId}&index=${index}`,
    })),
  })),
};
export const testSnapshot = () => ({
  ...createSnapshot("http://192.168.1.42:8787", definition),
  workflows: [definition],
});
