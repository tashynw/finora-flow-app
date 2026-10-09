import { Module } from '@nestjs/common';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { LoggerModule } from 'nestjs-pino';
import { auth } from './better-auth/index.js';
import { AdminModule } from './admin.module.js';
import { ApprovalsModule } from './approvals/approvals.module.js';
import { CommonModule } from './common/common.module.js';
import { CostCentresModule } from './cost-centres/cost-centres.module.js';
import { DepartmentsModule } from './departments/departments.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { EstimatesModule } from './estimates/estimates.module.js';
import { GlAccountsModule } from './gl-accounts/gl-accounts.module.js';
import { HealthModule } from './health/health.module.js';
import { InvoicesModule } from './invoices/invoices.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { OperationsModule } from './operations.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module.js';
import { ReferenceModule } from './reference/reference.module.js';
import { VendorsModule } from './vendors/vendors.module.js';

const pretty = process.env.NODE_ENV !== 'production';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: pretty ? 'debug' : 'info',
        transport: pretty
          ? {
              target: 'pino-pretty',
              options: {
                singleLine: true,
                translateTime: 'SYS:HH:MM:ss',
                ignore: 'pid,hostname,req,res,responseTime',
              },
            }
          : undefined,
        customSuccessMessage: (request, response, responseTime) =>
          `${request.method} ${request.url} ${response.statusCode} ${responseTime}ms`,
        customErrorMessage: (request, response, error) =>
          `${request.method} ${request.url} ${response.statusCode} ${error.message}`,
        customLogLevel: (_request, response, error) => {
          if (error || response.statusCode >= 500) return 'error';
          if (response.statusCode >= 400) return 'warn';
          return 'info';
        },
      },
    }),
    AuthModule.forRoot({
      auth,
      // Existing routes stay open until we lock them down route by route.
      disableGlobalAuthGuard: true,
    }),
    CommonModule,
    PrismaModule,
    HealthModule,
    ReferenceModule,
    VendorsModule,
    GlAccountsModule,
    CostCentresModule,
    DepartmentsModule,
    AdminModule,
    EstimatesModule,
    PurchaseOrdersModule,
    InvoicesModule,
    ApprovalsModule,
    OperationsModule,
    DocumentsModule,
    JobsModule,
  ],
})
export class AppModule {}
