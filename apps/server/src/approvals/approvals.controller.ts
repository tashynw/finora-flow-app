import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  AuthGuard,
  Session,
  type UserSession,
} from '@thallesp/nestjs-better-auth';
import { PrismaService } from '../prisma/prisma.service.js';
import { notFound } from '../common/errors.js';
import { ApprovalsService } from './approvals.service.js';
import type { WorkflowRecordType } from './record-types.js';

@Controller('approvals')
@UseGuards(AuthGuard)
export class ApprovalsController {
  constructor(
    private readonly approvalsService: ApprovalsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('queue')
  async queue(
    @Session() session: UserSession,
    @Query('record_type') recordType?: WorkflowRecordType,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: session.user.id },
    });
    if (!user) throw notFound('User', session.user.id);
    return this.approvalsService.queue(user, recordType);
  }
}
