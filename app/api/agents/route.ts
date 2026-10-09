import { NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import { basename, dirname, resolve } from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_AGENT_BYTES, discoverAgents, unpackBundled } from "@/lib/omp/agents-service";
import { getProjectAgentsDir } from "@/lib/omp/paths";
import { resolveConfigurationContext } from "@/lib/omp/configuration-context";
import { AgentTemplateConflictError, agentTemplateDirectory, mutateAgentTemplate, readAgentTemplate, type AgentTemplateMutation } from "@/lib/omp/agent-template";

export const dynamic = "force-dynamic";

// JSON can expand control characters in a maximum-size agent prompt to six
// bytes each, with room for the envelope fields.
const MAX_AGENT_REQUEST_BYTES = MAX_AGENT_BYTES * 6 + 64 * 1024;

type Scope = "all" | "user" | "project" | "bundled";

async function allowedCwd(value: unknown, required = true): Promise<string | undefined> {
  if (typeof value !== "string" || !value.trim()) {
    if (required) throw new Error("cwd is required");
    return undefined;
  }
  const roots = await getAllowedFileRoots();
  try {
    if (!statSync(value).isDirectory()) throw new Error("Workspace is not allowed");
  } catch {
    throw new Error("Workspace is not allowed");
  }
  if (!isExistingFilePathAllowed(value, roots)) throw new Error("Workspace is not allowed");
  return value;
}

async function allowedProjectScope(value: unknown): Promise<{ cwd: string; dir: string }> {
  const cwd = await allowedCwd(value);
  if (!cwd) throw new Error("cwd is required");
  const dir = getProjectAgentsDir(cwd);
  const roots = await getAllowedFileRoots();
  let probe = resolve(dir);
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) throw new Error("Workspace is not allowed");
    probe = parent;
  }
  if (!isExistingFilePathAllowed(probe, roots)) throw new Error("Workspace is not allowed");
  return { cwd, dir };
}

function parseScope(value: string | null | undefined, allowBundled = true): Scope {
  const scope = value ?? "all";
  if (scope === "user" || scope === "project" || (allowBundled && scope === "bundled") || scope === "all") return scope as Scope;
  throw new Error("scope must be all, user, project, or bundled");
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const scope = parseScope(params.get("scope"));
    const cwd = await allowedCwd(params.get("cwd"), false);
    const context = await resolveConfigurationContext({ cwd, sessionId: params.get("sessionId") });
    const name = params.get("name");
    if (name !== null) {
      if (scope !== "user" && scope !== "project") throw new Error("Template scope is required");
      if (scope === "project") await allowedProjectScope(cwd);
      return NextResponse.json({ template: readAgentTemplate(context, scope, name), context: context.view });
    }
    const result = await discoverAgents(context);
    const agents = scope === "all" ? result.agents : result.agents.filter((agent) => agent.scope === scope);
    for (const agent of agents) if (agent.scope === "user" || agent.scope === "project") {
      try {
        if (agent.scope === "project") await allowedProjectScope(cwd);
        agent.template = readAgentTemplate(context, agent.scope, basename(agent.filePath, ".md"));
      } catch { agent.scope = "readonly"; }
    }
    return NextResponse.json({ ...result, agents, context: context.view, userPath: agentTemplateDirectory(context, "user"), projectPath: cwd ? agentTemplateDirectory(context, "project") : null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /not allowed/i.test(message) ? 403 : 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonWithinLimit<{ action?: unknown; contextId?: unknown; scope?: unknown }>(request, MAX_AGENT_REQUEST_BYTES);
    if (body.action !== "unpack" || Object.keys(body).some((key) => !["action", "contextId", "scope"].includes(key)) || (body.scope !== "user" && body.scope !== "project")) throw new Error("Expected explicit unpack action");
    const params = new URL(request.url).searchParams;
    const cwd = await allowedCwd(params.get("cwd"), false);
    const context = await resolveConfigurationContext({ cwd, sessionId: params.get("sessionId") });
    if (body.contextId !== context.view.id) return NextResponse.json({ error: "Configuration context changed", code: "conflict" }, { status: 409 });
    if (body.scope === "project") await allowedProjectScope(cwd);
    return NextResponse.json({ success: true, ...await unpackBundled(context, agentTemplateDirectory(context, body.scope)), persistence: { saved: true, appliedToRunningSessions: false } });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Agent request is too large" }, { status: 413 });
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /not allowed/i.test(message) ? 403 : 400 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await parseJsonWithinLimit<AgentTemplateMutation>(request, MAX_AGENT_REQUEST_BYTES);
    const params = new URL(request.url).searchParams;
    const cwd = await allowedCwd(params.get("cwd"), false);
    if (body.scope === "project") await allowedProjectScope(cwd);
    const context = await resolveConfigurationContext({ cwd, sessionId: params.get("sessionId") });
    const template = await mutateAgentTemplate(context, body);
    return NextResponse.json({ template, persistence: { saved: true, appliedToRunningSessions: false } });
  } catch (error) {
    if (error instanceof AgentTemplateConflictError) return NextResponse.json({ error: error.message, code: "conflict", latest: error.latest, conflicts: error.keys }, { status: 409 });
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Agent request is too large" }, { status: 413 });
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /not allowed/i.test(message) ? 403 : 400 });
  }
}
