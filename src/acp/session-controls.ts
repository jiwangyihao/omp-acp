import { RequestError, type NewSessionResponse, type SessionConfigOption, type SessionModeState, type SessionModelState, type SetSessionConfigOptionRequest } from "@agentclientprotocol/sdk";
import type { RuntimeAdapter } from "../runtime/RuntimeAdapter.ts";

export type SessionSetupStatePublic = Pick<NewSessionResponse, "models" | "modes" | "configOptions">;
export type SessionSetupState = SessionSetupStatePublic & { runtimeSessionId?: string };

export function requireSessionSetupState(setupState: SessionSetupState | undefined): SessionSetupState {
  if (setupState === undefined) {
    throw new Error("Session setup state was not built before publish");
  }
  return setupState;
}

export function toPublicSessionSetupState(setupState: SessionSetupState): SessionSetupStatePublic {
  const { runtimeSessionId: _runtimeSessionId, ...publicState } = setupState;
  return publicState;
}

type OmpModelSummary = {
  provider: string;
  id: string;
  name?: string;
  thinking?: { minLevel?: string; maxLevel?: string };
};

type OmpControlState = {
  model: OmpModelSummary;
  thinkingLevel?: string | null;
  sessionId?: string;
};
type SelectOption = { value: string; name: string; description?: string };

type Snapshot = {
  state: OmpControlState;
  models: OmpModelSummary[];
  setup: SessionSetupState;
};

const THINKING_ORDER = ["minimal", "low", "medium", "high", "xhigh"] as const;

export function buildDefaultModeState(): SessionModeState {
  return {
    availableModes: [{ id: "default", name: "Default", description: "Standard OMP ACP mode" }],
    currentModeId: "default",
  };
}

export async function buildSessionSetupState(runtime: RuntimeAdapter): Promise<SessionSetupState> {
  const snapshot = await readSnapshot(runtime);
  return snapshot.setup;
}

export async function setSessionModelControl(runtime: RuntimeAdapter, modelId: string): Promise<SessionSetupState> {
  const decoded = decodeModelId(modelId);
  const before = await readSnapshot(runtime);
  if (!before.setup.models?.availableModels.some((model) => model.modelId === modelId)) {
    throw invalidParams(`Unknown model id: ${modelId}`);
  }

  await runtime.request("set_model", { provider: decoded.provider, modelId: decoded.id });
  const after = await buildSessionSetupState(runtime);
  if (after.models?.currentModelId !== modelId) {
    throw new Error(`set_model succeeded but reread models.currentModelId was ${after.models?.currentModelId ?? "<missing>"}, expected ${modelId}`);
  }
  return after;
}

export async function setSessionConfigControl(runtime: RuntimeAdapter, request: SetSessionConfigOptionRequest): Promise<SessionSetupState> {
  switch (request.configId) {
    case "model": {
      if (typeof request.value !== "string") throw invalidParams("model config value must be a string");
      return await setSessionModelControl(runtime, request.value);
    }
    case "thinking":
      return await setThinking(runtime, request.value);
    default:
      throw invalidParams(`Unknown configId: ${request.configId}`);
  }
}

async function setThinking(runtime: RuntimeAdapter, value: unknown): Promise<SessionSetupState> {
  if (typeof value !== "string") throw invalidParams("thinking config value must be a string");
  const before = await readSnapshot(runtime);
  const allowed = buildSupportedThinkingValues(currentModelFromSnapshot(before));
  if (!allowed.includes(value)) {
    throw invalidParams(`Unsupported thinking value ${value} for model ${encodeModelId(before.state.model)}; supported values: ${allowed.join(", ")}`);
  }

  await runtime.request("set_thinking_level", { level: value });
  const after = await buildSessionSetupState(runtime);
  const option = findConfigOption(after, "thinking");
  if (option.type !== "select" || option.currentValue !== value) {
    const actual = option.type === "select" ? option.currentValue : "<missing>";
    throw new Error(`set_thinking_level succeeded but reread thinking currentValue was ${actual}, expected ${value}`);
  }
  return after;
}


async function readSnapshot(runtime: RuntimeAdapter): Promise<Snapshot> {
  const rawState = await runtime.request("get_state");
  const rawModels = await runtime.request("get_available_models");
  const state = parseControlState(rawState);
  const models = parseAvailableModels(rawModels);
  return { state, models, setup: buildSetupState(state, models) };
}

function buildSetupState(state: OmpControlState, availableModels: OmpModelSummary[]): SessionSetupState {
  const currentModelId = encodeModelId(state.model);
  const modelInfos = availableModels.map(toModelInfo);
  const currentExists = modelInfos.some((model) => model.modelId === currentModelId);
  if (!currentExists) {
    modelInfos.push({
      modelId: currentModelId,
      name: safeModelName(state.model),
      description: "当前 runtime model；未出现在 available model list 中",
    });
  }

  const models: SessionModelState = { availableModels: modelInfos, currentModelId };
  const modelSelectOptions = modelInfos.map((model): SelectOption => ({
    value: model.modelId,
    name: model.name,
    ...(model.description !== undefined && model.description !== null ? { description: model.description } : {}),
  }));

  const currentModel = availableModels.find((model) => encodeModelId(model) === currentModelId) ?? state.model;
  const thinkingOptions = buildThinkingOptions(currentModel, normalizeThinkingValue(state.thinkingLevel));
  const configOptions: SessionConfigOption[] = [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: currentModelId,
      options: modelSelectOptions,
    },
    {
      type: "select",
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      currentValue: normalizeThinkingValue(state.thinkingLevel),
      options: thinkingOptions,
    },
  ];

  return { models, modes: buildDefaultModeState(), configOptions, ...(state.sessionId !== undefined ? { runtimeSessionId: state.sessionId } : {}) };
}


