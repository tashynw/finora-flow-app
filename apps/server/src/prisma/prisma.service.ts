import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/index.js';
import { prisma } from './client.js';

/** Injection token. The value is the shared Prisma client. */
export class PrismaService extends PrismaClient {}

@Injectable()
export class PrismaLifecycle implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await prisma.$connect();
  }

  async onModuleDestroy() {
    await prisma.$disconnect();
  }
}

export const prismaServiceProvider = {
  provide: PrismaService,
  useValue: prisma as PrismaService,
};
