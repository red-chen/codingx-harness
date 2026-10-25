import { readFileTool } from './read-file.js';
import { listDirTool } from './list-dir.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { writeFileTool } from './write-file.js';
import { editFileTool } from './edit-file.js';
import { updatePlanTool } from './plan.js';
import { applyPatchTool } from './apply-patch.js';
import { shellTool } from './shell.js';
import { askUserQuestionTool } from './ask-user.js';
import { skillTool } from './skill.js';
import type { ToolDef } from './types.js';

export { ToolRegistry } from './registry.js';
export { ReadFileTracker } from './read-tracker.js';
export { resolveWorkspacePath } from './paths.js';
export { readFileTool } from './read-file.js';
export { listDirTool } from './list-dir.js';
export { globTool } from './glob.js';
export { grepTool } from './grep.js';
export { writeFileTool } from './write-file.js';
export { editFileTool } from './edit-file.js';
export { updatePlanTool } from './plan.js';
export { applyPatchTool } from './apply-patch.js';
export { shellTool } from './shell.js';
export { askUserQuestionTool } from './ask-user.js';
export { skillTool } from './skill.js';
export type {
  AskAnswer,
  AskHandler,
  AskOption,
  AskQuestion,
  PlanController,
  PlanStep,
  PlanStepStatus,
  ShellToolContext,
  SkillToolContext,
  SkillToolEntry,
  ToolApproval,
  ToolContext,
  ToolDef,
  ToolResult,
} from './types.js';

/** M1/M2 built-ins. MCP and custom tools arrive later. */
export function createBuiltinTools(): ToolDef[] {
  return [
    readFileTool,
    listDirTool,
    globTool,
    grepTool,
    writeFileTool,
    editFileTool,
    updatePlanTool,
    applyPatchTool,
    shellTool,
    skillTool,
    askUserQuestionTool,
  ];
}
