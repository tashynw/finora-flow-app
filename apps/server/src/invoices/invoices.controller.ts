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
import { InvoicesService } from './invoices.service.js';

@Controller('invoices')
@UseGuards(AuthGuard)
export class InvoicesController {
  constructor(
    private readonly service: InvoicesService,
    private readonly prisma: PrismaService,
  ) {}

  private async sessionUser(session: UserSession) {
    const user = await this.prisma.user.findUnique({
      where: { id: session.user.id },
    });
    if (!user) throw notFound('User', session.user.id);
    return user;
  }

  @Get('summary')
  summary() {
    return this.service.summary();
  }

  @Get('reference/linkable')
  linkable() {
    return this.service.linkableReference();
  }

  @Get()
  list(
    @Query('status') status?: string | string[],
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.list({
      status: parseWorkflowStates(status),
      search,
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
    @Body() body: { documentId?: string | null; document_id?: string | null },
  ) {
    const user = await this.sessionUser(session);
    return this.service.create(user, {
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
    return this.service.updateDraft(id, user, body);
  }

  @Post(':id/request-sign-off')
  async requestSignOff(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body?: { requesterId?: string; requester_id?: string },
  ) {
    const user = await this.sessionUser(session);
    const requesterId = body?.requesterId ?? body?.requester_id;
    return this.service.requestSignOff(
      id,
      user,
      requesterId ? { requesterId } : {},
    );
  }

  @Post(':id/sign-off')
  async signOff(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { note?: string | null },
  ) {
    const user = await this.sessionUser(session);
    return this.service.signOff(id, user, body);
  }

  @Post(':id/decline')
  async decline(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    const user = await this.sessionUser(session);
    return this.service.decline(id, user, body.reason);
  }

  @Post(':id/recall')
  async recall(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    const user = await this.sessionUser(session);
    return this.service.recall(id, user, body.reason);
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
    return this.service.decision(id, user, {
      stepOrder: body.stepOrder ?? body.step_order ?? 0,
      level: body.level,
      outcome: body.outcome,
      comment: body.comment,
    });
  }
}
