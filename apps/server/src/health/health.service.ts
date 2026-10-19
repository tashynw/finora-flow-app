import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export type DependencyReport = {
  name: string;
  state: 'up' | 'down';
  detail?: string;
};

export type ReadinessResult = {
  ready: boolean;
  version: string;
  dependencies: DependencyReport[];
};

@Injectable()
export class HealthService {
  readonly version = '0.0.1';

  constructor(private readonly prisma: PrismaService) {}

  liveness() {
    return { status: 'ok' as const, version: this.version };
  }

  async readiness(): Promise<ReadinessResult> {
    const dependencies: DependencyReport[] = [];

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dependencies.push({ name: 'postgresql', state: 'up' });
    } catch (error) {
      dependencies.push({
        name: 'postgresql',
        state: 'down',
        detail: error instanceof Error ? error.name : 'Error',
      });
    }

    const ready = dependencies.every((d) => d.state === 'up');

    return {
      ready,
      version: this.version,
      dependencies,
    };
  }
}