function buildThinkingOptions(model: OmpModelSummary, currentValue: string): SelectOption[] {
  const options: SelectOption[] = buildSupportedThinkingValues(model).map((value) => ({ value, name: value }));
  if (!options.some((option) => option.value === currentValue)) {
    options.push({
      value: currentValue,
      name: currentValue,
      description: "当前 runtime 值；不在当前模型 metadata 支持范围内",
    });
  }
  return options;
}

function buildSupportedThinkingValues(model: OmpModelSummary): string[] {
  const values = ["off"];
  const thinking = model.thinking;
  if (thinking?.minLevel === undefined || thinking.maxLevel === undefined) {
    return values;
  }
  const min = THINKING_ORDER.indexOf(thinking.minLevel as (typeof THINKING_ORDER)[number]);
  const max = THINKING_ORDER.indexOf(thinking.maxLevel as (typeof THINKING_ORDER)[number]);
  if (min === -1 || max === -1 || min > max) {
    return values;
  }
  return values.concat(THINKING_ORDER.slice(min, max + 1));
}

function currentModelFromSnapshot(snapshot: Snapshot): OmpModelSummary {
  const currentModelId = encodeModelId(snapshot.state.model);
  return snapshot.models.find((model) => encodeModelId(model) === currentModelId) ?? snapshot.state.model;
}

function normalizeThinkingValue(value: string | null | undefined): string {
  return value === undefined || value === null || value === "inherit" ? "off" : value;
}


function toModelInfo(model: OmpModelSummary): { modelId: string; name: string; description?: string } {
  return { modelId: encodeModelId(model), name: safeModelName(model) };
}

function safeModelName(model: OmpModelSummary): string {
  return model.name ?? encodeModelId(model);
}

function encodeModelId(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function decodeModelId(modelId: string): { provider: string; id: string } {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) {
    throw invalidParams(`Invalid modelId: ${modelId}`);
  }
  return { provider: modelId.slice(0, slash), id: modelId.slice(slash + 1) };
}

function parseControlState(raw: unknown): OmpControlState {
  const record = requireRecord(raw, "get_state response");
  const model = parseModel(requireRecord(record.model, "get_state.model"), "get_state.model");
  const state: OmpControlState = { model };
  const sessionId = record.sessionId;
  if (typeof sessionId === "string" && sessionId.length > 0) state.sessionId = sessionId;
  else if (sessionId !== undefined) throw new Error("Invalid get_state.sessionId: expected non-empty string/undefined");
  const thinkingLevel = record.thinkingLevel;
  if (typeof thinkingLevel === "string") state.thinkingLevel = thinkingLevel;
  else if (thinkingLevel === null) state.thinkingLevel = null;
  else if (thinkingLevel !== undefined) throw new Error("Invalid get_state.thinkingLevel: expected string/null/undefined");
  return state;
}

function parseAvailableModels(raw: unknown): OmpModelSummary[] {
  const models = Array.isArray(raw) ? raw : requireRecord(raw, "get_available_models response").models;
  if (!Array.isArray(models)) throw new Error("Invalid get_available_models response: expected array or { models: array }");
  return models.map((entry, index) => parseModel(requireRecord(entry, `get_available_models[${index}]`), `get_available_models[${index}]`));
}

function parseModel(record: Record<string, unknown>, path: string): OmpModelSummary {
  const model: OmpModelSummary = {
    provider: requireNonEmptyString(record.provider, `${path}.provider`),
    id: requireNonEmptyString(record.id, `${path}.id`),
  };
  if (record.name !== undefined) model.name = requireString(record.name, `${path}.name`);
  const thinkingRaw = record.thinking;
  if (thinkingRaw !== undefined && thinkingRaw !== null) {
    const thinking = requireRecord(thinkingRaw, `${path}.thinking`);
    const parsed: { minLevel?: string; maxLevel?: string } = {};
    if (thinking.minLevel !== undefined) parsed.minLevel = requireString(thinking.minLevel, `${path}.thinking.minLevel`);
    if (thinking.maxLevel !== undefined) parsed.maxLevel = requireString(thinking.maxLevel, `${path}.thinking.maxLevel`);
    model.thinking = parsed;
  }
  return model;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${path}: expected object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${path}: expected string`);
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (text.length === 0) throw new Error(`Invalid ${path}: expected non-empty string`);
  return text;
}


function findConfigOption(setup: SessionSetupState, id: string): SessionConfigOption {
  const option = setup.configOptions?.find((candidate) => candidate.id === id);
  if (option === undefined) throw new Error(`Missing config option after reread: ${id}`);
  return option;
}

function invalidParams(message: string): RequestError {
  return RequestError.invalidParams(undefined, message);
}
