import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AuthGuard,
  Roles,
  Session,
  type UserSession,
} from '@thallesp/nestjs-better-auth';
import { parseBoolQuery } from '../common/query.js';
import { AdminApprovalsService } from './admin-approvals.service.js';

@Controller('admin')
@UseGuards(AuthGuard)
@Roles(['administrator'])
export class AdminApprovalsController {
  constructor(private readonly adminApprovalsService: AdminApprovalsService) {}

  @Get('matrix/:recordType/preview')
  previewRoute(
    @Param('recordType') recordType: string,
    @Query('amount_minor_units') amountMinorUnits: string,
    @Query('currency') currency: string,
    @Query('department') department?: string,
  ) {
    const amount = Number.parseInt(amountMinorUnits ?? '0', 10);
    return this.adminApprovalsService.previewRoute(
      recordType,
      Number.isFinite(amount) ? amount : 0,
      currency ?? 'JMD',
      department,
    );
  }

  @Get('matrix/:recordType')
  getMatrix(
    @Param('recordType') recordType: string,
    @Query('include_retired') includeRetired?: string,
  ) {
    return this.adminApprovalsService.getMatrix(
      recordType,
      parseBoolQuery(includeRetired, false),
    );
  }

  @Post('matrix/rules')
  createRule(
    @Body()
    body: {
      name: string;
      record_type: string;
      level: string;
      step_order: number;
      min_amount_minor_units: number;
      max_amount_minor_units?: number | null;
      currency: string;
      department?: string | null;
      is_parallel?: boolean;
      reason: string;
    },
    @Session() session: UserSession,
  ) {
    return this.adminApprovalsService.createRule(body, session);
  }

  @Post('matrix/rules/:id/retire')
  retireRule(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @Session() session: UserSession,
  ) {
    return this.adminApprovalsService.retireRule(id, body.reason, session);
  }

  @Get('people')
  listPeople(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.adminApprovalsService.listPeople(q, parseSearchLimit(limit));
  }

  @Get('assignments')
  listAssignments(@Query('level') level?: string) {
    return this.adminApprovalsService.listAssignments(level);
  }

  @Post('assignments')
  createAssignment(
    @Body()
    body: { user_id: string; level: string; department?: string | null },
    @Session() session: UserSession,
  ) {
    return this.adminApprovalsService.createAssignment(body, session);
  }

  @Delete('assignments/:id')
  deleteAssignment(@Param('id') id: string, @Session() session: UserSession) {
    return this.adminApprovalsService.deleteAssignment(id, session);
  }

  @Get('delegations')
  listDelegations() {
    return this.adminApprovalsService.listDelegations();
  }

  @Put('delegations/:userId')
  updateDelegation(
    @Param('userId') userId: string,
    @Body()
    body: { delegate_to_id?: string | null; out_of_office_until?: string | null },
    @Session() session: UserSession,
  ) {
    return this.adminApprovalsService.updateDelegation(userId, body, session);
  }
}

function parseSearchLimit(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
