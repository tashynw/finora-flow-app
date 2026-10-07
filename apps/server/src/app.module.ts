import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { YessirModule } from './yessir/yessir.module.js';

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
    PrismaModule,
    YessirModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
