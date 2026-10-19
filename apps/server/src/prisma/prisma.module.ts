import { Global, Module } from '@nestjs/common';
import { PrismaLifecycle, PrismaService, prismaServiceProvider } from './prisma.service.js';

@Global()
@Module({
  providers: [prismaServiceProvider, PrismaLifecycle],
  exports: [PrismaService],
})
export class PrismaModule {}
