/** Maps ACP form elicitation to/from the gateway's AskUserQuestion prompt flow. */

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";

/**
 * Tool name that routes an AgentPermissionRequest through the interactive
 * question path in PermissionPromptManager (single/multi-select + free text).
 */
export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

/** One normalized question extracted from an elicitation form schema. */
interface MappedQuestion {
  /** The elicitation schema property key (e.g. `question_0`) this maps back to. */
  fieldKey: string;
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

/** Result of translating an elicitation request into an AskUserQuestion input. */
export interface MappedElicitation {
  /** `input` for an AgentPermissionRequest with toolName AskUserQuestion. */
  input: Record<string, unknown>;
  /** Retained mapping so the answer map can be folded back into form content. */
  questions: MappedQuestion[];
}

/**
 * Translates a form-mode `CreateElicitationRequest` into the `questions` input
 * shape consumed by PermissionPromptManager. Returns null when the request is
 * not a usable form (no schema / no answerable fields), so the caller can decline
 * gracefully rather than surfacing an empty prompt.
 *
 * Mirrors the `claude-agent-acp` schema convention: each `question_<n>` property
 * is a single-select string (`oneOf`) or multi-select array (`items.anyOf`); the
 * companion `question_<n>_custom` free-text field is ignored because the prompt
 * flow already accepts free-text answers.
 */
export function mapElicitationToQuestions(
  params: CreateElicitationRequest,
): MappedElicitation | null {
  if (params.mode !== "form") {
    return null;
  }

  const schema = (params as { requestedSchema?: { properties?: Record<string, unknown> } })
    .requestedSchema;
  const properties = schema?.properties;
  if (properties === undefined || properties === null) {
    return null;
  }

  const entries = Object.entries(properties).filter(([key]) => !key.endsWith("_custom"));
  const single = entries.length === 1;
  const questions: MappedQuestion[] = [];

  for (const [fieldKey, rawSchema] of entries) {
    const mapped = mapQuestionField(fieldKey, rawSchema as ElicitationPropertySchema, {
      fallbackQuestion: single ? params.message : undefined,
    });
    if (mapped !== null) {
      questions.push(mapped);
    }
  }

  if (questions.length === 0) {
    return null;
  }

  return {
    input: {
      questions: questions.map((question) => ({
        question: question.question,
        ...(question.header !== undefined ? { header: question.header } : {}),
        options: question.options,
        multiSelect: question.multiSelect,
      })),
    },
    questions,
  };
}

/**
 * Folds the answer map produced by the question flow (keyed by question text)
 * back into a `CreateElicitationResponse` accept action keyed by form field.
 * Multi-select answers are split back into arrays to match the array schema.
 */
export function buildAcceptResponse(
  answers: Record<string, string>,
  questions: readonly MappedQuestion[],
): CreateElicitationResponse {
  const content: Record<string, string | string[]> = {};

  for (const question of questions) {
    const answer = answers[question.question];
    if (answer === undefined || answer.length === 0) {
      continue;
    }

    content[question.fieldKey] = question.multiSelect
      ? answer.split(",").map((part) => part.trim()).filter((part) => part.length > 0)
      : answer;
  }

  return { action: "accept", content };
}

/** Maps one elicitation property schema to a normalized question, or null if unusable. */
function mapQuestionField(
  fieldKey: string,
  schema: ElicitationPropertySchema,
  options: { fallbackQuestion?: string },
): MappedQuestion | null {
  const record = schema as Record<string, unknown>;
  const type = record.type;
  const multiSelect = type === "array";

  const enumOptions = multiSelect
    ? extractEnumOptions((record.items as Record<string, unknown> | undefined)?.anyOf)
    : extractEnumOptions(record.oneOf);

  if (enumOptions.length === 0) {
    return null;
  }

  const question =
    readString(record.description) ?? options.fallbackQuestion ?? readString(record.title) ?? fieldKey;
  const header = readString(record.title);

  return {
    fieldKey,
    question,
    ...(header !== undefined ? { header } : {}),
    options: enumOptions,
    multiSelect,
  };
}

/** Extracts label/description option pairs from a schema's oneOf/anyOf array. */
function extractEnumOptions(raw: unknown): { label: string; description?: string }[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const options: { label: string; description?: string }[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const label = readString(record.title) ?? readString(record.const);
    if (label === undefined) {
      continue;
    }

    const description = readString(record.description);
    options.push({ label, ...(description !== undefined ? { description } : {}) });
  }

  return options;
}

/** Reads a non-empty string from an unknown value. */
function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
