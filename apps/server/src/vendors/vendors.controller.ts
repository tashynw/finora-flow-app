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
import { VendorsService } from './vendors.service.js';

function parseIncludeInactive(value: string | undefined) {
  if (value === undefined || value === '') {
    return true;
  }
  return value === 'true' || value === '1';
}

@Controller('vendors')
@UseGuards(AuthGuard)
export class VendorsController {
  constructor(private readonly vendorsService: VendorsService) {}

  @Get()
  async list(@Query('includeInactive') includeInactive?: string) {
    return serialize(
      await this.vendorsService.list(parseIncludeInactive(includeInactive)),
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
      email?: string | null;
      phone?: string | null;
      defaultCurrency?: string;
      paymentTermsDays?: number | null;
      reason?: string;
    },
  ) {
    return serialize(await this.vendorsService.create(session, body));
  }

  @Put(':id')
  async update(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      email?: string | null;
      phone?: string | null;
      defaultCurrency?: string;
      paymentTermsDays?: number | null;
      reason?: string;
    },
  ) {
    return serialize(await this.vendorsService.update(session, id, body));
  }

  @Post(':id/active')
  async setActive(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { isActive: boolean; reason?: string },
  ) {
    return serialize(await this.vendorsService.setActive(session, id, body));
  }
}
