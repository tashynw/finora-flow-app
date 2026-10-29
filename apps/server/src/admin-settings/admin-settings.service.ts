import { HttpStatus, Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { AuditService } from '../common/audit.service.js';
import { DomainException } from '../common/errors.js';
import { serialize } from '../common/serialize.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AI_KILL_SWITCH_SETTING_KEY,
  recordClassFromSettingKey,
  RETENTION_DEFAULTS,
  RETENTION_SETTING_PREFIX,
  retentionSettingKey,
} from './admin-settings.constants.js';

type RetentionValue = {
  retention_days: number;
  description: string;
  is_active: boolean;
};

@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getOperationalSnapshot() {
    const killSwitchRow = await this.prisma.systemSetting.findUnique({
      where: { key: AI_KILL_SWITCH_SETTING_KEY },
    });

    const runtimeEngaged =
      killSwitchRow?.value &&
      typeof killSwitchRow.value === 'object' &&
      !Array.isArray(killSwitchRow.value) &&
      (killSwitchRow.value as { engaged?: boolean }).engaged === true;

    const killSwitchEnv =
      process.env.AI_KILL_SWITCH_ENGAGED === 'true' ||
      process.env.AI_KILL_SWITCH === 'true';

    const killSwitchEffective = killSwitchEnv || runtimeEngaged === true;

    return serialize({
      ai: {
        enabled: process.env.AI_ENABLED !== 'false',
        kill_switch_env: killSwitchEnv,
        kill_switch_effective: killSwitchEffective,
        model_extraction: process.env.AI_MODEL_EXTRACTION ?? 'kimi-k2.6',
        model_classification: process.env.AI_MODEL_CLASSIFICATION ?? 'kimi-k2.6',
      },
      workflow: {
        reminder_interval_hours: Number(process.env.REMINDER_INTERVAL_HOURS ?? 24),
        reminder_max_count: Number(process.env.REMINDER_MAX_COUNT ?? 3),
        display_timezone: process.env.DISPLAY_TIMEZONE ?? 'America/Jamaica',
        base_currency: process.env.BASE_CURRENCY ?? 'JMD',
        invoice_tolerance_percent: Number(process.env.INVOICE_TOLERANCE_PERCENT ?? 0),
        invoice_tolerance_minor_units: Number(
          process.env.INVOICE_TOLERANCE_MINOR_UNITS ?? 0,
        ),
        sign_off_link_ttl_hours: Number(process.env.SIGN_OFF_LINK_TTL_HOURS ?? 72),
        vendor_check_in_link_ttl_hours: Number(
          process.env.VENDOR_CHECK_IN_LINK_TTL_HOURS ?? 72,
        ),
        link_ttl_seconds: Number(process.env.LINK_TTL_SECONDS ?? 86400),
      },
    });
  }

  async setAiKillSwitch(body: { engaged: boolean; reason: string }, session: UserSession) {
    this.requireReason(body.reason);
    const value = { engaged: Boolean(body.engaged) };

    const existing = await this.prisma.systemSetting.findUnique({
      where: { key: AI_KILL_SWITCH_SETTING_KEY },
    });

    const row = existing
      ? await this.prisma.systemSetting.update({
          where: { key: AI_KILL_SWITCH_SETTING_KEY },
          data: {
            value,
            changeReason: body.reason.trim(),
            version: { increment: 1 },
          },
        })
      : await this.prisma.systemSetting.create({
          data: {
            key: AI_KILL_SWITCH_SETTING_KEY,
            value,
            description:
              'Runtime AI kill switch. When engaged, the gateway makes no calls.',
            changeReason: body.reason.trim(),
          },
        });

    await this.audit.append({
      action: 'ai_kill_switch.changed',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'system_setting',
      subjectId: row.id,
      detail: { engaged: value.engaged, reason: body.reason.trim() },
    });

    const killSwitchEnv =
      process.env.AI_KILL_SWITCH_ENGAGED === 'true' ||
      process.env.AI_KILL_SWITCH === 'true';

    return serialize({
      engaged: value.engaged,
      kill_switch_effective: killSwitchEnv || value.engaged,
    });
  }

  async listRetention(includeInactive: boolean) {
    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { startsWith: RETENTION_SETTING_PREFIX } },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));

    const merged = RETENTION_DEFAULTS.map((defaults) => {
      const key = retentionSettingKey(defaults.record_class);
      const row = byKey.get(key);
      return this.retentionOut(key, defaults, row?.id ?? null, row?.value);
    });

    const filtered = includeInactive
      ? merged
      : merged.filter((policy) => policy.is_active);

    return serialize(filtered);
  }

  async patchRetention(
    keyParam: string,
    body: { retention_days: number; reason: string },
    session: UserSession,
  ) {
    this.requireReason(body.reason);
    if (!Number.isInteger(body.retention_days) || body.retention_days < 1) {
      throw new DomainException('retention_days must be a positive integer.');
    }

    const key = retentionSettingKey(keyParam);
    const recordClass = recordClassFromSettingKey(key);
    const defaults = RETENTION_DEFAULTS.find((d) => d.record_class === recordClass);
    if (!defaults) {
      throw new DomainException(
        `Unknown retention key '${keyParam}'.`,
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
      );
    }

    const value: RetentionValue = {
      retention_days: body.retention_days,
      description: defaults.description,
      is_active: true,
    };

    const existing = await this.prisma.systemSetting.findUnique({ where: { key } });
    const row = existing
      ? await this.prisma.systemSetting.update({
          where: { key },
          data: {
            value,
            changeReason: body.reason.trim(),
            version: { increment: 1 },
          },
        })
      : await this.prisma.systemSetting.create({
          data: {
            key,
            value,
            description: defaults.description,
            changeReason: body.reason.trim(),
          },
        });

    await this.audit.append({
      action: 'retention_policy.updated',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'retention_policy',
      subjectId: row.id,
      detail: {
        key,
        retention_days: body.retention_days,
        reason: body.reason.trim(),
      },
    });

    return serialize(this.retentionOut(key, defaults, row.id, row.value));
  }

  async setRetentionActive(
    keyParam: string,
    body: { is_active: boolean; reason: string },
    session: UserSession,
  ) {
    this.requireReason(body.reason);
    const key = retentionSettingKey(keyParam);
    const recordClass = recordClassFromSettingKey(key);
    const defaults = RETENTION_DEFAULTS.find((d) => d.record_class === recordClass);
    if (!defaults) {
      throw new DomainException(
        `Unknown retention key '${keyParam}'.`,
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
      );
    }
    const existing = await this.prisma.systemSetting.findUnique({ where: { key } });
    const current = this.parseRetentionValue(existing?.value, defaults);
    const value: RetentionValue = { ...current, is_active: body.is_active };
    const row = existing
      ? await this.prisma.systemSetting.update({
          where: { key },
          data: { value, changeReason: body.reason.trim(), version: { increment: 1 } },
        })
      : await this.prisma.systemSetting.create({
          data: {
            key,
            value,
            description: defaults.description,
            changeReason: body.reason.trim(),
          },
        });
    return serialize(this.retentionOut(key, defaults, row.id, row.value));
  }

  private retentionOut(
    key: string,
    defaults: (typeof RETENTION_DEFAULTS)[number],
    id: string | null,
    stored: unknown,
  ) {
    const parsed = this.parseRetentionValue(stored, defaults);
    return {
      id: id ?? key,
      record_class: defaults.record_class,
      retention_days: parsed.retention_days,
      description: parsed.description,
      is_active: parsed.is_active,
    };
  }

  private parseRetentionValue(
    stored: unknown,
    defaults: (typeof RETENTION_DEFAULTS)[number],
  ): RetentionValue {
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      const obj = stored as Partial<RetentionValue>;
      return {
        retention_days:
          typeof obj.retention_days === 'number'
            ? obj.retention_days
            : defaults.retention_days,
        description:
          typeof obj.description === 'string' ? obj.description : defaults.description,
        is_active: obj.is_active !== false,
      };
    }
    return {
      retention_days: defaults.retention_days,
      description: defaults.description,
      is_active: true,
    };
  }

  private requireReason(reason: string) {
    if (!reason?.trim() || reason.trim().length < 3) {
      throw new DomainException('A reason of at least 3 characters is required.');
    }
  }
}
