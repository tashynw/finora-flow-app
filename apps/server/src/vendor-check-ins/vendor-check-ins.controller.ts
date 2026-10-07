import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { resolvePage, type PageQuery } from '../common/pagination.js';
import { serialize } from '../common/serialize.js';
import { VendorCheckInsService } from './vendor-check-ins.service.js';

@Controller('vendor-check-ins')
@UseGuards(AuthGuard)
export class VendorCheckInsController {
  constructor(private readonly service: VendorCheckInsService) {}

  @Get()
  async list(@Query() query: PageQuery) {
    const page = resolvePage(query);
    const result = await this.service.list(query);
    return serialize({
      rows: result.rows,
      total: result.total,
      page: page.page ?? 1,
      pageSize: page.pageSize ?? page.take,
    });
  }

  @Post(':packageId')
  @HttpCode(HttpStatus.CREATED)
  async raise(
    @Session() session: UserSession,
    @Param('packageId') packageId: string,
  ) {
    return serialize(await this.service.raiseForPackage(session, packageId));
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    return serialize(await this.service.getById(id));
  }

  @Post(':id/send')
  async send(@Session() session: UserSession, @Param('id') id: string) {
    return serialize(await this.service.send(session, id));
  }

  @Post(':id/answer')
  async answer(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body()
    body: { claim: string; respondentName: string; note?: string },
  ) {
    return serialize(
      await this.service.answer(id, body, {
        actorLabel: session.user.name ?? session.user.id,
      }),
    );
  }

  @Post(':id/review')
  async review(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { outcome: 'paid' | 'outstanding'; note?: string },
  ) {
    return serialize(await this.service.review(session, id, body));
  }
}
