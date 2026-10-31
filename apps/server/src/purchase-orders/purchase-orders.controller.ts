import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AuthGuard,
  Session,
  type UserSession,
} from '@thallesp/nestjs-better-auth';
import { notFound } from '../common/errors.js';
import { parseWorkflowStates } from '../common/workflow-state.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';

@Controller('purchase-orders')
@UseGuards(AuthGuard)
export class PurchaseOrdersController {
  constructor(
    private readonly service: PurchaseOrdersService,
    private readonly prisma: PrismaService,
  ) {}

  private async sessionUser(session: UserSession) {
    const user = await this.prisma.user.findUnique({
      where: { id: session.user.id },
    });
    if (!user) throw notFound('User', session.user.id);
    return user;
  }

  @Get('reference-data')
  referenceData() {
    return this.service.referenceData();
  }

  @Get()
  async list(
    @Session() session: UserSession,
    @Query('status') status?: string | string[],
    @Query('search') search?: string,
    @Query('mine') mine?: string,
    @Query('open_only') openOnly?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const user = await this.sessionUser(session);
    return this.service.list(user, {
      status: parseWorkflowStates(status),
      search,
      mine: mine === 'true' || mine === '1',
      openOnly: openOnly === 'true' || openOnly === '1',
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get(':id')
  async getOne(@Session() session: UserSession, @Param('id') id: string) {
    const user = await this.sessionUser(session);
    return this.service.getById(id, user);
  }

  @Post()
  async create(
    @Session() session: UserSession,
    @Body() body: { estimateId?: string | null; estimate_id?: string | null },
  ) {
    const user = await this.sessionUser(session);
    return this.service.create(user, {
      estimateId: body.estimateId ?? body.estimate_id ?? null,
    });
  }

  @Put(':id')
  async update(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const user = await this.sessionUser(session);
    return this.service.updateDraft(id, user, body);
  }

  @Post(':id/submit')
  async submit(@Session() session: UserSession, @Param('id') id: string) {
    const user = await this.sessionUser(session);
    return this.service.submit(id, user);
  }

  @Post(':id/withdraw')
  async withdraw(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    const user = await this.sessionUser(session);
    return this.service.withdraw(id, user, body.reason);
  }

  @Post(':id/amend')
  async amend(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body()
    body: {
      totalMinorUnits?: string | number;
      total_minor_units?: string | number;
      reason: string;
    },
  ) {
    const user = await this.sessionUser(session);
    return this.service.amend(id, user, {
      totalMinorUnits:
        body.totalMinorUnits ?? body.total_minor_units ?? 0,
      reason: body.reason,
    });
  }

  @Post(':id/close')
  async close(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    const user = await this.sessionUser(session);
    return this.service.close(id, user, body.reason);
  }

  @Post(':id/cancel')
  async cancel(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    const user = await this.sessionUser(session);
    return this.service.cancel(id, user, body.reason);
  }

  @Post(':id/decisions')
  async decision(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body()
    body: {
      stepOrder?: number;
      step_order?: number;
      level: string;
      outcome: 'approved' | 'rejected';
      comment?: string | null;
    },
  ) {
    const user = await this.sessionUser(session);
    return this.service.decision(id, user, {
      stepOrder: body.stepOrder ?? body.step_order ?? 0,
      level: body.level,
      outcome: body.outcome,
      comment: body.comment,
    });
  }
}
