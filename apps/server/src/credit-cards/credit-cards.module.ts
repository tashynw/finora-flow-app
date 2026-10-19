import { Module } from '@nestjs/common';
import { CreditCardsController } from './credit-cards.controller.js';
import { CreditCardsService } from './credit-cards.service.js';

@Module({
  controllers: [CreditCardsController],
  providers: [CreditCardsService],
  exports: [CreditCardsService],
})
export class CreditCardsModule {}
