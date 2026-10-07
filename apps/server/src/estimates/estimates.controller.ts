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
import { EstimatesService } from './estimates.service.js';

@Controller('estimates')
@UseGuards(AuthGuard)
export class EstimatesController {
  constructor(
    private readonly estimatesService: EstimatesService,
    private readonly prisma: PrismaService,
  ) {}

  private async sessionUser(session: UserSession) {
    const user = await this.prisma.user.findUnique({
      where: { id: session.user.id },
    });
    if (!user) throw notFound('User', session.user.id);
    return user;
  }

  @Get()
  async list(
    @Session() session: UserSession,
    @Query('status') status?: string | string[],
    @Query('search') search?: string,
    @Query('mine') mine?: string,
    @Query('awaiting_me') awaitingMe?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const user = await this.sessionUser(session);
    return this.estimatesService.list(user, {
      status: parseWorkflowStates(status),
      search,
      mine: mine === 'true' || mine === '1',
      awaitingMe: awaitingMe === 'true' || awaitingMe === '1',
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get(':id')
  async getOne(@Session() session: UserSession, @Param('id') id: string) {
    const user = await this.sessionUser(session);
    return this.estimatesService.getById(id, user);
  }

  @Post()
  async create(
    @Session() session: UserSession,
    @Body() body: { documentId?: string | null; document_id?: string | null },
  ) {
    const user = await this.sessionUser(session);
    return this.estimatesService.create(user, {
      documentId: body.documentId ?? body.document_id ?? null,
    });
  }

  @Put(':id')
  async update(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const user = await this.sessionUser(session);
    return this.estimatesService.updateDraft(id, user, {
      vendorId: (body.vendorId ?? body.vendor_id) as string | null | undefined,
      description: body.description as string | undefined,
      justification: body.justification as string | undefined,
      estimateNumber: (body.estimateNumber ?? body.estimate_number) as
        | string
        | null
        | undefined,
      estimateDate: (body.estimateDate ?? body.estimate_date) as
        | string
        | null
        | undefined,
      neededBy: (body.neededBy ?? body.needed_by) as string | null | undefined,
      totalMinorUnits: (body.totalMinorUnits ?? body.total_minor_units) as
        | string
        | number
        | null
        | undefined,
      currency: body.currency as string | null | undefined,
      costCentreId: (body.costCentreId ?? body.cost_centre_id) as
        | string
        | null
        | undefined,
      glAccountId: (body.glAccountId ?? body.gl_account_id) as
        | string
        | null
        | undefined,
      documentId: (body.documentId ?? body.document_id) as
        | string
        | null
        | undefined,
    });
  }

  @Post(':id/submit')
  async submit(@Session() session: UserSession, @Param('id') id: string) {
    const user = await this.sessionUser(session);
    return this.estimatesService.submit(id, user);
  }

  @Post(':id/withdraw')
  async withdraw(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    const user = await this.sessionUser(session);
    return this.estimatesService.withdraw(id, user, body.reason);
  }

  @Post(':id/cancel')
  async cancel(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    const user = await this.sessionUser(session);
    return this.estimatesService.cancel(id, user, body.reason);
  }

  @Post(':id/decision')
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
    return this.estimatesService.decision(id, user, {
      stepOrder: body.stepOrder ?? body.step_order ?? 0,
      level: body.level,
      outcome: body.outcome,
      comment: body.comment,
    });
  }
}
