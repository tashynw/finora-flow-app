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
import { CostCentresService } from './cost-centres.service.js';

function parseIncludeInactive(value: string | undefined) {
  if (value === undefined || value === '') {
    return true;
  }
  return value === 'true' || value === '1';
}

@Controller('cost-centres')
@UseGuards(AuthGuard)
export class CostCentresController {
  constructor(private readonly costCentresService: CostCentresService) {}

  @Get()
  async list(@Query('includeInactive') includeInactive?: string) {
    return serialize(
      await this.costCentresService.list(parseIncludeInactive(includeInactive)),
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Session() session: UserSession,
    @Body()
    body: {
      code: string;
      name: string;
      departmentId?: string | null;
      reason?: string;
    },
  ) {
    return serialize(await this.costCentresService.create(session, body));
  }

  @Put(':id')
  async update(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      departmentId?: string | null;
      reason?: string;
    },
  ) {
    return serialize(await this.costCentresService.update(session, id, body));
  }

  @Post(':id/active')
  async setActive(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { isActive: boolean; reason?: string },
  ) {
    return serialize(
      await this.costCentresService.setActive(session, id, body),
    );
  }
}
