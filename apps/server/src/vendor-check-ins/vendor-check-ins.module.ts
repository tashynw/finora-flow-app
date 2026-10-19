import { Module } from '@nestjs/common';
import { PaymentCheckInController } from './payment-check-in.controller.js';
import { VendorCheckInsController } from './vendor-check-ins.controller.js';
import { VendorCheckInsService } from './vendor-check-ins.service.js';

@Module({
  controllers: [VendorCheckInsController, PaymentCheckInController],
  providers: [VendorCheckInsService],
  exports: [VendorCheckInsService],
})
export class VendorCheckInsModule {}
