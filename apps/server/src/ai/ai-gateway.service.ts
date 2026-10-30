import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type OpenAI from 'openai';
import { AI_KILL_SWITCH_SETTING_KEY } from '../admin-settings/admin-settings.constants.js';
import type { FieldName } from '../documents/document-reading.js';
import { FIELD_DEFS } from '../documents/document-reading.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fenceDocument, findInDocument, normalise } from './grounding.js';
import {
  configuredClassificationModel,
  configuredExtractionModel,
  moonshotClient,
} from './moonshot.client.js';
import {
  DOCUMENT_KINDS,
  type DocumentKindName,
  EXTRACTION_SYSTEM,
  KIND_SYSTEM,
  fieldInstruction,
  kindInstruction,
  proposeFieldsTool,
  proposeKindTool,
} from './prompts.js';

export type GatewayOutcome =
  | 'answered'
  | 'disabled'
  | 'kill_switch'
  | 'circuit_open'
  | 'unavailable'
  | 'malformed'
  | 'nothing_usable';

export type FieldSuggestion = {
  name: FieldName;
  text: string;
  quote: string;
};

export type SuggestionResult = {
  outcome: GatewayOutcome;
  suggestions: FieldSuggestion[];
  discarded: number;
  modelName: string | null;
  promptId: string | null;
  promptVersion: number | null;
  promptSha256: string | null;
  latencyMs: number | null;
  note: string | null;
};

export type KindSuggestion = {
  outcome: GatewayOutcome;
  kind: DocumentKindName;
  quote: string | null;
  modelName: string | null;
  promptId: string | null;
  promptVersion: number | null;
  promptSha256: string | null;
  latencyMs: number | null;
  note: string | null;
};

type BreakerState = {
  failures: number;
  openedAt: number | null;
};

const FAILURE_THRESHOLD = 5;
const RESET_MS = 60_000;

