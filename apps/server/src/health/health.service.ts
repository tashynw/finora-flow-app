import { Injectable } from '@nestjs/common';
import { AI_KILL_SWITCH_SETTING_KEY } from '../admin-settings/admin-settings.constants.js';
import {
  configuredExtractionModel,
  moonshotClient,
} from '../ai/moonshot.client.js';
import { outboundMailConfigured, verifyOutboundMail } from '../mail/email.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type DependencyState = 'up' | 'down' | 'degraded' | 'not_configured';

export type DependencyReport = {
  name: string;
  state: DependencyState;
  detail?: string;
};

export type ReadinessResult = {
  ready: boolean;
  version: string;
  environment: string;
  dependencies: DependencyReport[];
};

const AI_PROBE_MS = 5_000;
const SMTP_PROBE_MS = 5_000;
const CRITICAL = new Set(['postgresql']);

@Injectable()
export class HealthService {
  readonly version = '0.0.1';

  constructor(private readonly prisma: PrismaService) {}

  liveness() {
    return { status: 'ok' as const, version: this.version };
  }

  async readiness(): Promise<ReadinessResult> {
    const dependencies = await Promise.all([
      this.checkPostgres(),
      this.checkAiGateway(),
      this.checkSmtp(),
    ]);

    const ready = dependencies
      .filter((item) => CRITICAL.has(item.name))
      .every((item) => item.state === 'up');

    return {
      ready,
      version: this.version,
      environment: process.env.NODE_ENV?.trim() || 'development',
      dependencies,
    };
  }

  private async checkPostgres(): Promise<DependencyReport> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { name: 'postgresql', state: 'up' };
    } catch (error) {
      return {
        name: 'postgresql',
        state: 'down',
        detail: error instanceof Error ? error.name : 'Error',
      };
    }
  }

  private async checkAiGateway(): Promise<DependencyReport> {
    if (!process.env.MOONSHOT_API_KEY) {
      return {
        name: 'ai_gateway',
        state: 'not_configured',
        detail: 'MOONSHOT_API_KEY is not set',
      };
    }

    const wanted = configuredExtractionModel();
    try {
      const listed = await withTimeout(
        (async () => {
          const page = await moonshotClient().models.list();
          return page.data.map((model) => model.id);
        })(),
        AI_PROBE_MS,
        'Moonshot models.list timed out',
      );

      if (!listed.includes(wanted)) {
        return {
          name: 'ai_gateway',
          state: 'degraded',
          detail: `reachable, but configured model ${wanted} was not listed`,
        };
      }
      return { name: 'ai_gateway', state: 'up' };
    } catch (error) {
      return {
        name: 'ai_gateway',
        state: 'down',
        detail: error instanceof Error ? error.message : 'Moonshot unreachable',
      };
    }
  }

  private async checkSmtp(): Promise<DependencyReport> {
    if (!outboundMailConfigured()) {
      return {
        name: 'smtp',
        state: 'not_configured',
        detail: 'SMTP credentials are not set',
      };
    }

    try {
      await withTimeout(
        verifyOutboundMail(),
        SMTP_PROBE_MS,
        'SMTP verify timed out',
      );
      return { name: 'smtp', state: 'up' };
    } catch (error) {
      return {
        name: 'smtp',
        state: 'down',
        detail: error instanceof Error ? error.message : 'SMTP unreachable',
      };
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
