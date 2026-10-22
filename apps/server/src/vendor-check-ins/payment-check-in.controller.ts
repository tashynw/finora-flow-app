import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { serialize } from '../common/serialize.js';
import { VendorCheckInsService } from './vendor-check-ins.service.js';

@Controller('payment-check-in')
export class PaymentCheckInController {
  constructor(private readonly service: VendorCheckInsService) {}

  @Get(':token')
  async view(@Param('token') token: string) {
    return serialize(await this.service.publicView(token));
  }

  @Post(':token')
  async answer(
    @Param('token') token: string,
    @Body()
    body: {
      claim: string;
      respondentName?: string;
      respondent_name?: string;
      note?: string;
    },
  ) {
    return serialize(
      await this.service.publicAnswer(token, {
        claim: body.claim,
        respondentName: body.respondentName ?? body.respondent_name ?? '',
        note: body.note,
      }),
    );
  }
}
