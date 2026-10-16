import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { serialize } from '../common/serialize.js';
import { DepartmentsService } from './departments.service.js';

function parseSearchLimit(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseIncludeInactive(value: string | undefined) {
  if (value === undefined || value === '') {
    return true;
  }
  return value === 'true' || value === '1';
}

@Controller('departments')
@UseGuards(AuthGuard)
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Get()
  async list(
    @Query('includeInactive') includeInactive?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return serialize(
      await this.departmentsService.list(
        parseIncludeInactive(includeInactive),
        q,
        parseSearchLimit(limit),
      ),
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Session() session: UserSession,
    @Body() body: { name: string; costCentreNumber: string },
  ) {
    return serialize(await this.departmentsService.create(session, body));
  }

  @Put(':id')
  async update(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { name?: string; costCentreNumber?: string },
  ) {
    return serialize(await this.departmentsService.update(session, id, body));
  }

  @Post(':id/active')
  async setActive(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { isActive: boolean },
  ) {
    return serialize(
      await this.departmentsService.setActive(session, id, body.isActive),
    );
  }
}
