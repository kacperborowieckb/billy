import { callMcpToolTool } from "../mcp/call-mcp-tool-tool.ts";
import { findMcpToolsTool } from "../mcp/find-mcp-tools-tool.ts";
import {
  callMcpToolToolName,
  findMcpToolsToolName,
} from "../mcp/mcp-tool-names.ts";
import type { ScheduledTaskToolServices } from "./scheduled-task-tools.ts";

export const sideSessionMcpTools = (
  eventId: string,
  { mcp, journal, progress, redactor, behavior }: ScheduledTaskToolServices
) => {
  const services = { ...mcp, journal, progress, redactor, behavior };
  return {
    [findMcpToolsToolName]: findMcpToolsTool(services, eventId),
    [callMcpToolToolName]: callMcpToolTool(services, eventId, "read"),
  };
};
