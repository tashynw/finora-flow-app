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
import { DomainException } from '../common/errors.js';
import { type PageQuery } from '../common/pagination.js';
import { serialize } from '../common/serialize.js';
import { VendorCheckInsService } from './vendor-check-ins.service.js';

@Controller('vendor-check-ins')
@UseGuards(AuthGuard)
export class VendorCheckInsController {
  constructor(private readonly service: VendorCheckInsService) {}

  @Get()
  async list(
    @Query()
    query: PageQuery & {
      standing?: string | string[];
      search?: string;
      page_size?: string;
    },
  ) {
    const result = await this.service.list(query);
    return serialize({
      rows: result.rows,
      total: result.total,
      page: result.page,
      page_size: result.pageSize,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async raiseFromBody(
    @Session() session: UserSession,
    @Body() body: { package_id?: string; packageId?: string },
  ) {
    const packageId = body.packageId ?? body.package_id;
    if (!packageId) {
      throw new DomainException('A payment package is required.');
    }
    return serialize(await this.service.raiseForPackage(session, packageId));
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
  async getOne(@Session() session: UserSession, @Param('id') id: string) {
    return serialize(await this.service.present(session, id));
  }

  @Post(':id/send')
  async send(@Session() session: UserSession, @Param('id') id: string) {
    await this.service.send(session, id);
    return serialize(await this.service.present(session, id));
  }

  @Post(':id/answer')
  async answer(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body()
    body: {
      claim: string;
      respondentName?: string;
      respondent_name?: string;
      note?: string;
    },
  ) {
    await this.service.answer(
      id,
      {
        claim: body.claim,
        respondentName: body.respondentName ?? body.respondent_name ?? '',
        note: body.note,
      },
      {
        actorLabel: session.user.name ?? session.user.id,
      },
    );
    return serialize(await this.service.present(session, id));
  }

  @Post(':id/review')
  async review(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { outcome: 'paid' | 'outstanding'; note?: string },
  ) {
    await this.service.review(session, id, body);
    return serialize(await this.service.present(session, id));
  }
}
