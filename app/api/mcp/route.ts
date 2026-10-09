import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { McpConflictError, parseMcpListOutput, readDiscoveredMcpServers, readMcpProject, readUserMcpConfig, validateMcpServer, writeMcpProject } from "@/lib/omp/mcp-config";
import { readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { resolveConfigurationContext, type OmpConfigurationContext } from "@/lib/omp/configuration-context";
import { readNativeSettings } from "@/lib/omp/settings-config";
import type { McpView, McpWriteRequest } from "@/lib/omp/mcp-contract";
import { join } from "path";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";
const MAX_MCP_REQUEST_BYTES = 1024 * 1024;

function mcpErrorResponse(error: unknown) {
  if (error instanceof McpConflictError) return NextResponse.json({ code: "conflict", latest: error.latest }, { status: 409 });
  const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
  return NextResponse.json({ error: error instanceof RequestBodyTooLargeError ? "MCP request is too large" : "MCP request failed", code: "invalid_mcp_request" }, { status });
}


async function allowedCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("cwd is required");
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new Error("Workspace is not allowed");
  return cwd;
}

async function readView(context: OmpConfigurationContext): Promise<McpView> {
  await allowedCwd(context.view.cwd);
  const project = readMcpProject(context);
  await allowedCwd(project.root);
  const user = readUserMcpConfig(join(context.view.agentDir, "mcp.json"));
  const settings = await readNativeSettings(context, "project");
  const inventory: McpView["inventory"] = [
    ...project.servers.map((server) => ({ name: server.name, source: "Project level", valid: server.valid, enabled: server.enabled && !user.disabledServers.includes(server.name), type: typeof server.config.type === "string" ? server.config.type : "stdio" })),
    ...user.servers.map(({ name, config: raw }) => {
      const config = isRecord(raw) ? raw : {};
      let valid = true;
      try { validateMcpServer(name, raw); } catch { valid = false; }
      return { name, source: "User level", valid, enabled: config.enabled !== false && !user.disabledServers.includes(name), type: typeof config.type === "string" ? config.type : "stdio" };
    }),
    ...readDiscoveredMcpServers(context.view.cwd, user.disabledServers, context.env.HOME, [project.path, user.path]).map((server) => ({ name: server.name, source: server.source, type: server.type, valid: null, enabled: server.status !== "disabled" })),
  ];
  const live: McpView["live"] = { state: "not-running", sessionId: context.view.sessionId, servers: [] };
  const session = context.view.sessionId ? getRpcSession(context.view.sessionId) : null;
  if (session?.isAlive()) {
    try {
      live.servers = parseMcpListOutput(await session.getMcpList()).map((server) => ({
        name: server.name, source: server.source, type: server.type, listed: true,
        // Compact rpc-ui output is configuration inventory, not runtime proof.
        loaded: server.status === "configured" || server.status === "disabled" ? null : server.status !== "inactive",
        connected: server.status === "connected" ? true : server.status === "not_connected" || server.status === "connecting" || server.status === "inactive" ? false : null,
      }));
      live.state = "observed";
    } catch { live.state = "unavailable"; }
  }
  return { ...project, projectLoading: settings.fields["mcp.enableProjectConfig"] ?? null, inventory, live };
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const cwd = params.get("cwd");
    if (cwd) await allowedCwd(cwd);
    const context = await resolveConfigurationContext({ cwd, sessionId: params.get("sessionId") });
    return NextResponse.json(await readView(context));
  } catch (error) { return mcpErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonWithinLimit<McpWriteRequest & { cwd?: string; sessionId?: string; action?: string; advisor?: boolean }>(request, MAX_MCP_REQUEST_BYTES);
    if (!isRecord(body) || Object.keys(body).some((key) => !["cwd", "sessionId", "contextId", "operations", "action", "advisor"].includes(key))) throw new Error("Unsupported MCP request field");
    if (body.cwd) await allowedCwd(body.cwd);
    const context = await resolveConfigurationContext({ cwd: body.cwd, sessionId: body.sessionId });
    await allowedCwd(context.view.cwd);
    await allowedCwd(readMcpProject(context).root);
    if (body.action === "start-live") {
      if (!body.sessionId || body.contextId !== context.view.id) throw new Error("Session context required");
      if (!getRpcSession(body.sessionId)?.isAlive()) {
        const file = await resolveSessionPath(body.sessionId);
        if (!file) throw new Error("Session not found");
        const header = readSessionHeader(file);
        await startRpcSession(body.sessionId, file, context.view.cwd, undefined, body.advisor === true, header?.cwd);
      }
      return NextResponse.json(await readView(await resolveConfigurationContext({ sessionId: body.sessionId })));
    }
    if (body.action !== undefined) throw new Error("Unknown MCP action");
    const result = await writeMcpProject(context, body);
    return NextResponse.json({ ...result, persistence: { saved: true, appliedToRunningSessions: false } });
  } catch (error) { return mcpErrorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const body = await parseJsonWithinLimit<{ name?: unknown; server?: unknown }>(request, MAX_MCP_REQUEST_BYTES);
    validateMcpServer(body.name, body.server);
    return NextResponse.json({ success: true, message: "MCP server configuration is valid" });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}

