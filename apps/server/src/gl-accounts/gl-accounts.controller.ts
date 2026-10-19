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
import { GlAccountsService } from './gl-accounts.service.js';

function parseIncludeInactive(value: string | undefined) {
  if (value === undefined || value === '') {
    return true;
  }
  return value === 'true' || value === '1';
}

@Controller('gl-accounts')
@UseGuards(AuthGuard)
export class GlAccountsController {
  constructor(private readonly glAccountsService: GlAccountsService) {}

  @Get()
  async list(@Query('includeInactive') includeInactive?: string) {
    return serialize(
      await this.glAccountsService.list(parseIncludeInactive(includeInactive)),
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Session() session: UserSession,
    @Body() body: { code: string; name: string; reason?: string },
  ) {
    return serialize(await this.glAccountsService.create(session, body));
  }

  @Put(':id')
  async update(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { name?: string; reason?: string },
  ) {
    return serialize(await this.glAccountsService.update(session, id, body));
  }

  @Post(':id/active')
  async setActive(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { isActive: boolean; reason?: string },
  ) {
    return serialize(await this.glAccountsService.setActive(session, id, body));
  }
}
