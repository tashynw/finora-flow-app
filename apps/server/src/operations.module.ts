import { Module } from '@nestjs/common';
import { AccrualsModule } from './accruals/accruals.module.js';
import { AuditModule } from './audit/audit.module.js';
import { CommonModule } from './common/common.module.js';
import { CreditCardsModule } from './credit-cards/credit-cards.module.js';
import { IntakeModule } from './intake/intake.module.js';
import { OverviewModule } from './overview/overview.module.js';
import { PaymentPackagesModule } from './payment-packages/payment-packages.module.js';
import { SearchModule } from './search/search.module.js';
import { VendorCheckInsModule } from './vendor-check-ins/vendor-check-ins.module.js';
import { WorkModule } from './work/work.module.js';

/** Payment and operations API surface (import from AppModule when ready). */
@Module({
  imports: [
    CommonModule,
    PaymentPackagesModule,
    VendorCheckInsModule,
    CreditCardsModule,
    AccrualsModule,
    IntakeModule,
    WorkModule,
    OverviewModule,
    SearchModule,
    AuditModule,
  ],
})
export class OperationsModule {}
