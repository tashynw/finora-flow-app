import { Module } from '@nestjs/common';
import { PaymentPackagesController } from './payment-packages.controller.js';
import { PaymentPackagesService } from './payment-packages.service.js';

@Module({
  controllers: [PaymentPackagesController],
  providers: [PaymentPackagesService],
  exports: [PaymentPackagesService],
})
export class PaymentPackagesModule {}