@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);
  private breaker: BreakerState = { failures: 0, openedAt: null };
  private client: OpenAI | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async suggestFields(
    documentText: string,
    kind: string,
    wanted: FieldName[],
  ): Promise<SuggestionResult> {
    if (wanted.length === 0) {
      return emptySuggestion('nothing_usable');
    }

    const blocked = await this.availability();
    if (blocked) {
      return emptySuggestion(blocked, explain(blocked));
    }

    const model = configuredExtractionModel();
    const system = EXTRACTION_SYSTEM;
    const user = fenceDocument(documentText, fieldInstruction(kind, wanted));
    const promptSha256 = sha256(`${system}\n${user}`);
    const started = Date.now();

    try {
      const client = this.getClient();
      const completion = await client.chat.completions.create({
        model,
        // kimi-k2.6: thinking must be off to force a named tool; non-thinking temp is fixed at 0.6.
        temperature: 0.6,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        tools: [proposeFieldsTool(wanted)],
        tool_choice: {
          type: 'function',
          function: { name: 'propose_fields' },
        },
        ...kimiNonThinking,
      });

      const call = completion.choices[0]?.message?.tool_calls?.find(
        (item) => item.type === 'function' && item.function.name === 'propose_fields',
      );
      if (!call || call.type !== 'function') {
        this.recordFailure();
        return {
          ...emptySuggestion('malformed', 'The assistive reader did not answer in the agreed format.'),
          modelName: model,
          promptId: 'document.fields',
          promptVersion: 1,
          promptSha256,
          latencyMs: Date.now() - started,
        };
      }

      const payload = parseJson(call.function.arguments);
      const raw = payload?.fields;
      if (!Array.isArray(raw)) {
        this.recordFailure();
        return {
          ...emptySuggestion('malformed', 'The assistive reader did not answer in the agreed format.'),
          modelName: model,
          promptId: 'document.fields',
          promptVersion: 1,
          promptSha256,
          latencyMs: Date.now() - started,
        };
      }

      const wantedSet = new Set(wanted);
      const kept: FieldSuggestion[] = [];
      const seen = new Set<string>();
      let discarded = 0;

      for (const item of raw) {
        if (!item || typeof item !== 'object') {
          discarded += 1;
          continue;
        }
        const row = item as Record<string, unknown>;
        const name = String(row.name ?? '').trim() as FieldName;
        const value = String(row.value ?? '').trim();
        const quote = String(row.quote ?? '').trim();
        if (!wantedSet.has(name) || !value || seen.has(name)) {
          discarded += 1;
          continue;
        }
        if (quote && !findInDocument(documentText, quote)) {
          discarded += 1;
          continue;
        }
        if (quote && !normalise(quote).includes(normalise(value))) {
          discarded += 1;
          continue;
        }
        if (!findInDocument(documentText, value)) {
          discarded += 1;
          continue;
        }
        seen.add(name);
        kept.push({ name, text: value, quote });
      }

      this.recordSuccess();
      if (discarded > 0) {
        this.logger.warn(
          `Assistive reader discarded ${discarded} field proposal(s) that were not in the document.`,
        );
      }

      return {
        outcome: kept.length > 0 ? 'answered' : 'nothing_usable',
        suggestions: kept,
        discarded,
        modelName: model,
        promptId: 'document.fields',
        promptVersion: 1,
        promptSha256,
        latencyMs: Date.now() - started,
        note:
          kept.length > 0
            ? null
            : 'The assistive reader did not find any of the missing values in this document.',
      };
    } catch (error) {
      this.recordFailure();
      this.logger.warn(
        `Assistive reader unavailable: ${error instanceof Error ? error.message : error}`,
      );
      return {
        ...emptySuggestion('unavailable', explain('unavailable')),
        modelName: model,
        promptId: 'document.fields',
        promptVersion: 1,
        promptSha256,
        latencyMs: Date.now() - started,
      };
    }
  }

  async suggestKind(documentText: string): Promise<KindSuggestion> {
    const blocked = await this.availability();
    if (blocked) {
      return emptyKind(blocked, explain(blocked));
    }

    const model = configuredClassificationModel();
    const system = KIND_SYSTEM;
    const user = fenceDocument(documentText, kindInstruction());
    const promptSha256 = sha256(`${system}\n${user}`);
    const started = Date.now();

    try {
      const client = this.getClient();
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.6,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        tools: [proposeKindTool()],
        tool_choice: {
          type: 'function',
          function: { name: 'propose_kind' },
        },
        ...kimiNonThinking,
      });

      const call = completion.choices[0]?.message?.tool_calls?.find(
        (item) => item.type === 'function' && item.function.name === 'propose_kind',
      );
      if (!call || call.type !== 'function') {
        this.recordFailure();
        return {
          ...emptyKind('malformed', 'The assistive reader named a document type that does not exist.'),
          modelName: model,
          promptId: 'document.kind',
          promptVersion: 1,
          promptSha256,
          latencyMs: Date.now() - started,
        };
      }

      const payload = parseJson(call.function.arguments);
      const kindRaw = String(payload?.kind ?? '').trim().toLowerCase();
      const quote = String(payload?.quote ?? '').trim();
      const kind = DOCUMENT_KINDS.includes(kindRaw as DocumentKindName)
        ? (kindRaw as DocumentKindName)
        : null;

      if (!kind) {
        this.recordFailure();
        return {
          ...emptyKind('malformed', 'The assistive reader named a document type that does not exist.'),
          modelName: model,
          promptId: 'document.kind',
          promptVersion: 1,
          promptSha256,
          latencyMs: Date.now() - started,
        };
      }

      if (kind === 'unknown' || !quote || !findInDocument(documentText, quote)) {
        this.recordSuccess();
        return {
          outcome: 'nothing_usable',
          kind: 'unknown',
          quote: null,
          modelName: model,
          promptId: 'document.kind',
          promptVersion: 1,
          promptSha256,
          latencyMs: Date.now() - started,
          note:
            kind === 'unknown'
              ? 'The assistive reader could not tell what this document is either.'
              : 'The assistive reader suggested a document type but the text it cited is not in the document, so the suggestion was discarded.',
        };
      }

      this.recordSuccess();
      return {
        outcome: 'answered',
        kind,
        quote,
        modelName: model,
        promptId: 'document.kind',
        promptVersion: 1,
        promptSha256,
        latencyMs: Date.now() - started,
        note: null,
      };
    } catch (error) {
      this.recordFailure();
      this.logger.warn(
        `Assistive reader unavailable: ${error instanceof Error ? error.message : error}`,
      );
      return {
        ...emptyKind('unavailable', explain('unavailable')),
        modelName: model,
        promptId: 'document.kind',
        promptVersion: 1,
        promptSha256,
        latencyMs: Date.now() - started,
      };
    }
  }

  fieldLabels() {
    return FIELD_DEFS;
  }

  private getClient() {
    if (!this.client) this.client = moonshotClient();
    return this.client;
  }

  private async availability(): Promise<GatewayOutcome | null> {
    if (process.env.AI_ENABLED === 'false') return 'disabled';
    if (
      process.env.AI_KILL_SWITCH_ENGAGED === 'true' ||
      process.env.AI_KILL_SWITCH === 'true'
    ) {
      return 'kill_switch';
    }
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: AI_KILL_SWITCH_SETTING_KEY },
      select: { value: true },
    });
    if (
      row?.value &&
      typeof row.value === 'object' &&
      !Array.isArray(row.value) &&
      (row.value as { engaged?: boolean }).engaged === true
    ) {
      return 'kill_switch';
    }
    if (this.breaker.openedAt != null) {
      if (Date.now() - this.breaker.openedAt < RESET_MS) return 'circuit_open';
      this.breaker = { failures: 0, openedAt: null };
    }
    if (!process.env.MOONSHOT_API_KEY) return 'unavailable';
    return null;
  }

  private recordFailure() {
    this.breaker.failures += 1;
    if (this.breaker.failures >= FAILURE_THRESHOLD) {
      this.breaker.openedAt = Date.now();
    }
  }

  private recordSuccess() {
    this.breaker = { failures: 0, openedAt: null };
  }
}

function emptySuggestion(
  outcome: GatewayOutcome,
  note: string | null = null,
): SuggestionResult {
  return {
    outcome,
    suggestions: [],
    discarded: 0,
    modelName: null,
    promptId: null,
    promptVersion: null,
    promptSha256: null,
    latencyMs: null,
    note,
  };
}

function emptyKind(
  outcome: GatewayOutcome,
  note: string | null = null,
): KindSuggestion {
  return {
    outcome,
    kind: 'unknown',
    quote: null,
    modelName: null,
    promptId: null,
    promptVersion: null,
    promptSha256: null,
    latencyMs: null,
    note,
  };
}

function explain(outcome: GatewayOutcome) {
  switch (outcome) {
    case 'disabled':
      return 'The assistive reader is switched off.';
    case 'kill_switch':
      return 'The assistive reader kill switch is engaged.';
    case 'circuit_open':
      return 'The assistive reader is briefly withheld after repeated failures.';
    case 'unavailable':
      return 'The assistive reader could not be reached.';
    default:
      return null;
  }
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

/** Moonshot field: OpenAI SDK types omit it, but it must be in the JSON body. */
const kimiNonThinking = {
  thinking: { type: 'disabled' as const },
} as Record<string, unknown>;
